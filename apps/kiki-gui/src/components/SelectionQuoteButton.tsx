/**
 * SelectionQuoteButton — floating selection actions that appear above a text
 * selection inside the transcript. Two actions:
 *   - "Quote" hands the selected text to the composer as a quote chip.
 *   - "Annotate" swaps the pill for a small in-place comment input; confirming
 *     (Enter) hands {text, comment} to the composer as an annotation chip,
 *     Escape returns to the two-action pill.
 *
 * Behavior contract (mirrors aionui's SelectionReplyButton, minus Shadow DOM
 * concerns — this app is a plain DOM tree):
 *   - Shows on mouseup / selection change when the selection is non-empty and
 *     fully inside the transcript container.
 *   - Hides on selection collapse, scroll (capture — the scroll container
 *     lives inside the transcript), Escape, or a mousedown anywhere else while
 *     showing actions. While annotating, collapse and scroll are ignored; an
 *     outside mousedown only hides the popover temporarily so its draft can be
 *     resumed by selecting the same text again. A different selection returns
 *     to the actions pill with a fresh annotation draft; Escape cancels the
 *     retained draft explicitly.
 *   - Never renders on coarse-pointer (touch) devices.
 *   - The actions pill never steals the selection: its mousedown is prevented,
 *     while the annotate input keeps the default mousedown so the caret works.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

import {
  isCoarsePointer,
  selectionAnchorRect,
  selectionTextWithin,
} from '@kiki/session-core/composer';
import { useI18n } from '../i18n';

const PILL_HEIGHT = 32;
const VIEWPORT_MARGIN = 8;
/** Reserved horizontal room per mode so the popover stays inside the viewport. */
const PILL_WIDTH = 200;
const INPUT_WIDTH = 320;

type Target = { text: string; top: number; left: number };
type Mode = 'actions' | 'annotate';
type AnnotationDraft = { text: string; comment: string };

