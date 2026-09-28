import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import type { Tool } from '#/kosong/contract/tool';
import type { ToolCall } from '#/kosong/contract/message';
import { IModelCatalog } from '#/kosong/model/catalog';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { CompactionCompleted } from '#/agent/fullCompaction/compactionOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isLegacyToolName } from '#/agent/toolPolicy/toolAliases';
import { isMcpToolName, type ToolInfo } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';

import {
  collectLoadedDynamicToolNames,
  foldAnnouncedToolNames,
  renderLoadableToolsAnnouncement,
  stripDynamicToolContext,
} from './dynamicTools';
import { TOOL_SELECT_FLAG_ID } from './flag';
import {
  IAgentToolSelectService,
  CALL_TOOL_NAME,
  SELECT_TOOLS_TOOL_NAME,
  type LoadToolsResult,
  type ShapedToolEntry,
} from './toolSelect';

export const toolSelectPendingLoadedKey = defineState<Set<string>>(
  'toolSelect.pendingLoaded',
  () => new Set(),
);

export class AgentToolSelectService extends Service implements IAgentToolSelectService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
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
      const model = this.modelCatalog.getRequester(this.profile.resolveModelContext().modelAlias).model;
      return model.protocol === 'openai' || model.protocol === 'openai_responses' || model.protocol === 'anthropic';
    } catch {
      return false;
    }
  }

  shapeTools(entries: readonly ToolInfo[]): readonly ShapedToolEntry[] {
    const disclosure = this.enabled();
    const activeEntries = this.activeEntries(entries, disclosure);
    if (!disclosure) return activeEntries;
    const loaded = this.loadedToolNames();
    const model = this.modelCatalog.getRequester(this.profile.resolveModelContext().modelAlias).model;
    const kimiProvider = model.providerType === 'kimi' || isOAuthCatalogVendor(model.providerType);
    const shaped: ShapedToolEntry[] = [];
    for (const entry of activeEntries) {
      if (entry.name === SELECT_TOOLS_TOOL_NAME || entry.name === CALL_TOOL_NAME) {
        if (entry.name !== CALL_TOOL_NAME || !kimiProvider) shaped.push(entry);
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

  shapeHistory(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.enabled()) return stripDynamicToolContext(messages);
    let shaped: ContextMessage[] | undefined;
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i]!;
      const tools = message.tools;
      if (tools === undefined || !tools.some((tool) => this.isHistoricallyDisabled(tool.name))) {
        if (shaped !== undefined) shaped.push(message);
        continue;
      }
      const kept = tools.filter((tool) => !this.isHistoricallyDisabled(tool.name));
      if (shaped === undefined) shaped = messages.slice(0, i);
      if (kept.length > 0) shaped.push({ ...message, tools: kept });
      else if (message.content.length > 0 || message.toolCalls.length > 0) {
        const { tools: _tools, ...rest } = message;
        void _tools;
        shaped.push(rest);
      }
    }
    return shaped ?? messages;
  }

  private isHistoricallyDisabled(name: string): boolean {
    const info = this.toolRegistry.list().find((entry) => entry.name === name);
    if (info !== undefined) return !this.toolPolicy.isToolActive(name, info.source);
    return isMcpToolName(name) && !this.toolPolicy.isToolActive(name, 'mcp');
  }

  load(names: readonly string[]): LoadToolsResult {
    const loadable = new Set(this.loadableToolNames());
    const loaded = this.activeLoadedToolNames();
    const toLoad: string[] = [];
    const alreadyAvailable: string[] = [];
    const unknown: string[] = [];
    for (const name of new Set(names)) {
      if (loaded.has(name)) {
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
    if (typeof name !== 'string' || args === null || typeof args !== 'object' || Array.isArray(args) ||
      !this.activeLoadedToolNames().has(name) || this.toolRegistry.resolve(name) === undefined) return call;
    return { ...call, name, arguments: JSON.stringify(args) };
  }

  drainPendingToolSchemas(): readonly Tool[] | undefined {
    if (!this.enabled() || this.pendingLoaded.size === 0) return undefined;
    const names = [...this.pendingLoaded].toSorted((a, b) => a.localeCompare(b));
    const tools: Tool[] = [];
    for (const name of names) {
      const tool = this.schemaOf(name);
      if (tool === undefined) continue;
      this.pendingLoaded.delete(name);
      tools.push(tool);
    }
    return tools.length === 0 ? undefined : tools;
  }

  loadableToolsAnnouncement(): string | undefined {
    if (!this.enabled()) return undefined;
    const loadable = this.loadableToolNames();
    const loadableSet = new Set(loadable);
    const announced = foldAnnouncedToolNames(this.context.get());
    const added = loadable.filter((name) => !announced.has(name));
    const latestSchemas = new Map<string, Tool>();
    for (const message of this.context.get()) {
      for (const tool of message.tools ?? []) latestSchemas.set(tool.name, tool);
    }
    for (const name of loadable) {
      if (this.pendingLoaded.has(name) || !announced.has(name) || added.includes(name)) continue;
      const info = this.toolRegistry.list().find((entry) => entry.name === name);
      if (info?.source !== 'mcp' && info?.source !== 'plugin') continue;
      const previous = latestSchemas.get(name);
      const current = this.schemaOf(name);
      if (previous === undefined || current === undefined ||
        JSON.stringify(previous) === JSON.stringify(current)) continue;
      this.pendingLoaded.add(name);
      added.push(name);
    }
    const removed = [...announced]
      .filter((name) => !loadableSet.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    if (added.length === 0 && removed.length === 0) return undefined;
    return renderLoadableToolsAnnouncement(added, removed);
  }

  private shouldIntercept(name: string): boolean {
    if (!this.enabled()) return false;
    const info = this.toolRegistry.list().find((entry) => entry.name === name);
    if (info === undefined || !this.isDynamicallyLoadable(info)) return false;
    if (!this.loadableToolNames().includes(name)) return false;
    return !this.activeLoadedToolNames().has(name);
  }

  private describeUnavailableTool(name: string): string | undefined {
    if (this.isInactiveLoadedTool(name)) return inactiveLoadedToolOutput(name);
    if (!this.shouldIntercept(name)) return undefined;
    return notLoadedToolOutput(name);
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

  private loadableToolNames(): string[] {
    return this.toolRegistry
      .list()
      .filter(
        (info) =>
          this.isDynamicallyLoadable(info) &&
          this.toolPolicy.isToolActive(info.name, info.source),
      )
      .map((info) => info.name)
      .toSorted((a, b) => a.localeCompare(b));
  }

  private loadedToolNames(): Set<string> {
    const names = collectLoadedDynamicToolNames(this.context.get());
    for (const name of this.pendingLoaded) names.add(name);
    return names;
  }

  private activeLoadedToolNames(): Set<string> {
    const names = this.loadedToolNames();
    for (const name of names) {
      if (!this.isLoadedToolActive(name)) names.delete(name);
    }
    return names;
  }

  private isInactiveLoadedTool(name: string): boolean {
    if (!this.enabled()) return false;
    return this.loadedToolNames().has(name) && !this.isLoadedToolActive(name);
  }

  private isLoadedToolActive(name: string): boolean {
    const info = this.toolRegistry.list().find((entry) => entry.name === name);
    if (info !== undefined) {
      return (
        this.isDynamicallyLoadable(info) &&
        this.toolPolicy.isToolActive(name, info.source)
      );
    }
    if (isMcpToolName(name)) return this.toolPolicy.isToolActive(name, 'mcp');
    return false;
  }

  private isDynamicallyLoadable(info: ToolInfo): boolean {
    return info.source === 'mcp' || info.source === 'plugin' || info.disclosure === 'deferred';
  }

  private schemaOf(name: string): Tool | undefined {
    const tool = this.toolRegistry.resolve(name);
    if (tool === undefined) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  private activeEntries(entries: readonly ToolInfo[], disclosure: boolean): readonly ToolInfo[] {
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

function notLoadedToolOutput(name: string): string {
  return (
    `Tool "${name}" is available but not loaded. ` +
    `Call ${SELECT_TOOLS_TOOL_NAME} with ["${name}"] first, then call the tool.`
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
