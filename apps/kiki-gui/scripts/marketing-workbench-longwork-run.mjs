/**
 * marketing-workbench-longwork-run — a private, self-contained driver for the
 * workbench / long-work frame set.
 *
 * WHY THIS EXISTS, and why it is not the campaign runner: the frame set itself
 * lives in marketing-workbench-longwork-shots.mjs, which is written to be
 * registered into the shared campaign runner (owned by public_visuals_frontend_m3).
 * This driver exists so THIS slice can verify its own walkers and read its own
 * frames back without waiting on that registration and without touching the
 * shared file. It reuses the shared fixture server — the only source of truth
 * for the wire shapes — and 553's stable dist, pinned.
 *
 * It is not a second image framework: same build, same fixture server, same
 * capture path (static serve + per-job fixture server + browser context at DPR
 * 2). What differs is only that the SHOTS table is imported rather than
 * appended, and that every run writes into its own timestamped subdirectory of
 * KIKI_MARKETING_CAMPAIGN_DIR and deletes nothing.
 *
 *   node scripts/marketing-workbench-longwork-run.mjs
 *   node scripts/marketing-workbench-longwork-run.mjs --only=wl-longwork-board --locales=zh
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { WORKBENCH_LONGWORK_SHOTS } from './marketing-workbench-longwork-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(ROOT, '..', '..');

/** This slice's own output root. Never cleared; each run gets its own subdir. */
const OUT_ROOT = resolve(
  process.env.KIKI_MARKETING_CAMPAIGN_DIR
    ?? join(REPO_ROOT, '.tmp', 'visual-workbench-longwork-20261005', 'frames'),
);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(OUT_ROOT, runId);

/**
 * The shared, stable GUI dist. This driver never builds: public_visuals_frontend_m3
 * owns the one build, and a frame served from a bundle this slice rebuilt would
 * not be the bundle the rest of the series was shot from. A missing dist is a
 * clear failure, not a silent build.
 */
const DIST = resolve(
  process.env.KIKI_MARKETING_CAMPAIGN_DIST
    ?? join(REPO_ROOT, '.tmp', 'kiki-public-visuals', 'dist'),
);
/** 1440×900 @2x = 2880×1800 masters, matching the existing marketing frames. */
const DPR = 2;

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const only = arg('only', null)?.split(',').filter((value) => value !== '') ?? null;
const locales = arg('locales', 'en,zh').split(',').filter((value) => value !== '');

/**
 * The fixture clock is pinned so relative copy ("3 min ago") is stable across
 * runs. It must sit near the present: a public frame that shows a sidebar
 * reading "Jan 1" or a run timer reading "275d" is carrying the fixture's own
 * epoch into the pixels, which is a fixture artifact rather than the product.
 */
if (process.env.KIKI_FIXTURE_EPOCH === undefined) {
  process.env.KIKI_FIXTURE_EPOCH = '2026-10-05T10:40:00.000Z';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
};

/** A static SPA server. `/__kiki/local-server` reports no local server. */
function startStatic(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(dir, 'index.html');
    }
    const stream = createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      stream.pipe(res);
    });
    stream.once('error', () => {
      if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((ready) => { server.listen(0, '127.0.0.1', () => ready(server)); });
}

const S = 'sess_sample_prepare_release';
const READY = '[data-session-sidebar]';

async function captureOne(browser, { webUrl, shot: def }) {
  const scenario = `${def.scenario}-${def.locale}`;
  const file = `${def.name}.${def.locale}.${def.theme}.png`;
  const fixture = await startFixtureServer({ port: 0, scenario });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  const link = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
  const context = await browser.newContext({
    viewport: def.viewport,
    deviceScaleFactor: DPR,
    locale: def.locale === 'zh' ? 'zh-CN' : 'en-US',
    colorScheme: def.theme,
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
  });
  await context.addInitScript((payload) => {
    try {
      localStorage.setItem('kiki.locale', payload.locale);
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: payload.theme }));
      localStorage.setItem('kiki.layout', JSON.stringify({ groupBy: 'workspace', sortBy: 'updated-desc' }));
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-10-01T00:00:00.000Z' }));
    } catch { /* storage unavailable */ }
  }, { locale: def.locale, theme: def.theme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(link('/new'), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector(READY, { timeout: 60_000 });
    await page.waitForTimeout(700);
    const target = join(OUT, file);
    const shot = async ({ skipSettle = false } = {}) => {
      if (!skipSettle) {
        await page.mouse.move(2, 2);
        await page.evaluate(() => document.fonts.ready).catch(() => undefined);
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations()
            .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)));
        }).catch(() => undefined);
        await page.waitForTimeout(400);
        await page.mouse.move(1, 1);
        await page.waitForTimeout(200);
      }
      await page.screenshot({ path: target });
      console.log(`[shot] ${file} (${Math.round(statSync(target).size / 1024)} KB)`);
    };
    await def.run({ page, link, shot, locale: def.locale, fixtureUrl });
    if (errors.length > 0) throw new Error(`pageerror: ${errors.join(' | ')}`);
    return { ok: true };
  } catch (error) {
    await page.screenshot({ path: join(OUT, `${file.replace(/\.png$/, '')}.FAIL.png`) }).catch(() => undefined);
    return { ok: false, error: error.message };
  } finally {
    await context.close().catch(() => undefined);
    await fixture.stop().catch(() => undefined);
  }
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`no shared GUI dist at ${DIST} — public_visuals_frontend_m3 owns the build; this driver never builds`);
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`[wl] output: ${OUT}`);
  console.log(`[wl] dist:   ${DIST}`);

  const web = await startStatic(DIST);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const results = [];
  try {
    for (const def of WORKBENCH_LONGWORK_SHOTS) {
      if (only !== null && !only.some((fragment) => def.name.includes(fragment))) continue;
      for (const locale of locales) {
        for (const theme of def.themes ?? ['light']) {
          const job = { ...def, locale, theme };
          const started = Date.now();
          const result = await captureOne(browser, { webUrl, shot: job });
          results.push({ name: def.name, locale, theme, ...result, ms: Date.now() - started });
          console.log(`[wl] ${result.ok ? 'ok  ' : 'FAIL'} ${def.name}.${locale}.${theme} ${Date.now() - started}ms${result.ok ? '' : ` — ${result.error}`}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((done) => { web.close(done); });
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`[wl] frames ${results.length}, failed ${failed.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
