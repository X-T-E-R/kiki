import {
  createDecorator,
  type ServiceIdentifier,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
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
  | (string & Record<never, never>);

export type AgentExecutorOptionValue = string | number | boolean;
export type AgentExecutorOptions = Readonly<
  Record<string, AgentExecutorOptionValue>
>;

export interface AgentExecutorDescriptor {
  readonly id: string;
  readonly protocol: AgentExecutorProtocol;
  readonly command?: string;
  readonly args: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly modelBinding?: string;
  readonly modelConfigCategory?: string;
  readonly thoughtConfigCategory?: string;
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

export interface AgentExecutorProvider {
  readonly id: string;
  readonly protocol: AgentExecutorProtocol;
  validateOptions(value: unknown): AgentExecutorOptions;
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
