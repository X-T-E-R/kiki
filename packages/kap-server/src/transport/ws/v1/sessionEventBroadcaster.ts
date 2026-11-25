import { stat } from 'node:fs/promises';
import type {
  AgentActivityState,
  ApprovalResponse,
  ContextMessage,
  Event2,
  IAgentScopeHandle,
  IDisposable,
  Interaction,
  InteractionKind,
  ISessionScopeHandle,
  Scope,
  SessionActivityState,
  SessionLease,
} from '@kiki/agent-core-v2';
import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentPromptService,
  IAgentTaskService,
  IBootstrapService,
  IEventBus,
  IEventService,
  IInstantiationService,
  IPluginExtensionPortRegistry,
  IPluginService,
  IPluginUsageService,
  ISessionActivityView,
  ISessionContext,
  ISessionInteractionService,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  IWireService,
  MAIN_AGENT_ID,
  SyncDescriptor,
  foldLoopEvent,
  getLiveSessionById,
  ref,
  type LiveRef,
} from '@kiki/agent-core-v2';
import type {
  PluginExtensionBrokerHostPort,
  PluginPublishedWsTopicInput,
} from '../../../protocol/rest-plugin-broker';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';
import type {
  ConfigWarningItem,
  SessionCreatedEvent,
  SessionMetaUpdatedEvent,
  Event,
} from './events';
import { isVolatileEventType } from './events';
import { remoteConnectionsChangedPayloadSchema, type SessionCursor, type InFlightTurn, type SnapshotSubagent } from '@kiki/protocol';
import {
  detachGrades,
  filterOpsForGrade,
  gradeFor,
  needsResetOnTransition,
  projectInteractionEndState,
  redactSnapshotForGrade,
  type AgentTranscript,
  type TranscriptCursor,
  type TranscriptGrade,
  type TranscriptGradeSpec,
  type TranscriptOperation,
  type TranscriptOpsEvent,
  type TranscriptResetEvent,
  type TranscriptStore,
  transcriptReadForCoverage,
  jsonBytes,
} from '@kiki/transcript';

import { toWireApproval } from '../../../routes/approvals';
import { toWirePendingUserTool } from '../../../routes/interactions';
import { toWireQuestion } from '../../../routes/questions';
import {
  cachedMessageCount,
  captureContextMessageHistory,
  type CapturedContextMessageHistory,
} from '../../../services/messages/messageHistory';
import { projectPromptContentParts } from '../../../services/messages/messageProjection';
import { readLegacyStatus, toLegacyPhase } from '../../../services/legacyStatus/legacyStatus';
import type { TranscriptService } from '../../../services/transcript/transcriptService';
import { recordSessionViewTiming, timeSessionViewPhase, type SessionViewTimingContext } from '../../klient/sessionViewTiming';
import { boundedTranscriptOps, boundedTranscriptSnapshot, TRANSCRIPT_WINDOW_BYTES } from '../../klient/boundedTranscript';
import { resolveFreshTailResetBaseline, sessionViewSnapshotHistoryCursor } from '../../klient/sessionViewReads';
import { InFlightTurnTracker } from './inFlightTurnTracker';
import { SubagentRosterTracker } from './subagentRosterTracker';
import { TurnUsageTracker } from './turnUsageTracker';
import { buildResyncRequired } from './protocol';
import {
  encodeJsonValueBounded,
  estimateJsonByteLengthBounded,
  MAX_SINGLE_JOURNAL_LINE_BYTES,
} from './boundedJsonEncoder';
import {
  JournalWatermarkIndex,
  type JournalWatermark,
  type JournalWatermarkStats,
} from './journalWatermarkIndex';
import {
  type EventEnvelope,
  isAttentionEventType,
  type JournalAppendOutcome,
  type JournalLogger,
  type JournalWriteStats,
  pruneExpiredEventJournals,
  SessionEventJournal,
  sessionJournalPath,
  toAttentionCursor,
} from './sessionEventJournal';
import {
  buildLightweightLoopEventStub,
  buildLightweightTrackerStub,
  buildRosterHintEnvelopeFromGap,
  collectContiguousDiskRange,
  collectContiguousTailRange,
  isGlobalEventType,
  judgeReplayVisibility,
  preProjectEventForQueue,
  type QueuedDispatchPayload,
  type SessionTailEntry,
  subjectMatchesAgentFilter,
  subjectSuppressedByTranscript,
} from './sessionEventReplay';

export type ResyncReason =
  | 'buffer_overflow'
  | 'session_recreated'
  | 'epoch_changed'
  | 'history_rewritten'
  | 'journal_gap';

export interface BufferedSinceResult {
  events: Array<{ seq: number; envelope: EventEnvelope }>;
  /** Lightweight roster hints preserved across transcript-suppressed gaps for ordered views. */
  rosterHints?: EventEnvelope[];
  /** When set, the client must rebuild from the snapshot and re-subscribe. */
  resyncRequired: ResyncReason | false;
  currentSeq: number;
  epoch: string;
}

export interface RawSessionTarget {
  readonly wantsDeltas?: boolean;
  send(envelope: EventEnvelope): void;
  onEvicted?(info: { readonly epoch: string; readonly seq: number; readonly reason?: 'session_evicted' | 'journal_gap' }): void;
  onGap?(info: { readonly epoch: string; readonly seq: number; readonly reason: 'journal_gap' }): void;
}

export interface GlobalRawTarget {
  send(envelope: EventEnvelope, hidden: boolean): void;
  onGap?(info: {
    readonly epoch: string;
    readonly seq: number;
    readonly sessionId?: string;
    readonly hidden: boolean;
    readonly reason: 'journal_gap';
  }): void;
}

export interface SessionSnapshotState {
  seq: number;
  epoch: string;
  attentionSeq: number;
  contextMessages: readonly ContextMessage[];
  contextMessageTimes: readonly (number | undefined)[];
  contextMessageCount: number;
  inFlightTurn: InFlightTurn | null;
  subagents: SnapshotSubagent[];
  pendingApprovals: ReturnType<typeof toWireApproval>[];
  pendingQuestions: ReturnType<typeof toWireQuestion>[];
  pendingUserTools: ReturnType<typeof toWirePendingUserTool>[];
  currentPromptId?: string;
  status?: NonNullable<ReturnType<typeof readLegacyStatus>>;
  historyPromise?: Promise<CapturedContextMessageHistory>;
}

/** Internal transport lane: only subscription traffic enters the timed buffer. */
export type BroadcastDelivery = 'subscription' | 'immediate';

/** A connection (or test double) that receives sequenced envelopes. */
export interface BroadcastTarget {
  send(envelope: EventEnvelope, delivery?: BroadcastDelivery): void;
  sendDurableCursor?(cursor: SessionCursor): void;
  sendRosterHint?(envelope: EventEnvelope): void;
  sendControl?(frame: unknown): void;
  drain?(): Promise<void>;
}

/**
 * Per-subscription agent allowlist for fine-grained v1 event delivery.
 * `undefined` (or omitted) means "receive every agent" — the legacy
 * session-grained behavior. A `ReadonlySet` restricts delivery to the listed
 * agent ids; global events ({@link isGlobalEvent}) bypass the filter entirely.
 */
export type AgentFilter = ReadonlySet<string> | undefined;

/**
 * What one connection wants from a session: two independent dimensions. The
 * legacy agent allowlist gates `session_event` delivery only; the opt-in
 * per-agent transcript grades (`Record<agentId|'*', grade>`; absent = all
 * 'off' — legacy clients see no transcript frames at all) alone decide which
 * agents' transcript frames the connection receives — the allowlist does NOT
 * gate the transcript stream.
 */
export interface TargetSubscription {
  readonly agentFilter?: AgentFilter;
  readonly transcriptGrades?: TranscriptGradeSpec;
  readonly transcriptGeneration?: number;
  readonly residencyLease?: SessionLease;
  readonly prevTranscriptSeeded?: boolean;
  readonly transcriptOnly?: boolean;
  readonly detachedTranscriptAgents?: ReadonlySet<string>;
}

export type TranscriptSince = Record<string, TranscriptCursor | number>;

interface TranscriptStream {
  readonly store: TranscriptStore;
  readonly knownAgents: Set<string>;
}

interface PendingTranscriptSeed {
  readonly generation: number;
  readonly spec: TranscriptGradeSpec;
  readonly prev?: TranscriptGradeSpec;
  readonly transcriptSince?: TranscriptSince;
  readonly store: TranscriptStore;
  readonly deferred: boolean;
  readonly delivered: Map<string, TranscriptCursor>;
  readonly diagnostics: AbortController;
  readonly timing: SessionViewTimingContext;
}

interface QueuedBackpressureState {
  count: number;
  omittedBytesAtLeast: number;
  hasAttention: boolean;
  isGlobal: boolean;
}

interface QueuedSessionTask {
  readonly run: () => Promise<void> | void;
  readonly liveBytes: number;
  readonly backpressure?: QueuedBackpressureState;
}

interface SessionState {
  readonly sessionId: string;
  readonly sessionHandle?: ISessionScopeHandle;
  readonly journal: SessionEventJournal;
  readonly tracker: InFlightTurnTracker;
  readonly roster: SubagentRosterTracker;
  mainAgent?: IAgentScopeHandle;
  contextView: { messages: readonly ContextMessage[]; revision: number };
  authoritativeContext: boolean;
  deferredWork?: SessionActivityState;
  readonly tail: SessionTailEntry[];
  tailBytes: number;
  readonly targets: Map<BroadcastTarget, TargetSubscription>;
  readonly rawTargets: Set<RawSessionTarget>;
  readonly interactionConsumers: Map<BroadcastTarget, string>;
  interactionService?: ISessionInteractionService;
  readonly taskQueue: QueuedSessionTask[];
  queuedLiveBytes: number;
  queueDrainPromise?: Promise<void>;
  readonly agentDisposables: Map<string, IDisposable>;
  readonly lifecycleDisposables: IDisposable[];
  readonly knownInteractions: Map<string, { readonly kind: InteractionKind; readonly agentId: string }>;
  transcriptStream?: TranscriptStream;
  readonly transcriptSeeded: Set<BroadcastTarget>;
  readonly transcriptGenerations: WeakMap<BroadcastTarget, number>;
  readonly pendingTranscriptSeeds: Map<BroadcastTarget, PendingTranscriptSeed>;
}

export const DEFAULT_MAX_BUFFER_SIZE = 1000;
const MAX_TAIL_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_QUEUE_LIVE_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_QUEUE_LIVE_BYTES = 64 * 1024 * 1024;
const MIN_QUEUED_TASK_BYTES = 256;
const MAX_GLOBAL_RAW_RING_BYTES = 4 * 1024 * 1024;
const GLOBAL_SESSION_ID = '__global__';
const TRANSCRIPT_RESET_TAIL_TURNS = 20;
let nextInteractionConsumerId = 0;
let processQueuedLiveBytes = 0;

function adjustQueueLiveBytes(state: SessionState, delta: number): void {
  state.queuedLiveBytes = Math.max(0, state.queuedLiveBytes + delta);
  processQueuedLiveBytes = Math.max(0, processQueuedLiveBytes + delta);
}

async function disposeSessionState(state: SessionState): Promise<void> {
  if (state.queuedLiveBytes > 0) {
    adjustQueueLiveBytes(state, -state.queuedLiveBytes);
  }
  state.taskQueue.length = 0;
  state.tail.length = 0;
  state.tailBytes = 0;
  state.contextView = { messages: [], revision: 0 };
  for (const id of state.interactionConsumers.values()) {
    state.interactionService?.releaseConsumer(id);
  }
  state.interactionConsumers.clear();
  for (const seed of state.pendingTranscriptSeeds.values()) seed.diagnostics.abort();
  for (const subscription of state.targets.values()) await subscription.residencyLease?.dispose();
  state.targets.clear();
  for (const rawTarget of Array.from(state.rawTargets)) {
    try {
      rawTarget.onEvicted?.({ epoch: state.journal.epoch, seq: state.journal.seq });
    } catch {}
  }
  state.rawTargets.clear();
  for (const d of state.lifecycleDisposables) await d.dispose();
  for (const d of state.agentDisposables.values()) await d.dispose();
  state.roster.clear(state.sessionId);
  await state.journal.close();
}

class OptionalBroadcasterExtensionPortReader {
  constructor(
    @ref(IPluginExtensionPortRegistry)
    readonly portRef: LiveRef<IPluginExtensionPortRegistry>,
  ) {}
}

function readBroadcasterExtensionPort(core: Scope): PluginExtensionBrokerHostPort | undefined {
  try {
    const instantiation = core.accessor.get(IInstantiationService);
    if (instantiation !== undefined && typeof instantiation.createInstance === 'function') {
      const reader = instantiation.createInstance<OptionalBroadcasterExtensionPortReader>(
        new SyncDescriptor(OptionalBroadcasterExtensionPortReader),
      );
      return reader.portRef.current;
    }
  } catch {
  }
  try {
    return core.accessor.get(IPluginExtensionPortRegistry);
  } catch {
    return undefined;
  }
}

