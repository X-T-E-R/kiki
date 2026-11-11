import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { isError2, ThreadMailboxBacklogError } from '@kiki/agent-core-v2';
import { decodeJsonFrame, encodeJsonFrame, type KlientFrame } from '@kiki/klient/host';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import {
  bridgeListSchema,
  bridgeReadSchema,
  bridgeSendSchema,
  bridgeWaitSchema,
  type RemoteConnection,
} from '@kiki/protocol';
import { okEnvelope, errEnvelope } from '../../envelope';
import { AdmissionError } from '../connections/admission';
import { BROKER_WS_MESSAGE_BYTES, type RemoteConnectionManager } from '../connections/manager';
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
  wake(): void;
  pauseForNetworkLoss(): void;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

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
  ) {}

  start(): void {
    if (this.closed || this.shutdownSignal.aborted) return;
    this.subscriptions.push(
      this.connections.onDidChange(() => this.reconcile()),
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
    this.reconcile();
    for (const tunnel of this.tunnels.values()) tunnel.wake();
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

  private reconcile(): void {
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
      if (this.networkState === 'available') tunnel.wake();
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
    let authBlocked = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let connectController: AbortController | undefined;
    let socket: WebSocket | undefined;
    let registeredKey: string | undefined;
    const inflightRequests = new Map<string, AbortController>();

    const clearTimers = (): void => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    const abortInflight = (): void => {
      for (const controller of inflightRequests.values()) controller.abort();
      inflightRequests.clear();
    };

    const teardownSocket = (): void => {
      clearTimers();
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

    const scheduleReconnect = (): void => {
      if (stopped || paused || authBlocked || this.closed || this.networkState === 'lost') return;
      if (retryTimer !== undefined || socket !== undefined) return;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      attempt += 1;
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
      if (operation !== 'list' && operation !== 'read' && operation !== 'send' && operation !== 'wait') {
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

    const connectOnce = async (): Promise<void> => {
      if (stopped || paused || authBlocked || this.closed || this.networkState === 'lost' || socket !== undefined || connectController !== undefined) {
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
      connectController = controller;
      try {
        const credential = await this.connections.secrets.read<StoredPeerCredential>({
          connectionId: record.credentialRef,
          purpose: 'gui',
        });
        if (credential.grantId === undefined || credential.ownerToken !== credential.grant) {
          connectController = undefined;
          authBlocked = true;
          return;
        }
        const reverse = await this.bridge.ensureReversePeerBridge({
          connectionId: record.id,
          target: record.target,
          label: machineLabel(),
        });
        if (reverse === undefined) {
          connectController = undefined;
          return;
        }
        const nextKey = `${reverse.grant.id}:${reverse.grant.revision}`;
        if (registeredKey !== nextKey) {
          const signal = AbortSignal.any([controller.signal, this.shutdownSignal, AbortSignal.timeout(15_000)]);
          const response = await fetch(`${record.endpoint}/api/thread-bridges/peer/outbound`, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              authorization: `Bearer ${credential.ownerToken}`,
              'x-kiki-connection-grant': credential.grant,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ grant: reverse.grant, credential: reverse.credential }),
          });
          if (!response.ok) {
            const envelope = await readBoundedJsonBody(response, 8192).catch(() => undefined) as { msg?: unknown } | undefined;
            if (response.status === 401 || (response.status === 403 && envelope?.msg !== 'inbound_disabled')) {
              authBlocked = true;
              this.connections.failed(record.id, new AdmissionError(response.status, 'connection_not_approved'));
              connectController = undefined;
              return;
            }
            throw new AdmissionError(response.status, typeof envelope?.msg === 'string' ? envelope.msg : 'peer_bridge_register_failed');
          }
          await response.body?.cancel().catch(() => {});
          registeredKey = nextKey;
        }

        if (stopped || paused || this.closed || controller.signal.aborted) {
          connectController = undefined;
          return;
        }

        const wsUrl = new URL('/api/klient/events', record.endpoint);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(wsUrl, [`${WS_BEARER_PROTOCOL_PREFIX}${credential.ownerToken}`], {
          headers: { 'x-kiki-connection-grant': credential.grant },
          maxPayload: BROKER_WS_MESSAGE_BYTES,
          perMessageDeflate: false,
          followRedirects: false,
          handshakeTimeout: 15_000,
        });
        socket = ws;
        connectController = undefined;

        let lastInboundAt = Date.now();
        ws.once('open', () => {
          if (socket !== ws || stopped || paused) return;
          lastInboundAt = Date.now();
          sendFrame(ws, {
            type: 'bridge_attach',
            id: randomUUID(),
            data: { operations: ['list', 'read', 'send', 'wait'] },
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
            attempt = 0;
            return;
          }
          if (frame.type === 'bridge_error') {
            teardownSocket();
            if (frame.code === 40301) authBlocked = true;
            else scheduleReconnect();
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
          if (res.statusCode === 401) {
            authBlocked = true;
            this.connections.failed(record.id, new AdmissionError(401, 'connection_not_approved'));
            return;
          }
          scheduleReconnect();
        });

        ws.on('close', (code) => {
          if (socket !== ws) return;
          teardownSocket();
          if (code === 4001 || code === 1008) {
            authBlocked = true;
            this.connections.failed(record.id, new AdmissionError(401, 'connection_not_approved'));
            return;
          }
          registeredKey = undefined;
          scheduleReconnect();
        });

        ws.on('error', () => {
          if (socket !== ws) return;
          teardownSocket();
          scheduleReconnect();
        });
      } catch {
        connectController = undefined;
        scheduleReconnect();
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
      wake: () => {
        if (stopped || this.closed || this.networkState === 'lost') return;
        paused = false;
        let record: RemoteConnection | undefined;
        try { record = this.connections.get(connectionId); } catch { record = undefined; }
        if (record !== undefined && record.state !== 'authentication_required') authBlocked = false;
        attempt = 0;
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        if (socket === undefined && connectController === undefined) {
          void connectOnce();
        }
      },
    };
  }
}
