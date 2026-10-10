import {
  DEFAULT_AGENT_PROFILE_NAME,
  Error2,
  ErrorCodes,
  IAgentProfileService,
  IAuthSummaryService,
  ISessionAgentProfileCatalog,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@kiki/agent-core-v2';

export async function ensurePromptAuthReady(
  session: ISessionScopeHandle,
  accessor: IAgentScopeHandle['accessor'],
  overrides: { readonly execution?: import('@kiki/protocol').ExecutionSelection; readonly model?: string; readonly profile?: string } = {},
): Promise<void> {
  const profile = accessor.get(IAgentProfileService);
  const fileProfile = overrides.execution?.profile_file === undefined ? undefined
    : await profile.resolveFile(overrides.execution.profile_file);
  if (fileProfile !== undefined && (fileProfile.executor ?? 'native') !== overrides.execution!.executor) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `Profile file does not use executor "${overrides.execution!.executor}"`);
  }
  if (overrides.execution !== undefined && overrides.execution.executor !== 'native') return;
  if (overrides.execution === undefined && overrides.profile === undefined && (profile.data().executorId ?? 'native') !== 'native') return;
  const selectedProfile = overrides.execution?.profile ?? overrides.profile;
  let model = overrides.model ?? overrides.execution?.overrides?.model ?? undefined;
  if (model === undefined) {
    if (fileProfile !== undefined) {
      model = fileProfile.modelAlias;
    } else if (selectedProfile !== undefined && (overrides.execution !== undefined || selectedProfile !== profile.data().profileName)) {
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.ready;
      const selected = selectedProfile === DEFAULT_AGENT_PROFILE_NAME ? catalog.getDefault() : catalog.get(selectedProfile);
      if (selected === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown agent profile: "${selectedProfile}"`);
      if ((selected.executor ?? 'native') !== 'native') return;
      model = selected.modelAlias;
    } else if (overrides.execution === undefined) {
      model = profile.getModel() || undefined;
    }
  }
  await accessor.get(IAuthSummaryService).ensureReady(model);
}
