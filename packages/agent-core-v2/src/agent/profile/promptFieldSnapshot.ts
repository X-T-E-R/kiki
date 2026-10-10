import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { modelPromptLayers, resolveModelProfileEntry } from '@kiki/agent-profiles/modelProfileOverlay';
import { IConfigService } from '#/app/config/config';
import { PROMPT_SECTION, type PromptConfig } from '#/app/prompt/configSection';
import { IPromptFieldRegistry, type ResolvedPromptFieldOverrides } from '#/app/promptField/promptFieldRegistry';
import { hasCognitionContent } from '#/agent/cognition/cognitionFiles';
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
  const modelOverrides = modelPromptLayers(profile).flatMap((layer) => {
    const entry = resolveModelProfileEntry(layer.entries, alias, resolveId);
    return entry?.promptOverrides === undefined ? [] : [{ overrides: entry.promptOverrides, source: layer.source, path: layer.sourcePath }];
  });
  const recipeLayers = recipe?.layers ?? (recipe === undefined ? [] : [{ surface: 'model' as const, installation_id: model?.recipe ?? '', resolved: recipe }]);
  const modelRecipes = recipeLayers.filter((layer) => layer.surface === 'model');
  const profileRecipes = recipeLayers.filter((layer) => layer.surface === 'profile');
  const recipeFields = (layers: typeof recipeLayers) => layers.map((layer) => ({ fields: layer.resolved.branches[position].fields }));
  const modelDeclarations = model?.promptOverrides === undefined ? [] : [model.promptOverrides];
  const profileDeclarations = profile.promptOverrideLayers ?? (profile.promptOverrides === undefined ? [] : [profile.promptOverrides]);
  const sourcePath = profile.sourcePath?.replaceAll('\\', '/');
  const context = { profileName: profile.name, modelAlias: alias, executor: profile.executor ?? 'native', delegationPosition: position };
  const raw = await promptFields.resolve({
    global: { surface: 'global', overrides: promptConfig?.overrides },
    model: { surface: 'model', overrides: [...modelDeclarations, ...recipeFields(modelRecipes)] },
    profile: { surface: sourcePath?.endsWith('/SYSTEM.md') === true ? 'system' : 'profile', overrides: [...recipeFields(profileRecipes), ...profileDeclarations], sourcePath: profileDeclarations.length > 1 ? undefined : profile.sourcePath },
    profileModel: { surface: 'profile-model', overrides: modelOverrides.map((layer) => layer.overrides) },
    context, customVariables: promptConfig?.variables,
  });
  const fields = raw.fields.map((field) => ({ ...field, sources: field.sources.map((source) => {
    const index = source.declarationIndex ?? -1;
    const recipeLayer = source.surface === 'model' ? modelRecipes[index - modelDeclarations.length]
      : source.surface === 'profile' || source.surface === 'system' ? profileRecipes[index] : undefined;
    if (recipeLayer !== undefined) return { ...source, surface: 'recipe' as const, path: `${recipeLayer.surface}:${recipeLayer.installation_id}@${recipeLayer.resolved.revision}` };
    const layer = source.surface === 'profile-model' ? modelOverrides[index] : undefined;
    if (layer !== undefined) return { ...source, surface: layer.source === 'lease' ? 'caller-lease-model' as const : 'profile-model' as const, path: source.kind === 'inline' ? layer.path ?? source.path : source.path };
    return (source.surface === 'profile' || source.surface === 'system') && index >= 0 ? { ...source, declarationIndex: index - profileRecipes.length } : source;
  }) }));
  const customBody = profile.fileDefinition !== undefined || sourcePath?.endsWith('/SYSTEM.md') === true;
  const profileShadowsSystem = customBody && profile.systemPromptMode !== 'prepend' && profile.systemPromptMode !== 'append' && profile.systemPromptMode !== 'inherit';
  const cognition = selectCognitionConfig(model?.cognition, position);
  const cognitionShadowsSystem = (profile.executor ?? 'native') === 'native' && cognition?.overlayMode === 'replace' && hasCognitionContent(cognition.overlay);
  const intentOverride = fields.find((field) => field.id === 'system.intent_tool_use')?.value;
  const intentShadowsReplyStyle = intentOverride !== undefined && !intentOverride.includes('${reply_style_guide}');
  const projected = fields.map((field) =>
    (field.id.startsWith('system.') && field.id !== 'system.shared' && (profileShadowsSystem || cognitionShadowsSystem)) || (field.id === 'system.reply_style' && intentShadowsReplyStyle)
      ? { ...field, status: 'shadowed' as const } : field);
  return { values: Object.fromEntries(projected.filter((field) => field.status === 'effective').map((field) => [field.id, field.value])), fields: projected };
}
