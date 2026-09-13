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
  overrides: { readonly model?: string; readonly profile?: string } = {},
): Promise<void> {
  const profile = accessor.get(IAgentProfileService);
  let model = overrides.model;
  if (model === undefined) {
    if (overrides.profile !== undefined && overrides.profile !== profile.data().profileName) {
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.ready;
      const selected = overrides.profile === DEFAULT_AGENT_PROFILE_NAME
        ? catalog.getDefault()
        : catalog.get(overrides.profile);
      if (selected === undefined) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown agent profile: "${overrides.profile}"`);
      }
      model = selected.modelAlias;
    } else {
      model = profile.getModel() || undefined;
    }
  }
  await accessor.get(IAuthSummaryService).ensureReady(model);
}
