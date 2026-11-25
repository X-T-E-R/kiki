/**
 * ComposerNotes — the unsent notes riding the next prompt, folded into ONE
 * small pill in the composer's chip row ("2 条批注"). Hovering or clicking the
 * pill opens a panel right above it that lists every note on its own line,
 * each with locate / edit / remove. The panel closes on Escape, a click
 * outside, or when the pointer leaves (unless it was opened by click).
 *
 * This is the only place an unsent note shows; notes already sent fold into
 * the SentAnnotationsBubble beside the message that carried them.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';

import type { SelectionAnnotation } from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import {
  COMPOSER_FLOATING_GROUP,
  containsOrOwnsFloatingTarget,
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  hasOpenOwnedFloatingPortal,
  notifyFloatingGroupOpen,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
  subscribeFloatingGroup,
} from '../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from './Dialog';
import { Icon } from './icons';
import { POPOVER_SURFACE_CLASS } from './SearchableSelect';

/** Hover intent: open after a short dwell, close a beat after leaving. */
const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 220;

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

const ROW_ACTION =
  'inline-flex min-h-7 shrink-0 items-center rounded-md px-1.5 text-[12px] font-normal text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-10';

export function ComposerNotes({
  annotations,
  onRemove,
  onUpdate,
  onLocate,
  variant = 'compact',
}: {
  readonly annotations: readonly SelectionAnnotation[];
  readonly onRemove?: (id: string) => void;
  readonly onUpdate?: (id: string, comment: string) => void;
  /** Scroll the timeline to the passage a note quotes. */
  readonly onLocate?: (annotation: SelectionAnnotation) => void;
  readonly variant?: 'compact' | 'shelf';
}) {
  const { t, tp } = useI18n();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 'hover' follows the pointer; 'pinned' (a click) stays until dismissed.
  const [open, setOpen] = useState<'hover' | 'pinned' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => clearTimer, []);

  // An edit in progress holds the panel open like a click does.
  const pinned = open === 'pinned' || editingId !== null;
  const isOpen = open !== null;

  useEffect(() => subscribeFloatingGroup(COMPOSER_FLOATING_GROUP, 'composer-notes', () => {
    clearTimer();
    setEditingId(null);
    setOpen(null);
  }), []);

  useEffect(() => {
    if (!isOpen) return;
    notifyFloatingGroupOpen(COMPOSER_FLOATING_GROUP, 'composer-notes', triggerRef.current);
    const unregister = registerOverlay('composer-notes');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (hasOpenOwnedFloatingPortal('composer-notes')) return;
      event.preventDefault();
      setEditingId(null);
      setOpen(null);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        containsOrOwnsFloatingTarget(rootRef.current, event.target, 'composer-notes')
        || containsOrOwnsFloatingTarget(panelRef.current, event.target, 'composer-notes')
      ) {
        return;
      }
      setEditingId(null);
      setOpen(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [isOpen]);

  // The last note removed: nothing left to list.
  useEffect(() => {
    if (annotations.length === 0) {
      setOpen(null);
      setEditingId(null);
    }
  }, [annotations.length]);

  if (annotations.length === 0) return null;

  const onPointerEnter = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimer();
    if (open === null) timerRef.current = setTimeout(() => { setOpen('hover'); }, HOVER_OPEN_MS);
  };
  const onPointerLeave = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimer();
    if (!pinned) timerRef.current = setTimeout(() => { setOpen(null); }, HOVER_CLOSE_MS);
  };

  const modalOwner = isOpen ? owningModalId(triggerRef.current) : undefined;
  const floatingOwners = isOpen ? resolveFloatingOwners(rootRef.current?.parentElement ?? null) : undefined;
  const zIndex = isOpen ? floatingSurfaceZIndex(triggerRef.current) : undefined;

  return (
    <div
      ref={rootRef}
      data-composer-notes
      {...{ [FLOATING_OWNER_ATTRIBUTE]: 'composer-notes' }}
      className="relative shrink-0"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <Popover.Root
        open={isOpen}
        modal={false}
        onOpenChange={(nextOpen, eventDetails) => {
          if (nextOpen) return;
          if (eventDetails.reason === 'escape-key') {
            if (hasOpenOwnedFloatingPortal('composer-notes')) {
              eventDetails.cancel();
              return;
            }
            setEditingId(null);
            setOpen(null);
            triggerRef.current?.focus();
            return;
          }
          eventDetails.cancel();
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          data-composer-notes-pill
          data-chip-variant={variant === 'shelf' ? 'shelf' : undefined}
          aria-expanded={isOpen}
          aria-controls={isOpen ? panelId : undefined}
          onClick={() => {
            clearTimer();
            setOpen((current) => (current === 'pinned' ? null : 'pinned'));
          }}
          className={`context-chip anim-enter flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] font-normal text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-9 ${
            isOpen ? 'bg-ink/[0.08] text-ink' : 'bg-ink/[0.05] hover:bg-ink/[0.08] hover:text-ink'
          }`}
        >
          <Icon name="edit" size={12} className="text-accent-ink/80" />
          <span className="tabular-nums">{tp('composer.notes.pill', annotations.length)}</span>
        </button>
        {isOpen ? (
          <Popover.Portal>
            <Popover.Positioner
              anchor={triggerRef}
              side="top"
              align="start"
              sideOffset={8}
              collisionPadding={8}
              positionMethod="fixed"
              style={{ zIndex }}
            >
              <Popover.Popup
                ref={panelRef}
                id={panelId}
                role="region"
                aria-label={t('composer.notes.aria')}
                data-composer-notes-panel
                initialFocus={false}
                finalFocus={false}
                onPointerEnter={onPointerEnter}
                onPointerLeave={onPointerLeave}
                {...{
                  [FLOATING_OWNER_ATTRIBUTE]: 'composer-notes',
                  [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: floatingOwners,
                  [MODAL_ESCAPE_ATTRIBUTE]: modalOwner,
                }}
                className={`anim-enter w-[min(30rem,calc(100vw-48px))] p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
              >
                <ul className="max-h-[min(40vh,280px)] overflow-y-auto overscroll-contain">
                  {annotations.map((note) => (
                    <NoteRow
                      key={note.id}
                      note={note}
                      editing={editingId === note.id}
                      onStartEdit={onUpdate === undefined ? undefined : () => { setEditingId(note.id); }}
                      onEndEdit={() => { setEditingId(null); }}
                      onSave={(comment) => { onUpdate?.(note.id, comment); setEditingId(null); }}
                      onRemove={onRemove === undefined ? undefined : () => { onRemove(note.id); }}
                      onLocate={onLocate === undefined ? undefined : () => { onLocate(note); }}
                    />
                  ))}
                </ul>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        ) : null}
      </Popover.Root>
    </div>
  );
}

function NoteRow({
  note,
  editing,
  onStartEdit,
  onEndEdit,
  onSave,
  onRemove,
  onLocate,
}: {
  readonly note: SelectionAnnotation;
  readonly editing: boolean;
  readonly onStartEdit?: () => void;
  readonly onEndEdit: () => void;
  readonly onSave: (comment: string) => void;
  readonly onRemove?: () => void;
  readonly onLocate?: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(note.comment);
  const composingRef = useRef(false);
  const trimmed = draft.trim();
  const canSave = trimmed !== note.comment;
  const quote = oneLine(note.quote);
  return (
    <li data-composer-note={note.id} className="flex min-h-9 items-center gap-2 rounded-lg px-2 py-1 hover:bg-ink/[0.03]">
      <span title={note.quote} className="max-w-[40%] min-w-0 shrink-[2] truncate border-l-2 border-accent/50 pl-2 text-[12px] text-ink-faint">
        “{quote}”
      </span>
      {editing ? (
        <input
          type="text"
          data-composer-note-input
          autoFocus
          value={draft}
          aria-label={t('annotationTray.editAria', { quote })}
          onChange={(event) => { setDraft(event.target.value); }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            const imeActive = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
            if (imeActive) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              if (canSave) onSave(trimmed);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDraft(note.comment);
              onEndEdit();
            }
          }}
          className="min-h-8 min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2 text-[12.5px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-selected-ink/20"
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate text-[13px] ${note.comment === '' ? 'text-ink-faint' : 'text-ink'}`} title={note.comment}>
          {note.comment === '' ? t('composer.notes.emptyComment') : note.comment}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center justify-end">
        {editing ? (
          <>
            <button type="button" data-composer-note-save disabled={!canSave} onClick={() => { onSave(trimmed); }} className={`${ROW_ACTION} text-accent-ink disabled:opacity-40`}>
              {t('annotationTray.save')}
            </button>
            <button type="button" onClick={() => { setDraft(note.comment); onEndEdit(); }} className={ROW_ACTION}>
              {t('annotationTray.cancel')}
            </button>
          </>
        ) : (
          <>
            {onLocate !== undefined ? (
              <button type="button" data-composer-note-locate onClick={onLocate}
                aria-label={t('annotationTray.show')} title={t('annotationTray.show')}
                className={`${ROW_ACTION} w-7 justify-center px-0 pointer-coarse:w-10`}>
                <Icon name="arrowUpRight" size={12} />
              </button>
            ) : null}
            {onStartEdit !== undefined ? (
              <button type="button" data-composer-note-edit onClick={() => { setDraft(note.comment); onStartEdit(); }}
                aria-label={t('annotationTray.editAria', { quote })} title={t('annotationTray.edit')}
                className={`${ROW_ACTION} w-7 justify-center px-0 pointer-coarse:w-10`}>
                <Icon name="edit" size={12} />
              </button>
            ) : null}
            {onRemove !== undefined ? (
              <button type="button" data-composer-note-remove onClick={onRemove}
                aria-label={t('composer.removeAnnotation')} title={t('composer.removeAnnotation')}
                className={`${ROW_ACTION} w-7 justify-center px-0 hover:bg-danger/[0.08] hover:text-danger pointer-coarse:w-10`}>
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </>
        )}
      </span>
    </li>
  );
}
