import { CoreErrors } from '#/_base/errors/codes';
import { DispatchErrors } from '#/session/dispatch/errors';
export { DispatchErrors } from '#/session/dispatch/errors';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { AuthErrors } from '#/app/auth/errors';
import { TaskErrors } from '#/agent/task/errors';
import { ThreadCommunicationErrors } from '#/app/threadCommunication/errors';
import { ProtocolErrors } from '#/kosong/protocol/errors';
import { ConfigErrors } from '#/app/config/errors';
import { CapabilityErrors } from '#/app/capability/errors';
import { CronErrors } from '#/app/cron/errors';
import { DebugErrors } from '#/debug/errors';
import { EventErrors } from '#/app/event/errors';
import { FileErrors } from '#/app/file/fileService';
import { FsErrors } from '#/workspace/workspaceFs/internal/errors';
import { FullCompactionErrors } from '#/agent/fullCompaction/errors';
import { GoalErrors } from '#/agent/goal/errors';
import { LoopErrors } from '#/agent/loop/errors';
import { McpErrors } from '#/mcpCore/errors';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { RequestIdentityErrors } from '#/kosong/requestIdentity/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import { OsProcessErrors } from '#/os/interface/hostProcess';
import { PluginErrors } from '#/app/plugin/errors';
import { ProfileErrors } from '#/agent/profile/errors';
import { PromptErrors } from '#/agent/prompt/errors';
import { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
import { SessionExportErrors } from '#/app/sessionExport/errors';
import { SessionIndexErrors } from '#/app/sessionIndex/errors';
import { SessionErrors } from '#/session/errors';
import { SkillErrors } from '#/app/skillCatalog/errors';
import { StateErrors } from '#/state/errors';
import { StorageErrors } from '#/persistence/interface/storage';
import { TerminalErrors } from '#/os/interface/terminalErrors';
import { UsageErrors } from '#/agent/usage/errors';
import { WireErrors } from '#/wire/errors';
import { WorkspaceErrors } from '#/app/workspace/errors';
import { AgentProfileRouteErrors } from '#/app/agentProfileCatalog/errors';
import { AgentProfileWriteErrors } from '#/workspace/workspaceAgentProfileLoader/errors';
export * from '#/_base/errors/codes';
export * from '#/_base/errors/errorMessage';
export * from '#/_base/errors/errors';
export * from '#/_base/errors/serialize';
export * from '#/_base/errors/unexpectedError';
export { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
export { AuthErrors } from '#/app/auth/errors';
export { TaskErrors } from '#/agent/task/errors';
export { ThreadCommunicationErrors } from '#/app/threadCommunication/errors';
export { ProtocolErrors } from '#/kosong/protocol/errors';
export { ConfigErrors } from '#/app/config/errors';
export { CapabilityErrors } from '#/app/capability/errors';
export { CronErrors } from '#/app/cron/errors';
export { DebugErrors } from '#/debug/errors';
export { FileErrors } from '#/app/file/fileService';
export { FsErrors } from '#/workspace/workspaceFs/internal/errors';
export { FullCompactionErrors } from '#/agent/fullCompaction/errors';
export { GoalErrors } from '#/agent/goal/errors';
export { LoopErrors } from '#/agent/loop/errors';
export { McpErrors } from '#/mcpCore/errors';
export { ModelCatalogErrors } from '#/kosong/model/errors';
export { RequestIdentityErrors } from '#/kosong/requestIdentity/errors';
export { OsFsErrors } from '#/os/interface/hostFsErrors';
export { OsProcessErrors } from '#/os/interface/hostProcess';
export { PluginErrors } from '#/app/plugin/errors';
export { ProfileErrors } from '#/agent/profile/errors';
export { PromptErrors } from '#/agent/prompt/errors';
export { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
export { SessionExportErrors } from '#/app/sessionExport/errors';
export { SessionIndexErrors } from '#/app/sessionIndex/errors';
export { SessionErrors } from '#/session/errors';
export { SkillErrors } from '#/app/skillCatalog/errors';
export { StorageErrors } from '#/persistence/interface/storage';
export { TerminalErrors } from '#/os/interface/terminalErrors';
export { UsageErrors } from '#/agent/usage/errors';
export { WireErrors } from '#/wire/errors';
export { WorkspaceErrors } from '#/app/workspace/errors';
export { AgentProfileRouteErrors } from '#/app/agentProfileCatalog/errors';
export { AgentProfileWriteErrors } from '#/workspace/workspaceAgentProfileLoader/errors';
export { EventErrors } from '#/app/event/errors';
export { StateErrors } from '#/state/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...DispatchErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...AuthErrors.codes,
  ...TaskErrors.codes,
  ...ThreadCommunicationErrors.codes,
  ...ProtocolErrors.codes,
  ...ConfigErrors.codes,
  ...CapabilityErrors.codes,
  ...CronErrors.codes,
  ...DebugErrors.codes,
  ...FileErrors.codes,
  ...FsErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LoopErrors.codes,
  ...McpErrors.codes,
  ...ModelCatalogErrors.codes,
  ...RequestIdentityErrors.codes,
  ...OsFsErrors.codes,
  ...OsProcessErrors.codes,
  ...PluginErrors.codes,
  ...ProfileErrors.codes,
  ...PromptErrors.codes,
  ...ModelsDevImportErrors.codes,
  ...SessionExportErrors.codes,
  ...SessionIndexErrors.codes,
  ...SessionErrors.codes,
  ...SkillErrors.codes,
  ...StorageErrors.codes,
  ...TerminalErrors.codes,
  ...UsageErrors.codes,
  ...WireErrors.codes,
  ...WorkspaceErrors.codes,
  ...AgentProfileRouteErrors.codes,
  ...AgentProfileWriteErrors.codes,
  ...EventErrors.codes,
  ...StateErrors.codes,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
