import type { AnyCordisPlugin, CordisPluginContext, CordisScopeKey } from '@kiki/cordis-runtime';

/** Machine-readable reason codes emitted when a DSH plugin exceeds the supported capability shim boundary. */
export type DshCompatIncompatibilityCode =
  | 'DSH_COMPAT_SESSION_SURFACE_UNSUPPORTED'
  | 'DSH_COMPAT_SESSION_PROJECTION_UNSUPPORTED'
  | 'DSH_COMPAT_SUBAGENT_PRESET_UNSUPPORTED'
  | 'DSH_COMPAT_CLIENT_UI_BUNDLE_UNSUPPORTED'
  | 'DSH_COMPAT_SANDBOX_POLICY_UNSUPPORTED'
  | 'DSH_COMPAT_MISSING_REQUIRED_SERVICE'
  | 'DSH_COMPAT_ABI_MISMATCH';

/** Structured compatibility check report returned before mounting a DSH package. */
export interface DshPluginCompatibilityReport {
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly compatible: boolean;
  readonly mode: 'native-shim' | 'degraded-typert-broker' | 'rejected';
  readonly injectedServices: readonly string[];
  readonly diagnostics: readonly {
    readonly code: DshCompatIncompatibilityCode;
    readonly severity: 'error' | 'warn';
    readonly serviceName?: string;
    readonly message: string;
    readonly remediation: string;
  }[];
}

/** Stable per-generation live Agent facade exposed to DSH tools, guards, and AsyncLocalStorage initiators. */
export interface DshLiveAgentFacade {
  readonly id: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly scopeKey: CordisScopeKey;
  readonly revoked: boolean;
  readonly visibleTools?: readonly {
    readonly name: string;
    readonly timeoutMs?: number | null;
  }[];
  readonly session: {
    readonly id: string;
    requestHeader(): {
      readonly provider?: string;
      readonly model?: string;
      readonly config?: Readonly<Record<string, unknown>>;
    } | undefined;
  };
}

/** Pre-execution decision returned by DSH tool guard listeners (`tools/pre-execute`). */
export type DshPreToolDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'cancel'; readonly reason?: string }
  | { readonly action: 'ask'; readonly prompt?: string };

/** Post-execution augmentation returned by DSH tool listeners (`tools/post-execute`). */
export interface DshPostToolDecision {
  readonly additionalContexts?: readonly {
    readonly text: string;
    readonly variant?: string;
  }[];
}

/** Content blocks produced by DSH `defineTool` output renderers. */
export type DshRenderedContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly mimeType: string;
      readonly dataBase64?: string;
      readonly attachmentId?: string;
    }
  | {
      readonly type: 'resource_link';
      readonly uri: string;
      readonly name?: string;
      readonly mimeType?: string;
      readonly description?: string;
    };

/** Normalized DSH tool registration bridged into Kiki's `AgentToolContribution` registry. */
export interface DshBridgedToolDefinition<TArgs = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  readonly outputJsonSchema?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number | null;
  readonly concurrencySafe?: boolean;
  execute(
    args: Readonly<TArgs>,
    exec: {
      readonly agent: DshLiveAgentFacade;
      readonly toolCallId: string;
      readonly signal: AbortSignal;
    },
  ): Promise<TOutput>;
  renderOutput?(args: Readonly<TArgs>, value: TOutput): readonly DshRenderedContentBlock[] | string;
  presentCall?(args: Readonly<TArgs>): Readonly<Record<string, unknown>> | undefined;
  presentResult?(args: Readonly<TArgs>, value: TOutput): Readonly<Record<string, unknown>> | undefined;
}

/** DSH `ctx.systemPrompt` bridge mapping static sections and step-head context reconcilers into Kiki. */
export interface DshSystemPromptShim {
  section(spec: {
    readonly id: string;
    readonly order?: number;
    readonly scope?: CordisScopeKey;
    readonly suppressRuntimeContext?: boolean;
    readonly render: (vars: Readonly<Record<string, string>>) => string | undefined;
  }): () => void;
  context(spec: {
    readonly id: string;
    readonly scope?: CordisScopeKey;
    readonly suppressRuntimeContext?: boolean;
    readonly collect: (agent: DshLiveAgentFacade) => string | undefined | Promise<string | undefined>;
  }): () => void;
  variable(name: string, resolver: (agent: DshLiveAgentFacade) => string | undefined): () => void;
}

/** Configuration for installing the Node 24 `module.registerHooks` singleton specifier redirector. */
export interface DshModuleHookOptions {
  readonly pluginRoots: readonly string[];
  readonly redirectPackages?: Readonly<Record<string, string>>;
}

/** Controller managing the DSH compatibility layer over a Kiki `CordisPluginContext`. */
export interface DshCompatController {
  installModuleHooks(options: DshModuleHookOptions): void;
  inspectPlugin(
    plugin: AnyCordisPlugin<unknown, CordisPluginContext>,
    packageMeta?: { readonly name: string; readonly version?: string },
  ): DshPluginCompatibilityReport;
  withAgentInitiator<T>(agent: DshLiveAgentFacade, operation: () => Promise<T> | T): Promise<T>;
  currentInitiator(): DshLiveAgentFacade | undefined;
  requireInitiator(): DshLiveAgentFacade;
  dispose(): Promise<void>;
}
