/**
 * SessionController — one session's REST snapshot, ordered WS intake, bounded
 * resync quarantine, and user actions. Wire frames are coalesced and reduced on
 * an animation-frame cadence, with a microtask fast path for visible thinking;
 * React sees at most one publication per flush.
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
  type AgentTranscriptSnapshot,
  type TranscriptEvent,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import { API_CODES, ApiError, type KikiClient, type SessionCursor } from '../lib/client';
import { isHistoryRewrittenEvent, isInteractionEvent, type ResyncRequiredPayload, type SessionEventFrame } from '../lib/types';
import { DEFAULT_TRANSCRIPT_GRADES, type KikiSocket } from '../lib/ws';
import { FrameBuffer } from './framePipeline';
import {
  MAIN_AGENT_ID,
  advanceSessionCursor,
  applyAgentFrame,
  applyFrame,
  applySnapshot,
  applyTranscriptShell,
  appendLocalUserMessage,
  createViewState,
  incrementSubagentToolCount,
  markApprovalResolved,
  markQuestionOutcome,
  prependOlderMessages,
  prependOlderTranscriptSnapshot,
  preserveCapturedSteers,
  preserveCapturedSubagents,
  projectAgentTranscriptView,
  projectMessageContent,
  reconcilePromptList,
  sessionAgentForestFromAgentSnapshots,
  setGoal,
  setLoadError,
  setLoadingOlder,
  setOlderError,
  setResyncFailed,
  setResyncing,
  setSessionRecord,
  setTasks,
  type SessionViewState,
} from './transcript';
import type { AgentForest } from './agentTree';

export type Listener = () => void;

export const RESYNC_PAUSED_ERROR = 'Session is resyncing; sending is paused';

export function assertSessionWritable(state: Pick<SessionViewState, 'resyncing' | 'resyncFailed'>): void {
  if (state.resyncing || state.resyncFailed) {
    throw new Error(RESYNC_PAUSED_ERROR);
  }
}

const RESYNC_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
const QUARANTINE_MAX_FRAMES = 1000;
const QUARANTINE_MAX_BYTES = 2 * 1024 * 1024;
/** Frames applied per flush tick. Restoring a hidden tab can hold the full
 * inbound bound; applying it in one synchronous pass would freeze the frame. */
const FLUSH_CHUNK_FRAMES = 200;

export interface PublicationScheduler {
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
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

function childAgentId(frame: SessionEventFrame): string | undefined {
  const agentId = (frame.payload as { agentId?: string }).agentId;
  if (agentId === undefined || agentId === 'main' || frame.payload.type.startsWith('subagent.')) {
    return undefined;
  }
  return agentId;
}

function isVisibleThinkingDelta(frame: SessionEventFrame): boolean {
  if (frame.payload.type !== 'thinking.delta') return false;
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
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
  private frameHandle: unknown = null;
  /** One microtask per JS turn keeps reasoning visibly incremental without
   * publishing once per frame in a synchronous high-frequency burst. */
  private thinkingFlushQueued = false;
  /** Hidden-tab intake: while the document is hidden rAF never fires, so this
   * buffer carries the whole blackout. Bounded by the quarantine limits —
   * overflow drops the buffer and resyncs instead of growing without cap. */
  private readonly inboundFrames = new FrameBuffer({
    maxFrames: QUARANTINE_MAX_FRAMES,
    maxBytes: QUARANTINE_MAX_BYTES,
  });
  private readonly pendingFrames = new FrameBuffer({
    maxFrames: QUARANTINE_MAX_FRAMES,
    maxBytes: QUARANTINE_MAX_BYTES,
  });
  private quarantineOverflowed = false;
  private resyncInFlight = false;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private promptRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic refresh counter: only the newest GET /prompts response may
   * reconcile — an older response landing late must not clobber newer truth. */
  private promptRefreshSeq = 0;
  private closed = false;

  private readonly agentStates = new Map<string, SessionViewState>();
  private readonly publishedAgentStates = new Map<string, SessionViewState>();
  private readonly agentListeners = new Map<string, Set<Listener>>();
  private readonly dirtyAgents = new Set<string>();
  private readonly childToolCalls = new Map<string, Set<string>>();
  private readonly agentTranscripts = new Map<string, AgentTranscript>();
  private readonly olderPages = new Map<string, AgentTranscriptSnapshot>();
  private readonly transcriptSeq = new Map<string, number>();
  private readonly pendingTranscriptAgents = new Set<string>();
  private readonly forestDirtyAgents = new Set<string>();
  private readonly historyGeneration = new Map<string, number>();
  private readonly inFlightOlder = new Map<string, string>();
  private readonly transcriptMode: boolean;
  /** Stable empty fallback — useSyncExternalStore needs a cached snapshot. */
  private readonly emptyAgentState: SessionViewState;
  private publishedForest: AgentForest | undefined;

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
    this.transcriptMode = socket.timelineMode === 'transcript';
    this.state = createViewState(sessionId);
    this.publishedState = this.state;
    this.emptyAgentState = createViewState(sessionId);
  }

