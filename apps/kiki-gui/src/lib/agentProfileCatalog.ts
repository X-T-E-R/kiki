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

export function loadAgentProfileCatalog(
  client: Pick<KikiClient, 'listNamedAgentProfiles'>,
  catalog: AgentProfileCatalogMode,
): Promise<ListNamedAgentProfilesResponse> {
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
  if (catalog.mode === 'global') return client.listNamedAgentProfiles();
  return Promise.resolve({ items: [] });
}
