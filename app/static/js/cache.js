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
  cacheKeys.library = cacheKeys.library || 'ownfoil.cache.library.v1';
  cacheKeys.metadata = cacheKeys.metadata || 'ownfoil.cache.library-metadata.v1';
  cacheKeys.overrides = cacheKeys.overrides || 'ownfoil.cache.overrides.v1';

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
