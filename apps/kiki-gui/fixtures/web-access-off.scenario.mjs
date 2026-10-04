/**
 * web-access-off — the entry point is closed. This is the state a person meets
 * first, and the one that has to answer "can anything reach my Kiki?" without
 * a wall of fields.
 */

import spaces from './spaces.scenario.mjs';

export default {
  ...spaces,
  webAccess: {
    enabled: false,
    mode: null,
    host: '192.168.1.20',
    port: 58627,
    insecure: false,
  },
};
