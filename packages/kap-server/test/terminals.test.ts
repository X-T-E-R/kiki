import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  getLiveSessionById,
  IHostTerminalService,
  ISessionTerminalService,
  ScopeActivation,
  LifecycleScope,
  registerScopedService,
  type TerminalProcess,
  type TerminalSpawnOptions,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../src/protocol/error-codes';
import type { Terminal } from '@moonshot-ai/agent-core-v2/os/interface/terminal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';
import {
  terminalAttachAckMessageSchema,
  terminalCloseAckMessageSchema,
  terminalDetachAckMessageSchema,
  terminalExitMessageSchema,
  terminalInputAckMessageSchema,
  terminalOutputMessageSchema,
  terminalResizeAckMessageSchema,
} from '../src/protocol/ws-control';

// --- Fake PTY service -------------------------------------------------------
//
// `startServer` bootstraps the real `HostTerminalService` (backed by node-pty).
// Registering this fake at App scope AFTER those imports overrides it —
// `buildCollection` applies scoped registrations in import order and the last
// `set` for a given (scope, id) wins. Every spawned process is pushed into the
// module-level collectors below so tests can inspect cwd / kill state.

class FakeTerminalProcess implements TerminalProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number | null }) => void>();
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;

  readonly onProcessData = (listener: (data: string) => void): { dispose(): void } => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  readonly onProcessExit = (
    listener: (event: { exitCode: number | null }) => void,
  ): { dispose(): void } => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  emitExit(exitCode: number | null): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

class FakeHostTerminalService implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    spawnOptions.push(options);
    const proc = new FakeTerminalProcess();
    processes.push(proc);
    return Promise.resolve(proc);
  }
}

const spawnOptions: TerminalSpawnOptions[] = [];
const processes: FakeTerminalProcess[] = [];

registerScopedService(
  LifecycleScope.App,
  IHostTerminalService,
  FakeHostTerminalService,
  ScopeActivation.OnDemand,
  'terminal-test',
);

// --- Test harness -----------------------------------------------------------

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface WsFrame {
  type: string;
  id?: string;
  code?: number;
  msg?: string;
  seq?: number;
  session_id?: string;
  terminal_id?: string;
  payload?: Record<string, unknown>;
}

interface TerminalConn {
  ws: WebSocket;
  closed: Promise<void>;
  send(frame: unknown): void;
  next(predicate: (frame: WsFrame) => boolean, timeoutMs?: number): Promise<WsFrame>;
}

function openTerminalConn(url: string, token: string): Promise<TerminalConn> {
  return new Promise((resolveConn, reject) => {
    const ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    const frames: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    const closed = new Promise<void>((resolveClosed) => ws.on('close', resolveClosed));
    ws.on('message', (data) => {
      let frame: WsFrame;
      try {
        frame = JSON.parse((data as Buffer).toString()) as WsFrame;
      } catch {
        return;
      }
      const waiter = waiters.shift();
      if (waiter === undefined) frames.push(frame);
      else waiter(frame);
    });
    ws.once('open', () => {
      resolveConn({
        ws,
        closed,
        send: (frame) => {
          ws.send(JSON.stringify(frame));
        },
        next: (predicate, timeoutMs = 2000) =>
          new Promise((resolveFrame, rejectFrame) => {
            const existing = frames.findIndex(predicate);
            if (existing >= 0) {
              resolveFrame(frames.splice(existing, 1)[0]!);
              return;
            }
            const deadline = Date.now() + timeoutMs;
            let timer: ReturnType<typeof setTimeout>;
            const waiter = (frame: WsFrame): void => {
              clearTimeout(timer);
              if (predicate(frame)) resolveFrame(frame);
              else {
                frames.push(frame);
                waiters.push(waiter);
                arm();
              }
            };
            const arm = (): void => {
              const remaining = deadline - Date.now();
              if (remaining <= 0) {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                rejectFrame(new Error('timeout waiting for WebSocket frame'));
                return;
              }
              timer = setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                rejectFrame(new Error('timeout waiting for WebSocket frame'));
              }, remaining);
            };
            arm();
            waiters.push(waiter);
          }),
      });
    });
    ws.once('error', reject);
  });
}

