import datetime
import hashlib
import logging
import re
import unicodedata
from typing import Any, Dict, Iterable, Optional, Tuple

from flask import Blueprint, jsonify, request

from auth import access_required
from cache import compute_library_metadata_snapshot_hash, snapshot_has_required_shape
from constants import (
    APP_TYPE_BASE,
    APP_TYPE_DLC,
    LIBRARY_METADATA_CACHE_FILE,
    LIBRARY_METADATA_SNAPSHOT_VERSION,
)
from overrides import build_override_index
from utils import load_json, normalize_id, save_json
import titles as titles_lib

metadata_blueprint = Blueprint("metadata_blueprint", __name__, url_prefix="/api/metadata")
logger = logging.getLogger("main")

MetadataRecord = Dict[str, Any]
TOKEN_RE = re.compile(r"[a-z0-9]+")
COMBINING_MARKS_RE = re.compile(r"[\u0300-\u036f]")

@metadata_blueprint.route("", methods=["GET"])
@access_required("shop")
def get_library_metadata():
    payload, etag_hash = generate_library_metadata()
    resp = jsonify(payload)
    resp.set_etag(etag_hash)
    resp.headers["Vary"] = "Authorization"
    resp.headers["Cache-Control"] = "no-cache, private"
    return resp.make_conditional(request)


def generate_library_metadata() -> Tuple[dict, str]:
    snapshot = load_or_generate_library_metadata_snapshot()
    payload = snapshot.get("payload") or {}
    entries = payload.get("entries") or {}
    base_lookup = payload.get("base_display_by_prefix") or {}

    data = {
        "entries": entries,
        "base_display_by_prefix": base_lookup,
    }

    etag_hash = snapshot.get("hash") or hashlib.sha256(b":metadata:").hexdigest()
    return data, etag_hash


def load_or_generate_library_metadata_snapshot(force_regenerate: bool = False) -> dict:
    saved = load_json(LIBRARY_METADATA_CACHE_FILE, default=None)
    if not force_regenerate and snapshot_has_required_shape(
        saved,
        expected_version=LIBRARY_METADATA_SNAPSHOT_VERSION,
        payload_key="payload",
        payload_type=dict,
    ):
        return saved
    return _generate_library_metadata_snapshot(force_regenerate=force_regenerate)


def _generate_library_metadata_snapshot(*, force_regenerate: bool = False) -> dict:
    logger.info("Generating library metadata snapshot...")
    from library import load_or_generate_library_snapshot  # Local import to avoid circular dependency

    with titles_lib.titledb_session("generate_library_metadata"):
        library_snapshot = load_or_generate_library_snapshot(force_regenerate=force_regenerate)
        games = library_snapshot.get("library") or []

        overrides_by_app = _build_overrides_by_app()
        base_sort_name_by_id, base_display_by_prefix = _collect_base_maps(games, overrides_by_app)

        metadata_entries: Dict[str, MetadataRecord] = {}
        for game in games:
            app_id_norm = _normalized_id(game.get("app_id"), "app")
            if not app_id_norm:
                continue
            override = overrides_by_app.get(app_id_norm)
            record = _build_metadata_record(game, override, base_sort_name_by_id, base_display_by_prefix)
            record["search"] = _build_search_blob(game, override, record["display_title"])
            metadata_entries[app_id_norm] = record

        snapshot = {
            "hash": compute_library_metadata_snapshot_hash(),
            "snapshot_version": LIBRARY_METADATA_SNAPSHOT_VERSION,
            "generated_at": datetime.datetime.utcnow().isoformat(timespec="seconds"),
            "payload": {
                "entries": metadata_entries,
                "base_display_by_prefix": base_display_by_prefix,
            },
        }

        save_json(snapshot, LIBRARY_METADATA_CACHE_FILE)
        logger.info("Generating library metadata snapshot done.")
        return snapshot


def _first_nonempty(*values: Optional[str]) -> Optional[str]:
    for val in values:
        if isinstance(val, str):
            trimmed = val.strip()
            if trimmed:
                return trimmed
    return None


def _normalized_id(value: Optional[str], kind: str) -> str:
    if not isinstance(value, str):
        return ""
    trimmed = value.strip()
    if not trimmed:
        return ""
    try:
        normalized = normalize_id(trimmed, kind)
    except Exception:
        normalized = None
    if normalized:
        return normalized.upper()
    return trimmed.upper()


