import { memo, useState } from 'react';
import type { TranscriptTodoNotes, TranscriptTodoNotesMeta } from '@kiki/transcript';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { ClampText } from '../ClampText';
import { InspectorChevron, INSPECTOR_HEAD } from './InspectorSection';

/** Section order: what the agent is after, then what it settled, then what is left. */
const SECTIONS = ['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open'] as const;

export interface AgentNotesSectionProps {
  readonly notes: TranscriptTodoNotes | undefined;
  readonly meta: TranscriptTodoNotesMeta | undefined;
  /**
   * Whether the agent's own view state has loaded. A still-loading agent and
   * an agent that has no notes read as two different quiet lines — never as
   * the same gap.
   */
  readonly loaded: boolean;
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** A fixed chapter head (no fold) for the states where there is nothing to unfold. */
function QuietHead() {
  const { t } = useI18n();
  return (
    <h3 className="flex h-8 items-center gap-1.5">
      <span className={INSPECTOR_HEAD}>{t('agentPanel.notes')}</span>
    </h3>
  );
}

/**
 * The agent's working notes, read-only: the goal on one line while closed;
 * opened, every section it wrote plus when the notes were last updated (the
 * turn and the revision — never the internal hash, step or window ids). Long
 * sections clamp to four lines with the shared show-more toggle; the whole
 * block scrolls past the rail's own cap. The agent writes them (TodoList
 * notes); nothing here edits them.
 */
export const AgentNotesSection = memo(function AgentNotesSection({ notes, meta, loaded }: AgentNotesSectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const present = SECTIONS.filter((section) => (notes?.[section] ?? '').trim() !== '');
  if (notes === undefined || present.length === 0) {
    return (
      <section data-agent-notes-section data-agent-notes-state={loaded ? 'empty' : 'loading'}>
        <QuietHead />
        {loaded ? (
          <p className="pb-0.5 text-[12px] leading-relaxed text-ink-faint">{t('agentPanel.notes.empty')}</p>
        ) : (
          <p role="status" className="pb-0.5 text-[12px] leading-relaxed text-ink-faint">{t('agentPanel.notes.loading')}</p>
        )}
      </section>
    );
  }
  const goal = notes.goal === undefined ? undefined : firstLine(notes.goal);
  return (
    <section data-agent-notes-section data-agent-notes-state="written">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); }}
        className="group -ml-1.5 flex min-h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
      >
        <span className={`${INSPECTOR_HEAD} transition-colors group-hover:text-ink`}>{t('agentPanel.notes')}</span>
        {!open && goal !== undefined ? (
          <span data-agent-notes-goal className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{goal}</span>
        ) : <span className="flex-1" />}
        <InspectorChevron open={open} />
      </button>
      {open ? (
        <div className="pt-1">
          <dl className="max-h-80 space-y-2 overflow-y-auto overscroll-y-contain pr-0.5">
            {present.map((section) => (
              <div key={section} data-agent-notes-part={section}>
                <dt className="text-[11px] font-medium text-ink-faint">{t(`agentPanel.notes.${section}` as I18nKey)}</dt>
                <dd className="text-[12.5px] leading-snug text-ink-soft">
                  <ClampText text={notes[section] ?? ''} lines={4} className="break-words whitespace-pre-wrap" />
                </dd>
              </div>
            ))}
          </dl>
          {meta !== undefined ? (
            <p data-agent-notes-meta className="mt-2 text-[11px] text-ink-faint tabular-nums">
              {t('agentPanel.notes.meta', { rev: meta.rev, turn: meta.writtenTurn })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
