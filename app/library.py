import os
import hashlib
from constants import *
from db import *
import titles as titles_lib
import datetime
from pathlib import Path
from sqlalchemy import or_
from utils import *

def _apply_override_to_title_dict(title_dict):
    """
    Best-effort: find an associated file for this app_id+version and
    apply a user override (by filename or title_id) to the dict.
    """
    # Lazy import to avoid circular import at module import time
    from overrides import find_user_override, apply_user_override
    # We need an app row to reach its files relationship
    app_row = Apps.query.filter_by(
        app_id=title_dict.get("app_id"),
        app_version=str(title_dict.get("app_version", "0"))
    ).first()

    file_basename = None
    if app_row and getattr(app_row, "files", None):
        # pick the first associated file (owned path)
        f0 = next(iter(app_row.files), None)
        if f0:
            file_basename = f0.filename

    # Try matching priority: title_id, (app_id+version), filename
    uo = find_user_override(
        title_id=title_dict.get("title_id"),
        app_id=title_dict.get("app_id"),
        app_version=str(title_dict.get("app_version", "0")),
        file_basename=file_basename,
    )
    if uo:
        # apply_user_override returns a new dict with fields patched
        return apply_user_override(title_dict, uo)
    return title_dict

def add_library_complete(app, watcher, path):
    """Add a library to settings, database, and watchdog"""
    from settings import add_library_path_to_settings
    
    with app.app_context():
        # Add to settings
        success, errors = add_library_path_to_settings(path)
        if not success:
            return success, errors
        
        # Add to database
        add_library(path)
        
        # Add to watchdog
        watcher.add_directory(path)
        
        logger.info(f"Successfully added library: {path}")
        return True, []

def remove_library_complete(app, watcher, path):
    """Remove a library from settings, database, and watchdog with proper cleanup"""
    from settings import delete_library_path_from_settings
    
    with app.app_context():
        # Remove from watchdog first
        watcher.remove_directory(path)
        
        # Get library object before deletion
        library = Libraries.query.filter_by(path=path).first()
        if library:
            # Get all file IDs from this library before deletion
            file_ids = [f.id for f in library.files]
            
            # Update Apps table to remove file references and update ownership
            total_apps_updated = 0
            for file_id in file_ids:
                apps_updated = remove_file_from_apps(file_id)
                total_apps_updated += apps_updated
            
            # Remove titles that no longer have any owned apps
            titles_removed = remove_titles_without_owned_apps()
            
            # Delete library (cascade will delete files automatically)
            db.session.delete(library)
            db.session.commit()
            
            logger.info(f"Removed library: {path}")
            if total_apps_updated > 0:
                logger.info(f"Updated {total_apps_updated} app entries to remove library file references.")
            if titles_removed > 0:
                logger.info(f"Removed {titles_removed} titles with no owned apps.")
        
        # Remove from settings
        success, errors = delete_library_path_from_settings(path)
        return success, errors

def init_libraries(app, watcher, paths):
    with app.app_context():
        # delete non existing libraries
        for library in get_libraries():
            path = library.path
            if not os.path.exists(path):
                logger.warning(f"Library {path} no longer exists, deleting from database.")
                # Use the complete removal function for consistency
                remove_library_complete(app, watcher, path)

        # add libraries and start watchdog
        for path in paths:
            # Check if library already exists in database
            existing_library = Libraries.query.filter_by(path=path).first()
            if not existing_library:
                # add library paths to watchdog if necessary
                watcher.add_directory(path)
                add_library(path)
            else:
                # Ensure watchdog is monitoring existing library
                watcher.add_directory(path)

