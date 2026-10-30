/**
 * SessionController — one session's REST snapshot, ordered transcript intake,
 * publication scheduling, resync, and user actions. Canonical transcript ops
 * are applied immediately and projected to React at most once per flush.
 */

import type {
  ApprovalDecision,
  ApprovalScope,
  DeferredAppendTiming,
  ExecutionSelection,
  MessageContent,
  PermissionMode,
  PromptItem,
  PromptPlanGate,
  PromptSubmission,
  PromptSubmitResult,
  QuestionResponse,
  Session,
  SessionSnapshotResponse,
} from '@kiki/protocol';
import {
  AgentTranscript,
  GRADE_RANK,
  gradeFor,
  itemId,
  releaseFramePayload,
  type AgentTranscriptSnapshot,
  type TranscriptCoverage,
  type TranscriptCursor,
  type TranscriptEvent,
  type TranscriptGrade,
  type TranscriptGradeSpec,
  type TranscriptOperation,
  type TranscriptRead,
  type TranscriptTodo,
  type TranscriptTurn,
} from '@kiki/transcript';
import type { SessionViewTranscriptDetail } from '@kiki/klient/session-view';
import { OlderLoadCoordinator, type OlderLoadResult } from './olderLoadCoordinator';

import {
  API_CODES,
  ApiError,
  DEFAULT_TRANSCRIPT_GRADES,
  isUnconfirmedTransportError,
  transcriptGradesForFocus,
  type AgentTranscriptResponse,
  type SessionCursor,
  type SessionTransport,
} from '../transport';
import { RPCError, type SessionViewFacade, type SessionViewSignal, type SessionViewSubscription } from '@kiki/klient/session-view';
import {
  MAIN_AGENT_ID,
  applyTranscriptShell,
  appendLocalUserMessage,
  createViewState,
  markApprovalResolved,
  markQuestionOutcome,
  prependOlderTranscriptSnapshot,
  projectAgentTranscriptView,
  projectMessageContent,
  SessionAgentForestQuery,
  setLoadError,
  setLoadingOlder,
  setOlderError,
  setResyncFailed,
  setResyncing,
  setSessionRecord,
  snapshotSubagentAgentId,
  transcriptDetailKey,
  type SessionViewState,
  type QuestionOutcome,
  type TranscriptDetailKind,
} from './transcript';
import { emptyOlderSnapshot } from './transcript/selectors';
import { collectTranscriptContentRefs, patchTranscriptContent, patchAgentTranscriptContent, replaceAgentContentEntity, replaceSnapshotContentEntity, snapshotContentEntity, transcriptContentEntity } from './transcript/content';
import { adoptContentPreviewField, applyContentSegment, carryContentHydration, contentPathValue, restoreContentPreview, sameContentRef, type ContentRef, type ContentSource, type ContentWindow } from '@kiki/transcript';
import { isModelSwitchQueueId } from './modelSwitchQueue';
import { questionAnswerTexts } from './transcript/questionAnswers';
import { interactionToBlock } from './transcript/project';
import { isSteerSettled, newSteerPromptId, withPendingSteers, type PendingSteer } from './transcript/steer';
import type { QueuedPromptMeta } from './transcript/types';
import type { AgentForest } from './agentTree';
import { messageContentSchema } from '@kiki/protocol';
import { forgetUnconfirmedSubmission, preserveSubmission } from '../composer/submissionRecovery';

export type Listener = () => void;

export const CONTENT_INLINE_TEXT_CHARS = 512 * 1024;
export const CONTENT_RANGE_CHARS = 4096;
const CONTENT_RANGE_CACHE_BYTES = 2 * 1024 * 1024;
const CONTENT_BODY_CACHE_BYTES = 8 * 1024 * 1024;

export const RESYNC_PAUSED_ERROR = 'Session is resyncing; sending is paused';

export function assertSessionWritable(state: Pick<SessionViewState, 'resyncing' | 'resyncFailed'>): void {
  if (state.resyncing || state.resyncFailed) {
    throw new Error(RESYNC_PAUSED_ERROR);
  }
}

const RESYNC_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
const TOOL_DETAIL_PREPARING_RETRY_MS = 80;
export const OLDER_HISTORY_TIMEOUT_MS = 10_000;
const OLDER_PREPARING_BATCH_LIMIT = 16;
const REWRITE_RESET_TIMEOUT_MS = 10_000;
const HIDDEN_FRAME_FLUSH_INTERVAL_MS = 1000;
/**
 * Roster reads one agent id may cost before its row is given up on: one
 * speculative read when the agent appears, plus up to two more when later
 * spawn evidence says the row must exist by now. A row the session never emits
 * (an external delegation, say) then stops costing whole-session snapshots.
 */
const MAX_ROSTER_ROW_READS = 3;
const MAX_ROSTER_REVISION_REFRESHES = 3;

