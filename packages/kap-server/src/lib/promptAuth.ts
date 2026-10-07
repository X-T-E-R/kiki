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
  if (overrides.execution !== undefined && overrides.execution.executor !== 'native') return;
  if (overrides.execution === undefined && overrides.profile === undefined && (profile.data().executorId ?? 'native') !== 'native') return;
  const selectedProfile = overrides.execution?.profile ?? overrides.profile;
  let model = overrides.model ?? overrides.execution?.overrides?.model ?? undefined;
  if (model === undefined) {
    if (selectedProfile !== undefined && (overrides.execution !== undefined || selectedProfile !== profile.data().profileName)) {
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.ready;
      const selected = selectedProfile === DEFAULT_AGENT_PROFILE_NAME ? catalog.getDefault() : catalog.get(selectedProfile);
      if (selected === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown agent profile: "${selectedProfile}"`);
      if ((selected.executor ?? 'native') !== 'native') return;
      model = selected.modelAlias;
    } else if (overrides.execution === undefined) {
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