def add_files_to_library(library, files):
    """
    Upsert files into the Files table.
    - Always inserts a row even when file_info is None (marks as unidentified).
    - Updates existing rows in place.
    """
    nb_to_identify = len(files)

    # Resolve library_id/path
    if isinstance(library, int) or (isinstance(library, str) and library.isdigit()):
        library_id = int(library)
        library_path = get_library_path(library_id)
    else:
        library_path = library
        library_id = get_library_id(library_path)

    library_path = get_library_path(library_id)
    for n, filepath in enumerate(files):
        file_rel = filepath.replace(library_path, "")
        logger.info(f'Getting file info ({n+1}/{nb_to_identify}): {file_rel}')

        # Try to read basic FS info regardless of titles_lib outcome
        filename = os.path.basename(filepath)
        extension = os.path.splitext(filename)[1].lstrip(".").lower()
        try:
            size = os.path.getsize(filepath)
        except Exception:
            size = None

        # Call the metadata helper
        try:
            file_info = titles_lib.get_file_info(filepath)
        except Exception as e:
            logger.exception(f"Error getting info for file {file_rel}: {e}")
            file_info = None

        # Upsert by unique filepath
        existing = Files.query.filter_by(filepath=filepath).first()
        if existing:
            # Refresh core info
            existing.folder = os.path.dirname(filepath) if file_info is None else file_info.get("filedir", os.path.dirname(filepath))
            existing.filename = filename if file_info is None else file_info.get("filename", filename)
            existing.extension = extension if file_info is None else file_info.get("extension", extension)
            # Size: prefer file_info size if provided, else FS size
            existing.size = (file_info.get("size") if (file_info and "size" in file_info) else size)

            # Identification flags
            if file_info is None:
                existing.identified = False
                existing.identification_type = "unidentified"
                existing.identification_error = "Failed to parse file info"
            else:
                existing.identified = True
                existing.identification_type = "titles_lib"
                existing.identification_error = None

            existing.identification_attempts = (existing.identification_attempts or 0) + 1
            existing.last_attempt = datetime.datetime.utcnow()

        else:
            if file_info is None:
                new_file = Files(
                    filepath=filepath,
                    library_id=library_id,
                    folder=os.path.dirname(filepath),
                    filename=filename,
                    extension=extension,
                    size=size,
                    identified=False,
                    identification_type="unidentified",
                    identification_error="Failed to parse file info",
                    identification_attempts=1,
                    last_attempt=datetime.datetime.utcnow(),
                )
            else:
                new_file = Files(
                    filepath=filepath,
                    library_id=library_id,
                    folder=file_info.get("filedir", os.path.dirname(filepath)),
                    filename=file_info.get("filename", filename),
                    extension=file_info.get("extension", extension),
                    size=file_info.get("size", size),
                    identified=True,
                    identification_type="titles_lib",
                    identification_error=None,
                    identification_attempts=1,
                    last_attempt=datetime.datetime.utcnow(),
                )
            db.session.add(new_file)

        # Commit every 100 files to avoid excessive memory use
        if (n + 1) % 100 == 0:
            db.session.commit()

    # Final commit
    db.session.commit()

def scan_library_path(library_path):
    library_id = get_library_id(library_path)
    logger.info(f'Scanning library path {library_path} ...')
    if not os.path.isdir(library_path):
        logger.warning(f'Library path {library_path} does not exists.')
        return
    _, files = titles_lib.getDirsAndFiles(library_path)

    filepaths_in_library = get_library_file_paths(library_id)
    new_files = [f for f in files if f not in filepaths_in_library]
    add_files_to_library(library_id, new_files)
    set_library_scan_time(library_id)

def get_files_to_identify(library_id, *, force_all: bool = False):
    q = Files.query.filter(Files.library_id == library_id)

    if not force_all:
        q = q.filter(
            or_(
                Files.identified.is_(None),
                Files.identification_type.is_(None),
                Files.last_attempt.is_(None),
                # optional: rescan stale entries older than 7 days
                Files.last_attempt < func.now() - func.cast(7, db.Interval)  # adapt if not using Interval
            )
        )

    return q.order_by(
        Files.last_attempt.is_(None).desc(),
        Files.last_attempt.asc()
    ).all()

