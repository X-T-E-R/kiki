/**
 * SelectionQuoteButton — floating "quote" action that appears above a text
 * selection inside the transcript. Clicking it hands the selected text to the
 * composer as a quote chip.
 *
 * Behavior contract (mirrors aionui's SelectionReplyButton, minus Shadow DOM
 * concerns — this app is a plain DOM tree):
 *   - Shows on mouseup / selection change when the selection is non-empty and
 *     fully inside the transcript container.
 *   - Hides on selection collapse, any scroll (capture — the scroll container
 *     lives inside the transcript), Escape, or a mousedown anywhere else.
 *   - Never renders on coarse-pointer (touch) devices.
 *   - The button itself never steals the selection: mousedown is prevented so
 *     the highlighted text stays put until the click commits.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

import { useI18n } from '../i18n';
import {
  isCoarsePointer,
  selectionAnchorRect,
  selectionTextWithin,
} from '../lib/selectionQuote';

const BUTTON_HEIGHT = 32;
const VIEWPORT_MARGIN = 8;

export function SelectionQuoteButton({
  containerRef,
  onQuote,
}: {
  /** The transcript container; a selection must live fully inside it. */
  containerRef: RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}) {
  const { t } = useI18n();
  // SSR (tests render to static markup) has no window — stay hidden there.
  const [coarse] = useState(() => isCoarsePointer());
  const [target, setTarget] = useState<{ text: string; top: number; left: number } | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (coarse) return;
    const evaluate = () => {
      const container = containerRef.current;
      const selection = window.getSelection();
      if (container === null || selection === null) {
        setTarget(null);
        return;
      }
      const text = selectionTextWithin(container, selection);
      const rect = text === null ? null : selectionAnchorRect(selection);
      if (text === null || rect === null) {
        setTarget(null);
        return;
      }
      setTarget({
        text,
        top: Math.max(rect.top - BUTTON_HEIGHT - 6, VIEWPORT_MARGIN),
        left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN), window.innerWidth - 96),
      });
    };
    const onMouseUp = () => { evaluate(); };
    const onSelectionChange = () => {
      // Collapse hides immediately; a still-growing selection is re-evaluated
      // on mouseup so the button does not chase the caret mid-drag.
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) setTarget(null);
    };
    const onMouseDown = (event: MouseEvent) => {
      const button = buttonRef.current;
      if (button !== null && event.target instanceof Node && button.contains(event.target)) return;
      setTarget(null);
    };
    // Capture + stopPropagation: while the quote button is up, Escape dismisses
    // IT — it must not fall through to the session-level abort handler.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || targetRef.current === null) return;
      event.stopPropagation();
      setTarget(null);
    };
    const onScroll = () => { setTarget(null); };
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

  if (target === null) return null;
  return (
    <button
      ref={buttonRef}
      type="button"
      data-selection-quote
      className="anim-enter fixed z-50 flex items-center gap-1 rounded-full border border-hairline bg-panel px-3 py-1 text-[12px] font-medium text-ink-soft shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)] transition-colors hover:border-accent hover:text-accent"
      style={{ top: target.top, left: target.left }}
      onMouseDown={(event) => { event.preventDefault(); }}
      onClick={() => {
        onQuote(target.text);
        window.getSelection()?.removeAllRanges();
        setTarget(null);
      }}
    >
      <span aria-hidden className="text-accent">❝</span>
      {t('composer.quoteSelection')}
    </button>
  );
}
