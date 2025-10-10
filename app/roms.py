from flask import Blueprint, current_app, jsonify, request, send_file, abort, Response
from pathlib import Path
from urllib.parse import quote

import logging
import re
import os

from settings import load_settings
from shop import encrypt_shop 

from constants import ALLOWED_EXTENSIONS
EXTS = {e.lower().lstrip(".") for e in ALLOWED_EXTENSIONS}

roms_bp = Blueprint("roms", __name__)
logger = logging.getLogger("roms")


def _normalize_roots(roots) -> list[str]:
    """
    Accepts either a list[str] or a single string like '/roms;/more/roms'.
    Splits on ';' and ',' and strips.
    """
    if isinstance(roots, str):
        parts = [p.strip() for p in re.split(r"[;,]", roots) if p.strip()]
        return parts
    return list(roots or [])

def _find_subdir_casefold(base: Path, name: str) -> Path | None:
    if not base.exists() or not base.is_dir():
        return None
    for cand in (name, name.lower(), name.upper(), name.capitalize()):
        p = base / cand
        if p.exists() and p.is_dir():
            return p
    name_cf = name.casefold()
    for child in base.iterdir():
        if child.is_dir() and child.name.casefold() == name_cf:
            return child
    return None

def _iter_rom_files(roots: list[str]):
    for root in roots:
        base = Path(root).resolve()
        if not base.exists() or not base.is_dir():
            continue

        # Walk without following symlinks to avoid /proc, /sys, etc.
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            # prune symlinked directories
            dirnames[:] = [d for d in dirnames
                           if not Path(dirpath, d).is_symlink()]

            for fn in filenames:
                try:
                    p = Path(dirpath) / fn
                    # skip symlinks and unreadable files quickly
                    if p.is_symlink():
                        continue
                    # extension check
                    if p.suffix.lower().lstrip(".") not in EXTS:
                        continue
                    # touch stat to ensure readable; skip if denied
                    _ = p.stat()
                except OSError:
                    logger.warning("UNABLE TO READ FILE: %s", p)
                    continue

                yield base, p.relative_to(base)

def _iter_rom_files_in_subdir(roots: list[str], subdir_name: str):
    for root in roots:
        base = Path(root).resolve()
        
        sub_base = _find_subdir_casefold(base, subdir_name)
        logger.info("ROM PATH CHECK: root=%s sub=%s exists=%s", base, sub_base, bool(sub_base))
        if not sub_base:
            continue

        sub_base = sub_base.resolve()
        if not sub_base.exists() or not sub_base.is_dir():
            continue

        for dirpath, dirnames, filenames in os.walk(sub_base, followlinks=False):
            dirnames[:] = [d for d in dirnames if not Path(dirpath, d).is_symlink()]
            for fn in filenames:
                try:
                    p = Path(dirpath) / fn
                    if p.is_symlink():
                        continue
                    if p.suffix.lower().lstrip(".") not in EXTS:
                        continue
                    _ = p.stat()
                except OSError:
                    logger.warning("UNABLE TO READ FILE: %s", p)
                    continue

                # IMPORTANT: yield the SNES subfolder as "base" so /roms/download
                # stays sandboxed in that subtree by your _is_safe_path check.
                yield sub_base, p.relative_to(sub_base)

def _is_safe_path(base: Path, target: Path) -> bool:
    try:
        base_resolved = base.resolve(strict=True)
        target_resolved = target.resolve(strict=True)
        # Will raise ValueError if target is not under base
        target_resolved.relative_to(base_resolved)
        return True
    except Exception:
        return False

def _maybe_encrypt(payload):
    app_settings = load_settings()
    if app_settings["shop"].get("encrypt"):
        return Response(encrypt_shop(payload), mimetype="application/octet-stream")
    return jsonify(payload)

@roms_bp.route("/roms/snes", methods=["GET"], strict_slashes=False)
def roms_snes():
    raw = getattr(current_app, "ROM_PATHS", [])
    roots = _normalize_roots(raw)
    logger.info("ROM_PATHS(normalized) = %s", roots)
    host = request.host_url.rstrip("/")
    
    files = []
    for base, rel in _iter_rom_files_in_subdir(roots, "SNES"):
        abs_url = (
            f"{host}/roms/download"
            f"?root={quote(str(base))}"
            f"&path={quote(str(rel).replace(os.sep, '/'))}"
        )
        # include size – Tinfoil prefers objects with url+size
        size = (base / rel).stat().st_size
        files.append({"url": abs_url, "size": size})

    payload = {"files": files, "success": "SNES ROMs"}

    # ✅ Only include referrer if the decorator set it
    if getattr(request, "verified_host", None):
        payload["referrer"] = f"https://{request.verified_host}"

    logger.info("SNES index hit; files=%d, referrer=%s", len(files), getattr(request, "verified_host", None))

    # mirror the root shop’s encryption behavior
    return _maybe_encrypt(payload)

@roms_bp.route("/roms", methods=["GET"])
def roms_index():
    """
    Tinfoil custom-index JSON. It accepts JSON with:
      { "files": [...], "directories": [...] }
    We populate "files" with HTTP links to our own download route.
    """
    raw = getattr(current_app, "ROM_PATHS", [])
    roots = _normalize_roots(raw)
    host = request.host_url.rstrip("/")
    files = []
    for base, rel in _iter_rom_files(roots):
        # We encode root marker and relpath so the download route can map safely
        files.append(f"{host}/roms/download?root={quote(str(base))}&path={quote(str(rel).replace(os.sep, '/'))}")
    return jsonify({"files": files, "success": "ROMs"})

@roms_bp.route("/roms/download", methods=["GET"])
def roms_download():
    root = request.args.get("root")
    rel = request.args.get("path")
    if not root or not rel:
        abort(400)

    base = Path(root).resolve()
    target = (base / rel).resolve()
    if not _is_safe_path(base, target):
        abort(403)
    if not target.exists() or not target.is_file():
        abort(404)

    # Let Tinfoil stream it. Don’t force attachment.
    return send_file(str(target), as_attachment=False)
