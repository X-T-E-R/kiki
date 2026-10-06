import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { modelPromptLayers, resolveModelProfileEntry } from '@kiki/agent-profiles/modelProfileOverlay';
import { IConfigService } from '#/app/config/config';
import { PROMPT_SECTION, type PromptConfig } from '#/app/prompt/configSection';
import { IPromptFieldRegistry, type ResolvedPromptFieldOverrides } from '#/app/promptField/promptFieldRegistry';
import { cognitionPathRefs } from '#/agent/cognition/cognitionFiles';
import { selectCognitionConfig } from '#/agent/cognition/cognitionConfig';
import { IModelService } from '#/kosong/model/model';
import type { DelegationPosition } from './delegationContext';

export async function resolveProfilePromptFields(
  profile: Omit<AgentProfile, 'systemPrompt' | 'renderSystemPrompt' | 'promptPrefix'>,
  alias: string,
  position: DelegationPosition,
  config: IConfigService,
  models: IModelService,
  promptFields: IPromptFieldRegistry,
  recipe?: import('@kiki/protocol').ResolvedRecipe,
): Promise<ResolvedPromptFieldOverrides> {
  const promptConfig = config.get<PromptConfig>(PROMPT_SECTION);
  const model = alias.length === 0 ? undefined : models.get(alias);
  const resolveId = (profile.executor ?? 'native') === 'native' ? (id: string) => models.resolveId(id) : (id: string) => id;
  const modelOverrides = recipe === undefined ? modelPromptLayers(profile).flatMap((layer) => {
    const entry = resolveModelProfileEntry(layer.entries, alias, resolveId);
    return entry?.promptOverrides === undefined ? [] : [{ overrides: entry.promptOverrides, source: layer.source, path: layer.sourcePath }];
  }) : [];
  const sourcePath = profile.sourcePath?.replaceAll('\\', '/');
  const context = { profileName: profile.name, modelAlias: alias, executor: profile.executor ?? 'native', delegationPosition: position };
  const raw = await promptFields.resolve({
    global: { surface: 'global', overrides: promptConfig?.overrides },
    model: { surface: 'model', overrides: recipe === undefined ? model?.promptOverrides : undefined },
    profile: { surface: sourcePath?.endsWith('/SYSTEM.md') === true ? 'system' : 'profile', overrides: profile.promptOverrideLayers ?? profile.promptOverrides, sourcePath: (profile.promptOverrideLayers?.length ?? 0) > 1 ? undefined : profile.sourcePath },
    profileModel: { surface: 'profile-model', overrides: modelOverrides.map((layer) => layer.overrides) },
    context, customVariables: promptConfig?.variables,
  });
  const fields = raw.fields.map((field) => ({ ...field, sources: field.sources.map((source) => {
    const layer = source.surface === 'profile-model' && source.declarationIndex !== undefined ? modelOverrides[source.declarationIndex] : undefined;
    return layer === undefined ? source : { ...source, surface: layer.source === 'lease' ? 'caller-lease-model' as const : 'profile-model' as const, path: source.kind === 'inline' ? layer.path ?? source.path : source.path };
  }) }));
  if (recipe !== undefined) {
    const values = recipe.branches[position].fields;
    const validated = promptFields.validate({ values, sources: Object.fromEntries(Object.keys(values).map((id) => [id, [{ surface: 'recipe' as const, kind: 'inline' as const, path: recipe.revision }]])) }, context);
    for (const field of validated.fields) {
      const existing = fields.findIndex((candidate) => candidate.id === field.id);
      if (existing >= 0) fields.splice(existing, 1);
      fields.push({ ...field, sources: [...field.sources] });
    }
  }
  const customBody = profile.fileDefinition !== undefined || sourcePath?.endsWith('/SYSTEM.md') === true;
  const profileShadowsSystem = customBody && profile.systemPromptMode !== 'prepend' && profile.systemPromptMode !== 'append' && profile.systemPromptMode !== 'inherit';
  const cognition = recipe === undefined ? selectCognitionConfig(model?.cognition, position) : undefined;
  const cognitionShadowsSystem = (profile.executor ?? 'native') === 'native' && cognition?.overlayMode === 'replace' && cognitionPathRefs(cognition.overlay).length > 0;
  const intentOverride = fields.find((field) => field.id === 'system.intent_tool_use')?.value;
  const intentShadowsReplyStyle = intentOverride !== undefined && !intentOverride.includes('${reply_style_guide}');
  const projected = fields.map((field) =>
    (field.id.startsWith('system.') && field.id !== 'system.shared' && (profileShadowsSystem || cognitionShadowsSystem)) || (field.id === 'system.reply_style' && intentShadowsReplyStyle)
      ? { ...field, status: 'shadowed' as const } : field);
  return { values: Object.fromEntries(projected.filter((field) => field.status === 'effective').map((field) => [field.id, field.value])), fields: projected };
}