export interface PublicationScheduler {
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

interface VisibilityDocument {
  readonly visibilityState?: string;
  readonly addEventListener?: (type: string, listener: () => void) => void;
  readonly removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * The browser globals this module probes, read through `globalThis` so the file
 * typechecks in compilation units without the DOM lib while runtime access and
 * the `typeof` guards stay identical to a bare global reference.
 */
interface BrowserGlobal {
  readonly requestAnimationFrame?: (callback: () => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly document?: VisibilityDocument;
}

const browserGlobal = globalThis as unknown as BrowserGlobal;

interface PendingTranscriptBatch {
  readonly ops: TranscriptOperation[];
  cursor: TranscriptCursor;
  /**
   * Server-side coverage watermark of the merged events: seqs beyond
   * `cursor.seq` up to here were seen but filtered out of `ops`. The resume
   * cursor must advance past them or a reconnect re-pulls the filtered tail.
   */
  throughSeq: number;
}

interface ToolCountObservation {
  readonly count: number;
  readonly cursor: TranscriptCursor;
}

interface ToolCountSpan {
  readonly from: TranscriptCursor;
  readonly through: TranscriptCursor;
  readonly delta: number | undefined;
}

const TOOL_COUNT_SPAN_LIMIT = 128;

interface RewriteHold {
  readonly token: number;
  readonly mainEpoch: string | undefined;
  generation: number | undefined;
  subscribeToken: number | undefined;
  readonly deferredBatches: PendingTranscriptBatch[];
  timer: ReturnType<typeof setTimeout> | null;
}

const browserScheduler: PublicationScheduler = {
  schedule(callback) {
    const { requestAnimationFrame } = browserGlobal;
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 24);
  },
  cancel(handle) {
    const { cancelAnimationFrame } = browserGlobal;
    if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') {
      cancelAnimationFrame(handle);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

function browserVisibilityDocument(): VisibilityDocument | undefined {
  return browserGlobal.document;
}

/** UTF-16 size of a JSON-serializable value; an unserializable value counts as zero. */
function estimateJsonBytes(value: unknown): number {
  try {
    return (JSON.stringify(value)?.length ?? 0) * 2;
  } catch {
    return 0;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Why a "send now" did not reach the running turn. `submit` and `refused`
 * leave nothing behind on the server, so the text belongs back in the
 * composer; `unknown` may still arrive and must not be re-sent blindly.
 */
function nonEmpty<T>(items: readonly T[]): readonly T[] | undefined {
  return items.length === 0 ? undefined : items;
}

export class SendNowError extends Error {
  constructor(
    readonly reason: 'submit' | 'refused' | 'unknown',
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SendNowError';
  }
}

export class SessionController {
  private readonly client: SessionTransport;
  private viewHandle: SessionViewSubscription | undefined;
  private connectionGeneration: number | undefined;
  private viewAttachment = 0;
  private openGeneration = 0;
  private bootstrapOpening: { readonly attachment: number; readonly resolve: () => void } | undefined;
  readonly sessionId: string;
  private state: SessionViewState;
  private publishedState: SessionViewState;
  private readonly listeners = new Set<Listener>();
  private readonly interruptedPromptListeners = new Set<(content: readonly MessageContent[]) => void>();
  private readonly scheduler: PublicationScheduler;
  private readonly usesBrowserScheduler: boolean;
  private readonly visibilityDocument: VisibilityDocument | undefined;
  private readonly rewriteResetTimeoutMs: number;
  private frameHandle: unknown = null;
  private hiddenFrameTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncInFlight = false;
  private resyncGeneration = 0;
  private readonly resyncIdleWaiters = new Set<() => void>();
  private rosterRefreshInFlight = false;
  private rosterReadQueued = false;
  private rosterReadInFlight = false;
  private rosterRevisionRefreshes = 0;
  /** Turn-structure paths with a preview already in flight. The replacement read must not preview again. */
  private readonly turnStructureRefreshKeys = new Set<string>();
  private rosterRefreshQueuedCursor: SessionCursor | undefined;
  /** Agent id → roster reads spent chasing its row (see `requestRosterRows`). */
  private readonly requestedRosterAgents = new Map<string, number>();
  private rosterLeaseTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private rewriteHold: RewriteHold | undefined;
  private rewriteHoldToken = 0;
  private closed = false;
  private abortActiveInFlight: Promise<void> | undefined;
  private lastRestoredPromptId: string | undefined;

  private readonly snapshotControllers = new Set<AbortController>();
  private readonly agentStates = new Map<string, SessionViewState>();
  private readonly publishedAgentStates = new Map<string, SessionViewState>();
  private readonly agentListeners = new Map<string, Set<Listener>>();
  private readonly dirtyAgents = new Set<string>();
  private readonly agentTranscripts = new Map<string, AgentTranscript>();
  private readonly olderPages = new Map<string, AgentTranscriptSnapshot>();
  private readonly transcriptCursors = new Map<string, TranscriptCursor>();
  private readonly historyReads = new Map<string, TranscriptRead>();
  private readonly todoReads = new Map<string, TranscriptRead>();
  private readonly appliedTranscriptGrades = new Map<string, TranscriptGrade>();
  /** Bumps on every applied reset so a resync can tell a baseline that landed during its snapshot from the one it is about to drop. */
  private readonly transcriptBaselineSerial = new Map<string, number>();
  private transcriptBaselineClock = 0;
  private readonly publishedTranscriptCursors = new Map<string, TranscriptCursor>();
  private readonly toolCountObservations = new Map<string, ToolCountObservation>();
  private readonly toolCountSpans = new Map<string, ToolCountSpan[]>();
  private readonly pendingTranscriptBatches = new Map<string, PendingTranscriptBatch>();
  private readonly pendingTranscriptAgents = new Set<string>();
  private readonly forestDirtyAgents = new Set<string>();
  private readonly historyGeneration = new Map<string, number>();
  private readonly olderLoads = new OlderLoadCoordinator((agentId) => {
    const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId);
    if (current?.loadingOlder) this.publishAgentView(agentId, setLoadingOlder(current, false));
  });
  private readonly emptyAgentState: SessionViewState;
  /** "Send now" echoes per agent, laid over each published view (transcript/steer.ts). */
  private readonly pendingSteers = new Map<string, readonly PendingSteer[]>();
  private readonly unprojectedQueueReceipts = new Map<string, PromptSubmitResult>();
  private publishedForest: AgentForest | undefined;
  private readonly forestQuery = new SessionAgentForestQuery();
  private readonly composedSnapshots = new Map<string, {
    live: AgentTranscriptSnapshot;
    older: AgentTranscriptSnapshot;
    snapshot: AgentTranscriptSnapshot;
  }>();
  private transcriptGrades: TranscriptGradeSpec = DEFAULT_TRANSCRIPT_GRADES;
  private focusedAgentId: string | undefined;
  private readonly agentViews = new Map<string, { readonly agentId: string; readonly grade: TranscriptGrade }>();
  private readonly catchupByAgent = new Map<string, Promise<void>>();
  private readonly catchupControllers = new Map<string, AbortController>();
  private readonly globalCoverage = new Map<string, AgentTranscriptSnapshot['globalCoverage']>();
  private readonly detailReads = new Map<string, Promise<boolean>>();
  private readonly olderPageCursors = new Map<string, string>();
  private readonly olderPageTurns = new Map<string, string>();
  private readonly historyPreviewPages = new Map<string, { agentId: string; beforeItem?: string; beforeTurn?: string; unloaded: boolean }>();
  private readonly historyPreviewReaders = new Map<string, number>();
  private readonly historyPreviewReads = new Map<string, { agentId: string; controller: AbortController; promise: Promise<boolean> }>();
  private readonly historyPreviewBytes: number;
  private queuedTimingWriteSequence = 0;
  private readonly queuedTimingWrites = new Map<string, number>();
  private readonly contentControllers = new Map<string, AbortController>();
  private readonly contentReaders = new Map<string, { agentId: string; source: ContentSource; roots: readonly string[]; includeOlder: boolean; readers: number; blocked: boolean; ref?: ContentRef }>();
  private contentPumpRunning = false;
  private readonly contentPumpReads = new Set<string>();
  private readonly contentRanges = new Map<string, string>();
  private contentRangeBytes = 0;
  private readonly rangeControllers = new Map<AbortController, string>();
  private readonly contentBodies = new Map<string, { agentId: string; source: ContentSource; base: ContentWindow; bytes: number }>();
  private readonly toolDetails = new Map<string, Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup']>();
  private readonly toolDetailEpochs = new Map<string, number>();
  private readonly toolDetailReads = new Map<string, { promise: Promise<Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup']>; controller: AbortController; readers: number }>();
  private readonly entityPageCursors = new Map<string, string | null>();
  private latestSnapshot: SessionSnapshotResponse | undefined;
  private durableIngressReadInFlight: Promise<void> | undefined;
  private readonly durableSteerReads = new Map<string, { agentId: string; promptId: string }>();
  private durableSteerReadTimer: ReturnType<typeof setTimeout> | undefined;
  private durableSteerReadInFlight = false;
  private durableSteerReadGeneration = 0;
  private readonly catchupReplay = new Map<
    string,
    { readonly ops: readonly TranscriptOperation[]; readonly cursor: TranscriptCursor }
  >();
  private ephemeralHint: boolean | undefined;
  private persistenceHint: 'temporary' | 'saved' | 'unknown' | undefined;

  constructor(
    client: SessionTransport,
    private readonly view: SessionViewFacade,
    sessionId: string,
    options: { scheduler?: PublicationScheduler; rewriteResetTimeoutMs?: number; historyPreviewBytes?: number; ephemeral?: boolean; persistenceHint?: 'temporary' | 'saved' | 'unknown' } = {},
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.ephemeralHint = options.ephemeral;
    this.persistenceHint = options.persistenceHint ?? (options.ephemeral === undefined ? 'unknown' : options.ephemeral ? 'temporary' : 'saved');
    this.scheduler = options.scheduler ?? browserScheduler;
    this.usesBrowserScheduler = options.scheduler === undefined;
    this.visibilityDocument = this.usesBrowserScheduler ? browserVisibilityDocument() : undefined;
    this.rewriteResetTimeoutMs = options.rewriteResetTimeoutMs ?? REWRITE_RESET_TIMEOUT_MS;
    this.historyPreviewBytes = options.historyPreviewBytes ?? 64 * 1024 * 1024;
    this.state = createViewState(sessionId);
    this.publishedState = this.state;
    this.emptyAgentState = createViewState(sessionId);
    this.visibilityDocument?.addEventListener?.('visibilitychange', this.onVisibilityChange);
  }

  getForest = (): AgentForest | undefined => this.publishedForest;

  private readonly onVisibilityChange = (): void => {
    if (this.closed) return;
    if (this.isDocumentHidden()) {
      this.cancelVisibleFrameFlush();
    } else {
      this.clearHiddenFrameTimer();
    }
    if (this.pendingTranscriptAgents.size > 0 || this.pendingTranscriptBatches.size > 0) {
      this.scheduleFrameFlush();
    }
  };

  getState = (): SessionViewState => this.publishedState;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeInterruptedPrompt = (listener: (content: readonly MessageContent[]) => void): (() => void) => {
    this.interruptedPromptListeners.add(listener);
    return () => this.interruptedPromptListeners.delete(listener);
  };

  getAgentState = (agentId: string): SessionViewState =>
    this.publishedAgentStates.get(agentId) ?? this.agentStates.get(agentId) ?? this.emptyAgentState;

  /** Per-agent cursor at the latest transcript publication, not the session event cursor. */
  getAgentTranscriptCursor = (agentId: string): TranscriptCursor | undefined =>
    this.publishedTranscriptCursors.get(agentId);

  /** Observe summary state, explicitly admitting cold history at turn grade without taking timeline focus. */
  subscribeAgent = (agentId: string, listener: Listener): (() => void) => {
    const listeners = this.agentListeners.get(agentId) ?? new Set<Listener>();
    listeners.add(listener);
    this.agentListeners.set(agentId, listeners);
    this.refreshTranscriptGrades();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.agentListeners.delete(agentId);
        this.refreshTranscriptGrades();
      }
    };
  };

  private notifyMain(): void {
    this.retireSettledSteers(MAIN_AGENT_ID, this.state);
    this.publishedState = withPendingSteers(this.state, this.getPendingSteers(MAIN_AGENT_ID));
    for (const listener of this.listeners) listener();
  }

  private publishAgents(): void {
    for (const agentId of this.dirtyAgents) {
      const state = this.agentStates.get(agentId);
      if (state === undefined) continue;
      this.retireSettledSteers(agentId, state);
      this.publishedAgentStates.set(agentId, withPendingSteers(state, this.getPendingSteers(agentId)));
      for (const listener of this.agentListeners.get(agentId) ?? []) listener();
    }
    this.dirtyAgents.clear();
  }

  private setState(next: SessionViewState, immediate = true): void {
    if (next === this.state) return;
    const rosterChanged = next.snapshotSubagents !== this.state.snapshotSubagents;
    this.state = next;
    if (rosterChanged) this.scheduleRosterLease();
    this.queueAutomaticRosterRead();
    if (immediate) this.notifyMain();
  }

  private clearRosterLeaseTimer(): void {
    if (this.rosterLeaseTimer === null) return;
    clearTimeout(this.rosterLeaseTimer);
    this.rosterLeaseTimer = null;
  }

  private scheduleRosterLease(): void {
    this.clearRosterLeaseTimer();
    if (this.closed) return;
    let nearest = Infinity;
    for (const row of this.state.snapshotSubagents) {
      if (row.refreshing !== true) continue;
      const until = Date.parse(row.refreshing_until ?? '');
      nearest = Math.min(nearest, Number.isFinite(until) ? until : 0);
    }
    if (nearest === Infinity) return;
    this.rosterLeaseTimer = setTimeout(() => {
      this.rosterLeaseTimer = null;
      if (this.closed) return;
      const now = Date.now();
      let changed = false;
      const next = this.state.snapshotSubagents.map((row) => {
        if (row.refreshing !== true || Date.parse(row.refreshing_until ?? '') > now) return row;
        changed = true;
        const terminal = row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled';
        return { ...row, refreshing: undefined, refreshing_until: undefined,
          live: terminal ? false : row.live };
      });
      if (!changed) {
        this.scheduleRosterLease();
        return;
      }
      this.setState({ ...this.state, version: this.state.version + 1, snapshotSubagents: next }, false);
      this.publishForest();
      this.notifyMain();
    }, Math.min(2_147_483_647, Math.max(0, nearest - Date.now())));
  }

  private isDocumentHidden(): boolean {
    return this.usesBrowserScheduler && this.visibilityDocument?.visibilityState === 'hidden';
  }

  private cancelVisibleFrameFlush(): void {
    if (this.frameHandle === null) return;
    this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
  }

  private clearHiddenFrameTimer(): void {
    if (this.hiddenFrameTimer === null) return;
    clearTimeout(this.hiddenFrameTimer);
    this.hiddenFrameTimer = null;
  }

  private scheduleFrameFlush(): void {
    if (this.frameHandle !== null || this.hiddenFrameTimer !== null || this.closed) return;
    if (this.isDocumentHidden()) {
      this.hiddenFrameTimer = setTimeout(() => {
        this.hiddenFrameTimer = null;
        this.flushFrames();
      }, HIDDEN_FRAME_FLUSH_INTERVAL_MS);
      return;
    }
    this.frameHandle = this.scheduler.schedule(() => {
      this.frameHandle = null;
      this.flushFrames();
    });
  }

  /** Public test seam and fallback for environments without an actual rAF. */
  flushFrames = (): void => {
    if (this.closed) return;
    this.flushPendingTranscriptBatches();
    if (this.pendingTranscriptAgents.size > 0) {
      const agents = [...this.pendingTranscriptAgents];
      this.pendingTranscriptAgents.clear();
      for (const agentId of agents) {
        const store = this.agentTranscripts.get(agentId);
        if (store !== undefined) this.publishProjectedAgent(agentId, store);
      }
    }
  };

  private async readSnapshot(): Promise<SessionSnapshotResponse> {
    const controller = new AbortController();
    this.snapshotControllers.add(controller);
    const attachment = this.viewAttachment;
    try {
      const snapshot = await this.view.snapshot({ signal: controller.signal });
      if (!this.closed && !controller.signal.aborted && attachment === this.viewAttachment &&
        (!this.state.loaded || this.resyncInFlight || (snapshot.epoch === this.state.cursor.epoch && snapshot.as_of_seq >= this.state.cursor.seq))) {
        this.latestSnapshot = snapshot;
        this.state = { ...this.state, contentRefs: [...collectTranscriptContentRefs(this.composeAgentSnapshot(MAIN_AGENT_ID)), ...(snapshot.contentRefs ?? [])] };
      }
      return snapshot;
    } finally {
      this.snapshotControllers.delete(controller);
    }
  }

  /** Initial sync seeds visible transcripts independently of the session shell when the transport supports it. */
  async open(): Promise<void> {
    if (this.closed || this.isSuspended) return;
    if (this.view.bootstrap !== undefined) {
      this.finishBootstrapOpening();
      this.transcriptGrades = this.requestedTranscriptGrades();
      await new Promise<void>((resolve) => {
        this.bootstrapOpening = { attachment: this.viewAttachment + 1, resolve };
        try {
          this.attachView({ seq: 0 }, true);
        } catch (error) {
          this.finishBootstrapOpening();
          this.setState({ ...setLoadError(this.state, errorMessage(error, 'Could not load session')), loaded: this.state.loaded });
        }
      });
      return;
    }
    const generation = ++this.openGeneration;
    const attachment = this.viewAttachment;
    try {
      const snapshot = await this.readSnapshot();
      if (this.closed || this.isSuspended || generation !== this.openGeneration || attachment !== this.viewAttachment) return;
      this.setState(this.applyTranscriptShellSnapshot(snapshot));
      this.transcriptGrades = this.requestedTranscriptGrades();
      this.attachView({ seq: snapshot.as_of_seq, epoch: snapshot.epoch });
      void this.refreshDurableIngress();
    } catch (error) {
      if (this.closed || this.isSuspended || generation !== this.openGeneration || attachment !== this.viewAttachment) return;
      if (isAbortError(error)) return;
      this.setState({ ...setLoadError(this.state, errorMessage(error, 'Could not load session')), loaded: this.state.loaded });
    }
  }

  private finishBootstrapOpening(): void {
    const opening = this.bootstrapOpening;
    this.bootstrapOpening = undefined;
    opening?.resolve();
  }

  private attachView(sessionCursor: SessionCursor, bootstrap = false): void {
    const attachment = ++this.viewAttachment;
    this.droppedWithLiveWork = false;
    const previous = this.viewHandle;
    this.viewHandle = undefined;
    previous?.close();
    const qualifiedCursors = [...this.transcriptCursors].filter(([agentId]) => this.hasTranscriptBaseline(agentId));
    const input = {
      sessionCursor,
      transcriptGrades: this.transcriptGrades,
      transcriptSince: qualifiedCursors.length === 0 ? undefined : Object.fromEntries(qualifiedCursors),
    };
    const onSignal = (signal: SessionViewSignal) => {
      if (attachment === this.viewAttachment) this.handleSignal(signal);
    };
    this.viewHandle = bootstrap && this.view.bootstrap !== undefined
      ? this.view.bootstrap(input, onSignal) : this.view.subscribe(input, onSignal);
    if (bootstrap && this.bootstrapOpening === undefined) this.viewHandle.updateSessionCursor(this.state.cursor);
  }

  nudge(): void {
    this.viewHandle?.nudge();
  }

  /** True while the controller holds no live view subscription but keeps its store. */
  get suspended(): boolean {
    return this.isSuspended;
  }

  private isSuspended = false;

  /**
   * Park a loaded view: detach the live subscription and cancel in-flight
   * reads, but keep the canonical per-agent stores and cursors so `resume()`
   * can repaint instantly and catch up from where it stopped.
   */
  suspend(): void {
    if (this.closed || this.isSuspended) return;
    this.isSuspended = true;
    this.finishBootstrapOpening();
    this.pauseDurableSteerReads();
    this.resolveResyncIdleWaiters();
    for (const controller of this.snapshotControllers) controller.abort();
    this.snapshotControllers.clear();
    this.clearResyncTimer();
    this.clearRosterLeaseTimer();
    this.clearRewriteHold();
    this.cancelVisibleFrameFlush();
    this.clearHiddenFrameTimer();
    // Batches that have not been applied yet are dropped together with their
    // cursors: resume re-requests everything after the last applied cursor.
    this.pendingTranscriptBatches.clear();
    this.catchupReplay.clear();
    this.flushFrames();
    for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
    this.olderLoads.cancelAll();
    if (this.state.loadingOlder || this.state.olderError !== undefined) {
      this.setState({ ...this.state, loadingOlder: false, olderError: undefined }, false);
    }
    this.viewAttachment += 1;
    this.viewHandle?.close();
    this.viewHandle = undefined;
  }

  /**
   * Re-attach a suspended view. The retained window renders immediately; the
   * subscription resumes from the last applied session and transcript
   * cursors, and the returned promise settles after the fresh snapshot shell
   * refreshes session-level fields.
   */
  resume(): Promise<void> {
    if (this.closed || !this.isSuspended) return Promise.resolve();
    this.isSuspended = false;
    this.scheduleDurableSteerRead();
    if (!this.state.loaded) return this.open();
    if (this.state.resyncFailed) return this.resync();
    this.transcriptGrades = this.requestedTranscriptGrades();
    this.attachView(this.state.cursor);
    void this.pumpContentReads();
    return this.refreshShell();
  }

  private async refreshShell(): Promise<void> {
    const attachment = this.viewAttachment;
    try {
      const snapshot = await this.readSnapshot();
      if (this.closed || this.isSuspended || attachment !== this.viewAttachment) return;
      if (this.state.cursor.epoch !== undefined && snapshot.epoch !== this.state.cursor.epoch) {
        void this.resync();
        return;
      }
      this.setState(this.applyTranscriptShellSnapshot(snapshot), false);
      this.publishForest();
      this.notifyMain();
    } catch (error) {
      if (this.closed || this.isSuspended || attachment !== this.viewAttachment) return;
      if (isAbortError(error)) return;
      const message = errorMessage(error, 'Could not load session');
      this.setState({ ...setLoadError(this.state, message), loaded: this.state.loaded });
    }
  }

  /**
   * Rough resident size of the retained view (canonical stores plus loaded
   * older pages), used by the view cache to bound what it keeps.
   */
  residentBytes(): number {
    let bytes = 0;
    for (const store of this.agentTranscripts.values()) bytes += store.residentReport().estimatedBytes;
    for (const older of this.olderPages.values()) bytes += estimateJsonBytes(older);
    return bytes;
  }

  async retryOpen(): Promise<void> {
    if (this.closed) return;
    this.setState(setLoadError(this.state, undefined));
    if (this.state.loaded && this.viewHandle !== undefined) await this.refreshShell();
    else await this.open();
  }

  close(): void {
    this.closed = true;
    this.finishBootstrapOpening();
    this.pauseDurableSteerReads();
    this.durableSteerReads.clear();
    this.resolveResyncIdleWaiters();
    for (const controller of this.snapshotControllers) controller.abort();
    this.snapshotControllers.clear();
    this.agentViews.clear();
    this.visibilityDocument?.removeEventListener?.('visibilitychange', this.onVisibilityChange);
    this.clearResyncTimer();
    this.clearRosterLeaseTimer();
    this.clearRewriteHold();
    this.cancelVisibleFrameFlush();
    this.clearHiddenFrameTimer();
    this.pendingTranscriptBatches.clear();
    this.pendingTranscriptAgents.clear();
    this.composedSnapshots.clear();
    for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
    this.historyGeneration.clear();
    this.historyPreviewReads.clear();
    this.historyPreviewReaders.clear();
    this.historyPreviewPages.clear();
    this.contentReaders.clear();
    this.contentBodies.clear();
    this.toolDetails.clear();
    this.contentRanges.clear(); this.contentRangeBytes = 0;
    this.olderLoads.cancelAll();
    this.queuedTimingWrites.clear();
    if (this.state.loadingOlder || this.state.olderError !== undefined) {
      this.state = { ...this.state, loadingOlder: false, olderError: undefined };
    }
    this.viewAttachment += 1;
    this.viewHandle?.close();
    this.viewHandle = undefined;
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  private beginRewriteHold(): void {
    if (this.rewriteHold !== undefined) return;
    const token = (this.rewriteHoldToken += 1);
    const generation = this.connectionGeneration;
    const pendingMain = this.pendingTranscriptBatches.get(MAIN_AGENT_ID);
    const hold: RewriteHold = {
      token,
      mainEpoch: (pendingMain?.cursor ?? this.transcriptCursors.get(MAIN_AGENT_ID))?.epoch,
      generation: Number.isInteger(generation) ? generation : undefined,
      subscribeToken: undefined,
      deferredBatches: [],
      timer: null,
    };
    if (pendingMain?.ops.some((op) => op.op === 'items.remove') === true) {
      this.pendingTranscriptBatches.delete(MAIN_AGENT_ID);
      hold.deferredBatches.push(pendingMain);
    }
    hold.timer = setTimeout(() => this.recoverRewriteHold(token), this.rewriteResetTimeoutMs);
    this.rewriteHold = hold;
  }

  private armRewriteSubscription(token: number): void {
    const hold = this.rewriteHold;
    if (hold === undefined || hold.token !== token) return;
    hold.subscribeToken = token;
    if (hold.mainEpoch !== undefined) return;
    const generation = this.connectionGeneration;
    hold.generation = generation === undefined ? undefined : generation + 1;
    this.viewHandle?.restart();
  }

  private clearRewriteHold(token?: number): void {
    const hold = this.rewriteHold;
    if (hold === undefined || (token !== undefined && hold.token !== token)) return;
    if (hold.timer !== null) clearTimeout(hold.timer);
    this.rewriteHold = undefined;
  }

  private recoverRewriteHold(token: number): void {
    if (this.closed || this.rewriteHold?.token !== token) return;
    this.clearRewriteHold(token);
    this.viewHandle?.restart();
    if (this.resyncInFlight) {
      this.hardResyncQueued = true;
      return;
    }
    void this.resync();
  }

  private matchesRewriteGeneration(generation: number | undefined): boolean {
    const heldGeneration = this.rewriteHold?.generation;
    return heldGeneration === undefined || generation === heldGeneration;
  }

  private completesRewriteHold(hold: RewriteHold, cursor: TranscriptCursor): boolean {
    if (hold.mainEpoch !== undefined) {
      return cursor.epoch !== undefined && cursor.epoch !== hold.mainEpoch;
    }
    return hold.subscribeToken === hold.token;
  }

  handleTranscript(event: TranscriptEvent, generation?: number): void {
    if (this.closed || event.session_id !== this.sessionId) return;
    const hold = this.rewriteHold;
    if (event.type === 'transcript.reset') {
      if (hold !== undefined && event.agent_id === MAIN_AGENT_ID) {
        if (!this.matchesRewriteGeneration(generation)) return;
        if (!this.completesRewriteHold(hold, event.cursor)) return;
        this.clearRewriteHold(hold.token);
      }
      const appliedCursor = this.transcriptCursors.get(event.agent_id);
      const appliedGrade = this.appliedTranscriptGrades.get(event.agent_id);
      const pending = this.pendingTranscriptBatches.get(event.agent_id);
      const seenThrough = Math.max(appliedCursor?.seq ?? -1, pending?.throughSeq ?? -1);
      if (hold === undefined && !this.catchupByAgent.has(event.agent_id) &&
          appliedCursor?.epoch !== undefined && event.cursor.epoch === appliedCursor.epoch &&
          (event.cursor.seq < seenThrough ||
            (event.cursor.seq === seenThrough && appliedGrade !== undefined &&
              GRADE_RANK[event.grade] <= GRADE_RANK[appliedGrade]))) return;
      this.applyTranscriptReset(event.agent_id, event.snapshot, event.coverage, event.cursor, event.grade, event.read);
      return;
    }
    if (hold !== undefined && event.agent_id === MAIN_AGENT_ID) {
      if (!this.matchesRewriteGeneration(generation)) return;
      if (hold.deferredBatches.length > 0 || event.ops.some((op) => op.op === 'items.remove')) {
        hold.deferredBatches.push({
          ops: [...event.ops],
          cursor: event.cursor,
          throughSeq: event.through_seq,
        });
        return;
      }
    }
    this.applyTranscriptOps(event.agent_id, event.ops, event.cursor, event.through_seq);
  }

  /**
   * Durable `session_event` seq is the message-closure watermark (`expected_cursor`).
   * Transcript ops use a per-agent seq and must not overwrite this.
   */
  private advanceSessionCursor(cursor: SessionCursor): void {
    const current = this.state.cursor;
    if (cursor.seq < current.seq) return;
    if (cursor.seq === current.seq && cursor.epoch === current.epoch) return;
    this.setState({
      ...this.state,
      version: this.state.version + 1,
      cursor: { seq: cursor.seq, epoch: cursor.epoch },
    });
    this.viewHandle?.updateSessionCursor(cursor);
  }

  setFocusedAgent(agentId: string | undefined): void {
    if (this.closed) return;
    this.focusedAgentId = agentId;
    this.refreshTranscriptGrades();
  }

  /**
   * Retain a view-instance demand; reusing its ID replaces that demand, not another view's.
   * Grades merge above the legacy focus/summary baseline; off adds no demand.
   */
  retainAgentView(viewId: string, agentId: string, grade: TranscriptGrade): void {
    if (this.closed) return;
    if (viewId.trim() === '' || agentId.trim() === '' || agentId === '*') {
      throw new Error('Agent views require a view ID and a concrete agent ID');
    }
    this.agentViews.set(viewId, { agentId, grade });
    this.refreshTranscriptGrades();
  }

  /** Change a retained view's demand; an unknown or released ID is a no-op. */
  updateAgentView(viewId: string, grade: TranscriptGrade): void {
    if (this.closed) return;
    const view = this.agentViews.get(viewId);
    if (view === undefined || view.grade === grade) return;
    this.agentViews.set(viewId, { agentId: view.agentId, grade });
    this.refreshTranscriptGrades();
  }

  /** Idempotently release one view without lowering any other consumer's demand. */
  releaseAgentView(viewId: string): void {
    if (!this.agentViews.delete(viewId)) return;
    this.refreshTranscriptGrades();
  }

  private requestedTranscriptGrades(): TranscriptGradeSpec {
    const grades = { ...transcriptGradesForFocus(this.focusedAgentId) };
    for (const agentId of this.agentListeners.keys()) {
      if (!Object.hasOwn(grades, agentId)) grades[agentId] = 'turn';
    }
    for (const { agentId, grade } of this.agentViews.values()) {
      if (grade === 'off' && !Object.hasOwn(grades, agentId)) grades[agentId] = 'off';
    }
    for (const { agentId, grade } of this.agentViews.values()) {
      if (grade === 'off') continue;
      const current = gradeFor(grades, agentId);
      grades[agentId] = GRADE_RANK[grade] > GRADE_RANK[current] ? grade : current;
    }
    return grades;
  }

  private scheduledTranscriptGrades: { handle: SessionViewSubscription; previous: TranscriptGradeSpec } | undefined;

  private refreshTranscriptGrades(): void {
    if (this.closed) return;
    const nextGrades = this.requestedTranscriptGrades();
    const previous = this.transcriptGrades;
    if (Object.keys(previous).length === Object.keys(nextGrades).length &&
        Object.entries(nextGrades).every(([id, grade]) => previous[id] === grade)) return;
    for (const id of this.agentTranscripts.keys()) {
      if (gradeFor(this.transcriptGrades, id) !== gradeFor(nextGrades, id)) {
        this.bumpHistoryGeneration(id);
        this.catchupReplay.delete(id);
      }
    }
    this.transcriptGrades = nextGrades;
    for (const [agentId, store] of this.agentTranscripts) {
      if (gradeFor(previous, agentId) !== gradeFor(nextGrades, agentId)) this.publishProjectedAgent(agentId, store);
    }
    const handle = this.viewHandle;
    if (handle === undefined || this.scheduledTranscriptGrades?.handle === handle) return;
    const scheduled = { handle, previous };
    this.scheduledTranscriptGrades = scheduled;
    queueMicrotask(() => {
      if (this.scheduledTranscriptGrades !== scheduled) return;
      this.scheduledTranscriptGrades = undefined;
      if (this.closed || this.isSuspended || this.viewHandle !== handle) return;
      if (Object.keys(scheduled.previous).length === Object.keys(this.transcriptGrades).length &&
        Object.entries(this.transcriptGrades).every(([id, grade]) => scheduled.previous[id] === grade)) return;
      handle.setTranscriptGrades(this.transcriptGrades);
    });
  }

  private hasTranscriptBaseline(agentId: string): boolean {
    const applied = this.appliedTranscriptGrades.get(agentId);
    return applied !== undefined && GRADE_RANK[applied] >= GRADE_RANK[gradeFor(this.transcriptGrades, agentId)];
  }

  handleSignal(signal: SessionViewSignal): void {
    if (this.closed || (this.connectionGeneration !== undefined && signal.generation < this.connectionGeneration)) return;
    this.connectionGeneration = signal.generation;
    switch (signal.type) {
      case 'status':
        if (signal.status !== 'open') this.handleWsDrop();
        return;
      case 'snapshot': {
        if (this.bootstrapOpening?.attachment !== this.viewAttachment) return;
        const snapshot = signal.snapshot;
        if (snapshot.session.id !== this.sessionId) {
          this.handleSignal({ type: 'protocolError', detail: 'Session snapshot identity changed', recoverable: false, generation: signal.generation });
          return;
        }
        this.latestSnapshot = snapshot;
        this.setState(this.applyTranscriptShellSnapshot(snapshot), false);
        this.viewHandle?.updateSessionCursor(this.state.cursor);
        this.finishBootstrapOpening();
        const main = this.agentTranscripts.get(MAIN_AGENT_ID);
        if (main !== undefined && this.hasTranscriptBaseline(MAIN_AGENT_ID)) this.publishProjectedAgent(MAIN_AGENT_ID, main);
        this.retireRequestedRosterAgents();
        this.publishForest();
        this.notifyMain();
        const queued = this.rosterRefreshQueuedCursor;
        this.rosterRefreshQueuedCursor = undefined;
        if (queued !== undefined && this.requestedRosterAgents.size > 0) void this.refreshRoster(queued);
        void this.refreshDurableIngress();
        return;
      }
      case 'ready':
        if (this.resyncInFlight) return;
        if (this.state.cursor.epoch !== undefined && signal.currentSessionCursor.epoch !== this.state.cursor.epoch) {
          this.handleSubscribeRejected(signal.generation);
          return;
        }
        this.advanceSessionCursor(signal.currentSessionCursor);
        if (signal.reconnected) this.handleReconnectAck();
        return;
      case 'sessionCursorAdvanced':
        this.advanceSessionCursor(signal.cursor);
        if (signal.title !== undefined && this.state.session !== undefined) {
          this.setState(setSessionRecord(this.state, { ...this.state.session, title: signal.title }));
        }
        // A roster row this view already holds is re-read for the waking /
        // disposal flags the server stamps on it. An agent it has no row for
        // is one this event just created: the row (role profile and model)
        // only exists in the session snapshot, so ask for it — the spawn's
        // transcript op asks again if this read raced the row's creation.
        if (signal.rosterAgentId !== undefined) {
          if (this.hasRosterRow(signal.rosterAgentId)) void this.refreshRoster(signal.cursor);
          else this.requestRosterRows([signal.rosterAgentId], signal.cursor);
        }
        return;
      case 'historyRewritten':
        this.advanceSessionCursor(signal.cursor);
        if (this.state.resyncError?.retryable !== false) void this.resync({ rewrite: true });
        return;
      case 'transcript':
        this.handleTranscript(signal.event, signal.generation);
        return;
      case 'protocolError': {
        if (this.state.resyncError?.retryable === false) return;
        if (this.bootstrapOpening !== undefined) {
          this.finishBootstrapOpening();
          this.setState(setLoadError(this.state, signal.detail), false);
        }
        this.setState({
          ...setResyncFailed(setResyncing(this.state, false), true, this.state.resyncAttempt + 1),
          resyncError: { message: signal.detail, code: API_CODES.INVALID_RESPONSE, retryable: signal.recoverable },
        });
        if (signal.recoverable) void this.resync();
        else {
          this.clearResyncTimer();
          this.clearRewriteHold();
          this.hardResyncQueued = false;
          this.rewriteResyncQueued = false;
          this.viewAttachment += 1;
          this.viewHandle?.close();
          this.viewHandle = undefined;
        }
        return;
      }
      case 'resyncRequired':
        if (this.state.resyncError?.retryable === false) return;
        if (this.rewriteHold !== undefined) this.handleSubscribeRejected(signal.generation);
        else void this.resync({ rewrite: signal.reason === 'history_rewritten' });
        return;
    }
  }

  private queueAutomaticRosterRead(): void {
    if (this.closed || this.isSuspended || !this.state.loaded || this.state.resyncing || this.rosterReadQueued || this.rosterReadInFlight) return;
    const ref = this.latestSnapshot?.contentRefs?.find((entry) => entry.source.kind === 'snapshot' && entry.kind === 'array' && entry.path.length === 1 && entry.path[0] === 'subagents');
    if (ref === undefined || this.view.transcript.content === undefined || this.state.detailLoads[`content:${JSON.stringify(ref)}`]?.status === 'error') return;
    this.rosterReadQueued = true;
    queueMicrotask(() => {
      this.rosterReadQueued = false;
      if (this.closed || this.isSuspended || this.state.resyncing) return;
      this.rosterReadInFlight = true;
      void this.loadContentSegment(MAIN_AGENT_ID, ref).then((advanced) => {
        this.rosterReadInFlight = false;
        if (advanced || !this.latestSnapshot?.contentRefs?.some((current) => sameContentRef(current, ref))) this.queueAutomaticRosterRead();
      });
    });
  }

  private mergeRosterRows(snapshot: SessionSnapshotResponse): readonly NonNullable<SessionSnapshotResponse['subagents']>[number][] {
    const incoming = snapshot.subagents ?? [];
    const rows = new Map(incoming.map((row) => [snapshotSubagentAgentId(row), row]));
    const partial = snapshot.contentRefs?.some((ref) => ref.path[0] === 'subagents' && ref.kind === 'array') === true;
    const stable = this.state.snapshotSubagents.flatMap((old) => {
      const id = snapshotSubagentAgentId(old);
      const next = rows.get(id);
      rows.delete(id);
      return next === undefined ? partial ? [old] : [] : [next];
    });
    const merged = [...stable, ...rows.values()];
    if (merged.length > this.state.snapshotSubagents.length) this.rosterRevisionRefreshes = 0;
    return merged;
  }

  private applyTranscriptShellSnapshot(snapshot: SessionSnapshotResponse): SessionViewState {
    return { ...applyTranscriptShell(this.sessionId, snapshot, this.state), snapshotSubagents: this.mergeRosterRows(snapshot) };
  }

  private async refreshRoster(cursor: SessionCursor): Promise<void> {
    if (this.closed || this.isSuspended || this.resyncInFlight) return;
    if (this.rosterRefreshInFlight || this.bootstrapOpening !== undefined) {
      const queued = this.rosterRefreshQueuedCursor;
      if (queued === undefined || cursor.epoch !== queued.epoch || cursor.seq > queued.seq) {
        this.rosterRefreshQueuedCursor = cursor;
      }
      return;
    }
    this.rosterRefreshInFlight = true;
    const attachment = this.viewAttachment;
    try {
      const snapshot = await this.readSnapshot();
      if (
        this.closed || this.resyncInFlight || attachment !== this.viewAttachment ||
        snapshot.epoch !== cursor.epoch ||
        snapshot.as_of_seq < Math.max(cursor.seq, this.state.cursor.seq) ||
        snapshot.subagents === undefined
      ) return;
      this.setState({
        ...this.state,
        version: this.state.version + 1,
        snapshotSubagents: this.mergeRosterRows(snapshot),
        agentCounts: snapshot.agent_counts,
      }, false);
      this.retireRequestedRosterAgents();
      this.publishForest();
      this.notifyMain();
    } catch {
      // Best-effort: task ops and reconnect snapshots still recover the row.
    } finally {
      this.rosterRefreshInFlight = false;
      const queued = this.rosterRefreshQueuedCursor;
      this.rosterRefreshQueuedCursor = undefined;
      if (queued !== undefined && !this.closed && !this.resyncInFlight) void this.refreshRoster(queued);
    }
  }

  /** True when the roster already carries a row for this agent. */
  private hasRosterRow(agentId: string): boolean {
    return this.state.snapshotSubagents.some((row) => snapshotSubagentAgentId(row) === agentId);
  }

  /** Forget ids the read answered, so they stop counting against the read budget. */
  private retireRequestedRosterAgents(): void {
    for (const agentId of this.requestedRosterAgents.keys()) {
      if (this.hasRosterRow(agentId)) this.requestedRosterAgents.delete(agentId);
    }
  }

  /**
   * Ask for the session's roster rows behind these agent ids. The roster is
   * the one place the client reads an agent's role profile and model, and a
   * view only picks up rows the session's own snapshot carried — an agent
   * spawned mid-session has to be asked for by id. `fresh` marks evidence the
   * server has already materialised the row (a spawn op the viewer's own
   * transcript stream carried): worth a read even when an earlier request for
   * the same id raced ahead of the row's creation. `MAX_ROSTER_ROW_READS` caps
   * what a row-less agent (an external delegation, say) can cost in reads.
   */
  private requestRosterRows(
    agentIds: Iterable<string>,
    cursor?: SessionCursor,
    fresh = false,
  ): void {
    if (this.closed || this.isSuspended) return;
    let wanted = false;
    for (const agentId of agentIds) {
      if (agentId === '' || agentId === MAIN_AGENT_ID) continue;
      if (this.hasRosterRow(agentId)) continue;
      const attempts = this.requestedRosterAgents.get(agentId) ?? 0;
      if (attempts >= MAX_ROSTER_ROW_READS) continue;
      if (!fresh && attempts > 0) continue;
      this.requestedRosterAgents.set(agentId, attempts + 1);
      wanted = true;
    }
    if (wanted) void this.refreshRoster(cursor ?? this.state.cursor);
  }

  handleSubscribeRejected(generation?: number): void {
    if (this.closed || this.state.resyncError?.retryable === false) return;
    const hold = this.rewriteHold;
    if (hold === undefined) {
      void this.resync();
      return;
    }
    if (!this.matchesRewriteGeneration(generation)) return;
    this.recoverRewriteHold(hold.token);
  }

  /** Volatile deltas are never journaled or replayed, so a turn that was
   * live when the socket dropped has holes the durable replay cannot fill.
   * Remember the drop; the next post-reconnect subscribe ack resyncs. */
  private droppedWithLiveWork = false;

  handleWsDrop(): void {
    if (this.closed) return;
    const streaming = this.state.blocks.some(
      (block) => (block.kind === 'assistant' || block.kind === 'thinking') && block.streaming,
    );
    if (this.state.busy || streaming) this.droppedWithLiveWork = true;
  }

  handleReconnectAck(): void {
    if (this.closed || !this.droppedWithLiveWork || this.state.resyncError?.retryable === false) return;
    this.droppedWithLiveWork = false;
    void this.refreshDurableIngress();
    const agents = [...this.agentTranscripts.keys()];
    if (agents.length === 0) {
      void this.resync();
      return;
    }
    for (const agentId of agents) void this.catchUpAgent(agentId);
  }

  /** Rewrite resyncs requested while another resync was in flight — the
   * in-flight snapshot may predate the rewrite, so it re-runs afterwards. */
  private rewriteResyncQueued = false;
  private hardResyncQueued = false;

  private resolveResyncIdleWaiters(): void {
    const waiters = [...this.resyncIdleWaiters];
    this.resyncIdleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private waitForResyncIdle(signal?: AbortSignal): Promise<'ready' | 'failed' | 'cancelled'> {
    const status = (): 'ready' | 'failed' | 'cancelled' => this.closed || this.isSuspended || signal?.aborted
      ? 'cancelled'
      : this.state.resyncFailed ? 'failed' : 'ready';
    if (signal?.aborted || this.closed || this.isSuspended || !this.resyncInFlight) return Promise.resolve(status());
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.resyncIdleWaiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve(status());
      };
      this.resyncIdleWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (!this.resyncInFlight) finish();
    });
  }

  /** Refresh the session shell and subscription. Transcript baselines received
   * during the read retain their readiness, grade and resume cursor together;
   * a rewrite retains only baselines from a new transcript epoch. */
  async resync(options: { rewrite?: boolean } = {}): Promise<void> {
    if (this.closed || this.isSuspended) return;
    this.finishBootstrapOpening();
    const rewrite = options.rewrite === true;
    if (rewrite) this.beginRewriteHold();
    const rewriteHoldToken = rewrite ? this.rewriteHold?.token : undefined;
    if (this.resyncInFlight) {
      if (rewrite) this.rewriteResyncQueued = true;
      return;
    }
    this.resyncInFlight = true;
    this.resyncGeneration += 1;
    for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
    if (rewrite) this.rewriteResyncQueued = false;
    this.clearResyncTimer();
    this.setState(setResyncing(this.state, true));
    const attachment = this.viewAttachment;
    const baselineAtStart = new Map(this.transcriptBaselineSerial);
    const cursorsAtStart = rewrite ? new Map(this.transcriptCursors) : undefined;
    try {
      const snapshot = await this.readSnapshot();
      if (this.closed || attachment !== this.viewAttachment) return;
      for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
      this.catchupReplay.clear();
      const retainedReady = new Set([...this.agentTranscripts.keys()].filter((agentId) => {
        const epoch = this.transcriptCursors.get(agentId)?.epoch;
        return this.transcriptBaselineSerial.get(agentId) !== baselineAtStart.get(agentId) && this.hasTranscriptBaseline(agentId) &&
          (!rewrite || epoch !== undefined && epoch !== cursorsAtStart?.get(agentId)?.epoch);
      }));
      for (const agentId of this.pendingTranscriptBatches.keys()) if (!retainedReady.has(agentId)) this.pendingTranscriptBatches.delete(agentId);
      for (const agentId of this.pendingTranscriptAgents) if (!retainedReady.has(agentId)) this.pendingTranscriptAgents.delete(agentId);
      for (const [agentId, state] of this.agentStates) {
        const transcriptReady = retainedReady.has(agentId);
        if (state.transcriptReady === transcriptReady) continue;
        this.agentStates.set(agentId, { ...state, version: state.version + 1, transcriptReady });
        this.dirtyAgents.add(agentId);
      }
      const transcriptReady = retainedReady.has(MAIN_AGENT_ID);
      for (const agentId of this.transcriptCursors.keys()) if (!retainedReady.has(agentId)) this.transcriptCursors.delete(agentId);
      for (const agentId of this.appliedTranscriptGrades.keys()) if (!retainedReady.has(agentId)) this.appliedTranscriptGrades.delete(agentId);
      this.setState(
        setResyncing(
          {
            ...this.applyTranscriptShellSnapshot(snapshot),
            transcriptReady,
            loadingOlder: false,
            olderError: undefined,
          },
          false,
        ),
      );
      this.publishAgents();
      this.attachView({ seq: snapshot.as_of_seq, epoch: snapshot.epoch });
      if (rewriteHoldToken !== undefined) this.armRewriteSubscription(rewriteHoldToken);
    } catch (error) {
      if (rewriteHoldToken !== undefined) this.clearRewriteHold(rewriteHoldToken);
      if (!this.closed && !this.isSuspended && (attachment === this.viewAttachment || this.state.resyncError?.retryable !== false)) {
        const attempt = this.state.resyncAttempt + 1;
        const code = error instanceof ApiError || error instanceof RPCError ? error.code : undefined;
        const retryable = code === undefined || code === -1 || code === API_CODES.TIMEOUT ||
          code === API_CODES.SESSION_INDEX_BUILDING || code === 408 || code === 429 ||
          (code >= 500 && code < 600) || code >= 50000;
        this.setState({
          ...setResyncFailed(setResyncing(this.state, false), true, attempt),
          resyncError: {
            message: errorMessage(error, 'Could not restore session'),
            code,
            requestId: error instanceof ApiError ? error.requestId : undefined,
            retryable,
          },
        });
        if (retryable) this.scheduleResyncRetry();
        else {
          this.clearRewriteHold();
          this.hardResyncQueued = false;
          this.rewriteResyncQueued = false;
        }
      }
    } finally {
      this.resyncInFlight = false;
      let rerunQueued = false;
      if (!this.closed) {
        if (this.hardResyncQueued) {
          rerunQueued = true;
          this.hardResyncQueued = false;
          this.rewriteResyncQueued = false;
          queueMicrotask(() => void this.resync());
        } else if (this.rewriteResyncQueued) {
          rerunQueued = true;
          this.rewriteResyncQueued = false;
          queueMicrotask(() => void this.resync({ rewrite: true }));
        }
      }
      if (!rerunQueued) this.resolveResyncIdleWaiters();
    }
  }

  private scheduleResyncRetry(): void {
    if (this.closed || this.isSuspended || this.resyncTimer !== null) return;
    const step = Math.min(this.state.resyncAttempt, RESYNC_BACKOFF_MS.length) - 1;
    const delay = RESYNC_BACKOFF_MS[Math.max(0, step)] ?? 4000;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.closed) void this.resync();
    }, delay);
  }

