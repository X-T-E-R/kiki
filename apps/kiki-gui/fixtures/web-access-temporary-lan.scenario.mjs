/**
 * web-access-temporary-lan — a temporary entry on plain LAN HTTP with a
 * countdown and no browser signed in yet. The two things a person must not be
 * able to miss here: it is not encrypted, and "temporary" is about the clock,
 * not about permission.
 */

import spaces from './spaces.scenario.mjs';

export default {
  ...spaces,
  webAccess: {
    enabled: true,
    mode: 'temporary',
    url: 'http://192.168.1.20:58627/',
    host: '0.0.0.0',
    port: 58627,
    insecure: true,
    expiresInMs: 5 * 3_600_000 + 42 * 60_000,
    sessions: [],
  },
};
