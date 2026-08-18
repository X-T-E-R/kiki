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

import { API_CODES, ApiError, type KikiClient } from '../lib/client';
import { isInteractionEvent, type ResyncRequiredPayload, type SessionEventFrame } from '../lib/types';
import type { KikiSocket } from '../lib/ws';
import { FrameBuffer } from './framePipeline';
import {
  advanceSessionCursor,
  applyAgentFrame,
  applyFrame,
  applySnapshot,
  appendLocalUserMessage,
  createViewState,
  incrementSubagentToolCount,
  markApprovalResolved,
  markQuestionOutcome,
  prependOlderMessages,
  preserveCapturedSteers,
  preserveCapturedSubagents,
  reconcilePromptList,
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
  /** Stable empty fallback — useSyncExternalStore needs a cached snapshot. */
  private readonly emptyAgentState: SessionViewState;

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
    this.state = createViewState(sessionId);
    this.publishedState = this.state;
    this.emptyAgentState = createViewState(sessionId);
  }

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
      this.setState(applySnapshot(this.sessionId, snapshot, this.state));
      this.socket.subscribe(this.sessionId, { seq: snapshot.as_of_seq, epoch: snapshot.epoch });
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
    this.socket.unsubscribe(this.sessionId);
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  handleFrame(frame: SessionEventFrame): void {
    if (this.closed || frame.session_id !== this.sessionId) return;
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
    if (payload.session_id === this.sessionId) void this.resync();
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

  async resync(): Promise<void> {
    if (this.resyncInFlight || this.closed) return;
    this.resyncInFlight = true;
    this.clearResyncTimer();
    this.setState(setResyncing(this.state, true));
    let runAgain = false;
    try {
      const snapshot = await this.client.snapshot(this.sessionId);
      if (this.closed) return;
      const rebuilt = preserveCapturedSteers(
        preserveCapturedSubagents(applySnapshot(this.sessionId, snapshot, this.state), this.state),
        this.state,
      );
      this.setState(setResyncing(rebuilt, false));
      this.socket.subscribe(this.sessionId, { seq: snapshot.as_of_seq, epoch: snapshot.epoch });
      if (this.quarantineOverflowed) {
        this.pendingFrames.clear();
        this.quarantineOverflowed = false;
        runAgain = true;
      } else {
        this.replayPendingFrames(rebuilt.cursor.seq);
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
      if (runAgain && !this.closed) queueMicrotask(() => void this.resync());
    }
  }

  private replayPendingFrames(minSeq: number): void {
    const frames = this.pendingFrames.drain();
    let gap = false;
    for (const frame of frames) {
      if (frame.volatile === true || frame.seq <= minSeq) continue;
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
    try {
      const data = await this.client.listTasks(this.sessionId);
      if (!this.closed) this.setState(setTasks(this.state, data.items));
    } catch {
      // Optional rail data on older servers; explicit task actions still surface failures.
    }
  }

  async refreshGoal(): Promise<void> {
    try {
      const goal = await this.client.getSessionGoal(this.sessionId);
      if (!this.closed) this.setState(setGoal(this.state, goal));
    } catch {
      // Older servers may not expose the goal route; goal.updated remains authoritative.
    }
  }

  async loadOlderMessages(): Promise<boolean> {
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

  async sendPrompt(input: {
    text: string;
    /**
     * Full wire content override (mentions folded into the text part, images
     * as base64 parts). When omitted, a single text part carries `text`.
     */
    content?: MessageContent[];
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

  async abortActive(): Promise<void> {
    const promptId = this.state.activePromptId;
    if (promptId !== undefined) await this.abortPrompt(promptId);
  }

  async abortPrompt(promptId: string): Promise<void> {
    if (promptId === this.state.activePromptId) this.socket.abort(this.sessionId, promptId);
    await this.client.abortPrompt(this.sessionId, promptId);
    await this.refreshPrompts();
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
