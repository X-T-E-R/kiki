import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { HookDef } from '#/features/externalHooks/internal/types';
import type { SkillRoot } from '#/app/skillCatalog/types';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { PluginInstallPlan } from './installPlan';

import type {
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
} from './types';

export interface InstallPluginInput {
  readonly source: string;
  readonly sha256?: string;
  readonly fingerprint?: string;
  readonly consent?: boolean;
}

export interface SetPluginEnabledInput {
  readonly id: string;
  readonly enabled: boolean;
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

export interface IPluginService {
  readonly _serviceBrand: undefined;

  listPlugins(): Promise<readonly PluginSummary[]>;
  previewPlugin(input: Pick<InstallPluginInput, 'source' | 'sha256'>): Promise<PluginInstallPlan>;
  installPlugin(input: InstallPluginInput): Promise<PluginSummary>;
  rollbackPlugin(input: { readonly id: string }): Promise<PluginSummary>;
  setPluginEnabled(input: SetPluginEnabledInput): Promise<void>;
  setPluginMcpServerEnabled(input: SetPluginMcpServerEnabledInput): Promise<void>;
  removePlugin(input: RemovePluginInput): Promise<void>;
  reloadPlugins(): Promise<ReloadSummary>;
  getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo>;
  listPluginCommands(): Promise<readonly PluginCommandDef[]>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  pluginSkillRoots(): Promise<readonly SkillRoot[]>;
  pluginAgentRoots(): Promise<readonly PluginAgentRoot[]>;
  enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]>;
  enabledSystemPrompts(): Promise<readonly EnabledPluginSystemPrompt[]>;
  enabledMcpServers(): Promise<Record<string, McpServerConfig>>;
  mcpServerEntries(): Promise<readonly PluginMcpServerEntry[]>;
  enabledHooks(): Promise<readonly HookDef[]>;
  enabledHookRules(): Promise<readonly import('#/features/externalHooks/internal/loadRules').HookRuleSource[]>;
  hasLoadedSnapshot(): boolean;
  readonly onDidReload: Event<PluginReloadEvent>;
  readonly onDidMutate: Event<PluginMutationSummary>;
}

export const IPluginService: ServiceIdentifier<IPluginService> =
  createDecorator<IPluginService>('pluginService');
