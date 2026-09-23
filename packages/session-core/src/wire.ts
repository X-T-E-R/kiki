/**
 * Wire types that the kap-server broadcaster emits but
 * `@kiki/protocol` does not export as named TS types:
 *
 *   - the `session_event` WS envelope (`wsEventEnvelopeSchema(eventSchema)`)
 *   - interaction events (`event.approval.*` / `event.question.*`), which the
 *     v1 broadcaster synthesizes via `as unknown as Event` casts
 *     (packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts)
 *   - the server→client system frames we handle
 *
 * Everything else (Session, Message, ApprovalRequest, …) is imported straight
 * from `@kiki/protocol`; these shapes reuse those base types.
 */

import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalScope,
  QuestionRequest,
} from '@kiki/protocol';

/** `event.approval.requested` payload = ApprovalRequest + agent routing. */
export interface ApprovalRequestedEvent extends ApprovalRequest {
  readonly type: 'event.approval.requested';
  readonly agentId: string;
  readonly sessionId: string;
}

/** `event.approval.resolved` payload (any client may have resolved it). */
export interface ApprovalResolvedEvent {
  readonly type: 'event.approval.resolved';
  readonly agentId: string;
  readonly sessionId: string;
  readonly approval_id: string;
  readonly decision?: ApprovalDecision;
  readonly scope?: ApprovalScope;
  readonly feedback?: string;
  readonly selected_label?: string;
  readonly resolved_at: string;
}

/** `event.question.requested` payload = QuestionRequest + agent routing. */
export interface QuestionRequestedEvent extends QuestionRequest {
  readonly type: 'event.question.requested';
  readonly agentId: string;
  readonly sessionId: string;
}

export interface QuestionAnsweredEvent {
  readonly type: 'event.question.answered';
  readonly agentId: string;
  readonly sessionId: string;
  readonly question_id: string;
  readonly answers: unknown;
  readonly resolved_at: string;
}

export interface QuestionDismissedEvent {
  readonly type: 'event.question.dismissed';
  readonly agentId: string;
  readonly sessionId: string;
  readonly question_id: string;
  readonly dismissed_at: string;
}

export type InteractionEvent =
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | QuestionRequestedEvent
  | QuestionAnsweredEvent
  | QuestionDismissedEvent;

/**
 * `event.session.history_rewritten` — durable signal that the journal was
 * truncated and rebuilt (edit-resend / regenerate). The payload is only a
 * notice; the controller reacts with a snapshot resync, so the fields are
 * informational (toast / orphan marking) rather than applied incrementally.
 */
export interface HistoryRewrittenEvent {
  readonly type: 'event.session.history_rewritten';
  readonly reason: 'edit_resend' | 'regenerate';
  readonly target_message_id: string;
  readonly agentId?: string;
  readonly sessionId?: string;
}

export interface WireTokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface ContextBreakdown {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messagesTokens: number;
  readonly estimated: true;
}

type ExtendedAgentEvent =
  | Exclude<AgentEvent, { type: 'turn.ended' | 'agent.status.updated' }>
  | (Extract<AgentEvent, { type: 'turn.ended' }> & {
      readonly usage?: WireTokenUsage;
      readonly tokensPerSecond?: number;
    })
  | (Extract<AgentEvent, { type: 'agent.status.updated' }> & {
      readonly contextBreakdown?: ContextBreakdown;
    });

/** Any payload that can ride a `session_event` frame. */
export type SessionEventPayload = ExtendedAgentEvent | InteractionEvent | HistoryRewrittenEvent;

/**
 * The WS `session_event` envelope: frame `type` mirrors the payload event
 * type; `seq` only advances on durable events; volatile text deltas carry the
 * cumulative `offset` used for gap detection.
 */
export interface SessionEventFrame {
  readonly type: string;
  readonly seq: number;
  readonly epoch?: string;
  readonly volatile?: boolean;
  readonly offset?: number;
  readonly session_id?: string;
  readonly timestamp: string;
  readonly payload: SessionEventPayload;
}

/** `resync_required` system frame payload. */
export interface ResyncRequiredPayload {
  readonly session_id: string;
  readonly reason:
    | 'buffer_overflow'
    | 'session_recreated'
    | 'epoch_changed'
    | 'history_rewritten'
    | 'journal_gap';
  readonly current_seq: number;
  readonly epoch?: string;
}

export function isHistoryRewrittenEvent(payload: SessionEventPayload): payload is HistoryRewrittenEvent {
  return payload.type === 'event.session.history_rewritten';
}

export function isInteractionEvent(payload: SessionEventPayload): payload is InteractionEvent {
  return payload.type.startsWith('event.approval.') || payload.type.startsWith('event.question.');
}
