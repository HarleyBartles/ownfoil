import logging
import os

from constants import LIBRARY_CACHE_FILE, OVERRIDES_CACHE_FILE, SHOP_CACHE_FILE

logger = logging.getLogger("main")


def invalidate_cache(path: str) -> bool:
    """
    Delete a cache file if it exists.
    Returns True if removed, False if it wasn't there.
    """
    try:
        os.remove(path)
        logger.info(f"Invalidated: {path}")
        return True
    except FileNotFoundError:
        return False
    except Exception as e:
        logger.warning(f"Failed to invalidate {path}: {e}")
        return False


def generate_snapshot(path: str):
    """
    Regenerate a known cache snapshot given its file path.
    Dispatches to the correct builder so the cache is warm for next request.
    """
    try:
        if path == LIBRARY_CACHE_FILE:
            from library import load_or_generate_library

            load_or_generate_library()
            logger.info(f"Regenerated library snapshot: {path}")
        elif path == OVERRIDES_CACHE_FILE:
            from overrides import load_or_generate_overrides_snapshot

            load_or_generate_overrides_snapshot()
            logger.info(f"Regenerated overrides snapshot: {path}")
        elif path == SHOP_CACHE_FILE:
            from shop import load_or_generate_shop_snapshot

            load_or_generate_shop_snapshot()
            logger.info(f"Regenerated shop snapshot: {path}")
        else:
            logger.warning(f"Unknown snapshot path: {path}")
    except Exception as e:
        logger.error(f"Failed to regenerate {path}: {e}")


def invalidate_and_regenerate_cache(path: str):
    """
    Invalidate and regenerate a known cache snapshot given its file path.
    """
    invalidate_cache(path)
    generate_snapshot(path)


def regenerate_all_caches():
    """
    Invalidate and regenerate all known cache snapshots.
    """
    for path in (LIBRARY_CACHE_FILE, OVERRIDES_CACHE_FILE, SHOP_CACHE_FILE):
        logger.info(f"Refreshing {os.path.basename(path)}")
        invalidate_and_regenerate_cache(path)
