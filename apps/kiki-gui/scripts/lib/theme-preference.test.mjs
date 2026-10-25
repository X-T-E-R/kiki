import assert from 'node:assert/strict';
import test from 'node:test';

import { FIXTURE_TOKEN, startFixtureServer } from '../fixture-server.mjs';
import { applyFixtureTheme, themeApplyBody, themeEditBody, themeVisibleToShell } from './theme-preference.mjs';

test('an authoritative space theme hides the device key the old wait wrote', () => {
  assert.equal(themeVisibleToShell('dark', 'light'), 'light');
  assert.equal(themeVisibleToShell('light', 'dark'), 'dark');
  assert.equal(themeVisibleToShell('dark', undefined), 'dark');
  assert.deepEqual(themeEditBody('dark'), { action: 'edit', changes: [{ id: 'pref:theme', value: 'dark' }] });
  assert.deepEqual(themeApplyBody('plan-1'), { token: 'plan-1', selected: ['pref:theme'] });
  assert.throws(() => themeEditBody('dim'), /theme preference/);
});

test('basic-stream confirms dark and light through the settings preview the shell posts', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'basic-stream' });
  const origin = `http://127.0.0.1:${server.http.address().port}`;
  const headers = { authorization: `Bearer ${FIXTURE_TOKEN}` };
  const detail = async () => {
    const response = await fetch(`${origin}/api/homes/main/settings`, { headers });
    const body = await response.json();
    assert.equal(body.code, 0);
    return body.data;
  };
  try {
    const initial = await detail();
    assert.equal(initial.preference_authority, false);
    assert.equal(initial.preferences.theme, 'system');
    const dark = await applyFixtureTheme(origin, 'dark', FIXTURE_TOKEN);
    assert.equal(dark.preference_authority, true);
    assert.equal(dark.preferences.theme, 'dark');
    assert.equal((await detail()).preferences.theme, 'dark');
    const light = await applyFixtureTheme(origin, 'light', FIXTURE_TOKEN);
    assert.equal(light.preferences.theme, 'light');
    assert.equal((await detail()).preferences.theme, 'light');
  } finally {
    await server.stop();
  }
});
