import {
  terminalAttachMessageSchema,
  terminalCloseMessageSchema,
  terminalDetachMessageSchema,
  terminalInputMessageSchema,
  terminalResizeMessageSchema,
  unsubscribeV2PayloadSchema,
  WS_PROTOCOL_VERSION,
  ErrorCode,
  type SessionCursor,
} from '@kiki/protocol';
import {
  Error2,
  ErrorCodes as CoreErrorCodes,
  ISessionTerminalService,
  isError2,
  type Scope,
  type TerminalFrame,
} from '@kiki/agent-core-v2';
import {
  acceptsTranscriptCoverage,
  detachGrades,
  gradeFor,
  requestsTranscript,
  TRANSCRIPT_CLIENT_UPGRADE_MESSAGE,
  TRANSCRIPT_COVERAGE_VERSION,
  transcriptSubscribeV2PayloadSchema,
  type TranscriptGradeSpec,
} from '@kiki/transcript';
import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';

import { withSessionOperation } from '../../../lib/sessionOperationLease';
import { RemoteConnectionsChanged } from '../../../services/connections/events';
import type { CredentialValidator } from '../../../services/auth/credentials';
import type { IConnectionRegistry } from '../connectionRegistry';
import { encodeJsonValueBounded } from './boundedJsonEncoder';
import {
  type EventEnvelope,
  type JournalLogger,
} from './sessionEventJournal';
import {
  buildAck,
  buildPing,
  buildResyncRequired,
  buildServerHello,
} from './protocol';
import {
  isGlobalEvent,
  type AgentFilter,
  type BroadcastDelivery,
  type BroadcastTarget,
  type ResyncReason,
  type SessionEventBroadcaster,
  type TargetSubscription,
  type TranscriptSince,
} from './sessionEventBroadcaster';
import { FsWatchBridge } from './fsWatchBridge';

const DEFAULT_MAX_BUFFER_SIZE = 1000;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_MISS_LIMIT = 2;

type SessionSubscription = TargetSubscription;

const DEFAULT_FLUSH_INTERVAL_MS = 30;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_HIGH_WATER_MARK_BYTES = 1 << 20;
const DEFAULT_MAX_OUTBOUND_BUFFER_BYTES = 4 << 20;
const DEFAULT_MAX_BACKPRESSURE_ROUNDS = 3;
const DEFAULT_BACKPRESSURE_RETRY_MS = 5;
const DEFAULT_BACKPRESSURE_MAX_DELAY_MS = 100;

interface InboundFrame {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
}

export interface WsConnectionV1Options {
  readonly socket: WebSocket;
  readonly broadcaster: SessionEventBroadcaster;
  readonly fsWatchBridge?: FsWatchBridge;
  /** Core scope used to resolve Session-scoped terminal services. */
  readonly terminalCore?: Scope;
  /** Exposure-policy gate shared with the terminal REST routes and `/meta`. */
  readonly enableTerminals?: boolean;
  readonly connectionRegistry: IConnectionRegistry;
  /**
   * Present-only credential check for the post-connect `client_hello`
   * handshake. The WebSocket upgrade handler (`start.ts`) is the real auth
   * gate; this is defense-in-depth so a presented handshake token must still
   * be valid. A missing token is accepted (the production web client sends
   * the bearer at the upgrade and no token in `client_hello`).
   */
  readonly validateCredential?: CredentialValidator;
  readonly sessionAccessId?: string;
  readonly browser?: boolean;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  readonly logger?: JournalLogger;
  readonly maxBufferSize?: number;
  /** Delay before buffered subscription events are flushed. */
  readonly flushIntervalMs?: number;
  /** Flush subscription events once this many frames are queued. */
  readonly maxBatchSize?: number;
  /** `socket.bufferedAmount` above which flushing is deferred (backpressure). */
  readonly highWaterMarkBytes?: number;
  /** Hard cap for queued frames and sustained `socket.bufferedAmount`. */
  readonly maxOutboundBufferBytes?: number;
  /** Consecutive over-cap backpressure retries before terminating the peer. */
  readonly maxBackpressureRounds?: number;
  /** Heartbeat ping cadence; `0` disables it and omits `heartbeat_ms`. */
  readonly heartbeatIntervalMs?: number;
}

export class WsConnectionV1 implements BroadcastTarget {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;

  private readonly socket: WebSocket;
  private readonly broadcaster: SessionEventBroadcaster;
  private readonly fsWatchBridge?: FsWatchBridge;
  private readonly terminalCore?: Scope;
  private readonly enableTerminals: boolean;
  private readonly validateCredential?: CredentialValidator;
  private readonly sessionAccessId?: string;
  private readonly browser: boolean;
  private readonly maxBufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly highWaterMarkBytes: number;
  private readonly maxOutboundBufferBytes: number;
  private readonly maxBackpressureRounds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly logger?: JournalLogger;

  private closed = false;
  private gotClientHello = false;
  /** Per-session subscription state: legacy agent allowlist + opt-in transcript grades. */
  readonly subscriptions = new Map<string, SessionSubscription>();
  private readonly transcriptOnlySessions = new Set<string>();
  private readonly pendingAttaches = new Set<string>();
  private readonly replayHolds = new Set<string>();
  private readonly heldDuringReplay = new Map<string, EventEnvelope[]>();
  private readonly heldSessionBytes = new Map<string, number>();
  private heldBytes = 0;
  private lastFragmentProgressAt = 0;
  /**
   * Serializes control-frame handling in receive order. Frames arrive
   * back-to-back (e.g. `client_hello` immediately followed by
   * `subscribe_v2`), and a later handler reads subscription state the
   * earlier one stores — without the queue, two async attaches could
   * interleave and the stale one would overwrite the fresher state.
   */
  private controlQueue: Promise<void> = Promise.resolve();

  /** Outbound frames awaiting the next flush. */
  private outbound: unknown[] = [];
  /** Cached serialization for byte accounting and non-coalesced sends. */
  private outboundSerialized: Array<string | undefined> = [];
  private outboundBytes = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private backpressureRetryTimer?: ReturnType<typeof setTimeout>;
  /** Epoch ms when the current backpressure deferral started; caps the wait. */
  private backpressureSince?: number;
  private overLimitBackpressureRounds = 0;
  private readonly terminalAttachments = new Map<string, ISessionTerminalService>();

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** Epoch ms of the most recent inbound frame — any frame proves the peer is alive. */
  private lastInboundAt = Date.now();

