'use strict';

((global) => {
  const namespace = global.Ownfoil = global.Ownfoil || {};

  const latinCharRegex = /[A-Za-z\u00C0-\u024F]/;
  let letterCharRegex = null;
  try {
    letterCharRegex = new RegExp('\\p{L}', 'u');
  } catch (err) {
    letterCharRegex = null;
  }

  const LATIN_LANGUAGE_HINTS = new Set([
    'en', 'en-us', 'en-gb', 'english',
    'es', 'es-es', 'es-mx', 'spanish',
    'fr', 'fr-fr', 'french',
    'de', 'de-de', 'german',
    'it', 'it-it', 'italian',
    'pt', 'pt-br', 'pt-pt', 'portuguese',
    'nl', 'dutch',
    'sv', 'swedish',
    'da', 'danish',
    'no', 'nb', 'nn', 'norwegian',
    'fi', 'finnish',
    'pl', 'polish',
    'cs', 'czech',
    'sk', 'slovak',
    'hu', 'hungarian',
    'ro', 'romanian',
    'tr', 'turkish',
    'vi', 'vietnamese',
    'id', 'indonesian',
    'ms', 'malay',
  ]);

  const NON_LATIN_LANGUAGE_HINTS = new Set([
    'ja', 'japanese',
    'zh', 'zh-cn', 'zh-tw', 'chinese',
    'ko', 'korean',
    'ru', 'russian',
    'uk', 'ukrainian',
    'bg', 'bulgarian',
    'el', 'greek',
    'th', 'thai',
    'ar', 'arabic',
    'he', 'hebrew',
    'fa', 'persian',
    'hi', 'hindi',
    'bn', 'bengali',
    'ta', 'tamil',
    'te', 'telugu',
    'kn', 'kannada',
    'ml', 'malayalam',
    'si', 'sinhala',
    'ka', 'georgian',
    'kk', 'kazakh',
    'sr', 'serbian',
    'mk', 'macedonian',
  ]);

  const NON_LATIN_REGION_HINTS = new Set([
    'JP', 'JPN', 'JAPAN',
    'CN', 'CHN', 'CHINA',
    'HK', 'HKG', 'HONG KONG',
    'TW', 'TWN', 'TAIWAN',
    'KR', 'KOR', 'KOREA', 'SOUTH KOREA',
    'RU', 'RUS', 'RUSSIA',
    'UA', 'UKR', 'UKRAINE',
    'BG', 'BGR', 'BULGARIA',
    'GR', 'GRC', 'GREECE',
    'TH', 'THA', 'THAILAND',
    'IL', 'ISR', 'ISRAEL',
    'SA', 'SAU', 'SAUDI ARABIA',
  ]);

  function isLetterChar(char) {
    if (letterCharRegex) return letterCharRegex.test(char);
    return /[A-Za-z]/.test(char);
  }

  function isLatinChar(char) {
    return latinCharRegex.test(char);
  }

  function analyzeScriptContent(text) {
    const stats = {
      totalLetters: 0,
      latinLetters: 0,
      latinRatio: 1,
    };
    if (!text) return stats;
    for (const char of text) {
      if (!isLetterChar(char)) continue;
      stats.totalLetters += 1;
      if (isLatinChar(char)) stats.latinLetters += 1;
    }
    stats.latinRatio = stats.totalLetters > 0 ? stats.latinLetters / stats.totalLetters : 1;
    return stats;
  }

  function inferScriptFromLanguage(language) {
    if (!language || typeof language !== 'string') return null;
    const normalized = language.trim().toLowerCase();
    if (!normalized) return null;
    if (LATIN_LANGUAGE_HINTS.has(normalized)) return 'latin';
    if (NON_LATIN_LANGUAGE_HINTS.has(normalized)) return 'nonlatin';
    const short = normalized.slice(0, 2);
    if (LATIN_LANGUAGE_HINTS.has(short)) return 'latin';
    if (NON_LATIN_LANGUAGE_HINTS.has(short)) return 'nonlatin';
    return null;
  }

  function inferScriptFromRegion(region) {
    if (!region || typeof region !== 'string') return null;
    const normalized = region.trim().toUpperCase();
    if (!normalized) return null;
    if (NON_LATIN_REGION_HINTS.has(normalized)) return 'nonlatin';
    if (/^[A-Z]{2,3}$/.test(normalized)) return 'latin';
    return null;
  }

  function getPrimaryLanguage(game) {
    if (!game || typeof game !== 'object') return '';
    const direct = typeof game.language === 'string' ? game.language.trim() : '';
    if (direct) return direct;
    const fallback = typeof game._orig?.language === 'string' ? game._orig.language.trim() : '';
    if (fallback) return fallback;
    if (Array.isArray(game.languages) && game.languages.length) {
      const firstLang = game.languages.find((lang) => typeof lang === 'string' && lang.trim());
      return firstLang ? firstLang.trim() : '';
    }
    return '';
  }

  function formatLanguagesDisplay(game) {
    if (!game || typeof game !== 'object') return '';
    const languages = Array.isArray(game.languages)
      ? game.languages
        .map((lang) => (typeof lang === 'string' ? lang.trim() : ''))
        .filter((lang) => !!lang)
      : [];
    const uniqueLanguages = languages.length ? Array.from(new Set(languages)) : [];
    return uniqueLanguages.length ? uniqueLanguages.join(', ') : '';
  }

  function shouldSuppressInfoText(text, context = {}) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) return false;
    const { region, language } = context;
    const normalizedLanguage = typeof language === 'string' ? language.trim() : '';
    const normalizedRegion = typeof region === 'string' ? region.trim() : '';
    if (!normalizedLanguage && !normalizedRegion) return false;
    const expectedScript = inferScriptFromLanguage(normalizedLanguage)
      || inferScriptFromRegion(normalizedRegion);
    if (expectedScript !== 'latin') return false;
    const stats = analyzeScriptContent(value);
    if (stats.totalLetters === 0) return false;
    if (stats.latinRatio >= 0.6) return false;
    return true;
  }

  namespace.LanguageUtils = {
    getPrimaryLanguage,
    formatLanguagesDisplay,
    shouldSuppressInfoText,
    _analyzeScriptContent: analyzeScriptContent,
    _inferScriptFromLanguage: inferScriptFromLanguage,
    _inferScriptFromRegion: inferScriptFromRegion,
  };
})(typeof window !== 'undefined' ? window : globalThis);
