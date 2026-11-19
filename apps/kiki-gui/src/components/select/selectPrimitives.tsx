/**
 * Shared floating-select primitives consumed by `SearchableSelect`,
 * `ProfileSelect`, and `ExecutionSelect`.
 *
 * Centralizes Base UI Popover dismissal policy (respecting IME composition and
 * nested floating portals), keyboard row walking (`ArrowDown` / `ArrowUp` /
 * `Home` / `End` / `Enter` on `[data-menu-row]`), and shared checkmark / scroll
 * container classes so each picker stops hand-rolling its own state machine.
 */

import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { Popover } from '@base-ui/react/popover';

import { isImeKeyEvent } from '../../lib/shortcuts';
import { containsOrOwnsFloatingTarget, hasOpenOwnedFloatingPortal } from '../../lib/uiBusy';
import { Icon } from '../icons';

/** Shared scrollable option-list classes: never collapses in flex column, smooth wheel/touch scroll. */
export const SELECT_SCROLL_LIST_CLASS =
  'min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain';

/** Shared checkmark indicator used across ProfileSelect and ExecutionSelect rows. */
export function SelectRowCheck({ on }: { readonly on: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}
    >
      <Icon name="check" size={12} />
    </span>
  );
}

/**
 * Shared Base UI `Popover.Root` `onOpenChange` guard for floating select panels.
 * Handles `escape-key` and `outside-press` cleanly while respecting:
 * - active IME composition (`isImeKeyEvent`),
 * - nested floating portals owned by this surface (`hasOpenOwnedFloatingPortal`),
 * - presses landing inside the trigger root or an owned nested portal.
 */
export function handleFloatingSelectOpenChange(
  nextOpen: boolean,
  eventDetails: Popover.Root.ChangeEventDetails,
  options: {
    readonly surfaceOwnerId: string;
    readonly triggerEl: HTMLElement | null;
    readonly panelEl: HTMLElement | null;
    readonly rootEl?: HTMLElement | null;
    readonly onDismiss: (refocusTrigger: boolean) => void;
  },
): void {
  if (nextOpen) return;
  const { surfaceOwnerId, triggerEl, panelEl, rootEl, onDismiss } = options;
  if (eventDetails.reason === 'escape-key') {
    const native = eventDetails.event;
    if (
      (native instanceof KeyboardEvent && isImeKeyEvent(native)) ||
      hasOpenOwnedFloatingPortal(surfaceOwnerId)
    ) {
      eventDetails.cancel();
      return;
    }
    onDismiss(true);
    return;
  }
  if (eventDetails.reason === 'outside-press') {
    const target = eventDetails.event?.target ?? null;
    if (
      eventDetails.event?.type === 'click' ||
      (target instanceof Node && (triggerEl?.contains(target) === true || rootEl?.contains(target) === true)) ||
      containsOrOwnsFloatingTarget(panelEl, target, surfaceOwnerId) ||
      hasOpenOwnedFloatingPortal(surfaceOwnerId)
    ) {
      eventDetails.cancel();
      return;
    }
    onDismiss(false);
    return;
  }
  if (eventDetails.reason === 'focus-out') {
    eventDetails.cancel();
    return;
  }
  onDismiss(false);
}

/**
 * Shared outside-pointerdown dismissal for floating select panels so dismissal
 * happens immediately on pointerdown (matching native desktop menus and
 * avoiding Base UI's `outsidePressEvent: 'intentional'` click delay).
 */
export function useFloatingOutsidePointerDown(
  open: boolean,
  options: {
    readonly enabled?: boolean;
    readonly surfaceOwnerId: string;
    readonly rootRef?: RefObject<HTMLElement | null>;
    readonly triggerRef?: RefObject<HTMLElement | null>;
    readonly panelRef: RefObject<HTMLElement | null>;
    readonly onDismiss: () => void;
  },
): void {
  const { enabled = true, surfaceOwnerId, rootRef, triggerRef, panelRef, onDismiss } = options;
  useEffect(() => {
    if (!open || !enabled) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (rootRef?.current?.contains(target) === true) return;
        if (triggerRef?.current?.contains(target) === true) return;
      }
      if (containsOrOwnsFloatingTarget(panelRef.current, target, surfaceOwnerId)) return;
      if (hasOpenOwnedFloatingPortal(surfaceOwnerId)) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, enabled, surfaceOwnerId, rootRef, triggerRef, panelRef, onDismiss]);
}

/**
 * Shared keyboard handler for filter-input + `[data-menu-row]` floating lists
 * (used by `ProfileSelect` and similar composite menus).
 */
export function handleCompositeMenuKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  panel: HTMLElement | null,
): boolean {
  if (isImeKeyEvent(event) || panel === null) return false;
  const rows = [...panel.querySelectorAll<HTMLElement>('[data-menu-row]:not(:disabled)')];
  if (rows.length === 0) return false;
  const isInput = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (isInput) {
      (event.key === 'ArrowDown' ? rows[0] : rows.at(-1))?.focus();
      return true;
    }
    const index = rows.findIndex((row) => row === document.activeElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    rows[(index + delta + rows.length) % rows.length]?.focus();
    return true;
  }
  if (event.key === 'Enter' && isInput) {
    event.preventDefault();
    rows[0]?.click();
    return true;
  }
  return false;
}
