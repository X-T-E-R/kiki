import {
  DEFAULT_AGENT_PROFILE_NAME,
  Error2,
  ErrorCodes,
  IAgentProfileService,
  IAuthSummaryService,
  IConfigService,
  IModelService,
  ISessionAgentProfileCatalog,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@kiki/agent-core-v2';
import { AGENT_EXECUTOR_OVERRIDES_SECTION, type AgentExecutorOverridesConfig } from '@kiki/agent-core-v2/app/agentExecutor/executorOverrides';
import { resolveSelectedExecutionBinding } from '@kiki/agent-core-v2/agent/profile/executionBinding';
import type { ExecutionSelection } from '@kiki/protocol';

export async function ensurePromptAuthReady(
  session: ISessionScopeHandle,
  accessor: IAgentScopeHandle['accessor'],
  overrides: { readonly execution?: ExecutionSelection; readonly model?: string; readonly profile?: string } = {},
): Promise<void> {
  const profile = accessor.get(IAgentProfileService);
  const execution = overrides.execution;
  const fileProfile = execution?.profile_file === undefined ? undefined
    : await profile.resolveFile(execution.profile_file);
  if (execution !== undefined && execution.executor !== 'native') return;
  if (execution === undefined && overrides.profile === undefined && (profile.data().executorId ?? 'native') !== 'native') return;
  if (execution !== undefined) {
    await accessor.get(IAuthSummaryService).ensureReady(await nativeExecutionAuthModel(
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
      model = selected.modelAlias;
    } else {
      model = profile.getModel() || undefined;
      if (model === undefined && profile.data().profileName === undefined) {
        const catalog = session.accessor.get(ISessionAgentProfileCatalog);
        await catalog.ready;
        const selected = catalog.getDefault();
        if ((selected.executor ?? 'native') !== 'native') return;
        model = selected.modelAlias;
      }
    }
  }
  await accessor.get(IAuthSummaryService).ensureReady(model);
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
  await config.reload();
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
