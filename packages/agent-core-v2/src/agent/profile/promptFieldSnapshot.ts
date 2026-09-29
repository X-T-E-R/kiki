import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { resolveModelProfileEntry } from '@kiki/agent-profiles/modelProfileOverlay';
import { IConfigService } from '#/app/config/config';
import { PROMPT_SECTION, type PromptConfig } from '#/app/prompt/configSection';
import { IPromptFieldRegistry, type ResolvedPromptFieldOverrides } from '#/app/promptField/promptFieldRegistry';
import { cognitionPathRefs } from '#/agent/cognition/cognitionFiles';
import { IModelService } from '#/kosong/model/model';
import type { DelegationPosition } from './delegationContext';

export async function resolveProfilePromptFields(
  profile: AgentProfile,
  alias: string,
  position: DelegationPosition,
  config: IConfigService,
  models: IModelService,
  promptFields: IPromptFieldRegistry,
): Promise<ResolvedPromptFieldOverrides> {
  const promptConfig = config.get<PromptConfig>(PROMPT_SECTION);
  const model = alias.length === 0 ? undefined : models.get(alias);
  const resolveId = (profile.executor ?? 'native') === 'native'
    ? (id: string) => models.resolveId(id)
    : (id: string) => id;
  const modelProfile = resolveModelProfileEntry(profile.modelProfiles, alias, resolveId);
  const sourcePath = profile.sourcePath?.replaceAll('\\', '/');
  const resolved = await promptFields.resolve({
    global: { surface: 'global', overrides: promptConfig?.overrides },
    model: { surface: 'model', overrides: model?.promptOverrides },
    profile: {
      surface: sourcePath?.endsWith('/SYSTEM.md') === true ? 'system' : 'profile',
      overrides: profile.promptOverrideLayers ?? profile.promptOverrides,
      sourcePath: profile.sourcePath,
    },
    profileModel: { surface: 'profile-model', overrides: modelProfile?.promptOverrides },
    context: {
      profileName: profile.name,
      modelAlias: alias,
      executor: profile.executor ?? 'native',
      delegationPosition: position,
    },
    customVariables: promptConfig?.variables,
  });
  const customBody = profile.fileDefinition !== undefined || sourcePath?.endsWith('/SYSTEM.md') === true;
  const profileShadowsSystem = customBody
    && profile.systemPromptMode !== 'prepend'
    && profile.systemPromptMode !== 'append'
    && profile.systemPromptMode !== 'inherit';
  const cognitionShadowsSystem = (profile.executor ?? 'native') === 'native'
    && model?.cognition?.overlayMode === 'replace'
    && cognitionPathRefs(model.cognition.overlay).length > 0;
  const intentOverride = resolved.values['system.intent_tool_use'];
  const intentShadowsReplyStyle = intentOverride !== undefined && !intentOverride.includes('${reply_style_guide}');
  if (!profileShadowsSystem && !cognitionShadowsSystem && !intentShadowsReplyStyle) return resolved;
  const fields = resolved.fields.map((field) =>
    (field.id.startsWith('system.') && field.id !== 'system.shared' && (profileShadowsSystem || cognitionShadowsSystem))
      || (field.id === 'system.reply_style' && intentShadowsReplyStyle)
      ? { ...field, status: 'shadowed' as const }
      : field,
  );
  return {
    values: Object.fromEntries(fields.filter((field) => field.status === 'effective').map((field) => [field.id, field.value])),
    fields,
  };
}