def identify_library_files(library):
    # Resolve library_id / path
    if isinstance(library, int) or (isinstance(library, str) and library.isdigit()):
        library_id = int(library)
        library_path = get_library_path(library_id)
    else:
        library_path = library
        library_id = get_library_id(library_path)

    files_to_identify = get_files_to_identify(library_id, force_all=True)
    nb_to_identify = len(files_to_identify)

    # Load TitleDB once so we can check presence of title_ids quickly
    titles_lib.load_titledb()
    try:
        for n, file in enumerate(files_to_identify):
            try:
                file_id = file.id
                filepath = file.filepath
                filename = file.filename

                if not os.path.exists(filepath):
                    logger.warning(f'Identifying file ({n+1}/{nb_to_identify}): {filename} no longer exists, deleting from database.')
                    Files.query.filter_by(id=file_id).delete(synchronize_session=False)
                    continue

                logger.info(f'Identifying file ({n+1}/{nb_to_identify}): {filename}')
                identification, success, file_contents, error = titles_lib.identify_file(filepath)

                if success and file_contents and not error:
                    # Unique title_ids present in this file
                    title_ids = list(dict.fromkeys([c['title_id'] for c in file_contents]))

                    # Ensure Titles table has those IDs
                    for title_id in title_ids:
                        add_title_id_in_db(title_id)

                    nb_content = 0
                    for file_content in file_contents:
                        logger.info(
                            f'Identifying file ({n+1}/{nb_to_identify}) - '
                            f'Found content Title ID: {file_content["title_id"]} '
                            f'App ID : {file_content["app_id"]} '
                            f'Title Type: {file_content["type"]} '
                            f'Version: {file_content["version"]}'
                        )
                        # Upsert Apps and attach file via M2M
                        title_id_in_db = get_title_id_db_id(file_content["title_id"])

                        existing_app = get_app_by_id_and_version(
                            file_content["app_id"],
                            file_content["version"]
                        )

                        if existing_app:
                            add_file_to_app(file_content["app_id"], file_content["version"], file_id)
                        else:
                            new_app = Apps(
                                app_id=file_content["app_id"],
                                app_version=file_content["version"],
                                app_type=file_content["type"],
                                owned=True,
                                title_id=title_id_in_db
                            )
                            db.session.add(new_app)
                            db.session.flush()  # to get new_app id

                            file_obj = get_file_from_db(file_id)
                            if file_obj:
                                new_app.files.append(file_obj)

                        nb_content += 1

                    # Update multi-content flags
                    if nb_content > 1:
                        file.multicontent = True
                    file.nb_content = nb_content

                    needs_override = False
                    for tid in title_ids:
                        if not titles_lib.has_title_id(tid): # uses loaded TitleDB
                            needs_override = True
                            break

                    if needs_override:
                        # set identified to False if any title_id isn’t in TitleDB (homebrew/custom)
                        logger.info(f"Marking file as NOT identified (not in TitleDB): {filename} (title_ids={title_ids})")
                        file.identified = False
                        file.identification_type = "not_in_titledb"
                        file.identification_error = "Title ID not present in TitleDB (homebrew/custom)."
                    else:
                        # otherwise set it to True
                        file.identified = True
                        file.identification_type = identification  # e.g., 'cnmt'
                        file.identification_error = None

                else:
                    # Failed to identify contents
                    logger.warning(f"Error identifying file {filename}: {error}")
                    file.identification_error = error
                    file.identified = False
                    if not getattr(file, "identification_type", None):
                        file.identification_type = "exception"

            except Exception as e:
                logger.warning(f"Error identifying file {getattr(file, 'filename', '<unknown>')}: {e}")
                file.identification_error = str(e)
                file.identified = False
                # keep identification_type as-is if set earlier; otherwise mark generic
                if not getattr(file, "identification_type", None):
                    file.identification_type = "exception"

            # finally update attempts/time
            file.identification_attempts = (file.identification_attempts or 0) + 1
            file.last_attempt = datetime.datetime.now()

            # Commit every 100 files to avoid excessive memory use
            if (n + 1) % 100 == 0:
                db.session.commit()

        # Final commit for the batch
        db.session.commit()

    finally:
        # Keep titledb counters consistent and unload after a short debounce window
        titles_lib.unload_titledb()

