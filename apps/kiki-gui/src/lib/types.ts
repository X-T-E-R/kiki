/**
 * Wire types that the kap-server broadcaster emits but
 * `@moonshot-ai/protocol` does not export as named TS types:
 *
 *   - the `session_event` WS envelope (`wsEventEnvelopeSchema(eventSchema)`)
 *   - interaction events (`event.approval.*` / `event.question.*`), which the
 *     v1 broadcaster synthesizes via `as unknown as Event` casts
 *     (packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts)
 *   - the server→client system frames we handle
 *
 * Everything else (Session, Message, ApprovalRequest, …) is imported straight
 * from `@moonshot-ai/protocol`; these shapes reuse those base types.
 */

import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalScope,
  QuestionRequest,
} from '@moonshot-ai/protocol';

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

/** Any payload that can ride a `session_event` frame. */
export type SessionEventPayload = AgentEvent | InteractionEvent;

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
  readonly reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed';
  readonly current_seq: number;
  readonly epoch?: string;
}

export function isInteractionEvent(payload: SessionEventPayload): payload is InteractionEvent {
  return payload.type.startsWith('event.approval.') || payload.type.startsWith('event.question.');
}
