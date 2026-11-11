import {
  Context,
  FiberState,
  scope,
  type AnyCordisPlugin,
  type CordisScopeKey,
  type Fiber,
} from '@kiki/cordis-runtime';

import { Lsp } from './vendor/lsp/src/index';
import { DshCompatError, type DshCompatLoadDiagnostic, inspectDshPlugin } from './diagnostics';

const { createScope } = scope;
import { bindDshCompatToExtensionSlots, type HostExtensionPortRegistryLike } from './extensionSlotBridge';
import { DshHostServicesBridge, type DshHostPorts } from './hostServicesBridge';
import { type DshAgentInit, DshAgentIdentityRegistry } from './initiatorAls';
import { assertDshModuleAbi, installDshModuleHooks, type InstalledDshModuleHooks } from './moduleHooks';
import { createNodeHostPorts } from './nodeHostPorts';
import { importDshPluginModule } from './pluginModuleLoader';
import { DshSystemPromptBridge } from './systemPromptBridge';
import { ToolRuntimeBridge } from './toolsBridge';
import type {
  DshCompatController,
  DshLiveAgentFacade,
  DshModuleHookOptions,
  DshPluginCompatibilityReport,
} from './index';

export interface CreateDshCompatEnvironmentOptions {
  readonly context?: Context;
  readonly hostPorts?: DshHostPorts;
  readonly workspaceRoot?: string | ((agent: object) => string | undefined | Promise<string | undefined>);
  readonly nativeTools?: (agent?: DshLiveAgentFacade) => readonly { name: string; timeoutMs?: number | null }[];
  readonly moduleHooks?: DshModuleHookOptions;
}

export interface MountedDshPluginHandle {
  readonly fiber: Fiber;
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

async function waitForFiberActive(fiber: Fiber): Promise<void> {
  await fiber.await();
  if (fiber.state === FiberState.ACTIVE) return;
  await new Promise<void>((resolve, reject) => {
    const check = (): boolean => {
      if (fiber.state === FiberState.ACTIVE) {
        cleanup();
        resolve();
        return true;
      }
      if (fiber.state === FiberState.FAILED || fiber.state === FiberState.DISPOSED || fiber.uid === null) {
        cleanup();
        const err = (fiber as unknown as { _error?: unknown; error?: unknown })._error
          ?? (fiber as unknown as { error?: unknown }).error;
        reject(err instanceof Error ? err : new Error(`DSH plugin fiber "${fiber.name}" failed to activate`));
        return true;
      }
      return false;
    };
    const offStatus = fiber.ctx.root.on('internal/status', (target) => {
      if (target === fiber) check();
    }, { global: true });
    const offPlugin = fiber.ctx.root.on('internal/plugin', (target) => {
      if (target === fiber) check();
    }, { global: true });
    const cleanup = () => {
      offStatus();
      offPlugin();
    };
    check();
  });
}

async function quiesceFiber(fiber: Fiber): Promise<void> {
  await Promise.resolve(fiber.dispose());
  while (fiber.inertia !== undefined) {
    await fiber.inertia;
  }
}

export class DshCompatEnvironment implements DshCompatController {
  readonly ctx: Context;
  readonly initiators: DshAgentIdentityRegistry;
  readonly systemPrompt: DshSystemPromptBridge;
  readonly tools: ToolRuntimeBridge;
  readonly lsp: Lsp;
  readonly hostServices: DshHostServicesBridge;
  readonly ready: Promise<void>;

