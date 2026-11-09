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
import {
  applyCommittedShellCredential,
  clearAppShellCredentialState,
  installAppShellCredentialListener,
  SHELL_MANAGED_STORAGE_KEY,
  SHELL_PEER_TOKEN_KEY,
} from '../lib/appShell';
import { resetWebAccessBootstrap, setWebAccessBootstrap } from '../lib/webAccess';
import { ConnectionProvider, handleGlobalConnectionFrame, LiveControllerRegistry, nextGuiLeaseClientId, useConnection, useControllerRegistry } from './connection';

const mocks = vi.hoisted(() => ({
  detectLocalConnection: vi.fn(),
  invoke: vi.fn(),
  meta: vi.fn(),
  homes: vi.fn(),
  renewLease: vi.fn(),
  rebindDesktop: vi.fn(),
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
    baseUrl: string;
    readonly klient;
    private readonly statusListeners = new Set<(status: string) => void>();

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
          onStatus: vi.fn((listener: (status: string) => void) => {
            this.statusListeners.add(listener);
            const subscription = { baseUrl: options.baseUrl, connect: vi.fn(), close: vi.fn(() => { this.statusListeners.delete(listener); }) };
            subscription.connect();
            mocks.terminalSubscriptions.push(subscription);
            return subscription.close;
          }),
        },
      };
      this.klient = klient;
      mocks.klients.push(klient);
    }

    rebindDesktop(config: { url: string; token: string }) {
      mocks.rebindDesktop(config);
      this.baseUrl = config.url;
      this.klient.endpoint = config.url;
      this.klient.token = config.token;
      for (const listener of this.statusListeners) listener('closed');
      for (const listener of this.statusListeners) listener('connecting');
    }
    suspendDesktop = vi.fn();
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
    <span data-recovery-error>{connection.recovery?.failure?.message}</span>
    <span data-recovery-state>{connection.recovery?.status}</span>
    <span data-recovery-kind>{connection.recovery?.failure?.kind}</span>
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
    <button data-return-board onClick={() => { void navigate('/board'); }} />
    <button data-return-back onClick={() => { void navigate(-1); }} />
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

