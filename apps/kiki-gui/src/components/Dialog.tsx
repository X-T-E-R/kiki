/**
 * Dialog — the shared modal primitive built on `@base-ui/react/dialog`:
 * portal to `<body>`, focus management, Escape/backdrop dismissal, and
 * `role="dialog"`/`aria-modal`. While mounted it registers with the uiBusy
 * overlay set so global Escape-to-abort yields to it.
 *
 * Initial focus goes to the child's `[data-autofocus]` element when present —
 * if it is momentarily disabled (a query still in flight), no fallback runs and
 * the child re-focuses it once it enables. Without a marked element Base UI's
 * focus manager focuses the first tabbable control and restores focus on close.
 *
 * A portaled surface owned by this dialog (a picker or popover in `<body>`
 * carrying `data-modal-escape={overlayId}`) is allowed to hold focus while this
 * dialog is the top modal, and closes on Escape before the dialog does.
 *
 * On a coarse pointer a dismissible dialog also owns one history entry
 * (`lib/layerHistory`) so phone back closes it the way Escape does.
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';

import { useLayerHistory } from '../lib/layerHistory';
import { useCoarsePointer } from '../lib/layoutHooks';
import { isImeKeyEvent } from '../lib/shortcuts';
import {
  canRestoreModalFocus,
  hasOpenOwnedFloatingPortal,
  MODAL_BASE_Z_INDEX,
  MODAL_DEPTH_ATTRIBUTE,
  MODAL_ID_ATTRIBUTE,
  nextModalDepth,
  registerModal,
  registerOverlay,
} from '../lib/uiBusy';

export const DialogTitle = BaseDialog.Title;
export const DialogDescription = BaseDialog.Description;
export const DialogClose = BaseDialog.Close;

const ModalDepth = createContext<number | undefined>(undefined);
export function useStackedDialog(): boolean { return useContext(ModalDepth) !== undefined; }

/**
 * Names the dialog a portaled surface belongs to, so stacked modal focus and
 * Escape ownership can tell an owned floating surface from an unrelated one.
 */
export const MODAL_ESCAPE_ATTRIBUTE = 'data-modal-escape';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared panel chrome (everything but the width cap) plus the semantic width
 * scale. Callers pair `DIALOG_PANEL_BASE` with one of the sizes instead of
 * hand-rolling a width:
 *
 * - `sm`  520px — confirmations and single-field prompts (rename, undo).
 * - `md`  640px — standard forms with a handful of controls (profile editor).
 * - `lg`  880px — roomy single-column forms with large writing surfaces (new task).
 * - `xl`  1080px — sectioned detail views with side rails (task detail).
 * - `2xl` 1280px — full workspace surfaces (task board).
 */
export const DIALOG_PANEL_BASE =
  'anim-enter w-full rounded-2xl border border-hairline bg-panel p-6 shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)] outline-none';

export const DIALOG_PANEL_SIZES = {
  sm: 'max-w-[520px]',
  md: 'max-w-[640px]',
  lg: 'max-w-[880px]',
  xl: 'max-w-[1080px]',
  '2xl': 'max-w-[1280px]',
} as const;

const CENTERED_OVERLAY_CLASS =
  'fixed inset-0 z-50 flex items-center justify-center bg-shell/20 p-4 pt-[max(1rem,var(--kiki-safe-top-inset))]';

export const DIALOG_SHEET_OVERLAY_CLASS =
  `${CENTERED_OVERLAY_CLASS} pointer-coarse:h-[var(--kiki-visual-height,100dvh)] max-md:items-end max-md:p-0 max-md:pt-[var(--kiki-safe-top-inset)]`;

export const DIALOG_DEFAULT_PANEL_CLASS =
  `${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm} max-h-[calc(var(--kiki-visual-height,100dvh)-2rem-var(--kiki-safe-top-inset))] overflow-y-auto overscroll-y-contain max-md:max-w-none max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:pb-[calc(1.5rem+var(--kiki-safe-bottom-inset))]`;

function isOwnedEscapeTarget(target: EventTarget | null, overlayId: string): boolean {
  return target instanceof Element
    && target.closest(`[${MODAL_ESCAPE_ATTRIBUTE}]`)?.getAttribute(MODAL_ESCAPE_ATTRIBUTE) === overlayId;
}