  setPersistenceHint(value: 'temporary' | 'saved' | 'unknown' | undefined): void {
    if (value === undefined) return;
    if (value === 'unknown' && this.persistenceHint !== undefined && this.persistenceHint !== 'unknown') return;
    if (value === 'temporary' && this.persistenceHint === 'saved') return;
    this.persistenceHint = value;
  }

  setEphemeralHint(value: boolean | undefined): void {
    if (value === undefined) return;
    if (value && this.persistenceHint === 'saved') return;
    this.ephemeralHint = value;
    this.setPersistenceHint(value ? 'temporary' : 'saved');
  }

  private usesDurableSubmission(): boolean {
    if (this.persistenceHint === 'temporary' || this.persistenceHint === 'unknown') return false;
    if (this.persistenceHint === 'saved') return true;
    return this.ephemeralHint !== true && this.state.session?.ephemeral !== true;
  }

  private hasKnownSavedSession(): boolean {
    if (this.persistenceHint !== undefined) return this.persistenceHint === 'saved';
    return this.ephemeralHint === false || this.state.session?.ephemeral === false;
  }

  handleSessionRecord = (record: Session): void => {
    if (record.id !== this.sessionId || this.closed) return;
    const current = this.state.session;
    if (current === undefined || record.updated_at >= current.updated_at) {
      if (record.ephemeral !== undefined) this.setEphemeralHint(record.ephemeral);
      this.setState(setSessionRecord(this.state, record));
    }
  };

  private setDurableIngress(records: readonly PromptItem[], agentId = MAIN_AGENT_ID): void {
    for (const record of records) {
      if (record.admission === 'failed' || record.admission === 'cancelled' ||
          (record.admission === 'admitted' && record.delivery_state === 'queued')) {
        this.reconcileSteerOutcome(agentId, record.prompt_id, this.settledSteerOutcome(agentId, record.prompt_id));
      }
    }
    const previous = this.state.durableIngress ?? [];
    if (previous.length === records.length && previous.every((item, index) => {
      const next = records[index];
      return next !== undefined && item.prompt_id === next.prompt_id && item.status === next.status &&
        item.admission === next.admission && item.delivery_state === next.delivery_state && item.delivery_reason === next.delivery_reason && item.revision === next.revision &&
        item.admission_content_truncated === next.admission_content_truncated &&
        item.admission_error?.code === next.admission_error?.code &&
        item.admission_error?.message === next.admission_error?.message;
    })) return;
    this.setState({ ...this.state, version: this.state.version + 1, durableIngress: [...records] });
  }

  private observeDurableSteer(agentId: string, promptId: string): void {
    if (this.client.getDurableIngress === undefined || this.closed) return;
    const key = JSON.stringify([agentId, promptId]);
    if (this.durableSteerReads.has(key)) return;
    this.durableSteerReads.set(key, { agentId, promptId });
    this.scheduleDurableSteerRead();
  }

  private scheduleDurableSteerRead(): void {
    if (this.durableSteerReads.size === 0 || this.durableSteerReadTimer !== undefined || this.durableSteerReadInFlight || this.closed || this.isSuspended) return;
    this.durableSteerReadTimer = setTimeout(() => {
      this.durableSteerReadTimer = undefined;
      void this.readDurableSteer();
    }, 500);
  }

  private async readDurableSteer(): Promise<void> {
    const first = this.durableSteerReads.entries().next().value;
    if (first === undefined || this.closed || this.isSuspended) return;
    const [key, target] = first;
    if (this.findPendingSteer(target.agentId, target.promptId) === undefined) {
      this.durableSteerReads.delete(key);
      this.scheduleDurableSteerRead();
      return;
    }
    const generation = this.durableSteerReadGeneration;
    this.durableSteerReadInFlight = true;
    try {
      const result = await this.client.getDurableIngress!(this.sessionId, target.promptId, target.agentId);
      if (this.closed || this.isSuspended || generation !== this.durableSteerReadGeneration) return;
      this.setDurableIngress([...this.getDurableIngress().filter(item => item.prompt_id !== result.prompt_id), result], target.agentId);
      if (result.admission !== 'restoring') this.durableSteerReads.delete(key);
    } catch {
      // Retry only the receipt read; a missing response never replays the submission.
    } finally {
      this.durableSteerReadInFlight = false;
      if (this.durableSteerReads.delete(key) && !this.closed) this.durableSteerReads.set(key, target);
      this.scheduleDurableSteerRead();
    }
  }

  private pauseDurableSteerReads(): void {
    this.durableSteerReadGeneration += 1;
    if (this.durableSteerReadTimer !== undefined) clearTimeout(this.durableSteerReadTimer);
    this.durableSteerReadTimer = undefined;
  }

  async refreshDurableIngress(): Promise<void> {
    const read = this.client.listDurableIngress?.bind(this.client);
    if (read === undefined || !this.hasKnownSavedSession() || this.closed || this.isSuspended) return;
    if (this.durableIngressReadInFlight !== undefined) return this.durableIngressReadInFlight;
    let request!: Promise<void>;
    request = (async () => {
      try {
        const records: PromptItem[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
          const result = await read(this.sessionId, { cursor });
          if (this.closed || this.isSuspended) return;
          records.push(...(result.ingress ?? []));
          const next = result.ingress_next_cursor;
          if (next === undefined || cursors.has(next)) break;
          cursors.add(next);
          cursor = next;
        }
        if (!this.closed && !this.isSuspended) this.setDurableIngress(records);
      } catch {
        // Durable ingress is an auxiliary recovery read; prompt submission and
        // the ordered transcript remain usable when this best-effort probe fails.
      } finally {
        if (this.durableIngressReadInFlight === request) this.durableIngressReadInFlight = undefined;
      }
    })();
    this.durableIngressReadInFlight = request;
    return request;
  }

  getDurableIngress(): readonly PromptItem[] {
    return this.state.durableIngress ?? [];
  }

  async resumeDurableIngress(promptId: string, body: PromptSubmission, agentId = MAIN_AGENT_ID): Promise<PromptItem> {
    const resume = this.client.resumeDurableIngress?.bind(this.client);
    if (resume === undefined) throw new Error('Durable prompt recovery is unavailable on this transport');
    const result = await resume(this.sessionId, promptId, {
      ...body,
      admission: 'durable',
      prompt_id: promptId,
      agent_id: body.agent_id ?? (agentId === MAIN_AGENT_ID ? undefined : agentId),
    }, agentId);
    const admissionRejected = result.admission === 'failed' || result.admission === 'cancelled';
    if (!admissionRejected) forgetUnconfirmedSubmission(this.sessionId, promptId);
    if (result.admission !== undefined) {
      this.setDurableIngress([
        ...this.getDurableIngress().filter((item) => item.prompt_id !== promptId),
        result,
      ]);
    }
    if (admissionRejected || result.admission === 'restoring' || result.admission === 'held') return result;
    if (!this.state.blocks.some((block) => block.kind === 'user' && block.promptId === result.prompt_id)) {
      const projection = projectMessageContent(result.content);
      this.setState(appendLocalUserMessage(this.state, {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: projection.text,
        createdAt: result.created_at,
        status: result.status,
        origin: result.origin,
        media: projection.media,
        content: result.content,
        appendTiming: result.append_timing,
      }));
    }
    return result;
  }

  async refreshPrompts(): Promise<void> {
    await this.refreshDurableIngress();
  }

  async refreshTasks(): Promise<void> {
    // Task rail truth is projected from the canonical transcript.
  }

  async refreshGoal(): Promise<void> {
    // Goal truth is projected from the canonical transcript.
  }

  /** Re-read the session record (post-rebind the echoed `agent_config` is the
   * only profile truth — no WS frame carries it). */
  async refreshSession(): Promise<void> {
    try {
      const record = await this.client.getSession(this.sessionId);
      if (!this.closed) this.handleSessionRecord(record);
    } catch {
      // Best-effort: the next snapshot/poll repaints the binding regardless.
    }
  }

  /** Hydrate forward structure for a mounted turn; older suffix predecessors wait for loadOlderMessages or an explicit content read. */
  retainHistoryStructure(agentId: string, turnId: string): () => void {
    const lease = this.beginContentRead(agentId, { kind: 'turn', id: turnId }, ['steps'], false);
    return () => { lease.release(); };
  }

  historyPreviewPending(agentId: string, turnId: string): boolean {
    return this.historyPreviewPages.get(`${agentId}/${turnId}`)?.unloaded === true;
  }

