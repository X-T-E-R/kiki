/**
 * Visual proof for backgrounds and appearance packs.
 *
 *   node scripts/visual-proof-appearance.mjs [--only=surfaces,matrix,scopes,pack,video,settings,onboarding]
 *
 * Boots the fixture server (scenario `appearance-bg`) and its own vite, then
 * drives the real GUI: no background, a picture at three strengths, the
 * example pack (light picture, dark video), the settings page, the pack list,
 * the onboarding welcome page's appearance rows, and a loud 4K picture and a short video
 * generated for the proof (fixtures/appearance-media). Light and dark, 1440
 * and 390, locale from KIKI_PROOF_LOCALE (en default). Screenshots land in
 * .tmp/appearance2/ (gitignored).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.KIKI_PROOF_OUTPUT_DIR ?? join(ROOT, '.tmp', 'appearance2');
const MEDIA = join(ROOT, 'fixtures', 'appearance-media');
const EXAMPLE = join(ROOT, '..', '..', 'docs', 'examples', 'appearance-packs', 'dusk-harbor');
const LOCALE = process.env.KIKI_PROOF_LOCALE === 'zh' ? 'zh' : 'en';
const ONLY = (process.argv.find((arg) => arg.startsWith('--only='))?.slice(7).split(',')) ?? null;
const wanted = (name) => ONLY === null || ONLY.includes(name);
mkdirSync(OUT, { recursive: true });

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(() => resolve()); });
  return port;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server never came up: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const fixturePort = await freePort();
const webPort = await freePort();
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const fixture = await startFixtureServer({ port: fixturePort, scenario: 'appearance-bg' });
// A shared worktree can change during the walk; HMR must not navigate a page
// in the middle of an IndexedDB write or geometry assertion.
const vite = await createViteServer({ root: ROOT, server: { host: '127.0.0.1', port: webPort, strictPort: true, hmr: false } });
await vite.listen();
const cleanup = async () => {
  await vite.close();
  await fixture.stop();
};

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`[check] ${message}`);
  else { failures.push(message); console.error(`[FAIL] ${message}`); }
};
/** Put a file into the app's media store and point the background prefs at it. */
async function setLocalBackground(page, file, mime, look = {}) {
  const bytes = [...readFileSync(file)];
  await page.evaluate(async ({ bytes, mime, look, name }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kiki-appearance', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('media'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const id = `local-proof-${Date.now().toString(36)}`;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      tx.objectStore('media').put(blob, id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const kind = mime.startsWith('video/') ? 'video' : 'image';
    localStorage.setItem('kiki.background', JSON.stringify({
      light: { media: [{ id, kind, mime, name, bytes: blob.size }], interval: 0, look },
      dark: null,
      linked: true,
    }));
  }, { bytes, mime, look, name: file.split(/[\\/]/).at(-1) });
}

async function clearBackground(page) {
  await page.evaluate(() => { localStorage.removeItem('kiki.background'); });
}

async function setTheme(page, theme) {
  await page.evaluate((value) => {
    const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
    localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, theme: value }));
  }, theme);
}

const deep = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;

async function open(page, path, ready) {
  try {
    await page.goto(deep(path), { waitUntil: 'domcontentloaded', timeout: 180_000 });
  } catch (error) {
    // Vite's first dependency optimization reloads the page once; go again.
    if (!/interrupted by another navigation/.test(String(error))) throw error;
    await page.waitForLoadState('domcontentloaded');
    await page.goto(deep(path), { waitUntil: 'domcontentloaded', timeout: 180_000 });
  }
  await page.waitForSelector(ready, { timeout: 60_000 });
  await page.waitForTimeout(700);
}

