/**
 * FloorNavRail — liveagent's FloorNavRail idea, kiki-weight: a slim tick rail
 * at the transcript's right edge, one tick per user message ("floor"). It
 * reveals while the log is being scrolled or while hovered/focused and fades
 * back out after ~1.4s idle; the tick owning the viewport stays highlighted.
 * Clicking a tick smooth-scrolls the row into view.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';

import { buildFloorEntries, type Block, type FloorEntry } from '@kiki/session-core/session';
import { useI18n } from '../i18n';

const REVEAL_IDLE_MS = 1400;

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
    () => entries.map((entry, index) => {
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
            virtualizer.scrollToIndex(nodeIndexes.get(entry.blockId)!, {
              align: 'start',
              behavior: 'smooth',
            });
          }}
          className={`h-[3px] rounded-full transition-all duration-150 ${
            active ? 'w-[18px] bg-accent' : 'w-[10px] bg-ink-faint/40 hover:bg-ink-faint/70'
          }`}
        />
      );
    }),
    [activeId, entries, nodeIndexes, t, virtualizer],
  );

  if (entries.length < 2) return null;
  const visible = revealed || hovering;
  return (
    <nav
      aria-label={t('transcript.floorsAria')}
      data-floor-nav
      onMouseEnter={() => { setHovering(true); }}
      onMouseLeave={() => { setHovering(false); }}
      onFocus={() => { setHovering(true); }}
      onBlur={() => { setHovering(false); }}
      className={`absolute top-1/2 right-1.5 z-10 flex -translate-y-1/2 flex-col items-end gap-[7px] transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      {ticks}
    </nav>
  );
}
