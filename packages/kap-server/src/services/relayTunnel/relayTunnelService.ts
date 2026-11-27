import { randomBytes, randomUUID } from 'node:crypto';
import { connect as connectNetSocket, type Socket } from 'node:net';
import {
  ConfigTarget,
  DEFAULT_RELAY_CONFIG,
  RELAY_CONFIG_SECTION,
  type IConfigService,
  type RelayConfig,
} from '@kiki/agent-core-v2';
import {
  RELAY_WS_SUBPROTOCOL,
  isValidRelaySubscriptionUrl,
  normalizeRelayBaseUrl,
  parseRelayShareUri,
  relayManifestSchema,
  relayNodeCreateInputSchema,
  relayNodePatchInputSchema,
  relaySubscriptionCreateInputSchema,
  type RelayNodeConfig,
  type RelayNodeCreateInput,
  type RelayNodeLiveStatus,
  type RelayNodePatchInput,
  type RelayNodeSlot,
  type RelayProbeResult,
  type RelayStatus,
  type RelaySubscriptionConfig,
  type RelaySubscriptionCreateInput,
} from '@kiki/protocol';
import { WebSocket, type RawData } from 'ws';

import { AdmissionError } from '../connections/admission';
import type { PeerTlsIdentity } from '../connections/tlsIdentity';
import {
  buildRelayPublishedBaseStreamUrl,
  buildRelayStreamEndpoint,
  mintRelayGrantTicket,
  mintRelayPairingTicket,
  mintRelayPoolToken,
  signRelayHostChallenge,
} from './tickets';

const MAX_STANDBY_RELAYS = 2;
const HOME_WARM_POOL_SIZE = 2;
const STANDBY_WARM_POOL_SIZE = 1;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const BURST_POOL_IDLE_TIMEOUT_MS = 12_000;
const MAX_WS_PAYLOAD_BYTES = 1_048_576;
const STREAM_HIGH_WATER_BYTES = 1_048_576;
const STREAM_LOW_WATER_BYTES = 262_144;
const HYSTERESIS_MIN_IMPROVEMENT_MS = 10;
const DEFAULT_SUBSCRIPTION_REFRESH_SEC = 21_600;

export interface RelayTunnelServiceOptions {
  readonly configService: Pick<IConfigService, 'ready' | 'get' | 'replace' | 'onDidSectionChange'>;
  readonly identity?: PeerTlsIdentity;
  readonly isInboundEnabled: () => boolean;
  readonly ensurePeerLoopback: () => Promise<string | undefined>;
  readonly getLoopbackUrl: () => string | undefined;
  readonly onDidChange?: () => void;
  readonly fetchImpl?: typeof fetch;
}

