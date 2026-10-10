import { createHash } from 'node:crypto';
import type { ExecutionBinding } from '@kiki/protocol';

import {
  createDecorator,
  type ServiceIdentifier,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type {
  ExecutorBinding,
  ExecutorValidationResult,
} from '@kiki/agent-profiles/ports';

import type { Hooks } from '#/hooks';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import type { NegotiatedExecutorCapabilities } from './capabilities';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';

export type AgentExecutorProtocol =
  | 'native'
  | 'acp-v1'
  | 'codex-app-server'
  | (string & Record<never, never>);

export type AgentExecutorBinarySource =
  | { readonly id: string; readonly kind: 'explicit-path'; readonly path: string }
  | { readonly id: string; readonly kind: 'env'; readonly name: string }
  | {
      readonly id: string;
      readonly kind: 'glob';
      readonly pattern: string;
      readonly maxDepth?: number;
    }
  | {
      readonly id: string;
      readonly kind: 'path-lookup';
      readonly command: string;
      readonly requiredBasename?: string;
    }
  | { readonly id: string; readonly kind: 'node-script'; readonly path: string };

export interface AgentExecutorVersionProbe {
  readonly args: readonly string[];
}

export interface AgentExecutorSourceProbe {
  readonly id: string;
  readonly kind: AgentExecutorBinarySource['kind'];
  readonly available: boolean;
  readonly command?: string;
  /** Arguments placed before every other argument, e.g. the script a `node-script` source runs. */
  readonly launchArgs?: readonly string[];
  readonly version?: string;
  readonly diagnostic?: string;
  /** Stable reason code for `diagnostic`, e.g. {@link ANTIGRAVITY_IDE_NOT_ACP}. */
  readonly diagnosticCode?: string;
}

/** The Antigravity IDE was found where the Antigravity ACP CLI was expected. */
export const ANTIGRAVITY_IDE_NOT_ACP = 'antigravity_ide_not_acp';

export type AgentExecutorOptionValue = string | number | boolean;
export type AgentExecutorOptions = Readonly<
  Record<string, AgentExecutorOptionValue>
>;

export interface AgentExecutorPermissionModeMapping {
  readonly configId?: string;
  readonly configCategory?: string;
  readonly manual: string | boolean;
  readonly auto: string | boolean;
  readonly yolo: string | boolean;
}

export type AgentExecutorProfileDelivery = 'system_prompt_override';
export type ExecutorPromptDelivery = 'append' | 'replace' | 'preamble';
export interface AgentExecutorPermission {
  readonly via: 'config_option' | 'session_mode' | 'argv' | 'turn_param';
  readonly flag?: string;
  readonly configId?: string;
  readonly configCategory?: string;
  readonly manual: string;
  readonly review?: string;
  readonly auto: string;
  readonly yolo: string;
  readonly trustEngineSettings?: boolean;
}

/**
 * Which credential an external engine's own configuration already carries.
 * `api_key_env`, `auth_token_env`, `settings_env` and `api_key_helper` are
 * observed directly; `oauth_login` and `api_key` are what the vendor CLI
 * reports when the origin is outside what Kiki can see.
 */
export type AgentExecutorCredentialSource =
  | 'oauth_login'
  | 'api_key_env'
  | 'auth_token_env'
  | 'settings_env'
  | 'api_key_helper'
  | 'api_key'
  | 'external_backend'
  | 'none'
  | 'unknown';

export type AgentExecutorDiagnosticRule =
  | { readonly kind: 'message'; readonly severity: 'info' | 'warning'; readonly message: string }
  | { readonly kind: 'env'; readonly name: string; readonly present: string; readonly absent: string }
  | { readonly kind: 'path'; readonly path: string; readonly envHome?: string;
      readonly present: string; readonly absent: string; readonly absentSeverity: 'info' | 'warning' }
  | { readonly kind: 'dependency'; readonly command: string; readonly args: readonly string[];
      readonly unavailable: string; readonly failed: string; readonly label?: string;
      readonly installHint?: string }
  | { readonly kind: 'flag'; readonly args: readonly string[]; readonly stable: string;
      readonly fallback: string; readonly stableMessage: string; readonly fallbackMessage: string;
      readonly missingMessage: string }
  | { readonly kind: 'version'; readonly min: string; readonly maxExclusive?: string; readonly warning: string; readonly normal: string };

export interface AgentExecutorDescriptor {
  readonly id: string;
  readonly protocol: AgentExecutorProtocol;
  readonly label?: string;
  readonly command?: string;
  readonly sources?: readonly AgentExecutorBinarySource[];
  readonly source?: string;
  readonly selectedSource?: string;
  readonly sourceProbes?: readonly AgentExecutorSourceProbe[];
  /** Resolved launch prefix of the selected source; spawners place it before every other argument. */
  readonly launchArgs?: readonly string[];
  /** Name of the program Kiki launches when it differs from the engine label, e.g. an ACP adapter package. */
  readonly programLabel?: string;
  readonly version?: string;
  readonly versionProbe?: AgentExecutorVersionProbe;
  readonly diagnostics?: readonly AgentExecutorDiagnosticRule[];
  readonly auth?: { readonly kind: 'command-json'; readonly command: string;
    readonly args: readonly string[]; readonly loggedInKey: string }
    | { readonly kind: 'codex-account' }
    | { readonly kind: 'claude-credentials'; readonly command: string;
        readonly args: readonly string[] };
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Environment variable that names this engine's own configuration
   * directory, when the engine has one. A user-configured `homeDir` is
   * published under it for both the check and the launch, so the engine reads
   * the same settings either way.
   */
  readonly homeEnv?: string;
  /** User-configured configuration directory for this engine, from `[agent_executor_overrides]`. */
  readonly homeDir?: string;
  /** User-configured launch flags, appended after the descriptor's own. */
  readonly extraArgs?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly modelBinding?: string;
  readonly modelArgs?: readonly string[];
  readonly modelConfigCategory?: string;
  readonly modelConfigId?: string;
  readonly thoughtConfigCategory?: string;
  readonly thoughtConfigId?: string;
  readonly permissionModeMapping?: AgentExecutorPermissionModeMapping;
  readonly permission?: AgentExecutorPermission;
  readonly promptDeliveries?: readonly ExecutorPromptDelivery[];
  readonly supportsMcp?: boolean;
  /** Only forward transports accepted by this ACP harness; absent allows every ACP transport. */
  readonly mcpTransports?: readonly ('stdio' | 'http' | 'sse')[];
  readonly defaultProfile?: boolean;
  readonly installHint?: string;
  readonly loginCommand?: readonly string[];
  /** Environment variable the engine reads an API key from, when the engine accepts one as an alternative to signing in. */
  readonly apiKeyEnv?: string;
  readonly steerDelivery?: 'native' | 'next_turn_preamble';
  /**
   * Declares that the harness accepts the frozen profile as a real system
   * prompt through the `session/new` `_meta.systemPromptOverride` extension.
   * When absent, the profile rides inside the first user prompt instead.
   * Revision-neutral: it shapes only newly created sessions, so toggling it
   * must not invalidate persisted executor sessions.
   */
  readonly profileDelivery?: AgentExecutorProfileDelivery;
  readonly revision: string;
}

export interface AgentExecutionStatus {
  readonly state:
    | 'idle'
    | 'starting'
    | 'running'
    | 'cancelling'
    | 'broken';
  readonly turnId?: number;
}

export interface AgentExecutorSession {
  run(
    request: AgentRunRequest,
    options: RunAgentOptions,
  ): Promise<AgentRunHandle>;
  status(): AgentExecutionStatus;
  steer?(message: import('#/agent/contextMemory/types').ContextMessage): Promise<boolean>;
  updateBinding?(binding: ProfileBindingSnapshot): void;
  cancel(reason?: unknown): boolean;
  settled(): Promise<void>;
  shutdown(reason?: unknown): Promise<void>;
  readonly hooks: Hooks<{ onWillRun: { signal: AbortSignal } }>;
}

export interface AgentExecutorAgentContext {
  readonly id: string;
  readonly accessor: ServicesAccessor;
}

export interface AgentExecutorContext {
  readonly agent: AgentExecutorAgentContext;
  readonly descriptor: AgentExecutorDescriptor;
  readonly binding: ProfileBindingSnapshot;
  readonly worktree?: import('#/app/git/worktreeModel').SessionWorktree;
}

export function executionContextIdentity(binding: Pick<ExecutionBinding, 'selection' | 'effective'>) {
  const { permission_mode: _override, ...overrides } = binding.selection.overrides ?? {};
  const { permission_mode: _effective, ...effective } = binding.effective;
  return { selection: { ...binding.selection, overrides: Object.keys(overrides).length === 0 ? undefined : overrides }, effective };
}

export function agentExecutorBindingMatches(binding: ProfileBindingSnapshot, fingerprint: string | undefined): boolean {
  return fingerprint === agentExecutorBindingFingerprint(binding) || fingerprint === agentExecutorBindingFingerprint(binding, true);
}

export function agentExecutorBindingFingerprint(binding: ProfileBindingSnapshot, legacy = false): string {
  return createHash('sha256')
    .update(JSON.stringify({
      execution: legacy || binding.execution === undefined ? binding.execution
        : { version: binding.execution.version, ...executionContextIdentity(binding.execution), generation: binding.execution.generation },
      executorId: binding.executorId,
      executorProtocol: binding.executorProtocol,
      executorOptions: binding.executorOptions,
      executorDescriptorRevision: binding.executorDescriptorRevision,
      personaId: binding.personaId,
      personaRevision: binding.personaRevision,
      roomPrompt: binding.roomPrompt,
      modelAlias: binding.modelAlias,
      thinkingLevel: binding.thinkingLevel,
      profileDefinitionId: binding.profileDefinitionId,
      routeId: binding.routeId,
      systemPrompt: binding.systemPrompt,
      executorPrompt: binding.executorPrompt,
      allowKikiSubagents: binding.allowKikiSubagents === true ? true : undefined,
      kikiContext: binding.kikiContext?.length ? [...new Set(binding.kikiContext)].sort() : undefined,
      renderGeneration: binding.renderGeneration,
    }))
    .digest('hex');
}

export interface AgentExecutorProvider {
  readonly id: string;
  readonly protocol: AgentExecutorProtocol;
  validateOptions(value: unknown): AgentExecutorOptions;
  validateBinding(binding: ExecutorBinding): ExecutorValidationResult;
  create(context: AgentExecutorContext): AgentExecutorSession;
}

export interface ResolvedAgentExecutor {
  readonly descriptor: AgentExecutorDescriptor;
  readonly options: AgentExecutorOptions;
  readonly provider?: AgentExecutorProvider;
}

export interface IAgentExecutorRegistry {
  readonly _serviceBrand: undefined;

  get(id: string): AgentExecutorDescriptor | undefined;
  list(): readonly AgentExecutorDescriptor[];
  resolve(id?: string, options?: unknown): ResolvedAgentExecutor;
  validateBinding(
    id: string,
    options: unknown,
    binding: ExecutorBinding,
  ): ExecutorValidationResult;
  resolveExecutable(id?: string, options?: unknown): Promise<ResolvedAgentExecutor>;
  /** Defaults to full diagnostics; false resolves only the admitted source needed for catalog availability. */
  discover(id: string, exhaustive?: boolean): Promise<readonly AgentExecutorSourceProbe[]>;
  recordNegotiated?(id: string, version: string | undefined, capabilities: NegotiatedExecutorCapabilities): void;
  negotiated?(id: string, version: string | undefined): NegotiatedExecutorCapabilities | undefined;
  /** Last observation for the current descriptor, without launching the executor or verifying its installed version. */
  lastNegotiated?(id: string): NegotiatedExecutorCapabilities | undefined;
  provider(protocol: AgentExecutorProtocol): AgentExecutorProvider | undefined;
}

export const IAgentExecutorRegistry: ServiceIdentifier<IAgentExecutorRegistry> =
  createDecorator<IAgentExecutorRegistry>('agentExecutorRegistry');

const providers = new Map<AgentExecutorProtocol, AgentExecutorProvider>();

export function registerAgentExecutorProvider(
  provider: AgentExecutorProvider,
): IDisposable {
  if (providers.has(provider.protocol)) {
    throw new Error(
      `Agent executor provider already registered for protocol "${provider.protocol}"`,
    );
  }
  providers.set(provider.protocol, provider);
  return {
    dispose: () => {
      if (providers.get(provider.protocol) === provider) {
        providers.delete(provider.protocol);
      }
    },
  };
}

export function registeredAgentExecutorProviders(): readonly AgentExecutorProvider[] {
  return [...providers.values()];
}
