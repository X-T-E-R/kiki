import { describe, expect, it } from 'vitest';

import {
  consumeAppShellHandoff,
  createShellHandoffEnvelope,
  installAppShellCredentialListener,
  SHELL_HANDOFF_MAX_AGE_MS,
} from '../lib/appShell';
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

  it('consumes one-time shell handoff only for matching origin in the KikiApp shell and preserves hash and history state', () => {
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
    const now = 1_700_000_000_000;
    const win = {
      location: locationState,
      history: historyState,
      localStorage: localStore,
      sessionStorage: sessionStore,
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 16; wv) KikiApp/android' },
      opener: null as unknown,
      parent: undefined as unknown,
      name: '',
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        target.addEventListener(type, listener as EventListener);
      },
      removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        target.removeEventListener(type, listener as EventListener);
      },
      dispatchEvent: (event: Event) => target.dispatchEvent(event),
    };
    win.parent = win;

    const receivedEvents: Array<{ origin: string; token: string }> = [];
    const onShellToken = (event: Event) => {
      receivedEvents.push((event as CustomEvent<{ origin: string; token: string }>).detail);
    };
    target.addEventListener('kiki:shell-token', onShellToken);
    try {
      // 1. Mismatched origin handoff is scrubbed and ignored
      win.name = JSON.stringify(
        createShellHandoffEnvelope('https://other.example.test', 'wrong-origin-token', now),
      );
      expect(consumeAppShellHandoff(win, now)).toBe(false);
      expect(win.name).toBe('');
      expect(readStoredConfig(localStore)).toBeNull();
      expect(sessionStore.getItem('kiki.peer.token')).toBeNull();
      expect(receivedEvents).toEqual([]);

      // 2. Expired or forged-signature handoff is scrubbed and ignored
      win.name = JSON.stringify(
        createShellHandoffEnvelope(
          'http://127.0.0.1:5494',
          'expired-token',
          now - SHELL_HANDOFF_MAX_AGE_MS - 1,
        ),
      );
      expect(consumeAppShellHandoff(win, now)).toBe(false);
      expect(win.name).toBe('');
      expect(readStoredConfig(localStore)).toBeNull();

      win.name = JSON.stringify({
        ...createShellHandoffEnvelope('http://127.0.0.1:5494', 'forged-sig-token', now),
        sig: '0000000000000000',
      });
      expect(consumeAppShellHandoff(win, now)).toBe(false);
      expect(win.name).toBe('');
      expect(readStoredConfig(localStore)).toBeNull();

      // 3. Matching origin in KikiApp shell is consumed once, scrubs window.name, and leaves hash/history untouched
      win.name = JSON.stringify(
        createShellHandoffEnvelope('http://127.0.0.1:5494', 'committed-peer-token', now),
      );
      expect(consumeAppShellHandoff(win, now)).toBe(true);
      expect(win.name).toBe('');
      expect(readStoredConfig(localStore)).toEqual({ url: '', token: 'committed-peer-token' });
      expect(sessionStore.getItem('kiki.peer.token')).toBe('committed-peer-token');
      expect(receivedEvents).toEqual([
        { origin: 'http://127.0.0.1:5494', token: 'committed-peer-token' },
      ]);
      expect(win.location.pathname).toBe('/settings');
      expect(win.location.search).toBe('?tab=providers');
      expect(win.location.hash).toBe('#st-card-providers-add');
      expect(win.history.state).toEqual({ idx: 4 });
    } finally {
      target.removeEventListener('kiki:shell-token', onShellToken);
    }
  });

  it('rejects malicious opener, cross-window postMessage, and non-shell browser overwrite attempts with zero credential mutation', () => {
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
    writeStoredConfig({ url: '', token: 'existing-owner-token' }, localStore);

    const target = new EventTarget();
    const win = {
      location: { origin: 'http://127.0.0.1:5494' },
      localStorage: localStore,
      sessionStorage: sessionStore,
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      },
      opener: null as unknown,
      parent: undefined as unknown,
      name: '',
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        target.addEventListener(type, listener as EventListener);
      },
      removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        target.removeEventListener(type, listener as EventListener);
      },
      dispatchEvent: (event: Event) => target.dispatchEvent(event),
    };
    win.parent = win;

    const receivedEvents: Array<{ origin: string; token: string }> = [];
    const onShellToken = (event: Event) => {
      receivedEvents.push((event as CustomEvent<{ origin: string; token: string }>).detail);
    };
    target.addEventListener('kiki:shell-token', onShellToken);
    const uninstall = installAppShellCredentialListener(win);
    try {
      // 1. Cross-window / opener or same-origin forged postMessage is completely ignored
      for (const senderOrigin of ['https://evil.example.test', 'http://127.0.0.1:5494']) {
        const evt = new MessageEvent('message', {
          origin: senderOrigin,
          data: {
            type: 'kiki:shell-credential',
            origin: 'http://127.0.0.1:5494',
            token: 'attacker-postmessage-token',
          },
        });
        target.dispatchEvent(evt);
      }
      expect(readStoredConfig(localStore)).toEqual({ url: '', token: 'existing-owner-token' });
      expect(sessionStore.getItem('kiki.peer.token')).toBeNull();
      expect(receivedEvents).toEqual([]);

      // 2. Ordinary top-level browser page (non-KikiApp UA) rejects even a validly signed window.name handoff
      win.name = JSON.stringify(
        createShellHandoffEnvelope('http://127.0.0.1:5494', 'attacker-handoff-token'),
      );
      expect(consumeAppShellHandoff(win)).toBe(false);
      expect(win.name).toBe('');
      expect(readStoredConfig(localStore)).toEqual({ url: '', token: 'existing-owner-token' });

      // 3. Even inside KikiApp UA, a popup with window.opener !== null or a subframe is rejected
      win.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) KikiApp/ios' };
      win.opener = { postMessage: () => {} };
      win.name = JSON.stringify(
        createShellHandoffEnvelope('http://127.0.0.1:5494', 'attacker-opener-token'),
      );
      expect(consumeAppShellHandoff(win)).toBe(false);
      expect(win.name).toBe('');
      expect(readStoredConfig(localStore)).toEqual({ url: '', token: 'existing-owner-token' });
      expect(sessionStore.getItem('kiki.peer.token')).toBeNull();
      expect(receivedEvents).toEqual([]);
    } finally {
      uninstall();
      target.removeEventListener('kiki:shell-token', onShellToken);
    }
  });
});
