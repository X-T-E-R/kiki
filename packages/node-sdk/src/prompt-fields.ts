import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'pathe';
import { parse as parseToml } from 'smol-toml';

import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  BUILTIN_PROMPT_FIELD_DEFINITIONS,
  ConfigRegistry,
  HostFileSystem,
  PromptFieldRegistryService,
  resolveModelId,
  type AgentModelProfile,
  type AgentProfile,
  type CollectionView,
  type IHostFsWatchService,
  type ModelsSection,
  type PromptFieldContext,
  type PromptFieldDefinition,
  type PromptFieldResolutionStatus,
  type PromptOverrides,
} from '@kiki/agent-core-v2';
import { Event } from '@kiki/agent-core-v2/_base/event';
import { transformTomlData } from '@kiki/agent-core-v2/app/config/toml';
import { ModelsSectionSchema } from '@kiki/agent-core-v2/app/kosongConfig/configSection';
import { PromptConfigSchema, type PromptConfig } from '@kiki/agent-core-v2/app/prompt/configSection';
import { ShippedAgentProfileSourceService } from '@kiki/agent-core-v2/app/shippedAgentProfiles/shippedAgentProfileSourceService';
import { discoverAgentFiles } from '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery';
import {
  configuredAgentRoots,
  projectAgentRoots,
  userAgentRoots,
} from '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/agentRoots';
import { loadSystemMdProfile } from '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/systemFile';
import type { AgentFileDefinition } from '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/types';

export interface PromptFieldInspectOptions {
  readonly homeDir: string;
  readonly configPath?: string;
  readonly cwd?: string;
  readonly osHomeDir?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly executor?: string;
  readonly delegationPosition?: 'main' | 'sub' | 'independent';
}

export interface PromptFieldDefinitionInfo {
  readonly id: string;
  readonly owner: string;
  readonly consumers: readonly string[];
  readonly overridable: boolean;
  readonly allowEmpty: boolean;
  readonly allowedVariables: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly defaultKind: 'inline' | 'resource';
  readonly defaultValue: string;
}

interface PromptOverrideSourceLike {
  readonly surface: 'global' | 'model' | 'profile' | 'profile-model' | 'system';
  readonly kind: 'file' | 'inline';
  readonly path?: string;
  readonly fileIndex?: number;
  readonly line?: number;
}

export interface PromptFieldSourceInfo {
  readonly surface: 'default' | PromptOverrideSourceLike['surface'];
  readonly kind: 'default' | PromptOverrideSourceLike['kind'];
  readonly status: 'effective' | 'shadowed' | 'inactive';
  readonly path?: string;
  readonly fileIndex?: number;
  readonly line?: number;
}

export interface PromptFieldValueInfo extends PromptFieldDefinitionInfo {
  readonly status: PromptFieldResolutionStatus;
  readonly value?: string;
  readonly sources: readonly PromptFieldSourceInfo[];
}

export interface PromptFieldValidationSummary {
  readonly configPath: string;
  readonly fieldCount: number;
  readonly modelCount: number;
  readonly profileCount: number;
  readonly systemMdLoaded: boolean;
  readonly externalFileCount: number;
}

export interface PromptFieldInspection {
  readonly fields: readonly PromptFieldValueInfo[];
  readonly profile: string;
  readonly model?: string;
  readonly executor: string;
  readonly delegationPosition: 'main' | 'sub' | 'independent';
  readonly warnings: readonly string[];
  readonly validation: PromptFieldValidationSummary;
}

interface InspectionProfile {
  readonly name: string;
  readonly override?: boolean;
  readonly sourcePath?: string;
  readonly systemPromptMode?: 'replace' | 'prepend' | 'append' | 'inherit';
  readonly executor?: string;
  readonly promptOverrides?: PromptOverrides;
  readonly promptOverrideLayers?: readonly PromptOverrides[];
  readonly modelProfiles?: readonly AgentModelProfile[];
  readonly fileBacked: boolean;
}

