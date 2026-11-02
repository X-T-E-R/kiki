import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';
import { brokerDesktopMock } from './broker-desktop-mock.mjs';
import { FIXTURE_TOKEN } from './fixture-server.mjs';

const SID = 'session_fixture_resume_notifications';
const OTHER = 'session_fixture_resume_other';
const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'), argv: process.argv.slice(2),
  label: 'resume-notifications', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{ name: 'resume-notifications', async run({ page, link, control, shot, out }) {
    const fixtureUrl = new URL(link('/')).searchParams.get('server');
    await page.context().grantPermissions(['notifications']);
    await page.context().addInitScript(brokerDesktopMock, { aUrl: fixtureUrl, aOwner: FIXTURE_TOKEN, homeName: 'Fixture' });
    await page.context().addInitScript(() => {
      const bridge = window.__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      window.__resumeBridge = { badges: [], notifications: [] };
      bridge.invoke = async (command, args) => {
        if (command === 'desktop_window_mode') return {};
        if (command === 'read_plugin_focus') return null;
        if (command === 'mutate_desktop_update_state') return {};
        if (command === 'set_unread_count') window.__resumeBridge.badges.push(args);
        if (command === 'send_desktop_notification') {
          window.__resumeBridge.notifications.push(args);
          return;
        }
        return invoke(command, args);
      };
    });
    await page.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, data: { ...body.data, server_home_id: 'fixture-home' } } });
    });
    let completions = [];
    let completionReads = 0;
    await page.route('**/api/notifications/completions', async (route) => {
      completionReads += 1;
      await route.fulfill({ json: { code: 0, msg: 'ok', data: completions } });
    });
    const requests = [];
    page.on('request', (request) => { requests.push(new URL(request.url()).pathname); });
    await page.goto(link(`/s/${SID}`));
    const input = page.locator('[data-composer-session]').first();
    await input.waitFor();
    await page.waitForSelector('[data-transcript-virtual-item]');
    await page.waitForFunction(() => window.__resumeBridge.badges.length > 0);
    await input.fill('Keep this draft and selection while work is restored.');
    await input.evaluate((node) => {
      const view = node.cmTile.root.view;
      view.contentDOM.focus();
      view.dispatch({ selection: { anchor: 15, head: 5 } });
    });
    await page.locator('[data-transcript-scroll]').first().evaluate((node) => { node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 300); });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await shot('resume-before-metadata');
    const before = await page.evaluate(() => {
      const input = document.querySelector('[data-composer-session]');
      const scroll = document.querySelector('[data-transcript-scroll]');
      window.__resumeNodes = { input, scroll, parent: scroll.parentElement };
      window.__resumeSample = { frames: 0, empty: 0, detached: 0, focusLost: 0, maxScrollDrift: 0, maxFrameGapMs: 0, last: performance.now() };
      const top = scroll.scrollTop;
      const sample = (time) => {
        const state = window.__resumeSample;
        if (state.stopped) return;
        state.frames += 1;
        state.maxFrameGapMs = Math.max(state.maxFrameGapMs, time - state.last);
        state.last = time;
        if (!scroll.isConnected) state.detached += 1;
        if (scroll.querySelectorAll('[data-transcript-virtual-item]').length === 0) state.empty += 1;
        if (document.activeElement !== input) state.focusLost += 1;
        state.maxScrollDrift = Math.max(state.maxScrollDrift, Math.abs(scroll.scrollTop - top));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const { anchor, head } = input.cmTile.root.view.state.selection.main;
      return { badges: window.__resumeBridge.badges.length, top,
        selection: [Math.min(anchor, head), Math.max(anchor, head), anchor > head ? 'backward' : 'forward'] };
    });
    const requestStart = requests.length;
    for (let i = 0; i < 20; i += 1) {
      const title = `Resume notifications ${i + 1}`;
      const response = await fetch(`${fixtureUrl}/api/sessions/${SID}/profile`, { method: 'POST',
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
      assert.equal(response.status, 200);
      await page.waitForFunction((title) => [...document.querySelectorAll('[data-session-title]')].some((node) => node.textContent === title), title);
    }
    const metadata = await page.evaluate(() => {
      window.__resumeSample.stopped = true;
      const { input, scroll } = window.__resumeNodes;
      const view = input.cmTile.root.view;
      const { anchor, head } = view.state.selection.main;
      return { ...window.__resumeSample, badges: window.__resumeBridge.badges.length,
        sameInput: input === document.querySelector('[data-composer-session]'),
        sameScroll: scroll === document.querySelector('[data-transcript-scroll]'),
        draft: view.state.sliceDoc(),
        selection: [Math.min(anchor, head), Math.max(anchor, head), anchor > head ? 'backward' : 'forward'] };
    });
    metadata.badgeDelta = metadata.badges - before.badges;
    metadata.transcriptReads = requests.slice(requestStart).filter((path) => /transcript|\/snapshot/.test(path));
    assert.equal(metadata.badgeDelta, 0);
    assert.equal(metadata.detached, 0);
    assert.equal(metadata.empty, 0);
    assert.equal(metadata.focusLost, 0);
    assert.equal(metadata.sameInput, true);
    assert.equal(metadata.sameScroll, true);
    assert.ok(metadata.maxScrollDrift <= 1, `scroll moved ${metadata.maxScrollDrift}px`);
    assert.equal(metadata.draft, 'Keep this draft and selection while work is restored.');
    assert.deepEqual(metadata.selection, before.selection);
    assert.deepEqual(metadata.transcriptReads, []);
    assert.equal(new URL(page.url()).pathname, `/s/${SID}`);
    await shot('resume-after-metadata');

    const readyBefore = (await control({ action: 'ws_log' })).data.inbound.length;
    await control({ action: 'drop_ws' });
    await page.waitForFunction(async ({ fixtureUrl, readyBefore }) => {
      const response = await fetch(`${fixtureUrl}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ws_log' }) });
      return (await response.json()).data.inbound.length > readyBefore;
    }, { fixtureUrl, readyBefore });
    await page.locator('[data-app-banner]').waitFor({ state: 'detached' });
    assert.equal(await input.evaluate((node) => node.cmTile.root.view.state.sliceDoc()), metadata.draft);
    assert.equal(await input.evaluate((node) => document.activeElement === node), true);
    assert.equal(new URL(page.url()).pathname, `/s/${SID}`);
    await shot('resume-after-reconnect');

    await page.goto(link(`/s/${SID}/agent/child-0`));
    await page.waitForSelector('[data-agent-workspace-target="child-0"]');
    const childInput = page.locator('[data-composer-session]').last();
    await childInput.fill('Child draft stays here.');
    await childInput.focus();
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    const readsBefore = completionReads;
    completions = [SID, OTHER].map((session_id) => ({ session_id, episode_id: `resumed-${session_id}`, completed_at: Date.now() }));
    await page.waitForFunction(() => window.__resumeBridge.notifications.length === 1, undefined, { timeout: 12_000 }).catch(async (error) => {
      console.log(JSON.stringify({ completionReads, readsBefore, diagnostic: await page.evaluate(() => ({ bridge: window.__resumeBridge, focused: document.hasFocus(), visible: document.visibilityState,
        cursor: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('completionObserved'))) })) }));
      throw error;
    });
    const notified = await page.evaluate(() => window.__resumeBridge.notifications);
    assert.equal(notified[0].route, `/s/${OTHER}`);
    const firstPoll = page.waitForResponse((response) => response.url().endsWith('/api/notifications/completions'));
    await firstPoll;
    assert.equal(await childInput.evaluate((node) => node.cmTile.root.view.state.sliceDoc()), 'Child draft stays here.');
    assert.equal(await childInput.evaluate((node) => document.activeElement === node), true);
    assert.equal(new URL(page.url()).pathname, `/s/${SID}/agent/child-0`);
    assert.equal(await page.evaluate(() => window.__resumeBridge.notifications.length), 1);
    assert.ok(completionReads - readsBefore >= 2);
    await shot('resume-child-completion-keeps-focus');
    const receipt = { metadata, reconnect: { draftPreserved: true, focused: true, routePreserved: true },
      completionReads, notified, restoredChildren: 24, restoredProcesses: 16 };
    await writeFile(join(out, 'resume-notifications-receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } }],
});
if (result.failed.length > 0) process.exitCode = 1;
