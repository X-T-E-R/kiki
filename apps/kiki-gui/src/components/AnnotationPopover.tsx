/**
 * AnnotationPopover — the anchored editor reopened from a timeline annotation
 * marker. The panel is portalled to the document body so virtualized rows and
 * transcript overflow cannot clip it, then clamped inside the viewport after
 * its real size is known.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { TimelineAnnotation } from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { registerOverlay } from '../lib/uiBusy';

export interface AnnotationPopoverOpen {
  readonly annotationId: string;
  readonly anchor: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
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
  const [panelSize, setPanelSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(annotation.comment ?? '');
  }, [annotation.id, annotation.comment]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const next = { width: panel.offsetWidth, height: panel.offsetHeight };
    setPanelSize((previous) =>
      previous?.width === next.width && previous.height === next.height ? previous : next,
    );
  }, [annotation.id, annotation.quote, annotation.comment]);

  useEffect(() => {
    (annotation.comment === null ? removeRef.current : inputRef.current)?.focus({ preventScroll: true });
  }, [annotation.id, annotation.comment]);

  useEffect(() => {
    const unregister = registerOverlay('timeline-annotation');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (panel !== null && event.target instanceof Node && panel.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[data-annotation-ref]') !== null) return;
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
  }, [onClose]);

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const measured = panelSize ?? { width: Math.min(320, viewport.width - 16), height: 0 };
  const below = state.anchor.bottom + 6;
  const above = state.anchor.top - measured.height - 6;
  const preferredTop =
    panelSize !== null && below + measured.height + 8 > viewport.height && above >= 8
      ? above
      : below;
  const position = clampOverlayPosition(
    state.anchor.left,
    preferredTop,
    measured,
    viewport,
  );
  const trimmed = draft.trim();
  const dirty = annotation.comment !== null && trimmed !== annotation.comment;
  const save = () => {
    if (!dirty || trimmed === '') return;
    onSave(annotation.id, trimmed);
  };

  return createPortal(
    <div
      ref={panelRef}
      data-annotation-panel
      role="dialog"
      aria-label={t('transcript.annotation.panelAria')}
      tabIndex={-1}
      className="anim-enter fixed z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-hairline bg-panel p-2 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)]"
      style={{ top: position.top, left: position.left }}
    >
      <p className="mb-1.5 max-h-16 overflow-hidden border-l-2 border-accent/60 pl-1.5 text-[11px] leading-snug whitespace-pre-wrap text-ink-soft">
        {annotation.quote}
      </p>
      {annotation.comment !== null ? (
        <input
          ref={inputRef}
          data-annotation-panel-input
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
          className="min-h-10 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/20 sm:min-h-8"
        />
      ) : (
        <p className="text-[11px] text-ink-faint">{t('transcript.annotation.quoteOnly')}</p>
      )}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          ref={removeRef}
          type="button"
          data-annotation-panel-remove
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
            className="min-h-10 rounded-md bg-accent-soft px-2.5 text-[11px] font-semibold text-accent-deep transition-colors hover:bg-accent-soft/70 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-8"
            onClick={save}
          >
            {t('transcript.annotation.save')}
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
