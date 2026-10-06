// @vitest-environment jsdom

import { StrictMode, act, useLayoutEffect, useState } from 'react';
import { createMemoryRouter, RouterProvider, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { DirtyGuardContext, useDirtyGuardState, useGuardedNavigate } from '../components/dirtyGuard';
import { NavScopeBoundary } from '../components/NavScopeBoundary';
import { clearNavHistory, getCurrentVisit, recordNavigation } from '../lib/navHistory';
import { SpaceSwitcher } from '../components/SpaceSwitcher';
import { SpacesSection } from '../components/settings/SpacesSection';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeDesktopPrefs, writeSettings } from '@kiki/session-core/settings';
import type { SessionController } from '@kiki/session-core/session';
import { browserHost, HostProvider } from '../host';
import { I18nProvider } from '../i18n';
import { ConnectionSection } from '../components/settings/ConnectionSection';
import { ConnectionProvider, handleGlobalConnectionFrame, LiveControllerRegistry, nextGuiLeaseClientId, useConnection } from './connection';

const mocks = vi.hoisted(() => ({
  detectLocalConnection: vi.fn(),
  invoke: vi.fn(),
  meta: vi.fn(),
  homes: vi.fn(),
  renewLease: vi.fn(),
  klients: [] as Array<{
    endpoint: string;
    token?: string;
    timeoutMs?: number;
    closed: boolean;
    close: ReturnType<typeof vi.fn>;
    global: { mcp: { list: ReturnType<typeof vi.fn> } };
    events: { on: ReturnType<typeof vi.fn> };
    terminal: { onStatus: ReturnType<typeof vi.fn> };
  }>,
  terminalSubscriptions: [] as Array<{
    baseUrl: string;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  stageListener: undefined as ((event: { payload: unknown }) => void) | undefined,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) =>
    command === 'desktop_connection'
      ? Promise.resolve(mocks.detectLocalConnection()).then((connection) => connection.config)
      : command === 'take_scope_connection' ? Promise.resolve(null)
      : mocks.invoke(command === 'prepare_ssh_profile' ? 'connect_ssh_profile' : command, args),
  isTauri: () => true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_event: string, listener: (event: { payload: unknown }) => void) => {
    if (_event === 'kiki://desktop-backend-stage') mocks.stageListener = listener;
    return Promise.resolve(() => {
      if (mocks.stageListener === listener) mocks.stageListener = undefined;
    });
  }),
}));

vi.mock('../lib/busySessionsHook', () => ({ useBusySessionCount: () => 0 }));

vi.mock('../lib/client', () => ({
  ApiError: class ApiError extends Error {},
  KikiClient: class KikiClient {
    readonly baseUrl: string;
    readonly klient;

    constructor(options: { baseUrl: string; token?: string; timeoutMs?: number }) {
      this.baseUrl = options.baseUrl;
      const klient = {
        endpoint: options.baseUrl, token: options.token, timeoutMs: options.timeoutMs, closed: false,
        close: vi.fn(async () => { klient.closed = true; }),
        rest: { homes: { list: () => {
          if (klient.closed) throw new Error('klient closed');
          return mocks.homes(options.baseUrl);
        } } },
        global: { mcp: { list: vi.fn(async () => {
          if (klient.closed) throw new Error('klient closed');
          return [];
        }) } },
        events: { on: vi.fn(() => ({ dispose: vi.fn(), ready: Promise.resolve() })) },
        terminal: {
          nudge: vi.fn(),
          onTerminalSignal: vi.fn(() => {
            if (klient.closed) throw new Error('http closed');
            return () => {};
          }),
          onStatus: vi.fn(() => {
            const subscription = { baseUrl: options.baseUrl, connect: vi.fn(), close: vi.fn() };
            subscription.connect();
            mocks.terminalSubscriptions.push(subscription);
            return subscription.close;
          }),
        },
      };
      this.klient = klient;
      mocks.klients.push(klient);
    }

    meta() { return mocks.meta(this.baseUrl); }
    getSession(id: string) { return Promise.resolve({ id }); }
    renewLease(body: { clientId: string; kind: 'gui' }) { return mocks.renewLease(body); }
  },
}));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function ConnectedHarness() {
  const connection = useConnection();
  const queryClient = useQueryClient();
  const [switchError, setSwitchError] = useState('');
  return <>
    <span data-switch-error>{switchError}</span>
    <span data-connected-url>{connection.config.url}</span>
    <span data-scope-id>{connection.scopeId}</span>
    <span data-local-control-url>{connection.localClient?.baseUrl ?? 'pending'}</span>
    <span data-cache-value>{queryClient.getQueryData(['workspaces']) ?? 'empty'}</span>
    <button type="button" data-write-cache onClick={() => {
      queryClient.setQueryData(['workspaces'], connection.scopeId);
    }} />
    <button type="button" data-switch-ssh onClick={() => {
      void connection.activateSshProfile('host-1', 'a'.repeat(43)).catch((error: unknown) => { setSwitchError(String(error)); });
    }} />
    <button type="button" data-switch-local onClick={connection.activateLocal} />
    <button type="button" data-switch-manual onClick={() => { connection.applyConnection({ url: 'http://peer.example.test:8080', token: 'peer-token' }); }} />
  </>;
}

function NavigationObserver() {
  const connection = useConnection();
  const location = useLocation(); const action = useNavigationType();
  useLayoutEffect(() => {
    recordNavigation({ location, scope: { homeId: 'main', scopeId: connection.scopeId, serverHomeId: connection.meta.server_home_id, connectionRef: connection.connectionRef }, action });
  }, [location, action, connection.scopeId, connection.meta.server_home_id, connection.connectionRef]);
  return null;
}

let returnedConnection: ReturnType<typeof useConnection> | undefined;
function BrowserReturnHarness() {
  returnedConnection = useConnection();
  const location = useLocation(); const navigate = useGuardedNavigate();
  return <>
    <span data-return-route>{location.pathname}</span>
    <button data-return-board onClick={() => { navigate('/board'); }} />
    <button data-return-back onClick={() => { navigate(-1); }} />
  </>;
}

function SwitcherHarness() {
  const location = useLocation();
  const rawNavigate = useNavigate();
  const guard = useDirtyGuardState(location, (target, options) => {
    if (typeof target === 'number') void rawNavigate(target);
    else void rawNavigate(target, options);
  });
  const [error, setError] = useState('');
  return <DirtyGuardContext.Provider value={guard.value}>
    <span data-switcher-route>{location.pathname}{location.search}</span>
    <span data-guard-dirty>{String(guard.value.dirty)}</span>
    <span data-restore-error>{error}</span>
    <input data-settings-draft defaultValue="unsaved local routing draft" />
    <button data-dirty-editor onClick={() => guard.value.reportDirty('provider-editor', true)} />
    <button data-confirm-leave onClick={() => { void Promise.resolve().then(guard.confirm).catch((failure: unknown) => {
      if (failure instanceof Error && failure.name === 'AbortError') return;
      setError(failure instanceof Error ? failure.message : String(failure));
    }); }} />
    <button data-cancel-leave onClick={guard.cancel} />
    <SpaceSwitcher /><SpacesSection />
  </DirtyGuardContext.Provider>;
}