const recoveryControllers: SessionController[] = [];
function RecoveryHarness() {
  const connection = useConnection();
  const registry = useControllerRegistry();
  useLayoutEffect(() => {
    const lease = registry.acquire('session-recovery', connection.client, () => {
      const controller = { sessionId: 'session-recovery', open: vi.fn(async () => {}), close: vi.fn() } as unknown as SessionController;
      recoveryControllers.push(controller);
      return controller;
    });
    return () => { lease.release(); };
  }, [connection.client, registry]);
  return <>
    <input data-recovery-draft defaultValue="unsent local draft" />
    <div data-recovery-reading style={{ height: 120, overflow: 'auto' }}><p style={{ height: 2000 }}>Retained conversation history</p></div>
    <span data-recovery-status>{connection.wsStatus}</span>
    <button data-recovery-retry onClick={() => { connection.socket.nudge(); }} />
  </>;
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
  mocks.rebindDesktop.mockReset();
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

async function mountProvider(strict = false, settings = false, switcher = false, browserReturn = false, manualScope = false, recovery = false): Promise<HTMLDivElement> {
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
    {recovery ? <RecoveryHarness /> : null}
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

async function loseLocalConnection(url: string): Promise<void> {
  const local = mocks.klients.findLast((entry) => !entry.closed && entry.endpoint === url)!;
  const onStatus = local.terminal.onStatus.mock.calls.at(-1)![0];
  await act(async () => { onStatus('closed'); await new Promise((resolve) => setTimeout(resolve, 300)); });
  await flush();
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
    expect(container.querySelector('[data-conn-edit]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-conn-edit]')!.click(); });
    expect(container.querySelector('#st-conn-token')).not.toBeNull();
    expect(container.querySelector('#st-card-conn-owned')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    expect(container.querySelector('[data-conn-edit]')).toBeNull();
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
    // Scope preparation is serialized: the cancelled attempt must release its
    // tunnel before the newer attempt can commit, even if its result is ready.
    expect(connections).toBe(1);
    expect(container.querySelector('[data-scope-id]')?.textContent).toBe('local');
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
    await loseLocalConnection(localConfig.url);
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
    await loseLocalConnection(localConfig.url);
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

  it('invalidates stale meta and validates a native ready endpoint without requesting another startup', async () => {
    const oldConfig = { url: 'http://127.0.0.1:41001', token: 'old-token' };
    const intermediateConfig = { url: 'http://127.0.0.1:41501', token: 'middle-token' };
    const newConfig = { url: 'http://127.0.0.1:42002', token: 'new-token' };
    const staleMeta = deferred<object>();
    const newMeta = deferred<object>();
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: oldConfig, persist: false })
      .mockResolvedValueOnce({ config: intermediateConfig, persist: false });
    const identity = { server_id: 'original', server_home_id: 'd92a5d0d-7059-4dd4-b16b-1bc1d179f09e', current_space_id: 'main', dangerous_bypass_auth: false };
    mocks.meta.mockResolvedValueOnce(identity)
      .mockReturnValueOnce(staleMeta.promise).mockReturnValueOnce(newMeta.promise);
    const container = await mountProvider();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(oldConfig.url);
    await loseLocalConnection(oldConfig.url);
    expect(mocks.terminalSubscriptions[0]!.close).not.toHaveBeenCalled();
    expect(mocks.klients[0]!.close).not.toHaveBeenCalled();
    expect(mocks.meta).toHaveBeenCalledTimes(2);
    await emitStage({ stage: 'ready', connection: newConfig });
    await flush();
    staleMeta.resolve({ ...identity, server_id: 'superseded' });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(oldConfig.url);
    expect(mocks.terminalSubscriptions).toHaveLength(1);
    expect(mocks.klients[1]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.meta).toHaveBeenCalledTimes(3);
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
    newMeta.resolve({ ...identity, server_id: 'replacement' });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(newConfig.url);
    expect(mocks.terminalSubscriptions).toHaveLength(1);
    expect(mocks.klients).toHaveLength(3);
    expect(mocks.klients[0]).toMatchObject({ endpoint: newConfig.url, token: newConfig.token, closed: false });
    expect(mocks.klients[2]!.close).toHaveBeenCalledTimes(1);
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
    await loseLocalConnection(oldConfig.url);
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
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(oldConfig.url);
    expect(mocks.terminalSubscriptions).toHaveLength(1);
    expect(mocks.terminalSubscriptions[0]!.close).not.toHaveBeenCalled();
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
  const identity = {
    server_id: 'local', server_version: '0.1.0', server_home_id: 'a9ba1f7e-c97b-4d53-a424-e79c1662c019',
    current_space_id: 'main', dangerous_bypass_auth: false, started_at: '2026-11-03T00:00:00.000Z',
  };

  beforeEach(() => {
    recoveryControllers.length = 0;
    mocks.meta.mockImplementation(() => Promise.resolve(identity));
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
  const mountRecovery = () => mountProvider(false, false, false, false, true, true);

  it('retains the client, controller and edited draft through same-instance discovery and identity verification', async () => {
    mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
    const container = await mountRecovery();
    const draft = container.querySelector<HTMLInputElement>('[data-recovery-draft]')!;
    draft.value = 'keep this unfinished message';
    const before = mocks.klients[0]!;
    const status = statusHandler();
    await status('open');
    const discovery = deferred<{ config: typeof firstPort; persist: boolean }>();
    const verified = deferred<object>();
    mocks.detectLocalConnection.mockReturnValueOnce(discovery.promise);
    mocks.meta.mockReturnValueOnce(verified.promise);
    await status('closed');
    await settle();
    expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
    expect(mocks.klients).toEqual([before]);
    expect(recoveryControllers).toHaveLength(1);
    expect(recoveryControllers[0]!.close).not.toHaveBeenCalled();
    await act(async () => { discovery.resolve({ config: { url: `${firstPort.url}///`, token: ` ${firstPort.token} ` }, persist: false }); });
    await status('open');
    expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('connecting');
    await act(async () => { verified.resolve(identity); });
    await flush();
    expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('open');
    expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
    expect(draft.value).toBe('keep this unfinished message');
    expect(before.close).not.toHaveBeenCalled();
    expect(recoveryControllers[0]!.open).toHaveBeenCalledTimes(1);
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
    expect(mocks.meta).toHaveBeenCalledTimes(2);
  });

  it('revalidates a same-endpoint native ready event without replacing the client or view', async () => {
    mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
    const container = await mountRecovery();
    const draft = container.querySelector('[data-recovery-draft]');
    await statusHandler()('open');
    await emitStage({ stage: 'ready', connection: firstPort });
    await flush();
    expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
    expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('open');
    expect(mocks.klients).toHaveLength(1);
    expect(mocks.klients[0]!.close).not.toHaveBeenCalled();
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(1);
    expect(mocks.meta).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['server instance', { server_id: 'replacement' }, firstPort],
    ['service generation', { started_at: '2026-11-03T00:01:00.000Z' }, firstPort],
    ['bearer identity', { server_id: 'replacement' }, { ...firstPort, token: 'replacement-token' }],
    ['random port', { server_id: 'replacement' }, restartedPort],
  ] as const)('preserves the controller, draft and reading surface when the verified %s changes', async (_reason, patch, config) => {
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: firstPort, persist: false }).mockResolvedValue({ config, persist: false });
    const container = await mountRecovery();
    const draft = container.querySelector<HTMLInputElement>('[data-recovery-draft]')!;
    draft.value = 'a draft written before service replacement';
    const reading = container.querySelector<HTMLElement>('[data-recovery-reading]')!;
    reading.scrollTop = 713;
    const previous = mocks.klients[0]!;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-write-cache]')!.click(); });
    mocks.meta.mockResolvedValue({ ...identity, ...patch });
    await statusHandler()('closed');
    await settle();
    expect(previous.close).not.toHaveBeenCalled();
    expect(recoveryControllers[0]!.close).not.toHaveBeenCalled();
    expect(recoveryControllers).toHaveLength(1);
    expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
    expect(draft.value).toBe('a draft written before service replacement');
    expect(container.querySelector('[data-recovery-reading]')).toBe(reading);
    expect(reading.scrollTop).toBe(713);
    expect(container.querySelector('[data-cache-value]')?.textContent).toBe('local');
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(config.url);
    expect(previous).toMatchObject({ endpoint: config.url, token: config.token, closed: false });
    expect(mocks.rebindDesktop).toHaveBeenCalledWith(config);
  });

  it('does not treat the synchronous socket restart inside a verified rebind as a new discovery failure', async () => {
    vi.useFakeTimers();
    try {
      mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
      const container = await mountRecovery();
      await statusHandler()('open');
      const controller = recoveryControllers[0]!;
      mocks.meta.mockResolvedValue({ ...identity, server_id: 'replacement' });
      await emitStage({ stage: 'ready', connection: { ...restartedPort, token: 'rotated-token' } });
      await flush();
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('connecting');
      await statusHandler()('open');
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('open');
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('open');
      expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-connected-url]')?.textContent).toBe(restartedPort.url);
      expect(recoveryControllers).toEqual([controller]);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['server home', { server_home_id: '462f8d09-a1bf-4d73-bd20-49ec3b4b2fd4' }],
    ['space', { current_space_id: 'another-space' }],
    ['missing space', { current_space_id: undefined }],
    ['unknown identity', { server_home_id: undefined }],
    ['authentication mode', { dangerous_bypass_auth: true }],
    ['missing authentication mode', { dangerous_bypass_auth: undefined }],
  ] as const)('rejects a candidate whose %s changed without dropping the prior view or binding', async (_reason, patch) => {
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: firstPort, persist: false }).mockResolvedValue({ config: restartedPort, persist: false });
    const container = await mountRecovery();
    const draft = container.querySelector('[data-recovery-draft]');
    const previous = mocks.klients[0]!;
    mocks.meta.mockResolvedValue({ ...identity, ...patch });
    await statusHandler()('closed');
    await settle();
    expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('closed');
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(firstPort.url);
    expect(previous).toMatchObject({ endpoint: firstPort.url, token: firstPort.token, closed: false });
    expect(previous.close).not.toHaveBeenCalled();
    expect(recoveryControllers).toHaveLength(1);
    expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
    expect(container.querySelector('[data-recovery-state]')?.textContent).toBe('blocked');
    expect(container.querySelector('[data-recovery-kind]')?.textContent).toBe(_reason.includes('authentication') ? 'authentication' : 'identity');
  });

  it.each(['identity', 'authentication', 'protocol'] as const)('parks structured native %s refusals without automatic retries or a stale socket reopening the view', async (kind) => {
    vi.useFakeTimers();
    try {
      mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
      const container = await mountRecovery();
      const draft = container.querySelector('[data-recovery-draft]');
      await statusHandler()('open');
      const diagnostic = 'The local service identity, authentication mode or GUI protocol is unavailable. Reopen the intended space or inspect its service logs; no second service was started.';
      mocks.detectLocalConnection.mockRejectedValue({ kind, message: diagnostic });
      await statusHandler()('closed');
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(container.querySelector('[data-recovery-state]')?.textContent).toBe('blocked');
      expect(container.querySelector('[data-recovery-error]')?.textContent).toBe(diagnostic);
      for (const status of ['open', 'closed', 'connecting', 'open']) await statusHandler()(status);
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-recovery-retry]')!.click(); await vi.advanceTimersByTimeAsync(60_000); });
      expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('closed');
      expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
      expect(container.querySelector('[data-connected-url]')?.textContent).toBe(firstPort.url);
      expect(recoveryControllers).toHaveLength(1);
      mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
      if (kind === 'identity') mocks.meta.mockRejectedValueOnce(new Error('metadata temporarily unavailable after refusal'));
      await emitStage({ stage: 'ready', connection: firstPort });
      await flush();
      if (kind === 'identity') {
        expect(container.querySelector('[data-recovery-state]')?.textContent).toBe('retrying');
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        await flush();
      }
      await statusHandler()('open');
      expect(container.querySelector('[data-recovery-state]')?.textContent).toBe('');
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('open');
      expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
      expect(recoveryControllers).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('automatically retries a temporarily unreachable replacement and retains the view until it verifies', async () => {
    vi.useFakeTimers();
    try {
      mocks.detectLocalConnection.mockResolvedValueOnce({ config: firstPort, persist: false })
        .mockRejectedValueOnce(new Error('service is starting'))
        .mockResolvedValue({ config: { ...restartedPort, token: 'rotated-token' }, persist: false });
      const container = await mountRecovery();
      const draft = container.querySelector<HTMLInputElement>('[data-recovery-draft]')!;
      draft.value = 'preserve through automatic retry';
      const reading = container.querySelector<HTMLElement>('[data-recovery-reading]')!;
      reading.scrollTop = 713;
      const controller = recoveryControllers[0]!;
      await statusHandler()('closed');
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('closed');
      mocks.meta.mockResolvedValue({ ...identity, server_id: 'replacement' });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      await flush();
      expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(3);
      expect(container.querySelector('[data-connected-url]')?.textContent).toBe(restartedPort.url);
      expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
      expect(draft.value).toBe('preserve through automatic retry');
      expect(container.querySelector('[data-recovery-reading]')).toBe(reading);
      expect(reading.scrollTop).toBe(713);
      expect(recoveryControllers).toEqual([controller]);
      expect(controller.close).not.toHaveBeenCalled();
      await statusHandler()('open');
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('recovers an initial desktop discovery failure without requiring a restart button', async () => {
    vi.useFakeTimers();
    try {
      mocks.detectLocalConnection.mockRejectedValueOnce(new Error('service temporarily unavailable'))
        .mockResolvedValue({ config: firstPort, persist: false });
      const container = await mountRecovery();
      expect(container.textContent).toContain('service temporarily unavailable');
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      await flush();
      expect(container.querySelector('[data-connected-url]')?.textContent).toBe(firstPort.url);
      expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it.each(['discovery failure', 'metadata failure'] as const)(
    'keeps retained facts disconnected and retryable after %s rather than claiming no host', async (failure) => {
      mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
      const container = await mountRecovery();
      const draft = container.querySelector<HTMLInputElement>('[data-recovery-draft]')!;
      draft.value = 'retry without losing this draft';
      const status = statusHandler();
      await status('open');
      if (failure === 'discovery failure') mocks.detectLocalConnection.mockRejectedValueOnce(new Error('lookup unavailable'));
      else mocks.meta.mockRejectedValueOnce(new Error('metadata unavailable'));
      await status('closed');
      await settle();
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('closed');
      expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
      expect(container.querySelector('[data-connected-url]')?.textContent).toBe(firstPort.url);
      expect(mocks.klients[0]!.close).not.toHaveBeenCalled();
      expect(recoveryControllers[0]!.close).not.toHaveBeenCalled();
      await status('open');
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('closed');
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-recovery-retry]')!.click(); });
      await settle();
      expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('open');
      expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
      expect(draft.value).toBe('retry without losing this draft');
      expect(mocks.klients).toHaveLength(1);
      expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(3);
    },
  );

  it('discards a superseded same-instance proof after native supplies a new endpoint', async () => {
    mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
    const container = await mountRecovery();
    const oldMeta = deferred<object>();
    mocks.meta.mockReturnValueOnce(oldMeta.promise);
    await statusHandler()('closed');
    await settle();
    await emitStage({ stage: 'ready', connection: restartedPort });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(restartedPort.url);
    await statusHandler()('open');
    await act(async () => { oldMeta.resolve(identity); });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(restartedPort.url);
    expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('open');
    expect(mocks.klients).toHaveLength(2);
    expect(mocks.klients[0]!.close).not.toHaveBeenCalled();
    expect(mocks.klients[1]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
  });

  it('keeps retained facts disconnected after a native failure supersedes an identity check', async () => {
    mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
    const container = await mountRecovery();
    const draft = container.querySelector('[data-recovery-draft]');
    const oldMeta = deferred<object>();
    mocks.meta.mockReturnValueOnce(oldMeta.promise);
    await statusHandler()('closed');
    await settle();
    await emitStage({ stage: 'failed', failure: { message: 'recovery failed', stderrTail: [], logPath: null } });
    await act(async () => { oldMeta.resolve(identity); });
    await flush();
    expect(container.querySelector('[data-recovery-status]')?.textContent).toBe('closed');
    expect(container.querySelector('[data-recovery-draft]')).toBe(draft);
    expect(mocks.klients[0]!.close).not.toHaveBeenCalled();
    expect(recoveryControllers[0]!.close).not.toHaveBeenCalled();
  });

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

  it('joins repeated loss notifications while one discovery is pending', async () => {
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: firstPort, persist: false });
    const container = await mountProvider();
    const slow = deferred<{ config: typeof restartedPort; persist: boolean }>();
    mocks.detectLocalConnection.mockReturnValueOnce(slow.promise);
    const close = statusHandler();
    await close('closed');
    await settle();
    await close('closed');
    await emitStage('waiting');
    await emitStage('waiting');
    await settle();
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
    await act(async () => { slow.resolve({ config: restartedPort, persist: false }); });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(restartedPort.url);
  });

  it('does not rediscover or clear a healthy connection for an unsolicited progress event', async () => {
    mocks.detectLocalConnection.mockResolvedValue({ config: firstPort, persist: false });
    const container = await mountProvider();
    await emitStage('waiting');
    await emitStage('waiting');
    await settle();
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(firstPort.url);
    expect(mocks.klients[0]!.close).not.toHaveBeenCalled();
  });

  it('breaks native waiting feedback during the first cold discovery and accepts that same result', async () => {
    const cold = deferred<{ config: typeof firstPort; persist: boolean }>();
    mocks.detectLocalConnection.mockImplementation(() => {
      mocks.stageListener?.({ payload: 'waiting' });
      return cold.promise;
    });
    const container = await mountProvider();
    await emitStage('waiting');
    await emitStage('waiting');
    await settle();
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-connected-url]')).toBeNull();
    await act(async () => { cold.resolve({ config: firstPort, persist: false }); });
    await flush();
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(firstPort.url);
  });

  it('keeps cancellation visible after late progress and results, then permits one explicit retry', async () => {
    const cold = deferred<{ config: typeof firstPort; persist: boolean }>();
    mocks.detectLocalConnection.mockReturnValueOnce(cold.promise);
    const container = await mountProvider();
    const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent === label)!;
    await act(async () => { button('Cancel startup').click(); });
    await emitStage('waiting');
    await emitStage({ stage: 'ready', connection: restartedPort });
    await act(async () => { cold.resolve({ config: firstPort, persist: false }); });
    await flush();
    expect(container.textContent).toContain('Desktop backend startup was cancelled.');
    expect(container.querySelector('[data-connected-url]')).toBeNull();
    expect(mocks.meta).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_desktop_startup', undefined);
    mocks.detectLocalConnection.mockResolvedValueOnce({ config: restartedPort, persist: false });
    await act(async () => { button('Retry startup').click(); });
    await flush();
    expect(mocks.detectLocalConnection).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(restartedPort.url);
  });
});

describe('mobile shell credential lifecycle in ConnectionProvider', () => {
  function ShellStatusHarness() {
    const connection = useConnection();
    return (
      <>
        <span data-shell-source>{connection.connectionSource ?? 'none'}</span>
        <span data-shell-token>{connection.config.token}</span>
        <span data-shell-url>{connection.config.url}</span>
        <button
          type="button"
          data-manual-owner
          onClick={() => connection.applyConnection({ url: '', token: 'manual-owner-token' })}
        />
        <button type="button" data-disconnect-shell onClick={connection.disconnect} />
      </>
    );
  }

  async function mountBrowserShell(): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const entry = { container, root };
    mounted.push(entry);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <HostProvider host={browserHost}>
            <ConnectionProvider>
              <ShellStatusHarness />
            </ConnectionProvider>
          </HostProvider>
        </I18nProvider>
      </QueryClientProvider>
    );
    await act(async () => {
      root.render(tree);
    });
    await flush();
    return {
      container,
      unmount: async () => {
        const idx = mounted.indexOf(entry);
        if (idx >= 0) mounted.splice(idx, 1);
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  it('retires staged shell credentials on manual owner switch and disconnect so reload does not restore the old shell token', async () => {
    mocks.meta.mockResolvedValue({
      server_id: 'srv-1',
      server_home_id: 'home-1',
      server_version: '0.1.0',
      current_space_id: 'main',
      dangerous_bypass_auth: false,
    });
    expect(applyCommittedShellCredential(window, window.location.origin, 'shell-peer-token-1')).toBe(true);
    expect(localStorage.getItem('kiki.connection')).toBeNull();
    expect(localStorage.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();

    const first = await mountBrowserShell();
    expect(first.container.querySelector('[data-shell-token]')?.textContent).toBe('shell-peer-token-1');
    expect(localStorage.getItem('kiki.connection')).toBeNull();
    expect(sessionStorage.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();

    // Switch to manual owner credential on the same origin
    await act(async () => {
      first.container.querySelector<HTMLButtonElement>('[data-manual-owner]')!.click();
    });
    await flush();
    expect(first.container.querySelector('[data-shell-token]')?.textContent).toBe('manual-owner-token');
    expect(first.container.querySelector('[data-shell-source]')?.textContent).toBe('manual');
    expect(localStorage.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();

    // Simulate reload / re-entry even if a stale staged token remained in sessionStorage
    sessionStorage.setItem(SHELL_PEER_TOKEN_KEY, 'shell-peer-token-1');
    await first.unmount();

    const reloaded = await mountBrowserShell();
    expect(reloaded.container.querySelector('[data-shell-token]')?.textContent).toBe('manual-owner-token');
    expect(sessionStorage.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();

    // Disconnect retires stored and shell credentials; reload stays on ConnectScreen
    sessionStorage.setItem(SHELL_PEER_TOKEN_KEY, 'shell-peer-token-1');
    localStorage.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
    await act(async () => {
      reloaded.container.querySelector<HTMLButtonElement>('[data-disconnect-shell]')!.click();
    });
    await flush();
    expect(reloaded.container.querySelector('[data-shell-token]')).toBeNull();
    expect(localStorage.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();
    await reloaded.unmount();

    const afterDisconnectReload = await mountBrowserShell();
    expect(afterDisconnectReload.container.querySelector('[data-shell-token]')).toBeNull();
  });

  it('preserves web-cookie (#access=) sessions and never converts them to bearer when shell tokens are staged or dispatched', async () => {
    mocks.meta.mockResolvedValue({
      server_id: 'srv-cookie',
      server_home_id: 'home-cookie',
      server_version: '0.1.0',
      current_space_id: 'main',
      dangerous_bypass_auth: false,
    });
    localStorage.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
    sessionStorage.setItem(SHELL_PEER_TOKEN_KEY, 'stale-shell-token');
    setWebAccessBootstrap({ kind: 'signed-in' });
    try {
      const mountedCookie = await mountBrowserShell();
      expect(mountedCookie.container.querySelector('[data-shell-source]')?.textContent).toBe('web-cookie');
      expect(mountedCookie.container.querySelector('[data-shell-token]')?.textContent).toBe('');
      expect(localStorage.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();

      await act(async () => {
        expect(applyCommittedShellCredential(window, window.location.origin, 'injected-shell-token')).toBe(false);
      });
      await flush();
      expect(mountedCookie.container.querySelector('[data-shell-source]')?.textContent).toBe('web-cookie');
      expect(mountedCookie.container.querySelector('[data-shell-token]')?.textContent).toBe('');
      await mountedCookie.unmount();

      // True refresh after #access= redemption: URL has no fragment (`webAccessBootstrap` resets to `none`),
      // HttpOnly cookie is still valid (`/api/web-access/session` returns `authenticated: true`),
      // and even if legacy/staged shell state lingered, the refreshed page adopts `web-cookie` and retires shell state.
      resetWebAccessBootstrap();
      localStorage.setItem('kiki.connection', JSON.stringify({ url: '', token: 'legacy-shell-token' }));
      localStorage.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
      sessionStorage.setItem(SHELL_PEER_TOKEN_KEY, 'stale-shell-token');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).endsWith('/api/web-access/session')) {
            return {
              ok: true,
              json: async () => ({ code: 0, data: { authenticated: true } }),
            } as Response;
          }
          return { ok: false, status: 404, json: async () => ({}) } as Response;
        }),
      );
      const refreshedCookie = await mountBrowserShell();
      await flush();
      expect(refreshedCookie.container.querySelector('[data-shell-source]')?.textContent).toBe('web-cookie');
      expect(refreshedCookie.container.querySelector('[data-shell-token]')?.textContent).toBe('');
      expect(localStorage.getItem('kiki.connection')).toBeNull();
      expect(localStorage.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(SHELL_PEER_TOKEN_KEY)).toBeNull();
    } finally {
      resetWebAccessBootstrap();
    }
  });

  it('delivers late shell credentials to ConnectionProvider when main.tsx bootstrap listener is already registered and preserves owner url+token with legacy marker', async () => {
    mocks.meta.mockResolvedValue({
      server_id: 'srv-late',
      server_home_id: 'home-late',
      server_version: '0.1.0',
      current_space_id: 'main',
      dangerous_bypass_auth: false,
    });
    // 1. Register the long-lived no-callback bootstrap listener first (matching src/main.tsx:67),
    // then mount ConnectionProvider (which registers its callback listener), then inject credential late.
    const uninstallBootstrap = installAppShellCredentialListener(window);
    try {
      const mountedLate = await mountBrowserShell();
      expect(mountedLate.container.querySelector('[data-shell-token]')).toBeNull();

      // Bare unbacked CustomEvent must not adopt any token
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('kiki:shell-token', {
            detail: { origin: window.location.origin, token: 'forged-bare-event-token' },
          }),
        );
      });
      await flush();
      expect(mountedLate.container.querySelector('[data-shell-token]')).toBeNull();

      // Late post-commit delivery after both listeners are active must be adopted by ConnectionProvider
      await act(async () => {
        expect(
          applyCommittedShellCredential(window, window.location.origin, 'late-post-mount-peer-token'),
        ).toBe(true);
      });
      await flush();
      expect(mountedLate.container.querySelector('[data-shell-token]')?.textContent).toBe(
        'late-post-mount-peer-token',
      );
      expect(mountedLate.container.querySelector('[data-shell-source]')?.textContent).toBe('app-shell');
      await mountedLate.unmount();

      // 2. Manual owner connection (`url: 'https://owner.example.test'`) + stale `kiki.shell.managed = '1'`
      // is preserved across startup and late shell injection.
      clearAppShellCredentialState(window);
      localStorage.setItem(
        'kiki.connection',
        JSON.stringify({ url: 'https://owner.example.test', token: 'owner-preserved-token' }),
      );
      localStorage.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
      const mountedOwner = await mountBrowserShell();
      await flush();
      expect(mountedOwner.container.querySelector('[data-shell-url]')?.textContent).toBe(
        'https://owner.example.test',
      );
      expect(mountedOwner.container.querySelector('[data-shell-token]')?.textContent).toBe(
        'owner-preserved-token',
      );
      expect(localStorage.getItem(SHELL_MANAGED_STORAGE_KEY)).toBeNull();
      expect(JSON.parse(localStorage.getItem('kiki.connection') ?? 'null')).toEqual({
        url: 'https://owner.example.test',
        token: 'owner-preserved-token',
      });
      await mountedOwner.unmount();
    } finally {
      uninstallBootstrap();
    }
  });

  it('gives paired credentials app-shell provenance and blocks Settings ConnectionSection KEEP URL edits from persisting or forwarding the paired peer token while allowing explicit owner credentials', async () => {
    mocks.meta.mockResolvedValue({
      server_id: 'srv-paired',
      server_home_id: 'home-paired',
      server_version: '0.1.0',
      current_space_id: 'main',
      dangerous_bypass_auth: false,
    });
    expect(applyCommittedShellCredential(window, window.location.origin, 'paired-peer-secret-token')).toBe(true);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const entry = { container, root };
    mounted.push(entry);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          path: '/settings/connection',
          element: (
            <>
              <ShellStatusHarness />
              <ConnectionSection />
            </>
          ),
        },
      ],
      { initialEntries: ['/settings/connection'] },
    );
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <HostProvider host={browserHost}>
              <ConnectionProvider>
                <RouterProvider router={router} />
              </ConnectionProvider>
            </HostProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(container.querySelector('[data-shell-source]')?.textContent).toBe('app-shell');
    expect(container.querySelector('[data-shell-token]')?.textContent).toBe('paired-peer-secret-token');
    expect(localStorage.getItem('kiki.connection')).toBeNull();

    const setInputValue = async (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };

    // 1. Same-origin URL edit with default KEEP_SECRET keeps the verified app-shell pairing without persisting to localStorage
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-conn-edit]')!.click();
    });
    const sameOriginUrlInput = container.querySelector<HTMLInputElement>('#st-conn-url')!;
    const sameOriginTokenInput = container.querySelector<HTMLInputElement>('#st-conn-token')!;
    expect(sameOriginTokenInput.value).toBe('');
    expect(sameOriginTokenInput.readOnly).toBe(false);
    await setInputValue(sameOriginUrlInput, window.location.origin);
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.querySelector('[data-shell-source]')?.textContent).toBe('app-shell');
    expect(container.querySelector('[data-shell-url]')?.textContent).toBe(window.location.origin);
    expect(container.querySelector('[data-shell-token]')?.textContent).toBe('paired-peer-secret-token');
    expect(localStorage.getItem('kiki.connection')).toBeNull();

    // 2. Cross-origin URL edit with default KEEP_SECRET neither persists the paired peer token nor sends it to the edited origin
    const klientCountBeforeCrossOrigin = mocks.klients.length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-conn-edit]')!.click();
    });
    const crossOriginUrlInput = container.querySelector<HTMLInputElement>('#st-conn-url')!;
    await setInputValue(crossOriginUrlInput, 'http://edited-other-origin.example.test:9090');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(localStorage.getItem('kiki.connection')).toBeNull();
    const newKlients = mocks.klients.slice(klientCountBeforeCrossOrigin);
    expect(newKlients.length).toBeGreaterThan(0);
    for (const created of newKlients) {
      expect(created.endpoint).toBe('http://edited-other-origin.example.test:9090');
      expect(created.token ?? '').toBe('');
      expect(created.token).not.toBe('paired-peer-secret-token');
    }

    // 3. Re-adopt paired credential, then explicitly enter an independent owner token in Settings -> saves to localStorage as manual owner
    await act(async () => {
      expect(applyCommittedShellCredential(window, window.location.origin, 'paired-peer-secret-token-2')).toBe(true);
    });
    await flush();
    expect(container.querySelector('[data-shell-source]')?.textContent).toBe('app-shell');
    expect(container.querySelector('[data-shell-token]')?.textContent).toBe('paired-peer-secret-token-2');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-conn-edit]')!.click();
    });
    const explicitUrlInput = container.querySelector<HTMLInputElement>('#st-conn-url')!;
    const explicitTokenInput = container.querySelector<HTMLInputElement>('#st-conn-token')!;
    await setInputValue(explicitUrlInput, 'http://explicit-owner.example.test:8080');
    await setInputValue(explicitTokenInput, 'explicit-owner-bearer-token');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.querySelector('[data-shell-source]')?.textContent).toBe('manual');
    expect(container.querySelector('[data-shell-url]')?.textContent).toBe('http://explicit-owner.example.test:8080');
    expect(container.querySelector('[data-shell-token]')?.textContent).toBe('explicit-owner-bearer-token');
    expect(JSON.parse(localStorage.getItem('kiki.connection') ?? 'null')).toEqual({
      url: 'http://explicit-owner.example.test:8080',
      token: 'explicit-owner-bearer-token',
    });
  });
});
