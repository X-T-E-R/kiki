/**
 * SelectionQuoteButton — one floating annotation entry above a transcript text
 * selection. Activating it immediately creates a sourced composer item with an
 * empty comment, then opens the comment editor. Enter, Escape and light dismiss
 * only close that editor: the item and every keystroke already belong to the
 * composer, so ignoring the input never cancels the reference.
 *
 * Behavior contract (mirrors aionui's SelectionReplyButton, minus Shadow DOM
 * concerns — this app is a plain DOM tree):
 *   - Shows on mouseup when the selection is non-empty and fully inside the
 *     transcript container.
 *   - Hides on selection collapse, scroll, Escape, or a mousedown anywhere else.
 *   - Never renders on coarse-pointer (touch) devices.
 *   - The entry pill never steals the selection: its mousedown is prevented,
 *     while the comment input keeps the default mousedown so the caret works.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

import {
  isCoarsePointer,
  selectionAnchorRect,
  selectionTextWithin,
  selectionSourceAnchor,
  type SelectionSourceAnchor,
} from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { Icon } from './icons';

const PILL_HEIGHT = 32;
const VIEWPORT_MARGIN = 8;
const PILL_WIDTH = 112;
const INPUT_WIDTH = 320;

type Target = { text: string; source: SelectionSourceAnchor | null; top: number; left: number };
type Mode = 'actions' | 'annotate';

export function SelectionQuoteButton({
  containerRef,
  onAnnotate,
  onUpdateAnnotation,
}: {
  /** The transcript container; a selection must live fully inside it. */
  containerRef: RefObject<HTMLElement | null>;
  /** Create the item immediately and return its stable id for comment updates. */
  onAnnotate: (text: string, comment: string, source?: SelectionSourceAnchor | null) => string;
  onUpdateAnnotation: (id: string, comment: string) => void;
}) {
  const { t } = useI18n();
  const [coarse] = useState(() => isCoarsePointer());
  const [target, setTarget] = useState<Target | null>(null);
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<Mode>('actions');
  const [comment, setComment] = useState('');
  const targetRef = useRef(target);
  targetRef.current = target;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const composingRef = useRef(false);
  const annotationIdRef = useRef<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setVisible(false);
    setTarget(null);
    setMode('actions');
    setComment('');
    annotationIdRef.current = null;
    composingRef.current = false;
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (coarse) return;
    const evaluate = () => {
      if (modeRef.current === 'annotate') return;
      const container = containerRef.current;
      const selection = window.getSelection();
      const text = container === null || selection === null ? null : selectionTextWithin(container, selection);
      const rect = text === null || selection === null ? null : selectionAnchorRect(selection);
      if (text === null || rect === null || selection === null) {
        closeRef.current();
        return;
      }
      setTarget({
        text,
        source: selectionSourceAnchor(selection),
        top: Math.max(rect.top - PILL_HEIGHT - 6, VIEWPORT_MARGIN),
        left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN), window.innerWidth - PILL_WIDTH),
      });
      setVisible(true);
    };
    const onMouseUp = () => { evaluate(); };
    const onSelectionChange = () => {
      if (modeRef.current === 'annotate') return;
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) closeRef.current();
    };
    const onMouseDown = (event: MouseEvent) => {
      const popover = popoverRef.current;
      if (popover !== null && event.target instanceof Node && popover.contains(event.target)) return;
      if (targetRef.current !== null) closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || targetRef.current === null || modeRef.current === 'annotate') return;
      event.stopPropagation();
      closeRef.current();
    };
    const onScroll = () => {
      if (modeRef.current !== 'annotate') closeRef.current();
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

  useEffect(() => {
    if (mode === 'annotate' && visible) inputRef.current?.focus();
  }, [mode, visible]);

  if (target === null || !visible) return null;

  if (mode === 'annotate') {
    return (
      <div
        ref={popoverRef}
        data-selection-quote
        data-selection-annotate
        className="anim-enter fixed z-50 w-[min(18rem,calc(100vw-16px))] rounded-xl border border-hairline bg-panel p-2 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)]"
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
            const id = annotationIdRef.current;
            if (id !== null) onUpdateAnnotation(id, nextComment);
          }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            event.stopPropagation();
            const nativeEvent = event.nativeEvent;
            const imeActive = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
            if ((event.key === 'Enter' || event.key === 'Escape') && imeActive) return;
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault();
              window.getSelection()?.removeAllRanges();
              close();
            }
          }}
          className="min-h-9 w-full rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-selected-ink/20"
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
        data-selection-annotate-action
        className="flex min-h-8 items-center gap-1.5 px-3 py-1 transition-colors hover:text-amber-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        onClick={() => {
          const id = onAnnotate(target.text, '', target.source);
          annotationIdRef.current = id;
          setComment('');
          setTarget({
            ...target,
            top: Math.max(target.top - 58, VIEWPORT_MARGIN),
            left: Math.min(target.left, window.innerWidth - INPUT_WIDTH),
          });
          setMode('annotate');
          window.getSelection()?.removeAllRanges();
        }}
      >
        <Icon name="edit" className="text-amber-ink" />
        {t('composer.annotateSelection')}
      </button>
    </div>
  );
}