  constructor(opts: WsConnectionV1Options) {
    this.id = `conn_${ulid()}`;
    this.connectedAt = new Date().toISOString();
    this.remoteAddress = opts.remoteAddress;
    this.userAgent = opts.userAgent;
    this.socket = opts.socket;
    this.broadcaster = opts.broadcaster;
    this.fsWatchBridge = opts.fsWatchBridge;
    this.terminalCore = opts.terminalCore;
    this.enableTerminals = opts.enableTerminals === true && opts.terminalCore !== undefined;
    this.validateCredential = opts.validateCredential;
    this.sessionAccessId = opts.sessionAccessId;
    this.browser = opts.browser === true;
    this.logger = opts.logger;
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.highWaterMarkBytes = opts.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;
    this.maxOutboundBufferBytes =
      opts.maxOutboundBufferBytes ?? DEFAULT_MAX_OUTBOUND_BUFFER_BYTES;
    this.maxBackpressureRounds =
      opts.maxBackpressureRounds ?? DEFAULT_MAX_BACKPRESSURE_ROUNDS;
    this.heartbeatIntervalMs =
      opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.lastInboundAt = Date.now();

    this.socket.on('message', (data: RawData) => this.onMessage(data));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    opts.connectionRegistry.add(this);
    this.broadcaster.addGlobalTarget(this);
    this.sendImmediateFrame(
      buildServerHello({
        ws_connection_id: this.id,
        protocol_version: WS_PROTOCOL_VERSION,
        heartbeat_ms:
          this.heartbeatIntervalMs > 0 ? this.heartbeatIntervalMs : undefined,
        max_event_buffer_size: this.maxBufferSize,
        capabilities: { event_batching: false, compression: false },
      }),
    );
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      this.onHeartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  get hasClientHello(): boolean {
    return this.gotClientHello;
  }

  get subscriptionSessionIds(): readonly string[] {
    return Array.from(this.subscriptions.keys()).sort();
  }

  /** BroadcastTarget — buffer subscription traffic; public traffic is a FIFO barrier. */
  send(envelope: EventEnvelope, delivery: BroadcastDelivery = 'subscription'): void {
    const sessionId = envelope.session_id;
    if (this.browser && envelope.type === RemoteConnectionsChanged.type) return;
    if (this.sessionAccessId !== undefined && (sessionId !== this.sessionAccessId ||
      envelope.type === 'event.plugin.topic' || envelope.type.startsWith('event.room.') ||
      (delivery === 'immediate' || isGlobalEvent(envelope.type)) && !/^(?:event\.session\.(?:work_changed|history_rewritten)|session\.meta\.updated|event\.(?:approval|question)\.[^.]+)$/.test(envelope.type))) return;
    if (delivery !== 'immediate' && sessionId !== undefined && this.replayHolds.has(sessionId)) {
      this.holdReplayFrame(envelope);
      return;
    }
    if (delivery === 'immediate' || isUrgentTranscriptFrame(envelope)) this.sendImmediateFrame(envelope);
    else this.sendSubscribedFrame(envelope);
  }

  private holdReplayFrame(envelope: EventEnvelope): void {
    if (this.closed) return;
    const sessionId = envelope.session_id;
    if (sessionId === undefined) return;
    const serialized = serializeOutboundFrame(envelope, this.maxOutboundBufferBytes);
    const held = this.heldDuringReplay.get(sessionId);
    if (held === undefined) this.heldDuringReplay.set(sessionId, [envelope]);
    else held.push(envelope);
    const prevSessionBytes = this.heldSessionBytes.get(sessionId) ?? 0;
    this.heldSessionBytes.set(sessionId, prevSessionBytes + serialized.bytes);
    this.heldBytes += serialized.bytes;
    if (this.outboundBytes + this.heldBytes > this.maxOutboundBufferBytes) {
      this.terminateSlowOrSilent('slow_consumer', {
        cause: 'queued_bytes',
        queuedBytes: this.outboundBytes + this.heldBytes,
        limitBytes: this.maxOutboundBufferBytes,
      });
    }
  }

  private takeReplayHeld(sid: string): EventEnvelope[] {
    const held = this.heldDuringReplay.get(sid) ?? [];
    this.discardReplayHeld(sid);
    return held;
  }

  private discardReplayHeld(sid?: string): void {
    if (sid === undefined) {
      this.heldDuringReplay.clear();
      this.heldSessionBytes.clear();
      this.heldBytes = 0;
      return;
    }
    this.heldDuringReplay.delete(sid);
    const removed = this.heldSessionBytes.get(sid) ?? 0;
    this.heldSessionBytes.delete(sid);
    this.heldBytes = Math.max(0, this.heldBytes - removed);
  }

  private fragmenting = false;

  async drain(): Promise<void> {
    this.flush();
    while (!this.closed && (this.fragmenting || this.outbound.length > 0 || this.socket.bufferedAmount > this.highWaterMarkBytes)) {
      if (this.socket.bufferedAmount > this.maxOutboundBufferBytes) {
        this.terminateSlowOrSilent('slow_consumer', { cause: 'socket_buffered_bytes' });
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_BACKPRESSURE_RETRY_MS));
      this.flush();
    }
    if (this.closed) throw new Error('WebSocket connection closed during transcript transfer');
  }