async function shot(page, name) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)));
  }).catch(() => undefined);
  const file = join(OUT, `${name}-${LOCALE}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

/**
 * The faintest text's contrast as rendered, measured from pixels: for each
 * probe element, compare its text colour with the darkest and lightest
 * surface pixels behind it (read from a screenshot with the text hidden).
 */
async function renderedContrast(page, selectors) {
  // The first match wholly on screen and not under another layer: a virtualized
  // timeline keeps rows above the fold that the header would cover.
  const boxes = await page.evaluate((list) => list.map((selector) => {
    const element = [...document.querySelectorAll(selector)].find((node) => {
      const r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return false;
      const hit = document.elementFromPoint(r.left + Math.min(r.width, 20) / 2, r.top + r.height / 2);
      return hit !== null && (node === hit || node.contains(hit));
    });
    if (element === undefined) return null;
    const rect = element.getBoundingClientRect();
    return { selector, x: rect.x, y: rect.y, w: rect.width, h: rect.height, color: getComputedStyle(element).color };
  }).filter(Boolean), selectors);
  await page.addStyleTag({ content: '*, *::placeholder { color: transparent !important; caret-color: transparent !important; } svg, img:not([data-kiki-backdrop-item]) { visibility: hidden !important; }' });
  const results = [];
  const viewport = page.viewportSize();
  for (const box of boxes) {
    // Only what is on screen is read; an off-screen probe has nothing behind it to measure.
    const x = Math.max(0, box.x); const y = Math.max(0, box.y);
    const w = Math.min(box.w, 400, viewport.width - x); const h = Math.min(box.h, viewport.height - y);
    if (w < 4 || h < 4) continue;
    const png = await page.screenshot({ clip: { x, y, width: w, height: h } });
    results.push({ ...box, png: png.toString('base64') });
  }
  await page.evaluate(() => { document.querySelectorAll('style').forEach((node) => { if (node.textContent?.includes('color: transparent !important')) node.remove(); }); });
  return page.evaluate(async (entries) => {
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const out = [];
    for (const entry of entries) {
      const image = new Image();
      image.src = `data:image/png;base64,${entry.png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let lo = 1; let hi = 0;
      for (let index = 0; index < data.length; index += 4) {
        const l = lum([data[index], data[index + 1], data[index + 2]]);
        lo = Math.min(lo, l); hi = Math.max(hi, l);
      }
      const text = lum(entry.color.match(/\d+/g).slice(0, 3).map(Number));
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      out.push({ selector: entry.selector, worst: Number(Math.min(ratio(text, lo), ratio(text, hi)).toFixed(2)) });
    }
    return out;
  }, results);
}
const SESSION = '/s/session_fixture_long';
const TIMELINE = '[role="log"]';
/** Faint text on each reading surface: sidebar timestamps, the timeline, the composer. */
const PROBES = ['.app-sidebar [class*="text-ink-faint"]', '[role="log"] .kiki-prose p', '[data-composer]'];

async function scenarioSurfaces(page) {
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await clearBackground(page);
      await open(page, SESSION, TIMELINE);
      check(await page.evaluate(() => document.documentElement.dataset.kikiBg === undefined && document.querySelector('[data-kiki-backdrop]') === null),
        `${theme} ${width}: no background leaves no layer and no attribute`);
      await shot(page, `bg-none-${theme}-${width}`);
      for (const opacity of [0.35, 0.7, 1]) {
        await setLocalBackground(page, join(EXAMPLE, theme === 'dark' ? 'lantern.webp' : 'tide.webp'), 'image/webp', { opacity });
        await open(page, SESSION, '[data-kiki-backdrop-item]');
        await shot(page, `bg-image-${Math.round(opacity * 100)}-${theme}-${width}`);
        const vars = await layerVars(page);
        console.log(`[info] ${theme} ${width} strength ${opacity}: canvas ${vars.canvas}% text surfaces ${vars.solid}%`);
        if (width === 1440) {
          const contrast = await renderedContrast(page, PROBES);
          for (const item of contrast) check(item.worst >= 4.5, `${theme} opacity ${opacity}: ${item.selector} rendered contrast ${item.worst} ≥ 4.5`);
        }
      }
    }
  }
  // A full-strength picture with a see-through request: the canvas keeps the
  // request, and only the text layer is raised to hold contrast.
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, 'light');
  await setLocalBackground(page, join(MEDIA, 'loud-4k.jpg'), 'image/jpeg', { opacity: 1, scrim: 0, surfaceOpacity: 0.3, surfaceBlur: 6 });
  await open(page, SESSION, '[data-kiki-backdrop-item]');
  const vars = await layerVars(page);
  check(vars.canvas === 30, `a 30% panel request keeps the canvas at 30% (applied ${vars.canvas}%)`);
  check(vars.solid > 30, `the text layer is raised over a full-strength picture (text surfaces at ${vars.solid}%)`);
  await shot(page, 'bg-floor-raised-light-1440');
  for (const item of await renderedContrast(page, PROBES)) check(item.worst >= 4.5, `floor: ${item.selector} rendered contrast ${item.worst} ≥ 4.5`);
}

/**
 * Painted text-layer blocks in the sidebar, top to bottom: elements whose
 * own background is not transparent, merged when they touch (one block may
 * be several elements, like the sessions header + list).
 */
