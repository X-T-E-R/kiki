/**
 * Style tiers for the default rail (prototype, round 3). One component tree;
 * each variant is only a table of classes:
 *
 *   r1  the current rail's look, reordered: no frames, plain rows
 *   r2  small section heads over hairlines, a thin attention rule on Needs
 *       you, outline buttons, figures as the visual anchor
 *   r3  every section a faint panel (the settings card token), quiet inside
 *
 * One accent in every tier, and only on what needs the user.
 */

import { useCallback, useEffect, useState } from 'react';

export type RailVariant = 'r1' | 'r2' | 'r3';
export const RAIL_VARIANTS: readonly RailVariant[] = ['r1', 'r2', 'r3'];
const STORAGE_KEY = 'kiki.railVariant';
const listeners = new Set<() => void>();

function readVariant(): RailVariant {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'r1' || value === 'r3' ? value : 'r2';
  } catch {
    return 'r2';
  }
}

export function useRailVariant(): [RailVariant, (next: RailVariant) => void] {
  const [variant, setVariant] = useState(readVariant);
  useEffect(() => {
    const sync = () => { setVariant(readVariant()); };
    listeners.add(sync);
    return () => { listeners.delete(sync); };
  }, []);
  const choose = useCallback((next: RailVariant) => {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* this window only */ }
    for (const listener of listeners) listener();
  }, []);
  return [variant, choose];
}

export interface RailTone {
  /** Gap between sections on the page. */
  readonly page: string;
  /** Wrapper around each section. */
  readonly section: string;
  /** Section heading text (the tiers that draw their own heads). */
  readonly head: string;
  /** Needs you: the list container and one row. */
  readonly needsList: string;
  readonly needsRow: string;
  /** Needs you: approve / reject / answer controls. */
  readonly approve: string;
  readonly reject: string;
  /** Needs you head count. */
  readonly needsCount: string;
  /** Restyles the current overview: the context meter (neutral until near the compaction point) and the figures. */
  readonly overview: string;
  /** Todo pointer progress fill. */
  readonly pointerFill: string;
}

const METER = '[&_[data-overview-context]_[role=meter]>div]:!bg-ink-soft/70 [&_[data-overview-context=warn]_[role=meter]>div]:!bg-attention [&_[data-overview-context=danger]_[role=meter]>div]:!bg-attention [&_[data-overview-context]_span.text-danger]:!text-attention [&_[data-overview-context]_span.text-amber-ink]:!text-attention';
const FIGURES_MONO = "[&_[data-overview-fact]>div:first-child]:font-mono [&_[data-overview-fact]>div:first-child]:text-[17px] [&_[data-overview-fact]>div:first-child]:font-normal [&_[data-overview-fact]>div:first-child]:tracking-tight [&_[data-overview-context]_.text-[13px]]:font-mono";

const TEXT_BUTTON = 'h-7 shrink-0 rounded-md px-1.5 text-[12.5px] transition-colors';

export const TONES: Record<RailVariant, RailTone> = {
  r1: {
    page: 'space-y-5',
    section: '',
    head: 'text-[12px] font-medium text-ink-soft',
    needsList: '-mx-1.5',
    needsRow: 'rounded-md px-1.5 hover:bg-ink/[0.03]',
    approve: `${TEXT_BUTTON} font-medium text-attention hover:bg-attention-soft`,
    reject: `${TEXT_BUTTON} text-ink-faint hover:bg-ink/[0.05] hover:text-ink`,
    needsCount: 'text-[12px] text-attention tabular-nums',
    overview: METER,
    pointerFill: 'bg-ink-soft/60',
  },
  r2: {
    page: 'space-y-0',
    section: 'border-t border-hairline py-4 first:border-t-0 first:pt-1',
    head: 'text-[11.5px] font-medium tracking-[0.02em] text-section-ink',
    needsList: 'border-l-2 border-attention pl-2.5',
    needsRow: 'py-0.5',
    approve: `h-7 shrink-0 rounded-md px-2 text-[12px] font-medium text-attention ring-1 ring-attention/45 ring-inset transition-colors hover:bg-attention-soft`,
    reject: `${TEXT_BUTTON} text-[12px] text-ink-faint hover:bg-ink/[0.05] hover:text-ink`,
    needsCount: 'text-[12px] font-medium text-attention tabular-nums',
    overview: `${METER} ${FIGURES_MONO}`,
    pointerFill: 'bg-ink-soft/60',
  },
  r3: {
    page: 'space-y-2.5',
    section: 'rounded-xl border border-hairline bg-paper/70 px-3 py-2.5',
    head: 'text-[12px] font-medium text-ink-soft',
    needsList: '-mx-1.5',
    needsRow: 'rounded-md px-1.5 hover:bg-ink/[0.03]',
    approve: `${TEXT_BUTTON} font-medium text-attention hover:bg-attention-soft`,
    reject: `${TEXT_BUTTON} text-ink-faint hover:bg-ink/[0.05] hover:text-ink`,
    needsCount: 'text-[12px] text-attention tabular-nums',
    overview: METER,
    pointerFill: 'bg-ink-soft/60',
  },
};
