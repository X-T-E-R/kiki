/**
 * The memory page's persona group: one chip per persona (face, name, entry
 * count), plus "shared" to leave the persona namespaces. A persona's memory is
 * a namespace, not a fifth scope, so the page's workspace control keeps its
 * meaning — "all" reads the persona's cross-project entries, one workspace
 * reads what it learned there.
 */

import { useQueries } from '@tanstack/react-query';

import type { PersonaSummary } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import type { MemoryTarget } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { segmentClass } from '../WorkspaceScopeControl';
import { PersonaAvatar, personaAvatarOf } from './PersonaAvatar';

/** The persona namespace for a workspace scope (`undefined` = cross-project). */
export function personaMemoryTarget(personaId: string, workspaceId: string | undefined): MemoryTarget {
  return workspaceId === undefined
    ? { scope: 'persona', personaId }
    : { scope: 'persona_workspace', personaId, workspaceId };
}

export function PersonaMemoryScope({
  personas,
  value,
  workspaceId,
  onChange,
}: {
  readonly personas: readonly PersonaSummary[];
  readonly value: string | undefined;
  readonly workspaceId: string | undefined;
  readonly onChange: (next: string | undefined) => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  // Counts share the list's query key shape, so opening a chip reuses them.
  const counts = useQueries({
    queries: personas.map((persona) => {
      const target = personaMemoryTarget(persona.id, workspaceId);
      return {
        queryKey: ['memory', memoryTargetKey(target), { search: '', typeFilter: 'all', showInactive: false }],
        queryFn: () => client.listMemory(target, { query: '' }),
        staleTime: 5_000,
      };
    }),
  });
  if (personas.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-2" data-memory-persona-scope={value ?? 'none'}>
      <span className="shrink-0 text-[12px] text-ink-faint">{t('persona.memoryGroup')}</span>
      <div role="group" aria-label={t('persona.memoryScopeAria')} className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-[9px] border border-hairline bg-paper p-0.5 [scrollbar-width:none]">
        {personas.map((persona, index) => {
          const active = persona.id === value;
          const count = counts[index]?.data?.items.filter((entry) => entry.status !== 'pending').length;
          return (
            <button
              key={persona.id}
              type="button"
              data-memory-persona={persona.id}
              aria-pressed={active}
              onClick={() => { onChange(active ? undefined : persona.id); }}
              className={`${segmentClass(active, 'h-7 max-w-44 shrink-0 pr-3 pl-1 text-[13px] pointer-coarse:h-10')}`}
            >
              <PersonaAvatar persona={personaAvatarOf(persona)} size={20} decorative />
              <span className="min-w-0 truncate">{persona.name}</span>
              {count !== undefined ? <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{count}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Mirrors MemoryPage's `targetKey` so the page and the chips share cache entries. */
export function memoryTargetKey(target: MemoryTarget): string {
  if (target.scope === 'persona') return `persona:${target.personaId ?? ''}`;
  if (target.scope === 'persona_workspace') return `workspace:${target.workspaceId ?? ''}/persona:${target.personaId ?? ''}`;
  return target.scope === 'global' ? 'global' : `workspace:${target.workspaceId ?? ''}`;
}
