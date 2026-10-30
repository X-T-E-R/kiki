/**
 * MiniContextMenu — the small fixed-position context menu shared by the
 * link/file-path surfaces (markdown anchors, file chips, preview tabs). No
 * Radix: outside-click and Escape close, and the panel size is measured after
 * mount so the position clamps inside the viewport on both axes (right-click
 * near an edge). Items are data — each surface composes its own list, so
 * desktop-only entries simply stay out of the browser build's array.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { clampOverlayPosition } from '../lib/overlayPosition';
import { runToastAction } from '../lib/toasts';
import { floatingSurfaceZIndex, registerOverlay } from '../lib/uiBusy';

export type MiniMenuEntry =
  | {
      readonly key: string;
      readonly label: string;
      readonly danger?: boolean;
      /** Rendered unavailable; activation never fires. */
      readonly disabled?: boolean;
      readonly run: () => void | Promise<void>;
    }
  | { readonly separator: true };

export function MiniContextMenu({
  x,
  y,
  entries,
  onClose,
  ariaLabel,
  overlayId,
  dataAttribute,
  itemDataAttribute = 'data-menu-item',
  modalOwnerId,
  autofocus = true,
}: {
  readonly x: number;
  readonly y: number;
  readonly entries: readonly MiniMenuEntry[];
  readonly onClose: () => void;
  readonly ariaLabel: string;
  readonly overlayId: string;
  readonly dataAttribute: string;
  /** Per-item hook attribute; a surface with its own legacy key contract
   * (the composer's `data-menu-action`) passes it instead of forking the menu. */
  readonly itemDataAttribute?: string;
  readonly modalOwnerId?: string;
  /** Focus the first item on open. Off where the opener owns the caret: the
   * composer's clipboard menu pins a textarea selection that a focus move
   * would drop, and its actions re-pin before they run. */
  readonly autofocus?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Whatever held focus when the menu opened — the link/chip/button for a
  // keyboard trigger, or just where the caret was for a right-click. Escape
  // and item activation hand focus back to it; an outside pointerdown never
  // does (the pointer's own target takes focus, and stealing it back reads as
  // a glitch).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  // Layout effect: the clamped position lands before the first paint. Focus
  // moves to the first item the same way (SpaceRowMenu's pattern), so the
  // menu is operable the moment it appears.
  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = menuRef.current;
    if (node !== null) setSize({ width: node.offsetWidth, height: node.offsetHeight });
    if (autofocus) node?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, []);

  const restoreTriggerFocus = () => {
    const trigger = returnFocusRef.current;
    if (trigger === null || trigger === document.body || !trigger.isConnected) return;
    trigger.focus();
  };
  const position = clampOverlayPosition(x, y, size ?? { width: 200, height: 0 }, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  // Handlers read the latest onClose through a ref: callers pass inline
  // closures, and re-subscribing on every parent render opens a detach/attach
  // gap that can swallow a trusted Escape.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const unregister = registerOverlay(overlayId);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // Hand focus back only when the menu still owns it; focus that the user
      // moved elsewhere (a Tab out of this transient layer) is left alone.
      const owned = menuRef.current?.contains(document.activeElement) === true;
      closeRef.current();
      if (owned) restoreTriggerFocus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.closest(`[${dataAttribute}]`) === null
      ) {
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
    // dataAttribute/overlayId are per-surface constants; onClose rides the ref.
  }, [overlayId, dataAttribute]);

  const containerProps = { [dataAttribute]: true } as Record<string, boolean>;
  // Portal: anchors and file chips sit inside paragraphs, and a fixed panel
  // is invalid <p> content; escaping to <body> also dodges overflow clipping.
  return createPortal(
    <div
      ref={menuRef}
      {...containerProps}
      data-modal-escape={modalOwnerId}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        // Menu-keyboard semantics on the items only; Enter/Space stay the
        // buttons' own activation and Tab keeps its native transient behavior.
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
        if (items.length === 0) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
        items[next]?.focus();
      }}
      onClick={(event) => {
        // Item activation hands focus back to the opener — but only after
        // the click's commit has landed: an in-place toggle keeps this menu
        // mounted and keeps its focus, and a dialog/route the action opened
        // claims focus on its own mount. Checking post-commit restores
        // exactly when neither happened.
        if (!(event.target instanceof HTMLElement) || event.target.closest('[role="menuitem"]') === null) return;
        const menuNode = menuRef.current;
        queueMicrotask(() => {
          if (menuNode === null || menuNode.isConnected) return;
          const active = document.activeElement;
          if (active !== null && active !== document.body && active instanceof HTMLElement && active.isConnected) return;
          restoreTriggerFocus();
        });
      }}
      className="anim-enter fixed w-52 rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]"
      // Above whatever dialog is up: a context menu opened from inside one is
      // drawn under that dialog's own panel otherwise, and reads as a menu that
      // opened and then vanished. The shared helper resolves the owning modal's
      // own depth, and lands on the page-level layer outside one.
      style={{ left: position.left, top: position.top, zIndex: floatingSurfaceZIndex(null) }}
    >
      {entries.map((entry, index) =>
        'separator' in entry ? (
          <div key={`sep-${index}`} className="mx-1 my-1 border-t border-hairline" />
        ) : (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            {...{ [itemDataAttribute]: entry.key }}
            disabled={entry.disabled}
            className={`w-full rounded-md px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-paper focus-visible:bg-paper disabled:pointer-events-none disabled:opacity-45 ${
              entry.danger === true ? 'text-ink hover:text-danger' : 'text-ink'
            }`}
            onClick={() => {
              onClose();
              runToastAction(entry.label, entry.run);
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