export class SessionEventBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  /**
   * Every established connection, subscribed or not. Global events
   * ({@link isGlobalEvent}) fan out to this set (union the per-session
   * targets) so a freshly connected client sees session-level facts —
   * `event.session.created`, `session.meta.updated`, and every activated
   * session's `event.session.work_changed` — without subscribing to anything.
   */
  private readonly globalTargets = new Set<BroadcastTarget>();
  private readonly globalRawTargets = new Set<GlobalRawTarget>();
  private readonly knownPrivateSessionIds = new Set<string>();
  private readonly globalRawRing: Array<
    | { readonly kind: 'event'; readonly seq: number; readonly envelope: EventEnvelope; readonly hidden: boolean; readonly bytes: number }
    | { readonly kind: 'gap'; readonly seq: number; readonly sessionId?: string; readonly hidden: boolean; readonly bytes: number }
  > = [];
  private globalRawRingBytes = 0;
  private globalRawSeq = 0;
  private readonly globalRawEpoch = crypto.randomUUID();
  /**
   * Single-flight guard for session activation: without it, two concurrent
   * activations (WS subscribe racing a REST snapshot / replay / resync) each
   * built their own SessionState, bus subscriptions, and journal writer. The
   * leaked listeners all route through `onAgentEvent`, which looks up the
   * current state by session id, so they advance the SAME tracker and journal:
   * one source delta is emitted at consecutive offsets and adjacent durable
   * events receive distinct consecutive seqs. WS coalescing then folds the
   * adjacent delta copies into one doubled payload, producing the observed
   * per-chunk `AABBCC` stream while every seq and offset still looks valid.
   */
  private readonly pendingStates = new Map<string, Promise<SessionState | undefined>>();
  private readonly pendingSubscriptions = new Map<string, Map<BroadcastTarget, AbortController>>();
  /** Session ids whose closing state is being drained and disposed. */
  private readonly evictions = new Map<string, Promise<void>>();
  private readonly maxBufferSize: number;
  private readonly coreEventSubscription: IDisposable;
  private readonly sessionLifecycleSubscription: IDisposable;
  private pluginTopicSubscription?: IDisposable;
  private attachedPluginPort?: PluginExtensionBrokerHostPort;
  private readonly pluginGenerations = new Map<string, number>();
  private readonly activePruneUnlinks = new Map<string, Promise<void>>();
  private readonly watermarkIndex: JournalWatermarkIndex;
  private journalPruneTimer?: ReturnType<typeof setTimeout>;
  private journalPruneInterval?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly opts: {
      readonly eventsDir: string;
      readonly core: Scope;
      readonly logger?: JournalLogger;
      readonly maxBufferSize?: number;
      readonly transcriptService?: TranscriptService;
    },
  ) {
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.watermarkIndex = new JournalWatermarkIndex(opts.eventsDir, opts.logger);
    this.coreEventSubscription = opts.core.accessor
      .get(IEventService)
      .subscribe((event) => this.onCoreEvent(event));
    const sessionManager = opts.core.accessor.get(ISessionManager);
    const onClose = sessionManager.onDidCloseSession?.(({ sessionId }) => {
      this.scheduleSessionEviction(sessionId);
    });
    const onArchive = sessionManager.onDidArchiveSession?.(({ sessionId }) => {
      this.scheduleSessionEviction(sessionId);
    });
    const onDelete = sessionManager.onDidDeleteSession?.(({ sessionId }) => {
      this.scheduleSessionEviction(sessionId);
      this.watermarkIndex.invalidate(sessionId, 'delete');
    });
    this.sessionLifecycleSubscription = {
      dispose: () => {
        onClose?.dispose();
        onArchive?.dispose();
        onDelete?.dispose();
      },
    };
    this.syncPluginTopicSubscription();
    this.scheduleJournalPrune();
    void this.watermarkIndex.prepare().catch(() => undefined);
  }

  private scheduleJournalPrune(): void {
    const isSessionActive = (sessionId: string): boolean =>
      this.sessions.has(sessionId) || this.pendingStates.has(sessionId) || this.evictions.has(sessionId);
    const runPrune = (): void => {
      if (this.closed) return;
      void pruneExpiredEventJournals(this.opts.eventsDir, {
        isSessionActive,
        beforeUnlink: (sessionId) => {
          if (this.closed || isSessionActive(sessionId) || this.activePruneUnlinks.has(sessionId)) {
            return undefined;
          }
          this.watermarkIndex.markDirty(sessionId, 'prune');
          let release!: () => void;
          const wait = new Promise<void>((resolve) => { release = resolve; });
          this.activePruneUnlinks.set(sessionId, wait);
          return () => {
            if (this.activePruneUnlinks.get(sessionId) === wait) {
              this.activePruneUnlinks.delete(sessionId);
            }
            release();
          };
        },
        onUnlinked: (sessionId) => {
          this.watermarkIndex.recordRemoved(sessionId);
        },
        logger: this.opts.logger,
      }).catch(() => undefined);
    };
    this.journalPruneTimer = setTimeout(() => {
      this.journalPruneTimer = undefined;
      runPrune();
    }, 30_000);
    this.journalPruneTimer.unref?.();
    this.journalPruneInterval = setInterval(runPrune, 6 * 60 * 60 * 1000);
    this.journalPruneInterval.unref?.();
  }

  /**
   * Register a freshly established connection for global-event fan-out. The
   * connection receives every global event ({@link isGlobalEvent}) from this
   * point on, with no per-session subscription required. Idempotent.
   */
  addGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.add(target);
  }

  publishRoomChanged(change: {
    readonly roomId: string;
    readonly room: import('@kiki/agent-core-v2/app/room/room').RoomDocument;
    readonly entry?: import('@kiki/agent-core-v2/app/room/room').RoomLogEntry;
    readonly deleted?: boolean;
  }): void {
    const event = {
      type: 'event.room.changed' as const,
      room_id: change.roomId,
      room: change.room,
      entry: change.entry,
      deleted: change.deleted,
      agentId: 'main',
      sessionId: GLOBAL_SESSION_ID,
    };
    const envelope: EventEnvelope = {
      type: event.type,
      seq: 0,
      session_id: GLOBAL_SESSION_ID,
      timestamp: new Date().toISOString(),
      payload: event,
    };
    for (const target of this.globalTargets) {
      try {
        target.send(envelope, 'immediate');
      } catch {}
    }
  }

  publishThreadMessageDelivery(change: {
    readonly messageId: string;
    readonly sourceSessionId?: string;
    readonly targetSessionId: string;
    readonly delivery: 'delivered' | 'undeliverable';
    readonly updatedAt: number;
    readonly reason?: string;
  }): void {
    const event = {
      type: 'event.thread.message_delivery' as const,
      message_id: change.messageId,
      source_session_id: change.sourceSessionId,
      target_session_id: change.targetSessionId,
      delivery: change.delivery,
      updated_at: change.updatedAt,
      reason: change.reason,
      agentId: 'main',
      sessionId: GLOBAL_SESSION_ID,
    };
    const envelope: EventEnvelope = {
      type: event.type,
      seq: 0,
      session_id: GLOBAL_SESSION_ID,
      timestamp: new Date().toISOString(),
      payload: event,
    };
    for (const target of this.globalTargets) {
      try {
        target.send(envelope, 'immediate');
      } catch {}
    }
  }

  /** Broadcasts a global Portable Spaces invalidation signal to all connected clients. */
  publishPortableSpacesChanged(change: {
    readonly spaceId: string;
    readonly revision: number;
    readonly at: number;
    readonly reason?: 'subscribed' | 'synced' | 'updated' | 'reordered' | 'removed' | 'imported';
  }): void {
    const event = {
      type: 'event.portable_spaces.changed' as const,
      spaceId: change.spaceId,
      revision: change.revision,
      at: change.at,
      ...(change.reason !== undefined ? { reason: change.reason } : {}),
      agentId: 'main',
      sessionId: GLOBAL_SESSION_ID,
    };
    const envelope: EventEnvelope = {
      type: event.type,
      seq: 0,
      session_id: GLOBAL_SESSION_ID,
      timestamp: new Date(change.at).toISOString(),
      payload: event,
    };
    for (const target of this.globalTargets) {
      try {
        target.send(envelope, 'immediate');
      } catch {}
    }
  }

  /** Drop a closed connection from the global fan-out set. Idempotent. */
  removeGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.delete(target);
  }

  /** Register an ephemeral stateless reader for R2 `/api/events`. */
  addGlobalRawTarget(target: GlobalRawTarget): void {
    this.globalRawTargets.add(target);
  }

  /** Unregister a stateless R2 `/api/events` reader. */
  removeGlobalRawTarget(target: GlobalRawTarget): void {
    this.globalRawTargets.delete(target);
  }

  /** Replay buffered global events strictly after `cursor`, or report resync required. */
  getGlobalBufferedSince(cursor: SessionCursor, scopedSessionId?: string): BufferedSinceResult {
    const currentSeq = this.globalRawSeq;
    const epoch = this.globalRawEpoch;
    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    const oldest = this.globalRawRing[0]?.seq;
    if (oldest === undefined || oldest > cursor.seq + 1) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }
    let expected = cursor.seq + 1;
    const events: Array<{ seq: number; envelope: EventEnvelope }> = [];
    for (const item of this.globalRawRing) {
      if (item.seq <= cursor.seq) continue;
      if (item.seq > currentSeq) break;
      if (item.seq !== expected) {
        return { events: [], resyncRequired: 'journal_gap', currentSeq, epoch };
      }
      expected = item.seq + 1;
      const visible =
        scopedSessionId !== undefined
          ? (item.kind === 'event' ? item.envelope.session_id : item.sessionId) === scopedSessionId
          : !item.hidden;
      if (!visible) continue;
      if (item.kind === 'gap') {
        return { events: [], resyncRequired: 'journal_gap', currentSeq, epoch };
      }
      events.push({ seq: item.seq, envelope: item.envelope });
    }
    if (expected !== currentSeq + 1) {
      return { events: [], resyncRequired: 'journal_gap', currentSeq, epoch };
    }
    return {
      events,
      resyncRequired: false,
      currentSeq,
      epoch,
    };
  }

  /** Publish a completed work episode onto the stateless global stream. */
  publishGlobalEpisodeCompleted(episode: { readonly session_id: string; readonly episode_id: string; readonly completed_at: number }): void {
    const envelope: EventEnvelope = {
      type: 'event.session.episode_completed',
      seq: 0,
      session_id: episode.session_id,
      timestamp: new Date(episode.completed_at).toISOString(),
      payload: {
        type: 'event.session.episode_completed',
        session_id: episode.session_id,
        episode_id: episode.episode_id,
        completed_at: episode.completed_at,
      },
    };
    this.recordAndEmitGlobalRaw(envelope);
  }

  private isHiddenForPublicGlobal(sessionId: string | undefined, envelope?: EventEnvelope): boolean {
    if (sessionId === undefined || sessionId === GLOBAL_SESSION_ID || sessionId.length === 0) return false;
    const payload = envelope?.payload;
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      if (record['private'] === true || record['ephemeral'] === true) {
        this.knownPrivateSessionIds.add(sessionId);
        return true;
      }
      if (record['private'] === false) {
        this.knownPrivateSessionIds.delete(sessionId);
      }
    }
    try {
      const manager = this.opts.core.accessor.get(ISessionManager);
      if (manager.isEphemeral(sessionId)) {
        this.knownPrivateSessionIds.add(sessionId);
        return true;
      }
      const live = manager.get(sessionId);
      if (live !== undefined) {
        if (live.accessor.get(ISessionContext).ephemeral === true || live.accessor.get(ISessionMetadata).snapshot().private === true) {
          this.knownPrivateSessionIds.add(sessionId);
          return true;
        }
        this.knownPrivateSessionIds.delete(sessionId);
        return false;
      }
    } catch {
      return true;
    }
    return this.knownPrivateSessionIds.has(sessionId);
  }

  private trimGlobalRawRing(): void {
    while (
      this.globalRawRing.length > this.maxBufferSize ||
      this.globalRawRingBytes > MAX_GLOBAL_RAW_RING_BYTES
    ) {
      const dropped = this.globalRawRing.shift();
      if (dropped === undefined) break;
      this.globalRawRingBytes = Math.max(0, this.globalRawRingBytes - dropped.bytes);
    }
  }

  private recordGlobalRawGap(sessionId: string | undefined): void {
    const seq = ++this.globalRawSeq;
    const hidden = this.isHiddenForPublicGlobal(sessionId);
    const gapBytes = 128;
    this.globalRawRing.push({ kind: 'gap', seq, sessionId, hidden, bytes: gapBytes });
    this.globalRawRingBytes += gapBytes;
    this.trimGlobalRawRing();
    for (const target of this.globalRawTargets) {
      try {
        target.onGap?.({
          epoch: this.globalRawEpoch,
          seq,
          sessionId,
          hidden,
          reason: 'journal_gap',
        });
      } catch {}
    }
  }

  private recordAndEmitGlobalRaw(source: EventEnvelope): void {
    const seq = ++this.globalRawSeq;
    const envelope: EventEnvelope = {
      ...source,
      seq,
      epoch: this.globalRawEpoch,
    };
    const hidden = this.isHiddenForPublicGlobal(envelope.session_id, envelope);
    const probe = encodeJsonValueBounded(envelope, MAX_SINGLE_JOURNAL_LINE_BYTES);
    if (probe.ok) {
      this.globalRawRing.push({ kind: 'event', seq, envelope, hidden, bytes: probe.bytes });
      this.globalRawRingBytes += probe.bytes;
    } else {
      const gapBytes = 128;
      this.globalRawRing.push({ kind: 'gap', seq, sessionId: envelope.session_id, hidden, bytes: gapBytes });
      this.globalRawRingBytes += gapBytes;
    }
    this.trimGlobalRawRing();
    for (const target of this.globalRawTargets) {
      try {
        target.send(envelope, hidden);
      } catch {}
    }
  }

  /** Attach an ephemeral stateless R2 session event stream target without creating persistent subscriber state. */
  async attachRawSessionTarget(sessionId: string, target: RawSessionTarget): Promise<() => void> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) return () => {};
    state.rawTargets.add(target);
    return () => {
      state.rawTargets.delete(target);
    };
  }

  /** Publishes an ACL-scoped `event.plugin.topic` frame to authorized WebSocket targets. */
  async publishPluginTopicEvent(input: PluginPublishedWsTopicInput): Promise<boolean> {
    if (this.closed) return false;
    this.syncPluginTopicSubscription();
    const pluginKey = input.pluginId.toLowerCase();
    const generation = this.pluginGenerations.get(pluginKey) ?? 0;
    const port = readBroadcasterExtensionPort(this.opts.core);
    if (port === undefined) return false;
    const descriptor = port.resolveWsTopic?.(input.pluginId, input.topic);
    if (descriptor === undefined || descriptor.pluginId.toLowerCase() !== pluginKey) return false;

    const currentSpaceId = this.opts.core.accessor.get(IBootstrapService)?.spaceId ?? 'main';
    if (descriptor.scopeAcl === 'space') {
      const targetSpaceId = input.spaceId ?? currentSpaceId;
      if (targetSpaceId !== currentSpaceId) return false;
    }

    let workspaceId: string | undefined;
    if (descriptor.scopeAcl === 'session') {
      if (input.sessionId === undefined || input.sessionId.trim() === '') return false;
      if (input.spaceId !== undefined && input.spaceId !== currentSpaceId) return false;
      const state = this.sessions.get(input.sessionId);
      if (state === undefined || state.targets.size === 0) return false;
      workspaceId = await this.resolveSessionWorkspaceForPlugin(input.sessionId);
      if (workspaceId === undefined) return false;
    } else if (input.sessionId !== undefined) {
      workspaceId = await this.resolveSessionWorkspaceForPlugin(input.sessionId);
    }

    const allowed = await this.isPluginAllowedForTopic(input.pluginId, workspaceId, input.sessionId);
    if (!allowed || this.closed || (this.pluginGenerations.get(pluginKey) ?? 0) !== generation) {
      return false;
    }
    const rechecked = port.resolveWsTopic?.(input.pluginId, input.topic);
    if (rechecked === undefined || rechecked.pluginId.toLowerCase() !== pluginKey) return false;

    const sessionId = descriptor.scopeAcl === 'session' ? input.sessionId! : (input.sessionId ?? GLOBAL_SESSION_ID);
    const wirePayload = {
      type: 'event.plugin.topic' as const,
      plugin_id: input.pluginId,
      topic: input.topic,
      session_id: input.sessionId,
      space_id: descriptor.scopeAcl === 'space' ? (input.spaceId ?? currentSpaceId) : input.spaceId,
      payload: input.payload,
      agentId: MAIN_AGENT_ID,
      sessionId,
    };

    if (descriptor.scopeAcl === 'session') {
      const state = this.sessions.get(input.sessionId!);
      if (state === undefined || state.targets.size === 0) return false;
      const envelope: EventEnvelope = {
        type: 'event.plugin.topic',
        seq: state.journal.seq,
        epoch: state.journal.epoch,
        volatile: true,
        session_id: state.sessionId,
        timestamp: new Date().toISOString(),
        payload: wirePayload,
      };
      for (const target of state.targets.keys()) {
        try {
          target.send(envelope, 'immediate');
        } catch {}
      }
      return true;
    }

    const recipients = new Set<BroadcastTarget>(this.globalTargets);
    for (const target of this.allTargets()) recipients.add(target);
    if (recipients.size === 0) return false;
    const envelope: EventEnvelope = {
      type: 'event.plugin.topic',
      seq: 0,
      volatile: true,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload: wirePayload,
    };
    for (const target of recipients) {
      try {
        target.send(envelope, 'immediate');
      } catch {}
    }
    return true;
  }

  private syncPluginTopicSubscription(): void {
    if (this.closed) return;
    const port = readBroadcasterExtensionPort(this.opts.core);
    if (port === this.attachedPluginPort) return;
    void this.pluginTopicSubscription?.dispose();
    this.pluginTopicSubscription = undefined;
    this.attachedPluginPort = port;
    if (port?.onDidPublishWsTopicEvent !== undefined) {
      this.pluginTopicSubscription = port.onDidPublishWsTopicEvent((event) => {
        void this.publishPluginTopicEvent(event).catch((error: unknown) => {
          this.logDispatchError(event.sessionId ?? GLOBAL_SESSION_ID, 'event.plugin.topic', error);
        });
      });
    }
  }

  private bumpAllPluginGenerations(pluginId?: string): void {
    if (pluginId !== undefined && pluginId !== '') {
      const key = pluginId.toLowerCase();
      this.pluginGenerations.set(key, (this.pluginGenerations.get(key) ?? 0) + 1);
      return;
    }
    for (const [key, current] of this.pluginGenerations) {
      this.pluginGenerations.set(key, current + 1);
    }
  }

  private async resolveSessionWorkspaceForPlugin(sessionId: string): Promise<string | undefined> {
    const live = getLiveSessionById(this.opts.core.accessor, sessionId);
    if (live !== undefined) {
      try {
        const ctx = live.accessor.get(ISessionContext);
        if (ctx?.workspaceId !== undefined) return ctx.workspaceId;
      } catch {}
    }
    const summary = await this.opts.core.accessor.get(ISessionIndex)?.get(sessionId);
    return summary?.workspaceId;
  }

  private async isPluginAllowedForTopic(
    pluginId: string,
    workspaceId: string | undefined,
    sessionId: string | undefined,
  ): Promise<boolean> {
    const pluginService = this.opts.core.accessor.get(IPluginService);
    if (pluginService !== undefined) {
      const installed = await pluginService.listPlugins();
      const record = installed.find((entry) => entry.id.toLowerCase() === pluginId.toLowerCase());
      if (record === undefined || !record.enabled || record.state !== 'ok') return false;
    }
    const usage = this.opts.core.accessor.get(IPluginUsageService);
    if (usage !== undefined) {
      return usage.allows(workspaceId, pluginId, sessionId);
    }
    return true;
  }

  isSessionViewed(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.targets.size ?? 0) > 0;
  }

  /** Return live journal write/compaction/tail metrics for a resident session, if active. */
  getSessionJournalMetrics(sessionId: string): {
    readonly journal: JournalWriteStats;
    readonly tailBytes: number;
    readonly tailCount: number;
    readonly queuedLiveBytes: number;
  } | undefined {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return undefined;
    return {
      journal: state.journal.stats(),
      tailBytes: state.tailBytes,
      tailCount: state.tail.length,
      queuedLiveBytes: state.queuedLiveBytes,
    };
  }

  /** Flush the resident session's event queue and journal to disk when active. */
  async flushSessionJournal(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    await this.drainSessionQueue(state);
    await state.journal.flush();
  }

  /**
   * Subscribe a connection to a session's stream (activates the session).
   *
   * When `transcriptGrades` is present the connection also joins the
   * session's transcript stream: every already-known agent whose grade is not
   * 'off' and that is an upgrade over the connection's previous grade
   * (`needsResetOnTransition`) is seeded with a `transcript.reset` snapshot;
   * later ops arrive as `transcript.ops`. Transcript frames are ALWAYS
   * volatile (current watermark as seq, never journaled, never replayed) —
   * frame loss surfaces through the ordinary backpressure → `resync_required`
   * → REST + re-subscribe path, which resets the transcript naturally.
   */
  async subscribe(
    sessionId: string,
    target: BroadcastTarget,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
    opts?: { deferTranscriptReset?: boolean; transcriptSince?: TranscriptSince; timing?: SessionViewTimingContext; transcriptOnly?: boolean },
  ): Promise<boolean> {
    if (this.closed) return false;
    const pending = this.pendingSubscriptions.get(sessionId) ?? new Map<BroadcastTarget, AbortController>();
    this.pendingSubscriptions.set(sessionId, pending);
    pending.get(target)?.abort();
    const token = new AbortController();
    pending.set(target, token);
    const timing = { ...opts?.timing, logger: opts?.timing?.logger ?? this.opts.logger,
      signal: opts?.timing?.signal === undefined ? token.signal : AbortSignal.any([token.signal, opts.timing.signal]) };
    const fields = { sessionId, generation: timing.generation, viewId: timing.viewId };
    let acquiredLease: SessionLease | undefined;
    let attached: { state: SessionState; generation: number; prev: TargetSubscription | undefined; prevSeeded: boolean } | undefined;
    const coldPreEmitAbort = new AbortController();
    try {
      const pinnedState = this.sessions.get(sessionId);
      const existingLease = pinnedState?.targets.get(target)?.residencyLease;
      const manager = this.opts.core.accessor.get(ISessionManager);
      const service = this.opts.transcriptService;
      if (
        pinnedState === undefined &&
        existingLease === undefined &&
        transcriptGrades !== undefined &&
        opts?.deferTranscriptReset !== true &&
        opts?.transcriptSince === undefined &&
        service !== undefined &&
        typeof service.readColdPageSnapshot === 'function'
      ) {
        const preEmitSignal = AbortSignal.any([timing.signal, coldPreEmitAbort.signal]);
        for (const [agentId, grade] of Object.entries(transcriptGrades)) {
          if (agentId === '*' || (grade !== 'delta' && grade !== 'block')) continue;
          void service
            .readColdPageSnapshot(sessionId, agentId, (snapshot) => snapshot, preEmitSignal, false, undefined, false, true)
            .then((rawSnapshot) => {
              if (
                rawSnapshot === undefined ||
                preEmitSignal.aborted ||
                this.closed ||
                pending.get(target) !== token
              ) {
                return;
              }
              const redacted = boundedTranscriptSnapshot(redactSnapshotForGrade(grade, rawSnapshot), agentId);
              const snapshot = { ...redacted, toolCallCount: undefined, toolCallCountKnown: false, hasMoreOlder: true };
              const coverage = { kind: 'unknown' as const, hasMoreOlder: true as const };
              const cursor: TranscriptCursor = { epoch: 'cold', seq: 0 };
              try {
                target.send({
                  type: 'transcript.reset',
                  seq: 0,
                  epoch: 'cold',
                  volatile: true,
                  session_id: sessionId,
                  timestamp: new Date().toISOString(),
                  payload: {
                    type: 'transcript.reset',
                    session_id: sessionId,
                    agent_id: agentId,
                    snapshot: { ...snapshot, olderCursor: sessionViewSnapshotHistoryCursor(snapshot, agentId, 'derived', cursor.epoch) },
                    grade,
                    coverage,
                    cursor,
                    read: transcriptReadForCoverage('cold', coverage, { transcript: cursor }),
                  },
                });
              } catch {
              }
            })
            .catch(() => undefined);
        }
      }
      if (existingLease === undefined) {
        acquiredLease = await timeSessionViewPhase('subscription_acquire', fields,
          async () => manager.acquire?.(sessionId, 'ws-subscription', undefined, token.signal), timing);
        if (manager.acquire !== undefined && acquiredLease === undefined) return false;
      }
      coldPreEmitAbort.abort();
      if (this.closed || pending.get(target) !== token) return false;
      const state = await timeSessionViewPhase('subscription_state', fields, () => this.ensureState(sessionId), timing);
      if (state === undefined || this.closed || pending.get(target) !== token ||
          this.sessions.get(sessionId) !== state ||
          (existingLease !== undefined && state !== pinnedState)) return false;
      const prev = state.targets.get(target);
      const prevSeeded = state.transcriptSeeded.has(target);
      const prevSeed = state.pendingTranscriptSeeds.get(target);
      const prevSeedStore = prevSeed?.store;
      const prevSeedSpec = prevSeed?.spec;
      const prevSeedDelivered = prevSeed !== undefined ? new Map(prevSeed.delivered) : undefined;
      const residencyLease = prev?.residencyLease ?? acquiredLease;
      if (residencyLease !== undefined &&
          (state.sessionHandle !== residencyLease.handle ||
           manager.get(sessionId) !== residencyLease.handle)) return false;
      if (prev === undefined && state.interactionService !== undefined) {
        const consumerId = `kap-ws:${sessionId}:${nextInteractionConsumerId++}`;
        state.interactionService.acquireConsumer(consumerId);
        state.interactionConsumers.set(target, consumerId);
      }
      const generation = this.nextTranscriptGeneration(state, target);
      if (prev?.residencyLease !== undefined) await acquiredLease?.dispose();
      acquiredLease = undefined;
      const nextTranscriptOnly = opts?.transcriptOnly ?? (prev?.transcriptOnly === true && filter === undefined);
      let nextDetached: Set<string> | undefined;
      if (nextTranscriptOnly && prev?.detachedTranscriptAgents !== undefined && prev.detachedTranscriptAgents.size > 0) {
        nextDetached = new Set<string>();
        for (const id of prev.detachedTranscriptAgents) {
          if (transcriptGrades === undefined || gradeFor(transcriptGrades, id) === 'off') {
            nextDetached.add(id);
          }
        }
        if (nextDetached.size === 0) nextDetached = undefined;
      }
      state.targets.set(target, {
        agentFilter: filter,
        transcriptGrades,
        transcriptGeneration: generation,
        residencyLease,
        prevTranscriptSeeded: prevSeeded,
        transcriptOnly: nextTranscriptOnly,
        detachedTranscriptAgents: nextDetached,
      });
      attached = { state, generation, prev, prevSeeded };
      if (transcriptGrades === undefined) {
        state.transcriptSeeded.delete(target);
        return true;
      }
      const deferred = opts?.deferTranscriptReset === true;
      const liveStore = this.opts.transcriptService?.forSessionLive(sessionId, { tailFirst: true });
      const streamChanged = liveStore !== undefined && state.transcriptStream?.store !== liveStore;
      const needsSeed =
        deferred ||
        streamChanged ||
        opts?.transcriptSince !== undefined ||
        !state.transcriptSeeded.has(target) ||
        this.willSendTranscriptReset(state, transcriptGrades, prev);
      if (!needsSeed) return true;
      const hadBaseline = state.transcriptSeeded.has(target);
      state.transcriptSeeded.delete(target);
      if (liveStore === undefined) return true;
      const delivered = new Map<string, TranscriptCursor>();
      if (!deferred && !streamChanged && opts?.transcriptSince === undefined && service !== undefined) {
        if (hadBaseline && prev?.transcriptGrades !== undefined) {
          for (const { agentId } of liveStore.agents()) {
            const nextGrade = gradeFor(transcriptGrades, agentId);
            if (nextGrade === 'off') continue;
            if (!needsResetOnTransition(gradeFor(prev.transcriptGrades, agentId), nextGrade)) {
              delivered.set(agentId, service.getTranscriptCursor(sessionId, agentId));
            }
          }
        } else if (prevSeedDelivered !== undefined && prevSeedStore === liveStore && prevSeedSpec !== undefined) {
          for (const [agentId, prevCursor] of prevSeedDelivered) {
            const nextGrade = gradeFor(transcriptGrades, agentId);
            if (nextGrade === 'off') continue;
            if (needsResetOnTransition(gradeFor(prevSeedSpec, agentId), nextGrade)) continue;
            const currentCursor = service.getTranscriptCursor(sessionId, agentId);
            if (currentCursor.seq === prevCursor.seq && currentCursor.epoch === prevCursor.epoch) {
              delivered.set(agentId, prevCursor);
            }
          }
        }
      }
      const diagnostics = new AbortController();
      const seed: PendingTranscriptSeed = {
        generation,
        spec: transcriptGrades,
        prev: streamChanged || !hadBaseline ? undefined : prev?.transcriptGrades,
        transcriptSince: opts?.transcriptSince,
        store: liveStore,
        deferred,
        delivered,
        diagnostics,
        timing: { ...timing, signal: AbortSignal.any([timing.signal, diagnostics.signal]) },
      };
      state.pendingTranscriptSeeds.set(target, seed);
      if (!deferred) await this.runTranscriptSeed(state, target, seed);
      return true;
    } catch (error) {
      if (token.signal.aborted && (this.closed || pending.get(target) !== token)) return false;
      if (attached !== undefined && pending.get(target) === token &&
          this.sessions.get(sessionId) === attached.state &&
          attached.state.targets.get(target)?.transcriptGeneration === attached.generation) {
        if (attached.prev === undefined) {
          this.unsubscribe(sessionId, target);
        } else {
          const restoredGeneration = this.nextTranscriptGeneration(attached.state, target);
          attached.state.targets.set(target, {
            agentFilter: attached.prev.agentFilter,
            transcriptGrades: attached.prev.transcriptGrades,
            transcriptGeneration: restoredGeneration,
            residencyLease: attached.prev.residencyLease,
            transcriptOnly: attached.prev.transcriptOnly,
            detachedTranscriptAgents: attached.prev.detachedTranscriptAgents,
          });
          if (attached.prevSeeded) attached.state.transcriptSeeded.add(target);
          else attached.state.transcriptSeeded.delete(target);
        }
      }
      throw error;
    } finally {
      coldPreEmitAbort.abort();
      await acquiredLease?.dispose();
      if (pending.get(target) === token) pending.delete(target);
      if (pending.size === 0 && this.pendingSubscriptions.get(sessionId) === pending) {
        this.pendingSubscriptions.delete(sessionId);
      }
    }
  }

  private nextTranscriptGeneration(state: SessionState, target: BroadcastTarget): number {
    state.pendingTranscriptSeeds.get(target)?.diagnostics.abort();
    state.pendingTranscriptSeeds.delete(target);
    const generation = (state.transcriptGenerations.get(target) ?? 0) + 1;
    state.transcriptGenerations.set(target, generation);
    return generation;
  }

  private isTranscriptGeneration(
    state: SessionState,
    target: BroadcastTarget,
    generation: number,
  ): boolean {
    return (
      state.transcriptGenerations.get(target) === generation &&
      state.targets.get(target)?.transcriptGeneration === generation
    );
  }

  /**
   * Whether `subscribeTranscript` will send at least one reset for this
   * (target, spec) pair right now — an upgrade over the previous grades.
   */
  private willSendTranscriptReset(
    state: SessionState,
    spec: TranscriptGradeSpec,
    prev: TargetSubscription | undefined,
  ): boolean {
    const service = this.opts.transcriptService;
    if (service === undefined) return false;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return false;
    for (const descriptor of store.agents()) {
      const grade = gradeFor(spec, descriptor.agentId);
      if (grade === 'off') continue;
      if (
        Object.hasOwn(spec, descriptor.agentId) &&
        store.getAgent(descriptor.agentId) === undefined
      ) {
        return true;
      }
      if (needsResetOnTransition(gradeFor(prev?.transcriptGrades, descriptor.agentId), grade)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Send the transcript baseline deferred by `subscribe(deferTranscriptReset)`
   * — callers run it after their cursor replay so the reset never lands ahead
   * of the replayed (lower-seq) backlog. The baseline is forced for every
   * admitted agent: volatile ops fanned out while the target sat unseeded
   * were dropped, so a full reset closes that gap unless a covered cursor
   * permits replay. A grade upgrade still requires a reset because the
   * cursor does not cover detail redacted by the previous grade.
   */
  async flushTranscriptSeed(sessionId: string, target: BroadcastTarget): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const seed = state.pendingTranscriptSeeds.get(target);
    if (seed === undefined || !seed.deferred) return;
    await this.runTranscriptSeed(state, target, seed);
  }

  restoreSubscription(
    sessionId: string,
    target: BroadcastTarget,
    prior: { readonly agentFilter?: AgentFilter; readonly transcriptGrades?: TranscriptGradeSpec } | undefined,
  ): void {
    if (prior === undefined) {
      this.unsubscribe(sessionId, target);
      return;
    }
    const state = this.sessions.get(sessionId);
    const current = state?.targets.get(target);
    if (state === undefined || current === undefined) return;
    const restoredGeneration = this.nextTranscriptGeneration(state, target);
    state.targets.set(target, {
      agentFilter: prior.agentFilter,
      transcriptGrades: prior.transcriptGrades,
      transcriptGeneration: restoredGeneration,
      residencyLease: current.residencyLease,
      transcriptOnly: current.transcriptOnly,
      detachedTranscriptAgents: current.detachedTranscriptAgents,
    });
    if (prior.transcriptGrades !== undefined && current.prevTranscriptSeeded === true) {
      state.transcriptSeeded.add(target);
    } else {
      state.transcriptSeeded.delete(target);
    }
  }

  unsubscribe(sessionId: string, target: BroadcastTarget): void {
    const pending = this.pendingSubscriptions.get(sessionId);
    pending?.get(target)?.abort();
    pending?.delete(target);
    if (pending?.size === 0) this.pendingSubscriptions.delete(sessionId);
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    this.nextTranscriptGeneration(state, target);
    const residencyLease = state.targets.get(target)?.residencyLease;
    if (residencyLease !== undefined) {
      this.enqueueStateTask(state, async () => { await residencyLease.dispose(); });
    }
    state.targets.delete(target);
    const consumerId = state.interactionConsumers.get(target);
    if (consumerId !== undefined) {
      state.interactionConsumers.delete(target);
      state.interactionService?.releaseConsumer(consumerId);
    }
    state.transcriptSeeded.delete(target);
  }

  /**
   * Detach one connection's transcript grade stream — agent-grained. With
   * `agentIds`, only the listed agents drop to an explicit 'off' (a listed
   * '*' removes the wildcard default); without it, the whole stream goes.
   * Non-activating and idempotent: unknown sessions/targets are no-ops. A
   * detached agent stops streaming on the next ops batch and its legacy
   * session_events resume automatically (both paths re-read the per-agent
   * grade); when no non-'off' grade remains the spec collapses to
   * `undefined`, the seeded/deferred baselines are dropped, and any in-flight
   * `subscribeTranscript` aborts on its grade re-read.
   */
  unsubscribeTranscript(
    sessionId: string,
    target: BroadcastTarget,
    agentIds?: readonly string[],
  ): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const sub = state.targets.get(target);
    if (sub === undefined) return;
    const wasSeeded = state.transcriptSeeded.has(target);
    const next =
      agentIds === undefined ? undefined : detachGrades(sub.transcriptGrades, agentIds);
    const generation = this.nextTranscriptGeneration(state, target);
    let detachedTranscriptAgents: ReadonlySet<string> | undefined;
    if (next !== undefined && sub.transcriptOnly === true) {
      const merged = new Set<string>(sub.detachedTranscriptAgents);
      for (const id of agentIds ?? []) {
        if (id !== '*') merged.add(id);
      }
      if (merged.size > 0) detachedTranscriptAgents = merged;
    }
    state.targets.set(target, {
      agentFilter: sub.agentFilter,
      transcriptGrades: next,
      transcriptGeneration: generation,
      residencyLease: sub.residencyLease,
      transcriptOnly: next === undefined ? false : sub.transcriptOnly,
      detachedTranscriptAgents,
    });
    if (next === undefined || !wasSeeded) state.transcriptSeeded.delete(target);
  }

  private async runTranscriptSeed(
    state: SessionState,
    target: BroadcastTarget,
    seed: PendingTranscriptSeed,
  ): Promise<void> {
    const service = this.opts.transcriptService;
    const startedAt = performance.now();
    const admitted = admittedForHistory(seed);
    const priority = new Set(Object.keys(seed.spec).filter((agentId) => agentId !== '*' &&
      !seed.delivered.has(agentId) &&
      (gradeFor(seed.spec, agentId) === 'block' || gradeFor(seed.spec, agentId) === 'delta')));
    const timing = seed.timing;
    const fields = { sessionId: state.sessionId, generation: timing.generation,
      transcriptGeneration: seed.generation, viewId: timing.viewId,
      admittedAgents: admitted.size, priorityAgents: priority.size };
    let firstDetail = false;
    let stopped = false;
    try {
      if (service === undefined) return;
      const current = () => !stopped && this.isTranscriptGeneration(state, target, seed.generation) &&
        service.forSessionLive(state.sessionId) === seed.store;
      if (!current()) return;
      const ensureHistory = async (agentId: string): Promise<AgentTranscript | undefined> => {
        if (!admitted.has(agentId)) return seed.store.getAgent(agentId);
        const transcript = await timeSessionViewPhase('agent_backfill', { ...fields, agentId },
          () => service.ensureAgentHistory(state.sessionId, agentId, { tailFirst: true, signal: timing.signal }), timing);
        admitted.delete(agentId);
        return transcript;
      };
      this.ensureTranscriptStream(state, seed.store);
      const delivered = seed.delivered;
      let sliceStart = performance.now();
      const yieldIfNeeded = async (): Promise<void> => {
        if (performance.now() - sliceStart >= 8) {
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          sliceStart = performance.now();
        }
      };
      const deliverAgent = async (agentId: string): Promise<boolean> => {
        await yieldIfNeeded();
        if (!current()) return false;
        const currentSpec = state.targets.get(target)?.transcriptGrades;
        if (currentSpec === undefined) return false;
        const grade = gradeFor(currentSpec, agentId);
        if (grade === 'off') return true;
        const alreadyDelivered = delivered.get(agentId);
        if (alreadyDelivered !== undefined) {
          const liveCursor = service.getTranscriptCursor(state.sessionId, agentId);
          if (alreadyDelivered.seq === liveCursor.seq && alreadyDelivered.epoch === liveCursor.epoch) {
            return true;
          }
        }
        if (!admitted.has(agentId) && seed.store.getAgent(agentId) === undefined) return true;
        let rawTranscript: AgentTranscript | undefined;
        let historyLoaded = false;
        const loadTranscript = async (): Promise<AgentTranscript | undefined> => {
          if (!historyLoaded) {
            rawTranscript = await ensureHistory(agentId);
            historyLoaded = true;
          }
          return rawTranscript;
        };
        const resolveResetBaseline = async (
          transcript: AgentTranscript,
        ): Promise<{ readonly transcript: AgentTranscript; readonly cursor: TranscriptCursor }> => resolveFreshTailResetBaseline(
          service,
          state.sessionId,
          agentId,
          transcript,
          timing.signal,
        );
        let sent = delivered.get(agentId);
        for (;;) {
          await yieldIfNeeded();
          if (!current()) return false;
          const cursor = service.getTranscriptCursor(state.sessionId, agentId);
          if (sent !== undefined && sent.seq === cursor.seq && sent.epoch === cursor.epoch) {
            delivered.set(agentId, sent);
            return true;
          }
          delivered.delete(agentId);
          const since = sent ?? seed.transcriptSince?.[agentId] ?? seed.transcriptSince?.['*'];
          const gradeUpgrade = needsResetOnTransition(gradeFor(seed.prev, agentId), grade);
          const needsReset = seed.deferred || gradeUpgrade;
          const detailBaselineRequired = sent === undefined && gradeUpgrade &&
            (seed.prev !== undefined || grade === 'block' || grade === 'delta');
          const catchup = since === undefined || detailBaselineRequired || seed.store.getAgent(agentId) === undefined
            ? undefined
            : service.getOpsSince(state.sessionId, agentId, since);
          if (catchup?.complete === true) {
            const visible = catchup.batches
              .map((batch) => ({ ...batch, ops: filterOpsForGrade(grade, batch.ops) }))
              .filter((batch) => batch.ops.length > 0);
            let fallbackToReset = false;
            for (let index = 0; index < visible.length; index += 1) {
              await yieldIfNeeded();
              if (!current()) return false;
              const batch = visible[index]!;
              const outcome = this.sendTranscriptOpsInternal(
                state, target, agentId, grade, batch.ops,
                { epoch: catchup.epoch, seq: batch.seq },
                index === visible.length - 1 ? catchup.throughSeq : batch.seq,
                seed.generation,
                true,
              );
              if (outcome === 'failed') return false;
              if (outcome === 'needs_async_reset') {
                fallbackToReset = true;
                break;
              }
              if (((index + 1) & 31) === 0) await target.drain?.();
            }
            if (!fallbackToReset && visible.length > 0) {
              await target.drain?.();
            }
            if (fallbackToReset) {
              const transcript = await loadTranscript();
              if (!current()) return false;
              if (transcript === undefined) return true;
              const baseline = await resolveResetBaseline(transcript);
              if (!current()) return false;
              if (!this.sendTranscriptReset(state, target, baseline.transcript, grade, baseline.cursor, seed.generation)) return false;
              await timeSessionViewPhase('agent_drain', { ...fields, agentId }, async () => target.drain?.(), timing);
              sent = baseline.cursor;
            } else {
              sent = { seq: catchup.throughSeq, epoch: catchup.epoch };
            }
          } else if (since !== undefined || needsReset) {
            const transcript = await loadTranscript();
            if (!current()) return false;
            if (transcript === undefined) return true;
            const baseline = await resolveResetBaseline(transcript);
            if (!current()) return false;
            if (!this.sendTranscriptReset(state, target, baseline.transcript, grade, baseline.cursor, seed.generation)) return false;
            await timeSessionViewPhase('agent_drain', { ...fields, agentId }, async () => target.drain?.(), timing);
            if (!firstDetail && priority.has(agentId)) {
              firstDetail = true;
              recordSessionViewTiming('first_detail_reset', startedAt, { ...fields, agentId }, timing);
            }
            sent = baseline.cursor;
          } else {
            sent = cursor;
          }
        }
      };
      await timeSessionViewPhase('seed_drain', fields, async () => target.drain?.(), timing);
      const isUrgentSubagent = (agentId: string): boolean => agentId !== 'main' && (
        seed.transcriptSince?.[agentId] === undefined ||
        needsResetOnTransition(gradeFor(seed.prev, agentId), gradeFor(seed.spec, agentId))
      );
      const orderedPriority = [...priority].toSorted((left, right) => Number(isUrgentSubagent(right)) - Number(isUrgentSubagent(left)));
      await Promise.all(orderedPriority.map(async (agentId) => {
        if (!await deliverAgent(agentId)) {
          stopped = true;
          delivered.clear();
        }
      }));
      for (;;) {
        await yieldIfNeeded();
        if (!current()) return;
        const agents = [...new Set([...seed.store.agents().map((descriptor) => descriptor.agentId),
          ...Object.keys(seed.spec).filter((agentId) => agentId !== '*')])]
          .toSorted((left, right) => Number(priority.has(right)) - Number(priority.has(left)));
        for (const agentId of agents) {
          await yieldIfNeeded();
          if (!await deliverAgent(agentId)) return;
        }
        if (!current()) return;
        const currentSpec = state.targets.get(target)?.transcriptGrades;
        let caughtUp = true;
        for (const { agentId } of seed.store.agents()) {
          if (gradeFor(currentSpec, agentId) === 'off' || seed.store.getAgent(agentId) === undefined) continue;
          const currentCursor = service.getTranscriptCursor(state.sessionId, agentId);
          const sent = delivered.get(agentId);
          if (sent?.seq !== currentCursor.seq || sent?.epoch !== currentCursor.epoch) {
            caughtUp = false;
            break;
          }
        }
        if (caughtUp) {
          state.transcriptSeeded.add(target);
          recordSessionViewTiming('seed_ready', startedAt, fields, timing);
          break;
        }
      }
    } finally {
      stopped = true;
      seed.diagnostics.abort();
      seed.delivered.clear();
      if (state.pendingTranscriptSeeds.get(target) === seed) {
        state.pendingTranscriptSeeds.delete(target);
      }
    }
  }

  private hasTranscriptBaseline(state: SessionState, target: BroadcastTarget, agentId: string): boolean {
    if (state.transcriptSeeded.has(target)) return true;
    const seed = state.pendingTranscriptSeeds.get(target);
    return seed !== undefined && this.isTranscriptGeneration(state, target, seed.generation) &&
      state.transcriptStream?.store === seed.store && seed.delivered.has(agentId);
  }

  private sendTranscriptOps(
    state: SessionState,
    target: BroadcastTarget,
    agentId: string,
    grade: TranscriptGrade,
    ops: readonly TranscriptOperation[],
    cursor: TranscriptCursor,
    throughSeq: number,
    generation?: number,
  ): boolean {
    return this.sendTranscriptOpsInternal(state, target, agentId, grade, ops, cursor, throughSeq, generation, false) === 'sent';
  }

  private sendTranscriptOpsInternal(
    state: SessionState,
    target: BroadcastTarget,
    agentId: string,
    grade: TranscriptGrade,
    ops: readonly TranscriptOperation[],
    cursor: TranscriptCursor,
    throughSeq: number,
    generation: number | undefined,
    deferEvictedTailReset: boolean,
  ): 'sent' | 'failed' | 'needs_async_reset' {
    const transcript = this.opts.transcriptService?.forSessionLive(state.sessionId)?.getAgent(agentId);
    if (transcript === undefined) return 'failed';
    const filtered = boundedTranscriptOps(filterOpsForGrade(grade, ops), transcript);
    if (filtered.length === 0) return 'sent';
    const envelope = this.buildTranscriptEnvelope(state, 'transcript.ops', {
      session_id: state.sessionId, agent_id: agentId, ops: filtered, cursor, through_seq: throughSeq,
    });
    const needsWindowSizeCheck = filtered.length > 8 || filtered.some((op) => op.op === 'reset' || op.op === 'turn.upsert');
    if (needsWindowSizeCheck && jsonBytes(envelope) > TRANSCRIPT_WINDOW_BYTES) {
      if (grade === 'off') return 'sent';
      if (transcript.hasEvictedTail) {
        if (deferEvictedTailReset) return 'needs_async_reset';
        this.sendLiveTranscriptReset(state, target, transcript, grade, generation);
        return 'sent';
      }
      const current = this.opts.transcriptService!.getTranscriptCursor(state.sessionId, agentId);
      return this.sendTranscriptReset(state, target, transcript, grade, current, generation) ? 'sent' : 'failed';
    }
    return this.sendTranscriptEnvelope(state, target, envelope, generation) ? 'sent' : 'failed';
  }

  private sendTranscriptEnvelope(
    state: SessionState,
    target: BroadcastTarget,
    envelope: EventEnvelope,
    generation?: number,
  ): boolean {
    try {
      target.send(envelope);
    } catch (error) {
      this.opts.logger?.warn(
        { sessionId: state.sessionId, eventType: envelope.type, err: error },
        'transcript frame send failed',
      );
      if (
        generation !== undefined &&
        this.isTranscriptGeneration(state, target, generation)
      ) {
        state.transcriptSeeded.delete(target);
      }
      return false;
    }
    return true;
  }

  /**
   * Attach the session's shared transcript fan-out: one mapped-ops
   * subscription for the whole session (grade filtering happens per target at
   * fan-out). New agents appearing later seed a `transcript.reset` for every
   * connected target whose grade admits them. The attachment is pinned to the
   * store instance: when the engine session closes, the service drops the
   * store together with its ops listener set while this session state
   * survives, so a subscribe after an in-daemon session resume must
   * re-register the fan-out against the rebuilt store — returning early on
   * any stale stream would deliver resets but never the live ops.
   */
  private ensureTranscriptStream(state: SessionState, store: TranscriptStore): void {
    if (state.transcriptStream?.store === store) return;
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const stream: TranscriptStream = {
      store,
      knownAgents: new Set(
        store
          .agents()
          .map((d) => d.agentId)
          .filter((agentId) => store.getAgent(agentId) !== undefined),
      ),
    };
    state.transcriptStream = stream;

    const opsDisposable = service.onSessionOps(
      state.sessionId,
      ({ agentId, ops }, cursor) => {
        for (const [target, sub] of state.targets) {
          const grade = gradeFor(sub.transcriptGrades, agentId);
          if (grade === 'off') continue;
          if (!this.hasTranscriptBaseline(state, target, agentId)) continue;
          const seed = state.pendingTranscriptSeeds.get(target);
          const through = seed?.delivered.get(agentId);
          if (!state.transcriptSeeded.has(target) && (through === undefined ||
              through.epoch !== cursor.epoch || cursor.seq !== through.seq + 1)) continue;
          const sent = this.sendTranscriptOps(
            state,
            target,
            agentId,
            grade,
            ops,
            cursor,
            cursor.seq,
            sub.transcriptGeneration,
          );
          if (seed !== undefined && seed.generation === sub.transcriptGeneration && through !== undefined) {
            if (sent) seed.delivered.set(agentId, cursor);
            else seed.delivered.delete(agentId);
          }
        }
      },
    );
    if (opsDisposable !== undefined) state.lifecycleDisposables.push(opsDisposable);

    state.lifecycleDisposables.push(
      store.onRosterChange((agents) => {
        const hasSubscribers = state.targets.size > 0;
        for (const descriptor of agents) {
          if (stream.knownAgents.has(descriptor.agentId)) continue;
          const transcript = store.getAgent(descriptor.agentId);
          if (transcript === undefined) continue;
          stream.knownAgents.add(descriptor.agentId);
          if (!hasSubscribers) continue;
          for (const [target, sub] of state.targets) {
            if (!this.hasTranscriptBaseline(state, target, descriptor.agentId)) continue;
            const grade = gradeFor(sub.transcriptGrades, descriptor.agentId);
            if (grade === 'off') continue;
            this.sendLiveTranscriptReset(state, target, transcript, grade, sub.transcriptGeneration);
          }
        }
      }),
    );
  }

  private sendLiveTranscriptReset(
    state: SessionState,
    target: BroadcastTarget,
    transcript: AgentTranscript,
    grade: Exclude<TranscriptGrade, 'off'>,
    generation?: number,
  ): void {
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const isCurrentTarget = (): boolean => {
      if (generation !== undefined && !this.isTranscriptGeneration(state, target, generation)) return false;
      if (generation === undefined && !state.targets.has(target)) return false;
      if (service.forSessionLive(state.sessionId)?.getAgent(transcript.agentId) !== transcript) return false;
      return this.hasTranscriptBaseline(state, target, transcript.agentId);
    };
    const deliverResolved = (resolved: AgentTranscript, cursor: TranscriptCursor): void => {
      if (!isCurrentTarget()) return;
      const seed = state.pendingTranscriptSeeds.get(target);
      const sent = this.sendTranscriptReset(state, target, resolved, grade, cursor, generation);
      if (seed?.delivered.has(transcript.agentId)) {
        if (sent) seed.delivered.set(transcript.agentId, cursor);
        else seed.delivered.delete(transcript.agentId);
      }
      if (!sent) return;
      const liveCursor = service.getTranscriptCursor(state.sessionId, transcript.agentId);
      if (liveCursor.seq === cursor.seq && liveCursor.epoch === cursor.epoch) return;
      const catchup = service.getOpsSince(state.sessionId, transcript.agentId, cursor);
      if (catchup?.complete !== true) return;
      const visible = catchup.batches
        .map((batch) => ({ ...batch, ops: filterOpsForGrade(grade, batch.ops) }))
        .filter((batch) => batch.ops.length > 0);
      for (let index = 0; index < visible.length; index += 1) {
        const batch = visible[index]!;
        if (!this.sendTranscriptOps(
          state,
          target,
          transcript.agentId,
          grade,
          batch.ops,
          { epoch: catchup.epoch, seq: batch.seq },
          index === visible.length - 1 ? catchup.throughSeq : batch.seq,
          generation,
        )) return;
      }
      if (seed?.delivered.has(transcript.agentId)) {
        seed.delivered.set(transcript.agentId, { epoch: catchup.epoch, seq: catchup.throughSeq });
      }
    };
    if (!transcript.hasEvictedTail) {
      deliverResolved(transcript, service.getTranscriptCursor(state.sessionId, transcript.agentId));
      return;
    }
    void resolveFreshTailResetBaseline(service, state.sessionId, transcript.agentId, transcript)
      .then((baseline) => {
        deliverResolved(baseline.transcript, baseline.cursor);
      })
      .catch((error: unknown) => {
        this.opts.logger?.warn(
          { sessionId: state.sessionId, agentId: transcript.agentId, err: String(error) },
          'fresh tail transcript reset failed; requesting client resync',
        );
        if (!isCurrentTarget()) return;
        const seed = state.pendingTranscriptSeeds.get(target);
        seed?.delivered.delete(transcript.agentId);
        try {
          target.sendControl?.(buildResyncRequired(state.sessionId, 'journal_gap', state.journal.seq, state.journal.epoch));
        } catch {
          return;
        }
      });
  }

  /**
   * Volatile `transcript.reset` baseline: the newest 20 turns plus global
   * state, redacted to the target's grade, plus the seq watermark. Older
   * history pages in over REST; live ops stream from the watermark.
   */
  private sendTranscriptReset(
    state: SessionState,
    target: BroadcastTarget,
    transcript: AgentTranscript,
    grade: Exclude<TranscriptGrade, 'off'>,
    cursor: TranscriptCursor,
    generation?: number,
  ): boolean {
    const redacted = boundedTranscriptSnapshot(redactSnapshotForGrade(grade, transcript.snapshot({ tailTurns: TRANSCRIPT_RESET_TAIL_TURNS })), transcript.agentId);
    const liveVerified = this.opts.transcriptService?.isTranscriptLiveCoverageVerified(state.sessionId, transcript.agentId) === true;
    const snapshot = liveVerified && redacted.toolCallCountKnown !== false ? redacted
      : { ...redacted, toolCallCount: undefined, toolCallCountKnown: false, hasMoreOlder: true };
    const turns = snapshot.items.filter((item) => item.kind === 'turn');
    const hasMoreOlder = snapshot.hasMoreOlder ?? false;
    const coverage = snapshot.toolCallCountKnown === false
      ? { kind: 'unknown' as const, hasMoreOlder: true as const }
      : hasMoreOlder
        ? {
            kind: 'tail' as const,
            fromTurnId: turns[0]?.turnId,
            throughTurnId: turns.at(-1)?.turnId,
            hasMoreOlder,
          }
        : { kind: 'full' as const, hasMoreOlder: false as const };
    return this.sendTranscriptEnvelope(
      state,
      target,
      this.buildTranscriptEnvelope(state, 'transcript.reset', {
        session_id: state.sessionId,
        agent_id: transcript.agentId,
        snapshot: { ...snapshot, olderCursor: sessionViewSnapshotHistoryCursor(snapshot, transcript.agentId, 'derived', cursor.epoch) },
        grade,
        coverage,
        cursor,
        read: transcriptReadForCoverage('live', coverage, { transcript: cursor }),
      }),
      generation,
    );
  }

  /**
   * All transcript frames are volatile and carry the current durable watermark
   * as `seq` (they never advance it and are never journaled or replayed). The
   * payload is the flat protocol event (`{ type, agent_id, … }`), matching the
   * `transcriptResetEventSchema` / `transcriptOpsEventSchema` shapes.
   */
  private buildTranscriptEnvelope(
    state: SessionState,
    type: 'transcript.reset' | 'transcript.ops',
    payload: Omit<TranscriptResetEvent, 'type'> | Omit<TranscriptOpsEvent, 'type'>,
  ): EventEnvelope {
    return {
      type,
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      volatile: true,
      session_id: state.sessionId,
      timestamp: new Date().toISOString(),
      payload: { type, ...payload },
    };
  }

  async getBufferedSince(
    sessionId: string,
    cursor: SessionCursor,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
    transcriptOnly = false,
    detachedTranscriptAgents?: ReadonlySet<string>,
    options?: { readonly wantsRosterHints?: boolean },
  ): Promise<BufferedSinceResult> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      return { events: [], resyncRequired: 'session_recreated', currentSeq: 0, epoch: '' };
    }
    await this.drainSessionQueue(state);
    const { journal, tail } = state;
    const currentSeq = journal.seq;
    const { epoch } = journal;

    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this.maxBufferSize) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }

    let covered = collectContiguousTailRange(tail, cursor.seq, currentSeq, epoch, sessionId);
    if (covered === undefined) {
      const fromDisk = await journal.readRecordsSince(cursor.seq, currentSeq, this.maxBufferSize);
      if (!fromDisk.healthy || !fromDisk.headerEpochValid || fromDisk.epoch !== epoch) {
        return { events: [], resyncRequired: 'journal_gap', currentSeq, epoch };
      }
      covered = collectContiguousDiskRange(fromDisk.records, cursor.seq, currentSeq, epoch, sessionId);
      if (covered === undefined) {
        return { events: [], resyncRequired: 'journal_gap', currentSeq, epoch };
      }
    }

    const verdict = judgeReplayVisibility(
      covered,
      sessionId,
      epoch,
      filter,
      transcriptGrades,
      transcriptOnly,
      detachedTranscriptAgents,
      options?.wantsRosterHints === true,
    );
    if (!verdict.ok) {
      return { events: [], resyncRequired: verdict.reason, currentSeq, epoch };
    }
    return {
      events: verdict.events,
      ...(verdict.rosterHints.length > 0 ? { rosterHints: verdict.rosterHints } : {}),
      resyncRequired: false,
      currentSeq,
      epoch,
    };
  }

  prepareWatermarkIndex(): Promise<void> {
    return this.watermarkIndex.prepare();
  }

  watermarkStats(): JournalWatermarkStats {
    return this.watermarkIndex.stats();
  }

  invalidateWatermark(sessionId: string, reason = 'external'): void {
    this.watermarkIndex.invalidate(sessionId, reason);
  }

  getCoveredCursor(sessionId: string): JournalWatermark | undefined {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) {
      this.watermarkIndex.recordLiveHit();
      return {
        seq: live.journal.seq,
        epoch: live.journal.epoch,
        attentionSeq: live.journal.attentionSeq,
      };
    }
    if (this.pendingStates.has(sessionId) || this.evictions.has(sessionId)) {
      return undefined;
    }
    return this.watermarkIndex.getCovered(sessionId);
  }

  async getCoveredCursorAsync(sessionId: string): Promise<JournalWatermark | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) {
      this.watermarkIndex.recordLiveHit();
      return {
        seq: live.journal.seq,
        epoch: live.journal.epoch,
        attentionSeq: live.journal.attentionSeq,
      };
    }
    if (this.pendingStates.has(sessionId) || this.evictions.has(sessionId)) {
      return undefined;
    }
    return this.watermarkIndex.getCoveredAsync(sessionId);
  }

  async getCursor(
    sessionId: string,
    signal?: AbortSignal,
    indexed = false,
  ): Promise<{ seq: number; epoch: string; attentionSeq: number }> {
    signal?.throwIfAborted();
    const statePromise = this.ensureState(sessionId);
    const state = signal === undefined ? await statePromise : await abortable(statePromise, signal);
    signal?.throwIfAborted();
    if (state === undefined) {
      const cold = await this.readColdWatermark(sessionId, signal, indexed);
      return cold ?? { seq: 0, epoch: '', attentionSeq: 0 };
    }
    const drained = this.drainSessionQueue(state);
    await (signal === undefined ? drained : abortable(drained, signal));
    signal?.throwIfAborted();
    this.watermarkIndex.recordLiveHit();
    return {
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      attentionSeq: state.journal.attentionSeq,
    };
  }

  async publishHistoryRewritten(
    sessionId: string,
    reason: 'edit_resend' | 'regenerate',
    targetMessageId: string,
  ): Promise<{ seq: number; epoch: string }> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) throw new Error(`session ${sessionId} does not exist`);
    const event: Event = {
      type: 'event.session.history_rewritten',
      reason,
      target_message_id: targetMessageId,
      agentId: 'main',
      sessionId,
    };
    const projected = preProjectEventForQueue(event, false);
    await this.enqueueStateTaskAsync(state, async () => {
      await this.dispatchProjected(state, projected, false);
      await state.journal.flush();
    }, event.type);
    return { seq: state.journal.seq, epoch: state.journal.epoch };
  }

  refreshTranscriptAfterHistoryRewrite(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    const service = this.opts.transcriptService;
    const store = service?.forSessionLive(sessionId);
    if (state === undefined || service === undefined || store === undefined) return;
    this.ensureTranscriptStream(state, store);
    for (const descriptor of store.agents()) {
      const transcript = store.getAgent(descriptor.agentId);
      if (transcript === undefined) continue;
      for (const [target, sub] of state.targets) {
        if (!this.hasTranscriptBaseline(state, target, descriptor.agentId)) continue;
        const grade = gradeFor(sub.transcriptGrades, descriptor.agentId);
        if (grade === 'off') continue;
        this.sendLiveTranscriptReset(state, target, transcript, grade, sub.transcriptGeneration);
      }
    }
  }

  broadcastHistoryResync(
    sessionId: string,
    cursor: { seq: number; epoch: string },
  ): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const frame = buildResyncRequired(sessionId, 'history_rewritten', cursor.seq, cursor.epoch);
    for (const target of state.targets.keys()) {
      try {
        target.sendControl?.(frame);
      } catch {
      }
    }
  }

  async getTranscriptToolCallCounts(
    sessionId: string,
    agentIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    return (
      (await this.opts.transcriptService?.getAgentToolCallCounts(sessionId, agentIds)) ??
      new Map<string, number>()
    );
  }

  getMaterializedTranscriptToolCallCounts(
    sessionId: string,
    agentIds: readonly string[],
  ): ReadonlyMap<string, number> {
    return (
      this.opts.transcriptService?.getMaterializedAgentToolCallCounts(sessionId, agentIds) ??
      new Map<string, number>()
    );
  }

  async getSnapshotState<T = undefined>(
    sessionId: string,
    options: { captureMessages?: boolean; deferHistory?: boolean; capture?: () => Promise<T>; timing?: SessionViewTimingContext } = {},
  ): Promise<SessionSnapshotState & { captured?: T }> {
    const timing = { ...options.timing, logger: options.timing?.logger ?? this.opts.logger };
    const fields = { sessionId, requestId: timing.requestId };
    timing.signal?.throwIfAborted();
    const state = await timeSessionViewPhase('snapshot_state', fields, () => this.ensureState(sessionId), timing);
    timing.signal?.throwIfAborted();
    if (state === undefined) {
      const cold = await this.readColdWatermark(sessionId, timing.signal);
      return {
        seq: cold?.seq ?? 0,
        epoch: cold?.epoch ?? '',
        attentionSeq: cold?.attentionSeq ?? 0,
        contextMessages: [],
        contextMessageTimes: [],
        contextMessageCount: 0,
        inFlightTurn: null,
        subagents: [],
        pendingApprovals: [],
        pendingQuestions: [],
        pendingUserTools: [],
      };
    }
    const captureMessages = options.captureMessages !== false;
    const barrier = await timeSessionViewPhase(
      'snapshot_queue',
      fields,
      () =>
        this.enqueueStateTaskAsync(
          state,
          () => {
            timing.signal?.throwIfAborted();
            const viewMessages = state.contextView.messages;
            const contextMessages = captureMessages ? [...viewMessages] : [];
            const mainAgent = state.mainAgent;
            const frozen = {
              seq: state.journal.seq,
              epoch: state.journal.epoch,
              attentionSeq: state.journal.attentionSeq,
              contextMessages,
              contextMessageCount: captureMessages
                ? viewMessages.length
                : cachedMessageCount(this.opts.core, sessionId, viewMessages) ?? viewMessages.length,
              mainAgent,
              inFlightTurn: structuredClone(state.tracker.get(sessionId)),
              subagents: structuredClone(state.roster.get(sessionId)),
              pendingApprovals: structuredClone(state.interactionService?.listPending('approval').map((interaction) => toWireApproval(interaction, sessionId)) ?? []),
              pendingQuestions: structuredClone(state.interactionService?.listPending('question').map((interaction) => toWireQuestion(interaction, sessionId)) ?? []),
              pendingUserTools: structuredClone(state.interactionService?.listPending('user_tool').map((interaction) => toWirePendingUserTool(interaction, sessionId)) ?? []),
              currentPromptId: readCurrentPromptId(mainAgent),
              status: structuredClone(readSnapshotStatus(mainAgent)),
            };
            const captured = timeSessionViewPhase('snapshot_capture', fields, async () => options.capture?.(), timing);
            return { ...frozen, captured };
          },
          'snapshot.capture',
        ),
      timing,
    );
    const { mainAgent, contextMessages, captured, ...base } = barrier;
    if (options.deferHistory === true && captureMessages && mainAgent !== undefined) {
      await mainAgent.accessor.get(IWireService).flush();
      timing.signal?.throwIfAborted();
      const historyPromise = timeSessionViewPhase('snapshot_history', fields,
        () => captureContextMessageHistory(this.opts.core, mainAgent, contextMessages, timing.signal), timing);
      void historyPromise.catch(() => {});
      const captureValue = await captured;
      return {
        ...base,
        captured: captureValue,
        contextMessages,
        contextMessageTimes: [],
        historyPromise,
      };
    }
    const [capture, history] = await Promise.allSettled([
      captured,
      !captureMessages || mainAgent === undefined
        ? { messages: contextMessages, times: contextMessages.map(() => undefined) }
        : timeSessionViewPhase('snapshot_history', fields,
          () => captureContextMessageHistory(this.opts.core, mainAgent, contextMessages, timing.signal), timing),
    ]);
    if (capture.status === 'rejected') throw capture.reason;
    if (history.status === 'rejected') throw history.reason;
    return {
      ...base,
      captured: capture.value,
      contextMessages: history.value.messages,
      contextMessageTimes: history.value.times,
    };
  }

  /**
   * Watermark for a session that is not live in this process but exists on disk
   * (carried over from a prior process, or created by v1). Opens the journal
   * transiently — no agent/interaction listeners and not cached in
   * `this.sessions` — so a later live activation still attaches subscriptions.
   * Returns `undefined` when the session is unknown to the index (truly absent).
   */
  private async readColdWatermark(
    sessionId: string,
    signal?: AbortSignal,
    indexed = false,
  ): Promise<{ seq: number; epoch: string; attentionSeq: number } | undefined> {
    signal?.throwIfAborted();
    if (!indexed) {
      const summary = await this.opts.core.accessor.get(ISessionIndex).get(sessionId, undefined, signal);
      if (summary === undefined) return undefined;
    }
    signal?.throwIfAborted();
    const journalPath = sessionJournalPath(this.opts.eventsDir, sessionId);
    const mutationBefore = this.watermarkIndex.currentMutationSeq(sessionId);
    let statBefore: { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number } | null | undefined;
    try {
      const info = await stat(journalPath);
      statBefore = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    } catch (error) {
      statBefore = (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
    }
    const watermark = await SessionEventJournal.peekWatermark(
      journalPath,
      this.opts.logger,
    );
    let statAfter: { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number } | null | undefined;
    try {
      const info = await stat(journalPath);
      statAfter = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    } catch (error) {
      statAfter = (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
    }
    if (statBefore === null && statAfter === null) {
      this.watermarkIndex.backfillAuthoritative(sessionId, watermark, undefined, mutationBefore);
    } else if (
      statBefore !== null &&
      statBefore !== undefined &&
      statAfter !== null &&
      statAfter !== undefined &&
      statBefore.size === statAfter.size &&
      Math.abs(statBefore.mtimeMs - statAfter.mtimeMs) < 0.001 &&
      Math.abs(statBefore.ctimeMs - statAfter.ctimeMs) < 0.001
    ) {
      this.watermarkIndex.backfillAuthoritative(sessionId, watermark, statAfter, mutationBefore);
    }
    return watermark;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.journalPruneTimer !== undefined) {
      clearTimeout(this.journalPruneTimer);
      this.journalPruneTimer = undefined;
    }
    if (this.journalPruneInterval !== undefined) {
      clearInterval(this.journalPruneInterval);
      this.journalPruneInterval = undefined;
    }
    for (const pending of this.pendingSubscriptions.values()) for (const controller of pending.values()) controller.abort();
    this.pendingSubscriptions.clear();
    void this.pluginTopicSubscription?.dispose();
    this.pluginTopicSubscription = undefined;
    this.attachedPluginPort = undefined;
    await this.coreEventSubscription.dispose();
    await this.sessionLifecycleSubscription.dispose();
    await Promise.allSettled([...this.evictions.values(), ...this.pendingStates.values()]);
    for (const [sessionId, state] of this.sessions) {
      await this.drainSessionQueue(state);
      await disposeSessionState(state);
      this.opts.transcriptService?.dropSession(sessionId);
    }
    this.sessions.clear();
    await this.watermarkIndex.close();
  }

  private scheduleSessionEviction(sessionId: string): void {
    if (sessionId === GLOBAL_SESSION_ID || this.evictions.has(sessionId)) return;
    let tracked: Promise<void>;
    tracked = this.evictSessionState(sessionId)
      .catch((error: unknown) => {
        this.opts.logger?.warn(
          { sessionId, err: String(error) },
          'failed to evict closed session event state',
        );
      })
      .finally(() => {
        if (this.evictions.get(sessionId) === tracked) this.evictions.delete(sessionId);
      });
    this.evictions.set(sessionId, tracked);
  }

  private async evictSessionState(sessionId: string): Promise<void> {
    const pending = this.pendingStates.get(sessionId);
    const state = this.sessions.get(sessionId) ?? (pending === undefined ? undefined : await pending);
    if (state === undefined || this.sessions.get(sessionId) !== state) return;

    this.sessions.delete(sessionId);
    await this.drainSessionQueue(state);
    await disposeSessionState(state);
    this.opts.transcriptService?.dropSession(sessionId);
  }

  private ensureState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const eviction = this.evictions.get(sessionId);
    if (eviction !== undefined) return eviction.then(() => this.ensureState(sessionId));
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return Promise.resolve(existing);
    let pending = this.pendingStates.get(sessionId);
    if (pending === undefined) {
      pending = this.createSessionState(sessionId).finally(() => {
        if (this.pendingStates.get(sessionId) === pending) {
          this.pendingStates.delete(sessionId);
        }
      });
      this.pendingStates.set(sessionId, pending);
    }
    return pending;
  }

  private async createSessionState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return undefined;

    const session = getLiveSessionById(this.opts.core.accessor, sessionId);
    if (session === undefined) return undefined;

    const pendingUnlink = this.activePruneUnlinks.get(sessionId);
    if (pendingUnlink !== undefined) await pendingUnlink;
    if (this.closed) return undefined;

    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, sessionId),
      this.opts.logger,
      this.maxBufferSize,
      undefined,
      this.watermarkIndex.hookFor(sessionId),
    );
    if (this.closed) {
      await journal.close();
      return undefined;
    }
    const state: SessionState = {
      sessionId,
      sessionHandle: session,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      contextView: { messages: [], revision: 0 },
      authoritativeContext: false,
      tail: [],
      tailBytes: 0,
      targets: new Map(),
      rawTargets: new Set(),
      interactionConsumers: new Map(),
      interactionService: session.accessor.get(ISessionInteractionService),
      taskQueue: [],
      queuedLiveBytes: 0,
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
      transcriptGenerations: new WeakMap(),
      pendingTranscriptSeeds: new Map(),
    };
    this.sessions.set(sessionId, state);
    try {
      this.attachWorkView(session, state);
      this.attachAgents(sessionId, session, state);
      this.attachInteractions(sessionId, session, state);
    } catch (error) {
      this.sessions.delete(sessionId);
      await disposeSessionState(state);
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') return undefined;
      throw error;
    }
    return state;
  }

  private ensureGlobalState(): Promise<SessionState> {
    const existing = this.sessions.get(GLOBAL_SESSION_ID);
    if (existing !== undefined) return Promise.resolve(existing);
    let pending = this.pendingStates.get(GLOBAL_SESSION_ID);
    if (pending === undefined) {
      pending = this.createGlobalState().finally(() => {
        if (this.pendingStates.get(GLOBAL_SESSION_ID) === pending) {
          this.pendingStates.delete(GLOBAL_SESSION_ID);
        }
      });
      this.pendingStates.set(GLOBAL_SESSION_ID, pending);
    }
    return pending as Promise<SessionState>;
  }

  private async createGlobalState(): Promise<SessionState> {
    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, GLOBAL_SESSION_ID),
      this.opts.logger,
      this.maxBufferSize,
    );
    const state: SessionState = {
      sessionId: GLOBAL_SESSION_ID,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      contextView: { messages: [], revision: 0 },
      authoritativeContext: false,
      tail: [],
      tailBytes: 0,
      targets: new Map(),
      rawTargets: new Set(),
      interactionConsumers: new Map(),
      taskQueue: [],
      queuedLiveBytes: 0,
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
      transcriptGenerations: new WeakMap(),
      pendingTranscriptSeeds: new Map(),
    };
    this.sessions.set(GLOBAL_SESSION_ID, state);
    return state;
  }

  private onCoreEvent(event: Event2<any>): void {
    const corePayload = (event as { readonly payload?: unknown }).payload;
    if (event.type === 'session.worktree.changed') {
      const payload = corePayload as { sessionId?: string; worktreeId?: string; state?: string; inspection?: unknown } | undefined;
      if (typeof payload?.sessionId !== 'string' || typeof payload.worktreeId !== 'string' || typeof payload.state !== 'string') return;
      void this.dispatchSessionEvent(payload.sessionId, {
        type: 'session.worktree.changed', agentId: 'main', sessionId: payload.sessionId,
        worktreeId: payload.worktreeId, state: payload.state, inspection: payload.inspection,
      } as Event).catch((error: unknown) => this.logDispatchError(payload.sessionId!, 'session.worktree.changed', error));
      return;
    }
    if (event.type === 'event.session.created') {
      const payload = sessionCreatedPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchSessionEvent(payload.sessionId, {
        type: 'event.session.created',
        session: payload.session,
        agentId: 'main',
        sessionId: payload.sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(payload.sessionId, 'event.session.created', error),
      );
      return;
    }
    if (event.type === 'session.meta.updated') {
      const payload = sessionMetaUpdatedPayload(corePayload);
      if (payload === undefined) return;
      const sessionId = sessionMetaUpdatedSessionId(corePayload);
      if (sessionId === undefined) return;
      void this.dispatchSessionEvent(sessionId, {
        type: 'session.meta.updated',
        ...payload,
        agentId: 'main',
        sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(sessionId, 'session.meta.updated', error),
      );
      return;
    }
    if (event.type === 'event.plugin.changed') {
      const changedPluginId =
        typeof corePayload === 'object' && corePayload !== null
          ? (corePayload as { readonly pluginId?: unknown }).pluginId
          : undefined;
      this.bumpAllPluginGenerations(typeof changedPluginId === 'string' ? changedPluginId : undefined);
      this.syncPluginTopicSubscription();
      void this.dispatchGlobal({
        type: 'event.plugin.changed',
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.plugin.changed', error),
      );
      return;
    }
    if (event.type === 'event.persona.changed') {
      void this.dispatchGlobal({
        type: 'event.persona.changed',
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.persona.changed', error),
      );
      return;
    }
    if (event.type === 'event.plugin.topic') {
      if (typeof corePayload !== 'object' || corePayload === null) return;
      const candidate = corePayload as Record<string, unknown>;
      const pluginId = typeof candidate['pluginId'] === 'string'
        ? candidate['pluginId']
        : typeof candidate['plugin_id'] === 'string'
          ? candidate['plugin_id']
          : undefined;
      const topic = typeof candidate['topic'] === 'string' ? candidate['topic'] : undefined;
      if (pluginId === undefined || topic === undefined) return;
      const sessionId = typeof candidate['sessionId'] === 'string'
        ? candidate['sessionId']
        : typeof candidate['session_id'] === 'string'
          ? candidate['session_id']
          : undefined;
      const spaceId = typeof candidate['spaceId'] === 'string'
        ? candidate['spaceId']
        : typeof candidate['space_id'] === 'string'
          ? candidate['space_id']
          : undefined;
      void this.publishPluginTopicEvent({
        pluginId,
        topic,
        sessionId,
        spaceId,
        payload: candidate['payload'],
      }).catch((error: unknown) =>
        this.logDispatchError(sessionId ?? GLOBAL_SESSION_ID, 'event.plugin.topic', error),
      );
      return;
    }
    if (event.type === 'event.remote_connections.changed') {
      const raw = typeof corePayload === 'object' && corePayload !== null ? (corePayload as Record<string, unknown>) : {};
      const parsed = remoteConnectionsChangedPayloadSchema.safeParse({
        revision: typeof raw['revision'] === 'number' ? raw['revision'] : 1,
        at: typeof raw['at'] === 'number' ? raw['at'] : 0,
        reason: raw['reason'],
        connection_id: raw['connection_id'],
      });
      if (!parsed.success) return;
      void this.dispatchGlobal({
        type: 'event.remote_connections.changed',
        ...parsed.data,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }).catch((error: unknown) => this.logDispatchError(GLOBAL_SESSION_ID, 'event.remote_connections.changed', error));
      return;
    }
    if (event.type === 'event.model_catalog.changed') {
      const payload = modelCatalogChangedPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchGlobal({
        type: 'event.model_catalog.changed',
        ...payload,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.model_catalog.changed', error),
      );
      return;
    }
    if (event.type === 'event.capability.changed') {
      const payload = capabilityChangedPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchGlobal({
        type: 'event.capability.changed',
        ...payload,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.capability.changed', error),
      );
      return;
    }
    if (event.type === 'event.config.warning') {
      const payload = configWarningPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchGlobal({
        type: 'event.config.warning',
        warnings: payload.warnings,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.config.warning', error),
      );
      return;
    }
  }

  private async dispatchGlobal(event: Event): Promise<void> {
    const state = await this.ensureGlobalState();
    this.enqueueEvent(state, event, isVolatileEventType(event.type));
  }

  /**
   * Dispatch an event through a real session's state so the WS envelope carries
   * the real `session_id` (not the global `'__global__'` watermark). Used for
   * session-scoped core events that must still fan out to every connection
   * (e.g. `session.meta.updated`); `isGlobalEvent` keeps the fan-out global.
   */
  private async dispatchSessionEvent(sessionId: string, event: Event): Promise<void> {
    let state: SessionState | undefined;
    try {
      state = await this.ensureState(sessionId);
    } catch (error) {
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return;
      }
      throw error;
    }
    if (state === undefined) return;
    this.enqueueEvent(state, event, isVolatileEventType(event.type));
  }

  /**
   * Bridge the core's session work aggregate (`ISessionActivityView`) onto
   * the v1 `event.session.work_changed` frame. The view owns the fold and
   * its change dedup; the edge only schedules the wire emission. Every cause
   * except `turn_ended` emits immediately. A `turn_ended` change must land
   * after the matching `turn.ended` frame, but the agent bus fires
   * full-stream subscribers (the edge's own handler) before per-type ones
   * (the activity view chain that reports this change) — so the state is
   * buffered and flushed from a microtask: the microtask runs after the
   * whole synchronous publish, by which time the `turn.ended` frame is
   * already enqueued on the session queue, and the emission can never be
   * stranded behind a flush that already ran.
   */
  private attachWorkView(session: ISessionScopeHandle, state: SessionState): void {
    const workView = session.accessor.get(ISessionActivityView);
    workView.state();
    state.lifecycleDisposables.push(
      workView.onDidChange(({ state: work, cause }) => {
        if (cause === 'turn_ended' || cause === 'interaction') {
          state.deferredWork = work;
          queueMicrotask(() => {
            if (this.sessions.get(state.sessionId) !== state) return;
            this.flushDeferredWork(state);
          });
          return;
        }
        this.flushDeferredWork(state);
        this.enqueueWorkChanged(state, work);
      }),
    );
  }

  private flushDeferredWork(state: SessionState): void {
    const deferred = state.deferredWork;
    if (deferred === undefined) return;
    state.deferredWork = undefined;
    this.enqueueWorkChanged(state, deferred);
  }

  private attachAgents(sessionId: string, session: ISessionScopeHandle, state: SessionState): void {
    const agents = session.accessor.get(IAgentLifecycleService);
    const subscribeAgent = (handle: IAgentScopeHandle): void => {
      if (state.agentDisposables.has(handle.id)) return;
      for (const info of handle.accessor.get(IAgentTaskService)?.list(false) ?? []) {
        state.roster.seedTask(sessionId, handle.id, info);
      }
      if (handle.id === MAIN_AGENT_ID) {
        state.mainAgent = handle;
        const probe = probeAuthoritativeContext(handle);
        state.authoritativeContext = probe.authoritative;
        state.contextView = { messages: probe.messages, revision: state.contextView.revision + 1 };
      }
      state.agentDisposables.set(handle.id, this.attachAgent(sessionId, handle));
    };
    for (const handle of agents.list()) subscribeAgent(handle);
    const dispatch = session.accessor.get(ISessionDispatchService);
    if (dispatch !== undefined) {
      state.lifecycleDisposables.push(dispatch.onDidDelegateRun(({ agentId }) => {
        state.roster.markRefreshing(sessionId, agentId, Date.now());
      }));
    }
    state.lifecycleDisposables.push(
      agents.onDidCreate((handle) => {
        subscribeAgent(handle);
        this.enqueueDurable(state, {
          type: 'agent.created',
          agentId: handle.id,
          sessionId,
          time: Date.now(),
        });
      }),
      agents.onDidDispose((agentId) => {
        const d = state.agentDisposables.get(agentId);
        if (d !== undefined) {
          this.enqueueStateTask(state, async () => { await d.dispose(); });
          state.agentDisposables.delete(agentId);
          this.enqueueDurable(state, {
            type: 'agent.disposed',
            agentId,
            sessionId,
            time: Date.now(),
          });
        }
      }),
    );
  }

  private attachAgent(sessionId: string, handle: IAgentScopeHandle): IDisposable {
    const eventBus = handle.accessor.get(IEventBus);
    const turnUsage = new TurnUsageTracker();
    let lastLegacyStatus: string | undefined;
    const emitLegacyStatus = (): void => {
      const snapshot = readLegacyStatus(handle);
      if (snapshot === undefined) return;
      const key = JSON.stringify(snapshot);
      if (key === lastLegacyStatus) return;
      lastLegacyStatus = key;
      this.onAgentEvent(sessionId, MAIN_AGENT_ID, {
        type: 'agent.status.updated',
        ...snapshot,
      } as unknown as Event2<any>);
    };
    const disposables: IDisposable[] = [
      eventBus.subscribe((event) => {
        let projected: Event2<any> = event;
        const turnSummary = turnUsage.apply(event);
        if (event.type === 'turn.ended' && turnSummary !== undefined) {
          projected = Object.assign({}, event, turnSummary) as unknown as Event2<any>;
        }
        if (event.type === 'agent.status.updated') {
          const snapshot = readLegacyStatus(handle);
          if (snapshot !== undefined) {
            lastLegacyStatus = JSON.stringify(snapshot);
            projected = Object.assign({}, event, snapshot) as unknown as Event2<any>;
          }
        }
        if (handle.id === MAIN_AGENT_ID && event.type === 'context.spliced') {
          emitLegacyStatus();
        }
        this.onAgentEvent(sessionId, handle.id, projected);
      }),
    ];

    return { dispose: async () => { for (const disposable of disposables) await disposable.dispose(); } };
  }

  private onAgentEvent(sessionId: string, agentId: string, event: Event2<any>): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    if (TRANSCRIPT_ONLY_STATE_EVENT_TYPES.has(event.type)) return;

    if (event.type === 'context.undone') {
      const undo = event as unknown as {
        readonly turns?: number;
        readonly fromTurnId?: number;
        readonly cutToTurnId?: number;
        readonly removedTurnIds?: readonly number[];
      };
      const projectedUndo = {
        type: 'context.undo',
        agentId,
        sessionId,
        agent_id: agentId,
        turns: undo.turns ?? 1,
        ...(undo.cutToTurnId === undefined ? {} : { cut_to_turn_id: undo.cutToTurnId }),
        ...(undo.fromTurnId === undefined ? {} : { from_turn_id: undo.fromTurnId }),
        removed_turn_ids: undo.removedTurnIds ?? [],
      } as unknown as Event;
      this.enqueueDurable(state, projectedUndo);
      return;
    }

    if (event.type === 'context.append_loop_event') {
      if (agentId === MAIN_AGENT_ID) {
        this.enqueueContextLoopEvent(
          state,
          Object.assign({}, event, { agentId, sessionId }) as unknown as Event,
        );
      }
      return;
    }

    if (event.type === 'agent.activity.updated') {
      const snapshot = event as unknown as AgentActivityState;
      const phase = toLegacyPhase(snapshot);
      if (phase !== undefined) {
        const wireEvent = {
          type: 'agent.status.updated',
          phase,
          agentId,
          sessionId,
        } as unknown as Event;
        this.enqueueEvent(state, wireEvent, true);
      }
      return;
    }
    if (
      event.type === 'agent.status.updated' &&
      (event as { phase?: unknown }).phase !== undefined
    ) {
      return;
    }

    if (
      event.type === 'assistant.delta' ||
      event.type === 'thinking.delta' ||
      event.type === 'tool_call.delta'
    ) {
      let hasDeltaRecipient = false;
      for (const rawTarget of state.rawTargets) {
        if (rawTarget.wantsDeltas === true) {
          hasDeltaRecipient = true;
          break;
        }
      }
      if (!hasDeltaRecipient) {
        for (const sub of state.targets.values()) {
          if (sub.transcriptGrades === undefined) {
            hasDeltaRecipient = true;
            break;
          }
          const grade = gradeFor(sub.transcriptGrades, agentId);
          if (grade === 'off' && (!sub.transcriptOnly || sub.detachedTranscriptAgents?.has(agentId) === true)) {
            hasDeltaRecipient = true;
            break;
          }
        }
      }
      if (!hasDeltaRecipient) return;
    }

    let wireEvent: Event;
    if (event.type === 'turn.started') {
      const { promptAttachments: _internal, ...wireFields } = event as typeof event & {
        promptAttachments?: unknown;
      };
      wireEvent = Object.assign({}, wireFields, { agentId, sessionId }) as unknown as Event;
    } else if (
      event.type === 'prompt.steered' ||
      event.type === 'prompt.queued' ||
      event.type === 'prompt.replaced' ||
      event.type === 'prompt.submitted'
    ) {
      const { origin: _origin, ...withoutOrigin } = event as typeof event & { origin?: unknown };
      const wireFields =
        event.type === 'prompt.queued'
          ? (() => {
              const { userMessageId: _userMessageId, ...rest } = withoutOrigin as typeof withoutOrigin & {
                userMessageId?: unknown;
              };
              return rest;
            })()
          : withoutOrigin;
      const content = (wireFields as unknown as { content: Parameters<typeof projectPromptContentParts>[0] }).content;
      wireEvent = Object.assign({}, wireFields, {
        content: projectPromptContentParts(content),
        agentId,
        sessionId,
      }) as Event;
    } else {
      wireEvent = Object.assign({}, event, { agentId, sessionId }) as unknown as Event;
    }
    const volatile = isVolatileSignal(event.type);
    this.enqueueEvent(state, wireEvent, volatile);
    const legacy = legacyTaskEvent(event, agentId, sessionId);
    if (legacy !== undefined) {
      this.enqueueEvent(state, legacy, volatile);
    }
  }

  /**
   * Bridge the session's interaction kernel (approvals / questions) onto the
   * v1 event stream. The kernel only emits in-process notifications
   * (`onDidChangePending` / `onDidResolve`), so the v1 protocol events are
   * synthesized here.
   */
  private attachInteractions(
    sessionId: string,
    session: ISessionScopeHandle,
    state: SessionState,
  ): void {
    const interactions = session.accessor.get(ISessionInteractionService);
    for (const i of interactions.listPending()) {
      state.knownInteractions.set(i.id, { kind: i.kind, agentId: i.origin.agentId ?? 'main' });
    }
    state.lifecycleDisposables.push(
      interactions.onDidChangePending(() => {
        let emitted = false;
        for (const i of interactions.listPending()) {
          if (state.knownInteractions.has(i.id)) continue;
          state.knownInteractions.set(i.id, {
            kind: i.kind,
            agentId: i.origin.agentId ?? 'main',
          });
          const event = interactionRequestedEvent(i, sessionId);
          if (event !== undefined) {
            this.enqueueDurable(state, event);
            emitted = true;
          }
        }
        if (emitted) {
          if (state.deferredWork !== undefined) this.flushDeferredWork(state);
          else this.enqueueWorkChanged(state, session.accessor.get(ISessionActivityView).state());
        }
      }),
      interactions.onDidResolve(({ id, response }) => {
        const known = state.knownInteractions.get(id);
        if (known === undefined) return;
        state.knownInteractions.delete(id);
        const event = interactionResolvedEvent(known.kind, id, response, sessionId, known.agentId);
        if (event !== undefined) {
          this.enqueueDurable(state, event);
        }
        this.flushDeferredWork(state);
      }),
    );
  }

  private enqueueStateTask(
    state: SessionState,
    run: () => Promise<void> | void,
    eventType = 'task',
    liveBytes = 0,
  ): void {
    if (liveBytes > 0) adjustQueueLiveBytes(state, liveBytes);
    state.taskQueue.push({
      liveBytes,
      run: async () => {
        try {
          await run();
        } catch (error: unknown) {
          this.logDispatchDropped(state.sessionId, eventType, error);
        }
      },
    });
    this.ensureQueueDraining(state);
  }

  private enqueueStateTaskAsync<T>(
    state: SessionState,
    run: () => Promise<T> | T,
    eventType: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      state.taskQueue.push({
        liveBytes: 0,
        run: async () => {
          try {
            resolve(await run());
          } catch (error: unknown) {
            this.logDispatchDropped(state.sessionId, eventType, error);
            reject(error);
          }
        },
      });
      this.ensureQueueDraining(state);
    });
  }

  private ensureQueueDraining(state: SessionState): void {
    if (state.queueDrainPromise !== undefined) return;
    state.queueDrainPromise = (async () => {
      await Promise.resolve();
      while (state.taskQueue.length > 0) {
        const next = state.taskQueue.shift()!;
        try {
          await next.run();
        } finally {
          if (next.liveBytes > 0) adjustQueueLiveBytes(state, -next.liveBytes);
        }
      }
    })().finally(() => {
      state.queueDrainPromise = undefined;
      if (state.taskQueue.length > 0) this.ensureQueueDraining(state);
    });
  }

  private async drainSessionQueue(state: SessionState): Promise<void> {
    while (state.queueDrainPromise !== undefined || state.taskQueue.length > 0) {
      this.ensureQueueDraining(state);
      await state.queueDrainPromise;
    }
  }

  private hasUnsuppressedRecipient(
    state: SessionState,
    eventType: string,
    agentId: string | null,
    routingKnown: boolean,
  ): boolean {
    if (isGlobalEventType(eventType)) {
      if (this.globalTargets.size > 0 || this.globalRawTargets.size > 0 || state.rawTargets.size > 0) {
        return true;
      }
      for (const s of this.sessions.values()) {
        if (s.targets.size > 0) return true;
      }
      return false;
    }
    if (state.rawTargets.size > 0) return true;
    const subject = { eventType, agentId, routingKnown };
    for (const sub of state.targets.values()) {
      if (!subjectMatchesAgentFilter(subject, sub.agentFilter)) continue;
      if (
        !subjectSuppressedByTranscript(
          subject,
          sub.transcriptGrades,
          sub.transcriptOnly === true,
          sub.detachedTranscriptAgents,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private enqueueEvent(state: SessionState, event: Event, volatile: boolean): void {
    let contextAuthoritativeRef: readonly ContextMessage[] | undefined;
    let fallbackSplice: { readonly start: number; readonly deleteCount: number; readonly messages: readonly ContextMessage[] } | undefined;
    if (event.agentId === MAIN_AGENT_ID && event.type === 'context.spliced') {
      const liveRef = readContextMessagesRef(state.mainAgent);
      if (
        liveRef !== undefined &&
        (state.authoritativeContext ||
          (liveRef !== state.contextView.messages &&
            (event.messages.length === 0 ||
              (liveRef[event.start] === event.messages[0] &&
                liveRef[event.start + event.messages.length - 1] === event.messages.at(-1)))))
      ) {
        contextAuthoritativeRef = liveRef;
      } else {
        fallbackSplice = {
          start: event.start,
          deleteCount: event.deleteCount,
          messages: event.messages,
        };
      }
    }

    const projected = preProjectEventForQueue(event, volatile, MAX_SINGLE_JOURNAL_LINE_BYTES);
    let finalProjected: QueuedDispatchPayload = projected;
    let liveBytes = MIN_QUEUED_TASK_BYTES;
    let backpressureDropped = false;
    let backpressureOmittedBytes = 0;

    if (projected.kind === 'oversized_gap') {
      const wantsRaw = this.hasUnsuppressedRecipient(
        state,
        projected.eventType,
        projected.agentId,
        projected.routingKnown,
      );
      if (wantsRaw) {
        const probe = encodeJsonValueBounded(event, MAX_SESSION_QUEUE_LIVE_BYTES);
        if (
          probe.ok &&
          state.queuedLiveBytes + probe.bytes <= MAX_SESSION_QUEUE_LIVE_BYTES &&
          processQueuedLiveBytes + probe.bytes <= MAX_PROCESS_QUEUE_LIVE_BYTES
        ) {
          finalProjected = { ...projected, liveRawEvent: event };
          liveBytes = Math.max(MIN_QUEUED_TASK_BYTES, probe.bytes);
        }
      }
      if (
        finalProjected.kind === 'oversized_gap' &&
        finalProjected.liveRawEvent === undefined &&
        (state.queuedLiveBytes + MIN_QUEUED_TASK_BYTES > MAX_SESSION_QUEUE_LIVE_BYTES ||
          processQueuedLiveBytes + MIN_QUEUED_TASK_BYTES > MAX_PROCESS_QUEUE_LIVE_BYTES)
      ) {
        backpressureDropped = true;
        backpressureOmittedBytes = projected.omittedBytesAtLeast;
      }
    } else if (!volatile) {
      const neededBytes = Math.max(MIN_QUEUED_TASK_BYTES, projected.estimatedBytes);
      if (
        state.queuedLiveBytes + neededBytes > MAX_SESSION_QUEUE_LIVE_BYTES ||
        processQueuedLiveBytes + neededBytes > MAX_PROCESS_QUEUE_LIVE_BYTES
      ) {
        backpressureDropped = true;
        backpressureOmittedBytes = projected.estimatedBytes;
      } else {
        liveBytes = neededBytes;
      }
    } else {
      liveBytes = Math.max(MIN_QUEUED_TASK_BYTES, Math.min(projected.estimatedBytes, MAX_SINGLE_JOURNAL_LINE_BYTES));
    }

    if (backpressureDropped && !volatile) {
      const eventHasAttention = isAttentionEventType(event.type);
      const eventIsGlobal = isGlobalEventType(event.type);
      const tailTask = state.taskQueue.at(-1);
      if (
        contextAuthoritativeRef === undefined &&
        fallbackSplice === undefined &&
        tailTask?.backpressure !== undefined
      ) {
        tailTask.backpressure.count += 1;
        tailTask.backpressure.omittedBytesAtLeast += backpressureOmittedBytes;
        tailTask.backpressure.hasAttention ||= eventHasAttention;
        tailTask.backpressure.isGlobal ||= eventIsGlobal;
        this.ensureQueueDraining(state);
        return;
      }

      const bpState: QueuedBackpressureState = {
        count: 1,
        omittedBytesAtLeast: backpressureOmittedBytes,
        hasAttention: eventHasAttention,
        isGlobal: eventIsGlobal,
      };
      const trackerStub = buildLightweightTrackerStub(event);
      const bpLiveBytes = MIN_QUEUED_TASK_BYTES;
      adjustQueueLiveBytes(state, bpLiveBytes);
      state.taskQueue.push({
        liveBytes: bpLiveBytes,
        backpressure: bpState,
        run: async () => {
          try {
            if (contextAuthoritativeRef !== undefined) {
              state.contextView = {
                messages: contextAuthoritativeRef,
                revision: state.contextView.revision + 1,
              };
            } else if (fallbackSplice !== undefined) {
              const prev = state.contextView.messages;
              state.contextView = {
                messages: [
                  ...prev.slice(0, fallbackSplice.start),
                  ...fallbackSplice.messages,
                  ...prev.slice(fallbackSplice.start + fallbackSplice.deleteCount),
                ],
                revision: state.contextView.revision + 1,
              };
            }
            if (bpState.count === 1) {
              state.tracker.apply(state.sessionId, trackerStub);
              state.roster.apply(state.sessionId, trackerStub);
            }
            const fromSeq = state.journal.nextSeq();
            let toSeq = fromSeq;
            for (let i = 1; i < bpState.count; i += 1) {
              toSeq = state.journal.nextSeq();
            }
            const outcome = state.journal.appendGap(toSeq, {
              fromSeq,
              eventType: '*',
              agentId: null,
              routingKnown: false,
              omittedBytesAtLeast: bpState.omittedBytesAtLeast,
              reason: 'queue_backpressure',
              sessionId: state.sessionId,
              advancesAttention: bpState.hasAttention,
            });
            this.pushTailOutcome(state, outcome);
            const frame = buildResyncRequired(state.sessionId, 'journal_gap', toSeq, state.journal.epoch);
            if (bpState.isGlobal) {
              const recipients = new Set<BroadcastTarget>(this.globalTargets);
              for (const target of this.allTargets()) recipients.add(target);
              for (const target of recipients) {
                try {
                  target.sendControl?.(frame);
                } catch {}
              }
              this.recordGlobalRawGap(state.sessionId);
            } else {
              for (const target of state.targets.keys()) {
                try {
                  target.sendControl?.(frame);
                } catch {}
              }
            }
            this.notifyRawTargetsGap(state, toSeq);
          } catch (error: unknown) {
            this.logDispatchDropped(state.sessionId, 'queue_backpressure', error);
          }
        },
      });
      this.ensureQueueDraining(state);
      return;
    }

    this.enqueueStateTask(
      state,
      () => {
        if (contextAuthoritativeRef !== undefined) {
          state.contextView = {
            messages: contextAuthoritativeRef,
            revision: state.contextView.revision + 1,
          };
        } else if (fallbackSplice !== undefined) {
          const prev = state.contextView.messages;
          state.contextView = {
            messages: [
              ...prev.slice(0, fallbackSplice.start),
              ...fallbackSplice.messages,
              ...prev.slice(fallbackSplice.start + fallbackSplice.deleteCount),
            ],
            revision: state.contextView.revision + 1,
          };
        }
        return this.dispatchProjected(state, finalProjected, volatile);
      },
      event.type,
      liveBytes,
    );
  }

  private enqueueContextLoopEvent(state: SessionState, event: Event): void {
    if (event.type !== 'context.append_loop_event') return;
    const authoritativeRef = state.authoritativeContext
      ? readContextMessagesRef(state.mainAgent)
      : undefined;
    const trackerStub = buildLightweightLoopEventStub(event);
    if (authoritativeRef !== undefined) {
      this.enqueueStateTask(
        state,
        () => {
          state.contextView = {
            messages: authoritativeRef,
            revision: state.contextView.revision + 1,
          };
          if (trackerStub !== undefined) {
            state.tracker.apply(state.sessionId, trackerStub);
          }
        },
        event.type,
        MIN_QUEUED_TASK_BYTES,
      );
      return;
    }
    const loopPayload = event.event;
    const estimated = estimateJsonByteLengthBounded(loopPayload, MAX_SESSION_QUEUE_LIVE_BYTES);
    const liveBytes = Number.isFinite(estimated)
      ? Math.max(MIN_QUEUED_TASK_BYTES, Math.min(estimated, MAX_SESSION_QUEUE_LIVE_BYTES))
      : MIN_QUEUED_TASK_BYTES;
    this.enqueueStateTask(
      state,
      () => {
        state.contextView = {
          messages: foldLoopEvent(state.contextView.messages, loopPayload),
          revision: state.contextView.revision + 1,
        };
        if (trackerStub !== undefined) {
          state.tracker.apply(state.sessionId, trackerStub);
        }
      },
      event.type,
      liveBytes,
    );
  }

  private enqueueDurable(state: SessionState, event: Event): void {
    this.enqueueEvent(state, event, false);
  }

  /**
   * Emit `event.session.work_changed` for one aggregate change announced by
   * the core `ISessionActivityView` (the view already dedups — every call
   * here is a real tuple change).
   */
  private enqueueWorkChanged(state: SessionState, work: SessionActivityState): void {
    this.enqueueStateTask(
      state,
      async () => {
        const attentionCursor = toAttentionCursor({
          epoch: state.journal.epoch,
          attentionSeq: state.journal.attentionSeq,
        });
        const event = {
          type: 'event.session.work_changed',
          busy: work.busy,
          executing: work.executing,
          cleanup_pending: work.cleanupPending,
          main_turn_active: work.mainTurnActive,
          pending_interaction: work.pendingInteraction,
          last_turn_reason: work.lastTurnReason,
          attention_cursor: attentionCursor,
          agentId: 'main',
          sessionId: state.sessionId,
        } as Event;
        await this.dispatchProjected(state, preProjectEventForQueue(event, false), false);
        const coreEvents = this.opts.core.accessor.get(IEventService) as { publish?: (event: unknown) => void };
        coreEvents.publish?.({
          type: 'event.session.work_changed',
          payload: {
            sessionId: state.sessionId,
            busy: work.busy,
            executing: work.executing,
            cleanup_pending: work.cleanupPending,
            main_turn_active: work.mainTurnActive,
            pending_interaction: work.pendingInteraction,
            last_turn_reason: work.lastTurnReason,
            attention_cursor: attentionCursor,
          },
        });
      },
      'event.session.work_changed',
    );
  }

  /**
   * Log a rejected `dispatchSessionEvent` promise — the session's scope was
   * torn down mid-dispatch, or a non-disposed error escaped `ensureState`.
   */
  private logDispatchError(sessionId: string, eventType: string, _error: unknown): void {
    const logger = this.opts.logger;
    if (logger === undefined) return;
    if (logger.error !== undefined) {
      logger.error({ sessionId, eventType }, 'session event dispatch failed');
    } else {
      logger.warn({ sessionId, eventType }, 'session event dispatch failed');
    }
  }

  /**
   * A queued dispatch rejected: the event is permanently lost (and, for durable
   * events, the seq is skipped). Warn instead of swallowing it silently.
   */
  private logDispatchDropped(sessionId: string, eventType: string, error: unknown): void {
    this.opts.logger?.warn(
      { sessionId, eventType, err: error },
      'session event dispatch failed; event dropped',
    );
  }

  private pushTailOutcome(state: SessionState, outcome: JournalAppendOutcome): void {
    if (outcome.kind === 'event') {
      state.tail.push({
        kind: 'event',
        seq: outcome.seq,
        attentionSeq: outcome.attentionSeq,
        bytes: outcome.bytes,
        encoded: outcome.encoded,
        eventType: outcome.eventType,
        agentId: outcome.agentId,
        epoch: outcome.epoch,
        sessionId: outcome.sessionId,
        rosterHint: outcome.rosterHint,
      });
      state.tailBytes += outcome.bytes;
    } else if (outcome.collapsedIntoPrevious) {
      const last = state.tail.at(-1);
      if (last !== undefined && last.kind === 'gap' && last.gap.reason === 'queue_backpressure') {
        state.tailBytes = Math.max(0, state.tailBytes - last.bytes + outcome.bytes);
        state.tail[state.tail.length - 1] = {
          kind: 'gap',
          seq: outcome.seq,
          ...(outcome.fromSeq !== undefined ? { fromSeq: outcome.fromSeq } : {}),
          attentionSeq: outcome.attentionSeq,
          bytes: outcome.bytes,
          gap: outcome.gap,
        };
      } else {
        state.tail.push({
          kind: 'gap',
          seq: outcome.seq,
          ...(outcome.fromSeq !== undefined ? { fromSeq: outcome.fromSeq } : {}),
          attentionSeq: outcome.attentionSeq,
          bytes: outcome.bytes,
          gap: outcome.gap,
        });
        state.tailBytes += outcome.bytes;
      }
    } else {
      state.tail.push({
        kind: 'gap',
        seq: outcome.seq,
        ...(outcome.fromSeq !== undefined ? { fromSeq: outcome.fromSeq } : {}),
        attentionSeq: outcome.attentionSeq,
        bytes: outcome.bytes,
        gap: outcome.gap,
      });
      state.tailBytes += outcome.bytes;
    }

    while (state.tail.length > this.maxBufferSize || state.tailBytes > MAX_TAIL_BUFFER_BYTES) {
      const dropped = state.tail.shift();
      if (dropped === undefined) break;
      state.tailBytes = Math.max(0, state.tailBytes - dropped.bytes);
    }
  }

  private async dispatchProjected(
    state: SessionState,
    queued: QueuedDispatchPayload,
    volatile: boolean,
  ): Promise<void> {
    const { journal, tracker, roster, targets, sessionId } = state;
    const trackerEvent = queued.kind === 'full' ? queued.event : queued.trackerEvent;
    const annotation = tracker.apply(sessionId, trackerEvent);
    roster.apply(sessionId, trackerEvent);
    if (annotation.disposition === 'rejected' || annotation.disposition === 'closed') return;

    let liveEnvelope: EventEnvelope | undefined;
    let durableSeq = journal.seq;
    let gapOutcome: JournalAppendOutcome | undefined;

    if (volatile) {
      if (queued.kind === 'full') {
        liveEnvelope = this.buildEnvelope(journal.seq, sessionId, queued.event, {
          epoch: journal.epoch,
          volatile: true,
          ...(annotation.offset !== undefined ? { offset: annotation.offset } : {}),
        });
      }
    } else {
      const seq = journal.nextSeq();
      durableSeq = seq;
      if (queued.kind === 'full') {
        const envelope = this.buildEnvelope(seq, sessionId, queued.event, { epoch: journal.epoch });
        journal.append(seq, envelope);
        const outcome = journal.lastOutcome();
        if (outcome !== undefined) {
          this.pushTailOutcome(state, outcome);
          gapOutcome = outcome;
        }
        liveEnvelope = envelope;
      } else {
        const outcome = journal.appendGap(seq, {
          eventType: queued.eventType,
          agentId: queued.agentId,
          routingKnown: queued.routingKnown,
          omittedBytesAtLeast: queued.omittedBytesAtLeast,
          reason: queued.reason,
          ...(queued.rosterHint !== undefined ? { rosterHint: queued.rosterHint } : {}),
          sessionId,
        });
        this.pushTailOutcome(state, outcome);
        gapOutcome = outcome;
        if (queued.liveRawEvent !== undefined) {
          liveEnvelope = this.buildEnvelope(seq, sessionId, queued.liveRawEvent, { epoch: journal.epoch });
        }
      }
    }

    const eventType = queued.kind === 'full' ? queued.event.type : queued.eventType;
    const agentId =
      queued.kind === 'full'
        ? typeof queued.event.agentId === 'string'
          ? queued.event.agentId
          : null
        : queued.agentId;
    const routingKnown = queued.kind === 'full' ? true : queued.routingKnown;

    if (isGlobalEvent(eventType)) {
      if (liveEnvelope !== undefined) {
        this.recordAndEmitGlobalRaw(liveEnvelope);
        const recipients = new Set<BroadcastTarget>(this.globalTargets);
        for (const target of this.allTargets()) recipients.add(target);
        for (const target of recipients) {
          try {
            target.send(liveEnvelope, 'immediate');
          } catch {
          }
        }
        if (liveEnvelope.session_id === state.sessionId) {
          for (const rawTarget of state.rawTargets) {
            try {
              rawTarget.send(liveEnvelope);
            } catch {}
          }
        }
      } else if (!volatile) {
        const frame = buildResyncRequired(sessionId, 'journal_gap', durableSeq, journal.epoch);
        const recipients = new Set<BroadcastTarget>(this.globalTargets);
        for (const target of this.allTargets()) recipients.add(target);
        for (const target of recipients) {
          try {
            target.sendControl?.(frame);
          } catch {}
        }
        this.notifyRawTargetsGap(state, durableSeq);
        this.recordGlobalRawGap(sessionId);
      }
      return;
    }

    if (liveEnvelope !== undefined) {
      for (const rawTarget of state.rawTargets) {
        try {
          rawTarget.send(liveEnvelope);
        } catch {}
      }
    } else if (!volatile) {
      this.notifyRawTargetsGap(state, durableSeq);
    }

    const subject = { eventType, agentId, routingKnown };
    const rosterHintEnvelope =
      liveEnvelope !== undefined
        ? liveEnvelope
        : gapOutcome?.kind === 'gap'
          ? buildRosterHintEnvelopeFromGap(gapOutcome.gap, sessionId, journal.epoch)
          : undefined;
    const isRosterHint =
      ((eventType === 'agent.status.updated' ||
        eventType === 'agent.branch_sealed' ||
        eventType === 'agent.tool_lock_changed' ||
        eventType === 'turn.started' ||
        eventType === 'turn.ended') &&
        agentId !== MAIN_AGENT_ID) ||
      ((eventType === 'task.started' || eventType === 'task.terminated') &&
        ((trackerEvent as { info?: { kind?: unknown } }).info?.kind === 'agent' ||
          (queued.kind === 'oversized_gap' && queued.rosterHint?.infoKind === 'agent'))) ||
      eventType === 'subagent.spawned' ||
      eventType === 'subagent.started' ||
      eventType === 'subagent.suspended' ||
      eventType === 'subagent.completed' ||
      eventType === 'subagent.failed';

    for (const [target, sub] of targets) {
      if (!subjectMatchesAgentFilter(subject, sub.agentFilter)) continue;
      try {
        if (
          subjectSuppressedByTranscript(
            subject,
            sub.transcriptGrades,
            sub.transcriptOnly === true,
            sub.detachedTranscriptAgents,
          )
        ) {
          if (target.sendRosterHint !== undefined && isRosterHint && rosterHintEnvelope !== undefined) {
            target.sendRosterHint(rosterHintEnvelope);
          } else if (!volatile) {
            target.sendDurableCursor?.({ seq: durableSeq, epoch: journal.epoch });
          }
          continue;
        }
        if (liveEnvelope !== undefined) {
          target.send(liveEnvelope);
        } else if (!volatile) {
          target.sendControl?.(buildResyncRequired(sessionId, 'journal_gap', durableSeq, journal.epoch));
        }
      } catch {
      }
    }
  }

  private buildEnvelope(
    seq: number,
    sessionId: string,
    event: Event,
    extras: { epoch?: string; volatile?: boolean; offset?: number },
  ): EventEnvelope {
    return {
      type: event.type,
      seq,
      session_id: sessionId,
      timestamp:
        event.time !== undefined
          ? new Date(event.time).toISOString()
          : new Date().toISOString(),
      payload: event,
      ...extras,
    };
  }

  private notifyRawTargetsGap(state: SessionState, seq: number): void {
    const info = { epoch: state.journal.epoch, seq, reason: 'journal_gap' as const };
    for (const rawTarget of state.rawTargets) {
      try {
        if (rawTarget.onGap !== undefined) rawTarget.onGap(info);
        else rawTarget.onEvicted?.(info);
      } catch {}
    }
  }

  private *allTargets(): Iterable<BroadcastTarget> {
    for (const state of this.sessions.values()) {
      for (const target of state.targets.keys()) yield target;
    }
  }
}

function admittedForHistory(seed: PendingTranscriptSeed): Set<string> {
  const admitted = new Set<string>();
  for (const agentId of Object.keys(seed.spec)) {
    if (agentId !== '*' && !seed.delivered.has(agentId) && gradeFor(seed.spec, agentId) !== 'off') admitted.add(agentId);
  }
  const wildcardCursor = seed.transcriptSince?.['*'] !== undefined;
  for (const descriptor of seed.store.agents()) {
    const { agentId } = descriptor;
    if (admitted.has(agentId) || seed.delivered.has(agentId) || gradeFor(seed.spec, agentId) === 'off') continue;
    const claimed = wildcardCursor || seed.transcriptSince?.[agentId] !== undefined;
    if (claimed || seed.store.getAgent(agentId) !== undefined) admitted.add(agentId);
  }
  return admitted;
}

function readContextMessagesRef(agent: IAgentScopeHandle | undefined): readonly ContextMessage[] | undefined {
  if (agent === undefined) return undefined;
  try {
    return agent.accessor.get(IAgentContextMemoryService).get();
  } catch {
    return undefined;
  }
}

function probeAuthoritativeContext(agent: IAgentScopeHandle): {
  readonly authoritative: boolean;
  readonly messages: readonly ContextMessage[];
} {
  try {
    const svc = agent.accessor.get(IAgentContextMemoryService);
    const first = svc.get();
    const second = svc.get();
    return {
      authoritative: first === second,
      messages: first === second ? first : [...first],
    };
  } catch {
    return { authoritative: false, messages: [] };
  }
}

function readCurrentPromptId(agent: IAgentScopeHandle | undefined): string | undefined {
  if (agent === undefined) return undefined;
  try {
    return agent.accessor.get(IAgentPromptService).list().active?.id;
  } catch {
    return undefined;
  }
}

function readSnapshotStatus(
  agent: IAgentScopeHandle | undefined,
): NonNullable<ReturnType<typeof readLegacyStatus>> | undefined {
  if (agent === undefined) return undefined;
  try {
    return readLegacyStatus(agent, { contextBreakdown: true });
  } catch {
    return undefined;
  }
}

const VOLATILE_SIGNAL_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
] as const;

const volatileSignalTypeSet: ReadonlySet<string> = new Set(VOLATILE_SIGNAL_TYPES);

const TRANSCRIPT_ONLY_STATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.prompt',
  'turn.steer',
  'context.clear',
  'context.apply_compaction',
  'context.undo',
  'tools.update_store',
]);

function isVolatileSignal(type: string): boolean {
  return volatileSignalTypeSet.has(type);
}

function legacyTaskEvent(event: Event2<any>, agentId: string, sessionId: string): Event | undefined {
  if (event.type !== 'task.started' && event.type !== 'task.terminated') return undefined;
  const legacyType =
    event.type === 'task.started' ? 'background.task.started' : 'background.task.terminated';
  return Object.assign({}, event, { type: legacyType, agentId, sessionId }) as unknown as Event;
}

export function isGlobalEvent(type: string): boolean {
  return isGlobalEventType(type);
}

function interactionRequestedEvent(interaction: Interaction, sessionId: string): Event | undefined {
  const agentId = interaction.origin.agentId ?? 'main';
  switch (interaction.kind) {
    case 'question':
      return {
        type: 'event.question.requested',
        agentId,
        sessionId,
        ...toWireQuestion(interaction, sessionId),
      } as unknown as Event;
    case 'approval':
      return {
        type: 'event.approval.requested',
        agentId,
        sessionId,
        ...toWireApproval(interaction, sessionId),
      } as unknown as Event;
    case 'user_tool':
      return {
        type: 'tool.requires_action',
        agentId,
        sessionId,
        ...toWirePendingUserTool(interaction, sessionId),
      } as unknown as Event;
    default:
      return undefined;
  }
}

function interactionResolvedEvent(
  kind: InteractionKind,
  id: string,
  response: unknown,
  sessionId: string,
  agentId: string,
): Event | undefined {
  const resolvedAt = new Date().toISOString();
  switch (kind) {
    case 'question': {
      const resolution = projectQuestionResolution(response);
      if (resolution.kind === 'dismissed') {
        return {
          type: 'event.question.dismissed',
          agentId,
          sessionId,
          question_id: id,
          dismissed_at: resolvedAt,
        } as unknown as Event;
      }
      return {
        type: 'event.question.answered',
        agentId,
        sessionId,
        question_id: id,
        answers: resolution.answers,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    case 'approval': {
      const r =
        typeof response === 'object' && response !== null
          ? (response as Partial<ApprovalResponse>)
          : undefined;
      return {
        type: 'event.approval.resolved',
        agentId,
        sessionId,
        approval_id: id,
        decision: projectInteractionEndState('approval', response),
        scope: r?.scope,
        feedback: r?.feedback,
        selected_label: r?.selectedLabel,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    case 'user_tool': {
      const r = typeof response === 'object' && response !== null
        ? (response as { readonly isError?: boolean })
        : undefined;
      return {
        type: 'tool.action_resolved',
        agentId,
        sessionId,
        interaction_id: id,
        is_error: r?.isError === true,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    default:
      return undefined;
  }
}

type QuestionResolutionProjection =
  | { readonly kind: 'answered'; readonly answers: unknown }
  | { readonly kind: 'dismissed' };

function projectQuestionResolution(response: unknown): QuestionResolutionProjection {
  if (projectInteractionEndState('question', response) === 'dismissed') {
    return { kind: 'dismissed' };
  }
  if (typeof response === 'object' && response !== null && Object.hasOwn(response, 'answers')) {
    return {
      kind: 'answered',
      answers: (response as { readonly answers: unknown }).answers,
    };
  }
  return { kind: 'answered', answers: response };
}

function sessionMetaUpdatedPayload(
  payload: unknown,
): Pick<SessionMetaUpdatedEvent, 'title' | 'patch'> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Partial<SessionMetaUpdatedEvent>;
  const title = typeof candidate.title === 'string' ? candidate.title : undefined;
  const patch =
    typeof candidate.patch === 'object' &&
      candidate.patch !== null &&
      !Array.isArray(candidate.patch)
      ? candidate.patch
      : undefined;
  if (title === undefined && patch === undefined) return undefined;
  return { title, patch };
}

function sessionMetaUpdatedSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function sessionCreatedPayload(
  payload: unknown,
): { sessionId: string; session: SessionCreatedEvent['session'] } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as { sessionId?: unknown; session?: unknown };
  const sessionId =
    typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
      ? candidate.sessionId
      : undefined;
  const session =
    typeof candidate.session === 'object' &&
      candidate.session !== null &&
      !Array.isArray(candidate.session)
      ? (candidate.session as SessionCreatedEvent['session'])
      : undefined;
  if (sessionId === undefined || session === undefined) return undefined;
  return { sessionId, session };
}

interface CapabilityChangedPayload {
  capability_id: string;
  install: {
    running: boolean;
    step?: string;
    percent?: number;
    error?: string;
    note?: string;
  };
}

interface ModelCatalogChangedPayload {
  changed: unknown[];
  unchanged: unknown[];
  failed: unknown[];
}

function modelCatalogChangedPayload(payload: unknown): ModelCatalogChangedPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { changed, unchanged, failed } = payload as Record<string, unknown>;
  if (!Array.isArray(changed) || !Array.isArray(unchanged) || !Array.isArray(failed)) {
    return undefined;
  }
  return { changed, unchanged, failed };
}

function capabilityChangedPayload(payload: unknown): CapabilityChangedPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const id = (payload as { capability_id?: unknown }).capability_id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const install = (payload as { install?: unknown }).install;
  if (typeof install !== 'object' || install === null) return undefined;
  const running = (install as { running?: unknown }).running;
  if (typeof running !== 'boolean') return undefined;
  const out: CapabilityChangedPayload['install'] = { running };
  for (const key of ['step', 'error', 'note'] as const) {
    const value = (install as Record<string, unknown>)[key];
    if (typeof value === 'string') out[key] = value;
  }
  const percent = (install as { percent?: unknown }).percent;
  if (typeof percent === 'number') out.percent = percent;
  return { capability_id: id, install: out };
}

function configWarningPayload(payload: unknown): { warnings: ConfigWarningItem[] } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const warnings = (payload as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return undefined;
  const items: ConfigWarningItem[] = [];
  for (const warning of warnings) {
    if (typeof warning !== 'object' || warning === null) return undefined;
    const message = (warning as { message?: unknown }).message;
    if (typeof message !== 'string' || message.length === 0) return undefined;
    const domain = (warning as { domain?: unknown }).domain;
    if (domain !== undefined && typeof domain !== 'string') return undefined;
    items.push(typeof domain === 'string' ? { domain, message } : { message });
  }
  return { warnings: items };
}
