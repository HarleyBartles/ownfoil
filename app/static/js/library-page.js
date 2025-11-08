'use strict';

((global, $) => {
  if (!$) {
    console.warn('Ownfoil library page requires jQuery.');
    return;
  }

  const namespace = global.Ownfoil = global.Ownfoil || {};
  const Overrides = namespace.Overrides || null;
  const LibraryDataNs = namespace.LibraryData || null;
  const PageConfig = namespace.Config || null;
  const CacheModule = namespace.Cache || null;
  const getDetailModule = () => (global.Ownfoil && global.Ownfoil.Detail) ? global.Ownfoil.Detail : null;
  const contentRoot = document.getElementById('content');
  const configSnapshot = PageConfig?.applyFromElement
      ? PageConfig.applyFromElement(contentRoot)
      : null;

  const isAdminUser = (global.IS_ADMIN === true || global.IS_ADMIN === 'true');
  const hideGhostCardsSetting = (global.HIDE_GHOST_CARDS === true || global.HIDE_GHOST_CARDS === 'true');
  const shouldHideGhostCards = !isAdminUser && hideGhostCardsSetting;

  if (!LibraryDataNs || typeof LibraryDataNs.create !== 'function') {
    console.error('Ownfoil library page: LibraryData module not available.');
    return;
  }

  const dataManager = LibraryDataNs.create({
    overridesModule: Overrides,
    combinedCacheVersion: 1,
    shouldHideGhostCards,
  });
  const state = dataManager.state;

  const isGhostCard = (game) => game?.suppressed_missing === true;
  const pruneGhostsInPlace = (list) => dataManager.pruneGhostsInPlace
    ? dataManager.pruneGhostsInPlace(list)
    : list;
  const openDetailFromLibrary = (appId, historyMode = 'push') => {
    const Detail = getDetailModule();
    if (!Detail || typeof Detail.open !== 'function') return;
    Detail.open(appId, { historyMode });
  };

  const bindDetailTrigger = (element, game, options = {}) => {
    const detailModule = getDetailModule();
    if (!detailModule || typeof detailModule.open !== 'function') return;
    if (!element || !game || !game.app_id) return;
    const excludeSelector = typeof options.excludeSelector === 'string' ? options.excludeSelector : null;

    const isExcludedTarget = (target) => {
      if (!excludeSelector) return false;
      if (!(target instanceof Element)) return false;
      return !!target.closest(excludeSelector);
    };
    const shouldIgnoreEvent = (event) => isExcludedTarget(event.target);

    element.dataset.appId = game.app_id;
    element.classList.add('game-detail-trigger');
    element.style.cursor = 'pointer';
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');

    let recentTouchHandled = false;
    let touchState = null;

    element.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1) {
        touchState = null;
        return;
      }
      const { clientX, clientY } = event.touches[0];
      touchState = {
        startX: clientX,
        startY: clientY,
        moved: false,
        ignore: isExcludedTarget(event.target),
      };
    }, { passive: true });

    element.addEventListener('touchmove', (event) => {
      if (!touchState || touchState.moved) return;
      if (event.touches.length !== 1) {
        touchState.moved = true;
        return;
      }
      const { clientX, clientY } = event.touches[0];
      const dx = clientX - touchState.startX;
      const dy = clientY - touchState.startY;
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      if (distance > 10) {
        touchState.moved = true;
      }
    }, { passive: true });

    element.addEventListener('touchend', (event) => {
      if (!touchState || touchState.moved || touchState.ignore) {
        touchState = null;
        return;
      }
      touchState = null;
      recentTouchHandled = true;
      setTimeout(() => { recentTouchHandled = false; }, 250);
      event.preventDefault();
      openDetailFromLibrary(game.app_id, 'push');
    });

    element.addEventListener('click', (event) => {
      if (shouldIgnoreEvent(event)) return;
      if (recentTouchHandled) {
        recentTouchHandled = false;
        return;
      }
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey) {
        const href = typeof dataManager.getDetailUrlForGame === 'function'
          ? dataManager.getDetailUrlForGame(game)
          : null;
        if (href) {
          global.open(href, '_blank', 'noopener');
        }
        return;
      }
      if (event.shiftKey || event.altKey) return;
      if (typeof event.button === 'number' && event.button !== 0) return;
      openDetailFromLibrary(game.app_id, 'push');
    });

    element.addEventListener('keydown', (event) => {
      if (shouldIgnoreEvent(event)) return;
      if (event.defaultPrevented) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetailFromLibrary(game.app_id, 'push');
      }
    });
  };

  const VALID_VIEWS = new Set(['card', 'icon']);
  const normalizeView = (value) => {
    const candidate = (value || '').toString().toLowerCase();
    return VALID_VIEWS.has(candidate) ? candidate : 'card';
  };

  const setActiveViewButton = (view) => {
    const buttons = document.querySelectorAll('.view-toggle-btn');
    buttons.forEach((btn) => btn.classList.remove('active'));
    const target = document.querySelector(`.view-toggle-btn[data-view="${view}"]`);
    if (target) target.classList.add('active');
  };

  let games = state.games;
      let filteredGames = [];
      let baseFilteredGames = [];
      let itemsPerPage = 12;
      let currentPage = 1;
      let totalGames = 0;
      let cardSize = 3; // Default card size
      let currentView = 'card'; // Default view is 'card'
      let paginationController = null;
      let activeTooltips = []; // DOM nodes whose tooltips we need to tear down
      let activePopovers = []; // DOM nodes whose popovers we need to tear down

      // --- Search debounce ---
      const SEARCH_DEBOUNCE_MS = 300;
      let searchDebounceTimer = null;
      // -----------------------

      const CURRENT_PAGE_KEY = 'currentPage';
      const updateKnownEtags = (partial) => {
          dataManager.updateKnownEtags(partial);
      };
      const SearchConfig = namespace.SearchConfig = namespace.SearchConfig || {};
      if (typeof SearchConfig.includeDescriptions !== 'boolean') {
          SearchConfig.includeDescriptions = false;
      }
      const shouldIncludeDescriptionSearch = () => namespace?.SearchConfig?.includeDescriptions === true;

      let suppressNextOverridesMetadataRefresh = false;
      let metadataEntries = state.metadataEntries || {};
      let baseDisplayByPrefix = state.baseDisplayByPrefix || {};
      let metadataReady = !!state.metadataReady;

      function syncGamesFromState() {
          games = state.games;
          totalGames = Number.isFinite(state.totalGames)
              ? state.totalGames
              : (Array.isArray(games) ? games.length : 0);
          metadataEntries = state.metadataEntries || {};
          baseDisplayByPrefix = state.baseDisplayByPrefix || {};
          metadataReady = !!state.metadataReady;
      }

      syncGamesFromState();

      function applyMetadataPayload(payload) {
          dataManager.applyMetadataPayload(payload);
          syncGamesFromState();
          filteredGames = pruneGhostsInPlace(Array.isArray(games) ? games.slice() : []);
          baseFilteredGames = filteredGames.slice();
          rebuildGenreFiltersIfNeeded();
      }

      function hydrateGamesFromPayload(data) {
          dataManager.hydrateGamesFromPayload(data);
          syncGamesFromState();
          filteredGames = pruneGhostsInPlace(Array.isArray(games) ? games.slice() : []);
          baseFilteredGames = filteredGames.slice();
          rebuildGenreFiltersIfNeeded();
      }

      function normalizePage(value, fallback = 1) {
          const num = Number(value);
          if (!Number.isFinite(num) || num < 1) return fallback;
          return Math.floor(num);
      }

      function loadStoredPage() {
      const saved = CacheModule?.readLocalString
          ? CacheModule.readLocalString(CURRENT_PAGE_KEY, null)
          : null;
          if (saved === null) return null;
          return normalizePage(saved, null);
      }

      function persistCurrentPage(page) {
          CacheModule?.writeLocalString?.(CURRENT_PAGE_KEY, page);
      }

      function setCurrentPageValue(page) {
          const normalized = normalizePage(page);
          currentPage = normalized;
          persistCurrentPage(normalized);
          return normalized;
      }

      function clampCurrentPageTo(totalPages) {
          const safeTotal = Math.max(1, Number.isFinite(totalPages) ? Math.floor(totalPages) : 1);
          const clamped = Math.min(normalizePage(currentPage), safeTotal);
          currentPage = clamped;
          persistCurrentPage(clamped);
          return clamped;
      }


      function renderGames() {
          // Ensure we always have arrays
          if (!Array.isArray(games)) games = [];
          if (!Array.isArray(filteredGames)) filteredGames = [];

          // Set slider to show `cardsize` columns by default
          $('#cardSizeRange').val(cardSize);

          if (currentView === 'card') {
              renderCardView();
              adjustCardSizes();
          } else if (currentView === 'icon') {
              renderIconView();
              adjustIconSizes();
          }

          // Refresh Bootstrap tooltips & popovers after replacing the DOM.
          disposeInteractiveHints();
          initInteractiveHints();
      }

  const normalizeAssetUrl = (value) => {
      if (typeof value !== 'string') return '';
      const trimmed = value.trim();
      if (!trimmed) return '';
      const lowered = trimmed.toLowerCase();
      if (lowered === 'undefined' || lowered === 'null') return '';
      return trimmed;
  };

  const pickArtworkUrl = (...values) => {
      for (let i = 0; i < values.length; i += 1) {
          const normalized = normalizeAssetUrl(values[i]);
          if (normalized) return normalized;
      }
      return '';
  };

  function renderCardView() {
          // Render card view logic...
          // Build cards in a document fragment to minimize layout thrash while rendering a page.
          const gameGrid = $('#gameGrid');
          gameGrid.empty(); // Clear existing games

          // Hard guard: nothing to render yet
          if (!Array.isArray(filteredGames) || filteredGames.length === 0) {
              gameGrid.append(`
                  <div class="col-12 text-center text-muted py-5">
                      <div class="mb-2"><i class="bi bi-collection"></i></div>
                      <div>No titles to display.</div>
                  </div>
              `);
              updatePaginationControls(0);
              return;
          }

          // Keep the current page within bounds for the available results.
          const totalItems = filteredGames.length;
          const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
          clampCurrentPageTo(totalPages);

          // Get games for the current page
          const start = (currentPage - 1) * itemsPerPage;
          const end = start + itemsPerPage;
          const paginatedGames = filteredGames.slice(start, end);

          const fragment = document.createDocumentFragment();

          paginatedGames.forEach((game) => {
              if (!game || typeof game !== 'object') return;

              const colDiv = document.createElement('div');
              colDiv.className = `col game-col col-${12 / getColumnsForCardSize(cardSize)}`;

              const cardDiv = document.createElement('div');
              cardDiv.className = 'card text-bg-dark game-card';
              if (game.title_id) cardDiv.dataset.titleId = game.title_id;
              if (game.file_basename) cardDiv.dataset.fileBasename = game.file_basename;
              if (game.identification_type) cardDiv.dataset.identificationType = (game.identification_type || '').toLowerCase();

              const isSuppressed = game.suppressed_missing === true;
              if (isSuppressed) {
                  cardDiv.classList.add('suppressed-card');
                  cardDiv.dataset.suppressedMissing = 'true';
              }

              const bannerSrc = pickArtworkUrl(
                  Overrides?.bannerUrlFor?.(game),
                  game.banner_path,
                  game.bannerUrl,
                  game.banner
              );
              const resolvedBanner = bannerSrc || window.DEFAULT_BANNER;
              const img = document.createElement('img');
              img.className = 'card-img';
              img.src = resolvedBanner;
              img.addEventListener('error', function () {
                  if (this.src !== window.DEFAULT_BANNER) this.src = window.DEFAULT_BANNER;
              });
              cardDiv.appendChild(img);

              const overlayDiv = document.createElement('div');
              overlayDiv.className = 'card-img-overlay game-info';

              const titleLine = document.createElement('div');
              titleLine.className = 'd-flex align-items-center justify-content-between';
              const metaTitle = (typeof game.display_title === 'string') ? game.display_title.trim() : '';
              const bigTitle = metaTitle || Overrides?.displayTitleFor?.(game, games) || game.name || '';
              const titleH5 = document.createElement('h5');
              titleH5.className = 'card-title game-title mb-1';
              titleH5.textContent = bigTitle;
              titleLine.appendChild(titleH5);
              overlayDiv.appendChild(titleLine);

              const descriptionP = document.createElement('p');
              descriptionP.className = 'card-text game-description mb-2';
              if ((game.app_type || '').toUpperCase() === 'DLC') {
                  let dlcName = (game.name || '').trim();
                  const baseName = bigTitle.trim();

                  // Derive base name used in the header
                  if (baseName && dlcName.toLowerCase().startsWith(baseName.toLowerCase())) {
                      dlcName = dlcName.slice(baseName.length).replace(/^(\s*[-–:]\s*)?/, '');
                  }

                  if (dlcName) {
                      const dlcSmall = document.createElement('small');
                      dlcSmall.textContent = `${dlcName} | `;
                      descriptionP.appendChild(dlcSmall);
                  }
              }

              // Prefer corrected → app_id (app-specific) → dlc_title_id → title_id → id.
              const fallbackTid = game.corrected_title_id || game.app_id || game.dlc_title_id || game.title_id || game.id || '';
              const rawTid = Overrides?.pickTidForDisplay?.(game, Overrides?.getOverrideForGame?.(game)) ?? fallbackTid ?? '';
              const tidToShow = rawTid.toString().trim().toUpperCase();
              const tidSmall = document.createElement('small');
              tidSmall.textContent = tidToShow;
              // Highlight only if the displayed TID is the corrected one.
              if (tidToShow && game.corrected_title_id && tidToShow === game.corrected_title_id.toString().trim().toUpperCase()) {
                  tidSmall.classList.add('text-warning', 'fw-semibold');
              }
              descriptionP.appendChild(tidSmall);
              overlayDiv.appendChild(descriptionP);

              // Badge strip showing type/completion/override state.
              const tagsContainer = document.createElement('div');
              tagsContainer.className = 'tags-container d-flex gap-1 align-items-center';

              const badgesModule = namespace.StatusBadges || null;
              if (badgesModule?.createTypeBadge) {
                  const typeBadge = badgesModule.createTypeBadge(game);
                  if (typeBadge) tagsContainer.appendChild(typeBadge);
              } else {
                  const fallbackBadge = document.createElement('span');
                  fallbackBadge.className = `badge rounded-pill ${game.owned === false ? 'text-bg-warning' : 'text-bg-info'} game-tag`;
                  fallbackBadge.textContent = game.app_type || '';
                  tagsContainer.appendChild(fallbackBadge);
              }

              if (badgesModule?.createDlcBadge) {
                  const dlcBadge = badgesModule.createDlcBadge(game);
                  if (dlcBadge) tagsContainer.appendChild(dlcBadge);
              }

              if (isSuppressed) {
                  // Ghost badge to signal the card is hidden from completion metrics.
                  const suppressedBadge = document.createElement('span');
                  suppressedBadge.className = 'badge rounded-pill text-bg-secondary game-tag';
                  suppressedBadge.innerHTML = '<i class="bi bi-eye-slash"></i>';
                  suppressedBadge.setAttribute('data-bs-toggle', 'tooltip');
                  suppressedBadge.setAttribute('data-bs-placement', 'top');
                  suppressedBadge.setAttribute('data-bs-title', 'Ignored for completion filters (ghost card)');
                  tagsContainer.appendChild(suppressedBadge);
              } else if (badgesModule?.createVersionBadge) {
                  const versionBadge = badgesModule.createVersionBadge(game, {
                      popoverClass: 'version-popover',
                  });
                  if (versionBadge) tagsContainer.appendChild(versionBadge);
              } else if (typeof game.has_latest_version !== 'undefined' && !isSuppressed) {
                  const fallbackVersionBadge = document.createElement('span');
                  fallbackVersionBadge.className = 'badge rounded-pill game-tag version-tag';
                  fallbackVersionBadge.classList.add(game.has_latest_version ? 'text-bg-success' : 'text-bg-warning');
                  fallbackVersionBadge.innerHTML = `<i class='bi ${game.has_latest_version ? 'bi-check-circle-fill' : 'bi-arrow-down-circle'}'></i>`;
                  tagsContainer.appendChild(fallbackVersionBadge);
              }

          if (isAdminUser) {
              // Override edit pill
                const hasOvr = Overrides?.hasActiveOverride?.(game) === true;
                const editPill = document.createElement('button');
                editPill.type = 'button';
                editPill.classList.add('override-pill', 'btn', 'rounded-pill', 'game-tag', hasOvr ? 'btn-success' : 'btn-secondary');
                editPill.title = hasOvr ? 'Metadata override active. Click to edit.' : 'No override. Click to edit metadata.';
                editPill.innerHTML = '<i class="bi bi-pencil-square"></i>';
                editPill.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (typeof Overrides?.openOverrideEditor === 'function') {
                        Overrides.openOverrideEditor(game);
                    }
                });
                tagsContainer.appendChild(editPill);
            }

            overlayDiv.appendChild(tagsContainer);
            cardDiv.appendChild(overlayDiv);

            bindDetailTrigger(cardDiv, game, { excludeSelector: '.game-info, .game-info *' });

            colDiv.appendChild(cardDiv);
            fragment.appendChild(colDiv);
          });

          const gridEl = gameGrid.get(0);
          if (!gridEl) return;
          gridEl.appendChild(fragment);

          // Update pagination with the current page size.
          updatePaginationControls(totalItems);
      }

      function renderIconView() {
          // Render icon view logic...
          // Build icons in a document fragment to reduce reflows during pagination.
          const gameGrid = $('#gameGrid');
          gameGrid.empty(); // Clear existing icons

          // Hard guard: nothing to render yet
          if (!Array.isArray(filteredGames) || filteredGames.length === 0) {
              gameGrid.append(`
                  <div class="col-12 text-center text-muted py-5">
                      <div class="mb-2"><i class="bi bi-collection"></i></div>
                      <div>No titles to display.</div>
                  </div>
              `);
              updatePaginationControls(0);
              return;
          }

          // Only paginate base titles in icon view.
          const baseGames = filteredGames.filter(game => (game?.app_type || '').toUpperCase() === 'BASE');
          const totalIconItems = baseGames.length;
          const totalIconPages = Math.max(1, Math.ceil(totalIconItems / itemsPerPage));
          clampCurrentPageTo(totalIconPages);

          // Get games for the current page.
          const start = (currentPage - 1) * itemsPerPage;
          const end = start + itemsPerPage;
          const paginatedGames = baseGames.slice(start, end);

          const fragment = document.createDocumentFragment();

          paginatedGames.forEach((game) => {
            if (!game || typeof game !== 'object') return;
            const icon = document.createElement('img');
            icon.className = 'game-icon';
            icon.loading = 'lazy';
            const iconSrc = pickArtworkUrl(
                Overrides?.iconUrlFor?.(game),
                game.icon_path,
                game.iconUrl,
                game.icon
            );
            icon.src = iconSrc || window.DEFAULT_ICON;
            const iconTitle = (typeof game.display_title === 'string' && game.display_title.trim())
                ? game.display_title.trim()
                : (game.name || game.title_id_name || 'Game');
            icon.alt = iconTitle;
            icon.addEventListener('error', function () {
                if (this.src !== window.DEFAULT_ICON) this.src = window.DEFAULT_ICON;
            });

            const iconWrapper = document.createElement('div');
            iconWrapper.className = 'game-icon-link text-decoration-none';
            iconWrapper.setAttribute('aria-label', iconTitle);
            iconWrapper.appendChild(icon);

            bindDetailTrigger(iconWrapper, game);

            fragment.appendChild(iconWrapper);
          });

          const gridEl = gameGrid.get(0);
          if (!gridEl) return;
          gridEl.appendChild(fragment);

          adjustIconSizes();
          // Update pagination for icon view.
          updatePaginationControls(totalIconItems);
      }

      // Tear down Bootstrap tooltips/popovers before reinitializing after a render.
      function disposeInteractiveHints() {
          const bootstrap = window.bootstrap;
          if (!bootstrap) {
              activeTooltips = [];
              activePopovers = [];
              return;
          }

          const disposeFor = (elements, ctor) => {
              if (!Array.isArray(elements) || !ctor || typeof ctor !== 'function') return;
              const getInstance = typeof ctor.getInstance === 'function' ? ctor.getInstance.bind(ctor) : null;

              elements.forEach((el) => {
                  if (!el) return;
                  const instance = getInstance ? getInstance(el) : null;
                  if (!instance || typeof instance.dispose !== 'function') return;
                  try {
                      instance.dispose();
                  } catch (err) {
                      // Ignore: Bootstrap may already have disposed the instance internally.
                  }
              });
          };

          disposeFor(activeTooltips, bootstrap.Tooltip);
          disposeFor(activePopovers, bootstrap.Popover);
          activeTooltips = [];
          activePopovers = [];
      }

      // Lazily (re)create Bootstrap tooltips/popovers after the DOM has been replaced.
      function initInteractiveHints() {
          if (!window.bootstrap) return;

          const tooltipCtor = window.bootstrap.Tooltip;
          if (typeof tooltipCtor === 'function') {
              const tooltipEls = document.querySelectorAll('[data-bs-toggle="tooltip"]');
              tooltipEls.forEach((el) => {
                  const instance = tooltipCtor.getOrCreateInstance(el);
                  if (instance) activeTooltips.push(el);
              });
          }

          const popoverCtor = window.bootstrap.Popover;
          if (typeof popoverCtor === 'function') {
              const popoverEls = document.querySelectorAll('[data-bs-toggle="popover"]');
              popoverEls.forEach((el) => {
                  const instance = popoverCtor.getOrCreateInstance(el);
                  if (instance) activePopovers.push(el);
              });
          }
      }

      function getColumnsForCardSize(size) {
          switch (size) {
              case 1: return 1; // 2 columns
              case 2: return 2; // 3 columns
              case 3: return 3; // 4 columns
              case 4: return 4; // 6 columns
              case 5: return 6; // 8 columns
              default: return 4; // default to 3 columns
          }
      }

      function adjustCardSizes() {
          const gameGrid = $('#gameGrid');
          const gameCols = gameGrid.find('.game-col');
          gameCols.each(function () {
              $(this).removeClass().addClass(`col game-col col-${12 / getColumnsForCardSize(cardSize)}`);
          });
      }

      function adjustIconSizes() {
          // Adjust icon sizes based on the slider value.
          const columns = Math.max(1, (cardSize || 0) + 3);
          const widthPercent = 100 / columns;
          $('.game-icon-link').css({
              flex: `0 0 ${widthPercent}%`,
              maxWidth: `${widthPercent}%`
          });
          $('.game-icon').css({
              width: '100%',
              height: 'auto'
          });
      }

      function updatePaginationSummary(totalItems) {
          const $summary = $('#paginationSummary');
          if (!$summary.length) return;

          $summary.text('');
          $summary.addClass('d-none');

          const safeTotal = Number.isFinite(totalItems) && totalItems > 0 ? Math.floor(totalItems) : 0;
          const safeItemsPerPage = Math.max(1, Number.isFinite(itemsPerPage) ? Math.floor(itemsPerPage) : 1);
          if (safeTotal === 0) {
              return;
          }

          const safeTotalPages = Math.max(1, Math.ceil(safeTotal / safeItemsPerPage));
          const safeCurrentPage = Math.min(Math.max(1, Number.isFinite(currentPage) ? Math.floor(currentPage) : 1), safeTotalPages);
          const pageStart = (safeCurrentPage - 1) * safeItemsPerPage + 1;
          const pageEnd = Math.min(pageStart + safeItemsPerPage - 1, safeTotal);
          const titleLabel = safeTotal === 1 ? 'Title' : 'Titles';

          $summary.removeClass('d-none');
          $summary.text(`Showing ${pageStart} to ${pageEnd} of ${safeTotal} ${titleLabel}`);
      }

      function updatePaginationControls(nbDisplayedGames) {
          paginationController?.update(nbDisplayedGames);
          updatePaginationSummary(nbDisplayedGames);
      }

      // ---- Filters persistence and application ----
      const activeTypeFilters = new Set();
      const activeOwnershipFilters = new Set();
      const activeUpdateFilters = new Set();
      const activeCompletionFilters = new Set();
      const activeSpecialFilters = new Set();
      const activeCategoryFilters = new Set();
      const pendingCategoryFilters = new Set();
      let allCategoryOptions = [];
      let categoryLabelMap = new Map();
      let categoryOptionsSignature = '';

      const getCheckedId = (groupName) => $(`input[name="${groupName}"]:checked`).attr('id') || null;

      const GENRE_LIST_SELECTOR = '#genreFilterList';
      const GENRE_TITLE_SELECTOR = '#genreFilterTitle';
      const GENRE_BODY_SELECTOR = '#genreFilterBody';
      const GENRE_TOGGLE_SELECTOR = '#genreFilterToggle';
      const GENRE_PILLS_SELECTOR = '#genreSelectedPills';
      const GENRE_SELECTED_ROW_SELECTOR = '#genreSelectedRow';
      const CLEAR_GENRE_BUTTON_SELECTOR = '#clearGenreFilters';

      const CATEGORY_CANONICALS = {
          action: { label: 'Action', aliases: ['アクション', '액션', '動作', '动作', 'action game'] },
          arcade: { label: 'Arcade', aliases: ['アーケード', '街機', 'arcade', 'arcade game', 'arcades'] },
          adventure: { label: 'Adventure', aliases: ['アドベンチャー', '冒険', '冒险', '모험', 'adventure game'] },
          'role-playing': { label: 'Role-Playing', aliases: ['ロールプレイング', 'role playing', 'role playing game', 'RPG', 'ＲＰＧ', '角色扮演', '角色扮演游戏', '롤플레잉'] },
          simulation: { label: 'Simulation', aliases: ['シミュレーション', '模拟', '模擬', '시뮬레이션', 'simulation game'] },
          strategy: { label: 'Strategy', aliases: ['ストラテジー', '策略', '戰略', '戦略', '전략', 'strategy game'] },
          sports: { label: 'Sports', aliases: ['スポーツ', '体育', '體育', '스포츠', 'sports game'] },
          puzzle: { label: 'Puzzle', aliases: ['パズル', '益智', 'パズルゲーム', '퍼즐', 'puzzle game'] },
          racing: { label: 'Racing', aliases: ['レース', '赛车', '賽車', '레이싱', 'racing game'] },
          shooter: { label: 'Shooter', aliases: ['シューティング', '射击', '射擊', '슈팅', 'shooting'] },
          fighting: { label: 'Fighting', aliases: ['格闘', '格鬥', '格斗', '대전 격투', '대전', 'fighting game'] },
          platformer: { label: 'Platformer', aliases: ['平台跳跃', '平台跳躍', 'プラットフォーム', 'ジャンプ', '플랫포머', 'platform'] },
          rhythm: { label: 'Rhythm', aliases: ['リズム', '音乐', '音樂', '리듬', 'rhythm game'] },
          horror: { label: 'Horror', aliases: ['ホラー', '恐怖', '호러', 'horror game'] },
          party: { label: 'Party', aliases: ['パーティー', '派对', '파티', 'party game'] },
          board: { label: 'Board/Card', aliases: ['ボードゲーム', 'カード', '卡牌', '桌游', '보드', 'テーブル', 'board game', 'card game', 'table'] },
          education: { label: 'Education', aliases: ['教育', '학습', '学習', '学習ゲーム', 'learning', 'education', 'educational'] },
          music: { label: 'Music', aliases: ['音楽', '音乐游戏', '音樂遊戲', '뮤직', 'music game'] },
          other: { label: 'Other', aliases: ['その他', 'other', 'others']},
          training: {label: 'Training', aliases: ['トレーニング', 'training']}
      };


      function normalizeCategoryValue(raw) {
          if (typeof raw !== 'string') raw = (raw ?? '').toString();
          if (!raw) return '';
          let normalized = raw;
          if (normalized.normalize) normalized = normalized.normalize('NFKD');
          normalized = normalized.replace(/[\u0300-\u036f]/g, '');
          normalized = normalized.trim().toLowerCase();
          normalized = normalized.replace(/\s+/g, ' ');
          return normalized;
      }

      const CATEGORY_ALIAS_LOOKUP = (() => {
          const map = new Map();
          Object.entries(CATEGORY_CANONICALS).forEach(([key, info]) => {
              const aliasSet = new Set([key, info.label, ...(info.aliases || [])]);
              aliasSet.forEach((alias) => {
                  const normalized = normalizeCategoryValue(alias);
                  if (normalized && !map.has(normalized)) {
                      map.set(normalized, key);
                  }
              });
          });
          return map;
      })();

      const GENRE_ICON_MAP = {
          action: 'fa-solid fa-bolt',
          adventure: 'fa-solid fa-map-location-dot',
          arcade: 'fa-solid fa-gamepad',
          'board/card': 'fa-solid fa-chess-board',
          board: 'fa-solid fa-chess-board',
          communication: 'fa-solid fa-comments',
          education: 'fa-solid fa-graduation-cap',
          educational: 'fa-solid fa-graduation-cap',
          study: 'fa-solid fa-book-open-reader',
          training: 'fa-solid fa-chalkboard-user',
          fighting: 'fa-solid fa-hand-fist',
          'first-person shooter': 'fa-solid fa-crosshairs',
          shooter: 'fa-solid fa-crosshairs',
          lifestyle: 'fa-solid fa-heart-pulse',
          music: 'fa-solid fa-music',
          party: 'fa-solid fa-people-group',
          platformer: 'fa-solid fa-layer-group',
          practical: 'fa-solid fa-screwdriver-wrench',
          utility: 'fa-solid fa-screwdriver-wrench',
          puzzle: 'fa-solid fa-puzzle-piece',
          racing: 'fa-solid fa-flag-checkered',
          'role-playing': 'fa-solid fa-hat-wizard',
          simulation: 'fa-solid fa-vr-cardboard',
          strategy: 'fa-solid fa-chess-knight',
          video: 'fa-solid fa-film',
          other: 'fa-solid fa-question',
      };

      const DEFAULT_GENRE_ICON = 'fa-solid fa-gamepad';

      function canonicalizeCategoryValue(raw) {
          const normalized = normalizeCategoryValue(raw);
          if (!normalized) return '';
          return CATEGORY_ALIAS_LOOKUP.get(normalized) || normalized;
      }

      function getGenreIconClass(value) {
          const canonical = canonicalizeCategoryValue(value);
          if (!canonical) return DEFAULT_GENRE_ICON;
          if (GENRE_ICON_MAP[canonical]) return GENRE_ICON_MAP[canonical];
          return DEFAULT_GENRE_ICON;
      }

      function asCategoryArray(source) {
          if (!source) return [];
          if (Array.isArray(source)) return source;
          if (typeof source === 'string' || typeof source === 'number') return [source];
          return [];
      }

      function collectRawCategoriesFromGame(game) {
          if (!game || typeof game !== 'object') return [];
          const values = [];
          const pushValues = (source) => {
              asCategoryArray(source).forEach((value) => {
                  const str = (value ?? '').toString().trim();
                  if (str) values.push(str);
              });
          };
          pushValues(game.category);
          pushValues(game.categories);
          pushValues(game.category_tags);
          pushValues(game.metadata?.category);
          pushValues(game._metadataEntry?.category);
          pushValues(game._orig?.category);
          return values;
      }

      function getGameCategoryValues(game) {
          const normalized = new Set();
          collectRawCategoriesFromGame(game).forEach((value) => {
              const norm = canonicalizeCategoryValue(value);
              if (norm) normalized.add(norm);
          });
          return Array.from(normalized);
      }

      function collectCategoryOptionsFromGames(list) {
          const labelMap = new Map();
          (Array.isArray(list) ? list : []).forEach((game) => {
              collectRawCategoriesFromGame(game).forEach((raw) => {
                  const norm = canonicalizeCategoryValue(raw);
                  if (!norm || labelMap.has(norm)) return;
                  const canonical = CATEGORY_CANONICALS[norm];
                  const displayLabel = canonical?.label || (typeof raw === 'string' ? raw.trim() : norm);
                  labelMap.set(norm, displayLabel);
              });
          });
          return Array.from(labelMap.entries())
              .map(([value, label]) => ({
                  value,
                  label: label || value,
              }))
              .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
      }

      function getCategoryLabel(value) {
          if (!value) return '';
          const canonicalKey = canonicalizeCategoryValue(value);
          if (canonicalKey && CATEGORY_CANONICALS[canonicalKey]?.label) {
              return CATEGORY_CANONICALS[canonicalKey].label;
          }
          if (canonicalKey && categoryLabelMap.get(canonicalKey)) {
              return categoryLabelMap.get(canonicalKey);
          }
          if (categoryLabelMap.get(value)) return categoryLabelMap.get(value);
          if (canonicalKey && canonicalKey !== value) {
              return canonicalKey.split(/[\s_-]+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
          }
          return value;
      }

      function updateGenreSummaryUi() {
          const $title = $(GENRE_TITLE_SELECTOR);
          if (!$title.length) return;
          if (!allCategoryOptions.length) {
              $title.text('Genres (Loading)');
              return;
          }
          if (!activeCategoryFilters.size) {
              $title.text('Genres (All)');
          } else {
              $title.text('Genres');
          }
      }

      function updateGenreClearButtonState() {
          const $btn = $(CLEAR_GENRE_BUTTON_SELECTOR);
          if (!$btn.length) return;
          $btn.prop('disabled', activeCategoryFilters.size === 0);
      }

      function renderGenreSelectedPills() {
          const $container = $(GENRE_PILLS_SELECTOR);
          const $row = $(GENRE_SELECTED_ROW_SELECTOR);
          if (!$container.length) return;
          const selectedValues = Array.from(activeCategoryFilters);
          if (!selectedValues.length) {
              $container.empty().addClass('d-none');
              if ($row.length) $row.addClass('d-none');
              return;
          }
          $container.removeClass('d-none');
          if ($row.length) $row.removeClass('d-none');
          const fragment = document.createDocumentFragment();
          selectedValues
              .map((value) => ({
                  value,
                  label: getCategoryLabel(value),
              }))
              .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
              .forEach((item) => {
                  const pill = document.createElement('span');
                  pill.className = 'genre-pill';
                  pill.dataset.genreValue = item.value;

                  const textSpan = document.createElement('span');
                  textSpan.textContent = item.label || item.value;

                  const removeBtn = document.createElement('button');
                  removeBtn.type = 'button';
                  removeBtn.className = 'genre-pill-remove';
                  removeBtn.dataset.genreValue = item.value;
                  removeBtn.setAttribute('aria-label', `Remove ${item.label || item.value}`);
                  removeBtn.innerHTML = '&times;';

                  pill.appendChild(textSpan);
                  pill.appendChild(removeBtn);
                  fragment.appendChild(pill);
              });

          $container.empty().append(fragment).removeClass('d-none');
      }

      function refreshGenreSelectionUi() {
          updateGenreSummaryUi();
          updateGenreClearButtonState();
          renderGenreSelectedPills();
      }

      function setGenreSectionExpanded(expanded) {
          const $body = $(GENRE_BODY_SELECTOR);
          const $toggle = $(GENRE_TOGGLE_SELECTOR);
          const $row = $(GENRE_SELECTED_ROW_SELECTOR);
          if ($body.length) {
              $body.toggleClass('open', expanded);
              $body.attr('aria-hidden', expanded ? 'false' : 'true');
          }
          if ($toggle.length) {
              $toggle.attr('aria-expanded', expanded ? 'true' : 'false');
          }
          if ($row.length) {
              $row.toggleClass('expanded', expanded);
          }
      }

      function computeVisibleCategoryOptions() {
          if (!Array.isArray(games) || !games.length || !allCategoryOptions.length) {
              return [];
          }
          if (!activeCategoryFilters.size) {
              return allCategoryOptions.slice();
          }

          const selection = Array.from(activeCategoryFilters);
          const matchingGames = games.filter((game) => {
              const categories = getGameCategoryValues(game);
              if (!categories.length) return false;
              const categorySet = new Set(categories);
              for (let i = 0; i < selection.length; i += 1) {
                  if (!categorySet.has(selection[i])) return false;
              }
              return true;
          });

          const derivedOptions = collectCategoryOptionsFromGames(matchingGames);
          const combinedMap = new Map();
          selection.forEach((value) => {
              const label = getCategoryLabel(value);
              combinedMap.set(value, { value, label });
          });
          derivedOptions.forEach((option) => {
              if (!combinedMap.has(option.value)) combinedMap.set(option.value, option);
          });

          return Array.from(combinedMap.values())
              .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
      }

      function renderGenreFilterOptions() {
          const $list = $(GENRE_LIST_SELECTOR);
          if (!$list.length) return;

          if (!allCategoryOptions.length) {
              $list.html('<div class="text-muted small py-2">No genres detected.</div>');
              refreshGenreSelectionUi();
              return;
          }

          const options = computeVisibleCategoryOptions();

          if (!options.length) {
              $list.html('<div class="text-muted small py-2">No matching genres.</div>');
          } else {
              const fragment = document.createDocumentFragment();
              options.forEach((option) => {
                  const row = document.createElement('div');
                  row.className = 'genre-toggle-row';
                  row.dataset.categoryValue = option.value;
                  row.setAttribute('tabindex', '0');
                  row.setAttribute('role', 'button');

                  const info = document.createElement('div');
                  info.className = 'genre-toggle-info';

                  const icon = document.createElement('i');
                  icon.className = `genre-icon ${getGenreIconClass(option.value)}`;
                  info.appendChild(icon);

                  const textSpan = document.createElement('span');
                  textSpan.textContent = option.label;
                  info.appendChild(textSpan);

                  const toggle = document.createElement('div');
                  toggle.className = 'genre-toggle-button';

                  row.appendChild(info);
                  row.appendChild(toggle);
                  fragment.appendChild(row);
              });

              $list.empty().append(fragment);
          }

          applyCategoryFiltersToDom();
          pendingCategoryFilters.clear();
      }

      function rebuildGenreFiltersIfNeeded() {
          if (!Array.isArray(games) || !games.length) {
              allCategoryOptions = [];
              categoryLabelMap = new Map();
              categoryOptionsSignature = '';
              const $list = $(GENRE_LIST_SELECTOR);
              if ($list.length) {
                  $list.html('<div class="text-muted small py-2">No genres detected.</div>');
              }
              refreshGenreSelectionUi();
              return;
          }
          const options = collectCategoryOptionsFromGames(games);
          const signature = options.map((option) => option.value).join('|');
          const changed = signature !== categoryOptionsSignature;
          if (changed || !allCategoryOptions.length) {
              categoryOptionsSignature = signature;
              allCategoryOptions = options;
              categoryLabelMap = new Map(options.map((option) => [option.value, option.label]));
          }
          renderGenreFilterOptions();
          refreshGenreSelectionUi();
      }

      function clearGenreFilters() {
          activeCategoryFilters.clear();
          pendingCategoryFilters.clear();
          applyCategoryFiltersToDom();
      }

      function applyCategoryFiltersToDom() {
          const $list = $(GENRE_LIST_SELECTOR);
          if (!$list.length) {
              refreshGenreSelectionUi();
              return;
          }
          const rows = $list.find('.genre-toggle-row');
          if (!rows.length) {
              refreshGenreSelectionUi();
              return;
          }
          rows.each((_, row) => {
              const rawValue = row.dataset.categoryValue;
              const value = canonicalizeCategoryValue(rawValue);
              const isActive = activeCategoryFilters.has(value);
              row.classList.toggle('active', isActive);
              row.setAttribute('aria-pressed', isActive ? 'true' : 'false');
              const toggle = row.querySelector('.genre-toggle-button');
              if (toggle) {
                  toggle.classList.toggle('active', isActive);
              }
          });
          refreshGenreSelectionUi();
      }

      function handleGenreToggle(value) {
          const normalized = canonicalizeCategoryValue(value);
          if (!normalized) return;
          if (activeCategoryFilters.has(normalized)) {
              activeCategoryFilters.delete(normalized);
          } else {
              activeCategoryFilters.add(normalized);
          }
          renderGenreFilterOptions();
          applyFilters();
          saveFiltersToStorage();
      }

      function updateFilter() {
          // clear all
          activeTypeFilters.clear();
          activeOwnershipFilters.clear();
          activeUpdateFilters.clear();
          activeCompletionFilters.clear();
          activeSpecialFilters.clear();

          // Type (All clears the set → no filtering by type)
          switch (getCheckedId('typeFilter')) {
              case 'typeBase': activeTypeFilters.add('BASE'); break;
              case 'typeDlc':  activeTypeFilters.add('DLC');  break;
          }

          // Ownership
          switch (getCheckedId('ownershipFilter')) {
              case 'ownershipOwned':   activeOwnershipFilters.add('Owned');   break;
              case 'ownershipMissing': activeOwnershipFilters.add('Missing'); break;
          }

          // Update  (map “Missing Update” UI to internal “Outdated”)
          switch (getCheckedId('updateFilter')) {
              case 'updateUpToDate':       activeUpdateFilters.add('Up to date'); break;
              case 'updateMissingUpdate':  activeUpdateFilters.add('Outdated');    break;
          }

          // Completion
          switch (getCheckedId('completionFilter')) {
              case 'completionComplete':     activeCompletionFilters.add('Complete');     break;
              case 'completionIncomplete':   activeCompletionFilters.add('Missing DLC');  break;
          }

          // Special (Overrides)
          switch (getCheckedId('specialFilter')) {
              case 'specialUnrecognized': activeSpecialFilters.add('Unrecognized'); break;
              case 'specialOverridden':   activeSpecialFilters.add('Overridden');   break;
          }
      }

      function saveFiltersToStorage() {
          const filters = {
              type:        normalizeId(getCheckedId('typeFilter')),
              ownership:   normalizeId(getCheckedId('ownershipFilter')),
              update:      normalizeId(getCheckedId('updateFilter')),
              completion:  normalizeId(getCheckedId('completionFilter')),
              override:    normalizeId(getCheckedId('specialFilter')),
              genres:      Array.from(activeCategoryFilters),
          };
          CacheModule?.writeLocalJson?.('activeFilters', filters);
      }

      function normalizeId(raw) {
          const s = (raw || '').toString().trim();
          // strip one or more leading '#'
          return s.replace(/^#+/,'');
      }
    
      function checkIfExistsAndSet(id) {
          const norm = normalizeId(id);
          if (!norm) return;
          const $el = $(`#${norm}`);
          if ($el.length) $el.prop('checked', true);
      }

      function loadFiltersFromStorage() {
          const f = CacheModule?.readLocalJson?.('activeFilters', null);
          if (f) {
              if (f.type)       checkIfExistsAndSet(f.type);
              if (f.ownership)  checkIfExistsAndSet(f.ownership);
              if (f.update)     checkIfExistsAndSet(f.update);
              if (f.completion) checkIfExistsAndSet(f.completion);
              if (f.override)   checkIfExistsAndSet(f.override);
              if (Array.isArray(f.genres)) {
                  activeCategoryFilters.clear();
                  pendingCategoryFilters.clear();
                  f.genres.forEach((value) => {
                      const norm = canonicalizeCategoryValue(value);
                      if (!norm) return;
                      activeCategoryFilters.add(norm);
                      pendingCategoryFilters.add(norm);
                  });
                  refreshGenreSelectionUi();
              }
          }

          updateFilter();

          const savedSearch = CacheModule?.readLocalString?.('searchTerm', null);
          if (typeof savedSearch === 'string') $('#textFilter').val(savedSearch);

          applyCategoryFiltersToDom();

          applyFilters({ preservePage: true });
      }

      // Build (and memoize) a lowercase search string for a game to avoid recomputing per keystroke.
      const buildSearchBlob = (game) => {
          if (!game || typeof game !== 'object') return '';
          if (typeof game._searchBlob === 'string') return game._searchBlob;

          const parts = [];
          const addText = (value) => {
              if (typeof value !== 'string') return;
              const trimmed = value.trim();
              if (trimmed.length) parts.push(trimmed.toLowerCase());
          };

          addText(game.app_id);
          addText(game.title_id);
          addText(game.dlc_title_id);
          addText(game.corrected_title_id);
          addText(game.name);
          addText(game.title_id_name);
          addText(game.base_name);

          if (game._orig) {
              addText(game._orig.name);
              addText(game._orig.title_id_name);
          }

          const override = Overrides?.getOverrideForGame?.(game);
          if (override) addText(override.name);

          const displayTitle = (typeof game.display_title === 'string')
              ? game.display_title
              : Overrides?.displayTitleFor?.(game, games);
          if (displayTitle) addText(displayTitle);

          game._searchBlob = parts.join(' ');
          game._searchTokens = parts.filter(Boolean);
          return game._searchBlob;
      };

      function getDescriptionTokens(game) {
          if (!game || typeof game !== 'object') return [];
          if (Array.isArray(game._descriptionSearchTokens)) return game._descriptionSearchTokens;

          const values = [];
          if (typeof game.description === 'string') values.push(game.description);
          const override = Overrides?.getOverrideForGame?.(game);
          if (override && typeof override.description === 'string') values.push(override.description);

          const tokenSet = new Set();
          values.forEach((raw) => {
              if (typeof raw !== 'string') return;
              const normalized = raw.normalize ? raw.normalize('NFKD') : raw;
              const withoutMarks = normalized.replace(/[\u0300-\u036f]/g, '');
              const lowered = withoutMarks.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
              lowered.split(/\s+/).forEach((token) => {
                  if (token) tokenSet.add(token);
              });
          });

          const tokens = Array.from(tokenSet);
          game._descriptionSearchTokens = tokens;
          return tokens;
      }

      function getBaseSearchTokens(game) {
          if (!game || typeof game !== 'object') return [];
          if (Array.isArray(game._searchTokens)) return game._searchTokens;
          const entryTokens = game._metadataEntry?.search_tokens;
          if (Array.isArray(entryTokens) && entryTokens.length > 0) {
              game._searchTokens = entryTokens.slice();
              return game._searchTokens;
          }
          buildSearchBlob(game);
          if (Array.isArray(game._searchTokens)) return game._searchTokens;
          const blob = typeof game._searchBlob === 'string' ? game._searchBlob : '';
          game._searchTokens = blob.split(/\s+/).filter(Boolean);
          return game._searchTokens;
      }

      function getSearchTokens(game) {
          const baseTokens = getBaseSearchTokens(game);
          if (!shouldIncludeDescriptionSearch()) return baseTokens;
          const descTokens = getDescriptionTokens(game);
          if (!descTokens.length) return baseTokens;
          const prefixTokens = Array.isArray(baseTokens) ? baseTokens : [];
          return prefixTokens.concat(descTokens);
      }

      // Function to apply filters and show/hide game cards with animation
      function applyFilters(options = {}) {
          if (!Array.isArray(games)) games = [];

          const preservePage = options?.preservePage === true;
          const prevPage = currentPage;
          const prevItemsPerPage = itemsPerPage;
          const prevTotalItems = Array.isArray(filteredGames) ? filteredGames.length : 0;
          const safePrevItemsPerPage = Math.max(1, Number.isFinite(prevItemsPerPage) ? prevItemsPerPage : 1);
          const prevTotalPages = Math.max(1, Math.ceil(prevTotalItems / safePrevItemsPerPage));

          const requireType = activeTypeFilters.size > 0;
          const requireOwnership = activeOwnershipFilters.size > 0;
          const requireUpdate = activeUpdateFilters.size > 0;
          const requireCompletion = activeCompletionFilters.size > 0;
          const requireSpecial = activeSpecialFilters.size > 0;
          const requireCategories = activeCategoryFilters.size > 0;

          const wantsOwned = activeOwnershipFilters.has("Owned");
          const wantsMissing = activeOwnershipFilters.has("Missing");
          const wantsUpToDate = activeUpdateFilters.has("Up to date");
          const wantsOutdated = activeUpdateFilters.has("Outdated");
          const wantsComplete = activeCompletionFilters.has("Complete");
          const wantsMissingDlc = activeCompletionFilters.has("Missing DLC");
          const wantsUnrecognized = activeSpecialFilters.has("Unrecognized");
          const wantsOverridden = activeSpecialFilters.has("Overridden");
          const categoryFiltersSet = requireCategories ? new Set(activeCategoryFilters) : null;

          const gamesUpperType = requireType ? new Set(Array.from(activeTypeFilters).map(t => (t || '').toUpperCase())) : null;
          const canCheckUnrecognized = typeof Overrides?.isUnrecognizedGame === 'function';
          const canCheckOverridden = typeof Overrides?.hasActiveOverride === 'function';

          // Single-pass filter across all toggles to avoid repeated full-array scans.
          baseFilteredGames = games.filter(game => {
              if (!game || typeof game !== 'object') return false;

              const type = (game.app_type || '').toUpperCase();
              if (requireType && !gamesUpperType.has(type)) return false;

              if (requireOwnership) {
                  const owned = game.owned === true;
                  const matchesOwned =
                      (wantsOwned && owned) ||
                      (wantsMissing && !owned);
                  if (!matchesOwned) return false;
              }

              if (requireUpdate) {
                  const hasLatest = game.has_latest_version === true;
                  const matchesUpdate =
                      (wantsUpToDate && hasLatest) ||
                      (wantsOutdated && !hasLatest);
                  if (!matchesUpdate) return false;
              }

              if (requireCompletion) {
                  const hasAllDlcs = game.has_all_dlcs === true;
                  const matchesCompletion =
                      (wantsComplete && hasAllDlcs) ||
                      (wantsMissingDlc && !hasAllDlcs);
                  if (!matchesCompletion) return false;
              }

              if (requireSpecial) {
                  let matchesSpecial = false;
                  if (wantsUnrecognized) {
                      if (canCheckUnrecognized) {
                          matchesSpecial = Overrides.isUnrecognizedGame(game);
                      } else if (typeof game.isUnrecognized === 'boolean') {
                          matchesSpecial = game.isUnrecognized;
                      }
                  }
                  if (!matchesSpecial && wantsOverridden) {
                      if (canCheckOverridden) {
                          matchesSpecial = Overrides.hasActiveOverride(game);
                      } else if (game && typeof game.override_name === 'string') {
                          matchesSpecial = true;
                      }
                  }
                  if (!matchesSpecial) return false;
              }

              if (requireCategories) {
                  if (!categoryFiltersSet || !categoryFiltersSet.size) return false;
                  const gameCategories = getGameCategoryValues(game);
                  if (!gameCategories.length) return false;
                  const gameCategorySet = new Set(gameCategories);
                  for (const needed of categoryFiltersSet) {
                      if (!gameCategorySet.has(needed)) return false;
                  }
              }

              return true;
          });

          baseFilteredGames = pruneGhostsInPlace(baseFilteredGames);

          // Now apply SEARCH on top of baseFilteredGames
          const term = $('#textFilter').val() || '';
          filteredGames = filterBySearchText(baseFilteredGames, term);
          filteredGames = pruneGhostsInPlace(filteredGames);

          const newTotalItems = filteredGames.length;
          const safeItemsPerPage = Math.max(1, Number.isFinite(itemsPerPage) ? itemsPerPage : 1);
          const newTotalPages = Math.max(1, Math.ceil(newTotalItems / safeItemsPerPage));

          if (preservePage && prevItemsPerPage === itemsPerPage) {
              const candidatePage = Math.min(Math.max(prevPage, 1), newTotalPages);
              setCurrentPageValue(candidatePage);
          } else {
              setCurrentPageValue(1);
          }

          renderGames();
      }

      function filterBySearchText(list, searchTerm) {
          const src = Array.isArray(list) ? list : [];
          const term = (searchTerm || '').trim().toLowerCase();
          if (!term) return src.slice();

          const searchTokens = term.split(/\s+/).filter(Boolean);
          if (searchTokens.length === 0) return src.slice();

          return src.filter(game => {
              const tokens = getSearchTokens(game);
              if (!tokens.length) return false;
              return searchTokens.every(t => tokens.some(gt => gt.includes(t)));
          });
      }

      $(document).ready(() => {
          const overridesModule = Overrides;

          if (overridesModule?.bindEnvironment) {
              overridesModule.bindEnvironment({
                  getGames: () => games,
                  applyFilters: (options) => applyFilters(options),
              });
          }
          if (overridesModule?.initDomBindings) {
              overridesModule.initDomBindings();
          }

          const savedItemsPerPage = CacheModule?.readLocalString?.('itemsPerPage', null);
          if (savedItemsPerPage) itemsPerPage = parseInt(savedItemsPerPage, 10);

          const savedCurrentView = CacheModule?.readLocalString?.('currentView', null);
          if (savedCurrentView) currentView = normalizeView(savedCurrentView);
          setActiveViewButton(currentView);

          const savedCardSize = CacheModule?.readLocalString?.('cardSize', null);
          if (savedCardSize) cardSize = parseInt(savedCardSize, 10);

          const savedCurrentPage = loadStoredPage();
          if (savedCurrentPage !== null) currentPage = savedCurrentPage;

          paginationController = window.Ownfoil?.Pagination?.create({
              container: '#paginationControls',
              getCurrentPage: () => currentPage,
              setCurrentPage: (page) => { setCurrentPageValue(page); },
              getItemsPerPage: () => itemsPerPage,
              onPageChange: () => renderGames(),
          });
          updatePaginationSummary(Array.isArray(filteredGames) ? filteredGames.length : 0);

          async function bootstrap() {
              let restoredFromSnapshot = false;

              try {
                  const snapshot = await dataManager.loadCombinedSnapshot();
                  if (snapshot && Array.isArray(snapshot.games)) {
                      syncGamesFromState();
                      filteredGames = pruneGhostsInPlace(Array.isArray(games) ? games.slice() : []);
                      baseFilteredGames = filteredGames.slice();
                      rebuildGenreFiltersIfNeeded();
                      updatePaginationSummary(filteredGames.length);
                      loadFiltersFromStorage();
                      renderGames();
                      restoredFromSnapshot = true;
                  }
              } catch (err) {
                  console.warn('Ownfoil cache: failed to load combined snapshot', err);
              }

              window.Ownfoil.onOverridesUpdated = async () => {
                  if (suppressNextOverridesMetadataRefresh) {
                      suppressNextOverridesMetadataRefresh = false;
                      return;
                  }
                  try {
                      await dataManager.refreshMetadataAfterOverrides();
                      syncGamesFromState();
                      filteredGames = pruneGhostsInPlace(Array.isArray(games) ? games.slice() : []);
                      baseFilteredGames = filteredGames.slice();
                      rebuildGenreFiltersIfNeeded();
                      applyFilters({ preservePage: true });
                  } catch (err) {
                      console.warn('Ownfoil overrides refresh failed', err);
                      applyFilters({ preservePage: true });
                  }
              };

              suppressNextOverridesMetadataRefresh = true;

              try {
                  const result = await dataManager.fetchAll();
                  syncGamesFromState();
                  filteredGames = pruneGhostsInPlace(Array.isArray(games) ? games.slice() : []);
                  baseFilteredGames = filteredGames.slice();
                  rebuildGenreFiltersIfNeeded();
                  if (result?.etags) updateKnownEtags(result.etags);
                  loadFiltersFromStorage();
                  applyFilters({ preservePage: restoredFromSnapshot });
              } catch (err) {
                  console.error('Ownfoil bootstrap failed', err);
                  syncGamesFromState();
                  filteredGames = pruneGhostsInPlace(Array.isArray(games) ? games.slice() : []);
                  baseFilteredGames = filteredGames.slice();
                  rebuildGenreFiltersIfNeeded();
                  loadFiltersFromStorage();
                  applyFilters({ preservePage: true });
              } finally {
                  suppressNextOverridesMetadataRefresh = false;
              }
          }

          bootstrap().catch((err) => {
              console.error('Ownfoil bootstrap failed', err);
              suppressNextOverridesMetadataRefresh = false;
              loadFiltersFromStorage();
          });

          function recalcPageForNewPageSize(prevItemsPerPage) {
              const totalItems = Array.isArray(filteredGames) ? filteredGames.length : 0;
              if (totalItems === 0) {
                  setCurrentPageValue(1);
                  return;
              }

              const prevSize = Number(prevItemsPerPage);
              const newSize = Number(itemsPerPage);
              const safePrevItemsPerPage = Math.max(1, Number.isFinite(prevSize) ? Math.floor(prevSize) : 1);
              const safeNewItemsPerPage = Math.max(1, Number.isFinite(newSize) ? Math.floor(newSize) : 1);
              const safePrevPage = Math.max(1, normalizePage(currentPage));

              const firstItemIndex = (safePrevPage - 1) * safePrevItemsPerPage;
              const candidatePage = Math.floor(firstItemIndex / safeNewItemsPerPage) + 1;
              const totalPages = Math.max(1, Math.ceil(totalItems / safeNewItemsPerPage));

              const clampedPage = Math.min(Math.max(candidatePage, 1), totalPages);
              setCurrentPageValue(clampedPage);
          }

          // Event listeners for items per page dropdown
          $('.items-per-page').click(function () {
              const prevItemsPerPage = itemsPerPage;
              itemsPerPage = parseInt($(this).data('value'), 10);
              CacheModule?.writeLocalString?.('itemsPerPage', itemsPerPage);
              recalcPageForNewPageSize(prevItemsPerPage);
              renderGames();
          });

          $('#applyCustomItemsPerPage').click(function () {
              const prevItemsPerPage = itemsPerPage;
              const customValue = $('#customItemsPerPage').val();
              if (customValue && customValue > 0) {
                  itemsPerPage = parseInt(customValue, 10);
                  CacheModule?.writeLocalString?.('itemsPerPage', itemsPerPage);
                  recalcPageForNewPageSize(prevItemsPerPage);
                  renderGames();
              }
          });

          // Event listener for card size slider
          $('#cardSizeRange').on('input', function () {
              cardSize = parseInt($(this).val());
              CacheModule?.writeLocalString?.('cardSize', cardSize);
              if (currentView === 'icon') adjustIconSizes(); else adjustCardSizes();
          });

          // Event listener for view buttons
          $('.view-toggle-btn').on('click', function () {
              if (this.disabled) return;
              const view = normalizeView($(this).data('view'));
              setActiveViewButton(view);
              CacheModule?.writeLocalString?.('currentView', view);
              currentView = view;
              renderGames();
          });

          // Filters
          $('.type-toggle, .ownership-toggle, .update-toggle, .completion-toggle, .override-toggle').on('change', function() {
              updateFilter();
              applyFilters();
              saveFiltersToStorage();
          });

      $(document).on('click', '#genreFilterList .genre-toggle-row', (event) => {
          event.preventDefault();
          const row = event.currentTarget;
          handleGenreToggle(row.dataset.categoryValue);
      });

          $(document).on('keydown', '#genreFilterList .genre-toggle-row', (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleGenreToggle(event.currentTarget.dataset.categoryValue);
              }
          });

          $(document).on('click', '#clearGenreFilters', (event) => {
              event.preventDefault();
              if (!activeCategoryFilters.size) return;
              clearGenreFilters();
              renderGenreFilterOptions();
              applyFilters();
              saveFiltersToStorage();
          });

          $(document).on('click', '#genreFilterToggle', (event) => {
              event.preventDefault();
              const $body = $(GENRE_BODY_SELECTOR);
              const isOpen = $body.hasClass('open');
              setGenreSectionExpanded(!isOpen);
          });

          $(document).on('click', '.genre-pill-remove', (event) => {
              event.preventDefault();
              const button = event.currentTarget;
              const value = button?.dataset?.genreValue;
              if (!value) return;
              if (activeCategoryFilters.has(value)) activeCategoryFilters.delete(value);
              if (pendingCategoryFilters.has(value)) pendingCategoryFilters.delete(value);
              const $checkbox = $(`${GENRE_LIST_SELECTOR} .genre-filter-checkbox`).filter((_, el) => {
                  return (el.dataset.categoryValue || '').toLowerCase() === value;
              });
              $checkbox.prop('checked', false);
              renderGenreFilterOptions();
              applyFilters();
              saveFiltersToStorage();
          });

          // Search (debounced, but skip on Enter)
          $("#textFilter").on("input", function () {
              const val = $(this).val();
              CacheModule?.writeLocalString?.('searchTerm', val);

              clearTimeout(searchDebounceTimer);
              searchDebounceTimer = setTimeout(() => {
                  applyFilters();
              }, SEARCH_DEBOUNCE_MS);
          });

          // Apply immediately when the field loses focus
          $("#textFilter").on("blur", function () {
              clearTimeout(searchDebounceTimer);
              applyFilters();
          });

          // Apply immediately when Enter is pressed (skip debounce)
          $("#textFilter").on("keydown", function (e) {
              if (e.key === "Enter" || e.keyCode === 13) {
                  e.preventDefault();                 // prevent form submit/page nav
                  clearTimeout(searchDebounceTimer);  // cancel any pending debounce
                  const val = $(this).val();
                  CacheModule?.writeLocalString?.('searchTerm', val);
                  applyFilters();
              }
          });

          // Close popovers on document click
          $(document).on('click', function () {
              $('.popover').removeClass('show');
              $('.popover').remove();
          });

          // Add click event on the popover to stop propagation
          $(document).on('click', '.popover', function (e) {
              e.stopPropagation(); // Prevent the click event from bubbling up
          });
      });
})(window, window.jQuery);
