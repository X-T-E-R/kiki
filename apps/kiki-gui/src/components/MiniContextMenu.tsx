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
import { registerOverlay } from '../lib/uiBusy';

export type MiniMenuEntry =
  | {
      readonly key: string;
      readonly label: string;
      readonly danger?: boolean;
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
}: {
  readonly x: number;
  readonly y: number;
  readonly entries: readonly MiniMenuEntry[];
  readonly onClose: () => void;
  readonly ariaLabel: string;
  readonly overlayId: string;
  readonly dataAttribute: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  // Layout effect: the clamped position lands before the first paint.
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (node !== null) setSize({ width: node.offsetWidth, height: node.offsetHeight });
  }, []);
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
      if (event.key === 'Escape') closeRef.current();
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
      role="menu"
      aria-label={ariaLabel}
      className="anim-enter fixed z-50 w-52 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]"
      style={{ left: position.left, top: position.top }}
    >
      {entries.map((entry, index) =>
        'separator' in entry ? (
          <div key={`sep-${index}`} className="mx-1 my-1 border-t border-hairline" />
        ) : (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            data-menu-item={entry.key}
            className={`w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-paper ${
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
