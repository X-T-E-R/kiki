/**
 * The theme switch the shell actually resolves.
 *
 * `theme` is space-portable. Once the space bridge is installed, `readSettings`
 * spreads the bridge over the device `kiki.settings` record, so writing that
 * key and dispatching a same-window `storage` event republishes the old space
 * theme. `<html data-theme>` never moves, and a wait on it expires.
 *
 * Appearance posts the change as a settings preview/apply (`pref:theme`). The
 * fixture serves that route for every scenario, including `basic-stream`.
 */

export const THEME_PREFERENCE_ID = 'pref:theme';

const THEME_PREFERENCES = new Set(['light', 'dark', 'system']);

export function themeEditBody(theme) {
  if (!THEME_PREFERENCES.has(theme)) throw new Error(`theme preference must be light, dark, or system, got ${theme}`);
  return { action: 'edit', changes: [{ id: THEME_PREFERENCE_ID, value: theme }] };
}

export function themeApplyBody(token) {
  return { token, selected: [THEME_PREFERENCE_ID] };
}

/** Bridge theme wins. A missing bridge key leaves the device value visible. */
export function themeVisibleToShell(deviceTheme, bridgeTheme) {
  return bridgeTheme === undefined ? deviceTheme : bridgeTheme;
}

async function fixtureData(fixtureUrl, token, path, data) {
  const response = await fetch(`${fixtureUrl}/api${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`theme preference ${path} failed: ${body.msg ?? response.status}`);
  }
  return body.data;
}

/** Confirm `theme` on the page's current space. Returns the applied detail. */
export async function applyFixtureTheme(fixtureUrl, theme, token) {
  const meta = await fixtureData(fixtureUrl, token, '/meta');
  if (!meta?.current_space_id) throw new Error('theme fixture has no confirmed space');
  const path = `/homes/${encodeURIComponent(meta.current_space_id)}/settings`;
  const preview = await fixtureData(fixtureUrl, token, `${path}/preview`, themeEditBody(theme));
  const applied = await fixtureData(fixtureUrl, token, `${path}/apply`, themeApplyBody(preview.token));
  if (applied.detail?.preference_authority !== true || applied.detail.preferences?.theme !== theme) {
    throw new Error(`theme fixture did not confirm ${theme}`);
  }
  return applied.detail;
}