async function sidebarBlocks(page) {
  return page.evaluate(() => {
    const side = document.querySelector('.app-sidebar');
    const origin = side.getBoundingClientRect();
    const painted = [...side.querySelectorAll('*')].filter((el) => {
      if (getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)') return false;
      // Rows inside a block are not blocks; the "New session" chip is.
      if (el.closest('[data-session-row], .sticky, [data-connection-status], [data-nav-settings]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 20 && r.bottom < innerHeight;
    }).map((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left - origin.left), right: Math.round(origin.right - r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
    painted.sort((a, b) => a.top - b.top);
    const merged = [];
    for (const box of painted) {
      const last = merged.at(-1);
      if (last !== undefined && box.top <= last.bottom + 1) { last.bottom = Math.max(last.bottom, box.bottom); }
      else merged.push({ ...box });
    }
    return merged;
  });
}

/** The canvas and text-layer opacities backdrop.ts wrote, as numbers. */
async function layerVars(page) {
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--kiki-surface-alpha').trim() !== '', null, { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const read = (name) => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
    return { canvas: read('--kiki-surface-alpha'), band: read('--kiki-text-alpha'), solid: read('--kiki-solid-alpha') };
  });
}

/**
 * Three pictures (the loud gradient, an anime-like saturated scene, a large
 * bright sky) behind the session, the settings page and the sidebar scope,
 * light and dark, at default dials: the picture must show, the text must
 * hold 4.5:1. Also shows the assist switched off on the vivid picture.
 */
const MATRIX_PICTURES = ['loud-4k.jpg', 'vivid-anime.jpg', 'bright-sky.jpg'];
const SETTINGS_PROBES = ['[data-settings-intro]', '#st-card-appearance-background [data-bg-current]', '[data-settings-nav-group] > p', '[data-settings-page-title]'];
async function scenarioMatrix(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    for (const picture of MATRIX_PICTURES) {
      const name = picture.replace(/\.jpg$/, '');
      await setLocalBackground(page, join(MEDIA, picture), 'image/jpeg', {});
      await open(page, SESSION, '[data-kiki-backdrop-item]');
      const vars = await layerVars(page);
      console.log(`[info] ${theme} ${name}: canvas ${vars.canvas}% text surfaces ${vars.solid}%`);
      await shot(page, `matrix-session-${name}-${theme}-1440`);
      for (const item of await renderedContrast(page, PROBES)) check(item.worst >= 4.5, `${theme} ${name} session: ${item.selector} ${item.worst} ≥ 4.5`);
      await open(page, '/settings/appearance', '[data-bg-thumb] img');
      await page.locator('#st-card-appearance-background').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(page, `matrix-settings-${name}-${theme}-1440`);
      for (const item of await renderedContrast(page, SETTINGS_PROBES)) check(item.worst >= 4.5, `${theme} ${name} settings: ${item.selector} ${item.worst} ≥ 4.5`);
      await setLocalBackground(page, join(MEDIA, picture), 'image/jpeg', { scope: 'sidebar' });
      await open(page, SESSION, '[data-kiki-backdrop-item]');
      await shot(page, `matrix-sidebar-${name}-${theme}-1440`);
      for (const item of await renderedContrast(page, PROBES.slice(0, 1))) check(item.worst >= 4.5, `${theme} ${name} sidebar: ${item.selector} ${item.worst} ≥ 4.5`);
    }
    // Sidebar text-layer blocks share one column and one gap.
    await setLocalBackground(page, join(MEDIA, 'vivid-anime.jpg'), 'image/jpeg', {});
    await open(page, SESSION, '[data-kiki-backdrop-item]');
    const blocks = await sidebarBlocks(page);
    console.log(`[info] ${theme} sidebar blocks ${JSON.stringify(blocks)}`);
    const lefts = new Set(blocks.map((b) => b.left)); const rights = new Set(blocks.map((b) => b.right));
    check(lefts.size === 1 && rights.size === 1, `${theme} sidebar blocks share one left/right edge (${[...lefts]} / ${[...rights]})`);
    // Gaps between the top blocks; the footer sits at the window bottom.
    check(blocks.length >= 5, `${theme} sidebar has wordmark, chip, nav, sessions and footer blocks (${blocks.length})`);
    const gaps = blocks.slice(1, -1).map((b, i) => b.top - blocks[i].bottom);
    check(gaps.every((g) => g === gaps[0]), `${theme} sidebar block gaps are equal (${gaps.join(', ')})`);
    // The previous single-layer model, emulated for a before/after: the whole
    // canvas at the text floor this picture needs, no separate text layer.
    await setLocalBackground(page, join(MEDIA, 'vivid-anime.jpg'), 'image/jpeg', {});
    await open(page, SESSION, '[data-kiki-backdrop-item]');
    const floor = (await layerVars(page)).solid;
    await setLocalBackground(page, join(MEDIA, 'vivid-anime.jpg'), 'image/jpeg', { surfaceOpacity: floor / 100 });
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem('kiki.background'));
      localStorage.setItem('kiki.background', JSON.stringify({ ...prefs, assist: false }));
    });
    await open(page, SESSION, '[data-kiki-backdrop-item]');
    await shot(page, `matrix-session-vivid-anime-old-model-${theme}-1440`);
    // Assist off: exactly the requested numbers, and the settings page says so.
    await setLocalBackground(page, join(MEDIA, 'vivid-anime.jpg'), 'image/jpeg', {});
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem('kiki.background'));
      localStorage.setItem('kiki.background', JSON.stringify({ ...prefs, assist: false }));
    });
    await open(page, SESSION, '[data-kiki-backdrop-item]');
    const off = await layerVars(page);
    check(off.band === 0 && off.solid === off.canvas, `${theme} assist off: no text layer (canvas ${off.canvas}%, text ${off.solid}%)`);
    await shot(page, `matrix-session-assist-off-${theme}-1440`);
    await open(page, '/settings/appearance', '[data-bg-assist]');
    await page.locator('[data-bg-assist]').scrollIntoViewIfNeeded();
    check(/hard to read/i.test(await page.locator('[data-bg-assist]').innerText()), `${theme} assist off: the settings row warns`);
    await shot(page, `matrix-settings-assist-off-${theme}-1440`);
    // No background: the plain sidebar is exactly the base theme.
    await clearBackground(page);
    await open(page, SESSION, TIMELINE);
    await shot(page, `matrix-session-none-${theme}-1440`);
  }
  // Phone: the sidebar is a solid drawer; the blocks must not change it.
  await setTheme(page, 'dark');
  await setLocalBackground(page, join(MEDIA, 'vivid-anime.jpg'), 'image/jpeg', {});
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, SESSION, '[data-kiki-backdrop-item]');
  await page.getByRole('button', { name: 'Open session menu' }).first().click().catch(() => undefined);
  await page.waitForTimeout(400);
  await shot(page, 'matrix-sidebar-drawer-dark-390');
  await page.setViewportSize({ width: 1440, height: 900 });
  await clearBackground(page);
}