describe('server-v2 /api/v1/sessions/{sid}/terminals', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let work: string | undefined;
  let base: string;

  beforeEach(async () => {
    spawnOptions.length = 0;
    processes.length = 0;
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-term-home-'));
    work = await mkdtemp(join(tmpdir(), 'kimi-server-v2-term-work-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
    if (work !== undefined) {
      await rm(work, { recursive: true, force: true });
      work = undefined;
    }
  });

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function post<T>(path: string, body: unknown): Promise<Envelope<T>> {
    const requestBody = path.endsWith('/terminals') ? { runtime_id: 'local', ...(body as object) } : body;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(requestBody),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  async function get<T>(path: string): Promise<Envelope<T>> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  it('defaults terminal creation to the local runtime when runtime_id is omitted', async () => {
    const sid = await createSession(work as string);
    const res = await fetch(`${base}/api/v1/sessions/${sid}/terminals`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    } as never);
    const body = (await res.json()) as Envelope<Terminal>;
    expect(body.code).toBe(0);
    expect(body.data.session_id).toBe(sid);
  });

  it('creates terminals for multiple sessions using each session workspace cwd', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'kimi-server-v2-term-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'kimi-server-v2-term-b-'));
    try {
      const sidA = await createSession(rootA);
      const sidB = await createSession(rootB);

      const termA = (await post<Terminal>(`/api/v1/sessions/${sidA}/terminals`, { cols: 100, rows: 30 }))
        .data;
      const termB = (await post<Terminal>(`/api/v1/sessions/${sidB}/terminals`, {})).data;

      expect(termA.session_id).toBe(sidA);
      expect(termA.cols).toBe(100);
      expect(termA.rows).toBe(30);
      expect(termA.status).toBe('running');
      expect(termB.session_id).toBe(sidB);
      // Each session resolves cwd against its own workspace workDir.
      expect(spawnOptions.map((o) => o.cwd)).toEqual([resolve(rootA), resolve(rootB)]);

      const listA = (await get<{ items: Terminal[] }>(`/api/v1/sessions/${sidA}/terminals`)).data;
      const listB = (await get<{ items: Terminal[] }>(`/api/v1/sessions/${sidB}/terminals`)).data;
      expect(listA.items.map((t) => t.id)).toEqual([termA.id]);
      expect(listB.items.map((t) => t.id)).toEqual([termB.id]);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it('resolves an explicit relative cwd against the session workspace', async () => {
    const sid = await createSession(work as string);
    const term = (await post<Terminal>(`/api/v1/sessions/${sid}/terminals`, { cwd: 'sub' })).data;
    expect(term.cwd).toBe(resolve(work as string, 'sub'));
    expect(spawnOptions[0]?.cwd).toBe(resolve(work as string, 'sub'));
  });

  it('gets and closes a terminal by session id', async () => {
    const sid = await createSession(work as string);
    const terminal = (await post<Terminal>(`/api/v1/sessions/${sid}/terminals`, {})).data;

    const got = (await get<Terminal>(`/api/v1/sessions/${sid}/terminals/${terminal.id}`)).data;
    expect(got.id).toBe(terminal.id);

    const closed = await post<{ closed: true }>(
      `/api/v1/sessions/${sid}/terminals/${terminal.id}:close`,
      {},
    );
    expect(closed.code).toBe(0);
    expect(closed.data).toEqual({ closed: true });
    expect(processes[0]?.killed).toBe(true);

    const after = (await get<Terminal>(`/api/v1/sessions/${sid}/terminals/${terminal.id}`)).data;
    expect(after.status).toBe('exited');
  });

  it('maps terminal-not-found, cwd-escape and unknown-session to protocol codes', async () => {
    const sid = await createSession(work as string);

    const missing = await get<unknown>(`/api/v1/sessions/${sid}/terminals/term_missing`);
    expect(missing.code).toBe(ErrorCode.TERMINAL_NOT_FOUND);

    const escaping = await post<unknown>(`/api/v1/sessions/${sid}/terminals`, {
      cwd: '../outside',
    });
    expect(escaping.code).toBe(ErrorCode.FS_PATH_ESCAPES_SESSION);

    const noSession = await get<unknown>(`/api/v1/sessions/sess_missing/terminals`);
    expect(noSession.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it('bridges terminal attach, input, output, resize, reconnect replay, detach, close and exit', async () => {
    const sid = await createSession(work as string);
    const terminal = (await post<Terminal>(`/api/v1/sessions/${sid}/terminals`, {})).data;
    const token = (server as RunningServer).authTokenService.getToken();
    const url = `ws://127.0.0.1:${(server as RunningServer).port}/api/v1/ws`;
    const session = getLiveSessionById((server as RunningServer).core.accessor, sid);
    expect(session).toBeDefined();
    const terminalService = session!.accessor.get(ISessionTerminalService);
    const detachAll = vi.spyOn(terminalService, 'detachAllForSink');

    const first = await openTerminalConn(url, token);
    const firstHello = await first.next((frame) => frame.type === 'server_hello');
    const firstConnectionId = firstHello.payload?.['ws_connection_id'];
    expect(typeof firstConnectionId).toBe('string');

    first.send({
      type: 'terminal_attach',
      id: 'attach-1',
      payload: { session_id: sid, terminal_id: terminal.id, since_seq: 0 },
    });
    expect(
      terminalAttachAckMessageSchema.parse(
        await first.next((frame) => frame.type === 'ack' && frame.id === 'attach-1'),
      ).payload,
    ).toEqual({ attached: true, replayed: 0, earliest_seq: null, truncated: false });

    first.send({
      type: 'terminal_input',
      id: 'input-1',
      payload: { session_id: sid, terminal_id: terminal.id, data: 'echo hello\r' },
    });
    terminalInputAckMessageSchema.parse(
      await first.next((frame) => frame.type === 'ack' && frame.id === 'input-1'),
    );
    expect(processes[0]?.writes).toEqual(['echo hello\r']);

    processes[0]!.emitData('hello\r\n');
    const liveOutput = terminalOutputMessageSchema.parse(
      await first.next((frame) => frame.type === 'terminal_output'),
    );
    expect(liveOutput).toMatchObject({
      seq: 1,
      session_id: sid,
      terminal_id: terminal.id,
      payload: { data: 'hello\r\n' },
    });

    first.send({
      type: 'terminal_resize',
      id: 'resize-1',
      payload: { session_id: sid, terminal_id: terminal.id, cols: 100, rows: 31 },
    });
    terminalResizeAckMessageSchema.parse(
      await first.next((frame) => frame.type === 'ack' && frame.id === 'resize-1'),
    );
    expect(processes[0]?.resizes).toEqual([[100, 31]]);

    first.ws.close();
    await first.closed;
    await vi.waitFor(() => {
      expect(detachAll).toHaveBeenCalledWith(firstConnectionId);
    });

    processes[0]!.emitData('while disconnected\r\n');
    const second = await openTerminalConn(url, token);
    await second.next((frame) => frame.type === 'server_hello');
    second.send({
      type: 'terminal_attach',
      id: 'attach-2',
      payload: { session_id: sid, terminal_id: terminal.id, since_seq: 1 },
    });
    const replay = terminalOutputMessageSchema.parse(
      await second.next((frame) => frame.type === 'terminal_output'),
    );
    expect(replay).toMatchObject({ seq: 2, payload: { data: 'while disconnected\r\n' } });
    expect(
      terminalAttachAckMessageSchema.parse(
        await second.next((frame) => frame.type === 'ack' && frame.id === 'attach-2'),
      ).payload,
    ).toEqual({ attached: true, replayed: 1, earliest_seq: 1, truncated: false });

    second.send({
      type: 'terminal_detach',
      id: 'detach-1',
      payload: { session_id: sid, terminal_id: terminal.id },
    });
    terminalDetachAckMessageSchema.parse(
      await second.next((frame) => frame.type === 'ack' && frame.id === 'detach-1'),
    );
    processes[0]!.emitData('while detached\r\n');
    await expect(second.next((frame) => frame.type === 'terminal_output', 100)).rejects.toThrow(
      /timeout/,
    );

    second.send({
      type: 'terminal_attach',
      id: 'attach-3',
      payload: { session_id: sid, terminal_id: terminal.id, since_seq: 2 },
    });
    expect(
      terminalOutputMessageSchema.parse(
        await second.next((frame) => frame.type === 'terminal_output'),
      ),
    ).toMatchObject({ seq: 3, payload: { data: 'while detached\r\n' } });
    await second.next((frame) => frame.type === 'ack' && frame.id === 'attach-3');

    second.send({
      type: 'terminal_close',
      id: 'close-1',
      payload: { session_id: sid, terminal_id: terminal.id },
    });
    expect(
      terminalExitMessageSchema.parse(
        await second.next((frame) => frame.type === 'terminal_exit'),
      ),
    ).toMatchObject({ session_id: sid, terminal_id: terminal.id, payload: { exit_code: null } });
    terminalCloseAckMessageSchema.parse(
      await second.next((frame) => frame.type === 'ack' && frame.id === 'close-1'),
    );
    expect(processes[0]?.killed).toBe(true);

    second.ws.close();
    await second.closed;

    const third = await openTerminalConn(url, token);
    await third.next((frame) => frame.type === 'server_hello');
    third.send({
      type: 'terminal_attach',
      id: 'attach-exited',
      payload: { session_id: sid, terminal_id: terminal.id, since_seq: 3 },
    });
    terminalExitMessageSchema.parse(
      await third.next((frame) => frame.type === 'terminal_exit'),
    );
    expect(
      terminalAttachAckMessageSchema.parse(
        await third.next((frame) => frame.type === 'ack' && frame.id === 'attach-exited'),
      ).payload,
    ).toEqual({ attached: true, replayed: 1, earliest_seq: 1, truncated: false });
    third.ws.close();
    await third.closed;
  });

  it('reports a replay gap after more than 2,000 buffered output frames', async () => {
    const sid = await createSession(work as string);
    const terminal = (await post<Terminal>(`/api/v1/sessions/${sid}/terminals`, {})).data;
    for (let seq = 1; seq <= 2001; seq += 1) processes[0]!.emitData(`frame-${seq}`);

    const conn = await openTerminalConn(
      `ws://127.0.0.1:${(server as RunningServer).port}/api/v1/ws`,
      (server as RunningServer).authTokenService.getToken(),
    );
    await conn.next((frame) => frame.type === 'server_hello');
    conn.send({
      type: 'terminal_attach',
      id: 'attach-truncated',
      payload: { session_id: sid, terminal_id: terminal.id, since_seq: 0 },
    });

    expect(
      terminalAttachAckMessageSchema.parse(
        await conn.next((frame) => frame.type === 'ack' && frame.id === 'attach-truncated'),
      ).payload,
    ).toEqual({ attached: true, replayed: 2000, earliest_seq: 2, truncated: true });
    expect(
      terminalOutputMessageSchema.parse(
        await conn.next((frame) => frame.type === 'terminal_output'),
      ).seq,
    ).toBe(2);

    conn.ws.close();
    await conn.closed;
  });

  it('maps malformed, unknown-session and unknown-terminal WS controls to protocol codes', async () => {
    const sid = await createSession(work as string);
    const conn = await openTerminalConn(
      `ws://127.0.0.1:${(server as RunningServer).port}/api/v1/ws`,
      (server as RunningServer).authTokenService.getToken(),
    );
    await conn.next((frame) => frame.type === 'server_hello');

    conn.send({
      type: 'terminal_resize',
      id: 'bad-resize',
      payload: { session_id: sid, terminal_id: 'term_missing', cols: 0, rows: 24 },
    });
    expect(await conn.next((frame) => frame.id === 'bad-resize')).toMatchObject({
      type: 'ack',
      code: ErrorCode.VALIDATION_FAILED,
    });

    conn.send({
      type: 'terminal_input',
      id: 'missing-terminal',
      payload: { session_id: sid, terminal_id: 'term_missing', data: 'x' },
    });
    expect(await conn.next((frame) => frame.id === 'missing-terminal')).toMatchObject({
      type: 'ack',
      code: ErrorCode.TERMINAL_NOT_FOUND,
    });

    conn.send({
      type: 'terminal_attach',
      id: 'missing-session',
      payload: { session_id: 'sess_missing', terminal_id: 'term_missing' },
    });
    expect(await conn.next((frame) => frame.id === 'missing-session')).toMatchObject({
      type: 'ack',
      code: ErrorCode.SESSION_NOT_FOUND,
    });

    conn.ws.close();
    await conn.closed;
  });
});
