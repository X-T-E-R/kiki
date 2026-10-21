/**
 * Ego Lite on the browser settings page. The other three routes stay at the
 * fixture defaults. Checks move this route from installed, through onboarding,
 * to a CLI choice, then to a saved connection. No local Ego program is started.
 */

export default {
  sessions: [],
  snapshots: {},
  host: 'fixture-win11',
  experimentalFlags: { native_browser: true },
  browser: { connections: [] },
};