async function scenarioScopes(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, 'dark');
  for (const scope of ['main', 'sidebar']) {
    await setLocalBackground(page, join(EXAMPLE, 'lantern.webp'), 'image/webp', { scope, opacity: 0.9 });
    await open(page, SESSION, '[data-kiki-backdrop-item]');
    await shot(page, `bg-scope-${scope}-dark-1440`);
  }
}
async function scenarioPack(page) {
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await clearBackground(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await open(page, '/settings/appearance', '#st-card-appearance-packs');
      await page.locator('#st-card-appearance-packs').scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-pack="dusk-harbor"] [data-pack-preview] img', { timeout: 15_000 });
      await shot(page, `pack-list-${theme}-${width}`);
      if (width === 1440 && theme === 'light') {
        await page.click('[data-pack-use="dusk-harbor"]');
        await page.waitForSelector('[data-kiki-backdrop-item]', { timeout: 15_000 });
        check(await page.evaluate(() => document.documentElement.dataset.skin === 'dusk-harbor'), 'Use pack selects the pack colors');
        await page.locator('#st-card-appearance-packs').scrollIntoViewIfNeeded();
        await shot(page, 'pack-in-use-light-1440');
        await page.click('[data-pack-delete="dusk-harbor"]');
        await page.waitForSelector('[role="dialog"], [role="alertdialog"]', { timeout: 5000 });
        await shot(page, 'pack-delete-confirm-light-1440');
        await page.keyboard.press('Escape');
      }
    }
    // The pack applied, seen over the conversation.
    await page.setViewportSize({ width: 1440, height: 900 });
    // Apply it the way a person does, so colors and media arrive together.
    await page.evaluate(() => { localStorage.removeItem('kiki.skin'); localStorage.removeItem('kiki.background'); });
    await open(page, '/settings/appearance', '[data-pack-use="dusk-harbor"]:not([disabled])');
    await page.click('[data-pack-use="dusk-harbor"]');
    await page.waitForSelector('[data-kiki-backdrop-item]', { timeout: 15_000 });
    await open(page, SESSION, '[data-kiki-backdrop-item]');
    if (theme === 'dark') {
      await page.waitForFunction(() => {
        const video = document.querySelector('video[data-kiki-backdrop-item]');
        return video !== null && video.readyState >= 2;
      }, null, { timeout: 20_000 });
      const video = await page.evaluate(() => {
        const element = document.querySelector('video[data-kiki-backdrop-item]');
        return { muted: element.muted, loop: element.loop, paused: element.paused, poster: element.poster !== '' };
      });
      check(video.muted && video.loop && video.poster, `pack video is muted, looped, with a poster (${JSON.stringify(video)})`);
    }
    await shot(page, `pack-applied-${theme}-1440`);
    for (const item of await renderedContrast(page, PROBES)) check(item.worst >= 4.5, `pack ${theme}: ${item.selector} rendered contrast ${item.worst} ≥ 4.5`);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, SESSION, '[data-kiki-backdrop-item]');
    await shot(page, `pack-applied-${theme}-390`);
    await page.evaluate(() => { localStorage.removeItem('kiki.skin'); localStorage.removeItem('kiki.background'); });
  }
}

