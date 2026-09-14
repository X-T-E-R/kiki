import { TASK_AGENT_ROLE_PREFIX } from '#/app/agentProfileCatalog/profile-shared';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import type { DelegatorRef } from '#/session/sessionMetadata/sessionMetadata';

import DEFAULT_INDEPENDENT_NOTICE from './delegation-independent-notice.md?raw';

export type DelegationPosition = 'main' | 'sub' | 'independent';

export type DelegationNotice = 'auto' | 'off';

export type DelegationSlotConfig = boolean;

export interface AgentsDelegationConfig {
  readonly sub?: DelegationSlotConfig;
  readonly independent?: DelegationSlotConfig;
}

export const DELEGATION_CONTEXT_TOKEN = '${delegation_context}';

export const DEFAULT_INDEPENDENT_DELEGATION_NOTICE = DEFAULT_INDEPENDENT_NOTICE;

export function resolveDelegationPosition(
  agentId: string,
  delegator: DelegatorRef | undefined,
): DelegationPosition {
  if (agentId === MAIN_AGENT_ID) return 'main';
  if (delegator?.kind === 'external') return 'independent';
  return 'sub';
}

export function injectDelegationContext(text: string, snippet: string | undefined): string {
  if (snippet === undefined || snippet.length === 0) {
    if (!text.includes(DELEGATION_CONTEXT_TOKEN)) return text;
    return text.replaceAll(DELEGATION_CONTEXT_TOKEN, '').replace(/\n{3,}/g, '\n\n');
  }
  if (text.includes(DELEGATION_CONTEXT_TOKEN)) {
    return text.replaceAll(DELEGATION_CONTEXT_TOKEN, () => snippet);
  }
  return `${snippet}\n\n${text}`;
}

export function resolveDelegationSnippet(input: {
  readonly position: DelegationPosition;
  readonly notice?: DelegationNotice;
  readonly config?: AgentsDelegationConfig;
  readonly fields?: Readonly<Record<string, string>>;
}): string | undefined {
  if (input.position === 'main' || input.notice === 'off') return undefined;
  const slot = input.position;
  const enabled = slot === 'sub' ? input.config?.sub : input.config?.independent;
  if (enabled === false) return undefined;
  return slot === 'sub'
    ? input.fields?.['delegation.sub.notice'] ?? TASK_AGENT_ROLE_PREFIX
    : input.fields?.['delegation.independent.notice'] ?? DEFAULT_INDEPENDENT_DELEGATION_NOTICE;
}
