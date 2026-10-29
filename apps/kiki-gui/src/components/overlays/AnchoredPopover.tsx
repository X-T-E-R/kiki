/**
 * AnchoredPopover — the small-edit tier of the surface ladder (README.md):
 * one to three fields or a short choice, attached to the control that opened
 * it. No scrim and no focus trap: the page behind stays readable and a click
 * anywhere else, Escape, or tabbing away closes it.
 *
 * Usage (the trigger is any button; `usePopover` wires its ARIA):
 *
 *   const pop = usePopover();
 *   <button type="button" {...pop.triggerProps}>按智能体</button>
 *   <AnchoredPopover {...pop.popoverProps} label="按智能体">…fields…</AnchoredPopover>
 *
 * Mechanics, so a worker never has to re-derive them:
 * - Portaled to <body> and placed with `placeAnchored` (flip + shift), so a
 *   scrolling column or an `overflow-hidden` card can never clip it. It
 *   follows its trigger on scroll and resize.
 * - "Inside" is the React tree, not the DOM: a picker opened from inside the
 *   popover portals its own panel elsewhere in <body>, and clicking or
 *   focusing that panel still counts as inside.
 * - Inside a Dialog or SidePanel it names that dialog in `data-modal-escape`,
 *   so the dialog's focus trap lets it hold focus and Escape closes the
 *   popover first, the panel second.
 * - Focus moves to `[data-autofocus]` (or the first control) on open and back
 *   to the trigger on close when it was inside the popover.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { floatingSurfaceZIndex, owningModalId, registerOverlay } from '../../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from '../Dialog';
import { POPOVER_SURFACE_CLASS } from '../SearchableSelect';
import { placeAnchored } from './anchoredPosition';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface AnchoredPopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: RefObject<HTMLElement | null>;
  /** DOM id; the trigger's `aria-controls` points here. */
  readonly id: string;
  /** Accessible name — usually the trigger's visible label. */
  readonly label: string;
  readonly side?: 'below' | 'above';
  readonly align?: 'start' | 'end';
  /** Width class for the surface; defaults to a 20rem form popover. */
  readonly widthClassName?: string;
  readonly className?: string;
  readonly data?: Record<`data-${string}`, string>;
  /** Extra key handling: return true when the event was consumed. */
  readonly onSurfaceKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => boolean;
  /** Focus this selector on open instead of `[data-autofocus]` / the first control. */
  readonly initialFocusSelector?: string;
  /** Surface role. 'menu' switches focus restore to whatever opened the menu
   * (menu key semantics) instead of the anchor button. */
  readonly role?: 'dialog' | 'menu';
  readonly children: ReactNode;
}

export function AnchoredPopover({
  open, onClose, anchorRef, id, label, side = 'below', align = 'start',
  widthClassName = 'w-[20rem]', className = '', data, onSurfaceKeyDown, initialFocusSelector, role = 'dialog', children,
}: AnchoredPopoverProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Set by React-tree capture handlers before the document listeners run.
  const pointerInside = useRef(false);
  const focusInside = useRef(false);
  // Read during render, not after: the owning dialog's focus trap checks this
  // attribute the moment focus moves in, and a late value lets it pull focus back.
  const owner = open ? owningModalId(anchorRef.current) : undefined;
  const zIndex = open ? floatingSurfaceZIndex(anchorRef.current) : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const surface = surfaceRef.current;
      if (anchor === null || surface === null) return;
      const placed = placeAnchored(anchor.getBoundingClientRect(),
        { width: surface.offsetWidth, height: surface.scrollHeight },
        { width: window.innerWidth, height: window.innerHeight }, { side, align });
      setStyle({ left: placed.left, top: placed.top, maxHeight: placed.maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (surfaceRef.current !== null) observer?.observe(surfaceRef.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      observer?.disconnect();
      setStyle({ visibility: 'hidden', left: 0, top: 0 });
    };
  }, [open, anchorRef, side, align]);

  const close = useCallback((restoreFocus: boolean) => {
    closeRef.current();
    if (restoreFocus) anchorRef.current?.focus();
  }, [anchorRef]);
  // A menu restores focus to whatever opened it (captured on open); a form
  // popover restores to its anchor button.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreTriggerFocus = useCallback(() => {
    const trigger = returnFocusRef.current;
    if (trigger === null || trigger === document.body || !trigger.isConnected) return;
    trigger.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay(`popover:${id}`);
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = surfaceRef.current;
    const first = (initialFocusSelector === undefined ? null : surface?.querySelector<HTMLElement>(initialFocusSelector))
      ?? surface?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])')
      ?? surface?.querySelector<HTMLElement>(FOCUSABLE) ?? surface;
    first?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const inside = pointerInside.current || anchorRef.current?.contains(event.target as Node) === true;
      pointerInside.current = false;
      if (!inside) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      unregister();
      document.removeEventListener('pointerdown', onPointerDown);
      const active = document.activeElement;
      if (active === null || active === document.body || surface?.contains(active) === true) {
        if (role === 'menu') restoreTriggerFocus();
        else anchorRef.current?.focus();
      }
    };
  }, [open, id, anchorRef, close, initialFocusSelector, role, restoreTriggerFocus]);

  if (!open) return null;
  return createPortal(
    <div
      ref={surfaceRef}
      id={id}
      role={role}
      aria-label={label}
      tabIndex={-1}
      data-anchored-popover=""
      {...data}
      {...(owner === undefined ? {} : { [MODAL_ESCAPE_ATTRIBUTE]: owner })}
      onPointerDownCapture={() => { pointerInside.current = true; }}
      onFocusCapture={() => { focusInside.current = true; }}
      onBlurCapture={() => {
        focusInside.current = false;
        setTimeout(() => {
          if (focusInside.current || !open) return;
          const active = document.activeElement;
          if (active !== null && active !== document.body && anchorRef.current?.contains(active) !== true) close(false);
        }, 0);
      }}
      onKeyDown={(event) => {
        if (onSurfaceKeyDown?.(event) === true) return;
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        // A menu-role surface restores focus itself (roving menu keys): its
        // opener is the recorded focus, not necessarily the anchor button.
        if (role !== 'menu') close(true);
        else { closeRef.current(); restoreTriggerFocus(); }
      }}
      className={`anim-enter fixed overflow-y-auto overscroll-contain p-3 outline-none ${POPOVER_SURFACE_CLASS} ${widthClassName} max-w-[calc(100vw-16px)] ${className}`}
      style={{ ...style, zIndex }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** State + ARIA wiring for one popover and its trigger. */
export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<T>(null);
  const id = `popover-${useId().replace(/:/g, '')}`;
  return {
    open,
    setOpen,
    anchorRef,
    triggerProps: {
      ref: anchorRef,
      'aria-haspopup': 'dialog' as const,
      'aria-expanded': open,
      'aria-controls': open ? id : undefined,
      onClick: () => { setOpen((value) => !value); },
    },
    popoverProps: { id, open, anchorRef, onClose: () => { setOpen(false); } },
  };
}