export function SelectionQuoteButton({
  containerRef,
  onQuote,
  onAnnotate,
}: {
  /** The transcript container; a selection must live fully inside it. */
  containerRef: RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
  onAnnotate: (text: string, comment: string) => void;
}) {
  const { t } = useI18n();
  // SSR (tests render to static markup) has no window — stay hidden there.
  const [coarse] = useState(() => isCoarsePointer());
  const [target, setTarget] = useState<Target | null>(null);
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<Mode>('actions');
  const [comment, setComment] = useState('');
  const targetRef = useRef(target);
  targetRef.current = target;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const composingRef = useRef(false);
  const submittingRef = useRef(false);
  const draftRef = useRef<AnnotationDraft | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = (clearDraft = true) => {
    setVisible(false);
    setTarget(null);
    setMode('actions');
    setComment('');
    if (clearDraft) draftRef.current = null;
    composingRef.current = false;
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (coarse) return;
    const evaluate = () => {
      const mode = modeRef.current;
      const resumingAnnotation = mode === 'annotate' && !visibleRef.current;
      // While the annotate input is open the current text is being edited —
      // a fresh selection must not swap it out from under the comment. A
      // temporarily hidden draft may be resumed by selecting its source text.
      if (mode === 'annotate' && !resumingAnnotation) return;
      const container = containerRef.current;
      const selection = window.getSelection();
      if (container === null || selection === null) {
        if (!resumingAnnotation) closeRef.current(draftRef.current === null);
        return;
      }
      const text = selectionTextWithin(container, selection);
      const rect = text === null ? null : selectionAnchorRect(selection);
      if (text === null || rect === null) {
        if (!resumingAnnotation) closeRef.current(draftRef.current === null);
        return;
      }
      const pendingTarget = targetRef.current;
      if (resumingAnnotation && (pendingTarget === null || pendingTarget.text !== text)) {
        // A different selection gets the ordinary actions pill. The one
        // retained draft stays keyed to its source and is not copied into it.
        setMode('actions');
        setComment('');
        setTarget({
          text,
          top: Math.max(rect.top - PILL_HEIGHT - 6, VIEWPORT_MARGIN),
          left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN), window.innerWidth - PILL_WIDTH),
        });
        setVisible(true);
        return;
      }
      const annotation = mode === 'annotate';
      const width = annotation ? INPUT_WIDTH : PILL_WIDTH;
      if (resumingAnnotation) {
        const draft = draftRef.current;
        if (draft !== null && draft.text === text) setComment(draft.comment);
      }
      setTarget({
        text,
        top: Math.max(rect.top - PILL_HEIGHT - 6 - (annotation ? 58 : 0), VIEWPORT_MARGIN),
        left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN), window.innerWidth - width),
      });
      setVisible(true);
    };
    const onMouseUp = () => { evaluate(); };
    const onSelectionChange = () => {
      // Collapse hides immediately — except while the annotate input is open:
      // focusing it collapses the document selection by design, and the
      // selected text is already captured in state. A still-growing selection
      // is re-evaluated on mouseup so the pill does not chase the caret
      // mid-drag.
      if (modeRef.current === 'annotate') return;
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) {
        closeRef.current(draftRef.current === null);
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      const popover = popoverRef.current;
      if (popover !== null && event.target instanceof Node && popover.contains(event.target)) return;
      // Dismissal during annotation is temporary: the selected text and the
      // comment remain available for a later re-selection.
      if (modeRef.current === 'annotate') {
        setVisible(false);
        return;
      }
      closeRef.current(draftRef.current === null);
    };
    // Capture + stopPropagation: while the pill is up, Escape dismisses IT —
    // it must not fall through to the session-level abort handler. In annotate
    // mode the input must receive Escape itself (back to the pill); it stops
    // propagation at the target, which equally shields the session handler.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || targetRef.current === null) return;
      if (modeRef.current === 'annotate') {
        // If an outside click temporarily hid the input, Escape is the
        // explicit cancellation path for that retained draft.
        if (!visibleRef.current) {
          event.stopPropagation();
          closeRef.current();
        }
        return;
      }
      event.stopPropagation();
      closeRef.current();
    };
    const onScroll = () => {
      // Scrolling is expected while an annotation is being edited (including
      // the input's own horizontal scroll); never discard that draft.
      if (modeRef.current === 'annotate') return;
      closeRef.current(draftRef.current === null);
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [coarse, containerRef]);

  // Entering or resuming annotate mode moves focus into the comment input
  // (which collapses the selection — guarded above). A resume already has an
  // annotation-sized target, so only a mode change needs to shift the panel.
  useEffect(() => {
    if (mode !== 'annotate' || !visible) return;
    inputRef.current?.focus();
  }, [mode, visible]);
  useEffect(() => {
    if (mode !== 'annotate') return;
    setTarget((current) =>
      current === null
        ? current
        : {
            ...current,
            top: Math.max(current.top - 58, VIEWPORT_MARGIN),
            left: Math.min(current.left, window.innerWidth - INPUT_WIDTH),
          },
    );
  }, [mode]);

  if (target === null || !visible) return null;

  if (mode === 'annotate') {
    return (
      <div
        ref={popoverRef}
        data-selection-quote
        data-selection-annotate
        className="anim-enter fixed z-50 w-72 rounded-xl border border-hairline bg-panel p-2 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)]"
        style={{ top: target.top, left: target.left }}
        onMouseDown={(event) => {
          if (event.target !== inputRef.current) event.preventDefault();
        }}
      >
        <p className="mb-1.5 max-h-8 overflow-hidden border-l-2 border-accent/60 pl-1.5 text-[11px] leading-snug whitespace-pre-wrap text-ink-soft">
          {target.text}
        </p>
        <input
          ref={inputRef}
          data-selection-annotate-input
          type="text"
          value={comment}
          placeholder={t('composer.annotationPlaceholder')}
          aria-label={t('composer.annotateSelection')}
          onChange={(event) => {
            const nextComment = event.target.value;
            setComment(nextComment);
            draftRef.current = { text: target.text, comment: nextComment };
          }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            event.stopPropagation();
            const nativeEvent = event.nativeEvent;
            const imeActive = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
            if ((event.key === 'Enter' || event.key === 'Escape') && imeActive) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              if (submittingRef.current) return;
              const trimmed = comment.trim();
              if (trimmed !== '') {
                submittingRef.current = true;
                draftRef.current = null;
                onAnnotate(target.text, trimmed);
                window.getSelection()?.removeAllRanges();
                close();
              }
            } else if (event.key === 'Escape') {
              submittingRef.current = false;
              composingRef.current = false;
              draftRef.current = null;
              setMode('actions');
              setComment('');
            }
          }}
          className="w-full rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
      </div>
    );
  }

  return (
    <div
      ref={popoverRef}
      data-selection-quote
      className="anim-enter fixed z-50 flex items-center overflow-hidden rounded-full border border-hairline bg-panel text-[12px] font-medium text-ink-soft shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)]"
      style={{ top: target.top, left: target.left }}
      onMouseDown={(event) => { event.preventDefault(); }}
    >
      <button
        type="button"
        className="flex items-center gap-1 px-3 py-1 transition-colors hover:text-accent"
        onClick={() => {
          onQuote(target.text);
          window.getSelection()?.removeAllRanges();
          close(draftRef.current === null);
        }}
      >
        <span aria-hidden className="text-accent">❝</span>
        {t('composer.quoteSelection')}
      </button>
      <span aria-hidden className="h-4 w-px bg-hairline" />
      <button
        type="button"
        data-selection-annotate-action
        className="flex items-center gap-1 px-3 py-1 transition-colors hover:text-amber-ink"
        onClick={() => {
          const draft = draftRef.current;
          const nextComment = draft?.text === target.text ? draft.comment : '';
          // Starting Annotate on another selection intentionally replaces the
          // single retained draft; it never reuses its comment for new text.
          draftRef.current = { text: target.text, comment: nextComment };
          submittingRef.current = false;
          composingRef.current = false;
          setComment(nextComment);
          setMode('annotate');
        }}
      >
        <span aria-hidden className="text-amber-ink">✎</span>
        {t('composer.annotateSelection')}
      </button>
    </div>
  );
}
