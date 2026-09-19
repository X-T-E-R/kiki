/**
 * SessionController — one session's REST snapshot, ordered transcript intake,
 * publication scheduling, resync, and user actions. Canonical transcript ops
 * are applied immediately and projected to React at most once per flush.
 */

import type {
  ApprovalDecision,
  ApprovalScope,
  DeferredAppendTiming,
  MessageContent,
  PermissionMode,
  PromptPlanGate,
  PromptSubmitResult,
  QuestionResponse,
  Session,
} from '@kiki/protocol';
import {
  AgentTranscript,
  gradeFor,
  type AgentTranscriptSnapshot,
  type TranscriptCoverage,
  type TranscriptCursor,
  type TranscriptEvent,
  type TranscriptGradeSpec,
  type TranscriptOperation,
} from '@kiki/transcript';

import {
  API_CODES,
  ApiError,
  DEFAULT_TRANSCRIPT_GRADES,
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
  sessionAgentForestFromAgentSnapshots,
  setLoadError,
  setLoadingOlder,
  setOlderError,
  setResyncFailed,
  setResyncing,
  setSessionRecord,
  type SessionViewState,
} from './transcript';
import { emptyOlderSnapshot } from './transcript/selectors';
import { stabilizeAgentForest, type AgentForest } from './agentTree';

export type Listener = () => void;

export const RESYNC_PAUSED_ERROR = 'Session is resyncing; sending is paused';

export function assertSessionWritable(state: Pick<SessionViewState, 'resyncing' | 'resyncFailed'>): void {
  if (state.resyncing || state.resyncFailed) {
    throw new Error(RESYNC_PAUSED_ERROR);
  }
}

const RESYNC_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
const REWRITE_RESET_TIMEOUT_MS = 10_000;
const HIDDEN_FRAME_FLUSH_INTERVAL_MS = 1000;

export interface PublicationScheduler {
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

interface VisibilityDocument {
  readonly visibilityState?: string;
  readonly addEventListener?: (type: string, listener: () => void) => void;
  readonly removeEventListener?: (type: string, listener: () => void) => void;
}

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
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 24);
  },
  cancel(handle) {
    if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') {
      cancelAnimationFrame(handle);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

function browserVisibilityDocument(): VisibilityDocument | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : fallback;
}

export class SessionController {
  private readonly client: SessionTransport;
  private viewHandle: SessionViewSubscription | undefined;
  private connectionGeneration: number | undefined;
  private viewAttachment = 0;
  readonly sessionId: string;
  private state: SessionViewState;
  private publishedState: SessionViewState;
  private readonly listeners = new Set<Listener>();
  private readonly scheduler: PublicationScheduler;
  private readonly usesBrowserScheduler: boolean;
  private readonly visibilityDocument: VisibilityDocument | undefined;
  private readonly rewriteResetTimeoutMs: number;
  private frameHandle: unknown = null;
  private hiddenFrameTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncInFlight = false;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private rewriteHold: RewriteHold | undefined;
  private rewriteHoldToken = 0;
  private closed = false;

  private readonly agentStates = new Map<string, SessionViewState>();
  private readonly publishedAgentStates = new Map<string, SessionViewState>();
  private readonly agentListeners = new Map<string, Set<Listener>>();
  private readonly dirtyAgents = new Set<string>();
  private readonly agentTranscripts = new Map<string, AgentTranscript>();
  private readonly olderPages = new Map<string, AgentTranscriptSnapshot>();
  private readonly transcriptCursors = new Map<string, TranscriptCursor>();
  private readonly toolCountObservations = new Map<string, ToolCountObservation>();
  private readonly toolCountSpans = new Map<string, ToolCountSpan[]>();
  private readonly pendingTranscriptBatches = new Map<string, PendingTranscriptBatch>();
  private readonly pendingTranscriptAgents = new Set<string>();
  private readonly forestDirtyAgents = new Set<string>();
  private readonly historyGeneration = new Map<string, number>();
  private readonly inFlightOlder = new Map<string, string>();
  private readonly emptyAgentState: SessionViewState;
  private publishedForest: AgentForest | undefined;
  private transcriptGrades: TranscriptGradeSpec = DEFAULT_TRANSCRIPT_GRADES;
  private focusedAgentId: string | undefined;
  private readonly catchupByAgent = new Map<string, Promise<void>>();
  private readonly catchupReplay = new Map<
    string,
    { readonly ops: readonly TranscriptOperation[]; readonly cursor: TranscriptCursor }
  >();

