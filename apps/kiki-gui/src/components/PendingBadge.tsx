/**
 * PendingBadge — the sidebar's global "waiting on you" indicator. Counts every
 * session whose polled record reports a pending approval or question, opens a
 * small popover naming those sessions, and jumps straight to one. Renders
 * nothing while nothing is pending.
 */

import { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';

import type { Session } from '@kiki/protocol';

import { useI18n } from '../i18n';
import {
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
} from '../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from './Dialog';
import { useGuardedNavigate } from './dirtyGuard';
import { POPOVER_SURFACE_CLASS } from './SearchableSelect';
import { ThreadTitle } from './ThreadTitle';

export function PendingBadge({ sessions }: { sessions: readonly Session[] }) {
  const { t, tp } = useI18n();
  const navigate = useGuardedNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const pending = sessions.filter(
    (session) =>
      session.pending_interaction === 'approval' || session.pending_interaction === 'question',
  );

  // Escape / outside pointer close, mirroring the sidebar's SessionMenu.
  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay('pending-badge');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node)
        || (rootRef.current?.contains(event.target) !== true && panelRef.current?.contains(event.target) !== true)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  if (pending.length === 0) return null;

  return (
    <div ref={rootRef} className="relative" data-pending-badge>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        title={t('pending.badgeTitle')}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium transition-colors ${
          open ? 'bg-amber-card text-amber-ink' : 'text-amber-ink hover:bg-amber-card/70'
        }`}
      >
        <span className="block h-2 w-2 shrink-0 rounded-full bg-amber-rule shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-amber-rule)_25%,transparent)]" />
        {tp('pending.count', pending.length)}
      </button>
      {open ? (
        <Popover.Root open modal={false} onOpenChange={(next) => { if (!next) setOpen(false); }}>
          <Popover.Portal>
            <Popover.Positioner
              anchor={triggerRef}
              side="top"
              align="start"
              sideOffset={6}
              collisionPadding={8}
              positionMethod="fixed"
              style={{ zIndex: floatingSurfaceZIndex(triggerRef.current) }}
            >
              <Popover.Popup
                ref={panelRef}
                initialFocus={false}
                finalFocus={false}
                {...{
                  [FLOATING_OWNER_ATTRIBUTE]: 'pending-badge',
                  [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(triggerRef.current),
                  [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(triggerRef.current),
                }}
                className={`anim-enter w-max min-w-[200px] max-w-[280px] max-h-[min(var(--available-height,320px),320px)] overflow-y-auto overscroll-contain p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
              >
                <p className="px-3 pt-1 pb-0.5 text-[12px] font-medium text-ink-faint">
                  {t('pending.popoverTitle')}
                </p>
                {pending.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      void navigate(`/s/${session.id}`);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-paper"
                  >
                    <span className="shrink-0 text-[11px] font-medium text-amber-ink">
                      {session.pending_interaction === 'approval'
                        ? t('pending.kind.approval')
                        : t('pending.kind.question')}
                    </span>
                    <span className="min-w-0 truncate text-[12px] text-ink">
                      <ThreadTitle text={session.title.trim() !== '' ? session.title : t('sidebar.untitled')} />
                    </span>
                  </button>
                ))}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </div>
  );
}
