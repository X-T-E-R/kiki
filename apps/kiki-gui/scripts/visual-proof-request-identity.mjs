/**
 * Visual proof for Settings › Request identity (fixture `request-identity`):
 * a built-in identity with its preview, the custom editor (dirty + a server
 * rejection), client version tracks (staged candidate, pinned, after a check),
 * where identities are used, and the latest requests — zh, light and dark.
 *
 *   node scripts/visual-proof-request-identity.mjs [--widths=1440,390]
 *
 * Screenshots land in .tmp/request-identity-proof/<stamp>/ as `<surface>-<theme>-<width>.png`.
 * Mock-only: the fixture server stands in for kap-server.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'request-identity-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const widths = (process.argv.find((arg) => arg.startsWith('--widths='))?.slice('--widths='.length) ?? '1440').split(',').map(Number);

const fixture = await startFixtureServer({ port: 0, scenario: 'request-identity' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const errors = [];

const control = (body) => fetch(`${endpoint}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const url = (path) => `${web}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });
  await page.waitForTimeout(200);
}

async function shot(page, name) {
  await settle(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`${name}: horizontal overflow ${overflow}px`);
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

async function to(page, selector) {
  await page.locator(selector).first().evaluate((node) => { node.scrollIntoView({ block: 'start' }); });
}

async function walk(page, tag, width) {
  await page.goto(url('/settings/identity'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-identity-detail="codex"] [data-preview-header="User-Agent"]', { timeout: 30_000 });
  await shot(page, `builtin-${tag}`);
  if (width < 600) {
    await to(page, '[data-identity-preview]');
    await shot(page, `builtin-preview-${tag}`);
    await page.locator('[data-identity-back]').click();
  }

  await page.locator('[data-identity-row="custom:codex-1"]').click();
  await page.waitForSelector('[data-identity-detail="custom:codex-1"] [data-identity-user-agent]');
  await shot(page, `custom-${tag}`);
  await page.locator('[data-identity-user-agent]').fill('codex-tui/{version} ({os_type} {os_version}; {arch}) {terminal}');
  await to(page, '[data-identity-pairs="header"]');
  await page.locator('[data-settings-draft="identity-custom:codex-1"] button').first().click();
  await page.waitForSelector('[data-identity-detail="custom:codex-1"] [data-field-issue]', { timeout: 10_000 });
  await to(page, '[data-identity-pairs="param"]');
  await shot(page, `custom-rejected-${tag}`);
  await page.locator('[data-settings-discard="identity-custom:codex-1"]').click();

  await to(page, '#st-card-identity-tracks');
  await shot(page, `tracks-${tag}`);
  await page.locator('[data-identity-track="codex_cli"] [data-track-check="npm"]').click();
  await page.waitForSelector('[data-identity-track="codex_cli"] [data-track-candidate]');
  await to(page, '#st-card-identity-tracks');
  await shot(page, `tracks-staged-${tag}`);

  await to(page, '#st-card-identity-usage');
  await shot(page, `usage-${tag}`);
  await to(page, '#st-card-identity-recent');
  await shot(page, `recent-${tag}`);
}

for (const width of widths) {
  for (const theme of ['light', 'dark']) {
    await control({ action: 'scenario', name: 'request-identity' }).catch(() => {});
    const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => { errors.push(`${theme}-${width}: ${error.message}`); });
    await page.addInitScript((next) => {
      localStorage.setItem('kiki.locale', 'zh');
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: next }));
    }, theme);
    try { await walk(page, `${theme}-${width}`, width); }
    catch (error) { errors.push(`${theme}-${width}: ${error instanceof Error ? error.message : String(error)}`); await page.screenshot({ path: join(output, `failed-${theme}-${width}.png`) }).catch(() => {}); }
    finally { await page.close(); }
  }
}

await browser.close();
await vite.close();
fixture.http.close();
console.log(`[proof] ${output}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
process.exit();
