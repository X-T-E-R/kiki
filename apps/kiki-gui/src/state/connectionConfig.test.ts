import { describe, expect, it } from 'vitest';

import { installAppShellCredentialListener } from '../lib/appShell';
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

  it('persists a deep link only when its server is loopback or same-origin', () => {
    for (const url of [
      'http://127.0.0.1:58627',
      'http://localhost:1234',
      'https://sub.localhost:1234',
      'http://[::1]:58627',
      '',
    ]) {
      const selection = selectInitialConnection({ deepLink: { url, token: 't' } });
      expect(selection?.persist, url).toBe(true);
      expect(selection?.source, url).toBe('deep-link');
    }
    for (const url of [
      'https://attacker.example',
      'http://metadata.google.internal',
      'http://0.0.0.0',
      'file:///C:/Windows',
      'javascript:alert(1)',
      'http://127.0.0.1.attacker.example',
      'not a url',
    ]) {
      const selection = selectInitialConnection({ deepLink: { url, token: 't' } });
      expect(selection?.persist, url).toBe(false);
      // The config itself is still offered; the /meta check still runs and the
      // address stays out of localStorage.
      expect(selection?.config?.url, url).toBe(url);
    }
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

  it('accepts post-commit shell credential messages only for matching window origin and preserves hash and history state', () => {
    const localMap = new Map<string, string>();
    const sessionMap = new Map<string, string>();
    const localStore = {
      getItem: (key: string) => localMap.get(key) ?? null,
      setItem: (key: string, value: string) => { localMap.set(key, value); },
    };
    const sessionStore = {
      getItem: (key: string) => sessionMap.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionMap.set(key, value); },
    };
    const target = new EventTarget();
    const locationState = {
      origin: 'http://127.0.0.1:5494',
      pathname: '/settings',
      search: '?tab=providers',
      hash: '#st-card-providers-add',
    };
    const historyState = { state: { idx: 4 } };
    const win = {
      location: locationState,
      history: historyState,
      localStorage: localStore,
      sessionStorage: sessionStore,
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        target.addEventListener(type, listener as EventListener);
      },
      removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        target.removeEventListener(type, listener as EventListener);
      },
      dispatchEvent: (event: Event) => target.dispatchEvent(event),
    };

    const receivedEvents: Array<{ origin: string; token: string }> = [];
    const onShellToken = (event: Event) => {
      receivedEvents.push((event as CustomEvent<{ origin: string; token: string }>).detail);
    };
    target.addEventListener('kiki:shell-token', onShellToken);
    const uninstall = installAppShellCredentialListener(win);
    try {
      const acks: Array<{ message: unknown; targetOrigin: string }> = [];
      const mockSource = {
        postMessage: (message: unknown, targetOrigin: string) => {
          acks.push({ message, targetOrigin });
        },
      };

      const makeMessageEvent = (origin: string, data: unknown) => {
        const evt = new MessageEvent('message', { origin, data });
        Object.defineProperty(evt, 'source', { value: mockSource });
        return evt;
      };

      // Mismatched origin is ignored
      target.dispatchEvent(
        makeMessageEvent('http://127.0.0.1:4100', {
          type: 'kiki:shell-credential',
          origin: 'https://other.example.test',
          token: 'wrong-origin-token',
        }),
      );
      expect(readStoredConfig(localStore)).toBeNull();
      expect(sessionStore.getItem('kiki.peer.token')).toBeNull();
      expect(receivedEvents).toEqual([]);
      expect(acks).toEqual([]);

      // Matching window.location.origin is accepted, stored, acknowledged, and leaves hash/history untouched
      target.dispatchEvent(
        makeMessageEvent('http://127.0.0.1:4100', {
          type: 'kiki:shell-credential',
          origin: 'http://127.0.0.1:5494',
          token: 'committed-peer-token',
        }),
      );
      expect(readStoredConfig(localStore)).toEqual({ url: '', token: 'committed-peer-token' });
      expect(sessionStore.getItem('kiki.peer.token')).toBe('committed-peer-token');
      expect(receivedEvents).toEqual([{ origin: 'http://127.0.0.1:5494', token: 'committed-peer-token' }]);
      expect(acks).toEqual([
        {
          message: { type: 'kiki:shell-credential-ack', origin: 'http://127.0.0.1:5494' },
          targetOrigin: 'http://127.0.0.1:4100',
        },
      ]);
      expect(win.location.pathname).toBe('/settings');
      expect(win.location.search).toBe('?tab=providers');
      expect(win.location.hash).toBe('#st-card-providers-add');
      expect(win.history.state).toEqual({ idx: 4 });
    } finally {
      uninstall();
      target.removeEventListener('kiki:shell-token', onShellToken);
    }
  });
});
