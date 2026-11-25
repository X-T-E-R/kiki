import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { PEER_BRIDGE_CAPABILITY_CHUNKED_V1, PEER_BRIDGE_CAPABILITY_GROUP_IDENTITY_V1, type RemoteConnection } from '@kiki/protocol';
import type { KlientFrame } from '@kiki/klient/host';
import type { RemoteConnectionManager } from '../src/services/connections/manager';
import { OutboundPeerBridgeClient } from '../src/services/threadBridge/outboundPeerBridgeClient';
import type { SpaceThreadBridge } from '../src/services/threadBridge/bridge';
import { PEER_BRIDGE_READ_MAX_RESPONSE_BYTES, PeerBridgeConnection, PeerBridgeRegistry } from '../src/transport/klient/peerBridgeSocket';

interface Frame {
  readonly type?: string;
  readonly id?: string;
  readonly data?: Record<string, unknown>;
}

interface Fixture {
  readonly client: OutboundPeerBridgeClient;
  readonly server: Server;
  readonly sockets: WebSocket[];
  readonly registrationCount: () => number;
  readonly attachedCount: () => number;
  readonly failed: ReturnType<typeof vi.fn>;
  readonly changed: () => void;
  setRegistration(status: number, message?: string): void;
  setCredential(ownerToken: string, grantId: string, revision: number): void;
  setListed(listed: boolean): void;
  closeSocket(index: number, code?: number): void;
}

const fixtures: Fixture[] = [];
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

async function waitUntil(predicate: () => boolean, timeout = 3000): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout, interval: 10 });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { nativeSetTimeout(resolve, ms); });
}

