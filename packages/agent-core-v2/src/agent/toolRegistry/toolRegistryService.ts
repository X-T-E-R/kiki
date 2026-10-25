import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { abortable } from '#/_base/utils/abort';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';
import {
  IAgentToolRegistryService,
  type ToolReference,
  type ToolRegistrationOptions,
} from './toolRegistry';

import './builtinToolAssemblyService';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export class AgentToolRegistryService implements IAgentToolRegistryService {
  declare readonly _serviceBrand: undefined;
  private readonly tools = new Map<string, ToolEntry>();
  private readonly preparations = new Set<() => Promise<void>>();

  registerPreparation(prepare: () => Promise<void>): IDisposable {
    this.preparations.add(prepare);
    return toDisposable(() => { this.preparations.delete(prepare); });
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const prepared = Promise.all([...this.preparations].map((prepare) => prepare())).then(() => undefined);
    await (signal === undefined ? prepared : abortable(prepared, signal));
  }

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): IDisposable {
    const source = options.source ?? 'builtin';
    const entry: ToolEntry = { tool, source, disclosure: options.disclosure };
    this.unregisterTool(tool.name);
    this.tools.set(tool.name, entry);

    return toDisposable(() => {
      const current = this.tools.get(tool.name);
      if (current !== entry) return;
      this.unregisterTool(tool.name);
    });
  }

  list(): readonly ToolInfo[] {
    return [...this.tools.values()]
      .map(({ tool, source, disclosure }) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        source,
        disclosure,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listReferences(): readonly ToolReference[] {
    return [...this.tools.entries()]
      .map(([name, { source }]) => ({ name, source }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name)?.tool;
  }

  private unregisterTool(name: string): ToolEntry | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return undefined;
    this.tools.delete(name);
    return entry;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolRegistryService,
  AgentToolRegistryService,
  ScopeActivation.OnScopeCreated,
  'toolRegistry',
);
