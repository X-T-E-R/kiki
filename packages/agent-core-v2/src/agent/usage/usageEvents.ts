/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

import type { UsageStatus } from './usage';
import type { PermissionMode } from '#/agent/permissionPolicy/types';

export interface AgentStatusUpdatedPayload {
  usage?: UsageStatus;
  planMode?: boolean;
  model?: string;
  thinkingEffort?: string;
  maxContextTokens?: number;
  contextStrategy?: 'summarize' | 'auto' | 'fresh';
  contextStrategySource?: 'session' | 'profile' | 'global' | 'default' | 'subagent' | 'executor';
  autoCompactTokens?: number;
  autoCompactSource?: 'session' | 'profile' | 'model' | 'global' | 'legacy';
  effectiveMaxContextTokens?: number;
  reservedContextTokens?: number;
  contextTokens?: number;
  permission?: PermissionMode;
}

export class AgentStatusUpdated extends Event2<AgentStatusUpdatedPayload> {
  static override readonly type = 'agent.status.updated';
  static override readonly observable = true;
}
export interface AgentStatusUpdated extends AgentStatusUpdatedPayload {}

export interface UsageSettledPayload {
  readonly payload: { readonly sessionId?: string; readonly agentId?: string };
}

export class UsageSettled extends Event2<UsageSettledPayload> {
  static override readonly type = 'event.usage.settled';
  static override readonly observable = true;
}
export interface UsageSettled extends UsageSettledPayload {}
