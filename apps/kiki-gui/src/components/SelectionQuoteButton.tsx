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

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import {
  isCoarsePointer,
  selectionAnchorRect,
  selectionTextWithin,
  selectionSourceAnchor,
  type SelectionSourceAnchor,
} from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { unzoomedRect, unzoomedViewport } from '../lib/uiZoom';
import { Icon } from './icons';

const PILL_HEIGHT = 32;
const PILL_WIDTH = 112;
const INPUT_WIDTH = 288;
const INPUT_HEIGHT = 104;
const GAP = 6;
const VIEWPORT_MARGIN = 8;
const MAX_TEXTAREA_HEIGHT = 120;

interface AnchorRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

type Target = {
  readonly text: string;
  readonly source: SelectionSourceAnchor | null;
  readonly anchor: AnchorRect;
  readonly top: number;
  readonly left: number;
};
type Mode = 'actions' | 'annotate';

function clampPopoverPosition(
  anchor: AnchorRect,
  boxWidth: number,
  boxHeight: number,
  viewport: { readonly width: number; readonly height: number },
): { readonly top: number; readonly left: number } {
  const maxAvailableWidth = Math.max(0, viewport.width - VIEWPORT_MARGIN * 2);
  const effectiveWidth = Math.min(boxWidth, maxAvailableWidth);
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - effectiveWidth - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN), maxLeft);

  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - boxHeight - VIEWPORT_MARGIN);
  const aboveTop = anchor.top - boxHeight - GAP;
  const belowTop = anchor.bottom + GAP;
  let top: number;
  if (aboveTop >= VIEWPORT_MARGIN) {
    top = aboveTop;
  } else if (belowTop + boxHeight <= viewport.height - VIEWPORT_MARGIN) {
    top = belowTop;
  } else {
    const roomAbove = anchor.top - VIEWPORT_MARGIN;
    const roomBelow = viewport.height - VIEWPORT_MARGIN - anchor.bottom;
    top = roomBelow >= roomAbove ? belowTop : aboveTop;
  }
  top = Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop);
  return { top, left };
}

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
  const anchorRangeRef = useRef<Range | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const close = () => {
    setVisible(false);
    setTarget(null);
    setMode('actions');
    setComment('');
    annotationIdRef.current = null;
    anchorRangeRef.current = null;
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
      const rawRect = text === null || selection === null ? null : selectionAnchorRect(selection);
      if (text === null || rawRect === null || selection === null) {
        closeRef.current();
        return;
      }
      const rect = unzoomedRect(rawRect);
      const anchor: AnchorRect = {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      };
      const viewport = unzoomedViewport();
      const pos = clampPopoverPosition(anchor, PILL_WIDTH, PILL_HEIGHT, viewport);
      anchorRangeRef.current = selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      setTarget({
        text,
        source: selectionSourceAnchor(selection),
        anchor,
        top: pos.top,
        left: pos.left,
      });
      setVisible(true);
    };
    const repositionAnnotate = () => {
      const current = targetRef.current;
      if (current === null) return;
      const viewport = unzoomedViewport();
      let anchor = current.anchor;
      const range = anchorRangeRef.current;
      if (range !== null && range.startContainer.isConnected && typeof range.getBoundingClientRect === 'function') {
        const rawRect = range.getBoundingClientRect();
        if (rawRect.width > 0 || rawRect.height > 0) {
          const rect = unzoomedRect(rawRect);
          if (rect.bottom < 0 || rect.top > viewport.height) {
            closeRef.current();
            return;
          }
          anchor = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        }
      }
      const box = popoverRef.current?.getBoundingClientRect();
      const width = box !== undefined && box.width > 0 ? unzoomedRect(box).width : INPUT_WIDTH;
      const height = box !== undefined && box.height > 0 ? unzoomedRect(box).height : INPUT_HEIGHT;
      const pos = clampPopoverPosition(anchor, width, height, viewport);
      setTarget((previous) => {
        if (previous === null) return null;
        if (
          previous.top === pos.top &&
          previous.left === pos.left &&
          previous.anchor.top === anchor.top &&
          previous.anchor.bottom === anchor.bottom &&
          previous.anchor.left === anchor.left &&
          previous.anchor.right === anchor.right
        ) {
          return previous;
        }
        return { ...previous, anchor, top: pos.top, left: pos.left };
      });
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
    const onScroll = (event: Event) => {
      const popover = popoverRef.current;
      if (popover !== null && event.target instanceof Node && popover.contains(event.target)) return;
      const scrollTarget = event.target;
      const container = containerRef.current;
      if (
        scrollTarget !== window &&
        scrollTarget !== document &&
        scrollTarget instanceof Node &&
        container !== null &&
        !scrollTarget.contains(container) &&
        !container.contains(scrollTarget)
      ) {
        return;
      }
      if (modeRef.current !== 'annotate') {
        closeRef.current();
        return;
      }
      repositionAnnotate();
    };
    const onResize = () => {
      if (modeRef.current === 'annotate') repositionAnnotate();
      else if (targetRef.current !== null) closeRef.current();
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [coarse, containerRef]);

  useEffect(() => {
    if (mode === 'annotate' && visible) inputRef.current?.focus();
  }, [mode, visible]);

  useLayoutEffect(() => {
    if (mode !== 'annotate' || !visible) return;
    const area = inputRef.current;
    if (area !== null) {
      area.style.height = 'auto';
      if (area.scrollHeight > 0) {
        area.style.height = `${Math.min(area.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
      }
    }
    const popover = popoverRef.current;
    const current = targetRef.current;
    if (popover === null || current === null) return;
    const rawBox = popover.getBoundingClientRect();
    if (rawBox.width <= 0 || rawBox.height <= 0) return;
    const box = unzoomedRect(rawBox);
    const pos = clampPopoverPosition(current.anchor, box.width, box.height, unzoomedViewport());
    if (pos.top !== current.top || pos.left !== current.left) {
      setTarget((previous) => (previous === null ? null : { ...previous, top: pos.top, left: pos.left }));
    }
  }, [mode, visible, comment]);

  if (target === null || !visible) return null;

  if (mode === 'annotate') {
    return (
      <div
        ref={popoverRef}
        data-selection-quote
        data-selection-annotate
        className="anim-enter fixed z-50 w-[min(18rem,calc(100%-16px))] rounded-xl border border-hairline bg-panel p-2 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)]"
        style={{ top: target.top, left: target.left }}
        onMouseDown={(event) => {
          if (event.target !== inputRef.current) event.preventDefault();
        }}
      >
        <p className="mb-1.5 max-h-8 overflow-hidden border-l-2 border-accent/60 pl-1.5 text-[11px] leading-snug whitespace-pre-wrap text-ink-soft">
          {target.text}
        </p>
        <textarea
          ref={inputRef}
          rows={1}
          data-selection-annotate-input
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
            if (event.key === 'Enter' && event.shiftKey) return;
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault();
              window.getSelection()?.removeAllRanges();
              close();
            }
          }}
          className="min-h-9 max-h-[120px] w-full resize-none overflow-y-auto rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] leading-snug text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-selected-ink/20"
        />
      </div>
    );
  }

  return (
    <div
      ref={popoverRef}
      data-selection-quote
      className="anim-enter fixed z-50 flex items-center overflow-hidden rounded-full border border-hairline bg-panel text-[12px] font-normal text-ink-soft shadow-[0_8px_24px_-10px_rgba(28,25,23,0.35)]"
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
          const pos = clampPopoverPosition(target.anchor, INPUT_WIDTH, INPUT_HEIGHT, unzoomedViewport());
          setTarget({
            ...target,
            top: pos.top,
            left: pos.left,
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
