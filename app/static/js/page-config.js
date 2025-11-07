'use strict';

((global) => {
  const namespace = global.Ownfoil = global.Ownfoil || {};
  const ConfigNs = namespace.Config = namespace.Config || {};

  const toStringOrNull = (value) => {
    if (value == null) return null;
    const str = value.toString();
    return str.length ? str : null;
  };

  const coerceBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (value == null) return null;
    if (typeof value === 'number') return !Number.isNaN(value) && value !== 0;
    const lowered = value.toString().trim().toLowerCase();
    if (!lowered) return null;
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
    return null;
  };

  const buildPlaceholderUrl = (dimensions, placeholderText) => {
    const text = placeholderText ?? ConfigNs.placeholderText ?? global.PLACEHOLDER_TEXT ?? 'Image Unavailable';
    const encoded = encodeURIComponent(text);
    return `https://placehold.co/${dimensions}/png?text=${encoded}`;
  };

  const assignGlobal = (key, value) => {
    if (value === undefined || value === null) return;
    global[key] = value;
  };

  const applyValues = (values = {}) => {
    const placeholder = toStringOrNull(values.placeholderText);
    if (placeholder) {
      ConfigNs.placeholderText = placeholder;
      assignGlobal('PLACEHOLDER_TEXT', placeholder);
    }

    let defaultBanner = toStringOrNull(values.defaultBanner);
    if (!defaultBanner && placeholder) {
      defaultBanner = buildPlaceholderUrl('400x225', placeholder);
    }
    if (defaultBanner) {
      ConfigNs.defaultBanner = defaultBanner;
      assignGlobal('DEFAULT_BANNER', defaultBanner);
    }

    let defaultIcon = toStringOrNull(values.defaultIcon);
    if (!defaultIcon && (placeholder || ConfigNs.placeholderText)) {
      const bannerPlaceholder = placeholder || ConfigNs.placeholderText;
      defaultIcon = buildPlaceholderUrl('400x400', bannerPlaceholder);
    }
    if (defaultIcon) {
      ConfigNs.defaultIcon = defaultIcon;
      assignGlobal('DEFAULT_ICON', defaultIcon);
    }

    const detailBasePath = toStringOrNull(values.detailBasePath);
    if (detailBasePath) {
      ConfigNs.detailBasePath = detailBasePath;
      assignGlobal('DETAIL_BASE_PATH', detailBasePath);
    }

    const adminFlag = coerceBoolean(values.isAdmin);
    if (adminFlag !== null) {
      ConfigNs.isAdmin = adminFlag;
      assignGlobal('IS_ADMIN', adminFlag);
    }

    const hideGhostFlag = coerceBoolean(values.hideGhostCards);
    if (hideGhostFlag !== null) {
      ConfigNs.hideGhostCards = hideGhostFlag;
      assignGlobal('HIDE_GHOST_CARDS', hideGhostFlag);
    }

    return {
      placeholderText: ConfigNs.placeholderText,
      defaultBanner: ConfigNs.defaultBanner,
      defaultIcon: ConfigNs.defaultIcon,
      detailBasePath: ConfigNs.detailBasePath,
      isAdmin: ConfigNs.isAdmin,
      hideGhostCards: ConfigNs.hideGhostCards,
    };
  };

  ConfigNs.applyFromElement = (element, fallback = {}) => {
    if (!element) return applyValues(fallback);
    const dataset = element.dataset || {};
    const values = {
      placeholderText: dataset.placeholderText ?? fallback.placeholderText,
      defaultBanner: dataset.defaultBanner ?? fallback.defaultBanner,
      defaultIcon: dataset.defaultIcon ?? fallback.defaultIcon,
      detailBasePath: dataset.detailBasePath ?? fallback.detailBasePath,
      isAdmin: dataset.isAdmin ?? fallback.isAdmin,
      hideGhostCards: dataset.hideGhostCards ?? fallback.hideGhostCards,
    };
    return applyValues(values);
  };

  ConfigNs.apply = (values) => applyValues(values);

  ConfigNs.get = (key, fallback = null) => {
    if (Object.prototype.hasOwnProperty.call(ConfigNs, key) && ConfigNs[key] !== undefined) {
      return ConfigNs[key];
    }
    return fallback;
  };
})(window);
