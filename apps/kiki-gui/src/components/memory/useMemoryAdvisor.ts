import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { MemorySettingsPatch, MemorySettingsResponse } from '@kiki/protocol';
import { memoryAdvisorModePatch, memoryAdvisorView } from '@kiki/session-core/settings';

import { useConnection } from '../../state/connection';

/**
 * Every memory-settings read sits under this prefix: the plain settings read
 * the memory page and the Memory card use, and one advisor read per workspace.
 * A write from any entry refreshes all of them, so the quick switch, the
 * Memory page header and the settings card never disagree.
 */
export const MEMORY_SETTINGS_PREFIX = ['memory-settings'] as const;
export const memoryAdvisorQueryKey = (workspaceId?: string) => [...MEMORY_SETTINGS_PREFIX, 'advisor', workspaceId ?? null] as const;
const ADVISOR_PREFIX = [...MEMORY_SETTINGS_PREFIX, 'advisor'] as const;

/**
 * A write to memory itself (the global switch, a workspace override, the
 * budget) changes what every advisor read reports: its status turns
 * `disabled` the moment memory is off. Callers that write those fields
 * re-read every advisor read through this, not only the plain settings key.
 */
export function invalidateMemoryAdvisorReads(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ADVISOR_PREFIX });
}

/** Live status of one running agent; read on request, never polled. */
export const memoryAdvisorRuntimeKey = (sessionId: string, agentId: string) => ['memory-advisor-runtime', sessionId, agentId] as const;

export function useMemoryAdvisor(workspaceId?: string) {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const queryKey = memoryAdvisorQueryKey(workspaceId);
  const query = useQuery({
    queryKey,
    queryFn: () => client.getMemoryAdvisorSettings(workspaceId),
    staleTime: 15_000,
  });
  const save = useMutation({
    mutationFn: (patch: MemorySettingsPatch) => client.patchMemoryAdvisorSettings(patch, workspaceId),
    onSuccess: async (next: MemorySettingsResponse) => {
      queryClient.setQueryData(queryKey, next);
      // The plain settings read carries the same `advisor` block; other
      // workspaces' reads carry their own status, so they are re-read.
      queryClient.setQueryData(MEMORY_SETTINGS_PREFIX, (current: object | undefined) => (current === undefined ? current : { ...current, advisor: next.advisor }));
      await queryClient.invalidateQueries({
        queryKey: MEMORY_SETTINGS_PREFIX,
        predicate: (entry) => entry.queryKey.length > 1 && JSON.stringify(entry.queryKey) !== JSON.stringify(queryKey),
      });
    },
  });
  const data = query.data;
  const view = memoryAdvisorView(data?.advisor, data?.advisor_status);
  return {
    query,
    data,
    view,
    save,
    /** The quick switch: the mode alone, so the chosen model and consent stay. */
    setOn: (on: boolean) => save.mutateAsync(memoryAdvisorModePatch(on, data?.advisor)),
  };
}
