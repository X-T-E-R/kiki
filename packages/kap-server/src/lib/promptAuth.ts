import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  Error2,
  ErrorCodes,
  IAgentProfileService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IModelService,
  IProviderService,
  ISessionAgentProfileCatalog,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@kiki/agent-core-v2';
import { AGENT_EXECUTOR_OVERRIDES_SECTION, type AgentExecutorOverridesConfig } from '@kiki/agent-core-v2/app/agentExecutor/executorOverrides';
import { resolveSelectedExecutionBinding } from '@kiki/agent-core-v2/agent/profile/executionBinding';
import { IAdhocEndpointVault } from '@kiki/agent-core-v2/session/adhocEndpoint/adhocEndpointVault';
import { materializeAdhocModel } from '@kiki/agent-core-v2/session/adhocEndpoint/adhocEndpointRuntime';
import { resolveEndpointBinding } from '@kiki/agent-core-v2/session/adhocEndpoint/endpointBinding';
import { adhocEndpointModelId, type ExecutionSelection } from '@kiki/protocol';

interface CachedStaticAuth {
  readonly resolvedModelId: string;
  readonly providerId?: string;
}

interface AuthReadyCacheState {
  diskFingerprint?: string;
  readonly verifiedStaticModels: Map<string, CachedStaticAuth>;
}

const authReadyCaches = new WeakMap<IConfigService, AuthReadyCacheState>();

function getAuthReadyCache(config: IConfigService): AuthReadyCacheState {
  let state = authReadyCaches.get(config);
  if (state === undefined) {
    const created: AuthReadyCacheState = { verifiedStaticModels: new Map() };
    config.onDidChangeConfiguration?.(() => {
      created.verifiedStaticModels.clear();
    });
    authReadyCaches.set(config, created);
    state = created;
  }
  return state;
}

async function statToken(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    return `${String(info.size)}:${String(info.mtimeMs)}`;
  } catch {
    return '-';
  }
}

async function computeAuthFilesFingerprint(accessor: IAgentScopeHandle['accessor']): Promise<string | undefined> {
  let bootstrap: IBootstrapService;
  try {
    bootstrap = accessor.get(IBootstrapService);
  } catch {
    return undefined;
  }
  const paths = [
    bootstrap.configPath,
    join(bootstrap.homeDir, 'config.toml'),
    join(bootstrap.credentialsHomeDir, 'credentials', 'config.toml'),
    join(bootstrap.credentialsHomeDir, 'credentials.toml'),
    ...(bootstrap.baseHomeDir === undefined ? [] : [join(bootstrap.baseHomeDir, 'config.toml')]),
  ];
  const unique = [...new Set(paths.filter((item): item is string => typeof item === 'string' && item.length > 0))];
  if (unique.length === 0) return undefined;
  const tokens = await Promise.all(unique.map(statToken));
  return tokens.join('|');
}

function isStaticApiKeyModelReadyInMemory(
  accessor: IAgentScopeHandle['accessor'],
  requestedModel: string | undefined,
  expected?: CachedStaticAuth,
): CachedStaticAuth | undefined {
  try {
    const models = accessor.get(IModelService);
    const providers = accessor.get(IProviderService);
    const candidate = requestedModel ?? models.getDefaultModel();
    if (candidate === undefined || candidate === '') return undefined;
    const resolvedModelId = models.resolveId(candidate);
    if (resolvedModelId === undefined) return undefined;
    if (expected !== undefined && expected.resolvedModelId !== resolvedModelId) return undefined;
    const configured = models.get(resolvedModelId);
    if (configured === undefined) return undefined;
    const configuredRecord = configured as unknown as Record<string, unknown>;
    if (configuredRecord['oauth'] !== undefined) return undefined;
    const providerId = typeof configured.provider === 'string' && configured.provider.length > 0
      ? configured.provider
      : providers.getDefaultProvider();
    if (expected !== undefined && expected.providerId !== providerId) return undefined;
    if (providerId !== undefined) {
      const provider = providers.get(providerId);
      if (provider === undefined || provider.oauth !== undefined) return undefined;
      const key = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
      const modelKey = typeof configuredRecord['apiKey'] === 'string' ? configuredRecord['apiKey'].trim() : '';
      if (key.length === 0 && modelKey.length === 0) return undefined;
      return { resolvedModelId, providerId };
    }
    const directKey = typeof configuredRecord['apiKey'] === 'string' ? configuredRecord['apiKey'].trim() : '';
    if (directKey.length === 0) return undefined;
    return { resolvedModelId };
  } catch {
    return undefined;
  }
}