function hasOwnedModalEscapePortal(overlayId: string): boolean {
  if (typeof document === 'undefined') return false;
  for (const node of document.querySelectorAll(`[${MODAL_ESCAPE_ATTRIBUTE}]`)) {
    if (node.getAttribute(MODAL_ESCAPE_ATTRIBUTE) === overlayId) return true;
  }
  return false;
}

export function Dialog({
  onClose, ariaLabel, overlayId, panelClassName, overlayClassName, children,
  stacked, role = 'dialog', overlayData, dismissible = true,
}: {
  onClose: () => void;
  /** Accessible name for the dialog (mirrors the visible title). */
  ariaLabel: string;
  /** uiBusy overlay registration id — unique per dialog kind. */
  overlayId: string;
  /** Replaces the default panel chrome — prefer composing DIALOG_PANEL_BASE + DIALOG_PANEL_SIZES. */
  panelClassName?: string;
  /** Replaces the default backdrop layout (slide-overs and lightboxes restyle alignment/tint). */
  overlayClassName?: string;
  /** Opt into top-modal keyboard/focus ownership; inherited by nested dialogs. */
  stacked?: boolean;
  role?: 'dialog' | 'alertdialog';
  overlayData?: Record<`data-${string}`, string>;
  /**
   * Whether a backdrop click or a bare Escape closes this dialog. Defaults to
   * true. Set false when closing is an explicit decision.
   */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const parentDepth = useContext(ModalDepth);
  // App-level confirmations have no React modal parent but must cover the live stack.
  const [rootDepth] = useState(nextModalDepth);
  const depth = (stacked ?? parentDepth !== undefined) ? (parentDepth === undefined ? rootDepth : parentDepth + 1) : undefined;
  const modalDepth = depth ?? 0;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  const ownership = useRef<ReturnType<typeof registerModal> | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  const [previousFocus] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const previousFocusRef = useRef<HTMLElement | null>(previousFocus);

  const coarse = useCoarsePointer();
  useLayerHistory(overlayId, coarse && dismissible, onClose);

  const handlePanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setPanelEl((current) => (current === node ? current : node));
  }, []);

  const isTopModal = useCallback((): boolean => {
    const panel = panelRef.current;
    if (panel === null) return false;
    return depth === undefined ? canRestoreModalFocus(panel) : ownership.current?.isTop() === true;
  }, [depth]);

  // Register overlay immediately so global Escape-to-abort yields even before portal mount.
  useLayoutEffect(() => registerOverlay(overlayId), [overlayId]);

  // Register modal ownership once Base UI's Dialog.Portal attaches the popup element.
  useLayoutEffect(() => {
    if (panelEl === null) return;
    const modal = registerModal(overlayId, modalDepth, panelEl);
    ownership.current = modal;
    return () => {
      modal.unregister();
      if (ownership.current === modal) ownership.current = null;
    };
  }, [overlayId, modalDepth, panelEl]);

  // Restore focus cleanly when unmounting (Base UI's finalFocus runs on open->false
  // transitions, while Kiki callers conditionally unmount `<Dialog />`).
  useEffect(() => () => {
    const previous = previousFocusRef.current;
    if (previous === null) return;
    if (depth === undefined) {
      if (previous.isConnected) previous.focus();
    } else {
      queueMicrotask(() => {
        if (previous.isConnected && canRestoreModalFocus(previous)) previous.focus();
      });
    }
  }, [depth]);

  // Keep Tab cycling inside the top modal while leaving portaled surfaces
  // owned by this dialog (`data-modal-escape`) untouched.
  useEffect(() => {
    if (panelEl === null) return;
    const ownsFocus = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      if (panelEl.contains(target)) return true;
      return isOwnedEscapeTarget(target, overlayId) && isTopModal();
    };
    const focusable = () => [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (element) => (element.offsetParent !== null || element.getClientRects().length > 0) && (depth === undefined || !element.closest('[inert]')),
    );
    const onTabKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTopModal()) return;
      if (depth !== undefined) event.stopPropagation();
      if (event.target instanceof Element && ownsFocus(event.target) && !panelEl.contains(event.target)) return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        if (depth !== undefined) panelEl.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelEl.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panelEl.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (depth !== undefined && ownership.current?.isTop() === true && !ownsFocus(event.target)) {
        (focusable()[0] ?? panelEl).focus();
      }
    };
    if (depth === undefined) {
      panelEl.addEventListener('keydown', onTabKeyDown);
    } else {
      window.addEventListener('keydown', onTabKeyDown, true);
      document.addEventListener('focusin', onFocusIn);
    }
    return () => {
      panelEl.removeEventListener('keydown', onTabKeyDown);
      window.removeEventListener('keydown', onTabKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [depth, overlayId, panelEl, isTopModal]);

  // Synchronous initial focus when the portal attaches: avoids a deferred rAF
  // pulling focus back out of a child picker opened immediately after mount.
  useEffect(() => {
    if (panelEl === null) return;
    if (!isTopModal()) return;
    const marked = panelEl.querySelector<HTMLElement>('[data-autofocus]:not([disabled])');
    const initial = marked ?? (panelEl.querySelector('[data-autofocus]') === null ? panelEl.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) : null);
    (initial ?? panelEl).focus();
  }, [panelEl]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenChange = useCallback((nextOpen: boolean, eventDetails: BaseDialog.Root.ChangeEventDetails) => {
    if (nextOpen) return;
    const cancelEscape = () => {
      eventDetails.cancel();
      eventDetails.allowPropagation();
    };
    if (!dismissibleRef.current) {
      cancelEscape();
      return;
    }
    const panel = panelRef.current;
    if (eventDetails.reason === 'escape-key') {
      const nativeEvent = eventDetails.event;
      if (nativeEvent?.defaultPrevented) {
        cancelEscape();
        return;
      }
      if (nativeEvent instanceof KeyboardEvent && isImeKeyEvent(nativeEvent)) {
        cancelEscape();
        return;
      }
      if (!isTopModal()) {
        cancelEscape();
        return;
      }
      // Inline non-stacked confirmation inside this panel owns Escape first.
      if (panel !== null && panel.querySelector('[aria-modal="true"]') !== null) {
        cancelEscape();
        return;
      }
      // Portaled surface owned by this dialog owns Escape first.
      if (
        isOwnedEscapeTarget(nativeEvent?.target ?? null, overlayId) ||
        hasOwnedModalEscapePortal(overlayId) ||
        hasOpenOwnedFloatingPortal(overlayId)
      ) {
        cancelEscape();
        return;
      }
      closeRef.current();
      return;
    }
    if (eventDetails.reason === 'outside-press' || eventDetails.reason === 'focus-out') {
      eventDetails.cancel();
      return;
    }
    closeRef.current();
  }, [isTopModal, overlayId]);

  return (
    <ModalDepth.Provider value={depth}>
      <BaseDialog.Root
        open
        modal={false}
        disablePointerDismissal={!dismissible}
        onOpenChange={handleOpenChange}
      >
        <BaseDialog.Portal>
          <BaseDialog.Backdrop className="sr-only" />
          <BaseDialog.Viewport
            {...overlayData}
            className={overlayClassName ?? (panelClassName === undefined ? DIALOG_SHEET_OVERLAY_CLASS : CENTERED_OVERLAY_CLASS)}
            style={depth === undefined ? undefined : { zIndex: MODAL_BASE_Z_INDEX + depth }}
            onPointerDown={(event) => {
              if (dismissibleRef.current && event.target === event.currentTarget && isTopModal()) {
                closeRef.current();
              }
            }}
          >
            <BaseDialog.Popup
              ref={handlePanelRef}
              role={role}
              aria-modal="true"
              aria-label={ariaLabel}
              initialFocus={false}
              finalFocus={false}
              {...{
                [MODAL_ID_ATTRIBUTE]: overlayId,
                [MODAL_DEPTH_ATTRIBUTE]: modalDepth,
              }}
              className={panelClassName ?? DIALOG_DEFAULT_PANEL_CLASS}
            >
              {children}
            </BaseDialog.Popup>
          </BaseDialog.Viewport>
        </BaseDialog.Portal>
      </BaseDialog.Root>
    </ModalDepth.Provider>
  );
}
