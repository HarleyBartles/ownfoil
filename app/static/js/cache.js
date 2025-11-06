/* eslint-disable no-console */
'use strict';

// Shared caching helpers for async snapshot management with IndexedDB fallback to localStorage.
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
  cacheKeys.titles = cacheKeys.titles || 'ownfoil.cache.titles.v2';
  cacheKeys.metadata = cacheKeys.metadata || 'ownfoil.cache.library-metadata.v2';
  cacheKeys.overrides = cacheKeys.overrides || 'ownfoil.cache.overrides.v2';
  cacheKeys.library = cacheKeys.library || 'ownfoil.cache.library-combined.v2';

  const now = () => Date.now();
  const supportsIndexedDb = typeof global.indexedDB !== 'undefined';

  const IDB_CONFIG = {
    name: 'ownfoil-cache',
    version: 1,
    store: 'snapshots',
  };

  let openDbPromise = null;

  function _coerceTtl(options) {
    if (!options) return cacheNs.TTL_MS;
    const explicit = Number(options.ttlMs);
    return Number.isFinite(explicit) && explicit > 0 ? explicit : cacheNs.TTL_MS;
  }

  function _normalizeSnapshotObject(raw, ttlMs) {
    if (!raw || typeof raw !== 'object') return null;
    const savedAt = Number(raw.savedAt);
    if (!Number.isFinite(savedAt)) return null;
    const age = now() - savedAt;
    const etag = (typeof raw.etag === 'string' && raw.etag.trim()) ? raw.etag.trim() : null;
    return {
      data: raw.data ?? null,
      etag,
      savedAt,
      isFresh: age <= ttlMs,
      raw,
    };
  }

  function _deserializeLocalStorage(raw, ttlMs) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return _normalizeSnapshotObject(parsed, ttlMs);
    } catch {
      return null;
    }
  }

  async function openDatabase() {
    if (!supportsIndexedDb) return null;
    if (openDbPromise) return openDbPromise;

    openDbPromise = new Promise((resolve, reject) => {
      try {
        const request = global.indexedDB.open(IDB_CONFIG.name, IDB_CONFIG.version);
        request.onerror = () => reject(request.error || new Error('indexedDB open failed'));
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
            db.createObjectStore(IDB_CONFIG.store);
          }
        };
      } catch (err) {
        reject(err);
      }
    }).catch((err) => {
      console.warn('Ownfoil cache: indexedDB unavailable', err);
      return null;
    });

    return openDbPromise;
  }

  async function withStore(mode, callback) {
    const db = await openDatabase();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(IDB_CONFIG.store, mode);
        const store = tx.objectStore(IDB_CONFIG.store);
        const request = callback(store);
        tx.oncomplete = () => resolve(request?.result ?? null);
        tx.onerror = () => reject(tx.error || new Error('indexedDB transaction failed'));
      } catch (err) {
        reject(err);
      }
    }).catch(() => null);
  }

  async function idbGet(key) {
    if (!key) return null;
    return withStore('readonly', (store) => store.get(key));
  }

  async function idbPut(key, value) {
    if (!key) return false;
    const result = await withStore('readwrite', (store) => store.put(value, key));
    return result !== null;
  }

  async function idbDelete(key) {
    if (!key) return false;
    const result = await withStore('readwrite', (store) => store.delete(key));
    return result !== null;
  }

  function persistToLocalStorage(key, payload) {
    if (!key || !payload) return;
    try {
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      // Ignore localStorage write failures (quota, private browsing, etc.)
    }
  }

  function removeFromLocalStorage(key) {
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore removal errors
    }
  }

  function loadFromLocalStorage(key, ttlMs) {
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      return _deserializeLocalStorage(raw, ttlMs);
    } catch {
      return null;
    }
  }

  async function loadSnapshotAsync(key, options) {
    if (!key) return null;
    const ttlMs = _coerceTtl(options);

    const fromIdb = await idbGet(key);
    const normalized = _normalizeSnapshotObject(fromIdb, ttlMs);
    if (normalized) return normalized;

    return loadFromLocalStorage(key, ttlMs);
  }

  function loadSnapshotSync(key, options) {
    return loadFromLocalStorage(key, _coerceTtl(options));
  }

  async function persistSnapshotAsync(key, etag, data) {
    if (!key || data == null) return;
    const payload = {
      data,
      etag: etag || null,
      savedAt: now(),
    };

    let stored = false;
    if (supportsIndexedDb) {
      stored = await idbPut(key, payload);
      if (!stored) {
        await idbDelete(key);
      }
    }

    if (!stored) {
      persistToLocalStorage(key, payload);
    } else {
      removeFromLocalStorage(key);
    }
  }

  async function touchSnapshotAsync(key, snapshot, etagOverride) {
    if (!key || !snapshot || snapshot.data == null) return;
    await persistSnapshotAsync(key, etagOverride || snapshot.etag || null, snapshot.data);
  }

  async function clearSnapshotAsync(key) {
    if (!key) return;
    if (supportsIndexedDb) {
      await idbDelete(key);
    }
    removeFromLocalStorage(key);
  }

  function writeLocalString(key, value) {
    if (!key) return;
    try {
      if (value === undefined || value === null) {
        localStorage.removeItem(key);
        return;
      }
      localStorage.setItem(key, String(value));
    } catch {
      // Ignore storage errors (quota, private browsing, etc.)
    }
  }

  function readLocalString(key, fallback = null) {
    if (!key) return fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw;
    } catch {
      return fallback;
    }
  }

  function writeLocalJson(key, value) {
    if (!key) return;
    try {
      if (value === undefined) {
        localStorage.removeItem(key);
        return;
      }
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore serialization/storage errors
    }
  }

  function readLocalJson(key, fallback = null) {
    if (!key) return fallback;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function removeLocalKey(key) {
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore removal errors
    }
  }

  cacheNs.writeLocalString = writeLocalString;
  cacheNs.readLocalString = readLocalString;
  cacheNs.writeLocalJson = writeLocalJson;
  cacheNs.readLocalJson = readLocalJson;
  cacheNs.removeLocal = removeLocalKey;

  cacheNs.loadSnapshotAsync = loadSnapshotAsync;
  cacheNs.persistSnapshotAsync = persistSnapshotAsync;
  cacheNs.touchSnapshotAsync = touchSnapshotAsync;
  cacheNs.clearSnapshotAsync = clearSnapshotAsync;

  cacheNs.loadSnapshot = function loadSnapshot(key, options) {
    return loadSnapshotSync(key, options);
  };

  cacheNs.persistSnapshot = function persistSnapshot(key, etag, data) {
    persistSnapshotAsync(key, etag, data);
  };

  cacheNs.touchSnapshot = function touchSnapshot(key, snapshot, etagOverride) {
    touchSnapshotAsync(key, snapshot, etagOverride);
  };

  cacheNs.createLibraryCombinedManager = function createLibraryCombinedManager(options = {}) {
    const storageKey = cacheKeys.library;
    if (!storageKey) {
      return {
        load: async () => null,
        persist: async () => {},
        touch: async () => {},
        clear: async () => {},
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

    const sanitizeOverridesState = (raw) => {
      if (!raw || typeof raw !== 'object') {
        return {
          items: [],
          redirects: {},
          busters: [],
        };
      }
      return {
        items: Array.isArray(raw.items) ? raw.items : [],
        redirects: (raw.redirects && typeof raw.redirects === 'object') ? raw.redirects : {},
        busters: Array.isArray(raw.busters) ? raw.busters : [],
      };
    };

    const load = async () => {
      const snapshot = await loadSnapshotAsync(storageKey, options);
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
        overridesState: sanitizeOverridesState(data.overridesState),
        etags: normalizeEtags(data.etags || {}),
        raw: snapshot,
      };
    };

    const persist = async (payload, etags) => {
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
        overridesState: sanitizeOverridesState(payload.overridesState),
        etags: normalizedEtags,
      };
      await persistSnapshotAsync(storageKey, combineEtags(normalizedEtags), data);
    };

    const touch = async (loadedSnapshot, overrideEtags) => {
      if (!loadedSnapshot || !loadedSnapshot.raw) return;
      const etagsToUse = normalizeEtags(overrideEtags || loadedSnapshot.etags || {});
      await touchSnapshotAsync(storageKey, loadedSnapshot.raw, combineEtags(etagsToUse));
    };

    const clear = async () => {
      await clearSnapshotAsync(storageKey);
    };

    return { load, persist, touch, clear };
  };

  cacheNs.conditionalFetch = function conditionalFetch(options = {}) {
    const { url, storageKey, allowStaleFallback = false } = options;
    if (!url || !storageKey) {
      return Promise.reject(new Error('conditionalFetch requires url and storageKey'));
    }

    return (async () => {
      const cached = await loadSnapshotAsync(storageKey, options);
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
          success: async (data, _statusText, xhr) => {
            const responseEtag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || null;
            const status = Number(xhr?.status);
            const notModified = status === 304;

            if (data != null) {
              await persistSnapshotAsync(storageKey, responseEtag, data);
              resolve({ data, etag: responseEtag, fromCache: false, notModified: false, staleFallback: false });
              return;
            }

            if (cached && cached.data != null) {
              await touchSnapshotAsync(storageKey, cached, responseEtag || cached.etag || null);
              resolve({
                data: notModified ? cached.data : cached.data,
                etag: responseEtag || cached.etag || null,
                fromCache: true,
                notModified,
                staleFallback: false,
              });
              return;
            }

            resolve({ data: null, etag: responseEtag || null, fromCache: false, notModified, staleFallback: false });
          },
          error: async () => {
            if (allowStaleFallback && cached && cached.data != null && cached.isFresh) {
              await touchSnapshotAsync(storageKey, cached, cached.etag || null);
              resolve({ data: cached.data, etag: cached.etag || null, fromCache: true, notModified: false, staleFallback: true });
              return;
            }
            reject(new Error(`Failed to fetch ${url}`));
          },
        });
      });
    })();
  };
})(window, window.jQuery);
