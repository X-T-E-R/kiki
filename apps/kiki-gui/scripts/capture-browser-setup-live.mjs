/**
 * Live browser-setup walk — the same settings leaf, against a REAL kap-server
 * and the REAL browser components on this machine, rather than the fixture.
 * The fixture walk proves the page renders every state it was seeded; this one
 * proves what an ordinary person actually meets on this host: which routes are
 * already installed, which still need a person, and what the external route
 * says.
 *
 * It never writes server state unless LIVE_PREPARE=1 is set, and it re-reads
 * the presets after every action, so the screenshots are the server's answers.
 *
 *   node scripts/capture-browser-setup-live.mjs
 *
 * Credentials come from the caller (KIKI_LIVE_TOKEN / KIKI_LIVE_URL), so this
 * script never reads a token file itself.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, '.tmp', 'live-dist');
const OUT = process.env.KIKI_LIVE_SHOTS ?? join(ROOT, '.tmp', 'browser-setup-live');
const SERVER = process.env.KIKI_LIVE_URL;
const TOKEN = process.env.KIKI_LIVE_TOKEN;
const ALLOW_WRITE = process.env.LIVE_PREPARE === '1';
const OWNER = process.env.KIKI_LIVE_OWNER ?? 'local';
// The deep link and the direct call want different shapes: the GUI appends its
// own `/api`, a direct read has to say so itself.
const API = `${SERVER.replace(/\/api\/?$/, '')}/api`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

async function serve() {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = path === '/' ? join(DIST, 'index.html') : join(DIST, path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      // The app is a single-page surface: unknown paths are still the app.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await readFile(join(DIST, 'index.html')));
    }
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** What the page itself will see, read through the same header the GUI uses. */
async function presets() {
  const response = await fetch(`${API}/browser/setup`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(60_000) });
  const envelope = await response.json();
  return envelope.data.presets;
}

const shots = [];
const facts = [];
async function main() {
  const before = await presets();
  facts.push({ when: 'before', presets: before.map((p) => ({ preset: p.preset, state: p.state, surface: p.controlSurface, steps: p.steps.map((s) => `${s.id}=${s.state}`) })) });

  const { server, url } = await serve();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en' });
  const page = await context.newPage();
  // The GUI appends `/api` itself, so the deep link carries the bare origin.
  const origin = SERVER.replace(/\/api\/?$/, '');
  const link = (path) => `${url}${path}?server=${encodeURIComponent(origin)}&token=${encodeURIComponent(OWNER)}`;

  async function shot(name, { keepScroll = false } = {}) {
    if (!keepScroll) await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
    await page.waitForTimeout(220);
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    shots.push(file);
    process.stdout.write(`[shot] ${name}.png\n`);
  }

  await page.goto(link('/settings/browser-control'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-browser-route="kimi-webbridge"]', { timeout: 40_000 });
  await page.waitForSelector('[data-browser-route="independent-browser"]', { timeout: 40_000 });
  await page.waitForSelector('[data-browser-route="codex-browser"]', { timeout: 40_000 });
  await shot('live-wizard');

  // The external route must never offer a Kiki action, on a real server too.
  const codexActions = await page.locator('[data-browser-route="codex-browser"] [data-browser-route-prepare], [data-browser-route="codex-browser"] [data-browser-route-connect], [data-browser-route="codex-browser"] [data-browser-route-connected]').count();
  if (codexActions !== 0) throw new Error(`live external route offered ${codexActions} Kiki actions`);

  // The rows the page draws, read back from the DOM as evidence.
  const rendered = await page.evaluate(() => [...document.querySelectorAll('[data-browser-route]')].map((row) => ({
    preset: row.getAttribute('data-browser-route'),
    readiness: row.querySelector('[data-browser-route-readiness]')?.textContent?.trim(),
    blocker: row.querySelector('[data-browser-route-blocker]')?.textContent?.trim(),
    connected: row.querySelector('[data-browser-route-connected]') !== null,
    buttons: [...row.querySelectorAll('button,a')].map((el) => el.getAttribute('data-browser-route-prepare') !== null ? 'prepare'
      : el.getAttribute('data-browser-route-connect') !== null ? 'connect'
        : el.getAttribute('data-browser-route-extension') !== null ? 'extension'
          : el.getAttribute('data-browser-route-instructions') !== null ? 'instructions'
            : el.getAttribute('data-browser-route-enable-feature') !== null ? 'enable-feature' : 'other'),
  })));
  facts.push({ when: 'rendered', rows: rendered });
  process.stdout.write(`${JSON.stringify(rendered, null, 1)}\n`);

  // The diagnostics fold: the detector's own sentences, off the first screen.
  const diagnostics = page.locator('[data-browser-route-diagnostics] summary').first();
  if (await diagnostics.isVisible().catch(() => false)) {
    await diagnostics.click();
    await page.locator('[data-browser-route-diagnostics]').first().scrollIntoViewIfNeeded();
    await shot('live-diagnostics');
  }

  // The connected route, if this host has one, and the narrow layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('live-wizard-390');

  // The advanced region: what a person fills in when no route is theirs. The
  // diagnostics fold is closed first, or the shot below is still the fold.
  const openFold = page.locator('[data-browser-route-diagnostics][open]');
  if (await openFold.count() > 0) await openFold.first().locator('summary').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-browser-advanced-region] summary').click();
  await page.waitForSelector('[data-browser-connections]', { timeout: 20_000 });
  await page.locator('[data-browser-connections]').scrollIntoViewIfNeeded();
  await shot('live-advanced', { keepScroll: true });
  facts.push({ when: 'advanced', open: await page.locator('[data-browser-advanced-region][open]').count() });

  // The real two-action flow, only when the caller allows writes.
  if (ALLOW_WRITE) {
    const route = page.locator('[data-browser-route="independent-browser"]');
    if (await route.locator('[data-browser-route-prepare]').isVisible().catch(() => false)) {
      await route.locator('[data-browser-route-prepare]').click();
      await page.waitForSelector('[data-confirm-action="confirm"]', { timeout: 10_000 });
      await shot('live-prepare-confirm');
      await page.locator('[data-confirm-action="confirm"]').click();
      await page.waitForFunction(() => {
        const row = document.querySelector('[data-browser-route="independent-browser"]');
        return row !== null && row.getAttribute('data-browser-route-state') !== 'needs-action';
      }, undefined, { timeout: 600_000 });
      await shot('live-after-prepare');
      facts.push({ when: 'after-prepare', presets: (await presets()).map((p) => ({ preset: p.preset, state: p.state })) });
    }
  }

  await browser.close();
  server.close();
  process.stdout.write(`${JSON.stringify(facts, null, 1)}\n`);
}

if (SERVER === undefined || TOKEN === undefined) {
  process.stderr.write('set KIKI_LIVE_URL and KIKI_LIVE_TOKEN\n');
  process.exit(2);
}
await main();