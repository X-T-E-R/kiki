import { createHash, randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { isError2, ThreadMailboxBacklogError } from '@kiki/agent-core-v2';
import { decodeJsonFrame, encodeJsonFrame, type KlientFrame } from '@kiki/klient/host';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import {
  bridgeCreateSchema,
  bridgeListSchema,
  bridgeReadSchema,
  bridgeSendSchema,
  bridgeWaitSchema,
  type RemoteConnection,
} from '@kiki/protocol';
import { okEnvelope, errEnvelope } from '../../envelope';
import { AdmissionError } from '../connections/admission';
import type { ConnectionLease, RemoteConnectionManager } from '../connections/manager';
import { peerFetch, pinnedAgent, requirePinnedTls } from '../connections/peerTls';
import { machineLabel } from '../connections/pairing';
import { ContentChangedError } from '../../transport/klient/boundedContent';
import { WS_BEARER_PROTOCOL_PREFIX } from '../../transport/ws/bearerProtocol';
import type { SpaceThreadBridge } from './bridge';

interface StoredPeerCredential {
  readonly ownerToken: string;
  readonly grant: string;
  readonly grantId?: string;
  readonly revision?: number;
}

interface ActivePeerTunnel {
  readonly connectionId: string;
  stop(state?: 'removed'): void;
  wake(reason?: 'normal' | 'credential' | 'network'): void;
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
    record.transport === undefined &&
    record.purposes.includes('gui') &&
    record.purposes.includes('bridge') &&
    record.state !== 'disabled' &&
    record.state !== 'identity_changed'
  );
}

export class OutboundPeerBridgeClient {
  private readonly tunnels = new Map<string, ActivePeerTunnel>();
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private networkState: 'available' | 'lost' = 'available';
  private closed = false;

  constructor(
    private readonly connections: RemoteConnectionManager,
    private readonly bridge: SpaceThreadBridge,
    private readonly shutdownSignal: AbortSignal,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (this.closed || this.shutdownSignal.aborted) return;
    this.subscriptions.push(
      this.connections.onDidChange(() => this.reconcile('credential')),
      this.bridge.onDidChange(() => this.reconcile()),
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

  private reconcile(wakeReason: 'normal' | 'credential' | 'network' = 'normal'): void {
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
      if (ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(encodeJsonFrame(frame));
        return true;
      } catch {
        return false;
      }
    };

    const handleInboundBridgeRequest = async (ws: WebSocket, frame: KlientFrame): Promise<void> => {
      const id = typeof frame.id === 'string' ? frame.id : '';
      if (id === '') return;
      const data = frame.data !== null && typeof frame.data === 'object' ? frame.data as Record<string, unknown> : {};
      const operation = data['operation'];
      const authorization = typeof data['authorization'] === 'string' ? data['authorization'] : '';
      const body = data['body'];
      if (operation !== 'list' && operation !== 'read' && operation !== 'send' && operation !== 'wait' && operation !== 'create') {
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
      try {
        if (token === '') throw new AdmissionError(401, 'invalid_bridge_credential');
        const grant = this.bridge.authorizeCredential(token);
        detach = this.bridge.attach(grant.id, controller);
        const signal = AbortSignal.any([controller.signal, this.shutdownSignal]);
        const result = operation === 'list' ? await this.bridge.inboundList(grant, bridgeListSchema.parse(body))
          : operation === 'read' ? await this.bridge.inboundRead(grant, bridgeReadSchema.parse(body), signal)
          : operation === 'send' ? await this.bridge.inboundSend(grant, bridgeSendSchema.parse(body))
          : operation === 'create' ? await this.bridge.inboundCreate(grant, bridgeCreateSchema.parse(body))
          : await this.bridge.inboundWait(grant, bridgeWaitSchema.parse(body), signal);
        signal.throwIfAborted();
        sendFrame(ws, {
          type: 'bridge_response',
          id,
          data: { status: 200, envelope: okEnvelope({ identity: this.bridge.admission.identity, result }, id) },
        });
      } catch (error) {
        if (controller.signal.aborted || this.shutdownSignal.aborted || stopped) return;
        if (error instanceof ContentChangedError) {
          sendFrame(ws, { type: 'bridge_response', id, data: { status: 409, envelope: errEnvelope(40922, error.message, id) } });
          return;
        }
        if (error instanceof ThreadMailboxBacklogError) {
          sendFrame(ws, { type: 'bridge_response', id, data: { status: 429, envelope: errEnvelope(42901, 'bridge_queue_or_rate_limit', id) } });
          return;
        }
        if (isError2(error)) {
          sendFrame(ws, { type: 'bridge_response', id, data: { status: 403, envelope: errEnvelope(40301, error.message, id) } });
          return;
        }
        if (error instanceof Error && error.name === 'ZodError') {
          sendFrame(ws, { type: 'bridge_response', id, data: { status: 400, envelope: errEnvelope(40001, 'invalid_bridge_request', id) } });
          return;
        }
        if (error instanceof AdmissionError) {
          sendFrame(ws, { type: 'bridge_response', id, data: { status: error.status, envelope: errEnvelope(40101, error.reason, id) } });
          return;
        }
        sendFrame(ws, {
          type: 'bridge_response',
          id,
          data: { status: 500, envelope: errEnvelope(50001, error instanceof Error ? error.message : 'bridge_internal_error', id) },
        });
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
          agent: record.pinnedFingerprint === undefined ? undefined : pinnedAgent(record.pinnedFingerprint, undefined, lease.signal),
          headers: { 'x-kiki-connection-grant': credential.grant },
          maxPayload: 1024 * 1024,
          perMessageDeflate: false,
          followRedirects: false,
          handshakeTimeout: 15_000,
        });
        socket = ws;
        const activeLease = lease;
        socketLease = activeLease;
        lease = undefined;
        activeLease.signal.addEventListener('abort', () => { if (socketLease === activeLease) teardownSocket(); }, { once: true });
        connectController = undefined;

        let lastInboundAt = Date.now();
        let attached = false;
        ws.once('open', () => {
          if (socket !== ws || stopped || paused) return;
          lastInboundAt = Date.now();
          sendFrame(ws, {
            type: 'bridge_attach',
            id: randomUUID(),
            data: {},
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
            stableAttachmentTimer = setTimeout(() => {
              stableAttachmentTimer = undefined;
              if (socket === ws && ws.readyState === WebSocket.OPEN && attached) attempt = 0;
            }, STABLE_ATTACHMENT_MS);
            stableAttachmentTimer.unref();
            return;
          }
          if (frame.type === 'bridge_error') {
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
        if (authCooldownUntil > Date.now() || retryTimer !== undefined) return;
        if (socket === undefined && connectController === undefined) void connectOnce();
      },
    };
  }
}
