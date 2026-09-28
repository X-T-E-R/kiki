/**
 * Motion language helpers. The tokens and keyframes live in styles/motion.css;
 * this module maps product facts onto the few states that are allowed to move
 * and hands out the small style hooks the CSS reads.
 *
 * Life states (the only looping motion in the app, on small marks only):
 *   working — an agent holds a turn or background work: slow breath
 *   waiting — a human interaction is pending: steady dot, outward ring
 *   done    — a turn completed moments ago: one settle, then still
 *   failed  — the last turn failed or was cancelled: still, danger/amber tone
 *   idle    — nothing to report: not drawn at all
 *
 * The rendered mark is `LifeMark` (components/LifeMark.tsx): rows pass
 * `still` so working never breathes in a list, and done settles only at the
 * moment the state changes.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import type { Session } from '@kiki/protocol';

export type LifeState = 'working' | 'waiting' | 'done' | 'failed' | 'idle';

/** How long a completed turn still reads as "just done". */
export const DONE_WINDOW_MS = 10 * 60_000;

type LifeFacts = Pick<Session, 'busy'> & Partial<Pick<Session, 'pending_interaction' | 'last_turn_reason' | 'updated_at'>>;

export function lifeOf(session: LifeFacts, now: number = Date.now()): LifeState {
  if (session.pending_interaction === 'approval' || session.pending_interaction === 'question') return 'waiting';
  if (session.busy) return 'working';
  if (session.last_turn_reason === 'failed' || session.last_turn_reason === 'cancelled') return 'failed';
  if (session.last_turn_reason === 'completed' && session.updated_at !== undefined) {
    const updated = Date.parse(session.updated_at);
    if (Number.isFinite(updated) && now - updated < DONE_WINDOW_MS) return 'done';
  }
  return 'idle';
}

/** The loudest state across many sessions: waiting beats working beats done. */
export function aggregateLife(states: readonly LifeState[]): LifeState {
  for (const state of ['waiting', 'working', 'done'] as const) {
    if (states.includes(state)) return state;
  }
  return 'idle';
}

/** Stagger index for a `.motion-stagger` child. Capped so long lists never wait. */
export function staggerStyle(index: number, cap = 8): CSSProperties {
  return { '--kiki-i': Math.min(index, cap) } as CSSProperties;
}

/** The in-app motion preference, set as `data-kiki-motion` on <html>. */
export type MotionPreference = 'system' | 'reduce' | 'full';

export function motionPreference(): MotionPreference {
  if (typeof document === 'undefined') return 'system';
  const value = document.documentElement.dataset['kikiMotion'];
  return value === 'reduce' || value === 'full' ? value : 'system';
}

/**
 * Whether script-driven motion (scroll smoothing, JS animations) should hold
 * still. Mirrors styles/motion.css: `reduce` and `full` override the OS.
 */
export function prefersReducedMotion(): boolean {
  const preference = motionPreference();
  if (preference !== 'system') return preference === 'reduce';
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const lastMarkLife = new Map<string, LifeState>();

/** Test seam: forget remembered mark states. */
export function resetMarkLives(): void {
  lastMarkLife.clear();
}

/**
 * True while a mark shows the state it just changed into. The last state is
 * remembered per `markId` across remounts, so re-rendering a page or a list
 * does not replay the done settle; only a real flip does. Pair it with
 * `data-life-changed` on the mark (styles/motion.css). An undefined `life`
 * (state not known yet, e.g. still loading) records nothing, so the first
 * known state never counts as a change.
 */
export function useLifeChanged(markId: string, life: LifeState | undefined): boolean {
  const latch = useRef<{ life: LifeState | undefined; changed: boolean } | null>(null);
  if (latch.current === null || latch.current.life !== life) {
    const previous = lastMarkLife.get(markId);
    latch.current = { life, changed: life !== undefined && previous !== undefined && previous !== life };
  }
  useEffect(() => {
    if (life !== undefined) lastMarkLife.set(markId, life);
  }, [markId, life]);
  return latch.current.changed;
}
