import type { AgentModelParameters, AgentModelProfile, AgentModelPromptContent, AgentModelPromptLayer, AgentProfile } from './agentProfile';
import { selectPromptIdentityContent, type PromptDelegationPosition } from './promptOverrides';
import { renderPrompt } from './renderPrompt';

export function mergeModelParameters(
  ...layers: readonly (AgentModelParameters | undefined)[]
): AgentModelParameters {
  const defined = layers.filter((layer): layer is AgentModelParameters => layer !== undefined);
  const minimum = (key: 'contextBudget' | 'maxCompletionTokens'): number | undefined => {
    const values = defined.flatMap((layer) => layer[key] === undefined ? [] : [layer[key]!]);
    return values.length === 0 ? undefined : Math.min(...values);
  };
  const requestLayers = defined.flatMap((layer) => layer.requestParams === undefined ? [] : [layer.requestParams]);
  return {
    contextBudget: minimum('contextBudget'),
    autoCompact: defined.findLast((layer) => layer.autoCompact !== undefined)?.autoCompact,
    maxCompletionTokens: minimum('maxCompletionTokens'),
    serviceTier: defined.findLast((layer) => layer.serviceTier !== undefined)?.serviceTier,
    requestParams: requestLayers.length === 0 ? undefined : Object.assign({}, ...requestLayers),
  };
}

export function resolveModelProfileEntry(
  entries: readonly AgentModelProfile[] | undefined,
  alias: string,
  resolveId: (id: string) => string | undefined,
): AgentModelProfile | undefined {
  if (entries === undefined || entries.length === 0 || alias.length === 0) return undefined;
  const canonical = safeResolve(resolveId, alias);
  if (canonical === undefined) return undefined;
  for (const entry of entries) {
    const entryId = safeResolve(resolveId, entry.alias);
    if (entryId === undefined) continue;
    if (entryId === canonical) return entry;
  }
  return undefined;
}

export function resolveProfileThinkingDefault(
  profile: {
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
    readonly modelProfiles?: readonly AgentModelProfile[];
  } | undefined,
  alias: string,
  resolveId: (id: string) => string | undefined,
): string | undefined {
  if (profile === undefined) return undefined;
  const matched = resolveModelProfileEntry(profile.modelProfiles, alias, resolveId);
  if (matched?.thinkingEffort !== undefined) return matched.thinkingEffort;
  if (profile.modelAlias === undefined) return undefined;
  const canonical = safeResolve(resolveId, alias) ?? alias;
  const defaultModel = safeResolve(resolveId, profile.modelAlias) ?? profile.modelAlias;
  return canonical === defaultModel ? profile.thinkingEffort : undefined;
}

export function modelPromptLayers(profile: Pick<AgentProfile, 'modelPromptLayers' | 'modelProfiles' | 'sourcePath'>): readonly AgentModelPromptLayer[] {
  return profile.modelPromptLayers ?? [{ source: 'profile', sourcePath: profile.sourcePath, entries: profile.modelProfiles ?? [] }];
}

export function selectModelProfilePrompt(entry: AgentModelProfile | undefined, position: PromptDelegationPosition): AgentModelPromptContent | undefined {
  if (entry === undefined) return undefined;
  return selectPromptIdentityContent(
    { promptMode: entry.promptMode, prompt: entry.prompt },
    position === 'sub' ? undefined : entry[position],
  );
}

export function applyMatchedModelProfilePrompt(
  base: string,
  entries: readonly AgentModelProfile[] | undefined,
  alias: string,
  resolveId: (id: string) => string | undefined,
  position: PromptDelegationPosition = 'main',
): string {
  return applyModelProfilePromptDelta(base, selectModelProfilePrompt(resolveModelProfileEntry(entries, alias, resolveId), position));
}

export function applyModelProfilePromptDelta(
  base: string,
  entry: AgentModelPromptContent | undefined,
): string {
  if (entry?.promptMode === undefined || entry.prompt === undefined || entry.prompt.length === 0) {
    return base;
  }
  if (entry.promptMode === 'prepend') return `${entry.prompt}\n\n${base}`;
  if (entry.promptMode === 'append') return `${base}\n\n${entry.prompt}`;
  return renderPrompt(entry.prompt, {
    parent_prompt: base,
    base_prompt: base,
  });
}

export function declaresModelProfilePrompt(
  entries: readonly AgentModelProfile[] | undefined,
  alias: string | undefined,
  resolveId: (id: string) => string | undefined,
  position: PromptDelegationPosition = 'main',
): boolean {
  if (alias === undefined || alias.length === 0) return false;
  const entry = selectModelProfilePrompt(resolveModelProfileEntry(entries, alias, resolveId), position);
  return entry?.promptMode !== undefined && entry.prompt !== undefined && entry.prompt.length > 0;
}

function safeResolve(
  resolveId: (id: string) => string | undefined,
  id: string,
): string | undefined {
  try {
    return resolveId(id);
  } catch {
    return undefined;
  }
}