  get timelineMode(): 'transcript' | 'legacy' {
    return this.transcriptMode ? 'transcript' : 'legacy';
  }

  getForest = (): AgentForest | undefined => this.publishedForest;

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

  private scheduleFrameFlush(): void {
    if (this.frameHandle !== null || this.closed) return;
    this.frameHandle = this.scheduler.schedule(() => {
      this.frameHandle = null;
      this.flushFrames();
    });
  }

  private scheduleThinkingFlush(): void {
    if (this.thinkingFlushQueued || this.closed) return;
    this.thinkingFlushQueued = true;
    queueMicrotask(() => {
      this.thinkingFlushQueued = false;
      if (this.closed) return;
      if (this.frameHandle !== null) {
        this.scheduler.cancel(this.frameHandle);
        this.frameHandle = null;
      }
      this.flushFrames();
    });
  }

  /** Public test seam and fallback for environments without an actual rAF. */
  flushFrames = (): void => {
    if (this.closed) return;
    if (this.transcriptMode && this.pendingTranscriptAgents.size > 0) {
      const agents = [...this.pendingTranscriptAgents];
      this.pendingTranscriptAgents.clear();
      for (const agentId of agents) {
        const store = this.agentTranscripts.get(agentId);
        if (store !== undefined) this.publishProjectedAgent(agentId, store);
      }
    }
    const frames = this.inboundFrames.drain();
    if (frames.length === 0) return;
    const batch =
      frames.length > FLUSH_CHUNK_FRAMES ? frames.slice(0, FLUSH_CHUNK_FRAMES) : frames;
    const before = this.state;
    for (const frame of batch) this.applyIncomingFrame(frame);
    if (this.state !== before) this.notifyMain();
    this.publishAgents();
    if (batch.length < frames.length) {
      // Keep the remainder in wire order and keep flushing on the next tick —
      // the publication cadence stays at most one per tick.
      for (const frame of frames.slice(FLUSH_CHUNK_FRAMES)) this.inboundFrames.push(frame);
      this.scheduleFrameFlush();
    }
  };