async function ensureNativeModelAuthReady(
  accessor: IAgentScopeHandle['accessor'],
  model: string | undefined,
): Promise<void> {
  let config: IConfigService | undefined;
  try {
    config = accessor.get(IConfigService);
  } catch {
    config = undefined;
  }
  const cacheKey = model ?? '__default__';
  if (config !== undefined) {
    const state = getAuthReadyCache(config);
    const fingerprint = await computeAuthFilesFingerprint(accessor);
    if (fingerprint !== undefined && fingerprint === state.diskFingerprint) {
      const cached = state.verifiedStaticModels.get(cacheKey);
      if (cached !== undefined && isStaticApiKeyModelReadyInMemory(accessor, model, cached) !== undefined) {
        return;
      }
    }
    await accessor.get(IAuthSummaryService).ensureReady(model);
    const afterFingerprint = await computeAuthFilesFingerprint(accessor);
    if (afterFingerprint !== undefined) {
      if (state.diskFingerprint !== afterFingerprint) {
        state.verifiedStaticModels.clear();
        state.diskFingerprint = afterFingerprint;
      }
      const verified = isStaticApiKeyModelReadyInMemory(accessor, model);
      if (verified !== undefined) {
        state.verifiedStaticModels.set(cacheKey, verified);
      }
    }
    return;
  }
  await accessor.get(IAuthSummaryService).ensureReady(model);
}

