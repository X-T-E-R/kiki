import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { KikiClient } from './client';
import {
  agentProfileCatalogQueryKey,
  agentProfileCatalogRefetchInterval,
  loadAgentProfileCatalog,
  type AgentProfileCatalogMode,
} from './agentProfileCatalog';

const mode: AgentProfileCatalogMode = {
  mode: 'cwd',
  cwd: 'C:/workspace',
  effective: true,
};

describe('loadAgentProfileCatalog', () => {
  it('requests a workspace-free effective preview instead of filtering the loaded global registrations', async () => {
    const items = [
      { name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] },
      { name: 'lead', source: 'user', main: true, disabled: false, routes: [], workspace_ids: ['wd_a'] },
      { name: 'scoped', source: 'workspace', main: true, disabled: false, routes: [], workspace_id: 'wd_a' },
    ];
    const previewItems = [{ ...items[1], workspace_ids: undefined }];
    const listNamedAgentProfiles = vi.fn().mockImplementation((query) =>
      Promise.resolve({ items: query?.unscoped ? previewItems : items, complete: true })
    );
    const client = { listNamedAgentProfiles } as unknown as Pick<KikiClient, 'listNamedAgentProfiles'>;

    const unscoped = await loadAgentProfileCatalog(client, { mode: 'unscoped' });
    expect(unscoped.items.map((item) => item.name)).toEqual(['lead']);
    expect(await loadAgentProfileCatalog(client, { mode: 'global' })).toEqual({ items, complete: true });
    expect(listNamedAgentProfiles.mock.calls).toEqual([[{ unscoped: true }], []]);
    expect(agentProfileCatalogQueryKey({ mode: 'unscoped' })).not.toEqual(agentProfileCatalogQueryKey({ mode: 'global' }));
  });

  it('caches an incomplete catalog immediately with its loaded profiles available', async () => {
    const response = { items: [{ name: 'lead', source: 'user', main: true, disabled: false, routes: [] }], complete: false };
    const listNamedAgentProfiles = vi.fn().mockResolvedValue(response);
    const client = { listNamedAgentProfiles } as unknown as Pick<KikiClient, 'listNamedAgentProfiles'>;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(queryClient.fetchQuery({
      queryKey: agentProfileCatalogQueryKey(mode),
      queryFn: () => loadAgentProfileCatalog(client, mode),
      staleTime: 60_000,
    })).resolves.toEqual(response);

    expect(listNamedAgentProfiles).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(agentProfileCatalogQueryKey(mode))).toEqual(response);
    queryClient.clear();
  });

  it('continues incomplete responses and stops after completion or a read failure', () => {
    expect(agentProfileCatalogRefetchInterval({ state: { data: { items: [], complete: false }, error: null } })).toBe(250);
    expect(agentProfileCatalogRefetchInterval({ state: { data: { items: [], complete: true }, error: null } })).toBe(false);
    expect(agentProfileCatalogRefetchInterval({ state: { data: undefined, error: null } })).toBe(false);
    expect(agentProfileCatalogRefetchInterval({ state: { data: { items: [], complete: false }, error: new Error('offline') } })).toBe(false);
  });
});
