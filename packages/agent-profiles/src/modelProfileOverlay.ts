import type { AgentModelParameters, AgentModelProfile } from './agentProfile';
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

export function applyMatchedModelProfilePrompt(
  base: string,
  entries: readonly AgentModelProfile[] | undefined,
  alias: string,
  resolveId: (id: string) => string | undefined,
): string {
  return applyModelProfilePromptDelta(
    base,
    resolveModelProfileEntry(entries, alias, resolveId),
  );
}

export function applyModelProfilePromptDelta(
  base: string,
  entry: AgentModelProfile | undefined,
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
): boolean {
  if (alias === undefined || alias.length === 0) return false;
  const entry = resolveModelProfileEntry(entries, alias, resolveId);
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
