import {
  IConfigService,
  IModelCatalog,
  IModelService,
  IProtocolAdapterRegistry,
  type Scope,
  type ThinkingEffort,
} from '@kiki/agent-core-v2';
import {
  drivesThinkingThroughTraits,
  requiresStrictThinkingValidation,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  type ThinkingConfig,
} from '@kiki/agent-core-v2/kosong/model/thinking';
import { assertBoundModelAllowed } from '@kiki/agent-core-v2/session/subagent/configSection';
import type { PanelProfileDefinition } from './agentPanelProfileResolution';
import type { PersistedAgentProfileSnapshot } from './agentProfileSnapshot';

export interface PersistedAgentThinkingProjection {
  readonly effectiveThinkingLevel?: ThinkingEffort;
  readonly thinkingEffortSource?: 'forced' | 'adjusted';
}

export function projectPersistedAgentThinking(
  scope: Pick<Scope, 'accessor'>,
  snapshot: PersistedAgentProfileSnapshot,
  profile: PanelProfileDefinition,
): PersistedAgentThinkingProjection {
  const stored = snapshot.thinkingLevel as ThinkingEffort | undefined;
  if (stored === undefined) return {};
  if (snapshot.executorId !== undefined && snapshot.executorId !== 'native') {
    return {
      effectiveThinkingLevel: stored,
      thinkingEffortSource: snapshot.thinkingEffortAdjusted === true ? 'adjusted' : undefined,
    };
  }
  const config = scope.accessor.get(IConfigService);
  const models = scope.accessor.get(IModelService);
  const modelCatalog = scope.accessor.get(IModelCatalog);
  const protocols = scope.accessor.get(IProtocolAdapterRegistry);
  const modelAlias = snapshot.modelAlias;
  const model = modelAlias === undefined ? undefined : (() => {
    try {
      return modelCatalog.get(modelAlias);
    } catch {
      return undefined;
    }
  })();
  const thinkingConfig = config.get<ThinkingConfig>('thinking');
  const strict = model === undefined ? false
    : requiresStrictThinkingValidation(protocols, model.protocol, model.providerType);
  const base = stored === 'off' && model?.alwaysThinking === true
    ? resolveThinkingEffortForModel(stored, thinkingConfig, model, strict)
    : stored;
  const forced = resolveForcedThinkingEffort(
    thinkingConfig?.forcedEffort,
    base,
    drivesThinkingThroughTraits(model?.providerType),
  );
  if (forced !== undefined && snapshot.modelAlias !== undefined) {
    assertBoundModelAllowed(
      config,
      snapshot.modelAlias,
      snapshot.boundProfile ?? profile,
      models,
      forced,
    );
  }
  return {
    effectiveThinkingLevel: forced ?? base,
    thinkingEffortSource: forced !== undefined
      ? 'forced' : snapshot.thinkingEffortAdjusted === true ? 'adjusted' : undefined,
  };
}
