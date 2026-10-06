/**
 * SentAnnotationsBubble — the notes a sent user message carried, folded into
 * small bubbles beside that message (annotations no longer mark the timeline;
 * only the composer's draft notes do). Up to three notes get one bubble each
 * (pencil + a preview of the comment); more collapse into a single bubble
 * reading "{count} annotations". Clicking a bubble opens the list: quote +
 * comment per note. Edits and removals write the same local overlay store the
 * old timeline editor used, keyed by the carrying message's id, so overrides
 * made before this change keep applying.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import {
  annotationOverrideId,
  applyAnnotationOverrides,
  getAnnotationOverridesSnapshot,
  subscribeAnnotationOverrides,
  writeAnnotationOverride,
  type TimelineAnnotation,
} from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { floatingSurfaceZIndex, registerOverlay } from '../lib/uiBusy';
import { Icon } from './icons';

interface SentNote {
  readonly id: string;
  readonly quote: string;
  readonly comment: string;
}

/** At most this many notes get their own bubble; past it they merge into one. */
const MAX_NOTE_BUBBLES = 3;
/** Comment preview length in code points before an ellipsis takes over. */
const NOTE_PREVIEW_LENGTH = 7;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** First few characters of a comment, single line, ellipsized past the cap. */
export function notePreviewText(comment: string): string {
  const flat = oneLine(comment);
  const characters = Array.from(flat);
  return characters.length <= NOTE_PREVIEW_LENGTH
    ? flat
    : `${characters.slice(0, NOTE_PREVIEW_LENGTH).join('')}…`;
}

export function SentAnnotationsBubble({
  blockId,
  annotations,
}: {
  readonly blockId: string;
  readonly annotations: readonly { quote: string; comment: string }[];
}) {
  const { t, tp } = useI18n();
  const overrides = useSyncExternalStore(
    subscribeAnnotationOverrides,
    getAnnotationOverridesSnapshot,
    getAnnotationOverridesSnapshot,
  );
  // Same id scheme as collectTimelineAnnotations: the annotation segments lead
  // the carry-over prefix, so the ordinal is the index inside `annotations`.
  const notes: readonly SentNote[] = (() => {
    const derived = new Map<string, TimelineAnnotation[]>();
    derived.set(
      blockId,
      annotations.map((annotation, ordinal) => ({
        id: annotationOverrideId(annotation.quote, annotation.comment, blockId, ordinal),
        quote: annotation.quote,
        comment: annotation.comment,
      })),
    );
    // Sent annotations always carry a comment; the null arm of the shared
    // TimelineAnnotation type is the quote-only shape, which cannot occur here.
    return (applyAnnotationOverrides(derived, overrides).get(blockId) ?? []).map((note) => ({
      id: note.id,
      quote: note.quote,
      comment: note.comment ?? '',
    }));
  })();

  if (notes.length === 0) return null;

  if (notes.length > MAX_NOTE_BUBBLES) {
    return (
      <NoteBubble
        blockId={blockId}
        notes={notes}
        ariaLabel={tp('transcript.annotation.bubbleAria', notes.length)}
        title={tp('transcript.annotation.bubbleAria', notes.length)}
        label={t('transcript.annotation.bubbleSummary', { count: notes.length })}
      />
    );
  }

  return notes.map((note) => (
    <NoteBubble
      key={note.id}
      blockId={blockId}
      noteId={note.id}
      notes={notes}
      ariaLabel={t('transcript.annotation.openAria', { quote: oneLine(note.quote) })}
      title={oneLine(note.comment)}
      label={notePreviewText(note.comment)}
    />
  ));
}

function NoteBubble({
  blockId,
  noteId,
  notes,
  ariaLabel,
  title,
  label,
}: {
  readonly blockId: string;
  readonly noteId?: string;
  readonly notes: readonly SentNote[];
  readonly ariaLabel: string;
  readonly title: string;
  readonly label: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-annotation-bubble={blockId}
        data-annotation-bubble-note={noteId}
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        onClick={() => { setOpen((value) => !value); }}
        className="flex h-7 min-w-0 max-w-full items-center gap-1 rounded-full bg-paper px-2 text-[12px] font-medium text-ink-soft shadow-[var(--kiki-sheet-shadow)] transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-9"
      >
        <span aria-hidden className="flex shrink-0 text-accent-ink/80"><Icon name="edit" size={12} /></span>
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open ? (
        <SentNotesPopover
          notes={notes}
          anchorRef={anchorRef}
          onClose={() => { setOpen(false); }}
        />
      ) : null}
    </>
  );
}

