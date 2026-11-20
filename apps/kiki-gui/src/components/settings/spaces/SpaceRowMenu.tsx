import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Popover } from '@base-ui/react/popover';

import {
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
} from '../../../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from '../../Dialog';
import { POPOVER_SURFACE_CLASS } from '../../SearchableSelect';

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
export function SpaceRowMenu({ anchor, anchorElement, items, ariaLabel, onClose }: {
  anchor: DOMRect;
  /**
   * The row the menu was opened from. The menu renders in `<body>`, so this is
   * how it finds out whether it is inside a dialog — without it the menu is
   * painted at the page-level z-index and a dialog opened over Settings buries
   * it. Null when the caller no longer has the element.
   */
  anchorElement?: HTMLElement | null;
  items: readonly SpaceMenuItem[];
  ariaLabel: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const virtualAnchor = useMemo(() => ({ getBoundingClientRect: () => anchor }), [anchor]);

  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
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

  return (
    <Popover.Root open modal={false} onOpenChange={(next) => { if (!next) closeRef.current(); }}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={virtualAnchor}
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          positionMethod="fixed"
          style={{ zIndex: floatingSurfaceZIndex(anchorElement ?? null) }}
        >
          <Popover.Popup
            ref={ref}
            role="menu"
            aria-label={ariaLabel}
            data-space-row-menu
            initialFocus={false}
            finalFocus={false}
            {...{
              [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(anchorElement ?? null),
              [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(anchorElement ?? null),
            }}
            className={`anim-enter w-60 p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
          >
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
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
