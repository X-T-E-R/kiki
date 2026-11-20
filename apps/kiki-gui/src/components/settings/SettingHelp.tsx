/**
 * On-demand help for a settings label.
 *
 * A settings page has two kinds of writing, and putting both on the first
 * screen is what makes these pages read as noise:
 *
 *  - what the page is *for* and what a value *does now* — always shown;
 *  - the fine print behind a number: what `0` means, what an empty field
 *    resolves to, what the engine default is.
 *
 * The second kind is real information, and it stays one hover, one tap or one
 * Tab away. It is not a paragraph under the control.
 *
 * A caller that passes children is opting this specific text out of the first
 * screen. Nothing converts automatically: `SettingField.help` and
 * `SettingsGroup.help` keep rendering a visible `Hint` on every other page.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';

import { useI18n } from '../../i18n';
import {
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
} from '../../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from '../Dialog';
import { Icon } from '../icons';
import { POPOVER_SURFACE_CLASS } from '../SearchableSelect';

const TRIGGER =
  'inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[1px] focus-visible:outline-selected-ink pointer-coarse:size-7';
const BUBBLE =
  `w-72 max-w-[calc(100vw-1.5rem)] px-2.5 py-2 text-[12px] leading-relaxed text-ink outline-none ${POPOVER_SURFACE_CLASS}`;

/** Long enough to cross the 6px gap between the `i` and its bubble. */
const CLOSE_GRACE_MS = 150;

export function SettingHelp({ children, className = '' }: {
  children: React.ReactNode;
  /** Sits next to the trigger — the label, normally. */
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // True once a click has opened the bubble, so the next click on the same
  // trigger puts it away.
  const openedByClick = useRef(false);
  const helpId = useId();

  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay(`setting-help:${helpId}`);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const hadFocus = triggerRef.current !== null && triggerRef.current.contains(document.activeElement);
      setOpen(false);
      if (hadFocus) triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (bubbleRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, helpId]);

  const close = () => { setOpen(false); openedByClick.current = false; };

  // The bubble sits 6px below the `i`, so a real pointer crosses the gap
  // between them and the element under it is briefly neither. A relatedTarget
  // check alone would close the bubble mid-crossing, before the reader could
  // reach the text. Instead the close waits briefly and is cancelled the
  // moment the pointer is anywhere over the trigger or the bubble.
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const leaveLater = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; close(); }, CLOSE_GRACE_MS);
  };
  const enter = () => { cancelClose(); setOpen(true); };

  useEffect(() => cancelClose, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-setting-help
        aria-describedby={open ? helpId : undefined}
        aria-expanded={open}
        aria-label={t('st.help.label')}
        onClick={() => {
          // A first touch tap focuses the button before the click lands, so
          // `focus` has already opened it. A click that finds the bubble open
          // but not yet claimed by a click keeps it open; a second, deliberate
          // click puts it away.
          if (open && openedByClick.current) { close(); return; }
          setOpen(true);
          openedByClick.current = true;
        }}
        onMouseEnter={enter}
        onMouseLeave={leaveLater}
        onFocus={() => { if (!openedByClick.current) setOpen(true); }}
        onBlur={(event) => {
          if (event.relatedTarget instanceof Node
            && bubbleRef.current?.contains(event.relatedTarget) === true) return;
          setOpen(false);
        }}
        className={`${TRIGGER} ${className}`.trim()}
      >
        <Icon name="info" size={12} />
      </button>
      {open ? (
        <Popover.Root
          open
          modal={false}
          onOpenChange={(next, details) => {
            if (!next) {
              const target = details.event?.target;
              if (target instanceof Node && triggerRef.current?.contains(target)) return;
              close();
            }
          }}
        >
          <Popover.Portal>
            <Popover.Positioner
              anchor={triggerRef}
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={8}
              positionMethod="fixed"
              style={{ zIndex: floatingSurfaceZIndex(triggerRef.current) }}
            >
              <Popover.Popup
                ref={bubbleRef}
                id={helpId}
                role="tooltip"
                data-setting-help-bubble
                initialFocus={false}
                finalFocus={false}
                {...{
                  [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(triggerRef.current),
                  [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(triggerRef.current),
                }}
                onMouseEnter={enter}
                onMouseLeave={leaveLater}
                className={BUBBLE}
              >
                {children}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </>
  );
}
