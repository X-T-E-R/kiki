/**
 * Builds the ContextMeter's `autoCompact` wiring for one agent: the server
 * status, the per-agent session write, and the three "save as default"
 * targets with an undo that restores the target layer and the session value
 * it replaced. Returns undefined until the server reports a point (older
 * engines and external executors keep the plain meter).
 */

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AutoCompactWriteResult, ModelCatalogItem } from '@kiki/protocol';

import type { KikiConfigResponse, NamedAgentProfile } from '../lib/client';
import {
  agentProfileCatalogQueryKey,
  loadAgentProfileCatalog,
  type AgentProfileCatalogMode,
} from '../lib/agentProfileCatalog';
import type { AutoCompactSaveTarget } from '../lib/autoCompact';
import { useConnection } from '../state/connection';
import type { CompactSaveOutcome } from './ContextCompactSection';
import type { ContextMeterAutoCompact } from './ContextMeter';
import { useAutoCompact } from './useAutoCompact';
import { useContextStrategy } from './useContextStrategy';

function profileWritable(profile: NamedAgentProfile | undefined): boolean {
  return profile !== undefined
    && profile.workspace_id !== undefined
    && profile.source_file !== undefined
    && (profile.source === 'user' || profile.source === 'workspace' || profile.source === 'extra');
}

function profileScope(profile: NamedAgentProfile): 'user' | 'project' | 'extra' {
  return profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra';
}

export function useContextMeterAutoCompact(input: {
  readonly sessionId: string | undefined;
  readonly agentId: string;
  /** Canonical model id currently bound to the agent. */
  readonly modelId: string | undefined;
  readonly modelLabel?: string;
  readonly maxContextTokens: number | undefined;
  readonly running: boolean;
  /** Main agent only: the bound profile and the catalog that describes it. */
  readonly profileName?: string;
  readonly profileCatalog?: AgentProfileCatalogMode;
}): ContextMeterAutoCompact | undefined {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const catalog = input.profileCatalog ?? { mode: 'disabled' as const };
  const handle = useAutoCompact({
    sessionId: input.sessionId,
    agentId: input.agentId,
    refreshKey: `${input.modelId ?? ''}:${input.maxContextTokens ?? ''}`,
  });
  const strategy = useContextStrategy({ sessionId: input.sessionId, agentId: input.agentId });
  const profilesQuery = useQuery({
    queryKey: agentProfileCatalogQueryKey(catalog),
    queryFn: () => loadAgentProfileCatalog(client, catalog),
    enabled: input.profileName !== undefined && catalog.mode !== 'disabled',
    staleTime: 60_000,
    retry: false,
  });
  const boundProfile = input.profileName === undefined
    ? undefined
    : profilesQuery.data?.items.find((item) => item.name === input.profileName);

  const status = handle?.status;
  return useMemo(() => {
    if (handle === undefined || status === undefined) return undefined;
    const restoreSession = async (): Promise<void> => {
      await handle.write({ tokens: status.source === 'session' ? status.tokens : null });
    };
    const onSave = async (target: AutoCompactSaveTarget, tokens: number): Promise<CompactSaveOutcome> => {
      let restoreLayer: (() => Promise<unknown>) | undefined;
      if (target === 'model' && input.modelId !== undefined) {
        const models = queryClient.getQueryData<{ items: ModelCatalogItem[] }>(['models'])?.items;
        const previous = models?.find((item) => item.id === input.modelId)?.auto_compact;
        const modelId = input.modelId;
        restoreLayer = async () => {
          const entity = await client.getModel(modelId);
          await client.updateModel(modelId, { auto_compact: previous ?? null, base_revision: entity.revision });
        };
      } else if (target === 'profile' && boundProfile !== undefined && profileWritable(boundProfile)) {
        const previous = boundProfile.auto_compact;
        const profile = boundProfile;
        restoreLayer = () => client.updateNamedAgentProfile(profile.name, {
          scope: profileScope(profile),
          workspace_id: profile.workspace_id!,
          source_file: profile.source_file,
          auto_compact: previous ?? null,
        });
      } else if (target === 'global') {
        const config = queryClient.getQueryData<KikiConfigResponse>(['config']) ?? await client.getConfig();
        const previous = config.loop_control;
        restoreLayer = () => client.patchConfig({
          loop_control: previous ?? {},
          replace_domains: ['loop_control'],
        });
      }
      const result: AutoCompactWriteResult = await handle.write({ tokens, save: target });
      const undo = restoreLayer === undefined ? undefined : async () => {
        await restoreLayer!();
        await restoreSession();
        void queryClient.invalidateQueries({ queryKey: target === 'model' ? ['models'] : target === 'profile' ? ['agentProfiles'] : ['config'] });
      };
      return { result, undo };
    };
    return {
      status,
      defaultStatus: handle.defaultStatus,
      running: input.running,
      modelLabel: input.modelLabel ?? input.modelId,
      profile: input.profileName === undefined
        ? undefined
        : { name: input.profileName, editable: profileWritable(boundProfile) },
      onCommit: (tokens) => handle.write({ tokens }),
      onSave,
      onOpen: () => { handle.refresh(); strategy?.refresh(); },
      strategy,
    };
  }, [boundProfile, client, handle, input.modelId, input.modelLabel, input.profileName, input.running, queryClient, status, strategy]);
}
