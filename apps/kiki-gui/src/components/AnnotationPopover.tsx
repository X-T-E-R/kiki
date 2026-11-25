/**
 * Shared `@base-ui/react/popover` annotation editor used both when creating a
 * new selection annotation (`SelectionQuoteButton`) and when reopening a saved
 * highlight mark (`AnnotationPopover`).
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';

import type { TimelineAnnotation } from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { floatingSurfaceZIndex, registerOverlay } from '../lib/uiBusy';

export interface AnnotationAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface AnnotationPopoverOpen {
  readonly annotationId: string;
  readonly anchor: AnnotationAnchorRect;
}

const MAX_EXPANDED_TEXTAREA_HEIGHT = 160;
const MIN_EXPANDED_TEXTAREA_HEIGHT = 68;

export function AnnotationEditorPopover({
  id,
  anchor,
  side = 'bottom',
  quote,
  comment,
  placeholder,
  panelAriaLabel,
  inputAriaLabel,
  alwaysEnableSave = false,
  selectionInputAttr = false,
  popupDataAttrs,
  onLiveChange,
  onSave,
  onRemove,
  onClose,
}: {
  readonly id?: string;
  readonly anchor: AnnotationAnchorRect;
  readonly side?: 'top' | 'bottom';
  readonly quote: string;
  readonly comment: string | null;
  readonly placeholder?: string;
  readonly panelAriaLabel: string;
  readonly inputAriaLabel: string;
  readonly alwaysEnableSave?: boolean;
  readonly selectionInputAttr?: boolean;
  readonly popupDataAttrs?: Readonly<Record<`data-${string}`, string>>;
  readonly onLiveChange?: (comment: string) => void;
  readonly onSave: (comment: string) => void;
  readonly onRemove?: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const generatedId = useId().replace(/:/g, '');
  const surfaceId = id ?? `annotation-editor-${generatedId}`;
  const [draft, setDraft] = useState(comment ?? '');
  const [isFocused, setIsFocused] = useState(comment !== null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const removeRef = useRef<HTMLButtonElement | null>(null);
  const composingRef = useRef(false);
  const focusedOnceRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    setDraft(comment ?? '');
  }, [comment]);

  const virtualAnchor = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x: anchor.left,
        y: anchor.top,
        top: anchor.top,
        left: anchor.left,
        bottom: anchor.bottom,
        right: anchor.right,
        width: Math.max(1, anchor.right - anchor.left),
        height: Math.max(1, anchor.bottom - anchor.top),
        toJSON: () => ({}),
      }),
    }),
    [anchor.bottom, anchor.left, anchor.right, anchor.top],
  );

  useEffect(() => {
    const unregister = registerOverlay(`popover:${surfaceId}`);
    const onOutsidePress = (event: MouseEvent | PointerEvent) => {
      const popup = popupRef.current;
      if (popup !== null && event.target instanceof Node && popup.contains(event.target)) return;
      closeRef.current();
    };
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || composingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('mousedown', onOutsidePress);
    window.addEventListener('keydown', onWindowKeyDown);
    return () => {
      unregister();
      document.removeEventListener('mousedown', onOutsidePress);
      window.removeEventListener('keydown', onWindowKeyDown);
    };
  }, [surfaceId]);

  useLayoutEffect(() => {
    const area = textareaRef.current;
    if (area === null) return;
    if (!isFocused) {
      area.style.height = '';
      return;
    }
    area.style.height = 'auto';
    if (area.scrollHeight > 0) {
      area.style.height = `${Math.min(Math.max(area.scrollHeight, MIN_EXPANDED_TEXTAREA_HEIGHT), MAX_EXPANDED_TEXTAREA_HEIGHT)}px`;
    }
  }, [draft, isFocused]);

  const trimmed = draft.trim();
  const dirty = comment !== null && trimmed !== comment;
  const canSave = comment !== null && (alwaysEnableSave || dirty);

  const commitSave = () => {
    if (comment === null) {
      onClose();
      return;
    }
    if (alwaysEnableSave || dirty) {
      onSave(trimmed);
    }
    onClose();
  };

  const zIndex = floatingSurfaceZIndex(null);

  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) return;
        if (eventDetails.reason === 'escape-key') {
          if (composingRef.current) {
            eventDetails.cancel();
            return;
          }
          onClose();
          return;
        }
        eventDetails.cancel();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={virtualAnchor}
          side={side}
          align="start"
          sideOffset={8}
          collisionPadding={12}
          positionMethod="fixed"
          style={{ zIndex }}
        >
          <Popover.Popup
            ref={(node) => {
              popupRef.current = node;
              if (node !== null && !focusedOnceRef.current) {
                focusedOnceRef.current = true;
                queueMicrotask(() => {
                  if (textareaRef.current !== null) {
                    textareaRef.current.focus();
                    setIsFocused(true);
                  } else {
                    removeRef.current?.focus();
                  }
                });
              }
            }}
            id={surfaceId}
            role="dialog"
            aria-label={panelAriaLabel}
            initialFocus={false}
            finalFocus={false}
            tabIndex={-1}
            data-anchored-popover=""
            data-annotation-panel=""
            {...popupDataAttrs}
            className="anim-enter w-80 max-w-[calc(100vw-24px)] rounded-xl border border-hairline bg-panel p-3 shadow-lg outline-none"
          >
            <p
              className={`border-l-2 border-accent/60 pl-2 text-[12px] leading-[18px] whitespace-pre-wrap break-words text-ink-soft ${
                isFocused ? 'mb-2 line-clamp-3' : 'mb-1.5 line-clamp-2'
              }`}
            >
              {quote}
            </p>
            {comment !== null ? (
              <textarea
                ref={textareaRef}
                rows={isFocused ? 3 : 1}
                data-annotation-panel-input=""
                data-focused={isFocused ? 'true' : 'false'}
                {...(selectionInputAttr ? { 'data-selection-annotate-input': '' } : {})}
                value={draft}
                placeholder={placeholder}
                aria-label={inputAriaLabel}
                onFocus={() => { setIsFocused(true); }}
                onBlur={(event) => {
                  const nextTarget = event.relatedTarget;
                  if (nextTarget instanceof Node && popupRef.current?.contains(nextTarget)) return;
                  setIsFocused(false);
                }}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setDraft(nextValue);
                  onLiveChange?.(nextValue);
                }}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  const nativeEvent = event.nativeEvent;
                  const imeActive = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
                  if ((event.key === 'Enter' || event.key === 'Escape') && imeActive) return;
                  if (event.key === 'Enter' && event.shiftKey) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitSave();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onClose();
                  }
                }}
                className={
                  isFocused
                    ? 'min-h-[68px] max-h-[160px] w-full resize-none overflow-y-auto rounded-lg border border-hairline-strong bg-paper px-2.5 py-2 text-[13px] leading-5 whitespace-pre-wrap break-words text-ink outline-none placeholder:text-ink-faint transition-[border-color,box-shadow] duration-150 [field-sizing:content] focus:border-ink-soft/60 focus:ring-2 focus:ring-ink/[0.06]'
                    : 'h-8 max-h-8 w-full cursor-text resize-none overflow-hidden rounded-lg border border-hairline bg-paper px-2.5 py-1.5 text-[13px] leading-5 text-ellipsis whitespace-nowrap text-ink outline-none placeholder:text-ink-faint transition-[border-color,box-shadow] duration-150'
                }
              />
            ) : (
              <p className="text-[12px] leading-4 text-ink-faint">{t('transcript.annotation.quoteOnly')}</p>
            )}
            <div
              className="mt-2.5 flex items-center justify-end gap-1.5"
              onMouseDown={(event) => { event.preventDefault(); }}
            >
              {onRemove !== undefined ? (
                <button
                  ref={removeRef}
                  type="button"
                  data-annotation-panel-remove=""
                  className="min-h-8 cursor-pointer rounded-md px-2.5 text-[12px] leading-4 font-normal text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-10"
                  onClick={() => {
                    onRemove();
                    onClose();
                  }}
                >
                  {t('transcript.annotation.remove')}
                </button>
              ) : null}
              {comment !== null ? (
                <button
                  type="button"
                  data-annotation-panel-save=""
                  disabled={!canSave}
                  className="min-h-8 cursor-pointer rounded-md bg-ink/[0.07] px-3 text-[12px] leading-4 font-normal text-ink transition-colors hover:bg-ink/[0.12] focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-10"
                  onClick={commitSave}
                >
                  {t('transcript.annotation.save')}
                </button>
              ) : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
  return (
    <AnnotationEditorPopover
      id={`annotation-panel-${annotation.id}`}
      anchor={state.anchor}
      side="bottom"
      quote={annotation.quote}
      comment={annotation.comment}
      placeholder={t('composer.annotationPlaceholder')}
      panelAriaLabel={t('transcript.annotation.panelAria')}
      inputAriaLabel={t('transcript.annotation.commentAria')}
      onSave={(comment) => { onSave(annotation.id, comment); }}
      onRemove={() => { onRemove(annotation.id); }}
      onClose={onClose}
    />
  );
}
