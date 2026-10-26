import type { ListNamedAgentProfilesResponse } from '@kiki/protocol';
import type { QueryClient } from '@tanstack/react-query';

import type { KikiClient } from './client';

export async function invalidateAgentProfileCatalogs(client: QueryClient): Promise<void> {
  await Promise.all(['named-agent-profiles', 'agentProfiles', 'agentCapabilities'].map(
    (key) => client.invalidateQueries({ queryKey: [key] }),
  ));
}

export type AgentProfileCatalogMode =
  | { readonly mode: 'global' }
  | { readonly mode: 'unscoped' }
  | { readonly mode: 'workspace'; readonly workspaceId: string; readonly effective?: boolean }
  | { readonly mode: 'cwd'; readonly cwd: string; readonly effective?: boolean }
  | { readonly mode: 'disabled' };

export function agentProfileCatalogQueryKey(
  catalog: AgentProfileCatalogMode,
): readonly string[] {
  if (catalog.mode === 'workspace') {
    return catalog.effective
      ? ['agentProfiles', 'workspace', catalog.workspaceId, 'effective']
      : ['agentProfiles', 'workspace', catalog.workspaceId];
  }
  if (catalog.mode === 'cwd') {
    return catalog.effective
      ? ['agentProfiles', 'cwd', catalog.cwd, 'effective']
      : ['agentProfiles', 'cwd', catalog.cwd];
  }
  return ['agentProfiles', catalog.mode];
}

const INCOMPLETE_CATALOG_RETRY_DELAY_MS = 250;

export function agentProfileCatalogRefetchInterval(query: {
  readonly state: { readonly data: ListNamedAgentProfilesResponse | undefined; readonly error: Error | null };
}): number | false {
  return query.state.error === null && query.state.data?.complete === false ? INCOMPLETE_CATALOG_RETRY_DELAY_MS : false;
}

export async function loadAgentProfileCatalog(
  client: Pick<KikiClient, 'listNamedAgentProfiles'>,
  catalog: AgentProfileCatalogMode,
): Promise<ListNamedAgentProfilesResponse> {
  if (catalog.mode === 'disabled') return { items: [], complete: true };
  const load = (): Promise<ListNamedAgentProfilesResponse> => {
    if (catalog.mode === 'workspace') {
      return client.listNamedAgentProfiles(
        catalog.effective
          ? { workspace_id: catalog.workspaceId, effective: true }
          : catalog.workspaceId,
      );
    }
    if (catalog.mode === 'cwd') {
      return client.listNamedAgentProfiles(
        catalog.effective ? { cwd: catalog.cwd, effective: true } : { cwd: catalog.cwd },
      );
    }
    return catalog.mode === 'unscoped'
      ? client.listNamedAgentProfiles({ unscoped: true })
      : client.listNamedAgentProfiles();
  };
  const unscoped = (response: ListNamedAgentProfilesResponse): ListNamedAgentProfilesResponse =>
    catalog.mode === 'unscoped'
      ? { ...response, items: response.items.filter((item) =>
          item.workspace_id === undefined && (item.workspace_ids?.length ?? 0) === 0
        ) }
      : response;
  return unscoped(await load());
}