def add_missing_apps_to_db():
    logger.info('Adding missing apps to database...')
    titles = get_all_titles()
    apps_added = 0
    
    for n, title in enumerate(titles):
        title_id = title.title_id
        title_db_id = get_title_id_db_id(title_id)
        
        # Add base game if not present
        existing_base = get_app_by_id_and_version(title_id, "0")
        
        if not existing_base:
            new_base_app = Apps(
                app_id=title_id,
                app_version="0",
                app_type=APP_TYPE_BASE,
                owned=False,
                title_id=title_db_id
            )
            db.session.add(new_base_app)
            apps_added += 1
            logger.debug(f'Added missing base app: {title_id}')
        
        # Add missing update versions
        title_versions = titles_lib.get_all_existing_versions(title_id)
        for version_info in title_versions:
            version = str(version_info['version'])
            update_app_id = title_id[:-3] + '800'  # Convert base ID to update ID
            
            existing_update = get_app_by_id_and_version(update_app_id, version)
            
            if not existing_update:
                new_update_app = Apps(
                    app_id=update_app_id,
                    app_version=version,
                    app_type=APP_TYPE_UPD,
                    owned=False,
                    title_id=title_db_id
                )
                db.session.add(new_update_app)
                apps_added += 1
                logger.debug(f'Added missing update app: {update_app_id} v{version}')
        
        # Add missing DLC
        title_dlc_ids = titles_lib.get_all_existing_dlc(title_id)
        for dlc_app_id in title_dlc_ids:
            dlc_versions = titles_lib.get_all_app_existing_versions(dlc_app_id)
            if dlc_versions:
                for dlc_version in dlc_versions:
                    existing_dlc = get_app_by_id_and_version(dlc_app_id, str(dlc_version))
                    
                    if not existing_dlc:
                        new_dlc_app = Apps(
                            app_id=dlc_app_id,
                            app_version=str(dlc_version),
                            app_type=APP_TYPE_DLC,
                            owned=False,
                            title_id=title_db_id
                        )
                        db.session.add(new_dlc_app)
                        apps_added += 1
                        logger.debug(f'Added missing DLC app: {dlc_app_id} v{dlc_version}')
        
        # Commit every 100 titles to avoid excessive memory use
        if (n + 1) % 100 == 0:
            db.session.commit()
            logger.info(f'Processed {n + 1}/{len(titles)} titles, added {apps_added} missing apps so far')
    
    # Final commit
    db.session.commit()
    logger.info(f'Finished adding missing apps to database. Total apps added: {apps_added}')

def process_library_identification(app):
    logger.info(f"Starting library identification process for all libraries...")
    try:
        with app.app_context():
            libraries = get_libraries()
            for library in libraries:
                identify_library_files(library.path)

    except Exception as e:
        logger.error(f"Error during library identification process: {e}")
    logger.info(f"Library identification process for all libraries completed.")

