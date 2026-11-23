import { createHash, randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { isError2, ThreadMailboxBacklogError } from '@kiki/agent-core-v2';
import { decodeJsonFrame, encodeJsonFrame, type KlientFrame } from '@kiki/klient/host';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import {
  PEER_BRIDGE_CAPABILITY_CHUNKED_V1,
  bridgeCreateSchema,
  bridgeListSchema,
  bridgeReadSchema,
  bridgeSendSchema,
  bridgeToolsCallSchema,
  bridgeToolsListSchema,
  bridgeWaitSchema,
  type RemoteConnection,
} from '@kiki/protocol';
import { okEnvelope, errEnvelope } from '../../envelope';
import { AdmissionError } from '../connections/admission';
import type { ConnectionLease, RemoteConnectionManager } from '../connections/manager';
import { peerFetch, pooledPinnedAgent, requirePinnedTls } from '../connections/peerTls';
import { machineLabel } from '../connections/pairing';
import { resolveWsPerMessageDeflate } from '../../middleware/wireCompression';
import { ContentChangedError } from '../../transport/klient/boundedContent';
import { resolvePeerBridgeChunkBytes, sliceUtf8Chunks } from '../../transport/klient/peerBridgeSocket';
import { WS_BEARER_PROTOCOL_PREFIX } from '../../transport/ws/bearerProtocol';
import type { SpaceThreadBridge } from './bridge';

export interface OutboundPeerBridgeClientOptions {
  /** Override `KIKI_PEER_BRIDGE_CHUNK_BYTES` for chunked `bridge_response_chunk` frames. Defaults to `65536`. */
  readonly chunkBytes?: number;
  /** Override `KIKI_PEER_BRIDGE_BULK_HWM_BYTES` for bulk lane `ws.bufferedAmount` pacing. Defaults to `262144`. */
  readonly bulkHighWaterBytes?: number;
  /** Environment bag used when explicit overrides are omitted. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_BULK_HIGH_WATER_BYTES = 256 * 1024;
const BULK_BACKPRESSURE_POLL_MS = 5;

function resolveBulkHighWaterBytes(override: number | undefined, env: NodeJS.ProcessEnv): number {
  if (override !== undefined && Number.isFinite(override) && override >= 1024) {
    return Math.floor(override);
  }
  const raw = env['KIKI_PEER_BRIDGE_BULK_HWM_BYTES'];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1024) return parsed;
  }
  return DEFAULT_BULK_HIGH_WATER_BYTES;
}

interface QueuedBulkTransfer {
  readonly id: string;
  readonly frames: readonly KlientFrame[];
  index: number;
  cancelled: boolean;
  readonly isAborted: () => boolean;
}

class OutboundTwoLaneScheduler {
  private readonly highQueue: KlientFrame[] = [];
  private readonly bulkQueue: QueuedBulkTransfer[] = [];
  private immediateHandle: ReturnType<typeof setImmediate> | undefined;
  private backoffHandle: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly bulkHighWaterBytes: number,
  ) {}

  enqueueHigh(frame: KlientFrame): boolean {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return false;
    this.highQueue.push(frame);
    this.drainHigh();
    return true;
  }

  enqueueBulk(id: string, frames: readonly KlientFrame[], isAborted: () => boolean): boolean {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN || frames.length === 0) return false;
    this.bulkQueue.push({ id, frames, index: 0, cancelled: false, isAborted });
    this.schedulePump();
    return true;
  }

  cancel(id: string): void {
    for (let i = this.bulkQueue.length - 1; i >= 0; i -= 1) {
      const entry = this.bulkQueue[i]!;
      if (entry.id === id) {
        entry.cancelled = true;
        this.bulkQueue.splice(i, 1);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.immediateHandle !== undefined) {
      clearImmediate(this.immediateHandle);
      this.immediateHandle = undefined;
    }
    if (this.backoffHandle !== undefined) {
      clearTimeout(this.backoffHandle);
      this.backoffHandle = undefined;
    }
    this.highQueue.length = 0;
    this.bulkQueue.length = 0;
  }

  private drainHigh(): void {
    while (!this.closed && this.ws.readyState === WebSocket.OPEN && this.highQueue.length > 0) {
      const frame = this.highQueue.shift()!;
      try {
        this.ws.send(encodeJsonFrame(frame));
      } catch {
        this.close();
        return;
      }
    }
  }

  private schedulePump(): void {
    if (this.closed || this.immediateHandle !== undefined || this.backoffHandle !== undefined) return;
    if (this.highQueue.length === 0 && this.bulkQueue.length === 0) return;
    this.immediateHandle = setImmediate(() => {
      this.immediateHandle = undefined;
      this.pumpOnce();
    });
  }

  private pumpOnce(): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      this.close();
      return;
    }
    this.drainHigh();
    if (this.closed || this.ws.readyState !== WebSocket.OPEN || this.bulkQueue.length === 0) return;

    if (this.ws.bufferedAmount >= this.bulkHighWaterBytes) {
      this.backoffHandle = setTimeout(() => {
        this.backoffHandle = undefined;
        this.pumpOnce();
      }, BULK_BACKPRESSURE_POLL_MS);
      this.backoffHandle.unref();
      return;
    }

    while (this.bulkQueue.length > 0) {
      const entry = this.bulkQueue.shift()!;
      if (entry.cancelled || entry.isAborted() || entry.index >= entry.frames.length) continue;
      const frame = entry.frames[entry.index]!;
      entry.index += 1;
      try {
        this.ws.send(encodeJsonFrame(frame));
      } catch {
        this.close();
        return;
      }
      if (entry.index < entry.frames.length && !entry.cancelled && !entry.isAborted()) {
        this.bulkQueue.push(entry);
      }
      break;
    }

    if (this.highQueue.length > 0 || this.bulkQueue.length > 0) {
      this.schedulePump();
    }
  }
}

interface StoredPeerCredential {
  readonly ownerToken: string;
  readonly grant: string;
  readonly grantId?: string;
  readonly revision?: number;
}

interface ActivePeerTunnel {
  readonly connectionId: string;
  stop(state?: 'removed'): void;
  wake(reason?: 'normal' | 'credential' | 'network' | 'bridge'): void;
  pauseForNetworkLoss(): void;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 60_000] as const;
const AUTH_COOLDOWN_MS = 300_000;
const STABLE_ATTACHMENT_MS = 60_000;

function unitRandom(random: () => number): number {
  return Math.max(0, Math.min(1, random()));
}

function backoffDelay(delay: number, random: () => number): number {
  return delay * (0.5 + unitRandom(random) * 0.5);
}

function restartDelay(random: () => number): number {
  return 250 + Math.floor(unitRandom(random) * 350);
}

function credentialFingerprint(record: RemoteConnection, credential: StoredPeerCredential): string {
  return createHash('sha256').update(JSON.stringify([
    record.credentialRef,
    record.endpoint,
    record.target,
    credential.ownerToken,
    credential.grant,
    credential.grantId,
    credential.revision,
  ])).digest('hex');
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function isEligiblePeerBridgeRecord(record: RemoteConnection): boolean {
  return (
    record.enabled &&
    (record.transport === undefined || record.transport.kind === 'ccp_tunnel') &&
    record.purposes.includes('bridge') &&
    record.state !== 'disabled' &&
    record.state !== 'identity_changed'
  );
}

export class OutboundPeerBridgeClient {
  private readonly tunnels = new Map<string, ActivePeerTunnel>();
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly chunkBytes: number;
  private readonly bulkHighWaterBytes: number;
  private readonly env: NodeJS.ProcessEnv;
  private networkState: 'available' | 'lost' = 'available';
  private closed = false;

  constructor(
    private readonly connections: RemoteConnectionManager,
    private readonly bridge: SpaceThreadBridge,
    private readonly shutdownSignal: AbortSignal,
    private readonly random: () => number = Math.random,
    opts: OutboundPeerBridgeClientOptions = {},
  ) {
    this.env = opts.env ?? process.env;
    this.chunkBytes = resolvePeerBridgeChunkBytes(opts.chunkBytes, this.env);
    this.bulkHighWaterBytes = resolveBulkHighWaterBytes(opts.bulkHighWaterBytes, this.env);
  }

  start(): void {
    if (this.closed || this.shutdownSignal.aborted) return;
    this.subscriptions.push(
      this.connections.onDidChange(() => this.reconcile('credential')),
      this.bridge.onDidChange(() => this.reconcile('bridge')),
    );
    this.shutdownSignal.addEventListener('abort', () => { void this.close(); }, { once: true });
    this.reconcile();
  }

  notifyNetworkChange(state: 'available' | 'lost'): void {
    if (this.closed) return;
    this.networkState = state;
    if (state === 'lost') {
      for (const tunnel of this.tunnels.values()) tunnel.pauseForNetworkLoss();
      return;
    }
    this.reconcile('network');
    void this.bridge.retry().catch(() => {});
    void this.connections.pollSummaries().catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscriptions.splice(0)) sub.dispose();
    const active = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const tunnel of active) tunnel.stop();
  }

  private reconcile(wakeReason: 'normal' | 'credential' | 'network' | 'bridge' = 'normal'): void {
    if (this.closed || this.shutdownSignal.aborted) return;
    const records = this.connections.list();
    const eligibleIds = new Set<string>();
    for (const record of records) {
      if (!isEligiblePeerBridgeRecord(record)) continue;
      eligibleIds.add(record.id);
      let tunnel = this.tunnels.get(record.id);
      if (tunnel === undefined) {
        tunnel = this.createTunnel(record.id);
        this.tunnels.set(record.id, tunnel);
      }
      if (this.networkState === 'available') tunnel.wake(wakeReason);
    }
    for (const [id, tunnel] of this.tunnels.entries()) {
      if (eligibleIds.has(id)) continue;
      this.tunnels.delete(id);
      const stillExists = records.some((entry) => entry.id === id);
      tunnel.stop(stillExists ? undefined : 'removed');
      if (!stillExists) {
        void this.bridge.revokeReversePeerBridges(id).catch(() => {});
      }
    }
  }

  private createTunnel(connectionId: string): ActivePeerTunnel {
    let stopped = false;
    let paused = false;
    let attempt = 0;
    let authCooldownUntil = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let stableAttachmentTimer: ReturnType<typeof setTimeout> | undefined;
    let connectController: AbortController | undefined;
    let socketLease: ConnectionLease | undefined;
    let socket: WebSocket | undefined;
    let scheduler: OutboundTwoLaneScheduler | undefined;
    let peerSupportsChunked = false;
    let registeredKey: string | undefined;
    let lastCredentialFingerprint: string | undefined;
    let credentialRefreshInFlight = false;
    let credentialRefreshRequested = false;
    let reconnectAfterCredentialChange = false;
    const inflightRequests = new Map<string, AbortController>();

    const clearRetryTimer = (): void => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const clearTimers = (): void => {
      clearRetryTimer();
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (stableAttachmentTimer !== undefined) {
        clearTimeout(stableAttachmentTimer);
        stableAttachmentTimer = undefined;
      }
    };

    const abortInflight = (): void => {
      for (const controller of inflightRequests.values()) controller.abort();
      inflightRequests.clear();
    };

    const teardownSocket = (): void => {
      clearTimers();
      const activeScheduler = scheduler;
      scheduler = undefined;
      peerSupportsChunked = false;
      activeScheduler?.close();
      const lease = socketLease; socketLease = undefined; lease?.release();
      connectController?.abort();
      connectController = undefined;
      abortInflight();
      const current = socket;
      socket = undefined;
      if (current !== undefined) {
        current.removeAllListeners();
        current.on('error', () => {});
        try {
          if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) {
            current.terminate();
          }
        } catch {
        }
      }
    };

    const retryAfterAuthCooldown = (deadline: number, timer: ReturnType<typeof setTimeout>): void => {
      if (retryTimer !== timer) return;
      if (stopped || paused || this.closed || this.networkState === 'lost' || authCooldownUntil !== deadline) {
        retryTimer = undefined;
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        const nextTimer = setTimeout(() => retryAfterAuthCooldown(deadline, nextTimer), remaining);
        retryTimer = nextTimer;
        nextTimer.unref();
        return;
      }
      retryTimer = undefined;
      authCooldownUntil = 0;
      void connectOnce();
    };

    const setAuthCooldown = (): void => {
      authCooldownUntil = Date.now() + AUTH_COOLDOWN_MS;
      registeredKey = undefined;
      clearRetryTimer();
      const deadline = authCooldownUntil;
      const timer = setTimeout(() => retryAfterAuthCooldown(deadline, timer), AUTH_COOLDOWN_MS);
      retryTimer = timer;
      timer.unref();
    };

    const scheduleReconnect = (plannedRestart = false): void => {
      if (stopped || paused || authCooldownUntil > Date.now() || this.closed || this.networkState === 'lost') return;
      if (retryTimer !== undefined || socket !== undefined) return;
      const delay = plannedRestart
        ? restartDelay(this.random)
        : backoffDelay(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!, this.random);
      if (!plannedRestart) attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void connectOnce();
      }, delay);
      retryTimer.unref();
    };

    const sendFrame = (ws: WebSocket, frame: KlientFrame): boolean => {
      if (socket === ws && scheduler !== undefined) {
        return scheduler.enqueueHigh(frame);
      }
      if (ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(encodeJsonFrame(frame));
        return true;
      } catch {
        return false;
      }
    };

    const sendBridgeResponse = (
      ws: WebSocket,
      id: string,
      status: number,
      envelope: Record<string, unknown>,
      isAborted: () => boolean,
    ): void => {
      if (socket !== ws || scheduler === undefined || ws.readyState !== WebSocket.OPEN) return;
      if (peerSupportsChunked) {
        const serializedEnvelope = JSON.stringify(envelope);
        if (Buffer.byteLength(serializedEnvelope, 'utf8') > this.chunkBytes) {
          const slices = sliceUtf8Chunks(serializedEnvelope, this.chunkBytes);
          const total = slices.length;
          const frames: KlientFrame[] = slices.map((chunk, seq) => ({
            type: 'bridge_response_chunk',
            id,
            data: seq === 0 ? { seq, total, status, chunk } : { seq, total, chunk },
          }));
          scheduler.enqueueBulk(id, frames, isAborted);
          return;
        }
      }
      scheduler.enqueueHigh({
        type: 'bridge_response',
        id,
        data: { status, envelope },
      });
    };

    const handleInboundBridgeRequest = async (ws: WebSocket, frame: KlientFrame): Promise<void> => {
      const id = typeof frame.id === 'string' ? frame.id : '';
      if (id === '') return;
      const data = frame.data !== null && typeof frame.data === 'object' ? frame.data as Record<string, unknown> : {};
      const operation = data['operation'];
      const authorization = typeof data['authorization'] === 'string' ? data['authorization'] : '';
      const body = data['body'];
      if (operation !== 'list' && operation !== 'read' && operation !== 'send' && operation !== 'wait' && operation !== 'create' && operation !== 'tools_list' && operation !== 'tools_call') {
        sendFrame(ws, {
          type: 'bridge_response',
          id,
          data: { status: 400, envelope: errEnvelope(40001, 'invalid_bridge_request', id) },
        });
        return;
      }
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      const controller = new AbortController();
      inflightRequests.set(id, controller);
      let detach = (): void => {};
      const isAborted = (): boolean => controller.signal.aborted || this.shutdownSignal.aborted || stopped;
      try {
        if (token === '') throw new AdmissionError(401, 'invalid_bridge_credential');
        const grant = this.bridge.authorizeCredential(token);
        detach = this.bridge.attach(grant.id, controller);
        const signal = AbortSignal.any([controller.signal, this.shutdownSignal]);
        const result = operation === 'list' ? await this.bridge.inboundList(grant, bridgeListSchema.parse(body))
          : operation === 'read' ? await this.bridge.inboundRead(grant, bridgeReadSchema.parse(body), signal)
          : operation === 'send' ? await this.bridge.inboundSend(grant, bridgeSendSchema.parse(body), signal)
          : operation === 'create' ? await this.bridge.inboundCreate(grant, bridgeCreateSchema.parse(body))
          : operation === 'tools_list' ? await this.bridge.inboundToolsList(grant, bridgeToolsListSchema.parse(body), signal)
          : operation === 'tools_call' ? await this.bridge.inboundToolsCall(grant, bridgeToolsCallSchema.parse(body), signal)
          : await this.bridge.inboundWait(grant, bridgeWaitSchema.parse(body), signal);
        signal.throwIfAborted();
        sendBridgeResponse(
          ws,
          id,
          200,
          okEnvelope({ identity: this.bridge.admission.identity, result }, id) as unknown as Record<string, unknown>,
          isAborted,
        );
      } catch (error) {
        if (isAborted()) return;
        if (error instanceof ContentChangedError) {
          sendBridgeResponse(ws, id, 409, errEnvelope(40922, error.message, id) as unknown as Record<string, unknown>, isAborted);
          return;
        }
        if (error instanceof ThreadMailboxBacklogError) {
          sendBridgeResponse(ws, id, 429, errEnvelope(42901, 'bridge_queue_or_rate_limit', id) as unknown as Record<string, unknown>, isAborted);
          return;
        }
        if (isError2(error)) {
          sendBridgeResponse(ws, id, 403, errEnvelope(40301, error.message, id) as unknown as Record<string, unknown>, isAborted);
          return;
        }
        if (error instanceof Error && error.name === 'ZodError') {
          sendBridgeResponse(ws, id, 400, errEnvelope(40001, 'invalid_bridge_request', id) as unknown as Record<string, unknown>, isAborted);
          return;
        }
        if (error instanceof AdmissionError) {
          sendBridgeResponse(ws, id, error.status, errEnvelope(40101, error.reason, id) as unknown as Record<string, unknown>, isAborted);
          return;
        }
        sendBridgeResponse(
          ws,
          id,
          500,
          errEnvelope(50001, error instanceof Error ? error.message : 'bridge_internal_error', id) as unknown as Record<string, unknown>,
          isAborted,
        );
      } finally {
        detach();
        if (inflightRequests.get(id) === controller) inflightRequests.delete(id);
      }
    };

    const resumeCredentialChange = (): boolean => {
      if (!reconnectAfterCredentialChange) return false;
      reconnectAfterCredentialChange = false;
      if (!stopped && !paused && !this.closed && this.networkState === 'available') void connectOnce();
      return true;
    };

    const connectOnce = async (): Promise<void> => {
      if (stopped || paused || authCooldownUntil > Date.now() || this.closed || this.networkState === 'lost' || socket !== undefined || connectController !== undefined) {
        return;
      }
      let record: RemoteConnection;
      try {
        record = this.connections.get(connectionId);
      } catch {
        return;
      }
      if (!isEligiblePeerBridgeRecord(record)) return;

      const controller = new AbortController();
      const epoch = this.connections.credentialEpoch(connectionId);
      const current = () => !controller.signal.aborted && this.connections.credentialEpoch(connectionId) === epoch;
      connectController = controller;
      let lease: ConnectionLease | undefined;
      try {
        lease = this.connections.lease(connectionId, AbortSignal.any([controller.signal, this.shutdownSignal]));
        const { credential, transport } = await this.connections.connect(connectionId, lease.signal);
        if (current()) lastCredentialFingerprint = credentialFingerprint(record, credential);
        if (!current()) {
          connectController = undefined;
          resumeCredentialChange();
          return;
        }
        if (credential.grantId === undefined || credential.ownerToken !== credential.grant) {
          connectController = undefined;
          setAuthCooldown();
          return;
        }
        const reverse = await this.bridge.ensureReversePeerBridge({
          connectionId: record.id,
          target: record.target,
          label: machineLabel(),
          signal: lease.signal,
        });
        if (!current()) {
          connectController = undefined;
          resumeCredentialChange();
          return;
        }
        if (reverse === undefined) {
          connectController = undefined;
          return;
        }
        const nextKey = `${reverse.grant.id}:${reverse.grant.revision}`;
        if (registeredKey !== nextKey) {
          const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(15_000)]);
          const response = await peerFetch(`${transport.endpoint}/api/thread-bridges/peer/outbound`, {
            method: 'POST',
            signal,
            headers: {
              authorization: `Bearer ${credential.ownerToken}`,
              'x-kiki-connection-grant': credential.grant,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ grant: reverse.grant, credential: reverse.credential }),
          }, record.pinnedFingerprint);
          if (!current()) {
            await response.body?.cancel();
            connectController = undefined;
            resumeCredentialChange();
            return;
          }
          if (!response.ok) {
            const envelope = await readBoundedJsonBody(response, 8192).catch(() => undefined) as { msg?: unknown } | undefined;
            if (!current()) {
              connectController = undefined;
              resumeCredentialChange();
              return;
            }
            if (response.status === 401 || (response.status === 403 && envelope?.msg !== 'inbound_disabled')) {
              connectController = undefined;
              setAuthCooldown();
              this.connections.failed(record.id, new AdmissionError(response.status, 'connection_not_approved'), epoch);
              return;
            }
            throw new AdmissionError(response.status, typeof envelope?.msg === 'string' ? envelope.msg : 'peer_bridge_register_failed');
          }
          await response.body?.cancel().catch(() => {});
          registeredKey = nextKey;
        }

        if (stopped || paused || this.closed || !current()) {
          connectController = undefined;
          resumeCredentialChange();
          return;
        }

        const wsUrl = new URL('/api/klient/events', transport.endpoint);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        requirePinnedTls(wsUrl, record.pinnedFingerprint);
        const ws = new WebSocket(wsUrl, [`${WS_BEARER_PROTOCOL_PREFIX}${credential.ownerToken}`], {
          agent: record.pinnedFingerprint === undefined ? undefined : pooledPinnedAgent(transport.endpoint, record.pinnedFingerprint),
          headers: { 'x-kiki-connection-grant': credential.grant },
          maxPayload: 16 * 1024 * 1024,
          perMessageDeflate: resolveWsPerMessageDeflate({ env: this.env }),
          followRedirects: false,
          handshakeTimeout: 15_000,
        });
        socket = ws;
        scheduler = new OutboundTwoLaneScheduler(ws, this.bulkHighWaterBytes);
        peerSupportsChunked = false;
        const activeLease = lease;
        socketLease = activeLease;
        lease = undefined;
        activeLease.signal.addEventListener('abort', () => { if (socketLease === activeLease) teardownSocket(); }, { once: true });
        connectController = undefined;

        let lastInboundAt = Date.now();
        let attached = false;
        let attachSentCapabilities = true;
        ws.once('open', () => {
          if (socket !== ws || stopped || paused) return;
          lastInboundAt = Date.now();
          attachSentCapabilities = true;
          sendFrame(ws, {
            type: 'bridge_attach',
            id: randomUUID(),
            data: { capabilities: [PEER_BRIDGE_CAPABILITY_CHUNKED_V1] },
          });
          heartbeatTimer = setInterval(() => {
            if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
            if (Date.now() - lastInboundAt > 35_000) {
              teardownSocket();
              scheduleReconnect();
              return;
            }
            sendFrame(ws, { type: 'ping', data: { nonce: String(Date.now()) } });
          }, 12_000);
          heartbeatTimer.unref();
        });

        ws.on('message', (raw) => {
          if (socket !== ws || stopped) return;
          lastInboundAt = Date.now();
          const frame = decodeJsonFrame(rawDataToString(raw));
          if (frame === undefined) return;
          if (frame.type === 'ping') {
            sendFrame(ws, { type: 'pong', data: frame.data });
            return;
          }
          if (frame.type === 'bridge_attached') {
            if (attached) return;
            attached = true;
            const caps = (frame.data as { capabilities?: unknown } | undefined)?.capabilities;
            peerSupportsChunked = Array.isArray(caps) && caps.includes(PEER_BRIDGE_CAPABILITY_CHUNKED_V1);
            stableAttachmentTimer = setTimeout(() => {
              stableAttachmentTimer = undefined;
              if (socket === ws && ws.readyState === WebSocket.OPEN && attached) attempt = 0;
            }, STABLE_ATTACHMENT_MS);
            stableAttachmentTimer.unref();
            return;
          }
          if (frame.type === 'bridge_error') {
            if (!attached && attachSentCapabilities && frame.code === 40001 && frame.msg === 'invalid_bridge_attach') {
              attachSentCapabilities = false;
              peerSupportsChunked = false;
              sendFrame(ws, {
                type: 'bridge_attach',
                id: randomUUID(),
                data: {},
              });
              return;
            }
            teardownSocket();
            if (frame.code === 40301) {
              setAuthCooldown();
              this.connections.failed(record.id, new AdmissionError(403, 'connection_not_approved'), epoch);
            } else scheduleReconnect();
            return;
          }
          if (frame.type === 'bridge_cancel') {
            const id = typeof frame.id === 'string' ? frame.id : '';
            if (id !== '') {
              inflightRequests.get(id)?.abort();
              inflightRequests.delete(id);
              scheduler?.cancel(id);
            }
            return;
          }
          if (frame.type === 'bridge_request') {
            void handleInboundBridgeRequest(ws, frame);
          }
        });

        ws.on('unexpected-response', (_req, res) => {
          res.resume();
          if (socket !== ws) return;
          teardownSocket();
          if (res.statusCode === 401 || res.statusCode === 403) {
            setAuthCooldown();
            this.connections.failed(record.id, new AdmissionError(res.statusCode, 'connection_not_approved'), epoch);
            return;
          }
          scheduleReconnect();
        });

        ws.on('close', (code) => {
          if (socket !== ws) return;
          teardownSocket();
          if (code === 4001 || code === 1008) {
            setAuthCooldown();
            this.connections.failed(record.id, new AdmissionError(401, 'connection_not_approved'), epoch);
            return;
          }
          registeredKey = undefined;
          scheduleReconnect(code === 1012 || code === 4002);
        });

        ws.on('error', (error) => {
          if (socket !== ws) return;
          teardownSocket();
          if (error instanceof AdmissionError && error.reason === 'identity_changed') this.connections.failed(record.id, error, epoch);
          else scheduleReconnect();
        });
      } catch (error) {
        if (connectController === controller) connectController = undefined;
        if (resumeCredentialChange() || !current()) return;
        if (error instanceof AdmissionError && error.reason === 'gui_connection_required') return;
        if (error instanceof AdmissionError && error.reason === 'identity_changed') this.connections.failed(record.id, error, epoch);
        else if (error instanceof AdmissionError && error.status === 401) setAuthCooldown();
        else scheduleReconnect();
      } finally { lease?.release(); }
    };

    const wakeForCredentialChange = async (): Promise<void> => {
      if (credentialRefreshInFlight) {
        credentialRefreshRequested = true;
        return;
      }
      credentialRefreshInFlight = true;
      try {
        const record = this.connections.get(connectionId);
        const credential = await this.connections.secrets.read<StoredPeerCredential>({
          connectionId: record.credentialRef,
          purpose: 'gui',
        });
        const fingerprint = credentialFingerprint(record, credential);
        if (lastCredentialFingerprint === undefined) {
          lastCredentialFingerprint = fingerprint;
          if (connectController !== undefined) {
            reconnectAfterCredentialChange = true;
            connectController.abort();
          } else if (!stopped && !paused && !this.closed && this.networkState === 'available' && socket === undefined) {
            clearRetryTimer();
            void connectOnce();
          }
          return;
        }
        if (lastCredentialFingerprint === fingerprint) return;
        lastCredentialFingerprint = fingerprint;
        authCooldownUntil = 0;
        clearRetryTimer();
        registeredKey = undefined;
        if (socket !== undefined) {
          teardownSocket();
        } else if (connectController !== undefined) {
          reconnectAfterCredentialChange = true;
          connectController.abort();
          return;
        }
        if (!stopped && !paused && !this.closed && this.networkState === 'available') void connectOnce();
      } catch {
      } finally {
        credentialRefreshInFlight = false;
        if (credentialRefreshRequested) {
          credentialRefreshRequested = false;
          void wakeForCredentialChange();
        }
      }
    };

    const syncActiveReverseBridge = async (): Promise<void> => {
      const currentSocket = socket;
      const activeLease = socketLease;
      if (stopped || paused || this.closed || currentSocket === undefined || activeLease === undefined) return;
      try {
        const record = this.connections.get(connectionId);
        const epoch = this.connections.credentialEpoch(connectionId);
        const { credential, transport } = await this.connections.connect(connectionId, activeLease.signal);
        if (socket !== currentSocket || this.connections.credentialEpoch(connectionId) !== epoch) return;
        const reverse = await this.bridge.ensureReversePeerBridge({
          connectionId: record.id,
          target: record.target,
          label: machineLabel(),
          signal: activeLease.signal,
        });
        if (reverse === undefined || socket !== currentSocket) return;
        const nextKey = `${reverse.grant.id}:${reverse.grant.revision}`;
        if (registeredKey === nextKey) return;
        const response = await peerFetch(`${transport.endpoint}/api/thread-bridges/peer/outbound`, {
          method: 'POST',
          signal: AbortSignal.any([activeLease.signal, AbortSignal.timeout(15_000)]),
          headers: {
            authorization: `Bearer ${credential.ownerToken}`,
            'x-kiki-connection-grant': credential.grant,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ grant: reverse.grant, credential: reverse.credential }),
        }, record.pinnedFingerprint);
        await response.body?.cancel().catch(() => {});
        if (response.ok && socket === currentSocket) registeredKey = nextKey;
      } catch {}
    };

    return {
      connectionId,
      stop: () => {
        stopped = true;
        teardownSocket();
      },
      pauseForNetworkLoss: () => {
        paused = true;
        teardownSocket();
      },
      wake: (reason = 'normal') => {
        if (stopped || this.closed || this.networkState === 'lost') return;
        paused = false;
        if (reason === 'network') {
          authCooldownUntil = 0;
          clearRetryTimer();
          if (socket === undefined && connectController === undefined) void connectOnce();
          return;
        }
        if (reason === 'credential') {
          void wakeForCredentialChange();
          return;
        }
        if (reason === 'bridge' && socket !== undefined) {
          void syncActiveReverseBridge();
          return;
        }
        if (authCooldownUntil > Date.now() || retryTimer !== undefined) return;
        if (socket === undefined && connectController === undefined) void connectOnce();
      },
    };
  }
}
