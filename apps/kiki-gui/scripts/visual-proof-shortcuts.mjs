/**
 * Scoped visual check for the management-shortcuts alignment (2026-10-04).
 *
 * Only the three surfaces that changed, at one desktop width, one theme: the
 * sidebar persona switcher (now reading the server's list), the memory page's
 * workspace override row (whose card read-back is now invalidated), and the
 * add-from-source dialog (which no longer carries the catalog editor).
 * Mock-only: the fixture server stands in for kap-server.
 *
 *   node scripts/visual-proof-shortcuts.mjs [--only=switcher,memory,source] [--no-build]
 *
 * It builds first and serves the build statically, so another owner editing
 * sources mid-run cannot reload the page out from under a shot.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const output = join(root, '.tmp', 'shortcuts-proof', String(Date.now()));
const dist = resolve(process.env.KIKI_SHORTCUTS_DIST ?? join(root, '.tmp', 'shortcuts-proof', 'dist'));
mkdirSync(output, { recursive: true });
const only = new Set((process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? 'switcher,memory,source').split(','));
const WIDTH = 1440;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

function startStatic(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

if (!process.argv.includes('--no-build')) {
  const built = spawnSync(process.execPath, [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn',
  ], { cwd: root, stdio: 'inherit', timeout: 180_000 });
  if (built.status !== 0) throw new Error(`vite build failed (status ${built.status})`);
}

const fixture = await startFixtureServer({ port: 0, scenario: 'personas' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
const staticServer = await startStatic(dist);
const web = `http://127.0.0.1:${staticServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const errors = [];
const control = (body) => fetch(`${endpoint}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const url = (path) => `${web}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;

const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => { errors.push(error.message); });
await page.addInitScript(() => {
  localStorage.setItem('kiki.locale', 'zh');
  localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
});

async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });
  await page.waitForTimeout(200);
}

async function shot(name) {
  await settle();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`${name}: horizontal overflow ${overflow}px`);
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

const walkers = {
  // The sidebar panel now asks the server for this persona's conversations.
  async switcher() {
    await page.goto(url('/new'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-sidebar-persona-row]', { timeout: 30_000 });
    const ids = await page.locator('[data-sidebar-persona-row]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-sidebar-persona-row')));
    // Find the persona the fixture actually gave a conversation, so this is
    // the list the fix is about rather than the empty case.
    let shown = null;
    for (const id of ids) {
      await page.locator(`[data-persona-switcher-toggle="${id}"]`).click();
      await page.locator('[data-persona-conversation-switcher]').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      const rows = await page.locator('[data-persona-conversation-switcher] [data-conversation-item]').count();
      if (shown === null) await shot(`sidebar-switcher-${id}`);
      if (rows > 1) { shown = id; break; }
      await page.keyboard.press('Escape');
    }
    if (shown === null) errors.push('switcher: no persona in the fixture has a conversation to show');
    // The exit to the full list stays reachable, and the daily row is first.
    const kinds = await page.locator('[data-persona-conversation-switcher] [data-conversation-kind]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-conversation-kind')));
    if (kinds[0] !== 'daily') errors.push(`switcher: the daily row must come first, saw ${kinds.join(',')}`);
    if (await page.locator('[data-persona-switcher-all]').count() !== 1) errors.push('switcher: the all-conversations exit is missing');
    if (shown !== null) await shot(`sidebar-switcher-with-conversations-${shown}`);
  },

  // The workspace override row whose card read-back is now invalidated.
  async memory() {
    await page.goto(url('/memory'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-memory-kind="workspace"]', { timeout: 30_000 });
    await page.locator('[data-memory-kind="workspace"]').click();
    await page.waitForSelector('[data-memory-ws-option]', { timeout: 10_000 });
    await shot('memory-workspace-override');
  },

  // The install-source dialog, which no longer carries the catalog editor.
  async source() {
    await page.goto(url('/capabilities?view=market'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-plugins-view="market"]', { timeout: 30_000 });
    await page.locator('[data-plugins-advanced] > button').click();
    await page.waitForSelector('[data-plugins-advanced][data-open="true"] [data-catalog-source]', { timeout: 5000 });
    // The catalog editor is still where it is read.
    await page.locator('[data-plugins-advanced]').scrollIntoViewIfNeeded();
    await shot('capability-advanced-catalog');
    await page.locator('[data-plugins-add-source-home]').click();
    await page.waitForSelector('[data-add-source]', { timeout: 5000 });
    await shot('add-source-dialog');
    if (await page.locator('[data-add-source] [data-catalog-source]').count() !== 0) {
      errors.push('add-source: the install dialog still carries the catalog editor');
    }
    if (await page.locator('[data-add-source-submit]').count() !== 1) errors.push('add-source: the review step is missing');
  },
};

try {
  for (const [name, walk] of Object.entries(walkers)) {
    if (!only.has(name)) continue;
    await control({ action: 'scenario', name: 'personas' });
    await walk();
  }
} finally {
  await browser.close();
  staticServer.close();
  await fixture.stop();
}
console.log(`[proof] ${output}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
