import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.KIKI_PROOF_OUTPUT_DIR === undefined
  ? join(root, '.tmp', 'oauth-model-proof')
  : resolve(process.env.KIKI_PROOF_OUTPUT_DIR, 'oauth-model-proof');
mkdirSync(shots, { recursive: true });

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url) {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* waiting for our dev server */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev server did not start at ${url}`);
}

const fixturePort = await availablePort();
const webPort = await availablePort();
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const deepLink = (route) => `${webUrl}${route}${route.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
const fixture = await startFixtureServer({ port: fixturePort, scenario: 'settings' });
const vite = spawn('pnpm --filter @kiki/gui dev', {
  cwd: join(root, '..', '..'),
  env: { ...process.env, KIKI_GUI_PORT: String(webPort), KIKI_SERVER_URL: fixtureUrl },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));
let browser;
try {
  await waitFor(webUrl);
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const errors = [];
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width <= 639 ? 844 : 900 },
        deviceScaleFactor: 1,
        ...(width <= 639 ? { isMobile: true, hasTouch: true } : {}),
      });
      try {
        await context.addInitScript(() => {
          localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: new Date().toISOString() }));
          localStorage.setItem('kiki.locale', 'en');
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error));
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(deepLink('/settings/ai?tab=defaults'), { waitUntil: 'domcontentloaded' });
        await page.locator('[data-default-row]').first().waitFor();
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        await page.screenshot({ path: join(shots, `models-${theme}-${width}.png`), fullPage: true });
        await page.locator('[data-ai-tab="providers"]').click();
        await page.screenshot({ path: join(shots, `providers-${theme}-${width}.png`), fullPage: true });

        await page.goto(deepLink('/settings/ai'), { waitUntil: 'domcontentloaded' });
        await page.locator('[data-add-connection]').first().click();
        const panel = page.locator('[data-add-connection-panel]');
        await panel.locator('[data-first-run-card="lanes"]').waitFor({ timeout: 10_000 });
        await panel.locator('[data-first-run-lane="account"]').click();
        await panel.locator('[data-first-run-open-lane="account"] [data-oauth-method="github-copilot"]').waitFor();
        await panel.locator('[data-first-run-open-lane="account"] [data-oauth-method="openai-codex"]').waitFor();
        if (await panel.locator('[data-preset-grid]').count() !== 0) throw new Error('The account lane still shows API-key presets');
        await page.screenshot({ path: join(shots, `add-connection-account-list-${theme}-${width}.png`), fullPage: true });
        await page.locator('[data-oauth-method="openai-codex"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(shots, `add-connection-account-codex-${theme}-${width}.png`), fullPage: true });
        await page.keyboard.press('Escape');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        if (overflow) throw new Error(`Horizontal overflow at ${width}px (${theme})`);
      } finally {
        await context.close();
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'GUI page errors during OAuth/model proof');
  console.log(`[proof] 16 screenshots at ${shots}`);
} finally {
  await browser?.close();
  if (process.platform === 'win32' && vite.pid !== undefined) {
    try { execFileSync('taskkill', ['/PID', String(vite.pid), '/F', '/T'], { stdio: 'ignore' }); }
    catch { /* our process already exited */ }
  } else vite.kill();
  await fixture.stop();
}