  private readonly disposeHostServices: () => Promise<void>;
  private readonly serviceFiber: Fiber;
  private readonly mountedFibers = new Set<Fiber>();
  private readonly scopedHandles = new Set<{ dispose(): Promise<void> }>();
  private readonly slotUnbinders = new Set<() => void>();
  private installedHooks: InstalledDshModuleHooks | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(options: CreateDshCompatEnvironmentOptions = {}) {
    if (options.moduleHooks !== undefined) assertDshModuleAbi();
    this.serviceFiber = (options.context ?? new Context()).plugin({ name: 'dsh-compat/services', apply() {} });
    this.ready = this.serviceFiber.await().then(() => {});
    this.ctx = this.serviceFiber.ctx;
    this.initiators = new DshAgentIdentityRegistry();
    this.ctx.provide('agents', {
      withInitiator: <T>(agent: DshLiveAgentFacade, op: () => Promise<T> | T) =>
        this.initiators.withInitiator(agent, op),
      currentInitiator: () => this.initiators.currentInitiator(),
      requireInitiator: () => this.initiators.requireInitiator(),
    });
    const ports = options.hostPorts ?? createNodeHostPorts({ workspaceRoot: options.workspaceRoot });
    this.hostServices = new DshHostServicesBridge(this.ctx, ports);
    this.disposeHostServices = this.hostServices.install();
    this.systemPrompt = new DshSystemPromptBridge(this.ctx, this.initiators);
    this.lsp = (this.ctx.get('lsp') as Lsp | undefined) ?? new Lsp(this.ctx);
    this.tools = new ToolRuntimeBridge(this.ctx, this.initiators, {
      nativeTools: options.nativeTools,
      attachments: () => this.hostServices.attachmentStore,
    });
    if (options.moduleHooks !== undefined) this.installModuleHooks(options.moduleHooks);
  }

  get loadDiagnostics(): readonly DshCompatLoadDiagnostic[] {
    return this.installedHooks?.diagnostics ?? [];
  }

  installModuleHooks(options: DshModuleHookOptions): void {
    this.installedHooks?.dispose();
    this.installedHooks = installDshModuleHooks(options);
  }

  availableServiceNames(): ReadonlySet<string> {
    const names = new Set<string>([
      'agents',
      'workingDirectory',
      'fs',
      'subprocess',
      'shell',
      'attachments',
      'settings',
      'systemPrompt',
      'lsp',
      'tools',
    ]);
    for (const optional of ['llm', 'credentials', 'storageDomain', 'typert']) {
      if (this.ctx.get(optional as any) !== undefined) names.add(optional);
    }
    return names;
  }

  inspectPlugin(
    plugin: AnyCordisPlugin,
    packageMeta?: { readonly name: string; readonly version?: string },
  ): DshPluginCompatibilityReport {
    const inferredName = packageMeta?.name
      ?? (typeof plugin === 'object' && plugin !== null && 'name' in plugin && typeof plugin.name === 'string'
        ? plugin.name
        : typeof plugin === 'function' && plugin.name
          ? plugin.name
          : 'anonymous-dsh-plugin');
    return inspectDshPlugin(
      plugin,
      { name: inferredName, ...(packageMeta?.version === undefined ? {} : { version: packageMeta.version }) },
      this.availableServiceNames(),
    );
  }

  acquireAgent(init: Omit<DshAgentInit, 'visibleTools'> & {
    readonly visibleTools?: () => readonly { readonly name: string; readonly timeoutMs?: number | null }[];
  }): DshLiveAgentFacade {
    let facadeRef: DshLiveAgentFacade | undefined;
    const facade = this.initiators.acquire({
      ...init,
      visibleTools: init.visibleTools ?? (() => this.tools.visibleTools(facadeRef)),
    });
    facadeRef = facade;
    return facade;
  }

  revokeAgent(agent: DshLiveAgentFacade): void {
    this.initiators.revoke(agent);
  }

  withAgentInitiator<T>(agent: DshLiveAgentFacade, operation: () => Promise<T> | T): Promise<T> {
    return this.initiators.withInitiator(agent, operation);
  }

  currentInitiator(): DshLiveAgentFacade | undefined {
    return this.initiators.currentInitiator();
  }

  requireInitiator(): DshLiveAgentFacade {
    return this.initiators.requireInitiator();
  }

  createScopedContext(scopeKey: CordisScopeKey, parentScopeKey?: CordisScopeKey): {
    readonly ctx: Context;
    dispose(): Promise<void>;
  } {
    const created = createScope(
      this.ctx,
      scopeKey,
      parentScopeKey === undefined ? undefined : { parent: parentScopeKey },
    );
    this.scopedHandles.add(created);
    return {
      ctx: created.ctx,
      dispose: async () => {
        this.scopedHandles.delete(created);
        await created.dispose();
      },
    };
  }

