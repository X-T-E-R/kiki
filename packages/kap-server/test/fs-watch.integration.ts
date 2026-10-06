import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IRuntimeResolver, ISessionManager, IWorkspaceInstanceManager } from '@kiki/agent-core-v2';
import type { HostFsChange, IHostFsWatchService } from '@kiki/agent-core-v2/os/interface/hostFsWatch';
import { FakeRuntime } from '@kiki/agent-core-v2/runtime/fakeRuntime';
import type { RuntimeProviderRuntimeHandle } from '@kiki/agent-core-v2/runtime/runtimeUnitHost';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { startServer, type RunningServer } from '../src/start';
import { FsWatchBridge, type FsChangedFrame, type FsWatchConnection } from '../src/transport/ws/v1/fsWatchBridge';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

let tmpDir: string;
let bridgeHome: string;
let workspace: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kap-fswatch-'));
  bridgeHome = mkdtempSync(join(tmpdir(), 'kap-fswatch-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'docs'), { recursive: true });
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
  }
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  rmSync(bridgeHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function boot(): Promise<RunningServer> {
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: bridgeHome,
    logger: pino({ level: 'silent' }),
    disableAuth: true,
  });
  return server;
}

function addressOf(r: RunningServer): string {
  return `http://${r.host}:${r.port}`;
}

function wsUrl(r: RunningServer): string {
  return `${addressOf(r).replace(/^http/, 'ws')}/api/ws`;
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await fetch(`${addressOf(r)}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: { cwd: workspace } }),
  });
  const env = (await res.json()) as { code: number; data: { id: string } | null };
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

interface WsFrame {
  type: string;
  payload?: Record<string, unknown>;
  id?: string;
  code?: number;
  msg?: string;
  seq?: number;
  session_id?: string;
}

interface Conn {
  ws: WebSocket;
  queue: WsFrame[];
  waiters: Array<(frame: WsFrame) => void>;
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function openConn(url: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    ws.on('message', (data) => {
      let parsed: WsFrame;
      try {
        parsed = JSON.parse(rawToString(data)) as WsFrame;
      } catch {
        return;
      }
      if (waiters.length > 0) waiters.shift()?.(parsed);
      else queue.push(parsed);
    });
    ws.once('open', () => resolve({ ws, queue, waiters }));
    ws.once('error', (err) => reject(err));
  });
}

function receive(conn: Conn, timeoutMs: number): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    if (conn.queue.length > 0) {
      resolve(conn.queue.shift()!);
      return;
    }
    const t = setTimeout(() => {
      const idx = conn.waiters.indexOf(waiter);
      if (idx >= 0) conn.waiters.splice(idx, 1);
      reject(new Error(`no message in ${timeoutMs}ms`));
    }, timeoutMs);
    const waiter = (frame: WsFrame): void => {
      clearTimeout(t);
      resolve(frame);
    };
    conn.waiters.push(waiter);
  });
}

async function receiveType(conn: Conn, type: string, timeoutMs: number): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no message of type ${type} within ${timeoutMs}ms`);
    const frame = await receive(conn, remaining);
    if (frame.type === type) return frame;
  }
}

async function helloAndSubscribe(conn: Conn, clientId: string, sessionId: string): Promise<void> {
  await receiveType(conn, 'server_hello', 1000);
  conn.ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: `cli_${clientId}`,
      payload: { client_id: clientId, subscriptions: [sessionId] },
    }),
  );
  await receiveType(conn, 'ack', 1000);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const WATCH_SETTLE_MS = 150;

async function connectUnsubscribed(r: RunningServer, clientId: string): Promise<Conn> {
  const conn = await openConn(wsUrl(r));
  await receiveType(conn, 'server_hello', 1000);
  conn.ws.send(JSON.stringify({ type: 'client_hello', id: clientId, payload: { client_id: clientId, subscriptions: [] } }));
  expect((await receiveType(conn, 'ack', 1000)).code).toBe(0);
  return conn;
}

