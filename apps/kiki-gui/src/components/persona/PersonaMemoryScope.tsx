/** Persona and Bot memory share the same namespace picker. */
import type { PersonaSummary } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import type { MemoryTarget } from '../../lib/client';
import { segmentClass } from '../WorkspaceScopeControl';
import { PersonaAvatar, personaAvatarOf } from './PersonaAvatar';

/** The persona namespace for a workspace scope (`undefined` = cross-project). */
export function personaMemoryTarget(personaId: string, workspaceId: string | undefined): MemoryTarget {
  return workspaceId === undefined
    ? { scope: 'persona', personaId }
    : { scope: 'persona_workspace', personaId, workspaceId };
}

export function PersonaMemoryScope({ personas, value, onChange }: {
  readonly personas: readonly PersonaSummary[];
  readonly value: string | undefined;
  readonly onChange: (next: string | undefined) => void;
}) {
  const { t } = useI18n();
  if (personas.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-2" data-memory-persona-scope={value ?? 'none'}>
      <span className="shrink-0 text-[12px] text-ink-faint">{t('memory.source.personas')}</span>
      <div role="group" aria-label={t('persona.memoryScopeAria')} className="flex min-w-0 items-center gap-1 overflow-x-auto p-0.5 [scrollbar-width:none]">
        <button type="button" data-memory-persona="none" aria-pressed={value === undefined}
          onClick={() => { onChange(undefined); }} className={segmentClass(value === undefined, 'h-7 shrink-0 px-3 text-[13px] ring-0 shadow-none')}>
          {t('persona.memoryShared')}
        </button>
        {personas.map((persona) => (
          <button key={persona.id} type="button" data-memory-persona={persona.id} aria-pressed={persona.id === value}
            onClick={() => { onChange(persona.id); }} className={segmentClass(persona.id === value, 'h-7 max-w-44 shrink-0 pr-3 pl-1 text-[13px] ring-0 shadow-none pointer-coarse:h-10')}>
            <PersonaAvatar persona={personaAvatarOf(persona)} size={20} decorative />
            <span className="min-w-0 truncate">{persona.name}</span>
          </button>
        ))}
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
