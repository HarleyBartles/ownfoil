from typing import Optional, Dict, Any
from sqlalchemy import or_

def _models():
    # Lazy import to avoid circular import at module import time
    from db import db, UserOverrides
    return db, UserOverrides

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


def find_user_override(
    *,
    title_id: Optional[str] = None,
    file_basename: Optional[str] = None,
    app_id: Optional[str] = None,
    app_version: Optional[str] = None,
):
    """
    Fetch the most relevant enabled override for the given selectors.
    """
    db, UserOverrides = _models()
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

def apply_user_override(base: Dict[str, Any], uo) -> Dict[str, Any]:
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

    # artwork (point to static paths)
    if uo.icon_path:
        merged["icon_url"] = f"/static/{uo.icon_path.lstrip('/')}"
    if uo.banner_path:
        merged["banner_url"] = f"/static/{uo.banner_path.lstrip('/')}"

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
    uo = find_user_override(
        title_id=title_id or base.get("title_id"),
        file_basename=file_basename or base.get("file_basename"),
        app_id=app_id or base.get("app_id"),
        app_version=app_version or base.get("app_version"),
    )
    return apply_user_override(base, uo)
