'use strict';

((global, $) => {
  if (!$) {
    console.warn('Ownfoil game detail page requires jQuery.');
    return;
  }

  function toggleDetailGridSidebar(shouldShowSidebar) {
    const gridEl = rootEl.querySelector('.game-detail-grid');
    if (!gridEl) return;
    if (shouldShowSidebar) {
      gridEl.classList.remove('no-sidebar');
      elements.relatedContentCard?.attr('hidden', false);
    } else {
      gridEl.classList.add('no-sidebar');
      elements.relatedContentCard?.attr('hidden', true);
    }
  }

  const rootEl = document.getElementById('gameDetailRoot');
  if (!rootEl) return;

  const modalEl = document.getElementById('gameDetailModal');
  if (!modalEl) return;

  const shouldMatchInfoLanguage = (() => {
    const raw = rootEl.dataset.matchInfoLanguage;
    if (typeof raw === 'string') {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
    }
    return true;
  })();

  const bootstrapNs = global.bootstrap;
  if (!bootstrapNs || typeof bootstrapNs.Modal !== 'function') {
    console.warn('Ownfoil game detail modal requires Bootstrap Modal support.');
    return;
  }
  const modalInstance = bootstrapNs.Modal.getOrCreateInstance(modalEl);
  const CarouselComponent = typeof bootstrapNs.Carousel === 'function' ? bootstrapNs.Carousel : null;

  const namespace = global.Ownfoil = global.Ownfoil || {};
  const Overrides = namespace.Overrides || null;
  const LibraryDataNs = namespace.LibraryData || null;
  const LanguageUtils = namespace.LanguageUtils || null;
  const StatusBadges = namespace.StatusBadges || null;
  const PageConfig = namespace.Config || null;
  const datasetDetailBasePath = typeof rootEl.dataset.detailBasePath === 'string'
    ? rootEl.dataset.detailBasePath.trim()
    : '';
  const fallbackDetailBasePath = datasetDetailBasePath || '/games';
  const configSnapshot = PageConfig?.applyFromElement
    ? PageConfig.applyFromElement(rootEl, { detailBasePath: fallbackDetailBasePath })
    : null;

  if (!LibraryDataNs || typeof LibraryDataNs.create !== 'function') {
    console.error('Ownfoil game detail page: LibraryData module not available.');
    return;
  }
  if (!LanguageUtils) {
    console.warn('Ownfoil language utilities not available; falling back to raw text rendering.');
  }
  if (!StatusBadges) {
    console.warn('Ownfoil status badge utilities not available; badges may be missing.');
  }

  const isAdminUser = (global.IS_ADMIN === true || global.IS_ADMIN === 'true');
  const hideGhostCardsSetting = (global.HIDE_GHOST_CARDS === true || global.HIDE_GHOST_CARDS === 'true');
  const shouldHideGhostCards = !isAdminUser && hideGhostCardsSetting;
  const resolvedDetailBasePath = configSnapshot?.detailBasePath
    || datasetDetailBasePath
    || namespace.Config?.get?.('detailBasePath', fallbackDetailBasePath)
    || fallbackDetailBasePath;

  const dataManager = LibraryDataNs.create({
    overridesModule: Overrides,
    combinedCacheVersion: 1,
    shouldHideGhostCards,
    detailBasePath: resolvedDetailBasePath,
  });
  const state = dataManager.state;

  const normalizeAppId = dataManager.normalizeAppId;
  const getBaseKeyForAppId = dataManager.getBaseKeyForAppId;
  const getDetailUrlForGame = typeof dataManager.getDetailUrlForGame === 'function'
    ? (game) => dataManager.getDetailUrlForGame(game)
    : () => '#';

  const resolveBaseKeyFor = (appId) => {
    const normalized = normalizeAppId(appId);
    if (!normalized) return '';
    const base = getBaseKeyForAppId(appId);
    return normalizeAppId(base) || normalized;
  };

  const requestedAppId = normalizeAppId(rootEl.dataset.appId || '');
  let baseKey = resolveBaseKeyFor(requestedAppId);
  if (!baseKey) baseKey = requestedAppId;
  let currentAppId = normalizeAppId(requestedAppId || baseKey);
  const libraryUrl = typeof rootEl.dataset.libraryUrl === 'string' && rootEl.dataset.libraryUrl.trim()
    ? rootEl.dataset.libraryUrl.trim()
    : '/library';
  const historySupported = !!(global.history && typeof global.history.pushState === 'function');
  let isModalVisible = modalEl.classList.contains('show');
  let suppressHistorySync = false;
  let latestRequestToken = 0;

  modalEl.addEventListener('shown.bs.modal', () => {
    isModalVisible = true;
  });

  modalEl.addEventListener('hidden.bs.modal', () => {
    isModalVisible = false;
    if (!historySupported) return;
    if (suppressHistorySync) {
      suppressHistorySync = false;
      return;
    }
    try {
      global.history.replaceState({ appId: null }, '', libraryUrl);
    } catch (err) {
      console.warn('Ownfoil detail: history reset failed', err);
    }
  });

  const elements = {
    modalTitle: $('#gameDetailModalTitle'),
    alert: $('#gameDetailAlert'),
    overrideButton: $('#gameDetailOverrideBtn'),
    banner: $('#gameBanner'),
    icon: $('#gameIcon'),
    statusContainer: $('#gameStatusPills'),
    identifiers: $('#gameIdentifiers'),
    region: $('#gameRegion'),
    releaseDate: $('#gameReleaseDate'),
    players: $('#gamePlayers'),
    developer: $('#gameDeveloper'),
    publisher: $('#gamePublisher'),
    language: $('#gameLanguage'),
    languages: $('#gameLanguages'),
    size: $('#gameSize'),
    rating: $('#gameRating'),
    intro: $('#gameIntro'),
    description: $('#gameDescription'),
    descriptionContainer: $('#gameDescription'),
    categories: $('#gameCategories'),
    screenshotsCard: $('#screenshotsCard'),
    screenshots: $('#gameScreenshots'),
    screenshotIndicators: $('#gameScreenshotIndicators'),
    screenshotPrev: $('#gameScreenshotPrevControl'),
    screenshotNext: $('#gameScreenshotNextControl'),
    relatedContentCard: $('#relatedContentCard'),
    relatedContentList: $('#relatedContentList'),
  };

  const metadataRows = {
    region: $('#gameMetaRegion'),
    release: $('#gameMetaRelease'),
    players: $('#gameMetaPlayers'),
    developer: $('#gameMetaDeveloper'),
    publisher: $('#gameMetaPublisher'),
    rating: $('#gameMetaRating'),
    language: $('#gameMetaLanguage'),
    languages: $('#gameMetaLanguages'),
    size: $('#gameMetaSize'),
  };

  const templates = {
    screenshotItem: document.getElementById('screenshotItemTemplate'),
    relatedItem: document.getElementById('relatedItemTemplate'),
  };
  const screenshotCarouselEl = document.getElementById('gameScreenshotCarousel');
  let screenshotCarouselInstance = null;

  function disposeScreenshotCarousel() {
    if (screenshotCarouselInstance && typeof screenshotCarouselInstance.dispose === 'function') {
      screenshotCarouselInstance.dispose();
    }
    screenshotCarouselInstance = null;
  }

  function syncScreenshotIndicators(activeIndex) {
    if (!elements.screenshotIndicators?.length) return;
    const container = elements.screenshotIndicators[0];
    if (!container) return;
    const buttons = container.querySelectorAll('button');
    buttons.forEach((btn, idx) => {
      const isActive = idx === activeIndex;
      btn.classList.toggle('active', isActive);
      if (isActive) {
        btn.setAttribute('aria-current', 'true');
      } else {
        btn.removeAttribute('aria-current');
      }
    });
  }

  function getActiveSlideIndex() {
    if (!screenshotCarouselEl) return 0;
    const items = screenshotCarouselEl.querySelectorAll('.carousel-item');
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].classList.contains('active')) return i;
    }
    return 0;
  }

  if (screenshotCarouselEl) {
    screenshotCarouselEl.addEventListener('slid.bs.carousel', (event) => {
      const targetIndex = typeof event.to === 'number' ? event.to : getActiveSlideIndex();
      syncScreenshotIndicators(targetIndex);
    });
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


  function disposeHint(element) {
    if (!element) return;
    try {
      const tooltipCtor = bootstrapNs?.Tooltip;
      if (tooltipCtor && typeof tooltipCtor.getInstance === 'function') {
        const tooltipInstance = tooltipCtor.getInstance(element);
        if (tooltipInstance && typeof tooltipInstance.dispose === 'function') {
          tooltipInstance.dispose();
        }
      }
      const popoverCtor = bootstrapNs?.Popover;
      if (popoverCtor && typeof popoverCtor.getInstance === 'function') {
        const popoverInstance = popoverCtor.getInstance(element);
        if (popoverInstance && typeof popoverInstance.dispose === 'function') {
          popoverInstance.dispose();
        }
      }
    } catch (err) {
      console.warn('Ownfoil detail: failed to dispose tooltip/popover', err);
    }
    [
      'data-bs-toggle',
      'data-bs-placement',
      'data-bs-title',
      'data-bs-content',
      'data-bs-html',
      'data-bs-trigger',
      'data-bs-original-title',
      'title',
      'aria-describedby',
    ].forEach((attr) => {
      element.removeAttribute(attr);
    });
  }

  function applyTooltip(element, titleText) {
    if (!element) return;
    disposeHint(element);
    element.setAttribute('data-bs-toggle', 'tooltip');
    element.setAttribute('data-bs-placement', 'top');
    element.setAttribute('data-bs-title', titleText || '');
    const ctor = bootstrapNs?.Tooltip;
    if (typeof ctor === 'function') {
      ctor.getOrCreateInstance(element);
    }
  }

  function applyPopover(element, { title: popoverTitle, content, trigger = 'click' } = {}) {
    if (!element) return;
    disposeHint(element);
    element.setAttribute('data-bs-toggle', 'popover');
    element.setAttribute('data-bs-placement', 'top');
    element.setAttribute('data-bs-trigger', trigger);
    element.setAttribute('data-bs-title', popoverTitle || '');
    element.setAttribute('data-bs-content', content || '');
    element.setAttribute('data-bs-html', 'true');
    const ctor = bootstrapNs?.Popover;
    if (typeof ctor === 'function') {
      ctor.getOrCreateInstance(element);
    }
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(value) {
    if (!value || typeof value !== 'string') return '—';
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'unknown') return 'Unknown';
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return trimmed;
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  }

  function safeText(value, fallback = '—') {
    if (value == null) return fallback;
    const text = value.toString().trim();
    return text || fallback;
  }

  function formatStorageSize(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = [
      { unit: 'GB', factor: 1024 ** 3 },
      { unit: 'MB', factor: 1024 ** 2 },
      { unit: 'KB', factor: 1024 },
    ];
    for (const { unit, factor } of units) {
      if (bytes >= factor) {
        const amount = bytes / factor;
        const precision = amount >= 10 ? 1 : 2;
        return `${amount.toFixed(precision)} ${unit}`;
      }
    }
    return `${Math.max(bytes, 0).toFixed(0)} B`;
  }

  function getDisplayTitle(game, options = {}) {
    if (!game || typeof game !== 'object') return 'Unknown Title';
    const preferDlcName = options.preferDlcName === true;
    const type = (game.app_type || '').toUpperCase();
    const displayTitle = typeof game.display_title === 'string' ? game.display_title.trim() : '';
    const redirectedGame = getRedirectedGame(game);
    const redirectedDisplay = typeof redirectedGame?.display_title === 'string'
      ? redirectedGame.display_title.trim()
      : '';
    const redirectedName = (() => {
      if (!redirectedGame) return '';
      const candidate = (redirectedGame.name || redirectedGame.title_id_name || '').toString().trim();
      return candidate;
    })();

    if (type === 'DLC' && preferDlcName) {
      if (redirectedName) return redirectedName;
      if (redirectedDisplay) return redirectedDisplay;
      const name = (game.name || '').trim();
      if (name) return name;
    }

    if (displayTitle) return displayTitle;
    if (redirectedDisplay) return redirectedDisplay;
    if (redirectedName) return redirectedName;
    if (Overrides?.displayTitleFor) {
      const title = Overrides.displayTitleFor(game, state.games);
      if (title) return title;
    }
    if (type === 'DLC') {
      const name = (game.name || '').trim();
      if (name) return name;
    }
    return game.title_id_name || game.name || 'Unknown Title';
  }

  function collectGames(includeGhosts = false) {
    if (!baseKey) return [];
    return dataManager.getGamesForBaseKey(baseKey, {
      includeGhosts,
      hideGhosts: shouldHideGhostCards,
    });
  }

  function setBaseKeyForAppId(appId) {
    const resolved = resolveBaseKeyFor(appId);
    baseKey = resolved || normalizeAppId(appId);
  }

  function collectFullGames() {
    if (!baseKey) return [];
    return dataManager.getGamesForBaseKey(baseKey, {
      includeGhosts: true,
      hideGhosts: false,
    });
  }

  function setImageWithFallback(imgEl, src, fallback) {
    if (!imgEl || !imgEl.length) return;
    const el = imgEl.get(0);
    el.onload = null;
    el.onerror = null;
    const resolved = normalizeAssetUrl(src) || fallback;
    el.src = resolved;
    el.onerror = () => {
      if (el.src !== fallback) el.src = fallback;
    };
  }

  function setMetaValue(rowEl, valueEl, value) {
    if (!rowEl?.length || !valueEl?.length) return;
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      valueEl.text(normalized);
      rowEl.removeClass('d-none');
    } else {
      valueEl.text('—');
      rowEl.addClass('d-none');
    }
  }

  function getRedirectedGame(primaryGame) {
    if (!primaryGame || typeof primaryGame !== 'object') return null;
    const redirected = primaryGame._redirectedGame;
    return redirected && typeof redirected === 'object' ? redirected : null;
  }

  function resolveScalarField(primary, redirected, key) {
    const redirectedValue = redirected?.[key];
    if (redirectedValue !== undefined && redirectedValue !== null && redirectedValue !== '') {
      return redirectedValue;
    }
    const primaryValue = primary?.[key];
    if (primaryValue !== undefined && primaryValue !== null && primaryValue !== '') {
      return primaryValue;
    }
    return '';
  }

  function resolveArrayField(primary, redirected, key) {
    const redirectedValue = redirected?.[key];
    if (Array.isArray(redirectedValue) && redirectedValue.length) {
      return redirectedValue;
    }
    const primaryValue = primary?.[key];
    if (Array.isArray(primaryValue) && primaryValue.length) {
      return primaryValue;
    }
    return [];
  }

  function buildIdentifiers(baseGame, options = {}) {
    if (!baseGame) return '';
    const stacked = options.stacked === true;
    const parts = [];

    const wrapLine = (content) => (stacked ? `<div class="identifier-line">${content}</div>` : content);
    const add = (label, value, highlight = false) => {
      if (!value) return;
      const escapedValue = escapeHtml(value);
      const labelHtml = `<span class="identifier-label">${label}:</span>`;
      const valueHtml = `<span class="identifier-value${highlight ? ' text-warning fw-semibold' : ''}">${escapedValue}</span>`;
      parts.push(wrapLine(`${labelHtml} ${valueHtml}`));
    };

    const overrideEntry = typeof Overrides?.getOverrideForGame === 'function'
      ? Overrides.getOverrideForGame(baseGame)
      : null;
    const resolvedAppId = typeof Overrides?.pickTidForDisplay === 'function'
      ? Overrides.pickTidForDisplay(baseGame, overrideEntry)
      : '';

    const rawAppId = (baseGame.app_id || '').toString().trim().toUpperCase();
    const normalizedAppId = (resolvedAppId || rawAppId || '').toString().trim().toUpperCase();
    const titleId = safeText(baseGame.title_id, '').toUpperCase();
    const dlcId = safeText(baseGame.dlc_title_id, '').toUpperCase();
    const type = (baseGame.app_type || '').toUpperCase();

    const highlightAppId = normalizedAppId && normalizedAppId !== rawAppId;
    add('App ID', normalizedAppId, highlightAppId);
    if (!(highlightAppId && type === 'BASE') && titleId && titleId !== normalizedAppId) {
      add('Title ID', titleId);
    }
    if (dlcId && dlcId !== normalizedAppId && dlcId !== titleId) add('DLC ID', dlcId);

    if (!parts.length) return '';
    return stacked ? `<div class="identifier-list">${parts.join('')}</div>` : parts.join(' · ');
  }

  function renderCategories(container, categories) {
    container.empty();
    const list = Array.isArray(categories) ? categories.filter(Boolean) : [];
    if (!list.length) return;
    list.forEach((cat) => {
      const badge = $('<span class="badge rounded-pill text-bg-secondary me-2 mb-2"></span>');
      badge.text(cat);
      container.append(badge);
    });
  }

  function renderScreenshots(container, cardEl, screenshots) {
    container.empty();
    elements.screenshotIndicators?.empty();
    disposeScreenshotCarousel();

    const validScreenshots = Array.isArray(screenshots)
      ? screenshots.map((url) => (typeof url === 'string' ? url.trim() : '')).filter(Boolean)
      : [];

    if (!validScreenshots.length) {
      cardEl.attr('hidden', true);
      elements.screenshotIndicators?.addClass('d-none');
      elements.screenshotPrev?.addClass('d-none');
      elements.screenshotNext?.addClass('d-none');
      syncScreenshotIndicators(-1);
      return;
    }

    const total = validScreenshots.length;
    validScreenshots.forEach((url, index) => {
      let itemNode = null;
      if (templates.screenshotItem?.content?.firstElementChild) {
        itemNode = templates.screenshotItem.content.firstElementChild.cloneNode(true);
      } else {
        itemNode = document.createElement('div');
        itemNode.className = 'carousel-item';
        const frame = document.createElement('div');
        frame.className = 'screenshot-carousel-frame bg-body-secondary rounded overflow-hidden shadow-sm';
        const img = document.createElement('img');
        img.className = 'w-100 h-100 object-fit-cover screenshot-image';
        frame.appendChild(img);
        itemNode.appendChild(frame);
      }

      const imgEl = itemNode.querySelector('img');
      if (imgEl) {
        imgEl.setAttribute('src', url);
        imgEl.setAttribute('alt', `Screenshot ${index + 1}`);
      }

      if (index === 0) {
        itemNode.classList.add('active');
      } else {
        itemNode.classList.remove('active');
      }

      container.append(itemNode);

      if (total > 1 && elements.screenshotIndicators?.length) {
        const indicator = document.createElement('button');
        indicator.type = 'button';
        indicator.setAttribute('data-bs-target', '#gameScreenshotCarousel');
        indicator.setAttribute('data-bs-slide-to', index.toString());
        indicator.setAttribute('aria-label', `Go to screenshot ${index + 1}`);
        if (index === 0) {
          indicator.classList.add('active');
          indicator.setAttribute('aria-current', 'true');
        }
        elements.screenshotIndicators[0].appendChild(indicator);
      }
    });

    const hasMultiple = total > 1;
    if (elements.screenshotIndicators?.length) {
      elements.screenshotIndicators.toggleClass('d-none', !hasMultiple);
    }
    if (elements.screenshotPrev?.length) {
      elements.screenshotPrev.toggleClass('d-none', !hasMultiple);
    }
    if (elements.screenshotNext?.length) {
      elements.screenshotNext.toggleClass('d-none', !hasMultiple);
    }

    cardEl.attr('hidden', false);
    syncScreenshotIndicators(0);

    if (screenshotCarouselEl) {
      if (hasMultiple) {
        screenshotCarouselEl.setAttribute('data-bs-ride', 'carousel');
        screenshotCarouselEl.setAttribute('data-bs-interval', '5000');
      } else {
        screenshotCarouselEl.removeAttribute('data-bs-ride');
        screenshotCarouselEl.removeAttribute('data-bs-interval');
      }
    }

    if (!CarouselComponent || !screenshotCarouselEl) return;

    screenshotCarouselInstance = CarouselComponent.getOrCreateInstance(screenshotCarouselEl, {
      interval: hasMultiple ? 5000 : false,
      ride: hasMultiple ? 'carousel' : false,
      touch: true,
      pause: 'hover',
      wrap: true,
      keyboard: true,
    });

    if (hasMultiple) {
      screenshotCarouselInstance.cycle();
    } else {
      screenshotCarouselInstance.pause();
      screenshotCarouselEl.querySelectorAll('.carousel-item').forEach((item, idx) => {
        if (idx === 0) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
    }
  }

  function renderRelatedContent(listEl, cardEl, primaryGame, baseGame, dlcGames, selectedAppId, fallbackDlcGames = []) {
    listEl.empty();
    const normalizedSelected = normalizeAppId(selectedAppId);
    const items = [];
    const seenIds = new Set();

    const addItem = (game) => {
      if (!game || typeof game !== 'object') return;
      const normalizedId = normalizeAppId(game.app_id);
      if (!normalizedId || seenIds.has(normalizedId)) return;
      seenIds.add(normalizedId);
      const type = (game.app_type || '').toUpperCase();
      const label = getDisplayTitle(game, { preferDlcName: type === 'DLC' });
      const metaParts = [
        game.owned ? 'Owned' : 'Missing',
        typeof game.has_latest_version === 'boolean'
          ? (game.has_latest_version ? 'Up to date' : 'Update available')
          : null,
      ];
      if (type === 'DLC' && game.release_date) {
        metaParts.push(`Release: ${formatDate(game.release_date)}`);
      }
      items.push({
        game,
        label,
        meta: metaParts.filter(Boolean).join(' · '),
        normalizedId,
        type,
      });
    };

    addItem(baseGame);

    const dlcSource = [];
    if (Array.isArray(dlcGames)) dlcSource.push(...dlcGames);
    if (Array.isArray(fallbackDlcGames)) dlcSource.push(...fallbackDlcGames);
    dlcSource.forEach((dlc) => {
      if (!dlc || (dlc.app_type || '').toUpperCase() !== 'DLC') return;
      addItem(dlc);
    });

    addItem(primaryGame);

    const hasDlcEntries = items.some((item) => item.type === 'DLC');

    if (!items.length || !hasDlcEntries) {
      if (!hasDlcEntries) listEl.empty();
      cardEl.attr('hidden', true);
      return false;
    }

    items.sort((a, b) => {
      const typeWeightA = a.type === 'BASE' ? 0 : 1;
      const typeWeightB = b.type === 'BASE' ? 0 : 1;
      if (typeWeightA !== typeWeightB) return typeWeightA - typeWeightB;
      const idA = a.normalizedId || '';
      const idB = b.normalizedId || '';
      if (idA && idB) {
        const compareIds = idA.localeCompare(idB, undefined, { sensitivity: 'base' });
        if (compareIds !== 0) return compareIds;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });
    });

    const createCardElements = () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'related-card';

      const link = document.createElement('a');
      link.className = 'related-link text-decoration-none';
      link.href = '#';

      const iconContainer = document.createElement('div');
      iconContainer.className = 'related-card-icon';
      const iconImg = document.createElement('img');
      iconImg.className = 'related-icon-image';
      iconImg.alt = '';
      iconContainer.appendChild(iconImg);

      const textContainer = document.createElement('div');
      textContainer.className = 'related-card-body';
      const titleEl = document.createElement('div');
      titleEl.className = 'related-card-title';
      const metaEl = document.createElement('div');
      metaEl.className = 'related-card-meta';
      textContainer.appendChild(titleEl);
      textContainer.appendChild(metaEl);

      link.appendChild(iconContainer);
      link.appendChild(textContainer);
      wrapper.appendChild(link);

      return {
        wrapper,
        link,
        iconContainer,
        iconImg,
        textContainer,
        titleEl,
        metaEl,
      };
    };

    items.forEach(({ game, label, meta, normalizedId }) => {
      const {
        wrapper, link, iconContainer, iconImg, textContainer, titleEl, metaEl,
      } = createCardElements();

      titleEl.textContent = label;
      metaEl.textContent = meta || '';

      const fallbackIcon = global.DEFAULT_ICON || rootEl.dataset.defaultIcon || '';
      const iconUrl = pickArtworkUrl(
        Overrides?.iconUrlFor?.(game),
        game.icon_path,
        game.iconUrl,
        game.icon,
      ) || fallbackIcon;
      iconImg.src = iconUrl;
      iconImg.alt = `${label} icon`;
      if (fallbackIcon) {
        iconImg.onerror = () => {
          if (iconImg.src !== fallbackIcon) {
            iconImg.src = fallbackIcon;
          }
        };
      }

      const href = getDetailUrlForGame(game);
      const isSelected = normalizedId && normalizedId === normalizedSelected;

      if (isSelected) {
        const staticEl = document.createElement('div');
        staticEl.className = 'related-card-static';
        staticEl.appendChild(iconContainer);
        staticEl.appendChild(textContainer);
        wrapper.replaceChild(staticEl, link);
        wrapper.classList.add('selected');
        listEl.append(wrapper);
        return;
      }

      if (!href || href === '#' || href.includes('undefined')) {
        const staticDisabled = document.createElement('div');
        staticDisabled.className = 'related-card-static disabled';
        staticDisabled.appendChild(iconContainer);
        staticDisabled.appendChild(textContainer);
        wrapper.replaceChild(staticDisabled, link);
        wrapper.classList.add('disabled');
        listEl.append(wrapper);
        return;
      }

      link.href = href;
      link.setAttribute('aria-label', `View details for ${label}`);
      if (normalizedId) link.dataset.appId = normalizedId;

      link.addEventListener('click', (event) => {
        const isModifiedClick = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
        const isNonPrimaryButton = typeof event.which === 'number' && event.which !== 1;
        if (isModifiedClick || isNonPrimaryButton) {
          return;
        }
        event.preventDefault();
        if (!normalizedId || normalizedId === currentAppId) return;
        openDetail(normalizedId, { historyMode: 'push' }).catch((err) => {
          console.error('Ownfoil detail: failed to load related game', err);
        });
      });

      listEl.append(wrapper);
    });

    cardEl.attr('hidden', false);
    return true;
  }

  function renderStatusBadges(game) {
    const container = elements.statusContainer;
    if (!container || !container.length) return;
    const badgesModule = StatusBadges;
    const overrideButton = elements.overrideButton?.length ? elements.overrideButton.detach() : null;
    container.empty();
    if (badgesModule) {
      const nodes = [];
      const typeBadge = badgesModule.createTypeBadge?.(game, { activateHints: true });
      if (typeBadge) nodes.push(typeBadge);
      const versionBadge = badgesModule.createVersionBadge?.(game, { activateHints: true });
      if (versionBadge) nodes.push(versionBadge);
      const dlcBadge = badgesModule.createDlcBadge?.(game, { activateHints: true });
      if (dlcBadge) nodes.push(dlcBadge);
      const containerNode = container[0];
      nodes.forEach((node) => {
        if (node instanceof Node) containerNode.appendChild(node);
      });
    }
    if (overrideButton) {
      container.append(overrideButton);
    }
  }

  function renderGameDetail(primaryGame, baseGame, relatedGames) {
    if (!primaryGame) return;
    if (elements.alert && elements.alert.length) {
      elements.alert.addClass('d-none').text('');
    }
    rootEl.dataset.appId = currentAppId || '';
    const type = (primaryGame.app_type || '').toUpperCase();
    const displayTitle = getDisplayTitle(primaryGame, { preferDlcName: true });
    if (elements.modalTitle && elements.modalTitle.length) {
      elements.modalTitle.text(displayTitle);
    }

    renderStatusBadges(primaryGame);

    setImageWithFallback(
      elements.banner,
      pickArtworkUrl(
        Overrides?.bannerUrlFor?.(primaryGame),
        primaryGame.banner_path,
        primaryGame.bannerUrl,
        primaryGame.banner,
      ),
      global.DEFAULT_BANNER,
    );
    setImageWithFallback(
      elements.icon,
      pickArtworkUrl(
        Overrides?.iconUrlFor?.(primaryGame),
        primaryGame.icon_path,
        primaryGame.iconUrl,
        primaryGame.icon,
      ),
      global.DEFAULT_ICON,
    );

    const hasOverride = Overrides?.hasActiveOverride?.(primaryGame) === true;

    const identifiersHtml = buildIdentifiers(primaryGame, { stacked: true }) || 'Identifiers unavailable';
    elements.identifiers.html(identifiersHtml);

    const redirectedGame = getRedirectedGame(primaryGame);
    const regionValue = resolveScalarField(primaryGame, redirectedGame, 'region');
    setMetaValue(metadataRows.region, elements.region, safeText(regionValue, ''));

    const releaseSource = resolveScalarField(primaryGame, redirectedGame, 'release_date')
      || primaryGame._orig?.release_date;
    const releaseText = formatDate(releaseSource);
    setMetaValue(metadataRows.release, elements.releaseDate, releaseText === '—' ? '' : releaseText);

    const playersValue = resolveScalarField(primaryGame, redirectedGame, 'numberOfPlayers')
      || resolveScalarField(primaryGame, redirectedGame, 'players');
    setMetaValue(metadataRows.players, elements.players, safeText(playersValue, ''));

    const developerValue = resolveScalarField(primaryGame, redirectedGame, 'developer');
    setMetaValue(metadataRows.developer, elements.developer, safeText(developerValue, ''));

    const publisherValue = resolveScalarField(primaryGame, redirectedGame, 'publisher');
    setMetaValue(metadataRows.publisher, elements.publisher, safeText(publisherValue, ''));
    const languageSourceGame = redirectedGame || primaryGame;
    const rawPrimaryLanguage = typeof LanguageUtils?.getPrimaryLanguage === 'function'
      ? LanguageUtils.getPrimaryLanguage(languageSourceGame)
      : (languageSourceGame.language || '');
    const primaryLanguage = (rawPrimaryLanguage || '').toString().trim();
    setMetaValue(metadataRows.language, elements.language, primaryLanguage || '');

    const languagesArray = Array.isArray(languageSourceGame.languages)
      ? languageSourceGame.languages
        .map((lang) => (lang ?? '').toString().trim())
        .filter((lang) => !!lang)
      : [];
    const orderedLanguages = [];
    const seenLanguages = new Set();
    const addLanguage = (lang) => {
      const trimmed = (lang || '').toString().trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seenLanguages.has(key)) return;
      seenLanguages.add(key);
      orderedLanguages.push(trimmed);
    };
    if (primaryLanguage) addLanguage(primaryLanguage);
    languagesArray.forEach(addLanguage);
    const languagesDisplay = orderedLanguages.length > 1 ? orderedLanguages.join(', ') : '';
    setMetaValue(metadataRows.languages, elements.languages, languagesDisplay);

    const sizeBytes = Number(resolveScalarField(primaryGame, redirectedGame, 'file_size'));
    const sizeDisplay = formatStorageSize(sizeBytes);
    setMetaValue(metadataRows.size, elements.size, sizeDisplay);

    const ratingParts = [];
    const ratingValue = resolveScalarField(primaryGame, redirectedGame, 'rating');
    if (ratingValue) ratingParts.push(ratingValue);
    const ratingContent = resolveArrayField(primaryGame, redirectedGame, 'ratingContent');
    if (Array.isArray(ratingContent) && ratingContent.length) {
      ratingParts.push(ratingContent.join(', '));
    }
    setMetaValue(metadataRows.rating, elements.rating, ratingParts.length ? ratingParts.join(' · ') : '');

    const introSource = resolveScalarField(primaryGame, redirectedGame, 'intro');
    const introText = typeof introSource === 'string' ? introSource.trim() : '';
    const suppressIntro = shouldMatchInfoLanguage && typeof LanguageUtils?.shouldSuppressInfoText === 'function'
      ? LanguageUtils.shouldSuppressInfoText(introText, {
        region: regionValue,
        language: primaryLanguage,
      })
      : false;
    if (introText && !suppressIntro) {
      elements.intro.text(introText).prop('hidden', false);
    } else {
      elements.intro.prop('hidden', true);
    }

    const rawDescription = resolveScalarField(primaryGame, redirectedGame, 'description');
    const description = (typeof rawDescription === 'string' && rawDescription.trim())
      ? rawDescription.trim()
      : (primaryGame._orig?.description || '').toString().trim();
    if (description) {
      elements.description.text(description);
    } else {
      elements.description.text('Description unavailable for this title.');
    }

    const resolvedCategories = resolveArrayField(primaryGame, redirectedGame, 'category');
    renderCategories(elements.categories, resolvedCategories.length ? resolvedCategories : primaryGame.category);

    const resolvedScreenshots = resolveArrayField(primaryGame, redirectedGame, 'screenshots');
    renderScreenshots(elements.screenshots, elements.screenshotsCard, resolvedScreenshots.length ? resolvedScreenshots : primaryGame.screenshots);

    const dlcGames = Array.isArray(relatedGames)
      ? relatedGames.filter((game) => (game.app_type || '').toUpperCase() === 'DLC')
      : [];
    const fullDlcList = collectFullGames();
    const fallbackDlcList = Array.isArray(fullDlcList)
      ? fullDlcList.filter((game) => (game.app_type || '').toUpperCase() === 'DLC')
      : [];
    const sidebarVisible = renderRelatedContent(
      elements.relatedContentList,
      elements.relatedContentCard,
      primaryGame,
      baseGame,
      dlcGames,
      currentAppId,
      fallbackDlcList
    );
    toggleDetailGridSidebar(sidebarVisible);

    if (elements.overrideButton && elements.overrideButton.length) {
      const button = elements.overrideButton;
      const buttonNode = button[0];
      if (isAdminUser && typeof Overrides?.openOverrideEditor === 'function') {
        const buttonStateClass = hasOverride ? 'btn-success' : 'btn-secondary';
        button
          .removeClass('d-none btn-success btn-secondary')
          .addClass(buttonStateClass)
          .attr('aria-label', hasOverride ? 'Override active. Click to edit.' : 'No override. Click to create one.')
          .off('click')
          .on('click', (event) => {
            event.preventDefault();
            Overrides.openOverrideEditor(primaryGame);
          });
        if (buttonNode) {
          const tooltipText = hasOverride
            ? 'Override active. Click to edit metadata.'
            : 'No override set. Click to create or edit.';
          applyTooltip(buttonNode, tooltipText);
        }
      } else {
        if (buttonNode) disposeHint(buttonNode);
        button.addClass('d-none').off('click');
      }
    }
  }

  function showError(message) {
    const text = typeof message === 'string' && message.trim()
      ? message.trim()
      : 'Unable to display this game.';
    if (elements.alert && elements.alert.length) {
      elements.alert.removeClass('d-none').text(text);
    }
    if (elements.modalTitle && elements.modalTitle.length) {
      elements.modalTitle.text('Game Detail');
    }
    if (elements.statusContainer && elements.statusContainer.length) {
      elements.statusContainer.empty();
    }
    if (elements.overrideButton && elements.overrideButton.length) {
      elements.overrideButton.addClass('d-none').off('click');
    }
    if (!isModalVisible) {
      modalInstance.show();
    }
  }

  async function ensureDataAvailable(targetAppId) {
    const normalizedTarget = normalizeAppId(targetAppId);
    if (!normalizedTarget) return null;

    setBaseKeyForAppId(normalizedTarget);

    const findPrimary = (games) => (Array.isArray(games)
      ? games.find((game) => normalizeAppId(game.app_id) === normalizedTarget)
      : null);

    let relatedGames = collectGames();
    let primaryGame = findPrimary(relatedGames) || dataManager.getGameByAppId(normalizedTarget);
    let baseGame = Array.isArray(relatedGames)
      ? relatedGames.find((game) => (game.app_type || '').toUpperCase() === 'BASE')
      : null;

    if (!primaryGame) {
      try {
        await dataManager.loadCombinedSnapshot();
      } catch (err) {
        console.warn('Ownfoil detail: failed to load snapshot', err);
      }
      setBaseKeyForAppId(normalizedTarget);
      relatedGames = collectGames();
      primaryGame = findPrimary(relatedGames) || dataManager.getGameByAppId(normalizedTarget);
      baseGame = Array.isArray(relatedGames)
        ? relatedGames.find((game) => (game.app_type || '').toUpperCase() === 'BASE')
        : null;
    }

    if (!primaryGame) {
      try {
        await dataManager.fetchAll();
      } catch (err) {
        console.error('Ownfoil detail: failed to fetch library data', err);
      }
      setBaseKeyForAppId(normalizedTarget);
      relatedGames = collectGames();
      primaryGame = findPrimary(relatedGames) || dataManager.getGameByAppId(normalizedTarget);
      baseGame = Array.isArray(relatedGames)
        ? relatedGames.find((game) => (game.app_type || '').toUpperCase() === 'BASE')
        : null;
    }

    if (!primaryGame) {
      showError('Unable to locate this game in the library.');
      return null;
    }

    if (!baseGame) baseGame = primaryGame;
    return { primaryGame, baseGame, relatedGames };
  }

  async function loadAndRender(targetAppId, requestToken) {
    const normalizedTarget = normalizeAppId(targetAppId || currentAppId);
    if (!normalizedTarget) {
      showError('Unable to locate this game in the library.');
      return null;
    }

    const data = await ensureDataAvailable(normalizedTarget);
    if (!data) return null;

    if (typeof requestToken === 'number' && requestToken !== latestRequestToken) {
      return null;
    }

    const { primaryGame, baseGame, relatedGames } = data;
    currentAppId = normalizedTarget;
    renderGameDetail(primaryGame, baseGame, relatedGames);
    return { primaryGame, baseGame, relatedGames };
  }

  async function openDetail(targetAppId, options = {}) {
    const normalizedTarget = normalizeAppId(targetAppId || currentAppId);
    if (!normalizedTarget) {
      showError('Unable to locate this game in the library.');
      return null;
    }

    const requestToken = ++latestRequestToken;
    const data = await loadAndRender(normalizedTarget, requestToken);
    if (!data) return null;

    if (!isModalVisible) {
      modalInstance.show();
    }

    if (historySupported) {
      const { primaryGame } = data;
      const href = primaryGame ? getDetailUrlForGame(primaryGame) : '';
      if (href && href !== '#' && !href.includes('undefined')) {
        const mode = options.historyMode || 'push';
        const state = { appId: normalizedTarget };
        try {
          if (mode === 'replace') {
            global.history.replaceState(state, '', href);
          } else if (mode === 'push') {
            global.history.pushState(state, '', href);
          }
        } catch (err) {
          console.warn('Ownfoil detail: history navigation failed', err);
        }
      }
    }

    return data;
  }

  function closeDetail({ updateHistory = true } = {}) {
    if (!isModalVisible) return;
    if (historySupported) {
      if (updateHistory) {
        try {
          suppressHistorySync = true;
          global.history.replaceState({ appId: null }, '', libraryUrl);
        } catch (err) {
          suppressHistorySync = false;
          console.warn('Ownfoil detail: failed to restore library URL', err);
        }
      } else {
        suppressHistorySync = true;
      }
    }
    modalInstance.hide();
  }

  if (historySupported) {
    global.addEventListener('popstate', (event) => {
      const appIdFromState = normalizeAppId(event.state?.appId || '');
      if (appIdFromState) {
        openDetail(appIdFromState, { historyMode: 'replace' }).catch((err) => {
          console.error('Ownfoil detail: popstate navigation failed', err);
        });
      } else {
        closeDetail({ updateHistory: false });
      }
    });
  }

  namespace.Detail = namespace.Detail || {};
  namespace.Detail.open = (appId, options) => openDetail(appId, options);
  namespace.Detail.close = (options) => closeDetail(options);
  namespace.Detail.getCurrentAppId = () => currentAppId;
  namespace.Detail.isVisible = () => isModalVisible;

  $(document).ready(async () => {
    if (Overrides?.bindEnvironment) {
      Overrides.bindEnvironment({
        getGames: () => state.games,
        applyFilters: () => {},
      });
    }
    if (Overrides?.initDomBindings) {
      Overrides.initDomBindings();
    }

    if (currentAppId) {
      await openDetail(currentAppId, { historyMode: 'replace' });
    }

    global.Ownfoil.onOverridesUpdated = async () => {
      try {
        await dataManager.refreshMetadataAfterOverrides();
        if (currentAppId && isModalVisible) {
          await loadAndRender(currentAppId);
        }
      } catch (err) {
        console.warn('Ownfoil detail: override refresh failed', err);
      }
    };
  });
})(window, window.jQuery);
