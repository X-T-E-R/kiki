import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { spaceDesktopMock } from './space-desktop-mock.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'session_fixture_history_paging';
const HOME = 'd92a5d0d-7059-4dd4-b16b-1bc1d179f09e';

async function reconnect({ page, webUrl, fixtureUrl, control, shot }) {
  const replacement = await startFixtureServer({ port: 0, scenario: 'history-paging' });
  const replacementUrl = `http://127.0.0.1:${replacement.http.address().port}`;
  const replacementFrames = [];
  const socketStates = [];
  page.on('websocket', (socket) => {
    const state = { url: socket.url(), closed: false, ready: false, frames: [] };
    socketStates.push(state);
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(String(payload));
      state.frames.push(frame.type);
      if (frame.type === 'view_signal' && frame.data?.type === 'ready') state.ready = true;
    });
    socket.on('close', () => { state.closed = true; });
  });
  let submissions = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/sessions\/[^/]+\/prompts$/.test(new URL(request.url()).pathname)) submissions += 1;
  });
  await page.route('**/api/meta', async (route) => {
    const response = await route.fetch();
    const envelope = await response.json();
    const current = new URL(route.request().url()).origin;
    envelope.data.server_home_id = HOME;
    envelope.data.server_id = current === replacementUrl ? 'replacement-server' : 'original-server';
    envelope.data.build_id = current === replacementUrl ? 'replacement-build' : 'original-build';
    await route.fulfill({ response, json: envelope });
  });
  await page.context().addInitScript(spaceDesktopMock, {
    fixtureUrl, token: FIXTURE_TOKEN,
    spaces: [{ id: 'main', name: 'Main space', path: 'C:/Users/example/.kiki' }], windowMode: 'switch',
  });
  await page.context().addInitScript(({ fixtureUrl, token }) => {
    window.__desktopReconnectProof = { url: fixtureUrl, fail: false, discoveries: 0 };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'read_plugin_focus') return null;
      if (command === 'desktop_window_mode') return 'switch';
      if (command === 'set_unread_count' || command === 'mutate_desktop_update_state') return undefined;
      if (command !== 'desktop_connection') return invoke(command, args);
      const state = window.__desktopReconnectProof;
      state.discoveries += 1;
      if (state.fail) throw new Error('Fixture local service is restarting');
      return { url: state.url, token };
    };
  }, { fixtureUrl, token: FIXTURE_TOKEN });
  try {
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${webUrl}/new?server=${encodeURIComponent(fixtureUrl)}`, { waitUntil: 'domcontentloaded' });
    await page.locator('aside div.group', { hasText: 'Fixture: complete history paging' }).first().locator('button').first().click();
    await page.waitForURL(`**/s/${SID}`);
    const composer = page.locator('[data-composer-variant="main"] [data-composer-input]');
    const scroll = page.locator('[data-transcript-scroll]').first();
    await composer.waitFor({ timeout: 30_000 });
    await scroll.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[role="log"]')?.textContent?.includes('Reply 1199'));
    await composer.fill('Keep this unsent draft while the local service changes ports.');
    await scroll.evaluate((node) => { node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 620); });
    await page.waitForTimeout(350);
    const before = await page.evaluate(() => {
      const scroll = document.querySelector('[data-transcript-scroll]');
      const draft = document.querySelector('[data-composer-variant="main"] [data-composer-input]');
      window.__reconnectNodes = { scroll, draft };
      return { path: location.pathname, key: history.state?.key, top: scroll.scrollTop, draft: draft.textContent };
    });
    assert(before.top > 0, 'the fixture must exercise a real scrolled conversation');
    await shot('desktop-reconnect-before');
    await page.evaluate((url) => { Object.assign(window.__desktopReconnectProof, { url, fail: true }); }, replacementUrl);
    await control({ action: 'drop_ws' });
    await page.locator('[data-app-banner]', { hasText: 'Fixture local service is restarting' }).waitFor({ timeout: 10_000 });
    await shot('desktop-reconnect-retrying');
    await page.evaluate(() => { window.__desktopReconnectProof.fail = false; });
    const deadline = Date.now() + 20_000;
    let stableSince;
    let recovered = false;
    while (Date.now() < deadline) {
      const socket = socketStates.findLast((state) => state.url.startsWith(replacementUrl.replace('http:', 'ws:')));
      const visible = await page.evaluate(() => ({ discoveries: window.__desktopReconnectProof.discoveries, banner: document.querySelector('[data-app-banner]')?.textContent }));
      if (socket !== undefined && !socket.closed && socket.ready && visible.discoveries >= 3 && visible.banner === undefined) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= 1_500) { recovered = true; break; }
      } else { stableSince = undefined; }
      await page.waitForTimeout(100);
    }
    if (!recovered) console.log('[diagnostic]', JSON.stringify({ sockets: socketStates, log: await page.evaluate(() => window.__kikiConnectionLog?.()), banner: await page.locator('[data-app-banner]').textContent().catch(() => null) }));
    assert(recovered, 'replacement socket, ordered-view ready and the visible connected state must remain stable together');
    const response = await fetch(`${replacementUrl}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ws_log' }) });
    replacementFrames.push(...(await response.json()).data.inbound);
    assert(replacementFrames.some((frame) => frame.type === 'view_attach'), 'the production ordered session view must reattach to the replacement');
    const after = await page.evaluate(() => {
      const scroll = document.querySelector('[data-transcript-scroll]');
      const draft = document.querySelector('[data-composer-variant="main"] [data-composer-input]');
      return { path: location.pathname, key: history.state?.key, top: scroll.scrollTop, draft: draft.textContent,
        sameScroll: scroll === window.__reconnectNodes.scroll, sameDraft: draft === window.__reconnectNodes.draft };
    });
    assert.equal(after.path, before.path);
    assert.equal(after.key, before.key);
    assert.equal(after.draft, before.draft);
    assert(after.sameScroll && after.sameDraft, 'recovery must retain the mounted conversation and composer');
    assert(Math.abs(after.top - before.top) <= 2, `reading position moved: ${before.top} -> ${after.top}`);
    assert.equal(submissions, 0, 'recovery must not submit or replay the draft');
    await shot('desktop-reconnect-recovered');
    assert.equal(await page.locator('[data-app-banner]').count(), 0, 'the final recovery screenshot must be connected');
    const socket = socketStates.findLast((state) => state.url.startsWith(replacementUrl.replace('http:', 'ws:')));
    assert(socket !== undefined && !socket.closed && socket.ready, 'the replacement event socket must remain open with ordered recovery ready at capture');
    console.log(`[check] desktop reconnect retained route, history entry, composer, draft and scroll (${before.top} -> ${after.top}); replacement event socket open, ordered view ready and no banner stable for 1500ms; no prompt submissions`);
    await page.locator('[data-nav-settings]').click();
    await page.locator('nav [data-settings-nav-leaf="about"]').click();
    const technical = page.locator('#st-card-about [data-about-technical]');
    await technical.locator('summary').click();
    const builds = await technical.locator('dl > div').evaluateAll((rows) => Object.fromEntries(rows.map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])));
    assert.equal(builds['Desktop build'], '111111111111');
    assert.equal(builds['Server build'], 'replacement-');
    assert.equal(builds['Server ID'], 'replacement-server');
    await technical.scrollIntoViewIfNeeded();
    await shot('desktop-reconnect-build-sources');
    console.log('[check] About shows the unchanged desktop build and the authenticated replacement server build separately');
  } finally {
    await replacement.stop();
  }
}

const result = await runProof({ root, scenarios: [{ name: 'desktop-reconnect', fixture: 'history-paging', run: reconnect }], argv: process.argv.slice(2), label: 'desktop-reconnect', workers: 1, jobTimeoutMs: 90_000 });
if (result.failed.length > 0) process.exitCode = 1;