export async function ensurePromptAuthReady(
  session: ISessionScopeHandle,
  accessor: IAgentScopeHandle['accessor'],
  overrides: { readonly execution?: ExecutionSelection; readonly model?: string; readonly profile?: string } = {},
): Promise<void> {
  const profile = accessor.get(IAgentProfileService);
  const execution = overrides.execution;
  const bound = currentBoundEndpoint(profile.data(), overrides);
  if (bound !== undefined) {
    await materializeAdhocModel(bound, session.accessor.get(IAdhocEndpointVault)).authProvider.getAuth();
    return;
  }
  const endpointReady = async (selected: import('@kiki/agent-core-v2').AgentProfile): Promise<boolean> => {
    if ((selected.executor ?? 'native') !== 'native' || selected.endpoint === undefined) return false;
    const selectedModel = overrides.model ?? execution?.overrides?.model;
    if (selectedModel === null) return false;
    if (selectedModel !== undefined) {
      const input = selected.endpoint;
      if (input.base_url === undefined || input.model === undefined) return false;
      if (selectedModel !== adhocEndpointModelId({ provider_type: input.provider_type ?? 'openai', base_url: input.base_url, model: input.model })) return false;
    }
    const vault = session.accessor.get(IAdhocEndpointVault);
    const endpoint = resolveEndpointBinding(selected, undefined, undefined, vault);
    if (endpoint === undefined) return false;
    await materializeAdhocModel(endpoint, vault).authProvider.getAuth();
    return true;
  };
  const fileProfile = execution?.profile_file === undefined ? undefined
    : await profile.resolveFile(execution.profile_file);
  if (execution !== undefined && execution.executor !== 'native') return;
  if (execution === undefined && overrides.profile === undefined && (profile.data().executorId ?? 'native') !== 'native') return;
  if (fileProfile !== undefined && await endpointReady(fileProfile)) return;
  if (execution !== undefined) {
    const selectedName = execution.profile;
    if (selectedName !== undefined) {
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.ready;
      const selected = selectedName === DEFAULT_AGENT_PROFILE_NAME ? catalog.getDefault() : catalog.get(selectedName);
      if (selected !== undefined && await endpointReady(selected)) return;
    }
    await ensureNativeModelAuthReady(accessor, await nativeExecutionAuthModel(
      session, accessor, profile, execution, fileProfile, overrides.model,
    ));
    return;
  }
  const selectedProfile = overrides.profile;
  let model = overrides.model ?? undefined;
  if (model === undefined) {
    if (selectedProfile !== undefined && selectedProfile !== profile.data().profileName) {
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.ready;
      const selected = selectedProfile === DEFAULT_AGENT_PROFILE_NAME ? catalog.getDefault() : catalog.get(selectedProfile);
      if (selected === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown agent profile: "${selectedProfile}"`);
      if ((selected.executor ?? 'native') !== 'native') return;
      if (await endpointReady(selected)) return;
      model = selected.modelAlias;
    } else {
      model = profile.getModel() || undefined;
      if (model === undefined && profile.data().profileName === undefined) {
        const catalog = session.accessor.get(ISessionAgentProfileCatalog);
        await catalog.ready;
        const selected = catalog.getDefault();
        if ((selected.executor ?? 'native') !== 'native') return;
        if (await endpointReady(selected)) return;
        model = selected.modelAlias;
      }
    }
  }
  await ensureNativeModelAuthReady(accessor, model);
}

function currentBoundEndpoint(
  data: ReturnType<IAgentProfileService['data']>,
  overrides: { readonly execution?: ExecutionSelection; readonly model?: string; readonly profile?: string },
): ReturnType<IAgentProfileService['data']>['endpoint'] {
  const endpoint = data.endpoint;
  if (endpoint === undefined || data.driver === 'external' || (data.executorId ?? 'native') !== 'native') return undefined;
  const modelId = adhocEndpointModelId(endpoint);
  if (data.modelAlias !== modelId) return undefined;
  if (overrides.profile !== undefined && overrides.profile !== data.profileName) return undefined;
  const execution = overrides.execution;
  if (execution !== undefined && (execution.executor !== 'native' || execution.profile_file !== undefined ||
    (execution.profile !== undefined && execution.profile !== data.profileName))) return undefined;
  if (overrides.model !== undefined && overrides.model !== modelId) return undefined;
  if (overrides.model === undefined && execution?.overrides?.model !== undefined && execution.overrides.model !== modelId) return undefined;
  return endpoint;
}

async function nativeExecutionAuthModel(
  session: ISessionScopeHandle,
  accessor: IAgentScopeHandle['accessor'],
  profile: IAgentProfileService,
  execution: ExecutionSelection,
  fileProfile: Awaited<ReturnType<IAgentProfileService['resolveFile']>> | undefined,
  requestedModel: string | undefined,
): Promise<string | undefined> {
  let selected = fileProfile;
  const selectedName = execution.profile;
  if (fileProfile === undefined && selectedName !== undefined) {
    const catalog = session.accessor.get(ISessionAgentProfileCatalog);
    await catalog.ready;
    selected = selectedName === DEFAULT_AGENT_PROFILE_NAME ? catalog.getDefault() : catalog.get(selectedName);
    if (selected === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown agent profile: "${selectedName}"`);
  }
  const config = accessor.get(IConfigService);
  const cacheState = getAuthReadyCache(config);
  const fingerprint = await computeAuthFilesFingerprint(accessor);
  if (fingerprint === undefined || fingerprint !== cacheState.diskFingerprint) {
    await config.reload();
  }
  const models = accessor.get(IModelService);
  const requested = execution.profile_file === undefined ? execution : { ...execution, profile_file: fileProfile?.sourcePath };
  const defaults = config.get<AgentExecutorOverridesConfig>(AGENT_EXECUTOR_OVERRIDES_SECTION)?.[requested.executor]?.defaults;
  const configured = config.get<string>('defaultModel')?.trim();
  const engineModel = configured === undefined || configured.length === 0 ? undefined : models.resolveId(configured);
  const binding = profile.data();
  const liveModel = binding.execution === undefined && (binding.executorId ?? 'native') === requested.executor
    ? profile.getModel() || undefined
    : undefined;
  return resolveSelectedExecutionBinding(requested, {
    model: requestedModel ?? execution.overrides?.model,
  }, defaults, selected, binding.execution, { model: engineModel }, liveModel).effective.model;
}
