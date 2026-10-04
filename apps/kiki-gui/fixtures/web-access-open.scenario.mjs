/**
 * web-access-open — an always-on entry with two browsers already signed in.
 * The permission sentence and the per-browser sign-out both have to be visible
 * at the same time: one says what a link is, the other says how you take it
 * back.
 */

import spaces from './spaces.scenario.mjs';

export default {
  ...spaces,
  webAccess: {
    enabled: true,
    mode: 'persistent',
    url: 'http://192.168.1.20:58627/',
    host: '192.168.1.20',
    port: 58627,
    insecure: false,
    sessions: [
      // UUID-shaped, because the contract validates the id with `z.string().uuid()`.
      { id: '11111111-2222-4333-8444-555555555555', label: 'Pixel · Chrome', createdAgoMs: 7_200_000, lastUsedAgoMs: 45_000, expiresInMs: 30 * 86_400_000 },
      { id: '66666666-7777-4888-8999-aaaaaaaaaaaa', label: 'Office iPad · Safari', createdAgoMs: 172_800_000, lastUsedAgoMs: 5_400_000, expiresInMs: 28 * 86_400_000 },
    ],
  },
};
