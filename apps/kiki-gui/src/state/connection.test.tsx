// @vitest-environment jsdom

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    closed: boolean;
    close: ReturnType<typeof vi.fn>;
    global: { mcp: { list: ReturnType<typeof vi.fn> } };
  }>,
  sockets: [] as Array<{
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

vi.mock('@moonshot-ai/klient/http', () => ({
  createKlient: (options: { endpoint: string; token?: string }) => {
    const klient: (typeof mocks.klients)[number] = {
      ...options,
      closed: false,
      close: vi.fn(),
      global: { mcp: { list: vi.fn() } },
    };
    klient.close.mockImplementation(async () => {
      klient.closed = true;
    });
    klient.global.mcp.list.mockImplementation(async () => {
      if (klient.closed) throw new Error('klient closed');
      return [];
    });
    mocks.klients.push(klient);
    return klient;
  },
}));

vi.mock('../lib/client', () => ({
  ApiError: class ApiError extends Error {},
  KikiClient: class KikiClient {
    readonly baseUrl: string;

    constructor(options: { baseUrl: string }) {
      this.baseUrl = options.baseUrl;
    }

    meta() {
      return mocks.meta(this.baseUrl);
    }

    renewLease(body: { clientId: string; kind: 'gui' }) {
      return mocks.renewLease(body);
    }
  },
}));

vi.mock('../lib/ws', () => ({
  KikiSocket: class KikiSocket {
    readonly connectionGeneration = 0;
    readonly baseUrl: string;
    readonly connect = vi.fn();
    readonly close = vi.fn();
    readonly nudge = vi.fn();

    constructor(options: { baseUrl: string }) {
      this.baseUrl = options.baseUrl;
      mocks.sockets.push(this);
    }
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
  mocks.sockets.length = 0;
  mocks.stageListener = undefined;
  localStorage.clear();
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
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.klients).toHaveLength(1);
    expect(mocks.klients[0]).toMatchObject({ endpoint: oldConfig.url, token: oldConfig.token });

    await emitStage('waiting');
    await flush();
    expect(mocks.sockets[0]!.close).toHaveBeenCalledTimes(1);
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
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.klients[1]!.close).toHaveBeenCalledTimes(1);

    newDesktopConnection.resolve({ config: newConfig, persist: false });
    await flush();
    expect(mocks.meta).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-connected-url]')).toBeNull();

    newMeta.resolve({ serverVersion: 'test' });
    await flush();
    expect(container.querySelector('[data-connected-url]')?.textContent).toBe(newConfig.url);
    expect(mocks.sockets).toHaveLength(2);
    expect(mocks.klients).toHaveLength(3);
    expect(mocks.klients[2]).toMatchObject({ endpoint: newConfig.url, token: newConfig.token });
    expect(mocks.sockets[1]!.baseUrl).toBe(newConfig.url);
    expect(mocks.sockets[1]!.connect).toHaveBeenCalledTimes(1);
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
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.sockets[0]!.close).toHaveBeenCalledTimes(1);
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
