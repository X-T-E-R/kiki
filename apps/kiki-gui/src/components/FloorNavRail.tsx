/**
 * FloorNavRail — liveagent's FloorNavRail idea, kiki-weight: a slim tick rail
 * at the transcript's right edge, one tick per user message ("floor"). It
 * reveals while the log is being scrolled or while hovered/focused and fades
 * back out after ~1.4s idle; the tick owning the viewport stays highlighted.
 * Clicking a tick smooth-scrolls the row into view.
 *
 * Rows are always mounted (the transcript paginates memoized pages, not a
 * windowing virtualizer), so positioning is plain DOM queries against
 * `[data-block-id]`. The floor model itself is pure (`buildFloorEntries` /
 * `resolveActiveFloorId` in state/transcript.ts) for unit tests.
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

/** Idle delay before the rail fades back out after the last scroll. */
const REVEAL_IDLE_MS = 1400;

function findRowElement(content: HTMLElement | null, blockId: string): HTMLElement | null {
  if (content === null) return null;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(blockId)
    : blockId.replace(/"/g, '\\"');
  return content.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`);
}

export function FloorNavRail({ blocks }: { blocks: readonly Block[] }) {
  const { t } = useI18n();
  const { scrollRef, contentRef } = useStickToBottomContext();
  const entries: FloorEntry[] = useMemo(() => buildFloorEntries(blocks), [blocks]);
  const [revealed, setRevealed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Viewport-relative row tops for the active-floor computation. ONE
   * full-content scan per call: a per-entry querySelector is O(entries × DOM)
   * and dominates mount time on long transcripts (jsdom nwsapi walks the
   * whole tree per attribute query). */
  const measure = useCallback((): { blockId: string; top: number }[] => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (scroll === null || content === null) return [];
    const wanted = new Set(entries.map((entry) => entry.blockId));
    const scrollTop = scroll.getBoundingClientRect().top;
    const positions: { blockId: string; top: number }[] = [];
    for (const row of content.querySelectorAll<HTMLElement>('[data-block-id]')) {
      const blockId = row.getAttribute('data-block-id');
      if (blockId !== null && wanted.has(blockId)) {
        positions.push({ blockId, top: row.getBoundingClientRect().top - scrollTop });
      }
    }
    return positions;
  }, [entries, scrollRef, contentRef]);
  // Read through a ref so the wiring effect below does not re-run on every
  // streaming delta: a setState during the commit phase turns the Profiler
  // phase into 'nested-update' and adds a commit per token.
  const measureRef = useRef(measure);
  measureRef.current = measure;

  // Layout effect, deliberately: the initial setActiveId must land inside the
  // mount commit. A passive effect defers to the NEXT flushSync/commit, which
  // would turn the first streaming delta's commit into a 'nested-update' (and
  // costs an extra commit per mount).
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null || entries.length < 2) return;
    const onScroll = () => {
      setRevealed(true);
      setActiveId(resolveActiveFloorId(measureRef.current(), 0));
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => { setRevealed(false); }, REVEAL_IDLE_MS);
    };
    // Initial paint: land the highlight without revealing the rail.
    const initial = resolveActiveFloorId(measureRef.current(), 0);
    setActiveId((previous) => (previous === initial ? previous : initial));
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', onScroll);
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    };
  }, [entries.length, scrollRef]);

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
      {entries.map((entry, index) => {
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
      })}
    </nav>
  );
}