  /** Initial sync: snapshot → subscribe watermark → queue/tasks/goal hydration. */
  async open(): Promise<void> {
    try {
      const snapshot = await this.client.snapshot(this.sessionId);
      if (this.closed) return;
      if (this.transcriptMode) {
        this.setState(applyTranscriptShell(this.sessionId, snapshot, this.state));
        this.socket.subscribe(
          this.sessionId,
          { seq: snapshot.as_of_seq, epoch: snapshot.epoch },
          DEFAULT_TRANSCRIPT_GRADES,
        );
      } else {
        this.setState(applySnapshot(this.sessionId, snapshot, this.state));
        this.socket.subscribe(this.sessionId, { seq: snapshot.as_of_seq, epoch: snapshot.epoch });
      }
      await Promise.allSettled([this.refreshPrompts(), this.refreshTasks(), this.refreshGoal()]);
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
    this.clearResyncTimer();
    if (this.promptRefreshTimer !== null) clearTimeout(this.promptRefreshTimer);
    if (this.frameHandle !== null) this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
    this.inboundFrames.clear();
    this.pendingFrames.clear();
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
    if (this.closed || !this.transcriptMode) return;
    if (event.type === 'transcript.reset') {
      this.applyTranscriptReset(event.agent_id, event.snapshot, event.seq);
      return;
    }
    this.applyTranscriptOps(event.agent_id, event.ops, event.seq);
  }

  setFocusedAgent(agentId: string | undefined): void {
    if (!this.transcriptMode) return;
    const grades =
      agentId === undefined || agentId === MAIN_AGENT_ID
        ? DEFAULT_TRANSCRIPT_GRADES
        : { '*': 'turn' as const, main: 'delta' as const, [agentId]: 'delta' as const };
    this.socket.setTranscriptGrades(this.sessionId, grades);
  }

  handleFrame(frame: SessionEventFrame): void {
    if (this.closed || frame.session_id !== this.sessionId) return;
    if (this.transcriptMode && isLegacyTimelineFrame(frame)) return;
    // A rewrite invalidates every cached block from the target onward; the
    // frame itself carries no incremental payload, so skip the pipeline and
    // rebuild from a snapshot (quarantine covers frames already in flight).
    if (isHistoryRewrittenEvent(frame.payload)) {
      void this.resync({ rewrite: true });
      return;
    }
    if (this.state.resyncing || this.state.resyncFailed) {
      if (!this.quarantineOverflowed && this.pendingFrames.push(frame).overflowed) {
        this.quarantineOverflowed = true;
      }
      return;
    }
    if (this.inboundFrames.push(frame).overflowed) {
      // The hidden blackout exceeded the inbound bound (push already dropped
      // the buffer): resync from a snapshot rather than apply a stream with
      // guaranteed holes.
      void this.resync();
      return;
    }
    if (isVisibleThinkingDelta(frame)) this.scheduleThinkingFlush();
    else this.scheduleFrameFlush();
  }

  private applyIncomingFrame(frame: SessionEventFrame): void {
    const agentId = childAgentId(frame);
    if (agentId !== undefined) {
      const current = this.agentStates.get(agentId) ?? this.emptyAgentState;
      const result = applyAgentFrame(current, frame);
      this.agentStates.set(agentId, result.state);
      this.dirtyAgents.add(agentId);

      // Interaction events are session-scoped: a subagent's approval/question
      // must ALSO land in the main transcript as an actionable card (tagged
      // with its origin by the reducer) — otherwise it hangs to expiry.
      if (isInteractionEvent(frame.payload)) {
        const mainResult = applyFrame(this.state, frame);
        this.state = mainResult.state;
        if (frame.volatile !== true && mainResult.state.cursor.seq >= frame.seq) {
          this.socket.updateCursor(this.sessionId, mainResult.state.cursor);
        }
        if (result.gapDetected || mainResult.gapDetected) void this.resync();
        return;
      }

      if (frame.payload.type === 'tool.call.started') {
        const toolCallId = (frame.payload as { toolCallId?: string }).toolCallId;
        const seen = this.childToolCalls.get(agentId) ?? new Set<string>();
        if (toolCallId !== undefined && !seen.has(toolCallId)) {
          seen.add(toolCallId);
          this.childToolCalls.set(agentId, seen);
          this.state = incrementSubagentToolCount(this.state, agentId, frame.timestamp);
        }
      }
      const advanced = advanceSessionCursor(this.state, frame);
      if (advanced !== this.state) {
        this.state = advanced;
        this.socket.updateCursor(this.sessionId, advanced.cursor);
      }
      if (result.gapDetected) void this.resync();
      return;
    }

    const result = applyFrame(this.state, frame);
    this.state = result.state;
    if (frame.volatile !== true && result.state.cursor.seq >= frame.seq) {
      this.socket.updateCursor(this.sessionId, result.state.cursor);
    }
    if (
      frame.payload.type.startsWith('prompt.') ||
      frame.payload.type === 'turn.started' ||
      frame.payload.type === 'turn.ended'
    ) {
      this.schedulePromptRefresh();
    }
    if (result.gapDetected) void this.resync();
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
    void this.resync();
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
    const rewrite = options.rewrite === true || this.rewriteResyncQueued;
    this.rewriteResyncQueued = false;
    this.clearResyncTimer();
    this.setState(setResyncing(this.state, true));
    let runAgain = false;
    try {
      const snapshot = await this.client.snapshot(this.sessionId);
      if (this.closed) return;
      if (this.transcriptMode) {
        for (const agentId of this.agentTranscripts.keys()) this.bumpHistoryGeneration(agentId);
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
          DEFAULT_TRANSCRIPT_GRADES,
        );
      } else {
        const rebuilt = preserveCapturedSteers(
          preserveCapturedSubagents(
            applySnapshot(this.sessionId, snapshot, this.state),
            this.state,
            { orphanMissing: rewrite },
          ),
          this.state,
        );
        this.setState(setResyncing(rebuilt, false));
        this.socket.subscribe(this.sessionId, { seq: snapshot.as_of_seq, epoch: snapshot.epoch });
      }
      if (this.quarantineOverflowed) {
        this.pendingFrames.clear();
        this.quarantineOverflowed = false;
        runAgain = true;
      } else if (!this.transcriptMode) {
        this.replayPendingFrames(this.state.cursor.seq);
        // Volatile deltas quarantined during the resync are dropped on replay
        // by design. A turn that started AND settled inside the resync window
        // (rewrites rerun fast) leaves a hole only the journal can fill: once
        // idle, run one more resync so the snapshot picks up the committed
        // content. Converges because the follow-up quarantines no volatiles.
        if (this.droppedVolatileInReplay && !this.state.busy) runAgain = true;
        this.droppedVolatileInReplay = false;
      }
      await Promise.allSettled([this.refreshPrompts(), this.refreshTasks(), this.refreshGoal()]);
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

  private droppedVolatileInReplay = false;

  private replayPendingFrames(minSeq: number): void {
    const frames = this.pendingFrames.drain();
    let gap = false;
    for (const frame of frames) {
      if (frame.volatile === true) {
        this.droppedVolatileInReplay = true;
        continue;
      }
      if (frame.seq <= minSeq) continue;
      const before = this.state;
      this.applyIncomingFrame(frame);
      if (this.state === before && frame.seq > this.state.cursor.seq) gap = true;
    }
    this.notifyMain();
    this.publishAgents();
    if (gap) void this.resync();
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

  private schedulePromptRefresh(): void {
    if (this.closed || this.promptRefreshTimer !== null) return;
    this.promptRefreshTimer = setTimeout(() => {
      this.promptRefreshTimer = null;
      void this.refreshPrompts();
    }, 60);
  }

  handleSessionRecord = (record: Session): void => {
    if (record.id !== this.sessionId || this.closed) return;
    const current = this.state.session;
    if (current === undefined || record.updated_at >= current.updated_at) {
      this.setState(setSessionRecord(this.state, record));
    }
  };

  async refreshPrompts(): Promise<void> {
    if (this.transcriptMode) return;
    const seq = (this.promptRefreshSeq += 1);
    try {
      const prompts = await this.client.listPrompts(this.sessionId);
      if (!this.closed && seq === this.promptRefreshSeq) {
        this.setState(reconcilePromptList(this.state, prompts));
      }
    } catch {
      // The queue view is best-effort; prompt.* frames and the submit result
      // remain authoritative when this route is unavailable.
    }
  }

  async refreshTasks(): Promise<void> {
    if (this.transcriptMode) return;
    try {
      const data = await this.client.listTasks(this.sessionId);
      if (!this.closed) this.setState(setTasks(this.state, data.items));
    } catch {
      // Optional rail data on older servers; explicit task actions still surface failures.
    }
  }

  async refreshGoal(): Promise<void> {
    if (this.transcriptMode) return;
    try {
      const goal = await this.client.getSessionGoal(this.sessionId);
      if (!this.closed) this.setState(setGoal(this.state, goal));
    } catch {
      // Older servers may not expose the goal route; goal.updated remains authoritative.
    }
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
    if (this.transcriptMode) return this.loadOlderTranscript(agentId);
    const current = this.state;
    if (
      this.closed ||
      !current.loaded ||
      !current.hasMoreHistory ||
      current.loadingOlder ||
      current.oldestMessageId === undefined
    ) {
      return false;
    }
    this.setState(setLoadingOlder(current, true));
    try {
      const page = await this.client.listMessages(this.sessionId, {
        before_id: current.oldestMessageId,
        page_size: 50,
      });
      if (this.closed) return false;
      this.setState(prependOlderMessages(this.state, page.items, page.has_more));
      return page.items.length > 0;
    } catch (error) {
      if (!this.closed) {
        this.setState(setOlderError(this.state, errorMessage(error, 'Could not load earlier messages')));
      }
      return false;
    }
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
    seq?: number,
  ): void {
    const store = this.ensureAgentTranscript(agentId);
    this.bumpHistoryGeneration(agentId);
    this.olderPages.delete(agentId);
    store.apply([{ op: 'reset', agentId, snapshot }]);
    if (seq !== undefined) this.transcriptSeq.set(agentId, seq);
    this.forestDirtyAgents.add(agentId);
    this.publishProjectedAgent(agentId, store, {
      loadingOlder: false,
      olderError: undefined,
      retainPendingPrompts: false,
    });
  }

  private applyTranscriptOps(
    agentId: string,
    ops: readonly TranscriptOperation[],
    seq?: number,
  ): void {
    const store = this.ensureAgentTranscript(agentId);
    const last = this.transcriptSeq.get(agentId);
    if (seq !== undefined && last !== undefined && seq > last + 1) {
      this.socket.restartGeneration();
      return;
    }
    const result = store.apply(ops);
    if (result.gap !== undefined) {
      this.socket.restartGeneration();
      return;
    }
    if (seq !== undefined) this.transcriptSeq.set(agentId, seq);
    if (opsAffectForest(ops)) this.forestDirtyAgents.add(agentId);
    this.pendingTranscriptAgents.add(agentId);
    this.scheduleFrameFlush();
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
    const result = await this.client.submitPrompt(this.sessionId, {
      content: input.content ?? [{ type: 'text', text: input.text }],
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
    this.setState(
      appendLocalUserMessage(this.state, {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: input.text,
        createdAt: result.created_at,
        status: result.status,
      }),
    );
    this.schedulePromptRefresh();
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
    this.schedulePromptRefresh();
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
    this.schedulePromptRefresh();
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
    this.schedulePromptRefresh();
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

function emptyOlderSnapshot(): AgentTranscriptSnapshot {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
  };
}

const LEGACY_TIMELINE_EVENT_PREFIXES = [
  'assistant.',
  'thinking.',
  'tool.',
  'turn.',
  'prompt.',
  'subagent.',
  'shell.',
] as const;

function isLegacyTimelineFrame(frame: SessionEventFrame): boolean {
  const type = frame.payload.type;
  return LEGACY_TIMELINE_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
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