def _normalize_sort_text(value: Optional[str]) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFKD", str(value))
    stripped = "".join(ch for ch in text if not unicodedata.combining(ch))
    return stripped.casefold()


def _normalize_for_search(value: Optional[str]) -> str:
    if not isinstance(value, str):
        return ""
    text = unicodedata.normalize("NFKD", value)
    text = COMBINING_MARKS_RE.sub("", text)
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text


def _tokenize_search_terms(values: Iterable[Optional[str]]) -> list[str]:
    tokens: set[str] = set()
    for raw in values:
        normalized = _normalize_for_search(raw)
        if not normalized:
            continue
        for token in TOKEN_RE.findall(normalized):
            tokens.add(token)
    return sorted(tokens)


def _build_overrides_by_app() -> Dict[str, dict]:
    idx = build_override_index(include_disabled=False) or {}
    raw = idx.get("by_app") if isinstance(idx, dict) else {}
    overrides_by_app: Dict[str, dict] = {}
    projection_cache: Dict[str, dict] = {}
    if isinstance(raw, dict):
        for raw_app_id, payload in raw.items():
            if not isinstance(payload, dict):
                continue
            normalized_app_id = _normalized_id(raw_app_id, "app")
            if not normalized_app_id:
                continue

            entry: dict = dict(payload)

            corrected = _normalized_id(entry.get("corrected_title_id"), "title")
            if corrected:
                projection = projection_cache.get(corrected)
                if projection is None:
                    info = titles_lib.get_game_info(corrected) or {}
                    projection = {
                        "name": (info.get("name") or "").strip() or None,
                    }
                    projection_cache[corrected] = projection
                projection_name = _first_nonempty(projection.get("name"))
                if projection_name:
                    entry["projection_name"] = projection_name

            overrides_by_app[normalized_app_id] = entry
    return overrides_by_app


def _collect_base_maps(
    games: Iterable[dict],
    overrides_by_app: Dict[str, dict],
) -> Tuple[Dict[str, str], Dict[str, str]]:
    base_sort_name_by_id: Dict[str, str] = {}
    base_display_by_prefix: Dict[str, str] = {}

    for game in games:
        app_type = (game.get("app_type") or "").upper()
        if app_type != APP_TYPE_BASE:
            continue

        app_id_norm = _normalized_id(game.get("app_id"), "app")
        override = overrides_by_app.get(app_id_norm)
        override_display_name = None
        if override:
            override_display_name = _first_nonempty(
                override.get("name"),
                override.get("projection_name"),
            )

        display_name = _first_nonempty(
            override_display_name,
            game.get("title_id_name"),
            game.get("name"),
        ) or "Unrecognized"

        for candidate in (
            _normalized_id(game.get("title_id"), "title"),
            app_id_norm,
            _normalized_id(game.get("corrected_title_id"), "title"),
        ):
            if candidate:
                base_sort_name_by_id[candidate] = display_name

        corrected_override = _normalized_id((override or {}).get("corrected_title_id"), "title")
        if corrected_override:
            base_sort_name_by_id[corrected_override] = display_name

        if app_id_norm:
            base_display_by_prefix[app_id_norm[:12]] = display_name

    return base_sort_name_by_id, base_display_by_prefix


def _display_title_for_game(
    game: dict,
    override: Optional[dict],
    base_sort_name_by_id: Dict[str, str],
    base_display_by_prefix: Dict[str, str],
) -> str:
    app_type = (game.get("app_type") or "").upper()
    app_id_norm = _normalized_id(game.get("app_id"), "app")
    title_id_norm = _normalized_id(game.get("title_id"), "title")
    override_display_name = None
    if override:
        override_display_name = _first_nonempty(
            override.get("name"),
            override.get("projection_name"),
        )

    if app_type == APP_TYPE_DLC:
        base_sort_name = base_sort_name_by_id.get(title_id_norm)
        if not base_sort_name:
            corrected_override = _normalized_id((override or {}).get("corrected_title_id"), "title")
            if corrected_override:
                base_sort_name = base_sort_name_by_id.get(corrected_override)
        if not base_sort_name:
            corrected_game = _normalized_id(game.get("corrected_title_id"), "title")
            if corrected_game:
                base_sort_name = base_sort_name_by_id.get(corrected_game)
        if not base_sort_name and app_id_norm:
            base_sort_name = base_display_by_prefix.get(app_id_norm[:12])

        return _first_nonempty(
            base_sort_name,
            game.get("title_id_name"),
            override_display_name,
            game.get("name"),
        ) or "Unrecognized"

    return _first_nonempty(
        override_display_name,
        game.get("title_id_name"),
        game.get("name"),
    ) or "Unrecognized"


