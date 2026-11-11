/** Execution isolation tier declared for a Cordis plugin in its Kiki manifest. */
export type CordisPluginTier = 'in-process' | 'worker-isolate' | 'process-isolated';

/** Canonical Kiki extension slots available to Cordis plugin handlers. */
export type ExtensionSlotId =
  | 'E1:llm-adapter'
  | 'E2:llm-request'
  | 'E3:llm-stream'
  | 'E4:llm-error-recovery'
  | 'E5:prompt-context'
  | 'E6:context-compaction'
  | 'E7:agent-loop'
  | 'E8:tool-pipeline'
  | 'E9:subagent-dispatch'
  | 'E10:executor-registry'
  | 'E11:session-state'
  | 'E12:server-gui-slots';

/** Optional execution metadata for a Cordis extension declaration. */
export interface CordisPluginDeclaration {
  readonly tier?: CordisPluginTier;
  readonly slots?: readonly ExtensionSlotId[];
}

export interface CordisScopeTarget<TSubject extends object = object> {
  readonly subjectType?: TSubject;
  readonly scopeKey: object | undefined;
}

export interface CordisWaterfallViolationReport {
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

export interface CordisWaterfallOptions<TValue> {
  readonly eventName: string;
  readonly initialValue: TValue;
  readonly target?: CordisScopeTarget;
  readonly signal?: AbortSignal;
  readonly syncWarnBudgetMs?: number;
  readonly asyncTimeoutMs?: number;
  readonly cloneValue?: (value: TValue) => TValue;
  readonly validateStep?: (nextValue: TValue, pluginId: string) => TValue;
  readonly onViolation?: (report: CordisWaterfallViolationReport) => void;
}

export interface CordisWaterfallResult<TValue> {
  readonly value: TValue;
  readonly touchedByPlugins: readonly string[];
  readonly vetoedByPluginId?: string;
  readonly violations: readonly CordisWaterfallViolationReport[];
}

export interface CordisPluginFiberHandle {
  readonly uid: number;
  readonly pluginId: string;
  readonly phase: 'pending' | 'loading' | 'active' | 'unloading' | 'disposed' | 'failed';
  readonly ready: Promise<void>;
  updateConfig(rawConfig: unknown): Promise<void>;
  dispose(): Promise<void>;
}

export interface CordisConfigIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

export type CordisConfigValidation<TConfig> =
  | { readonly value: TConfig; readonly issues?: undefined }
  | { readonly issues: readonly CordisConfigIssue[]; readonly value?: undefined };

export interface CordisConfigSchema<TConfig = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => CordisConfigValidation<TConfig> | Promise<CordisConfigValidation<TConfig>>;
    readonly types?: { readonly input: unknown; readonly output: TConfig };
  };
}

/** Minimal typed Cordis context available to a plugin and its child plugins. */
export interface CordisPluginContext {
  readonly root: CordisPluginContext;
  readonly scopeKey: object | undefined;
  provide(name: string, value: unknown): () => void;
  get<T = unknown>(name: string): T | undefined;
  effect(setup: () => void | (() => void | Promise<void>)): () => Promise<void>;
  on<TPayload = unknown, TResult = void>(
    eventName: string,
    listener: (payload: TPayload, next?: () => Promise<TResult>) => TResult | Promise<TResult>,
    options?: { readonly prepend?: boolean; readonly global?: boolean },
  ): () => void;
  emit(eventName: string, payload: unknown, target?: CordisScopeTarget): void;
  serial<TPayload>(eventName: string, payload: TPayload, target?: CordisScopeTarget): Promise<void>;
  bail<TPayload, TResult>(eventName: string, payload: TPayload, target?: CordisScopeTarget): Promise<TResult | undefined>;
  waterfall<TValue>(options: CordisWaterfallOptions<TValue>): Promise<CordisWaterfallResult<TValue>>;
  plugin<TConfig>(plugin: AnyCordisPlugin<TConfig, CordisPluginContext>, config?: TConfig): CordisPluginFiberHandle;
}

export interface CordisFunctionPlugin<TConfig = unknown, TContext = CordisPluginContext> {
  readonly name?: string;
  readonly inject?: readonly string[] | Readonly<Record<string, { readonly required?: boolean }>>;
  readonly Config?: CordisConfigSchema<TConfig>;
  apply(context: TContext, config: TConfig): void | Promise<void>;
}

export interface CordisClassPlugin<TConfig = unknown, TContext = CordisPluginContext> {
  readonly name?: string;
  readonly inject?: readonly string[] | Readonly<Record<string, { readonly required?: boolean }>>;
  readonly Config?: CordisConfigSchema<TConfig>;
  new (context: TContext, config: TConfig): unknown;
}

/** Function, object, or class form accepted by the Cordis plugin runtime. */
export type AnyCordisPlugin<TConfig = unknown, TContext = CordisPluginContext> =
  | CordisFunctionPlugin<TConfig, TContext>
  | CordisClassPlugin<TConfig, TContext>
  | ((context: TContext, config: TConfig) => void | Promise<void>);

/** Isolated handler context serialized by the host; cancellation retires the isolate. */
export interface CordisSlotHandlerContext {
  readonly pluginId: string;
  readonly generation: number;
  readonly slot: ExtensionSlotId;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly attemptId?: string;
  readonly conversationRevision?: number;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** Handler signature for an isolated Cordis extension slot. */
export type CordisSlotHandler<TPayload = unknown, TResult = unknown> = (
  payload: TPayload,
  context: CordisSlotHandlerContext,
) => TResult | Promise<TResult>;

/** Named or default-exported slot map accepted by an isolated plugin entry module. */
export interface IsolatedCordisPlugin {
  readonly slots: Readonly<Partial<Record<ExtensionSlotId, CordisSlotHandler>>>;
}
