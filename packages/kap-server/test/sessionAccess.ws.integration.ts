import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IConfigService, ISessionManager, IAgentLifecycleService, IAgentLoopService, IEventBus, type Event2 } from '@kiki/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { isSessionAccessLoopback } from '../src/services/sessionAccess/access';
import type { IncomingMessage } from 'node:http';

interface Frame { type: string; id?: string; code?: number; session_id?: string; payload?: Record<string, unknown> }

function connect(port: number, token: string, path = '/api/ws', origin?: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, [`kimi-code.bearer.${token}`], { origin });
  const frames: Frame[] = [];
  socket.on('message', (data) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    frames.push(JSON.parse(bytes.toString('utf8')) as Frame);
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const opened = new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  const send = (type: string, payload: Record<string, unknown> = {}) => socket.send(JSON.stringify({ type, id: type, payload }));
  const ack = async (type: string) => vi.waitFor(() => { const frame = frames.find((frame) => frame.type === 'ack' && frame.id === type); expect(frame).toBeDefined(); return frame!; });
  return { socket, frames, closed, opened, send, ack };
}

describe('session access WebSocket and lifecycle boundary', () => {
  let server: RunningServer;
  let home: string;
  let now: number;
  const sockets: ReturnType<typeof connect>[] = [];
  const request = async (method: string, path: string, token = server.localOwnerToken, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { code: number; msg: string; data: any } };
  };
  const createSession = async () => (await request('POST', '/api/sessions', undefined, { metadata: { cwd: home } })).body.data.id as string;
  const issue = async (session_id: string, scopes = ['read', 'prompt', 'abort']) => {
    const result = await request('POST', '/api/session-access/tokens', undefined, { session_id, scopes, client: { name: 'example-client' }, ttl_seconds: 60 });
    expect(result.body.code, JSON.stringify(result.body)).toBe(0);
    return result.body.data.token as string;
  };
  const open = async (token: string) => { const conn = connect(server.port, token); sockets.push(conn); await conn.opened; return conn; };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'session-access-ws-'));
    await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
    now = Date.now();
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, host: '127.0.0.1', port: 0, logLevel: 'silent', sessionAccessClock: () => now });
  });
  afterEach(async () => {
    for (const conn of sockets.splice(0)) { conn.socket.close(); await conn.closed; }
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('keeps subscriptions and global delivery scoped and refuses privilege upgrades', async () => {
    const id = await createSession();
    const other = await createSession();
    await server.core.accessor.get(ISessionManager).get(id)!.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const token = await issue(id);
    const conn = await open(token);
    conn.send('client_hello', { subscriptions: [other] });
    expect((await conn.ack('client_hello')).code).not.toBe(0);
    conn.send('subscribe', { session_ids: [id, other] });
    expect((await conn.ack('subscribe')).code).not.toBe(0);
    conn.send('subscribe_v2', { session_id: other, transcript: { main: 'delta' }, transcript_coverage_version: 2 });
    expect((await conn.ack('subscribe_v2')).code).not.toBe(0);
    conn.send('watch_fs_add', { session_id: id, paths: ['.'] });
    expect((await conn.ack('watch_fs_add')).code).not.toBe(0);
    conn.send('terminal_attach', { session_id: id, terminal_id: 'example' });
    expect((await conn.ack('terminal_attach')).code).not.toBe(0);
    conn.frames.length = 0;
    conn.send('subscribe', { session_ids: [id] });
    expect((await conn.ack('subscribe')).code).toBe(0);
    const main = server.core.accessor.get(ISessionManager).get(id)!.accessor.get(IAgentLifecycleService).get('main')!;
    main.accessor.get(IEventBus).publish({ type: 'turn.started', turnId: 0, promptId: 'token-turn', origin: { kind: 'user' } } as unknown as Event2<any>);
    await request('PATCH', `/api/sessions/${other}`, undefined, { title: 'Other session title' });
    await request('POST', '/api/sessions', undefined, { metadata: { cwd: home } });
    await vi.waitFor(() => expect(conn.frames.some((frame) => frame.type === 'turn.started')).toBe(true));
    expect(conn.frames.filter((frame) => frame.session_id !== undefined).every((frame) => frame.session_id === id)).toBe(true);
    expect(conn.frames.some((frame) => frame.type === 'event.session.created' || frame.type === 'event.plugin.topic' || frame.type.startsWith('event.room.'))).toBe(false);
    conn.send('client_hello', { token: server.localOwnerToken, subscriptions: [id] });
    await conn.closed;
    expect(conn.frames.filter((frame) => frame.type === 'ack' && frame.id === 'client_hello').at(-1)?.code).not.toBe(0);
  });

  it('applies scoped event delivery to cursor replay without lowering the journal watermark', async () => {
    const id = await createSession();
    const main = await server.core.accessor.get(ISessionManager).get(id)!.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const before = (await request('GET', `/api/sessions/${id}/snapshot`)).body.data;
    const token = await issue(id);
    const owner = await open(server.localOwnerToken);
    owner.send('subscribe', { session_ids: [id] });
    await owner.ack('subscribe');
    const bus = main.accessor.get(IEventBus);
    for (const type of ['event.session.created', 'session.worktree.changed', 'event.plugin.topic', 'event.room.changed']) {
      bus.publish({ type, sessionId: id } as unknown as Event2<any>);
    }
    bus.publish({ type: 'turn.started', turnId: 0, promptId: 'replay-turn', origin: { kind: 'user' } } as unknown as Event2<any>);
    await vi.waitFor(() => expect(owner.frames.some((frame) => frame.type === 'turn.started')).toBe(true));
    expect(owner.frames.some((frame) => frame.type === 'session.worktree.changed')).toBe(true);
    const scoped = await open(token);
    scoped.send('subscribe', { session_ids: [id], cursors: { [id]: { seq: before.as_of_seq, epoch: before.epoch } } });
    const ack = await scoped.ack('subscribe');
    expect(scoped.frames.some((frame) => frame.type === 'turn.started')).toBe(true);
    expect(scoped.frames.some((frame) => ['event.session.created', 'session.worktree.changed', 'event.plugin.topic', 'event.room.changed'].includes(frame.type))).toBe(false);
    expect((ack.payload?.['cursors'] as Record<string, { seq: number }>)[id]!.seq).toBeGreaterThan(before.as_of_seq);
  });

  it('invalidates tokens on restart and keeps owner management protected when legacy auth is bypassed', async () => {
    const id = await createSession();
    const token = await issue(id);
    await server.close();
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, host: '127.0.0.1', port: 0, logLevel: 'silent', disableAuth: true });
    expect((await request('GET', `/api/sessions/${id}`, token)).status).toBe(401);
    for (const [method, path] of [['GET', '/api/session-access'], ['POST', '/api/session-access/tokens'], ['DELETE', '/api/session-access/tokens'], ['DELETE', '/api/session-access/tokens/sat_unknown']]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 40101 });
    }
    expect((await request('GET', '/api/session-access')).body).toMatchObject({ code: 0, data: { tokens: [] } });
  });

  it('refuses scoped credentials on klient sockets and all browser origins', async () => {
    const token = await issue(await createSession());
    for (const [path, origin] of [['/api/klient/events', undefined], ['/api/ws', 'http://127.0.0.1']] as const) {
      const conn = connect(server.port, token, path, origin); sockets.push(conn);
      await expect(conn.opened).rejects.toThrow(path === '/api/ws' ? '401' : '403');
    }
  });

  it.each(['one', 'all', 'delete', 'expiry', 'disabled'] as const)('revokes REST and sockets on %s', async (cause) => {
    const id = await createSession();
    const token = await issue(id);
    const conn = await open(token);
    const list = await request('GET', '/api/session-access');
    if (cause === 'one') await request('DELETE', `/api/session-access/tokens/${list.body.data.tokens[0].id}`);
    if (cause === 'all') await request('DELETE', '/api/session-access/tokens');
    if (cause === 'delete') await server.core.accessor.get(ISessionManager).delete(id);
    if (cause === 'expiry') now += 60_001;
    if (cause === 'disabled') await server.core.accessor.get(IConfigService).set('sessionAccess', { enabled: false });
    expect((await request('GET', `/api/sessions/${id}`, token)).status).toBe(401);
    await conn.closed;
    expect((await request('GET', '/api/session-access')).body.data.tokens).toEqual([]);
  });

  it('cancels an admitted abort before it acquires the session after revocation', async () => {
    const id = await createSession();
    const manager = server.core.accessor.get(ISessionManager);
    const main = await manager.get(id)!.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const token = await issue(id);
    const cancel = vi.spyOn(main.accessor.get(IAgentLoopService), 'cancelFromUser');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const acquire = manager.acquire!.bind(manager);
    const pending = vi.spyOn(manager, 'acquire').mockImplementationOnce(async (...args) => {
      entered(); await gate; return acquire(...args);
    });
    try {
      const abort = request('POST', `/api/sessions/${id}:abort`, token, {}).catch((error: unknown) => error);
      await started;
      await request('DELETE', '/api/session-access/tokens');
      expect(await abort).toBeInstanceOf(Error);
      expect(pending.mock.calls[0]![3]!.aborted).toBe(true);
      release();
      await Promise.allSettled([pending.mock.results[0]!.value]);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      release(); pending.mockRestore(); cancel.mockRestore();
    }
  });

  it('requires the exact loopback socket with no web or peer provenance', () => {
    const web = new WeakSet<IncomingMessage>();
    const peers = new WeakSet<IncomingMessage>();
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2', '192.0.2.1']) {
      const request = { socket: { remoteAddress: address }, headers: {} } as IncomingMessage;
      expect(isSessionAccessLoopback(request, web, peers)).toBe(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address));
      web.add(request); expect(isSessionAccessLoopback(request, web, peers)).toBe(false);
      web.delete(request); peers.add(request); expect(isSessionAccessLoopback(request, web, peers)).toBe(false);
    }
  });
});
