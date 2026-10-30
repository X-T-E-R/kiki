/**
 * AnnotationPopover — the anchored editor reopened from a timeline annotation
 * marker, on the surface ladder's anchored-popover tier (overlays/README.md):
 * portalled to the document body, placed with `placeAnchored` (flip + shift),
 * light dismiss, Escape, focus back to the mark that opened it.
 */

import { useEffect, useRef, useState } from 'react';

import type { TimelineAnnotation } from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { AnchoredPopover } from './overlays';

export interface AnnotationPopoverOpen {
  readonly annotationId: string;
  readonly anchor: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

/** The caller holds a rect (a virtualized mark, measured at click time); the popover anchors to it. */
function RectAnchor({ rect, anchorRef }: {
  readonly rect: AnnotationPopoverOpen['anchor'];
  readonly anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    anchorRef.current = ref.current;
    return () => { anchorRef.current = null; };
  }, [anchorRef]);
  return (
    <span
      ref={ref}
      aria-hidden
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: Math.max(1, rect.right - rect.left),
        height: Math.max(1, rect.bottom - rect.top),
        pointerEvents: 'none',
      }}
    />
  );
}

export function AnnotationPopover({
  state,
  annotation,
  onSave,
  onRemove,
  onClose,
}: {
  state: AnnotationPopoverOpen;
  /** The live (override-applied) annotation; always matches state.annotationId. */
  annotation: TimelineAnnotation;
  onSave: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(annotation.comment ?? '');
  const anchorRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(annotation.comment ?? '');
  }, [annotation.id, annotation.comment]);

  const trimmed = draft.trim();
  const dirty = annotation.comment !== null && trimmed !== annotation.comment;
  const save = () => {
    if (!dirty || trimmed === '') return;
    onSave(annotation.id, trimmed);
  };

  return (
    <>
      <RectAnchor rect={state.anchor} anchorRef={anchorRef} />
      <AnchoredPopover
        open
        onClose={onClose}
        anchorRef={anchorRef}
        id={`annotation-panel-${annotation.id}`}
        label={t('transcript.annotation.panelAria')}
        widthClassName="w-80"
        className="p-2"
        data={{ 'data-annotation-panel': '' }}
      >
        <p className="mb-1.5 max-h-16 overflow-hidden border-l-2 border-accent/60 pl-1.5 text-[11px] leading-snug whitespace-pre-wrap text-ink-soft">
          {annotation.quote}
        </p>
        {annotation.comment !== null ? (
          <input
            ref={inputRef}
            data-annotation-panel-input
            data-autofocus
            type="text"
            value={draft}
            aria-label={t('transcript.annotation.commentAria')}
            onChange={(event) => { setDraft(event.target.value); }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              event.stopPropagation();
              const nativeEvent = event.nativeEvent;
              const imeActive = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
              if ((event.key === 'Enter' || event.key === 'Escape') && imeActive) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
            }}
            className="min-h-10 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-selected-ink/20 sm:min-h-8"
          />
        ) : (
          <p className="text-[11px] text-ink-faint">{t('transcript.annotation.quoteOnly')}</p>
        )}
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <button
            ref={removeRef}
            type="button"
            data-annotation-panel-remove
            {...(annotation.comment === null ? { 'data-autofocus': '' } : {})}
            className="min-h-10 rounded-md px-2 text-[11px] font-medium text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger sm:min-h-8"
            onClick={() => { onRemove(annotation.id); }}
          >
            {t('transcript.annotation.remove')}
          </button>
          {annotation.comment !== null ? (
            <button
              type="button"
              data-annotation-panel-save
              disabled={!dirty || trimmed === ''}
              className="min-h-10 rounded-md bg-ink/[0.06] px-3 text-[11px] font-semibold text-ink transition-colors hover:bg-ink/[0.1] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-8"
              onClick={save}
            >
              {t('transcript.annotation.save')}
            </button>
          ) : null}
        </div>
      </AnchoredPopover>
    </>
  );
}