function StrictLifecycleHarness() {
  const connection = useConnection();
  return (
    <>
      <span data-connected-url>{connection.config.url}</span>
      <button type="button" data-list-mcp onClick={() => void connection.klient.global.mcp.list()} />
      <button
        type="button"
        data-equivalent-pair
        onClick={() => connection.applyConnection({
          url: 'http://127.0.0.1:41001////',
          token: 'strict-token',
        })}
      />
      <button
        type="button"
        data-changed-pair
        onClick={() => connection.applyConnection({
          url: 'http://127.0.0.1:42002/',
          token: ' next-token ',
        })}
      />
    </>
  );
}

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal('__KIKI_PROXY_TARGET__', 'http://127.0.0.1:58627');
  mocks.detectLocalConnection.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command: string) => command === 'list_ssh_profiles' ? Promise.resolve([]) : Promise.resolve(undefined));
  mocks.meta.mockReset();
  mocks.homes.mockReset().mockResolvedValue({ items: [] });
  mocks.renewLease.mockReset();
  mocks.renewLease.mockResolvedValue(undefined);
  mocks.klients.length = 0;
  mocks.terminalSubscriptions.length = 0;
  mocks.stageListener = undefined;
  localStorage.clear(); sessionStorage.clear(); clearNavHistory();
  window.history.replaceState(null, '', '/new');
  writeSettings({ requestTimeoutSeconds: 30 });
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
  vi.unstubAllGlobals();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountProvider(strict = false, settings = false, switcher = false, browserReturn = false, manualScope = false): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A manual address is chosen inside the provider, so that test renders the
  // harness without the scope boundary that would re-enter the local scope.
  const element = manualScope
    ? <><NavigationObserver /><ConnectedHarness /></>
    : <NavScopeBoundary>
      <NavigationObserver />
      {browserReturn ? <BrowserReturnHarness /> : <><ConnectedHarness />{settings ? <ConnectionSection /> : null}{switcher ? <SwitcherHarness /> : null}</>}
    </NavScopeBoundary>;
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: [browserReturn ? '/s/browser-source' : '/new'] });
  const connection = <ConnectionProvider>
    {strict && !browserReturn ? <StrictLifecycleHarness /> : <RouterProvider router={router} />}
  </ConnectionProvider>;
  const hosted = strict ? <HostProvider host={browserHost}>{connection}</HostProvider> : connection;
  const tree = (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>{hosted}</I18nProvider>
    </QueryClientProvider>
  );
  await act(async () => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  await flush();
  return container;
}

async function emitStage(payload: unknown): Promise<void> {
  await act(async () => {
    mocks.stageListener?.({ payload });
    await Promise.resolve();
  });
}