def update_titles():
    # Remove titles that no longer have any owned apps
    titles_removed = remove_titles_without_owned_apps()
    if titles_removed > 0:
            logger.info(f"Removed {titles_removed} titles with no owned apps.")

    titles = get_all_titles()
    for n, title in enumerate(titles):
        have_base = False
        up_to_date = False
        complete = False

        title_id = title.title_id
        title_apps = get_all_title_apps(title_id)

        # check have_base - look for owned base apps
        owned_base_apps = [app for app in title_apps if app.get('app_type') == APP_TYPE_BASE and app.get('owned')]
        have_base = len(owned_base_apps) > 0

        # check up_to_date - find highest owned update version
        owned_update_apps = [app for app in title_apps if app.get('app_type') == APP_TYPE_UPD and app.get('owned')]
        available_update_apps = [app for app in title_apps if app.get('app_type') == APP_TYPE_UPD]
        
        if not available_update_apps:
            # No updates available, consider up to date
            up_to_date = True
        elif not owned_update_apps:
            # Updates available but none owned
            up_to_date = False
        else:
            # Find highest available version and highest owned version
            highest_available_version = max(int(app['app_version']) for app in available_update_apps)
            highest_owned_version = max(int(app['app_version']) for app in owned_update_apps)
            up_to_date = highest_owned_version >= highest_available_version

        # check complete - latest version of all available DLC are owned
        available_dlc_apps = [app for app in title_apps if app.get('app_type') == APP_TYPE_DLC]
        
        if not available_dlc_apps:
            # No DLC available, consider complete
            complete = True
        else:
            # Group DLC by app_id and find latest version for each
            dlc_by_id = {}
            for app in available_dlc_apps:
                app_id = app['app_id']
                version = int(app['app_version'])
                if app_id not in dlc_by_id or version > dlc_by_id[app_id]['version']:
                    dlc_by_id[app_id] = {
                        'version': version,
                        'owned': app.get('owned', False)
                    }
            
            # Check if latest version of each DLC is owned
            complete = all(dlc_info['owned'] for dlc_info in dlc_by_id.values())

        title.have_base = have_base
        title.up_to_date = up_to_date
        title.complete = complete

        # Commit every 100 titles to avoid excessive memory use
        if (n + 1) % 100 == 0:
            db.session.commit()

    db.session.commit()

def get_library_status(title_id):
    title = get_title(title_id)
    title_apps = get_all_title_apps(title_id)

    available_versions = titles_lib.get_all_existing_versions(title_id)
    for version in available_versions:
        if len(list(filter(lambda x: x.get('app_type') == APP_TYPE_UPD and str(x.get('app_version')) == str(version['version']), title_apps))):
            version['owned'] = True
        else:
            version['owned'] = False

    library_status = {
        'has_base': title.have_base,
        'has_latest_version': title.up_to_date,
        'version': available_versions,
        'has_all_dlcs': title.complete
    }
    return library_status

def compute_apps_hash():
    """
    Computes a hash of all Apps table content to detect changes in library state.
    """
    hash_md5 = hashlib.md5()
    apps = get_all_apps()
    
    # Sort apps with safe handling of None values
    for app in sorted(apps, key=lambda x: (x['app_id'] or '', x['app_version'] or '')):
        hash_md5.update((app['app_id'] or '').encode())
        hash_md5.update((app['app_version'] or '').encode())
        hash_md5.update((app['app_type'] or '').encode())
        hash_md5.update(str(app['owned'] or False).encode())
        hash_md5.update((app['title_id'] or '').encode())
    return hash_md5.hexdigest()

def is_library_unchanged():
    cache_path = Path(LIBRARY_CACHE_FILE)
    if not cache_path.exists():
        return False

    saved_library = load_library_from_disk()
    if not saved_library:
        return False

    if not saved_library.get('hash'):
        return False

    current_hash = compute_apps_hash()
    return saved_library['hash'] == current_hash

def save_library_to_disk(library_data):
    cache_path = Path(LIBRARY_CACHE_FILE)
    # Ensure cache directory exists
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    safe_write_json(cache_path, library_data)

def load_library_from_disk():
    cache_path = Path(LIBRARY_CACHE_FILE)
    if not cache_path.exists():
        return None

    try:
        with cache_path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except:
        return None

