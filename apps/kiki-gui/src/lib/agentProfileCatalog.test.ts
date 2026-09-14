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
