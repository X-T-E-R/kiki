import { memo, useState } from 'react';
import type { TranscriptTodoNotes, TranscriptTodoNotesMeta, TranscriptTodoNotesStatus } from '@kiki/transcript';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { ClampText } from '../ClampText';
import { InspectorChevron, INSPECTOR_HEAD } from './InspectorSection';

export const NOTE_SECTION_LABELS = {
  goal: 'agentPanel.notes.goal', directives: 'agentPanel.notes.directives', decided: 'agentPanel.notes.decided',
  rejected: 'agentPanel.notes.rejected', evidence: 'agentPanel.notes.evidence', files: 'agentPanel.notes.files',
  next: 'agentPanel.notes.next', open: 'agentPanel.notes.open',
} as const satisfies Record<string, I18nKey>;
const SECTIONS = Object.keys(NOTE_SECTION_LABELS);

export interface AgentNotesSectionProps {
  readonly notes: TranscriptTodoNotes | undefined;
  readonly meta: TranscriptTodoNotesMeta | undefined;
  readonly status?: TranscriptTodoNotesStatus;
  readonly loaded: boolean;
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

function QuietHead() {
  const { t } = useI18n();
  return <h3 className="flex h-8 items-center gap-1.5"><span className={INSPECTOR_HEAD}>{t('agentPanel.notes')}</span></h3>;
}

export const AgentNotesSection = memo(function AgentNotesSection({ notes, meta, status, loaded }: AgentNotesSectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sections = [...SECTIONS, ...Object.keys(notes ?? {}).filter((section) => !SECTIONS.includes(section))];
  const present = sections.filter((section) => (notes?.[section] ?? '').trim() !== '');
  if (notes === undefined || present.length === 0) {
    const state = status !== undefined ? 'incompatible' : loaded ? 'empty' : 'loading';
    const message = status !== undefined ? t('agentPanel.notes.unavailable') : !loaded ? t('agentPanel.notes.loading')
      : meta !== undefined ? t('agentPanel.notes.cleared', { rev: meta.rev }) : t('agentPanel.notes.empty');
    return <section data-agent-notes-section data-agent-notes-state={state}>
      <QuietHead />
      <p role={status !== undefined || !loaded ? 'status' : undefined} className="pb-0.5 text-[12px] leading-relaxed text-ink-faint">{message}</p>
    </section>;
  }
  const goal = notes.goal === undefined ? undefined : firstLine(notes.goal);
  return (
    <section data-agent-notes-section data-agent-notes-state={status !== undefined ? 'stale' : 'written'}>
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
      {status !== undefined ? <p role="status" className="text-[12px] leading-relaxed text-ink-faint">{t('agentPanel.notes.stale')}</p> : null}
      {open ? (
        <div className="pt-1">
          <dl className="max-h-80 space-y-2 overflow-y-auto overscroll-y-contain pr-0.5">
            {present.map((section) => (
              <div key={section} data-agent-notes-part={section}>
                <dt className="text-[11px] font-medium text-ink-faint">{Object.hasOwn(NOTE_SECTION_LABELS, section)
                  ? t(NOTE_SECTION_LABELS[section as keyof typeof NOTE_SECTION_LABELS]) : t('agentPanel.notes.unknown', { field: section })}</dt>
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
