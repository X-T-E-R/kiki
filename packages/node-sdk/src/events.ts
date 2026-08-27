import type { ApprovalRequest, ApprovalResponse, QuestionRequest, QuestionResult } from '#/protocol';

// Event union plus shared fields/payloads used across event families. The
// vocabulary itself lives in `@moonshot-ai/protocol` — the engine-neutral
// package both the daemon and this SDK speak.
export type { Event } from '@moonshot-ai/protocol';
export type { KimiErrorPayload } from '#/errors';

export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/protocol';

// Session lifecycle/status events and their status payload.
export type {
  AgentStatusUpdatedEvent,
  SessionMetaUpdatedEvent,
  GoalUpdatedEvent,
  SkillActivatedEvent,
  PluginCommandActivatedEvent,
  ErrorEvent,
  WarningEvent,
  UsageStatus,
} from '@moonshot-ai/protocol';

// Turn and step lifecycle events plus the turn-ending reason enum.
export type {
  TurnStartedEvent,
  TurnEndedEvent,
  TurnStepStartedEvent,
  TurnStepCompletedEvent,
  TurnStepRetryingEvent,
  TurnStepInterruptedEvent,
  TurnEndReason,
} from '@moonshot-ai/protocol';

// Streaming content and hook-result events.
export type {
  AssistantDeltaEvent,
  HookResultEvent,
  ThinkingDeltaEvent,
} from '@moonshot-ai/protocol';

// Tool-call events and incremental progress payloads.
export type {
  ToolCallStartedEvent,
  ToolCallDeltaEvent,
  ToolProgressEvent,
  ToolResultEvent,
  ToolUpdate,
  ToolInputDisplay,
  McpOAuthAuthorizationUrlUpdateData,
} from '@moonshot-ai/protocol';

// MCP tool-list and server status events.
export type {
  ToolListUpdatedEvent,
  ToolListUpdatedReason,
  McpServerStatusEvent,
  McpServerStatusPayload,
} from '@moonshot-ai/protocol';

// Approval and question reverse-RPC shapes, plus the in-process tool-call
// bridge. These are the SDK's own contract (see `src/protocol/sdk-api.ts`).
export type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalScope,
  ApprovalResponse,
  QuestionRequest,
  QuestionItem,
  QuestionOption,
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionResponse,
  QuestionResult,
  ToolCallRequest,
  ToolCallResponse,
} from '#/protocol';

// Subagent lifecycle events.
export type {
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
} from '@moonshot-ai/protocol';

// Compaction lifecycle events and compaction result payload.
export type {
  CompactionStartedEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionResult,
} from '@moonshot-ai/protocol';

// Background task lifecycle events emitted by the BPM. Covers both
// bash (`bash-*`) and agent (`agent-*`) tasks under one wire format.
export type {
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
} from '@moonshot-ai/protocol';

export type { CronFiredEvent } from '@moonshot-ai/protocol';

export type MaybePromise<T> = T | Promise<T>;

export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;