describe('LiveControllerRegistry leases', () => {
  function controller(sessionId = 'session-shared', ready = Promise.resolve()): SessionController {
    return { sessionId, open: vi.fn(() => ready), close: vi.fn() } as unknown as SessionController;
  }

  it('shares one initialization and closes only after the last consumer releases', async () => {
    const registry = new LiveControllerRegistry();
    const connection = {};
    const opening = deferred<void>();
    const shared = controller('session-shared', opening.promise);
    const factory = vi.fn(() => shared);
    const changed = vi.fn();
    const unsubscribe = registry.subscribe(changed);
    const first = registry.acquire('session-shared', connection, factory);
    const second = registry.acquire('session-shared', connection, factory);
    expect(first.controller).toBe(second.controller);
    expect(first.ready).toBe(second.ready);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(shared.open).toHaveBeenCalledTimes(1);
    expect([...registry]).toEqual([shared]);
    expect(registry.snapshot()).toBe(1);
    first.release();
    first.release();
    expect(shared.close).not.toHaveBeenCalled();
    const third = registry.acquire('session-shared', connection, factory);
    expect(third.controller).toBe(shared);
    second.release();
    expect(shared.close).not.toHaveBeenCalled();
    opening.resolve();
    await third.ready;
    third.release();
    expect(shared.close).toHaveBeenCalledTimes(1);
    expect([...registry]).toEqual([]);
    expect(registry.snapshot()).toBe(2);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('isolates identical session IDs by connection identity and distinct sessions within a connection', async () => {
    const registry = new LiveControllerRegistry();
    const connection = {};
    const a = registry.acquire('session-shared', connection, () => controller());
    const b = registry.acquire('session-shared', {}, () => controller());
    const c = registry.acquire('session-other', connection, () => controller('session-other'));
    await Promise.all([a.ready, b.ready, c.ready]);
    expect(new Set([a.controller, b.controller, c.controller]).size).toBe(3);
    a.release();
    expect([...registry]).toEqual([b.controller, c.controller]);
    expect(b.controller.close).not.toHaveBeenCalled();
    expect(c.controller.close).not.toHaveBeenCalled();
    b.release();
    c.release();
  });

  it('retains the first reference before notifying reentrant registry observers', () => {
    const registry = new LiveControllerRegistry();
    const connection = {};
    const shared = controller();
    const factory = vi.fn(() => shared);
    const unsubscribe = registry.subscribe(() => {
      if (registry.snapshot() !== 1) return;
      registry.acquire('session-shared', connection, factory).release();
    });
    const lease = registry.acquire('session-shared', connection, factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(shared.close).not.toHaveBeenCalled();
    expect([...registry]).toEqual([shared]);
    unsubscribe();
    lease.release();
    expect(shared.close).toHaveBeenCalledTimes(1);
  });

  it('allows effect cleanup and reacquisition while stale cleanup cannot close the new controller', async () => {
    const registry = new LiveControllerRegistry();
    const connection = {};
    const opening = deferred<void>();
    const first = registry.acquire('session-shared', connection, () => controller('session-shared', opening.promise));
    first.release();
    const next = registry.acquire('session-shared', connection, () => controller());
    first.release();
    opening.resolve();
    await Promise.all([first.ready, next.ready]);
    expect(next.controller).not.toBe(first.controller);
    expect(first.controller.close).toHaveBeenCalledTimes(1);
    expect(next.controller.close).not.toHaveBeenCalled();
    expect([...registry]).toEqual([next.controller]);
    next.release();
    expect(next.controller.close).toHaveBeenCalledTimes(1);
  });

  it('leaves legacy registration ownership unchanged and does not borrow its externally closed controller', () => {
    const registry = new LiveControllerRegistry();
    const legacy = controller();
    registry.add(legacy);
    const lease = registry.acquire('session-shared', {}, () => controller());
    expect(lease.controller).not.toBe(legacy);
    expect([...registry]).toEqual([legacy, lease.controller]);
    registry.delete(legacy);
    expect(legacy.open).not.toHaveBeenCalled();
    expect(legacy.close).not.toHaveBeenCalled();
    expect(lease.controller.close).not.toHaveBeenCalled();
    lease.release();
  });

  it('rejects factory identity mismatches and already registered instances without taking ownership', () => {
    const registry = new LiveControllerRegistry();
    const wrong = controller('other');
    expect(() => registry.acquire('session-shared', {}, () => wrong)).toThrow('fresh controller');
    expect(wrong.open).not.toHaveBeenCalled();
    const legacy = controller();
    registry.add(legacy);
    expect(() => registry.acquire('session-shared', {}, () => legacy)).toThrow('fresh controller');
    expect(legacy.close).not.toHaveBeenCalled();
    expect([...registry]).toEqual([legacy]);
    registry.delete(legacy);
  });
});

describe('ConnectionProvider Klient ownership', () => {
  it('refreshes index status only after restored subscription attachment', async () => {
    localStorage.setItem('kiki.connection', JSON.stringify({ url: 'http://127.0.0.1:41001', token: 'test-token' }));
    mocks.meta.mockResolvedValue({ serverVersion: 'test' });
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    try {
      await mountProvider(true);
      const client = mocks.klients.find((entry) => !entry.closed)!;
      const attached = deferred<void>();
      client.events.on.mockImplementationOnce(() => ({ dispose: vi.fn(), ready: attached.promise }));
      invalidate.mockClear();
      const status = client.terminal.onStatus.mock.calls.at(-1)![0];
      await act(async () => { status('open'); });
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['search-index-state'] });
      await act(async () => { attached.resolve(); });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['search-index-state'] });
    } finally { invalidate.mockRestore(); }
  });
  it('cancels stale status reads and installs typed pushed index snapshots', async () => {
    localStorage.setItem('kiki.connection', JSON.stringify({ url: 'http://127.0.0.1:41001', token: 'test-token' }));
    mocks.meta.mockResolvedValue({ serverVersion: 'test' });
    const cancel = vi.spyOn(QueryClient.prototype, 'cancelQueries');
    const update = vi.spyOn(QueryClient.prototype, 'setQueryData');
    try {
      await mountProvider(true);
      const client = mocks.klients.find((entry) => !entry.closed)!;
      const registration = client.events.on.mock.calls.find(([name]) => name === 'search.indexStateChanged')!;
      expect(registration).toBeDefined();
      const state = { state: 'building', indexed_sessions: 2, total_sessions: 3, documents: 10 };
      await act(async () => { registration[1](state); });
      expect(cancel).toHaveBeenCalledWith({ queryKey: ['search-index-state'] });
      expect(update).toHaveBeenCalledWith(['search-index-state'], state);
    } finally { cancel.mockRestore(); update.mockRestore(); }
  });
  it('invalidates all model and provider entities only in the active connection cache', () => {
    const active = new QueryClient();
    const other = new QueryClient();
    const keys = [
      ['model-entity', 'provider-a/shared-model'],
      ['model-entity', 'provider-b/shared-model'],
      ['provider-entity', 'provider-a'],
    ];
    for (const cache of [active, other]) {
      for (const key of keys) cache.setQueryData(key, { id: key[1] });
      cache.setQueryData(['config'], { loop_control: {} });
    }
    try {
      expect(handleGlobalConnectionFrame({ type: 'event.unrelated' }, active)).toBe(false);
      expect(active.getQueryState(keys[0]!)?.isInvalidated).toBe(false);
      expect(handleGlobalConnectionFrame({ type: 'event.model_catalog.changed' }, active)).toBe(true);
      for (const key of keys) {
        expect(active.getQueryState(key)?.isInvalidated).toBe(true);
        expect(other.getQueryState(key)?.isInvalidated).toBe(false);
      }
      expect(active.getQueryState(['config'])?.isInvalidated).toBe(false);
    } finally {
      active.clear();
      other.clear();
    }
  });

  it('refreshes model and provider queries from typed Klient global events', async () => {
    localStorage.setItem('kiki.connection', JSON.stringify({ url: 'http://127.0.0.1:41001', token: 'test-token' }));
    mocks.meta.mockResolvedValue({ serverVersion: 'test' });
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    try {
      await mountProvider(true);
      const client = mocks.klients.find((entry) => !entry.closed)!;
      const registration = client.events.on.mock.calls.find(([name]) => name === 'kosong.changed')!;
      expect(registration).toBeDefined();
      await act(async () => { registration[1]({ changed: [], unchanged: [], failed: [] }); });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['models'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['providers'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['model-entity'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['provider-entity'] });
    } finally { invalidate.mockRestore(); }
  });

  it('rebuilds the GUI Klient with the saved timeout for subsequent requests', async () => {
    localStorage.setItem('kiki.connection', JSON.stringify({
      url: 'http://127.0.0.1:41001',
      token: 'test-token',
    }));
    mocks.meta.mockResolvedValue({ serverVersion: 'test' });
    const container = await mountProvider(true);
    expect(mocks.klients.filter((entry) => !entry.closed)).toHaveLength(1);
    expect(mocks.klients.find((entry) => !entry.closed)).toMatchObject({ timeoutMs: 30_000 });

    await act(async () => {
      writeSettings({ requestTimeoutSeconds: 120 });
    });
    await flush();

    const active = mocks.klients.filter((entry) => !entry.closed);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ timeoutMs: 120_000 });
    expect(mocks.klients.filter((entry) => entry.timeoutMs === 30_000).every((entry) => entry.closed)).toBe(true);
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe('http://127.0.0.1:41001');
  });

  it('rebuilds the StrictMode lease and owns normalized pair changes through final unmount', async () => {
    localStorage.setItem('kiki.connection', JSON.stringify({
      url: 'http://127.0.0.1:41001/',
      token: ' strict-token ',
    }));
    mocks.meta.mockResolvedValue({ serverVersion: 'test' });

    const container = await mountProvider(true);
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe('http://127.0.0.1:41001/');
    expect(mocks.klients).toHaveLength(2);
    expect(mocks.klients[0]).toMatchObject({
      endpoint: 'http://127.0.0.1:41001',
      token: 'strict-token',
      closed: true,
    });
    expect(mocks.klients[1]).toMatchObject({
      endpoint: 'http://127.0.0.1:41001',
      token: 'strict-token',
      closed: false,
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-list-mcp]')!.click();
      await Promise.resolve();
    });
    expect(mocks.klients[0]!.global.mcp.list).not.toHaveBeenCalled();
    expect(mocks.klients[1]!.global.mcp.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-equivalent-pair]')!.click();
    });
    await flush();
    expect(mocks.klients).toHaveLength(2);
    expect(mocks.klients.filter((klient) => !klient.closed)).toEqual([mocks.klients[1]]);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-changed-pair]')!.click();
    });
    await flush();
    expect(mocks.klients).toHaveLength(3);
    expect(mocks.klients[1]!.closed).toBe(true);
    expect(mocks.klients[2]).toMatchObject({
      endpoint: 'http://127.0.0.1:42002',
      token: 'next-token',
      closed: false,
    });

    const mountedEntry = mounted.pop()!;
    await act(async () => {
      mountedEntry.root.unmount();
    });
    mountedEntry.container.remove();
    expect(mocks.klients[2]!.closed).toBe(true);
    expect(mocks.klients.filter((klient) => !klient.closed)).toHaveLength(0);
  });
});

