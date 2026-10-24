import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { admitSendMessageCapability } from '#/app/optionalCapability/admit';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IAgentToolPolicyService } from './toolPolicy';

export interface SendMessageProfileBinding {
  readonly activeToolNames?: readonly string[];
  readonly profileDefinitionId?: string;
  readonly boundProfile?: { readonly definitionId?: string };
}

export function isLegacyShippedMessageBinding(
  profile: SendMessageProfileBinding,
  deliveryMode: 'reply' | 'message',
  isCleanActivePath: (path: string) => boolean,
): boolean {
  if (deliveryMode !== 'message' || profile.activeToolNames === undefined || profile.activeToolNames.includes('SendMessage')) return false;
  const definitionId = profile.profileDefinitionId ?? profile.boundProfile?.definitionId;
  if (definitionId === undefined) return false;
  return definitionId.startsWith('shipped://agent-profiles/') || isCleanActivePath(definitionId);
}

export function isSendMessageCapabilityAdmitted(accessor: ServicesAccessor): boolean {
  const delivery = accessor.get(ISessionDeliveryService);
  try {
    const session = accessor.get(ISessionContext);
    const agent = accessor.get(IAgentScopeContext);
    const policy = accessor.get(IOptionalCapabilityPolicy);
    return admitSendMessageCapability(policy, {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      agentId: agent.agentId,
    }, delivery.effectiveMode()).admitted;
  } catch {
    return delivery.effectiveMode() === 'message';
  }
}

export function isSendMessageToolActive(accessor: ServicesAccessor): boolean {
  if (!isSendMessageCapabilityAdmitted(accessor)) return false;
  try {
    return accessor.get(IAgentToolPolicyService).isToolActive('SendMessage');
  } catch {
    return true;
  }
}
