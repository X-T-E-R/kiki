import { createHash } from 'node:crypto';

import { normalize } from 'pathe';
import type {
  ExecutorBinding,
  ExecutorValidationResult,
} from '@kiki/agent-profiles/ports';

import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import {
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';

import {
  type AgentExecutorDescriptor,
  type AgentExecutorOptions,
  type AgentExecutorSourceProbe,
  type AgentExecutorOptionValue,
  type AgentExecutorProtocol,
  type AgentExecutorProvider,
  IAgentExecutorRegistry,
  type ResolvedAgentExecutor,
  registeredAgentExecutorProviders,
} from './agentExecutor';
import {
  discoverExecutorSources,
  resolveExecutorSource,
} from './binaryDiscovery';
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

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IHostProcessService private readonly processService: IHostProcessService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

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

  validateBinding(
    id: string,
    options: unknown,
    binding: ExecutorBinding,
  ): ExecutorValidationResult {
    try {
      const resolved = this.resolve(id, options);
      if (resolved.provider === undefined) {
        return {
          ok: false,
          diagnostic: `External executor "${id}" is unsupported because protocol "${resolved.descriptor.protocol}" has no registered provider`,
        };
      }
      const result = resolved.provider.validateBinding(binding);
      if (!result.ok) return result;
      for (const field of ['modelAlias', 'thinkingEffort'] as const) {
        if (
          binding[field] !== undefined &&
          (result.binding[field] === undefined || result.binding[field].trim().length === 0)
        ) {
          return {
            ok: false,
            diagnostic: `External executor "${id}" returned an empty ${field} binding`,
          };
        }
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async resolveExecutable(
    id = 'native',
    options: unknown = {},
  ): Promise<ResolvedAgentExecutor> {
    const resolved = this.resolve(id, options);
    if (resolved.descriptor.id === 'native') return resolved;
    const probes = await resolveExecutorSource(
      resolved.descriptor,
      this.processService,
      this.fs,
      this.bootstrap,
    );
    const selected = probes.find((probe) => probe.available);
    if (selected?.command === undefined) {
      const requested = resolved.descriptor.source;
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        requested === undefined
          ? `No executable source is available for agent executor "${id}"`
          : `Configured source "${requested}" is unavailable for agent executor "${id}"`,
        { details: { executorId: id, source: requested, probes } },
      );
    }
    return {
      ...resolved,
      descriptor: {
        ...resolved.descriptor,
        command: selected.command,
        selectedSource: selected.id,
        sourceProbes: probes,
        version: selected.version,
        revision: resolvedExecutableRevision({
          baseRevision: resolved.descriptor.revision,
          selectedSource: selected.id,
          command: selected.command,
          version: selected.version,
        }),
      },
    };
  }

  async discover(id: string): Promise<readonly AgentExecutorSourceProbe[]> {
    const descriptor = this.get(id);
    if (descriptor === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, `Unknown agent executor "${id}"`);
    }
    return discoverExecutorSources(
      descriptor,
      this.processService,
      this.fs,
      this.bootstrap,
    );
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
    sources: config.sources,
    source: config.source,
    versionProbe: config.versionProbe,
    args: [...config.args],
    env: config.env,
    startupTimeoutMs: config.startupTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs,
    modelBinding: config.modelBinding,
    modelArgs: config.modelArgs,
    modelConfigCategory: config.modelConfigCategory,
    modelConfigId: config.modelConfigId,
    thoughtConfigCategory: config.thoughtConfigCategory,
    thoughtConfigId: config.thoughtConfigId,
    permissionModeMapping: config.permissionModeMapping,
    revision: descriptorRevisionFromConfig(config),
  };
}

export function resolvedExecutableRevision(input: {
  readonly baseRevision: string;
  readonly selectedSource: string;
  readonly command: string;
  readonly version?: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      baseRevision: input.baseRevision,
      selectedSource: input.selectedSource,
      command: normalize(input.command),
      version: input.version,
    }))
    .digest('hex');
}

export function descriptorRevisionFromConfig(config: AgentExecutorConfig): string {
  const env = config.env === undefined
    ? undefined
    : Object.fromEntries(Object.entries(config.env).toSorted(([left], [right]) => left.localeCompare(right)));
  const canonical = JSON.stringify({
    protocol: config.protocol,
    command: config.command,
    sources: config.sources,
    source: config.source,
    versionProbe: config.versionProbe,
    args: config.args,
    env,
    startupTimeoutMs: config.startupTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs,
    modelBinding: config.modelBinding,
    modelArgs: config.modelArgs,
    modelConfigCategory: config.modelConfigCategory,
    modelConfigId: config.modelConfigId,
    thoughtConfigCategory: config.thoughtConfigCategory,
    thoughtConfigId: config.thoughtConfigId,
    permissionModeMapping: config.permissionModeMapping,
    declaredRevision: config.revision,
  });
  return createHash('sha256').update(canonical).digest('hex');
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
