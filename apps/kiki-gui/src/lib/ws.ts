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
  /** subscribe ack: server-side current cursor per accepted session. */
  onSubscribeAck(
    accepted: readonly string[],
    resyncRequired: readonly string[],
    cursors: Record<string, SessionCursor> | undefined,
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

  /**
   * Foreground/wake nudge (liveagent pattern): if the stream is healthy, do
   * nothing — a spurious `online`/`focus` must never force-drop a live
   * socket. If the socket is down and a backoff timer is pending, reconnect
   * immediately instead of waiting it out.
   */
  nudge(): void {
    if (this.manuallyClosed) return;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.helloReceived) {
      return; // healthy — nothing to do
    }
    if (this.ws !== null && this.ws.readyState === WebSocket.CONNECTING) {
      return; // a connect attempt is already in flight
    }
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    if (this.ws === null) {
      this.openSocket();
    }
  }

  abort(sessionId: string, promptId: string): void {
    if (this.isReady()) {
      this.send({ type: 'abort', id: this.nextId(), payload: { session_id: sessionId, prompt_id: promptId } });
    }
  }

  get ready(): boolean {
    return this.isReady();
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
    let message: WireMessage;
    try {
      message = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'server_hello': {
        this.helloReceived = true;
        this.reconnectAttempts = 0;
        this.send({
          type: 'client_hello',
          id: this.nextId(),
          payload: { client_id: this.clientId },
        });
        this.events.onStatus('open');
        if (this.desired.size > 0) {
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
          }
        }
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
      this.events.onSubscribeAck(accepted, resyncRequired, payload.cursors);
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
