# overrides_api.py
from flask import Blueprint, request, jsonify, render_template, abort
from flask_login import login_required, current_user
from werkzeug.exceptions import BadRequest, NotFound
from sqlalchemy import and_, or_
from datetime import datetime
import os

from db import db, UserOverrides, Files


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
    data = _parse_json()

    if not any(data.get(k) for k in ("title_id", "file_basename", "app_id")):
        raise BadRequest("Provide at least one target: title_id, file_basename, or app_id.")

    uo = UserOverrides()
    _apply_fields(uo, data)
    uo.created_at = datetime.utcnow()
    uo.updated_at = datetime.utcnow()

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
    data = _parse_json()

    uo = UserOverrides.query.get(oid)
    if not uo:
        raise NotFound("Override not found.")

    _apply_fields(uo, data)
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


# ---------------------------------------------------------------------------
# ADMIN PAGE BLUEPRINT
# ---------------------------------------------------------------------------

admin_overrides = Blueprint("admin_overrides", __name__, url_prefix="/admin")


from sqlalchemy import and_, inspect
import titles as titles_lib  # add this import near the top

@admin_overrides.route("/overrides", methods=["GET"])
@login_required
def overrides_page():
    if not getattr(current_user, "is_admin", False):
        abort(403)

    from sqlalchemy import or_, inspect, tuple_
    # Problem buckets we care about
    BAD_TYPES = ["not_in_titledb", "exception", "unidentified"]

    files_q = (
        Files.query
        .filter(
            or_(
                Files.identified == False,  # noqa: E712
                Files.identification_type.in_(BAD_TYPES),
                Files.identification_error.isnot(None),
            )
        )
        .order_by(Files.size.desc().nullslast())
    )

    inspector = inspect(db.engine)
    has_uo = inspector.has_table("user_overrides")

    files = files_q.all()
    rows = []

    if not files:
        return render_template("overrides.html", items=[])

    # ---- Bulk-load overrides to avoid N+1 ----
    ov_by_filename = {}
    ov_by_key = {}

    if has_uo:
        # Build lookup keys from files
        filenames = {f.filename for f in files if getattr(f, "filename", None)}
        keys = {(getattr(f, "title_id", None), getattr(f, "app_id", None), getattr(f, "app_version", None))
                for f in files}
        keys.discard((None, None, None))

        q = UserOverrides.query.filter(UserOverrides.enabled.is_(True))
        # Load by filename in one go
        if filenames:
            for o in q.filter(UserOverrides.file_basename.in_(filenames)).all():
                ov_by_filename[o.file_basename] = o
        # Load by (title_id, app_id, app_version) in one go
        if keys:
            tups = list(keys)
            for o in q.filter(
                tuple_(UserOverrides.title_id, UserOverrides.app_id, UserOverrides.app_version).in_(tups)
            ).all():
                ov_by_key[(o.title_id, o.app_id, o.app_version)] = o

    # ---- Build response rows ----
    for f in files:
        ov = None
        k = (getattr(f, "title_id", None), getattr(f, "app_id", None), getattr(f, "app_version", None))
        if k in ov_by_key:
            ov = ov_by_key[k]
        elif getattr(f, "filename", None) in ov_by_filename:
            ov = ov_by_filename[f.filename]

        rows.append({
            "file_basename": getattr(f, "filename", None),
            "size": getattr(f, "size", None),
            "override_id": getattr(ov, "id", None) if ov else None,
            "override_name": getattr(ov, "name", None) if ov else None,
            "identification_type": getattr(f, "identification_type", None),
            "identification_error": getattr(f, "identification_error", None),
            "status": "Unidentified",  # keep your current label
            # include keys so the UI can save robustly
            "title_id": getattr(f, "title_id", None),
            "app_id": getattr(f, "app_id", None),
            "app_version": getattr(f, "app_version", None),
        })

    return render_template("overrides.html", items=rows)
