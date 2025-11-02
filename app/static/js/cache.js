/* eslint-disable no-console */
'use strict';

// Shared caching helpers for localStorage-backed JSON snapshots.
// Relies on jQuery's $.ajax for conditional requests.

((global, $) => {
  if (!$) {
    console.warn('Ownfoil Cache helpers require jQuery.');
    return;
  }

  const namespace = global.Ownfoil = global.Ownfoil || {};
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  const cacheNs = namespace.Cache = namespace.Cache || {};
  cacheNs.TTL_MS = Number.isFinite(cacheNs.TTL_MS) ? cacheNs.TTL_MS : DEFAULT_TTL_MS;

  const cacheKeys = namespace.CacheKeys = namespace.CacheKeys || {};
  cacheKeys.titles = cacheKeys.titles || 'ownfoil.cache.titles.v1';
  cacheKeys.metadata = cacheKeys.metadata || 'ownfoil.cache.library-metadata.v1';
  cacheKeys.overrides = cacheKeys.overrides || 'ownfoil.cache.overrides.v1';
  cacheKeys.library = cacheKeys.library || 'ownfoil.cache.library-combined.v1';

  const now = () => Date.now();

  function _coerceTtl(options) {
    if (!options) return cacheNs.TTL_MS;
    const explicit = Number(options.ttlMs);
    return Number.isFinite(explicit) && explicit > 0 ? explicit : cacheNs.TTL_MS;
  }

  cacheNs.loadSnapshot = function loadSnapshot(key, options) {
    const ttlMs = _coerceTtl(options);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const savedAt = Number(parsed.savedAt);
      if (!Number.isFinite(savedAt)) return null;
      const etag = (typeof parsed.etag === 'string' && parsed.etag.trim()) ? parsed.etag.trim() : null;
      const age = now() - savedAt;
      return {
        data: parsed.data ?? null,
        etag,
        savedAt,
        isFresh: age <= ttlMs,
      };
    } catch {
      return null;
    }
  };

  cacheNs.persistSnapshot = function persistSnapshot(key, etag, data) {
    if (data == null) return;
    const payload = {
      data,
      etag: etag || null,
      savedAt: now(),
    };
    try {
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      // Ignore storage failures (quota, private browsing, etc.)
    }
  };

  cacheNs.touchSnapshot = function touchSnapshot(key, snapshot, etagOverride) {
    if (!snapshot || snapshot.data == null) return;
    cacheNs.persistSnapshot(key, etagOverride || snapshot.etag || null, snapshot.data);
  };

  cacheNs.createLibraryCombinedManager = function createLibraryCombinedManager(options = {}) {
    const storageKey = cacheKeys.library;
    if (!storageKey) {
      return {
        load: () => null,
        persist: () => {},
        touch: () => {},
        clear: () => {},
      };
    }

    const version = Number.isFinite(options.version) ? Number(options.version) : 1;
    const combineEtags = (etags = {}) => [
      etags.titles || '',
      etags.metadata || '',
      etags.overrides || '',
    ].join('|');

    const normalizeEtags = (etags = {}) => ({
      titles: etags.titles || null,
      metadata: etags.metadata || null,
      overrides: etags.overrides || null,
    });

    const load = () => {
      if (typeof cacheNs.loadSnapshot !== 'function') return null;
      try {
        const snapshot = cacheNs.loadSnapshot(storageKey, options);
        if (!snapshot || snapshot.isFresh === false) return null;
        const data = snapshot.data;
        if (!data || typeof data !== 'object') return null;
        if (data.version !== version) return null;
        if (!Array.isArray(data.games)) return null;
        return {
          version,
          games: data.games,
          totalGames: Number.isFinite(data.totalGames) ? data.totalGames : data.games.length,
          metadataEntries: typeof data.metadataEntries === 'object' && data.metadataEntries
            ? data.metadataEntries
            : {},
          baseDisplayByPrefix: typeof data.baseDisplayByPrefix === 'object' && data.baseDisplayByPrefix
            ? data.baseDisplayByPrefix
            : {},
          etags: normalizeEtags(data.etags || {}),
          raw: snapshot,
        };
      } catch {
        return null;
      }
    };

    const persist = (payload, etags) => {
      if (typeof cacheNs.persistSnapshot !== 'function') return;
      if (!payload || !Array.isArray(payload.games)) return;
      const normalizedEtags = normalizeEtags(etags || {});
      const data = {
        version,
        games: payload.games,
        totalGames: Number.isFinite(payload.totalGames) ? payload.totalGames : payload.games.length,
        metadataEntries: typeof payload.metadataEntries === 'object' && payload.metadataEntries
          ? payload.metadataEntries
          : {},
        baseDisplayByPrefix: typeof payload.baseDisplayByPrefix === 'object' && payload.baseDisplayByPrefix
          ? payload.baseDisplayByPrefix
          : {},
        etags: normalizedEtags,
      };
      cacheNs.persistSnapshot(storageKey, combineEtags(normalizedEtags), data);
    };

    const touch = (loadedSnapshot, overrideEtags) => {
      if (typeof cacheNs.touchSnapshot !== 'function') return;
      if (!loadedSnapshot || !loadedSnapshot.raw) return;
      const etagsToUse = normalizeEtags(overrideEtags || loadedSnapshot.etags || {});
      cacheNs.touchSnapshot(storageKey, loadedSnapshot.raw, combineEtags(etagsToUse));
    };

    const clear = () => {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Ignore storage errors (e.g., private browsing, quota issues)
      }
    };

    return { load, persist, touch, clear };
  };

  cacheNs.conditionalFetch = function conditionalFetch(options = {}) {
    const { url, storageKey, allowStaleFallback = false } = options;
    if (!url || !storageKey) {
      return Promise.reject(new Error('conditionalFetch requires url and storageKey'));
    }

    const cached = cacheNs.loadSnapshot(storageKey, options);
    const cachedEtag = cached?.etag || null;

    return new Promise((resolve, reject) => {
      $.ajax({
        url,
        method: 'GET',
        dataType: 'json',
        ifModified: true,
        beforeSend: (xhr) => {
          if (cachedEtag) xhr.setRequestHeader('If-None-Match', cachedEtag);
        },
        success: (data, _statusText, xhr) => {
          const responseEtag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || null;
          if (data != null) {
            cacheNs.persistSnapshot(storageKey, responseEtag, data);
            resolve({ data, etag: responseEtag, fromCache: false });
            return;
          }

          if (cached && cached.data != null) {
            cacheNs.touchSnapshot(storageKey, cached, responseEtag || cached.etag || null);
            resolve({ data: cached.data, etag: responseEtag || cached.etag || null, fromCache: true });
            return;
          }

          resolve({ data: null, etag: responseEtag || null, fromCache: false });
        },
        error: () => {
          if (allowStaleFallback && cached && cached.data != null && cached.isFresh) {
            resolve({ data: cached.data, etag: cached.etag || null, fromCache: true });
            return;
          }
          reject(new Error(`Failed to fetch ${url}`));
        },
      });
    });
  };
})(window, window.jQuery);
