// @vitest-environment jsdom

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeSettings } from '@kiki/session-core/settings';
import { browserHost, HostProvider } from '../host';
import { I18nProvider } from '../i18n';
import { ConnectionProvider, nextGuiLeaseClientId, useConnection } from './connection';

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
  return <span data-connected-url>{connection.config.url}</span>;
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

async function mountProvider(strict = false): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const connection = (
    <ConnectionProvider>
      {strict ? <StrictLifecycleHarness /> : <ConnectedHarness />}
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
