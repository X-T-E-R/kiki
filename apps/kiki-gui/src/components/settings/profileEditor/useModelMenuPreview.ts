import { useQuery } from '@tanstack/react-query';
import type { AgentModelMenuDraft, NamedAgentProfile, UpdateNamedAgentProfileRequest } from '@kiki/protocol';
import { useConnection } from '../../../state/connection';
import type { ModelMenuPreviewData } from './ModelMenuPreview';

/** Only permission-affecting changes belong in the server's preview request. */
export function modelMenuDraftPatch(patch: UpdateNamedAgentProfileRequest, profile?: NamedAgentProfile): AgentModelMenuDraft {
  const aliases = patch.model_profiles?.map((entry) => ({ alias: entry.alias })) ?? patch.model_profiles;
  const sameMenu = profile !== undefined && JSON.stringify(aliases ?? []) === JSON.stringify(profile.model_profiles?.map((entry) => ({ alias: entry.alias })) ?? []);
  return {
    pinned_model_alias: patch.pinned_model_alias,
    restrict_models_to_menu: patch.restrict_models_to_menu,
    model_profiles: sameMenu ? undefined : aliases,
    allowed_models: patch.allowed_models,
    deny_models: patch.deny_models,
    executor: patch.executor,
    main: patch.main,
  };
}

export function useModelMenuPreview(profile: NamedAgentProfile, draft: AgentModelMenuDraft, checked: boolean) {
  const { client } = useConnection();
  const changed = Object.values(draft).some((value) => value !== undefined);
  const needed = checked && changed;
  const query = useQuery({
    queryKey: ['profile-model-menu-preview', profile.workspace_id, profile.source_file, profile.name, draft],
    queryFn: ({ signal }) => {
      const agents = client.klient.rest?.agents;
      if (agents === undefined) throw new Error('Model menu preview is unavailable');
      return agents.previewModelMenu(profile.name, {
        workspace_id: profile.workspace_id!, source_file: profile.source_file, draft,
      }, { signal });
    },
    enabled: needed && profile.workspace_id !== undefined,
    staleTime: 0,
    retry: false,
  });
  const projected = needed ? query.data : profile;
  const value: ModelMenuPreviewData | undefined = projected?.declared_model_menu === undefined ? undefined : {
    declared: projected.declared_model_menu.aliases,
    defaultAlias: projected.declared_model_menu.default_alias,
    effective: projected.effective_model_aliases,
    added: needed ? query.data?.added_model_identities : undefined,
    removed: needed ? query.data?.removed_model_identities : undefined,
  };
  return {
    value,
    pending: needed && query.isPending,
    error: needed && query.isError,
    ready: !needed || query.isSuccess,
    retry: () => { void query.refetch(); },
  };
}
