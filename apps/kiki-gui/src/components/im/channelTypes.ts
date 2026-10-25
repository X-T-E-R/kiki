import {
  imSessionAdmitted,
  type ImBinding,
  type ImIdentity,
  type ImPolicy,
  type ImProviderKind,
  type OptionalCapabilitySessionResponse,
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

/**
 * Strip the 'notify:' prefix from channelViews ID so client sends raw channelId
 * to PUT/DELETE /api/im/sessions/targets/:id/notify/:channelId.
 */
export function stripNotifyPrefix(channelId: string): string {
  return channelId.startsWith('notify:') ? channelId.slice(7) : channelId;
}

export function formatIdentityChannel(chatId: string, topicId?: string): string {
  if (topicId !== undefined && topicId !== '' && topicId !== '0') {
    return `${chatId} / topic:${topicId}`;
  }
  return chatId;
}

/**
 * Format human-readable identity variant.
 * Prefers chat_title and sender_name as primary labels, reserving raw chat_id / topic_id for secondary metadata.
 */
export function formatIdentityVariant(identity: ImIdentity): string {
  const channel = identity.chat_title && identity.chat_title.trim() !== ''
    ? identity.chat_title
    : identity.chat_id;
  const sender = identity.sender_name && identity.sender_name.trim() !== ''
    ? identity.sender_name
    : identity.sender_id;
  if (channel === sender) {
    return channel;
  }
  return `${channel} · ${sender}`;
}

/**
 * Base session admission helper: matches backend imSessionAdmitted rules.
 * Requires:
 * 1. Policy allowed & binding enabled;
 * 2. Not in pending_reanchor state;
 * 3. Must belong to the specified session_id;
 * 4. Passes policy.default_enabled and binding.session_enabled check.
 */
export function isBindingSessionAdmitted(
  binding: ImBinding,
  policy: ImPolicy,
  sessionId?: string,
): boolean {
  if (binding.pending_reanchor) return false;
  if (sessionId !== undefined && binding.session_id !== sessionId) return false;
  if (!binding.session_id) return false;
  if (!binding.enabled) return false;
  return imSessionAdmitted({
    allowed: policy.allowed,
    defaultEnabled: policy.default_enabled,
    sessionEnabled: binding.session_enabled,
  });
}

export function isBindingAdmittedInbound(
  binding: ImBinding,
  policy: ImPolicy,
  sessionId?: string,
): boolean {
  if (!isBindingSessionAdmitted(binding, policy, sessionId)) return false;
  return binding.input_enabled ?? true;
}

export function isBindingAdmittedOutbound(
  binding: ImBinding,
  policy: ImPolicy,
  sessionId?: string,
): boolean {
  if (!isBindingSessionAdmitted(binding, policy, sessionId)) return false;
  return binding.output_enabled ?? true;
}

export function findSendMessageRow(
  response?: OptionalCapabilitySessionResponse,
) {
  return response?.rows.find((row) => row.id === 'send_message');
}
