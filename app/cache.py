import datetime
import hashlib
import json
import logging
import os
from typing import Callable, Dict, Optional

from constants import (
    CACHE_MAX_AGE_SECONDS,
    LIBRARY_CACHE_FILE,
    LIBRARY_METADATA_CACHE_FILE,
    LIBRARY_METADATA_SNAPSHOT_VERSION,
    LIBRARY_SNAPSHOT_VERSION,
    OVERRIDES_CACHE_FILE,
    OVERRIDES_SNAPSHOT_VERSION,
    SHOP_CACHE_FILE,
)
from db import AppOverrides, Files, db, get_all_apps
from utils import load_json
import titles as titles_lib

logger = logging.getLogger("main")

CacheValidator = Callable[[Optional[dict]], bool]


def compute_library_apps_hash() -> str:
    """
    Computes a hash of all Apps table content to detect changes in library state.
    """
    hash_md5 = hashlib.md5()
    apps = get_all_apps()

    for app in sorted(apps, key=lambda x: (x["app_id"] or "", x["app_version"] or "")):
        hash_md5.update((app["app_id"] or "").encode())
        hash_md5.update((app["app_version"] or "").encode())
        hash_md5.update((app["app_type"] or "").encode())
        hash_md5.update(str(app["owned"] or False).encode())
        hash_md5.update((app["title_id"] or "").encode())
    return hash_md5.hexdigest()


def _snapshot_current(
    saved: Optional[dict],
    *,
    expected_version: int,
    current_hash_func,
    extra_checks: Optional[Callable[[dict], bool]] = None,
) -> bool:
    if not saved or not saved.get("hash"):
        return False
    if saved.get("snapshot_version") != expected_version:
        return False
    if not _snapshot_recent_enough(saved):
        return False
    if saved.get("hash") != current_hash_func():
        return False
    if extra_checks and not extra_checks(saved):
        return False
    return True


def snapshot_has_required_shape(
    saved: Optional[dict],
    *,
    expected_version: int,
    payload_key: str,
    payload_type: type,
) -> bool:
    """
    Lightweight structural validation for snapshot files that callers want to
    reuse without fully recomputing hashes.
    """
    if not isinstance(saved, dict):
        return False
    if saved.get("snapshot_version") != expected_version:
        return False
    stamp = saved.get("generated_at")
    if not isinstance(stamp, str) or not stamp.strip():
        return False
    hashed = saved.get("hash")
    if not isinstance(hashed, str) or not hashed.strip():
        return False
    payload = saved.get(payload_key)
    if not isinstance(payload, payload_type):
        return False
    return True


def is_library_snapshot_current(saved_library: Optional[dict]) -> bool:
    def _extra(saved: dict) -> bool:
        current_tdb = titles_lib.get_titledb_commit_hash() or ""
        saved_tdb = saved.get("titledb_commit")
        if saved_tdb is None:
            return False
        return saved_tdb == current_tdb

    return _snapshot_current(
        saved_library,
        expected_version=LIBRARY_SNAPSHOT_VERSION,
        current_hash_func=compute_library_apps_hash,
        extra_checks=_extra,
    )


def compute_overrides_fingerprint_rows() -> list[tuple]:
    rows = (
        db.session.query(
            AppOverrides.id,
            AppOverrides.corrected_title_id,
            AppOverrides.banner_path,
            AppOverrides.icon_path,
            AppOverrides.enabled,
            AppOverrides.suppress_missing,
            AppOverrides.name,
            AppOverrides.release_date,
            AppOverrides.region,
            AppOverrides.description,
            AppOverrides.content_type,
        )
        .order_by(AppOverrides.id.asc())
        .all()
    )

    normalized = []
    for (
        oid,
        corrected_title_id,
        banner_path,
        icon_path,
        enabled,
        suppress_missing,
        name,
        release_date,
        region,
        description,
        content_type,
    ) in rows:
        normalized.append(
            (
                oid,
                corrected_title_id or None,
                banner_path or None,
                icon_path or None,
                bool(enabled),
                bool(suppress_missing),
                name or None,
                release_date.isoformat() if isinstance(release_date, datetime.date) else (release_date or None),
                region or None,
                description or None,
                content_type or None,
            )
        )
    return normalized


