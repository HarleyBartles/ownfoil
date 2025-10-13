import os

from datetime import datetime
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from PIL import Image, ImageOps
from sqlalchemy import or_
from typing import Optional, Dict, Any
from werkzeug.exceptions import BadRequest, NotFound
from werkzeug.utils import secure_filename

from db import db, UserOverrides


# ---------------------------------------------------------------------------
# API BLUEPRINT
# ---------------------------------------------------------------------------

overrides_api = Blueprint("overrides_api", __name__, url_prefix="/api/overrides")


# --- helpers ---------------------------------------------------------------

def _best_override(candidates, title_id: Optional[str], file_basename: Optional[str],
                   app_id: Optional[str], app_version: Optional[str]):
    """
    Pick the 'best' override by stable keys. Priority:
      1) title_id
      2) (app_id + app_version) [optional, app-specific fix]
      3) file_basename
    """
    def score(uo) -> int:
        s = 0
        if title_id and uo.title_id == title_id:
            s += 100
        if app_id and app_version and uo.app_id == app_id and uo.app_version == app_version:
            s += 10
        if file_basename and uo.file_basename == file_basename:
            s += 1
        return s

    return max(candidates, key=score) if candidates else None


def _find_user_override(
    *,
    title_id: Optional[str] = None,
    file_basename: Optional[str] = None,
    app_id: Optional[str] = None,
    app_version: Optional[str] = None,
):
    """
    Fetch the most relevant enabled override for the given selectors.
    """
    filters = [UserOverrides.enabled.is_(True)]
    ors = []

    if title_id:
        ors.append(UserOverrides.title_id == title_id)
    if file_basename:
        ors.append(UserOverrides.file_basename == file_basename)
    if app_id:
        ors.append(UserOverrides.app_id == app_id)
    # app_version only matters if app_id matches
    if app_id and app_version:
        ors.append((UserOverrides.app_id == app_id) & (UserOverrides.app_version == app_version))

    if ors:
        q = UserOverrides.query.filter(*filters).filter(or_(*ors)).all()
    else:
        q = []

    return _best_override(q, title_id, file_basename, app_id, app_version)


_OVERRIDABLE_FIELDS = (
    "name", "publisher", "region", "description", "content_type", "version",
)

def _apply_user_override(base: Dict[str, Any], uo) -> Dict[str, Any]:
    """
    Given a base dict of title/app/file metadata, apply override fields if present.
    Expected base keys (best-effort): title_id, file_basename, app_id, app_version, name, icon_url, banner_url, ...
    Returns a *new* dict (does not mutate input).
    """
    if not uo:
        return dict(base)

    merged = dict(base)

    # overlay text fields
    for f in _OVERRIDABLE_FIELDS:
        v = getattr(uo, f)
        if v:  # only replace when override provides a value
            merged[f] = v

    # artwork: use public paths as-is (e.g., /uploads/banners/...), only prefix /static for relative asset paths
    def _public_url(p: Optional[str]) -> Optional[str]:
        if not p:
            return None
        # absolute URLs or app-served absolute paths should be used as-is
        if p.startswith("http://") or p.startswith("https://") or p.startswith("/"):
            return p
        # otherwise treat as a static asset path
        return f"/static/{p.lstrip('/')}"

    if uo.icon_path:
        merged["icon_url"] = _public_url(uo.icon_path)
    if uo.banner_path:
        merged["banner_url"] = _public_url(uo.banner_path)

    # helpful hint for UIs
    merged["overridden"] = True
    return merged


