/**
 * WebSocket client for `/api/v1/ws` (WS protocol v2).
 *
 * Handshake: server_hello → client_hello {client_id} → subscribe frames with
 * per-session {seq, epoch} cursors. Browser sockets cannot set headers, so the
 * bearer token rides the `kimi-code.bearer.<token>` subprotocol (the server's
 * documented browser-auth path — see kap-server transport/ws/bearerProtocol).
 *
 * Reconnect: exponential backoff with jitter; on every (re)open the socket
 * re-hello's and resubscribes the desired session set with the latest cursors.
 * Sessions the server flags `resync_required` are reported so the caller can
 * refetch a snapshot and adopt the fresh cursor.
 */

import type { SessionCursor } from '@moonshot-ai/protocol';

import type { ResyncRequiredPayload, SessionEventFrame } from './types';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsEvents {
  onStatus(status: WsStatus, detail?: string): void;
  onFrame(frame: SessionEventFrame): void;
  onResyncRequired(payload: ResyncRequiredPayload): void;
  /** subscribe ack: server-side current cursor per accepted session.
   * `reconnected` is true when the subscribe rode the hello of a re-established
   * socket (as opposed to the first connect or an explicit resubscribe). */
  onSubscribeAck(
    accepted: readonly string[],
    resyncRequired: readonly string[],
    cursors: Record<string, SessionCursor> | undefined,
    reconnected: boolean,
  ): void;
}

interface WireMessage {
  type?: string;
  id?: string;
  code?: number;
  msg?: string;
  timestamp?: string;
  payload?: unknown;
}

const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000] as const;
const STALE_INBOUND_MS = 45_000;

let clientCounter = 0;

export class KikiSocket {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly events: WsEvents;
  private readonly clientId = `kiki-gui-${Date.now().toString(36)}-${(clientCounter += 1)}`;

  /** Desired subscriptions and the cursor to resume each from. */
  private readonly desired = new Map<string, SessionCursor>();
  private manuallyClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private helloReceived = false;
  private idCounter = 0;
  private lastInboundAt = 0;
  private malformedFrameCount = 0;
  private helloCount = 0;
  /** Set when the in-flight subscribe rode a reconnect hello; consumed by the ack. */
  private subscribeFromReconnect = false;
  /** Heartbeat cadence advertised by server_hello (undefined = none — kap-server
   * does not currently advertise one; see docs/server-heartbeat.md). */
  private serverHeartbeatMs: number | undefined;

