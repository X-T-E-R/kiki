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

/**
 * Terminal channel signals lifted out of the frame stream. `output`/`exit`
 * carry the wire `terminal_output` / `terminal_exit` frames; `attached` fires
 * on every successful `terminal_attach` ack — including the automatic
 * re-attaches after a reconnect, which is how a listener learns the stream
 * resumed. `unavailable` reports an automatic attach failure.
 */
export type TerminalSignal =
  | {
      readonly kind: 'attached';
      readonly sessionId: string;
      readonly terminalId: string;
      readonly replayed: number;
      readonly earliestSeq: number | null;
      readonly truncated: boolean;
    }
  | { readonly kind: 'output'; readonly sessionId: string; readonly terminalId: string; readonly seq: number; readonly data: string }
  | { readonly kind: 'exit'; readonly sessionId: string; readonly terminalId: string; readonly exitCode: number | null }
  | { readonly kind: 'unavailable'; readonly sessionId: string; readonly terminalId: string };

export interface TerminalAttachResult {
  readonly replayed: number;
  readonly earliestSeq: number | null;
  readonly truncated: boolean;
}

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
/** Deadline for a terminal control ack (attach is the only awaited verb). */
const TERMINAL_CONTROL_TIMEOUT_MS = 8_000;

interface TrackedTerminal {
  readonly sessionId: string;
  readonly terminalId: string;
  lastSeq: number;
}

