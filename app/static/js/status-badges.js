'use strict';

((global) => {
  const namespace = global.Ownfoil = global.Ownfoil || {};
  const bootstrapNs = global.bootstrap || null;

  function attachTooltip(el, title, activateHints) {
    if (!el || !title) return;
    el.setAttribute('data-bs-toggle', 'tooltip');
    el.setAttribute('data-bs-placement', 'top');
    el.setAttribute('data-bs-title', title);
    if (activateHints && bootstrapNs?.Tooltip) {
      bootstrapNs.Tooltip.getOrCreateInstance(el);
    }
  }

  function attachPopover(el, { title, content, popoverClass, trigger = 'click', activateHints = false }) {
    if (!el || !content) return;
    el.setAttribute('data-bs-toggle', 'popover');
    el.setAttribute('data-bs-placement', 'top');
    el.setAttribute('data-bs-trigger', trigger);
    el.setAttribute('data-bs-title', title || '');
    el.setAttribute('data-bs-content', content);
    el.setAttribute('data-bs-html', 'true');
    if (popoverClass) {
      el.setAttribute('data-bs-custom-class', popoverClass);
    } else {
      el.removeAttribute('data-bs-custom-class');
    }
    if (activateHints && bootstrapNs?.Popover) {
      bootstrapNs.Popover.getOrCreateInstance(el);
    }
  }

  function buildNormalizedVersions(game) {
    const rawVersions = Array.isArray(game?.version)
      ? game.version.filter((entry) => entry && typeof entry === 'object')
      : [];
    if (!rawVersions.length) return [];

    const baseReleaseDate = (() => {
      const candidate = typeof game?.release_date === 'string' ? game.release_date.trim() : '';
      if (candidate && candidate.toLowerCase() !== 'unknown') return candidate;
      const orig = typeof game?._orig?.release_date === 'string' ? game._orig.release_date.trim() : '';
      return orig;
    })();

    return rawVersions.map((entry) => {
      const versionNumber = Number.isFinite(Number(entry.version)) ? Number(entry.version) : entry.version;
      const isBaseVersion = Number(versionNumber) === 0;
      const rawDate = typeof entry.release_date === 'string' ? entry.release_date.trim() : '';
      let displayDate = rawDate;
      if ((!displayDate || displayDate.toLowerCase() === 'unknown') && isBaseVersion && baseReleaseDate) {
        displayDate = baseReleaseDate;
      }
      if (!displayDate) {
        displayDate = isBaseVersion ? 'Base release' : 'Unknown';
      }
      return {
        versionNumber,
        owned: entry.owned === true,
        displayDate,
      };
    });
  }

  function createTypeBadge(game, options = {}) {
    const type = (game?.app_type || '').toUpperCase();
    if (!type) return null;
    const badge = document.createElement('span');
    badge.className = 'badge rounded-pill game-tag';
    const isOwned = game?.owned === true;
    const isMissing = game?.owned === false;
    if (isOwned) {
      badge.classList.add('text-bg-info');
    } else if (isMissing) {
      badge.classList.add('text-bg-warning', 'text-dark');
    } else {
      badge.classList.add('text-bg-secondary');
    }
    badge.textContent = type;
    const tooltipText = options.tooltip ?? (isOwned
      ? 'Owned in library'
      : (isMissing ? 'Not owned in library' : 'Ownership unknown'));
    badge.setAttribute('aria-label', `${type} · ${tooltipText}`);
    if (tooltipText) attachTooltip(badge, tooltipText, options.activateHints);
    return badge;
  }

  function createDlcBadge(game, options = {}) {
    if (typeof game?.has_all_dlcs !== 'boolean') return null;
    const hasAll = game.has_all_dlcs === true;
    const badge = document.createElement('span');
    badge.className = 'badge rounded-pill game-tag';
    badge.classList.add(hasAll ? 'text-bg-success' : 'text-bg-warning');
    if (!hasAll) badge.classList.add('text-dark');
    badge.innerHTML = '<i class="bi bi-box-seam-fill"></i>';
    const message = hasAll ? 'All DLC owned' : 'Missing DLC content';
    badge.setAttribute('aria-label', message);
    attachTooltip(badge, message, options.activateHints);
    return badge;
  }

  function createVersionBadge(game, options = {}) {
    if (typeof game?.has_latest_version !== 'boolean') return null;
    const upToDate = game.has_latest_version === true;
    const badge = document.createElement('span');
    badge.className = 'badge rounded-pill game-tag version-tag';
    badge.classList.add(upToDate ? 'text-bg-success' : 'text-bg-warning');
    if (!upToDate) badge.classList.add('text-dark');
    const icon = document.createElement('i');
    icon.className = `bi ${upToDate ? 'bi-check-circle-fill' : 'bi-arrow-down-circle'}`;
    badge.appendChild(icon);
    const statusText = upToDate ? 'Latest update installed' : 'Update available';
    badge.setAttribute('aria-label', statusText);

    const normalizedVersions = buildNormalizedVersions(game);
    if (normalizedVersions.length) {
      const versionTitle = `${game?.name || 'Title'} Updates`;
      const popoverContent = normalizedVersions
        .map((entry) => `${entry.displayDate}: v${entry.versionNumber} ${entry.owned ? 'Owned' : 'Missing'}`)
        .join('<br>');
      attachPopover(badge, {
        title: versionTitle,
        content: popoverContent,
        popoverClass: options.popoverClass,
        trigger: options.popoverTrigger || 'click',
        activateHints: options.activateHints,
      });
    } else {
      const fallbackTitle = typeof game?.version !== 'undefined'
        ? `Version v${game.version}`
        : statusText;
      attachTooltip(badge, fallbackTitle, options.activateHints);
    }
    return badge;
  }

  namespace.StatusBadges = {
    createTypeBadge,
    createDlcBadge,
    createVersionBadge,
  };
})(typeof window !== 'undefined' ? window : globalThis);
