import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, '.tmp', 'oauth-model-proof');
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
  env: { ...process.env, KIKI_GUI_PORT: String(webPort) },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));
let browser;
try {
  await waitFor(webUrl);
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.addInitScript(() => {
    localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: new Date().toISOString() }));
    localStorage.setItem('kiki.locale', 'en');
  });
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(deepLink('/settings/ai?tab=models'), { waitUntil: 'domcontentloaded' });
      await page.evaluate((value) => {
        const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
        localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, theme: value }));
      }, theme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#st-card-models').waitFor();
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
      await page.screenshot({ path: join(shots, `models-${theme}-${width}.png`), fullPage: true });
      await page.locator('[data-ai-tab="providers"]').click();
      await page.locator('[data-oauth-method="openai-codex"]').waitFor();
      await page.locator('[data-preset-grid]').waitFor();
      await page.screenshot({ path: join(shots, `providers-${theme}-${width}.png`), fullPage: true });
      await page.locator('[data-oauth-method="openai-codex"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, `providers-account-${theme}-${width}.png`), fullPage: true });
      await page.goto(deepLink('/settings/about'), { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Replay setup wizard' }).click();
      const wizard = page.locator('[role="dialog"]');
      await wizard.locator('button[data-autofocus]').click();
      await wizard.getByRole('button', { name: 'Change or add another connection' }).waitFor();
      if (await wizard.locator('[data-preset-grid]').count() !== 0) {
        throw new Error('Connected onboarding still shows API key options');
      }
      await page.screenshot({ path: join(shots, `onboarding-connected-${theme}-${width}.png`), fullPage: true });
      await wizard.getByRole('button', { name: 'Change or add another connection' }).click();
      await wizard.locator('[data-oauth-method="github-copilot"]').waitFor();
      await wizard.locator('[data-preset-grid]').waitFor();
      await page.screenshot({ path: join(shots, `onboarding-${theme}-${width}.png`), fullPage: true });
      await wizard.locator('[data-oauth-method="openai-codex"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, `onboarding-account-${theme}-${width}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (overflow) throw new Error(`Horizontal overflow at ${width}px (${theme})`);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'GUI page errors during OAuth/model proof');
  console.log(`[proof] 24 screenshots at ${shots}`);
} finally {
  await browser?.close();
  if (process.platform === 'win32' && vite.pid !== undefined) {
    try { execFileSync('taskkill', ['/PID', String(vite.pid), '/F', '/T'], { stdio: 'ignore' }); }
    catch { /* our process already exited */ }
  } else vite.kill();
  await fixture.stop();
}
