import { createHash } from 'node:crypto';

import { normalize } from 'pathe';
import type {
  ExecutorBinding,
  ExecutorCapabilityCatalog,
  ExecutorCapabilityDimension,
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
  probeExecutorModelCatalog,
  resolveExecutorSource,
} from './binaryDiscovery';
import { BUILTIN_AGENT_EXECUTORS } from './builtinDescriptors';
import { executorControlCapabilities, type NegotiatedExecutorCapabilities } from './capabilities';
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
import { ANTIGRAVITY_CACHE_SCOPE, type AntigravityCacheState } from './antigravityService';
import { antigravityCacheRoot, antigravityRelease } from './antigravityDistribution';
import { join } from 'pathe';

const CAPABILITY_CACHE_MAX_AGE_MS = 60_000;

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
    readonly catalog?: ExecutorCapabilityCatalog;
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
    if (descriptor === undefined) return;
    this.negotiatedById.set(id, {
      revision: descriptor.revision,
      version,
      capabilities,
      catalog: {
        executorId: id,
        descriptorRevision: descriptor.revision,
        version,
        source: 'negotiated',
        provenance: 'acp_negotiation',
        observedAt: Date.now(),
        models: capabilityDimension(capabilities.models),
        thinkingLevels: capabilityDimension(capabilities.thinkingLevels),
        context: contextCapabilities(capabilities),
        controls: executorControlCapabilities(descriptor),
      },
    });
  }

  async refreshExecutorCapabilityCatalog(id: string): Promise<ExecutorCapabilityCatalog> {
    const descriptor = this.get(id);
    if (descriptor === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, `Unknown agent executor "${id}"`);
    if (descriptor.modelProbe === undefined) {
      const existing = this.negotiatedById.get(id)?.catalog;
      if (existing !== undefined) return existing;
      const unknown = {
        executorId: id,
        descriptorRevision: descriptor.revision,
        source: 'negotiated' as const,
        provenance: 'acp_negotiation' as const,
        observedAt: 0,
        models: { state: 'unknown' as const, diagnostic: 'Executor has no model catalog probe' },
        thinkingLevels: { state: 'unknown' as const, diagnostic: 'Executor has no model catalog probe' },
        context: unknownContextCapabilities(),
        controls: executorControlCapabilities(descriptor),
      };
      this.recordExecutorCapabilityCatalog(unknown);
      return unknown;
    }
    this.recordExecutorCapabilityCatalog({
      executorId: id,
      descriptorRevision: descriptor.revision,
      version: descriptor.version,
      source: 'cli_probe',
      provenance: 'read_only_cli_probe',
      observedAt: Date.now(),
      models: { state: 'loading' },
      thinkingLevels: { state: 'unknown', diagnostic: 'Thinking levels require executor negotiation' },
      context: unknownContextCapabilities(),
      controls: executorControlCapabilities(descriptor),
    });
    try {
      const managed = await this.#withManagedSource(descriptor);
      const probes = await resolveExecutorSource(
        managed,
        this.#probeProcessService(),
        this.fs,
        this.bootstrap,
      );
      const selected = probes.find((probe) => probe.available);
      const catalog = await probeExecutorModelCatalog(
        managed,
        selected,
        this.#probeProcessService(),
        this.fs,
        this.bootstrap,
      );
      const snapshot: ExecutorCapabilityCatalog = {
        executorId: id,
        descriptorRevision: descriptor.revision,
        version: selected?.version,
        catalogProgramVersion: catalog.programVersion,
        catalogCommand: catalog.command,
        source: 'cli_probe',
        provenance: 'read_only_cli_probe',
        observedAt: Date.now(),
        models: catalog.models,
        thinkingLevels: { state: 'unknown', diagnostic: 'Thinking levels require executor negotiation' },
        context: unknownContextCapabilities(),
        controls: executorControlCapabilities(descriptor),
      };
      this.recordExecutorCapabilityCatalog(snapshot);
      return snapshot;
    } catch {
      const snapshot: ExecutorCapabilityCatalog = {
        executorId: id,
        descriptorRevision: descriptor.revision,
        version: descriptor.version,
        source: 'cli_probe',
        provenance: 'read_only_cli_probe',
        observedAt: Date.now(),
        models: { state: 'unavailable', diagnostic: 'Model catalog probe failed' },
        thinkingLevels: { state: 'unknown', diagnostic: 'Thinking levels require executor negotiation' },
        context: unknownContextCapabilities(),
        controls: executorControlCapabilities(descriptor),
      };
      this.recordExecutorCapabilityCatalog(snapshot);
      return snapshot;
    }
  }

  recordExecutorCapabilityCatalog(catalog: ExecutorCapabilityCatalog): void {
    const descriptor = this.get(catalog.executorId);
    if (descriptor === undefined || descriptor.revision !== catalog.descriptorRevision) return;
    const current = this.negotiatedById.get(catalog.executorId);
    this.negotiatedById.set(catalog.executorId, {
      revision: catalog.descriptorRevision,
      version: catalog.version,
      capabilities: current?.capabilities ?? {},
      catalog,
    });
  }

  getExecutorCapabilityCatalog(
    id: string,
    expected?: { readonly descriptorRevision?: string; readonly version?: string; readonly programVersion?: string },
  ): ExecutorCapabilityCatalog | undefined {
    const cached = this.negotiatedById.get(id);
    const revision = this.get(id)?.revision;
    if (cached === undefined || revision === undefined || cached.revision !== revision || cached.catalog === undefined) return undefined;
    if (expected?.descriptorRevision !== undefined && cached.catalog.descriptorRevision !== expected.descriptorRevision) return undefined;
    if (expected?.version !== undefined && cached.catalog.version !== expected.version) return undefined;
    if (expected?.programVersion !== undefined && cached.catalog.catalogProgramVersion !== expected.programVersion) return undefined;
    const stale = cached.catalog.observedAt > 0 && Date.now() - cached.catalog.observedAt > CAPABILITY_CACHE_MAX_AGE_MS;
    if (expected?.version === undefined && cached.catalog.version !== undefined) {
      return {
        ...cached.catalog,
        models: { state: 'unknown', diagnostic: 'Executor version has not been revalidated' },
        thinkingLevels: { state: 'unknown', diagnostic: 'Executor version has not been revalidated' },
      };
    }
    if (stale) {
      return {
        ...cached.catalog,
        models: { state: 'unknown', diagnostic: 'Capability observation is stale; refresh the executor catalog' },
        thinkingLevels: { state: 'unknown', diagnostic: 'Capability observation is stale; refresh the executor catalog' },
        context: { state: 'unknown', diagnostic: 'Capability observation is stale; refresh the executor catalog' },
      };
    }
    return cached.catalog;
  }

  negotiated(id: string, version: string | undefined): NegotiatedExecutorCapabilities | undefined {
    const cached = this.negotiatedById.get(id);
    return cached !== undefined && cached.revision === this.get(id)?.revision && cached.version === version
      ? cached.capabilities : undefined;
  }

  lastNegotiated(id: string): NegotiatedExecutorCapabilities | undefined {
    const cached = this.negotiatedById.get(id);
    return cached?.revision === this.get(id)?.revision ? cached?.capabilities : undefined;
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
      const cached = this.negotiatedById.get(id);
      const observedVersion = cached?.version;
      const catalog = this.getExecutorCapabilityCatalog(id, {
        descriptorRevision: descriptor.revision,
        version: observedVersion,
        programVersion: cached?.catalog?.catalogProgramVersion,
      });
      const modelCatalog = catalog?.models;
      if (result.binding.modelAlias !== undefined && modelCatalog?.state === 'ready' &&
          !(modelCatalog.values ?? []).includes(result.binding.modelAlias)) {
        return {
          ok: false,
          diagnostic: `External executor "${id}" does not advertise model "${result.binding.modelAlias}"; select one of ${(modelCatalog.values ?? []).join(', ') || '(none)'}`,
        };
      }
      const effortCatalog = catalog?.thinkingLevels;
      if (result.binding.thinkingEffort !== undefined && effortCatalog?.state === 'ready' &&
          !(effortCatalog.values ?? []).includes(result.binding.thinkingEffort)) {
        return {
          ok: false,
          diagnostic: `External executor "${id}" does not advertise thinking effort "${result.binding.thinkingEffort}"; select one of ${(effortCatalog.values ?? []).join(', ') || '(none)'}`,
        };
      }
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
    if (descriptor.id === 'antigravity-acp') {
      const state = await this.documents?.get<AntigravityCacheState>(ANTIGRAVITY_CACHE_SCOPE, descriptor.id);
      if (state?.activeVersion !== undefined && descriptor.sources?.some((source) => source.id === 'kiki-managed')) {
        const release = antigravityRelease(state.activeVersion, this.bootstrap.platform, this.bootstrap.arch);
        const path = join(antigravityCacheRoot(this.bootstrap.homeDir), release.version, release.platform, release.entry);
        return { ...descriptor, sources: descriptor.sources.map((source) => source.id === 'kiki-managed'
          ? { id: source.id, kind: 'explicit-path', path } : source) };
      }
      return descriptor;
    }
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
    modelProbe: config.modelProbe,
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
    controlCapabilities: config.controlCapabilities,
    thoughtConfigCategory: config.thoughtConfigCategory,
    thoughtConfigId: config.thoughtConfigId,
    permissionModeMapping: config.permissionModeMapping,
    permission: config.permission,
    promptDeliveries: config.promptDeliveries,
    supportsMcp: config.supportsMcp,
    mcpTransports: config.mcpTransports,
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
    modelProbe: config.modelProbe,
    args: config.args,
    env,
    startupTimeoutMs: config.startupTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs,
    modelBinding: config.modelBinding,
    modelArgs: config.modelArgs,
    modelConfigCategory: config.modelConfigCategory,
    modelConfigId: config.modelConfigId,
    controlCapabilities: config.controlCapabilities,
    thoughtConfigCategory: config.thoughtConfigCategory,
    thoughtConfigId: config.thoughtConfigId,
    permissionModeMapping: config.permissionModeMapping,
    declaredRevision: config.revision,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function capabilityDimension(values: readonly string[] | undefined): ExecutorCapabilityDimension {
  if (values === undefined) return { state: 'unknown' };
  const unique = [...new Set(values.filter((value) => value.trim() !== ''))];
  return unique.length === 0
    ? { state: 'unknown', diagnostic: 'Executor did not advertise any values' }
    : { state: 'ready', values: unique };
}

function unknownContextCapabilities() {
  return { state: 'unknown' as const };
}

function contextCapabilities(capabilities: NegotiatedExecutorCapabilities) {
  const values = [capabilities.contextWindow, capabilities.maxInputTokens, capabilities.maxOutputTokens,
    capabilities.compactionThreshold].filter((value): value is number => value !== undefined && Number.isFinite(value));
  return {
    state: values.length === 0 ? 'unknown' as const : values.length === 4 ? 'ready' as const : 'partial' as const,
    contextWindow: capabilities.contextWindow,
    maxInputTokens: capabilities.maxInputTokens,
    maxOutputTokens: capabilities.maxOutputTokens,
    compactionThreshold: capabilities.compactionThreshold,
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
