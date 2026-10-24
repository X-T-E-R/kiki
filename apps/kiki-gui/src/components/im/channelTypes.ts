import type {
  ImBinding,
  ImChannelView,
  ImIdentity,
  ImPolicy,
  ImProviderKind,
  ImSessionSnapshot,
  ImTargetChannels,
  OptionalCapabilitySessionResponse,
} from '@kiki/protocol';

export const IM_IDENTITY_ALREADY_BOUND_CODE = 40949;

export interface RebindConflictDetails {
  readonly existing_binding_id?: string;
  readonly variant_label?: string;
  readonly variant_key?: {
    readonly provider_instance_id: string;
    readonly account_id: string;
    readonly chat_id: string;
    readonly topic_id?: string;
    readonly sender_id: string;
  };
  readonly previous_session_id?: string;
  readonly previous_session_title?: string;
  readonly target_session_id?: string;
  readonly target_session_title?: string;
  readonly overlapping_bindings?: readonly unknown[];
}

export interface RebindCandidate {
  readonly id: string;
  readonly source: 'discovery' | 'binding';
  readonly provider_instance_id: string;
  readonly provider_kind: ImProviderKind;
  readonly account_id: string;
  readonly identity: ImIdentity;
  readonly isOccupied: boolean;
  readonly currentSessionId?: string;
  readonly currentSessionTitle?: string;
  readonly pendingReanchor?: boolean;
}

export function isIdentityAlreadyBoundError(error: unknown): error is Error & { details?: RebindConflictDetails } {
  if (!(error instanceof Error)) return false;
  const anyErr = error as unknown as { code?: number; msg?: string; details?: RebindConflictDetails };
  return (
    anyErr.code === IM_IDENTITY_ALREADY_BOUND_CODE ||
    anyErr.msg === 'im_identity_already_bound' ||
    error.message.includes('im_identity_already_bound')
  );
}

export function extractConflictDetails(error: unknown): RebindConflictDetails | undefined {
  if (!isIdentityAlreadyBoundError(error)) return undefined;
  return (error as { details?: RebindConflictDetails }).details;
}

export function formatIdentityChannel(chatId: string, topicId?: string): string {
  if (topicId !== undefined && topicId !== '' && topicId !== '0') {
    return `${chatId} / topic:${topicId}`;
  }
  return chatId;
}

export function formatIdentityVariant(identity: ImIdentity): string {
  const channel = formatIdentityChannel(identity.chat_id, identity.topic_id);
  const sender = identity.sender_name ?? identity.sender_id;
  return `${channel} · ${sender}`;
}

export function isBindingAdmittedInbound(
  binding: ImBinding,
  policy: ImPolicy,
): boolean {
  if (!policy.allowed || !binding.enabled) return false;
  if (binding.session_enabled === false) return false;
  return binding.input_enabled ?? true;
}

export function isBindingAdmittedOutbound(
  binding: ImBinding,
  policy: ImPolicy,
): boolean {
  if (!policy.allowed || !binding.enabled) return false;
  if (binding.session_enabled === false) return false;
  return binding.output_enabled ?? true;
}

export function findSendMessageRow(
  response?: OptionalCapabilitySessionResponse,
) {
  return response?.rows.find((row) => row.id === 'send_message');
}
