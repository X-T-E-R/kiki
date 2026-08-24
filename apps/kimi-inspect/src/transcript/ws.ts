/**
 * Minimal `/api/v1/ws` client for the transcript stream — **block grade**.
 *
 * The socket is used as an incremental channel, at the cheapest grade that
 * keeps the live view correct: 'block' drops the per-token `append` frames
 * (the bulk of transcript traffic) and still receives the whole-state frame
 * upserts at every flush point. After the upgrade, the client sends
 * `client_hello` with the session in `subscriptions`, then a `subscribe_v2`
 * frame carrying the opt-in `transcript` grade map (plus the per-agent
 * `{epoch?, seq}` `transcript_since` cursor when a watermark is known), and
 * forwards `transcript.ops` plus `transcript.reset` to the consumer.
 *
 * `transcript.reset` is a baseline snapshot with `coverage` — the consumer
 * reconciles it in place (preserving already-loaded older turns). Filtered
 * grades may skip batches, so `cursor.seq` can jump; that is not a gap.
 *
 * Loss signals: `resync_required` → `onResyncRequired`, and the
 * `subscribe_v2` ack after every established socket → `onReconnected` (the
 * consumer catch-up from its cursor; `complete: false` is the only baseline
 * reset trigger). The bearer token is presented at the upgrade through the
 * `kimi-code.bearer.<token>` subprotocol.
 */