  constructor(options: { baseUrl: string; token?: string; events: WsEvents }) {
    const root =
      options.baseUrl === '' ? window.location.origin : options.baseUrl.replace(/\/+$/, '');
    this.url = `${root.replace(/^http/, 'ws')}/api/v1/ws`;
    this.token = options.token !== undefined && options.token !== '' ? options.token : undefined;
    this.events = options.events;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  close(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        // already closing
      }
    }
    this.events.onStatus('closed');
  }

  /** Upsert a subscription. Takes effect immediately when open, else on reconnect. */
  subscribe(sessionId: string, cursor: SessionCursor): void {
    this.desired.set(sessionId, cursor);
    if (this.isReady()) {
      this.sendSubscribe([sessionId]);
    }
  }

  unsubscribe(sessionId: string): void {
    this.desired.delete(sessionId);
    if (this.isReady()) {
      this.send({
        type: 'unsubscribe',
        id: this.nextId(),
        payload: { session_ids: [sessionId] },
      });
    }
  }

  /** Update the resume cursor for a session (called for every durable event). */
  updateCursor(sessionId: string, cursor: SessionCursor): void {
    if (this.desired.has(sessionId)) {
      this.desired.set(sessionId, cursor);
    }
  }

  /** Foreground/wake nudge. An OPEN readyState is not trusted after a long
   * inbound silence ONLY when the server advertised an application-level
   * heartbeat in its hello: with a heartbeat, silence past the window means
   * the transport is half-open. kap-server's wsConnectionV1 currently
   * advertises none (see docs/server-heartbeat.md), so the stale branch stays
   * disarmed and reconnects remain close-driven; the 'ping' reply handler is
   * forward-compat for the day the server grows one. */
  nudge(): void {
    if (this.manuallyClosed) return;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.helloReceived) {
      if (this.serverHeartbeatMs === undefined) return;
      const staleAfter = Math.max(STALE_INBOUND_MS, this.serverHeartbeatMs * 3);
      if (this.lastInboundAt > 0 && Date.now() - this.lastInboundAt <= staleAfter) return;
      try {
        this.ws.close(4000, 'stale inbound stream');
      } catch {
        this.ws = null;
        this.openSocket();
      }
      return;
    }
    if (this.ws !== null && this.ws.readyState === WebSocket.CONNECTING) return;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    if (this.ws === null) this.openSocket();
  }

  abort(sessionId: string, promptId: string): void {
    if (this.isReady()) {
      this.send({ type: 'abort', id: this.nextId(), payload: { session_id: sessionId, prompt_id: promptId } });
    }
  }

  get ready(): boolean {
    return this.isReady();
  }

  /** Frames dropped as unparseable or missing the session_event shape. */
  get malformedCount(): number {
    return this.malformedFrameCount;
  }

  /** Last time any inbound message arrived (0 = none yet on this socket). */
  get lastInbound(): number {
    return this.lastInboundAt;
  }

  private isReady(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.helloReceived;
  }

  private nextId(): string {
    this.idCounter += 1;
    return `${this.clientId}-${this.idCounter}`;
  }

  private openSocket(): void {
    this.events.onStatus('connecting');
    this.helloReceived = false;
    this.lastInboundAt = 0;
    this.serverHeartbeatMs = undefined;
    const protocols = this.token !== undefined ? [`kimi-code.bearer.${this.token}`] : undefined;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, protocols);
    } catch (error) {
      this.events.onStatus('closed', error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      // Wait for server_hello before client_hello.
    };
    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(typeof event.data === 'string' ? event.data : '');
    };
    ws.onclose = (event) => {
      if (this.ws === ws) this.ws = null;
      this.helloReceived = false;
      this.events.onStatus('closed', `code ${event.code}`);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and drives the reconnect.
    };
  }

  private handleMessage(raw: string): void {
    if (raw === '') return;
    this.lastInboundAt = Date.now();
    let message: WireMessage;
    try {
      message = JSON.parse(raw) as WireMessage;
    } catch {
      this.malformedFrameCount += 1;
      return;
    }
    // Intentional partial router: the default case below funnels session_event
    // frames and counts anything else as malformed — listing all ~50 union
    // members would be dead no-op cases.
    // eslint-disable-next-line typescript/switch-exhaustiveness-check
    switch (message.type) {
      case 'server_hello': {
        this.helloReceived = true;
        this.reconnectAttempts = 0;
        this.helloCount += 1;
        // Accept the server's schema name (heartbeat_ms, ws-control.ts) and
        // the interval variant this client documented first.
        const helloPayload = message.payload as
          | { heartbeat_ms?: unknown; heartbeat_interval_ms?: unknown }
          | undefined;
        const heartbeat = helloPayload?.heartbeat_ms ?? helloPayload?.heartbeat_interval_ms;
        this.serverHeartbeatMs =
          typeof heartbeat === 'number' && Number.isFinite(heartbeat) && heartbeat > 0
            ? heartbeat
            : undefined;
        this.send({
          type: 'client_hello',
          id: this.nextId(),
          payload: { client_id: this.clientId },
        });
        this.events.onStatus('open');
        if (this.desired.size > 0) {
          this.subscribeFromReconnect = this.helloCount > 1;
          this.sendSubscribe([...this.desired.keys()]);
        }
        return;
      }
      case 'ping': {
        const nonce = (message.payload as { nonce?: string } | undefined)?.nonce;
        if (typeof nonce === 'string') {
          this.send({ type: 'pong', payload: { nonce } });
        }
        return;
      }
      case 'ack': {
        this.handleAck(message);
        return;
      }
      case 'resync_required': {
        this.events.onResyncRequired(message.payload as ResyncRequiredPayload);
        return;
      }
      case 'error': {
        const payload = message.payload as { msg?: string; fatal?: boolean } | undefined;
        if (payload?.fatal === true) {
          this.events.onStatus('closed', payload.msg ?? 'fatal ws error');
          this.close();
        }
        return;
      }
      default: {
        // session_event frames carry seq+payload; anything else is ignored.
        if (typeof message.type === 'string' && message.payload !== undefined) {
          const frame = message as unknown as SessionEventFrame;
          if (typeof frame.seq === 'number') {
            this.events.onFrame(frame);
            return;
          }
        }
        this.malformedFrameCount += 1;
      }
    }
  }

  private handleAck(message: WireMessage): void {
    const payload = message.payload as
      | {
          accepted?: string[];
          accepted_subscriptions?: string[];
          resync_required?: string[];
          cursors?: Record<string, SessionCursor>;
        }
      | undefined;
    if (payload === undefined) return;
    const accepted = payload.accepted ?? payload.accepted_subscriptions ?? [];
    const resyncRequired = payload.resync_required ?? [];
    if (accepted.length > 0 || resyncRequired.length > 0) {
      const reconnected = this.subscribeFromReconnect;
      this.subscribeFromReconnect = false;
      this.events.onSubscribeAck(accepted, resyncRequired, payload.cursors, reconnected);
    }
  }

  private sendSubscribe(sessionIds: readonly string[]): void {
    const cursors: Record<string, SessionCursor> = {};
    for (const sessionId of sessionIds) {
      const cursor = this.desired.get(sessionId);
      if (cursor !== undefined) cursors[sessionId] = cursor;
    }
    this.send({
      type: 'subscribe',
      id: this.nextId(),
      // Omit agent_filter to receive the session's complete agent stream. The
      // transcript reducer scopes main vs. child presentation client-side while
      // preserving the existing session cursor/resync contract.
      payload: { session_ids: sessionIds, cursors },
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed) return;
    this.clearReconnectTimer();
    const step = BACKOFF_STEPS_MS[Math.min(this.reconnectAttempts, BACKOFF_STEPS_MS.length - 1)]!;
    const jitter = Math.floor(Math.random() * step * 0.25);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manuallyClosed) this.openSocket();
    }, step + jitter);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
