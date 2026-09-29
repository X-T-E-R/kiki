/**
 * Standalone visual proof for the context-renewal strategy control (fixture
 * `context-strategy`): the ContextMeter card in every strategy state, the
 * source menu, the "compact now with…" menu, and the strategy on the
 * timeline's compaction markers. Light and dark, 1440 and 390.
 *
 *   node scripts/visual-proof-context-strategy.mjs
 *
 * Output: .tmp/context_strategy/ (override with KIKI_PROOF_OUTPUT_DIR).
 */

import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.KIKI_PROOF_OUTPUT_DIR ?? join(ROOT, '.tmp', 'context_strategy');
const LOCALE = process.env.KIKI_PROOF_LOCALE === 'zh' ? 'zh' : 'en';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up: ${url}`);
    await sleep(300);
  }
}

const fixturePort = await freePort();
const webPort = await freePort();
const FIXTURE_URL = `http://127.0.0.1:${fixturePort}`;
const WEB_URL = `http://127.0.0.1:${webPort}`;
const fixture = await startFixtureServer({ port: fixturePort, scenario: 'context-strategy' });
// KIKI_PROOF_VITE_CONFIG points vite at an alternate config (relative to the
// app root) when the shared tree needs a proof-only transform to boot.
const viteConfig = process.env.KIKI_PROOF_VITE_CONFIG;
const vite = spawn(`pnpm --filter @kiki/gui exec vite${viteConfig === undefined ? '' : ` --config ${viteConfig}`}`, {
  cwd: join(ROOT, '..', '..'),
  env: { ...process.env, KIKI_GUI_PORT: String(webPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
vite.stderr.on('data', (d) => process.stdout.write(`[vite:err] ${d}`));

const cleanup = async () => {
  if (process.platform === 'win32' && vite.pid !== undefined) {
    try { execSync(`taskkill /PID ${vite.pid} /F /T`, { stdio: 'ignore' }); } catch { /* gone */ }
  }
  vite.kill();
  await fixture.stop();
};

const errors = [];
let browser;
try {
  await waitForServer(WEB_URL, 120_000);
  await fetch(`${WEB_URL}/src/main.tsx`).catch(() => undefined);
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => { errors.push(error); console.error(`[pageerror] ${error}`); });
  await page.addInitScript((locale) => { try { localStorage.setItem('kiki.locale', locale); } catch { /* ignore */ } }, LOCALE);

  const url = (path) => `${WEB_URL}${path}?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`;
  const shot = async (name) => {
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)));
    }).catch(() => undefined);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`[shot] ${name}.png`);
  };
  const setTheme = async (theme) => {
    await page.evaluate((next) => {
      const raw = localStorage.getItem('kiki.settings');
      localStorage.setItem('kiki.settings', JSON.stringify({ ...(raw === null ? {} : JSON.parse(raw)), theme: next }));
    }, theme);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((next) => document.documentElement.dataset['theme'] === next, theme, { timeout: 20_000 });
  };
  const openSession = async (id) => {
    await page.goto(url(`/s/${id}`), { waitUntil: 'domcontentloaded', timeout: 240_000 });
    await page.waitForSelector('[data-context-meter]', { timeout: 60_000 });
    await page.waitForTimeout(700);
  };
  const openCard = async () => {
    if (await page.locator('[data-context-details]').count() === 0) await page.click('[data-context-meter]');
    await page.waitForSelector('[data-context-details]', { timeout: 5000 });
  };
  const closeCard = async () => {
    if (await page.locator('[data-context-details]').count() > 0) await page.click('[data-context-meter]');
  };
  const expectStrategy = async (strategy, source) => {
    await page.waitForFunction(([s, src]) => {
      const el = document.querySelector('[data-context-strategy]');
      return el?.getAttribute('data-strategy') === s && el?.getAttribute('data-strategy-source') === src;
    }, [strategy, source], { timeout: 8000 });
  };

  await page.goto(url('/new'), { waitUntil: 'domcontentloaded', timeout: 240_000 });
  for (const theme of ['light', 'dark']) {
    await fixture.loadScenario('context-strategy');
    await setTheme(theme);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Built-in default + the timeline's four marker variants.
    await openSession('session_fixture_strategy_timeline');
    const markerKeys = await page.locator('[data-timeline-divider][data-notice-key]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-notice-key')),
    );
    console.log(`[check] marker keys: ${JSON.stringify(markerKeys)}`);
    for (const expected of [
      'transcript.marker.compactionSummarize',
      'transcript.marker.compactionFresh',
      'transcript.marker.compactionFallback',
      'transcript.marker.compactionRescue',
    ]) {
      if (!markerKeys.includes(expected)) throw new Error(`marker "${expected}" missing`);
    }
    await shot(`timeline-1440-${theme}`);
    await openCard();
    await expectStrategy('summarize', 'default');
    await shot(`card-default-1440-${theme}`);

    // Pick fresh: session override; hint and source label follow.
    await page.click('[data-strategy-option="fresh"]');
    await expectStrategy('fresh', 'session');
    await shot(`card-session-fresh-1440-${theme}`);
    await page.click('[data-strategy-source-trigger]');
    await page.waitForSelector('[data-strategy-source-menu]');
    await shot(`card-source-menu-1440-${theme}`);
    await page.click('[data-strategy-reset]');
    await expectStrategy('summarize', 'default');

    // Compact now with a chosen strategy: the marker lands on the timeline.
    await page.click('[data-context-compact-with]');
    await page.waitForSelector('[data-context-compact-menu]');
    await shot(`card-compact-menu-1440-${theme}`);
    await page.click('[data-context-compact-option="fresh"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-timeline-divider]').length >= 5, null, { timeout: 8000 });
    await shot(`compact-now-fresh-1440-${theme}`);

    // Profile layer, session override on auto, executor lock, older engine.
    await openSession('session_fixture_strategy_profile');
    await openCard();
    await expectStrategy('fresh', 'profile');
    await shot(`card-profile-1440-${theme}`);
    await closeCard();
    await openSession('session_fixture_strategy_session');
    await openCard();
    await expectStrategy('auto', 'session');
    // Sync to global: the override drops and the source reads global.
    await page.click('[data-strategy-source-trigger]');
    await page.click('[data-strategy-save-global]');
    await expectStrategy('auto', 'global');
    await shot(`card-saved-global-1440-${theme}`);
    await page.click('[data-strategy-option="summarize"]');
    await expectStrategy('summarize', 'session');
    await closeCard();
    await openSession('session_fixture_strategy_executor');
    await openCard();
    await expectStrategy('summarize', 'executor');
    await shot(`card-executor-1440-${theme}`);
    await closeCard();
    await openSession('session_fixture_strategy_legacy');
    await openCard();
    if (await page.locator('[data-context-strategy]').count() !== 0) throw new Error('older engine must not show the strategy block');
    await shot(`card-older-engine-1440-${theme}`);
    await closeCard();

    // 390: the same card on a phone width, then the timeline.
    await page.setViewportSize({ width: 390, height: 844 });
    await openSession('session_fixture_strategy_profile');
    await openCard();
    await shot(`card-profile-390-${theme}`);
    await page.click('[data-context-compact-with]');
    await page.waitForSelector('[data-context-compact-menu]');
    await shot(`card-compact-menu-390-${theme}`);
    await closeCard();
    await openSession('session_fixture_strategy_timeline');
    await shot(`timeline-390-${theme}`);
  }
  if (errors.length > 0) throw new Error(`${errors.length} page error(s)`);
  console.log('[proof] context-strategy ok');
} catch (error) {
  console.error('[FAIL]', error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await cleanup();
}
