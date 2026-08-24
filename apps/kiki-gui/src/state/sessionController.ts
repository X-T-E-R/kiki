/**
 * SessionController — one session's REST snapshot, ordered transcript intake,
 * publication scheduling, resync, and user actions. Canonical transcript ops
 * are applied immediately and projected to React at most once per flush.
 */

import type {
  ApprovalDecision,
  ApprovalScope,
  MessageContent,
  PermissionMode,
  QuestionResponse,
  Session,
} from '@moonshot-ai/protocol';
import {
  AgentTranscript,
  gradeFor,
  type AgentTranscriptSnapshot,
  type TranscriptCoverage,
  type TranscriptCursor,
  type TranscriptEvent,
  type TranscriptGradeSpec,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import { API_CODES, ApiError, type KikiClient, type SessionCursor } from '../lib/client';
import { isHistoryRewrittenEvent, type ResyncRequiredPayload, type SessionEventFrame } from '../lib/types';
import { DEFAULT_TRANSCRIPT_GRADES, transcriptGradesForFocus, type KikiSocket } from '../lib/ws';
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
import type { AgentForest } from './agentTree';

export type Listener = () => void;

export const RESYNC_PAUSED_ERROR = 'Session is resyncing; sending is paused';

export function assertSessionWritable(state: Pick<SessionViewState, 'resyncing' | 'resyncFailed'>): void {
  if (state.resyncing || state.resyncFailed) {
    throw new Error(RESYNC_PAUSED_ERROR);
  }
}

const RESYNC_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
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
  private readonly client: KikiClient;
  private readonly socket: KikiSocket;
  readonly sessionId: string;
  private state: SessionViewState;
  private publishedState: SessionViewState;
  private readonly listeners = new Set<Listener>();
  private readonly scheduler: PublicationScheduler;
  private readonly usesBrowserScheduler: boolean;
  private readonly visibilityDocument: VisibilityDocument | undefined;
  private frameHandle: unknown = null;
  private hiddenFrameTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncInFlight = false;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private readonly agentStates = new Map<string, SessionViewState>();
  private readonly publishedAgentStates = new Map<string, SessionViewState>();
  private readonly agentListeners = new Map<string, Set<Listener>>();
  private readonly dirtyAgents = new Set<string>();
  private readonly agentTranscripts = new Map<string, AgentTranscript>();
  private readonly olderPages = new Map<string, AgentTranscriptSnapshot>();
  private readonly transcriptCursors = new Map<string, TranscriptCursor>();
  private readonly pendingTranscriptAgents = new Set<string>();
  private readonly forestDirtyAgents = new Set<string>();
  private readonly historyGeneration = new Map<string, number>();
  private readonly inFlightOlder = new Map<string, string>();
  private readonly emptyAgentState: SessionViewState;
  private publishedForest: AgentForest | undefined;
  private transcriptGrades: TranscriptGradeSpec = DEFAULT_TRANSCRIPT_GRADES;
  private readonly catchupByAgent = new Map<string, Promise<void>>();
  private readonly catchupReplay = new Map<
    string,
    { readonly ops: readonly TranscriptOperation[]; readonly cursor: TranscriptCursor }
  >();

  constructor(
    client: KikiClient,
    socket: KikiSocket,
    sessionId: string,
    options: { scheduler?: PublicationScheduler } = {},
  ) {
    this.client = client;
    this.socket = socket;
    this.sessionId = sessionId;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.usesBrowserScheduler = options.scheduler === undefined;
    this.visibilityDocument = this.usesBrowserScheduler ? browserVisibilityDocument() : undefined;
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
    if (this.pendingTranscriptAgents.size > 0) this.scheduleFrameFlush();
  };

  getState = (): SessionViewState => this.publishedState;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getAgentState = (agentId: string): SessionViewState =>
    this.publishedAgentStates.get(agentId) ?? this.agentStates.get(agentId) ?? this.emptyAgentState;

  subscribeAgent = (agentId: string, listener: Listener): (() => void) => {
    const listeners = this.agentListeners.get(agentId) ?? new Set<Listener>();
    listeners.add(listener);
    this.agentListeners.set(agentId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.agentListeners.delete(agentId);
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
      const snapshot = await this.client.snapshot(this.sessionId);
      if (this.closed) return;
      this.setState(applyTranscriptShell(this.sessionId, snapshot, this.state));
      this.transcriptGrades = DEFAULT_TRANSCRIPT_GRADES;
      this.socket.subscribe(
        this.sessionId,
        { seq: snapshot.as_of_seq, epoch: snapshot.epoch },
        this.transcriptGrades,
      );
    } catch (error) {
      if (this.closed) return;
      this.setState(setLoadError(this.state, errorMessage(error, 'Could not load session')));
    }
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
    this.cancelVisibleFrameFlush();
    this.clearHiddenFrameTimer();
    this.pendingTranscriptAgents.clear();
    for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
    this.historyGeneration.clear();
    this.inFlightOlder.clear();
    if (this.state.loadingOlder || this.state.olderError !== undefined) {
      this.state = { ...this.state, loadingOlder: false, olderError: undefined };
    }
    this.socket.unsubscribe(this.sessionId);
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  handleTranscript(event: TranscriptEvent): void {
    if (this.closed || event.session_id !== this.sessionId) return;
    if (event.type === 'transcript.reset') {
      this.applyTranscriptReset(event.agent_id, event.snapshot, event.coverage, event.cursor);
      return;
    }
    this.applyTranscriptOps(event.agent_id, event.ops, event.cursor);
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
    this.socket.updateCursor(this.sessionId, { seq: cursor.seq, epoch: cursor.epoch });
  }

  setFocusedAgent(agentId: string | undefined): void {
    this.transcriptGrades = transcriptGradesForFocus(agentId);
    this.socket.setTranscriptGrades(this.sessionId, this.transcriptGrades);
  }

  handleFrame(frame: SessionEventFrame): void {
    if (this.closed || frame.session_id !== this.sessionId) return;
    if (typeof frame.seq === 'number' && frame.volatile !== true) {
      this.advanceSessionCursor({ seq: frame.seq, epoch: frame.epoch ?? this.state.cursor.epoch });
    }
    if (isHistoryRewrittenEvent(frame.payload)) {
      void this.resync({ rewrite: true });
    }
  }

  handleResyncRequired(payload: ResyncRequiredPayload): void {
    if (payload.session_id !== this.sessionId) return;
    void this.resync({ rewrite: payload.reason === 'history_rewritten' });
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
    if (this.closed || !this.droppedWithLiveWork) return;
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

  async resync(options: { rewrite?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    if (this.resyncInFlight) {
      if (options.rewrite === true) this.rewriteResyncQueued = true;
      return;
    }
    this.resyncInFlight = true;
    this.rewriteResyncQueued = false;
    this.clearResyncTimer();
    this.setState(setResyncing(this.state, true));
    let runAgain = false;
    try {
      const snapshot = await this.client.snapshot(this.sessionId);
      if (this.closed) return;
      for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
      this.transcriptCursors.clear();
      this.socket.clearTranscriptSince(this.sessionId);
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
      this.socket.subscribe(
        this.sessionId,
        { seq: snapshot.as_of_seq, epoch: snapshot.epoch },
        this.transcriptGrades,
      );
    } catch {
      if (!this.closed) {
        const attempt = this.state.resyncAttempt + 1;
        this.setState(setResyncFailed(setResyncing(this.state, false), true, attempt));
        this.scheduleResyncRetry();
      }
    } finally {
      this.resyncInFlight = false;
      if (this.rewriteResyncQueued && !this.closed) runAgain = true;
      if (runAgain && !this.closed) queueMicrotask(() => void this.resync());
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
    const store = this.ensureAgentTranscript(agentId);
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
      const page = await this.client.getAgentTranscript(this.sessionId, agentId, {
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
    const store = this.ensureAgentTranscript(agentId);
    this.bumpHistoryGeneration(agentId);
    if (coverage.kind === 'full') this.olderPages.delete(agentId);
    store.apply([{ op: 'reset', agentId, snapshot, coverage }]);
    this.transcriptCursors.set(agentId, cursor);
    this.socket.updateTranscriptSince(this.sessionId, agentId, cursor);
    this.forestDirtyAgents.add(agentId);
    this.publishProjectedAgent(agentId, store, {
      loadingOlder: false,
      olderError: undefined,
      retainPendingPrompts: true,
    });
  }

  private applyTranscriptOps(
    agentId: string,
    ops: readonly TranscriptOperation[],
    cursor: TranscriptCursor,
  ): void {
    const last = this.transcriptCursors.get(agentId);
    if (last?.epoch !== undefined && cursor.epoch !== undefined && cursor.epoch !== last.epoch) {
      void this.resync();
      return;
    }
    const store = this.ensureAgentTranscript(agentId);
    const result = store.apply(ops);
    if (result.gap !== undefined) {
      const pending = this.catchupReplay.get(agentId);
      this.catchupReplay.set(agentId, {
        ops: pending === undefined ? ops : [...pending.ops, ...ops],
        cursor: pending === undefined || cursor.seq >= pending.cursor.seq ? cursor : pending.cursor,
      });
      void this.catchUpAgent(agentId);
      return;
    }
    this.transcriptCursors.set(agentId, cursor);
    this.socket.updateTranscriptSince(this.sessionId, agentId, cursor);
    if (opsAffectForest(ops)) this.forestDirtyAgents.add(agentId);
    this.pendingTranscriptAgents.add(agentId);
    this.scheduleFrameFlush();
  }

  private catchUpAgent(agentId: string): Promise<void> {
    const inFlight = this.catchupByAgent.get(agentId);
    if (inFlight !== undefined) return inFlight;
    const run = this.runCatchUpAgent(agentId).finally(() => {
      if (this.catchupByAgent.get(agentId) === run) this.catchupByAgent.delete(agentId);
    });
    this.catchupByAgent.set(agentId, run);
    return run;
  }

  private async runCatchUpAgent(agentId: string): Promise<void> {
    if (this.closed) return;
    try {
      const last = this.transcriptCursors.get(agentId) ?? { seq: 0 };
      const grade = gradeFor(this.transcriptGrades, agentId);
      const result = await this.client.getTranscriptOps(
        this.sessionId,
        agentId,
        last,
        grade === 'off' ? 'turn' : grade,
      );
      if (this.closed) return;
      if (result.complete === false || (last.epoch !== undefined && result.epoch !== last.epoch)) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
      }
      const store = this.ensureAgentTranscript(agentId);
      for (const batch of result.batches) {
        const ops = batch.ops as readonly TranscriptOperation[];
        store.apply(ops);
        if (opsAffectForest(ops)) this.forestDirtyAgents.add(agentId);
      }
      let cursor: TranscriptCursor = { seq: result.through_seq, epoch: result.epoch };
      const live = this.transcriptCursors.get(agentId);
      if (live !== undefined && live.epoch === result.epoch && live.seq > cursor.seq) {
        cursor = live;
      }
      const pending = this.catchupReplay.get(agentId);
      this.catchupReplay.delete(agentId);
      if (pending !== undefined) {
        const retry = store.apply(pending.ops);
        if (retry.gap === undefined && pending.cursor.seq > cursor.seq) {
          cursor = pending.cursor;
        }
        if (opsAffectForest(pending.ops)) this.forestDirtyAgents.add(agentId);
      }
      this.transcriptCursors.set(agentId, cursor);
      this.socket.updateTranscriptSince(this.sessionId, agentId, cursor);
      this.pendingTranscriptAgents.add(agentId);
      this.scheduleFrameFlush();
    } catch {
      this.catchupReplay.delete(agentId);
      if (!this.closed) await this.resync();
    }
  }

  private bumpHistoryGeneration(agentId: string): void {
    this.historyGeneration.set(agentId, (this.historyGeneration.get(agentId) ?? 0) + 1);
    this.inFlightOlder.delete(agentId);
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
    },
  ): void {
    const snapshot = this.composeAgentSnapshot(agentId);
    const previous =
      agentId === MAIN_AGENT_ID ? this.state : this.agentStates.get(agentId) ?? this.emptyAgentState;
    const next = projectAgentTranscriptView(previous, agentId, snapshot, {
      retainPendingPrompts: options?.retainPendingPrompts,
    });
    const projected =
      options === undefined
        ? next
        : {
            ...next,
            loadingOlder: options.loadingOlder ?? next.loadingOlder,
            fetchedOlder: options.fetchedOlder ?? next.fetchedOlder,
            olderError: options.olderError ?? next.olderError,
          };
    this.publishAgentView(agentId, projected);
    if (this.forestDirtyAgents.delete(agentId) || this.publishedForest === undefined) {
      this.publishForest();
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

  private publishForest(): void {
    const snapshots = new Map<string, AgentTranscriptSnapshot>();
    for (const [agentId] of this.agentTranscripts) {
      snapshots.set(agentId, this.composeAgentSnapshot(agentId));
    }
    this.publishedForest = sessionAgentForestFromAgentSnapshots(snapshots);
    this.forestPublishCount += 1;
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
    swarmMode?: boolean;
    goalObjective?: string;
    goalControl?: 'pause' | 'resume' | 'cancel';
  }): Promise<void> {
    assertSessionWritable(this.state);
    const content = input.content ?? [{ type: 'text' as const, text: input.text }];
    const result = await this.client.submitPrompt(this.sessionId, {
      content,
      profile: input.profile,
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_mode: input.planMode === true ? true : undefined,
      swarm_mode: input.swarmMode === true ? true : undefined,
      goal_objective:
        input.goalObjective !== undefined && input.goalObjective.trim() !== ''
          ? input.goalObjective.trim()
          : undefined,
      goal_control: input.goalControl,
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
      }),
    );
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
      swarmMode?: boolean;
    } = {},
  ): Promise<void> {
    assertSessionWritable(this.state);
    await this.client.regenerateMessage(this.sessionId, messageId, {
      expected_cursor: this.expectedCursor(),
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
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
    if (promptId === this.state.activePromptId) this.socket.abort(this.sessionId, promptId);
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
  ): Promise<void> {
    const resolvedAt = new Date().toISOString();
    try {
      await this.client.resolveApproval(this.sessionId, approvalId, { decision, scope });
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
      case 'task.upsert':
      case 'meta.merge':
      case 'turn.upsert':
      case 'step.upsert':
        return true;
      case 'frame.upsert':
        return op.frame.kind === 'tool' && op.frame.agentRefs !== undefined && op.frame.agentRefs.length > 0;
      default:
        return false;
    }
  });
}
