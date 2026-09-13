/**
 * PendingBadge — the sidebar's global "waiting on you" indicator. Counts every
 * session whose polled record reports a pending approval or question, opens a
 * small popover naming those sessions, and jumps straight to one. Renders
 * nothing while nothing is pending.
 */

import { useEffect, useRef, useState } from 'react';

import type { Session } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { registerOverlay } from '../lib/uiBusy';
import { useGuardedNavigate } from './dirtyGuard';

export function PendingBadge({ sessions }: { sessions: readonly Session[] }) {
  const { t, tp } = useI18n();
  const navigate = useGuardedNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
      if (!(event.target instanceof HTMLElement) || rootRef.current?.contains(event.target) !== true) {
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
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        title={t('pending.badgeTitle')}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11.5px] font-medium transition-colors ${
          open ? 'bg-amber-card text-amber-ink' : 'text-amber-ink hover:bg-amber-card/70'
        }`}
      >
        <span className="block h-2 w-2 shrink-0 rounded-full bg-amber-rule shadow-[0_0_0_2px_rgba(232,176,75,0.25)]" />
        {tp('pending.count', pending.length)}
      </button>
      {open ? (
        <div className="anim-enter absolute bottom-full left-0 z-50 mb-1 w-max min-w-[200px] max-w-[280px] rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]">
          <p className="px-2.5 pt-1 pb-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
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
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-paper"
            >
              <span className="shrink-0 rounded-full border border-amber-rule/40 bg-amber-card px-1.5 py-px text-[9.5px] font-medium text-amber-ink">
                {session.pending_interaction === 'approval'
                  ? t('pending.kind.approval')
                  : t('pending.kind.question')}
              </span>
              <span className="min-w-0 truncate text-[12px] text-ink">
                {session.title.trim() !== '' ? session.title : t('sidebar.untitled')}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
