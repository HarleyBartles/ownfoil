'use strict';

// Shared data manager for the library page.
// Provides a consistent API for loading cached snapshots, fetching titles/metadata/overrides
// with conditional (ETag) requests, and applying metadata/override overlays to games.

((global, $) => {
  const namespace = global.Ownfoil = global.Ownfoil || {};
  const LibraryDataNs = namespace.LibraryData = namespace.LibraryData || {};

  function create(options = {}) {
    const overridesModule = options.overridesModule || namespace.Overrides || null;
    const CacheHelpers = namespace.Cache || null;
    const CacheKeys = namespace.CacheKeys || {};
    const combinedCacheVersion = Number.isFinite(options.combinedCacheVersion)
      ? Number(options.combinedCacheVersion)
      : 1;
    const reuseSharedInstance = options.reuseSharedInstance !== false;
    const normalizeDetailBasePath = (value) => {
      if (typeof value !== 'string') return '/games';
      let trimmed = value.trim();
      if (!trimmed) return '/games';
      if (!trimmed.startsWith('/')) trimmed = `/${trimmed}`;
      if (trimmed.length > 1 && trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
      return trimmed;
    };
    let detailBasePath = normalizeDetailBasePath(
      options.detailBasePath
        || (namespace.Config && namespace.Config.get && namespace.Config.get('detailBasePath'))
        || '/games',
    );
    options.detailBasePath = detailBasePath;
    const existingShared = reuseSharedInstance ? (LibraryDataNs._sharedManager || null) : null;
    if (existingShared) {
      if (typeof existingShared.setDetailBasePath === 'function') {
        existingShared.setDetailBasePath(detailBasePath);
      }
      if (Object.prototype.hasOwnProperty.call(options, 'shouldHideGhostCards')
        && typeof existingShared.setHideGhostCards === 'function') {
        existingShared.setHideGhostCards(!!options.shouldHideGhostCards);
      }
      return existingShared;
    }

    const CombinedCache = (
      CacheHelpers &&
      typeof CacheHelpers.createLibraryCombinedManager === 'function'
    )
      ? CacheHelpers.createLibraryCombinedManager({ version: combinedCacheVersion })
      : null;

    const state = {
      games: [],
      totalGames: 0,
      metadataEntries: {},
      baseDisplayByPrefix: {},
      metadataReady: false,
    };

    const lastKnownEtags = {
      titles: null,
      metadata: null,
      overrides: null,
    };

    let cachedCombinedSnapshot = null;
    const defaultHideGhostCards = !!options.shouldHideGhostCards;
    const resolveHideGhostsSetting = (override) => {
      if (typeof override === 'boolean') return override;
      if (typeof options.shouldHideGhostCards === 'boolean') {
        return !!options.shouldHideGhostCards;
      }
      return defaultHideGhostCards;
    };

    // --- Utilities ----------------------------------------------------------
    function normalizeAppId(value) {
      if (typeof value !== 'string') value = (value ?? '').toString();
      const trimmed = value.trim();
      return trimmed ? trimmed.toUpperCase() : '';
    }

    function isGhostGame(game) {
      return !!(game && game.suppressed_missing === true);
    }

    function compareSortTuples(aTuple, bTuple) {
      if (!Array.isArray(aTuple) || !Array.isArray(bTuple)) return 0;
      const len = Math.max(aTuple.length, bTuple.length);
      for (let i = 0; i < len; i += 1) {
        const av = aTuple[i];
        const bv = bTuple[i];
        if (av === bv) continue;
        if (typeof av === 'number' && typeof bv === 'number') {
          const diff = av - bv;
          if (diff !== 0) return diff;
          continue;
        }
        const aStr = (av ?? '').toString();
        const bStr = (bv ?? '').toString();
        if (aStr < bStr) return -1;
        if (aStr > bStr) return 1;
      }
      return 0;
    }

    function sortGamesInPlace(list) {
      if (!Array.isArray(list) || list.length < 2) return;
      list.sort((a, b) => {
        const cmp = compareSortTuples(a?._sortTuple, b?._sortTuple);
        if (cmp !== 0) return cmp;
        const aName = ((a?.display_title) || a?.title_id_name || a?.name || '')
          .toString()
          .toUpperCase();
        const bName = ((b?.display_title) || b?.title_id_name || b?.name || '')
          .toString()
          .toUpperCase();
        if (aName < bName) return -1;
        if (aName > bName) return 1;
        return 0;
      });
    }

    function pruneGhostsInPlace(list, hideGhostsOverride) {
      if (!Array.isArray(list) || list.length === 0) return list;
      const hideGhosts = resolveHideGhostsSetting(hideGhostsOverride);
      if (!hideGhosts) return list;
      let write = 0;
      for (let read = 0; read < list.length; read += 1) {
        const item = list[read];
        if (isGhostGame(item)) continue;
        if (write !== read) list[write] = item;
        write += 1;
      }
      if (write !== list.length) {
        list.length = write;
      }
      return list;
    }

    function cloneGame(game) {
      if (!game || typeof game !== 'object') return null;
      const clone = { ...game };
      if (game._orig && typeof game._orig === 'object') {
        clone._orig = { ...game._orig };
      }
      if (Array.isArray(game.category)) clone.category = game.category.slice();
      if (Array.isArray(game.screenshots)) clone.screenshots = game.screenshots.slice();
      if (Array.isArray(game.languages)) clone.languages = game.languages.slice();
      if (Array.isArray(game.regions)) clone.regions = game.regions.slice();
      if (Array.isArray(game.ratingContent)) clone.ratingContent = game.ratingContent.slice();
      if (Array.isArray(game.version)) clone.version = game.version.map((item) => ({ ...item }));
      if (Array.isArray(game._sortTuple)) clone._sortTuple = game._sortTuple.slice();
      if (Array.isArray(game._searchTokens)) clone._searchTokens = game._searchTokens.slice();
      if (Array.isArray(game._descriptionSearchTokens)) {
        clone._descriptionSearchTokens = game._descriptionSearchTokens.slice();
      }
      return clone;
    }

    function buildRedirectedCloneFromProjection(game, correctedId, projection) {
      if (!game || typeof game !== 'object') return null;
      if (!projection || typeof projection !== 'object') return null;
      const baseClone = cloneGame(game) || { ...game };
      const normalizedTarget = normalizeAppId(correctedId)
        || normalizeAppId(projection.app_id)
        || normalizeAppId(projection.title_id);
      if (normalizedTarget) {
        baseClone.app_id = normalizedTarget;
        baseClone.title_id = normalizedTarget;
        baseClone.id = normalizedTarget;
      }
      if (!baseClone._orig && game._orig) {
        baseClone._orig = { ...game._orig };
      }
      if (typeof overridesModule?.applyProjectionToGame === 'function') {
        overridesModule.applyProjectionToGame(baseClone, projection);
      } else {
        Object.entries(projection).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            baseClone[key] = value.slice();
          } else if (value && typeof value === 'object') {
            baseClone[key] = { ...value };
          } else {
            baseClone[key] = value;
          }
        });
      }
      return baseClone;
    }

    // --- Metadata helpers ---------------------------------------------------
    function updateMetadataNamespace(entries, baseLookup) {
      const metadataNs = namespace.Metadata = namespace.Metadata || {};
      metadataNs.entries = entries || {};
      metadataNs.baseDisplayByPrefix = baseLookup || {};
      metadataNs.getEntry = (appId) => {
        const key = normalizeAppId(appId);
        return key && Object.prototype.hasOwnProperty.call(metadataNs.entries, key)
          ? metadataNs.entries[key]
          : null;
      };
    }

    function setMetadataState(entries, baseLookup) {
      state.metadataEntries = entries && typeof entries === 'object' ? entries : {};
      state.baseDisplayByPrefix = baseLookup && typeof baseLookup === 'object' ? baseLookup : {};
      updateMetadataNamespace(state.metadataEntries, state.baseDisplayByPrefix);
      state.metadataReady = true;
    }

    function applyMetadataToGames(targetGames) {
      if (!state.metadataReady || !Array.isArray(targetGames)) return;
      const getEntry = namespace.Metadata?.getEntry;
      if (typeof getEntry !== 'function') return;
      targetGames.forEach((game) => {
        if (!game || typeof game !== 'object') return;
        const entry = getEntry(game.app_id);
        game._metadataEntry = null;
        game._sortTuple = undefined;
        game._searchBlob = null;
        game._searchTokens = null;
        game._descriptionSearchTokens = null;
        const gameType = (game.app_type || '').toUpperCase();
        if (gameType === 'DLC') {
          game.base_name = game._orig?.title_id_name || game.base_name;
        }
        game.display_title = undefined;
        if (!entry) return;
        game._metadataEntry = entry;
        if (Array.isArray(entry.sort)) {
          game._sortTuple = entry.sort.slice();
        }
        if (typeof entry.search === 'string') {
          game._searchBlob = entry.search;
        }
        if (Array.isArray(entry.search_tokens)) {
          game._searchTokens = entry.search_tokens.slice();
        }
        if (Array.isArray(entry.description_search_tokens)) {
          game._descriptionSearchTokens = entry.description_search_tokens.slice();
        }
        if (typeof entry.display_title === 'string') {
          game.display_title = entry.display_title;
          if (gameType === 'DLC') {
            game.base_name = entry.display_title;
          }
        }

        const overrideEntry = overridesModule?.getOverrideForGame?.(game);
        const redirectInfo = overridesModule?.getRedirectForApp?.(game?.app_id);
        const correctedCandidate = overrideEntry?.corrected_title_id
          || redirectInfo?.corrected_title_id
          || (redirectInfo?.projection && (redirectInfo.projection.app_id || redirectInfo.projection.title_id));
        const normalizedOverride = normalizeAppId(correctedCandidate);
        const normalizedCurrent = normalizeAppId(game.app_id);
        if (normalizedOverride && normalizedOverride !== normalizedCurrent) {
          const target = state.games.find((g) => normalizeAppId(g?.app_id) === normalizedOverride);
          if (target) {
            game._redirectedGame = cloneGame(target);
          } else if (redirectInfo?.projection) {
            const stub = buildRedirectedCloneFromProjection(game, normalizedOverride, redirectInfo.projection);
            if (stub) {
              game._redirectedGame = stub;
            } else {
              delete game._redirectedGame;
            }
          } else {
            delete game._redirectedGame;
          }
        } else {
          delete game._redirectedGame;
        }
      });
    }

    function applyMetadataPayload(payload) {
      if (!payload || typeof payload !== 'object') {
        setMetadataState({}, {});
        state.metadataReady = false;
        return;
      }
      const entries = (payload.entries && typeof payload.entries === 'object')
        ? payload.entries
        : {};
      const baseLookup = (payload.base_display_by_prefix && typeof payload.base_display_by_prefix === 'object')
        ? payload.base_display_by_prefix
        : {};
      setMetadataState(entries, baseLookup);
      applyMetadataToGames(state.games);
      sortGamesInPlace(state.games);
    }

    function hydrateGamesFromPayload(data) {
      const list = Array.isArray(data?.games) ? data.games : [];
      state.totalGames = Number.isFinite(data?.total) ? data.total : list.length;
      state.games = list.map((g) => {
        const clone = { ...g };
        clone._orig = {
          name: clone.name,
          title_id_name: clone.title_id_name,
          release_date: clone.release_date ?? null,
          app_type: clone.app_type,
          suppressed_missing: clone.suppressed_missing === true,
        };

        if ((clone.app_type || '').toUpperCase() === 'DLC') {
          clone.base_name = clone.title_id_name;
        }

        if (overridesModule?.computeRecognitionFlags) {
          const flags = overridesModule.computeRecognitionFlags(clone);
          clone.isUnrecognized = flags.isUnrecognized;
          clone.hasTitleDb = flags.hasTitleDb;
        } else {
          clone.isUnrecognized = !!clone.isUnrecognized;
          clone.hasTitleDb = !!clone.hasTitleDb;
        }

        clone._searchBlob = null;
        clone._searchTokens = null;
        clone._descriptionSearchTokens = null;
        return clone;
      });

      applyMetadataToGames(state.games);
      sortGamesInPlace(state.games);
      state.totalGames = state.games.length;
    }

    // --- ETag helpers -------------------------------------------------------
    function updateKnownEtags(partial) {
      if (!partial || typeof partial !== 'object') return;
      if (partial.titles !== undefined) {
        lastKnownEtags.titles = partial.titles;
      }
      if (partial.metadata !== undefined) {
        lastKnownEtags.metadata = partial.metadata;
      }
      if (partial.overrides !== undefined) {
        lastKnownEtags.overrides = partial.overrides;
      }
    }

    function getLastKnownEtags() {
      return {
        titles: lastKnownEtags.titles,
        metadata: lastKnownEtags.metadata,
        overrides: lastKnownEtags.overrides,
      };
    }

    function snapshotMatches(etags) {
      if (!cachedCombinedSnapshot || !cachedCombinedSnapshot.etags) return false;
      const snapshotEtags = cachedCombinedSnapshot.etags;
      const current = etags || {};
      return (
        (snapshotEtags.titles || null) === (current.titles || null) &&
        (snapshotEtags.metadata || null) === (current.metadata || null) &&
        (snapshotEtags.overrides || null) === (current.overrides || null)
      );
    }

    // --- Combined cache helpers --------------------------------------------
    async function loadCombinedSnapshot() {
      if (!CombinedCache?.load) {
        cachedCombinedSnapshot = null;
        return null;
      }
      try {
        cachedCombinedSnapshot = await CombinedCache.load();
      } catch (err) {
        cachedCombinedSnapshot = null;
        return null;
      }

      const snapshot = cachedCombinedSnapshot;
      if (!snapshot || !Array.isArray(snapshot.games)) {
        state.games = [];
        state.totalGames = 0;
        state.metadataEntries = {};
        state.baseDisplayByPrefix = {};
        state.metadataReady = false;
        return snapshot;
      }

      state.games = snapshot.games.map((game) => ({ ...game }));
      state.totalGames = Number.isFinite(snapshot.totalGames) ? snapshot.totalGames : state.games.length;
      state.metadataEntries = (snapshot.metadataEntries && typeof snapshot.metadataEntries === 'object')
        ? snapshot.metadataEntries
        : {};
      state.baseDisplayByPrefix = (snapshot.baseDisplayByPrefix && typeof snapshot.baseDisplayByPrefix === 'object')
        ? snapshot.baseDisplayByPrefix
        : {};
      updateMetadataNamespace(state.metadataEntries, state.baseDisplayByPrefix);
      state.metadataReady = true;

      updateKnownEtags(snapshot.etags || {});

      if (overridesModule?.hydrateFromSnapshot) {
        overridesModule.hydrateFromSnapshot(snapshot.overridesState);
      }
      if (overridesModule?.applyRedirectsToGames) {
        overridesModule.applyRedirectsToGames(state.games);
      }
      if (overridesModule?.reapplyAllOverridesToGames) {
        overridesModule.reapplyAllOverridesToGames(state.games);
      }
      sortGamesInPlace(state.games);
      state.totalGames = state.games.length;
      return snapshot;
    }

    async function persistCombinedSnapshot() {
      if (!CombinedCache?.persist) return;
      await CombinedCache.persist({
        games: state.games,
        totalGames: state.totalGames,
        metadataEntries: state.metadataEntries,
        baseDisplayByPrefix: state.baseDisplayByPrefix,
        overridesState: overridesModule?.getSnapshotForCache?.(),
      }, getLastKnownEtags());

      if (CombinedCache?.load) {
        try {
          cachedCombinedSnapshot = await CombinedCache.load();
        } catch {
          cachedCombinedSnapshot = null;
        }
      }
    }

    async function touchCombinedSnapshot(etagsOverride) {
      if (!CombinedCache?.touch || !cachedCombinedSnapshot || !cachedCombinedSnapshot.raw) return;
      const etagsToUse = etagsOverride || getLastKnownEtags();
      await CombinedCache.touch(cachedCombinedSnapshot, etagsToUse);
    }

    async function clearCombinedSnapshot() {
      if (CombinedCache?.clear) {
        await CombinedCache.clear();
      }
      cachedCombinedSnapshot = null;
    }

    // --- Fetch helpers ------------------------------------------------------
    async function fetchTitles() {
      const storageKey = CacheKeys.titles || 'ownfoil.cache.titles.v2';
      if (CacheHelpers?.conditionalFetch) {
        try {
          const result = await CacheHelpers.conditionalFetch({
            url: '/api/titles',
            storageKey,
            allowStaleFallback: true,
          });
          const payload = (result && typeof result.data === 'object') ? result.data : null;
          return {
            data: payload,
            etag: result?.etag || null,
            fromCache: !!result?.fromCache,
            notModified: result?.notModified === true,
            staleFallback: result?.staleFallback === true,
          };
        } catch (err) {
          return {
            data: null,
            etag: null,
            fromCache: false,
            error: err,
            notModified: false,
            staleFallback: false,
          };
        }
      }

      return new Promise((resolve) => {
        $.ajax({
          url: '/api/titles',
          method: 'GET',
          dataType: 'json',
          success(data, _textStatus, xhr) {
            resolve({
              data: data && typeof data === 'object' ? data : null,
              etag: xhr?.getResponseHeader('ETag') || xhr?.getResponseHeader('etag') || null,
              fromCache: false,
              notModified: xhr?.status === 304,
              staleFallback: false,
            });
          },
          error() {
            resolve({
              data: null,
              etag: null,
              fromCache: false,
              error: true,
              notModified: false,
              staleFallback: false,
            });
          },
        });
      });
    }

    async function fetchMetadata() {
      const storageKey = CacheKeys.metadata || 'ownfoil.cache.library-metadata.v2';
      if (CacheHelpers?.conditionalFetch) {
        try {
          const result = await CacheHelpers.conditionalFetch({
            url: '/api/metadata',
            storageKey,
            allowStaleFallback: true,
          });
          const payload = (result && typeof result.data === 'object') ? result.data : null;
          return {
            data: payload,
            etag: result?.etag || null,
            fromCache: !!result?.fromCache,
            notModified: result?.notModified === true,
            staleFallback: result?.staleFallback === true,
          };
        } catch (err) {
          return {
            data: null,
            etag: null,
            fromCache: false,
            error: err,
            notModified: false,
            staleFallback: false,
          };
        }
      }

      return new Promise((resolve) => {
        $.ajax({
          url: '/api/metadata',
          method: 'GET',
          dataType: 'json',
          success(data, _textStatus, xhr) {
            resolve({
              data: data && typeof data === 'object' ? data : null,
              etag: xhr?.getResponseHeader('ETag') || xhr?.getResponseHeader('etag') || null,
              fromCache: false,
              notModified: xhr?.status === 304,
              staleFallback: false,
            });
          },
          error() {
            resolve({
              data: null,
              etag: null,
              fromCache: false,
              error: true,
              notModified: false,
              staleFallback: false,
            });
          },
        });
      });
    }

    async function fetchOverrides() {
      if (overridesModule?.fetchOverrides) {
        try {
          return await overridesModule.fetchOverrides();
        } catch (err) {
          return {
            error: err,
            overridesChanged: false,
            redirectsChanged: false,
            etag: null,
            fromCache: false,
            notModified: false,
            staleFallback: false,
          };
        }
      }

      const storageKey = CacheKeys.overrides || 'ownfoil.cache.overrides.v2';
      if (CacheHelpers?.conditionalFetch) {
        try {
          const result = await CacheHelpers.conditionalFetch({
            url: '/api/overrides',
            storageKey,
            allowStaleFallback: true,
          });
          return {
            data: result?.data ?? null,
            etag: result?.etag || null,
            fromCache: !!result?.fromCache,
            notModified: result?.notModified === true,
            staleFallback: result?.staleFallback === true,
            overridesChanged: !!result?.data,
            redirectsChanged: !!result?.data,
          };
        } catch (err) {
          return {
            data: null,
            etag: null,
            fromCache: false,
            error: err,
            overridesChanged: false,
            redirectsChanged: false,
            notModified: false,
            staleFallback: false,
          };
        }
      }

      return {
        data: null,
        etag: null,
        fromCache: false,
        overridesChanged: false,
        redirectsChanged: false,
        notModified: false,
        staleFallback: false,
      };
    }

    // --- Fetch orchestration ------------------------------------------------
    async function fetchAll(options = {}) {
      const metadataPromise = fetchMetadata();
      const overridesPromise = fetchOverrides();
      const titlesPromise = fetchTitles();

      let metadataResult;
      let overridesResult;
      let titlesResult;

      try {
        [metadataResult, overridesResult, titlesResult] = await Promise.all([
          metadataPromise,
          overridesPromise,
          titlesPromise,
        ]);
      } catch (err) {
        throw err;
      }

      overridesResult = overridesResult || {};
      const etagsForComparison = {
        titles: titlesResult?.etag || null,
        metadata: metadataResult?.etag || null,
        overrides: overridesResult?.etag || null,
      };

      const allNotModified =
        metadataResult?.notModified === true &&
        titlesResult?.notModified === true &&
        (overridesResult == null || overridesResult?.notModified === true);

      const cachedMatches = snapshotMatches(etagsForComparison);

      if (cachedMatches && allNotModified) {
        updateKnownEtags({
          titles: etagsForComparison.titles ?? lastKnownEtags.titles,
          metadata: etagsForComparison.metadata ?? lastKnownEtags.metadata,
          overrides: etagsForComparison.overrides ?? lastKnownEtags.overrides,
        });
        await touchCombinedSnapshot(etagsForComparison);
        return {
          metadataResult,
          overridesResult,
          titlesResult,
          etags: etagsForComparison,
          allNotModified: true,
          snapshotMatches: true,
          stateUnchanged: true,
          hadErrors: false,
        };
      }

      const titlesPayload = titlesResult?.data;
      if (titlesPayload && typeof titlesPayload === 'object') {
        hydrateGamesFromPayload(titlesPayload);
      } else if (!cachedCombinedSnapshot) {
        state.games = [];
        state.totalGames = 0;
      }

      const metadataPayload = metadataResult?.data;
      if (metadataPayload && typeof metadataPayload === 'object') {
        applyMetadataPayload(metadataPayload);
      } else if (!state.metadataReady) {
        applyMetadataPayload({ entries: {}, base_display_by_prefix: {} });
      }

      if (overridesResult?.redirectsChanged && overridesModule?.applyRedirectsToGames) {
        overridesModule.applyRedirectsToGames(state.games);
      }
      if (overridesResult?.overridesChanged && overridesModule?.reapplyAllOverridesToGames) {
        overridesModule.reapplyAllOverridesToGames(state.games);
      }

      applyMetadataToGames(state.games);
      sortGamesInPlace(state.games);
      state.totalGames = Array.isArray(state.games) ? state.games.length : 0;

      updateKnownEtags(etagsForComparison);

      const hadErrors = !!(metadataResult?.error || titlesResult?.error || overridesResult?.error);
      if (hadErrors) {
        await clearCombinedSnapshot();
      } else if (!options.skipPersist) {
        await persistCombinedSnapshot();
      }

      return {
        metadataResult,
        overridesResult,
        titlesResult,
        etags: etagsForComparison,
        allNotModified,
        snapshotMatches: cachedMatches,
        stateUnchanged: false,
        hadErrors,
      };
    }

    async function refreshMetadataAfterOverrides(options = {}) {
      const metaResult = await fetchMetadata();
      const payload = metaResult?.data;
      if (payload && typeof payload === 'object') {
        applyMetadataPayload(payload);
      }
      applyMetadataToGames(state.games);
      sortGamesInPlace(state.games);
      state.totalGames = Array.isArray(state.games) ? state.games.length : 0;

      updateKnownEtags({ metadata: metaResult?.etag ?? lastKnownEtags.metadata });

      if (metaResult?.error) {
        await clearCombinedSnapshot();
      } else if (!options.skipPersist) {
        await persistCombinedSnapshot();
      }

      return { metadataResult: metaResult };
    }

    // --- Lookup helpers -----------------------------------------------------
    function getMetadataEntry(appId) {
      const key = normalizeAppId(appId);
      if (!key) return null;
      const entry = state.metadataEntries[key];
      return entry || null;
    }

    function getBaseKeyForAppId(appId) {
      const key = normalizeAppId(appId);
      if (!key) return '';
      const entry = getMetadataEntry(key);
      if (entry && entry.base_key) {
        return entry.base_key;
      }
      const game = state.games.find((g) => normalizeAppId(g?.app_id) === key);
      if (game) {
        const maybeTitle = normalizeAppId(game.title_id);
        if (maybeTitle) return maybeTitle;
      }
      return key;
    }

    function getGameByAppId(appId) {
      const key = normalizeAppId(appId);
      if (!key) return null;
      const game = state.games.find((g) => normalizeAppId(g?.app_id) === key);
      return game ? cloneGame(game) : null;
    }

    function getGamesForBaseKey(baseKey, lookupOptions = {}) {
      const normalizedBase = normalizeAppId(baseKey);
      if (!normalizedBase) return [];
      const includeGhosts = lookupOptions.includeGhosts === true;
      const hideGhosts = resolveHideGhostsSetting(lookupOptions.hideGhosts);

      const related = state.games
        .filter((game) => {
          if (!game) return false;
          const gameBaseKey = getBaseKeyForAppId(game.app_id);
          return gameBaseKey === normalizedBase;
        })
        .map((game) => cloneGame(game));

      if (includeGhosts) return related;
      return related.filter((game) => {
        if (!isGhostGame(game)) return true;
        return !hideGhosts;
      });
    }

    function getDetailUrlForGame(game, overrideAppId) {
      const appId = normalizeAppId(overrideAppId || game?.app_id);
      if (!appId) return '';
      return `${detailBasePath}/${encodeURIComponent(appId)}`;
    }

    function setHideGhostCards(flag) {
      options.shouldHideGhostCards = !!flag;
    }

    function setDetailBasePath(value) {
      const normalized = normalizeDetailBasePath(value);
      if (!normalized) return;
      if (normalized === detailBasePath) {
        options.detailBasePath = normalized;
        return;
      }
      detailBasePath = normalized;
      options.detailBasePath = detailBasePath;
    }

    const api = {
      state,
      options,
      normalizeAppId,
      isGhostGame,
      compareSortTuples,
      sortGamesInPlace,
      pruneGhostsInPlace,
      cloneGame,
      applyMetadataPayload,
      applyMetadataToGames,
      hydrateGamesFromPayload,
      loadCombinedSnapshot,
      fetchAll,
      refreshMetadataAfterOverrides,
      persistCombinedSnapshot,
      touchCombinedSnapshot,
      clearCombinedSnapshot,
      updateKnownEtags,
      getLastKnownEtags,
      snapshotMatches,
      getMetadataEntry,
      getBaseKeyForAppId,
      getGameByAppId,
      getGamesForBaseKey,
      getDetailUrlForGame,
      setHideGhostCards,
      setDetailBasePath,
    };
    if (reuseSharedInstance) {
      LibraryDataNs._sharedManager = api;
    }
    return api;
  }

  LibraryDataNs.create = create;
})(window, window.jQuery);
