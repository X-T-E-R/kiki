import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { spaceDesktopMock } from './space-desktop-mock.mjs';

test('space mock stages a newly created exact home without reload and reloads only at commit', async () => {
  const storage = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  };
  const created = { id: 'h-created', name: 'Client B', path: 'C:/fixture/client-b', credentials: 'isolated' };
  const timers = [];
  let reloads = 0;
  const context = vm.createContext({
    window: { location: { reload: () => { reloads += 1; } } },
    sessionStorage: storage(), localStorage: storage(), console,
    setTimeout: (callback) => { timers.push(callback); },
    fetch: async (_url, options) => {
      const { id } = JSON.parse(options.body);
      return { ok: true, json: async () => ({ data: id === created.id
        ? { active: id, space: created } : { error: 'unknown space' } }) };
    },
  });
  vm.runInContext(`(${spaceDesktopMock.toString()})(${JSON.stringify({
    fixtureUrl: 'http://127.0.0.1:41001', token: 'isolated-fixture',
    spaces: [{ id: 'main', path: 'C:/fixture/main' }], windowMode: 'switch',
  })})`, context);
  const invoke = context.window.__TAURI_INTERNALS__.invoke;
  const prepared = await invoke('prepare_space', { homeId: created.id });
  assert.equal(prepared.homeId, created.id);
  assert.equal(prepared.name, 'Client B');
  assert.equal(prepared.credentialsShared, false);
  assert.equal((await invoke('desktop_active_space')).homeId, created.id);
  assert.equal(reloads, 0);
  assert.equal(timers.length, 0);
  assert.equal(await invoke('take_scope_connection'), null);
  assert.equal(await invoke('take_navigation_intent'), null);
  await assert.rejects(invoke('prepare_space', { homeId: 'h-unknown' }), /unknown space/);
  assert.equal((await invoke('desktop_active_space')).homeId, created.id);
  await invoke('switch_space', { homeId: created.id });
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(reloads, 1);
  const calls = JSON.parse(context.sessionStorage.getItem('kiki.proof.activeSpace.commands'));
  assert.equal(calls.some((call) => Object.hasOwn(call, 'token')), false);
  const navigation = JSON.parse(context.sessionStorage.getItem('kiki.proof.activeSpace.navigation'));
  assert.deepEqual(navigation.map(({ command, status }) => [command, status]), [
    ['prepare_space', 'started'], ['prepare_space', 'ok'],
    ['prepare_space', 'started'], ['prepare_space', 'failed'],
    ['switch_space', 'started'], ['switch_space', 'ok'], ['reload', 'started'],
  ]);
  assert.equal(navigation[1].result.homeId, created.id);
  assert.equal(navigation[1].result.credentialsShared, false);
  assert.equal(JSON.stringify({ calls, navigation }).includes('isolated-fixture'), false);
});