def _build_metadata_record(
    game: dict,
    override: Optional[dict],
    base_sort_name_by_id: Dict[str, str],
    base_display_by_prefix: Dict[str, str],
) -> MetadataRecord:
    app_type = (game.get("app_type") or "").upper()
    app_id_norm = _normalized_id(game.get("app_id"), "app")
    title_id_norm = _normalized_id(game.get("title_id"), "title")
    override_display_name = None
    if override:
        override_display_name = _first_nonempty(
            override.get("name"),
            override.get("projection_name"),
        )

    if app_type == APP_TYPE_DLC:
        base_sort_name = base_sort_name_by_id.get(title_id_norm)
        if not base_sort_name:
            corrected_override = _normalized_id((override or {}).get("corrected_title_id"), "title")
            if corrected_override:
                base_sort_name = base_sort_name_by_id.get(corrected_override)
        if not base_sort_name:
            corrected_game = _normalized_id(game.get("corrected_title_id"), "title")
            if corrected_game:
                base_sort_name = base_sort_name_by_id.get(corrected_game)

        sort_name = _first_nonempty(
            base_sort_name,
            game.get("title_id_name"),
            override_display_name,
            game.get("name"),
        ) or "Unrecognized"
        base_key = title_id_norm or app_id_norm
        sort_kind = 1
    elif app_type == APP_TYPE_BASE:
        sort_name = base_sort_name_by_id.get(title_id_norm) or (
            _first_nonempty(
                override_display_name,
                game.get("title_id_name"),
                game.get("name"),
            ) or "Unrecognized"
        )
        base_key = title_id_norm or app_id_norm
        sort_kind = 0
    else:
        sort_name = _first_nonempty(
            override_display_name,
            game.get("title_id_name"),
            game.get("name"),
        ) or "Unrecognized"
        base_key = title_id_norm or app_id_norm
        sort_kind = 2

    fallback = game.get("file_basename") or ""
    fallback_key = fallback.upper() if isinstance(fallback, str) else ""

    sort_tuple = (
        0 if sort_name else 1,
        _normalize_sort_text(sort_name),
        base_key,
        sort_kind,
        app_id_norm,
        fallback_key,
    )

    display_title = _display_title_for_game(
        game,
        override,
        base_sort_name_by_id,
        base_display_by_prefix,
    )

    metadata_record: MetadataRecord = {
        "sort": sort_tuple,
        "sort_name": sort_name,
        "sort_kind": sort_kind,
        "display_title": display_title,
        "base_key": base_key,
        "fallback": fallback,
    }

    search_tokens = _tokenize_search_terms(
        [
            game.get("app_id"),
            game.get("title_id"),
            game.get("dlc_title_id"),
            game.get("corrected_title_id"),
            game.get("name"),
            game.get("title_id_name"),
            game.get("base_name"),
            (override or {}).get("name"),
            display_title,
        ]
    )
    metadata_record["search"] = " ".join(search_tokens)
    metadata_record["search_tokens"] = search_tokens

    description_tokens = _tokenize_search_terms(
        [
            game.get("description"),
            (override or {}).get("description"),
        ]
    )
    if description_tokens:
        metadata_record["description_search"] = " ".join(description_tokens)
        metadata_record["description_search_tokens"] = description_tokens

    return metadata_record


def _build_search_blob(game: dict, override: Optional[dict], display_title: str) -> str:
    parts = []

    def add_text(value: Optional[str]):
        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed:
                parts.append(trimmed.lower())

    add_text(game.get("app_id"))
    add_text(game.get("title_id"))
    add_text(game.get("dlc_title_id"))
    add_text(game.get("corrected_title_id"))
    add_text(game.get("name"))
    add_text(game.get("title_id_name"))
    add_text(game.get("base_name"))

    if override:
        add_text(override.get("name"))

    add_text(display_title)

    return " ".join(parts)