describe('ConnectionProvider desktop backend recovery', () => {
  it('hides direct token editing and local restart in SSH settings scope', async () => {
    const localConfig = { url: 'http://127.0.0.1:41001', token: 'local-token' };
    const remoteConfig = { url: 'http://127.0.0.1:42002', token: 'a'.repeat(43) };
    mocks.detectLocalConnection.mockResolvedValue({ config: localConfig, persist: false });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'list_ssh_profiles') return Promise.resolve([{ id: 'host-1', label: 'Example', target: { kind: 'alias', alias: 'example' }, releaseChannel: 'stable', remotePort: 58627, serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed' }]);
      if (command === 'ssh_tunnel_running') return Promise.resolve(true);
      if (command === 'connect_ssh_profile') return Promise.resolve({ config: remoteConfig, tunnelId: 'tunnel-one',
        serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed', serverInstanceId: 'remote',
        serverVersion: '0.1.0', buildId: 'test-build', buildChannel: 'stable',
      });
      return Promise.resolve(undefined);
    });
    mocks.meta.mockImplementation((url: string) => Promise.resolve(url === remoteConfig.url ? {
      server_home_id: '46aca369-50e8-4fd3-9c45-606d084450ed', server_id: 'remote',
      dangerous_bypass_auth: false, server_version: '0.1.0', build_id: 'test-build', build_channel: 'stable',
    } : { server_version: '0.1.0', server_id: 'local' }));
    const container = await mountProvider(false, true);
    expect(container.querySelector('#st-conn-token')).not.toBeNull();
    expect(container.querySelector('#st-card-conn-owned')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    expect(container.querySelector('#st-conn-token')).toBeNull();
    expect(container.querySelector('#st-card-conn-owned')).toBeNull();
    expect(container.textContent).toContain('Its agent and provider settings live there');
    expect(mocks.invoke).not.toHaveBeenCalledWith('restart_server');
  });

  it('fails closed for an older remote server without server_home_id', async () => {
    const localConfig = { url: 'http://127.0.0.1:41001', token: 'local-token' };
    const remoteConfig = { url: 'http://127.0.0.1:42002', token: 'a'.repeat(43) };
    mocks.detectLocalConnection.mockResolvedValue({ config: localConfig, persist: false });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'list_ssh_profiles') return Promise.resolve([{ id: 'host-1', label: 'Example', target: { kind: 'alias', alias: 'example' }, releaseChannel: 'stable', remotePort: 58627, serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed' }]);
      if (command === 'ssh_tunnel_running') return Promise.resolve(true);
      if (command === 'connect_ssh_profile') return Promise.resolve({ config: remoteConfig, tunnelId: 'tunnel-one',
        serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed', serverInstanceId: 'remote',
        serverVersion: '0.1.0', buildId: 'test-build', buildChannel: 'stable',
      });
      return Promise.resolve(undefined);
    });
    mocks.meta.mockImplementation((url: string) => Promise.resolve(url === remoteConfig.url ? {
      server_id: 'remote', server_version: '0.1.0', build_id: 'test-build', build_channel: 'stable',
    } : { server_id: 'local' }));
    const container = await mountProvider();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(localConfig.url);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Kiki stopped');
    const stay = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Stay on this page');
    expect(stay).toBeDefined();
    expect(container.textContent).not.toContain('Retry startup');
    await act(async () => { stay!.click(); });
    await flush();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(localConfig.url);
    expect(mocks.invoke).not.toHaveBeenCalledWith('restart_server');
  });

  it('blocks a remote server that advertises bearer-auth bypass even when home ID matches', async () => {
    const homeId = '46aca369-50e8-4fd3-9c45-606d084450ed';
    const config = { url: 'http://127.0.0.1:42002', token: 'a'.repeat(43) };
    mocks.detectLocalConnection.mockResolvedValue({
      config: { url: 'http://127.0.0.1:41001', token: 'local-token' }, persist: false,
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'list_ssh_profiles') return Promise.resolve([{
        id: 'host-1', label: 'Example', target: { kind: 'alias', alias: 'example' },
        releaseChannel: 'stable', remotePort: 58627, serverHomeId: homeId,
      }]);
      if (command === 'connect_ssh_profile') return Promise.resolve({
        config, tunnelId: 'tunnel-one', serverHomeId: homeId,
        serverInstanceId: 'server-remote', serverVersion: '0.1.0', buildId: null, buildChannel: null,
      });
      return Promise.resolve(undefined);
    });
    mocks.meta.mockImplementation((url: string) => Promise.resolve(url === config.url ? {
      server_home_id: homeId, server_id: 'server-remote', server_version: '0.1.0', dangerous_bypass_auth: true,
    } : { server_id: 'server-local' }));
    const container = await mountProvider();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Kiki stopped');
  });

  it('hides a stale local failure while verifying SSH and restarts only the local backend on fallback', async () => {
    const localConfig = { url: 'http://127.0.0.1:41001', token: 'local-token' };
    const remoteConfig = { url: 'http://127.0.0.1:42002', token: 'a'.repeat(43) };
    const remoteMeta = deferred<object>();
    mocks.detectLocalConnection.mockRejectedValueOnce(new Error('local backend unavailable'))
      .mockResolvedValueOnce({ config: localConfig, persist: false });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'list_ssh_profiles') return Promise.resolve([{ id: 'host-1', label: 'Example', target: { kind: 'alias', alias: 'example' }, releaseChannel: 'stable', remotePort: 58627, serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed' }]);
      if (command === 'ssh_tunnel_running') return Promise.resolve(true);
      if (command === 'connect_ssh_profile') return Promise.resolve({ config: remoteConfig, tunnelId: 'tunnel-one',
        serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed', serverInstanceId: 'remote',
        serverVersion: '0.1.0', buildId: 'test-build', buildChannel: 'stable',
      });
      return Promise.resolve(undefined);
    });
    mocks.meta.mockImplementation((url: string) => url === remoteConfig.url
      ? remoteMeta.promise : Promise.resolve({ server_id: 'local' }));
    const container = await mountProvider();
    expect(container.textContent).toContain('local backend unavailable');
    expect(container.textContent).toContain('Retry startup');
    const tokenInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(tokenInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(tokenInput, 'a'.repeat(43));
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const connectButton = tokenInput.closest('label')!.nextElementSibling as HTMLButtonElement;
    await act(async () => { connectButton.click(); });
    await flush();
    expect(container.textContent).toContain('Checking SSH server identity');
    expect(container.textContent).not.toContain('local backend unavailable');
    expect(container.querySelector('#connect-token')).toBeNull();
    await act(async () => remoteMeta.resolve({ server_id: 'remote', server_version: '0.1.0', build_id: 'test-build', build_channel: 'stable' }));
    await flush();
    expect(container.textContent).toContain('SSH server identity changed');
    expect(container.textContent).not.toContain('local backend unavailable');
    const switchLocal = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch to this computer');
    expect(switchLocal).toBeDefined();
    await act(async () => { switchLocal!.click(); });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(localConfig.url);
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
  });

  it('isolates local and SSH scope caches and rejects mismatched server identity', async () => {
    const homeId = '46aca369-50e8-4fd3-9c45-606d084450ed';
    const localConfig = { url: 'http://127.0.0.1:41001', token: 'local-token' };
    const remoteConfig = { url: 'http://127.0.0.1:42002', token: 'a'.repeat(43) };
    const profile = { id: 'host-1', label: 'Example', target: { kind: 'alias', alias: 'example' }, releaseChannel: 'stable', remotePort: 58627, serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed' };
    const resolved = { config: remoteConfig, tunnelId: 'tunnel-one', serverHomeId: homeId, serverInstanceId: 'server-remote',
      serverVersion: '0.1.0', buildId: 'test-build', buildChannel: 'stable' };
    mocks.detectLocalConnection.mockResolvedValue({ config: localConfig, persist: false });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'list_ssh_profiles') return Promise.resolve([profile]);
      if (command === 'ssh_tunnel_running') return Promise.resolve(true);
      if (command === 'connect_ssh_profile') return Promise.resolve(resolved);
      return Promise.resolve(undefined);
    });
    mocks.meta.mockImplementation((url: string) => Promise.resolve(url === remoteConfig.url ? {
      server_home_id: homeId, server_id: 'server-remote', server_version: '0.1.0', dangerous_bypass_auth: false,
      build_id: 'test-build', build_channel: 'stable',
    } : { server_id: 'server-local' }));
    const container = await mountProvider();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-write-cache]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('ssh:host-1');
    expect(container.querySelector('[data-cache-value]')?.textContent).toBe('empty');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-write-cache]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-local]')!.click(); });
    await flush();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    expect(container.querySelector('[data-cache-value]')?.textContent).toBe('local');
    expect(mocks.klients.filter((entry) => !entry.closed)).toHaveLength(1);
    expect(mocks.klients.find((entry) => !entry.closed)?.endpoint).toBe(localConfig.url);
    expect(mocks.invoke).not.toHaveBeenCalledWith('disconnect_ssh_profile', { id: 'host-1', tunnelId: 'tunnel-one' });
    expect(mocks.invoke).toHaveBeenCalledWith('commit_scope_connection', { homeId: 'main', id: 'host-1', tunnelId: 'tunnel-one', reload: false });

    mocks.meta.mockImplementation((url: string) => Promise.resolve(url === remoteConfig.url ? {
      server_home_id: 'unexpected-home', server_id: 'server-remote', server_version: '0.1.0',
      build_id: 'test-build', build_channel: 'stable',
    } : { server_id: 'server-local' }));
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(localConfig.url);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Kiki stopped');
  });

  it('cannot disconnect a newer same-profile SSH tunnel from a late older connection', async () => {
    const homeId = '46aca369-50e8-4fd3-9c45-606d084450ed';
    const token = 'a'.repeat(43);
    const old = deferred<object>();
    const newer = deferred<object>();
    let connections = 0;
    mocks.detectLocalConnection.mockResolvedValue({
      config: { url: 'http://127.0.0.1:41001', token: 'local-token' }, persist: false,
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'list_ssh_profiles') return Promise.resolve([{
        id: 'host-1', label: 'Example', target: { kind: 'alias', alias: 'example' },
        releaseChannel: 'stable', remotePort: 58627, serverHomeId: homeId,
      }]);
      if (command === 'connect_ssh_profile') return ++connections === 1 ? old.promise : newer.promise;
      if (command === 'ssh_tunnel_running') return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    mocks.meta.mockImplementation((url: string) => Promise.resolve(url.includes('42002') ? {
      server_home_id: homeId, server_id: 'server-remote', server_version: '0.1.0', dangerous_bypass_auth: false,
    } : { server_id: 'server-local' }));
    const container = await mountProvider();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    const resolved = (tunnelId: string) => ({
      config: { url: 'http://127.0.0.1:42002', token }, tunnelId,
      serverHomeId: homeId, serverInstanceId: 'server-remote',
      serverVersion: '0.1.0', buildId: null, buildChannel: null,
    });
    await act(async () => newer.resolve(resolved('newer')));
    await flush();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('ssh:host-1');
    await act(async () => old.resolve(resolved('older')));
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith('disconnect_ssh_profile', { id: 'host-1', tunnelId: 'older' });
    expect(mocks.invoke).not.toHaveBeenCalledWith('disconnect_ssh_profile', { id: 'host-1', tunnelId: 'newer' });
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('ssh:host-1');
  });

  it('routes the real SpaceSwitcher through the retained local controller during SSH and local backend recovery', async () => {
    writeDesktopPrefs({ windowMode: 'windows' });
    const localConfig = { url: 'http://127.0.0.1:41001', token: 'local-token' };
    const remoteConfig = { url: 'http://127.0.0.1:42002', token: 'a'.repeat(43) };
    const recoveredConfig = { url: 'http://127.0.0.1:43003', token: 'recovered-local-token' };
    const homeId = '46aca369-50e8-4fd3-9c45-606d084450ed';
    const localHomes = { items: [
      { id: 'main', name: 'Main', path: 'C:/kiki', primary: true },
      { id: 'local-only', name: 'GPU', path: 'D:/local-gpu', primary: false },
      { id: 'shared', name: 'Paper', path: 'E:/local-paper', primary: false },
    ] };
    const remoteHomes = { items: [
      { id: 'main', name: 'Main', path: '/srv/kiki', primary: true },
      { id: 'remote-only', name: 'GPU', path: '/srv/remote-gpu', primary: false },
      { id: 'shared', name: 'Paper', path: '/srv/remote-paper', primary: false },
    ] };
    const recovery = deferred<{ config: typeof recoveredConfig; persist: boolean }>();
    const beforeOpenRecovery = deferred<{ config: typeof localConfig; persist: boolean }>();
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: localConfig, persist: false })
      .mockReturnValueOnce(beforeOpenRecovery.promise).mockReturnValueOnce(recovery.promise);
    const opened: string[] = [];
    let failNextOpen = true;
    mocks.invoke.mockImplementation((command: string, args?: { homeId?: string }) => {
      if (command === 'list_ssh_profiles') return Promise.resolve([{ id: 'host-1', label: 'Remote GPU', target: { kind: 'alias', alias: 'example' }, releaseChannel: 'stable', remotePort: 58627, serverHomeId: homeId }]);
      if (command === 'ssh_tunnel_running') return Promise.resolve(true);
      if (command === 'connect_ssh_profile') return Promise.resolve({ config: remoteConfig, tunnelId: 'tunnel-one', serverHomeId: homeId,
        serverInstanceId: 'server-remote', serverVersion: '0.1.0', buildId: null, buildChannel: null });
      if (command === 'desktop_space_statuses') return Promise.resolve([]);
      if (command === 'read_desktop_prefs') return Promise.resolve(null);
      if (command === 'open_space') {
        const home = localHomes.items.find((item) => item.id === args?.homeId);
        if (home === undefined) return Promise.reject(new Error('Unknown local home'));
        expect(mocks.meta.mock.calls.some(([url]) => url === localConfig.url)).toBe(true);
        if (failNextOpen) {
          failNextOpen = false;
          return Promise.reject(new Error('Independent window failed to open'));
        }
        opened.push(home.path);
      }
      return Promise.resolve(undefined);
    });
    mocks.meta.mockImplementation((url: string) => Promise.resolve(url === remoteConfig.url ? {
      server_home_id: homeId, server_id: 'server-remote', server_version: '0.1.0', dangerous_bypass_auth: false,
    } : { server_id: 'server-local' }));
    mocks.homes.mockImplementation((url: string) => Promise.resolve(url === remoteConfig.url ? remoteHomes : localHomes));
    const settle = async () => act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
    const container = await mountProvider(false, false, true);
    await settle();
    const localController = mocks.klients.find((entry) => entry.endpoint === localConfig.url)!;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await settle();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('ssh:host-1');
    expect(container.querySelector('[data-local-control-url]')?.textContent).toBe(localConfig.url);
    expect(localController.closed).toBe(false);
    expect(container.querySelector('[data-space-remote-tag]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-space-remote]')!.click(); });
    expect(document.querySelector('[data-space-switch-item="remote-only"]')).toBeNull();
    expect(document.querySelector('[data-space-switch-item="local-only"]')?.textContent).toContain('GPU');
    const sourceDraft = container.querySelector<HTMLInputElement>('[data-settings-draft]')!;
    const sourceVisit = getCurrentVisit();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-dirty-editor]')!.click(); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true })); });
    await emitStage('waiting');
    await settle();
    expect(container.querySelector('[data-local-control-url]')?.textContent).toBe('pending');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click(); });
    await settle();
    expect(opened).toEqual([]);
    expect(getCurrentVisit()).toEqual(sourceVisit);
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('true');
    expect(container.querySelector('[data-settings-draft]')).toBe(sourceDraft);
    await act(async () => { beforeOpenRecovery.resolve({ config: localConfig, persist: false }); });
    await settle();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true })); });
    expect(opened).toEqual([]);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click(); });
    await settle();
    expect(opened).toEqual([]);
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('ssh:host-1');
    expect(container.querySelector('[data-settings-draft]')).toBe(sourceDraft);
    expect(sourceDraft.value).toBe('unsaved local routing draft');
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('true');
    expect(container.querySelector('[data-restore-error]')?.textContent).toContain('Independent window failed to open');
    expect(getCurrentVisit()).toEqual(sourceVisit);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'open_space')).toHaveLength(1);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true })); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click(); });
    await settle();
    expect(opened).toEqual(['D:/local-gpu']);
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    expect(container.querySelector('[data-switcher-route]')?.textContent).toBe('/new');
    expect(getCurrentVisit()?.scope.scopeId).toBe('local');
    expect(mocks.invoke).not.toHaveBeenCalledWith('disconnect_ssh_profile', { id: 'host-1', tunnelId: 'tunnel-one' });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await settle();
    await emitStage('waiting');
    await settle();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('ssh:host-1');
    expect(container.querySelector('[data-local-control-url]')?.textContent).toBe('pending');
    expect(localController.closed).toBe(true);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-space-remote]')!.click(); });
    expect(document.querySelector('[data-space-directory-pending]')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', ctrlKey: true, altKey: true })); });
    expect(opened).toHaveLength(1);
    await act(async () => recovery.resolve({ config: recoveredConfig, persist: false }));
    await settle();
    expect(container.querySelector('[data-local-control-url]')?.textContent).toBe(recoveredConfig.url);
    expect(document.querySelector('[data-space-directory-pending]')).toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="shared"]')!.click(); });
    await settle();
    expect(opened).toEqual(['D:/local-gpu', 'E:/local-paper']);
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    expect(mocks.homes.mock.calls.every(([url]) => url !== remoteConfig.url)).toBe(true);
    expect(mocks.homes).toHaveBeenCalledWith(recoveredConfig.url);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await settle();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-dirty-editor]')!.click(); });
    let rejectLocal!: (reason: Error) => void;
    const failedLocal = new Promise<object>((_yes, no) => { rejectLocal = no; });
    mocks.meta.mockReturnValueOnce(failedLocal);
    const priorMetaCalls = mocks.meta.mock.calls.length;
    const priorHistory = window.location.href;
    const menuAction = async (selector: string) => {
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-space-remote]')!.click(); });
      await act(async () => { document.querySelector<HTMLButtonElement>(selector)!.click(); });
    };
    await menuAction('[data-space-manage]');
    expect(mocks.meta).toHaveBeenCalledTimes(priorMetaCalls);
    expect(window.location.href).toBe(priorHistory);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
      container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
    });
    expect(mocks.meta).toHaveBeenCalledTimes(priorMetaCalls + 1);
    await act(async () => { rejectLocal(new Error('Local server unavailable: connection refused')); });
    await settle();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('ssh:host-1');
    expect(container.querySelector('[data-switcher-route]')?.textContent).toBe('/new');
    expect(container.querySelector('[data-settings-draft]')?.getAttribute('value')).toBe('unsaved local routing draft');
    expect(container.querySelector('[data-guard-dirty]')?.textContent).toBe('true');
    expect(container.querySelector('[data-restore-error]')?.textContent).toContain('connection refused');
    expect(window.location.href).toBe(priorHistory);

    const lateLocal = deferred<object>();
    mocks.meta.mockReturnValueOnce(lateLocal.promise);
    await menuAction('[data-space-new-entry]');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-cancel-leave]')!.click(); });
    await act(async () => { lateLocal.resolve({ server_id: 'server-local' }); });
    await settle();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('ssh:host-1');
    expect(container.querySelector('[data-switcher-route]')?.textContent).toBe('/new');
    expect(window.location.href).toBe(priorHistory);

    const successfulMeta = deferred<object>();
    mocks.meta.mockReturnValueOnce(successfulMeta.promise);
    await menuAction('[data-space-manage]');
    const beforeRestore = mocks.meta.mock.calls.length;
    const beforeClients = mocks.klients.length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
      container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
    });
    expect(container.querySelector('[data-switcher-route]')?.textContent).toBe('/new');
    await act(async () => { successfulMeta.resolve({ server_id: 'server-local' }); });
    await settle();
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(recoveredConfig.url);
    expect(container.querySelector('[data-switcher-route]')?.textContent).toBe('/settings/spaces');
    expect(mocks.meta).toHaveBeenCalledTimes(beforeRestore + 1);
    expect(mocks.klients).toHaveLength(beforeClients);

    // The direct settings entry uses the same retained client and native local resolver.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await settle();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-dirty-editor]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-space-enter="shared"]')!.click(); });
    expect(opened).toHaveLength(2);
    const beforeSettingsMeta = mocks.meta.mock.calls.length;
    const beforeSettingsClients = mocks.klients.length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
      container.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
    });
    await settle();
    expect(opened).toEqual(['D:/local-gpu', 'E:/local-paper', 'E:/local-paper']);
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
    expect(mocks.meta).toHaveBeenCalledTimes(beforeSettingsMeta + 1);
    expect(mocks.klients).toHaveLength(beforeSettingsClients);
    expect(mocks.homes.mock.calls.every(([url]) => url !== remoteConfig.url)).toBe(true);
  });

  it('invalidates stale meta, closes the old socket, and connects only after the new endpoint validates', async () => {
    const oldConfig = { url: 'http://127.0.0.1:41001', token: 'old-token' };
    const intermediateConfig = { url: 'http://127.0.0.1:41501', token: 'middle-token' };
    const newConfig = { url: 'http://127.0.0.1:42002', token: 'new-token' };
    const staleMeta = deferred<object>();
    const newDesktopConnection = deferred<{ config: typeof newConfig; persist: boolean }>();
    const newMeta = deferred<object>();

    mocks.detectLocalConnection
      .mockResolvedValueOnce({ config: oldConfig, persist: false })
      .mockResolvedValueOnce({ config: intermediateConfig, persist: false })
      .mockReturnValueOnce(newDesktopConnection.promise);
    mocks.meta
      .mockResolvedValueOnce({ serverVersion: 'test' })
      .mockReturnValueOnce(staleMeta.promise)
      .mockReturnValueOnce(newMeta.promise);

    const container = await mountProvider();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(oldConfig.url);
    expect(mocks.terminalSubscriptions).toHaveLength(1);
    expect(mocks.klients).toHaveLength(1);
    expect(mocks.klients[0]).toMatchObject({ endpoint: oldConfig.url, token: oldConfig.token });

    await emitStage('waiting');
    await flush();
    expect(mocks.terminalSubscriptions[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.klients[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.klients).toHaveLength(2);
    expect(mocks.meta).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-connected-url]')).toBeNull();

    await emitStage('waiting');
    expect(container.textContent).toContain('waiting for it to become ready');

    staleMeta.resolve({ serverVersion: 'stale' });
    await flush();
    expect(container.textContent).toContain('waiting for it to become ready');
    expect(container.querySelector('[data-connected-url]')).toBeNull();
    expect(mocks.terminalSubscriptions).toHaveLength(1);
    expect(mocks.klients[1]!.close).toHaveBeenCalledTimes(1);

    newDesktopConnection.resolve({ config: newConfig, persist: false });
    await flush();
    expect(mocks.meta).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-connected-url]')).toBeNull();

    newMeta.resolve({ serverVersion: 'test' });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(newConfig.url);
    expect(mocks.terminalSubscriptions).toHaveLength(2);
    expect(mocks.klients).toHaveLength(3);
    expect(mocks.klients[2]).toMatchObject({ endpoint: newConfig.url, token: newConfig.token });
    expect(mocks.terminalSubscriptions[1]!.baseUrl).toBe(newConfig.url);
    expect(mocks.terminalSubscriptions[1]!.connect).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed recovery visible when an old meta promise resolves later', async () => {
    const oldConfig = { url: 'http://127.0.0.1:41001', token: 'old-token' };
    const intermediateConfig = { url: 'http://127.0.0.1:41501', token: 'middle-token' };
    const staleMeta = deferred<object>();

    mocks.detectLocalConnection
      .mockResolvedValueOnce({ config: oldConfig, persist: false })
      .mockResolvedValueOnce({ config: intermediateConfig, persist: false });
    mocks.meta
      .mockResolvedValueOnce({ serverVersion: 'test' })
      .mockReturnValueOnce(staleMeta.promise);

    const container = await mountProvider();
    await emitStage('waiting');
    await flush();
    expect(mocks.meta).toHaveBeenCalledTimes(2);

    await emitStage({
      stage: 'failed',
      failure: {
        message: 'backend recovery exhausted',
        stderrTail: ['boom'],
        logPath: 'desktop-backend.log',
      },
    });
    staleMeta.resolve({ serverVersion: 'stale' });
    await flush();

    expect(container.textContent).toContain('backend recovery exhausted');
    expect(container.querySelector('[data-connected-url]')).toBeNull();
    expect(mocks.terminalSubscriptions).toHaveLength(1);
    expect(mocks.terminalSubscriptions[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('builds lease client ids without crypto.randomUUID', () => {
    const crypto = globalThis.crypto as Crypto & { randomUUID?: () => `${string}-${string}-${string}-${string}-${string}` };
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      const first = nextGuiLeaseClientId(1234);
      const second = nextGuiLeaseClientId(1234);
      expect(first).toMatch(/^gui-ya-[0-9a-z]+$/);
      expect(second).not.toBe(first);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(crypto, 'randomUUID');
      else Object.defineProperty(crypto, 'randomUUID', descriptor);
    }
  });

  it('renders and renews one GUI lease when crypto.randomUUID is unavailable', async () => {
    vi.useFakeTimers();
    const crypto = globalThis.crypto as Crypto & { randomUUID?: () => `${string}-${string}-${string}-${string}-${string}` };
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      mocks.detectLocalConnection.mockResolvedValue({
        config: { url: 'http://127.0.0.1:41001', token: 'home-token' },
        persist: false,
      });
      mocks.meta.mockResolvedValue({ serverVersion: 'test' });

      await mountProvider();
      expect(mocks.klients).toHaveLength(1);
      expect(mocks.renewLease).toHaveBeenCalledTimes(1);
      expect(mocks.renewLease).toHaveBeenLastCalledWith({
        clientId: expect.any(String),
        kind: 'gui',
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(mocks.renewLease).toHaveBeenCalledTimes(2);

      const entry = mounted.pop();
      expect(entry).toBeDefined();
      await act(async () => {
        entry!.root.unmount();
      });
      entry!.container.remove();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.renewLease).toHaveBeenCalledTimes(2);
      expect(mocks.klients[0]!.close).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(crypto, 'randomUUID');
      else Object.defineProperty(crypto, 'randomUUID', descriptor);
      vi.useRealTimers();
    }
  });
});


describe('same direct return ownership', () => {
  it('keeps the existing HTTP client and terminal subscription alive across board then Back', async () => {
    localStorage.setItem('kiki.connection', JSON.stringify({ url: 'http://127.0.0.1:41001', token: 'fixture-browser-token' }));
    mocks.meta.mockResolvedValue({ server_home_id: 'fixture-browser-home' });
    const container = await mountProvider(true, false, false, true);
    const before = returnedConnection!; const active = mocks.klients.find((entry) => !entry.closed)!;
    const terminalSubscriptions = mocks.terminalSubscriptions.length;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-return-board]')!.click(); });
    expect(container.querySelector('[data-return-route]')?.textContent).toBe('/board');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-return-back]')!.click(); }); await flush();
    expect(container.querySelector('[data-return-route]')?.textContent).toBe('/s/browser-source');
    expect(returnedConnection!.client).toBe(before.client); expect(returnedConnection!.scopeId).toBe(before.scopeId);
    expect(active.closed).toBe(false); expect(active.close).not.toHaveBeenCalled();
    expect(mocks.terminalSubscriptions).toHaveLength(terminalSubscriptions);
    expect(() => returnedConnection!.socket.onTerminalSignal(() => {})).not.toThrow();
  });
});

