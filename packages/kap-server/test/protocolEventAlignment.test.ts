import type { z } from 'zod';
import {
  agentTaskReceiptSchema,
  assistantDeltaEventSchema,
  bundledSkillActivationSchema,
  compactionBlockedEventSchema,
  compactionCompletedEventSchema,
  compactionResultSchema,
  compactionStartedEventSchema,
  compactionSummaryOriginSchema,
  cronJobOriginSchema,
  cronMissedOriginSchema,
  finishReasonSchema,
  goalActorSchema,
  goalBudgetLimitsSchema,
  goalBudgetReportSchema,
  goalChangeKindSchema,
  goalChangeSchema,
  goalChangeStatsSchema,
  goalSnapshotSchema,
  goalStatusSchema,
  goalToolResultSchema,
  hookResultEventSchema,
  hookResultOriginSchema,
  injectionOriginSchema,
  mcpOAuthAuthorizationUrlUpdateDataSchema,
  mcpServerStatusEventSchema,
  mcpServerStatusPayloadSchema,
  permissionModeSchema,
  pluginCommandActivatedEventSchema,
  pluginCommandOriginSchema,
  retryOriginSchema,
  shellCommandOriginSchema,
  shellCompletedEventSchema,
  shellOutputEventSchema,
  shellStartedEventSchema,
  skillActivationOriginSchema,
  skillSourceSchema,
  subagentCompletedEventSchema,
  subagentFailedEventSchema,
  subagentSpawnedEventSchema,
  subagentStartedEventSchema,
  subagentSuspendedEventSchema,
  systemTriggerOriginSchema,
  taskLifecycleStatusSchema,
  taskOriginSchema,
  thinkingDeltaEventSchema,
  tokenUsageSchema,
  toolCallDeltaEventSchema,
  toolCallStartedEventSchema,
  toolListUpdatedEventSchema,
  toolListUpdatedReasonSchema,
  toolProgressEventSchema,
  toolResultEventSchema,
  toolUpdateSchema,
  turnEndReasonSchema,
  turnStepCompletedEventSchema,
  turnStepInterruptedEventSchema,
  turnStepRetryingEventSchema,
  turnStepStartedEventSchema,
  usageStatusSchema,
  userPromptOriginSchema,
  warningEventSchema,
} from '@kiki/protocol';
import type {
  BundledSkillActivation,
  CompactionSummaryOrigin,
  CronJobOrigin,
  CronMissedOrigin,
  HookResultOrigin,
  InjectionOrigin,
  PluginCommandOrigin,
  RetryOrigin,
  ShellCommandOrigin,
  SkillActivationOrigin,
  SkillSource,
  SystemTriggerOrigin,
  TaskOrigin,
  UserPromptOrigin,
} from '@kiki/agent-core-v2/agent/contextMemory/types';
import type {
  CompactionBlockedPayload,
  CompactionCompletedPayload,
  CompactionStartedPayload,
} from '@kiki/agent-core-v2/agent/fullCompaction/compactionOps';
import type { CompactionResult } from '@kiki/agent-core-v2/agent/fullCompaction/types';
import type {
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeKind,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from '@kiki/agent-core-v2/agent/goal/types';
import type {
  AssistantDeltaPayload,
  ThinkingDeltaPayload,
  ToolCallDeltaPayload,
  TurnEndReason,
  TurnStepCompletedPayload,
  TurnStepInterruptedPayload,
  TurnStepStartedPayload,
} from '@kiki/agent-core-v2/agent/loop/turnEvents';
import type {
  McpServerStatusEventPayload,
  McpServerStatusPayload,
  ToolListUpdatedPayload,
  ToolListUpdatedReason,
} from '@kiki/agent-core-v2/agent/mcp/mcpEvents';
import type { McpOAuthAuthorizationUrlUpdateData } from '@kiki/agent-core-v2/agent/mcp/tools/auth';
import type { PermissionMode } from '@kiki/agent-core-v2/agent/permissionPolicy/types';
import type { PluginCommandActivatedPayload } from '@kiki/agent-core-v2/agent/pluginCommand/pluginCommand';
import type { WarningEvent } from '@kiki/agent-core-v2/agent/profile/profileService';
import type {
  ShellCompletedPayload,
  ShellOutputPayload,
  ShellStartedPayload,
} from '@kiki/agent-core-v2/agent/shellCommand/shellCommandService';
import type { TurnStepRetryingPayload } from '@kiki/agent-core-v2/agent/stepRetry/stepRetryService';
import type { AgentTaskReceipt, AgentTaskStatus } from '@kiki/agent-core-v2/agent/task/types';
import type {
  ToolCallStartedPayload,
  ToolProgressPayload,
  ToolResultEventPayload,
} from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { UsageStatus } from '@kiki/agent-core-v2/agent/usage/usage';
import type { HookResultPayload } from '@kiki/agent-core-v2/features/externalHooks/agent/agentExternalHooksService';
import type { FinishReason } from '@kiki/agent-core-v2/kosong/contract/provider';
import type { TokenUsage } from '@kiki/agent-core-v2/kosong/contract/usage';
import type {
  SubagentCompletedPayload,
  SubagentFailedPayload,
  SubagentSpawnedPayload,
  SubagentStartedPayload,
} from '@kiki/agent-core-v2/session/subagent/mirrorAgentRun';
import type { SubagentSuspendedPayload } from '@kiki/agent-core-v2/session/subagent/subagentSuspended';
import type { ToolUpdate } from '@kiki/agent-core-v2/tool/toolContract';
import { describe, expect, it } from 'vitest';

const ALIGNED_PROTOCOL_EVENT_SCHEMAS = [
  tokenUsageSchema satisfies z.ZodType<TokenUsage>,
  finishReasonSchema satisfies z.ZodType<FinishReason>,
  usageStatusSchema satisfies z.ZodType<UsageStatus>,
  permissionModeSchema satisfies z.ZodType<PermissionMode>,
  skillSourceSchema satisfies z.ZodType<SkillSource>,
  bundledSkillActivationSchema satisfies z.ZodType<BundledSkillActivation>,
  userPromptOriginSchema satisfies z.ZodType<UserPromptOrigin>,
  skillActivationOriginSchema satisfies z.ZodType<SkillActivationOrigin>,
  pluginCommandOriginSchema satisfies z.ZodType<PluginCommandOrigin>,
  injectionOriginSchema satisfies z.ZodType<InjectionOrigin>,
  shellCommandOriginSchema satisfies z.ZodType<ShellCommandOrigin>,
  compactionSummaryOriginSchema satisfies z.ZodType<CompactionSummaryOrigin>,
  systemTriggerOriginSchema satisfies z.ZodType<SystemTriggerOrigin>,
  taskLifecycleStatusSchema satisfies z.ZodType<AgentTaskStatus>,
  taskOriginSchema satisfies z.ZodType<TaskOrigin>,
  cronJobOriginSchema satisfies z.ZodType<CronJobOrigin>,
  cronMissedOriginSchema satisfies z.ZodType<CronMissedOrigin>,
  hookResultOriginSchema satisfies z.ZodType<HookResultOrigin>,
  retryOriginSchema satisfies z.ZodType<RetryOrigin>,
  goalStatusSchema satisfies z.ZodType<GoalStatus>,
  goalActorSchema satisfies z.ZodType<GoalActor>,
  goalBudgetLimitsSchema satisfies z.ZodType<GoalBudgetLimits>,
  goalBudgetReportSchema satisfies z.ZodType<GoalBudgetReport>,
  goalSnapshotSchema satisfies z.ZodType<GoalSnapshot>,
  goalToolResultSchema satisfies z.ZodType<GoalToolResult>,
  goalChangeStatsSchema satisfies z.ZodType<GoalChangeStats>,
  goalChangeKindSchema satisfies z.ZodType<GoalChangeKind>,
  goalChangeSchema satisfies z.ZodType<GoalChange>,
  agentTaskReceiptSchema satisfies z.ZodType<AgentTaskReceipt>,
  compactionResultSchema satisfies z.ZodType<CompactionResult>,
  toolUpdateSchema satisfies z.ZodType<ToolUpdate>,
  mcpOAuthAuthorizationUrlUpdateDataSchema satisfies z.ZodType<McpOAuthAuthorizationUrlUpdateData>,
  turnEndReasonSchema satisfies z.ZodType<TurnEndReason>,
  pluginCommandActivatedEventSchema satisfies z.ZodType<PluginCommandActivatedPayload>,
  warningEventSchema satisfies z.ZodType<WarningEvent>,
  turnStepStartedEventSchema satisfies z.ZodType<TurnStepStartedPayload>,
  turnStepCompletedEventSchema satisfies z.ZodType<TurnStepCompletedPayload>,
  turnStepRetryingEventSchema satisfies z.ZodType<TurnStepRetryingPayload>,
  turnStepInterruptedEventSchema satisfies z.ZodType<TurnStepInterruptedPayload>,
  assistantDeltaEventSchema satisfies z.ZodType<AssistantDeltaPayload>,
  hookResultEventSchema satisfies z.ZodType<HookResultPayload>,
  thinkingDeltaEventSchema satisfies z.ZodType<ThinkingDeltaPayload>,
  toolCallDeltaEventSchema satisfies z.ZodType<ToolCallDeltaPayload>,
  toolCallStartedEventSchema satisfies z.ZodType<ToolCallStartedPayload>,
  toolProgressEventSchema satisfies z.ZodType<ToolProgressPayload>,
  shellOutputEventSchema satisfies z.ZodType<ShellOutputPayload>,
  shellStartedEventSchema satisfies z.ZodType<ShellStartedPayload>,
  shellCompletedEventSchema satisfies z.ZodType<ShellCompletedPayload>,
  toolResultEventSchema satisfies z.ZodType<ToolResultEventPayload>,
  subagentSpawnedEventSchema satisfies z.ZodType<SubagentSpawnedPayload>,
  subagentStartedEventSchema satisfies z.ZodType<SubagentStartedPayload>,
  subagentSuspendedEventSchema satisfies z.ZodType<SubagentSuspendedPayload>,
  subagentCompletedEventSchema satisfies z.ZodType<SubagentCompletedPayload>,
  subagentFailedEventSchema satisfies z.ZodType<SubagentFailedPayload>,
  compactionStartedEventSchema satisfies z.ZodType<CompactionStartedPayload>,
  compactionBlockedEventSchema satisfies z.ZodType<CompactionBlockedPayload>,
  compactionCompletedEventSchema satisfies z.ZodType<CompactionCompletedPayload>,
  toolListUpdatedReasonSchema satisfies z.ZodType<ToolListUpdatedReason>,
  toolListUpdatedEventSchema satisfies z.ZodType<ToolListUpdatedPayload>,
  mcpServerStatusPayloadSchema satisfies z.ZodType<McpServerStatusPayload>,
  mcpServerStatusEventSchema satisfies z.ZodType<McpServerStatusEventPayload>,
] as const;

describe('protocol event alignment with agent-core-v2', () => {
  it('keeps every core event schema exported and aligned at compile time', () => {
    expect(ALIGNED_PROTOCOL_EVENT_SCHEMAS).toHaveLength(61);
    for (const schema of ALIGNED_PROTOCOL_EVENT_SCHEMAS) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });
});
