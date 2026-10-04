/** Persona and Bot memory share the same namespace helpers. */
import type { MemoryTarget } from '../../lib/client';

/** The persona namespace for a workspace scope (`undefined` = cross-project). */
export function personaMemoryTarget(personaId: string, workspaceId: string | undefined): MemoryTarget {
  return workspaceId === undefined
    ? { scope: 'persona', personaId }
    : { scope: 'persona_workspace', personaId, workspaceId };
}

/** Mirrors MemoryPage's `targetKey` so the page and the pickers share cache entries. */
export function memoryTargetKey(target: MemoryTarget): string {
  if (target.scope === 'persona') return `persona:${target.personaId ?? ''}`;
  if (target.scope === 'persona_workspace') return `workspace:${target.workspaceId ?? ''}/persona:${target.personaId ?? ''}`;
  return target.scope === 'global' ? 'global' : `workspace:${target.workspaceId ?? ''}`;
}
