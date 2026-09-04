import { createHash } from 'node:crypto';

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
    };

export interface AgentExecutorVersionProbe {
  readonly args: readonly string[];
}

export interface AgentExecutorSourceProbe {
  readonly id: string;
  readonly kind: AgentExecutorBinarySource['kind'];
  readonly available: boolean;
  readonly command?: string;
  readonly version?: string;
  readonly diagnostic?: string;
}

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

export interface AgentExecutorDescriptor {
  readonly id: string;
  readonly protocol: AgentExecutorProtocol;
  readonly command?: string;
  readonly sources?: readonly AgentExecutorBinarySource[];
  readonly source?: string;
  readonly selectedSource?: string;
  readonly sourceProbes?: readonly AgentExecutorSourceProbe[];
  readonly version?: string;
  readonly versionProbe?: AgentExecutorVersionProbe;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly modelBinding?: string;
  readonly modelArgs?: readonly string[];
  readonly modelConfigCategory?: string;
  readonly thoughtConfigCategory?: string;
  readonly permissionModeMapping?: AgentExecutorPermissionModeMapping;
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
}

export function agentExecutorBindingFingerprint(binding: ProfileBindingSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify({
      executorId: binding.executorId,
      executorProtocol: binding.executorProtocol,
      executorOptions: binding.executorOptions,
      executorDescriptorRevision: binding.executorDescriptorRevision,
      profileDefinitionId: binding.profileDefinitionId,
      routeId: binding.routeId,
      modelAlias: binding.modelAlias,
      thinkingLevel: binding.thinkingLevel,
      systemPrompt: binding.systemPrompt,
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
  resolve(id?: string, options?: unknown): ResolvedAgentExecutor;
  validateBinding(
    id: string,
    options: unknown,
    binding: ExecutorBinding,
  ): ExecutorValidationResult;
  resolveExecutable(id?: string, options?: unknown): Promise<ResolvedAgentExecutor>;
  discover(id: string): Promise<readonly AgentExecutorSourceProbe[]>;
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
