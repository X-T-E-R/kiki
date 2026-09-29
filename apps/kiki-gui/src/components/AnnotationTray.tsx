/**
 * AnnotationTray — every note in this conversation, one card above the
 * composer: the ones riding the next prompt ("Not sent yet") and the ones
 * already in the timeline. A single quiet header row while closed; opened,
 * each note can be edited in place, removed, or located in the timeline.
 *
 * Sent notes derive from the transcript exactly like the in-line marks
 * (collectTimelineAnnotations + the local override overlay), so an edit here
 * and an edit in the timeline popover are the same write.
 */

import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  applyAnnotationOverrides,
  collectTimelineAnnotations,
  getAnnotationOverridesSnapshot,
  subscribeAnnotationOverrides,
  writeAnnotationOverride,
  type SelectionAnnotation,
  type TimelineBlockLike,
} from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { locateInTimeline } from '../lib/timelineLocate';
import { DisclosureChevron, Icon } from './icons';

interface TrayNote {
  readonly key: string;
  readonly id: string;
  readonly quote: string;
  readonly comment: string | null;
  /** Anchor block for sent notes; undefined while the note is still a draft. */
  readonly blockId?: string;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function AnnotationTray({
  sessionId,
  agentId,
  blocks,
  pending,
  onUpdatePending,
  onRemovePending,
}: {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly blocks: readonly TimelineBlockLike[];
  /** Notes attached to the next prompt (the composer's chips). */
  readonly pending: readonly SelectionAnnotation[];
  readonly onUpdatePending: (id: string, comment: string) => void;
  readonly onRemovePending: (id: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const overrides = useSyncExternalStore(
    subscribeAnnotationOverrides,
    getAnnotationOverridesSnapshot,
    getAnnotationOverridesSnapshot,
  );
  const derived = useMemo(() => collectTimelineAnnotations(blocks), [blocks]);
  const sent = useMemo<TrayNote[]>(() => {
    const notes: TrayNote[] = [];
    for (const [blockId, list] of applyAnnotationOverrides(derived, overrides)) {
      for (const annotation of list) {
        notes.push({ key: `s:${annotation.id}`, id: annotation.id, quote: annotation.quote, comment: annotation.comment, blockId });
      }
    }
    return notes;
  }, [derived, overrides]);
  const drafts = useMemo<TrayNote[]>(
    () => pending.map((annotation) => ({ key: `p:${annotation.id}`, id: annotation.id, quote: annotation.quote, comment: annotation.comment })),
    [pending],
  );
  const total = sent.length + drafts.length;
  if (total === 0) return null;

  const saveSent = (id: string, comment: string) => {
    writeAnnotationOverride(id, { ...getAnnotationOverridesSnapshot()[id], comment });
  };
  const removeSent = (id: string) => {
    writeAnnotationOverride(id, { ...getAnnotationOverridesSnapshot()[id], deleted: true });
  };
  const latest = drafts.at(-1) ?? sent.at(-1);

  return (
    <div className="px-6 pb-2">
      <section
        data-annotation-tray
        data-annotation-tray-open={open || undefined}
        aria-label={t('annotationTray.aria')}
        className="anim-enter mx-auto max-w-[var(--kiki-chat-content-width,760px)] rounded-[14px] border border-hairline bg-panel shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06)]"
      >
        <button
          type="button"
          data-annotation-tray-toggle
          aria-expanded={open}
          aria-label={open ? t('annotationTray.collapse') : t('annotationTray.expand')}
          onClick={() => { setOpen((value) => !value); }}
          className="flex min-h-10 w-full items-center gap-2 rounded-[14px] px-3.5 text-left transition-colors hover:bg-ink/[0.03] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          <span aria-hidden className="flex shrink-0 text-accent-ink/80"><Icon name="edit" size={12} /></span>
          <span className="shrink-0 text-[13px] font-medium text-ink">{t('annotationTray.title')}</span>
          <span className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 text-[11px] font-medium tabular-nums text-ink-soft">{total}</span>
          {!open && latest !== undefined ? (
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">
              {latest.comment === null || latest.comment === '' ? `“${oneLine(latest.quote)}”` : latest.comment}
            </span>
          ) : <span className="flex-1" />}
          <DisclosureChevron open={open} className="shrink-0 text-ink-faint" />
        </button>
        {open ? (
          <div className="max-h-[min(40vh,320px)] overflow-y-auto px-2 pb-2">
            {drafts.length > 0 ? (
              <TrayGroup label={t('annotationTray.pending')}>
                {drafts.map((note) => (
                  <TrayRow key={note.key} note={note} onSave={onUpdatePending} onRemove={onRemovePending} />
                ))}
              </TrayGroup>
            ) : null}
            {sent.length > 0 ? (
              <TrayGroup label={t('annotationTray.sent')}>
                {sent.map((note) => (
                  <TrayRow
                    key={note.key}
                    note={note}
                    onSave={saveSent}
                    onRemove={removeSent}
                    onShow={() => {
                      void locateInTimeline(
                        { kind: 'annotation', annotationId: note.id, blockId: note.blockId! },
                        { sessionId, agentId },
                      );
                    }}
                  />
                ))}
              </TrayGroup>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function TrayGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pt-1">
      <p className="px-1.5 pt-1 pb-0.5 text-[11px] font-medium text-ink-faint">{label}</p>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

const ROW_ACTION =
  'min-h-8 shrink-0 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none';

function TrayRow({
  note,
  onSave,
  onRemove,
  onShow,
}: {
  note: TrayNote;
  onSave: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
  onShow?: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.comment ?? '');
  const composingRef = useRef(false);
  const trimmed = draft.trim();
  const canSave = trimmed !== '' && trimmed !== note.comment;
  const commit = () => {
    if (!canSave) return;
    onSave(note.id, trimmed);
    setEditing(false);
  };
  return (
    <li data-annotation-tray-row={note.id} className="group/note rounded-lg px-1.5 py-1.5 hover:bg-ink/[0.025]">
      <p className="truncate border-l-2 border-accent/50 pl-2 text-[11.5px] leading-snug text-ink-faint">“{oneLine(note.quote)}”</p>
      {editing ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-2.5">
          <input
            type="text"
            data-annotation-tray-input
            autoFocus
            value={draft}
            aria-label={t('annotationTray.editAria', { quote: oneLine(note.quote) })}
            onChange={(event) => { setDraft(event.target.value); }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              event.stopPropagation();
              const imeActive = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
              if (imeActive) return;
              if (event.key === 'Enter') { event.preventDefault(); commit(); }
              if (event.key === 'Escape') { event.preventDefault(); setDraft(note.comment ?? ''); setEditing(false); }
            }}
            className="min-h-9 min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2 text-[12.5px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <button type="button" data-annotation-tray-save disabled={!canSave} onClick={commit}
            className="min-h-9 rounded-md bg-accent-soft px-2.5 text-[12px] font-semibold text-accent-deep transition-colors hover:bg-accent-soft/70 disabled:cursor-not-allowed disabled:opacity-40">
            {t('annotationTray.save')}
          </button>
          <button type="button" onClick={() => { setDraft(note.comment ?? ''); setEditing(false); }} className={ROW_ACTION}>
            {t('annotationTray.cancel')}
          </button>
        </div>
      ) : (
        <div className="mt-0.5 flex items-center gap-1 pl-2.5">
          <p className={`min-w-0 flex-1 text-[13px] leading-snug [overflow-wrap:anywhere] ${note.comment === null ? 'text-ink-faint italic' : 'text-ink'}`}>
            {note.comment ?? t('annotationTray.quoteOnly')}
          </p>
          {onShow !== undefined ? (
            <button type="button" data-annotation-tray-show onClick={onShow} className={ROW_ACTION}>
              {t('annotationTray.show')}
            </button>
          ) : null}
          {note.comment !== null ? (
            <button type="button" data-annotation-tray-edit onClick={() => { setDraft(note.comment ?? ''); setEditing(true); }}
              aria-label={t('annotationTray.editAria', { quote: oneLine(note.quote) })} className={ROW_ACTION}>
              {t('annotationTray.edit')}
            </button>
          ) : null}
          <button type="button" data-annotation-tray-remove onClick={() => { onRemove(note.id); }}
            aria-label={t('annotationTray.remove')}
            className={`${ROW_ACTION} hover:bg-danger/[0.08] hover:text-danger`}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
    </li>
  );
}
