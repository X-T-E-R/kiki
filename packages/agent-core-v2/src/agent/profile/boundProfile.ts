import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentPromptDiagnostics } from '@kiki/protocol';
import { modelPromptLayers, resolveModelProfileEntry } from '@kiki/agent-profiles/modelProfileOverlay';
import { selectPromptOverrides } from '@kiki/agent-profiles/promptOverrides';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { CognitionBinding } from '#/agent/cognition/cognitionConfig';
import type { ResolvedPromptFieldOverrides } from '#/app/promptField/promptFieldRegistry';

export interface BoundPromptInputs {
  readonly version: 1;
  readonly fields: ResolvedPromptFieldOverrides;
  readonly cognition: CognitionBinding;
  readonly variables: Readonly<Record<string, string>>;
  readonly revision: string;
}

const boundPromptInputsSchema = z.object({
  version: z.literal(1),
  fields: z.object({
    values: z.record(z.string(), z.string()),
    fields: z.array(z.object({
      id: z.string(), value: z.string(), status: z.enum(['effective', 'shadowed', 'inactive', 'deferred', 'unsupported']),
      sources: z.array(z.object({ surface: z.string(), kind: z.enum(['inline', 'file']) }).passthrough()),
    }).passthrough()),
  }),
  cognition: z.object({
    position: z.enum(['main', 'sub', 'independent']), modelAlias: z.string(), revision: z.number().int(),
    contentRevision: z.string(), bindingRevision: z.string().optional(),
    config: z.object({
      overlay: z.union([z.string(), z.array(z.string())]).optional(),
      steering: z.union([z.string(), z.array(z.string())]).optional(),
      anchor: z.union([z.string(), z.array(z.string())]).optional(),
      overlayMode: z.enum(['append', 'prepend', 'wrap', 'persona', 'replace']).optional(),
      anchorSteps: z.number().int().positive().optional(), anchorScope: z.enum(['session', 'turn']).optional(),
    }).optional(),
    anchor: z.string().optional(), slots: z.object({ overlay: z.string().optional(), steering: z.string().optional(), anchor: z.string().optional() }),
  }),
  variables: z.record(z.string(), z.string()), revision: z.string(),
});

export function freezePromptInputs(fields: ResolvedPromptFieldOverrides, cognition: CognitionBinding, variables: Readonly<Record<string, string>>): BoundPromptInputs {
  const content = structuredClone({ version: 1 as const, fields, cognition, variables });
  return { ...content, revision: promptInputsRevision(content) };
}

export function validPromptInputs(inputs: BoundPromptInputs, modelAlias: string, bindingRevision: string | undefined): boolean {
  if (!boundPromptInputsSchema.safeParse(inputs).success) return false;
  const { revision, ...content } = inputs;
  return inputs.cognition.modelAlias === modelAlias && inputs.cognition.bindingRevision === bindingRevision
    && revision === promptInputsRevision(content);
}

function promptInputsRevision(content: Omit<BoundPromptInputs, 'revision'>): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export interface BoundPromptBase {
  readonly text: string;
  readonly environment: import('#/app/agentProfileCatalog/agentProfileCatalog').EnvironmentDisclosureSnapshot;
  readonly delegationSnippet?: string;
  readonly promptVariablesRevision?: string;
  readonly promptDiagnostics?: import('@kiki/protocol').AgentPromptDiagnostics;
  readonly inputs?: BoundPromptInputs;
}

export type BoundProfile = Omit<AgentProfile, 'systemPrompt' | 'renderSystemPrompt' | 'promptPrefix'> & {
  readonly fileSources?: import('#/session/dispatch/profileFile').FrozenProfileFileSources;
  readonly promptBase?: BoundPromptBase;
};

export function recoverLegacyPromptFields(profile: BoundProfile | undefined, diagnostics: AgentPromptDiagnostics | undefined, alias: string, resolveId: (id: string) => string | undefined): ResolvedPromptFieldOverrides | undefined {
  const fields: ResolvedPromptFieldOverrides['fields'][number][] = [];
  const values: Record<string, string> = {};
  const position = diagnostics?.identity.delegation_position ?? 'main';
  const projections = diagnostics?.channels.filter((channel) => channel.state === 'effective'
    && (channel.channel === 'tool' || channel.id === 'system.shared' || channel.channel === 'cognition_anchor' || channel.channel === 'cognition_steering')) ?? [];
  for (const channel of projections) {
    const source = channel.sources.at(-1);
    if (profile === undefined || source?.kind !== 'inline' || !('declarationIndex' in source) || typeof source.declarationIndex !== 'number') return undefined;
    const declarations = source.surface === 'profile' || source.surface === 'system'
      ? profile.promptOverrideLayers ?? (profile.promptOverrides === undefined ? [] : [profile.promptOverrides])
      : source.surface === 'profile-model' || source.surface === 'caller-lease-model'
        ? modelPromptLayers(profile).flatMap((layer) => {
            const entry = resolveModelProfileEntry(layer.entries, alias, resolveId);
            return entry?.promptOverrides === undefined ? [] : [entry.promptOverrides];
          }) : [];
    const declaration = declarations[source.declarationIndex];
    const value = declaration === undefined ? undefined : selectPromptOverrides(declaration, position)?.fields?.[channel.id];
    if (value === undefined || value.includes('${')) return undefined;
    const { order: _order, ...origin } = source;
    if (origin.surface !== 'profile' && origin.surface !== 'system' && origin.surface !== 'profile-model' && origin.surface !== 'caller-lease-model') return undefined;
    fields.push({ id: channel.id, value, status: 'effective', sources: [{ ...origin, surface: origin.surface, kind: 'inline', declarationIndex: source.declarationIndex }] });
    values[channel.id] = value;
  }
  return { values, fields };
}

export function applyFileCallerCeiling(profile: AgentProfile): AgentProfile {
  const ceiling = (profile as AgentProfile & Pick<BoundProfile, 'fileSources'>).fileSources?.callerCeiling;
  if (ceiling === undefined) return profile;
  return {
    ...profile,
    toolAllowPolicies: [...(profile.toolAllowPolicies ?? []), ...(ceiling.toolAllowPolicies ?? []), ...(ceiling.activeToolNames === undefined ? [] : [ceiling.activeToolNames])],
    disallowedTools: [...new Set([...(profile.disallowedTools ?? []), ...(ceiling.disallowedTools ?? [])])],
  };
}

export function freezeBoundProfile(profile: AgentProfile, promptBase?: BoundPromptBase): BoundProfile {
  const { systemPrompt: _systemPrompt, renderSystemPrompt: _renderSystemPrompt, promptPrefix: _promptPrefix, ...definition } = profile;
  return structuredClone({ ...definition, promptBase });
}
