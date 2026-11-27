import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';

import {
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  MODAL_ESCAPE_ATTRIBUTE,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
  topModalId,
} from '../lib/uiBusy';
import { unzoomedPoint } from '../lib/uiZoom';
import { menuItems, type MiniContextMenuProps } from './MiniContextMenu';
import { POPOVER_SURFACE_CLASS } from './popoverSurfaceClass';

export function MiniContextPointerMenu({
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
}: MiniContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusedForOpenRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [inferredModalOwner] = useState(() =>
    modalOwnerId ?? owningModalId(typeof document !== 'undefined' ? document.activeElement : null) ?? topModalId(),
  );
  const effectiveModalOwner = modalOwnerId ?? inferredModalOwner;
  const point = unzoomedPoint(x, y);
  const virtualAnchor = useMemo(() => ({
    getBoundingClientRect: () => ({
      x: point.x,
      y: point.y,
      top: point.y,
      left: point.x,
      bottom: point.y,
      right: point.x,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }),
  }), [point.x, point.y]);

  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const restoreTriggerFocus = () => {
    const trigger = returnFocusRef.current;
    if (trigger === null || trigger === document.body || !trigger.isConnected) return;
    trigger.focus();
  };

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const unregister = registerOverlay(overlayId);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
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
  }, [overlayId, dataAttribute]);

  const containerProps = { [dataAttribute]: true } as Record<string, boolean>;
  const zIndex = floatingSurfaceZIndex(null);
  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) return;
        if (eventDetails.reason === 'escape-key') {
          const owned = menuRef.current?.contains(document.activeElement) === true;
          closeRef.current();
          if (owned) restoreTriggerFocus();
          return;
        }
        eventDetails.cancel();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={virtualAnchor}
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          positionMethod="fixed"
          style={{ zIndex }}
        >
          <Popover.Popup
            ref={(node) => {
              menuRef.current = node;
              if (autofocus && node !== null && !focusedForOpenRef.current && !node.contains(document.activeElement)) {
                focusedForOpenRef.current = true;
                node.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
              }
            }}
            initialFocus={autofocus}
            finalFocus={false}
            style={{ zIndex }}
            {...containerProps}
            data-modal-escape={effectiveModalOwner}
            role="menu"
            aria-label={ariaLabel}
            onKeyDown={(event) => {
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
              if (!(event.target instanceof HTMLElement) || event.target.closest('[role="menuitem"]') === null) return;
              const menuNode = menuRef.current;
              queueMicrotask(() => {
                if (menuNode === null || menuNode.isConnected) return;
                const active = document.activeElement;
                if (active !== null && active !== document.body && active instanceof HTMLElement && active.isConnected) return;
                restoreTriggerFocus();
              });
            }}
            className={`anim-enter max-h-[min(var(--available-height,calc(100dvh-16px)),calc(100dvh-16px))] w-52 overflow-y-auto overscroll-contain p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
          >
            {menuItems(entries, onClose, itemDataAttribute)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AnchoredFloatingPopover({
  anchorRef,
  side = 'top',
  align = 'end',
  sideOffset = 6,
  ownerId,
  popupRef,
  popupId,
  role,
  ariaLabel,
  dataAttrs,
  className,
  onEscapeClose,
  onOpenChange,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly side?: 'top' | 'bottom';
  readonly align?: 'start' | 'end';
  readonly sideOffset?: number;
  readonly ownerId?: string;
  readonly popupRef?: ((node: HTMLDivElement | null) => void) | RefObject<HTMLDivElement | null>;
  readonly popupId?: string;
  readonly role?: string;
  readonly ariaLabel?: string;
  readonly dataAttrs?: Readonly<Record<string, string | undefined>>;
  readonly className: string;
  readonly onEscapeClose?: () => void;
  readonly onOpenChange?: (nextOpen: boolean, eventDetails: { reason?: string; event?: Event; cancel: () => void }) => void;
  readonly onMouseEnter?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onMouseLeave?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}) {
  const anchorEl = anchorRef.current;
  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(nextOpen, eventDetails) => {
        if (
          !nextOpen &&
          eventDetails.reason === 'outside-press' &&
          anchorEl !== null &&
          eventDetails.event?.target instanceof Node &&
          anchorEl.contains(eventDetails.event.target)
        ) {
          eventDetails.cancel();
          return;
        }
        if (onOpenChange !== undefined) {
          onOpenChange(nextOpen, eventDetails);
          return;
        }
        if (nextOpen) return;
        if (eventDetails.reason === 'escape-key' && onEscapeClose !== undefined) {
          onEscapeClose();
          return;
        }
        eventDetails.cancel();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchorRef}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          positionMethod="fixed"
          style={{ zIndex: floatingSurfaceZIndex(anchorEl) }}
          className="outline-none"
        >
          <Popover.Popup
            ref={popupRef}
            id={popupId}
            role={role}
            aria-label={ariaLabel}
            initialFocus={false}
            finalFocus={false}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            {...dataAttrs}
            {...(ownerId !== undefined
              ? {
                  [FLOATING_OWNER_ATTRIBUTE]: ownerId,
                  [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(anchorEl, ownerId),
                  [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(anchorEl),
                }
              : {})}
            className={className}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
