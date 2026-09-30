/**
 * FloorNavRail — liveagent's FloorNavRail idea, kiki-weight: a slim tick rail
 * at the transcript's right edge, one tick per user message ("floor"). It
 * reveals while the log is being scrolled or while hovered/focused and fades
 * back out after ~1.4s idle; the tick owning the viewport stays highlighted.
 * Clicking a tick jumps the row to the top of the viewport.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';

import { buildFloorEntries, type Block, type FloorEntry } from '@kiki/session-core/session';
import { useI18n } from '../i18n';

const REVEAL_IDLE_MS = 1400;
const MAX_FLOOR_TICKS = 64;

function sameFloorEntries(left: readonly FloorEntry[], right: readonly FloorEntry[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a?.blockId !== b?.blockId || a?.preview !== b?.preview) return false;
  }
  return true;
}

function useStableFloorEntries(blocks: readonly Block[]): readonly FloorEntry[] {
  const previous = useRef<readonly FloorEntry[]>([]);
  return useMemo(() => {
    const next = buildFloorEntries(blocks);
    if (sameFloorEntries(previous.current, next)) return previous.current;
    previous.current = next;
    return next;
  }, [blocks]);
}

function resolveVirtualFloorId(
  entries: readonly FloorEntry[],
  nodeIndexes: ReadonlyMap<string, number>,
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  viewportTop: number,
): string | undefined {
  const target = viewportTop + 80;
  let low = 0;
  let high = entries.length - 1;
  let candidate: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = entries[middle]!;
    const top = virtualizer.measurementsCache[nodeIndexes.get(entry.blockId)!]!.start;
    if (top <= target) {
      candidate = entry.blockId;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate ?? entries[0]?.blockId;
}

export function FloorNavRail({
  blocks,
  nodeIndexes,
  scrollRef,
  virtualizer,
}: {
  blocks: readonly Block[];
  nodeIndexes: ReadonlyMap<string, number>;
  scrollRef: { readonly current: HTMLDivElement | null };
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
}) {
  const { t } = useI18n();
  const entries = useStableFloorEntries(blocks);
  const [revealed, setRevealed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null || entries.length < 2) {
      setActiveId(undefined);
      return;
    }
    const next = resolveVirtualFloorId(entries, nodeIndexes, virtualizer, scroll.scrollTop);
    setActiveId((previous) => (previous === next ? previous : next));
  }, [entries, nodeIndexes, scrollRef, virtualizer]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null || entries.length < 2) return;
    const onScroll = () => {
      setRevealed(true);
      const next = resolveVirtualFloorId(entries, nodeIndexes, virtualizer, scroll.scrollTop);
      setActiveId((previous) => (previous === next ? previous : next));
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => { setRevealed(false); }, REVEAL_IDLE_MS);
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', onScroll);
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    };
  }, [entries, nodeIndexes, scrollRef, virtualizer]);

  const ticks = useMemo(
    () => {
      const indexes = entries.length <= MAX_FLOOR_TICKS
        ? entries.map((_, index) => index)
        : Array.from({ length: MAX_FLOOR_TICKS }, (_, index) =>
            Math.round(index * (entries.length - 1) / (MAX_FLOOR_TICKS - 1)));
      const activeIndex = entries.findIndex((entry) => entry.blockId === activeId);
      if (activeIndex >= 0 && !indexes.includes(activeIndex)) {
        const nearest = Math.round(activeIndex * (MAX_FLOOR_TICKS - 1) / (entries.length - 1));
        indexes[Math.max(1, Math.min(MAX_FLOOR_TICKS - 2, nearest))] = activeIndex;
        indexes.sort((left, right) => left - right);
      }
      return indexes.map((index) => {
        const entry = entries[index]!;
        const active = entry.blockId === activeId;
        return (
          <button
            key={entry.blockId}
            type="button"
            data-floor-tick
            data-floor-active={active || undefined}
            title={entry.preview}
            aria-label={t('transcript.floorTickAria', { index: index + 1, preview: entry.preview })}
            onClick={() => {
              setActiveId(entry.blockId);
              // Instant, not smooth: virtual-core drops ResizeObserver
              // measurements outside the target window during a smooth
              // scroll and never re-reads them, so rows the animation sweeps
              // past keep estimated heights and paint over their neighbours.
              virtualizer.scrollToIndex(nodeIndexes.get(entry.blockId)!, { align: 'start' });
            }}
            className={`h-[2px] rounded-full transition-[width,background-color] duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
              active ? 'w-4 bg-selected-ink' : 'w-2 bg-ink-faint/25 group-hover/floor:w-2.5 group-hover/floor:bg-ink-faint/45 hover:!w-3.5 hover:!bg-ink-soft'
            }`}
          />
        );
      });
    },
    [activeId, entries, nodeIndexes, t, virtualizer],
  );

  if (entries.length < 2) return null;
  const visible = revealed || hovering;
  // Weight follows intent: hidden at rest, a whisper while the log scrolls,
  // full contrast only under the pointer or keyboard focus. The hit strip is
  // wider than the ticks so hovering never needs pixel aim.
  return (
    <nav
      aria-label={t('transcript.floorsAria')}
      data-floor-nav
      data-floor-hover={hovering || undefined}
      onMouseEnter={() => { setHovering(true); }}
      onMouseLeave={() => { setHovering(false); }}
      onFocus={() => { setHovering(true); }}
      onBlur={() => { setHovering(false); }}
      className={`group/floor absolute top-1/2 right-0.5 z-10 flex -translate-y-1/2 flex-col items-end gap-[6px] rounded-l-md py-2 pr-1 pl-3 transition-opacity duration-200 motion-reduce:transition-none ${
        hovering ? 'opacity-100' : visible ? 'opacity-60' : 'pointer-events-none opacity-0'
      }`}
    >
      {ticks}
    </nav>
  );
}
