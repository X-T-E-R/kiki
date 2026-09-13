import type {
  AgentConfigData,
  AgentConfigUpdateData,
  AgentContextData,
  CompactionResult,
  ContextMessage,
  GoalChange,
  GoalSnapshot,
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
  PlanData,
  SessionMeta,
  ToolInfo,
} from '@kiki/agent-core-v2';
import type { UsageStatus } from '@kiki/protocol';

import type { BackgroundTaskInfo } from './background';
import type { SessionSummary } from './core-api';

/** Whether an agent is the session's main agent or a spawned subagent. */
export type AgentType = 'main' | 'sub';

export type AgentReplayRecordPayload =
  | { type: 'message'; message: ContextMessage }
  | { type: 'compaction'; result?: CompactionResult | 'cancelled'; instruction?: string }
  | {
      type: 'goal_updated';
      snapshot: GoalSnapshot;
      change: GoalChange | { readonly kind: 'created' };
    }
  | { type: 'plan_updated'; enabled: boolean }
  | { type: 'config_updated'; config: AgentConfigUpdateData }
  | { type: 'permission_updated'; mode: PermissionMode }
  | { type: 'approval_result'; record: PermissionApprovalResultRecord };

export type AgentReplayRecord = { readonly time: number } & AgentReplayRecordPayload;

export interface ResumedAgentState {
  readonly type: AgentType;
  readonly config: AgentConfigData;
  readonly context: AgentContextData;
  readonly replay: readonly AgentReplayRecord[];
  readonly permission: PermissionData;
  readonly plan: PlanData;
  readonly swarmMode?: boolean | undefined;
  readonly usage: UsageStatus;
  readonly tools: readonly ToolInfo[];
  readonly toolStore?: Readonly<Record<string, unknown>>;
  readonly background: readonly BackgroundTaskInfo[];
}

export interface ResumeSessionResult extends SessionSummary {
  readonly sessionMetadata: SessionMeta;
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string | undefined;
}