  async mountPlugin<TConfig = unknown>(
    pluginModuleOrDef: unknown,
    config?: TConfig,
    options: {
      readonly packageMeta?: { readonly name: string; readonly version?: string };
      readonly targetCtx?: Context;
      readonly skipCompatibilityCheck?: boolean;
    } = {},
  ): Promise<MountedDshPluginHandle> {
    await this.ready;
    if (this.disposed) throw new Error('DshCompatEnvironment is disposed');
    const normalizedPlugin = normalizeCordisPluginExport(pluginModuleOrDef);
    if (!options.skipCompatibilityCheck) {
      const report = this.inspectPlugin(normalizedPlugin, options.packageMeta);
      if (!report.compatible) {
        const primary = report.diagnostics[0];
        throw new DshCompatError(primary.code, primary.message, {
          serviceName: primary.serviceName,
          report,
        });
      }
    }
    const hostCtx = options.targetCtx ?? this.ctx;
    const fiber = hostCtx.plugin(normalizedPlugin as any, config as any);
    this.mountedFibers.add(fiber);
    const ready = waitForFiberActive(fiber);
    try {
      await ready;
    } catch (error) {
      this.mountedFibers.delete(fiber);
      await quiesceFiber(fiber);
      throw error;
    }
    return {
      fiber,
      ready,
      dispose: async () => {
        this.mountedFibers.delete(fiber);
        await quiesceFiber(fiber);
      },
    };
  }

  async importAndMountPlugin<TConfig = unknown>(
    entryPathOrUrl: string,
    config?: TConfig,
    options: {
      readonly packageMeta?: { readonly name: string; readonly version?: string };
      readonly targetCtx?: Context;
    } = {},
  ): Promise<MountedDshPluginHandle> {
    const mod = await importDshPluginModule(entryPathOrUrl);
    return  this.mountPlugin(mod, config, options);
  }

  bindExtensionSlots(options: {
    readonly pluginId?: string;
    readonly registry: HostExtensionPortRegistryLike;
    readonly resolveAgent: (sessionId: string, agentId: string) => DshLiveAgentFacade;
  }): () => void {
    const unbind = bindDshCompatToExtensionSlots({
      pluginId: options.pluginId,
      registry: options.registry,
      ctx: this.ctx,
      initiators: this.initiators,
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      attachments: () => this.hostServices.attachmentStore,
      resolveAgent: options.resolveAgent,
    });
    this.slotUnbinders.add(unbind);
    return () => {
      this.slotUnbinders.delete(unbind);
      unbind();
    };
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.disposal ??= Promise.resolve().then(() => this.disposeInner());
  }

  private async disposeInner(): Promise<void> {
    for (const unbind of [...this.slotUnbinders].toReversed()) {
      unbind();
    }
    this.slotUnbinders.clear();
    await this.tools.dispose();
    try {
      for (const fiber of [...this.mountedFibers].toReversed()) await quiesceFiber(fiber);
      for (const scoped of [...this.scopedHandles].toReversed()) await scoped.dispose();
      await this.systemPrompt.dispose();
      await this.disposeHostServices();
    } finally {
      await quiesceFiber(this.serviceFiber);
      this.initiators.dispose();
      this.mountedFibers.clear();
      this.scopedHandles.clear();
      this.installedHooks?.dispose();
      this.installedHooks = undefined;
    }
  }
}

function normalizeCordisPluginExport(candidate: unknown): AnyCordisPlugin {
  if (typeof candidate === 'function') {
    return candidate as AnyCordisPlugin;
  }
  if (typeof candidate === 'object' && candidate !== null) {
    const record = candidate as Record<string, unknown>;
    if ('default' in record && record['default'] !== undefined && !('apply' in record)) {
      return normalizeCordisPluginExport(record['default']);
    }
    if ('apply' in record && typeof record['apply'] === 'function') {
      return candidate as AnyCordisPlugin;
    }
  }
  throw new TypeError('Invalid Cordis plugin module: expected function, Service class default export, or { apply } namespace.');
}

export function createDshCompatEnvironment(options?: CreateDshCompatEnvironmentOptions): DshCompatEnvironment {
  return new DshCompatEnvironment(options);
}