async function fixture(random: () => number = () => 0): Promise<Fixture> {
  let registrationStatus = 200;
  let registrationMessage = 'OK';
  let registrationCount = 0;
  let credential = {
    ownerToken: 'peer-token-one',
    grant: 'peer-token-one',
    grantId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
  };
  const sockets: WebSocket[] = [];
  const attachments: Array<{ socket: WebSocket; index: number }> = [];
  const connectionListeners = new Set<() => void>();
  const bridgeListeners = new Set<() => void>();
  let listed = true;
  const record = {
    id: '22222222-2222-4222-8222-222222222222',
    label: 'Peer fixture',
    endpoint: '',
    target: { hostId: 'peer-host' },
    credentialRef: '22222222-2222-4222-8222-222222222222',
    purposes: ['gui', 'bridge'],
    enabled: true,
    backgroundSummary: false,
    state: 'offline',
    activeLeases: 0,
    transport: undefined,
  } as unknown as RemoteConnection;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/thread-bridges/peer/outbound') {
      response.writeHead(404).end();
      return;
    }
    registrationCount += 1;
    request.resume();
    request.on('end', () => {
      response.writeHead(registrationStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: registrationStatus === 200 ? 0 : 40301, msg: registrationMessage }));
    });
  });
  const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit('connection', websocket, request));
  });
  websocketServer.on('connection', (socket) => {
    const index = sockets.push(socket) - 1;
    socket.on('message', (raw) => {
      let frame: Frame;
      try { frame = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as Frame; }
      catch { return; }
      if (frame.type === 'bridge_attach') {
        expect(frame.data).toEqual({ capabilities: [PEER_BRIDGE_CAPABILITY_CHUNKED_V1, PEER_BRIDGE_CAPABILITY_GROUP_IDENTITY_V1] });
        socket.send(JSON.stringify({ type: 'bridge_attached', id: frame.id, data: { operations: ['list', 'read', 'send', 'wait'] } }));
        attachments.push({ socket, index });
      } else if (frame.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', data: {} }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server did not listen');
  record.endpoint = `http://127.0.0.1:${address.port}`;
  const failed = vi.fn(() => { record.state = 'authentication_required'; });
  const connections = {
    list: () => listed ? [record] : [],
    get: () => record,
    secrets: { read: async () => ({ ...credential }) },
    credentialEpoch: () => 0,
    lease: (_id: string, signal: AbortSignal) => ({ signal, release: () => {} }),
    connect: async () => ({ record, credential: { ...credential }, transport: record }),
    onDidChange: (listener: () => void) => {
      connectionListeners.add(listener);
      return { dispose: () => { connectionListeners.delete(listener); } };
    },
    failed,
    pollSummaries: vi.fn(async () => {}),
  } as unknown as RemoteConnectionManager;
  const bridge = {
    onDidChange: (listener: () => void) => {
      bridgeListeners.add(listener);
      return { dispose: () => { bridgeListeners.delete(listener); } };
    },
    ensureReversePeerBridge: vi.fn(async () => ({
      grant: { id: '33333333-3333-4333-8333-333333333333', revision: 1 },
      credential: 'reverse-peer-credential',
    })),
    revokeReversePeerBridges: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
  } as unknown as SpaceThreadBridge;
  const client = new OutboundPeerBridgeClient(connections, bridge, new AbortController().signal, random);
  const entry: Fixture = {
    client,
    server,
    sockets,
    registrationCount: () => registrationCount,
    attachedCount: () => attachments.length,
    failed,
    changed: () => { for (const listener of connectionListeners) listener(); },
    setRegistration: (status, message = 'OK') => { registrationStatus = status; registrationMessage = message; },
    setCredential: (ownerToken, grantId, revision) => {
      credential = { ownerToken, grant: ownerToken, grantId, revision };
    },
    setListed: (value) => { listed = value; },
    closeSocket: (index, code) => {
      const socket = sockets[index];
      if (socket === undefined) throw new Error(`missing socket ${String(index)}`);
      if (code === undefined) socket.terminate();
      else socket.close(code, 'Service Restart');
    },
  };
  fixtures.push(entry);
  return entry;
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.client.close();
    for (const socket of item.sockets) socket.terminate();
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

describe('outbound peer bridge reconnect policy', () => {
  it('connects an eligible remote added after the client starts', async () => {
    const f = await fixture();
    f.setListed(false);
    f.client.start();
    await delay(20);
    expect(f.sockets).toHaveLength(0);
    f.setListed(true);
    f.changed();
    await waitUntil(() => f.sockets.length === 1 && f.attachedCount() === 1);
    expect(f.registrationCount()).toBe(1);
  });

  it('uses jittered backoff and resets attempts only after the attached-stability timer', async () => {
    const f = await fixture(() => 0);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    f.client.start();
    await waitUntil(() => f.sockets.length === 1 && f.registrationCount() === 1);
    await waitUntil(() => f.attachedCount() === 1);
    f.closeSocket(0);
    await waitUntil(() => timerSpy.mock.calls.some(([, delayMs]) => delayMs === 500));
    const firstRetryIndex = timerSpy.mock.calls.findIndex(([, delayMs]) => delayMs === 500);
    const firstRetryCallback = timerSpy.mock.calls[firstRetryIndex]?.[0];
    const firstRetryHandle = timerSpy.mock.results[firstRetryIndex]?.value as ReturnType<typeof setTimeout> | undefined;
    if (typeof firstRetryCallback !== 'function') throw new Error('backoff retry callback missing');
    firstRetryCallback();
    if (firstRetryHandle !== undefined) clearTimeout(firstRetryHandle);
    await waitUntil(() => f.sockets.length === 2 && f.attachedCount() === 2);
    timerSpy.mockClear();
    f.closeSocket(1);
    await waitUntil(() => timerSpy.mock.calls.some(([, delayMs]) => delayMs === 1_000));
    const secondRetryIndex = timerSpy.mock.calls.findIndex(([, delayMs]) => delayMs === 1_000);
    const secondRetryCallback = timerSpy.mock.calls[secondRetryIndex]?.[0];
    const secondRetryHandle = timerSpy.mock.results[secondRetryIndex]?.value as ReturnType<typeof setTimeout> | undefined;
    if (typeof secondRetryCallback !== 'function') throw new Error('progressive backoff callback missing');
    secondRetryCallback();
    if (secondRetryHandle !== undefined) clearTimeout(secondRetryHandle);
    timerSpy.mockClear();
    await waitUntil(() => f.sockets.length === 3 && f.attachedCount() === 3);
    const stableIndex = timerSpy.mock.calls.findIndex(([, delayMs]) => delayMs === 60_000);
    const stableCallback = timerSpy.mock.calls[stableIndex]?.[0];
    const stableHandle = timerSpy.mock.results[stableIndex]?.value as ReturnType<typeof setTimeout> | undefined;
    if (typeof stableCallback !== 'function') throw new Error('stable attachment timer missing');
    stableCallback();
    if (stableHandle !== undefined) clearTimeout(stableHandle);
    timerSpy.mockClear();
    f.closeSocket(2);
    await waitUntil(() => timerSpy.mock.calls.some(([, delayMs]) => delayMs === 500));
    expect(timerSpy.mock.calls.find(([, delayMs]) => delayMs === 500)).toBeDefined();
  });

  it('retries a planned restart close quickly without treating it as authentication failure', async () => {
    const f = await fixture(() => 0);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    f.client.start();
    await waitUntil(() => f.sockets.length === 1 && f.registrationCount() === 1);
    await waitUntil(() => f.attachedCount() === 1);
    f.closeSocket(0, 1012);
    await waitUntil(() => timerSpy.mock.calls.some(([, delayMs]) => delayMs === 250));
    expect(f.failed).not.toHaveBeenCalled();
    const restartIndex = timerSpy.mock.calls.findIndex(([, delayMs]) => delayMs === 250);
    const restartCallback = timerSpy.mock.calls[restartIndex]?.[0];
    const restartHandle = timerSpy.mock.results[restartIndex]?.value as ReturnType<typeof setTimeout> | undefined;
    if (typeof restartCallback !== 'function') throw new Error('planned restart callback missing');
    restartCallback();
    if (restartHandle !== undefined) clearTimeout(restartHandle);
    await waitUntil(() => f.sockets.length === 2 && f.attachedCount() === 2);
    expect(f.registrationCount()).toBe(2);
  });

  it('cooldowns credential refusals and wakes immediately when the stored credential changes', async () => {
    const f = await fixture(() => 0);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    f.setRegistration(401, 'connection_not_approved');
    f.client.start();
    await waitUntil(() => f.failed.mock.calls.length === 1);
    expect(timerSpy.mock.calls.some(([, delayMs]) => delayMs === 300_000)).toBe(true);
    await delay(100);
    expect(f.registrationCount()).toBe(1);
    f.setRegistration(200);
    f.setCredential('peer-token-two', '44444444-4444-4444-8444-444444444444', 2);
    f.changed();
    await waitUntil(() => f.sockets.length === 1 && f.attachedCount() === 1);
    expect(f.registrationCount()).toBe(2);
    expect(f.failed).toHaveBeenCalledOnce();
  });

  it('wakes immediately on network recovery during an authentication cooldown', async () => {
    const f = await fixture(() => 0);
    f.setRegistration(401, 'connection_not_approved');
    f.client.start();
    await waitUntil(() => f.failed.mock.calls.length === 1);
    expect(f.registrationCount()).toBe(1);
    f.setRegistration(200);
    f.client.notifyNetworkChange('lost');
    f.client.notifyNetworkChange('available');
    await waitUntil(() => f.sockets.length === 1 && f.attachedCount() === 1);
    expect(f.registrationCount()).toBe(2);
  });

  it('does not apply the auth cooldown to inbound_disabled', async () => {
    const f = await fixture(() => 0);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    f.setRegistration(403, 'inbound_disabled');
    f.client.start();
    await waitUntil(() => timerSpy.mock.calls.some(([, delayMs]) => delayMs === 500));
    expect(f.failed).not.toHaveBeenCalled();
    f.setRegistration(200);
    const retryIndex = timerSpy.mock.calls.findIndex(([, delayMs]) => delayMs === 500);
    const retryCallback = timerSpy.mock.calls[retryIndex]?.[0];
    const retryHandle = timerSpy.mock.results[retryIndex]?.value as ReturnType<typeof setTimeout> | undefined;
    if (typeof retryCallback !== 'function') throw new Error('normal retry callback missing');
    retryCallback();
    if (retryHandle !== undefined) clearTimeout(retryHandle);
    await waitUntil(() => f.sockets.length === 1 && f.attachedCount() === 1);
    expect(f.failed).not.toHaveBeenCalled();
  });
});

describe('PeerBridge chunked_v1 framing and two-lane anti-HOL scheduler', () => {
  const validBridgeReq = {
    bridgeId: '55555555-5555-4555-8555-555555555555',
    revision: 1,
    source: { hostId: 'source-host', workspaceId: 'ws-1', sessionId: 'sess-1' },
  };
  const validTarget = { hostId: 'target-host', workspaceId: 'ws-2', sessionId: 'sess-2' };

  it('transfers a 1.5 MiB tools_call response in 64 KiB chunks while a concurrent wait/list overtakes it mid-flight', async () => {
    const grantId = '11111111-1111-4111-8111-111111111111';
    const registry = new PeerBridgeRegistry();
    const receivedFrames: Array<{ type: string; id?: string; seq?: number; total?: number; at: number }> = [];
    const sockets: WebSocket[] = [];
    const connections: PeerBridgeConnection[] = [];
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/thread-bridges/peer/outbound') {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 0, msg: 'OK' }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    wss.on('connection', (ws) => {
      sockets.push(ws);
      const conn = new PeerBridgeConnection(grantId, registry, (frame) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(frame));
        return true;
      });
      connections.push(conn);
      ws.on('message', (raw) => {
        const frame = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as KlientFrame;
        const data = frame.data as { seq?: number; total?: number } | undefined;
        receivedFrames.push({
          type: frame.type,
          id: frame.id,
          seq: data?.seq,
          total: data?.total,
          at: performance.now(),
        });
        if (frame.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', data: frame.data }));
          return;
        }
        conn.receive(frame);
      });
      ws.on('close', () => conn.dispose());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const record = {
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Peer chunk fixture',
      endpoint: `http://127.0.0.1:${port}`,
      target: { hostId: 'peer-host' },
      credentialRef: '22222222-2222-4222-8222-222222222222',
      purposes: ['gui', 'bridge'],
      enabled: true,
      backgroundSummary: false,
      state: 'offline',
      activeLeases: 0,
      transport: undefined,
    } as unknown as RemoteConnection;
    const credential = { ownerToken: 'peer-token-one', grant: 'peer-token-one', grantId, revision: 1 };
    const largeText = `${'你好世界🚀-'.repeat(256)}${'A'.repeat(1536 * 1024)}`;
    const largeListText = 'L'.repeat(512 * 1024);
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => { releaseWait = resolve; });
    const bridge = {
      admission: { identity: { homeId: '66666666-6666-4666-8666-666666666666', hostId: 'target-host', protocol: 1 } },
      onDidChange: () => ({ dispose: () => {} }),
      ensureReversePeerBridge: vi.fn(async () => ({
        grant: { id: '33333333-3333-4333-8333-333333333333', revision: 1 },
        credential: 'reverse-peer-credential',
      })),
      revokeReversePeerBridges: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      authorizeCredential: () => ({ id: 'grant-1' }),
      attach: () => () => {},
      inboundToolsCall: vi.fn(async () => ({ output: largeText })),
      inboundWait: vi.fn(async () => {
        await waitGate;
        return { ready: true, tag: 'fast-wait' };
      }),
      inboundList: vi.fn(async () => ({ items: [largeListText] })),
    } as unknown as SpaceThreadBridge;
    const manager = {
      list: () => [record],
      get: () => record,
      secrets: { read: async () => ({ ...credential }) },
      credentialEpoch: () => 0,
      lease: (_id: string, signal: AbortSignal) => ({ signal, release: () => {} }),
      connect: async () => ({ record, credential: { ...credential }, transport: record }),
      onDidChange: () => ({ dispose: () => {} }),
      failed: vi.fn(),
      pollSummaries: vi.fn(async () => {}),
    } as unknown as RemoteConnectionManager;

    const client = new OutboundPeerBridgeClient(manager, bridge, new AbortController().signal, () => 0);
    try {
      client.start();
      await waitUntil(() => registry.isAttached(grantId, 'tools_call'));
      expect(connections[0]!.supportsChunkedResponses()).toBe(true);

      const toolsPromise = registry.forward(
        grantId,
        'tools_call',
        'reverse-peer-credential',
        { ...validBridgeReq, remoteName: 'big_tool', arguments: {}, callId: 'call-1' },
        new AbortController().signal,
      );
      const waitPromise = registry.forward(
        grantId,
        'wait',
        'reverse-peer-credential',
        { ...validBridgeReq, target: validTarget, timeoutMs: 5_000 },
        new AbortController().signal,
      );

      await waitUntil(() => receivedFrames.some((frame) => frame.type === 'bridge_response_chunk' && frame.seq === 0));
      const waitReleasedAt = performance.now();
      releaseWait();

      const waitReply = await waitPromise;
      const waitSettledAt = performance.now();
      const toolsReply = await toolsPromise;
      const toolsSettledAt = performance.now();

      expect(waitReply.status).toBe(200);
      expect((waitReply.envelope.data as { result: { tag: string } }).result.tag).toBe('fast-wait');
      expect(toolsReply.status).toBe(200);
      expect((toolsReply.envelope.data as { result: { output: string } }).result.output).toBe(largeText);

      const chunkFrames = receivedFrames.filter((frame) => frame.type === 'bridge_response_chunk');
      const waitFrameIndex = receivedFrames.findIndex((frame) => frame.type === 'bridge_response');
      const lastChunkIndex = receivedFrames.findLastIndex((frame) => frame.type === 'bridge_response_chunk');
      expect(chunkFrames.length).toBeGreaterThanOrEqual(24);
      expect(waitFrameIndex).toBeGreaterThan(-1);
      expect(waitFrameIndex).toBeLessThan(lastChunkIndex);

      const listReply = await registry.forward(
        grantId,
        'list',
        'reverse-peer-credential',
        { ...validBridgeReq },
        new AbortController().signal,
      );
      expect(listReply.status).toBe(200);
      expect((listReply.envelope.data as { result: { items: string[] } }).result.items[0]).toBe(largeListText);

      process.stdout.write(
        `[peerBridge] chunks=${chunkFrames.length} waitPreemptedAtFrame=${waitFrameIndex}/${lastChunkIndex} ` +
        `waitLatency=${(waitSettledAt - waitReleasedAt).toFixed(2)}ms toolsTotal=${(toolsSettledAt - waitReleasedAt).toFixed(2)}ms\n`,
      );
    } finally {
      await client.close();
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('enforces maxResponseBytes on accumulated chunks before JSON.parse and cleans up partial buffers on abort', async () => {
    const registry = new PeerBridgeRegistry();
    const sent: KlientFrame[] = [];
    const conn = new PeerBridgeConnection('grant-cap', registry, (frame) => {
      sent.push(frame);
      return true;
    }, { maxToolsCallResponseBytes: 4096 });
    conn.receive({ type: 'bridge_attach', id: 'attach-1', data: { capabilities: [PEER_BRIDGE_CAPABILITY_CHUNKED_V1] } });
    expect(sent.at(-1)).toMatchObject({
      type: 'bridge_attached',
      id: 'attach-1',
      data: { capabilities: [PEER_BRIDGE_CAPABILITY_CHUNKED_V1] },
    });

    const oversized = conn.forward('tools_call', 'cred', {}, new AbortController().signal);
    const reqId = sent.at(-1)!.id!;
    conn.receive({ type: 'bridge_response_chunk', id: reqId, data: { seq: 0, total: 3, status: 200, chunk: 'x'.repeat(2500) } });
    conn.receive({ type: 'bridge_response_chunk', id: reqId, data: { seq: 1, total: 3, chunk: 'x'.repeat(2500) } });
    await expect(oversized).rejects.toMatchObject({ status: 502, reason: 'bridge_response_too_large' });

    const abortController = new AbortController();
    const cancelled = conn.forward('tools_call', 'cred', {}, abortController.signal);
    const cancelId = sent.at(-1)!.id!;
    conn.receive({ type: 'bridge_response_chunk', id: cancelId, data: { seq: 0, total: 4, status: 200, chunk: '{"code":0,' } });
    abortController.abort(new Error('caller_cancelled'));
    await expect(cancelled).rejects.toThrow('caller_cancelled');
    expect(sent.at(-1)).toEqual({ type: 'bridge_cancel', id: cancelId });
    conn.dispose();
  });

  it('caps chunked read responses to a finite default ceiling and cleans up buffers on oversize rejection', async () => {
    expect(Number.isFinite(PEER_BRIDGE_READ_MAX_RESPONSE_BYTES)).toBe(true);
    expect(PEER_BRIDGE_READ_MAX_RESPONSE_BYTES).toBe(128 * 1024 * 1024);
    const registry = new PeerBridgeRegistry();
    const sent: KlientFrame[] = [];
    const conn = new PeerBridgeConnection('grant-read-cap', registry, (frame) => {
      sent.push(frame);
      return true;
    }, { maxReadResponseBytes: 4096 });
    conn.receive({ type: 'bridge_attach', id: 'attach-read', data: { capabilities: [PEER_BRIDGE_CAPABILITY_CHUNKED_V1] } });

    const oversizedRead = conn.forward('read', 'cred', {}, new AbortController().signal);
    const reqId = sent.at(-1)!.id!;
    conn.receive({ type: 'bridge_response_chunk', id: reqId, data: { seq: 0, total: 3, status: 200, chunk: 'r'.repeat(2500) } });
    conn.receive({ type: 'bridge_response_chunk', id: reqId, data: { seq: 1, total: 3, chunk: 'r'.repeat(2500) } });
    await expect(oversizedRead).rejects.toMatchObject({ status: 502, reason: 'bridge_response_too_large' });
    conn.receive({ type: 'bridge_response_chunk', id: reqId, data: { seq: 2, total: 3, chunk: 'ignored-after-cleanup' } });
    expect((conn as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);

    const smallRead = conn.forward('read', 'cred', {}, new AbortController().signal);
    const okId = sent.at(-1)!.id!;
    conn.receive({ type: 'bridge_response_chunk', id: okId, data: { seq: 0, total: 1, status: 200, chunk: JSON.stringify({ code: 0, msg: 'ok', data: { ok: true } }) } });
    await expect(smallRead).resolves.toMatchObject({ status: 200, envelope: { code: 0, msg: 'ok', data: { ok: true } } });
    conn.dispose();
  });

  it('falls back cleanly to legacy bridge_attach and single bridge_response when talking to an older strict peer', async () => {
    const grantId = '11111111-1111-4111-8111-111111111111';
    const received: KlientFrame[] = [];
    const sockets: WebSocket[] = [];
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/thread-bridges/peer/outbound') {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 0, msg: 'OK' }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    let attachedSocket: WebSocket | undefined;
    wss.on('connection', (ws) => {
      sockets.push(ws);
      ws.on('message', (raw) => {
        const frame = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as KlientFrame;
        received.push(frame);
        if (frame.type === 'bridge_attach') {
          if (frame.data !== null && typeof frame.data === 'object' && 'capabilities' in (frame.data as Record<string, unknown>)) {
            ws.send(JSON.stringify({ type: 'bridge_error', id: frame.id, code: 40001, msg: 'invalid_bridge_attach' }));
          } else {
            ws.send(JSON.stringify({ type: 'bridge_attached', id: frame.id, data: { operations: ['tools_call'] } }));
            attachedSocket = ws;
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const record = {
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Legacy peer',
      endpoint: `http://127.0.0.1:${port}`,
      target: { hostId: 'legacy-host' },
      credentialRef: '22222222-2222-4222-8222-222222222222',
      purposes: ['gui', 'bridge'],
      enabled: true,
      backgroundSummary: false,
      state: 'offline',
      activeLeases: 0,
      transport: undefined,
    } as unknown as RemoteConnection;
    const credential = { ownerToken: 'peer-token-one', grant: 'peer-token-one', grantId, revision: 1 };
    const bridge = {
      admission: { identity: { homeId: '66666666-6666-4666-8666-666666666666', hostId: 'target-host', protocol: 1 } },
      onDidChange: () => ({ dispose: () => {} }),
      ensureReversePeerBridge: vi.fn(async () => ({
        grant: { id: '33333333-3333-4333-8333-333333333333', revision: 1 },
        credential: 'reverse-peer-credential',
      })),
      revokeReversePeerBridges: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      authorizeCredential: () => ({ id: 'grant-1' }),
      attach: () => () => {},
      inboundToolsCall: vi.fn(async () => ({ output: 'B'.repeat(128 * 1024) })),
    } as unknown as SpaceThreadBridge;
    const manager = {
      list: () => [record],
      get: () => record,
      secrets: { read: async () => ({ ...credential }) },
      credentialEpoch: () => 0,
      lease: (_id: string, signal: AbortSignal) => ({ signal, release: () => {} }),
      connect: async () => ({ record, credential: { ...credential }, transport: record }),
      onDidChange: () => ({ dispose: () => {} }),
      failed: vi.fn(),
      pollSummaries: vi.fn(async () => {}),
    } as unknown as RemoteConnectionManager;

    const client = new OutboundPeerBridgeClient(manager, bridge, new AbortController().signal, () => 0);
    try {
      client.start();
      await waitUntil(() => attachedSocket !== undefined);
      attachedSocket!.send(JSON.stringify({
        type: 'bridge_request',
        id: 'legacy-req-1',
        data: {
          operation: 'tools_call',
          authorization: 'Bearer reverse-peer-credential',
          body: { ...validBridgeReq, remoteName: 'legacy_tool', arguments: {}, callId: 'call-legacy' },
        },
      }));
      await waitUntil(() => received.some((frame) => frame.type === 'bridge_response' && frame.id === 'legacy-req-1'));
      expect(received.some((frame) => frame.type === 'bridge_response_chunk')).toBe(false);
    } finally {
      await client.close();
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