import {
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  type AgentTranscriptSnapshot,
  type TranscriptCoverage,
  type TranscriptCursor,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import type { WsLike, WsLikeCtor } from '../channel/wsLike';

/** Envelope/payload metadata carried alongside a transcript frame (for auditing + cursor tracking). */
export interface TranscriptFrameMeta {
  /** Envelope `timestamp` (server send time, ISO). */
  readonly at?: string | undefined;
  /** Per-agent watermark on the frame (`{epoch?, seq}`). */
  readonly cursor?: TranscriptCursor | undefined;
  /** Ops frames only: journal watermark (may sit ahead of `cursor.seq` after grade filtering). */
  readonly throughSeq?: number | undefined;
}

export interface TranscriptWsHandlers {
  /** Incremental L2 op batch for the agent. */
  onOps: (agentId: string, ops: readonly TranscriptOperation[], meta?: TranscriptFrameMeta) => void;
  /**
   * Baseline snapshot. The chat consumer reconciles this in place via the
   * package reset reducer (coverage-aware: a tail reset keeps already-loaded
   * older turns). Also recorded by the audit panel.
   */
  onReset?: (
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    coverage: TranscriptCoverage,
    meta?: TranscriptFrameMeta,
  ) => void;
  /** Server signalled desync for our session — consumer should catch up from its cursor. */
  onResyncRequired: () => void;
  /** Socket re-established after a drop — consumer catch-up from `transcript_since`. */
  onReconnected: () => void;
}

export interface TranscriptWsOptions {
  /** Server base URL (`http(s)://host:port`) or a full `ws(s)://…/api/v1/ws` URL. */
  readonly url: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly agentId: string;
  readonly handlers: TranscriptWsHandlers;
  /**
   * Returns the caller's current per-agent cursor at (re)subscribe time;
   * when defined it is sent as `transcript_since` so the server replays
   * missed batches instead of sending a baseline reset.
   */
  readonly getSince?: (() => TranscriptCursor | undefined) | undefined;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Base delay (ms) for the reconnect backoff. Default `500`. */
  readonly reconnectDelayMs?: number;
}

interface ServerFrame {
  readonly type: string;
  readonly id?: string;
  readonly code?: number;
  readonly timestamp?: string;
  readonly payload?: unknown;
}

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export class TranscriptWs {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly handlers: TranscriptWsHandlers;
  private readonly getSince?: (() => TranscriptCursor | undefined) | undefined;
  private readonly WsCtor: WsLikeCtor;
  private readonly reconnectDelayMs: number;

  private ws: WsLike | undefined;
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private helloId: string | undefined;
  private subscribeV2Id: string | undefined;
  private subscribeV2Acked = false;

  constructor(opts: TranscriptWsOptions) {
    this.wsUrl = toWsUrl(opts.url);
    this.token = opts.token;
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.handlers = opts.handlers;
    this.getSince = opts.getSince;
    const ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsLikeCtor | undefined);
    if (ctor === undefined) {
      throw new Error('no WebSocket implementation available; pass WebSocketImpl');
    }
    this.WsCtor = ctor;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.connect();
  }

  /** Tear the socket down permanently. */
  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  private connect(): void {
    const protocols =
      this.token !== undefined && this.token.length > 0
        ? [`${WS_BEARER_PROTOCOL_PREFIX}${this.token}`]
        : undefined;
    let ws: WsLike;
    try {
      ws = new this.WsCtor(this.wsUrl, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.helloId = `kimi-inspect-${Date.now().toString(36)}`;
      this.subscribeV2Id = `${this.helloId}-sub`;
      this.subscribeV2Acked = false;
      const since = this.getSince?.();
      this.send({
        type: 'client_hello',
        id: this.helloId,
        payload: {
          client_id: 'kimi-inspect',
          subscriptions: [this.sessionId],
        },
      });
      // Transcript grades ride only `subscribe_v2` — sent right after the
      // hello on the same socket, so the server processes them in order.
      this.send({
        type: 'subscribe_v2',
        id: this.subscribeV2Id,
        payload: {
          session_id: this.sessionId,
          transcript: { [this.agentId]: 'block' },
          transcript_since: since !== undefined ? { [this.agentId]: since } : undefined,
        },
      });
      // The reconcile fires on the subscribe_v2 ACK (see onMessage) — the
      // server attaches the transcript stream only after processing
      // subscribe_v2, so refreshing at open could finish before the
      // subscription is active and still miss the ops in between.
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', () => {
      // Stale socket (a manual close already cleared `this.ws`).
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (!this.manualClose) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // The 'close' event always follows 'error'; reconnect logic lives there.
    });
  }

  private onMessage(raw: unknown): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'ack': {
        // The subscribe_v2 ack: the server has attached the transcript stream
        // by now — reconcile once per socket (ops emitted between the REST
        // page load and this point are missed; the consumer refreshes).
        if (!this.subscribeV2Acked && frame.id !== undefined && frame.id === this.subscribeV2Id) {
          this.subscribeV2Acked = true;
          this.handlers.onReconnected();
        }
        return;
      }
      case 'transcript.ops': {
        const parsed = transcriptOpsEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        if (parsed.data.session_id !== this.sessionId) return;
        this.handlers.onOps(parsed.data.agent_id, parsed.data.ops, {
          at: frame.timestamp,
          cursor: parsed.data.cursor,
          throughSeq: parsed.data.through_seq,
        });
        return;
      }
      case 'transcript.reset': {
        if (this.handlers.onReset === undefined) return;
        const parsed = transcriptResetEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        if (parsed.data.session_id !== this.sessionId) return;
        this.handlers.onReset(parsed.data.agent_id, parsed.data.snapshot, parsed.data.coverage, {
          at: frame.timestamp,
          cursor: parsed.data.cursor,
        });
        return;
      }
      case 'ping': {
        const nonce = (frame.payload as { nonce?: unknown } | undefined)?.nonce;
        this.send({ type: 'pong', payload: { nonce } });
        return;
      }
      case 'resync_required': {
        const sessionId = (frame.payload as { session_id?: unknown } | undefined)?.session_id;
        if (sessionId === this.sessionId) this.handlers.onResyncRequired();
        return;
      }
      default:
        // server_hello / ack / legacy session events — not consumed here.
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== this.WsCtor.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort; the close handler handles teardown
    }
  }
}

/** Derive the `/api/v1/ws` WebSocket URL from a server base URL (or pass a full ws URL through). */
function toWsUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for WS transport: ${base}`);
  }
  if (!url.pathname.endsWith('/api/v1/ws')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/ws`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