interface LoadedProfileSet {
  readonly candidates: ReadonlyMap<string, readonly InspectionProfile[]>;
  readonly count: number;
  readonly systemMdLoaded: boolean;
}

interface ParsedInspectionConfig {
  readonly prompt: PromptConfig;
  readonly models: ModelsSection;
  readonly defaultModel?: string;
  readonly extraAgentDirs: readonly string[];
  readonly disabledBuiltinProfiles: ReadonlySet<string>;
  readonly disabledNamedProfiles: ReadonlySet<string>;
  readonly warnings: readonly string[];
}

export function listPromptFieldDefinitions(): readonly PromptFieldDefinitionInfo[] {
  return BUILTIN_PROMPT_FIELD_DEFINITIONS.map(definitionInfo).toSorted((a, b) => a.id.localeCompare(b.id));
}

export async function inspectPromptFields(
  options: PromptFieldInspectOptions,
): Promise<PromptFieldInspection> {
  const cwd = options.cwd ?? process.cwd();
  const osHomeDir = options.osHomeDir ?? homedir();
  const configPath = options.configPath === undefined
    ? join(options.homeDir, 'config.toml')
    : isAbsolute(options.configPath)
      ? options.configPath
      : resolve(cwd, options.configPath);
  const warnings: string[] = [];
  const config = await readInspectionConfig(configPath, options.configPath !== undefined, warnings);
  const fs = new HostFileSystem();
  const promptFields = createRegistry(fs, options.homeDir);

  try {
    const profiles = await loadProfiles(fs, options.homeDir, osHomeDir, cwd, config, warnings);
    const profileName = options.profile ?? 'agent';
    const profile = resolveProfile(
      profileName,
      profiles.candidates.get(profileName) ?? [],
      config.disabledBuiltinProfiles,
      config.disabledNamedProfiles,
    );
    if (profile === undefined) throw new Error(`Agent profile "${profileName}" is not available.`);

    const requestedModel = options.model ?? config.defaultModel;
    const canonicalModel = requestedModel === undefined
      ? undefined
      : resolveModelId(config.models, requestedModel) ?? requestedModel;
    const model = canonicalModel === undefined ? undefined : config.models[canonicalModel];
    if (requestedModel !== undefined && model === undefined) {
      throw new Error(`Model "${requestedModel}" is not configured.`);
    }
    const executor = options.executor ?? profile.executor ?? 'native';
    const delegationPosition = options.delegationPosition ?? 'main';
    const modelProfile = matchModelProfile(profile.modelProfiles, canonicalModel, config.models, executor);
    const profileSurface = profile.sourcePath?.replaceAll('\\', '/').endsWith('/SYSTEM.md') === true
      ? 'system'
      : 'profile';
    const resolved = await promptFields.resolve({
      global: { surface: 'global', overrides: config.prompt.overrides },
      model: { surface: 'model', overrides: model?.promptOverrides },
      profile: {
        surface: profileSurface,
        overrides: profile.promptOverrideLayers ?? profile.promptOverrides,
        sourcePath: profile.sourcePath,
      },
      profileModel: { surface: 'profile-model', overrides: modelProfile?.promptOverrides },
      context: {
        profileName,
        modelAlias: canonicalModel,
        executor,
        delegationPosition,
      },
      customVariables: config.prompt.variables,
    });

    await validateAllSurfaces(promptFields, config, profiles, cwd);
    const shadowSystem = shadowsSystemFields(profile, model);
    const intentOverride = resolved.fields.find((field) => field.id === 'system.intent_tool_use');
    const fields = promptFields.list().map((definition) => {
      const configured = resolved.fields.find((field) => field.id === definition.id);
      let status = configured?.status ?? (applies(definition, {
        profileName,
        modelAlias: canonicalModel,
        executor,
        delegationPosition,
      }) ? 'effective' : 'inactive');
      if (
        status === 'effective'
        && definition.id.startsWith('system.')
        && definition.id !== 'system.shared'
        && shadowSystem
      ) {
        status = 'shadowed';
      }
      if (
        status === 'effective'
        && definition.id === 'system.reply_style'
        && intentOverride !== undefined
        && !intentOverride.value.includes('${reply_style_guide}')
      ) {
        status = 'shadowed';
      }
      return valueInfo(definition, configured?.value, status, configured?.sources ?? []);
    }).toSorted((a, b) => a.id.localeCompare(b.id));

    return {
      fields,
      profile: profileName,
      model: canonicalModel,
      executor,
      delegationPosition,
      warnings,
      validation: {
        configPath,
        fieldCount: fields.length,
        modelCount: Object.keys(config.models).length,
        profileCount: profiles.count,
        systemMdLoaded: profiles.systemMdLoaded,
        externalFileCount: countExternalFiles(config, profiles),
      },
    };
  } finally {
    promptFields.dispose();
  }
}

