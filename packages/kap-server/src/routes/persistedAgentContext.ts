import { IModelCatalog, IModelService, type Scope } from '@kiki/agent-core-v2';
import { modelWithUsage } from '@kiki/agent-core-v2/kosong/model/parameters';
import { mergeModelParameters, resolveModelProfileEntry } from '@kiki/agent-core-v2/app/agentProfileCatalog/modelProfileOverlay';
import type { PersistedAgentProfileSnapshot } from './agentProfileSnapshot';

export function persistedAgentContextLimit(core: Scope, profile: PersistedAgentProfileSnapshot | undefined, modelAlias = profile?.modelAlias, position: 'main' | 'sub' = 'main'): number | undefined {
  if (profile?.driver === 'external' || (profile?.executorId ?? 'native') !== 'native' || modelAlias === undefined) return undefined;
  try {
    const bound = profile?.boundProfile;
    const cognition = bound?.promptBase?.inputs?.cognition;
    const settings = cognition?.modelAlias === modelAlias ? cognition.modelSettings ?? cognition.recipe?.resolved.model : undefined;
    const model = modelWithUsage(core.accessor.get(IModelCatalog).get(modelAlias, settings), cognition?.position ?? position);
    const entry = resolveModelProfileEntry(bound?.modelProfiles, model.id, (id) => core.accessor.get(IModelService).resolveId(id));
    const budget = mergeModelParameters(model, mergeModelParameters(bound ?? {}, entry)).contextBudget;
    const limit = model.capabilities.max_input_tokens ?? model.capabilities.max_context_tokens;
    return budget === undefined ? limit : Math.min(limit, budget);
  } catch { return undefined; }
}
