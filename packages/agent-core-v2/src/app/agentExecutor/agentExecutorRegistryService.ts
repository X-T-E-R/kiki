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
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
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
import type { NegotiatedExecutorCapabilities } from './capabilities';
import {
  AGENT_EXECUTOR_OVERRIDES_SECTION,
  applyExecutorOverride,
  AgentExecutorOverrideSchema,
  type AgentExecutorOverridesConfig,
} from './executorOverrides';
import {
  AGENT_EXECUTORS_SECTION,
  type AgentExecutorConfig,
  type AgentExecutorsConfig,
} from './configSection';
import { MANAGED_ADAPTER_SCOPE, withManagedAdapterSource, type ManagedAdapterState } from './managedAdapterRegistry';
import { wrapWindowsNodeShims } from './windowsNodeShim';

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
  private readonly negotiatedById = new Map<string, {
    readonly revision: string;
    readonly version: string | undefined;
    readonly capabilities: NegotiatedExecutorCapabilities;
  }>();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IHostProcessService private readonly processService: IHostProcessService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAtomicTomlDocumentStore private readonly documents?: IAtomicTomlDocumentStore,
  ) {}

  get(id: string): AgentExecutorDescriptor | undefined {
    if (id === 'native') return NATIVE_DESCRIPTOR;
    const entry = this.config.get<AgentExecutorsConfig | undefined>(
      AGENT_EXECUTORS_SECTION,
    )?.[id] ?? BUILTIN_AGENT_EXECUTORS[id];
    if (entry === undefined) return undefined;
    const raw = this.config.get<AgentExecutorOverridesConfig | undefined>(
      AGENT_EXECUTOR_OVERRIDES_SECTION,
    )?.[id];
    const parsed = raw === undefined ? undefined : AgentExecutorOverrideSchema.safeParse(raw);
    return applyExecutorOverride(
      descriptorFromConfig(id, entry),
      parsed?.success === true ? parsed.data : undefined,
    );
  }

  list(): readonly AgentExecutorDescriptor[] {
    const configured = this.config.get<AgentExecutorsConfig | undefined>(AGENT_EXECUTORS_SECTION) ?? {};
    return ['native', ...new Set([...Object.keys(BUILTIN_AGENT_EXECUTORS), ...Object.keys(configured)]).values()]
      .map((id) => this.get(id)!)
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  recordNegotiated(id: string, version: string | undefined, capabilities: NegotiatedExecutorCapabilities): void {
    const descriptor = this.get(id);
    if (descriptor !== undefined) this.negotiatedById.set(id, {
      revision: descriptor.revision, version, capabilities,
    });
  }

  negotiated(id: string, version: string | undefined): NegotiatedExecutorCapabilities | undefined {
    const cached = this.negotiatedById.get(id);
    return cached !== undefined && cached.revision === this.get(id)?.revision && cached.version === version
      ? cached.capabilities : undefined;
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
      const descriptor = resolved.descriptor;
      const observed = this.negotiatedById.get(id);
      const negotiated = observed?.revision === descriptor.revision ? observed.capabilities : undefined;
      const fields = {
        name: { state: 'applied' as const }, description: { state: 'applied' as const },
        when: { state: 'applied' as const }, main: { state: 'applied' as const },
        executor_prompt: { state: 'mapped' as const },
        model_alias: { state: 'mapped' as const },
        thinking_effort: descriptor.protocol === 'codex-app-server' ||
          (negotiated?.thinkingLevels?.length ?? 0) > 0 || descriptor.thoughtConfigId !== undefined ||
          descriptor.thoughtConfigCategory !== undefined
          ? { state: 'mapped' as const }
          : { state: 'ignored' as const, reason: 'The executor did not advertise a thinking-level setting' },
        tools: { state: 'ignored' as const, reason: 'Tools are managed by the external executor' },
        disallowed_tools: { state: 'ignored' as const, reason: 'Tools are managed by the external executor' },
        service_tier: { state: 'ignored' as const, reason: 'Provider settings require native execution' },
        request_params: { state: 'ignored' as const, reason: 'Provider settings require native execution' },
        context_budget: { state: 'ignored' as const, reason: 'Provider settings require native execution' },
        auto_compact: { state: 'ignored' as const, reason: 'Compaction is managed by the external executor' },
        max_completion_tokens: { state: 'ignored' as const, reason: 'Provider settings require native execution' },
      };
      const advisories = (binding.explicitFields ?? []).flatMap((field) => {
        const state = fields[field as keyof typeof fields];
        return state?.state === 'ignored'
          ? [{ code: 'executor_field_ignored' as const, field,
              message: `${field} is ignored by executor "${id}": ${state.reason}` }]
          : [];
      });
      return { ...result, binding: { modelAlias: result.binding.modelAlias,
        thinkingEffort: result.binding.thinkingEffort }, fields, advisories };
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
    const descriptor = await this.#withManagedSource(resolved.descriptor);
    const probes = await resolveExecutorSource(
      descriptor,
      this.#probeProcessService(),
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
        ...descriptor,
        command: selected.command,
        launchArgs: selected.launchArgs,
        selectedSource: selected.id,
        sourceProbes: probes,
        version: selected.version,
        revision: resolvedExecutableRevision({
          baseRevision: resolved.descriptor.revision,
          selectedSource: selected.id,
          command: selected.command,
          launchArgs: selected.launchArgs,
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
      await this.#withManagedSource(descriptor),
      this.#probeProcessService(),
      this.fs,
      this.bootstrap,
    );
  }

  #probeProcessService(): IHostProcessService {
    if (this.bootstrap.platform !== 'win32') return this.processService;
    return wrapWindowsNodeShims(this.processService, this.fs, () => this.bootstrap);
  }

  async #withManagedSource(descriptor: AgentExecutorDescriptor): Promise<AgentExecutorDescriptor> {
    const state = await this.documents?.get<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, descriptor.id);
    return withManagedAdapterSource(descriptor, this.bootstrap.homeDir, state);
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
    label: config.label,
    command: config.command,
    sources: config.sources,
    source: config.source,
    versionProbe: config.versionProbe,
    diagnostics: config.diagnostics,
    auth: config.auth,
    args: [...config.args],
    env: config.env,
    homeEnv: config.homeEnv,
    startupTimeoutMs: config.startupTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs,
    modelBinding: config.modelBinding,
    modelArgs: config.modelArgs,
    modelConfigCategory: config.modelConfigCategory,
    modelConfigId: config.modelConfigId,
    thoughtConfigCategory: config.thoughtConfigCategory,
    thoughtConfigId: config.thoughtConfigId,
    permissionModeMapping: config.permissionModeMapping,
    permission: config.permission,
    promptDeliveries: config.promptDeliveries,
    supportsMcp: config.supportsMcp,
    defaultProfile: config.defaultProfile,
    installHint: config.installHint,
    programLabel: config.programLabel,
    loginCommand: config.loginCommand,
    apiKeyEnv: config.apiKeyEnv,
    steerDelivery: config.steerDelivery,
    profileDelivery: config.profileDelivery,
    revision: descriptorRevisionFromConfig(config),
  };
}

export function resolvedExecutableRevision(input: {
  readonly baseRevision: string;
  readonly selectedSource: string;
  readonly command: string;
  readonly launchArgs?: readonly string[];
  readonly version?: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      baseRevision: input.baseRevision,
      selectedSource: input.selectedSource,
      command: normalize(input.command),
      launchArgs: input.launchArgs?.map((arg) => normalize(arg)),
      version: input.version,
    }))
    .digest('hex');
}

/**
 * Hashes the session-shaping descriptor config into a stable revision.
 * `profileDelivery` is deliberately excluded: it only shapes how newly
 * created sessions receive the profile, so declaring or toggling it must not
 * invalidate executor sessions that are still resumable.
 */
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
