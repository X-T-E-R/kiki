import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

export interface BoundPromptBase {
  readonly text: string;
  readonly environment: import('#/app/agentProfileCatalog/agentProfileCatalog').EnvironmentDisclosureSnapshot;
  readonly delegationSnippet?: string;
  readonly promptVariablesRevision?: string;
}

export type BoundProfile = Omit<AgentProfile, 'systemPrompt' | 'renderSystemPrompt' | 'promptPrefix'> & {
  readonly fileSources?: import('#/session/dispatch/profileFile').FrozenProfileFileSources;
  readonly promptBase?: BoundPromptBase;
};

export function applyFileCallerCeiling(profile: AgentProfile): AgentProfile {
  const ceiling = (profile as AgentProfile & Pick<BoundProfile, 'fileSources'>).fileSources?.callerCeiling;
  if (ceiling === undefined) return profile;
  return {
    ...profile,
    toolAllowPolicies: [...(profile.toolAllowPolicies ?? []), ...(ceiling.toolAllowPolicies ?? []), ...(ceiling.activeToolNames === undefined ? [] : [ceiling.activeToolNames])],
    disallowedTools: [...new Set([...(profile.disallowedTools ?? []), ...(ceiling.disallowedTools ?? [])])],
    subagents: ceiling.subagents === undefined ? profile.subagents
      : profile.subagents === undefined ? ceiling.subagents : profile.subagents.filter((name) => ceiling.subagents!.includes(name)),
  };
}

export function freezeBoundProfile(profile: AgentProfile, promptBase?: BoundPromptBase): BoundProfile {
  const { systemPrompt: _systemPrompt, renderSystemPrompt: _renderSystemPrompt, promptPrefix: _promptPrefix, ...definition } = profile;
  return structuredClone({ ...definition, promptBase });
}