async function scenarioVideoPolicy(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, 'dark');
  await setLocalBackground(page, join(MEDIA, 'drift-720.mp4'), 'video/mp4', { opacity: 1 });
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
    localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, motion: 'reduce' }));
  });
  await open(page, '/settings/appearance', '[data-bg-settings="full"]');
  await page.waitForFunction(() => document.querySelector('video[data-kiki-backdrop-item]')?.readyState >= 2, null, { timeout: 20_000 });
  const paused = await page.evaluate(() => document.querySelector('video[data-kiki-backdrop-item]').paused);
  check(paused, 'reduced motion rests the video on its first frame');
  await page.waitForSelector('text=paused on its first frame', { timeout: 5000 }).catch(() => undefined);
  await page.locator('#st-card-appearance-background').scrollIntoViewIfNeeded();
  await shot(page, 'bg-video-reduced-motion-dark-1440');
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
    localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, motion: 'system' }));
  });
}

async function scenarioSettingsPage(page) {
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await clearBackground(page);
      await open(page, '/settings/appearance', '#st-card-appearance-background');
      await page.locator('#st-card-appearance-background').scrollIntoViewIfNeeded();
      await shot(page, `settings-bg-empty-${theme}-${width}`);
      await setLocalBackground(page, join(EXAMPLE, theme === 'dark' ? 'lantern.webp' : 'tide.webp'), 'image/webp', {});
      await open(page, '/settings/appearance', '[data-bg-thumb] img');
      await page.locator('#st-card-appearance-background').scrollIntoViewIfNeeded();
      await page.locator('[data-bg-more] summary').click();
      await page.waitForTimeout(200);
      await shot(page, `settings-bg-set-${theme}-${width}`);
      if (width === 1440) {
        await page.locator('#st-card-appearance').scrollIntoViewIfNeeded();
        await shot(page, `settings-skin-picker-${theme}-1440`);
      }
    }
  }
  // Keyboard: the anchor grid is one radio group moved with arrows.
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/settings/appearance', '[data-bg-thumb] img');
  await page.locator('[data-bg-more] summary').click();
  await page.locator('[data-bg-alignment-choice="center"]').focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('kiki.background') ?? '{}').light?.look?.alignment !== undefined, null, { timeout: 3000 }).catch(() => undefined);
  const anchor = await page.evaluate(() => JSON.parse(localStorage.getItem('kiki.background')).light.look.alignment);
  check(anchor === 'top', `arrow keys move the anchor (now ${anchor})`);
  await shot(page, 'settings-bg-focus-dark-1440');
  const plugin = await page.locator('[data-skin-choice="kiki-office:sea-glass"]').innerText().catch(() => '');
  check(/kiki-office/.test(plugin), `plugin skin listed with its origin ("${plugin.replace(/\s+/g, ' ')}")`);
}

/**
 * The onboarding welcome page's appearance rows, replayed from Settings › About: pick
 * dark, a palette, add a picture and lower its strength — each choice must
 * land in the real settings (no preview-only state) — then move on.
 */
