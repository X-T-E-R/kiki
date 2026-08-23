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
 * refetch a snapshot and adopt the fresh cursor. A server-sent fatal frame
 * switches to a bounded auto-reconnect budget; once spent, a foreground
 * `nudge()` starts another cycle.
 */

import type { SessionCursor } from '@moonshot-ai/protocol';
import {
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  type TranscriptEvent,
  type TranscriptGradeSpec,
} from '@moonshot-ai/transcript';

import type { ResyncRequiredPayload, SessionEventFrame } from './types';

export type TimelineMode = 'transcript' | 'legacy';

export const DEFAULT_TRANSCRIPT_GRADES: TranscriptGradeSpec = {
  '*': 'turn',
  main: 'delta',
};

export function transcriptGradesForFocus(focusedAgentId: string | undefined): TranscriptGradeSpec {
  if (focusedAgentId === undefined || focusedAgentId === 'main') return DEFAULT_TRANSCRIPT_GRADES;
  return { '*': 'turn', main: 'delta', [focusedAgentId]: 'delta' };
}

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
  onStatus(status: WsStatus, detail?: string, generation?: number): void;
  onFrame(frame: SessionEventFrame, generation?: number): void;
  onTranscript?(event: TranscriptEvent, generation?: number): void;
  onResyncRequired(payload: ResyncRequiredPayload, generation?: number): void;
  /** subscribe ack: server-side current cursor per accepted session.
   * `reconnected` is true when the subscribe rode the hello of a re-established
   * socket (as opposed to the first connect or an explicit resubscribe). */
  onSubscribeAck(
    accepted: readonly string[],
    resyncRequired: readonly string[],
    cursors: Record<string, SessionCursor> | undefined,
    reconnected: boolean,
    generation?: number,
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
/**
 * Auto-reconnect attempts after a server-sent fatal frame. Normal drops retry
 * on the backoff ladder indefinitely; a fatal (protocol-level) verdict gets a
 * bounded budget, and once it is spent the socket stays parked until `nudge()`.
 */
const FATAL_RECONNECT_ATTEMPTS = 4;
/** Socket creation through server_hello shares one establishment deadline. */
const ESTABLISHMENT_TIMEOUT_MS = 12_000;
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

interface DesiredSubscription {
  cursor: SessionCursor;
  grades: TranscriptGradeSpec;
}

export class KikiSocket {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly events: WsEvents;
  private mode: TimelineMode;
  private readonly resolveTimelineMode?: () => Promise<TimelineMode>;
  private readonly onTimelineModeChange?: (mode: TimelineMode, generation: number) => void;
  private opening = false;
  private generation = 0;
  private readonly clientId = `kiki-gui-${Date.now().toString(36)}-${(clientCounter += 1)}`;

  /** Desired subscriptions and the cursor to resume each from. */
  private readonly desired = new Map<string, DesiredSubscription>();
  private manuallyClosed = false;
  private reconnectAttempts = 0;
  /**
   * Remaining fatal-mode auto-reconnect attempts. `null` = normal mode
   * (unlimited backoff retries); a positive number = a fatal frame was
   * received and reconnects stop once the budget reaches zero.
   */
  private fatalRetriesLeft: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private establishmentTimer: ReturnType<typeof setTimeout> | null = null;
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

  constructor(options: {
    baseUrl: string;
    token?: string;
    events: WsEvents;
    timelineMode?: TimelineMode;
    resolveTimelineMode?: () => Promise<TimelineMode>;
    onTimelineModeChange?: (mode: TimelineMode, generation: number) => void;
  }) {
    const root =
      options.baseUrl === '' ? window.location.origin : options.baseUrl.replace(/\/+$/, '');
    this.url = `${root.replace(/^http/, 'ws')}/api/v1/ws`;
    this.token = options.token !== undefined && options.token !== '' ? options.token : undefined;
    this.events = options.events;
    this.mode = options.timelineMode ?? 'legacy';
    this.resolveTimelineMode = options.resolveTimelineMode;
    this.onTimelineModeChange = options.onTimelineModeChange;
  }

  get timelineMode(): TimelineMode {
    return this.mode;
  }

  get connectionGeneration(): number {
    return this.generation;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.reconnectAttempts = 0;
    this.fatalRetriesLeft = null;
    this.openSocket();
  }

  close(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.detachTransport();
    this.events.onStatus('closed', undefined, this.generation);
  }

  private clearEstablishmentTimer(): void {
    if (this.establishmentTimer === null) return;
    clearTimeout(this.establishmentTimer);
    this.establishmentTimer = null;
  }

  /** Tear the current transport down without touching the reconnect policy. */
  private detachTransport(): void {
    const ws = this.ws;
    this.ws = null;
    this.helloReceived = false;
    this.clearEstablishmentTimer();
    if (ws !== null && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        // The detached transport cannot affect the replacement.
      }
    }
  }

  /** Upsert a subscription. Takes effect immediately when open, else on reconnect. */
  subscribe(sessionId: string, cursor: SessionCursor, grades?: TranscriptGradeSpec): void {
    const existing = this.desired.get(sessionId);
    this.desired.set(sessionId, {
      cursor,
      grades: grades ?? existing?.grades ?? DEFAULT_TRANSCRIPT_GRADES,
    });
    if (this.isReady()) {
      this.sendSubscribe([sessionId]);
    }
  }

  setTranscriptGrades(sessionId: string, grades: TranscriptGradeSpec): void {
    const existing = this.desired.get(sessionId);
    if (existing === undefined) return;
    this.desired.set(sessionId, { cursor: existing.cursor, grades });
    if (this.isReady() && this.timelineMode === 'transcript') {
      this.sendSubscribeV2(sessionId, grades);
    }
  }

  restartGeneration(): void {
    if (this.manuallyClosed) return;
    this.detachTransport();
    this.openSocket();
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
    const existing = this.desired.get(sessionId);
    if (existing !== undefined) {
      this.desired.set(sessionId, { cursor, grades: existing.grades });
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
    const ws = this.ws;
    if (ws !== null && ws.readyState === WebSocket.OPEN && this.helloReceived) {
      if (this.serverHeartbeatMs === undefined) return;
      const staleAfter = Math.max(STALE_INBOUND_MS, this.serverHeartbeatMs * 3);
      if (this.lastInboundAt > 0 && Date.now() - this.lastInboundAt <= staleAfter) return;
      try {
        ws.close(4000, 'stale inbound stream');
      } catch {
        if (this.ws === ws) {
          this.detachTransport();
          this.openSocket();
        }
      }
      return;
    }
    if (ws !== null) return;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    if (this.fatalRetriesLeft !== null) this.fatalRetriesLeft = FATAL_RECONNECT_ATTEMPTS;
    this.openSocket();
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
    if (this.opening) return;
    this.opening = true;
    void this.openSocketGeneration();
  }

  private async openSocketGeneration(): Promise<void> {
    try {
      const resolved = this.resolveTimelineMode === undefined ? this.mode : await this.resolveTimelineMode();
      if (this.manuallyClosed) return;
      if (resolved !== this.mode) {
        const previousGeneration = this.generation;
        this.manuallyClosed = true;
        this.clearReconnectTimer();
        this.detachTransport();
        this.onTimelineModeChange?.(resolved, previousGeneration);
        return;
      }
      this.generation += 1;
      const generation = this.generation;
      this.clearEstablishmentTimer();
      this.events.onStatus('connecting', undefined, generation);
      this.helloReceived = false;
      this.lastInboundAt = 0;
      this.serverHeartbeatMs = undefined;
      const protocols = this.token !== undefined ? [`kimi-code.bearer.${this.token}`] : undefined;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url, protocols);
      } catch (error) {
        this.events.onStatus(
          'closed',
          error instanceof Error ? error.message : String(error),
          generation,
        );
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        // Wait for server_hello before client_hello.
      };
      ws.onmessage = (event: MessageEvent) => {
        if (this.generation !== generation || this.ws !== ws) return;
        this.handleMessage(typeof event.data === 'string' ? event.data : '', generation);
      };
      ws.onclose = (event) => {
        // A transport that was already replaced or detached (fatal frame, mode
        // switch, establishment timeout) has its own reconnect decision, and
        // must not clobber the live socket's hello state.
        if (this.ws !== ws || this.generation !== generation) return;
        this.ws = null;
        this.helloReceived = false;
        this.clearEstablishmentTimer();
        // Attach waiters must not hang until their timeout when the socket dies.
        this.failPendingTerminalControls('socket closed before the attach ack arrived');
        this.events.onStatus('closed', `code ${event.code}`, generation);
        this.scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose follows and drives the reconnect.
      };
      this.establishmentTimer = setTimeout(() => {
        if (this.ws !== ws || this.generation !== generation || this.manuallyClosed) return;
        const detail = 'WebSocket establishment timed out';
        this.detachTransport();
        this.failPendingTerminalControls(detail);
        this.events.onStatus('closed', detail, generation);
        this.scheduleReconnect();
      }, ESTABLISHMENT_TIMEOUT_MS);
    } finally {
      this.opening = false;
    }
  }

  private handleMessage(raw: string, generation: number): void {
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
        this.clearEstablishmentTimer();
        this.helloReceived = true;
        this.reconnectAttempts = 0;
        // A live hello ends fatal-retry mode; later drops use normal backoff.
        this.fatalRetriesLeft = null;
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
        this.events.onStatus('open', undefined, generation);
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
        this.handleAck(message, generation);
        return;
      }
      case 'transcript.reset':
      case 'transcript.ops': {
        if (this.timelineMode !== 'transcript') return;
        this.handleTranscriptFrame(message, generation);
        return;
      }
      case 'resync_required': {
        this.events.onResyncRequired(message.payload as ResyncRequiredPayload, generation);
        return;
      }
      case 'error': {
        const payload = message.payload as { msg?: string; fatal?: boolean } | undefined;
        if (payload?.fatal === true) {
          this.events.onStatus('closed', payload.msg ?? 'fatal ws error', generation);
          // Fatal protocol errors get one bounded retry cycle. Repeated
          // pre-hello errors consume that cycle rather than replenishing it.
          this.fatalRetriesLeft ??= FATAL_RECONNECT_ATTEMPTS;
          this.detachTransport();
          this.scheduleReconnect();
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
            this.events.onFrame(frame, generation);
            return;
          }
        }
        this.malformedFrameCount += 1;
      }
    }
  }

  private handleTranscriptFrame(message: WireMessage, generation: number): void {
    const parsed =
      message.type === 'transcript.reset'
        ? transcriptResetEventSchema.safeParse(message.payload)
        : transcriptOpsEventSchema.safeParse(message.payload);
    if (!parsed.success) return;
    this.events.onTranscript?.(parsed.data, generation);
  }

  private handleAck(message: WireMessage, generation: number): void {
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
      this.events.onSubscribeAck(accepted, resyncRequired, payload.cursors, reconnected, generation);
    }
  }

  private sendSubscribe(sessionIds: readonly string[]): void {
    const cursors: Record<string, SessionCursor> = {};
    for (const sessionId of sessionIds) {
      const desired = this.desired.get(sessionId);
      if (desired !== undefined) cursors[sessionId] = desired.cursor;
    }
    this.send({
      type: 'subscribe',
      id: this.nextId(),
      payload: { session_ids: sessionIds, cursors },
    });
    if (this.timelineMode === 'transcript') {
      for (const sessionId of sessionIds) {
        const desired = this.desired.get(sessionId);
        if (desired !== undefined) this.sendSubscribeV2(sessionId, desired.grades);
      }
    }
  }

  private sendSubscribeV2(sessionId: string, grades: TranscriptGradeSpec): void {
    this.send({
      type: 'subscribe_v2',
      id: this.nextId(),
      payload: {
        session_id: sessionId,
        transcript: grades,
      },
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed) return;
    if (this.fatalRetriesLeft !== null) {
      if (this.fatalRetriesLeft <= 0) return;
      this.fatalRetriesLeft -= 1;
    }
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
