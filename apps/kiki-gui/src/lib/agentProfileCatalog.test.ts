import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KikiClient } from './client';
import {
  agentProfileCatalogQueryKey,
  loadAgentProfileCatalog,
  type AgentProfileCatalogMode,
} from './agentProfileCatalog';

const mode: AgentProfileCatalogMode = {
  mode: 'cwd',
  cwd: 'C:/workspace',
  effective: true,
};

afterEach(() => {
  vi.useRealTimers();
});

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

  it('refetches an incomplete catalog once and only caches the complete response', async () => {
    vi.useFakeTimers();
    const listNamedAgentProfiles = vi.fn()
      .mockResolvedValueOnce({ items: [], complete: false })
      .mockResolvedValueOnce({ items: [], complete: true });
    const client = { listNamedAgentProfiles } as unknown as Pick<KikiClient, 'listNamedAgentProfiles'>;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const request = queryClient.fetchQuery({
      queryKey: agentProfileCatalogQueryKey(mode),
      queryFn: () => loadAgentProfileCatalog(client, mode),
      staleTime: 60_000,
    });

    await Promise.resolve();
    expect(queryClient.getQueryData(agentProfileCatalogQueryKey(mode))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    await expect(request).resolves.toEqual({ items: [], complete: true });

    expect(listNamedAgentProfiles).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(agentProfileCatalogQueryKey(mode))).toEqual({
      items: [],
      complete: true,
    });
    queryClient.clear();
  });

  it('rejects after one bounded retry when the catalog stays incomplete', async () => {
    vi.useFakeTimers();
    const listNamedAgentProfiles = vi.fn().mockResolvedValue({ items: [], complete: false });
    const client = { listNamedAgentProfiles } as unknown as Pick<KikiClient, 'listNamedAgentProfiles'>;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const request = queryClient.fetchQuery({
      queryKey: agentProfileCatalogQueryKey(mode),
      queryFn: () => loadAgentProfileCatalog(client, mode),
      staleTime: 60_000,
    });

    const rejection = expect(request).rejects.toThrow('Agent profile catalog is still loading');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await rejection;

    expect(listNamedAgentProfiles).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(agentProfileCatalogQueryKey(mode))).toBeUndefined();
    queryClient.clear();
  });
});
