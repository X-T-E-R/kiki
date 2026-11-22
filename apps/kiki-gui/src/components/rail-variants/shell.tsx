/**
 * Shared rail state marks, focus ring, and in-place approval actions.
 * `useRailMode` remains as a fixed `'default'` compatibility seam for callers
 * outside this slice while the inspector runs purely on Run | Config tabs.
 */

import { useCallback, useState } from 'react';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import type { FleetState, PendingItem } from './model';
import { pendingId } from './model';

export type RailMode = 'default' | 'cockpit';

const NOOP_CHOOSE = (_next: RailMode) => {};

/** Compatibility seam: the cockpit mode is retired and the rail always reports `'default'`. */
export function useRailMode(): [RailMode, (next: RailMode) => void] {
  return ['default', NOOP_CHOOSE];
}

/** Live media query, for surfaces the rail hides below a width. */
export { useMediaQuery } from '../../lib/layoutHooks';

export const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink';

/**
 * Agent state as shape + colour, so the set still reads in greyscale.
 *
 * `unknown` is a hollow dashed dot, deliberately unlike `done`'s solid ring:
 * a state the session never reported must not wear the mark of a finished one.
 */
export function StateMark({ state, className = 'h-2 w-2' }: { state: FleetState; className?: string }) {
  const shape: Record<FleetState, string> = {
    waiting: 'kiki-life rounded-full bg-attention',
    running: 'kiki-life rounded-full bg-success',
    done: 'rounded-full border-[1.5px] border-ink-faint',
    failed: 'rounded-[1.5px] bg-danger',
    stopped: 'rounded-[1.5px] border-[1.5px] border-ink-faint',
    unknown: 'rounded-full border border-dashed border-ink-faint/70',
  };
  return <span aria-hidden data-life={state === 'waiting' ? 'waiting' : state === 'running' ? 'working' : undefined} data-life-still={state === 'running' ? '' : undefined} className={`inline-block shrink-0 ${shape[state]} ${className}`} />;
}

/**
 * The fill a state carries in a time bar. Bars are neutral ink for how long
 * something existed; only the end-point mark carries status, so a long neutral
 * bar never reads as "still fine" or "still failing" on its own.
 */
export function stateFillClass(state: FleetState, needsUser: boolean): string {
  if (state === 'waiting') return needsUser ? 'bg-attention' : 'border border-dashed border-ink-faint/70';
  switch (state) {
    case 'running': return 'bg-success/80';
    case 'failed': return 'bg-danger/70';
    case 'stopped': return 'bg-ink/10';
    case 'unknown': return 'bg-ink/10 border border-dashed border-ink-faint/60';
    default: return 'bg-ink/15';
  }
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
