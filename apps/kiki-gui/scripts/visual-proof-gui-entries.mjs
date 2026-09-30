/**
 * Visual proof for the GUI entry batch: Settings › Shortcuts (default,
 * recording, conflict, remapped), the desktop log card, the /btw side
 * question, and the models.dev directory + account quota on Models &
 * providers. One static build, one fixture server per shot group, each
 * group at the given widths in light and dark.
 *
 *   node scripts/visual-proof-gui-entries.mjs [--no-build] [--locale=zh] [--only=shortcuts,…] [--widths=1440,390]
 *
 * Output: .tmp/visual-proof-gui-entries/<name>-<theme>-<width>-<locale>.png
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { spaceDesktopMock } from './space-desktop-mock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = resolve(join(ROOT, '.tmp', 'visual-proof-gui-entries'));
const DIST = resolve(join(ROOT, '.tmp', 'visual-proof-gui-entries-dist'));
const LOCALE = flag('locale', 'zh');
const WIDTHS = flag('widths', '1440').split(',').map(Number);
const ONLY = flag('only', '') === '' ? null : flag('only', '').split(',');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webp': 'image/webp',
};

function startStatic(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__kiki/local-server') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

function build() {
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', timeout: 240_000 });
  if (result.status !== 0) throw new Error(`vite build failed (status ${result.status})`);
}

async function settle(page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  }).catch(() => undefined);
  await page.waitForTimeout(250);
}

/**
 * Shot groups. `fixture` is the scenario to load; `desktop` injects the Tauri
 * mock (with `desktopLog` extending its command table); `run` walks the page
 * and calls `shot(name)` for each state worth keeping.
 */
const GROUPS = [
  {
    name: 'shortcuts',
    fixture: 'settings',
    async run({ page, open, shot }) {
      await open('/settings/shortcuts', '[data-shortcut-row="switcher"]');
      await shot('shortcuts-default');
      await page.click('[data-shortcut-row="switcher"] [data-shortcut-chord="0"]');
      await page.waitForSelector('[data-shortcut-recording]');
      await shot('shortcuts-recording');
      await page.keyboard.press('Control+f');
      await page.waitForSelector('[data-shortcut-row="switcher"] [data-shortcut-issue]');
      await shot('shortcuts-conflict');
      await page.click('[data-shortcut-row="switcher"] [data-shortcut-chord="0"]');
      await page.keyboard.press('Control+Shift+J');
      await page.waitForSelector('[data-shortcut-row="switcher"][data-shortcut-overridden="true"]');
      await page.click('[data-shortcut-row="approve"] [data-shortcut-chord="0"]');
      await page.keyboard.press('Backspace');
      await page.waitForSelector('[data-shortcut-row="approve"] [data-shortcut-disabled]');
      await page.mouse.click(5, 5);
      await shot('shortcuts-remapped');
      // The remap is live: the new chord opens the switcher, the old one does nothing.
      await page.keyboard.press('Control+Shift+J');
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+/');
      await page.waitForSelector('[data-shortcuts-customize]');
      await shot('shortcuts-overlay-remapped');
      await page.keyboard.press('Escape');
      await page.click('[data-shortcut-reset-all]');
      await page.waitForSelector('[role="alertdialog"], [role="dialog"]');
      await shot('shortcuts-reset-confirm');
    },
  },
  //@@MORE@@
];

async function runGroup(browser, webUrl, group, theme, width) {
  const fixture = await startFixtureServer({ port: 0, scenario: group.fixture });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  try {
    await context.addInitScript(({ locale, theme: next }) => {
      localStorage.setItem('kiki.locale', locale);
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
      localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, theme: next }));
    }, { locale: LOCALE, theme });
    if (group.desktop === true) {
      await context.addInitScript(spaceDesktopMock, { fixtureUrl, token: FIXTURE_TOKEN, spaces: [], windowMode: 'switch' });
      if (group.desktopLog !== undefined) await context.addInitScript(group.desktopLog);
    }
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const link = (path) => {
      const [route, hash = ''] = path.split('#');
      const joiner = route.includes('?') ? '&' : '?';
      return `${webUrl}${route}${joiner}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}${hash === '' ? '' : `#${hash}`}`;
    };
    const open = async (path, selector) => {
      await page.goto(link(path), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((next) => document.documentElement.dataset['theme'] === next, theme, { timeout: 15_000 });
      await page.waitForSelector(selector, { timeout: 20_000 });
      await settle(page);
    };
    const shots = [];
    const shot = async (name) => {
      await settle(page);
      const file = join(OUT, `${name}-${theme}-${width}-${LOCALE}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
    };
    await group.run({ page, open, shot, link, fixtureUrl });
    if (errors.length > 0) throw new Error(`pageerror: ${errors.join(' | ')}`);
    return { ok: true, shots };
  } catch (error) {
    const page = context.pages()[0];
    if (page !== undefined) await page.screenshot({ path: join(OUT, `${group.name}-${theme}-${width}-${LOCALE}-FAIL.png`) }).catch(() => undefined);
    return { ok: false, error: error.message };
  } finally {
    await context.close().catch(() => undefined);
    await fixture.stop().catch(() => undefined);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (!(argv.includes('--no-build') && existsSync(join(DIST, 'index.html')))) build();
  const web = await startStatic(DIST);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  let failed = 0;
  try {
    for (const group of GROUPS.filter((entry) => ONLY === null || ONLY.includes(entry.name))) {
      for (const width of WIDTHS) {
        for (const theme of ['light', 'dark']) {
          const result = await runGroup(browser, webUrl, group, theme, width);
          console.log(`[proof] ${result.ok ? 'ok  ' : 'FAIL'} ${group.name} ${theme} ${width}${result.ok ? ` (${result.shots.length} shots)` : ` — ${result.error}`}`);
          if (!result.ok) failed += 1;
        }
      }
    }
  } finally {
    await browser.close();
    web.close();
  }
  console.log(`[proof] output: ${OUT}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
