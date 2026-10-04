/**
 * Dialog — the shared modal primitive: ink backdrop, Escape to close, a focus
 * trap, and `role="dialog"`/`aria-modal`. Rendered through a body portal so
 * fixed positioning is never captured by a transformed ancestor (the mobile
 * sidebar drawer translates itself). While mounted it registers with the
 * uiBusy overlay set, so the global Escape-to-abort handler yields to it.
 *
 * Initial focus goes to the child's `[data-autofocus]` element when present —
 * if it is momentarily disabled (a query still in flight), no fallback runs and
 * the child re-focuses it once it enables. Without a marked element the first
 * focusable control takes focus; focus returns to the previously focused
 * element on close.
 *
 * The trap leaves one thing alone: a portaled surface that this dialog owns —
 * a picker's panel in `<body>`, marked with `data-modal-escape` set to that
 * dialog's `overlayId`. Focus belongs to the surface that owns it, so the trap
 * would otherwise rip it out from under the user mid-typing. The id is what
 * keeps that exemption honest: a panel belonging to a dialog underneath, or to
 * no dialog at all, is not accepted while this one is on top.
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { canRestoreModalFocus, nextModalDepth, registerModal, registerOverlay } from '../lib/uiBusy';

const ModalDepth = createContext<number | undefined>(undefined);
export function useStackedDialog(): boolean { return useContext(ModalDepth) !== undefined; }

/**
 * Names the dialog a portaled surface belongs to, so the dialog's focus trap
 * can tell its own surface from another one's. The value must be the owning
 * dialog's `overlayId`: the trap accepts a portaled surface only when that id
 * is still the top modal, which is what keeps a picker under one dialog from
 * holding focus while another dialog is on top of it.
 */
export const MODAL_ESCAPE_ATTRIBUTE = 'data-modal-escape';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared panel chrome (everything but the width cap) plus the semantic width
 * scale. Callers pair `DIALOG_PANEL_BASE` with one of the sizes instead of
 * hand-rolling a width; shells that own their chrome (fixed-height flex
 * layouts, alert dialogs) still compose the tier for the cap alone:
 *
 * - `sm`  520px — confirmations and single-field prompts (rename, undo).
 * - `md`  640px — standard forms with a handful of controls (profile editor).
 * - `lg`  880px — roomy single-column forms with large writing surfaces (new task).
 * - `xl`  1080px — sectioned detail views with side rails (task detail).
 * - `2xl` 1280px — full workspace surfaces (task board).
 *
 * Panels stay fluid below the cap (`w-full`), so narrow viewports just get a
 * full-bleed panel inside the overlay padding.
 */
export const DIALOG_PANEL_BASE =
  'anim-enter w-full rounded-2xl border border-hairline bg-panel p-6 shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)]';

export const DIALOG_PANEL_SIZES = {
  sm: 'max-w-[520px]',
  md: 'max-w-[640px]',
  lg: 'max-w-[880px]',
  xl: 'max-w-[1080px]',
  '2xl': 'max-w-[1280px]',
} as const;

const DEFAULT_PANEL_CLASS = `${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm}`;

export function Dialog({
  onClose, ariaLabel, overlayId, panelClassName, overlayClassName, children,
  stacked, role = 'dialog', overlayData,
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
  children: ReactNode;
}) {
  const parentDepth = useContext(ModalDepth);
  // App-level confirmations have no React modal parent but must cover the live stack.
  const [rootDepth] = useState(nextModalDepth);
  const depth = (stacked ?? parentDepth !== undefined) ? (parentDepth === undefined ? rootDepth : parentDepth + 1) : undefined;
  const panelRef = useRef<HTMLDivElement>(null);
  const ownership = useRef<ReturnType<typeof registerModal> | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Stack registration is stable across form edits and busy-state changes.
  useEffect(() => {
    const unregister = registerOverlay(overlayId);
    const modal = depth !== undefined && panelRef.current ? registerModal(overlayId, depth, panelRef.current) : null;
    ownership.current = modal;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (modal ? !modal.isTop() : !panelRef.current || !canRestoreModalFocus(panelRef.current))) return;
      // A confirmation rendered inline inside this panel (not stacked) owns
      // Escape while it is open: it closes, this panel stays.
      if ((panelRef.current?.querySelector('[aria-modal="true"]') ?? null) !== null) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      modal?.unregister();
      ownership.current = null;
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [overlayId, depth, depth === undefined ? onClose : undefined]);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const isTop = () => depth === undefined ? canRestoreModalFocus(panel) : ownership.current?.isTop() === true;
    /**
     * Focus the dialog keeps: its own subtree, plus a portaled surface that
     * this dialog owns — identified by its `overlayId` and only while this
     * dialog is still the top modal. A bare marker would let a picker under a
     * lower dialog, or one opened on the page behind this one, keep focus
     * while an unrelated dialog sits on top.
     */
    const ownsFocus = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      if (panel.contains(target)) return true;
      const owner = target.closest(`[${MODAL_ESCAPE_ATTRIBUTE}]`)?.getAttribute(MODAL_ESCAPE_ATTRIBUTE);
      return owner === overlayId && isTop();
    };
    const focusable = () => [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (element) => element.offsetParent !== null && (depth === undefined || !element.closest('[inert]')),
    );
    const marked = panel.querySelector<HTMLElement>('[data-autofocus]:not([disabled])');
    const initial = marked ?? (panel.querySelector('[data-autofocus]') === null ? panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) : null);
    if (isTop()) (initial ?? panel).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTop()) return;
      if (depth !== undefined) event.stopPropagation();
      // Tab inside a portaled surface belongs to that surface, not the trap.
      if (event.target instanceof Element && ownsFocus(event.target) && !panel.contains(event.target)) return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        if (depth !== undefined) panel.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (isTop() && !ownsFocus(event.target)) (focusable()[0] ?? panel).focus();
    };
    if (depth === undefined) panel.addEventListener('keydown', onKeyDown);
    else {
      window.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('focusin', onFocus);
    }
    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocus);
      if (depth === undefined) previous?.focus();
      else queueMicrotask(() => { if (previous && canRestoreModalFocus(previous)) previous.focus(); });
    };
    // overlayId is read by ownsFocus, so the trap has to be rebuilt with it.
  }, [depth, overlayId]);

  return createPortal(
    <ModalDepth.Provider value={depth}>
      <div
        {...overlayData}
        className={overlayClassName ?? 'fixed inset-0 z-50 flex items-center justify-center bg-shell/20 p-4'}
        style={depth === undefined ? undefined : { zIndex: 50 + depth }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget && (depth === undefined
            ? panelRef.current && canRestoreModalFocus(panelRef.current)
            : ownership.current?.isTop())) onClose();
        }}
      >
        <div ref={panelRef} role={role} aria-modal="true" aria-label={ariaLabel} tabIndex={-1} className={panelClassName ?? DEFAULT_PANEL_CLASS}>
          {children}
        </div>
      </div>
    </ModalDepth.Provider>,
    document.body,
  );
}
