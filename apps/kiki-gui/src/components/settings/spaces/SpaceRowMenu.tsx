import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { clampOverlayPosition } from '../../../lib/overlayPosition';
import { registerOverlay } from '../../../lib/uiBusy';

export interface SpaceMenuItem {
  readonly key: string;
  readonly label: string;
  readonly danger?: boolean;
  /** Why the item cannot run now; shown under it, and the item stays inert. */
  readonly blockedReason?: string;
  readonly separatorBefore?: boolean;
  readonly run: () => void;
}

/**
 * The ⋯ menu on a space row. Like MiniContextMenu, but an item can be
 * disabled with its reason written under it (delete while a space runs),
 * and focus moves into the menu so it is keyboard-operable.
 */
export function SpaceRowMenu({ anchor, items, ariaLabel, onClose }: {
  anchor: DOMRect;
  items: readonly SpaceMenuItem[];
  ariaLabel: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 240, height: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const node = ref.current;
    if (node !== null) setSize({ width: node.offsetWidth, height: node.offsetHeight });
    node?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, []);

  useEffect(() => {
    const unregister = registerOverlay('space-row-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
      if (buttons.length === 0) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  const position = clampOverlayPosition(anchor.right - size.width, anchor.bottom + 4, size, { width: window.innerWidth, height: window.innerHeight });
  return createPortal(
    <div ref={ref} role="menu" aria-label={ariaLabel} data-space-row-menu
      className="anim-enter fixed z-50 w-60 rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]"
      style={{ left: position.left, top: position.top }}>
      {items.map((item) => (
        <div key={item.key}>
          {item.separatorBefore === true ? <div className="mx-1 my-1 border-t border-hairline" /> : null}
          <button type="button" role="menuitem" data-space-menu-item={item.key} disabled={item.blockedReason !== undefined}
            aria-describedby={item.blockedReason !== undefined ? `space-menu-${item.key}-why` : undefined}
            onClick={() => { onClose(); item.run(); }}
            className={`flex min-h-9 w-full flex-col justify-center rounded-md px-3 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:hover:bg-transparent ${
              item.blockedReason !== undefined ? 'text-ink-faint' : item.danger === true ? 'text-danger' : 'text-ink'
            }`}>
            <span>{item.label}</span>
            {item.blockedReason !== undefined ? (
              <span id={`space-menu-${item.key}-why`} className="mt-0.5 text-[11.5px] leading-4 text-ink-faint">{item.blockedReason}</span>
            ) : null}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
