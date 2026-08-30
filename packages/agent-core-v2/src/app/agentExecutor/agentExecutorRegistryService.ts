import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import {
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';

import {
  type AgentExecutorDescriptor,
  type AgentExecutorOptions,
  type AgentExecutorOptionValue,
  type AgentExecutorProtocol,
  type AgentExecutorProvider,
  IAgentExecutorRegistry,
  type ResolvedAgentExecutor,
  registeredAgentExecutorProviders,
} from './agentExecutor';
import { BUILTIN_AGENT_EXECUTORS } from './builtinDescriptors';
import {
  AGENT_EXECUTORS_SECTION,
  type AgentExecutorConfig,
  type AgentExecutorsConfig,
} from './configSection';

const NATIVE_DESCRIPTOR: AgentExecutorDescriptor = {
  id: 'native',
  protocol: 'native',
  args: [],
  revision: 'native',
};

export class AgentExecutorRegistryService implements IAgentExecutorRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly providers = new Map<
    AgentExecutorProtocol,
    AgentExecutorProvider
  >(
    registeredAgentExecutorProviders().map((provider) => [
      provider.protocol,
      provider,
    ]),
  );

  constructor(@IConfigService private readonly config: IConfigService) {}

  get(id: string): AgentExecutorDescriptor | undefined {
    if (id === 'native') return NATIVE_DESCRIPTOR;
    const entry = this.config.get<AgentExecutorsConfig | undefined>(
      AGENT_EXECUTORS_SECTION,
    )?.[id] ?? BUILTIN_AGENT_EXECUTORS[id];
    return entry === undefined ? undefined : descriptorFromConfig(id, entry);
  }

  resolve(id = 'native', options: unknown = {}): ResolvedAgentExecutor {
    const descriptor = this.get(id);
    if (descriptor === undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Unknown agent executor "${id}". Configure [agent_executors.${id}] before referencing it from a profile.`,
        { details: { executorId: id } },
      );
    }
    const provider = this.provider(descriptor.protocol);
    const normalized = scalarOptions(options, id);
    if (provider === undefined) {
      if (Object.keys(normalized).length > 0) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Executor options for "${id}" cannot be validated because protocol "${descriptor.protocol}" has no registered provider.`,
          {
            details: {
              executorId: id,
              protocol: descriptor.protocol,
              optionKeys: Object.keys(normalized),
            },
          },
        );
      }
      return { descriptor, options: normalized };
    }
    return {
      descriptor,
      options: provider.validateOptions(normalized),
      provider,
    };
  }

  provider(protocol: AgentExecutorProtocol): AgentExecutorProvider | undefined {
    return this.providers.get(protocol);
  }
}

function descriptorFromConfig(
  id: string,
  config: AgentExecutorConfig,
): AgentExecutorDescriptor {
  return {
    id,
    protocol: config.protocol,
    command: config.command,
    args: [...config.args],
    env: config.env,
    startupTimeoutMs: config.startupTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs,
    modelBinding: config.modelBinding,
    modelArgs: config.modelArgs,
    modelConfigCategory: config.modelConfigCategory,
    thoughtConfigCategory: config.thoughtConfigCategory,
    revision: config.revision ?? JSON.stringify([
      config.protocol,
      config.command,
      config.args,
      config.env,
      config.startupTimeoutMs,
      config.shutdownGraceMs,
      config.modelBinding,
      config.modelArgs,
      config.modelConfigCategory,
      config.thoughtConfigCategory,
    ]),
  };
}

function scalarOptions(value: unknown, executorId: string): AgentExecutorOptions {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidOptions(executorId, 'executor_options must be a mapping');
  }
  const result: Record<string, AgentExecutorOptionValue> = {};
  for (const [key, option] of Object.entries(value)) {
    if (
      typeof option !== 'string' &&
      typeof option !== 'number' &&
      typeof option !== 'boolean'
    ) {
      throw invalidOptions(
        executorId,
        `executor_options.${key} must be a string, number, or boolean`,
      );
    }
    result[key] = option;
  }
  return result;
}

function invalidOptions(executorId: string, message: string): Error2 {
  return new Error2(ErrorCodes.CONFIG_INVALID, message, {
    details: { executorId },
  });
}

registerScopedService(
  LifecycleScope.App,
  IAgentExecutorRegistry,
  AgentExecutorRegistryService,
  ScopeActivation.OnScopeCreated,
  'agentExecutor',
);