  private async sendFragments(text: string): Promise<void> {
    this.fragmenting = true;
    this.lastFragmentProgressAt = Date.now();
    const data = Buffer.from(text);
    const chunkSize = Math.max(1, Math.min(64 * 1024, this.highWaterMarkBytes, this.maxOutboundBufferBytes));
    try {
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        while (!this.closed && this.socket.bufferedAmount > this.highWaterMarkBytes) {
          if (this.socket.bufferedAmount > this.maxOutboundBufferBytes) {
            this.terminateSlowOrSilent('slow_consumer', { cause: 'socket_buffered_bytes' });
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_BACKPRESSURE_RETRY_MS));
        }
        if (this.closed) return;
        const end = Math.min(offset + chunkSize, data.length);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WebSocket fragment write timed out')), 30_000);
          timer.unref?.();
          try {
            this.socket.send(data.subarray(offset, end), { binary: false, fin: end === data.length }, (error) => {
              clearTimeout(timer);
              if (error !== null && error !== undefined) reject(error);
              else {
                this.lastFragmentProgressAt = Date.now();
                resolve();
              }
            });
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      }
    } catch (error) {
      this.logger?.warn({ err: error }, 'transcript transfer failed');
      this.socket.terminate();
      this.onClose();
    } finally {
      this.fragmenting = false;
      this.flush();
    }
  }

  sendControl(frame: unknown): void {
    this.sendImmediateFrame(frame);
  }

  private onMessage(data: RawData): void {
    if (this.closed) return;
    this.lastInboundAt = Date.now();
    let frame: InboundFrame;
    try {
      frame = JSON.parse(rawDataToString(data)) as InboundFrame;
    } catch {
      return;
    }
    if (typeof frame?.type !== 'string') return;

    if (this.sessionAccessId !== undefined) {
      const payload = frame.payload ?? {};
      const sessions = frame.type === 'client_hello' ? asStringArray(payload['subscriptions']) : asStringArray(payload['session_ids']);
      if (!['client_hello', 'subscribe', 'subscribe_v2', 'unsubscribe', 'unsubscribe_v2', 'ping', 'pong'].includes(frame.type) ||
          sessions.some((id) => id !== this.sessionAccessId) ||
          (payload['session_id'] !== undefined && payload['session_id'] !== this.sessionAccessId)) {
        this.sendImmediateFrame(buildAck(frame.id ?? '', 40101, 'session_access_scope', {}));
        return;
      }
    }
    this.enqueueControl(() => this.handleFrame(frame), frame);
  }

  private async handleFrame(frame: InboundFrame): Promise<void> {
    if (this.closed) return;
    if (this.sessionAccessId !== undefined && frame.type !== 'client_hello' && !(await this.authorize(frame))) return;
    switch (frame.type) {
      case 'ping':
        if (this.sessionAccessId !== undefined) this.sendImmediateFrame({ type: 'pong', id: frame.id, payload: { nonce: frame.payload?.['nonce'] } });
        return;
      case 'client_hello': return this.onClientHello(frame);
      case 'subscribe': return this.onSubscribe(frame);
      case 'subscribe_v2': return this.onSubscribeV2(frame);
      case 'unsubscribe_v2': return this.onUnsubscribeV2(frame);
      case 'unsubscribe': return this.onUnsubscribe(frame);
      case 'watch_fs_add': return this.onWatchFs(frame, true);
      case 'watch_fs_remove': return this.onWatchFs(frame, false);
      case 'terminal_attach':
      case 'terminal_detach':
      case 'terminal_input':
      case 'terminal_resize':
      case 'terminal_close': return this.onTerminalControl(frame);
    }
  }

  private enqueueControl(task: () => Promise<void>, frame?: InboundFrame): void {
    this.controlQueue = this.controlQueue.then(task).catch((error: unknown) => {
      this.logger?.warn(
        { err: error, frame_type: frame?.type, frame_id: frame?.id },
        'ws control frame failed',
      );
      if (!this.closed && typeof frame?.id === 'string' && frame.id.length > 0) {
        this.sendImmediateFrame(buildAck(frame.id, ErrorCode.INTERNAL_ERROR, 'internal error', {}));
      }
    });
  }

  /**
   * Heartbeat tick: reap first, ping second. A peer silent for two full cycles
   * (no pong, no control traffic at all) is half-open — close it rather than
   * ping a dead pipe. The close also fires the client's reconnect path.
   */
  private onHeartbeat(): void {
    if (this.fragmenting) {
      if (Date.now() - this.lastFragmentProgressAt >= 30_000) {
        this.terminateSlowOrSilent('slow_consumer', { cause: 'fragment_stalled' });
      }
      return;
    }
    if (Date.now() - Math.max(this.lastInboundAt, this.lastFragmentProgressAt) >= this.heartbeatIntervalMs * HEARTBEAT_MISS_LIMIT) {
      this.close(1001, 'heartbeat timeout');
      return;
    }
    this.sendImmediateFrame(buildPing(ulid()));
  }

  private async onClientHello(frame: InboundFrame): Promise<void> {
    if (!(await this.authorize(frame))) return;
    this.gotClientHello = true;

    const payload = frame.payload ?? {};
    const subscriptions = asStringArray(payload['subscriptions']);
    const cursors = payload['cursors'] as Record<string, SessionCursor> | undefined;
    const agentFilter = parseAgentFilter(payload['agent_filter']);

    const accepted: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    for (const sid of subscriptions) {
      await this.attachSession(
        sid,
        cursors?.[sid],
        agentFilter?.[sid],
        this.subscriptions.get(sid)?.transcriptGrades,
        undefined,
        { accepted, resyncRequired, serverCursors },
        false,
      );
    }

    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted_subscriptions: accepted,
        resync_required: resyncRequired,
        cursors: serverCursors,
      }),
    );
  }

  private async onSubscribe(frame: InboundFrame): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionIds = asStringArray(payload['session_ids']);
    const cursors = payload['cursors'] as Record<string, SessionCursor> | undefined;
    const agentFilter = parseAgentFilter(payload['agent_filter']);

    const accepted: string[] = [];
    const notFound: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    for (const sid of sessionIds) {
      await this.attachSession(
        sid,
        cursors?.[sid],
        agentFilter?.[sid],
        this.subscriptions.get(sid)?.transcriptGrades,
        undefined,
        { accepted, resyncRequired, serverCursors, notFound },
        false,
      );
    }

    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted,
        not_found: notFound,
        resync_required: resyncRequired,
        cursors: serverCursors,
      }),
    );
  }

  /**
   * `subscribe_v2` — the ONLY transcript subscription channel: attach or
   * update this connection's per-agent transcript grades for ONE session.
   * Carries no durable cursor (transcript frames are volatile), so the
   * baseline/catch-up decision lives entirely in the broadcaster's
   * `subscribeTranscript` (`transcript_since` journal replay vs reset). A
   * legacy agent allowlist already held for the session is preserved.
   */
  private async onSubscribeV2(frame: InboundFrame): Promise<void> {
    const parsed = transcriptSubscribeV2PayloadSchema.safeParse(frame.payload ?? {});
    if (!parsed.success) {
      this.sendImmediateFrame(buildAck(frame.id ?? '', 1, 'invalid subscribe_v2 payload', {}));
      return;
    }
    const sid = parsed.data.session_id;
    const coverage = requestsTranscript(parsed.data.transcript);
    if (coverage && !acceptsTranscriptCoverage(parsed.data.transcript_coverage_version)) {
      const existing = this.subscriptions.get(sid);
      if (existing !== undefined) {
        this.broadcaster.unsubscribeTranscript(sid, this);
        this.subscriptions.set(sid, { ...existing, transcriptGrades: undefined });
      }
      this.sendImmediateFrame(buildAck(frame.id ?? '', 1, TRANSCRIPT_CLIENT_UPGRADE_MESSAGE, {}));
      return;
    }

    const accepted: string[] = [];
    const notFound: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    const existingSub = this.subscriptions.get(sid);
    await this.attachSession(
      sid,
      undefined,
      existingSub?.agentFilter,
      parsed.data.transcript,
      parsed.data.transcript_since,
      { accepted, resyncRequired, serverCursors, notFound },
      existingSub === undefined || this.transcriptOnlySessions.has(sid),
    );

    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted,
        not_found: notFound,
        resync_required: resyncRequired,
        cursors: serverCursors,
        transcript_coverage_version: coverage ? TRANSCRIPT_COVERAGE_VERSION : undefined,
      }),
    );
  }

  /**
   * `unsubscribe_v2` — the agent-grained counterpart of `subscribe_v2`:
   * detach the listed agents' transcript streams (`agent_ids` absent = the
   * whole session's stream) while leaving the legacy event subscription and
   * its agent allowlist untouched. Idempotent and never activates a session;
   * a detached agent's legacy `session_event`s resume in full as the
   * suppression lifts with its grade.
   */
  private async onUnsubscribeV2(frame: InboundFrame): Promise<void> {
    const parsed = unsubscribeV2PayloadSchema.safeParse(frame.payload ?? {});
    if (!parsed.success) {
      this.sendImmediateFrame(buildAck(frame.id ?? '', 1, 'invalid unsubscribe_v2 payload', {}));
      return;
    }
    const sid = parsed.data.session_id;
    const agentIds = parsed.data.agent_ids;

    const existing = this.subscriptions.get(sid);
    if (existing !== undefined) {
      this.broadcaster.unsubscribeTranscript(sid, this, agentIds);
      const nextGrades =
        agentIds === undefined ? undefined : detachGrades(existing.transcriptGrades, agentIds);
      let detachedTranscriptAgents: ReadonlySet<string> | undefined;
      if (nextGrades !== undefined && this.transcriptOnlySessions.has(sid)) {
        const merged = new Set<string>(existing.detachedTranscriptAgents);
        for (const id of agentIds ?? []) {
          if (id !== '*') merged.add(id);
        }
        if (merged.size > 0) detachedTranscriptAgents = merged;
      }
      if (nextGrades === undefined) this.transcriptOnlySessions.delete(sid);
      this.subscriptions.set(sid, {
        agentFilter: existing.agentFilter,
        transcriptGrades: nextGrades,
        detachedTranscriptAgents,
      });
    }

    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted: [sid],
        not_found: [],
        resync_required: [],
      }),
    );
  }

  private async onUnsubscribe(frame: InboundFrame): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionIds = asStringArray(payload['session_ids']);
    for (const sid of sessionIds) {
      this.broadcaster.unsubscribe(sid, this);
      this.subscriptions.delete(sid);
      this.transcriptOnlySessions.delete(sid);
    }
    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted: [],
        not_found: [],
        resync_required: [],
      }),
    );
  }

  private async onWatchFs(frame: InboundFrame, isAdd: boolean): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : '';
    const runtimeId =
      typeof payload['runtime_id'] === 'string' && payload['runtime_id'].length > 0
        ? payload['runtime_id']
        : 'local';
    const paths = asStringArray(payload['paths']);
    const bridge = this.fsWatchBridge;
    if (bridge === undefined) {
      this.sendImmediateFrame(buildAck(frame.id ?? '', 1, 'fs watch unavailable', {}));
      return;
    }
    let result;
    try {
      result = isAdd
        ? await bridge.addWatch(this, sessionId, paths, runtimeId)
        : await bridge.removeWatch(this, sessionId, paths, runtimeId);
    } catch (error) {
      this.sendImmediateFrame(
        buildAck(frame.id ?? '', 1, 'internal error', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    this.sendImmediateFrame(
      buildAck(frame.id ?? '', result.code, result.msg, {
        watched_paths: result.watched_paths ?? [],
        current_count: result.current_count ?? 0,
      }),
    );
  }

  private async onTerminalControl(frame: InboundFrame): Promise<void> {
    if (!this.enableTerminals) {
      this.sendImmediateFrame(
        buildAck(frame.id ?? '', ErrorCode.TERMINAL_NOT_FOUND, 'terminal unavailable', {}),
      );
      return;
    }

    try {
      switch (frame.type) {
        case 'terminal_attach': {
          const parsed = terminalAttachMessageSchema.safeParse(frame);
          if (!parsed.success) {
            this.sendInvalidTerminalControl(frame);
            return;
          }
          const { session_id, terminal_id, since_seq } = parsed.data.payload;
          await this.withTerminalService(session_id, async (service) => {
            if (this.closed) return;
            const key = terminalAttachmentKey(session_id, terminal_id);
            this.terminalAttachments.set(key, service);
            try {
              const result = await service.attach(
                terminal_id,
                {
                  id: this.id,
                  send: (terminalFrame) => {
                    this.onTerminalFrame(service, terminalFrame);
                  },
                },
                { sinceSeq: since_seq },
              );
              if (this.closed) {
                service.detach(terminal_id, this.id);
                this.terminalAttachments.delete(key);
                return;
              }
              this.sendImmediateFrame(
                buildAck(frame.id ?? '', ErrorCode.SUCCESS, 'success', {
                  attached: true as const,
                  replayed: result.replayed,
                  earliest_seq: result.earliestSeq,
                  truncated: result.truncated,
                }),
              );
            } catch (error) {
              service.detach(terminal_id, this.id);
              this.terminalAttachments.delete(key);
              throw error;
            }
          });
          return;
        }
        case 'terminal_detach': {
          const parsed = terminalDetachMessageSchema.safeParse(frame);
          if (!parsed.success) {
            this.sendInvalidTerminalControl(frame);
            return;
          }
          const { session_id, terminal_id } = parsed.data.payload;
          await this.withTerminalService(session_id, async (service) => {
            if (this.closed) return;
            await service.get(terminal_id);
            if (this.closed) return;
            service.detach(terminal_id, this.id);
            this.terminalAttachments.delete(terminalAttachmentKey(session_id, terminal_id));
            this.sendImmediateFrame(
              buildAck(frame.id ?? '', ErrorCode.SUCCESS, 'success', { detached: true as const }),
            );
          });
          return;
        }
        case 'terminal_input': {
          const parsed = terminalInputMessageSchema.safeParse(frame);
          if (!parsed.success) {
            this.sendInvalidTerminalControl(frame);
            return;
          }
          const { session_id, terminal_id, data } = parsed.data.payload;
          await this.withTerminalService(session_id, async (service) => {
            if (this.closed) return;
            await service.write(terminal_id, data);
            this.sendImmediateFrame(
              buildAck(frame.id ?? '', ErrorCode.SUCCESS, 'success', { accepted: true as const }),
            );
          });
          return;
        }
        case 'terminal_resize': {
          const parsed = terminalResizeMessageSchema.safeParse(frame);
          if (!parsed.success) {
            this.sendInvalidTerminalControl(frame);
            return;
          }
          const { session_id, terminal_id, cols, rows } = parsed.data.payload;
          await this.withTerminalService(session_id, async (service) => {
            if (this.closed) return;
            await service.resize(terminal_id, cols, rows);
            this.sendImmediateFrame(
              buildAck(frame.id ?? '', ErrorCode.SUCCESS, 'success', { resized: true as const }),
            );
          });
          return;
        }
        case 'terminal_close': {
          const parsed = terminalCloseMessageSchema.safeParse(frame);
          if (!parsed.success) {
            this.sendInvalidTerminalControl(frame);
            return;
          }
          const { session_id, terminal_id } = parsed.data.payload;
          await this.withTerminalService(session_id, async (service) => {
            if (this.closed) return;
            const result = await service.close(terminal_id);
            service.detach(terminal_id, this.id);
            this.terminalAttachments.delete(terminalAttachmentKey(session_id, terminal_id));
            this.sendImmediateFrame(
              buildAck(frame.id ?? '', ErrorCode.SUCCESS, 'success', result),
            );
          });
          return;
        }
      }
    } catch (error) {
      this.sendTerminalError(frame, error);
    }
  }

  private async withTerminalService<T>(sessionId: string, work: (service: ISessionTerminalService) => Promise<T>): Promise<T> {
    const core = this.terminalCore;
    if (core === undefined) throw new Error('terminal core unavailable');
    return withSessionOperation(core, sessionId, async (session) => {
      if (session === undefined) {
        throw new Error2(CoreErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      }
      return work(session.accessor.get(ISessionTerminalService));
    });
  }

  private onTerminalFrame(service: ISessionTerminalService, frame: TerminalFrame): void {
    if (this.closed) return;
    this.sendImmediateFrame(frame);
    if (frame.type === 'terminal_exit') {
      service.detach(frame.terminal_id, this.id);
      this.terminalAttachments.delete(
        terminalAttachmentKey(frame.session_id, frame.terminal_id),
      );
    }
  }

  private sendInvalidTerminalControl(frame: InboundFrame): void {
    this.sendImmediateFrame(
      buildAck(frame.id ?? '', ErrorCode.VALIDATION_FAILED, `invalid ${frame.type} payload`, {}),
    );
  }

  private sendTerminalError(frame: InboundFrame, error: unknown): void {
    if (isError2(error)) {
      const code =
        error.code === CoreErrorCodes.SESSION_NOT_FOUND
          ? ErrorCode.SESSION_NOT_FOUND
          : error.code === CoreErrorCodes.TERMINAL_NOT_FOUND
            ? ErrorCode.TERMINAL_NOT_FOUND
            : undefined;
      if (code !== undefined) {
        this.sendImmediateFrame(buildAck(frame.id ?? '', code, error.message, {}));
        return;
      }
    }
    this.logger?.error?.({ err: error }, 'terminal WebSocket control failed');
    this.sendImmediateFrame(
      buildAck(frame.id ?? '', ErrorCode.INTERNAL_ERROR, 'internal error', {}),
    );
  }

  /**
   * Shared attach path behind `client_hello` (legacy inline subscriptions)
   * and `subscribe`. Subscribes the connection via the broadcaster, then
   * either replays durable events since the client's cursor (with the
   * transcript baseline deferred until after the replay — its seq must
   * follow the replayed backlog, never precede it) or reports the server's
   * current cursor. Unknown sessions land in `collectors.notFound` when the
   * caller is `subscribe`, otherwise in `resyncRequired` (the hello ack has
   * no `not_found` field).
   */
  private async attachSession(
    sid: string,
    cursor: SessionCursor | undefined,
    filter: AgentFilter | undefined,
    transcriptGrades: TranscriptGradeSpec | undefined,
    transcriptSince: TranscriptSince | undefined,
    collectors: {
      accepted: string[];
      resyncRequired: string[];
      serverCursors: Record<string, { seq: number; epoch?: string }>;
      notFound?: string[];
    },
    transcriptOnly?: boolean,
  ): Promise<void> {
    if (this.closed) return;
    const { accepted, resyncRequired, serverCursors, notFound } = collectors;
    const prior = this.subscriptions.get(sid);
    const effectiveTranscriptOnly = transcriptOnly ?? this.transcriptOnlySessions.has(sid);
    let effectiveDetached: ReadonlySet<string> | undefined;
    if (effectiveTranscriptOnly && prior?.detachedTranscriptAgents !== undefined && prior.detachedTranscriptAgents.size > 0) {
      const retained = new Set<string>();
      for (const id of prior.detachedTranscriptAgents) {
        if (transcriptGrades === undefined || gradeFor(transcriptGrades, id) === 'off') {
          retained.add(id);
        }
      }
      if (retained.size > 0) effectiveDetached = retained;
    }
    this.pendingAttaches.add(sid);
    if (cursor !== undefined) this.replayHolds.add(sid);
    let attached = false;
    let notFoundSession = false;
    let subscribedInBroadcaster = false;
    try {
      const ok = await this.broadcaster.subscribe(sid, this, filter, transcriptGrades, {
        deferTranscriptReset: cursor !== undefined,
        transcriptSince,
        transcriptOnly,
      });
      if (this.closed) return;
      if (!ok) {
        notFoundSession = true;
        if (notFound !== undefined) notFound.push(sid);
        else resyncRequired.push(sid);
        return;
      }
      subscribedInBroadcaster = true;
      if (cursor !== undefined) {
        await this.replay(
          sid,
          cursor,
          filter,
          transcriptGrades,
          effectiveTranscriptOnly,
          effectiveDetached,
          resyncRequired,
          serverCursors,
        );
        await this.broadcaster.flushTranscriptSeed(sid, this);
      } else {
        const current = await this.broadcaster.getCursor(sid);
        serverCursors[sid] = { seq: current.seq, epoch: current.epoch };
      }
      if (this.closed) return;
      this.subscriptions.set(sid, {
        agentFilter: filter,
        transcriptGrades,
        detachedTranscriptAgents: effectiveDetached,
      });
      if (transcriptOnly === true) this.transcriptOnlySessions.add(sid);
      else if (transcriptOnly === false) this.transcriptOnlySessions.delete(sid);
      accepted.push(sid);
      attached = true;
    } catch (error) {
      if (this.closed && error instanceof Error && error.name === 'AbortError') return;
      this.logger?.warn({ err: error, session_id: sid }, 'ws session attach failed');
      if (!this.closed && !resyncRequired.includes(sid)) {
        resyncRequired.push(sid);
      }
    } finally {
      this.pendingAttaches.delete(sid);
      this.replayHolds.delete(sid);
      this.discardReplayHeld(sid);
      if (!attached) {
        if (this.closed || notFoundSession || prior === undefined) {
          this.broadcaster.unsubscribe(sid, this);
          this.subscriptions.delete(sid);
          this.transcriptOnlySessions.delete(sid);
        } else {
          if (subscribedInBroadcaster && typeof this.broadcaster.restoreSubscription === 'function') {
            this.broadcaster.restoreSubscription(sid, this, prior);
          } else if (prior.transcriptGrades === undefined && transcriptGrades !== undefined) {
            this.broadcaster.unsubscribeTranscript(sid, this);
          }
          this.subscriptions.set(sid, prior);
        }
      }
    }
  }

  private async replay(
    sid: string,
    cursor: SessionCursor,
    filter: AgentFilter | undefined,
    transcriptGrades: TranscriptGradeSpec | undefined,
    transcriptOnly: boolean,
    detachedTranscriptAgents: ReadonlySet<string> | undefined,
    resyncRequired: string[],
    serverCursors: Record<string, { seq: number; epoch?: string }>,
  ): Promise<void> {
    const result = await this.broadcaster.getBufferedSince(
      sid,
      cursor,
      filter,
      transcriptGrades,
      transcriptOnly,
      detachedTranscriptAgents,
    );
    this.replayHolds.delete(sid);
    const held = this.takeReplayHeld(sid);
    let seq = result.currentSeq;
    if (result.resyncRequired !== false) {
      this.sendImmediateFrame(
        buildResyncRequired(sid, result.resyncRequired as ResyncReason, result.currentSeq, result.epoch),
      );
      resyncRequired.push(sid);
    } else {
      const deliver = (envelope: EventEnvelope): void => {
        this.send(envelope);
        if (envelope.volatile !== true && envelope.seq > seq) seq = envelope.seq;
      };
      for (const { envelope } of result.events) deliver(envelope);
      for (const envelope of held) {
        if (envelope.volatile !== true && envelope.seq <= seq) continue;
        deliver(envelope);
      }
    }
    serverCursors[sid] = { seq, epoch: result.epoch };
  }

  private async authorize(frame: InboundFrame): Promise<boolean> {
    const payload = frame.payload ?? {};
    const token = typeof payload['token'] === 'string' ? (payload['token'] as string) : undefined;
    if (token === undefined || this.validateCredential === undefined) return true;
    let ok = false;
    try {
      ok = await this.validateCredential(token);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.sendImmediateFrame(buildAck(frame.id ?? '', 40112, 'unauthorized', {}));
      this.close();
      return false;
    }
    return true;
  }

  /** Queue an event delivered through `subscribe` / `subscribe_v2`. */
  private sendSubscribedFrame(msg: unknown): void {
    if (!this.enqueueOutbound(msg)) return;
    if (this.outbound.length >= this.maxBatchSize) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  /**
   * Public/control frames do not start a timer. They join the FIFO and flush it
   * immediately, so no later frame can overtake earlier subscription traffic.
   */
  private sendImmediateFrame(msg: unknown): void {
    if (!this.enqueueOutbound(msg)) return;
    this.flush();
  }

  private enqueueOutbound(msg: unknown): boolean {
    if (this.closed) return false;
    const type = typeof msg === 'object' && msg !== null && 'type' in msg ? msg.type : undefined;
    const isFragmentableTranscript = type === 'transcript.reset' || type === 'transcript.ops';
    const maxSerializeBytes = isFragmentableTranscript
      ? Math.max(this.maxOutboundBufferBytes, 7 * 1024 * 1024)
      : this.maxOutboundBufferBytes;
    const serialized = serializeOutboundFrame(msg, maxSerializeBytes);
    if (isFragmentableTranscript &&
        serialized.bytes > Math.min(64 * 1024, this.maxOutboundBufferBytes) &&
        serialized.text !== undefined && !this.fragmenting) {
      this.flush();
      if (this.outbound.length === 0 && !this.fragmenting) {
        void this.sendFragments(serialized.text);
        return false;
      }
    }
    this.outbound.push(msg);
    this.outboundSerialized.push(serialized.text);
    this.outboundBytes += serialized.bytes;
    if (this.outboundBytes + this.heldBytes > this.maxOutboundBufferBytes) {
      this.terminateSlowOrSilent('slow_consumer', {
        cause: 'queued_bytes',
        queuedBytes: this.outboundBytes + this.heldBytes,
        limitBytes: this.maxOutboundBufferBytes,
      });
      return false;
    }
    return true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  /**
   * Drain the outbound buffer: coalesce adjacent compatible volatile deltas,
   * then write the surviving frames to the socket. When the peer is not
   * draining (`bufferedAmount` above the high-water mark) and `force` is not
   * set, defer and keep accumulating — later deltas merge into the queued
   * ones. Queued bytes have a hard cap, and a socket that remains above that
   * cap for several retry rounds is terminated as a slow consumer.
   */
  private flush(force = false): void {
    if (this.fragmenting) return;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.outbound.length === 0) return;
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      this.outbound = [];
      this.outboundSerialized = [];
      this.outboundBytes = 0;
      return;
    }

    if (!force && this.socket.bufferedAmount > this.highWaterMarkBytes) {
      this.deferForBackpressure();
      return;
    }
    this.backpressureSince = undefined;
    this.overLimitBackpressureRounds = 0;

    const serializedByFrame = new Map<unknown, string>();
    const byteLengthsByFrame = new Map<unknown, number>();
    for (let i = 0; i < this.outbound.length; i++) {
      const text = this.outboundSerialized[i];
      if (text !== undefined) {
        serializedByFrame.set(this.outbound[i], text);
        byteLengthsByFrame.set(this.outbound[i], Buffer.byteLength(text));
      }
    }
    this.outbound = coalesceFrames(this.outbound, byteLengthsByFrame);
    this.outboundSerialized = this.outbound.map((frame) => serializedByFrame.get(frame) ?? JSON.stringify(frame));
    const frameBytes = this.outboundSerialized.map((text) => (text === undefined ? 0 : Buffer.byteLength(text)));
    this.outboundBytes = frameBytes.reduce((total, bytes) => total + bytes, 0);
    let sent = 0;
    try {
      for (let i = 0; i < this.outbound.length; i += 1) {
        if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
        if (!force && this.socket.bufferedAmount > this.highWaterMarkBytes) {
          this.deferForBackpressure();
          return;
        }
        const frame = this.outbound[i];
        const text = this.outboundSerialized[i];
        const bytes = frameBytes[i] ?? 0;
        sent = i + 1;
        if (text === undefined) continue;
        this.outboundBytes -= bytes;
        const type = typeof frame === 'object' && frame !== null && 'type' in frame ? frame.type : undefined;
        if ((type === 'transcript.reset' || type === 'transcript.ops') &&
            bytes > Math.min(64 * 1024, this.maxOutboundBufferBytes)) {
          this.outbound.splice(0, sent);
          this.outboundSerialized.splice(0, sent);
          sent = 0;
          void this.sendFragments(text);
          return;
        }
        try {
          this.socket.send(text);
        } catch {
        }
      }
    } finally {
      if (sent > 0) {
        if (sent >= this.outbound.length) {
          this.outbound = [];
          this.outboundSerialized = [];
          this.outboundBytes = 0;
        } else {
          this.outbound.splice(0, sent);
          this.outboundSerialized.splice(0, sent);
        }
      }
    }
  }

  private deferForBackpressure(): void {
    const now = Date.now();
    if (this.backpressureSince === undefined) this.backpressureSince = now;
    if (this.socket.bufferedAmount > this.maxOutboundBufferBytes) {
      if (this.backpressureRetryTimer === undefined) this.overLimitBackpressureRounds += 1;
      if (this.overLimitBackpressureRounds >= this.maxBackpressureRounds) {
        this.terminateSlowOrSilent('slow_consumer', {
          cause: 'socket_buffered_bytes',
          socketBufferedBytes: this.socket.bufferedAmount,
          limitBytes: this.maxOutboundBufferBytes,
          rounds: this.overLimitBackpressureRounds,
        });
        return;
      }
    } else {
      this.overLimitBackpressureRounds = 0;
    }
    if (now - this.backpressureSince >= DEFAULT_BACKPRESSURE_MAX_DELAY_MS) {
      this.flush(true);
      return;
    }
    if (this.backpressureRetryTimer !== undefined) return;
    this.backpressureRetryTimer = setTimeout(() => {
      this.backpressureRetryTimer = undefined;
      this.flush();
    }, DEFAULT_BACKPRESSURE_RETRY_MS);
    this.backpressureRetryTimer.unref?.();
  }

  private terminateSlowOrSilent(
    reason: 'inbound_silence' | 'slow_consumer',
    details: Record<string, unknown>,
  ): void {
    if (this.closed) return;
    this.logger?.warn(
      {
        connectionId: this.id,
        remoteAddress: this.remoteAddress,
        reason,
        queuedBytes: this.outboundBytes + this.heldBytes,
        socketBufferedBytes: this.socket.bufferedAmount,
        ...details,
      },
      'terminating unhealthy websocket connection',
    );
    try {
      this.socket.terminate();
    } catch {
    }
    this.onClose();
  }

  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    this.stopHeartbeat();
    this.flush(true);
    try {
      this.socket.close(code, reason);
    } catch {
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    if (this.backpressureRetryTimer !== undefined) clearTimeout(this.backpressureRetryTimer);
    this.flushTimer = undefined;
    this.backpressureRetryTimer = undefined;
    this.outbound = [];
    this.outboundSerialized = [];
    this.outboundBytes = 0;
    this.backpressureSince = undefined;
    this.overLimitBackpressureRounds = 0;
    this.broadcaster.removeGlobalTarget(this);
    for (const sid of new Set([...this.subscriptions.keys(), ...this.pendingAttaches])) {
      this.broadcaster.unsubscribe(sid, this);
    }
    this.subscriptions.clear();
    this.transcriptOnlySessions.clear();
    this.pendingAttaches.clear();
    this.replayHolds.clear();
    this.discardReplayHeld();
    this.fsWatchBridge?.detachConnection(this);
    const terminalServices = new Set(this.terminalAttachments.values());
    for (const service of terminalServices) {
      service.detachAllForSink(this.id);
    }
    this.terminalAttachments.clear();
  }
}

function serializeOutboundFrame(
  value: unknown,
  maxBytes: number,
): { text?: string; bytes: number } {
  const encoded = encodeJsonValueBounded(value, maxBytes);
  if (encoded.ok) {
    return { text: encoded.buffer.toString('utf8'), bytes: encoded.bytes };
  }
  if (encoded.reason === 'exceeded') {
    return { bytes: encoded.omittedBytesAtLeast };
  }
  return { bytes: Number.POSITIVE_INFINITY };
}

function terminalAttachmentKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\0${terminalId}`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function parseAgentFilter(value: unknown): Record<string, AgentFilter> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, AgentFilter> = {};
  for (const [sid, ids] of Object.entries(value)) {
    if (!Array.isArray(ids)) continue;
    const set = new Set(ids.filter((v): v is string => typeof v === 'string'));
    if (set.size === 0) continue;
    out[sid] = set;
  }
  return out;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

interface CoalescableDelta {
  type: 'assistant.delta' | 'thinking.delta';
  seq: number;
  volatile: true;
  offset?: number;
  session_id?: string;
  timestamp: string;
  payload: {
    agentId?: string;
    turnId?: number;
    delta: string;
    [key: string]: unknown;
  };
}

function isCoalescableDelta(frame: unknown): frame is CoalescableDelta {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f['volatile'] !== true) return false;
  const type = f['type'];
  if (type !== 'assistant.delta' && type !== 'thinking.delta') return false;
  const payload = f['payload'];
  if (typeof payload !== 'object' || payload === null) return false;
  return typeof (payload as Record<string, unknown>)['delta'] === 'string';
}

const MAX_COALESCED_TRANSCRIPT_OPS_BYTES = 64 * 1024;

interface CoalescableTranscriptOps {
  type: 'transcript.ops';
  seq: number;
  volatile?: boolean;
  session_id?: string;
  timestamp: string;
  payload: {
    session_id?: string;
    agent_id: string;
    ops: readonly unknown[];
    cursor: { readonly epoch: string; readonly seq: number };
    through_seq: number;
    [key: string]: unknown;
  };
}

function isUrgentTranscriptOp(op: unknown): boolean {
  if (typeof op !== 'object' || op === null) return false;
  const record = op as { op?: unknown; turn?: { state?: unknown } };
  if (
    record.op === 'turn.end' ||
    record.op === 'interaction.upsert' ||
    record.op === 'interaction.resolve' ||
    record.op === 'reset'
  ) {
    return true;
  }
  if (record.op === 'turn.upsert' && record.turn !== undefined && record.turn.state !== undefined && record.turn.state !== 'running') {
    return true;
  }
  return false;
}

function isUrgentTranscriptFrame(frame: unknown): boolean {
  if (!isCoalescableTranscriptOps(frame)) return false;
  return frame.payload.ops.some(isUrgentTranscriptOp);
}

function isCoalescableTranscriptOps(frame: unknown): frame is CoalescableTranscriptOps {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f['type'] !== 'transcript.ops') return false;
  const payload = f['payload'];
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p['agent_id'] !== 'string' || !Array.isArray(p['ops']) || typeof p['through_seq'] !== 'number') return false;
  const cursor = p['cursor'];
  if (typeof cursor !== 'object' || cursor === null) return false;
  const c = cursor as Record<string, unknown>;
  return typeof c['epoch'] === 'string' && typeof c['seq'] === 'number';
}

function mergeMetaMergeOp(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const prevMeta = (typeof prev['meta'] === 'object' && prev['meta'] !== null ? prev['meta'] : {}) as Record<string, unknown>;
  const nextMeta = (typeof next['meta'] === 'object' && next['meta'] !== null ? next['meta'] : {}) as Record<string, unknown>;
  const mergedMeta: Record<string, unknown> = { ...prevMeta };
  for (const [key, value] of Object.entries(nextMeta)) {
    if (value === undefined) continue;
    if (key === 'modes' && typeof value === 'object' && value !== null && typeof prevMeta['modes'] === 'object' && prevMeta['modes'] !== null) {
      const pm = prevMeta['modes'] as Record<string, unknown>;
      const nm = value as Record<string, unknown>;
      mergedMeta['modes'] = { ...pm, ...nm, plan: nm['plan'] === null ? null : (nm['plan'] ?? pm['plan']) };
    } else if (key === 'agent' && typeof value === 'object' && value !== null && typeof prevMeta['agent'] === 'object' && prevMeta['agent'] !== null) {
      mergedMeta['agent'] = { ...(prevMeta['agent'] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      mergedMeta[key] = value;
    }
  }
  return { ...next, meta: mergedMeta };
}

function frameUpsertKey(record: {
  turnId?: unknown;
  stepId?: unknown;
  frame?: { frameId?: unknown; kind?: unknown; contentRefs?: unknown };
}): string | undefined {
  if (typeof record.turnId !== 'string' || typeof record.stepId !== 'string' || typeof record.frame?.frameId !== 'string') {
    return undefined;
  }
  return `${record.turnId}\0${record.stepId}\0${record.frame.frameId}`;
}

function compactTranscriptOps(ops: readonly unknown[]): unknown[] {
  if (ops.length <= 1) return [...ops];
  const appendedTaskIds = new Set<string>();
  const blockedFrameKeys = new Set<string>();
  for (const op of ops) {
    if (typeof op !== 'object' || op === null) continue;
    const record = op as {
      op?: unknown;
      turnId?: unknown;
      stepId?: unknown;
      frameId?: unknown;
      frame?: { frameId?: unknown; kind?: unknown; contentRefs?: unknown };
      target?: { type?: unknown; taskId?: unknown; turnId?: unknown; stepId?: unknown; frameId?: unknown };
    };
    if (record.op === 'append') {
      if (record.target?.type === 'task' && typeof record.target.taskId === 'string') {
        appendedTaskIds.add(record.target.taskId);
      } else if (
        typeof record.target?.turnId === 'string' &&
        typeof record.target?.stepId === 'string' &&
        typeof record.target?.frameId === 'string'
      ) {
        blockedFrameKeys.add(`${record.target.turnId}\0${record.target.stepId}\0${record.target.frameId}`);
      }
    } else if (
      record.op === 'frame.remove' &&
      typeof record.turnId === 'string' &&
      typeof record.stepId === 'string' &&
      typeof record.frameId === 'string'
    ) {
      blockedFrameKeys.add(`${record.turnId}\0${record.stepId}\0${record.frameId}`);
    } else if (record.op === 'frame.upsert' && record.frame?.contentRefs !== undefined) {
      const key = frameUpsertKey(record);
      if (key !== undefined) blockedFrameKeys.add(key);
    }
  }
  const lastTaskUpsertIndex = new Map<string, number>();
  const lastFrameUpsertIndex = new Map<string, { index: number; kind: unknown; place: unknown }>();
  let lastToolCountIndex = -1;
  let lastMetaMergeIndex = -1;
  let mergedMetaOp: Record<string, unknown> | undefined;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (typeof op !== 'object' || op === null) continue;
    const record = op as {
      op?: unknown;
      turnId?: unknown;
      stepId?: unknown;
      place?: unknown;
      task?: { taskId?: unknown };
      frame?: { frameId?: unknown; kind?: unknown; contentRefs?: unknown };
    };
    if (record.op === 'reset') {
      lastTaskUpsertIndex.clear();
      lastFrameUpsertIndex.clear();
      lastToolCountIndex = -1;
      lastMetaMergeIndex = -1;
      mergedMetaOp = undefined;
    } else if (
      record.op === 'task.upsert' &&
      typeof record.task?.taskId === 'string' &&
      !appendedTaskIds.has(record.task.taskId)
    ) {
      lastTaskUpsertIndex.set(record.task.taskId, i);
    } else if (record.op === 'frame.upsert') {
      const key = frameUpsertKey(record);
      if (key !== undefined && !blockedFrameKeys.has(key)) {
        const prev = lastFrameUpsertIndex.get(key);
        if (prev !== undefined && prev.kind !== record.frame?.kind) {
          blockedFrameKeys.add(key);
          lastFrameUpsertIndex.delete(key);
        } else {
          lastFrameUpsertIndex.set(key, {
            index: i,
            kind: record.frame?.kind,
            place: prev?.place ?? record.place,
          });
        }
      }
    } else if (record.op === 'tool.count.set') {
      lastToolCountIndex = i;
    } else if (record.op === 'meta.merge') {
      mergedMetaOp = mergedMetaOp === undefined
        ? (op as Record<string, unknown>)
        : mergeMetaMergeOp(mergedMetaOp, op as Record<string, unknown>);
      lastMetaMergeIndex = i;
    }
  }
  const compacted: unknown[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (typeof op === 'object' && op !== null) {
      const record = op as {
        op?: unknown;
        turnId?: unknown;
        stepId?: unknown;
        place?: unknown;
        task?: { taskId?: unknown };
        frame?: { frameId?: unknown; kind?: unknown; contentRefs?: unknown };
      };
      if (
        record.op === 'task.upsert' &&
        typeof record.task?.taskId === 'string' &&
        !appendedTaskIds.has(record.task.taskId) &&
        lastTaskUpsertIndex.get(record.task.taskId) !== undefined &&
        lastTaskUpsertIndex.get(record.task.taskId) !== i
      ) {
        continue;
      }
      if (record.op === 'frame.upsert') {
        const key = frameUpsertKey(record);
        const latest = key !== undefined && !blockedFrameKeys.has(key) ? lastFrameUpsertIndex.get(key) : undefined;
        if (latest !== undefined) {
          if (latest.index !== i) continue;
          if (latest.place !== undefined && record.place === undefined) {
            compacted.push({ ...(op as Record<string, unknown>), place: latest.place });
            continue;
          }
        }
      }
      if (record.op === 'tool.count.set' && lastToolCountIndex !== -1 && lastToolCountIndex !== i) {
        continue;
      }
      if (record.op === 'meta.merge' && lastMetaMergeIndex !== -1) {
        if (lastMetaMergeIndex !== i) continue;
        compacted.push(mergedMetaOp ?? op);
        continue;
      }
    }
    compacted.push(op);
  }
  return compacted;
}

/**
 * Merge adjacent compatible volatile text deltas or contiguous `transcript.ops`
 * batches into a single envelope while preserving frame order and bounds.
 */
export function coalesceFrames(
  frames: readonly unknown[],
  byteLengths?: ReadonlyMap<unknown, number>,
): unknown[] {
  if (frames.length <= 1) return [...frames];
  const measureFrameBytes = (frame: unknown): number => {
    const cached = byteLengths?.get(frame);
    return cached !== undefined ? cached : Buffer.byteLength(JSON.stringify(frame));
  };
  const out: unknown[] = [];
  let pending: {
    base: CoalescableTranscriptOps;
    lastSeq: number;
    throughSeq: number;
    ops: unknown[];
    approxBytes: number;
    hasCompactableDup: boolean;
  } | undefined;

  const flushPending = (): void => {
    if (pending === undefined) return;
    const ops = pending.ops.length > 1 ? compactTranscriptOps(pending.ops) : pending.ops;
    if (
      pending.throughSeq === pending.base.payload.through_seq &&
      pending.lastSeq === pending.base.seq &&
      ops.length === pending.base.payload.ops.length
    ) {
      out.push(pending.base);
    } else {
      out.push({
        ...pending.base,
        seq: pending.lastSeq,
        payload: {
          ...pending.base.payload,
          ops,
          cursor: pending.base.payload.cursor,
          through_seq: pending.throughSeq,
        },
      });
    }
    pending = undefined;
  };

  for (const frame of frames) {
    if (
      pending !== undefined &&
      isCoalescableTranscriptOps(frame) &&
      (pending.base.session_id ?? pending.base.payload.session_id) === (frame.session_id ?? frame.payload.session_id) &&
      pending.base.payload.agent_id === frame.payload.agent_id &&
      pending.base.payload.cursor.epoch === frame.payload.cursor.epoch &&
      frame.payload.cursor.seq === pending.throughSeq + 1 &&
      !frame.payload.ops.some(isUrgentTranscriptOp)
    ) {
      const nextBytes = measureFrameBytes(frame);
      if (pending.approxBytes + nextBytes > MAX_COALESCED_TRANSCRIPT_OPS_BYTES && pending.hasCompactableDup) {
        pending.ops = compactTranscriptOps(pending.ops);
        pending.approxBytes = Buffer.byteLength(JSON.stringify({
          ...pending.base,
          seq: pending.lastSeq,
          payload: { ...pending.base.payload, ops: pending.ops, cursor: pending.base.payload.cursor, through_seq: pending.throughSeq },
        }));
        pending.hasCompactableDup = false;
      }
      if (pending.approxBytes + nextBytes <= MAX_COALESCED_TRANSCRIPT_OPS_BYTES) {
        for (const op of frame.payload.ops) {
          pending.ops.push(op);
          if (!pending.hasCompactableDup && typeof op === 'object' && op !== null) {
            const kind = (op as { op?: unknown }).op;
            if (kind === 'frame.upsert' || kind === 'task.upsert' || kind === 'meta.merge' || kind === 'tool.count.set') {
              pending.hasCompactableDup = true;
            }
          }
        }
        pending.lastSeq = frame.seq;
        pending.throughSeq = frame.payload.through_seq;
        pending.approxBytes += nextBytes;
        continue;
      }
      flushPending();
    } else if (pending !== undefined) {
      flushPending();
    }

    if (isCoalescableTranscriptOps(frame) && !frame.payload.ops.some(isUrgentTranscriptOp)) {
      pending = {
        base: frame,
        lastSeq: frame.seq,
        throughSeq: frame.payload.through_seq,
        ops: [...frame.payload.ops],
        approxBytes: measureFrameBytes(frame),
        hasCompactableDup: false,
      };
      continue;
    }

    const last = out.at(-1);
    if (
      last !== undefined &&
      isCoalescableDelta(last) &&
      isCoalescableDelta(frame) &&
      last.type === frame.type &&
      last.session_id === frame.session_id &&
      last.payload.agentId === frame.payload.agentId &&
      last.payload.turnId === frame.payload.turnId
    ) {
      out[out.length - 1] = {
        ...last,
        payload: { ...last.payload, delta: last.payload.delta + frame.payload.delta },
      };
    } else {
      out.push(frame);
    }
  }
  flushPending();
  return out;
}