  constructor(
    client: SessionTransport,
    private readonly view: SessionViewFacade,
    sessionId: string,
    options: { scheduler?: PublicationScheduler; rewriteResetTimeoutMs?: number } = {},
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.usesBrowserScheduler = options.scheduler === undefined;
    this.visibilityDocument = this.usesBrowserScheduler ? browserVisibilityDocument() : undefined;
    this.rewriteResetTimeoutMs = options.rewriteResetTimeoutMs ?? REWRITE_RESET_TIMEOUT_MS;
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

  getAgentState = (agentId: string): SessionViewState =>
    this.publishedAgentStates.get(agentId) ?? this.agentStates.get(agentId) ?? this.emptyAgentState;

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
    this.publishedState = this.state;
    for (const listener of this.listeners) listener();
  }

  private publishAgents(): void {
    for (const agentId of this.dirtyAgents) {
      const state = this.agentStates.get(agentId);
      if (state === undefined) continue;
      this.publishedAgentStates.set(agentId, state);
      for (const listener of this.agentListeners.get(agentId) ?? []) listener();
    }
    this.dirtyAgents.clear();
  }

  private setState(next: SessionViewState, immediate = true): void {
    if (next === this.state) return;
    this.state = next;
    if (immediate) this.notifyMain();
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

  /** Initial sync: snapshot shell → subscribe_v2 with per-agent grades. */
  async open(): Promise<void> {
    try {
      const snapshot = await this.view.snapshot();
      if (this.closed) return;
      this.setState(applyTranscriptShell(this.sessionId, snapshot, this.state));
      this.transcriptGrades = this.requestedTranscriptGrades();
      this.attachView({ seq: snapshot.as_of_seq, epoch: snapshot.epoch });
    } catch (error) {
      if (this.closed) return;
      this.setState(setLoadError(this.state, errorMessage(error, 'Could not load session')));
    }
  }

  private attachView(sessionCursor: SessionCursor): void {
    const attachment = ++this.viewAttachment;
    this.droppedWithLiveWork = false;
    const previous = this.viewHandle;
    this.viewHandle = undefined;
    previous?.close();
    this.viewHandle = this.view.subscribe({
      sessionCursor,
      transcriptGrades: this.transcriptGrades,
      transcriptSince: this.transcriptCursors.size === 0 ? undefined : Object.fromEntries(this.transcriptCursors),
    }, (signal) => {
      if (attachment === this.viewAttachment) this.handleSignal(signal);
    });
  }

  nudge(): void {
    this.viewHandle?.nudge();
  }

  async retryOpen(): Promise<void> {
    if (this.closed) return;
    this.setState(setLoadError(this.state, undefined));
    await this.open();
  }

  close(): void {
    this.closed = true;
    this.visibilityDocument?.removeEventListener?.('visibilitychange', this.onVisibilityChange);
    this.clearResyncTimer();
    this.clearRewriteHold();
    this.cancelVisibleFrameFlush();
    this.clearHiddenFrameTimer();
    this.pendingTranscriptBatches.clear();
    this.pendingTranscriptAgents.clear();
    for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
    this.historyGeneration.clear();
    this.inFlightOlder.clear();
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
      this.applyTranscriptReset(event.agent_id, event.snapshot, event.coverage, event.cursor);
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

  private requestedTranscriptGrades(): TranscriptGradeSpec {
    const grades = { ...transcriptGradesForFocus(this.focusedAgentId) };
    for (const agentId of this.agentListeners.keys()) {
      if (!Object.hasOwn(grades, agentId)) grades[agentId] = 'turn';
    }
    return grades;
  }

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
    this.viewHandle?.setTranscriptGrades(this.transcriptGrades);
  }

  handleSignal(signal: SessionViewSignal): void {
    if (this.closed || (this.connectionGeneration !== undefined && signal.generation < this.connectionGeneration)) return;
    this.connectionGeneration = signal.generation;
    switch (signal.type) {
      case 'status':
        if (signal.status !== 'open') this.handleWsDrop();
        return;
      case 'ready':
        if (this.state.cursor.epoch !== undefined && signal.currentSessionCursor.epoch !== this.state.cursor.epoch) {
          this.handleSubscribeRejected(signal.generation);
          return;
        }
        this.advanceSessionCursor(signal.currentSessionCursor);
        if (signal.reconnected) this.handleReconnectAck();
        return;
      case 'sessionCursorAdvanced':
        this.advanceSessionCursor(signal.cursor);
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

  async resync(options: { rewrite?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    const rewrite = options.rewrite === true;
    if (rewrite) this.beginRewriteHold();
    const rewriteHoldToken = rewrite ? this.rewriteHold?.token : undefined;
    if (this.resyncInFlight) {
      if (rewrite) this.rewriteResyncQueued = true;
      return;
    }
    this.resyncInFlight = true;
    for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
    if (rewrite) this.rewriteResyncQueued = false;
    this.clearResyncTimer();
    this.setState(setResyncing(this.state, true));
    const attachment = this.viewAttachment;
    try {
      const snapshot = await this.view.snapshot();
      if (this.closed || attachment !== this.viewAttachment) return;
      for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
      this.pendingTranscriptBatches.clear();
      this.pendingTranscriptAgents.clear();
      this.catchupReplay.clear();
      this.transcriptCursors.clear();
      this.setState(
        setResyncing(
          {
            ...applyTranscriptShell(this.sessionId, snapshot, this.state),
            loadingOlder: false,
            olderError: undefined,
          },
          false,
        ),
      );
      this.attachView({ seq: snapshot.as_of_seq, epoch: snapshot.epoch });
      if (rewriteHoldToken !== undefined) this.armRewriteSubscription(rewriteHoldToken);
    } catch (error) {
      if (rewriteHoldToken !== undefined) this.clearRewriteHold(rewriteHoldToken);
      if (!this.closed && (attachment === this.viewAttachment || this.state.resyncError?.retryable !== false)) {
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
      if (!this.closed) {
        if (this.hardResyncQueued) {
          this.hardResyncQueued = false;
          this.rewriteResyncQueued = false;
          queueMicrotask(() => void this.resync());
        } else if (this.rewriteResyncQueued) {
          this.rewriteResyncQueued = false;
          queueMicrotask(() => void this.resync({ rewrite: true }));
        }
      }
    }
  }

  private scheduleResyncRetry(): void {
    if (this.closed || this.resyncTimer !== null) return;
    const step = Math.min(this.state.resyncAttempt, RESYNC_BACKOFF_MS.length) - 1;
    const delay = RESYNC_BACKOFF_MS[Math.max(0, step)] ?? 4000;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.closed) void this.resync();
    }, delay);
  }

  handleSessionRecord = (record: Session): void => {
    if (record.id !== this.sessionId || this.closed) return;
    const current = this.state.session;
    if (current === undefined || record.updated_at >= current.updated_at) {
      this.setState(setSessionRecord(this.state, record));
    }
  };

  async refreshPrompts(): Promise<void> {
    // Queue / prompt truth is projected from the canonical transcript.
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

  async loadOlderMessages(agentId: string = MAIN_AGENT_ID): Promise<boolean> {
    return this.loadOlderTranscript(agentId);
  }

  private async loadOlderTranscript(agentId: string): Promise<boolean> {
    if (!this.flushPendingTranscriptBatch(agentId)) return false;
    const store = this.ensureAgentTranscript(agentId);
    if (this.pendingTranscriptAgents.delete(agentId)) this.publishProjectedAgent(agentId, store);
    const currentSnapshot = this.composeAgentSnapshot(agentId);
    const beforeTurn = currentSnapshot.items.find((item) => item.kind === 'turn')?.turnId;
    if (this.closed || !currentSnapshot.hasMoreOlder || beforeTurn === undefined) return false;
    const inFlightKey = `${agentId}:${beforeTurn}`;
    if (this.inFlightOlder.get(agentId) === inFlightKey) return false;
    const generation = this.historyGeneration.get(agentId) ?? 0;
    this.inFlightOlder.set(agentId, inFlightKey);
    const loadingView = agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
    this.publishAgentView(agentId, setLoadingOlder(loadingView, true));
    try {
      const page = await this.view.transcript.page({
        agentId,
        beforeTurn,
        pageSize: 20,
      });
      if (
        this.closed ||
        this.agentTranscripts.get(agentId) !== store ||
        (this.historyGeneration.get(agentId) ?? 0) !== generation
      ) {
        return false;
      }
      if (this.flushPendingTranscriptBatch(agentId)) this.observeToolCount(agentId, page);
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
      const merged = prependOlderTranscriptSnapshot(this.olderPages.get(agentId) ?? emptyOlderSnapshot(), older);
      this.olderPages.set(agentId, merged);
      this.forestDirtyAgents.add(agentId);
      this.publishProjectedAgent(agentId, store, {
        loadingOlder: false,
        fetchedOlder: true,
        olderError: undefined,
      });
      return older.items.length > 0;
    } catch (error) {
      if (!this.closed && (this.historyGeneration.get(agentId) ?? 0) === generation) {
        const current =
          agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
        this.publishAgentView(
          agentId,
          setOlderError(current, errorMessage(error, 'Could not load earlier messages')),
        );
      }
      return false;
    } finally {
      if (this.inFlightOlder.get(agentId) === inFlightKey) this.inFlightOlder.delete(agentId);
    }
  }

  private applyTranscriptReset(
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    coverage: TranscriptCoverage,
    cursor: TranscriptCursor,
  ): void {
    this.pendingTranscriptBatches.delete(agentId);
    this.pendingTranscriptAgents.delete(agentId);
    this.catchupReplay.delete(agentId);
    const store = this.ensureAgentTranscript(agentId);
    this.bumpHistoryGeneration(agentId);
    if (coverage.kind === 'full') this.olderPages.delete(agentId);
    store.apply([{ op: 'reset', agentId, snapshot, coverage }]);
    this.transcriptCursors.set(agentId, cursor);
    this.viewHandle?.updateTranscriptCursor(agentId, cursor);
    this.forestDirtyAgents.add(agentId);
    this.publishProjectedAgent(agentId, store, {
      loadingOlder: false,
      olderError: undefined,
      retainPendingPrompts: true,
      transcriptReset: coverage.kind === 'full',
    });
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
    const result = store.apply(batch.ops);
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
    this.recordToolCountSpan(agentId, priorCursor, resumeCursor, result.toolCallCountDelta);
    this.transcriptCursors.set(agentId, resumeCursor);
    this.viewHandle?.updateTranscriptCursor(agentId, resumeCursor);
    const adoptedCount = this.adoptToolCountObservation(agentId);
    if (result.accepted.length > 0 || adoptedCount) {
      if (opsAffectForest(result.accepted)) this.forestDirtyAgents.add(agentId);
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
    const isCurrent = (): boolean => !this.closed &&
      (this.historyGeneration.get(agentId) ?? 0) === generation;
    try {
      const last = this.transcriptCursors.get(agentId) ?? { seq: 0 };
      const grade = gradeFor(this.transcriptGrades, agentId);
      const result = await this.view.transcript.catchUp({
        agentId,
        since: last,
        grade: grade === 'off' ? 'turn' : grade,
      });
      if (!isCurrent()) return;
      if (result.complete === false || (last.epoch !== undefined && result.epoch !== last.epoch)) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
      }
      const store = this.ensureAgentTranscript(agentId);
      const recoveredOps: TranscriptOperation[] = [];
      for (const batch of result.batches) {
        recoveredOps.push(...(batch.ops as readonly TranscriptOperation[]));
      }
      const recovered = store.apply(recoveredOps);
      if (recovered.gap !== undefined) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
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
        const retry = store.apply(pending.ops);
        if (retry.gap !== undefined) {
          await this.resync();
          return;
        }
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
    }
  }

  private bumpHistoryGeneration(agentId: string): void {
    this.historyGeneration.set(agentId, (this.historyGeneration.get(agentId) ?? 0) + 1);
    this.inFlightOlder.delete(agentId);
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
    return older === undefined ? live : prependOlderTranscriptSnapshot(live, older);
  }

  private publishProjectedAgent(
    agentId: string,
    _store: AgentTranscript,
    options?: Partial<Pick<SessionViewState, 'loadingOlder' | 'fetchedOlder' | 'olderError'>> & {
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
    const next = projectAgentTranscriptView(previous, agentId, snapshot, {
      retainPendingPrompts: options?.retainPendingPrompts,
    });
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
            olderError: options.olderError ?? next.olderError,
          };
    const forestChanged = this.forestDirtyAgents.delete(agentId) || this.publishedForest === undefined
      ? this.publishForest()
      : false;
    this.publishAgentView(agentId, projected);
    if (forestChanged && agentId !== MAIN_AGENT_ID) {
      this.setState({ ...this.state, version: this.state.version + 1 });
    }
  }

  private publishAgentView(agentId: string, next: SessionViewState): void {
    if (agentId === MAIN_AGENT_ID) {
      this.setState(next);
      return;
    }
    this.agentStates.set(agentId, next);
    this.dirtyAgents.add(agentId);
    this.publishAgents();
  }

  forestPublishCount = 0;

  private publishForest(): boolean {
    const snapshots = new Map<string, AgentTranscriptSnapshot>();
    for (const [agentId] of this.agentTranscripts) {
      snapshots.set(agentId, this.composeAgentSnapshot(agentId));
    }
    const previous = this.publishedForest;
    this.publishedForest = stabilizeAgentForest(previous, sessionAgentForestFromAgentSnapshots(snapshots, this.state.snapshotSubagents));
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
    model?: string;
    thinking?: string;
    permissionMode: PermissionMode;
    planMode?: boolean;
    /**
     * Session plan-gate pick (`plan_gate`): when set, every prompt of this
     * session pins the agent's gate; omit to keep the agent's current gate.
     */
    planGate?: PromptPlanGate;
    swarmMode?: boolean;
    goalObjective?: string;
    goalControl?: 'pause' | 'resume' | 'cancel';
    /**
     * Deferred-append timing for this message when it lands in the queue
     * (consumed only when the prompt actually parks; running prompts ignore
     * it). Defaults to the server-side `agent_idle` when omitted.
     */
    appendTiming?: DeferredAppendTiming;
  }): Promise<PromptSubmitResult> {
    assertSessionWritable(this.state);
    const content = input.content ?? [{ type: 'text' as const, text: input.text }];
    const result = await this.client.submitPrompt(this.sessionId, {
      content,
      profile: input.profile,
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode,
      swarm_mode: input.swarmMode,
      goal_objective:
        input.goalObjective !== undefined && input.goalObjective.trim() !== ''
          ? input.goalObjective.trim()
          : undefined,
      goal_control: input.goalControl,
      append_timing: input.appendTiming,
    });
    const projection = projectMessageContent(result.content);
    this.setState(
      appendLocalUserMessage(this.state, {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: projection.text === '' ? input.text : projection.text,
        createdAt: result.created_at,
        status: result.status,
        media: projection.media,
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
      thinking?: string;
      permissionMode?: PermissionMode;
      planMode?: boolean;
      planGate?: PromptPlanGate;
      swarmMode?: boolean;
    },
  ): Promise<void> {
    assertSessionWritable(this.state);
    await this.client.editMessage(this.sessionId, messageId, {
      content: input.content ?? [{ type: 'text', text: input.text }],
      expected_cursor: this.expectedCursor(),
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode === true ? true : undefined,
      swarm_mode: input.swarmMode === true ? true : undefined,
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
      thinking?: string;
      permissionMode?: PermissionMode;
      planMode?: boolean;
      planGate?: PromptPlanGate;
      swarmMode?: boolean;
    } = {},
  ): Promise<void> {
    assertSessionWritable(this.state);
    await this.client.regenerateMessage(this.sessionId, messageId, {
      expected_cursor: this.expectedCursor(),
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode === true ? true : undefined,
      swarm_mode: input.swarmMode === true ? true : undefined,
    });
    void this.resync({ rewrite: true });
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
    const promptId = this.state.activePromptId;
    if (promptId !== undefined) await this.abortPrompt(promptId);
  }

  async abortPrompt(promptId: string): Promise<void> {
    await this.client.abortPrompt(this.sessionId, promptId);
    await this.refreshPrompts();
  }

  async replaceQueued(promptId: string, text: string): Promise<void> {
    assertSessionWritable(this.state);
    const result = await this.client.replacePrompt(this.sessionId, promptId, {
      content: [{ type: 'text', text }],
    });
    const projection = projectMessageContent(result.content);
    this.setState(
      appendLocalUserMessage(this.state, {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: projection.text,
        createdAt: result.created_at,
        status: result.status,
        media: projection.media,
      }),
    );
  }

  async moveQueued(promptId: string, targetIndex: number): Promise<void> {
    assertSessionWritable(this.state);
    const result = await this.client.movePrompt(this.sessionId, promptId, {
      target_index: targetIndex,
    });
    this.setState({
      ...this.state,
      version: this.state.version + 1,
      queuedPromptIds: result.queued_prompt_ids,
    });
  }

  /**
   * Re-time a parked prompt (`POST …:timing`). Sends the last known scheduling
   * revision as `expected_revision` so a concurrent retime (another client,
   * the engine itself) fails with 40001 instead of silently winning; the
   * authoritative reply (and the trailing reconcile) repaints the strip.
   */
  async setQueuedTiming(promptId: string, appendTiming: DeferredAppendTiming): Promise<void> {
    assertSessionWritable(this.state);
    const expected = this.state.queuedPromptMeta[promptId]?.revision;
    const result = await this.client.timingPrompt(this.sessionId, promptId, {
      append_timing: appendTiming,
      expected_revision: expected,
    });
    this.setState({
      ...this.state,
      version: this.state.version + 1,
      queuedPromptMeta: {
        ...this.state.queuedPromptMeta,
        [promptId]: { appendTiming: result.append_timing ?? appendTiming, revision: result.revision },
      },
    });
  }

  /**
   * "Send now" for a parked prompt — a REAL wire capability, not a client
   * approximation: `POST …:steer` injects the queued prompt's content into
   * the currently running turn immediately, and the prompt leaves the queue
   * and settles with that turn. Throws PROMPT_NOT_FOUND when no turn is
   * active or the prompt already left the queue (the UI surfaces that as an
   * action error; the next reconcile repaints the strip).
   */
  async steerQueued(promptId: string): Promise<void> {
    assertSessionWritable(this.state);
    await this.client.steerPrompt(this.sessionId, promptId);
    await this.refreshPrompts();
  }

  /** Clear the whole queue: the wire has no bulk-remove route, so abort each
   * parked prompt; one reconcile at the end repaints the strip. Failed ids stay
   * queued so the user can retry. */
  async clearQueue(): Promise<{ total: number; failed: number }> {
    const ids = this.state.queuedPromptIds;
    if (ids.length === 0) return { total: 0, failed: 0 };
    const results = await Promise.allSettled(
      ids.map((promptId) => this.client.abortPrompt(this.sessionId, promptId)),
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
  ): Promise<void> {
    const resolvedAt = new Date().toISOString();
    try {
      await this.client.resolveApproval(this.sessionId, approvalId, {
        decision,
        scope,
        selected_option_id: selectedOptionId,
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

  async answerQuestion(questionId: string, answers: QuestionResponse['answers']): Promise<void> {
    const at = new Date().toISOString();
    try {
      await this.client.resolveQuestion(this.sessionId, questionId, { answers, method: 'click' });
      this.setState(markQuestionOutcome(this.state, questionId, { kind: 'answered', at }));
    } catch (error) {
      if (error instanceof ApiError && error.code === API_CODES.APPROVAL_ALREADY_RESOLVED) {
        this.setState(markQuestionOutcome(this.state, questionId, { kind: 'answered', at }));
        return;
      }
      if (error instanceof ApiError && error.code === API_CODES.QUESTION_EXPIRED) {
        this.setState(markQuestionOutcome(this.state, questionId, { kind: 'expired' }));
        return;
      }
      throw error;
    }
  }

  async dismissQuestion(questionId: string): Promise<void> {
    const at = new Date().toISOString();
    try {
      await this.client.dismissQuestion(this.sessionId, questionId);
      this.setState(markQuestionOutcome(this.state, questionId, { kind: 'dismissed', at }));
    } catch (error) {
      if (error instanceof ApiError && error.code === API_CODES.APPROVAL_ALREADY_RESOLVED) {
        this.setState(markQuestionOutcome(this.state, questionId, { kind: 'answered', at }));
        return;
      }
      if (error instanceof ApiError && error.code === API_CODES.QUESTION_EXPIRED) {
        this.setState(markQuestionOutcome(this.state, questionId, { kind: 'expired' }));
        return;
      }
      throw error;
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
      case 'items.remove':
        return true;
      default:
        return false;
    }
  });
}
