/**
 * Shared chrome for the rail variants: the aside shell (same classes and
 * data hooks as RightRail, so layout, open state and the toggle keep
 * working), the variant picker, the agent state mark, and the in-place
 * approve / reject used by every variant.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { RAIL_MAX_WIDTH } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useLayoutPreferences } from '../../lib/layoutHooks';
import { pushToast } from '../../lib/toasts';
import { Icon } from '../icons';
import { railCopy } from './copy';
import type { FleetState, PendingItem } from './model';
import { pendingId } from './model';

export type RailVariant = 'a' | 'b' | 'c' | 'd';
export const RAIL_VARIANTS: readonly RailVariant[] = ['a', 'b', 'c', 'd'];
const STORAGE_KEY = 'kiki.railVariant';

function readVariant(): RailVariant | undefined {
  if (typeof window === 'undefined') return undefined;
  const fromUrl = new URLSearchParams(window.location.search).get('rail');
  if (fromUrl !== null) {
    const value = RAIL_VARIANTS.includes(fromUrl as RailVariant) ? (fromUrl as RailVariant) : undefined;
    try {
      if (value === undefined) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, value);
    } catch { /* storage unavailable: the URL still decides */ }
    return value;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return RAIL_VARIANTS.includes(stored as RailVariant) ? (stored as RailVariant) : undefined;
  } catch {
    return undefined;
  }
}

const listeners = new Set<() => void>();

/** `?rail=a|b|c|d` (sticky across navigation); `?rail=off` returns to the current rail. */
export function useRailVariant(): [RailVariant | undefined, (next: RailVariant | undefined) => void] {
  const [variant, setVariant] = useState(readVariant);
  useEffect(() => {
    const sync = () => { setVariant(readVariant()); };
    listeners.add(sync);
    return () => { listeners.delete(sync); };
  }, []);
  const choose = useCallback((next: RailVariant | undefined) => {
    const url = new URL(window.location.href);
    url.searchParams.set('rail', next ?? 'off');
    window.history.replaceState(window.history.state, '', url);
    for (const listener of listeners) listener();
  }, []);
  return [variant, choose];
}

export const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function VariantPicker({ variant, onChoose, dark = false }: {
  variant: RailVariant;
  onChoose: (next: RailVariant | undefined) => void;
  dark?: boolean;
}) {
  const { locale } = useI18n();
  const copy = railCopy(locale);
  const idle = dark ? 'text-shell-ink-soft hover:text-shell-ink' : 'text-ink-faint hover:text-ink';
  const on = dark ? 'bg-shell-ink/15 text-shell-ink-strong' : 'bg-ink/[0.07] text-ink';
  return (
    <div role="group" aria-label={copy.prototype} data-rail-variant-picker className="flex items-center gap-0.5 text-[11px] font-medium">
      <button type="button" onClick={() => { onChoose(undefined); }} className={`h-6 rounded px-1.5 transition-colors ${idle} ${FOCUS_RING}`}>
        {copy.current}
      </button>
      {RAIL_VARIANTS.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={id === variant}
          onClick={() => { onChoose(id); }}
          className={`h-6 w-6 rounded font-mono uppercase transition-colors ${id === variant ? on : idle} ${FOCUS_RING}`}
        >
          {id}
        </button>
      ))}
    </div>
  );
}

/** The aside every variant renders into; mirrors RightRail's outer shape. */
export function VariantShell({ className, variant, surface, minWidth = 340, children }: {
  className: string | undefined;
  variant: RailVariant;
  /** Background class for the whole rail sheet. */
  surface?: string;
  minWidth?: number;
  children: ReactNode;
}) {
  const layout = useLayoutPreferences();
  const width = Math.min(RAIL_MAX_WIDTH, Math.max(layout.railWidth, minWidth));
  return (
    <div className="app-rail-shell">
      <aside
        className={`${className ?? 'app-rail'} ${surface ?? ''}`}
        style={{ '--kiki-rail-width': `${width}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' } as React.CSSProperties}
        data-session-rail
        data-rail-variant={variant}
      >
        {children}
      </aside>
    </div>
  );
}

export function CloseButton({ onClose, dark = false }: { onClose: (() => void) | undefined; dark?: boolean }) {
  const { locale } = useI18n();
  if (onClose === undefined) return null;
  const label = railCopy(locale).close;
  return (
    <button
      type="button"
      onClick={onClose}
      data-rail-close
      title={label}
      aria-label={label}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors lg:h-7 lg:w-7 ${dark ? 'text-shell-ink-soft hover:bg-shell-hover hover:text-shell-ink-strong' : 'text-ink-faint hover:bg-ink/[0.05] hover:text-ink'} ${FOCUS_RING}`}
    >
      <Icon name="close" size={16} />
    </button>
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
