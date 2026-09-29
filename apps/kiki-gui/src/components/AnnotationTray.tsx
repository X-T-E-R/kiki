/**
 * AnnotationTray — the way back to notes already in this conversation, one
 * quiet line above the composer ("3 notes in this conversation"). Unsent
 * notes are not here: they are the composer's own chips, where they can be
 * removed before sending, so a note never shows in two places. Opened, each
 * sent note can be located in the timeline, edited, or removed.
 *
 * Sent notes derive from the transcript exactly like the in-line marks
 * (collectTimelineAnnotations + the local override overlay), so an edit here
 * and an edit in the timeline popover are the same write.
 */

import { useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  applyAnnotationOverrides,
  collectTimelineAnnotations,
  getAnnotationOverridesSnapshot,
  subscribeAnnotationOverrides,
  writeAnnotationOverride,
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
  readonly blockId: string;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function AnnotationTray({
  sessionId,
  agentId,
  blocks,
}: {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly blocks: readonly TimelineBlockLike[];
}) {
  const { t, tp } = useI18n();
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
  if (sent.length === 0) return null;

  const saveSent = (id: string, comment: string) => {
    writeAnnotationOverride(id, { ...getAnnotationOverridesSnapshot()[id], comment });
  };
  const removeSent = (id: string) => {
    writeAnnotationOverride(id, { ...getAnnotationOverridesSnapshot()[id], deleted: true });
  };

  return (
    <div className="px-6 pb-2">
      <section
        data-annotation-tray
        data-annotation-tray-open={open || undefined}
        aria-label={t('annotationTray.aria')}
        className={`anim-enter mx-auto max-w-[var(--kiki-chat-content-width,760px)] rounded-[12px] ${open ? 'border border-hairline bg-panel' : ''}`}
      >
        <button
          type="button"
          data-annotation-tray-toggle
          aria-expanded={open}
          onClick={() => { setOpen((value) => !value); }}
          className="flex min-h-8 w-full items-center gap-1.5 rounded-[12px] px-2.5 text-left text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.03] hover:text-ink-soft focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          <span aria-hidden className="flex shrink-0"><Icon name="edit" size={12} /></span>
          <span className="min-w-0 flex-1 truncate">{tp('annotationTray.sentCount', sent.length)}</span>
          <DisclosureChevron open={open} className="shrink-0" />
        </button>
        {open ? (
          <ul className="max-h-[min(40vh,320px)] overflow-y-auto px-2 pb-2">
            {sent.map((note) => (
              <TrayRow
                key={note.key}
                note={note}
                onSave={saveSent}
                onRemove={removeSent}
                onShow={() => {
                  void locateInTimeline(
                    { kind: 'annotation', annotationId: note.id, blockId: note.blockId },
                    { sessionId, agentId },
                  );
                }}
              />
            ))}
          </ul>
        ) : null}
      </section>
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
