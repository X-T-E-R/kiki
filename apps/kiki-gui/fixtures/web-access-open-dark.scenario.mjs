/**
 * web-access-open-dark — the same open entry, on a space that is set to dark.
 * The web-access card is built from the shared paper/ink/accent scale and adds
 * no colors of its own, so this is the check that it holds up in the palette a
 * person actually uses at night.
 */

import spaces from './spaces.scenario.mjs';

export default {
  ...spaces,
  spaces: {
    ...spaces.spaces,
    mainPrefs: { ...spaces.spaces?.mainPrefs, theme: 'dark' },
  },
  webAccess: {
    enabled: true,
    mode: 'persistent',
    url: 'http://192.168.1.20:58627/',
    host: '192.168.1.20',
    port: 58627,
    insecure: false,
    sessions: [
      { id: '11111111-2222-4333-8444-555555555555', label: 'Pixel · Chrome', createdAgoMs: 7_200_000, lastUsedAgoMs: 45_000, expiresInMs: 30 * 86_400_000 },
      { id: '66666666-7777-4888-8999-aaaaaaaaaaaa', label: 'Office iPad · Safari', createdAgoMs: 172_800_000, lastUsedAgoMs: 5_400_000, expiresInMs: 28 * 86_400_000 },
    ],
  },
};