def merge_with_override(
    base: Dict[str, Any],
    *,
    title_id: Optional[str] = None,
    file_basename: Optional[str] = None,
    app_id: Optional[str] = None,
    app_version: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Convenience: find + apply in one call.
    """
    uo = _find_user_override(
        title_id=title_id or base.get("title_id"),
        file_basename=file_basename or base.get("file_basename"),
        app_id=app_id or base.get("app_id"),
        app_version=app_version or base.get("app_version"),
    )
    return _apply_user_override(base, uo)

def require_admin():
    if not getattr(current_user, "is_authenticated", False) or not current_user.is_admin:
        raise BadRequest("Admin access required.")

# Note: UI sends multipart only when a banner upload/removal is requested; otherwise JSON.
# This keeps existing JSON flows working while enabling binary upload.
def _parse_payload():
    """
    Accept either JSON (application/json) or multipart/form-data.
    Returns (data_dict, banner_file, banner_remove_flag).
    - data_dict: dict of fields for _apply_fields
    - banner_file: FileStorage or None
    - banner_remove_flag: bool
    """
    banner_file = None
    banner_remove = False

    ctype = (request.content_type or "").lower()

    if ctype.startswith("multipart/form-data"):
        # Read textual fields from form, file from files
        form = request.form or {}
        data = {k: form.get(k) for k in form.keys()}

        # normalize booleans that might come from form
        for k in ("enabled", ):
            if k in data and isinstance(data[k], str):
                data[k] = data[k].lower() in ("1", "true", "yes", "on")

        # explicit removal flag
        banner_remove = (form.get("banner_remove", "").lower() in ("1", "true", "yes", "on"))

        banner_file = request.files.get("banner_file") or request.files.get("file")

        return data, banner_file, banner_remove

    # default: JSON
    data = request.get_json(silent=True)
    if data is None:
        raise BadRequest("Expected application/json or multipart/form-data body.")
    # in JSON mode, allow banner_remove true|false
    banner_remove = bool(data.get("banner_remove")) if isinstance(data, dict) else False
    return data, None, banner_remove


def _apply_fields(uo: UserOverrides, data: dict):
    # Only touch known fields; ignore extras to keep it robust.
    fields = [
        "title_id", "file_basename", "app_id", "app_version",
        "name", "publisher", "region", "description", "content_type", "version",
        "icon_path", "banner_path", "enabled",
    ]
    for f in fields:
        if f in data:
            setattr(uo, f, data[f])

ALLOWED_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}

def _allowed_image(filename: str) -> bool:
    if not filename:
        return False
    _, ext = os.path.splitext(filename.lower())
    return ext in ALLOWED_IMAGE_EXTS

def _ext_for_content_type(content_type: str) -> str:
    # Best-effort fallback if the filename extension is missing/untrusted
    if content_type == 'image/jpeg':
        return '.jpg'
    if content_type == 'image/png':
        return '.png'
    if content_type == 'image/webp':
        return '.webp'
    return ''

def _serialize_with_banner_url(uo: UserOverrides) -> dict:
    d = uo.as_dict()
    d["bannerUrl"] = d.get("banner_path")
    return d

# We always normalize to PNG on disk for consistency, regardless of input type.
# Public path is /uploads/banners/<title_id>_banner.png served by uploaded_banners() in create_app().
def _save_banner_file_for_title(title_id: str, file_storage) -> str:
    """
    Save the uploaded banner image for a title and return the public URL.
    - Validates input type (jpg/jpeg/png/webp)
    - Crops+resizes to 400x225 (center-cover)
    - ALWAYS saves as PNG on disk: <title_id>_banner.png
    - Overwrites/removes any prior banner regardless of previous extension
    """
    filename = secure_filename(file_storage.filename or "")
    in_ext = os.path.splitext(filename)[1].lower()

    # Validate input type (by extension or MIME fallback)
    if not _allowed_image(filename):
        in_ext = _ext_for_content_type(getattr(file_storage, "mimetype", "") or "")
        if not in_ext or in_ext not in ALLOWED_IMAGE_EXTS:
            raise BadRequest("Unsupported file type. Allowed: .jpg .jpeg .png .webp")

    # Deterministic output name (always .png)
    out_ext = ".png"
    out_name = f"{title_id}_banner{out_ext}"
    banners_dir = current_app.config["BANNERS_UPLOAD_DIR"]
    os.makedirs(banners_dir, exist_ok=True)
    dst_path = os.path.join(banners_dir, out_name)

    # Remove any older banner with any allowed extension (including .png)
    for old_ext in ALLOWED_IMAGE_EXTS.union({".png"}):
        old_path = os.path.join(banners_dir, f"{title_id}_banner{old_ext}")
        if old_path != dst_path and os.path.exists(old_path):
            try:
                os.remove(old_path)
            except OSError:
                pass

    # Crop+resize to 400x225 (center-cover) using Pillow, then save as PNG
    TARGET_W, TARGET_H = 400, 225
    try:
        file_storage.stream.seek(0)
    except Exception:
        pass

    with Image.open(file_storage.stream) as im:
        # Respect EXIF orientation
        im = ImageOps.exif_transpose(im)

        # --- COVER-SCALE FIRST, THEN CENTER-CROP ---
        src_w, src_h = im.size
        if src_w == 0 or src_h == 0:
            raise BadRequest("Invalid image.")

        # Scale so the resized image fully covers the target box (no letterboxing)
        scale = max(TARGET_W / src_w, TARGET_H / src_h)
        new_w = int(round(src_w * scale))
        new_h = int(round(src_h * scale))
        if (new_w, new_h) != (src_w, src_h):
            im = im.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # Now center-crop to exactly 400x225
        left = max(0, (im.width  - TARGET_W) // 2)
        top  = max(0, (im.height - TARGET_H) // 2)
        box = (left, top, left + TARGET_W, top + TARGET_H)
        im = im.crop(box)

        # Choose mode for PNG (keep alpha if present; otherwise RGB)
        if im.mode not in ("RGB", "RGBA"):
            if "A" in im.getbands():
                im = im.convert("RGBA")
            else:
                im = im.convert("RGB")

        # Save as PNG (optimize)
        im.save(dst_path, format="PNG", optimize=True, compress_level=9)

    public_url = f"{current_app.config['BANNERS_UPLOAD_URL_PREFIX'].rstrip('/')}/{out_name}"
    return public_url

def _delete_banner_file_if_owned(public_path: str) -> None:
    """
    If public_path points inside our /uploads/banners prefix, delete the file.
    """
    if not public_path:
        return
    prefix = current_app.config['BANNERS_UPLOAD_URL_PREFIX'].rstrip('/') + '/'
    if public_path.startswith(prefix):
        rel_name = public_path[len(prefix):]
        fpath = os.path.join(current_app.config['BANNERS_UPLOAD_DIR'], rel_name)
        if os.path.exists(fpath):
            try:
                os.remove(fpath)
            except OSError:
                pass

# --- routes ----------------------------------------------------------------

@overrides_api.get("")
@login_required
def list_overrides():
    require_admin()

    # filters (optional)
    title_id = request.args.get("title_id")
    file_basename = request.args.get("file_basename")
    app_id = request.args.get("app_id")
    enabled = request.args.get("enabled")

    q = UserOverrides.query
    if title_id:
        q = q.filter(UserOverrides.title_id == title_id)
    if file_basename:
        q = q.filter(UserOverrides.file_basename == file_basename)
    if app_id:
        q = q.filter(UserOverrides.app_id == app_id)
    if enabled is not None:
        # treat "true"/"1" as True, "false"/"0" as False
        enabled_bool = enabled.lower() in ("1", "true", "yes", "on")
        q = q.filter(UserOverrides.enabled.is_(enabled_bool))

    # simple pagination
    page = int(request.args.get("page", 1))
    page_size = min(int(request.args.get("page_size", 100)), 500)

    rows = (
        q.order_by(UserOverrides.updated_at.desc())
        .paginate(page=page, per_page=page_size, error_out=False)
    )

    return jsonify({
        "items": [_serialize_with_banner_url(r) for r in rows.items],
        "page": rows.page,
        "pages": rows.pages,
        "total": rows.total,
    })


@overrides_api.get("/<int:oid>")
@login_required
def get_override(oid: int):
    require_admin()
    uo = UserOverrides.query.get(oid)
    if not uo:
        raise NotFound("Override not found.")
    return jsonify(_serialize_with_banner_url(uo))


@overrides_api.post("")
@login_required
def create_override():
    require_admin()
    data, banner_file, banner_remove = _parse_payload()

    # Defaults / normalization
    data = data or {}
    data.setdefault("enabled", True)

    # Empty strings → None for text fields
    for k in (
        "file_basename", "name", "title_id", "app_id",
        "publisher", "region", "description", "content_type",
        "version", "icon_path", "banner_path"
    ):
        if k in data and isinstance(data[k], str) and not data[k].strip():
            data[k] = None

    # Normalize app_version (int or None)
    if "app_version" in data:
        try:
            data["app_version"] = int(data["app_version"]) if data["app_version"] not in (None, "") else None
        except (TypeError, ValueError):
            data["app_version"] = None

    # Require at least one targeting key after normalization
    if not any(data.get(k) for k in ("title_id", "file_basename", "app_id")):
        raise BadRequest("Provide at least one target: title_id, file_basename, or app_id.")

    # Create + apply fields
    uo = UserOverrides()
    _apply_fields(uo, data)

    # If a banner file is provided, save it now (prefer title_id if present)
    title_id_for_banner = uo.title_id or data.get("title_id")
    if banner_file and title_id_for_banner:
        public_url = _save_banner_file_for_title(title_id_for_banner, banner_file)
        uo.banner_path = public_url

    # if requested to remove banner (even on create), ensure cleared
    if banner_remove and uo.banner_path:
        _delete_banner_file_if_owned(uo.banner_path)
        uo.banner_path = None

    # Timestamps
    uo.created_at = datetime.utcnow()
    uo.updated_at = datetime.utcnow()

    # Persist
    db.session.add(uo)
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        raise BadRequest(f"Could not create override: {e}")

    return jsonify(_serialize_with_banner_url(uo)), 201

@overrides_api.put("/<int:oid>")
@login_required
def update_override(oid: int):
    require_admin()
    data, banner_file, banner_remove = _parse_payload()
    data = data or {}

    # Empty strings → None for text fields
    for k in (
        "file_basename", "name", "title_id", "app_id",
        "publisher", "region", "description", "content_type",
        "version", "icon_path", "banner_path"
    ):
        if k in data and isinstance(data[k], str) and not data[k].strip():
            data[k] = None

    # Normalize app_version (int or None)
    if "app_version" in data:
        try:
            data["app_version"] = int(data["app_version"]) if data["app_version"] not in (None, "") else None
        except (TypeError, ValueError):
            data["app_version"] = None

    uo = UserOverrides.query.get(oid)
    if not uo:
        raise NotFound("Override not found.")

    # Apply updated fields (title_id may change)
    _apply_fields(uo, data)

    # Handle banner remove first if requested
    if banner_remove and uo.banner_path:
        _delete_banner_file_if_owned(uo.banner_path)
        uo.banner_path = None

    # If a new banner file is provided, save it against the (possibly updated) title_id
    if banner_file:
        title_id_for_banner = uo.title_id or data.get("title_id")
        if not title_id_for_banner:
            raise BadRequest("A title_id is required to save a banner image.")
        public_url = _save_banner_file_for_title(title_id_for_banner, banner_file)
        uo.banner_path = public_url

    uo.updated_at = datetime.utcnow()

    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        raise BadRequest(f"Could not update override: {e}")

    return jsonify(_serialize_with_banner_url(uo))

@overrides_api.delete("/<int:oid>")
@login_required
def delete_override(oid: int):
    require_admin()
    uo = UserOverrides.query.get(oid)
    if not uo:
        raise NotFound("Override not found.")
    
    if uo.banner_path:
        _delete_banner_file_if_owned(uo.banner_path)

    db.session.delete(uo)
    db.session.commit()
    return jsonify({"ok": True, "deleted_id": oid})

