import { isBrowserOperationToolName } from '@kiki/agent-profiles/toolPolicy';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import type { Tool } from '#/kosong/contract/tool';
import type { ToolCall } from '#/kosong/contract/message';
import { usesKimiToolSchema } from '#/kosong/provider/providerDefinition';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { CompactionCompleted } from '#/agent/fullCompaction/compactionOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolPolicyService, withToolPolicySnapshot } from '#/agent/toolPolicy/toolPolicy';
import { isLegacyToolName } from '#/agent/toolPolicy/toolAliases';
import { isMcpToolName, type ToolInfo } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';

import {
  collectLoadedDynamicToolNames,
  foldAnnouncedToolNames,
  renderLoadableToolsAnnouncement,
  selectBoundedDeferredTools,
  shapeDynamicToolContext,
  shapeToolHistory,
} from './dynamicTools';
import { TOOL_SELECT_FLAG_ID } from './flag';
import {
  IAgentToolSelectService,
  CALL_TOOL_NAME,
  SELECT_TOOLS_TOOL_NAME,
  type LoadToolsResult,
  type ShapedToolEntry,
  type ShapedToolHistory,
} from './toolSelect';

export const toolSelectPendingLoadedKey = defineState<Set<string>>(
  'toolSelect.pendingLoaded',
  () => new Set(),
);

