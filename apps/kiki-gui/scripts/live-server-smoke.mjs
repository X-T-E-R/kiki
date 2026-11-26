#!/usr/bin/env node
/**
 * live-server-smoke.mjs — strictly read-only @2x Playwright smoke & screenshot
 * verifier against a running local `kiki-server` (real `~/.kiki` data, zero
 * writes/mutations). Blocks any non-GET/HEAD/OPTIONS API requests except the
 * read-only media-playback grant endpoint if media is rendered.
 *
 * Usage:
 *   node apps/kiki-gui/scripts/live-server-smoke.mjs \
 *     --url http://127.0.0.1:4399 \
 *     --token-file C:/Users/you/.kiki/server.token \
 *     --out-dir .tmp/live-smoke
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    url: process.env.KIKI_LIVE_URL ?? '',
    token: process.env.KIKI_LIVE_TOKEN ?? '',
    tokenFile: process.env.KIKI_LIVE_TOKEN_FILE ?? '',
    outDir: join(ROOT, '.tmp', 'live-server-smoke'),
    sessionId: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const val = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (key === '--help' || key === '-h') {
      opts.help = true;
      if (eq < 0) i -= 1;
    } else if (key === '--url') opts.url = val ?? '';
    else if (key === '--token') opts.token = val ?? '';
    else if (key === '--token-file') opts.tokenFile = val ?? '';
    else if (key === '--out-dir') opts.outDir = val ?? opts.outDir;
    else if (key === '--session-id') opts.sessionId = val ?? '';
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

async function detectErrorBoundary(page) {
  return page.evaluate(() => {
    try {
      const renderFail = sessionStorage.getItem('kiki.lastRenderFailure');
      if (renderFail) return `sessionStorage.lastRenderFailure: ${renderFail.slice(0, 400)}`;
    } catch { /* ignore */ }
    const settingsErr = document.querySelector('[data-settings-pane-error]');
    if (settingsErr) return `SettingsPaneBoundary: ${(settingsErr.textContent ?? '').trim().slice(0, 400)}`;
    const appAlertPre = document.querySelector('main > section[role="alert"] pre');
    if (appAlertPre) return `AppErrorBoundary: ${(appAlertPre.textContent ?? '').trim().slice(0, 400)}`;
    return null;
  }).catch(() => null);
}

export async function runLiveServerSmoke(rawArgv = process.argv.slice(2)) {
  const opts = parseArgs(rawArgv);
  if (opts.help) {
    process.stdout.write(
      'Usage: node apps/kiki-gui/scripts/live-server-smoke.mjs --url <http://127.0.0.1:port> [--token-file <path> | --token <tok>] [--session-id <id>] [--out-dir <dir>]\n',
    );
    return;
  }
  if (!opts.url) throw new Error('--url is required (e.g. --url http://127.0.0.1:4399)');
  const token = opts.token || (opts.tokenFile ? readFileSync(resolve(opts.tokenFile), 'utf8').trim() : '');
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });

  const baseOrigin = new URL(opts.url).origin;
  const headers = token ? { authorization: `Bearer ${token}` } : {};

  let targetSessionId = opts.sessionId;
  if (!targetSessionId) {
    const res = await fetch(`${baseOrigin}/api/sessions?limit=25`, { headers });
    if (res.ok) {
      const env = await res.json();
      const items = env?.data?.items ?? [];
      const rich = items.find((s) => !s.archived && (s.message_count ?? 0) > 2) ?? items[0];
      targetSessionId = rich?.id ?? '';
    }
  }

  const routeUrl = (path) => {
    const u = new URL(path, baseOrigin);
    if (token) u.searchParams.set('token', token);
    return u.href;
  };

  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  const results = [];
  const blockedMutations = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err instanceof Error ? (err.stack ?? err.message) : String(err));
    });

    // Strict read-only guard: never allow mutating verbs against /api/* except read-only media-playback grant.
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const method = req.method().toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || req.url().includes('/media-playback')) {
        await route.continue();
        return;
      }
      blockedMutations.push({ method, url: req.url() });
      await route.abort('blockedbyclient');
    });

    const stops = [
      { name: '01-new', path: '/new', wait: '[data-phase="hero"], [data-composer-input]' },
      ...(targetSessionId
        ? [{ name: '02-session-process', path: `/s/${targetSessionId}`, wait: '[data-transcript-scroll]' }]
        : []),
      { name: '03-usage-live', path: '/usage', wait: 'main' },
      { name: '04-usage-quota', path: '/usage?panel=quota', wait: '[data-provider-quota-panel]' },
      { name: '05-settings', path: '/settings/appearance', wait: '[data-settings-page-title]' },
    ];

    for (const stop of stops) {
      await page.goto(routeUrl(stop.path), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector(stop.wait, { timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
      const boundary = await detectErrorBoundary(page);
      if (boundary !== null) throw new Error(`ErrorBoundary on ${stop.name}: ${boundary}`);
      if (pageErrors.length > 0) throw new Error(`Uncaught pageerror on ${stop.name}: ${pageErrors.join(' | ')}`);
      const png = join(outDir, `${stop.name}.png`);
      await page.screenshot({ path: png });
      results.push({ name: stop.name, path: stop.path, png });

      if (stop.name === '02-session-process') {
        const otherTab = page.locator('[data-timeline-view-option][aria-checked="false"]').first();
        if ((await otherTab.count()) > 0 && (await otherTab.isVisible().catch(() => false))) {
          await otherTab.click();
          await page.waitForTimeout(300);
          const msgPng = join(outDir, '02b-session-alternate-view.png');
          await page.screenshot({ path: msgPng });
          results.push({ name: '02b-session-alternate-view', path: stop.path, png: msgPng });
        }
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }

  const summaryPath = join(outDir, 'summary.json');
  writeFileSync(
    summaryPath,
    JSON.stringify({ checkedAt: new Date().toISOString(), sessionId: targetSessionId || null, blockedMutations, results }, null, 2),
  );
  console.log(`[live-server-smoke] OK (${results.length} @2x captures -> ${outDir})`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runLiveServerSmoke();
}
