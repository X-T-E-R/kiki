import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof } from '../proof/runner.mjs';
import { brokerDesktopMock } from './broker-desktop-mock.mjs';
import { FIXTURE_TOKEN } from './fixture-server.mjs';

const result = await runProof({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'), argv: process.argv.slice(2),
  label: 'completion-notification', workers: 1, jobTimeoutMs: 120_000,
  scenarios: [{ name: 'completion-notification', async run({ page, link, control, shot, out }) {
    const fixtureUrl = new URL(link('/')).searchParams.get('server');
    await page.context().grantPermissions(['notifications']);
    await page.context().addInitScript(brokerDesktopMock, { aUrl: fixtureUrl, aOwner: FIXTURE_TOKEN, homeName: 'Fixture' });
    await page.context().addInitScript(() => {
      const bridge = window.__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      const transform = bridge.transformCallback;
      const callbacks = new Map();
      const listeners = new Map();
      const state = JSON.parse(sessionStorage.getItem('completion-bridge') ?? 'null') ?? { sent: [], acknowledged: [], retained: [], badges: [] };
      const save = () => sessionStorage.setItem('completion-bridge', JSON.stringify(state));
      bridge.transformCallback = (callback, once) => { const id = transform(callback, once); callbacks.set(id, callback); return id; };
      window.__completionBridge = { state, focused: true, click: (notification) => {
        const callback = callbacks.get(listeners.get('kiki://notification-click'));
        if (callback === undefined) throw new Error('Notification click consumer is not registered');
        callback({ payload: { route: notification.route, scope: notification.scope, homeId: notification.scope.homeId, navigationId: String(state.sent.length) } });
      } };
      bridge.invoke = async (command, args) => {
        if (command === 'plugin:event|listen') listeners.set(args.event, args.handler);
        if (command === 'plugin:window|is_focused') return window.__completionBridge.focused;
        if (command === 'desktop_window_mode') return {};
        if (command === 'read_plugin_focus') return null;
        if (command === 'mutate_desktop_update_state') return {};
        if (command === 'ack_navigation_intent') return;
        if (command === 'set_unread_count') { state.badges.push(args); save(); return; }
        if (command === 'send_desktop_notification') { state.sent.push(args); state.retained.push(args); save(); return; }
        if (command === 'acknowledge_desktop_notifications') {
          state.acknowledged.push(args);
          state.retained = state.retained.filter((entry) => {
            if (JSON.stringify(entry.scope) !== JSON.stringify(args.scope) || (args.deliveryId !== undefined && entry.deliveryId !== args.deliveryId)) return true;
            entry.sessionIds = entry.sessionIds.filter((id) => id !== args.sessionId);
            return entry.sessionIds.length > 0;
          });
          save(); return;
        }
        return invoke(command, args);
      };
    });
    await page.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, data: { ...body.data, server_home_id: 'fixture-home' } } });
    });
    const state = () => page.evaluate(() => window.__completionBridge.state);
    const open = async (route) => { await page.goto(link(route)); await page.waitForResponse((response) => response.url().endsWith('/api/notifications/completions')); };
    await open('/s/conversation-b');
    await page.locator('[data-composer-session]').first().waitFor();
    await page.waitForFunction(() => window.__completionBridge.state.acknowledged.some((entry) => entry.sessionId === 'conversation-b'));
    await page.goto(link('/s/conversation-a'));
    await page.locator('[data-composer-session]').first().waitFor();
    await page.waitForFunction(() => window.__completionBridge.state.acknowledged.some((entry) => entry.sessionId === 'conversation-a')).catch(async (error) => {
      console.log('acknowledgment diagnostic', await state()); throw error;
    });
    assert.equal(await page.locator('[data-session-row="conversation-b"]').getAttribute('data-session-row-state'), 'read');
    await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith('kiki.completionObserved.v1:') && key.includes('"scopeId":"local","serverHomeId":"fixture-home"')));
    const b = { session_id: 'conversation-b', episode_id: 'finished-b', completed_at: Date.now() };
    await control({ action: 'notification_completions', completions: [b] });
    await page.waitForFunction(() => window.__completionBridge.state.sent.length === 1).catch(async (error) => {
      console.log('completion diagnostic', await page.evaluate(() => ({ state: window.__completionBridge.state,
        cursor: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('completionObserved'))),
        focused: document.hasFocus(), visible: document.visibilityState, prefs: localStorage.getItem('kiki.desktop') })));
      throw error;
    });
    assert.equal((await state()).sent[0].route, '/s/conversation-b');
    assert.equal(await page.locator('[data-session-row="conversation-b"]').getAttribute('data-session-row-state'), 'unread');
    await shot('completion-b-unread-while-viewing-a');
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
    await open('/settings');
    await open('/s/conversation-a');
    assert.equal(await page.locator('[data-session-row="conversation-b"]').getAttribute('data-session-row-state'), 'unread');
    const afterA = await state();
    assert.equal(afterA.retained.length, 1);
    assert.equal(afterA.acknowledged.filter((entry) => entry.sessionId === 'conversation-b').length, 1);
    const c = { session_id: 'conversation-c', episode_id: 'finished-c', completed_at: Date.now() };
    await control({ action: 'notification_completions', completions: [b, c] });
    await page.waitForFunction(() => window.__completionBridge.state.sent.length === 2);
    await page.reload();
    await page.locator('[data-composer-session]').first().waitFor();
    await page.waitForResponse((response) => response.url().endsWith('/api/notifications/completions'));
    assert.equal((await state()).sent.length, 2);
    assert.equal(await page.locator('[data-session-row="conversation-b"]').getAttribute('data-session-row-state'), 'unread');
    assert.equal(await page.locator('[data-session-row="conversation-c"]').getAttribute('data-session-row-state'), 'unread');
    await control({ action: 'drop_ws' });
    await page.evaluate(() => { window.__completionBridge.focused = false; });
    await page.evaluate(() => window.__completionBridge.click(window.__completionBridge.state.sent[0]));
    await page.waitForURL((url) => url.pathname === '/s/conversation-b');
    await page.locator('[data-composer-session]').first().waitFor();
    assert.equal((await state()).retained.length, 2);
    await page.evaluate(() => { window.__completionBridge.focused = true; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => window.__completionBridge.state.retained.length === 1);
    assert.equal(await page.locator('[data-session-row="conversation-b"]').getAttribute('data-session-row-state'), 'read');
    assert.equal(await page.locator('[data-session-row="conversation-c"]').getAttribute('data-session-row-state'), 'unread');
    const final = await state();
    assert.deepEqual(final.retained[0].sessionIds, ['conversation-c']);
    assert.equal(final.acknowledged.at(-1).sessionId, 'conversation-b');
    assert.equal(final.acknowledged.at(-1).scope.serverHomeId, 'fixture-home');
    await shot('completion-click-b-retains-c');
    await writeFile(join(out, 'completion-notification-receipt.json'), JSON.stringify({ ...final, targetRoute: new URL(page.url()).pathname, reopenedWithoutDuplicate: true, focusAndOtherRoutesRetained: true, backgroundTargetRetainedUntilFocus: true }, null, 2));
  } }],
});
if (result.failed.length > 0) process.exitCode = 1;
