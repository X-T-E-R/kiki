import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { RemoteConnection } from '@kiki/protocol';
import type { RemoteConnectionManager } from '../src/services/connections/manager';
import { OutboundPeerBridgeClient } from '../src/services/threadBridge/outboundPeerBridgeClient';
import type { SpaceThreadBridge } from '../src/services/threadBridge/bridge';

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
        expect(frame.data).toEqual({});
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
