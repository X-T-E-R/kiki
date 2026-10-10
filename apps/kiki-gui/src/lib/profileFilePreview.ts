import { useQuery } from '@tanstack/react-query';

import { useConnection } from '../state/connection';
import type { AgentProfileCatalogMode } from './agentProfileCatalog';

/** Read-only preview, scoped to the connected host and the current draft target. */
export function useProfileFilePreview(path: string | undefined, catalog: AgentProfileCatalogMode) {
  const { client, scopeId, meta } = useConnection();
  const cwd = catalog.mode === 'cwd' ? catalog.cwd : undefined;
  const workspace_id = catalog.mode === 'workspace' ? catalog.workspaceId : undefined;
  return useQuery({
    queryKey: ['profile-file-preview', scopeId, meta?.server_id, catalog.mode, cwd, workspace_id, path],
    queryFn: () => client.rest.agents.previewFile({ path: path!, cwd, workspace_id }),
    enabled: path !== undefined && path.trim() !== '' && catalog.mode !== 'disabled',
    staleTime: 60_000,
    retry: false,
  });
}