export class AgentToolSelectService extends Service implements IAgentToolSelectService {
  declare readonly _serviceBrand: undefined;
  private readonly awaitingSchema = new Set<string>();

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IFlagService private readonly flags: IFlagService,
    @IEventBus eventBus: IEventBus,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(toolSelectPendingLoadedKey);
    this._register(
      toolExecutor.registerUnavailableToolDescriber((name) => this.describeUnavailableTool(name)),
    );
    this._register(
      toolExecutor.registerMissingToolDescriber((name) => this.describeMissingTool(name)),
    );
    this._register(
      eventBus.subscribe(CompactionCompleted, () => {
        this.pendingLoaded.clear();
        this.awaitingSchema.clear();
      }),
    );
    this._register(
      eventBus.subscribe(ContextSpliced, (splice) => {
        if (splice.deleteCount === 0 || splice.messages.length > 0) return;
        this.dropPendingLoadedNotLanded();
      }),
    );
  }

  private get pendingLoaded(): Set<string> {
    return this.states.get(toolSelectPendingLoadedKey);
  }

  private dropPendingLoadedNotLanded(): void {
    if (this.pendingLoaded.size === 0) return;
    const landed = collectLoadedDynamicToolNames(this.context.get());
    for (const name of this.pendingLoaded) {
      if (!landed.has(name)) this.pendingLoaded.delete(name);
    }
  }

  enabled(): boolean {
    if (!this.flags.enabled(TOOL_SELECT_FLAG_ID) || !this.profile.getModelCapabilities().tool_use) return false;
    try {
      const model = this.profile.getRuntimeRequester(this.profile.resolveModelContext().modelAlias, this.profile.getRecipeModelSettings()).model;
      return model.protocol === 'openai' || model.protocol === 'openai_responses' || model.protocol === 'anthropic';
    } catch {
      return false;
    }
  }

  shapeTools(entries: readonly ToolInfo[]): readonly ShapedToolEntry[] {
    const disclosure = this.enabled();
    const activeEntries = this.activeEntries(entries, disclosure);
    if (!disclosure) return activeEntries;
    const hasLoadableTools = activeEntries.some((entry) => this.isDynamicallyLoadable(entry));
    const loaded = this.loadedToolNames();
    const model = this.profile.getRuntimeRequester(this.profile.resolveModelContext().modelAlias, this.profile.getRecipeModelSettings()).model;
    const kimiProvider = usesKimiToolSchema(model.providerType);
    const shaped: ShapedToolEntry[] = [];
    for (const entry of activeEntries) {
      if (entry.name === SELECT_TOOLS_TOOL_NAME || entry.name === CALL_TOOL_NAME) {
        if (hasLoadableTools && (entry.name !== CALL_TOOL_NAME || !kimiProvider)) shaped.push(entry);
        continue;
      }
      if (!this.isDynamicallyLoadable(entry)) {
        shaped.push(entry);
        continue;
      }
      if (!loaded.has(entry.name)) continue;
      shaped.push({ ...entry, deferred: true });
    }
    return shaped;
  }

  isLoadable(name: string): boolean {
    if (!this.enabled()) return false;
    const entries = this.toolRegistry.list();
    let target: ToolInfo | undefined;
    for (const entry of entries) {
      if (entry.name === name) {
        target = entry;
        break;
      }
    }
    if (target === undefined || !this.isDynamicallyLoadable(target) || !this.toolPolicy.isToolActive(target.name, target.source)) {
      return false;
    }
    return this.shapeTools(entries).some((entry) => entry.name === SELECT_TOOLS_TOOL_NAME);
  }

  loadableNames(): ReadonlySet<string> {
    if (!this.enabled()) return new Set();
    const entries = this.toolRegistry.list();
    if (!this.shapeTools(entries).some((entry) => entry.name === SELECT_TOOLS_TOOL_NAME)) return new Set();
    return new Set(this.loadableToolsFrom(entries).map((info) => info.name));
  }

  shapeHistory(messages: readonly ContextMessage[]): ShapedToolHistory {
    if (!this.enabled()) return shapeDynamicToolContext(messages);
    const infoByName = indexToolInfos(this.toolRegistry.list());
    return shapeToolHistory(messages, (message) => {
      const tools = message.tools;
      if (tools === undefined || !tools.some((tool) => this.isHistoricallyDisabled(tool.name, infoByName))) return message;
      const kept = tools.filter((tool) => !this.isHistoricallyDisabled(tool.name, infoByName));
      if (kept.length > 0) return { ...message, tools: kept };
      if (message.content.length === 0 && message.toolCalls.length === 0) return undefined;
      const { tools: _tools, ...rest } = message;
      return rest;
    });
  }

  private isHistoricallyDisabled(name: string, infoByName: ReadonlyMap<string, ToolInfo>): boolean {
    const info = infoByName.get(name);
    if (info !== undefined) return !this.toolPolicy.isToolActive(name, info.source);
    return name.startsWith('plugin__') || name.startsWith('browser__') || isMcpToolName(name);
  }

  load(names: readonly string[]): LoadToolsResult {
    const entries = this.toolRegistry.list();
    const infoByName = indexToolInfos(entries);
    const loadable = new Set<string>();
    const resident = new Set<string>();
    withToolPolicySnapshot(this.toolPolicy, () => {
      for (const info of entries) {
        if (!this.toolPolicy.isToolActive(info.name, info.source)) continue;
        if (this.isDynamicallyLoadable(info)) loadable.add(info.name);
        else resident.add(info.name);
      }
    });
    const loaded = this.activeLoadedToolNames(infoByName);
    const toLoad: string[] = [];
    const alreadyAvailable: string[] = [];
    const unknown: string[] = [];
    for (const name of new Set(names)) {
      if (loaded.has(name) || resident.has(name)) {
        alreadyAvailable.push(name);
      } else if (loadable.has(name)) {
        toLoad.push(name);
      } else {
        unknown.push(name);
      }
    }
    if (toLoad.length > 0) {
      for (const name of toLoad) this.pendingLoaded.add(name);
    }
    return { toLoad, alreadyAvailable, unknown };
  }

  resolveBridgeCall(call: ToolCall): ToolCall {
    if (call.name !== CALL_TOOL_NAME || !this.enabled() || call.arguments === null) return call;
    let input: unknown;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      return call;
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return call;
    const { name, arguments: args } = input as { name?: unknown; arguments?: unknown };
    if (typeof name !== 'string' || args === null || typeof args !== 'object' || Array.isArray(args)) return call;
    const entries = this.toolRegistry.list();
    const infoByName = indexToolInfos(entries);
    if (
      (!this.activeLoadedToolNames(infoByName).has(name) && !this.residentToolNamesFrom(entries).has(name)) ||
      this.toolRegistry.resolve(name) === undefined
    ) return call;
    return { ...call, name, arguments: JSON.stringify(args) };
  }

  usesCallTool(): boolean {
    return this.shapeTools(this.toolRegistry.list()).some((entry) => entry.name === CALL_TOOL_NAME);
  }

  describeCallToolTarget(name: string): string {
    const unavailable = this.describeUnavailableTool(name) ?? this.describeMissingTool(name);
    if (unavailable !== undefined) return unavailable;
    if (this.residentToolNamesFrom(this.toolRegistry.list()).has(name) && this.toolRegistry.resolve(name) !== undefined) {
      return `Tool "${name}" is an ordinary tool, not a loaded one. Call it directly by its name instead of through ${CALL_TOOL_NAME}.`;
    }
    return (
      `Tool "${name}" cannot be run through ${CALL_TOOL_NAME}: it is not among the tools that can be loaded now. ` +
      `Fold the <tools_added> and <tools_removed> announcements to find a current name, then load it with ${SELECT_TOOLS_TOOL_NAME}.`
    );
  }

  drainPendingToolSchemas(): readonly Tool[] | undefined {
    if (!this.enabled() || this.pendingLoaded.size === 0) return undefined;
    const infoByName = indexToolInfos(this.toolRegistry.list());
    const names = [...this.pendingLoaded].toSorted((a, b) => a.localeCompare(b));
    const tools: Tool[] = [];
    for (const name of names) {
      const tool = this.schemaOf(name, infoByName);
      if (tool === undefined) continue;
      this.pendingLoaded.delete(name);
      this.awaitingSchema.delete(name);
      tools.push(tool);
    }
    return tools.length === 0 ? undefined : tools;
  }

  loadableToolsAnnouncement(): string | undefined {
    if (!this.enabled()) return undefined;
    const entries = this.toolRegistry.list();
    const infoByName = indexToolInfos(entries);
    const allLoadable = this.loadableToolsFrom(entries);
    const announced = foldAnnouncedToolNames(this.context.get());
    const { selected: loadable, omitted } = selectBoundedDeferredTools(allLoadable, announced);
    const loadableSet = new Set(loadable.map((info) => info.name));
    const added = loadable.filter((info) => !announced.has(info.name));
    const addedNames = new Set(added.map((info) => info.name));
    const latestSchemas = new Map<string, Tool>();
    for (const message of this.context.get()) {
      for (const tool of message.tools ?? []) latestSchemas.set(tool.name, tool);
    }
    for (const info of loadable) {
      const name = info.name;
      if (this.pendingLoaded.has(name) || !announced.has(name) || addedNames.has(name)) continue;
      const previous = latestSchemas.get(name);
      if (previous === undefined) continue;
      const current = this.schemaOf(name, infoByName);
      if (current === undefined || JSON.stringify(previous) === JSON.stringify(current)) continue;
      this.pendingLoaded.add(name);
      added.push(info);
      addedNames.add(name);
    }
    const residents = this.residentToolNamesFrom(entries);
    const allLoadableSet = omitted === 0 ? loadableSet : new Set(allLoadable.map((info) => info.name));
    const removed = [...announced]
      .filter((name) => !allLoadableSet.has(name) && !residents.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    if (added.length === 0 && removed.length === 0) return undefined;
    return renderLoadableToolsAnnouncement(added, removed, omitted);
  }

  private shouldIntercept(name: string): boolean {
    if (!this.enabled()) return false;
    const entries = this.toolRegistry.list();
    const infoByName = indexToolInfos(entries);
    const info = infoByName.get(name);
    if (info === undefined || !this.isDynamicallyLoadable(info)) return false;
    if (!this.toolPolicy.isToolActive(info.name, info.source)) return false;
    return !this.activeLoadedToolNames(infoByName).has(name);
  }

  private describeUnavailableTool(name: string): string | undefined {
    const infoByName = indexToolInfos(this.toolRegistry.list());
    if (this.isInactiveLoadedTool(name, infoByName)) return inactiveLoadedToolOutput(name);
    const awaiting = this.awaitingSchema.has(name) && this.pendingLoaded.has(name);
    if (!awaiting && !this.shouldIntercept(name)) return undefined;
    const schema = this.schemaOf(name, infoByName);
    if (schema === undefined) return undefined;
    this.pendingLoaded.add(name);
    this.awaitingSchema.add(name);
    return notLoadedToolOutput(name, schema.parameters, this.usesCallTool());
  }

  private describeMissingTool(name: string): string | undefined {
    if (!this.enabled()) return undefined;
    if (this.toolRegistry.resolve(name) !== undefined) return undefined;
    if (!this.loadedToolNames().has(name)) return undefined;
    if (isMcpToolName(name)) {
      return (
        `Tool "${name}" was loaded but its MCP server is currently disconnected. ` +
        'It may become available again when the server reconnects; do not retry immediately.'
      );
    }
    return (
      `Tool "${name}" was loaded but is no longer registered. ` +
      'Do not retry it unless it becomes available again.'
    );
  }

  private loadableToolsFrom(entries: readonly ToolInfo[]): ToolInfo[] {
    return withToolPolicySnapshot(this.toolPolicy, () =>
      entries
        .filter(
          (info) =>
            this.isDynamicallyLoadable(info) &&
            this.toolPolicy.isToolActive(info.name, info.source),
        )
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    );
  }

  private residentToolNamesFrom(entries: readonly ToolInfo[]): Set<string> {
    const names = new Set<string>();
    for (const info of entries) {
      if (!this.isDynamicallyLoadable(info)) names.add(info.name);
    }
    return names;
  }

  private loadedToolNames(): Set<string> {
    const names = collectLoadedDynamicToolNames(this.context.get());
    for (const name of this.pendingLoaded) names.add(name);
    return names;
  }

  private activeLoadedToolNames(infoByName: ReadonlyMap<string, ToolInfo>): Set<string> {
    const names = this.loadedToolNames();
    for (const name of names) {
      if (!this.isLoadedToolActive(name, infoByName)) names.delete(name);
    }
    return names;
  }

  private isInactiveLoadedTool(name: string, infoByName: ReadonlyMap<string, ToolInfo>): boolean {
    if (!this.enabled()) return false;
    return this.loadedToolNames().has(name) && !this.isLoadedToolActive(name, infoByName);
  }

  private isLoadedToolActive(name: string, infoByName: ReadonlyMap<string, ToolInfo>): boolean {
    const info = infoByName.get(name);
    if (info !== undefined) {
      return (
        this.isDynamicallyLoadable(info) &&
        this.toolPolicy.isToolActive(name, info.source)
      );
    }
    return false;
  }

  private isDynamicallyLoadable(info: ToolInfo): boolean {
    if (info.source === 'mcp' || info.source === 'plugin') return true;
    return info.source === 'builtin' && info.disclosure === 'deferred' && isBrowserOperationToolName(info.name);
  }

  private schemaOf(name: string, infoByName: ReadonlyMap<string, ToolInfo>): Tool | undefined {
    const info = infoByName.get(name);
    const tool = this.toolRegistry.resolve(name);
    if (tool === undefined || info === undefined || !this.toolPolicy.isToolActive(name, info.source)) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  private activeEntries(entries: readonly ToolInfo[], disclosure: boolean): readonly ToolInfo[] {
    return withToolPolicySnapshot(this.toolPolicy, () => this.activeEntriesInSnapshot(entries, disclosure));
  }

  private activeEntriesInSnapshot(entries: readonly ToolInfo[], disclosure: boolean): readonly ToolInfo[] {
    let filtered: ToolInfo[] | undefined;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const active =
        this.toolPolicy.isToolActive(entry.name, entry.source) ||
        (disclosure &&
          (entry.name === SELECT_TOOLS_TOOL_NAME || entry.name === CALL_TOOL_NAME) &&
          this.toolPolicy.isToolActiveForDisclosure(entry.name, entry.source));
      const keep = active && !isLegacyToolName(entry.name) &&
        (disclosure || (entry.name !== SELECT_TOOLS_TOOL_NAME && entry.name !== CALL_TOOL_NAME));
      if (keep) {
        if (filtered !== undefined) filtered.push(entry);
        continue;
      }
      if (filtered === undefined) filtered = entries.slice(0, i);
    }
    return filtered ?? entries;
  }
}

function indexToolInfos(entries: readonly ToolInfo[]): ReadonlyMap<string, ToolInfo> {
  const byName = new Map<string, ToolInfo>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return byName;
}

function notLoadedToolOutput(name: string, parameters: Record<string, unknown> | undefined, viaCallTool: boolean): string {
  const how = viaCallTool
    ? `through ${CALL_TOOL_NAME} as {"name": "${name}", "arguments": {...}}`
    : 'by its name';
  return (
    `Tool "${name}" had not been loaded, so this call was not run. It is loaded now. ` +
    `Call it again ${how}, with arguments that match its parameter schema:\n` +
    JSON.stringify(parameters ?? {})
  );
}

function inactiveLoadedToolOutput(name: string): string {
  return (
    `Tool "${name}" was loaded but is no longer active. ` +
    'Ask the user to enable it before calling it again.'
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolSelectService,
  AgentToolSelectService,
  ScopeActivation.OnScopeCreated,
  'toolSelect',
);
