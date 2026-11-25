// Runs synchronously before first paint, from <head> (see index.html).
// Resolves the active theme preference and applies the last persisted resolved
// skin CSS custom properties + appearance attributes + browser chrome color
// (`meta[name="theme-color"]`) so the very first frame paints the exact active
// skin with zero default-paper flash. Plain script, no build step.
(function () {
  var root = document.documentElement;
  var dark = false;
  var paper = '';

  function validTheme(value) {
    return value === 'light' || value === 'dark' || value === 'system' ? value : null;
  }

  function resolveSpacePrefix() {
    try {
      var raw = window.__KIKI_ACTIVE_SPACE__;
      if (typeof raw === 'string') raw = JSON.parse(raw);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        var homeId = typeof raw.homeId === 'string' && raw.homeId !== '' ? raw.homeId : null;
        var isPrimary = raw.isPrimary === true || homeId === 'main';
        if (homeId && !isPrimary) {
          return { homeId: homeId, prefix: 'kiki.space.' + homeId + '.' };
        }
      }
    } catch {
      // Fall back to main space keys.
    }
    return { homeId: 'main', prefix: '' };
  }

  function readJson(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function resolveSpaceCachedTheme(homeId) {
    var cache = readJson('kiki.spacePreferences.cache');
    if (!cache) return null;
    var lastKnown = cache.lastKnown;
    if (!lastKnown || typeof lastKnown !== 'object' || lastKnown.homeId !== homeId) return null;
    var serverId = typeof lastKnown.serverId === 'string' ? lastKnown.serverId : '';
    if (!serverId) return null;
    var authorities = cache.authorities;
    if (!authorities || typeof authorities !== 'object' || authorities[serverId + '|' + homeId] !== true) {
      return null;
    }
    var values = lastKnown.values;
    return values && typeof values === 'object' ? validTheme(values.theme) : null;
  }

  var space = resolveSpacePrefix();
  var boot = readJson(space.prefix + 'kiki.skin.boot');

  try {
    var settings = readJson('kiki.settings');
    var pref =
      (boot && validTheme(boot.theme)) ||
      resolveSpaceCachedTheme(space.homeId) ||
      (settings && validTheme(settings.theme)) ||
      'system';
    dark =
      pref === 'dark' ||
      (pref === 'system' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    dark = false;
  }

  root.dataset.theme = dark ? 'dark' : 'light';

  if (boot) {
    var keyPattern = /^--(?:color|font|kiki|spacing)[a-z0-9-]*$/;
    var vars = dark ? boot.dark : boot.light;
    if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
      var keys = Object.keys(vars);
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        var val = vars[key];
        if (
          keyPattern.test(key) &&
          typeof val === 'string' &&
          val.length > 0 &&
          val.length <= 256 &&
          !/[;{}<>]/.test(val)
        ) {
          root.style.setProperty(key, val);
          if (key === '--color-paper') paper = val;
        }
      }
    }

    if (typeof boot.skinId === 'string' && /^[a-z0-9][a-z0-9_:-]{0,127}$/.test(boot.skinId)) {
      root.dataset.skin = boot.skinId;
    }
    if (boot.proseFace === 'sans' || boot.proseFace === 'serif') {
      root.dataset.kikiProse = boot.proseFace;
    }
    if (boot.motion === 'system' || boot.motion === 'full' || boot.motion === 'reduce') {
      root.dataset.kikiMotion = boot.motion;
    }
    if (boot.chatWidth === 'compact' || boot.chatWidth === 'standard' || boot.chatWidth === 'wide') {
      root.dataset.kikiChatWidth = boot.chatWidth;
    }
    if (typeof boot.proseFontSize === 'number' && isFinite(boot.proseFontSize) && boot.proseFontSize >= 10 && boot.proseFontSize <= 32) {
      root.style.setProperty('--kiki-prose-font-size', Math.round(boot.proseFontSize) + 'px');
    }
    if (typeof boot.codeFontSize === 'number' && isFinite(boot.codeFontSize) && boot.codeFontSize >= 10 && boot.codeFontSize <= 32) {
      root.style.setProperty('--kiki-code-font-size', Math.round(boot.codeFontSize) + 'px');
    }
  }

  var themeColor = paper || (dark ? '#1B2226' : '#fbfaf6');
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var m = 0; m < metas.length; m += 1) metas[m].setAttribute('content', themeColor);
})();
