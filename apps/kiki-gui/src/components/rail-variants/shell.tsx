/**
 * Small shared rail chrome: the overview mode preference and its switch, the
 * agent state mark, and the in-place approve / reject.
 *
 * The mode is a device preference kept in `kiki.railMode`; with nothing
 * stored the overview opens in the standard mode. It changes only the
 * overview block; every other part of the rail is the same in both modes.
 */

import { useCallback, useEffect, useState } from 'react';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import type { FleetState, PendingItem } from './model';
import { pendingId } from './model';

export type RailMode = 'default' | 'cockpit';

const STORAGE_KEY = 'kiki.railMode';
const listeners = new Set<() => void>();

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** [mode, choose]; anything but a stored `cockpit` is the default mode. */
export function useRailMode(): [RailMode, (next: RailMode) => void] {
  const [stored, setStored] = useState(readStored);
  const mode: RailMode = stored === 'cockpit' ? 'cockpit' : 'default';
  useEffect(() => {
    const sync = () => { setStored(readStored()); };
    listeners.add(sync);
    return () => { listeners.delete(sync); };
  }, []);
  const choose = useCallback((next: RailMode) => {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable: this window only */ }
    for (const listener of listeners) listener();
  }, []);
  return [mode, choose];
}

export const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink';

const MODE_LABEL = { default: 'rail.mode.default', cockpit: 'rail.mode.cockpit' } as const;

/**
 * Two-segment switch in the overview block's own head. `controls` names the
 * block it changes, so assistive tech reads the scope too.
 */
export function ModeSwitch({ mode, onChoose, controls }: { mode: RailMode; onChoose: (next: RailMode) => void; controls?: string }) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t('rail.mode.aria')} aria-controls={controls} data-rail-mode-switch className="flex shrink-0 items-center rounded-md bg-ink/[0.05] p-0.5">
      {(['default', 'cockpit'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          data-rail-mode={value}
          onClick={() => { onChoose(value); }}
          className={`h-6 rounded-[5px] px-2 text-[12px] transition-colors duration-[var(--kiki-motion-quick)] pointer-coarse:h-8 ${mode === value ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-faint hover:text-ink'} ${FOCUS_RING}`}
        >
          {t(MODE_LABEL[value])}
        </button>
      ))}
    </div>
  );
}

/** Agent state as shape + colour, so the set still reads in greyscale. */
export function StateMark({ state, className = 'h-2 w-2' }: { state: FleetState; className?: string }) {
  const shape: Record<FleetState, string> = {
    waiting: 'kiki-life rounded-full bg-attention',
    running: 'kiki-life rounded-full bg-success',
    done: 'rounded-full border-[1.5px] border-ink-faint',
    failed: 'rounded-[1.5px] bg-danger',
    stopped: 'rounded-[1.5px] border-[1.5px] border-ink-faint',
  };
  return <span aria-hidden data-life={state === 'waiting' ? 'waiting' : state === 'running' ? 'working' : undefined} data-life-still={state === 'running' ? '' : undefined} className={`inline-block shrink-0 ${shape[state]} ${className}`} />;
}

/** In-place decisions for pending approvals, with the same failure toast as the current rail. */
export function useDecide(onResolve: ((approvalId: string, decision: 'approved' | 'rejected') => Promise<void>) | undefined) {
  const { t } = useI18n();
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const decide = useCallback((item: PendingItem, decision: 'approved' | 'rejected') => {
    if (onResolve === undefined || item.kind !== 'approval') return;
    const id = pendingId(item);
    setSending((current) => new Set(current).add(id));
    void onResolve(id, decision)
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: t('inspector.resolveFailed', { detail: error instanceof Error ? error.message : String(error) }) });
      })
      .finally(() => {
        setSending((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      });
  }, [onResolve, t]);
  return { sending, decide, canDecide: onResolve !== undefined };
}