async function scenarioOnboarding(page) {
  const wizard = page.locator('[role="dialog"]');
  const stepOpen = async (theme) => {
    await clearBackground(page);
    await setTheme(page, theme);
    await page.evaluate(() => { localStorage.removeItem('kiki.skin'); });
    await open(page, '/settings/about', 'text=Replay setup wizard');
    await page.getByRole('button', { name: 'Replay setup wizard', exact: true }).click();
    await wizard.waitFor({ timeout: 10_000 });
    await wizard.locator('[data-onboarding-appearance]').waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
  };
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await stepOpen(theme);
      await shot(page, `onboarding-appearance-${theme}-${width}`);
    }
  }
  // Choices take effect for real.
  await page.setViewportSize({ width: 1440, height: 900 });
  await stepOpen('light');
  await wizard.locator('[data-theme-choice="dark"]').click();
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'onboarding: Dark switches the window to dark');
  await wizard.locator('[data-onboarding-palette="iris"]').click();
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('kiki.skin') ?? '{}').selection?.id === 'iris'), 'onboarding: a swatch selects that palette');
  await wizard.locator('[data-onboarding-bg-open]').click();
  await wizard.locator('[data-bg-file]').setInputFiles(join(MEDIA, 'loud-4k.jpg'));
  await page.waitForSelector('[data-kiki-backdrop-item]', { timeout: 15_000 });
  await wizard.locator('#onboarding-bg-opacity').focus();
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
  const strength = await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('kiki.background') ?? '{}');
    return (prefs.dark ?? prefs.light)?.look?.opacity;
  });
  check(typeof strength === 'number' && strength < 1, `onboarding: the strength slider writes the picture's strength (${strength})`);
  await page.waitForTimeout(300);
  await shot(page, 'onboarding-appearance-chosen-dark-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await shot(page, 'onboarding-appearance-chosen-dark-390');
  await page.setViewportSize({ width: 1440, height: 900 });
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  await wizard.locator('[data-onboarding-appearance]').waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'onboarding: Next leaves the welcome page');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { localStorage.removeItem('kiki.skin'); localStorage.removeItem('kiki.background'); });
}

/** Exercise the production DOM/CSS in Chromium: jsdom cannot size replaced media. */
async function scenarioGeometry(page) {
  await setTheme(page, 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
  const results = [];
  for (const [file, mime] of [['bright-sky.jpg', 'image/jpeg'], ['drift-720.mp4', 'video/mp4'], [null, 'image/png']]) {
    if (file !== null) {
      await setLocalBackground(page, join(MEDIA, file), mime, { opacity: 1, scrim: 0 });
    } else {
      // A smaller-than-viewport picture is the other half of the intrinsic-size regression.
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 960; canvas.height = 540;
        const context = canvas.getContext('2d');
        context.fillStyle = '#2389ac'; context.fillRect(0, 0, 960, 540);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        const { putMedia } = await import('/src/lib/skins/mediaStore.ts');
        const id = 'local-proof-small';
        await putMedia(id, blob);
        const ref = { id, kind: 'image', mime: blob.type, name: 'small-proof.png', bytes: blob.size };
        localStorage.setItem('kiki.background', JSON.stringify({ light: { media: [ref], interval: 0, look: { opacity: 1, scrim: 0 } }, dark: null, linked: true }));
      });
    }
    await open(page, SESSION, '[data-kiki-backdrop-item]');
    for (const fit of mime.startsWith('video/') ? ['cover', 'contain', 'center'] : ['cover', 'contain', 'center', 'tile']) {
      for (const blur of [0, 20, 40]) {
        await page.evaluate(async ({ fit, blur }) => {
          const { applyBackdrop } = await import('/src/lib/skins/backdrop.ts');
          const { normalizeSlot } = await import('/src/lib/skins/background.ts');
          const raw = JSON.parse(localStorage.getItem('kiki.background')).light;
          applyBackdrop(normalizeSlot({ ...raw, look: { ...raw.look, fit, blur, alignment: 'bottomRight' } }), false);
        }, { fit, blur });
        await page.waitForFunction(() => {
          const media = document.querySelector('[data-kiki-backdrop-item]');
          return media instanceof HTMLImageElement ? media.complete && media.naturalWidth > 0 : media instanceof HTMLVideoElement ? media.readyState >= 2 : media !== null;
        });
        const geometry = await page.evaluate(() => {
          const root = document.querySelector('[data-kiki-backdrop]').getBoundingClientRect();
          const element = document.querySelector('[data-kiki-backdrop-item]');
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { root: { x: root.x, y: root.y, width: root.width, height: root.height }, box: { x: box.x, y: box.y, width: box.width, height: box.height }, fit: style.objectFit, position: style.objectPosition, tilePosition: style.backgroundPosition };
        });
        const pad = Math.ceil(blur * 3);
        const near = (a, b) => Math.abs(a - b) < 0.1;
        const { root, box } = geometry;
        const label = `${file ?? '960x540.png'} ${fit} blur ${blur}`;
        check(near(box.width, root.width + 2 * pad) && near(box.height, root.height + 2 * pad)
          && near(box.x, root.x - pad) && near(box.y, root.y - pad), `${label}: explicit overscan geometry ${JSON.stringify(box)}`);
        check(fit === 'tile' ? geometry.tilePosition === '100% 100%' : geometry.position === '100% 100%' && geometry.fit === (fit === 'center' ? 'none' : fit), `${label}: fit and alignment survive blur`);
        results.push({ media: file ?? '960x540.png', fit, blur, ...geometry });
      }
    }
    await shot(page, `geometry-${file?.replace(/\.[^.]+$/, '') ?? 'small'}-blur40`);
  }
  // CSS calc must follow the scoped box and viewport resizes without a JS size snapshot.
  for (const scope of ['window', 'main', 'sidebar']) {
    for (const width of [1440, 700, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async (scope) => {
        const { applyBackdrop } = await import('/src/lib/skins/backdrop.ts');
        const { normalizeSlot } = await import('/src/lib/skins/background.ts');
        const raw = JSON.parse(localStorage.getItem('kiki.background')).light;
        applyBackdrop(normalizeSlot({ ...raw, look: { ...raw.look, scope, fit: 'cover', blur: 20 } }), false);
      }, scope);
      await page.waitForTimeout(150);
      const boxes = await page.evaluate(() => {
        const root = document.querySelector('[data-kiki-backdrop]').getBoundingClientRect();
        const box = document.querySelector('[data-kiki-backdrop-item]').getBoundingClientRect();
        return { root: { x: root.x, width: root.width, height: root.height }, box: { x: box.x, width: box.width, height: box.height } };
      });
      check(Math.abs(boxes.box.width - boxes.root.width - 120) < 0.1 && Math.abs(boxes.box.height - boxes.root.height - 120) < 0.1
        && Math.abs(boxes.box.x - boxes.root.x + 60) < 0.1, `${scope} ${width}: overscan tracks scope and resize`);
    }
  }
  writeFileSync(join(OUT, 'geometry.json'), JSON.stringify(results, null, 2));
  await clearBackground(page);
}

