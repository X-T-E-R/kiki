import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { modelPromptLayers, resolveModelProfileEntry, selectModelProfilePrompt } from '@kiki/agent-profiles/modelProfileOverlay';
import type { PromptOverrides, PromptOverrideSource } from '@kiki/agent-profiles/promptOverrides';
import type { AgentPromptChannel } from '@kiki/protocol';
import type { ResolvedPromptFieldOverrides } from '#/app/promptField/promptFieldRegistry';
import type { CognitionConfig } from '#/kosong/model/model';
import { cognitionPathRefs, hasCognitionContent, isCognitionInline } from '#/agent/cognition/cognitionFiles';
import { selectCognitionConfig } from '#/agent/cognition/cognitionConfig';
import type { DelegationPosition } from './delegationContext';

export function promptChannelForField(id: string): AgentPromptChannel['channel'] {
  return id.startsWith('tool.') ? 'tool' : id.startsWith('delegation.') ? 'delegation' : 'system';
}

export function promptConfigurationChannels(input: {
  readonly profile: Omit<AgentProfile, 'systemPrompt' | 'renderSystemPrompt' | 'promptPrefix'>;
  readonly alias: string;
  readonly position: DelegationPosition;
  readonly cognition?: CognitionConfig;
  readonly recipe?: import('#/agent/cognition/cognitionConfig').CognitionBinding['recipe'];
  readonly fields: ResolvedPromptFieldOverrides;
  readonly resolveId: (id: string) => string | undefined;
  readonly overrideDeclarations: readonly { readonly surface: string; readonly overrides?: PromptOverrides | readonly PromptOverrides[]; readonly path?: string }[];
  readonly leaseMode?: 'preserve' | 'replace';
}): AgentPromptChannel[] {
  const { profile, alias, position, fields } = input;
  const channels: AgentPromptChannel[] = fields.fields.map((field) => ({
    id: field.id,
    channel: promptChannelForField(field.id),
    selection: promptSourceSelection(field.sources.at(-1) ?? { surface: 'global', kind: 'inline' }),
    state: field.status === 'deferred' ? 'inactive' : field.status,
    reason: field.diagnostic?.message ?? (field.status === 'shadowed' ? 'The selected system body replaces this field.' : field.status === 'inactive' ? 'This field does not apply to the current agent.' : undefined),
    sources: field.sources.map((source, order) => ({ ...source, order })),
  }));
  for (const declaration of input.overrideDeclarations) {
    const layers = declaration.overrides === undefined ? [] : Array.isArray(declaration.overrides) ? declaration.overrides : [declaration.overrides as PromptOverrides];
    for (const [index, overrides] of layers.entries()) {
      const branch = position === 'sub' ? undefined : overrides[position];
      if (branch === undefined || branch === 'same') continue;
      for (const id of Object.keys(overrides.fields ?? {})) channels.push({
        id: `${declaration.surface}:${index}:${id}:common`, channel: promptChannelForField(id), state: 'inactive', selection: 'common',
        reason: branch === 'off' ? `This declaration is off for ${position}; lower-priority declarations remain available.` : `The ${position} object replaces this declaration's common fields and files.`,
        sources: [{ surface: declaration.surface, kind: 'inline', path: declaration.path, order: index }],
      });
      for (const [fileIndex, path] of (overrides.files ?? []).entries()) channels.push({
        id: `${declaration.surface}:${index}:file:${fileIndex}:common`, channel: 'system', state: 'inactive', selection: 'common',
        reason: `This common override file is not selected for ${position} and was not read.`,
        sources: [{ surface: declaration.surface, kind: 'file', path, order: index }],
      });
    }
  }
  const selectedCognition = selectCognitionConfig(input.cognition, position);
  const cognitionReplaces = selectedCognition?.overlayMode === 'replace' && hasCognitionContent(selectedCognition.overlay);
  const promptLayers = modelPromptLayers(profile);
  if (input.leaseMode === 'replace') for (const [order, layer] of (profile.modelPromptBase ?? []).entries()) {
    const entry = resolveModelProfileEntry(layer.entries, alias, input.resolveId);
    if (entry === undefined) continue;
    const selected = selectModelProfilePrompt(entry, position);
    if (selected?.prompt !== undefined) channels.push({
      id: `model-profile:replaced:${order}:${entry.alias}`, channel: 'model_profile', state: 'shadowed',
      reason: 'The caller lease explicitly replaces the original role-model prompt sources.',
      sources: [{ surface: 'profile-model', kind: 'inline', path: layer.sourcePath, order }],
    });
  }
  for (const [order, layer] of promptLayers.entries()) {
    const entry = resolveModelProfileEntry(layer.entries, alias, input.resolveId);
    if (entry === undefined) continue;
    const branch = position === 'sub' ? undefined : entry[position];
    const selected = selectModelProfilePrompt(entry, position);
    const hasPrompt = selected?.prompt !== undefined && selected.promptMode !== undefined;
    const selection = branch === 'off' ? 'off' : typeof branch === 'object' ? position === 'sub' ? 'common' : position : 'common';
    channels.push({
      id: `model-profile:${layer.source}:${order}:${entry.alias}`, channel: 'model_profile',
      state: !hasPrompt ? 'inactive' : cognitionReplaces ? 'shadowed' : 'effective', selection,
      reason: branch === 'off' ? `The model-specific body is off for ${position}; field overrides are selected separately.`
        : !hasPrompt ? 'No model-specific body is selected.'
        : cognitionReplaces ? 'The selected cognition overlay replaces the model-specific body.'
        : layer.source === 'profile' && input.leaseMode === 'preserve' ? 'The caller lease preserves this original role-model prompt below its own model prompt.'
        : layer.source === 'lease' ? 'Caller lease model prompt; applied after preserved role-model prompts.' : undefined,
      sources: [{ surface: layer.source === 'lease' ? 'caller-lease-model' : 'profile-model', kind: 'inline', path: layer.sourcePath, order }],
    });
  }
  for (const slot of ['overlay', 'steering', 'anchor'] as const) {
    const branch = position === 'sub' ? undefined : input.cognition?.[position];
    const hasContent = hasCognitionContent(selectedCognition?.[slot]);
    const sources = (value: import('#/kosong/model/model').CognitionSlotContent | undefined): AgentPromptChannel['sources'] => isCognitionInline(value)
      ? [{ surface: 'model-cognition', kind: 'inline', order: 0 }]
      : cognitionPathRefs(value).map((path, order) => ({ surface: 'model-cognition', kind: 'file', path, order }));
    const supported = (profile.executor ?? 'native') === 'native';
    channels.push({
      id: `cognition.${slot}`, channel: `cognition_${slot}`,
      state: !supported ? 'unsupported' : hasContent ? 'effective' : 'inactive',
      selection: branch === 'off' ? 'off' : typeof branch === 'object' ? position === 'sub' ? 'common' : position : 'common',
      reason: !supported ? 'The current executor does not support native cognition.'
        : branch === 'off' ? `Cognition is off for ${position}.`
        : !hasContent ? 'No content is configured in the selected cognition configuration.'
        : slot === 'anchor' ? 'Within this window, anchor replaces the complete request system prompt, including identity, delegation and shared fields.'
        : slot === 'steering' ? 'Sent as a user message after the task prompt on each new turn.'
        : selectedCognition?.overlayMode === 'replace' ? 'Replaces the role system body; delegation and shared fields are still assembled separately.' : undefined,
      sources: sources(selectedCognition?.[slot]),
      anchor_steps: slot === 'anchor' && hasContent ? selectedCognition?.anchorSteps ?? 1 : undefined,
      anchor_scope: slot === 'anchor' && hasContent ? selectedCognition?.anchorScope ?? 'session' : undefined,
    });
    if (branch !== undefined && branch !== 'same' && hasCognitionContent(input.cognition?.[slot])) channels.push({
      id: `cognition.${slot}:common`, channel: `cognition_${slot}`, state: 'inactive', selection: 'common',
      reason: `The common cognition configuration is not selected for ${position} and was not read.`,
      sources: sources(input.cognition?.[slot]),
    });
  }
  const recipe = input.recipe;
  if (recipe === undefined) return channels;
  const effective = recipe.resolved.branches[position];
  const result = channels.map((channel) => (channel.id === 'cognition.steering' && effective.steering !== undefined || channel.id === 'cognition.anchor' && effective.anchor !== undefined)
    ? { ...channel, state: 'shadowed' as const, reason: 'A higher-priority Recipe supplies this cognition slot; the saved value is retained.' } : channel);
  const layers = recipe.resolved.layers ?? [{ surface: 'model' as const, installation_id: recipe.installation_id, resolved: recipe.resolved }];
  for (const [index, layer] of layers.entries()) for (const slot of ['system', 'steering', 'anchor'] as const) {
    const branch = layer.resolved.branches[position];
    const origins = layer.resolved.origins.filter((origin) => origin.position === position && origin.slot === slot);
    const shadowed = layers.slice(index + 1).some((next) => next.resolved.branches[position][slot] !== undefined);
    result.push({ id: `recipe.${layer.surface}.${slot}`, channel: slot === 'system' ? 'system' : `cognition_${slot}`, state: branch[slot] === undefined ? 'inactive' : shadowed ? 'shadowed' : 'effective',
      reason: shadowed ? 'A higher-priority Recipe supplies this slot.' : slot === 'anchor' ? 'Replaces only the Recipe system segment within its request window; role, persona, delegation and shared instructions remain active.' : undefined,
      recipe: { installation_id: layer.installation_id, revision: layer.resolved.revision, slot, origins: origins.map((origin) => ({ ...origin })) },
      sources: origins.length === 0 ? [{ surface: 'recipe', kind: 'inline', path: `${layer.surface}:${layer.installation_id}@${layer.resolved.revision}` }] : origins.map((origin) => ({ surface: 'recipe', kind: origin.file === undefined ? 'inline' as const : 'file' as const, path: origin.file ?? origin.source })),
      anchor_steps: slot === 'anchor' ? branch.anchor?.steps : undefined, anchor_scope: slot === 'anchor' ? branch.anchor?.scope : undefined });
  }
  return result;
}

export function promptSourceSelection(source: PromptOverrideSource): 'common' | 'main' | 'independent' | undefined {
  return source.selection;
}