interface NodeTelemetry {
  rttMs?: number;
  lastConnectedAt?: number;
  lastError?: string;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function relayHttpOriginUrl(relayBaseUrl: string, suffixPath: string): string {
  const parsed = new URL(relayBaseUrl);
  const scheme = parsed.protocol === 'ws:' ? 'http:' : 'https:';
  const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${scheme}//${parsed.host}${basePath}${suffixPath}`;
}

function defaultNodeLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.host}${pathname}`.slice(0, 128);
  } catch {
    return url.slice(0, 128);
  }
}

class RelayNodeHostSession {
  capKeyHex: string | undefined;
  connected = false;
  connecting = false;
  private closed = false;
  private controlWs: WebSocket | undefined;
  private readonly idlePool = new Set<WebSocket>();
  private readonly activeStreams = new Set<{ readonly ws: WebSocket; readonly tcp?: Socket }>();
  private poolOpeningCount = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private awaitingPongSince: number | undefined;
  private nextReconnectDelayOverrideMs: number | undefined;
  private readonly readyWaiters = new Set<() => void>();

  constructor(
    public node: RelayNodeConfig,
    public warmPoolTarget: number,
    private readonly identity: PeerTlsIdentity,
    private readonly telemetry: NodeTelemetry,
    private readonly ensurePeerLoopback: () => Promise<string | undefined>,
    private readonly getLoopbackUrl: () => string | undefined,
    private readonly notifyChange: () => void,
  ) {}

  start(): void {
    if (this.closed || this.controlWs !== undefined) return;
    this.dialControl();
  }

  updateConfig(nextNode: RelayNodeConfig, warmPoolTarget: number): void {
    const urlChanged = this.node.url !== nextNode.url || this.node.token !== nextNode.token;
    this.node = nextNode;
    this.warmPoolTarget = warmPoolTarget;
    if (urlChanged) {
      this.teardownControlAndIdlePool();
      if (!this.closed) this.dialControl();
      return;
    }
    if (this.connected) {
      this.ensureWarmPool();
    }
  }

  waitForConnected(timeoutMs: number): Promise<boolean> {
    if (this.connected && this.capKeyHex !== undefined) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.readyWaiters.delete(onReady);
        resolve(this.connected && this.capKeyHex !== undefined);
      };
      const onReady = () => done();
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.readyWaiters.add(onReady);
    });
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters) waiter();
    this.readyWaiters.clear();
  }

  private authHeaders(): Record<string, string> | undefined {
    const token = this.node.token?.trim();
    return token === undefined || token === '' ? undefined : { authorization: `Bearer ${token}` };
  }

  private dialControl(): void {
    if (this.closed || this.controlWs !== undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const baseUrl = normalizeRelayBaseUrl(this.node.url);
    if (baseUrl === undefined) {
      this.telemetry.lastError = 'Invalid relay URL';
      this.notifyChange();
      return;
    }
    this.connecting = true;
    const ws = new WebSocket(`${baseUrl}/v1/host`, [RELAY_WS_SUBPROTOCOL], {
      headers: this.authHeaders(),
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
      maxPayload: 65_536,
    });
    this.controlWs = ws;

    ws.on('message', (raw, isBinary) => {
      if (this.controlWs !== ws || isBinary) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawDataToBuffer(raw).toString('utf8')) as Record<string, unknown>;
      } catch {
        ws.close(1008, 'invalid json');
        return;
      }
      const type = msg['type'];
      if (type === 'challenge') {
        const nonce = typeof msg['nonce'] === 'string' ? msg['nonce'] : '';
        const ts = typeof msg['ts'] === 'number' ? msg['ts'] : NaN;
        if (!/^[a-f0-9]{32,128}$/i.test(nonce) || !Number.isFinite(ts)) {
          ws.close(1008, 'invalid challenge');
          return;
        }
        try {
          const signed = signRelayHostChallenge(this.identity.key, baseUrl, nonce, ts);
          ws.send(
            JSON.stringify({
              type: 'register',
              spkiDer: signed.spkiDerBase64,
              signature: signed.signatureBase64,
            }),
          );
        } catch (error) {
          this.telemetry.lastError = error instanceof Error ? error.message : 'challenge signing failed';
          ws.close(1011, 'sign failed');
        }
        return;
      }
      if (type === 'registered') {
        const fp = typeof msg['fp'] === 'string' ? msg['fp'].toLowerCase() : '';
        const capKey = typeof msg['capKey'] === 'string' ? msg['capKey'].toLowerCase() : '';
        if (fp !== this.identity.tlsFingerprint || !/^[a-f0-9]{64}$/.test(capKey)) {
          this.telemetry.lastError = 'Relay registration identity mismatch';
          ws.close(1008, 'invalid registration');
          return;
        }
        this.capKeyHex = capKey;
        this.connected = true;
        this.connecting = false;
        this.retryAttempt = 0;
        this.awaitingPongSince = undefined;
        this.telemetry.lastConnectedAt = Date.now();
        delete this.telemetry.lastError;
        this.startHeartbeat(ws);
        this.ensureWarmPool();
        this.resolveReadyWaiters();
        this.notifyChange();
        return;
      }
      if (type === 'pong') {
        const sentAt = typeof msg['ts'] === 'number' ? msg['ts'] : undefined;
        this.awaitingPongSince = undefined;
        if (sentAt !== undefined && Number.isFinite(sentAt)) {
          this.telemetry.rttMs = Math.max(1, Math.round(Date.now() - sentAt));
        }
        return;
      }
      if (type === 'replenish' && this.connected) {
        this.ensureWarmPool();
        return;
      }
      if (type === 'open' && this.connected) {
        const ticket = typeof msg['ticket'] === 'string' ? msg['ticket'] : '';
        if (/^[a-f0-9]{16,64}$/i.test(ticket)) {
          this.openPoolSocket(baseUrl, ticket);
        }
        return;
      }
      if (type === 'restarting') {
        const reconnectInMs = typeof msg['reconnectInMs'] === 'number' ? msg['reconnectInMs'] : 1000;
        this.nextReconnectDelayOverrideMs = Math.min(30_000, Math.max(200, reconnectInMs));
      }
    });

    ws.on('pong', () => {
      if (this.controlWs === ws) this.awaitingPongSince = undefined;
    });

    const handleDisconnect = (reason?: string) => {
      if (this.controlWs !== ws) return;
      this.controlWs = undefined;
      const wasConnected = this.connected;
      this.connected = false;
      this.connecting = false;
      this.capKeyHex = undefined;
      this.stopHeartbeat();
      this.closeIdlePool();
      if (reason !== undefined && reason !== '') {
        this.telemetry.lastError = reason;
      }
      if (this.closed) {
        this.resolveReadyWaiters();
        return;
      }
      this.scheduleReconnect();
      if (wasConnected || reason !== undefined) {
        this.notifyChange();
      }
    };

    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      handleDisconnect(`HTTP ${res.statusCode ?? 502}`);
    });
    ws.on('error', (err) => {
      handleDisconnect(err.message || 'Relay connection failed');
    });
    ws.on('close', (code, reasonBuf) => {
      const text = reasonBuf.toString('utf8').trim();
      handleDisconnect(code === 1000 ? undefined : (text || `Closed (${code})`));
    });
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.controlWs !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (
        this.awaitingPongSince !== undefined &&
        Date.now() - this.awaitingPongSince > HEARTBEAT_TIMEOUT_MS
      ) {
        ws.terminate();
        return;
      }
      this.awaitingPongSince = Date.now();
      try {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        ws.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.awaitingPongSince = undefined;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    let delayMs: number;
    if (this.nextReconnectDelayOverrideMs !== undefined) {
      delayMs = this.nextReconnectDelayOverrideMs;
      this.nextReconnectDelayOverrideMs = undefined;
    } else {
      const base = Math.min(15_000, 500 * 2 ** Math.min(this.retryAttempt, 5));
      delayMs = base + Math.floor(Math.random() * 250);
      this.retryAttempt += 1;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.dialControl();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  idlePoolCount(): number {
    return this.idlePool.size;
  }

  ensureWarmPool(): void {
    if (this.closed || !this.connected || this.capKeyHex === undefined) return;
    while (this.idlePool.size > this.warmPoolTarget) {
      const extra = this.idlePool.values().next().value;
      if (extra === undefined) break;
      this.idlePool.delete(extra);
      extra.close(1000, 'pool shrink');
    }
    const baseUrl = normalizeRelayBaseUrl(this.node.url);
    if (baseUrl === undefined) return;
    while (this.idlePool.size + this.poolOpeningCount < this.warmPoolTarget) {
      this.openPoolSocket(baseUrl);
    }
  }

  private openPoolSocket(baseUrl: string, ticket?: string): void {
    if (this.closed || this.capKeyHex === undefined) return;
    const isWarm = ticket === undefined;
    if (isWarm) this.poolOpeningCount += 1;
    const nonce = randomBytes(16).toString('hex');
    const fp = this.identity.tlsFingerprint;
    const poolToken = mintRelayPoolToken(this.capKeyHex, fp, nonce, ticket);
    const params = new URLSearchParams({ fp, nonce, poolToken });
    if (ticket !== undefined) params.set('ticket', ticket);
    const ws = new WebSocket(`${baseUrl}/v1/pool?${params.toString()}`, [RELAY_WS_SUBPROTOCOL], {
      headers: this.authHeaders(),
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
    });

    let settledOpen = false;
    let activated = false;
    let burstIdleTimer: ReturnType<typeof setTimeout> | undefined;
    if (!isWarm) {
      burstIdleTimer = setTimeout(() => {
        if (!activated) ws.close(1000, 'burst ticket expired');
      }, BURST_POOL_IDLE_TIMEOUT_MS);
      burstIdleTimer.unref?.();
    }

    const clearBurstTimer = () => {
      if (burstIdleTimer !== undefined) {
        clearTimeout(burstIdleTimer);
        burstIdleTimer = undefined;
      }
    };

    const releaseOpening = () => {
      if (!settledOpen && isWarm) {
        settledOpen = true;
        this.poolOpeningCount = Math.max(0, this.poolOpeningCount - 1);
      }
    };

    ws.once('open', () => {
      releaseOpening();
      if (this.closed) {
        clearBurstTimer();
        ws.terminate();
        return;
      }
      if (isWarm && !activated) {
        if (this.idlePool.size >= this.warmPoolTarget) {
          ws.close(1000, 'pool shrink');
          return;
        }
        this.idlePool.add(ws);
      }
    });

    const onPreActivateMessage = (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(1008, 'unexpected binary before activate');
        return;
      }
      let parsed: { type?: unknown };
      try {
        parsed = JSON.parse(rawDataToBuffer(raw).toString('utf8')) as { type?: unknown };
      } catch {
        ws.close(1008, 'invalid activate frame');
        return;
      }
      if (parsed.type !== 'activate') return;
      activated = true;
      clearBurstTimer();
      ws.off('message', onPreActivateMessage);
      this.idlePool.delete(ws);
      if (isWarm && this.connected) {
        this.ensureWarmPool();
      }
      void this.bridgeActivatedSocketToLoopbackTls(ws);
    };

    ws.on('message', onPreActivateMessage);
    ws.once('error', () => {
      clearBurstTimer();
      releaseOpening();
      this.idlePool.delete(ws);
      ws.terminate();
    });
    ws.once('close', () => {
      clearBurstTimer();
      releaseOpening();
      const removedIdle = this.idlePool.delete(ws);
      if (removedIdle && !this.closed && this.connected) {
        this.ensureWarmPool();
      }
    });
  }

  private async bridgeActivatedSocketToLoopbackTls(ws: WebSocket): Promise<void> {
    const queuedChunks: Buffer[] = [];
    let tcpReady = false;
    let closed = false;
    let tcpSocket: Socket | undefined;

    const entry: { readonly ws: WebSocket; tcp?: Socket } = { ws };
    this.activeStreams.add(entry);

    const teardown = () => {
      if (closed) return;
      closed = true;
      this.activeStreams.delete(entry);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000);
      }
      if (tcpSocket !== undefined && !tcpSocket.destroyed) {
        tcpSocket.destroy();
      }
    };

    ws.on('message', (raw) => {
      if (closed) return;
      const chunk = rawDataToBuffer(raw);
      if (!tcpReady || tcpSocket === undefined) {
        queuedChunks.push(chunk);
        if (queuedChunks.reduce((sum, item) => sum + item.byteLength, 0) > STREAM_HIGH_WATER_BYTES) {
          ws.pause();
        }
        return;
      }
      if (!tcpSocket.write(chunk)) {
        ws.pause();
      }
    });
    ws.once('close', teardown);
    ws.once('error', teardown);

    const loopbackUrl = this.getLoopbackUrl() ?? (await this.ensurePeerLoopback().catch(() => undefined));
    if (closed || loopbackUrl === undefined) {
      teardown();
      return;
    }
    let parsedLoopback: URL;
    try {
      parsedLoopback = new URL(loopbackUrl);
    } catch {
      teardown();
      return;
    }
    const port = Number(parsedLoopback.port);
    if (
      parsedLoopback.protocol !== 'https:' ||
      parsedLoopback.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) ||
      port <= 0
    ) {
      teardown();
      return;
    }

    const socket = connectNetSocket({ host: '127.0.0.1', port, noDelay: true });
    tcpSocket = socket;
    entry.tcp = socket;

    socket.once('connect', () => {
      if (closed) {
        socket.destroy();
        return;
      }
      tcpReady = true;
      let needsDrain = false;
      while (queuedChunks.length > 0) {
        const next = queuedChunks.shift()!;
        if (!socket.write(next)) needsDrain = true;
      }
      if (!needsDrain && ws.isPaused && ws.readyState === WebSocket.OPEN) {
        ws.resume();
      }
    });

    socket.on('drain', () => {
      if (!closed && ws.isPaused && ws.readyState === WebSocket.OPEN) {
        ws.resume();
      }
    });

    socket.on('data', (chunk: Buffer) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount + chunk.byteLength > STREAM_HIGH_WATER_BYTES) {
        socket.pause();
      }
      ws.send(chunk, { binary: true }, (err) => {
        if (err) {
          teardown();
          return;
        }
        if (!closed && socket.isPaused() && ws.bufferedAmount <= STREAM_LOW_WATER_BYTES) {
          socket.resume();
        }
      });
    });

    socket.once('end', teardown);
    socket.once('close', teardown);
    socket.once('error', teardown);
  }

  private closeIdlePool(): void {
    for (const poolWs of this.idlePool) {
      poolWs.terminate();
    }
    this.idlePool.clear();
    this.poolOpeningCount = 0;
  }

  private teardownControlAndIdlePool(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    this.connected = false;
    this.connecting = false;
    this.capKeyHex = undefined;
    const ws = this.controlWs;
    this.controlWs = undefined;
    if (ws !== undefined) {
      ws.terminate();
    }
    this.closeIdlePool();
  }

  close(closeActiveStreams = true): void {
    this.closed = true;
    this.teardownControlAndIdlePool();
    if (closeActiveStreams) {
      for (const active of this.activeStreams) {
        active.ws.terminate();
        active.tcp?.destroy();
      }
      this.activeStreams.clear();
    }
    this.resolveReadyWaiters();
  }
}

/** Manages outbound Home + Standby `kiki-relay` host sessions, pre-warmed reverse WSS pools, RTT probing, and `relays.json` subscriptions. */
export class RelayTunnelService {
  private readonly sessions = new Map<string, RelayNodeHostSession>();
  private readonly telemetry = new Map<string, NodeTelemetry>();
  private homeNodeId: string | undefined;
  private standbyNodeIds: string[] = [];
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private subscriptionTimer: ReturnType<typeof setInterval> | undefined;
  private configSubscription: { dispose(): void } | undefined;
  private closed = false;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RelayTunnelServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async start(): Promise<void> {
    await this.options.configService.ready;
    if (this.closed) return;
    this.configSubscription = this.options.configService.onDidSectionChange((event) => {
      if (event.domain === RELAY_CONFIG_SECTION && !this.closed) {
        void this.reconcileNow().catch(() => undefined);
      }
    });
    await this.reconcileNow();
    this.probeTimer = setInterval(() => {
      void this.probeAndReconcile().catch(() => undefined);
    }, PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
    this.subscriptionTimer = setInterval(() => {
      void this.refreshDueSubscriptions().catch(() => undefined);
    }, 60_000);
    this.subscriptionTimer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.configSubscription?.dispose();
    this.configSubscription = undefined;
    if (this.probeTimer !== undefined) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
    if (this.subscriptionTimer !== undefined) {
      clearInterval(this.subscriptionTimer);
      this.subscriptionTimer = undefined;
    }
    for (const session of this.sessions.values()) {
      session.close(true);
    }
    this.sessions.clear();
    this.homeNodeId = undefined;
    this.standbyNodeIds = [];
    await this.mutationQueue.catch(() => undefined);
  }

  private readConfig(): RelayConfig {
    const raw = this.options.configService.get<RelayConfig | undefined>(RELAY_CONFIG_SECTION);
    return raw ?? DEFAULT_RELAY_CONFIG;
  }

  private serializeMutation<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(work);
    this.mutationQueue = next.catch(() => undefined);
    return next;
  }

  private nodeTelemetry(id: string): NodeTelemetry {
    let record = this.telemetry.get(id);
    if (record === undefined) {
      record = {};
      this.telemetry.set(id, record);
    }
    return record;
  }

  private async measureProbe(rawUrl: string): Promise<RelayProbeResult> {
    const normalized = normalizeRelayBaseUrl(rawUrl);
    if (normalized === undefined) {
      return { ok: false, url: rawUrl, error: 'Invalid relay URL' };
    }
    const probeEndpoint = relayHttpOriginUrl(normalized, '/v1/probe');
    const startedAt = performance.now();
    try {
      const response = await this.fetchImpl(probeEndpoint, {
        method: 'GET',
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, url: normalized, error: `HTTP ${response.status}` };
      }
      const data = (await response.json()) as { ok?: unknown; version?: unknown };
      const rttMs = Math.max(1, Math.round(performance.now() - startedAt));
      if (data?.ok !== true) {
        return { ok: false, url: normalized, error: 'Invalid probe payload' };
      }
      return {
        ok: true,
        url: normalized,
        rttMs,
        ...(typeof data.version === 'number' && Number.isInteger(data.version) && data.version > 0
          ? { version: data.version }
          : {}),
      };
    } catch (error) {
      return {
        ok: false,
        url: normalized,
        error: error instanceof Error ? error.message : 'Probe failed',
      };
    }
  }

  async probeUrl(rawUrl: string): Promise<RelayProbeResult> {
    const result = await this.measureProbe(rawUrl);
    if (result.ok && result.rttMs !== undefined && !this.closed) {
      const config = this.readConfig();
      const matched = config.nodes.filter(
        (node) => normalizeRelayBaseUrl(node.url) === result.url,
      );
      if (matched.length > 0) {
        for (const node of matched) {
          this.nodeTelemetry(node.id).rttMs = result.rttMs;
        }
        await this.reconcileNow();
      }
    }
    return result;
  }

  async probeAndReconcile(): Promise<void> {
    if (this.closed) return;
    const config = this.readConfig();
    const enabledNodes = config.nodes.filter((node) => node.enabled);
    await Promise.all(
      enabledNodes.map(async (node) => {
        const result = await this.measureProbe(node.url);
        const tel = this.nodeTelemetry(node.id);
        if (result.ok && result.rttMs !== undefined) {
          tel.rttMs = result.rttMs;
        }
      }),
    );
    await this.reconcileNow();
  }

  async reconcileNow(): Promise<void> {
    if (this.closed) return;
    const config = this.readConfig();
    const inboundEnabled = this.options.isInboundEnabled();
    const identity = this.options.identity;
    const enabledNodes = config.nodes.filter((node) => node.enabled);

    if (!inboundEnabled || identity === undefined || enabledNodes.length === 0) {
      for (const session of this.sessions.values()) {
        session.close(false);
      }
      this.sessions.clear();
      this.homeNodeId = undefined;
      this.standbyNodeIds = [];
      this.options.onDidChange?.();
      return;
    }

    await this.options.ensurePeerLoopback().catch(() => undefined);
    if (this.closed) return;

    const missingRttNodes = enabledNodes.filter((node) => this.telemetry.get(node.id)?.rttMs === undefined);
    if (missingRttNodes.length > 0) {
      await Promise.all(
        missingRttNodes.map(async (node) => {
          const res = await this.measureProbe(node.url);
          if (res.ok && res.rttMs !== undefined) {
            this.nodeTelemetry(node.id).rttMs = res.rttMs;
          }
        }),
      );
    }

    const rankRtt = (node: RelayNodeConfig): number => this.telemetry.get(node.id)?.rttMs ?? Number.POSITIVE_INFINITY;
    const autoNodes = enabledNodes
      .filter((node) => node.role === 'auto')
      .toSorted((left, right) => rankRtt(left) - rankRtt(right));
    const backupNodes = enabledNodes
      .filter((node) => node.role === 'backup-only')
      .toSorted((left, right) => rankRtt(left) - rankRtt(right));

    let nextHomeId: string | undefined;
    if (autoNodes.length > 0) {
      const bestAuto = autoNodes[0]!;
      const currentHome =
        this.homeNodeId === undefined
          ? undefined
          : autoNodes.find((node) => node.id === this.homeNodeId);
      const currentSession =
        currentHome === undefined ? undefined : this.sessions.get(currentHome.id);
      const currentRtt = currentHome === undefined ? undefined : this.telemetry.get(currentHome.id)?.rttMs;
      const bestRtt = this.telemetry.get(bestAuto.id)?.rttMs;

      if (
        currentHome !== undefined &&
        currentSession?.connected === true &&
        currentRtt !== undefined
      ) {
        const shouldSwitch =
          bestAuto.id !== currentHome.id &&
          bestRtt !== undefined &&
          currentRtt - bestRtt >= HYSTERESIS_MIN_IMPROVEMENT_MS &&
          bestRtt < (currentRtt * 2) / 3;
        nextHomeId = shouldSwitch ? bestAuto.id : currentHome.id;
      } else {
        nextHomeId = bestAuto.id;
      }
    }

    const standbyCandidates = [
      ...autoNodes.filter((node) => node.id !== nextHomeId),
      ...backupNodes,
    ];
    const nextStandbyIds = standbyCandidates
      .slice(0, nextHomeId === undefined ? MAX_STANDBY_RELAYS + 1 : MAX_STANDBY_RELAYS)
      .map((node) => node.id);

    this.homeNodeId = nextHomeId;
    this.standbyNodeIds = nextStandbyIds;

    const desiredActive = new Map<string, { node: RelayNodeConfig; warmPoolSize: number }>();
    for (const node of enabledNodes) {
      if (node.id === nextHomeId) {
        desiredActive.set(node.id, { node, warmPoolSize: HOME_WARM_POOL_SIZE });
      } else if (nextStandbyIds.includes(node.id)) {
        desiredActive.set(node.id, { node, warmPoolSize: STANDBY_WARM_POOL_SIZE });
      }
    }

    for (const [id, session] of this.sessions) {
      if (!desiredActive.has(id)) {
        session.close(false);
        this.sessions.delete(id);
      }
    }

    for (const [id, spec] of desiredActive) {
      const existing = this.sessions.get(id);
      if (existing !== undefined) {
        existing.updateConfig(spec.node, spec.warmPoolSize);
      } else {
        const session = new RelayNodeHostSession(
          spec.node,
          spec.warmPoolSize,
          identity,
          this.nodeTelemetry(id),
          this.options.ensurePeerLoopback,
          this.options.getLoopbackUrl,
          () => this.options.onDidChange?.(),
        );
        this.sessions.set(id, session);
        session.start();
      }
    }

    this.options.onDidChange?.();
  }

  private orderedActiveSessions(): RelayNodeHostSession[] {
    const orderedIds = [
      ...(this.homeNodeId === undefined ? [] : [this.homeNodeId]),
      ...this.standbyNodeIds,
    ];
    const list: RelayNodeHostSession[] = [];
    for (const id of orderedIds) {
      const session = this.sessions.get(id);
      if (session !== undefined) list.push(session);
    }
    return list;
  }

  async mintPairingEndpoints(expiresAtMs: number): Promise<string[]> {
    const fp = this.options.identity?.tlsFingerprint;
    if (fp === undefined || !this.options.isInboundEnabled()) return [];
    const active = this.orderedActiveSessions();
    if (active.length === 0) return [];
    if (!active.some((s) => s.connected && s.capKeyHex !== undefined)) {
      await Promise.all(active.map((session) => session.waitForConnected(1_500)));
    }
    const expSec = Math.max(Math.floor(Date.now() / 1000) + 60, Math.ceil(expiresAtMs / 1000));
    const endpoints: string[] = [];
    for (const session of this.orderedActiveSessions()) {
      if (!session.connected || session.capKeyHex === undefined) continue;
      const baseUrl = normalizeRelayBaseUrl(session.node.url);
      if (baseUrl === undefined) continue;
      const ticket = mintRelayPairingTicket(session.capKeyHex, fp, expSec);
      endpoints.push(buildRelayStreamEndpoint(baseUrl, fp, ticket));
    }
    return endpoints;
  }

  mintGrantEndpoints(grantId: string): string[] {
    const fp = this.options.identity?.tlsFingerprint;
    if (fp === undefined) return [];
    const endpoints: string[] = [];
    for (const session of this.orderedActiveSessions()) {
      if (!session.connected || session.capKeyHex === undefined) continue;
      const baseUrl = normalizeRelayBaseUrl(session.node.url);
      if (baseUrl === undefined) continue;
      const ticket = mintRelayGrantTicket(session.capKeyHex, fp, grantId);
      endpoints.push(buildRelayStreamEndpoint(baseUrl, fp, ticket));
    }
    return endpoints;
  }

  warmPoolCounts(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const [id, session] of this.sessions) {
      counts[id] = session.idlePoolCount();
    }
    return counts;
  }

  status(): RelayStatus {
    const config = this.readConfig();
    const fp = this.options.identity?.tlsFingerprint;
    const inboundEnabled = this.options.isInboundEnabled();
    const nodes: RelayNodeLiveStatus[] = config.nodes.map((node) => {
      const session = this.sessions.get(node.id);
      const tel = this.telemetry.get(node.id);
      const baseUrl = normalizeRelayBaseUrl(node.url) ?? node.url;
      let slot: RelayNodeSlot;
      if (!node.enabled) {
        slot = 'disabled';
      } else if (session?.connected === true) {
        slot =
          node.id === this.homeNodeId
            ? 'home'
            : this.standbyNodeIds.includes(node.id)
              ? 'standby'
              : 'backup-only';
      } else if (session?.connecting === true) {
        slot = 'connecting';
      } else if (tel?.lastError !== undefined) {
        slot = 'error';
      } else if (node.role === 'backup-only') {
        slot = 'backup-only';
      } else {
        slot = 'offline';
      }
      return {
        id: node.id,
        label: node.label?.trim() || defaultNodeLabel(baseUrl),
        url: baseUrl,
        role: node.role,
        enabled: node.enabled,
        tokenConfigured: Boolean(node.token && node.token.trim() !== ''),
        ...(node.subscriptionId === undefined ? {} : { subscriptionId: node.subscriptionId }),
        slot,
        connected: session?.connected === true,
        ...(tel?.rttMs === undefined ? {} : { rttMs: tel.rttMs }),
        ...(tel?.lastConnectedAt === undefined ? {} : { lastConnectedAt: tel.lastConnectedAt }),
        ...(tel?.lastError === undefined ? {} : { lastError: tel.lastError }),
        ...(session?.connected === true && fp !== undefined
          ? { publishedStreamUrl: buildRelayPublishedBaseStreamUrl(baseUrl, fp) }
          : {}),
      };
    });

    return {
      schemaVersion: 1,
      ...(fp === undefined ? {} : { hostFingerprint: fp }),
      inboundEnabled,
      ...(this.homeNodeId === undefined ? {} : { homeNodeId: this.homeNodeId }),
      standbyNodeIds: [...this.standbyNodeIds],
      nodes,
      subscriptions: config.subscriptions.map((sub) => ({ ...sub })),
    };
  }

  async addNode(rawInput: RelayNodeCreateInput): Promise<RelayStatus> {
    const input = relayNodeCreateInputSchema.parse(rawInput);
    return this.serializeMutation(async () => {
      await this.options.configService.ready;
      const current = this.readConfig();
      let url: string;
      let label: string | undefined;
      let token: string | undefined;
      let role: 'auto' | 'backup-only' = 'auto';
      const enabled = input.enabled ?? true;

      if ('uri' in input) {
        const trimmedUri = input.uri.trim();
        if (/^kiki-relay:\/\//i.test(trimmedUri)) {
          const parsedShare = parseRelayShareUri(trimmedUri);
          if (parsedShare === undefined) {
            throw new AdmissionError(400, 'invalid_relay_uri');
          }
          url = parsedShare.url;
          label = parsedShare.label;
          token = parsedShare.token;
          role = parsedShare.role;
        } else {
          const normalized = normalizeRelayBaseUrl(trimmedUri);
          if (normalized === undefined) {
            throw new AdmissionError(400, 'invalid_relay_uri');
          }
          url = normalized;
        }
      } else {
        const normalized = normalizeRelayBaseUrl(input.url);
        if (normalized === undefined) {
          throw new AdmissionError(400, 'invalid_relay_url');
        }
        url = normalized;
        label = input.label?.trim() || undefined;
        token = input.token?.trim() || undefined;
        role = input.role ?? 'auto';
      }

      const existingIdx = current.nodes.findIndex(
        (entry) => entry.subscriptionId === undefined && entry.url === url,
      );
      const nextNodes = [...current.nodes];
      let targetId: string;
      if (existingIdx >= 0) {
        const prev = nextNodes[existingIdx]!;
        targetId = prev.id;
        nextNodes[existingIdx] = {
          id: prev.id,
          url,
          role,
          enabled,
          ...(label ?? prev.label ? { label: label ?? prev.label } : {}),
          ...(token ?? prev.token ? { token: token ?? prev.token } : {}),
        };
      } else {
        targetId = ('id' in input && input.id?.trim()) ? input.id.trim() : randomUUID();
        nextNodes.push({
          id: targetId,
          url,
          role,
          enabled,
          ...(label === undefined ? {} : { label }),
          ...(token === undefined ? {} : { token }),
        });
      }

      await this.options.configService.replace(
        RELAY_CONFIG_SECTION,
        { nodes: nextNodes, subscriptions: current.subscriptions },
        ConfigTarget.User,
      );
      const probe = await this.measureProbe(url);
      if (probe.ok && probe.rttMs !== undefined) {
        this.nodeTelemetry(targetId).rttMs = probe.rttMs;
      }
      await this.reconcileNow();
      if (enabled && this.options.isInboundEnabled()) {
        await this.sessions.get(targetId)?.waitForConnected(1_500);
      }
      return this.status();
    });
  }

  async updateNode(id: string, rawPatch: RelayNodePatchInput): Promise<RelayStatus> {
    const patch = relayNodePatchInputSchema.parse(rawPatch);
    return this.serializeMutation(async () => {
      await this.options.configService.ready;
      const current = this.readConfig();
      const idx = current.nodes.findIndex((entry) => entry.id === id);
      if (idx < 0) throw new AdmissionError(404, 'relay_node_not_found');
      const existing = current.nodes[idx]!;
      let nextUrl = existing.url;
      if (patch.url !== undefined) {
        const normalized = normalizeRelayBaseUrl(patch.url);
        if (normalized === undefined) throw new AdmissionError(400, 'invalid_relay_url');
        nextUrl = normalized;
      }
      const nextLabel = patch.label === null ? undefined : (patch.label?.trim() || existing.label);
      const nextToken = patch.token === null ? undefined : (patch.token?.trim() || existing.token);
      const updated: RelayNodeConfig = {
        id: existing.id,
        url: nextUrl,
        role: patch.role ?? existing.role,
        enabled: patch.enabled ?? existing.enabled,
        ...(nextLabel === undefined ? {} : { label: nextLabel }),
        ...(nextToken === undefined ? {} : { token: nextToken }),
        ...(existing.subscriptionId === undefined ? {} : { subscriptionId: existing.subscriptionId }),
      };
      const nextNodes = current.nodes.map((entry, i) => (i === idx ? updated : entry));
      await this.options.configService.replace(
        RELAY_CONFIG_SECTION,
        { nodes: nextNodes, subscriptions: current.subscriptions },
        ConfigTarget.User,
      );
      await this.reconcileNow();
      return this.status();
    });
  }

  async removeNode(id: string): Promise<RelayStatus> {
    return this.serializeMutation(async () => {
      await this.options.configService.ready;
      const current = this.readConfig();
      if (!current.nodes.some((entry) => entry.id === id)) {
        throw new AdmissionError(404, 'relay_node_not_found');
      }
      const nextNodes = current.nodes.filter((entry) => entry.id !== id);
      this.telemetry.delete(id);
      await this.options.configService.replace(
        RELAY_CONFIG_SECTION,
        { nodes: nextNodes, subscriptions: current.subscriptions },
        ConfigTarget.User,
      );
      await this.reconcileNow();
      return this.status();
    });
  }

  async addSubscription(rawInput: RelaySubscriptionCreateInput): Promise<RelayStatus> {
    const parsedInput = relaySubscriptionCreateInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new AdmissionError(400, 'invalid_relay_subscription_url');
    }
    const input = parsedInput.data;
    const subId = await this.serializeMutation(async () => {
      await this.options.configService.ready;
      const current = this.readConfig();
      const existing = current.subscriptions.find((sub) => sub.url === input.url);
      const id = existing?.id ?? randomUUID();
      const nextSub: RelaySubscriptionConfig = {
        id,
        url: input.url,
        enabled: input.enabled ?? true,
        ...(input.label?.trim() || existing?.label ? { label: input.label?.trim() || existing?.label } : {}),
        ...(existing?.etag === undefined ? {} : { etag: existing.etag }),
        ...(existing?.refreshIntervalSec === undefined ? {} : { refreshIntervalSec: existing.refreshIntervalSec }),
        ...(existing?.lastSyncedAt === undefined ? {} : { lastSyncedAt: existing.lastSyncedAt }),
      };
      const nextSubscriptions = existing === undefined
        ? [...current.subscriptions, nextSub]
        : current.subscriptions.map((sub) => (sub.id === id ? nextSub : sub));
      await this.options.configService.replace(
        RELAY_CONFIG_SECTION,
        { nodes: current.nodes, subscriptions: nextSubscriptions },
        ConfigTarget.User,
      );
      return id;
    });
    return this.refreshSubscription(subId);
  }

  async refreshSubscription(id: string): Promise<RelayStatus> {
    return this.serializeMutation(async () => {
      await this.options.configService.ready;
      const current = this.readConfig();
      const subIdx = current.subscriptions.findIndex((entry) => entry.id === id);
      if (subIdx < 0) throw new AdmissionError(404, 'relay_subscription_not_found');
      const sub = current.subscriptions[subIdx]!;
      if (!isValidRelaySubscriptionUrl(sub.url)) {
        const failedSubs = current.subscriptions.map((entry, idx) =>
          idx === subIdx ? { ...entry, lastError: 'Relay subscription URL must use HTTPS' } : entry,
        );
        await this.options.configService.replace(
          RELAY_CONFIG_SECTION,
          { nodes: current.nodes, subscriptions: failedSubs },
          ConfigTarget.User,
        );
        throw new AdmissionError(400, 'invalid_relay_subscription_url');
      }
      const headers = new Headers({ accept: 'application/json' });
      if (sub.etag !== undefined && sub.etag !== '') {
        headers.set('if-none-match', sub.etag);
      }

      let response: Response;
      try {
        response = await this.fetchImpl(sub.url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
      } catch (error) {
        const message = (error instanceof Error ? error.message : 'Subscription fetch failed').slice(0, 512);
        const failedSubs = current.subscriptions.map((entry, idx) =>
          idx === subIdx ? { ...entry, lastError: message } : entry,
        );
        await this.options.configService.replace(
          RELAY_CONFIG_SECTION,
          { nodes: current.nodes, subscriptions: failedSubs },
          ConfigTarget.User,
        );
        throw new AdmissionError(502, 'relay_subscription_unreachable');
      }

      if (response.status === 304) {
        const refreshedSubs = current.subscriptions.map((entry, idx) => {
          if (idx !== subIdx) return entry;
          const { lastError: _cleared, ...rest } = entry;
          return { ...rest, lastSyncedAt: Date.now() };
        });
        await this.options.configService.replace(
          RELAY_CONFIG_SECTION,
          { nodes: current.nodes, subscriptions: refreshedSubs },
          ConfigTarget.User,
        );
        return this.status();
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const failedSubs = current.subscriptions.map((entry, idx) =>
          idx === subIdx ? { ...entry, lastError: `HTTP ${response.status}` } : entry,
        );
        await this.options.configService.replace(
          RELAY_CONFIG_SECTION,
          { nodes: current.nodes, subscriptions: failedSubs },
          ConfigTarget.User,
        );
        throw new AdmissionError(502, 'relay_subscription_http_error');
      }

      let rawBody: unknown;
      try {
        rawBody = await response.json();
      } catch {
        throw new AdmissionError(502, 'relay_subscription_invalid_json');
      }
      const parsed = relayManifestSchema.safeParse(rawBody);
      if (!parsed.success) {
        throw new AdmissionError(502, 'relay_subscription_invalid_manifest');
      }
      const manifest = parsed.data;
      const etag = response.headers.get('etag')?.trim() || undefined;
      const headerTitle = response.headers.get('profile-title')?.trim() || undefined;
      const headerIntervalHours = Number(response.headers.get('profile-update-interval') ?? '');
      const refreshIntervalSec =
        manifest.refreshIntervalSec ??
        (Number.isFinite(headerIntervalHours) && headerIntervalHours >= 1
          ? Math.min(604_800, Math.round(headerIntervalHours * 3600))
          : sub.refreshIntervalSec);

      const previousSubNodes = new Map(
        current.nodes
          .filter((node) => node.subscriptionId === sub.id)
          .map((node) => [node.id, node]),
      );
      const mergedSubNodes: RelayNodeConfig[] = [];
      const rejectedUrls: string[] = [];
      for (const item of manifest.nodes) {
        const normalizedUrl = normalizeRelayBaseUrl(item.url);
        if (normalizedUrl === undefined) {
          rejectedUrls.push(item.url);
          continue;
        }
        const scopedId = `sub:${sub.id}:${item.id}`;
        const prevNode = previousSubNodes.get(scopedId);
        mergedSubNodes.push({
          id: scopedId,
          url: normalizedUrl,
          role: item.role ?? 'auto',
          enabled: prevNode?.enabled ?? sub.enabled,
          subscriptionId: sub.id,
          ...(item.name ?? prevNode?.label ? { label: item.name ?? prevNode?.label } : {}),
          ...(item.token ? { token: item.token } : {}),
        });
      }

      const retainedNodes = current.nodes.filter((node) => node.subscriptionId !== sub.id);
      const nextNodes = [...retainedNodes, ...mergedSubNodes];
      const nextSub: RelaySubscriptionConfig = {
        id: sub.id,
        url: sub.url,
        enabled: sub.enabled,
        lastSyncedAt: Date.now(),
        ...(sub.label ?? manifest.title ?? headerTitle
          ? { label: sub.label ?? manifest.title ?? headerTitle }
          : {}),
        ...(etag === undefined ? {} : { etag }),
        ...(refreshIntervalSec === undefined ? {} : { refreshIntervalSec }),
        ...(rejectedUrls.length > 0
          ? { lastError: `Rejected insecure or invalid relay node URL(s): ${rejectedUrls.slice(0, 3).join(', ')}`.slice(0, 512) }
          : {}),
      };
      const nextSubscriptions = current.subscriptions.map((entry, idx) =>
        idx === subIdx ? nextSub : entry,
      );

      await this.options.configService.replace(
        RELAY_CONFIG_SECTION,
        { nodes: nextNodes, subscriptions: nextSubscriptions },
        ConfigTarget.User,
      );
      await this.probeAndReconcile();
      return this.status();
    });
  }

  async removeSubscription(id: string): Promise<RelayStatus> {
    return this.serializeMutation(async () => {
      await this.options.configService.ready;
      const current = this.readConfig();
      if (!current.subscriptions.some((entry) => entry.id === id)) {
        throw new AdmissionError(404, 'relay_subscription_not_found');
      }
      const nextSubscriptions = current.subscriptions.filter((entry) => entry.id !== id);
      const nextNodes = current.nodes.filter((node) => node.subscriptionId !== id);
      await this.options.configService.replace(
        RELAY_CONFIG_SECTION,
        { nodes: nextNodes, subscriptions: nextSubscriptions },
        ConfigTarget.User,
      );
      await this.reconcileNow();
      return this.status();
    });
  }

  private async refreshDueSubscriptions(): Promise<void> {
    if (this.closed) return;
    const config = this.readConfig();
    const now = Date.now();
    for (const sub of config.subscriptions) {
      if (!sub.enabled) continue;
      const intervalMs = (sub.refreshIntervalSec ?? DEFAULT_SUBSCRIPTION_REFRESH_SEC) * 1000;
      if (sub.lastSyncedAt === undefined || now - sub.lastSyncedAt >= intervalMs) {
        await this.refreshSubscription(sub.id).catch(() => undefined);
      }
    }
  }
}
