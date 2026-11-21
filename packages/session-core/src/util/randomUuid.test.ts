import { describe, expect, it } from 'vitest';

import { randomUuid } from './randomUuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('randomUuid', () => {
  it('returns a valid v4 UUID when crypto.randomUUID is available', () => {
    const id = randomUuid();
    expect(id).toMatch(UUID_V4);
  });

  it('falls back cleanly via getRandomValues when crypto.randomUUID is missing on HTTP LAN', () => {
    const cryptoObj = globalThis.crypto as Crypto & { randomUUID?: () => string };
    const desc = Object.getOwnPropertyDescriptor(cryptoObj, 'randomUUID');
    Object.defineProperty(cryptoObj, 'randomUUID', { configurable: true, value: undefined });
    try {
      const a = randomUuid();
      const b = randomUuid();
      expect(a).toMatch(UUID_V4);
      expect(b).toMatch(UUID_V4);
      expect(a).not.toBe(b);
    } finally {
      if (desc === undefined) Reflect.deleteProperty(cryptoObj, 'randomUUID');
      else Object.defineProperty(cryptoObj, 'randomUUID', desc);
    }
  });
});