interface PendingTerminalControl {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly resolve: (result: TerminalAttachResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function terminalKey(sessionId: string, terminalId: string): string {
  return `${sessionId} ${terminalId}`;
}

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
  /**
   * Terminals this connection wants attached, keyed by session+terminal id.
   * Survives reconnects: every fresh hello re-attaches them with
   * `since_seq = lastSeq` so the server's bounded replay buffer can cover the
   * blackout when it still retains every missed frame.
   */
  private readonly trackedTerminals = new Map<string, TrackedTerminal>();
  private readonly terminalListeners = new Set<(signal: TerminalSignal) => void>();
  private readonly pendingTerminalControls = new Map<string, PendingTerminalControl>();
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

  // ── Terminal channel ───────────────────────────────────────────────────
  // Terminal I/O rides this same socket as `terminal_*` control frames with
  // `terminal_output` / `terminal_exit` frames coming back. Input and resize
  // are fire-and-forget (keystroke frequency makes per-frame acks pointless);
  // attach is the only awaited verb — its ack carries the replay count.

  /** Subscribe to terminal signals (`attached` / `output` / `exit` / `unavailable`). */
  onTerminalSignal(listener: (signal: TerminalSignal) => void): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  /**
   * Attach to a terminal's IO stream. The terminal stays tracked across
   * reconnects (re-attached automatically); `terminalDetach` untracks it.
   * Resolves with the attach ack; rejects when the socket is down or the
   * server never answers (the timeout is how the UI learns that).
   */
  terminalAttach(sessionId: string, terminalId: string): Promise<TerminalAttachResult> {
    const key = terminalKey(sessionId, terminalId);
    if (!this.trackedTerminals.has(key)) {
      this.trackedTerminals.set(key, { sessionId, terminalId, lastSeq: 0 });
    }
    if (!this.isReady()) {
      return Promise.reject(new Error('socket is not connected'));
    }
    return this.sendTerminalAttach(this.trackedTerminals.get(key)!);
  }

  /** Detach and stop tracking (no re-attach on the next reconnect). */
  terminalDetach(sessionId: string, terminalId: string): void {
    this.trackedTerminals.delete(terminalKey(sessionId, terminalId));
    if (this.isReady()) {
      this.send({
        type: 'terminal_detach',
        id: this.nextId(),
        payload: { session_id: sessionId, terminal_id: terminalId },
      });
    }
  }

  terminalInput(sessionId: string, terminalId: string, data: string): void {
    if (this.isReady()) {
      this.send({
        type: 'terminal_input',
        id: this.nextId(),
        payload: { session_id: sessionId, terminal_id: terminalId, data },
      });
    }
  }

  terminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void {
    if (this.isReady()) {
      this.send({
        type: 'terminal_resize',
        id: this.nextId(),
        payload: { session_id: sessionId, terminal_id: terminalId, cols, rows },
      });
    }
  }

  private sendTerminalAttach(tracked: TrackedTerminal): Promise<TerminalAttachResult> {
    const id = this.nextId();
    return new Promise<TerminalAttachResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTerminalControls.delete(id);
        reject(new Error('terminal attach timed out — the server does not answer terminal frames'));
      }, TERMINAL_CONTROL_TIMEOUT_MS);
      this.pendingTerminalControls.set(id, {
        sessionId: tracked.sessionId,
        terminalId: tracked.terminalId,
        resolve,
        reject,
        timer,
      });
      this.send({
        type: 'terminal_attach',
        id,
        payload: {
          session_id: tracked.sessionId,
          terminal_id: tracked.terminalId,
          // since_seq=0 means "full replay"; omit it rather than send 0.
          since_seq: tracked.lastSeq > 0 ? tracked.lastSeq : undefined,
        },
      });
    });
  }

  private emitTerminalSignal(signal: TerminalSignal): void {
    for (const listener of this.terminalListeners) {
      try {
        listener(signal);
      } catch {
        // a broken listener must not break the frame pump
      }
    }
  }

  private failPendingTerminalControls(reason: string): void {
    for (const pending of this.pendingTerminalControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingTerminalControls.clear();
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
      // Attach waiters must not hang until their timeout when the socket dies.
      this.failPendingTerminalControls('socket closed before the attach ack arrived');
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
        // Attach tracked terminals on every hello, including the first one.
        // A create can finish while the initial socket is still handshaking;
        // in that case terminalAttach() records the desired stream but cannot
        // send yet. Replay from
        // `lastSeq` closes whatever the blackout missed. Attach acks flow to
        // terminal listeners as `attached` signals.
        for (const tracked of this.trackedTerminals.values()) {
          void this.sendTerminalAttach(tracked).catch(() => {
            // A failed attach stays tracked so the next reconnect retries, but
            // listeners must not keep presenting this stream as live. A socket
            // close is different: SessionView marks streams attaching so input
            // can buffer through the reconnect.
            if (!this.isReady()) return;
            this.emitTerminalSignal({
              kind: 'unavailable',
              sessionId: tracked.sessionId,
              terminalId: tracked.terminalId,
            });
          });
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
      case 'terminal_output': {
        // Intercept before the session-event default: terminal seqs are
        // per-terminal and would corrupt session cursor tracking.
        const frame = message as WireMessage & {
          session_id?: unknown;
          terminal_id?: unknown;
          seq?: unknown;
        };
        if (
          typeof frame.session_id === 'string' &&
          typeof frame.terminal_id === 'string' &&
          typeof frame.seq === 'number'
        ) {
          const data = (message.payload as { data?: unknown } | undefined)?.data;
          const key = terminalKey(frame.session_id, frame.terminal_id);
          const tracked = this.trackedTerminals.get(key);
          if (tracked !== undefined && frame.seq > tracked.lastSeq) {
            tracked.lastSeq = frame.seq;
          }
          this.emitTerminalSignal({
            kind: 'output',
            sessionId: frame.session_id,
            terminalId: frame.terminal_id,
            seq: frame.seq,
            data: typeof data === 'string' ? data : '',
          });
        }
        return;
      }
      case 'terminal_exit': {
        const frame = message as WireMessage & {
          session_id?: unknown;
          terminal_id?: unknown;
        };
        if (typeof frame.session_id === 'string' && typeof frame.terminal_id === 'string') {
          // A dead terminal is never re-attached on reconnect.
          this.trackedTerminals.delete(terminalKey(frame.session_id, frame.terminal_id));
          const exitCode = (message.payload as { exit_code?: unknown } | undefined)?.exit_code;
          this.emitTerminalSignal({
            kind: 'exit',
            sessionId: frame.session_id,
            terminalId: frame.terminal_id,
            exitCode: typeof exitCode === 'number' ? exitCode : null,
          });
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
    // Terminal control acks correlate by frame id; everything else falls
    // through to the legacy subscribe-ack handling.
    if (message.id !== undefined) {
      const pending = this.pendingTerminalControls.get(message.id);
      if (pending !== undefined) {
        this.pendingTerminalControls.delete(message.id);
        clearTimeout(pending.timer);
        if (message.code === 0) {
          const payload = message.payload as
            | { replayed?: unknown; earliest_seq?: unknown; truncated?: unknown }
            | undefined;
          const result: TerminalAttachResult = {
            replayed: typeof payload?.replayed === 'number' ? payload.replayed : 0,
            earliestSeq: typeof payload?.earliest_seq === 'number' ? payload.earliest_seq : null,
            truncated: payload?.truncated === true,
          };
          pending.resolve(result);
          this.emitTerminalSignal({
            kind: 'attached',
            sessionId: pending.sessionId,
            terminalId: pending.terminalId,
            ...result,
          });
        } else {
          pending.reject(
            new Error(
              `terminal attach rejected: ${message.msg ?? 'unknown error'} (code ${String(message.code)})`,
            ),
          );
        }
        return;
      }
    }
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
