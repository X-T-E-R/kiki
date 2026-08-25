/**
 * FloorNavRail — liveagent's FloorNavRail idea, kiki-weight: a slim tick rail
 * at the transcript's right edge, one tick per user message ("floor"). It
 * reveals while the log is being scrolled or while hovered/focused and fades
 * back out after ~1.4s idle; the tick owning the viewport stays highlighted.
 * Clicking a tick smooth-scrolls the row into view.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';

import { useI18n } from '../i18n';
import {
  buildFloorEntries,
  resolveActiveFloorId,
  type FloorEntry,
} from '../state/transcript';
import type { Block } from '../state/transcript';

const REVEAL_IDLE_MS = 1400;

type FloorPosition = { blockId: string; top: number };

function findRowElement(content: HTMLElement | null, blockId: string): HTMLElement | null {
  if (content === null) return null;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(blockId)
    : blockId.replace(/"/g, '\\"');
  return content.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`);
}

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

export function FloorNavRail({ blocks }: { blocks: readonly Block[] }) {
  const { t } = useI18n();
  const { scrollRef, contentRef } = useStickToBottomContext();
  const entries = useStableFloorEntries(blocks);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const positionsRef = useRef<readonly FloorPosition[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rebuildPositions = useCallback((): void => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (scroll === null || content === null) {
      positionsRef.current = [];
      return;
    }
    const wanted = new Set(entriesRef.current.map((entry) => entry.blockId));
    const viewportTop = scroll.getBoundingClientRect().top;
    const positions: FloorPosition[] = [];
    for (const row of content.querySelectorAll<HTMLElement>('[data-block-id]')) {
      const blockId = row.getAttribute('data-block-id');
      if (blockId !== null && wanted.has(blockId)) {
        positions.push({
          blockId,
          top: row.getBoundingClientRect().top - viewportTop + scroll.scrollTop,
        });
      }
    }
    positionsRef.current = positions;
    const next = resolveActiveFloorId(positions, scroll.scrollTop);
    setActiveId((previous) => (previous === next ? previous : next));
  }, [contentRef, scrollRef]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null || entries.length < 2) {
      positionsRef.current = [];
      setActiveId(undefined);
      return;
    }
    rebuildPositions();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(rebuildPositions);
    resizeObserver?.observe(scroll);
    window.addEventListener('resize', rebuildPositions);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', rebuildPositions);
    };
  }, [entries, rebuildPositions, scrollRef]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null || entries.length < 2) return;
    const onScroll = () => {
      setRevealed(true);
      const next = resolveActiveFloorId(positionsRef.current, scroll.scrollTop);
      setActiveId((previous) => (previous === next ? previous : next));
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => { setRevealed(false); }, REVEAL_IDLE_MS);
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', onScroll);
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    };
  }, [entries, scrollRef]);

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
            findRowElement(contentRef.current, entry.blockId)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          className={`h-[3px] rounded-full transition-all duration-150 ${
            active ? 'w-[18px] bg-accent' : 'w-[10px] bg-ink-faint/40 hover:bg-ink-faint/70'
          }`}
        />
      );
    }),
    [activeId, contentRef, entries, t],
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