/** Main timeline, shared rail and the default embedded subagent tab at two dial values. */
async function scenarioRegression(page) {
  await fetch(`${fixtureUrl}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scenario', name: 'subagent-invocations' }) });
  const path = '/s/session_fixture_subagent_invocations';
  await open(page, path, '[role="log"]');
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, 'light');
  for (const assist of [false, true]) {
    for (const dial of [0.3, 0.9]) {
      await setLocalBackground(page, join(MEDIA, 'bright-sky.jpg'), 'image/jpeg', { opacity: 1, surfaceOpacity: dial, blur: 20, surfaceBlur: 0, scrim: 0 });
      await page.evaluate((assist) => {
        const prefs = JSON.parse(localStorage.getItem('kiki.background'));
        localStorage.setItem('kiki.background', JSON.stringify({ ...prefs, assist }));
      }, assist);
      await open(page, path, '[role="log"]');
      if (await page.locator('[data-session-rail]').count() === 0) await page.locator('[data-rail-toggle]').click();
      await page.locator('[data-rail-pinned]').waitFor();
      const tag = `${assist ? 'assist' : 'off'}-dial${Math.round(dial * 100)}`;
      await shot(page, `regression-main-rail-${tag}`);
      await page.locator('[data-agent-open="agent-lead"]').first().click();
      await page.locator('[data-agent-tab-workspace="agent-lead"] [role="log"]').waitFor();
      await page.waitForTimeout(300);
      await shot(page, `regression-subagent-rail-${tag}`);
      const colors = await page.evaluate(() => {
        const read = (selector) => {
          const element = document.querySelector(selector);
          return element === null ? null : getComputedStyle(element).backgroundColor;
        };
        return { pinned: read('[data-rail-pinned]'), owner: read('[data-rail-owner]'), footer: read('[data-session-rail] .sticky.bottom-0'), tab: read('[data-agent-tab-workspace]'), header: read('[data-agent-tab-workspace] header'), relations: read('[data-agent-tab-workspace] [data-agent-relations-surface]') };
      });
      console.log(`[info] ${tag} surfaces ${JSON.stringify(colors)}`);
      const alpha = (color) => color === null ? null : color === 'rgba(0, 0, 0, 0)' ? 0 : color.includes('/') ? Number.parseFloat(color.split('/')[1]) : color.startsWith('rgba') ? Number.parseFloat(color.split(',')[3]) : 1;
      for (const key of ['pinned', 'owner']) check(alpha(colors[key]) === (assist ? 0 : dial), `${tag}: ${key} uses the rail wash without an opaque band`);
      check(alpha(colors.tab) === dial, `${tag}: agent tab uses the requested paper wash`);
      check(alpha(colors.header) !== 1 && alpha(colors.relations) !== 1, `${tag}: agent header and relations are not opaque`);
      await open(page, `${path}/agent/agent-lead`, '[role="log"]');
      await shot(page, `regression-agent-route-${tag}`);
      const relationColor = await page.locator('[data-agent-relations-surface]').evaluate((node) => getComputedStyle(node).backgroundColor);
      check(alpha(relationColor) !== 1, `${tag}: routed agent relations share the session header wash`);
      // The bare-provider fullscreen branch has this hook but no preview-workspace class.
      const bareColor = await page.evaluate(() => {
        const probe = document.createElement('aside');
        probe.dataset.kikiPreviewProof = '';
        probe.setAttribute('data-preview-workspace', '');
        probe.className = 'fixed inset-0 bg-panel';
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      check(alpha(bareColor) === (assist ? (await layerVars(page)).solid / 100 : dial), `${tag}: bare-provider fullscreen gets the preview wash`);
    }
  }
  await fetch(`${fixtureUrl}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scenario', name: 'busy-rail' }) });
  await open(page, '/s/session_fixture_busy', '[role="log"]');
  for (const assist of [false, true]) {
    await page.evaluate(async (assist) => {
      const { applyBackdrop } = await import('/src/lib/skins/backdrop.ts');
      const { normalizeSlot } = await import('/src/lib/skins/background.ts');
      const raw = JSON.parse(localStorage.getItem('kiki.background')).light;
      applyBackdrop(normalizeSlot({ ...raw, look: { ...raw.look, surfaceOpacity: 0.3 } }), assist);
    }, assist);
    if (await page.locator('[data-session-rail]').count() === 0) await page.locator('[data-rail-toggle]').click();
    const footer = page.locator('[data-tasks-scroll] .sticky.bottom-0');
    await footer.waitFor();
    const color = await footer.evaluate((node) => getComputedStyle(node).backgroundColor);
    check(assist ? color === 'rgba(0, 0, 0, 0)' : color.includes('/ 0.3)'), `tasks footer ${assist ? 'assist' : 'off'} uses rail wash (${color})`);
    await shot(page, `regression-tasks-footer-${assist ? 'assist' : 'off'}`);
  }
}

const browser = await chromium.launch();
try {
  await waitForServer(webUrl, 180_000);
  const context = await browser.newContext({ locale: LOCALE === 'zh' ? 'zh-CN' : 'en-US', viewport: { width: 1440, height: 900 } });
  // Keep the first-run popup out of the way (the onboarding scenario replays
  // it explicitly) and pin the locale.
  await context.addInitScript((locale) => {
    try {
      if (localStorage.getItem('kiki.onboarding') === null) localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: new Date().toISOString() }));
      const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
      if (settings.locale !== locale) localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, locale }));
    } catch { /* ignore */ }
  }, LOCALE);
  const page = await context.newPage();
  page.on('pageerror', (error) => { failures.push(`page error: ${error.message}`); console.error(`[pageerror] ${error.message}`); });
  await page.goto(deep('/'), { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const scenarios = {
    surfaces: scenarioSurfaces,
    matrix: scenarioMatrix,
    scopes: scenarioScopes,
    pack: scenarioPack,
    video: scenarioVideoPolicy,
    settings: scenarioSettingsPage,
    onboarding: scenarioOnboarding,
    geometry: scenarioGeometry,
    regression: scenarioRegression,
  };
  for (const [name, run] of Object.entries(scenarios)) {
    if (!wanted(name)) continue;
    console.log(`[scenario] ${name}`);
    try { await run(page); } catch (error) {
      failures.push(`${name}: ${String(error.message).split('\n')[0]}`);
      console.error(`[FAIL] ${name}: ${error.message}`);
    }
  }
  await context.close();
} finally {
  await browser.close();
  await cleanup();
}
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ locale: LOCALE, failures }, null, 2));
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nappearance proof passed');