async function readInspectionConfig(
  configPath: string,
  explicit: boolean,
  warnings: string[],
): Promise<ParsedInspectionConfig> {
  if (!existsSync(configPath)) {
    if (explicit) throw new Error(`Config file does not exist: ${configPath}`);
    return emptyConfig(warnings);
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid TOML in ${configPath}: ${errorMessage(error)}`, { cause: error });
  }
  const registry = new ConfigRegistry();
  try {
    const transformed = transformTomlData(raw, registry);
    const schemaLessDomains = new Set(['defaultModel', 'defaultProvider', 'modelOverrides']);
    for (const [domain, value] of Object.entries(transformed)) {
      if (registry.getSection(domain) === undefined) {
        if (!schemaLessDomains.has(domain)) {
          warnings.push(`Unknown top-level config key ignored: ${domain}`);
        }
      } else {
        registry.validate(domain, value);
      }
    }
    return {
      prompt: PromptConfigSchema.parse(transformed['prompt'] ?? {}),
      models: ModelsSectionSchema.parse(transformed['models'] ?? {}),
      defaultModel: typeof transformed['defaultModel'] === 'string'
        ? transformed['defaultModel']
        : undefined,
      extraAgentDirs: stringArray(transformed['extraAgentDirs']),
      disabledBuiltinProfiles: new Set(stringArray(transformed['disabledBuiltinProfiles'])),
      disabledNamedProfiles: new Set(stringArray(transformed['disabledNamedProfiles'])),
      warnings,
    };
  } catch (error) {
    throw new Error(`Invalid configuration in ${configPath}: ${errorMessage(error)}`, { cause: error });
  } finally {
    registry.dispose();
  }
}

function emptyConfig(warnings: string[]): ParsedInspectionConfig {
  return {
    prompt: {},
    models: {},
    extraAgentDirs: [],
    disabledBuiltinProfiles: new Set(),
    disabledNamedProfiles: new Set(),
    warnings,
  };
}

function createRegistry(fs: HostFileSystem, homeDir: string): PromptFieldRegistryService {
  const view = {
    items: [],
    records: [],
    onDidChange: Event.None,
  } as unknown as CollectionView<{ readonly definition: PromptFieldDefinition }>;
  const fsWatch = {
    _serviceBrand: undefined,
    watch: () => ({
      ready: Promise.resolve(),
      onDidChange: Event.None,
      dispose: () => {},
    }),
  } as IHostFsWatchService;
  return new PromptFieldRegistryService(
    view,
    fs,
    fsWatch,
    {
      _serviceBrand: undefined,
      homeDir,
      platform: process.platform,
    } as never,
  );
}

async function loadProfiles(
  fs: HostFileSystem,
  homeDir: string,
  osHomeDir: string,
  cwd: string,
  config: ParsedInspectionConfig,
  warnings: string[],
): Promise<LoadedProfileSet> {
  const shipped = new ShippedAgentProfileSourceService();
  const builtins = shipped.list().map(fromShippedAgentProfile);
  const builtinDefault = shipped.get('agent');
  if (builtinDefault === undefined) throw new Error('Built-in agent profile "agent" is unavailable.');

  const roots = await Promise.all([
    userAgentRoots(fs, homeDir, osHomeDir, (message) => warnings.push(message)),
    configuredAgentRoots(fs, config.extraAgentDirs, cwd, osHomeDir, 'extra', (message) => warnings.push(message)),
    projectAgentRoots(fs, cwd, (message) => warnings.push(message)),
  ]);
  const discoveries = await Promise.all(roots.map((group) =>
    discoverAgentFiles(fs, group, (message) => warnings.push(message))));
  for (const discovery of discoveries) {
    const skipped = discovery.skipped?.[0];
    if (skipped !== undefined) {
      throw new Error(`Invalid agent profile ${skipped.path}: ${skipped.reason}`);
    }
  }

  let systemParseError: string | undefined;
  const systemProfile = await loadSystemMdProfile(
    fs,
    homeDir,
    builtinDefault,
    (message) => {
      warnings.push(message);
      if (message.includes('SYSTEM.md parse failed')) systemParseError = message;
    },
  );
  if (systemParseError !== undefined) throw new Error(systemParseError);
  const sourceGroups = [
    {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
      profiles: [
        ...discoveries[0]!.agents.map(fromAgentFile),
        ...(systemProfile === undefined ? [] : [fromAgentProfile(systemProfile)]),
      ],
    },
    {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.extra,
      profiles: discoveries[1]!.agents.map(fromAgentFile),
    },
    {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      profiles: discoveries[2]!.agents.map(fromAgentFile),
    },
  ];
  const names = new Set([...builtins.map((profile) => profile.name), ...sourceGroups.flatMap((group) => group.profiles.map((profile) => profile.name))]);
  const candidates = new Map<string, readonly InspectionProfile[]>();
  for (const name of names) {
    const fileCandidates = sourceGroups
      .toSorted((a, b) => b.priority - a.priority)
      .flatMap((group) => {
        const profile = new Map(group.profiles.map((item) => [item.name, item])).get(name);
        return profile === undefined ? [] : [profile];
      });
    const builtin = builtins.find((profile) => profile.name === name);
    candidates.set(name, builtin === undefined ? fileCandidates : [...fileCandidates, builtin]);
  }
  return {
    candidates,
    count: names.size,
    systemMdLoaded: systemProfile !== undefined,
  };
}

function fromAgentFile(profile: AgentFileDefinition): InspectionProfile {
  return {
    name: profile.name,
    override: profile.override,
    sourcePath: profile.path,
    systemPromptMode: profile.systemPromptMode,
    executor: profile.executor,
    promptOverrides: profile.promptOverrides,
    modelProfiles: profile.modelProfiles,
    fileBacked: true,
  };
}

function fromAgentProfile(profile: AgentProfile): InspectionProfile {
  return {
    name: profile.name,
    override: profile.override,
    sourcePath: profile.sourcePath,
    systemPromptMode: profile.systemPromptMode,
    executor: profile.executor,
    promptOverrides: profile.promptOverrides,
    promptOverrideLayers: profile.promptOverrideLayers,
    modelProfiles: profile.modelProfiles,
    fileBacked: profile.fileDefinition !== undefined || profile.sourcePath !== undefined,
  };
}

function fromShippedAgentProfile(profile: AgentProfile): InspectionProfile {
  return {
    name: profile.name,
    override: profile.override,
    systemPromptMode: profile.systemPromptMode,
    executor: profile.executor,
    promptOverrides: profile.promptOverrides,
    promptOverrideLayers: profile.promptOverrideLayers,
    modelProfiles: profile.modelProfiles,
    fileBacked: false,
  };
}

function resolveProfile(
  name: string,
  candidates: readonly InspectionProfile[],
  disabledBuiltin: ReadonlySet<string>,
  disabledNamed: ReadonlySet<string>,
): InspectionProfile | undefined {
  if (disabledNamed.has(name) && name !== 'agent') return undefined;
  const builtin = candidates.find((candidate) => !candidate.fileBacked);
  const files = candidates.filter((candidate) => candidate.fileBacked);
  for (const [index, candidate] of files.entries()) {
    if (builtin !== undefined && candidate.override !== true) continue;
    return resolveInheritedProfile(candidate, files, index, builtin);
  }
  return builtin === undefined || disabledBuiltin.has(name) ? undefined : builtin;
}

function resolveInheritedProfile(
  candidate: InspectionProfile,
  files: readonly InspectionProfile[],
  index: number,
  builtin: InspectionProfile | undefined,
): InspectionProfile {
  if (candidate.systemPromptMode !== 'inherit') return candidate;
  let lowerIndex = index + 1;
  if (builtin !== undefined) {
    for (;;) {
      const lower = files[lowerIndex];
      if (lower === undefined || lower.override === true) break;
      lowerIndex += 1;
    }
  }
  const lower = files[lowerIndex] === undefined
    ? builtin
    : resolveInheritedProfile(files[lowerIndex]!, files, lowerIndex, builtin);
  if (lower === undefined) {
    throw new Error(`Agent profile "${candidate.name}" uses system_prompt_mode "inherit" but has no lower-priority base profile.`);
  }
  const lowerLayers = lower.promptOverrideLayers
    ?? (lower.promptOverrides === undefined ? [] : [lower.promptOverrides]);
  return {
    ...candidate,
    promptOverrideLayers: candidate.promptOverrides === undefined
      ? lowerLayers
      : [...lowerLayers, candidate.promptOverrides],
  };
}

function matchModelProfile(
  entries: readonly AgentModelProfile[] | undefined,
  alias: string | undefined,
  models: ModelsSection,
  executor: string,
): AgentModelProfile | undefined {
  if (entries === undefined || alias === undefined) return undefined;
  const resolveId = executor === 'native'
    ? (id: string) => resolveModelId(models, id)
    : (id: string) => id;
  const canonical = resolveId(alias);
  if (canonical === undefined) return undefined;
  return entries.find((entry) => resolveId(entry.alias) === canonical);
}

async function validateAllSurfaces(
  registry: PromptFieldRegistryService,
  config: ParsedInspectionConfig,
  profiles: LoadedProfileSet,
  cwd: string,
): Promise<void> {
  await registry.resolve({
    global: { surface: 'global', overrides: config.prompt.overrides },
    customVariables: config.prompt.variables,
  });
  for (const [alias, model] of Object.entries(config.models)) {
    await registry.resolve({
      global: { surface: 'global', overrides: config.prompt.overrides },
      model: { surface: 'model', overrides: model.promptOverrides },
      context: { modelAlias: alias },
      customVariables: config.prompt.variables,
    });
  }
  const seen = new Set<string>();
  for (const candidates of profiles.candidates.values()) {
    for (const profile of candidates) {
      const key = `${profile.sourcePath ?? `builtin:${profile.name}`}\0${JSON.stringify(profile.promptOverrides ?? {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const surface = profile.sourcePath?.replaceAll('\\', '/').endsWith('/SYSTEM.md') === true
        ? 'system'
        : 'profile';
      await registry.resolve({
        global: { surface: 'global', overrides: config.prompt.overrides },
        profile: {
          surface,
          overrides: profile.promptOverrideLayers ?? profile.promptOverrides,
          sourcePath: profile.sourcePath ?? cwd,
        },
        context: { profileName: profile.name, executor: profile.executor ?? 'native' },
        customVariables: config.prompt.variables,
      });
      for (const entry of profile.modelProfiles ?? []) {
        await registry.resolve({
          profileModel: { surface: 'profile-model', overrides: entry.promptOverrides },
          context: { profileName: profile.name, modelAlias: entry.alias },
          customVariables: config.prompt.variables,
        });
      }
    }
  }
}

function shadowsSystemFields(
  profile: InspectionProfile,
  model: ModelsSection[string] | undefined,
): boolean {
  const sourcePath = profile.sourcePath?.replaceAll('\\', '/');
  const customBody = profile.fileBacked || sourcePath?.endsWith('/SYSTEM.md') === true;
  const profileShadows = customBody
    && profile.systemPromptMode !== 'prepend'
    && profile.systemPromptMode !== 'append'
    && profile.systemPromptMode !== 'inherit';
  const cognitionShadows = (profile.executor ?? 'native') === 'native'
    && model?.cognition?.overlayMode === 'replace'
    && model.cognition.overlay !== undefined;
  return profileShadows || cognitionShadows;
}

function applies(definition: PromptFieldDefinition, context: PromptFieldContext): boolean {
  const condition = definition.appliesTo;
  if (condition === undefined) return true;
  return matches(condition.profiles, context.profileName)
    && matches(condition.models, context.modelAlias)
    && matches(condition.executors, context.executor)
    && matches(condition.consumers, context.consumer)
    && matches(condition.delegationPositions, context.delegationPosition);
}

function matches(allowed: readonly string[] | undefined, actual: string | undefined): boolean {
  return allowed === undefined || (actual !== undefined && allowed.includes(actual));
}

function definitionInfo(definition: PromptFieldDefinition): PromptFieldDefinitionInfo {
  return {
    id: definition.id,
    owner: definition.owner,
    consumers: definition.consumers,
    overridable: !definition.readonly,
    allowEmpty: definition.allowEmpty,
    allowedVariables: definition.allowedVariables,
    requiredPlaceholders: definition.requiredPlaceholders,
    defaultKind: definition.defaultTemplate.kind,
    defaultValue: definition.defaultTemplate.value,
  };
}

function valueInfo(
  definition: PromptFieldDefinition,
  configuredValue: string | undefined,
  status: PromptFieldResolutionStatus,
  overrideSources: readonly PromptOverrideSourceLike[],
): PromptFieldValueInfo {
  const sourceCount = overrideSources.length;
  const sources: PromptFieldSourceInfo[] = [
    {
      surface: 'default',
      kind: 'default',
      status: sourceCount === 0 ? terminalSourceStatus(status) : 'shadowed',
    },
    ...overrideSources.map((source, index) => ({
      ...source,
      status: index === sourceCount - 1 ? terminalSourceStatus(status) : 'shadowed' as const,
    })),
  ];
  return {
    ...definitionInfo(definition),
    status,
    value: status === 'effective'
      ? configuredValue ?? definition.defaultTemplate.value
      : undefined,
    sources,
  };
}

function terminalSourceStatus(
  status: PromptFieldResolutionStatus,
): PromptFieldSourceInfo['status'] {
  return status === 'effective' ? 'effective' : status === 'inactive' ? 'inactive' : 'shadowed';
}

function countExternalFiles(config: ParsedInspectionConfig, profiles: LoadedProfileSet): number {
  let count = config.prompt.overrides?.files?.length ?? 0;
  for (const model of Object.values(config.models)) count += model.promptOverrides?.files?.length ?? 0;
  const seen = new Set<string>();
  for (const candidates of profiles.candidates.values()) {
    for (const profile of candidates) {
      const key = profile.sourcePath ?? `builtin:${profile.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      count += profile.promptOverrides?.files?.length ?? 0;
      for (const modelProfile of profile.modelProfiles ?? []) {
        count += modelProfile.promptOverrides?.files?.length ?? 0;
      }
    }
  }
  return count;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
