import type { PromptStatus } from '@kiki/protocol';

import type { SessionViewState } from '@kiki/session-core/session/transcript/types';

export interface AttachmentSettlementIdentity {
  readonly promptId?: string;
  readonly turnId?: string;
  readonly promptState?: PromptStatus;
}

export type AttachmentSettlementProjection = 'pending' | 'active' | 'terminal';

export function projectAttachmentSettlement(
  identity: AttachmentSettlementIdentity,
  view: SessionViewState,
): AttachmentSettlementProjection {
  if (view.resyncing || view.resyncFailed) return 'pending';
  if (identity.turnId !== undefined) {
    return view.turnTail?.turnId === identity.turnId ? 'terminal' : 'pending';
  }
  const promptId = identity.promptId!;
  if (view.activePromptId === promptId || view.queuedPromptIds.includes(promptId)) return 'active';
  const user = view.blocks.find((block) => block.kind === 'user' && block.promptId === promptId);
  if (user?.kind !== 'user') return identity.promptState === undefined ? 'pending' : 'active';
  return user.promptStatus === undefined ? 'terminal' : 'active';
}
