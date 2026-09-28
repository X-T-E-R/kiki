/**
 * The shell's one status dot: a `.kiki-life` mark (styles/motion.css) that
 * only moves when the motion rules allow it.
 *
 *   - `idle` renders nothing: a dot always means something is going on.
 *   - Every state has its own shape (dot / ring / square), so the set still
 *     reads in greyscale and for colour-blind users.
 *   - `still` pins the mark: list rows never breathe, so a sidebar with five
 *     running sessions does not turn into a field of blinking dots.
 *   - `done` settles once, at the moment the state changes. The last state is
 *     remembered per `markId` across remounts, so regrouping or reloading the
 *     list does not replay the settle on every finished row.
 */

import { useEffect, useRef } from 'react';

import type { LifeState } from '../lib/motion';

const lastLife = new Map<string, LifeState>();

/** Test seam: forget remembered states. */
export function resetLifeMarks(): void {
  lastLife.clear();
}

/** True while the mark is showing the state it just changed into. */
function useJustChanged(markId: string, life: LifeState): boolean {
  const latch = useRef<{ life: LifeState; changed: boolean } | null>(null);
  if (latch.current === null || latch.current.life !== life) {
    const previous = lastLife.get(markId);
    latch.current = { life, changed: previous !== undefined && previous !== life };
  }
  useEffect(() => {
    lastLife.set(markId, life);
  }, [markId, life]);
  return latch.current.changed;
}

/**
 * Colour per state. The tone is a background class; `done` is the one
 * exception, a border colour, because done is drawn as a ring.
 */
export const LIFE_TONE: Record<Exclude<LifeState, 'idle'>, string> = {
  waiting: 'bg-accent',
  working: 'bg-ink-soft',
  done: 'border-ink-soft',
  failed: 'bg-danger',
};

/**
 * Shape per state, so no two states differ by hue alone:
 *   waiting  solid dot (plus its ring)    working  solid dot
 *   done     hollow ring                  failed   square
 * `.kiki-life` is unlayered CSS, so the square's radius must be important to
 * beat it. The done ring's settle halo is a border too, drawn just outside
 * the ring so it grows from the ring's own edge.
 */
const LIFE_SHAPE: Record<Exclude<LifeState, 'idle'>, string> = {
  waiting: '',
  working: '',
  done: 'border-[1.5px] bg-transparent after:inset-[-1.5px] after:border-[1.5px] after:border-inherit',
  failed: 'rounded-[1.5px]!',
};

export function LifeMark({
  markId,
  life,
  tone,
  still = false,
  title,
  className = 'h-[7px] w-[7px]',
}: {
  /** Stable identity for the remembered state, e.g. `row:<sessionId>`. */
  markId: string;
  life: LifeState;
  /** Colour class; defaults to the state's tone (a border class for done). */
  tone?: string;
  /** Suppress the working breath (rows). Waiting keeps its ring regardless. */
  still?: boolean;
  title?: string;
  className?: string;
}) {
  const changed = useJustChanged(markId, life);
  if (life === 'idle') return null;
  const quiet = (life === 'working' && still) || (life === 'done' && !changed);
  return (
    <span
      data-life={life}
      data-life-still={quiet ? '' : undefined}
      data-life-changed={life === 'done' && changed ? '' : undefined}
      title={title}
      aria-hidden={title === undefined ? true : undefined}
      // Stillness is `data-life-still` alone: styles/motion.css stops both the
      // mark and its ring for it, so no utility override is needed here.
      className={`kiki-life ${className} ${LIFE_SHAPE[life]} ${tone ?? LIFE_TONE[life]}`}
    />
  );
}
