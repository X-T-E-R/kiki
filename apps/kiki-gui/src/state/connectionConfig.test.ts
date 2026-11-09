import { describe, expect, it } from 'vitest';

import {
  applyCommittedShellCredential,
  clearAppShellCredentialState,
  hasExistingOwnerCredential,
  installAppShellCredentialListener,
  SHELL_MANAGED_STORAGE_KEY,
  SHELL_PEER_TOKEN_KEY,
  SHELL_TOKEN_EVENT,
} from '../lib/appShell';
import {
  resetWebAccessBootstrap,
  setWebAccessBootstrap,
} from '../lib/webAccess';
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

  it('applies post-commit shell credentials only for matching origin and preserves route hash and history state', () => {
    const localMap = new Map<string, string>();
    const sessionMap = new Map<string, string>();
    const localStore = {
      getItem: (key: string) => localMap.get(key) ?? null,
      setItem: (key: string, value: string) => { localMap.set(key, value); },
      removeItem: (key: string) => { localMap.delete(key); },
    };
    const sessionStore = {
      getItem: (key: string) => sessionMap.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionMap.set(key, value); },
      removeItem: (key: string) => { sessionMap.delete(key); },
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
      name: JSON.stringify({
        type: 'kiki:shell-handoff',
        origin: 'http://127.0.0.1:5494',
        token: 'untrusted-window-name-token',
      }),
      addEventListener: (type: string, listener: (event: Event) => void) => {
        target.addEventListener(type, listener as EventListener);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        target.removeEventListener(type, listener as EventListener);
      },
      dispatchEvent: (event: Event) => target.dispatchEvent(event),
    };

    const receivedEvents: Array<{ origin: string; token: string }> = [];
    const uninstall = installAppShellCredentialListener(win, (detail) => {
      receivedEvents.push(detail);
    });
    try {
      // 1. Any window.name payload is scrubbed and never trusted as a credential source
      expect(win.name).toBe('');
      expect(readStoredConfig(localStore)).toBeNull();
      expect(sessionStore.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();
      expect(receivedEvents).toEqual([]);

      // 2. Mismatched expectedOrigin is rejected
      expect(
        applyCommittedShellCredential(win, 'https://other.example.test', 'wrong-origin-token'),
      ).toBe(false);
      expect(readStoredConfig(localStore)).toBeNull();
      expect(sessionStore.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();
      expect(receivedEvents).toEqual([]);

      // 3. Matching committed origin applies credential into volatile sessionStorage only, never persisting to localStorage['kiki.connection'], and leaves pathname, search, hash, and history.state untouched
      expect(
        applyCommittedShellCredential(win, 'http://127.0.0.1:5494', 'committed-peer-token'),
      ).toBe(true);
      expect(readStoredConfig(localStore)).toBeNull();
      expect(localStore.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
      expect(localStore.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      expect(sessionStore.getItem(SHELL_PEER_TOKEN_KEY)).toBe('committed-peer-token');
      expect(receivedEvents).toEqual([
        { origin: 'http://127.0.0.1:5494', token: 'committed-peer-token' },
      ]);
      expect(win.location.pathname).toBe('/settings');
      expect(win.location.search).toBe('?tab=providers');
      expect(win.location.hash).toBe('#st-card-providers-add');
      expect(win.history.state).toEqual({ idx: 4 });
    } finally {
      uninstall();
    }
  });

  it('refuses to overwrite existing non-shell owner credentials and rejects window.name, postMessage, and unbacked events', () => {
    const localMap = new Map<string, string>();
    const sessionMap = new Map<string, string>();
    const localStore = {
      getItem: (key: string) => localMap.get(key) ?? null,
      setItem: (key: string, value: string) => { localMap.set(key, value); },
      removeItem: (key: string) => { localMap.delete(key); },
    };
    const sessionStore = {
      getItem: (key: string) => sessionMap.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionMap.set(key, value); },
      removeItem: (key: string) => { sessionMap.delete(key); },
    };
    writeStoredConfig({ url: '', token: 'existing-owner-token' }, localStore);
    expect(hasExistingOwnerCredential(localStore)).toBe(true);

    const target = new EventTarget();
    const win = {
      location: { origin: 'http://127.0.0.1:5494' },
      localStorage: localStore,
      sessionStorage: sessionStore,
      name: JSON.stringify({
        type: 'kiki:shell-handoff',
        origin: 'http://127.0.0.1:5494',
        token: 'attacker-window-name-token',
      }),
      addEventListener: (type: string, listener: (event: Event) => void) => {
        target.addEventListener(type, listener as EventListener);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        target.removeEventListener(type, listener as EventListener);
      },
      dispatchEvent: (event: Event) => target.dispatchEvent(event),
    };

    const receivedEvents: Array<{ origin: string; token: string }> = [];
    const uninstall = installAppShellCredentialListener(win, (detail) => {
      receivedEvents.push(detail);
    });
    try {
      expect(win.name).toBe('');
      expect(readStoredConfig(localStore)).toEqual({ url: '', token: 'existing-owner-token' });

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

      // 2. Direct commit-origin delivery attempt refuses to overwrite existing owner credential
      expect(
        applyCommittedShellCredential(win, 'http://127.0.0.1:5494', 'shell-attempt-token'),
      ).toBe(false);

      // 3. Even if sessionStorage and kiki:shell-token event are triggered, existing owner credential is preserved
      sessionStore.setItem(SHELL_PEER_TOKEN_KEY, 'staged-override-token');
      target.dispatchEvent(
        new CustomEvent(SHELL_TOKEN_EVENT, {
          detail: { origin: 'http://127.0.0.1:5494', token: 'staged-override-token' },
        }),
      );

      expect(readStoredConfig(localStore)).toEqual({ url: '', token: 'existing-owner-token' });
      expect(localStore.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      expect(receivedEvents).toEqual([]);
    } finally {
      uninstall();
    }
  });

  it('retires shell managed/session state after manual owner overwrite or disconnect and protects web-cookie sessions across reload', () => {
    const localMap = new Map<string, string>();
    const sessionMap = new Map<string, string>();
    const localStore = {
      getItem: (key: string) => localMap.get(key) ?? null,
      setItem: (key: string, value: string) => { localMap.set(key, value); },
      removeItem: (key: string) => { localMap.delete(key); },
    };
    const sessionStore = {
      getItem: (key: string) => sessionMap.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionMap.set(key, value); },
      removeItem: (key: string) => { sessionMap.delete(key); },
    };
    const target = new EventTarget();
    const win = {
      location: { origin: 'http://127.0.0.1:5494' },
      localStorage: localStore,
      sessionStorage: sessionStore,
      addEventListener: (type: string, listener: (event: Event) => void) => {
        target.addEventListener(type, listener as EventListener);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        target.removeEventListener(type, listener as EventListener);
      },
      dispatchEvent: (event: Event) => target.dispatchEvent(event),
    };

    try {
      // 1. Start with shell-provisioned credential (volatile in sessionStorage, retired from localStorage)
      localStore.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ url: '', token: 'legacy-shell-token' }));
      localStore.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
      expect(readStoredConfig(localStore)).toBeNull();
      expect(localStore.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
      expect(localStore.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();

      expect(applyCommittedShellCredential(win, 'http://127.0.0.1:5494', 'initial-shell-token')).toBe(true);
      expect(localStore.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
      expect(localStore.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      expect(sessionStore.getItem(SHELL_PEER_TOKEN_KEY)).toBe('initial-shell-token');

      // 2. Manual owner write (even if legacy managed marker or staged session token lingered)
      writeStoredConfig({ url: '', token: 'manual-owner-token' }, localStore);
      expect(localStore.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      // Even if a caller left a legacy managed marker alongside a different staged session token,
      // hasExistingOwnerCredential recognizes the manual override and reload retires the stale shell token.
      localStore.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
      sessionStore.setItem(SHELL_PEER_TOKEN_KEY, 'initial-shell-token');
      expect(hasExistingOwnerCredential(localStore, sessionStore)).toBe(true);

      const reloadEvents: Array<{ origin: string; token: string }> = [];
      const uninstallReload = installAppShellCredentialListener(win, (detail) => {
        reloadEvents.push(detail);
      });
      uninstallReload();
      expect(reloadEvents).toEqual([]);
      expect(readStoredConfig(localStore)).toEqual({ url: '', token: 'manual-owner-token' });
      expect(localStore.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      expect(sessionStore.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();

      // 3. Explicit disconnect clears both stored config and any staged shell token
      clearStoredConfig(localStore);
      expect(applyCommittedShellCredential(win, 'http://127.0.0.1:5494', 'second-shell-token')).toBe(true);
      clearAppShellCredentialState(win);
      clearStoredConfig(localStore);
      const afterDisconnectEvents: Array<{ origin: string; token: string }> = [];
      const uninstallAfterDisconnect = installAppShellCredentialListener(win, (detail) => {
        afterDisconnectEvents.push(detail);
      });
      uninstallAfterDisconnect();
      expect(afterDisconnectEvents).toEqual([]);
      expect(readStoredConfig(localStore)).toBeNull();
      expect(localStore.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      expect(sessionStore.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();

      // 4. Web-cookie (#access=) signed-in session is never converted to bearer by staged or live shell tokens
      localStore.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
      sessionStore.setItem(SHELL_PEER_TOKEN_KEY, 'stale-shell-token');
      setWebAccessBootstrap({ kind: 'signed-in' });
      const cookieEvents: Array<{ origin: string; token: string }> = [];
      const uninstallCookie = installAppShellCredentialListener(win, (detail) => {
        cookieEvents.push(detail);
      });
      try {
        expect(applyCommittedShellCredential(win, 'http://127.0.0.1:5494', 'live-shell-token')).toBe(false);
        expect(cookieEvents).toEqual([]);
        expect(readStoredConfig(localStore)).toBeNull();
        expect(localStore.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
        expect(sessionStore.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();
      } finally {
        uninstallCookie();
      }
    } finally {
      resetWebAccessBootstrap();
    }
  });
});
