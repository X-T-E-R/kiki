import type { InteractionId } from './ids';
import type { TranscriptAnchor } from './identity';

export type InteractionKind = 'approval' | 'question';

export type InteractionState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'answered'
  | 'dismissed';

export type InteractionEndState = Exclude<InteractionState, 'pending'>;
export type ApprovalInteractionEndState = Extract<
  InteractionEndState,
  'approved' | 'rejected' | 'cancelled'
>;

export function isInteractionCancellationSentinel(
  response: unknown,
): response is null | { readonly cancelled: true } {
  if (response === null) return true;
  if (typeof response !== 'object' || !Object.hasOwn(response, 'cancelled')) return false;
  return (response as { readonly cancelled: unknown }).cancelled === true;
}

export function readApprovalInteractionDecision(
  response: unknown,
): ApprovalInteractionEndState | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const decision = (response as { readonly decision?: unknown }).decision;
  return decision === 'approved' || decision === 'rejected' || decision === 'cancelled'
    ? decision
    : undefined;
}

export function projectInteractionEndState(
  kind: InteractionKind,
  response: unknown,
): InteractionEndState {
  if (kind === 'question') {
    return isInteractionCancellationSentinel(response) ? 'dismissed' : 'answered';
  }
  return readApprovalInteractionDecision(response) ?? 'cancelled';
}

export interface TranscriptInteraction {
  readonly interactionId: InteractionId;
  readonly interactionKind: InteractionKind;
  /**
   * The tool call this interaction was issued from — the timeline anchor.
   * Present for the common case (approvals gate a tool call; questions are
   * emitted by the AskUserQuestion tool call itself). Absent means the
   * interaction is unanchored and renders floating rather than inline.
   */
  readonly toolCallId?: string;
  readonly origin?: unknown;
  readonly anchor?: TranscriptAnchor;
  readonly state: InteractionState;
  /** Open content: engine ApprovalRequest / QuestionRequest payload. */
  readonly request?: unknown;
  /** Open content: engine ApprovalResponse / QuestionResult payload. */
  readonly response?: unknown;
}
