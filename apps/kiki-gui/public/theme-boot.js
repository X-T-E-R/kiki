// Runs before first paint, from <head> (see index.html). Resolves the stored
// theme preference so the first frame already has the right palette and the
// browser chrome (theme-color) the right paper. Plain script, no build step:
// it must run before any module does. The two colours are the base
// --color-paper values in src/index.css.
(function () {
  var dark = false;
  try {
    var stored = JSON.parse(localStorage.getItem('kiki.settings') || '{}');
    var pref = stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system';
    dark =
      pref === 'dark' ||
      (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    dark = false;
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', dark ? '#1B2226' : '#fbfaf6');
})();
