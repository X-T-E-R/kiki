import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '../../../..', 'tasks', 'task-0043', 'research', 'visual');
await mkdir(output, { recursive: true });
const fixture = await startFixtureServer({ port: 0, scenario: 'first-open' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
const state = { allowed: true, host_locked: false, default_on: true, origin: 'default', unresolved: false };
const headers = { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKEN}` };
const seeded = await fetch(`${endpoint}/api/config`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    optional_capabilities: {
      browser: { ...state, default_on: false },
      computer: { ...state, default_on: false },
      memory: state,
      thread: state,
      web: state,
    },
  }),
});
assert.equal(seeded.status, 200);
const preview = await fetch(`${endpoint}/api/sessions/session_fixture_first_open/optional-capabilities`, { headers });
const previewBody = await preview.json();
assert.equal(preview.status, 200);
assert.equal(previewBody.code, 0, JSON.stringify(previewBody));
const previewBrowser = previewBody.data.rows.find((row) => row.id === 'browser');
assert.equal(previewBrowser.reason, 'unbound');
assert.equal(previewBrowser.source, 'default');
const previewThread = previewBody.data.rows.find((row) => row.id === 'thread');
assert.equal(previewThread.effective, true);
assert.equal(previewThread.default_on, true);
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const evidence = { mock: true, shell: 'fixture-klient', endpoint, checks: [], errors: [], responses: [] };
page.on('pageerror', (error) => evidence.errors.push(error.message));
page.on('response', async (response) => {
  const path = new URL(response.url()).pathname;
  if (!path.includes('optional-capabilities') && !path.endsWith('/config') && !path.endsWith('/memory/settings')) return;
  try {
    const body = await response.json();
    evidence.responses.push({ path, http: response.status(), code: body.code, msg: body.code === 0 ? undefined : body.msg });
  } catch { /* non-json */ }
});
await page.addInitScript(() => localStorage.setItem('kiki.locale', 'zh'));
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const sessionUrl = `${origin}/s/session_fixture_first_open?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;

async function dump(name) {
  evidence.body = await page.locator('body').innerText().then((text) => text.slice(0, 4000)).catch(() => '');
  evidence.capabilities = await page.locator('[data-rail-capabilities]').evaluateAll((nodes) => nodes.map((node) => ({
    expanded: node.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') ?? null,
    text: node.innerText.slice(0, 2000),
  }))).catch(() => []);
  await page.screenshot({ path: join(output, name) }).catch(() => undefined);
  await writeFile(join(output, 'shell-proof.json'), JSON.stringify(evidence, null, 2));
}

async function showRail() {
  const rail = page.locator('[data-session-rail]');
  if (await rail.count() === 0 || !(await rail.first().isVisible())) {
    const toggle = page.locator('[data-rail-toggle]');
    // Below lg the session header keeps no rail toggle; the routed agent page
    // carries the rail as its own drawer there, so this walk stays wide.
    if (await toggle.count() > 0) await toggle.first().click();
  }
  await rail.first().waitFor({ state: 'visible', timeout: 20_000 });
  const capabilities = page.locator('[data-rail-capabilities]').first();
  await capabilities.scrollIntoViewIfNeeded();
}

try {
  await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => document.querySelector('textarea[data-composer]'), { timeout: 30_000 });
  await showRail();
  const section = page.locator('[data-rail-capabilities]').first();
  await section.waitFor({ state: 'visible', timeout: 45_000 });
  await section.scrollIntoViewIfNeeded();
  const fold = section.locator('button[aria-expanded]').first();
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
  await page.waitForFunction(() => document.querySelector('[data-rail-capabilities] button[aria-expanded="true"]'), { timeout: 10_000 });
  const thread = section.locator('[data-optional-capability="thread"]');
  await thread.waitFor({ state: 'visible', timeout: 15_000 });
  await expectText(thread, '线程通信');
  assert.equal(await thread.getAttribute('data-optional-effective'), 'true');
  assert.equal(await section.locator('[data-optional-capability="web"]').getAttribute('data-optional-effective'), 'true');
  assert.equal(await section.locator('[data-optional-capability="memory"]').getAttribute('data-optional-effective'), 'true');
  const browserCap = section.locator('[data-optional-capability="browser"]');
  assert.equal(await browserCap.getAttribute('data-optional-effective'), 'false');
  assert.equal(await browserCap.getAttribute('data-optional-reason'), 'unbound');
  assert.equal(await section.locator('[data-optional-capability="computer"]').getAttribute('data-optional-effective'), 'false');
  evidence.checks.push('wide rail shows default-on thread/web/memory and default-off browser/computer');
  await thread.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, '05-rail-wide.png') });
  await browserCap.locator('[data-optional-set="on"]').click();
  await page.waitForFunction(() => document.querySelector('[data-optional-capability="browser"] [data-optional-fact="browser"]')?.textContent?.includes('本会话开启'));
  evidence.checks.push('turning browser on shows the session source and restore action from the server row');
  await page.setViewportSize({ width: 390, height: 844 });
  // Below lg the session shell has no rail at all; nothing may leak into the
  // narrow page (same expectation the notes-rail walker pins).
  const narrowRail = page.locator('[data-session-rail]');
  assert.equal(await narrowRail.count(), 0, 'the narrow session view still shows the rail');
  assert.equal(await page.locator('[data-rail-toggle]').count(), 0, 'the narrow session view still offers the rail toggle');
  evidence.checks.push('narrow shell hides the rail and its toggle');
  await page.setViewportSize({ width: 1280, height: 900 });
  await showRail();
  const narrowSection = page.locator('[data-rail-capabilities]').first();
  await narrowSection.waitFor({ state: 'visible', timeout: 20_000 });
  const narrowFold = narrowSection.locator('button[aria-expanded]').first();
  if ((await narrowFold.getAttribute('aria-expanded')) !== 'true') await narrowFold.click();
  const narrowBrowser = narrowSection.locator('[data-optional-capability="browser"]');
  await narrowBrowser.waitFor({ state: 'visible', timeout: 15_000 });
  await expectText(narrowBrowser.locator('[data-optional-fact="browser"]'), '本会话开启');
  await narrowBrowser.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, '06-rail-narrow.png') });
  evidence.checks.push('the rail keeps the same switch control and the saved session choice across a width round trip');

  await page.locator('[data-nav-settings]').filter({ visible: true }).first().click();
  const memoryLeaf = page.locator('[data-settings-nav-leaf="memory"]');
  await memoryLeaf.waitFor({ timeout: 20_000 });
  await memoryLeaf.click();
  const allow = page.locator('#memory-enabled');
  await allow.waitFor({ state: 'attached', timeout: 30_000 });
  const allowSwitch = page.locator('label:has(#memory-enabled) [role="switch"]');
  await allowSwitch.scrollIntoViewIfNeeded();
  assert.equal(await allow.isChecked(), true);
  await page.screenshot({ path: join(output, '07-memory-settings.png') });
  await allowSwitch.click();
  await page.waitForFunction(() => document.querySelector('#memory-enabled')?.checked === false, { timeout: 15_000 });
  await page.locator('[data-save-status="saving"]').waitFor({ state: 'detached', timeout: 15_000 });
  await page.screenshot({ path: join(output, '08-memory-settings-off.png') });
  evidence.checks.push('memory allow switch follows the capability config on the same page');
  assert.deepEqual(evidence.errors, []);
  await writeFile(join(output, 'shell-proof.json'), JSON.stringify(evidence, null, 2));
} catch (error) {
  await dump('05-rail-wide-failed.png');
  throw error;
} finally {
  await browser.close();
  await vite.close();
  await fixture.stop();
}

async function expectText(locator, text) {
  await locator.waitFor();
  const seen = await locator.innerText();
  assert.equal(seen.includes(text), true, seen);
}