function SentNotesPopover({
  notes,
  anchorRef,
  onClose,
}: {
  readonly notes: readonly SentNote[];
  readonly anchorRef: React.RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelSize, setPanelSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const next = { width: panel.offsetWidth, height: panel.offsetHeight };
    setPanelSize((previous) =>
      previous?.width === next.width && previous.height === next.height ? previous : next,
    );
  }, [notes]);

  useEffect(() => {
    const unregister = registerOverlay('sent-annotations');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (panel !== null && event.target instanceof Node && panel.contains(event.target)) return;
      if (anchorRef.current !== null && event.target instanceof Node && anchorRef.current.contains(event.target)) return;
      onClose();
    };
    const onResize = () => { onClose(); };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose, anchorRef]);

  const anchor = anchorRef.current?.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const measured = panelSize ?? { width: Math.min(320, viewport.width - 16), height: 0 };
  const anchorBox = anchor ?? { left: 8, top: 8, right: 8, bottom: 8 };
  const below = anchorBox.bottom + 6;
  const above = anchorBox.top - measured.height - 6;
  const preferredTop =
    panelSize !== null && below + measured.height + 8 > viewport.height && above >= 8
      ? above
      : below;
  const position = clampOverlayPosition(anchorBox.right - measured.width, preferredTop, measured, viewport);

  const saveNote = (id: string, comment: string) => {
    writeAnnotationOverride(id, { ...getAnnotationOverridesSnapshot()[id], comment });
  };
  const removeNote = (id: string) => {
    writeAnnotationOverride(id, { ...getAnnotationOverridesSnapshot()[id], deleted: true });
  };

  return createPortal(
    <div
      ref={panelRef}
      data-annotation-bubble-panel
      role="dialog"
      aria-label={t('transcript.annotation.notesAria')}
      tabIndex={-1}
      className="anim-enter fixed w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-hairline bg-panel p-1.5 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)]"
      style={{ top: position.top, left: position.left, zIndex: floatingSurfaceZIndex(null) }}
    >
      <ul className="max-h-[min(40vh,320px)] overflow-y-auto">
        {notes.map((note) => (
          <SentNoteRow key={note.id} note={note} onSave={saveNote} onRemove={removeNote} />
        ))}
      </ul>
    </div>,
    document.body,
  );
}

const ROW_ACTION =
  'min-h-7 shrink-0 rounded-md px-1.5 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-10';

function SentNoteRow({
  note,
  onSave,
  onRemove,
}: {
  readonly note: SentNote;
  readonly onSave: (id: string, comment: string) => void;
  readonly onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.comment);
  const composingRef = useRef(false);
  const trimmed = draft.trim();
  const canSave = trimmed !== '' && trimmed !== note.comment;
  const quote = oneLine(note.quote);
  const commit = () => {
    if (!canSave) return;
    onSave(note.id, trimmed);
    setEditing(false);
  };
  return (
    <li data-annotation-bubble-row={note.id} className="rounded-lg px-2 py-1.5 hover:bg-ink/[0.025]">
      <p className="max-h-16 overflow-hidden border-l-2 border-accent/50 pl-2 text-[11.5px] leading-snug whitespace-pre-wrap text-ink-faint">“{quote}”</p>
      {editing ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            data-annotation-bubble-input
            autoFocus
            value={draft}
            aria-label={t('annotationTray.editAria', { quote })}
            onChange={(event) => { setDraft(event.target.value); }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              event.stopPropagation();
              const imeActive = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
              if (imeActive) return;
              if (event.key === 'Enter') { event.preventDefault(); commit(); }
              if (event.key === 'Escape') { event.preventDefault(); setDraft(note.comment); setEditing(false); }
            }}
            className="min-h-8 min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2 text-[12.5px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-selected-ink/20"
          />
          <button type="button" data-annotation-bubble-save disabled={!canSave} onClick={commit}
            className="min-h-8 rounded-md bg-ink/[0.06] px-3 text-[12px] font-semibold text-ink transition-colors hover:bg-ink/[0.1] disabled:cursor-not-allowed disabled:opacity-40">
            {t('annotationTray.save')}
          </button>
          <button type="button" onClick={() => { setDraft(note.comment); setEditing(false); }} className={ROW_ACTION}>
            {t('annotationTray.cancel')}
          </button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-1">
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink [overflow-wrap:anywhere]">{note.comment}</p>
          <button
            type="button"
            data-annotation-bubble-edit
            onClick={() => { setDraft(note.comment); setEditing(true); }}
            aria-label={t('annotationTray.editAria', { quote })}
            title={t('annotationTray.edit')}
            className={`${ROW_ACTION} w-7 justify-center px-0 pointer-coarse:w-10`}
          >
            <Icon name="edit" size={12} />
          </button>
          <button
            type="button"
            data-annotation-bubble-remove
            onClick={() => { onRemove(note.id); }}
            aria-label={t('transcript.annotation.remove')}
            title={t('transcript.annotation.remove')}
            className={`${ROW_ACTION} w-7 justify-center px-0 hover:bg-danger/[0.08] hover:text-danger pointer-coarse:w-10`}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
    </li>
  );
}
