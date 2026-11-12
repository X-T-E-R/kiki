/**
 * ActionSheet — the coarse-pointer form of a small menu: a bottom sheet over
 * a scrim, rows sized for a thumb (index.css, "Touch action sheet"). A
 * pointer-positioned desktop menu lands under the finger on a phone and is
 * too small to hit, so `MiniContextMenu` and the message row's `⋯` hand
 * their items here instead on touch; the items stay the caller's own
 * `role="menuitem"` buttons.
 *
 * It closes on a scrim tap, Escape, and the phone's back (one layer-history
 * entry). Focus moves to the first enabled item on open and, when the sheet
 * still held it at close and nothing else claimed it since (an action that
 * opened a dialog keeps that dialog's focus), returns to whatever was focused
 * before.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useLayerHistory } from '../../lib/layerHistory';
import { floatingSurfaceZIndex, registerOverlay } from '../../lib/uiBusy';

const ITEM_SELECTOR =
  '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled]), [role="menuitemradio"]:not([disabled])';

/**
 * Focus the first item from `start` (stepping by `step`, wrapping) that
 * actually takes focus — a caller may keep width-gated rows in the DOM
 * hidden (`sm:hidden`), and those never do.
 */
function focusFrom(items: readonly HTMLElement[], start: number, step: 1 | -1): void {
  for (let offset = 0; offset < items.length; offset += 1) {
    const item = items[(((start + offset * step) % items.length) + items.length) % items.length]!;
    item.focus();
    if (document.activeElement === item) return;
  }
}

export function ActionSheet({
  ariaLabel,
  overlayId,
  onClose,
  dataAttribute,
  modalOwnerId,
  autofocus = true,
  restoreFocus = true,
  children,
}: {
  readonly ariaLabel: string;
  /** uiBusy overlay id; also the layer-history marker. */
  readonly overlayId: string;
  readonly onClose: () => void;
  /** Hook attribute on the sheet's root (tests, outside-click checks). */
  readonly dataAttribute?: string;
  /** The dialog this sheet belongs to: its Escape is the sheet's, not the dialog's. */
  readonly modalOwnerId?: string;
  readonly autofocus?: boolean;
  /** False where the opener reveals itself on focus-within and would stay pinned open. */
  readonly restoreFocus?: boolean;
  /** `role="menuitem"` buttons (separators allowed). */
  readonly children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayerHistory(overlayId, true, onClose);

  // Layout effect: focus lands before the first paint. Its cleanup runs while
  // the sheet is still in the DOM, so it can tell whether the sheet held focus.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    if (autofocus && sheet !== null) focusFrom([...sheet.querySelectorAll<HTMLElement>(ITEM_SELECTOR)], 0, 1);
    return () => {
      if (!restoreFocus || sheet === null || !sheet.contains(document.activeElement)) return;
      // After the commit: a dialog or route the action opened claims focus on
      // its own mount, and then keeps it.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body && active instanceof HTMLElement && active.isConnected) return;
        if (opener !== null && opener !== document.body && opener.isConnected) opener.focus();
      });
    };
    // Mount-only: the sheet's focus contract spans its whole life.
  }, []);

  useEffect(() => {
    const unregister = registerOverlay(overlayId);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [overlayId]);

  const rootProps = dataAttribute === undefined ? {} : { [dataAttribute]: true };
  return createPortal(
    <div
      {...rootProps}
      data-modal-escape={modalOwnerId}
      className="kiki-action-sheet-layer"
      // Above whatever dialog is up, like the desktop menu it replaces.
      style={{ zIndex: floatingSurfaceZIndex(null) }}
      // A portal still bubbles through the React tree: a scrim tap must not
      // reach the opener's own click handlers (a message row toggles its
      // actions on a tap).
      onClick={(event) => { event.stopPropagation(); }}
    >
      <div aria-hidden className="kiki-action-sheet-scrim" onClick={() => { closeRef.current(); }} />
      <div
        ref={sheetRef}
        role="menu"
        aria-label={ariaLabel}
        className="kiki-action-sheet"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
          const items = [...(sheetRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
          if (items.length === 0) return;
          event.preventDefault();
          const index = items.indexOf(document.activeElement as HTMLElement);
          if (event.key === 'Home') focusFrom(items, 0, 1);
          else if (event.key === 'End') focusFrom(items, items.length - 1, -1);
          else if (event.key === 'ArrowDown') focusFrom(items, index + 1, 1);
          else focusFrom(items, index - 1, -1);
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
