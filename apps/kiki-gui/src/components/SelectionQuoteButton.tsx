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
 *   - Hides on selection collapse, any scroll (capture — the scroll container
 *     lives inside the transcript), Escape, or a mousedown anywhere else.
 *     While the annotate input is open a collapse is expected (the input took
 *     focus) and does NOT hide the popover — the text is already captured.
 *   - Never renders on coarse-pointer (touch) devices.
 *   - The pill itself never steals the selection: mousedown is prevented so
 *     the highlighted text stays put until an action commits.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

import { useI18n } from '../i18n';
import {
  isCoarsePointer,
  selectionAnchorRect,
  selectionTextWithin,
} from '../lib/selectionQuote';

const PILL_HEIGHT = 32;
const VIEWPORT_MARGIN = 8;
/** Reserved horizontal room per mode so the popover stays inside the viewport. */
const PILL_WIDTH = 200;
const INPUT_WIDTH = 320;

type Target = { text: string; top: number; left: number };
type Mode = 'actions' | 'annotate';

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
  const [mode, setMode] = useState<Mode>('actions');
  const [comment, setComment] = useState('');
  const targetRef = useRef(target);
  targetRef.current = target;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setTarget(null);
    setMode('actions');
    setComment('');
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (coarse) return;
    const evaluate = () => {
      // While the annotate input is open the current text is being edited —
      // a fresh selection must not swap it out from under the comment.
      if (modeRef.current === 'annotate') return;
      const container = containerRef.current;
      const selection = window.getSelection();
      if (container === null || selection === null) {
        closeRef.current();
        return;
      }
      const text = selectionTextWithin(container, selection);
      const rect = text === null ? null : selectionAnchorRect(selection);
      if (text === null || rect === null) {
        closeRef.current();
        return;
      }
      setTarget({
        text,
        top: Math.max(rect.top - PILL_HEIGHT - 6, VIEWPORT_MARGIN),
        left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN), window.innerWidth - PILL_WIDTH),
      });
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
      if (selection === null || selection.isCollapsed) closeRef.current();
    };
    const onMouseDown = (event: MouseEvent) => {
      const popover = popoverRef.current;
      if (popover !== null && event.target instanceof Node && popover.contains(event.target)) return;
      closeRef.current();
    };
    // Capture + stopPropagation: while the pill is up, Escape dismisses IT —
    // it must not fall through to the session-level abort handler. In annotate
    // mode the input must receive Escape itself (back to the pill); it stops
    // propagation at the target, which equally shields the session handler.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || targetRef.current === null) return;
      if (modeRef.current === 'annotate') return;
      event.stopPropagation();
      closeRef.current();
    };
    const onScroll = () => { closeRef.current(); };
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

  // Entering annotate mode moves focus into the comment input (which collapses
  // the selection — guarded above). The panel is taller than the pill, so it
  // also shifts up to keep the selected lines uncovered, and re-clamps the
  // wider panel on screen.
  useEffect(() => {
    if (mode !== 'annotate') return;
    inputRef.current?.focus();
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

  if (target === null) return null;

  if (mode === 'annotate') {
    return (
      <div
        ref={popoverRef}
        data-selection-quote
        data-selection-annotate
        className="anim-enter fixed z-50 w-72 rounded-xl border border-hairline bg-panel p-2 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)]"
        style={{ top: target.top, left: target.left }}
        onMouseDown={(event) => { event.preventDefault(); }}
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
          onChange={(event) => { setComment(event.target.value); }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              const trimmed = comment.trim();
              if (trimmed !== '') {
                onAnnotate(target.text, trimmed);
                window.getSelection()?.removeAllRanges();
                close();
              }
            } else if (event.key === 'Escape') {
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
          close();
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
        onClick={() => { setMode('annotate'); }}
      >
        <span aria-hidden className="text-amber-ink">✎</span>
        {t('composer.annotateSelection')}
      </button>
    </div>
  );
}
