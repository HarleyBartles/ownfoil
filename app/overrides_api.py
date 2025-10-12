# overrides_api.py
from flask import Blueprint, request, jsonify, render_template, abort
from flask_login import login_required, current_user
from werkzeug.exceptions import BadRequest, NotFound
from sqlalchemy import and_, inspect, or_
from datetime import datetime
import os
import re
import titles as titles_lib

from db import db, UserOverrides, Files

hex16 = re.compile(r'^[0-9A-Fa-f]{16}$')

def _clean_hex16(value):
    if value is None:
        return None
    v = str(value).strip()
    if v == "":
        return None
    # allow non-hex during entry (UI is lenient), but prefer to persist only valid 16-hex
    return v.upper() if hex16.match(v) else v.upper()  # keep entered value; you can tighten if you want

def _to_int_or_none(v):
    if v in (None, ""):
        return None
    try:
        n = int(v)
        if n < 0:
            return None
        return n
    except Exception:
        return None

def _nonempty(s):
    if s is None:
        return None
    s = str(s).strip()
    return s or None


# ---------------------------------------------------------------------------
# API BLUEPRINT
# ---------------------------------------------------------------------------

overrides_api = Blueprint("overrides_api", __name__, url_prefix="/api/overrides")


# --- helpers ---------------------------------------------------------------

def require_admin():
    if not getattr(current_user, "is_authenticated", False) or not current_user.is_admin:
        raise BadRequest("Admin access required.")


def _parse_json():
    payload = request.get_json(silent=True)
    if payload is None:
        raise BadRequest("Expected application/json body.")
    return payload


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
        "items": [r.as_dict() for r in rows.items],
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
    return jsonify(uo.as_dict())


@overrides_api.post("")
@login_required
def create_override():
    require_admin()
    data = _parse_json() or {}

    # Defaults / normalization
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

    # Timestamps
    from datetime import datetime
    uo.created_at = datetime.utcnow()
    uo.updated_at = datetime.utcnow()

    # Persist
    db.session.add(uo)
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        raise BadRequest(f"Could not create override: {e}")

    return jsonify(uo.as_dict()), 201

@overrides_api.put("/<int:oid>")
@login_required
def update_override(oid: int):
    require_admin()
    data = _parse_json() or {}

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

    # Apply updated fields
    _apply_fields(uo, data)
    from datetime import datetime
    uo.updated_at = datetime.utcnow()

    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        raise BadRequest(f"Could not update override: {e}")

    return jsonify(uo.as_dict())

@overrides_api.delete("/<int:oid>")
@login_required
def delete_override(oid: int):
    require_admin()
    uo = UserOverrides.query.get(oid)
    if not uo:
        raise NotFound("Override not found.")

    db.session.delete(uo)
    db.session.commit()
    return jsonify({"ok": True, "deleted_id": oid})

