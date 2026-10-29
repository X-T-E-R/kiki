import { resolveProfileThinkingDefault } from '@kiki/agent-profiles/modelProfileOverlay';
import type { NamedAgentProfile } from '@kiki/protocol';
import { resolveCatalogModel } from '@kiki/session-core/settings';

export function profileThinkingDefault(
  profile: Pick<NamedAgentProfile, 'pinned_model_alias' | 'thinking_effort' | 'model_profiles' | 'executor'> | undefined,
  model: string | undefined,
  models: readonly { readonly id: string; readonly remote_id: string; readonly provider_id: string }[],
): string | undefined {
  if (profile === undefined || model === undefined) return undefined;
  return resolveProfileThinkingDefault({
    modelAlias: profile.pinned_model_alias,
    thinkingEffort: profile.thinking_effort,
    modelProfiles: profile.model_profiles?.map((entry) => ({ alias: entry.alias, thinkingEffort: entry.thinking_effort })),
  }, model, (alias) => profile.executor === undefined || profile.executor === 'native'
    ? resolveCatalogModel(models, alias)?.id : alias);
}
