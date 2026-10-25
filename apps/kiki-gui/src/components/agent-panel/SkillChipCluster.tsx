/**
 * One scope's skills as a wrapping chip cluster, folded on real rows.
 *
 * Every chip is laid out; the cluster is clipped to the height of its first
 * `rowCount` wrapped rows and a fade sits over the cut, so the fold reads as
 * "there is more below" rather than as a clipped border. The fold therefore
 * holds at any column width: the same list is two rows in the wide agent panel
 * and nine in the rail's narrowest column, and each measures its own rows
 * instead of guessing from a chip count.
 *
 * The fold is a reading limit, not a different list. The chips past the cut
 * stay in the DOM with their buttons, so opening the group reveals the same
 * elements in place, and the toggle below the cluster always names the real
 * number of chips the cut is hiding.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Height of one chip row: h-7 chip + gap-1, with a pixel for rounding. */
const ROW_HEIGHT = 32;

export interface SkillFoldState {
  /** The chips the cut is currently hiding. */
  readonly hidden: number;
  /** Whether the list folds at all at this width. */
  readonly folding: boolean;
}

export function SkillChipCluster({
  children,
  open,
  rowCount = 4,
  onFold,
  toggle,
}: {
  readonly children: ReactNode;
  /** Unfolded: the full list, at its natural height, with no fade. */
  readonly open: boolean;
  readonly rowCount?: number;
  /** Reports what the cut hides, so the toggle can name it. */
  readonly onFold?: (state: SkillFoldState) => void;
  /** The fold control, rendered below the cluster where it is always visible. */
  readonly toggle?: ReactNode;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [fold, setFold] = useState<{ hidden: number; folding: boolean } | null>(null);
  const cut = rowCount * ROW_HEIGHT;

  // One wrapper for both states, so the measured box is the same element before
  // and after folding. It carries the column's width and the list's natural
  // height; the clip is applied inside it, which is what makes a fold visible
  // without changing what is measured.
  const wrapRef = useRef<HTMLDivElement>(null);
  // What the current answer was derived from. A notification that matches all of
  // it is this component's own doing and must not re-enter — but it has to
  // include the chips, because the same box can hold a different list.
  const measured = useRef<{ width: number; height: number; open: boolean; chips: number } | null>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    const list = listRef.current;
    if (wrap === null || list === null) return undefined;
    const measure = () => {
      // A read that has not been laid out yet cannot be measured; leave the
      // list open rather than clip against a guess.
      const width = wrap.getBoundingClientRect().width;
      if (width === 0) return;
      // Read the list as it wraps, with this component's own clip removed, so
      // the answer never depends on the cut it is about to decide.
      const wasClipped = list.style.maxHeight;
      list.style.maxHeight = '';
      const natural = list.getBoundingClientRect().height;
      list.style.maxHeight = wasClipped;
      if (natural === 0) return;
      const chips = Array.from(list.querySelectorAll<HTMLElement>('[data-capability-chip]'));
      const size = { width, height: natural, open, chips: chips.length };
      const previous = measured.current;
      if (previous !== null && previous.width === size.width && previous.height === size.height
        && previous.open === size.open && previous.chips === size.chips) return;
      measured.current = size;
      // Rows are counted against this cluster's own top, never `offsetTop`:
      // that is relative to the nearest positioned ancestor, which for a chip
      // in this column is the wrapper, not the list it wraps in.
      const top = list.getBoundingClientRect().top;
      // A chip on the fold's last allowed row is still readable; one below it
      // is what the cut hides.
      const hidden = open
        ? 0
        : chips.filter((chip) => chip.getBoundingClientRect().top - top >= cut).length;
      setFold((current) =>
        current?.hidden === hidden && current.folding === hidden > 0
          ? current
          : { hidden, folding: hidden > 0 });
    };
    measure();
    // A sidebar drag or a viewport change is layout the component does not
    // perform: no state changes, no new children, so no dependency can fire.
    // The column's own size is what changes, so that is what is observed. It
    // reports the same numbers this guard ignores, which is what keeps the
    // clip from calling back on itself.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => { observer.disconnect(); };
  }, [open, cut, children]);

  // Reported from an effect, never during render.
  useEffect(() => { onFold?.(fold ?? { hidden: 0, folding: false }); }, [fold, onFold]);

  const folding = fold?.folding === true;
  return (
    <div ref={wrapRef} data-capability-skill-clip={folding ? '' : undefined} className="relative">
      <ul
        ref={listRef}
        data-capability-skill-cluster=""
        data-capability-skill-folded={folding ? '' : undefined}
        className={`flex flex-wrap gap-1 px-2 ${folding ? 'overflow-hidden' : ''}`}
        style={folding ? { maxHeight: cut } : undefined}
      >
        {children}
      </ul>
      {folding ? (
        // The cut is a fade, not a hard edge: the reader sees the next row
        // beginning rather than a chip sliced in half.
        <div
          aria-hidden
          data-capability-skill-fade=""
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-panel to-transparent"
        />
      ) : null}
      {toggle}
    </div>
  );
}
