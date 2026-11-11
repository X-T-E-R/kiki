import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Opaque object identity representing an App, Session, or Agent routing scope. */
export type CordisScopeKey = object;

/** Routing-only event carrier tagging a dispatch target with its enclosing scope chain. */
export interface CordisScopedTarget<T extends object = object> {
  readonly subjectType?: T;
  readonly scopeKey: CordisScopeKey | undefined;
}

/** Privileged handle allowing the scope owner to rebind a scope key before durable history exists. */
export interface CordisScopeParentBinding {
  rebind(parent: CordisScopeKey): void;
}

/** Lifecycle states of a Cordis plugin fiber in the Kiki plugin plane. */
export type CordisFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'unloading'
  | 'disposed'
  | 'failed';

/** Synchronous admission gate checked before any listener or hook enters execution. */
export interface ScopeAdmissionGate {
  readonly epoch: number;
  readonly revoked: boolean;
  readonly scopeKind: 'app' | 'session' | 'agent';
  readonly sessionId?: string;
  readonly agentId?: string;
  revoke(): void;
}

/** Diagnostic emitted when a plugin listener violates waterfall continuation or synchronous ELU budgets. */
export interface WaterfallViolationReport {
  readonly pluginId: string;
  readonly eventName: string;
  readonly kind:
    | 'double_next'
    | 'missing_next'
    | 'sync_budget_exceeded'
    | 'async_timeout'
    | 'unhandled_exception'
    | 'revoked_late_return';
  readonly syncDurationMs: number;
  readonly totalDurationMs: number;
  readonly detail?: string;
}

/** Options controlling once-guarded waterfall dispatch over registered plugin listeners. */
export interface GuardedWaterfallOptions<TValue> {
  readonly eventName: string;
  readonly initialValue: TValue;
  readonly target?: CordisScopedTarget;
  readonly signal?: AbortSignal;
  readonly syncWarnBudgetMs?: number;
  readonly asyncTimeoutMs?: number;
  readonly cloneValue?: (value: TValue) => TValue;
  readonly validateStep?: (nextValue: TValue, pluginId: string) => TValue;
  readonly onViolation?: (report: WaterfallViolationReport) => void;
}

/** Result of executing a guarded waterfall chain with provenance of participating plugins. */
export interface GuardedWaterfallResult<TValue> {
  readonly value: TValue;
  readonly touchedByPlugins: readonly string[];
  readonly vetoedByPluginId?: string;
  readonly violations: readonly WaterfallViolationReport[];
}

/** Standard Cordis function plugin signature supported by Kiki Tier 1 and DSH shims. */
export interface CordisFunctionPlugin<TConfig = unknown, TContext = CordisPluginContext> {
  readonly name?: string;
  readonly inject?: readonly string[] | Readonly<Record<string, { readonly required?: boolean }>>;
  readonly Config?: StandardSchemaV1<unknown, TConfig>;
  apply(ctx: TContext, config: TConfig): void | Promise<void>;
}

/** Standard Cordis class plugin constructor signature supported by Kiki Tier 1 and DSH shims. */
export interface CordisClassPlugin<TConfig = unknown, TContext = CordisPluginContext> {
  readonly name?: string;
  readonly inject?: readonly string[] | Readonly<Record<string, { readonly required?: boolean }>>;
  readonly Config?: StandardSchemaV1<unknown, TConfig>;
  new (ctx: TContext, config: TConfig): unknown;
}

/** Union of supported Cordis plugin definitions. */
export type AnyCordisPlugin<TConfig = unknown, TContext = CordisPluginContext> =
  | CordisFunctionPlugin<TConfig, TContext>
  | CordisClassPlugin<TConfig, TContext>
  | ((ctx: TContext, config: TConfig) => void | Promise<void>);

/** Handle to a mounted Cordis plugin fiber within the runtime plane. */
export interface CordisFiberHandle {
  readonly uid: number;
  readonly pluginId: string;
  readonly phase: CordisFiberPhase;
  readonly ready: Promise<void>;
  updateConfig(rawConfig: unknown): Promise<void>;
  dispose(): Promise<void>;
}

/** Minimal typed surface of the underlying Cordis Context exposed to host bridges and plugins. */
export interface CordisPluginContext {
  readonly root: CordisPluginContext;
  readonly scopeKey: CordisScopeKey | undefined;
  provide(name: string, value: unknown): () => void;
  get<T = unknown>(name: string): T | undefined;
  effect(setup: () => void | (() => void | Promise<void>)): () => Promise<void>;
  on<TPayload = unknown, TResult = void>(
    eventName: string,
    listener: (payload: TPayload, next?: () => Promise<TResult>) => TResult | Promise<TResult>,
    options?: { readonly prepend?: boolean; readonly global?: boolean },
  ): () => void;
  emit(eventName: string, payload: unknown, target?: CordisScopedTarget): void;
  serial<TPayload>(eventName: string, payload: TPayload, target?: CordisScopedTarget): Promise<void>;
  bail<TPayload, TResult>(
    eventName: string,
    payload: TPayload,
    target?: CordisScopedTarget,
  ): Promise<TResult | undefined>;
  waterfall<TValue>(options: GuardedWaterfallOptions<TValue>): Promise<GuardedWaterfallResult<TValue>>;
  plugin<TConfig>(
    plugin: AnyCordisPlugin<TConfig, CordisPluginContext>,
    config?: TConfig,
  ): CordisFiberHandle;
}

/** Singleton ABI registry ensuring a single module identity across bundled host and dynamic ESM plugins. */
export interface CordisCanonicalAbi {
  readonly version: string;
  readonly cordisNamespace: unknown;
  readonly cosmokitNamespace: unknown;
  readonly schemasteryNamespace: unknown;
  readonly scopeNamespace: {
    createScope(
      parentCtx: CordisPluginContext,
      key: CordisScopeKey,
    ): { readonly ctx: CordisPluginContext; dispose(): Promise<void> };
    bindScopeParent(key: CordisScopeKey, parent: CordisScopeKey): CordisScopeParentBinding;
    scopeParentOf(key: CordisScopeKey): CordisScopeKey | undefined;
    scopeChainOf(key: CordisScopeKey | undefined): readonly CordisScopeKey[];
    scopeOf(ctx: CordisPluginContext): CordisScopeKey | undefined;
    scopeTarget<T extends object>(subject: T, key: CordisScopeKey | undefined): CordisScopedTarget<T>;
  };
}