async function controlledWatch(r: RunningServer, runtimeId: string) {
  const pending: Array<{ ready: Promise<void>; release(): void; disposed: number; fire(change: HostFsChange): void }> = [];
  let workspaceId = '';
  let registered: RuntimeProviderRuntimeHandle | undefined;
  const watch = {
    watch: () => {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const listeners = new Set<(change: HostFsChange) => void>();
      const item = {
        ready,
        release,
        disposed: 0,
        fire: (change: HostFsChange) => { for (const listener of listeners) listener(change); },
      };
      pending.push(item);
      return {
        ready,
        onDidChange: (listener: (change: HostFsChange) => void) => {
          listeners.add(listener);
          return { dispose: () => { listeners.delete(listener); } };
        },
        dispose: () => { item.disposed++; },
      };
    },
  } as unknown as IHostFsWatchService;
  const makeRuntime = (generation: string) => Object.assign(new FakeRuntime(
    { workspaceId, runtimeId, generation },
    { capabilities: ['watch'], pathClass: process.platform === 'win32' ? 'win32' : 'posix' },
  ), { watch });
  const provider = await r.core.accessor.get(IWorkspaceInstanceManager).addProvider({
    id: `${runtimeId}-provider`,
    imports: { root: [], imports: [], local: [] },
    attach: async (context, host) => {
      workspaceId = context.id;
      registered = host.registerRuntime(makeRuntime(`${runtimeId}-generation`));
      return { dispose: () => registered?.remove() };
    },
  });
  return {
    pending,
    provider,
    replace: () => registered!.update(() => makeRuntime(`${runtimeId}-replacement`)),
  };
}

function pauseNextResolvedWatch(bridge: FsWatchBridge) {
  const original = Reflect.get(bridge, 'resolveSession') as (
    conn: FsWatchConnection, sessionId: string, runtimeId: string,
  ) => Promise<unknown>;
  let entered!: () => void;
  let release!: () => void;
  let armed = false;
  let captured: unknown;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(bridge as unknown as { resolveSession: typeof original }, 'resolveSession')
    .mockImplementation(async (...args) => {
      const sw = await original.apply(bridge, args);
      if (armed) {
        armed = false;
        captured = sw;
        entered();
        await gate;
      }
      return sw;
    });
  return {
    arm: () => { armed = true; },
    reached,
    captured: () => captured,
    release,
    dispose: () => spy.mockRestore(),
  };
}

