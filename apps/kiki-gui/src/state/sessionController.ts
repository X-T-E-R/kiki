/**
 * SessionController — owns one open session: snapshot load, WS event intake,
 * cursor bookkeeping, resync, and all user actions (prompt / abort / approvals
 * / questions / tasks). Plain class with subscribe/getState so React binds via
 * useSyncExternalStore; also directly unit-testable.
 */

import type {
  ApprovalDecision,
  ApprovalScope,
  PermissionMode,
  QuestionResponse,
  Session,
} from '@moonshot-ai/protocol';

import { API_CODES, ApiError, type KikiClient } from '../lib/client';
import type { ResyncRequiredPayload, SessionEventFrame } from '../lib/types';
import type { KikiSocket } from '../lib/ws';
import {
  applyFrame,
  applySnapshot,
  appendLocalUserMessage,
  markApprovalResolved,
  markQuestionOutcome,
  prependOlderMessages,
  setLoadingOlder,
  setResyncing,
  setSessionRecord,
  setTasks,
  type SessionViewState,
  createViewState,
} from './transcript';

export type Listener = () => void;

export class SessionController {
  private readonly client: KikiClient;
  private readonly socket: KikiSocket;
  readonly sessionId: string;
  private state: SessionViewState;
  private readonly listeners = new Set<Listener>();
  private resyncInFlight = false;
  private closed = false;

  constructor(client: KikiClient, socket: KikiSocket, sessionId: string) {
    this.client = client;
    this.socket = socket;
    this.sessionId = sessionId;
    this.state = createViewState(sessionId);
  }

  getState = (): SessionViewState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(next: SessionViewState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Initial sync: snapshot → subscribe from the watermark → tasks. */
  async open(): Promise<void> {
    const snapshot = await this.client.snapshot(this.sessionId);
    if (this.closed) return;
    this.setState(applySnapshot(this.sessionId, snapshot));
    this.socket.subscribe(this.sessionId, {
      seq: snapshot.as_of_seq,
      epoch: snapshot.epoch,
    });
    void this.refreshTasks();
  }

  close(): void {
    this.closed = true;
    this.socket.unsubscribe(this.sessionId);
  }

  handleFrame(frame: SessionEventFrame): void {
    if (this.closed || frame.session_id !== this.sessionId) return;
    const { state: next, gapDetected } = applyFrame(this.state, frame);
    if (frame.volatile !== true && next !== this.state) {
      this.socket.updateCursor(this.sessionId, next.cursor);
    }
    this.setState(next);
    if (gapDetected) void this.resync();
  }

  handleResyncRequired(payload: ResyncRequiredPayload): void {
    if (payload.session_id !== this.sessionId) return;
    void this.resync();
  }

  /** Full rebuild: fresh snapshot + resubscribe from the new watermark. */
  async resync(): Promise<void> {
    if (this.resyncInFlight || this.closed) return;
    this.resyncInFlight = true;
    this.setState(setResyncing(this.state, true));
    try {
      const snapshot = await this.client.snapshot(this.sessionId);
      if (this.closed) return;
      this.setState(setResyncing(applySnapshot(this.sessionId, snapshot), false));
      this.socket.subscribe(this.sessionId, {
        seq: snapshot.as_of_seq,
        epoch: snapshot.epoch,
      });
      void this.refreshTasks();
    } catch {
      if (!this.closed) this.setState(setResyncing(this.state, false));
    } finally {
      this.resyncInFlight = false;
    }
  }

  /** Merge a fresher session record from the list poll. */
  handleSessionRecord = (record: Session): void => {
    if (record.id !== this.sessionId || this.closed) return;
    const current = this.state.session;
    // The live event stream owns busy/pending while loaded; only adopt the
    // poll when it is at least as fresh as what we have.
    if (current === undefined || record.updated_at >= current.updated_at) {
      this.setState(setSessionRecord(this.state, record));
    }
  };

  async refreshTasks(): Promise<void> {
    try {
      const data = await this.client.listTasks(this.sessionId);
      if (!this.closed) this.setState(setTasks(this.state, data.items));
    } catch {
      // tasks rail is best-effort
    }
  }

  /**
   * Fetch one older history page and prepend it. Returns true when a page was
   * applied — the scroll layer uses that to re-anchor the viewport.
   */
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
    } catch {
      if (!this.closed) this.setState(setLoadingOlder(this.state, false));
      return false;
    }
  }

  async sendPrompt(input: {
    text: string;
    model?: string;
    thinking?: string;
    permissionMode: PermissionMode;
    planMode?: boolean;
  }): Promise<void> {
    const result = await this.client.submitPrompt(this.sessionId, {
      content: [{ type: 'text', text: input.text }],
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_mode: input.planMode === true ? true : undefined,
    });
    this.setState(
      appendLocalUserMessage(this.state, {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: input.text,
        createdAt: result.created_at,
        queued: result.status === 'queued',
      }),
    );
  }

  async abortActive(): Promise<void> {
    const promptId = this.state.activePromptId;
    if (promptId === undefined) return;
    // WS abort is fire-and-forget; REST is the reliable path.
    this.socket.abort(this.sessionId, promptId);
    try {
      await this.client.abortPrompt(this.sessionId, promptId);
    } catch {
      // prompt may have already completed — the event stream will settle state
    }
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
        this.setState(
          markApprovalResolved(this.state, approvalId, {
            decision: 'resolved_elsewhere',
            resolvedAt,
          }),
        );
        return;
      }
      if (error instanceof ApiError && error.code === API_CODES.APPROVAL_EXPIRED) {
        this.setState(
          markApprovalResolved(this.state, approvalId, { decision: 'expired', resolvedAt }),
        );
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
