import { IModelCatalog, IModelService, type Scope } from '@kiki/agent-core-v2';
import { materializeAdhocModel } from '@kiki/agent-core-v2/session/adhocEndpoint/adhocEndpointRuntime';
import { modelWithUsage } from '@kiki/agent-core-v2/kosong/model/parameters';
import { mergeModelParameters, resolveModelProfileEntry } from '@kiki/agent-core-v2/app/agentProfileCatalog/modelProfileOverlay';
import type { PersistedAgentProfileSnapshot } from './agentProfileSnapshot';

export function persistedAgentContextLimit(core: Scope, profile: PersistedAgentProfileSnapshot | undefined, modelAlias = profile?.modelAlias, position: 'main' | 'sub' = 'main'): number | undefined {
  if (profile?.driver === 'external' || (profile?.executorId ?? 'native') !== 'native') return undefined;
  try {
    const bound = profile?.boundProfile;
    const endpointModel = profile?.endpoint === undefined ? undefined : materializeAdhocModel(profile.endpoint);
    const effectiveAlias = modelAlias ?? endpointModel?.id;
    if (effectiveAlias === undefined) return undefined;
    const cognition = bound?.promptBase?.inputs?.cognition;
    const settings = cognition?.modelAlias === effectiveAlias ? cognition.modelSettings ?? cognition.recipe?.resolved.model : undefined;
    const model = endpointModel
      ?? modelWithUsage(core.accessor.get(IModelCatalog).get(effectiveAlias, settings), cognition?.position ?? position);
    const entry = endpointModel === undefined
      ? resolveModelProfileEntry(bound?.modelProfiles, model.id, (id) => core.accessor.get(IModelService).resolveId(id))
      : undefined;
    const budget = mergeModelParameters(model, mergeModelParameters(bound ?? {}, entry)).contextBudget;
    const limit = model.capabilities.max_input_tokens ?? model.capabilities.max_context_tokens ?? model.maxContextSize;
    return budget === undefined ? limit : Math.min(limit, budget);
  } catch { return undefined; }
}
