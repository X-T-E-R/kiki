import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { HookDef } from '#/features/externalHooks/internal/types';
import type { SkillRoot } from '#/app/skillCatalog/types';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { PluginInstallPlan } from './installPlan';

import type {
  EnabledPluginRequestProjection,
  EnabledPluginSessionStart,
  EnabledPluginSystemPrompt,
  PluginAgentRoot,
  PluginCommandDef,
  PluginInfo,
  PluginMcpServerEntry,
  PluginMutationSummary,
  PluginReloadEvent,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
  RequestProjectionDecision,
  RequestProjectionMetrics,
} from './types';

export interface InstallPluginInput {
  readonly source: string;
  readonly sha256?: string;
  readonly fingerprint?: string;
  readonly consent?: boolean;
  readonly defaultEnabled?: boolean;
}

export interface SetPluginEnabledInput {
  readonly id: string;
  readonly enabled: boolean;
  /** Default for workspaces without their own choice; omitted follows `enabled`. */
  readonly defaultEnabled?: boolean;
}

export interface SetPluginMcpServerEnabledInput {
  readonly id: string;
  readonly server: string;
  readonly enabled: boolean;
}

export interface RemovePluginInput {
  readonly id: string;
  readonly deleteData?: boolean;
}

export interface GetPluginInfoInput {
  readonly id: string;
}

export interface PluginChangeEvent extends IWaitUntil {
  readonly affected?: readonly string[];
  readonly finished: Promise<void>;
  readonly reportFailure?: (error: unknown) => void;
}

export interface IPluginService {
  readonly _serviceBrand: undefined;

  listPlugins(): Promise<readonly PluginSummary[]>;
  /** Reads a committed snapshot before preparing independently; cancellation waits for owned IO and scratch cleanup. */
  previewPlugin(input: Pick<InstallPluginInput, 'source' | 'sha256'>, signal?: AbortSignal): Promise<PluginInstallPlan>;
  installPlugin(input: InstallPluginInput): Promise<PluginSummary>;
  rollbackPlugin(input: { readonly id: string }): Promise<PluginSummary>;
  setPluginEnabled(input: SetPluginEnabledInput): Promise<void>;
  setPluginMcpServerEnabled(input: SetPluginMcpServerEnabledInput): Promise<void>;
  removePlugin(input: RemovePluginInput): Promise<void>;
  reloadPlugins(): Promise<ReloadSummary>;
  getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo>;
  listPluginCommands(workspaceId?: string, sessionId?: string): Promise<readonly PluginCommandDef[]>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  pluginSkillRoots(workspaceId?: string, sessionId?: string): Promise<readonly SkillRoot[]>;
  pluginSkillOwner(path: string): Promise<string | undefined>;
  pluginAgentRoots(workspaceId?: string, sessionId?: string): Promise<readonly PluginAgentRoot[]>;
  enabledSessionStarts(workspaceId?: string, sessionId?: string): Promise<readonly EnabledPluginSessionStart[]>;
  enabledSystemPrompts(workspaceId?: string, sessionId?: string): Promise<readonly EnabledPluginSystemPrompt[]>;
  enabledMcpServers(workspaceId?: string, sessionId?: string): Promise<Record<string, McpServerConfig>>;
  mcpServerEntries(): Promise<readonly PluginMcpServerEntry[]>;
  enabledHooks(workspaceId?: string, sessionId?: string): Promise<readonly HookDef[]>;
  enabledHookRules(workspaceId?: string, sessionId?: string): Promise<readonly import('#/features/externalHooks/internal/loadRules').HookRuleSource[]>;
  enabledRequestProjections(workspaceId?: string, sessionId?: string): Promise<readonly EnabledPluginRequestProjection[]>;
  resolveRequestProjection(input: {
    readonly modelAlias: string;
    readonly modelId?: string;
    readonly modelName?: string;
    readonly workspaceId?: string;
    readonly sessionId?: string;
  }): Promise<RequestProjectionDecision>;
  recordRequestProjectionOutcome(input: {
    readonly pluginId?: string;
    readonly matched: boolean;
    readonly projectedBatches: number;
    readonly projectedMessages: number;
  }): void;
  requestProjectionMetrics(pluginId?: string): RequestProjectionMetrics;
  hasLoadedSnapshot(): boolean;
  readonly onWillChange: Event<PluginChangeEvent>;
  readonly onDidReload: Event<PluginReloadEvent>;
  readonly onDidMutate: Event<PluginMutationSummary>;
}

export const IPluginService: ServiceIdentifier<IPluginService> =
  createDecorator<IPluginService>('pluginService');