def generate_library():
    """Generate the game library from Apps table, using cached version if unchanged"""
    # if is_library_unchanged():
    #     saved_library = load_library_from_disk()
    #     if saved_library:
    #         return saved_library['library']
    
    logger.info(f'Generating library ...')
    titles_lib.load_titledb()
    titles = get_all_apps()
    games_info = []
    processed_dlc_apps = set()  # Track processed DLC app_ids to avoid duplicates

    for title in titles:
        has_none_value = any(value is None for value in title.values())
        if has_none_value:
            logger.warning(f'File contains None value, it will be skipped: {title}')
            continue
        if title['app_type'] == APP_TYPE_UPD:
            continue
            
        # Get title info from titledb
        info_from_titledb = titles_lib.get_game_info(title['app_id'])
        if info_from_titledb is None:
            logger.warning(f'Info not found for game: {title}')
            continue
        title.update(info_from_titledb)
        title = _apply_override_to_title_dict(title)
        
        if title['app_type'] == APP_TYPE_BASE:
            # Get title status from Titles table (already calculated by update_titles)
            title_obj = get_title(title['title_id'])
            if title_obj:
                title['has_base'] = title_obj.have_base
                title['has_latest_version'] = title_obj.up_to_date
                title['has_all_dlcs'] = title_obj.complete
            else:
                title['has_base'] = False
                title['has_latest_version'] = False
                title['has_all_dlcs'] = False
            
            # Get version info from Apps table and add release dates from versions_db
            title_apps = get_all_title_apps(title['title_id'])
            update_apps = [app for app in title_apps if app.get('app_type') == APP_TYPE_UPD]
            
            # Get release date information from external source
            available_versions = titles_lib.get_all_existing_versions(title['title_id'])
            version_release_dates = {v['version']: v['release_date'] for v in available_versions}
            
            version_list = []
            for update_app in update_apps:
                app_version = int(update_app['app_version'])
                version_list.append({
                    'version': app_version,
                    'owned': update_app.get('owned', False),
                    'release_date': version_release_dates.get(app_version, 'Unknown')
                })
            
            title['version'] = sorted(version_list, key=lambda x: x['version'])
            title['title_id_name'] = title['name']
            
        elif title['app_type'] == APP_TYPE_DLC:
            # Skip if we've already processed this DLC app_id
            if title['app_id'] in processed_dlc_apps:
                continue
            processed_dlc_apps.add(title['app_id'])
            
            # Get all versions for this DLC app_id
            title_apps = get_all_title_apps(title['title_id'])
            dlc_apps = [app for app in title_apps if app.get('app_type') == APP_TYPE_DLC and app['app_id'] == title['app_id']]
            
            # Create version list for this DLC
            version_list = []
            for dlc_app in dlc_apps:
                app_version = int(dlc_app['app_version'])
                version_list.append({
                    'version': app_version,
                    'owned': dlc_app.get('owned', False),
                    'release_date': 'Unknown'  # DLC release dates not available in versions_db
                })
            
            title['version'] = sorted(version_list, key=lambda x: x['version'])
            
            # Check if this DLC has latest version
            if dlc_apps:
                highest_version = max(int(app['app_version']) for app in dlc_apps)
                highest_owned_version = max((int(app['app_version']) for app in dlc_apps if app.get('owned')), default=0)
                title['has_latest_version'] = highest_owned_version >= highest_version
            else:
                title['has_latest_version'] = True
            
            # Get title name for DLC
            titleid_info = titles_lib.get_game_info(title['title_id'])
            title['title_id_name'] = titleid_info['name'] if titleid_info else 'Unrecognized'
            title = _apply_override_to_title_dict(title)
            
        games_info.append(title)
    
    library_data = {
        'hash': compute_apps_hash(),
        'library': sorted(games_info, key=lambda x: (
            "title_id_name" not in x, 
            x.get("title_id_name", "Unrecognized") or "Unrecognized", 
            x.get('app_id', "") or ""
        ))
    }

    save_library_to_disk(library_data)

    titles_lib.identification_in_progress_count -= 1
    titles_lib.unload_titledb()

    logger.info(f'Generating library done.')

    return library_data['library']
