import type { ListNamedAgentProfilesResponse } from '@moonshot-ai/protocol';

import type { KikiClient } from './client';

export type AgentProfileCatalogMode =
  | { readonly mode: 'global' }
  | { readonly mode: 'workspace'; readonly workspaceId: string }
  | { readonly mode: 'disabled' };

export function agentProfileCatalogQueryKey(
  catalog: AgentProfileCatalogMode,
): readonly string[] {
  return catalog.mode === 'workspace'
    ? ['agentProfiles', 'workspace', catalog.workspaceId]
    : ['agentProfiles', catalog.mode];
}

export function loadAgentProfileCatalog(
  client: Pick<KikiClient, 'listNamedAgentProfiles'>,
  catalog: AgentProfileCatalogMode,
): Promise<ListNamedAgentProfilesResponse> {
  if (catalog.mode === 'workspace') {
    return client.listNamedAgentProfiles(catalog.workspaceId);
  }
  if (catalog.mode === 'global') return client.listNamedAgentProfiles();
  return Promise.resolve({ items: [] });
}
