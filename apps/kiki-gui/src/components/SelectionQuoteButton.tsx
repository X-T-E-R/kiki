/**
 * SelectionQuoteButton — floating `@base-ui/react/popover` annotation trigger &
 * shared multiline editor above a transcript text selection.
 *
 * Activating the entry pill immediately creates a sourced composer annotation
 * item with an empty comment, then opens the shared `AnnotationEditorPopover`
 * (multiline auto-wrapping `<textarea>`, focus-expand / blur-compress, and
 * explicit `删除` + `保存` actions).
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';

import {
  isCoarsePointer,
  selectionAnchorRect,
  selectionQuotableTextWithin,
  selectionSourceAnchor,
  type SelectionSourceAnchor,
} from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { floatingSurfaceZIndex } from '../lib/uiBusy';
import { unzoomedRect, unzoomedViewport } from '../lib/uiZoom';
import { AnnotationEditorPopover, type AnnotationAnchorRect } from './AnnotationPopover';
import { Icon } from './icons';

type Target = {
  readonly text: string;
  readonly source: SelectionSourceAnchor | null;
  readonly anchor: AnnotationAnchorRect;
};
type Mode = 'actions' | 'annotate';

const ANNOTATE_POPUP_ATTRS = {
  'data-selection-quote': '',
  'data-selection-annotate': '',
} as const;

export function SelectionQuoteButton({
  containerRef,
  onAnnotate,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: {
  /** The transcript container; a selection must live fully inside it. */
  containerRef: RefObject<HTMLElement | null>;
  /** Create the item immediately and return its stable id for comment updates. */
  onAnnotate: (text: string, comment: string, source?: SelectionSourceAnchor | null) => string;
  onUpdateAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation?: (id: string) => void;
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
  const lastSyncedCommentRef = useRef('');
  const annotationIdRef = useRef<string | null>(null);
  const anchorRangeRef = useRef<Range | null>(null);
  const pillPopupRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setVisible(false);
    setTarget(null);
    setMode('actions');
    setComment('');
    lastSyncedCommentRef.current = '';
    annotationIdRef.current = null;
    anchorRangeRef.current = null;
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (coarse) return;
    const evaluate = () => {
      if (modeRef.current === 'annotate') return;
      const container = containerRef.current;
      const selection = window.getSelection();
      const text = container === null || selection === null ? null : selectionQuotableTextWithin(container, selection);
      const rawRect = text === null || selection === null ? null : selectionAnchorRect(selection);
      if (text === null || rawRect === null || selection === null) {
        closeRef.current();
        return;
      }
      const rect = unzoomedRect(rawRect);
      const viewport = unzoomedViewport();
      if (rect.bottom < 0 || rect.top > viewport.height) {
        closeRef.current();
        return;
      }
      const clampedTop = Math.max(12, Math.min(viewport.height - 12, rect.top));
      const clampedBottom = Math.max(clampedTop, Math.min(viewport.height - 12, rect.bottom));
      const clampedLeft = Math.max(12, Math.min(viewport.width - 12, rect.left));
      const clampedRight = Math.max(clampedLeft, Math.min(viewport.width - 12, rect.right));
      const anchor: AnnotationAnchorRect = {
        top: clampedTop,
        bottom: clampedBottom,
        left: clampedLeft,
        right: clampedRight,
      };
      anchorRangeRef.current = selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      setTarget({
        text,
        source: selectionSourceAnchor(selection),
        anchor,
      });
      setVisible(true);
    };

    const refreshAnnotateAnchor = () => {
      const current = targetRef.current;
      if (current === null) return;
      const viewport = unzoomedViewport();
      const range = anchorRangeRef.current;
      if (range !== null && range.startContainer.isConnected && typeof range.getBoundingClientRect === 'function') {
        const rawRect = range.getBoundingClientRect();
        if (rawRect.width > 0 || rawRect.height > 0) {
          const rect = unzoomedRect(rawRect);
          if (rect.bottom < 0 || rect.top > viewport.height) {
            closeRef.current();
            return;
          }
          const nextAnchor: AnnotationAnchorRect = {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
          };
          setTarget((previous) => {
            if (previous === null) return null;
            if (
              previous.anchor.top === nextAnchor.top &&
              previous.anchor.bottom === nextAnchor.bottom &&
              previous.anchor.left === nextAnchor.left &&
              previous.anchor.right === nextAnchor.right
            ) {
              return previous;
            }
            return { ...previous, anchor: nextAnchor };
          });
        }
      }
    };

    const onMouseUp = () => { evaluate(); };
    const onSelectionChange = () => {
      if (modeRef.current === 'annotate') return;
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) closeRef.current();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (modeRef.current === 'annotate') return;
      const pill = pillPopupRef.current;
      if (pill !== null && event.target instanceof Node && pill.contains(event.target)) return;
      if (targetRef.current !== null) closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || targetRef.current === null || modeRef.current === 'annotate') return;
      event.stopPropagation();
      closeRef.current();
    };
    const onScroll = (event: Event) => {
      const scrollTarget = event.target;
      if (scrollTarget instanceof HTMLElement && scrollTarget.closest('[data-annotation-panel]') !== null) {
        return;
      }
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
      refreshAnnotateAnchor();
    };
    const onResize = () => {
      if (modeRef.current === 'annotate') refreshAnnotateAnchor();
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

  const anchor = target?.anchor;
  const virtualAnchor = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x: anchor?.left ?? 0,
        y: anchor?.top ?? 0,
        top: anchor?.top ?? 0,
        left: anchor?.left ?? 0,
        bottom: anchor?.bottom ?? 0,
        right: anchor?.right ?? 0,
        width: Math.max(1, (anchor?.right ?? 0) - (anchor?.left ?? 0)),
        height: Math.max(1, (anchor?.bottom ?? 0) - (anchor?.top ?? 0)),
        toJSON: () => ({}),
      }),
    }),
    [anchor?.bottom, anchor?.left, anchor?.right, anchor?.top],
  );

  if (target === null || !visible) return null;

  if (mode === 'annotate') {
    return (
      <AnnotationEditorPopover
        anchor={target.anchor}
        side="top"
        quote={target.text}
        comment={comment}
        placeholder={t('composer.annotationPlaceholder')}
        panelAriaLabel={t('transcript.annotation.panelAria')}
        inputAriaLabel={t('composer.annotateSelection')}
        alwaysEnableSave
        selectionInputAttr
        popupDataAttrs={ANNOTATE_POPUP_ATTRS}
        onLiveChange={(nextComment) => {
          setComment(nextComment);
          const id = annotationIdRef.current;
          if (id !== null) {
            lastSyncedCommentRef.current = nextComment;
            onUpdateAnnotation(id, nextComment);
          }
        }}
        onSave={(trimmed) => {
          const id = annotationIdRef.current;
          if (id !== null && trimmed !== lastSyncedCommentRef.current) {
            lastSyncedCommentRef.current = trimmed;
            onUpdateAnnotation(id, trimmed);
          }
        }}
        onRemove={() => {
          const id = annotationIdRef.current;
          if (id !== null) onRemoveAnnotation?.(id);
        }}
        onClose={() => {
          window.getSelection()?.removeAllRanges();
          close();
        }}
      />
    );
  }

  const zIndex = floatingSurfaceZIndex(null);

  return (
    <Popover.Root open modal={false}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={virtualAnchor}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          positionMethod="fixed"
          style={{ zIndex }}
        >
          <Popover.Popup
            ref={pillPopupRef}
            initialFocus={false}
            finalFocus={false}
            data-selection-quote=""
            className="anim-enter flex items-center overflow-hidden rounded-full border border-hairline bg-panel text-[12px] font-normal text-ink-soft shadow-lg outline-none"
            onMouseDown={(event) => { event.preventDefault(); }}
          >
            <button
              type="button"
              data-selection-annotate-action=""
              className="flex min-h-8 cursor-pointer items-center gap-1.5 px-3 py-1 transition-colors hover:text-amber-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
              onClick={() => {
                const id = onAnnotate(target.text, '', target.source);
                annotationIdRef.current = id;
                lastSyncedCommentRef.current = '';
                setComment('');
                setMode('annotate');
                window.getSelection()?.removeAllRanges();
              }}
            >
              <Icon name="edit" className="text-amber-ink" />
              {t('composer.annotateSelection')}
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
