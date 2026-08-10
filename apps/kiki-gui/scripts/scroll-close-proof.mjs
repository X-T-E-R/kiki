/**
 * Focused browser proof for the bounded session transcript and the two explicit
 * desktop close outcomes. Uses the real app against the deterministic fixture.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const GUI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('Could not reserve a port');
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep waiting for Vite.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

function assert(condition, message, details) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(details)}`);
}

const fixturePort = await freePort();
const webPort = await freePort();
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const webUrl = `http://localhost:${webPort}`;
const fixture = await startFixtureServer({ port: fixturePort, scenario: 'long-transcript' });
const vite = spawn(process.execPath, [join(GUI_ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], {
  cwd: GUI_ROOT,
  env: { ...process.env, KIKI_GUI_PORT: String(webPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stdout.on('data', (data) => process.stdout.write(`[vite] ${data}`));
vite.stderr.on('data', (data) => process.stderr.write(`[vite] ${data}`));

let browser;
try {
  await waitForServer(webUrl);
  console.log(`[proof] web ready at ${webUrl}`);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(
    `${webUrl}/s/session_fixture_long?server=${encodeURIComponent(fixtureUrl)}&token=${encodeURIComponent(FIXTURE_TOKEN)}`,
    { waitUntil: 'domcontentloaded' },
  );
  console.log('[proof] app connected');
  const transcript = page.locator('[role="log"] > div').first();
  await transcript.waitFor({ timeout: 15_000 });
  await page.getByText('Turn 64:', { exact: false }).waitFor({ timeout: 15_000 });

  const before = await page.evaluate(() => {
    const log = document.querySelector('[role="log"] > div');
    const main = log?.closest('main');
    const header = main?.querySelector('header');
    const composer = main?.querySelector('textarea');
    const rail = document.querySelector('.app-rail');
    if (!(log instanceof HTMLElement) || !(header instanceof HTMLElement) ||
        !(composer instanceof HTMLElement) || !(rail instanceof HTMLElement)) {
      throw new Error('Expected session geometry nodes are missing');
    }
    const headerRect = header.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    return {
      clientHeight: log.clientHeight,
      scrollHeight: log.scrollHeight,
      scrollTop: log.scrollTop,
      headerTop: headerRect.top,
      composerTop: composerRect.top,
      railTop: railRect.top,
      railBottom: railRect.bottom,
    };
  });
  await transcript.evaluate((element) => {
    element.scrollTop = Math.max(1, element.scrollTop - Math.floor(element.clientHeight / 2));
  });
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const log = document.querySelector('[role="log"] > div');
    const main = log?.closest('main');
    const header = main?.querySelector('header');
    const composer = main?.querySelector('textarea');
    if (!(log instanceof HTMLElement) || !(header instanceof HTMLElement) ||
        !(composer instanceof HTMLElement)) throw new Error('Expected session geometry nodes are missing');
    return {
      scrollTop: log.scrollTop,
      headerTop: header.getBoundingClientRect().top,
      composerTop: composer.getBoundingClientRect().top,
    };
  });

  assert(before.scrollHeight > before.clientHeight, 'Transcript is not independently overflowed', before);
  assert(after.scrollTop !== before.scrollTop, 'Transcript scrollTop did not change', { before, after });
  assert(after.headerTop === before.headerTop, 'Header moved with transcript scroll', { before, after });
  assert(after.composerTop === before.composerTop, 'Composer moved with transcript scroll', { before, after });
  assert(before.railTop >= 0 && before.railBottom <= 900, 'Right rail is not independently viewport-bounded', before);
  console.log(`[proof] transcript geometry ${JSON.stringify({ before, after })}`);

  await page.evaluate(() => {
    // Show desktop-only settings without restarting through desktop connection discovery.
    window.isTauri = true;
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  const hide = page.getByLabel('Hide to tray');
  const quit = page.getByLabel('Quit Kiki');
  await hide.waitFor();
  assert(await hide.isChecked(), 'Hide-to-tray was not the default', {});
  await quit.check();
  assert(await quit.isChecked(), 'Quit choice was not selected', {});
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('kiki.desktopPrefs') ?? '{}'));
  assert(persisted.closeToTray === false, 'Quit choice was not persisted locally', persisted);
  console.log(`[proof] close choices visible and quit persisted ${JSON.stringify(persisted)}`);
} catch (error) {
  console.error('[proof] failed', error);
  throw error;
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fixture.stop();
}