describe('a closed desktop socket', () => {
  const firstPort = { url: 'http://127.0.0.1:41001', token: 'local-token' };
  const restartedPort = { url: 'http://127.0.0.1:41557', token: 'local-token' };

  beforeEach(() => {
    mocks.meta.mockImplementation(() => Promise.resolve({ server_id: 'local', server_version: '0.1.0', dangerous_bypass_auth: false }));
    mocks.invoke.mockImplementation(() => Promise.resolve([]));
  });

  /**
   * The socket the provider is actually attached to. After a manual switch the
   * desktop client stays open as the local control connection, so the first
   * open client is not the one whose status this window observes.
   */
  function statusHandler(): (status: string) => Promise<void> {
    const open = mocks.klients.filter((entry) => !entry.closed);
    const client = open[open.length - 1]!;
    return (status: string) => act(async () => { client.terminal.onStatus.mock.calls.at(-1)![0](status); });
  }

  /** Past the debounce the recovery actually waits for. */
  async function settle(): Promise<void> {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 300); }); });
    await flush();
  }

  /** A desktop window the user has pointed at their own server. */
  async function onManualAddress(): Promise<HTMLDivElement> {
    const container = await mountProvider(false, false, false, false, true);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-manual]')!.click(); });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(MANUAL.url);
    return container;
  }

  const MANUAL = { url: 'http://peer.example.test:8080', token: 'peer-token' };

  it('re-discovers the new random port after another window restarts this home', async () => {
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: firstPort, persist: false })
      .mockResolvedValueOnce({ config: restartedPort, persist: false });
    const container = await mountProvider();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(firstPort.url);
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(1);

    // The backend this window was attached to is replaced: its socket closes
    // and the new one listens elsewhere.
    const close = statusHandler();
    await close('closed');
    await settle();

    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(restartedPort.url);
  });

  it('leaves a hand-entered address alone instead of dragging it back to a local port', async () => {
    mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
    const container = await onManualAddress();
    const discoverCalls = mocks.detectLocalConnection.mock.calls.length;

    await statusHandler()('closed');
    await settle();

    // No re-discovery at all: an address the user typed is not one this
    // window's shell owns and may move.
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(discoverCalls);
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(MANUAL.url);
  });

  it('does not let a local backend stage clear or re-point a hand-entered address', async () => {
    mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
    const container = await onManualAddress();

    const stage = mocks.stageListener!;
    // The local backend restarts underneath a window that is not using it.
    await act(async () => { stage({ payload: 'waiting' }); });
    await settle();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(MANUAL.url);
    const afterWaiting = mocks.detectLocalConnection.mock.calls.length;

    await act(async () => { stage({ payload: { stage: 'failed', failure: { kind: 'unknown' } } }); });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(MANUAL.url);
    // Neither stage re-resolved the local backend behind the user's back.
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(afterWaiting);
  });

  it('does not let a discovery that is already stale replace a newer one', async () => {
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: firstPort, persist: false });
    const container = await mountProvider(false, false, false, false, true);
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(firstPort.url);

    // One re-discovery starts and is slow.
    const slow = deferred<{ config: typeof restartedPort; persist: boolean }>();
    mocks.detectLocalConnection.mockReturnValueOnce(slow.promise);
    const close = statusHandler();
    await close('closed');
    await settle();
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);

    // Before it answers, the socket drops again and a second, faster discovery
    // finds the port the backend is really on now.
    const current = { url: 'http://127.0.0.1:41999', token: 'local-token' };
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: current, persist: false });
    await close('closed');
    await settle();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(current.url);

    // The first answer now arrives carrying the port the backend has already
    // left behind. Adopting it would move this window onto a dead address.
    await act(async () => { slow.resolve({ config: restartedPort, persist: false }); });
    await flush();

    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(current.url);
  });
});
