import { randomUUID } from 'node:crypto';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserCaller } from '#/app/browser/browser';
import type { ApprovalRequest, ApprovalResponse } from '#/session/approval/approval';
import { isInteractionCancellation, type ISessionInteractionService, type InteractionCancellation } from '#/session/interaction/interaction';
import { abortable } from '#/_base/utils/abort';

export async function browserElicitation(
  interaction: ISessionInteractionService,
  caller: BrowserCaller,
  turnId: number,
  toolCallId: string,
  request: ElicitRequest['params'],
  signal: AbortSignal,
): Promise<ElicitResult> {
  if (signal.aborted || request.mode === 'url' || !('requestedSchema' in request)) return { action: 'cancel' };
  if (Object.keys(request.requestedSchema.properties).length !== 0 || request._meta?.['codex_strict_auto_review'] === true) return { action: 'cancel' };
  const origin = { agentId: caller.agentId, turnId };
  if (!interaction.hasConsumer(origin)) return { action: 'cancel' };
  const id = `browser_approval_${randomUUID()}`;
  const payload: ApprovalRequest = { id, ...caller, turnId, toolCallId, toolName: 'Codex browser', action: request.message,
    display: { kind: 'external_permission', summary: request.message,
      detail: { source: 'Official Codex browser service', request: request._meta },
      options: [{ id: 'accept', label: 'Allow once', kind: 'allow_once' }, { id: 'decline', label: 'Decline', kind: 'reject_once' }] } };
  const pending = interaction.request<ApprovalRequest, ApprovalResponse | InteractionCancellation>({ id, kind: 'approval', payload, origin });
  try {
    const response = await abortable(pending, signal);
    if (isInteractionCancellation(response)) return { action: 'cancel' };
    if (response.decision === 'approved' && response.selectedOptionId === 'accept') return { action: 'accept', content: {} };
    return { action: response.decision === 'rejected' && response.selectedOptionId === 'decline' ? 'decline' : 'cancel' };
  } catch {
    try { interaction.respond(id, { cancelled: true, reason: 'aborted' }); } catch {}
    return { action: 'cancel' };
  }
}