def compute_overrides_snapshot_hash() -> str:
    payload_for_hash = {
        "rows": compute_overrides_fingerprint_rows(),
        "titledb_commit": titles_lib.get_titledb_commit_hash(),
    }
    return hashlib.sha256(
        json.dumps(payload_for_hash, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def is_overrides_snapshot_current(saved_snapshot: Optional[dict]) -> bool:
    return _snapshot_current(
        saved_snapshot,
        expected_version=OVERRIDES_SNAPSHOT_VERSION,
        current_hash_func=compute_overrides_snapshot_hash,
    )


def compute_library_metadata_snapshot_hash() -> str:
    payload_for_hash = {
        "library_hash": compute_library_apps_hash(),
        "overrides_hash": compute_overrides_snapshot_hash(),
        "titledb_commit": titles_lib.get_titledb_commit_hash(),
        "snapshot_version": LIBRARY_METADATA_SNAPSHOT_VERSION,
    }
    return hashlib.sha256(
        json.dumps(payload_for_hash, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def is_library_metadata_snapshot_current(saved_snapshot: Optional[dict]) -> bool:
    return _snapshot_current(
        saved_snapshot,
        expected_version=LIBRARY_METADATA_SNAPSHOT_VERSION,
        current_hash_func=compute_library_metadata_snapshot_hash,
    )


def compute_shop_files_fingerprint_rows() -> list[tuple[int, int, str]]:
    rows = (
        db.session.query(Files.id, Files.size, Files.filepath)
        .order_by(Files.id.asc())
        .all()
    )
    fingerprint = []
    for fid, size, path in rows:
        base = os.path.basename(path or "") if path else ""
        fingerprint.append((int(fid), int(size or 0), base))
    return fingerprint


def compute_shop_snapshot_hash() -> str:
    from overrides import load_or_generate_overrides_snapshot

    overrides_snapshot = load_or_generate_overrides_snapshot() or {}
    payload = overrides_snapshot.get("payload") or {}
    items = payload.get("items") if isinstance(payload, dict) else None
    redirects = payload.get("redirects") if isinstance(payload, dict) else None

    def _norm_item(it: dict) -> dict:
        return {
            "app_id": (it.get("app_id") or "").strip().upper(),
            "enabled": bool(it.get("enabled", True)),
            "corrected_title_id": (it.get("corrected_title_id") or "").strip().upper() or None,
            "name": it.get("name"),
            "region": it.get("region"),
            "release_date": it.get("release_date"),
            "description": it.get("description"),
            "banner_path": it.get("banner_path"),
            "icon_path": it.get("icon_path"),
            "category": it.get("category"),
        }

    norm_items = []
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict):
                norm_items.append(_norm_item(it))
    norm_items.sort(key=lambda d: d["app_id"])

    norm_redirects = []
    if isinstance(redirects, dict):
        for raw_app_id, data in redirects.items():
            if not isinstance(data, dict):
                continue
            norm_redirects.append({
                "app_id": (raw_app_id or "").strip().upper(),
                "corrected_title_id": (data.get("corrected_title_id") or "").strip().upper() or None,
                "projection": data.get("projection"),
            })
    norm_redirects.sort(key=lambda d: d["app_id"])

    ov_hash = hashlib.sha256(
        json.dumps(
            {"items": norm_items, "redirects": norm_redirects},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    library_snapshot = load_json(LIBRARY_CACHE_FILE) or {}
    lib_hash = library_snapshot.get("hash") or ""

    files_fp = compute_shop_files_fingerprint_rows()

    payload = {
        "overrides_hash": ov_hash,
        "library_hash": lib_hash,
        "files": files_fp,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def is_shop_snapshot_current(saved_snapshot: Optional[dict]) -> bool:
    if not saved_snapshot or not isinstance(saved_snapshot, dict):
        return False
    stored_hash = saved_snapshot.get("hash")
    if not stored_hash:
        return False
    return stored_hash == compute_shop_snapshot_hash()


_CACHE_VALIDATORS: Dict[str, CacheValidator] = {
    LIBRARY_CACHE_FILE: is_library_snapshot_current,
    LIBRARY_METADATA_CACHE_FILE: is_library_metadata_snapshot_current,
    OVERRIDES_CACHE_FILE: is_overrides_snapshot_current,
    SHOP_CACHE_FILE: is_shop_snapshot_current,
}

def generate_snapshot(path: str):
    """
    Regenerate a known cache snapshot given its file path.
    Dispatches to the correct builder so the cache is warm for next request.
    """
    try:
        if path == LIBRARY_CACHE_FILE:
            from library import load_or_generate_library_snapshot

            load_or_generate_library_snapshot(force_regenerate=True)
            logger.info(f"Regenerated library snapshot: {path}")
        elif path == LIBRARY_METADATA_CACHE_FILE:
            from metadata import load_or_generate_library_metadata_snapshot

            load_or_generate_library_metadata_snapshot(force_regenerate=True)
            logger.info(f"Regenerated library metadata snapshot: {path}")
        elif path == OVERRIDES_CACHE_FILE:
            from overrides import load_or_generate_overrides_snapshot

            load_or_generate_overrides_snapshot(force_regenerate=True)
            logger.info(f"Regenerated overrides snapshot: {path}")
        elif path == SHOP_CACHE_FILE:
            from shop import load_or_generate_shop_snapshot

            load_or_generate_shop_snapshot(force_regenerate=True)
            logger.info(f"Regenerated shop snapshot: {path}")
        else:
            logger.warning(f"Unknown snapshot path: {path}")
    except Exception as e:
        logger.error(f"Failed to regenerate {path}: {e}")


def regenerate_cache(*paths: str):
    """
    Force regeneration of one or more known cache snapshots.

    Accepts either a sequence of paths, or a single iterable of paths. The
    existing cache file is left in place until the snapshot builder finishes,
    so callers keep a fallback if regeneration fails.
    """
    if len(paths) == 1 and not isinstance(paths[0], str):
        candidate_paths = paths[0]
    else:
        candidate_paths = paths

    for path in candidate_paths:
        if not isinstance(path, str):
            logger.warning(f"Skipping non-string cache path: {path!r}")
            continue
        generate_snapshot(path)


def regenerate_all_caches():
    """
    Ensure all known cache snapshots are up-to-date without forcing rebuilds.
    """
    for path in (LIBRARY_CACHE_FILE, LIBRARY_METADATA_CACHE_FILE, OVERRIDES_CACHE_FILE, SHOP_CACHE_FILE):
        validator = _CACHE_VALIDATORS.get(path)
        if not validator:
            logger.warning(f"No validator registered for {path}; forcing regeneration.")
            generate_snapshot(path)
            continue

        name = os.path.basename(path)
        try:
            saved = load_json(path, default=None)
        except Exception as exc:
            logger.warning(f"Failed to load cache snapshot {path}: {exc}")
            saved = None

        if validator(saved):
            logger.debug(f"{name} cache is up-to-date; skipping regeneration.")
            continue

        logger.info(f"Refreshing {name}")
        generate_snapshot(path)

def _snapshot_recent_enough(saved: Optional[dict]) -> bool:
    if not isinstance(saved, dict):
        return False
    stamp = saved.get("generated_at")
    if not isinstance(stamp, str):
        return False
    try:
        generated = datetime.datetime.fromisoformat(stamp)
    except Exception:
        return False
    if generated.tzinfo is not None:
        generated = generated.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    age = datetime.datetime.utcnow() - generated
    return age.total_seconds() <= CACHE_MAX_AGE_SECONDS