  retainHistoryPreview(agentId: string, turnId: string): () => void {
    const key = `${agentId}/${turnId}`;
    this.historyPreviewReaders.set(key, (this.historyPreviewReaders.get(key) ?? 0) + 1);
    void this.loadHistoryPreview(agentId, turnId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.historyPreviewReaders.get(key) ?? 1) - 1;
      if (remaining > 0) this.historyPreviewReaders.set(key, remaining);
      else this.historyPreviewReaders.delete(key);
      const page = this.historyPreviewPages.get(key);
      if (page !== undefined) {
        const requestKey = JSON.stringify([agentId, page.beforeItem, page.beforeTurn]);
        const retained = [...this.historyPreviewPages].some(([candidateKey, candidate]) => candidate.agentId === agentId &&
          candidate.beforeItem === page.beforeItem && candidate.beforeTurn === page.beforeTurn && this.historyPreviewReaders.has(candidateKey));
        if (!retained) this.historyPreviewReads.get(requestKey)?.controller.abort();
      }
      if (this.trimHistoryPreviews(agentId)) this.publishProjectedAgent(agentId, this.ensureAgentTranscript(agentId));
    };
  }

  private trimHistoryPreviews(agentId: string): boolean {
    const older = this.olderPages.get(agentId);
    if (older === undefined) return false;
    let bytes = estimateJsonBytes(older);
    if (bytes <= this.historyPreviewBytes) return false;
    let changed = false;
    const liveIds = new Set(this.ensureAgentTranscript(agentId).snapshot().items.flatMap((item) => item.kind === 'turn' ? [item.turnId] : []));
    const items = older.items.map((item) => {
      if (bytes <= this.historyPreviewBytes || item.kind !== 'turn' || liveIds.has(item.turnId)) return item;
      const key = `${agentId}/${item.turnId}`;
      const page = this.historyPreviewPages.get(key);
      const reading = [...this.contentReaders.values()].some((reader) => reader.agentId === agentId &&
        (reader.source.kind === 'turn' && reader.source.id === item.turnId || reader.source.kind === 'frame' && reader.source.turnId === item.turnId));
      if (page === undefined || page.unloaded || this.historyPreviewReaders.has(key) || reading ||
          item.contentRefs?.some((ref) => ref.path[0] === 'steps' && (ref.path.length === 1 || ref.path.length === 3 && ref.path[2] === 'frames'))) return item;
      const header = { ...item, prompt: item.prompt?.slice(0, 256), contentRefs: undefined,
        steps: item.steps.map((step) => ({ ...step, frames: step.frames.map((frame) => {
          const identity = releaseFramePayload(frame);
          if (frame.kind === 'text' || frame.kind === 'thinking') return { ...identity, text: frame.text.slice(0, 256) };
          if (frame.kind === 'notice') return { ...identity, message: frame.message.slice(0, 256) };
          return identity;
        }) })) };
      bytes -= Math.max(0, estimateJsonBytes(item) - estimateJsonBytes(header));
      page.unloaded = true;
      for (const [bodyKey, entry] of this.contentBodies) if (entry.agentId === agentId &&
        (entry.source.kind === 'turn' && entry.source.id === item.turnId || entry.source.kind === 'frame' && entry.source.turnId === item.turnId)) this.contentBodies.delete(bodyKey);
      changed = true;
      return header;
    });
    if (changed) this.olderPages.set(agentId, { ...older, items });
    return changed;
  }



  private cancelHistoryRead(agentId: string): void {
    this.olderLoads.cancel(agentId);
    for (const [key, read] of this.historyPreviewReads) if (JSON.parse(key)[0] === agentId) {
      this.historyPreviewReads.delete(key); read.controller.abort();
    }
    const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId);
    if (current?.loadingOlder) this.publishAgentView(agentId, setLoadingOlder(current, false));
  }


  async loadHistoryPreview(agentId: string, turnId: string): Promise<boolean> {
    const key = `${agentId}/${turnId}`;
    const page = this.historyPreviewPages.get(key);
    if (this.closed || this.isSuspended || page === undefined || !page.unloaded) return false;
    const requestKey = JSON.stringify([agentId, page.beforeItem, page.beforeTurn]);
    const existing = this.historyPreviewReads.get(requestKey);
    if (existing !== undefined) return existing.promise;
    const controller = new AbortController();
    this.snapshotControllers.add(controller);
    const generation = this.historyGeneration.get(agentId) ?? 0;
    this.setDetailLoad(agentId, `history:${turnId}`, { status: 'loading' });
    const promise = (async () => {
      try {
        const obsolete = () => this.closed || controller.signal.aborted || (this.historyGeneration.get(agentId) ?? 0) !== generation;
        const read = () => this.view.transcript.page({ agentId,
          beforeItem: page.beforeItem, beforeTurn: page.beforeTurn, pageSize: 20 }, { signal: controller.signal });
        let result = await this.readPreparedContent(read, controller.signal);
        if (obsolete()) return false;
        if (result.agent_id !== agentId) throw new Error('History preview returned a different agent');
        if (result.read?.stale !== undefined) {
          const group = [...this.historyPreviewPages.entries()].filter(([, candidate]) => candidate.agentId === agentId &&
            candidate.beforeItem === page.beforeItem && candidate.beforeTurn === page.beforeTurn);
          const groupKeys = new Set(group.map(([candidateKey]) => candidateKey));
          const items = this.composeAgentSnapshot(agentId).items;
          const end = items.findLastIndex((item) => item.kind === 'turn' && groupKeys.has(`${agentId}/${item.turnId}`));
          const next = items.slice(end + 1).find((item) => item.kind === 'turn');
          for (const [, candidate] of group) {
            candidate.beforeItem = undefined;
            candidate.beforeTurn = next?.kind === 'turn' ? next.turnId : candidate.beforeTurn;
          }
          const flight = this.historyPreviewReads.get(requestKey);
          if (flight !== undefined) this.historyPreviewReads.set(JSON.stringify([agentId, page.beforeItem, page.beforeTurn]), flight);
          this.historyReads.set(agentId, result.read);
          this.publishProjectedAgent(agentId, this.ensureAgentTranscript(agentId), { historyCoverageKind: 'unknown' });
          if (result.read.stale.retry === 'resync') { void this.resync(); return false; }
          result = await this.readAuthoritativeTranscriptContinuation(read, 'History preview continuation is still stale', controller.signal);
          if (obsolete()) return false;
          if (result.agent_id !== agentId) throw new Error('History preview returned a different agent');
        }
        const older = this.olderPages.get(agentId);
        if (older === undefined) return false;
        if (result.read !== undefined) this.historyReads.set(agentId, result.read);
        const restored = new Map(result.items.flatMap((item) => item.kind === 'turn' ? [[item.turnId, item] as const] : []));
        if (!restored.has(turnId)) throw new Error('History preview is no longer available at its cursor');
        this.olderPages.set(agentId, { ...older, items: older.items.map((item) => {
          if (item.kind !== 'turn') return item;
          const target = this.historyPreviewPages.get(`${agentId}/${item.turnId}`);
          const replacement = restored.get(item.turnId);
          if (target?.unloaded !== true || replacement === undefined) return item;
          target.unloaded = false;
          this.setDetailLoad(agentId, `history:${item.turnId}`, undefined);
          return replacement;
        }) });
        this.trimHistoryPreviews(agentId);
        this.publishProjectedAgent(agentId, this.ensureAgentTranscript(agentId));
        return true;
      } catch (error) {
        if (!this.closed && (this.historyGeneration.get(agentId) ?? 0) === generation) for (const [candidateKey, candidate] of this.historyPreviewPages) {
          if (candidate.agentId === agentId && candidate.unloaded && candidate.beforeItem === page.beforeItem && candidate.beforeTurn === page.beforeTurn)
            this.setDetailLoad(agentId, `history:${candidateKey.slice(agentId.length + 1)}`, controller.signal.aborted ? undefined : { status: 'error', message: errorMessage(error, 'Could not load history preview') });
        }
        return false;
      } finally {
        this.snapshotControllers.delete(controller);
        for (const [flightKey, flight] of this.historyPreviewReads) if (flight.controller === controller) this.historyPreviewReads.delete(flightKey);
      }
    })();
    this.historyPreviewReads.set(requestKey, { agentId, controller, promise });
    return promise;
  }

  async loadOlderMessages(agentId: string = MAIN_AGENT_ID, signal?: AbortSignal): Promise<boolean> {
    return (await this.loadOlderHistory(agentId, signal)).changed;
  }

  loadOlderHistory(agentId: string = MAIN_AGENT_ID, signal?: AbortSignal): Promise<OlderLoadResult> {
    if (this.closed || this.isSuspended) return Promise.resolve({ kind: 'cancelled', changed: false });
    const start = (): Promise<OlderLoadResult> => {
      const resyncGeneration = this.resyncGeneration;
      return this.olderLoads.request(agentId, (sharedSignal) => this.loadOlderWithDeadline(agentId, sharedSignal), signal).then((result) => {
        if (result.kind !== 'cancelled' || signal?.aborted || this.closed || this.isSuspended || resyncGeneration === this.resyncGeneration) return result;
        return this.waitForResyncIdle(signal).then((resyncStatus) => {
          if (resyncStatus === 'cancelled') return { kind: 'cancelled', changed: false };
          if (resyncStatus === 'failed') return { kind: 'failed', changed: false };
          return start();
        });
      });
    };
    if (!this.resyncInFlight) return start();
    return this.waitForResyncIdle(signal).then((resyncStatus) => {
      if (resyncStatus === 'cancelled') return { kind: 'cancelled', changed: false };
      if (resyncStatus === 'failed') return { kind: 'failed', changed: false };
      return start();
    });
  }

  private async loadOlderWithDeadline(agentId: string, signal: AbortSignal): Promise<OlderLoadResult> {
    const deadline = new AbortController();
    const owned = AbortSignal.any([signal, deadline.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<OlderLoadResult>((resolve) => {
      timer = setTimeout(() => {
        deadline.abort();
        if (signal.aborted || this.closed || this.isSuspended) {
          resolve({ kind: 'cancelled', changed: false });
          return;
        }
        const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
        this.publishAgentView(agentId, setOlderError(current, 'Loading earlier messages timed out. Retry to continue.'));
        resolve({ kind: 'failed', changed: false });
      }, OLDER_HISTORY_TIMEOUT_MS);
    });
    try { return await Promise.race([this.loadOlderTranscript(agentId, owned), expired]); }
    finally { clearTimeout(timer); }
  }

  private async loadOlderTranscript(agentId: string, signal: AbortSignal): Promise<OlderLoadResult> {
    if (this.resyncInFlight) {
      const resyncStatus = await this.waitForResyncIdle(signal);
      if (resyncStatus === 'cancelled') return { kind: 'cancelled', changed: false };
      if (resyncStatus === 'failed') return { kind: 'failed', changed: false };
    }
    if (!this.flushPendingTranscriptBatch(agentId)) return { kind: 'cancelled', changed: false };
    const store = this.ensureAgentTranscript(agentId);
    const generation = this.historyGeneration.get(agentId) ?? 0;
    const obsolete = () => this.closed || signal.aborted || this.agentTranscripts.get(agentId) !== store ||
      (this.historyGeneration.get(agentId) ?? 0) !== generation;
    if (this.pendingTranscriptAgents.delete(agentId)) this.publishProjectedAgent(agentId, store);
    const currentSnapshot = this.composeAgentSnapshot(agentId);
    const olderStructure = currentSnapshot.items.flatMap((item) => {
      if (item.kind !== 'turn') return [];
      const refs = (item.contentRefs ?? []).filter((ref) => ref.direction === 'backward');
      const firstStep = item.steps[0]?.ordinal;
      const firstFrames = refs.find((ref) => ref.path.length === 3 && ref.path[1] === firstStep);
      const steps = refs.find((ref) => ref.path.length === 1);
      return firstFrames ?? steps ?? refs.toSorted((a, b) => Number(a.path[1]) - Number(b.path[1]));
    })[0];
    if (olderStructure !== undefined) {
      const loadingView = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
      this.publishAgentView(agentId, setLoadingOlder(loadingView, true));
      const cancel = () => { this.cancelContentSegment(agentId, olderStructure); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const changed = !signal.aborted && await this.loadContentSegment(agentId, olderStructure);
        if (obsolete()) return { kind: 'cancelled', changed: false };
        const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
        if (changed) {
          this.publishAgentView(agentId, { ...setLoadingOlder(current, false), olderError: undefined });
          return { kind: 'advanced', changed: true };
        }
        const detail = current.detailLoads[`content:${JSON.stringify(olderStructure)}`];
        this.publishAgentView(agentId, setOlderError(current, detail?.status === 'error' ? detail.message : 'Could not load earlier content'));
        return { kind: 'failed', changed: false };
      } finally {
        signal.removeEventListener('abort', cancel);
        if (!obsolete()) {
          const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
          if (current.loadingOlder) this.publishAgentView(agentId, setLoadingOlder(current, false));
        }
      }
    }
    let beforeItem = this.olderPageCursors.get(agentId);
    let beforeTurn = beforeItem === undefined
      ? this.olderPageTurns.get(agentId) ?? currentSnapshot.items.find((item) => item.kind === 'turn')?.turnId : undefined;
    if (!currentSnapshot.hasMoreOlder) return { kind: 'exhausted', changed: false };
    if (beforeItem === undefined && beforeTurn === undefined) {
      const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
      this.publishAgentView(agentId, setOlderError(current, 'History window has no continuation cursor'));
      return { kind: 'failed', changed: false };
    }
    const loadingView = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
    this.publishAgentView(agentId, setLoadingOlder(loadingView, true));
    try {
      const rememberContinuationCursor = (nextCursor: string | undefined): void => {
        if (nextCursor === undefined) return;
        beforeItem = nextCursor;
        beforeTurn = undefined;
        this.olderPageCursors.set(agentId, nextCursor);
        this.olderPageTurns.delete(agentId);
      };
      let preparingBatches = 0;
      for (;;) {
        const read = () => this.readPreparedContent(() => this.view.transcript.page({ agentId, beforeTurn, beforeItem, pageSize: 20 }, { signal }), signal);
        let page = await read();
        if (obsolete()) return { kind: 'cancelled', changed: false };
        if (page.agent_id !== agentId) throw new Error('History page returned a different agent');
        if (page.read?.stale !== undefined) {
          this.historyReads.set(agentId, page.read);
          this.olderPageCursors.delete(agentId);
          this.publishProjectedAgent(agentId, store, { historyCoverageKind: 'unknown' });
          beforeItem = undefined;
          beforeTurn = currentSnapshot.items.find((item) => item.kind === 'turn')?.turnId;
          if (page.read.stale.retry === 'resync' || beforeTurn === undefined) {
            this.publishProjectedAgent(agentId, store, { loadingOlder: false, historyCoverageKind: 'unknown' });
            void this.resync();
            return { kind: 'preparing', changed: false };
          }
          page = await this.readAuthoritativeTranscriptContinuation(read, 'History continuation is still stale', signal);
          if (obsolete()) return { kind: 'cancelled', changed: false };
          if (page.agent_id !== agentId) throw new Error('History page returned a different agent');
        }
        const nextTurn = page.items.find((item) => item.kind === 'turn')?.turnId;
        const pageReadiness = page.read?.readiness;
        const emptyContinuation = page.has_more && page.items.length === 0;
        const readIsPreparing = emptyContinuation && pageReadiness === 'preparing';
        const readIsPartial = emptyContinuation && pageReadiness === 'partial';
        const recoveredHeaders: TranscriptOperation[] = [];
        for (const item of page.items) {
          if (item.kind !== 'turn' || item.startedAt === undefined) continue;
          const current = store.getTurn(item.turnId);
          if (current?.origin.kind !== 'other' || current.message !== undefined || current.promptId !== undefined || current.startedAt !== undefined) continue;
          const { steps: _steps, ...header } = item;
          recoveredHeaders.push({ op: 'turn.upsert', turn: { ...header, state: current.state, endedAt: current.endedAt } });
        }
        const knownItems = new Set(currentSnapshot.items.map(item => item.kind === 'turn' ? `turn:${item.turnId}` : item.kind === 'marker' ? `marker:${item.markerId}` : `taskref:${item.refId}`));
        const addedItems = page.items.some(item => !knownItems.has(item.kind === 'turn' ? `turn:${item.turnId}` : item.kind === 'marker' ? `marker:${item.markerId}` : `taskref:${item.refId}`));
        if (page.has_more && !readIsPreparing && !readIsPartial && !addedItems && recoveredHeaders.length === 0 &&
            (page.next_cursor !== undefined ? page.next_cursor === beforeItem : nextTurn === undefined || nextTurn === beforeTurn)) {
          throw new Error('History page did not advance its cursor');
        }
        if (page.read !== undefined) this.historyReads.set(agentId, page.read);
        if (this.flushPendingTranscriptBatch(agentId)) this.observeToolCount(agentId, page);
        if (readIsPartial) {
          rememberContinuationCursor(page.next_cursor);
          this.publishProjectedAgent(agentId, store, {
            loadingOlder: false,
            fetchedOlder: true,
            olderError: undefined,
            historyCoverageKind: 'unknown',
          });
          return { kind: 'preparing', changed: false };
        }
        if (readIsPreparing) {
          rememberContinuationCursor(page.next_cursor);
          if (++preparingBatches >= OLDER_PREPARING_BATCH_LIMIT) throw new Error('Earlier history is still preparing. Retry to continue.');
          this.publishProjectedAgent(agentId, store, {
            loadingOlder: true,
            fetchedOlder: true,
            olderError: undefined,
            historyCoverageKind: 'unknown',
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (obsolete()) return { kind: 'cancelled', changed: false };
          continue;
        }
        const older: AgentTranscriptSnapshot = {
          items: page.items as AgentTranscriptSnapshot['items'],
          tasks: currentSnapshot.tasks,
          interactions: currentSnapshot.interactions,
          attachments: page.attachments ?? [],
          todos: currentSnapshot.todos,
          prompts: currentSnapshot.prompts,
          meta: currentSnapshot.meta,
          hasMoreOlder: page.has_more,
        };
        if (recoveredHeaders.length > 0) store.apply(recoveredHeaders);
        const merged = prependOlderTranscriptSnapshot(this.olderPages.get(agentId) ?? emptyOlderSnapshot(), older);
        this.olderPages.set(agentId, merged);
        for (const item of older.items) if (item.kind === 'turn' && !this.historyPreviewPages.has(`${agentId}/${item.turnId}`))
          this.historyPreviewPages.set(`${agentId}/${item.turnId}`, { agentId, beforeItem, beforeTurn, unloaded: false });
        this.trimHistoryPreviews(agentId);
        if (page.next_cursor !== undefined) this.olderPageCursors.set(agentId, page.next_cursor);
        else this.olderPageCursors.delete(agentId);
        if (nextTurn !== undefined) this.olderPageTurns.set(agentId, nextTurn);
        else this.olderPageTurns.delete(agentId);
        this.forestDirtyAgents.add(agentId);
        this.publishProjectedAgent(agentId, store, {
          loadingOlder: false,
          fetchedOlder: true,
          olderError: undefined,
          historyCoverageKind: page.coverage?.kind === 'unknown' ? 'unknown'
            : !page.has_more && page.coverage !== undefined ? 'full' : undefined,
        });
        const changed = older.items.length > 0 || page.next_cursor !== beforeItem;
        if (!page.has_more) return { kind: 'exhausted', changed };
        return { kind: 'advanced', changed: true };
      }
    } catch (error) {
      if (obsolete()) return { kind: 'cancelled', changed: false };
      const code = error instanceof ApiError || error instanceof RPCError ? error.code : undefined;
      const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
      if (code === 40923) {
        this.publishAgentView(agentId, { ...setLoadingOlder(current, false), olderError: undefined });
        return { kind: 'preparing', changed: false };
      }
      this.publishAgentView(agentId, setOlderError(current, errorMessage(error, 'Could not load earlier messages')));
      return { kind: 'failed', changed: false };
    }
  }

  private applyTranscriptReset(
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    coverage: TranscriptCoverage,
    cursor: TranscriptCursor,
    grade: TranscriptGrade,
    read?: TranscriptRead,
  ): void {
    this.pendingTranscriptBatches.delete(agentId);
    this.pendingTranscriptAgents.delete(agentId);
    this.catchupReplay.delete(agentId);
    const store = this.ensureAgentTranscript(agentId);
    const retainedBodies = [...this.contentBodies.entries()].filter(([, entry]) => entry.agentId === agentId);
    this.bumpHistoryGeneration(agentId);
    for (const key of this.entityPageCursors.keys()) if (key.startsWith(`${agentId}/`)) this.entityPageCursors.delete(key);
    this.todoReads.delete(agentId);
    for (const kind of ['task', 'attachment', 'prompt', 'interaction', 'todo'] as const) {
      const key = `entities:${kind}`;
      const requestKey = `${agentId}/${key}`;
      this.detailReads.delete(requestKey);
      this.setDetailLoad(agentId, key, undefined);
    }
    const previousCursor = this.transcriptCursors.get(agentId);
    if (coverage.kind === 'full' || (previousCursor !== undefined && previousCursor.epoch !== cursor.epoch)) {
      this.olderPages.delete(agentId);
      this.olderPageCursors.delete(agentId);
      for (const [key, page] of this.historyPreviewPages) if (page.agentId === agentId) this.historyPreviewPages.delete(key);
    } else {
      const retained = this.composeAgentSnapshot(agentId);
      if (retained.items.length > 0) this.olderPages.set(agentId, {
        ...retained,
        hasMoreOlder: coverage.kind === 'unknown' && snapshot.items.length === 0
          ? retained.hasMoreOlder || coverage.hasMoreOlder || snapshot.hasMoreOlder === true
          : snapshot.hasMoreOlder ?? coverage.hasMoreOlder,
      });
    }
    if (snapshot.olderCursor !== undefined) this.olderPageCursors.set(agentId, snapshot.olderCursor);
    else this.olderPageCursors.delete(agentId);
    const oldestTurn = snapshot.items.find((item) => item.kind === 'turn')?.turnId;
    if (oldestTurn !== undefined) this.olderPageTurns.set(agentId, oldestTurn);
    else this.olderPageTurns.delete(agentId);
    store.apply([{ op: 'reset', agentId, snapshot, coverage, grade: grade === 'off' ? undefined : grade, read }]);
    for (const target of this.contentReaders.values()) if (target.agentId === agentId) target.blocked = false;
    for (const [key, entry] of retainedBodies) {
      const entity = this.contentEntity(agentId, entry.source);
      if (entity === undefined) this.contentBodies.delete(key);
      else this.contentBodies.set(key, { ...entry, base: snapshotContentEntity(snapshot, entry.source) ?? entry.base, bytes: estimateJsonBytes(entity) });
    }
    this.transcriptCursors.set(agentId, cursor);
    if (read !== undefined) this.historyReads.set(agentId, read);
    else this.historyReads.delete(agentId);
    this.appliedTranscriptGrades.set(agentId, grade);
    this.transcriptBaselineSerial.set(agentId, ++this.transcriptBaselineClock);
    if (this.hasTranscriptBaseline(agentId)) this.viewHandle?.updateTranscriptCursor(agentId, cursor);
    this.forestDirtyAgents.add(agentId);
    this.globalCoverage.set(agentId, snapshot.globalCoverage);
    this.publishProjectedAgent(agentId, store, {
      loadingOlder: false,
      olderError: undefined,
      retainPendingPrompts: true,
      transcriptReset: coverage.kind === 'full',
      historyCoverageKind: coverage.kind === 'full' ? 'full'
        : coverage.kind === 'unknown' ||
          (agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId))?.historyCoverageKind === 'unknown'
          ? 'unknown' : 'tail',
    });
    // Queued / running prompts are actionable (edit, reorder, steer); a
    // windowed reset that dropped their content must not hide them.
    for (const prompt of snapshot.prompts) {
      if (prompt.detailRef === undefined || prompt.content !== undefined) continue;
      if (prompt.status !== 'queued' && prompt.status !== 'blocked' && prompt.status !== 'running') continue;
      void this.loadTranscriptDetail(agentId, 'prompt', prompt.promptId);
    }
  }

  /**
   * Read the canonical body of one windowed entity (a truncated task output,
   * an attachment whose source was omitted, a long prompt) and fold it into
   * the agent's store. Loading and failure states publish through
   * `detailLoads`; a retry is just another call.
   */
  async loadTranscriptDetail(agentId: string, kind: TranscriptDetailKind, id: string): Promise<boolean> {
    const read = this.view.transcript.detail?.bind(this.view.transcript);
    const key = transcriptDetailKey(kind, id);
    if (this.closed || read === undefined) return false;
    const inFlight = this.detailReads.get(`${agentId}/${key}`);
    if (inFlight !== undefined) return inFlight;
    const generation = this.historyGeneration.get(agentId) ?? 0;
    const run = (async (): Promise<boolean> => {
      this.setDetailLoad(agentId, key, { status: 'loading' });
      try {
        const detail = await read({ agentId, kind, id });
        if (this.closed || (this.historyGeneration.get(agentId) ?? 0) !== generation) return false;
        const applied = this.applyTranscriptDetail(agentId, detail);
        this.setDetailLoad(agentId, key, undefined);
        return applied;
      } catch (error) {
        if (this.closed) return false;
        this.setDetailLoad(agentId, key, {
          status: 'error',
          message: errorMessage(error, 'Could not load the full content'),
        });
        return false;
      }
    })().finally(() => {
      this.detailReads.delete(`${agentId}/${key}`);
    });
    this.detailReads.set(`${agentId}/${key}`, run);
    return run;
  }

  async copyToolCallField(agentId: string, toolCallId: string, root: 'input' | 'output', signal?: AbortSignal): Promise<string> {
    const lookup = await this.lookupToolCallForCopy(agentId, toolCallId, signal);
    const source = { kind: 'frame' as const, id: lookup.frame.frameId, turnId: lookup.turnId, stepId: lookup.stepId };
    const field = root === 'input' && lookup.frame.input === undefined ? 'inputText' : root === 'output' && lookup.frame.output === undefined ? 'error' : root;
    return this.copyResolvedContentField(agentId, source, [field], signal);
  }

  private async lookupToolCallForCopy(agentId: string, toolCallId: string, signal?: AbortSignal) {
    for (;;) {
      signal?.throwIfAborted();
      const lookup = await this.lookupToolCall(agentId, toolCallId, signal);
      if (lookup.status === 'preparing') {
        await this.waitForToolDetailPreparation(signal);
        continue;
      }
      if (lookup.status !== 'found') throw new Error('Invocation is not ready');
      return lookup;
    }
  }

  private waitForToolDetailPreparation(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new DOMException('Read cancelled', 'AbortError'));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, TOOL_DETAIL_PREPARING_RETRY_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  getToolCallDetail(agentId: string, toolCallId: string): Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup'] | undefined {
    return this.toolDetails.get(`${agentId}/${toolCallId}`);
  }

  async lookupToolCall(agentId: string, toolCallId: string, signal?: AbortSignal): Promise<Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup']> {
    signal?.throwIfAborted();
    const key = `${agentId}/${toolCallId}`;
    const local = this.agentTranscripts.get(agentId)?.getToolCall(toolCallId);
    if (local !== undefined) {
      const lookup = { status: 'found' as const, ...local };
      this.toolDetails.set(key, lookup);
      return lookup;
    }
    if (this.toolDetails.get(key)?.status === 'found') this.invalidateToolDetail(key);
    let flight = this.toolDetailReads.get(key);
    if (flight === undefined) {
      const generation = this.historyGeneration.get(agentId) ?? 0;
      const epoch = this.toolDetailEpochs.get(key) ?? 0;
      const read = this.view.transcript.detail?.bind(this.view.transcript);
      if (this.closed || read === undefined) throw new Error('Tool details are unavailable on this connection');
      const controller = new AbortController();
      this.snapshotControllers.add(controller);
      const promise = (async () => {
        const detail = await read.call(this.view.transcript, { agentId, kind: 'tool', id: toolCallId }, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (this.closed || (this.historyGeneration.get(agentId) ?? 0) !== generation) throw new Error('Tool detail scope changed');
        if (detail.kind !== 'tool' || detail.agent_id !== agentId || detail.session_id !== this.sessionId) throw new Error('Tool detail target mismatch');
        const resident = this.agentTranscripts.get(agentId)?.getToolCall(toolCallId);
        if (resident !== undefined) {
          const lookup = { status: 'found' as const, ...resident };
          this.toolDetails.set(key, lookup);
          return lookup;
        }
        if ((this.toolDetailEpochs.get(key) ?? 0) !== epoch) throw new Error('Tool detail scope changed');
        this.toolDetails.set(key, detail.lookup);
        return detail.lookup;
      })().finally(() => { this.snapshotControllers.delete(controller); if (this.toolDetailReads.get(key)?.controller === controller) this.toolDetailReads.delete(key); });
      flight = { promise, controller, readers: 0 };
      this.toolDetailReads.set(key, flight);
    }
    const owned = flight;
    owned.readers += 1;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new DOMException('Read cancelled', 'AbortError')); });
    signal?.addEventListener('abort', abort, { once: true });
    try { return await (signal === undefined ? owned.promise : Promise.race([owned.promise, cancelled])); }
    finally {
      signal?.removeEventListener('abort', abort);
      owned.readers -= 1;
      if (owned.readers === 0 && this.toolDetailReads.get(key) === owned) { this.toolDetailReads.delete(key); owned.controller.abort(); }
    }
  }

  isContentRange(agentId: string, ref: ContentRef): boolean {
    return ref.kind === 'text' && (ref.total > CONTENT_INLINE_TEXT_CHARS || (this.contentBodies.get(JSON.stringify([agentId, ref.source]))?.bytes ?? 0) >= CONTENT_BODY_CACHE_BYTES / 2 || this.contentMemoryReport().bodyBytes >= CONTENT_BODY_CACHE_BYTES);
  }

  contentRefsFor(agentId: string, source: ContentSource): readonly ContentRef[] {
    return this.contentEntity(agentId, source)?.contentRefs ?? [];
  }

  private contentEntity(agentId: string, source: ContentSource): ContentWindow | undefined {
    if (source.kind === 'snapshot') return this.latestSnapshot;
    if (source.kind === 'frame') {
      for (const [key, lookup] of this.toolDetails) if (key.startsWith(`${agentId}/`) && lookup.status === 'found' && lookup.frame.frameId === source.id && lookup.turnId === source.turnId && lookup.stepId === source.stepId) return lookup.frame;
    }
    const store = this.agentTranscripts.get(agentId);
    const entity = store === undefined ? undefined : transcriptContentEntity(store, source);
    if (entity !== undefined) return entity;
    const older = this.olderPages.get(agentId);
    if (older === undefined) return undefined;
    if (source.kind === 'turn') return older.items.find((item) => item.kind === 'turn' && item.turnId === source.id) as ContentWindow | undefined;
    if (source.kind === 'frame') {
      const turn = older.items.find((item) => item.kind === 'turn' && item.turnId === source.turnId);
      return turn?.kind === 'turn' ? turn.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id) : undefined;
    }
    const collection = { task: older.tasks, attachment: older.attachments, prompt: older.prompts, interaction: older.interactions, todo: older.todos };
    if (source.kind in collection) return collection[source.kind as keyof typeof collection].find((item) => Object.entries(item).some(([key, value]) => key.endsWith('Id') && value === source.id));
    return source.kind === 'meta' ? older.meta : undefined;
  }

  stepCanonicalIndex(agentId: string, turnId: string, stepId: string): number | undefined {
    const turn = this.composeAgentSnapshot(agentId).items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId);
    const index = turn?.steps.findIndex((step) => step.stepId === stepId) ?? -1;
    if (index < 0) return undefined;
    return index;
  }

  async readContentRange(agentId: string, ref: ContentRef, offset: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const key = JSON.stringify([agentId, ref.source, ref.path, ref.revision, offset]);
    const cached = this.contentRanges.get(key);
    if (cached !== undefined) { this.contentRanges.delete(key); this.contentRanges.set(key, cached); return cached; }
    const read = this.view.transcript.content?.bind(this.view.transcript);
    if (this.closed || read === undefined) throw new Error('Content reader unavailable');
    const generation = this.historyGeneration.get(agentId) ?? 0;
    const controller = new AbortController();
    const cancel = () => { controller.abort(); };
    signal?.addEventListener('abort', cancel, { once: true });
    this.snapshotControllers.add(controller);
    this.rangeControllers.set(controller, agentId);
    try {
      const segment = await this.readPreparedContent(() => read.call(this.view.transcript, { agentId, ref: { ...ref, offset }, range: true }, { signal: controller.signal }), controller.signal);
      controller.signal.throwIfAborted();
      if (this.closed || (this.historyGeneration.get(agentId) ?? 0) !== generation || segment.ref.revision !== ref.revision || typeof segment.value !== 'string') throw new Error('Content range changed');
      let start = offset - segment.ref.offset;
      let end = Math.min(segment.value.length, offset + CONTENT_RANGE_CHARS - segment.ref.offset);
      if (start > 0 && /[\uD800-\uDBFF]/u.test(segment.value[start - 1]!)) start += 1;
      if (end < segment.value.length && /[\uD800-\uDBFF]/u.test(segment.value[end - 1]!)) end += 1;
      const text = segment.value.slice(start, end);
      const previous = this.contentRanges.get(key);
      if (previous !== undefined) this.contentRangeBytes -= previous.length * 2;
      this.contentRanges.set(key, text);
      this.contentRangeBytes += text.length * 2;
      while (this.contentRangeBytes > CONTENT_RANGE_CACHE_BYTES) {
        const oldest = this.contentRanges.entries().next().value;
        if (oldest === undefined) break;
        this.contentRanges.delete(oldest[0]); this.contentRangeBytes -= oldest[1].length * 2;
      }
      return text;
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.snapshotControllers.delete(controller);
      this.rangeControllers.delete(controller);
    }
  }

  async copyContentField(agentId: string, source: ContentSource, path: readonly (string | number)[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (source.kind === 'frame') {
      for (const [key, cached] of this.toolDetails) {
        if (!key.startsWith(`${agentId}/`) || cached.status !== 'found' || cached.frame.frameId !== source.id || cached.turnId !== source.turnId || cached.stepId !== source.stepId) continue;
        const lookup = await this.lookupToolCallForCopy(agentId, cached.frame.toolCallId, signal);
        if (lookup.frame.frameId !== source.id || lookup.turnId !== source.turnId || lookup.stepId !== source.stepId) throw new Error('Copy target changed');
        break;
      }
    }
    return this.copyResolvedContentField(agentId, source, path, signal);
  }

  private async copyResolvedContentField(agentId: string, source: ContentSource, path: readonly (string | number)[], signal?: AbortSignal): Promise<string> {
    const select = (entity: unknown): unknown => {
      for (const key of path) {
        if (entity === null || typeof entity !== 'object') return undefined;
        entity = (entity as Record<string | number, unknown>)[key];
      }
      return entity;
    };
    signal?.throwIfAborted();
    const preview = this.contentEntity(agentId, source);
    if (preview === undefined) throw new Error('Copy target unavailable');
    let entity: ContentWindow = preview;
    const read = this.view.transcript.content?.bind(this.view.transcript);
    const controller = new AbortController();
    const cancel = () => { controller.abort(); };
    signal?.addEventListener('abort', cancel, { once: true });
    this.snapshotControllers.add(controller);
    this.rangeControllers.set(controller, agentId);
    const generation = this.historyGeneration.get(agentId) ?? 0;
    const check = () => {
      controller.signal.throwIfAborted();
      if (this.closed || (this.historyGeneration.get(agentId) ?? 0) !== generation) throw new Error('Copy scope changed');
    };
    try {
      for (;;) {
        check();
        const ref: ContentRef | undefined = entity.contentRefs?.find((candidate) => path.every((part, index) => candidate.path[index] === part) || candidate.path.every((part, index) => path[index] === part));
        if (ref === undefined) break;
        if (read === undefined) throw new Error('Content reader unavailable');
        if (ref.kind === 'text') {
          const chunks: string[] = [];
          let offset = ref.offset;
          while (offset < ref.total) {
            const segment = await this.readPreparedContent(() => read({ agentId, ref: { ...ref, offset } }, { signal: controller.signal }), controller.signal);
            check();
            if (segment.ref.revision !== ref.revision || segment.ref.offset !== offset || typeof segment.value !== 'string' || segment.value.length === 0) throw new Error('Copy content changed');
            chunks.push(segment.value);
            offset += segment.value.length;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          if (offset !== ref.total) throw new Error('Copy content length mismatch');
          entity = applyContentSegment(entity, { ref, value: chunks.join(''), contentRefs: [] });
        } else {
          const segment = await this.readPreparedContent(() => read({ agentId, ref }, { signal: controller.signal }), controller.signal);
          check();
          const next = applyContentSegment(entity, segment);
          if (next === entity || segment.next !== undefined && segment.next.offset <= ref.offset) throw new Error('Copy content made no progress');
          entity = next;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      check();
      const value = select(entity);
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.snapshotControllers.delete(controller);
      this.rangeControllers.delete(controller);
    }
  }

  contentMemoryReport(): { bodies: number; bodyBytes: number; rangeBytes: number; bodyBudget: number; rangeBudget: number } {
    return { bodies: this.contentBodies.size, bodyBytes: [...this.contentBodies.values()].reduce((sum, entry) => sum + entry.bytes, 0), rangeBytes: this.contentRangeBytes, bodyBudget: CONTENT_BODY_CACHE_BYTES, rangeBudget: CONTENT_RANGE_CACHE_BYTES };
  }

  incompleteTurnOrdinals(agentId: string): ReadonlySet<number> {
    const turns = new Set<number>();
    for (const item of this.composeAgentSnapshot(agentId).items) if (item.kind === 'turn' && (item.contentRefs?.length || item.steps.some((step) => step.frames.some((frame) => frame.contentRefs?.length)))) turns.add(item.ordinal);
    return turns;
  }

  async completeTurnContent(agentId: string, ordinal: number, signal?: AbortSignal, includeToolOutput = false): Promise<void> {
    let turn = this.composeAgentSnapshot(agentId).items.find((item) => item.kind === 'turn' && item.ordinal === ordinal);
    if (turn?.kind !== 'turn') throw new Error('Search target is not loaded');
    await this.completeContentRead(agentId, { kind: 'turn', id: turn.turnId }, ['steps', 'prompt'], signal);
    turn = this.composeAgentSnapshot(agentId).items.find((item) => item.kind === 'turn' && item.ordinal === ordinal);
    if (turn?.kind !== 'turn') return;
    for (const step of turn.steps) for (const frame of step.frames) {
      if (frame.kind !== 'text' && !(frame.kind === 'tool' && includeToolOutput)) continue;
      const root = frame.kind === 'tool' ? 'output' : 'text';
      if ((frame.contentRefs ?? []).some((ref) => ref.path[0] === root)) await this.completeContentRead(agentId, { kind: 'frame', id: frame.frameId, turnId: turn.turnId, stepId: step.stepId }, [root], signal);
    }
  }

  async findTurnContentRange(agentId: string, ordinal: number, pattern: RegExp, signal?: AbortSignal, includeToolOutput = false): Promise<{ ref: ContentRef; offset: number; toolCallId?: string } | undefined> {
    await this.completeTurnContent(agentId, ordinal, signal, includeToolOutput);
    const turn = this.composeAgentSnapshot(agentId).items.find((item) => item.kind === 'turn' && item.ordinal === ordinal);
    if (turn?.kind !== 'turn') throw new Error('Search target changed');
    const fields = [
      ...(turn.contentRefs ?? []).map((ref) => ({ ref, toolCallId: undefined as string | undefined })),
      ...turn.steps.flatMap((step) => step.frames.flatMap((frame) => {
        if (frame.kind === 'thinking' || frame.kind === 'notice') return [];
        if (frame.kind === 'tool' && !includeToolOutput) return [];
        if (frame.kind === 'text' && frame.role !== 'assistant' && frame.role !== 'user') return [];
        return (frame.contentRefs ?? []).map((ref) => ({ ref, toolCallId: frame.kind === 'tool' ? frame.toolCallId : undefined }));
      })),
    ];
    for (const { ref, toolCallId } of fields) {
      if (ref.kind !== 'text') continue;
      const root = String(ref.path[0]);
      if (toolCallId === undefined ? root !== 'prompt' && root !== 'text' : root !== 'output') continue;
      let tail = '';
      for (let offset = 0; offset < ref.total;) {
        signal?.throwIfAborted();
        const text = await this.readContentRange(agentId, ref, offset, signal);
        if (text.length === 0) throw new Error('Search content made no progress');
        const window = tail + text;
        const expression = new RegExp(pattern.source, pattern.flags);
        for (const match of window.matchAll(expression)) {
          if (offset > 0 && match.index === 0 || offset + text.length < ref.total && match.index + match[0].length === window.length) continue;
          return { ref, offset: offset - tail.length + match.index, toolCallId };
        }
        tail = window.slice(-512);
        offset += text.length;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return undefined;
  }

  async completeContentRead(agentId: string, source: ContentSource, roots: readonly string[], signal?: AbortSignal): Promise<void> {
    const lease = this.beginContentRead(agentId, source, roots);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const ref = this.contentRefsFor(agentId, source).find((candidate) => roots.includes(String(candidate.path[0])) && !this.isContentRange(agentId, candidate));
        if (ref === undefined) return;
        if (!await this.loadContentSegment(agentId, ref)) throw new Error('Could not read the complete content');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally { lease.release(); }
  }

  private observeContentPreview(agentId: string, op: TranscriptOperation): void {
    const selected = (): readonly [ContentSource, ContentWindow] | undefined => {
      switch (op.op) {
        case 'frame.upsert': return [{ kind: 'frame', id: op.frame.frameId, turnId: op.turnId, stepId: op.stepId }, op.frame];
        case 'turn.upsert': return [{ kind: 'turn', id: op.turn.turnId }, op.turn];
        case 'task.upsert': return [{ kind: 'task', id: op.task.taskId }, op.task];
        case 'attachment.upsert': return [{ kind: 'attachment', id: op.attachment.attachmentId }, op.attachment];
        case 'prompt.upsert': return [{ kind: 'prompt', id: op.prompt.promptId }, op.prompt];
        case 'interaction.upsert': return [{ kind: 'interaction', id: op.interaction.interactionId }, op.interaction];
        case 'todo.upsert': return [{ kind: 'todo', id: op.todo.todoId }, op.todo];
        case 'marker.upsert': return [{ kind: 'marker', id: op.item.markerId }, op.item];
        case 'meta.merge': return [{ kind: 'meta', id: '' }, op.meta];
        default: return undefined;
      }
    };
    const target = selected();
    if (target === undefined) return;
    const [source, preview] = target;
    const key = JSON.stringify([agentId, source]);
    const entry = this.contentBodies.get(key);
    if (entry === undefined) return;
    const changed = JSON.stringify(entry.base.contentRefs ?? []) !== JSON.stringify(preview.contentRefs ?? []);
    this.contentBodies.set(key, { ...entry, base: source.kind === 'turn' || source.kind === 'meta' ? { ...entry.base, ...preview } : preview, bytes: changed ? estimateJsonBytes(this.contentEntity(agentId, source)) : entry.bytes });
  }

  private accountContentBody(agentId: string, source: ContentSource, base?: ContentWindow): void {
    const key = JSON.stringify([agentId, source]);
    const previous = this.contentBodies.get(key);
    const entity = this.contentEntity(agentId, source);
    if (entity === undefined) return;
    this.contentBodies.delete(key);
    this.contentBodies.set(key, { agentId, source, base: previous?.base ?? base ?? entity, bytes: estimateJsonBytes(entity) });
    let total = [...this.contentBodies.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [candidateKey, candidate] of this.contentBodies) {
      if (total <= CONTENT_BODY_CACHE_BYTES) break;
      if ([...this.contentReaders.values()].some((target) => target.agentId === candidate.agentId && JSON.stringify(target.source) === JSON.stringify(candidate.source))) continue;
      const current = this.contentEntity(candidate.agentId, candidate.source);
      const restored = current === undefined ? undefined : restoreContentPreview(current, candidate.base);
      const store = this.agentTranscripts.get(candidate.agentId);
      if (restored !== undefined && store !== undefined && transcriptContentEntity(store, candidate.source) !== undefined) replaceAgentContentEntity(store, candidate.source, restored);
      const older = this.olderPages.get(candidate.agentId);
      if (restored !== undefined && older !== undefined) this.olderPages.set(candidate.agentId, replaceSnapshotContentEntity(older, candidate.source, restored));
      for (const [toolKey, lookup] of this.toolDetails) if (toolKey.startsWith(`${candidate.agentId}/`) && lookup.status === 'found' && lookup.frame.frameId === candidate.source.id) this.toolDetails.delete(toolKey);
      this.contentBodies.delete(candidateKey);
      total -= candidate.bytes;
      this.pendingTranscriptAgents.add(candidate.agentId);
    }
    this.flushFrames();
  }

  beginContentRead(agentId: string, source: ContentSource, roots: readonly string[], includeOlder = true): { release(): void; retry(): void } {
    const key = JSON.stringify([agentId, source, roots, includeOlder]);
    const target = this.contentReaders.get(key) ?? { agentId, source, roots, includeOlder, readers: 0, blocked: false };
    target.readers += 1;
    target.blocked = false;
    this.contentReaders.set(key, target);
    void this.pumpContentReads();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        target.readers -= 1;
        if (target.readers > 0) return;
        this.contentReaders.delete(key);
        this.accountContentBody(agentId, source);
        if (target.ref !== undefined && ![...this.contentReaders.values()].some((other) => other.agentId === agentId && JSON.stringify(other.source) === JSON.stringify(source) && other.roots.includes(String(target.ref!.path[0])))) this.cancelContentSegment(agentId, target.ref);
      },
      retry: () => { target.blocked = false; void this.pumpContentReads(); },
    };
  }

  private async pumpContentReads(): Promise<void> {
    if (this.contentPumpRunning || this.closed || this.isSuspended) return;
    this.contentPumpRunning = true;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.closed || this.isSuspended) return;
      for (const [key, target] of this.contentReaders) {
        if (this.contentPumpReads.size >= 4) break;
        if (target.readers === 0 || target.blocked || this.contentPumpReads.has(key)) continue;
        const ref = this.contentEntity(target.agentId, target.source)?.contentRefs?.find((candidate) => {
          if (!target.roots.includes(String(candidate.path[0])) || this.isContentRange(target.agentId, candidate) ||
            !target.includeOlder && candidate.direction === 'backward') return false;
          return candidate.path[0] !== 'steps' || candidate.path.length === 1 || candidate.path.length === 3 && candidate.path[2] === 'frames';
        });
        if (ref === undefined) continue;
        target.ref = ref;
        this.contentPumpReads.add(key);
        void this.loadContentSegment(target.agentId, ref).then((applied) => {
          target.ref = applied ? undefined : ref;
          if (!applied && target.readers > 0) target.blocked =
            this.contentRefsFor(target.agentId, target.source).some((current) => sameContentRef(current, ref));
        }).finally(() => {
          this.contentPumpReads.delete(key);
          if (this.contentReaders.get(key) === target) {
            this.contentReaders.delete(key);
            this.contentReaders.set(key, target);
          }
          void this.pumpContentReads();
        });
      }
    } finally { this.contentPumpRunning = false; }
  }

  private async readAuthoritativeTranscriptContinuation<T extends { read?: TranscriptRead }>(read: () => Promise<T>, staleMessage: string, signal?: AbortSignal): Promise<T> {
    const result = await this.readPreparedContent(read, signal);
    if (result.read?.stale !== undefined) throw new Error(staleMessage);
    return result;
  }

  private async readPreparedContent<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let failures = 0;
    for (;;) {
      signal?.throwIfAborted();
      try { return await read(); }
      catch (error) {
        signal?.throwIfAborted();
        const code = error instanceof RPCError || error instanceof ApiError ? error.code : undefined;
        const preparing = code === 40923;
        const transient = code === -1 || code === API_CODES.TIMEOUT ||
          error instanceof TypeError || (error instanceof RPCError && error.reason === 'transport.timeout');
        if (!preparing && (!transient || failures >= RESYNC_BACKOFF_MS.length)) throw error;
        const delay = preparing ? TOOL_DETAIL_PREPARING_RETRY_MS : RESYNC_BACKOFF_MS[failures++];
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private turnStructureRefreshKey(agentId: string, ref: ContentRef): string {
    return `${agentId}/${ref.source.kind}/${ref.source.id}/${JSON.stringify(ref.path)}`;
  }

  private isTurnStructureRef(ref: ContentRef): boolean {
    return ref.source.kind === 'turn' && ref.kind === 'array' && ref.path[0] === 'steps' &&
      (ref.path.length === 1 || ref.path.length === 3 && ref.path[2] === 'frames');
  }

  /** Rebind one canonical structure revision without discarding already loaded children. */
  private async refreshTurnStructurePreview(agentId: string, ref: ContentRef, signal: AbortSignal): Promise<ContentRef | undefined> {
    if (ref.source.kind !== 'turn' || signal.aborted || this.closed) return undefined;
    const turnId = ref.source.id;
    const items = this.composeAgentSnapshot(agentId).items;
    const index = items.findIndex((item) => item.kind === 'turn' && item.turnId === turnId);
    if (index < 0) return undefined;
    const nextTurn = items.slice(index + 1).find((item) => item.kind === 'turn');
    let beforeItem: string | undefined;
    const cursors = new Set<string>();
    for (;;) {
      const page = await this.readPreparedContent(() => this.view.transcript.page(
        { agentId, beforeTurn: nextTurn?.kind === 'turn' ? nextTurn.turnId : undefined, beforeItem, pageSize: 1 },
        { signal },
      ), signal);
      if (this.closed || signal.aborted || page.agent_id !== agentId || page.read?.stale !== undefined) return undefined;
      const preview = page.items.find((item) => item.kind === 'turn' && item.turnId === turnId);
      if (preview?.kind === 'turn') {
        const candidate = preview.contentRefs?.find((current) => current.kind === 'array' &&
          current.path.length === ref.path.length && current.path.every((part, partIndex) => part === ref.path[partIndex]) &&
          current.source.kind === ref.source.kind && current.source.id === ref.source.id);
        if (candidate === undefined || candidate.revision === ref.revision && candidate.offset === ref.offset && candidate.total === ref.total) return undefined;
        const fresh = ref.direction === 'backward' ? candidate : { ...candidate, direction: 'forward' as const, offset: 0 };
        if (!this.installTurnStructureRef(agentId, ref, fresh) || signal.aborted) return undefined;
        return this.contentEntity(agentId, ref.source)?.contentRefs?.find((current) => sameContentRef(current, fresh));
      }
      if (page.items.some((item) => item.kind === 'turn' && item.ordinal < (items[index] as TranscriptTurn).ordinal) ||
        !page.has_more || page.next_cursor === undefined || cursors.has(page.next_cursor)) return undefined;
      cursors.add(page.next_cursor);
      beforeItem = page.next_cursor;
    }
  }

  /** Replace one changed timeline field from a fresh canonical preview and return its first continuation reference. */
  private async refreshTimelineFieldPreview(agentId: string, ref: ContentRef, signal: AbortSignal): Promise<ContentRef | 'complete' | undefined> {
    const source = ref.source;
    if ((source.kind !== 'turn' && source.kind !== 'frame') || signal.aborted || this.closed) return undefined;
    const turnId = source.kind === 'turn' ? source.id : source.turnId;
    if (turnId === undefined) return undefined;
    const items = this.composeAgentSnapshot(agentId).items;
    const index = items.findIndex((item) => item.kind === 'turn' && item.turnId === turnId);
    if (index < 0) return undefined;
    const nextTurn = items.slice(index + 1).find((item) => item.kind === 'turn');
    const page = await this.readPreparedContent(() => this.view.transcript.page(
      { agentId, beforeTurn: nextTurn?.kind === 'turn' ? nextTurn.turnId : undefined, pageSize: 1 },
      { signal },
    ), signal);
    if (this.closed || signal.aborted || page.agent_id !== agentId || page.read?.stale !== undefined) return undefined;
    const turn = page.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId);
    const preview: ContentWindow | undefined = turn === undefined ? undefined : source.kind === 'turn' ? turn
      : turn.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id);
    const samePath = (candidate: ContentRef) => candidate.path.length === ref.path.length && candidate.path.every((part, partIndex) => part === ref.path[partIndex]);
    const candidate = preview?.contentRefs?.find((current) => samePath(current) && current.kind === ref.kind);
    if (preview === undefined || candidate?.revision === ref.revision ||
      (candidate === undefined && contentPathValue(preview, ref.path) === undefined)) return undefined;
    const current = this.contentEntity(agentId, source);
    if (current === undefined || !(current.contentRefs ?? []).some((entry) => sameContentRef(entry, ref))) return undefined;
    let adopted: ContentWindow;
    try { adopted = adoptContentPreviewField(current, preview, ref.path); } catch { return undefined; }
    const store = this.agentTranscripts.get(agentId);
    let installed = store !== undefined && transcriptContentEntity(store, source) !== undefined && replaceAgentContentEntity(store, source, adopted);
    if (!installed) {
      const older = this.olderPages.get(agentId);
      if (older !== undefined && snapshotContentEntity(older, source) !== undefined) {
        this.olderPages.set(agentId, replaceSnapshotContentEntity(older, source, adopted));
        installed = true;
      }
    }
    if (!installed || signal.aborted) return undefined;
    this.forestDirtyAgents.add(agentId);
    this.pendingTranscriptAgents.add(agentId);
    this.flushFrames();
    if (candidate === undefined) return 'complete';
    return this.contentEntity(agentId, source)?.contentRefs?.find((entry) => sameContentRef(entry, candidate));
  }

  private installTurnStructureRef(agentId: string, ref: ContentRef, fresh: ContentRef): boolean {
    if (ref.source.kind !== 'turn') return false;
    const turnId = ref.source.id;
    const contentRefsOf = (turn: TranscriptTurn): TranscriptTurn['contentRefs'] => (turn.contentRefs ?? []).flatMap((current) => {
      const under = ref.path.every((part, partIndex) => current.path[partIndex] === part);
      if (sameContentRef(current, ref)) return [fresh];
      return ref.direction !== 'backward' && under ? [] : [current];
    });
    const store = this.ensureAgentTranscript(agentId);
    const live = store.getTurn(turnId);
    if (live !== undefined) {
      const { steps: _steps, ...rest } = live;
      const header = carryContentHydration(live, { ...rest, contentRefs: contentRefsOf(live) });
      return store.apply([{ op: 'turn.upsert', turn: header }]).accepted.length > 0;
    }
    const older = this.olderPages.get(agentId);
    if (older === undefined) return false;
    let changed = false;
    const items = older.items.map((item) => {
      if (item.kind !== 'turn' || item.turnId !== turnId) return item;
      changed = true;
      return carryContentHydration(item, { ...item, contentRefs: contentRefsOf(item) });
    });
    if (!changed) return false;
    this.olderPages.set(agentId, { ...older, items });
    return true;
  }

  async loadContentSegment(agentId: string, ref: ContentRef): Promise<boolean> {
    const read = this.view.transcript.content?.bind(this.view.transcript);
    if (this.closed || read === undefined) return false;
    const key = `content:${JSON.stringify(ref)}`;
    const requestKey = `${agentId}/${key}`;
    const inFlight = this.detailReads.get(requestKey);
    if (inFlight !== undefined) return inFlight;
    const controller = new AbortController();
    this.snapshotControllers.add(controller);
    const rosterRead = ref.source.kind === 'snapshot' && ref.path[0] === 'subagents';
    const rootRosterRead = rosterRead && ref.kind === 'array' && ref.path.length === 1;
    const rosterBaseline = rootRosterRead ? this.latestSnapshot : undefined;
    if (rootRosterRead && !this.rosterReadInFlight) this.rosterRevisionRefreshes = 0;
    if (!rosterRead) this.contentControllers.set(requestKey, controller);
    const generation = this.historyGeneration.get(agentId) ?? 0;
    const run = (async (): Promise<boolean> => {
      this.setDetailLoad(agentId, key, { status: 'loading' });
      try {
        const baseline = this.contentEntity(agentId, ref.source);
        const refs = baseline?.contentRefs ?? [];
        if (!refs.some((current) => sameContentRef(current, ref))) return false;
        const segment = await this.readPreparedContent(() => read({ agentId, ref }, { signal: controller.signal }), controller.signal);
        if (this.closed || controller.signal.aborted || (!rosterRead && (this.historyGeneration.get(agentId) ?? 0) !== generation)) return false;
        if (segment.next !== undefined && (ref.direction === 'backward' ? segment.next.offset >= ref.offset : segment.next.offset <= ref.offset) ||
          segment.contentRefs.some((candidate) => sameContentRef(candidate, ref)))
          throw new Error('Content segment did not advance its reference');
        if (ref.source.kind === 'snapshot') {
          const current = this.latestSnapshot;
          if (current === undefined || (rosterRead && current !== baseline)) return false;
          const patched = applyContentSegment(current, segment);
          if (patched === current) return false;
          this.latestSnapshot = patched;
          const contentRefs = [...collectTranscriptContentRefs(this.composeAgentSnapshot(MAIN_AGENT_ID)), ...(patched.contentRefs ?? [])];
          this.setState(rosterRead
            ? { ...this.state, version: this.state.version + 1, snapshotSubagents: this.mergeRosterRows(patched), contentRefs }
            : { ...this.applyTranscriptShellSnapshot(patched), contentRefs });
          this.publishForest();
        } else {
          const store = this.ensureAgentTranscript(agentId);
          let applied = false;
          if (ref.source.kind === 'frame') {
            for (const [lookupKey, lookup] of this.toolDetails) {
              if (!lookupKey.startsWith(`${agentId}/`) || lookup.status !== 'found' || lookup.frame.frameId !== ref.source.id || lookup.turnId !== ref.source.turnId || lookup.stepId !== ref.source.stepId) continue;
              const frame = applyContentSegment(lookup.frame, segment);
              if (frame !== lookup.frame) { this.toolDetails.set(lookupKey, { ...lookup, frame }); applied = true; this.setState({ ...this.state }); }
            }
          }
          applied = patchAgentTranscriptContent(store, segment) || applied;
          if (!applied) {
            const older = this.olderPages.get(agentId);
            if (older !== undefined) {
              const patched = patchTranscriptContent(older, segment);
              if (patched !== older) { this.olderPages.set(agentId, patched); applied = true; }
            }
          }
          if (!applied) return false;
          this.forestDirtyAgents.add(agentId);
          this.pendingTranscriptAgents.add(agentId);
          this.flushFrames();
          if (ref.source.kind !== 'turn' || ref.path[0] !== 'steps') this.accountContentBody(agentId, ref.source, baseline);
        }
        return true;
      } catch (error) {
        if (rootRosterRead && error instanceof RPCError && error.code === 40922 &&
          !this.closed && !controller.signal.aborted && this.latestSnapshot === rosterBaseline &&
          this.rosterRevisionRefreshes < MAX_ROSTER_REVISION_REFRESHES) {
          this.rosterRevisionRefreshes += 1;
          await this.refreshRoster(this.state.cursor);
          if (!this.closed && !controller.signal.aborted && this.latestSnapshot !== rosterBaseline) {
            this.setDetailLoad(agentId, key, undefined);
            return true;
          }
        }
        const refreshKey = this.turnStructureRefreshKey(agentId, ref);
        const structure = this.isTurnStructureRef(ref);
        if ((structure || ref.source.kind === 'turn' || ref.source.kind === 'frame') && error instanceof RPCError && error.code === 40922 &&
          !this.closed && !controller.signal.aborted && !this.turnStructureRefreshKeys.has(refreshKey)) {
          this.turnStructureRefreshKeys.add(refreshKey);
          try {
            const fresh = structure ? await this.refreshTurnStructurePreview(agentId, ref, controller.signal)
              : await this.refreshTimelineFieldPreview(agentId, ref, controller.signal);
            if (fresh === 'complete' && !this.closed && !controller.signal.aborted) {
              this.setDetailLoad(agentId, key, undefined);
              return true;
            }
            if (fresh !== undefined && fresh !== 'complete' && !this.closed && !controller.signal.aborted) {
              // The replacement read registers its own controller. The older gesture only knows the stale ref, so cancel that read when this preview is aborted.
              const continuedPromise = this.loadContentSegment(agentId, fresh);
              const abortContinued = () => { this.cancelContentSegment(agentId, fresh); };
              controller.signal.addEventListener('abort', abortContinued, { once: true });
              try {
                const continued = await continuedPromise;
                if (this.closed || controller.signal.aborted) return false;
                if (continued) return true;
                const view = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId);
                const freshDetail = view?.detailLoads[`content:${JSON.stringify(fresh)}`];
                if (!this.closed && !controller.signal.aborted) this.setDetailLoad(agentId, key, {
                  status: 'error',
                  message: freshDetail?.status === 'error' ? freshDetail.message : errorMessage(error, 'Could not load the next content segment'),
                });
                return false;
              } finally {
                controller.signal.removeEventListener('abort', abortContinued);
              }
            }
          } catch (refreshError) {
            if (this.closed || controller.signal.aborted) return false;
            this.setDetailLoad(agentId, key, { status: 'error', message: errorMessage(refreshError, 'Could not load the next content segment') });
            return false;
          } finally {
            this.turnStructureRefreshKeys.delete(refreshKey);
          }
        }
        if (!this.closed && !controller.signal.aborted) this.setDetailLoad(agentId, key, { status: 'error', message: errorMessage(error, 'Could not load the next content segment') });
        return false;
      } finally {
        this.snapshotControllers.delete(controller);
        if (this.contentControllers.get(requestKey) === controller) this.contentControllers.delete(requestKey);
        const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId);
        if (!this.closed && !controller.signal.aborted && (rosterRead || (this.historyGeneration.get(agentId) ?? 0) === generation) &&
          current?.detailLoads[key]?.status === 'loading') this.setDetailLoad(agentId, key, undefined);
      }
    })().finally(() => { if (this.detailReads.get(requestKey) === run) this.detailReads.delete(requestKey); });
    this.detailReads.set(requestKey, run);
    return run;
  }

  cancelContentSegment(agentId: string, ref: ContentRef): void {
    const key = `content:${JSON.stringify(ref)}`;
    const requestKey = `${agentId}/${key}`;
    const controller = this.contentControllers.get(requestKey);
    if (controller === undefined) return;
    this.contentControllers.delete(requestKey);
    this.detailReads.delete(requestKey);
    controller.abort();
    this.setDetailLoad(agentId, key, undefined);
  }

  private todoPageWins(agentId: string, current: TranscriptTodo | undefined, todo: TranscriptTodo, read: TranscriptRead | undefined): boolean {
    if (current === undefined) return true;
    if (todo.todoId !== 'todo' || read?.readiness !== 'ready' || read.stale !== undefined ||
        todo.notesStatus !== undefined || todo.contentRefs?.some((ref) => ref.path[0] !== 'items') === true ||
        todo.notesMeta === undefined || todo.notesMeta.rev <= (current.notesMeta?.rev ?? -1)) return false;
    const watermark = read.watermark?.transcript;
    const cursor = this.transcriptCursors.get(agentId);
    const observed = this.todoReads.get(agentId)?.watermark?.transcript;
    return watermark !== undefined && cursor !== undefined && watermark.epoch !== undefined && watermark.epoch === cursor.epoch &&
      watermark.seq >= cursor.seq && (observed === undefined || observed.epoch === watermark.epoch && watermark.seq >= observed.seq);
  }

  private observeCanonicalTodoRead(agentId: string, previous: TranscriptTodo | undefined, ops: readonly TranscriptOperation[], cursor: TranscriptCursor): void {
    const appliedCursor = this.transcriptCursors.get(agentId);
    for (const op of ops) {
      if (op.op !== 'todo.upsert' || op.todo.todoId !== 'todo') continue;
      const next = op.todo;
      const advancesNotes = next.notesMeta !== undefined && next.notesMeta.rev > (previous?.notesMeta?.rev ?? -1);
      previous = next;
      const watermark = this.todoReads.get(agentId)?.watermark?.transcript ?? appliedCursor;
      const advancesRead = watermark !== undefined && watermark.epoch !== undefined && watermark.epoch === cursor.epoch &&
        cursor.seq > watermark.seq && (appliedCursor === undefined || appliedCursor.epoch === cursor.epoch && cursor.seq > appliedCursor.seq);
      if (!advancesNotes || !advancesRead) continue;
      const complete = next.notes !== undefined && next.notesStatus === undefined &&
        next.contentRefs?.some((ref) => ref.path[0] !== 'items') !== true;
      this.todoReads.set(agentId, { source: cursor.epoch?.startsWith('cold:') === true ? 'cold' : 'live',
        readiness: complete ? 'ready' : 'partial', reason: complete ? undefined : 'source_unverified',
        watermark: { transcript: cursor } });
    }
  }

  async loadTranscriptEntities(agentId: string, kind: import('@kiki/transcript').TranscriptDetailListResponse['kind']): Promise<boolean> {
    const read = this.view.transcript.entities?.bind(this.view.transcript);
    const key = `entities:${kind}`;
    const requestKey = `${agentId}/${key}`;
    if (this.closed || read === undefined || this.entityPageCursors.get(requestKey) === null) return false;
    const pending = this.detailReads.get(requestKey);
    if (pending !== undefined) return pending;
    const generation = this.historyGeneration.get(agentId) ?? 0;
    let cursor = this.entityPageCursors.get(requestKey) ?? undefined;
    const controller = new AbortController();
    this.snapshotControllers.add(controller);
    const run = (async (): Promise<boolean> => {
      this.setDetailLoad(agentId, key, { status: 'loading' });
      try {
        let page = await read({ agentId, kind, cursor, limit: 20 }, { signal: controller.signal });
        if (this.closed || controller.signal.aborted || page.agent_id !== agentId || page.kind !== kind || (this.historyGeneration.get(agentId) ?? 0) !== generation) return false;
        if (page.read?.stale !== undefined) {
          this.entityPageCursors.delete(requestKey);
          cursor = undefined;
          if (page.read.stale.retry === 'resync') { void this.resync(); return false; }
          page = await this.readAuthoritativeTranscriptContinuation(() => read({ agentId, kind, cursor, limit: 20 }, { signal: controller.signal }),
            'Transcript entity continuation is still stale', controller.signal);
          if (this.closed || controller.signal.aborted || page.agent_id !== agentId || page.kind !== kind || (this.historyGeneration.get(agentId) ?? 0) !== generation) return false;
        }
        const partial = page.read !== undefined && page.read.readiness !== 'ready';
        if (page.has_more && !(partial && page.items.length === 0) && (page.next_cursor === undefined || page.next_cursor === '' || page.next_cursor === cursor)) {
          throw new Error('Transcript entity page did not advance its cursor');
        }
        if (!this.flushPendingTranscriptBatch(agentId)) return false;
        const store = this.ensureAgentTranscript(agentId);
        const ops: TranscriptOperation[] = [];
        switch (page.kind) {
          case 'task': for (const task of page.items) if (store.getTask(task.taskId) === undefined) ops.push({ op: 'task.upsert', task }); break;
          case 'attachment': for (const attachment of page.items) if (store.getAttachment(attachment.attachmentId) === undefined) ops.push({ op: 'attachment.upsert', attachment }); break;
          case 'prompt': for (const prompt of page.items) if (store.getPrompt(prompt.promptId) === undefined) ops.push({ op: 'prompt.upsert', prompt }); break;
          case 'interaction': for (const interaction of page.items) if (!store.getInteractions().has(interaction.interactionId)) ops.push({ op: 'interaction.upsert', interaction }); break;
          case 'todo': for (const todo of page.items) if (this.todoPageWins(agentId, store.getTodo(todo.todoId), todo, page.read)) ops.push({ op: 'todo.upsert', todo }); break;
        }
        const applied = store.apply(ops);
        if (applied.accepted.some((op) => op.op === 'todo.upsert' && op.todo.todoId === 'todo')) {
          if (page.read === undefined) this.todoReads.delete(agentId);
          else this.todoReads.set(agentId, page.read);
        }
        this.entityPageCursors.set(requestKey, page.has_more ? page.next_cursor ?? null : null);
        const snapshot = store.snapshot();
        const field = { task: 'tasks', attachment: 'attachments', prompt: 'prompts', interaction: 'interactions', todo: 'todos' }[kind] as 'tasks' | 'attachments' | 'prompts' | 'interactions' | 'todos';
        const count = snapshot[field].length;
        const full = (returned: number) => ({ returned, total: returned, hasMore: false });
        const previous: NonNullable<AgentTranscriptSnapshot['globalCoverage']> = this.globalCoverage.get(agentId) ?? { version: 1, tasks: full(snapshot.tasks.length), attachments: full(snapshot.attachments.length), prompts: full(snapshot.prompts.length) };
        this.globalCoverage.set(agentId, { ...previous, [field]: { returned: count, total: Math.max(count, page.total ?? previous[field]?.total ?? count), hasMore: page.has_more } });
        this.forestDirtyAgents.add(agentId);
        this.publishProjectedAgent(agentId, store);
        return page.items.length > 0;
      } catch (error) {
        if (!this.closed && !controller.signal.aborted && (this.historyGeneration.get(agentId) ?? 0) === generation) this.setDetailLoad(agentId, key, { status: 'error', message: errorMessage(error, 'Could not load the next transcript entities') });
        return false;
      } finally {
        this.snapshotControllers.delete(controller);
        const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId);
        if (!this.closed && (this.historyGeneration.get(agentId) ?? 0) === generation && current?.detailLoads[key]?.status === 'loading') this.setDetailLoad(agentId, key, undefined);
      }
    })();
    this.detailReads.set(requestKey, run);
    void run.finally(() => {
      if (this.detailReads.get(requestKey) === run) this.detailReads.delete(requestKey);
    });
    return run;
  }

  /** Fold a detail read into a still-truncated entity or a missing referenced attachment. */
  private applyTranscriptDetail(agentId: string, detail: SessionViewTranscriptDetail): boolean {
    const store = this.agentTranscripts.get(agentId);
    if (store === undefined || detail.agent_id !== agentId || detail.kind === 'tool') return false;
    let op: TranscriptOperation | undefined;
    if (detail.kind === 'task') {
      const current = store.getTask(detail.task.taskId);
      if (current?.detailRef !== undefined) op = { op: 'task.upsert', task: detail.task as typeof current };
    } else if (detail.kind === 'attachment') {
      const current = store.getAttachment(detail.attachment.attachmentId);
      const referenced = this.composeAgentSnapshot(agentId).items.some((item) => item.kind === 'turn' &&
        (item.attachmentIds?.includes(detail.attachment.attachmentId) || item.steps.some((step) => step.frames.some((frame) =>
          'attachmentIds' in frame && frame.attachmentIds?.includes(detail.attachment.attachmentId)))));
      if (current?.detailRef !== undefined || (current === undefined && referenced)) op = { op: 'attachment.upsert', attachment: detail.attachment };
    } else {
      const current = store.getPrompt(detail.prompt.promptId);
      if (current?.detailRef !== undefined) op = { op: 'prompt.upsert', prompt: detail.prompt as typeof current };
    }
    // A live upsert that already replaced the summary wins over the read.
    if (op === undefined) return false;
    store.apply([op]);
    this.forestDirtyAgents.add(agentId);
    this.pendingTranscriptAgents.add(agentId);
    this.flushFrames();
    return true;
  }

  private setDetailLoad(
    agentId: string,
    key: string,
    status: SessionViewState['detailLoads'][string] | undefined,
  ): void {
    const current = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
    const previous = current.detailLoads[key];
    if (previous === status) return;
    const detailLoads = { ...current.detailLoads };
    if (status === undefined) delete detailLoads[key];
    else detailLoads[key] = status;
    this.publishAgentView(agentId, { ...current, version: current.version + 1, detailLoads });
  }

  private applyTranscriptOps(
    agentId: string,
    ops: readonly TranscriptOperation[],
    cursor: TranscriptCursor,
    throughSeq: number,
  ): void {
    const pending = this.pendingTranscriptBatches.get(agentId);
    const last = pending?.cursor ?? this.transcriptCursors.get(agentId);
    if (last?.epoch !== undefined && cursor.epoch !== undefined && cursor.epoch !== last.epoch) {
      if (this.state.resyncError?.retryable !== false) void this.resync();
      return;
    }
    const seenThrough = pending === undefined ? last?.seq : Math.max(pending.cursor.seq, pending.throughSeq);
    if (seenThrough !== undefined && throughSeq <= seenThrough) return;
    const freshOps = seenThrough !== undefined && cursor.seq <= seenThrough ? [] : ops;
    if (pending === undefined) {
      this.pendingTranscriptBatches.set(agentId, { ops: [...freshOps], cursor, throughSeq });
    } else {
      pending.ops.push(...freshOps);
      if (cursor.seq >= pending.cursor.seq) pending.cursor = cursor;
      if (throughSeq > pending.throughSeq) pending.throughSeq = throughSeq;
    }
    this.scheduleFrameFlush();
  }

  private flushPendingTranscriptBatches(): void {
    if (this.pendingTranscriptBatches.size === 0) return;
    const agentIds = [...this.pendingTranscriptBatches.keys()];
    for (const agentId of agentIds) this.flushPendingTranscriptBatch(agentId);
  }

  private flushPendingTranscriptBatch(agentId: string, startCatchUp = true): boolean {
    const batch = this.pendingTranscriptBatches.get(agentId);
    if (batch === undefined) return true;
    this.pendingTranscriptBatches.delete(agentId);
    // Ops apply keyed on `cursor`; the resume watermark folds in `throughSeq`
    // (same epoch by construction — an epoch change reroutes to resync above)
    // so a reconnect does not re-pull the filtered tail after the last
    // visible batch.
    const resumeCursor: TranscriptCursor =
      batch.throughSeq > batch.cursor.seq
        ? { seq: batch.throughSeq, epoch: batch.cursor.epoch }
        : batch.cursor;
    const store = this.ensureAgentTranscript(agentId);
    const priorCursor = this.transcriptCursors.get(agentId);
    const changedTasks = new Set(batch.ops.flatMap((op) => op.op === 'task.upsert' &&
      op.task.kind === 'subagent' && store.getTask(op.task.taskId)?.state !== op.task.state ? [op.task.taskId] : []));
    const previousTodo = store.getTodo('todo');
    const result = this.applyAgentTranscriptOps(agentId, store, batch.ops);
    if (result.gap !== undefined) {
      this.toolCountSpans.delete(agentId);
      this.toolCountObservations.delete(agentId);
      const replay = this.catchupReplay.get(agentId);
      this.catchupReplay.set(agentId, {
        ops: replay === undefined ? batch.ops : [...replay.ops, ...batch.ops],
        cursor:
          replay === undefined || resumeCursor.seq >= replay.cursor.seq
            ? resumeCursor
            : replay.cursor,
      });
      if (startCatchUp) void this.catchUpAgent(agentId);
      return false;
    }
    this.observeCanonicalTodoRead(agentId, previousTodo, result.accepted, batch.cursor);
    this.recordToolCountSpan(agentId, priorCursor, resumeCursor, result.toolCallCountDelta);
    this.transcriptCursors.set(agentId, resumeCursor);
    if (this.hasTranscriptBaseline(agentId)) this.viewHandle?.updateTranscriptCursor(agentId, resumeCursor);
    const adoptedCount = this.adoptToolCountObservation(agentId);
    if (result.accepted.length > 0 || adoptedCount) {
      for (const op of result.accepted) {
        if (op.op === 'frame.upsert' && op.frame.kind === 'tool') {
          const key = `${agentId}/${op.frame.toolCallId}`;
          const current = store.getToolCall(op.frame.toolCallId);
          if (this.toolDetails.has(key) && current !== undefined) this.toolDetails.set(key, { status: 'found', ...current });
        }
        this.observeContentPreview(agentId, op);
      }
      for (const target of this.contentReaders.values()) {
        if (target.agentId !== agentId || !target.blocked) continue;
        const refs = this.contentRefsFor(agentId, target.source);
        if (target.ref === undefined || !refs.some((ref) => sameContentRef(ref, target.ref!))) target.blocked = false;
      }
      void this.pumpContentReads();
      if (opsAffectForest(result.accepted)) this.forestDirtyAgents.add(agentId);
      // A spawn names an agent the viewer has no roster row for; the row (role
      // profile and model) rides the session snapshot, not this op stream.
      this.requestRosterRows(subagentAgentsInOps(result.accepted), undefined, true);
      if (this.state.agentCounts !== undefined && result.accepted.some((op) =>
        op.op === 'task.upsert' && changedTasks.has(op.task.taskId) && op.task.agentId !== undefined,
      )) void this.refreshRoster(this.state.cursor);
      this.pendingTranscriptAgents.add(agentId);
    }
    return true;
  }

  private catchUpAgent(agentId: string): Promise<void> {
    const inFlight = this.catchupByAgent.get(agentId);
    if (inFlight !== undefined) {
      this.flushPendingTranscriptBatch(agentId, false);
      return inFlight;
    }
    this.flushPendingTranscriptBatch(agentId, false);
    const run = this.runCatchUpAgent(agentId).finally(() => {
      if (this.catchupByAgent.get(agentId) === run) this.catchupByAgent.delete(agentId);
    });
    this.catchupByAgent.set(agentId, run);
    return run;
  }

  private async runCatchUpAgent(agentId: string): Promise<void> {
    if (this.closed || this.resyncInFlight || this.rewriteHold !== undefined || this.state.resyncError?.retryable === false) return;
    const generation = this.historyGeneration.get(agentId) ?? 0;
    const controller = new AbortController();
    this.catchupControllers.set(agentId, controller);
    const isCurrent = (): boolean => !this.closed && !this.isSuspended && !controller.signal.aborted &&
      (this.historyGeneration.get(agentId) ?? 0) === generation;
    try {
      if (!this.hasTranscriptBaseline(agentId)) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
      }
      const last = this.transcriptCursors.get(agentId) ?? { seq: 0 };
      const grade = gradeFor(this.transcriptGrades, agentId);
      let result = await this.view.transcript.catchUp({ agentId, since: last, grade: grade === 'off' ? 'turn' : grade }, { signal: controller.signal });
      const pages = [result];
      let since = last;
      while (result.has_more === true) {
        if (!isCurrent()) return;
        if (!result.complete || (since.epoch !== undefined && result.epoch !== since.epoch) || result.through_seq <= since.seq) {
          this.catchupReplay.delete(agentId);
          await this.resync();
          return;
        }
        since = { seq: result.through_seq, epoch: result.epoch };
        result = await this.view.transcript.catchUp({ agentId, since, grade: grade === 'off' ? 'turn' : grade }, { signal: controller.signal });
        pages.push(result);
      }
      if (!isCurrent()) return;
      if (!result.complete || (since.epoch !== undefined && result.epoch !== since.epoch)) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
      }
      const store = this.ensureAgentTranscript(agentId);
      const recoveredOps: TranscriptOperation[] = [];
      for (const page of pages) for (const batch of page.batches) {
        recoveredOps.push(...(batch.ops as readonly TranscriptOperation[]));
      }
      let previousTodo = store.getTodo('todo');
      const recovered = this.applyAgentTranscriptOps(agentId, store, recoveredOps);
      if (recovered.gap !== undefined) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
      }
      const accepted = new Set(recovered.accepted);
      for (const page of pages) for (const batch of page.batches) {
        const ops = batch.ops.filter((op) => accepted.has(op as TranscriptOperation)) as readonly TranscriptOperation[];
        this.observeCanonicalTodoRead(agentId, previousTodo, ops, { seq: batch.seq, epoch: page.epoch });
        for (const op of ops) if (op.op === 'todo.upsert' && op.todo.todoId === 'todo') previousTodo = op.todo;
      }
      let changed = recovered.accepted.length > 0;
      if (opsAffectForest(recovered.accepted)) this.forestDirtyAgents.add(agentId);
      let cursor: TranscriptCursor = { seq: result.through_seq, epoch: result.epoch };
      const live = this.transcriptCursors.get(agentId);
      if (live !== undefined && live.epoch === result.epoch && live.seq > cursor.seq) {
        cursor = live;
      }
      const pending = this.catchupReplay.get(agentId);
      this.catchupReplay.delete(agentId);
      if (pending !== undefined) {
        const previousTodo = store.getTodo('todo');
        const retry = this.applyAgentTranscriptOps(agentId, store, pending.ops);
        if (retry.gap !== undefined) {
          await this.resync();
          return;
        }
        this.observeCanonicalTodoRead(agentId, previousTodo, retry.accepted, pending.cursor);
        if (pending.cursor.seq > cursor.seq) cursor = pending.cursor;
        if (retry.accepted.length > 0) changed = true;
        if (opsAffectForest(retry.accepted)) this.forestDirtyAgents.add(agentId);
      }
      this.toolCountSpans.delete(agentId);
      this.transcriptCursors.set(agentId, cursor);
      this.viewHandle?.updateTranscriptCursor(agentId, cursor);
      const adoptedCount = this.adoptToolCountObservation(agentId);
      if (changed || adoptedCount) {
        this.pendingTranscriptAgents.add(agentId);
        this.scheduleFrameFlush();
      }
    } catch {
      if (!isCurrent()) return;
      this.catchupReplay.delete(agentId);
      await this.resync();
    } finally {
      if (this.catchupControllers.get(agentId) === controller) this.catchupControllers.delete(agentId);
    }
  }

  private applyAgentTranscriptOps(agentId: string, store: AgentTranscript, ops: readonly TranscriptOperation[]) {
    const removed = new Set<string>();
    for (const op of ops) if (op.op === 'items.remove') for (const id of op.ids) removed.add(id);
    const planned: { key: string; turnId: string }[] = [];
    const removedRetained = new Set<string>();
    if (removed.size > 0) {
      const older = this.olderPages.get(agentId);
      for (const item of older?.items ?? []) if (removed.has(itemId(item))) removedRetained.add(itemId(item));
      if (older !== undefined && removedRetained.size > 0) {
        const retained = new AgentTranscript(agentId);
        retained.apply([{ op: 'reset', agentId, snapshot: older }]);
        planned.push(...this.residentToolDetailsOnTurns(agentId, retained, removedRetained));
        retained.apply([{ op: 'items.remove', ids: [...removedRetained] }]);
        this.olderPages.set(agentId, retained.snapshot());
      }
      planned.push(...this.residentToolDetailsOnTurns(agentId, store, removed));
      for (const op of ops) {
        if (op.op === 'frame.upsert' && op.frame.kind === 'tool' && removed.has(op.turnId)) planned.push({ key: `${agentId}/${op.frame.toolCallId}`, turnId: op.turnId });
      }
      const prefix = `${agentId}/`;
      for (const [key, lookup] of this.toolDetails) {
        if (key.startsWith(prefix) && lookup.status === 'found' && removed.has(lookup.turnId)) planned.push({ key, turnId: lookup.turnId });
      }
    }
    const result = store.apply(ops);
    const retainedRemovals = ops.filter((op) => op.op === 'items.remove' && op.ids.some((id) => removedRetained.has(id)) && !result.accepted.includes(op));
    const acceptedOps = retainedRemovals.length === 0 ? result.accepted : [...result.accepted, ...retainedRemovals];
    if (removed.size > 0) {
      const accepted = new Set<string>();
      for (const op of acceptedOps) if (op.op === 'items.remove') for (const id of op.ids) accepted.add(id);
      const keys = new Set<string>();
      for (const entry of planned) if (accepted.has(entry.turnId)) keys.add(entry.key);
      for (const key of keys) this.invalidateToolDetail(key);
      if (accepted.size > 0) {
        for (const id of accepted) this.historyPreviewPages.delete(`${agentId}/${id}`);
        for (const [key, entry] of this.contentBodies) if (entry.agentId === agentId &&
          (entry.source.kind === 'turn' && accepted.has(entry.source.id) || entry.source.kind === 'frame' && entry.source.turnId !== undefined && accepted.has(entry.source.turnId))) this.contentBodies.delete(key);
        this.olderPageCursors.delete(agentId);
        if (accepted.has(this.olderPageTurns.get(agentId) ?? '')) this.olderPageTurns.delete(agentId);
        this.cancelHistoryRead(agentId);
      }
    }
    return retainedRemovals.length === 0 ? result : { ...result, accepted: acceptedOps };
  }

  private residentToolDetailsOnTurns(agentId: string, store: AgentTranscript, turnIds: ReadonlySet<string>): { key: string; turnId: string }[] {
    const entries: { key: string; turnId: string }[] = [];
    for (const turnId of turnIds) {
      const turn = store.getTurn(turnId);
      if (turn === undefined) continue;
      for (const step of turn.steps) for (const frame of step.frames) {
        if (frame.kind === 'tool') entries.push({ key: `${agentId}/${frame.toolCallId}`, turnId });
      }
    }
    return entries;
  }

  private invalidateToolDetail(key: string): void {
    this.toolDetails.delete(key);
    this.toolDetailEpochs.set(key, (this.toolDetailEpochs.get(key) ?? 0) + 1);
    const flight = this.toolDetailReads.get(key);
    if (flight === undefined) return;
    this.toolDetailReads.delete(key);
    flight.controller.abort();
  }

  private bumpHistoryGeneration(agentId: string): void {
    this.historyGeneration.set(agentId, (this.historyGeneration.get(agentId) ?? 0) + 1);
    for (const [key, flight] of this.historyPreviewReads) if (flight.agentId === agentId) {
      this.historyPreviewReads.delete(key);
      flight.controller.abort();
    }
    for (const [key, flight] of this.toolDetailReads) if (key.startsWith(`${agentId}/`)) { this.toolDetailReads.delete(key); flight.controller.abort(); }
    for (const key of this.toolDetails.keys()) if (key.startsWith(`${agentId}/`)) this.toolDetails.delete(key);
    for (const [controller, owner] of this.rangeControllers) if (owner === agentId) controller.abort();
    this.contentRanges.clear(); this.contentRangeBytes = 0;
    this.cancelHistoryRead(agentId);
    this.catchupControllers.get(agentId)?.abort();
    this.catchupControllers.delete(agentId);
    this.catchupByAgent.delete(agentId);
    this.toolCountSpans.delete(agentId);
    this.toolCountObservations.delete(agentId);
  }

  private observeToolCount(agentId: string, page: AgentTranscriptResponse): void {
    const count = page.tool_call_count;
    const cursor = page.cursor;
    if (count === undefined || !Number.isSafeInteger(count) || count < 0 || typeof cursor?.epoch !== 'string' || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) return;
    this.toolCountObservations.set(agentId, { count, cursor });
    this.adoptToolCountObservation(agentId);
  }

  private adoptToolCountObservation(agentId: string): boolean {
    const observation = this.toolCountObservations.get(agentId);
    if (observation === undefined) return false;
    const store = this.agentTranscripts.get(agentId);
    const current = this.transcriptCursors.get(agentId);
    if (store === undefined || current === undefined || current.epoch === undefined || current.epoch !== observation.cursor.epoch) {
      this.toolCountObservations.delete(agentId);
      return false;
    }
    if (store.snapshot().toolCallCount !== undefined) {
      this.toolCountObservations.delete(agentId);
      return false;
    }
    if (current.seq < observation.cursor.seq) return false;
    let count = observation.count;
    let through = observation.cursor.seq;
    for (const span of this.toolCountSpans.get(agentId) ?? []) {
      if (through === current.seq) break;
      if (span.through.seq <= through) continue;
      if (span.from.epoch !== current.epoch || span.from.seq !== through || span.through.seq > current.seq || span.delta === undefined) break;
      count += span.delta;
      through = span.through.seq;
    }
    this.toolCountObservations.delete(agentId);
    if (through !== current.seq || !Number.isSafeInteger(count) || count < 0) return false;
    const result = store.apply([{ op: 'tool.count.set', count }]);
    if (result.accepted.length === 0) return false;
    this.toolCountSpans.delete(agentId);
    this.forestDirtyAgents.add(agentId);
    return true;
  }

  private recordToolCountSpan(agentId: string, from: TranscriptCursor | undefined, through: TranscriptCursor, delta: number | undefined): void {
    if (this.agentTranscripts.get(agentId)?.snapshot().toolCallCount !== undefined) {
      this.toolCountSpans.delete(agentId);
      return;
    }
    if (from === undefined || from.epoch !== through.epoch || from.seq >= through.seq) return;
    const spans = this.toolCountSpans.get(agentId) ?? [];
    const grade = gradeFor(this.transcriptGrades, agentId);
    spans.push({ from, through, delta: grade === 'block' || grade === 'delta' ? delta : undefined });
    if (spans.length > TOOL_COUNT_SPAN_LIMIT) spans.splice(0, spans.length - TOOL_COUNT_SPAN_LIMIT);
    this.toolCountSpans.set(agentId, spans);
  }

  private ensureAgentTranscript(agentId: string): AgentTranscript {
    const existing = this.agentTranscripts.get(agentId);
    if (existing !== undefined) return existing;
    const created = new AgentTranscript(agentId);
    this.agentTranscripts.set(agentId, created);
    return created;
  }

  private composeAgentSnapshot(agentId: string): AgentTranscriptSnapshot {
    const live = this.ensureAgentTranscript(agentId).snapshot();
    const older = this.olderPages.get(agentId);
    if (older === undefined) {
      this.composedSnapshots.delete(agentId);
      return live;
    }
    const cached = this.composedSnapshots.get(agentId);
    if (cached?.older === older && cached.live.items === live.items && cached.live.tasks === live.tasks &&
        cached.live.interactions === live.interactions && cached.live.attachments === live.attachments &&
        cached.live.todos === live.todos && cached.live.prompts === live.prompts && cached.live.meta === live.meta &&
        cached.live.toolCallCount === live.toolCallCount && cached.live.toolCallCountKnown === live.toolCallCountKnown &&
        cached.live.hasMoreOlder === live.hasMoreOlder) return cached.snapshot;
    const snapshot = prependOlderTranscriptSnapshot(live, older);
    this.composedSnapshots.set(agentId, { live, older, snapshot });
    return snapshot;
  }

  private publishProjectedAgent(
    agentId: string,
    _store: AgentTranscript,
    options?: Partial<Pick<SessionViewState, 'loadingOlder' | 'fetchedOlder' | 'olderError' | 'historyCoverageKind'>> & {
      readonly retainPendingPrompts?: boolean;
      readonly transcriptReset?: boolean;
    },
  ): void {
    const snapshot = this.composeAgentSnapshot(agentId);
    const previousBase =
      agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
    const previous =
      previousBase.snapshotSubagents === this.state.snapshotSubagents
        ? previousBase
        : { ...previousBase, snapshotSubagents: this.state.snapshotSubagents };
    let next = projectAgentTranscriptView(previous, agentId, snapshot, {
      retainPendingPrompts: options?.retainPendingPrompts,
      cold: this.transcriptCursors.get(agentId)?.epoch?.startsWith('cold:') === true,
    });
    if (agentId === MAIN_AGENT_ID) {
      for (const prompt of snapshot.prompts) this.unprojectedQueueReceipts.delete(prompt.promptId);
      for (const receipt of this.unprojectedQueueReceipts.values()) {
        const projection = projectMessageContent(receipt.content);
        next = appendLocalUserMessage(next, { userMessageId: receipt.user_message_id, promptId: receipt.prompt_id,
          text: projection.text, media: projection.media, content: receipt.content, createdAt: receipt.created_at,
          status: receipt.status, origin: receipt.origin, appendTiming: receipt.append_timing });
        next = { ...next, queuedPromptMeta: { ...next.queuedPromptMeta,
          [receipt.prompt_id]: { appendTiming: receipt.append_timing ?? 'agent_idle', revision: receipt.revision, queuePosition: previous.queuedPromptMeta[receipt.prompt_id]?.queuePosition } } };
      }
    }
    for (const block of next.blocks) {
      if (block.kind !== 'question' || block.outcome !== undefined) continue;
      const outcome = this.questionOutcomes.get(block.request.question_id);
      if (outcome !== undefined) next = markQuestionOutcome(next, block.request.question_id, outcome);
    }
    const projected =
      options === undefined
        ? next
        : {
            ...next,
            transcriptResetVersion: options.transcriptReset === true
              ? next.transcriptResetVersion + 1
              : next.transcriptResetVersion,
            loadingOlder: options.loadingOlder ?? next.loadingOlder,
            fetchedOlder: options.fetchedOlder ?? next.fetchedOlder,
            olderError: Object.hasOwn(options, 'olderError') ? options.olderError : next.olderError,
            historyCoverageKind: options.historyCoverageKind ?? next.historyCoverageKind,
          };
    const globalCoverage = this.globalCoverage.get(agentId);
    const contentRefs = [...collectTranscriptContentRefs(snapshot), ...(agentId === MAIN_AGENT_ID ? this.latestSnapshot?.contentRefs ?? [] : [])];
    const withCoverage = { ...projected, globalCoverage, contentRefs, historyRead: this.historyReads.get(agentId), todoRead: this.todoReads.get(agentId), transcriptReady: this.hasTranscriptBaseline(agentId) };
    const forestChanged = this.forestDirtyAgents.delete(agentId) || this.publishedForest === undefined
      ? this.publishForest()
      : false;
    const cursor = this.transcriptCursors.get(agentId);
    if (cursor !== undefined) this.publishedTranscriptCursors.set(agentId, cursor);
    this.publishAgentView(agentId, withCoverage);
    if (this.contentReaders.size > 0) void this.pumpContentReads();
    if (forestChanged && agentId !== MAIN_AGENT_ID) {
      this.setState({ ...this.state, version: this.state.version + 1 });
    }
  }

  private publishAgentView(agentId: string, next: SessionViewState): void {
    if (agentId === MAIN_AGENT_ID) {
      this.setState(next);
    } else {
      this.agentStates.set(agentId, next);
      this.dirtyAgents.add(agentId);
      this.publishAgents();
    }
  }

  forestPublishCount = 0;

  private publishForest(): boolean {
    const snapshots = new Map<string, AgentTranscriptSnapshot>();
    for (const [agentId] of this.agentTranscripts) {
      snapshots.set(agentId, this.composeAgentSnapshot(agentId));
    }
    const previous = this.publishedForest;
    const coldAgents = new Set([...this.transcriptCursors].filter(([, cursor]) => cursor.epoch?.startsWith('cold:') === true).map(([agentId]) => agentId));
    this.publishedForest = this.forestQuery.read(snapshots, this.state.snapshotSubagents, coldAgents);
    this.forestPublishCount += 1;
    return previous !== this.publishedForest;
  }

  async sendPrompt(input: {
    text: string;
    /**
     * Full wire content override (mentions folded into the text part, images
     * as base64 parts). When omitted, a single text part carries `text`.
     */
    content?: MessageContent[];
    /**
     * Main-agent profile to bind before this prompt runs. Carry the new name
     * WITHOUT model/thinking so the rebind lands on the profile's own pins.
     */
    profile?: string;
    execution?: ExecutionSelection;
    model?: string;
    thinking?: string | null;
    permissionMode?: PermissionMode;
    planMode?: boolean;
    /**
     * Session plan-gate pick (`plan_gate`): when set, every prompt of this
     * session pins the agent's gate; omit to keep the agent's current gate.
     */
    planGate?: PromptPlanGate;
    goalObjective?: string;
    goalControl?: 'pause' | 'resume' | 'cancel';
    /**
     * Deferred-append timing for this message when it lands in the queue
     * (consumed only when the prompt actually parks; running prompts ignore
     * it). Defaults to the server-side `agent_idle` when omitted.
     */
    appendTiming?: DeferredAppendTiming;
    /**
     * Park this prompt behind an accepted model-switch operation: it launches
     * only after that operation completes, on the binding the operation
     * committed. Send-now/steer paths never carry it (they run on the live
     * binding by definition).
     */
    afterModelSwitch?: string;
    modelSwitchMode?: 'direct' | 'compact' | 'fresh';
    promptId?: string;
    skills?: import('@kiki/protocol').PromptSubmission['skills'];
    personaGreetingReply?: boolean;
    onPreservation?: (persisted: boolean) => void;
    onAcknowledged?: () => void;
  }): Promise<PromptSubmitResult> {
    // Prompt submission is the durable enqueue boundary. History resync and
    // ordered-view readiness must not block a user message from reaching the
    // server; rewrite/edit/steer operations keep their stricter cursor gate.
    const content = input.content ?? [{ type: 'text' as const, text: input.text }];
    const promptId = input.promptId ?? newSteerPromptId();
    const durable = this.usesDurableSubmission();
    const preservation = preserveSubmission({ sessionId: this.sessionId, agentId: MAIN_AGENT_ID, promptId, content, createdAt: new Date().toISOString() }, { persist: durable });
    input.onPreservation?.(preservation.persisted);
    const result = await this.client.submitPrompt(this.sessionId, {
      admission: durable ? 'durable' : undefined,
      content,
      profile: input.profile,
      execution: input.execution,
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode,
      goal_objective:
        input.goalObjective !== undefined && input.goalObjective.trim() !== ''
          ? input.goalObjective.trim()
          : undefined,
      goal_control: input.goalControl,
      append_timing: input.appendTiming,
      after_model_switch: input.afterModelSwitch,
      model_switch_mode: input.modelSwitchMode,
      prompt_id: promptId,
      skills: input.skills,
      persona_greeting_reply: input.personaGreetingReply,
    });
    const admissionRejected = result.admission === 'failed' || result.admission === 'cancelled';
    if (!admissionRejected) {
      preservation.acknowledge();
      input.onAcknowledged?.();
    }
    if (result.admission !== undefined) {
      this.setDurableIngress([
        ...(this.state.durableIngress ?? []).filter((item) => item.prompt_id !== result.prompt_id),
        result,
      ]);
    }
    const coreAdmitted = result.admission === undefined || result.admission === 'admitted';
    const canonical = this.agentTranscripts.get(MAIN_AGENT_ID)?.getPrompt(result.prompt_id);
    if (coreAdmitted && result.status === 'queued' && canonical === undefined) {
      this.unprojectedQueueReceipts.set(result.prompt_id, result);
    }
    if (!coreAdmitted || admissionRejected || canonical !== undefined) return result;
    const projection = projectMessageContent(result.content);
    this.setState(
      appendLocalUserMessage(this.state, {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: projection.text === '' ? input.text : projection.text,
        createdAt: result.created_at,
        status: result.status,
        origin: result.origin,
        media: projection.media,
        content: result.content,
        appendTiming: result.append_timing ?? input.appendTiming,
      }),
    );
    return result;
  }

  /**
   * Optimistic-concurrency cursor for the message-closure routes: the view's
   * current durable watermark. The server answers 40937 when the journal moved
   * past it (another client edited/forked first).
   */
  private expectedCursor(): SessionCursor {
    return { seq: this.state.cursor.seq, epoch: this.state.cursor.epoch };
  }

  /**
   * Edit-resend a user message (`POST …/messages/{mid}:edit`, full-replacement
   * semantics — attachments are NOT inherited; the body is the whole new
   * content). The server truncates the history from the target onward and
   * reruns the turn; we resync locally so the truncated tail (and any orphaned
   * subagent captures) repaint from server truth.
   */
  async editMessage(
    messageId: string,
    input: {
      text: string;
      content?: MessageContent[];
      model?: string;
      thinking?: string | null;
      permissionMode?: PermissionMode;
      planMode?: boolean;
      planGate?: PromptPlanGate;
    },
  ): Promise<void> {
    await this.runMessageRewrite('edit', messageId, {
      content: input.content ?? [{ type: 'text', text: input.text }],
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode === true ? true : undefined,
    });
    // The server also emits event.session.history_rewritten; resyncing here
    // makes the local repaint independent of WS delivery.
    void this.resync({ rewrite: true });
  }

  /**
   * Regenerate the turn behind an assistant message
   * (`POST …/messages/{mid}:regenerate`). Same rewrite + resync shape as
   * editMessage, without new content.
   */
  async regenerateMessage(
    messageId: string,
    input: {
      model?: string;
      thinking?: string | null;
      permissionMode?: PermissionMode;
      planMode?: boolean;
      planGate?: PromptPlanGate;
    } = {},
  ): Promise<void> {
    await this.runMessageRewrite('regenerate', messageId, {
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode === true ? true : undefined,
    });
    void this.resync({ rewrite: true });
  }

  private readonly messageRewrites = new Map<string, {
    fingerprint: string;
    body: import('../transport').EditMessageRequest | import('../transport').RegenerateMessageRequest;
    flight?: Promise<PromptSubmitResult>;
    result?: PromptSubmitResult;
  }>();

  private async runMessageRewrite(
    action: 'edit' | 'regenerate',
    messageId: string,
    input: Omit<import('../transport').EditMessageRequest, 'expected_cursor'> | Omit<import('../transport').RegenerateMessageRequest, 'expected_cursor'>,
  ): Promise<PromptSubmitResult> {
    const key = `${action}:${messageId}`;
    const fingerprint = JSON.stringify(input);
    let operation = this.messageRewrites.get(key);
    if (operation?.fingerprint !== fingerprint) operation = undefined;
    if (operation?.result !== undefined) {
      if (JSON.stringify(operation.body.expected_cursor) === JSON.stringify(this.expectedCursor())) return operation.result;
      operation = undefined;
    }
    if (operation?.flight !== undefined) return operation.flight;
    assertSessionWritable(this.state);
    if (operation === undefined) {
      operation = { fingerprint, body: { ...input, operation_id: newSteerPromptId(), expected_cursor: this.expectedCursor() } };
      this.messageRewrites.set(key, operation);
    }
    const retained = operation;
    const request = action === 'edit'
      ? this.client.editMessage(this.sessionId, messageId, retained.body as import('../transport').EditMessageRequest)
      : this.client.regenerateMessage(this.sessionId, messageId, retained.body);
    retained.flight = request;
    try {
      retained.result = await request;
      return retained.result;
    } catch (error) {
      const code = error instanceof ApiError || error instanceof RPCError ? error.code : undefined;
      if (code !== undefined && code > 0 && code !== 50001 && this.messageRewrites.get(key) === retained) {
        this.messageRewrites.delete(key);
      }
      throw error;
    } finally {
      retained.flight = undefined;
    }
  }

  /**
   * Fork the session at a message (`POST …:fork` with the truncation pair).
   * Returns the new session record; the caller navigates. Open-tail semantics:
   * no prompt runs in the fork until the user sends one.
   */
  async forkFromMessage(messageId: string): Promise<Session> {
    const fork = await this.client.forkSession(this.sessionId, {
      through_message_id: messageId,
      expected_cursor: this.expectedCursor(),
    });
    return fork;
  }

  async abortActive(): Promise<void> {
    if (this.abortActiveInFlight !== undefined) return this.abortActiveInFlight;
    const pending = this.abortActiveAndRestore();
    this.abortActiveInFlight = pending;
    try {
      await pending;
    } finally {
      this.abortActiveInFlight = undefined;
    }
  }

  private unansweredPromptContent(promptId: string, afterAbort = false): readonly MessageContent[] | undefined {
    const store = this.agentTranscripts.get(MAIN_AGENT_ID);
    if (store === undefined || this.appliedTranscriptGrades.get(MAIN_AGENT_ID) !== 'delta') return undefined;
    const snapshot = store.snapshot();
    const prompt = snapshot.prompts.find((item) => item.promptId === promptId);
    if (prompt === undefined || prompt.steeredAt !== undefined ||
        (prompt.status !== 'running' && !(afterAbort && prompt.status === 'aborted'))) return undefined;
    const turn = snapshot.items.find((item) => item.kind === 'turn' && (
      item.promptId === promptId || item.origin.kind === 'user' &&
      typeof item.origin.payload === 'object' && item.origin.payload !== null &&
      'promptId' in item.origin.payload && item.origin.payload.promptId === promptId
    ));
    if (turn?.kind === 'turn') {
      if (turn.origin.kind !== 'user') return undefined;
      if (turn.steps.some((step) => step.frames.some((frame) => frame.kind === 'tool' ||
          frame.kind === 'text' && frame.role === 'assistant' && (frame.text !== '' || (frame.attachmentIds?.length ?? 0) > 0)))) return undefined;
    }
    const parsed = messageContentSchema.array().safeParse(prompt.content);
    if (!parsed.success || parsed.data.length === 0 || parsed.data.some((part) =>
      part.type !== 'text' && part.type !== 'image' && part.type !== 'video' && part.type !== 'file')) return undefined;
    return parsed.data;
  }

  private async abortActiveAndRestore(): Promise<void> {
    if (!this.state.busy) return;
    const promptId = this.state.abortablePromptId;
    if (promptId !== undefined) {
      const content = this.unansweredPromptContent(promptId);
      const result = await this.client.abortPrompt(this.sessionId, promptId);
      await this.refreshPrompts();
      if (result.aborted && content !== undefined && this.lastRestoredPromptId !== promptId &&
          this.unansweredPromptContent(promptId, true) !== undefined) {
        this.lastRestoredPromptId = promptId;
        for (const listener of this.interruptedPromptListeners) listener(content);
      }
      return;
    }
    const turnId = this.state.abortableTurnId;
    if (turnId !== undefined) await this.client.abortTurn(this.sessionId, turnId);
  }

  async abortPrompt(promptId: string): Promise<void> {
    const result = await this.client.abortPrompt(this.sessionId, promptId, undefined, true);
    this.unprojectedQueueReceipts.delete(promptId);
    const queuedPromptMeta = { ...this.state.queuedPromptMeta };
    delete queuedPromptMeta[promptId];
    this.setState({ ...this.state, version: this.state.version + 1,
      queuedPromptIds: this.state.queuedPromptIds.filter((id) => id !== promptId), queuedPromptMeta,
      blocks: this.state.blocks.filter((block) => !(block.kind === 'user' && block.promptId === promptId && block.promptStatus === 'queued' && block.turnId === undefined)),
    });
    await this.refreshPrompts();
    if (!result.aborted) await this.resync();
  }

  async readQueuedPromptContent(promptId: string, signal?: AbortSignal): Promise<readonly MessageContent[] | undefined> {
    const source = { kind: 'prompt' as const, id: promptId };
    const lease = this.beginContentRead(MAIN_AGENT_ID, source, ['content']);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const ref = this.contentRefsFor(MAIN_AGENT_ID, source).find((candidate) => candidate.path[0] === 'content');
        if (ref === undefined) break;
        if (!await this.loadContentSegment(MAIN_AGENT_ID, ref)) throw new Error('Could not read the complete queued prompt');
      }
      const prompt = this.agentTranscripts.get(MAIN_AGENT_ID)?.getPrompt(promptId);
      if (prompt?.status !== 'queued' && prompt?.status !== 'blocked') return undefined;
      const parsed = messageContentSchema.array().safeParse(prompt.content);
      if (!parsed.success) throw new Error('Could not read the original queued prompt attachments');
      return parsed.data;
    } finally { lease.release(); }
  }

  async replaceQueued(promptId: string, text: string, retainedAttachments?: readonly MessageContent[], presentation?: import('@kiki/transcript').TextPresentation): Promise<void> {
    assertSessionWritable(this.state);
    const result = await this.client.replacePrompt(this.sessionId, promptId, {
      content: [...(text.trim() === '' ? [] : [{ type: 'text' as const, text, presentation }]), ...(retainedAttachments ?? [])],
      replace_attachments: retainedAttachments === undefined ? undefined : true,
    });
    if (this.unprojectedQueueReceipts.has(promptId)) this.unprojectedQueueReceipts.set(promptId, result);
    const projection = projectMessageContent(result.content);
    this.setState(
      appendLocalUserMessage(this.state, {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: projection.text,
        createdAt: result.created_at,
        status: result.status,
        origin: result.origin,
        media: projection.media,
        content: result.content,
      }),
    );
  }

  async moveQueued(promptId: string, targetIndex: number): Promise<void> {
    assertSessionWritable(this.state);
    const result = await this.client.movePrompt(this.sessionId, promptId, {
      target_index: targetIndex,
    });
    // The receipt lists the engine's SHARED drain order, which interleaves
    // model-switch control items (reserved ids) with messages. Control items
    // never become message rows here — they render through the model-switch
    // event pair — but their slots anchor each message's queuePosition so the
    // strip can interleave both kinds faithfully.
    const queuedPromptMeta: Record<string, QueuedPromptMeta> = { ...this.state.queuedPromptMeta };
    result.queued_prompt_ids.forEach((id, index) => {
      if (isModelSwitchQueueId(id)) return;
      const receipt = this.unprojectedQueueReceipts.get(id);
      if (receipt !== undefined) {
        this.unprojectedQueueReceipts.delete(id);
        this.unprojectedQueueReceipts.set(id, receipt);
      }
      const existing = queuedPromptMeta[id];
      queuedPromptMeta[id] = {
        ...existing,
        appendTiming: existing?.appendTiming ?? 'agent_idle',
        queuePosition: index,
      };
    });
    this.setState({
      ...this.state,
      version: this.state.version + 1,
      queuedPromptIds: result.queued_prompt_ids.filter((id) => !isModelSwitchQueueId(id)),
      queuedPromptMeta,
    });
  }

  /**
   * Re-time a parked prompt (`POST …:timing`). Sends the last known scheduling
   * revision as `expected_revision` so a concurrent retime (another client,
   * the engine itself) fails with 40001 instead of silently winning; stale
   * local replies likewise cannot replace a newer timing or queue-order write.
   */
  async setQueuedTiming(promptId: string, appendTiming: DeferredAppendTiming): Promise<void> {
    assertSessionWritable(this.state);
    const existing = this.state.queuedPromptMeta[promptId];
    const existingAppendTiming = existing?.appendTiming ?? 'agent_idle';
    const existingRevision = existing?.revision;
    const write = ++this.queuedTimingWriteSequence;
    this.queuedTimingWrites.set(promptId, write);
    const expected = existingRevision;
    let result: Awaited<ReturnType<SessionTransport['timingPrompt']>>;
    try {
      result = await this.client.timingPrompt(this.sessionId, promptId, {
        append_timing: appendTiming,
        expected_revision: expected,
      });
    } catch (error) {
      if (this.queuedTimingWrites.get(promptId) === write) this.queuedTimingWrites.delete(promptId);
      throw error;
    }
    const current = this.state.queuedPromptMeta[promptId];
    if (this.queuedTimingWrites.get(promptId) !== write) return;
    if (
      !this.state.queuedPromptIds.includes(promptId) ||
      (current?.appendTiming ?? 'agent_idle') !== existingAppendTiming ||
      current?.revision !== existingRevision
    ) {
      this.queuedTimingWrites.delete(promptId);
      return;
    }
    this.queuedTimingWrites.delete(promptId);
    this.setState({
      ...this.state,
      version: this.state.version + 1,
      queuedPromptMeta: {
        ...this.state.queuedPromptMeta,
        [promptId]: {
          ...current,
          appendTiming: result.append_timing ?? appendTiming,
          revision: result.revision,
        },
      },
    });
  }

  /**
   * Edit hold (`POST …:hold`): while a queued prompt is being edited the
   * engine keeps it — and everything queued behind it — from launching;
   * prompts ahead of it still run. The hold lapses server-side unless renewed,
   * so callers re-send `held: true` while the edit stays open. A transport
   * without the command (older server) resolves `false`: the edit still works,
   * the prompt just is not protected from launching.
   */
  async holdQueued(promptId: string, held: boolean): Promise<boolean> {
    if (this.client.holdPrompt === undefined) return false;
    assertSessionWritable(this.state);
    await this.client.holdPrompt(this.sessionId, promptId, { held });
    return true;
  }

  /** Send a parked prompt at the next safe boundary; report its actual disposition. */
  async steerQueued(promptId: string): Promise<{ readonly outcome: 'steered' | 'queued' | 'not_pending'; readonly reason?: PromptItem['delivery_reason'] }> {
    assertSessionWritable(this.state);
    const queued = this.state.blocks.find((block) =>
      block.kind === 'user' && block.promptId === promptId && block.promptStatus === 'queued');
    if (queued?.kind === 'user') {
      this.setPendingSteer(MAIN_AGENT_ID, {
        promptId,
        text: queued.text,
        presentation: queued.presentation,
        media: queued.media,
        createdAt: new Date().toISOString(),
        phase: 'sending',
      });
    }
    let delivery: Awaited<ReturnType<SessionTransport['steerPrompt']>>;
    try {
      delivery = await this.client.steerPrompt(this.sessionId, promptId);
    } catch (error) {
      this.clearPendingSteer(MAIN_AGENT_ID, promptId);
      if (error instanceof ApiError && error.code === API_CODES.PROMPT_NOT_FOUND) {
        await this.resync();
        return { outcome: 'not_pending', reason: 'prompt_no_longer_pending' };
      }
      await this.refreshPrompts();
      throw error;
    }
    this.unprojectedQueueReceipts.delete(promptId);
    if (delivery.steered) {
      const accepted = this.findPendingSteer(MAIN_AGENT_ID, promptId);
      if (accepted !== undefined) this.setPendingSteer(MAIN_AGENT_ID, { ...accepted, phase: 'waiting' });
    } else this.clearPendingSteer(MAIN_AGENT_ID, promptId);
    await this.refreshPrompts();
    if (!delivery.steered && delivery.delivery_state !== 'queued') await this.resync();
    return { outcome: delivery.steered ? 'steered' : delivery.delivery_state === 'queued' ? 'queued' : 'not_pending', reason: delivery.delivery_reason };
  }

  /** "Send now" echoes still between the keypress and their delivered frame, per agent. */
  getPendingSteers(agentId: string = MAIN_AGENT_ID): readonly PendingSteer[] {
    return this.pendingSteers.get(agentId) ?? [];
  }

  /**
   * "Send now" into the running turn of `agentId` (main or a native child) —
   * one path for every conversation, so the insertion point is the same
   * everywhere: the turn's next step boundary (after the current tool round).
   *
   * The message is on the timeline from the first frame: it enters the
   * steer ledger before any request goes out and leaves it only when the
   * projection owns its delivered frame. The prompt id is chosen here, so the
   * submit, the steer and the delivered context message share one identity
   * and the echo hands over to the real row without a remount.
   *
   * Idle agent: the submit starts its own turn and the echo retires as soon
   * as that prompt is running. A steer refused for a mode change is only
   * classified as refused after the parked prompt is confirmed withdrawn; if
   * withdrawal fails, the outcome is unknown and the queued prompt stays the
   * server-owned source of truth.
   */
  async sendPromptNow(input: {
    readonly agentId?: string;
    readonly text: string;
    readonly content?: MessageContent[];
    readonly media?: PendingSteer['media'];
    readonly promptId?: string;
    readonly profile?: string;
    readonly execution?: ExecutionSelection;
    readonly model?: string;
    readonly modelSwitchMode?: 'direct' | 'compact' | 'fresh';
    readonly thinking?: string | null;
    readonly permissionMode?: PermissionMode;
    readonly planMode?: boolean;
    readonly planGate?: PromptPlanGate;
    readonly onPreservation?: (persisted: boolean) => void;
    readonly onAcknowledged?: () => void;
  }): Promise<{ readonly promptId: string; readonly outcome: 'steered' | 'started' | 'queued' | 'not_pending' | 'restoring' | 'held' | 'failed' | 'cancelled'; readonly reason?: PromptItem['delivery_reason'] }> {
    assertSessionWritable(this.state);
    const agentId = input.agentId ?? MAIN_AGENT_ID;
    const promptId = input.promptId ?? newSteerPromptId();
    const content = input.content ?? [{ type: 'text' as const, text: input.text }];
    const projection = projectMessageContent(content);
    const durable = this.usesDurableSubmission();
    const preservation = preserveSubmission({ sessionId: this.sessionId, agentId, promptId, content, createdAt: new Date().toISOString() }, { persist: durable });
    input.onPreservation?.(preservation.persisted);
    this.setPendingSteer(agentId, {
      promptId,
      text: input.text,
      presentation: projection.presentation,
      media: input.media ?? nonEmpty(projection.media),
      createdAt: new Date().toISOString(),
      phase: 'sending',
    });
    let result: PromptSubmitResult;
    try {
      result = await this.client.submitPrompt(this.sessionId, {
        admission: durable ? 'durable' : undefined,
        delivery_mode: durable ? 'steer' : undefined,
        content,
        prompt_id: promptId,
        ...(agentId === MAIN_AGENT_ID ? {} : { agent_id: agentId }),
        profile: input.profile,
        execution: input.execution,
        model: input.model,
        model_switch_mode: input.modelSwitchMode,
        thinking: input.thinking,
        permission_mode: input.permissionMode,
        plan_mode: input.planMode,
        plan_gate: input.planGate,
      });
    } catch (error) {
      if (isUnconfirmedTransportError(error)) {
        const retained = this.findPendingSteer(agentId, promptId);
        if (retained !== undefined) this.setPendingSteer(agentId, { ...retained, phase: 'waiting' });
        throw new SendNowError('unknown', error);
      }
      this.clearPendingSteer(agentId, promptId);
      throw new SendNowError('submit', error);
    }
    const admission = result.admission;
    const admissionRejected = admission === 'failed' || admission === 'cancelled';
    if (!admissionRejected) {
      preservation.acknowledge();
      input.onAcknowledged?.();
    }
    if (admission !== undefined) {
      this.setDurableIngress([
        ...(this.state.durableIngress ?? []).filter((item) => item.prompt_id !== result.prompt_id),
        result,
      ], agentId);
    }
    const settled = this.settledSteerOutcome(agentId, result.prompt_id);
    if (settled !== undefined) {
      this.reconcileSteerOutcome(agentId, promptId, settled);
      return { promptId: result.prompt_id, outcome: settled };
    }
    if (admissionRejected) {
      this.clearPendingSteer(agentId, promptId);
      return { promptId: result.prompt_id, outcome: admission };
    }
    if (admission === 'restoring' || admission === 'held') {
      const retained = this.findPendingSteer(agentId, promptId);
      if (retained !== undefined) this.setPendingSteer(agentId, { ...retained, phase: 'waiting' });
      if (admission === 'restoring') this.observeDurableSteer(agentId, promptId);
      return { promptId: result.prompt_id, outcome: admission };
    }
    if (durable) {
      const retained = this.findPendingSteer(agentId, promptId);
      if (retained !== undefined) this.setPendingSteer(agentId, { ...retained, phase: 'waiting' });
      return { promptId: result.prompt_id, outcome: result.delivery_state === 'steered' ? 'steered'
        : result.status === 'queued' ? 'queued' : 'started', reason: result.delivery_reason };
    }
    if (result.status !== 'queued') {
      // Idle by the time it landed: the prompt opened its own turn, which is
      // an ordinary send — the projection owns the row from here.
      this.clearPendingSteer(agentId, promptId);
      return { promptId: result.prompt_id, outcome: 'started' };
    }
    try {
      const delivery = await this.client.steerPrompt(this.sessionId, result.prompt_id, agentId);
      const outcome = this.settledSteerOutcome(agentId, result.prompt_id);
      if (outcome !== undefined || delivery.delivery_state === 'queued') {
        this.reconcileSteerOutcome(agentId, promptId, outcome);
        return { promptId: result.prompt_id, outcome: outcome ?? 'queued', reason: outcome === undefined ? delivery.delivery_reason : undefined };
      }
      if (!delivery.steered) {
        this.clearPendingSteer(agentId, promptId);
        await this.resync();
        const disposition = this.settledSteerOutcome(agentId, result.prompt_id);
        return { promptId: result.prompt_id, outcome: disposition ?? 'not_pending', reason: disposition === undefined ? delivery.delivery_reason ?? 'prompt_no_longer_pending' : undefined };
      }
    } catch (error) {
      const outcome = this.settledSteerOutcome(agentId, result.prompt_id);
      this.reconcileSteerOutcome(agentId, promptId, outcome);
      if (outcome !== undefined) return { promptId: result.prompt_id, outcome };
      if (error instanceof ApiError && error.code === API_CODES.PROMPT_NOT_FOUND) {
        await this.resync();
        const disposition = this.settledSteerOutcome(agentId, result.prompt_id);
        if (disposition !== undefined) return { promptId: result.prompt_id, outcome: disposition };
        return { promptId: result.prompt_id, outcome: 'not_pending', reason: 'prompt_no_longer_pending' };
      }
      if (error instanceof ApiError && error.code === API_CODES.REQUEST_INVALID) {
        // Refused before it left the queue (it changes a mode, which needs a
        // turn of its own): only a confirmed withdrawal makes it safe for the
        // caller to hand the text back. A failed withdrawal leaves the prompt
        // queued, so its outcome is unknown and it must not be re-sent.
        let withdrawn: Awaited<ReturnType<SessionTransport['abortPrompt']>>;
        try {
          withdrawn = await this.client.abortPrompt(this.sessionId, result.prompt_id, agentId, true);
        } catch (abortError) {
          throw new SendNowError('unknown', abortError);
        }
        if (withdrawn.aborted === true) throw new SendNowError('refused', error);
        let canonical: NonNullable<AgentTranscriptResponse['prompts']>[number] | undefined;
        try {
          canonical = (await this.view.transcript.page({ agentId })).prompts?.find((item) => item.promptId === result.prompt_id);
        } catch (readError) {
          throw new SendNowError('unknown', readError);
        }
        if (canonical?.status === 'running' || canonical?.status === 'completed') {
          return { promptId: result.prompt_id, outcome: canonical.steeredAt === undefined ? 'started' : 'steered' };
        }
        throw new SendNowError('unknown', error);
      }
      // Outcome unknown: it may already be in the turn. Never withdraw it.
      throw new SendNowError('unknown', error);
    }
    const accepted = this.findPendingSteer(agentId, promptId);
    if (accepted !== undefined) this.setPendingSteer(agentId, { ...accepted, phase: 'waiting' });
    return { promptId: result.prompt_id, outcome: 'steered' };
  }

  private settledSteerOutcome(agentId: string, promptId: string): 'steered' | 'started' | 'failed' | 'cancelled' | undefined {
    const canonical = this.agentTranscripts.get(agentId)?.getPrompt(promptId);
    if (canonical === undefined || canonical.status === 'queued' || canonical.status === 'blocked') return undefined;
    if (canonical.status === 'aborted') return 'cancelled';
    if (canonical.status === 'failed') return 'failed';
    if (canonical.steeredAt !== undefined) return 'steered';
    return 'started';
  }

  private reconcileSteerOutcome(agentId: string, promptId: string, outcome: ReturnType<SessionController['settledSteerOutcome']>): void {
    if (outcome !== 'steered') {
      this.clearPendingSteer(agentId, promptId);
      return;
    }
    const retained = this.findPendingSteer(agentId, promptId);
    if (retained !== undefined) this.setPendingSteer(agentId, { ...retained, phase: 'waiting' });
  }

  private findPendingSteer(agentId: string, promptId: string): PendingSteer | undefined {
    return this.pendingSteers.get(agentId)?.find((steer) => steer.promptId === promptId);
  }

  private setPendingSteer(agentId: string, steer: PendingSteer): void {
    const current = this.pendingSteers.get(agentId) ?? [];
    const index = current.findIndex((entry) => entry.promptId === steer.promptId);
    this.pendingSteers.set(agentId, index < 0
      ? [...current, steer]
      : current.map((entry, at) => (at === index ? steer : entry)));
    this.republishSteers(agentId);
  }

  private clearPendingSteer(agentId: string, promptId: string): void {
    const current = this.pendingSteers.get(agentId);
    if (current === undefined || !current.some((steer) => steer.promptId === promptId)) return;
    const next = current.filter((steer) => steer.promptId !== promptId);
    if (next.length === 0) this.pendingSteers.delete(agentId);
    else this.pendingSteers.set(agentId, next);
    this.republishSteers(agentId);
  }

  /** Drop echoes whose delivered frame the projection now owns. */
  private retireSettledSteers(agentId: string, next: SessionViewState): void {
    const current = this.pendingSteers.get(agentId);
    if (current === undefined) return;
    const live = current.filter((steer) => !isSteerSettled(next.blocks, steer));
    if (live.length === current.length) return;
    if (live.length === 0) this.pendingSteers.delete(agentId);
    else this.pendingSteers.set(agentId, live);
  }

  /** Re-publish an agent's view with its current echoes (no transcript change). */
  private republishSteers(agentId: string): void {
    if (this.closed) return;
    if (agentId === MAIN_AGENT_ID) {
      this.setState({ ...this.state, version: this.state.version + 1 });
      return;
    }
    const base = this.agentStates.get(agentId) ?? this.emptyAgentState;
    this.agentStates.set(agentId, { ...base, version: base.version + 1 });
    this.dirtyAgents.add(agentId);
    this.publishAgents();
  }

  /** Clear the whole queue: the wire has no bulk-remove route, so abort each
   * parked prompt; one reconcile at the end repaints the strip. Failed ids stay
   * queued so the user can retry. */
  async clearQueue(): Promise<{ total: number; failed: number }> {
    const ids = this.state.queuedPromptIds;
    if (ids.length === 0) return { total: 0, failed: 0 };
    const results = await Promise.allSettled(
      ids.map((promptId) => this.abortPrompt(promptId)),
    );
    await this.refreshPrompts();
    return {
      total: ids.length,
      failed: results.filter((result) => result.status === 'rejected').length,
    };
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    selectedOptionId?: string,
    /** Plan review: the reviewer's note and the chosen review option (`Revise`, `Reject and Exit`). */
    review?: { readonly feedback?: string; readonly selectedLabel?: string },
  ): Promise<void> {
    const resolvedAt = new Date().toISOString();
    try {
      await this.client.resolveApproval(this.sessionId, approvalId, {
        decision,
        scope,
        selected_option_id: selectedOptionId,
        ...(review?.feedback === undefined ? {} : { feedback: review.feedback }),
        ...(review?.selectedLabel === undefined ? {} : { selected_label: review.selectedLabel }),
      });
      this.setState(markApprovalResolved(this.state, approvalId, { decision, resolvedAt }));
    } catch (error) {
      if (error instanceof ApiError && error.code === API_CODES.APPROVAL_ALREADY_RESOLVED) {
        this.setState(markApprovalResolved(this.state, approvalId, { decision: 'resolved_elsewhere', resolvedAt }));
        return;
      }
      if (error instanceof ApiError && error.code === API_CODES.APPROVAL_EXPIRED) {
        this.setState(markApprovalResolved(this.state, approvalId, { decision: 'expired', resolvedAt }));
        return;
      }
      throw error;
    }
  }

  private readonly questionOutcomes = new Map<string, QuestionOutcome>();

  private questionBlock(questionId: string) {
    const block = [this.state, ...this.agentStates.values()].flatMap((view) => view.blocks)
      .find((entry) => entry.kind === 'question' && entry.request.question_id === questionId);
    if (block?.kind !== 'question') return undefined;
    if (block.request.session_id !== '' && block.request.session_id !== this.sessionId) {
      throw new Error('The question belongs to a different session.');
    }
    return block;
  }

  private setQuestionOutcome(questionId: string, outcome: QuestionOutcome): void {
    this.questionOutcomes.set(questionId, outcome);
    this.setState(markQuestionOutcome(this.state, questionId, outcome));
    for (const [agentId, view] of this.agentStates) {
      const updated = markQuestionOutcome(view, questionId, outcome);
      if (updated !== view) this.publishAgentView(agentId, updated);
    }
  }

  private async reconcileQuestionOutcome(questionId: string, fallback: QuestionOutcome): Promise<void> {
    const block = this.questionBlock(questionId);
    this.setQuestionOutcome(questionId, fallback);
    try {
      const page = await this.view.transcript.page({ agentId: block?.originAgentId ?? MAIN_AGENT_ID, pageSize: 1 });
      if (this.closed) return;
      const interaction = page.interactions?.find((entry) => entry.interactionId === questionId);
      const outcome = interaction === undefined ? undefined : interactionToBlock(interaction, page.agent_id);
      if (outcome?.kind === 'question' && outcome.outcome !== undefined) {
        this.setQuestionOutcome(questionId, outcome.outcome);
      }
    } catch {
      // Keep the terminal REST outcome when a refresh is unavailable.
    }
  }

  private async handleQuestionError(questionId: string, error: unknown): Promise<boolean> {
    if (!(error instanceof ApiError)) return false;
    const at = new Date().toISOString();
    if (error.code === API_CODES.APPROVAL_ALREADY_RESOLVED) {
      await this.reconcileQuestionOutcome(questionId, { kind: 'resolvedElsewhere', at });
      return true;
    }
    if (error.code === API_CODES.QUESTION_NOT_FOUND || error.code === API_CODES.SESSION_NOT_FOUND) {
      await this.reconcileQuestionOutcome(questionId, { kind: 'unavailable', at });
      return true;
    }
    if (error.code === API_CODES.QUESTION_EXPIRED) {
      await this.reconcileQuestionOutcome(questionId, { kind: 'expired' });
      return true;
    }
    return false;
  }

  async answerQuestion(questionId: string, answers: QuestionResponse['answers']): Promise<void> {
    const block = this.questionBlock(questionId);
    if (block?.outcome !== undefined) return;
    const at = new Date().toISOString();
    try {
      await this.client.resolveQuestion(this.sessionId, questionId, { answers, method: 'click' });
      const texts = block === undefined ? undefined : questionAnswerTexts(block.request.questions, answers);
      this.setQuestionOutcome(questionId, { kind: 'answered', at, answers: texts });
    } catch (error) {
      if (!await this.handleQuestionError(questionId, error)) throw error;
    }
  }

  async dismissQuestion(questionId: string): Promise<void> {
    const block = this.questionBlock(questionId);
    if (block?.outcome !== undefined) return;
    const at = new Date().toISOString();
    try {
      await this.client.dismissQuestion(this.sessionId, questionId);
      this.setQuestionOutcome(questionId, { kind: 'dismissed', at });
    } catch (error) {
      if (!await this.handleQuestionError(questionId, error)) throw error;
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    try {
      await this.client.cancelTask(this.sessionId, taskId);
    } finally {
      await this.refreshTasks();
    }
  }
}

