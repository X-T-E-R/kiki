import { describe, expect, it } from 'vitest';

import {
  clearStoredConfig,
  CONNECTION_STORAGE_KEY,
  readDeepLinkConfig,
  readStoredConfig,
  scrubConnectionUrl,
  selectInitialConnection,
  writeStoredConfig,
} from './connectionConfig';

describe('connection config selection', () => {
  it('gives the in-memory desktop connection priority without persistence', () => {
    const desktop = { url: 'http://127.0.0.1:43123', token: 'desktop-secret' };
    expect(
      selectInitialConnection({
        desktop,
        deepLink: { url: 'https://example.test', token: 'link-secret' },
        stored: { url: 'https://stored.example.test', token: 'stored-secret' },
      }),
    ).toEqual({ config: desktop, persist: false, source: 'desktop' });
  });

  it('keeps browser deep-link then stored-config precedence', () => {
    const deepLink = { url: 'https://example.test', token: 'link-secret' };
    const stored = { url: 'https://stored.example.test', token: 'stored-secret' };
    expect(selectInitialConnection({ deepLink, stored })?.config).toEqual(deepLink);
    expect(selectInitialConnection({ stored })?.config).toEqual(stored);
  });
});
describe('connection config readers', () => {
  it('reads query and fragment handoffs', () => {
    expect(readDeepLinkConfig({ search: '?server=http%3A%2F%2Flocalhost%3A1234&token=abc', hash: '' })).toEqual({
      url: 'http://localhost:1234',
      token: 'abc',
    });
    expect(readDeepLinkConfig({ search: '', hash: '#token=fragment%20token' })).toEqual({
      url: '',
      token: 'fragment token',
    });
  });

  it('preserves non-connection query and fragment parameters when scrubbing', () => {
    expect(
      scrubConnectionUrl({
        pathname: '/new',
        search: '?agent=reviewer%2Ffast&workspace=demo+workspace',
        hash: '#view=details',
      }),
    ).toBe('/new?agent=reviewer%2Ffast&workspace=demo+workspace#view=details');
  });

  it('removes every consumed connection parameter while retaining the rest', () => {
    expect(
      scrubConnectionUrl({
        pathname: '/new',
        search:
          '?agent=reviewer&server=https%3A%2F%2Fexample.test&url=https%3A%2F%2Ffallback.example.test&token=query-secret',
        hash: '#token=fragment-secret&view=details',
      }),
    ).toBe('/new?agent=reviewer#view=details');
  });

  it('rejects malformed stored values', () => {
    expect(readStoredConfig({ getItem: () => '{bad json' })).toBeNull();
    expect(readStoredConfig({ getItem: () => JSON.stringify({ url: 1, token: 'abc' }) })).toBeNull();
  });

  it('treats browser storage writes and clears as best-effort', () => {
    const writes: Array<{ key: string; value: string }> = [];
    expect(
      writeStoredConfig(
        { url: 'https://example.test', token: 'secret' },
        { setItem: (key, value) => { writes.push({ key, value }); } },
      ),
    ).toBe(true);
    expect(writes).toEqual([
      {
        key: CONNECTION_STORAGE_KEY,
        value: JSON.stringify({ url: 'https://example.test', token: 'secret' }),
      },
    ]);

    expect(writeStoredConfig({ url: '', token: '' }, { setItem: () => { throw new Error('full'); } })).toBe(false);
    expect(clearStoredConfig({ removeItem: () => { throw new Error('blocked'); } })).toBe(false);
  });
});
