// @vitest-environment jsdom

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeSettings } from '@kiki/session-core/settings';
import type { SessionController } from '@kiki/session-core/session';
import { browserHost, HostProvider } from '../host';
import { I18nProvider } from '../i18n';
import { ConnectionSection } from '../components/settings/ConnectionSection';
import { ConnectionProvider, LiveControllerRegistry, nextGuiLeaseClientId, useConnection } from './connection';

const mocks = vi.hoisted(() => ({
  detectLocalConnection: vi.fn(),
  invoke: vi.fn(),
  meta: vi.fn(),
  renewLease: vi.fn(),
  klients: [] as Array<{
    endpoint: string;
    token?: string;
    timeoutMs?: number;
    closed: boolean;
    close: ReturnType<typeof vi.fn>;
    global: { mcp: { list: ReturnType<typeof vi.fn> } };
    events: { on: ReturnType<typeof vi.fn> };
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
      : mocks.invoke(command, args),
  isTauri: () => true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_event: string, listener: (event: { payload: unknown }) => void) => {
    mocks.stageListener = listener;
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
        global: { mcp: { list: vi.fn(async () => {
          if (klient.closed) throw new Error('klient closed');
          return [];
        }) } },
        events: { on: vi.fn(() => ({ dispose: vi.fn(), ready: Promise.resolve() })) },
        terminal: {
          nudge: vi.fn(),
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
  return <>
    <span data-connected-url>{connection.config.url}</span>
    <span data-scope-id>{connection.scopeId}</span>
    <span data-cache-value>{queryClient.getQueryData(['workspaces']) ?? 'empty'}</span>
    <button type="button" data-write-cache onClick={() => {
      queryClient.setQueryData(['workspaces'], connection.scopeId);
    }} />
    <button type="button" data-switch-ssh onClick={() => void connection.activateSshProfile('host-1', 'a'.repeat(43))} />
    <button type="button" data-switch-local onClick={connection.activateLocal} />
  </>;
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
  mocks.renewLease.mockReset();
  mocks.renewLease.mockResolvedValue(undefined);
  mocks.klients.length = 0;
  mocks.terminalSubscriptions.length = 0;
  mocks.stageListener = undefined;
  localStorage.clear();
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

async function mountProvider(strict = false, settings = false): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const connection = (
    <ConnectionProvider>
      {strict ? <StrictLifecycleHarness /> : <><ConnectedHarness />{settings ? <ConnectionSection /> : null}</>}
    </ConnectionProvider>
  );
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
    expect(container.querySelector('[data-connected-url]')).toBeNull();
    expect(container.textContent).toContain('SSH server identity changed');
    expect(container.textContent).toContain('SSH connection blocked');
    const switchLocal = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch to this computer');
    expect(switchLocal).toBeDefined();
    expect(container.textContent).not.toContain('Retry startup');
    await act(async () => { switchLocal!.click(); });
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
    expect(container.querySelector('[data-connected-url]')).toBeNull();
    expect(container.textContent).toContain('SSH server identity changed');
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
    expect(mocks.invoke).toHaveBeenCalledWith('disconnect_ssh_profile', { id: 'host-1', tunnelId: 'tunnel-one' });

    mocks.meta.mockImplementation((url: string) => Promise.resolve(url === remoteConfig.url ? {
      server_home_id: 'unexpected-home', server_id: 'server-remote', server_version: '0.1.0',
      build_id: 'test-build', build_channel: 'stable',
    } : { server_id: 'server-local' }));
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-ssh]')!.click(); });
    await flush();
    expect(container.querySelector('[data-connected-url]')).toBeNull();
    expect(container.textContent).toContain('SSH server identity changed');
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