function opsAffectForest(ops: readonly TranscriptOperation[]): boolean {
  return ops.some((op) => {
    switch (op.op) {
      case 'reset':
      case 'tool.count.set':
      case 'task.upsert':
      case 'meta.merge':
      case 'turn.upsert':
      case 'step.upsert':
      case 'frame.upsert':
      case 'frame.remove':
      case 'items.remove':
        return true;
      default:
        return false;
    }
  });
}

/**
 * Agent ids a batch of transcript ops introduces as subagents: the spawned
 * agent's task row and the dispatch tool frame's `agentRef`s. Ids may repeat
 * across batches, so callers dedupe.
 */
function subagentAgentsInOps(ops: readonly TranscriptOperation[]): readonly string[] {
  const agentIds: string[] = [];
  for (const op of ops) {
    if (op.op === 'task.upsert') {
      if (op.task.kind === 'subagent' && op.task.agentId !== undefined && op.task.agentId !== '') {
        agentIds.push(op.task.agentId);
      }
      continue;
    }
    if (op.op === 'frame.upsert') {
      if (op.frame.kind !== 'tool') continue;
      for (const ref of op.frame.agentRefs ?? []) {
        if (ref.agentId !== '') agentIds.push(ref.agentId);
      }
    }
  }
  return agentIds;
}