describe('WS fs watch (kap-server)', () => {
  it('pins an unsubscribed watch through ready and lifetime, cancelling an unready watch on disconnect', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION', 'true');
    writeFileSync(join(bridgeHome, 'config.toml'), '[session_residency]\nidle_ttl_ms = 0\nmin_idle_ms = 0\nsweep_interval_ms = 300000\n');
    const r = await boot();
    const sid = await createSession(r);
    const manager = r.core.accessor.get(ISessionManager);
    const { pending, provider } = await controlledWatch(r, 'watch-pin');
    let conn: Conn | undefined;
    try {
      conn = await connectUnsubscribed(r, 'unsubscribed-one');
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'pending-one', payload: { session_id: sid, runtime_id: 'watch-pin', paths: ['src'] } }));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(await manager.evictIfIdle!(sid)).toBe(false);
      pending[0]!.release();
      expect((await receiveType(conn, 'ack', 1500)).code).toBe(0);
      expect(await manager.evictIfIdle!(sid)).toBe(false);
      const closedOne = new Promise<void>((resolve) => conn!.ws.once('close', () => resolve()));
      conn.ws.close();
      await closedOne;
      await vi.waitFor(() => expect(pending[0]?.disposed).toBe(1));
      expect(await manager.evictIfIdle!(sid)).toBe(true);
      const warm = await manager.acquire!(sid, 'test-setup');
      expect(warm).toBeDefined();
      await warm!.dispose();

      conn = await connectUnsubscribed(r, 'unsubscribed-two');
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'pending-two', payload: { session_id: sid, runtime_id: 'watch-pin', paths: ['src'] } }));
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(await manager.evictIfIdle!(sid)).toBe(false);
      const closedTwo = new Promise<void>((resolve) => conn!.ws.once('close', () => resolve()));
      conn.ws.close();
      await closedTwo;
      await vi.waitFor(() => expect(pending[1]?.disposed).toBe(1));
      expect(await manager.evictIfIdle!(sid)).toBe(true);
    } finally {
      for (const watch of pending) watch.release();
      conn?.ws.close();
      await provider.dispose();
    }
  });

  it.each([
    ['pending', 'archive'],
    ['active', 'archive'],
    ['active', 'close'],
  ] as const)('releases a %s unsubscribed watch on explicit %s without reviving its old handle', async (phase, lifecycle) => {
    vi.stubEnv('KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION', 'true');
    writeFileSync(join(bridgeHome, 'config.toml'), '[session_residency]\nidle_ttl_ms = 0\nmin_idle_ms = 0\nsweep_interval_ms = 300000\n');
    const r = await boot();
    const sid = await createSession(r);
    const manager = r.core.accessor.get(ISessionManager);
    const { pending, provider } = await controlledWatch(r, 'archive-watch');
    const resolver = r.core.accessor.get(IRuntimeResolver);
    const runtimeAcquire = resolver.acquire.bind(resolver);
    let runtimeDisposals = 0;
    const runtimeSpy = vi.spyOn(resolver, 'acquire').mockImplementation((...args) => {
      const lease = runtimeAcquire(...args);
      if (args[0].runtimeId !== 'archive-watch') return lease;
      return {
        runtime: lease.runtime,
        track: lease.track.bind(lease),
        dispose: () => { runtimeDisposals++; lease.dispose(); },
      };
    });
    const acquire = manager.acquire!.bind(manager);
    let pins = 0;
    let releases = 0;
    const leaseSpy = vi.spyOn(manager, 'acquire').mockImplementation(async (...args) => {
      const lease = await acquire(...args);
      if (lease === undefined || args[1] !== 'fs-watch') return lease;
      pins++;
      return {
        handle: lease.handle,
        dispose: async () => { releases++; pins--; await lease.dispose(); },
      };
    });
    const conn = await connectUnsubscribed(r, `${lifecycle}-${phase}`);
    let reconnected: Conn | undefined;
    try {
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'before-archive', payload: { session_id: sid, runtime_id: 'archive-watch', paths: ['src'] } }));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(pins).toBe(1);
      if (phase === 'active') {
        pending[0]!.release();
        expect((await receiveType(conn, 'ack', 1500)).code).toBe(0);
      }
      if (lifecycle === 'archive') await manager.archive(sid);
      else await manager.close(sid);
      if (phase === 'pending') expect((await receiveType(conn, 'ack', 1500)).code).toBe(40409);
      await vi.waitFor(() => expect(pending[0]?.disposed).toBe(1));
      expect(pins).toBe(0);
      expect(releases).toBe(1);
      expect(runtimeDisposals).toBe(1);
      expect(manager.get(sid)).toBeUndefined();
      pending[0]!.release();
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'after-lifecycle', payload: { session_id: sid, runtime_id: 'archive-watch', paths: ['src'] } }));
      expect((await receiveType(conn, 'ack', 1500)).code).toBe(40409);
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'empty-after-lifecycle', payload: { session_id: sid, runtime_id: 'archive-watch', paths: [] } }));
      expect((await receiveType(conn, 'ack', 1500)).code).toBe(40409);
      expect(pending).toHaveLength(1);
      expect(manager.get(sid)).toBeUndefined();
      if (lifecycle === 'archive') {
        reconnected = await connectUnsubscribed(r, `reconnected-${phase}`);
        reconnected.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'reconnected', payload: { session_id: sid, runtime_id: 'archive-watch', paths: ['src'] } }));
        expect((await receiveType(reconnected, 'ack', 1500)).code).toBe(40409);
        expect(pending).toHaveLength(1);
      }
    } finally {
      for (const watch of pending) watch.release();
      conn.ws.close();
      reconnected?.ws.close();
      leaseSpy.mockRestore();
      runtimeSpy.mockRestore();
      await provider.dispose();
    }
  });

  it('treats empty watch additions as no-op or clearing updates without acquiring a lease', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION', 'true');
    writeFileSync(join(bridgeHome, 'config.toml'), '[session_residency]\nidle_ttl_ms = 0\nmin_idle_ms = 0\nsweep_interval_ms = 300000\n');
    const r = await boot();
    const sid = await createSession(r);
    const manager = r.core.accessor.get(ISessionManager);
    const { pending, provider } = await controlledWatch(r, 'empty-watch');
    const acquire = vi.spyOn(manager, 'acquire');
    const conn = await connectUnsubscribed(r, 'empty-watch');
    try {
      for (const [id, payload] of [
        ['empty-one', { session_id: sid, runtime_id: 'empty-watch', paths: [] }],
        ['empty-two', { session_id: sid, runtime_id: 'empty-watch' }],
      ] as const) {
        conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id, payload }));
        const ack = await receiveType(conn, 'ack', 1500);
        expect(ack.code).toBe(0);
        expect(ack.payload).toMatchObject({ watched_paths: [], current_count: 0 });
      }
      expect(acquire).not.toHaveBeenCalled();
      expect(pending).toHaveLength(0);
      expect(await manager.evictIfIdle!(sid)).toBe(true);
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'empty-cold', payload: { session_id: sid, runtime_id: 'empty-watch', paths: [] } }));
      expect((await receiveType(conn, 'ack', 1500)).code).toBe(40409);
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'empty-unknown', payload: { session_id: 'unknown', runtime_id: 'empty-watch', paths: [] } }));
      expect((await receiveType(conn, 'ack', 1500)).code).toBe(40409);
      expect(acquire).not.toHaveBeenCalled();
      expect(manager.get(sid)).toBeUndefined();
      const warm = await manager.acquire!(sid, 'test-setup');
      expect(warm).toBeDefined();
      await warm!.dispose();
      acquire.mockClear();

      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'nonempty', payload: { session_id: sid, runtime_id: 'empty-watch', paths: ['src'] } }));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending[0]!.release();
      expect((await receiveType(conn, 'ack', 1500)).payload).toMatchObject({ watched_paths: ['src'], current_count: 1 });
      expect(await manager.evictIfIdle!(sid)).toBe(false);
      acquire.mockClear();
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'clear', payload: { session_id: sid, runtime_id: 'empty-watch', paths: [] } }));
      const cleared = await receiveType(conn, 'ack', 1500);
      expect(cleared.code).toBe(0);
      expect(cleared.payload).toMatchObject({ watched_paths: [], current_count: 0 });
      expect(acquire).not.toHaveBeenCalled();
      expect(pending[0]?.disposed).toBe(1);
      expect(await manager.evictIfIdle!(sid)).toBe(true);
      conn.ws.send(JSON.stringify({ type: 'watch_fs_add', id: 'repeat-clear', payload: { session_id: sid, runtime_id: 'empty-watch', paths: [] } }));
      expect((await receiveType(conn, 'ack', 1500)).payload).toMatchObject({ watched_paths: [], current_count: 0 });
      expect(pending[0]?.disposed).toBe(1);
      expect(pending).toHaveLength(1);
    } finally {
      for (const watch of pending) watch.release();
      conn.ws.close();
      acquire.mockRestore();
      await provider.dispose();
    }
  });

  it('rejects an add resolved against a watch archived before its continuation', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION', 'true');
    writeFileSync(join(bridgeHome, 'config.toml'), '[session_residency]\nidle_ttl_ms = 0\nmin_idle_ms = 0\nsweep_interval_ms = 300000\n');
    const r = await boot();
    const sid = await createSession(r);
    const manager = r.core.accessor.get(ISessionManager);
    const { pending, provider } = await controlledWatch(r, 'raced-archive');
    const bridge = new FsWatchBridge({ core: r.core });
    const conn: FsWatchConnection = { id: 'raced-archive-conn', send: vi.fn() };
    let paused: ReturnType<typeof pauseNextResolvedWatch> | undefined;
    try {
      const first = bridge.addWatch(conn, sid, ['src'], 'raced-archive');
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending[0]!.release();
      expect(await first).toMatchObject({ code: 0, watched_paths: ['src'], current_count: 1 });
      paused = pauseNextResolvedWatch(bridge);
      paused.arm();
      const second = bridge.addWatch(conn, sid, ['docs'], 'raced-archive');
      await paused.reached;
      const watches = Reflect.get(bridge, 'bySession') as Map<string, unknown>;
      expect(paused.captured()).toBe(watches.get(`${sid}\0raced-archive`));
      await manager.archive(sid);
      expect(pending[0]?.disposed).toBe(1);
      expect(watches.has(`${sid}\0raced-archive`)).toBe(false);
      paused.release();
      expect(await second).toMatchObject({ code: 40409 });
      expect((Reflect.get(bridge, 'connPathCount') as Map<string, number>).get(conn.id) ?? 0).toBe(0);
      expect(manager.residencyReport?.().pinnedSessions).toBe(0);
      expect(await bridge.addWatch(conn, sid, ['docs'], 'raced-archive')).toMatchObject({ code: 40409 });
      expect(pending).toHaveLength(1);
    } finally {
      paused?.release();
      paused?.dispose();
      bridge.dispose();
      await provider.dispose();
    }
  });

  it('rejects a stale-generation add and delivers through the replacement watch', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION', 'true');
    writeFileSync(join(bridgeHome, 'config.toml'), '[session_residency]\nidle_ttl_ms = 0\nmin_idle_ms = 0\nsweep_interval_ms = 300000\n');
    const r = await boot();
    const sid = await createSession(r);
    const manager = r.core.accessor.get(ISessionManager);
    const { pending, provider, replace } = await controlledWatch(r, 'raced-replace');
    const bridge = new FsWatchBridge({ core: r.core });
    const sent = vi.fn<FsWatchConnection['send']>();
    const conn: FsWatchConnection = { id: 'raced-replace-conn', send: sent };
    let paused: ReturnType<typeof pauseNextResolvedWatch> | undefined;
    try {
      const first = bridge.addWatch(conn, sid, ['src'], 'raced-replace');
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending[0]!.release();
      expect(await first).toMatchObject({ code: 0, watched_paths: ['src'], current_count: 1 });
      paused = pauseNextResolvedWatch(bridge);
      paused.arm();
      const stale = bridge.addWatch(conn, sid, ['docs'], 'raced-replace');
      await paused.reached;
      const watches = Reflect.get(bridge, 'bySession') as Map<string, unknown>;
      expect(paused.captured()).toBe(watches.get(`${sid}\0raced-replace`));
      await replace();
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      pending[1]!.release();
      await vi.waitFor(() => expect(watches.get(`${sid}\0raced-replace`)).not.toBe(paused!.captured()));
      expect(pending[0]?.disposed).toBe(1);
      paused.release();
      expect(await stale).toMatchObject({ code: 40409 });
      expect((Reflect.get(bridge, 'connPathCount') as Map<string, number>).get(conn.id)).toBe(1);
      const retry = await bridge.addWatch(conn, sid, ['docs'], 'raced-replace');
      expect(retry).toMatchObject({ code: 0, watched_paths: ['docs', 'src'], current_count: 2 });
      pending[1]!.fire({ path: join(workspace, 'docs', 'fresh.txt'), action: 'created', kind: 'file' });
      await vi.waitFor(() => expect(sent.mock.calls.some(([frame]) => {
        const event = frame as FsChangedFrame;
        return event.type === 'event.fs.changed' && event.payload.changes.some((change) => change.path === 'docs/fresh.txt');
      })).toBe(true));
      expect(manager.residencyReport?.().pinnedSessions).toBe(1);
      bridge.detachConnection(conn);
      expect(manager.residencyReport?.().pinnedSessions).toBe(0);
      expect(pending[1]?.disposed).toBe(1);
    } finally {
      paused?.release();
      paused?.dispose();
      bridge.dispose();
      await provider.dispose();
    }
  });

  it('subscribe src → create file → receive event.fs.changed', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w1',
        payload: { session_id: sid, runtime_id: 'local', paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(0);
    expect(ack.payload).toMatchObject({ watched_paths: ['src'] });

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'new.ts'), 'export const x = 1;\n');

    const ev = await receiveType(conn, 'event.fs.changed', 2000);
    expect(ev.session_id).toBe(sid);
    const payload = ev.payload as {
      changes: Array<{ path: string; change: string; kind: string }>;
      coalesced_window_ms: number;
      truncated?: boolean;
    };
    expect(payload.coalesced_window_ms).toBe(200);
    expect(payload.truncated).toBeUndefined();
    expect(payload.changes.length).toBeGreaterThanOrEqual(1);
    const paths = payload.changes.map((c) => c.path);
    expect(paths.some((p) => p === 'src/new.ts' || p === 'src')).toBe(true);

    conn.ws.close();
  });

  it('watch_fs_add without runtime_id defaults to the local runtime', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w1',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(0);
    expect(ack.payload).toMatchObject({ watched_paths: ['src'] });

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'compat.ts'), 'export const y = 2;\n');

    const ev = await receiveType(conn, 'event.fs.changed', 2000);
    expect(ev.session_id).toBe(sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_remove',
        id: 'w2',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    const removeAck = await receiveType(conn, 'ack', 1000);
    expect(removeAck.code).toBe(0);

    conn.ws.close();
  });

  it.skipIf(process.platform === 'win32')(
    'burst > 500 changes inside 200ms window → truncated:true',
    { timeout: 15000 },
    async () => {
      vi.stubEnv('KIKI_FS_WATCH_DEBOUNCE_MS', '500');
      vi.stubEnv('KIKI_FS_WATCH_MAX_CHANGES_PER_WINDOW', '100');
      const r = await boot();
      const sid = await createSession(r);
      const conn = await openConn(wsUrl(r));
      await helloAndSubscribe(conn, 'A', sid);

      conn.ws.send(
        JSON.stringify({
          type: 'watch_fs_add',
          id: 'w2',
          payload: { session_id: sid, runtime_id: 'local', paths: ['.'] },
        }),
      );
      await receiveType(conn, 'ack', 1000);
      await sleep(WATCH_SETTLE_MS);

      const burstDir = join(workspace, 'burst');
      mkdirSync(burstDir, { recursive: true });
      for (let i = 0; i < 600; i++) writeFileSync(join(burstDir, `f${i}.txt`), `x${i}`);

      const deadline = Date.now() + 12000;
      let sawTruncated = false;
      while (Date.now() < deadline) {
        let frame: WsFrame;
        try {
          frame = await receive(conn, deadline - Date.now());
        } catch {
          break;
        }
        if (frame.type !== 'event.fs.changed') continue;
        const payload = frame.payload as { truncated?: boolean; count?: number };
        if (payload.truncated === true) {
          expect(payload.count).toBeGreaterThan(100);
          sawTruncated = true;
          break;
        }
      }
      expect(sawTruncated).toBe(true);
      conn.ws.close();
    },
  );

  it('two clients on disjoint paths receive only their own changes', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const a = await openConn(wsUrl(r));
    const b = await openConn(wsUrl(r));
    await helloAndSubscribe(a, 'A', sid);
    await helloAndSubscribe(b, 'B', sid);

    a.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'wA', payload: { session_id: sid, runtime_id: 'local', paths: ['src'] } }),
    );
    await receiveType(a, 'ack', 1000);
    b.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'wB', payload: { session_id: sid, runtime_id: 'local', paths: ['docs'] } }),
    );
    await receiveType(b, 'ack', 1000);

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'a.ts'), 'a');
    writeFileSync(join(workspace, 'docs', 'b.md'), 'b');

    const evA = await receiveType(a, 'event.fs.changed', 2000);
    const pathsA = (evA.payload as { changes: Array<{ path: string }> }).changes.map((c) => c.path);
    expect(pathsA.some((p) => p.startsWith('src/'))).toBe(true);
    expect(pathsA.some((p) => p.startsWith('docs/'))).toBe(false);

    const evB = await receiveType(b, 'event.fs.changed', 2000);
    const pathsB = (evB.payload as { changes: Array<{ path: string }> }).changes.map((c) => c.path);
    expect(pathsB.some((p) => p.startsWith('docs/'))).toBe(true);
    expect(pathsB.some((p) => p.startsWith('src/'))).toBe(false);

    a.ws.close();
    b.ws.close();
  });

  it('> 100 paths on one connection → 42902 fs.watch_limit_exceeded', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    const paths: string[] = [];
    for (let i = 0; i < 101; i++) {
      const p = `dir${i}`;
      mkdirSync(join(workspace, p), { recursive: true });
      paths.push(p);
    }

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w100',
        payload: { session_id: sid, runtime_id: 'local', paths: paths.slice(0, 100) },
      }),
    );
    const ack100 = await receiveType(conn, 'ack', 2000);
    expect(ack100.code).toBe(0);
    expect((ack100.payload as { current_count: number }).current_count).toBe(100);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w101',
        payload: { session_id: sid, runtime_id: 'local', paths: [paths[100]!] },
      }),
    );
    const ack101 = await receiveType(conn, 'ack', 2000);
    expect(ack101.code).toBe(42902);

    conn.ws.close();
  });

  it('idempotent: adding the same path twice keeps current_count singular', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'w1', payload: { session_id: sid, runtime_id: 'local', paths: ['src'] } }),
    );
    await receiveType(conn, 'ack', 1000);
    conn.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'w2', payload: { session_id: sid, runtime_id: 'local', paths: ['src'] } }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect((ack.payload as { current_count: number }).current_count).toBe(1);

    conn.ws.close();
  });

  it('watch_fs_remove drops the subscription and acks updated watched_paths', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'wadd',
        payload: { session_id: sid, runtime_id: 'local', paths: ['src', 'docs'] },
      }),
    );
    await receiveType(conn, 'ack', 1000);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_remove',
        id: 'wrm',
        payload: { session_id: sid, runtime_id: 'local', paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    const payload = ack.payload as { watched_paths: string[]; current_count: number };
    expect(payload.watched_paths).toEqual(['docs']);
    expect(payload.current_count).toBe(1);

    conn.ws.close();
  });

  it('watch_fs_add for `..` path → 41304 fs.path_escapes_session', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'wbad',
        payload: { session_id: sid, runtime_id: 'local', paths: ['../escape'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(41304);

    conn.ws.close();
  });

  it('keeps delivering events after the runtime generation is replaced, without a client re-add', async () => {
    const r = await boot();
    const sid = await createSession(r);

    interface FakeHandle {
      disposed: number;
      fire(change: HostFsChange): void;
    }
    const fakeWatch = (): { readonly service: IHostFsWatchService; readonly handles: FakeHandle[] } => {
      const handles: FakeHandle[] = [];
      const service = {
        watch: () => {
          const listeners = new Set<(change: HostFsChange) => void>();
          const handle: FakeHandle & {
            readonly ready: Promise<void>;
            onDidChange(listener: (change: HostFsChange) => void): { dispose(): void };
            dispose(): void;
          } = {
            ready: Promise.resolve(),
            disposed: 0,
            onDidChange: (listener) => {
              listeners.add(listener);
              return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: () => { handle.disposed += 1; },
            fire: (change) => { for (const listener of [...listeners]) listener(change); },
          };
          handles.push(handle);
          return handle;
        },
      } as unknown as IHostFsWatchService;
      return { service, handles };
    };
    const watchOne = fakeWatch();
    const watchTwo = fakeWatch();
    let workspaceId = '';
    let handle: RuntimeProviderRuntimeHandle | undefined;
    const makeRuntime = (generation: string, service: IHostFsWatchService): FakeRuntime =>
      Object.assign(
        new FakeRuntime(
          { workspaceId, runtimeId: 'watch-test', generation },
          {
            capabilities: ['watch'],
            pathClass: process.platform === 'win32' ? 'win32' : 'posix',
          },
        ),
        { watch: service },
      );
    const provider = await r.core.accessor.get(IWorkspaceInstanceManager).addProvider({
      id: 'watch-test-provider',
      imports: { root: [], imports: [], local: [] },
      attach: async (context, host) => {
        workspaceId = context.id;
        handle = host.registerRuntime(makeRuntime('watch-generation-1', watchOne.service));
        return { dispose: () => handle!.remove() };
      },
    });

    const conn = await openConn(wsUrl(r));
    try {
      await helloAndSubscribe(conn, 'A', sid);
      conn.ws.send(
        JSON.stringify({
          type: 'watch_fs_add',
          id: 'w1',
          payload: { session_id: sid, runtime_id: 'watch-test', paths: ['src'] },
        }),
      );
      const ack = await receiveType(conn, 'ack', 1000);
      expect(ack.code).toBe(0);
      expect(ack.payload).toMatchObject({ watched_paths: ['src'] });
      expect(watchOne.handles).toHaveLength(1);

      watchOne.handles[0]!.fire({ path: join(workspace, 'src', 'one.ts'), action: 'created', kind: 'file' });
      const evOne = await receiveType(conn, 'event.fs.changed', 2000);
      expect((evOne.payload as { changes: Array<{ path: string }> }).changes.some((c) => c.path === 'src/one.ts')).toBe(true);

      await handle!.update(() => makeRuntime('watch-generation-2', watchTwo.service));

      const deadline = Date.now() + 2000;
      while (watchTwo.handles.length === 0 && Date.now() < deadline) await sleep(25);
      expect(watchTwo.handles).toHaveLength(1);
      expect(watchOne.handles[0]!.disposed).toBe(1);
      await sleep(WATCH_SETTLE_MS);

      watchTwo.handles[0]!.fire({ path: join(workspace, 'src', 'two.ts'), action: 'created', kind: 'file' });
      const evTwo = await receiveType(conn, 'event.fs.changed', 2000);
      expect(evTwo.session_id).toBe(sid);
      expect((evTwo.payload as { changes: Array<{ path: string }> }).changes.some((c) => c.path === 'src/two.ts')).toBe(true);
      expect(evTwo.seq).toBe((evOne.seq ?? 0) + 1);

      conn.ws.send(
        JSON.stringify({
          type: 'watch_fs_add',
          id: 'w2',
          payload: { session_id: sid, runtime_id: 'watch-test', paths: ['docs'] },
        }),
      );
      const ackTwo = await receiveType(conn, 'ack', 1000);
      expect(ackTwo.code).toBe(0);
      expect(ackTwo.payload).toMatchObject({ watched_paths: ['docs', 'src'] });
    } finally {
      conn.ws.close();
      await provider.dispose();
    }
  });
});
