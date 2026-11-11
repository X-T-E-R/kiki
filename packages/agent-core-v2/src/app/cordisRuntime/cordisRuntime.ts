import type {
  AnyCordisPlugin,
  CordisCanonicalAbi,
  CordisFiberHandle,
  CordisFiberPhase,
  CordisPluginContext,
  CordisScopeKey,
  CordisScopedTarget,
  ScopeAdmissionGate,
  WaterfallViolationReport,
} from '@kiki/cordis-runtime';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';

/** Execution trust and isolation tier declared by or assigned to a Kiki plugin. */
export type PluginExecutionTier = 'in-process' | 'worker-isolate' | 'process-isolated';

/** Resource and queue budgets enforced on plugin worker isolates and child processes. */
export interface PluginIsolationBudget {
  readonly maxWorkers: number;
  readonly maxActiveRequests: number;
  readonly maxQueuedRequests: number;
  readonly maxQueuedBytes: number;
  readonly maxPayloadBytes: number;
  readonly callTimeoutMs: number;
  readonly oldSpaceMb: number;
}

/** Envelope for invoking an asynchronous proposal or tool handler inside a Worker Isolate or Tier 2 process. */
export interface IsolatedPluginInvocation<TPayload = unknown> {
  readonly pluginId: string;
  readonly generation: number;
  readonly slot: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly attemptId?: string;
  readonly conversationRevision?: number;
  readonly payload: TPayload;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Validated response envelope returned from an isolated plugin execution domain. */
export interface IsolatedPluginResult<TResult = unknown> {
  readonly pluginId: string;
  readonly generation: number;
  readonly attemptId?: string;
  readonly conversationRevision?: number;
  readonly durationMs: number;
  readonly value: TResult;
}

/** Runtime status snapshot of a mounted Cordis plugin unit. */
export interface MountedCordisPluginInfo {
  readonly pluginId: string;
  readonly tier: PluginExecutionTier;
  readonly generation: number;
  readonly phase: CordisFiberPhase;
  readonly declaredSlots: readonly string[];
  readonly violationCount: number;
  readonly quarantinedReason?: string;
}

/** Controlled host facade services explicitly exposed onto the root Cordis `ctx` (`kiki.*` namespace). */
export interface KikiCordisHostPorts {
  readonly config: {
    getPluginSettings(pluginId: string): Readonly<Record<string, unknown>>;
  };
  readonly workspace: {
    resolveSessionWorkspaceRoot(sessionId: string): string | undefined;
  };
  readonly secrets: {
    getPluginSecret(pluginId: string, key: string): Promise<string | undefined>;
  };
}

/** App-scoped service managing the isolated Worker/Process execution pool for plugins. */
export interface IPluginIsolationPoolService {
  readonly _serviceBrand: undefined;

  readonly budget: PluginIsolationBudget;
  registerWorkerPlugin(input: {
    readonly pluginId: string;
    readonly entryPath: string;
    readonly settings: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly generation: number; dispose(): Promise<void> }>;
  invoke<TPayload, TResult>(
    invocation: IsolatedPluginInvocation<TPayload>,
  ): Promise<IsolatedPluginResult<TResult>>;
  terminatePlugin(pluginId: string, reason: string): Promise<void>;
}

export const IPluginIsolationPoolService: ServiceIdentifier<IPluginIsolationPoolService> =
  createDecorator<IPluginIsolationPoolService>('pluginIsolationPoolService');

/** App-scoped service owning the single true Cordis plugin plane and `Session`/`Agent` scope synchronization. */
export interface ICordisRuntimeService {
  readonly _serviceBrand: undefined;

  readonly abi: CordisCanonicalAbi;
  readonly rootContext: CordisPluginContext;
  readonly onDidChangePlugins: Event<void>;
  readonly onDidReportViolation: Event<WaterfallViolationReport>;

  sessionScopeKey(sessionId: string): CordisScopeKey | undefined;
  agentScopeKey(sessionId: string, agentId: string): CordisScopeKey | undefined;
  admissionGateForSession(sessionId: string): ScopeAdmissionGate | undefined;
  admissionGateForAgent(sessionId: string, agentId: string): ScopeAdmissionGate | undefined;
  scopeTargetForSession<T extends object>(sessionId: string, subject: T): CordisScopedTarget<T>;
  scopeTargetForAgent<T extends object>(
    sessionId: string,
    agentId: string,
    subject: T,
  ): CordisScopedTarget<T>;

  provideHostService(name: string, implementation: unknown): IDisposable;

  mountInProcessPlugin<TConfig>(input: {
    readonly pluginId: string;
    readonly declaredSlots: readonly string[];
    readonly plugin: AnyCordisPlugin<TConfig, CordisPluginContext>;
    readonly config?: TConfig;
    readonly scope?: { readonly sessionId: string; readonly agentId?: string };
  }): CordisFiberHandle;

  unmountPlugin(pluginId: string): Promise<void>;
  quarantinePlugin(pluginId: string, reason: string): Promise<void>;
  listMountedPlugins(): readonly MountedCordisPluginInfo[];
}

export const ICordisRuntimeService: ServiceIdentifier<ICordisRuntimeService> =
  createDecorator<ICordisRuntimeService>('cordisRuntimeService');
