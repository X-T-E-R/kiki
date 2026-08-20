import { renderPrompt } from '#/_base/utils/render-prompt';

import type { AgentModelProfile } from './agentProfileCatalog';

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
