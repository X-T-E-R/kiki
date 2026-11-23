import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { unregisterInlineMediaElement } from './inlineMediaCoordinator';

export interface ActiveTranscriptMediaSnapshot {
  readonly rowKey: string;
  readonly kind: 'audio' | 'video';
  readonly playing: boolean;
  readonly currentTimeSec: number;
  readonly durationSec?: number;
}

interface TrackedMediaEntry {
  readonly element: HTMLMediaElement;
  readonly rowKey: string;
  readonly kind: 'audio' | 'video';
  playing: boolean;
}

function isMediaElement(target: EventTarget | null): target is HTMLMediaElement {
  if (target === null || typeof target !== 'object' || !('tagName' in target)) return false;
  const tag = String((target as { tagName?: unknown }).tagName ?? '').toUpperCase();
  return tag === 'AUDIO' || tag === 'VIDEO';
}

function resolveRowKey(element: HTMLMediaElement): string | undefined {
  const rowEl = element.closest<HTMLElement>('[data-row-key]');
  const key = rowEl?.dataset['rowKey'];
  return key !== undefined && key !== '' ? key : undefined;
}

function safeSeconds(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function safeDuration(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function formatMediaClock(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function computeElementOffscreen(
  scrollElement: HTMLElement | null,
  element: HTMLMediaElement,
  rowIndex: number | undefined,
  visibleRange: { readonly startIndex: number; readonly endIndex: number } | null,
): boolean {
  if (scrollElement !== null && element.isConnected) {
    const scrollRect = scrollElement.getBoundingClientRect();
    const mediaRect = element.getBoundingClientRect();
    if (scrollRect.height > 0 && mediaRect.height > 0) {
      return mediaRect.bottom <= scrollRect.top + 8 || mediaRect.top >= scrollRect.bottom - 8;
    }
    const rowEl = element.closest<HTMLElement>('[data-row-key]');
    const rowRect = rowEl?.getBoundingClientRect();
    if (scrollRect.height > 0 && rowRect !== undefined && rowRect.height > 0) {
      return rowRect.bottom <= scrollRect.top + 8 || rowRect.top >= scrollRect.bottom - 8;
    }
  }
  if (rowIndex !== undefined && visibleRange !== null) {
    return rowIndex < visibleRange.startIndex || rowIndex > visibleRange.endIndex;
  }
  return false;
}

/**
 * Tracks actively playing `<audio>`/`<video>` elements inside the virtualized
 * transcript via capture-phase media listeners (HTML media events do not
 * bubble) so their owning virtual rows stay mounted in `pinnedIndexes` during
 * scroll and never interrupt playback.
 */
export function useActiveTranscriptMedia(params: {
  readonly scrollElement: HTMLElement | null;
  readonly nodeIndexes: ReadonlyMap<string, number>;
  readonly scopeKey: string;
}) {
  const { scrollElement, nodeIndexes, scopeKey } = params;
  const entriesRef = useRef(new Map<HTMLMediaElement, TrackedMediaEntry>());
  const primaryRef = useRef<HTMLMediaElement | null>(null);
  const nodeIndexesRef = useRef(nodeIndexes);
  nodeIndexesRef.current = nodeIndexes;
  const visibleRangeRef = useRef<{ readonly startIndex: number; readonly endIndex: number } | null>(null);
  const scrollElementRef = useRef(scrollElement);
  scrollElementRef.current = scrollElement;

  const [pinnedRowKeys, setPinnedRowKeys] = useState<readonly string[]>([]);
  const [activeMedia, setActiveMedia] = useState<ActiveTranscriptMediaSnapshot | null>(null);
  const [offscreen, setOffscreen] = useState(false);

  const syncState = useCallback(() => {
    const entries = entriesRef.current;
    for (const [el, entry] of Array.from(entries.entries())) {
      if (!el.isConnected || !nodeIndexesRef.current.has(entry.rowKey)) {
        entries.delete(el);
        if (primaryRef.current === el) primaryRef.current = null;
      }
    }

    let primary = primaryRef.current;
    if (primary === null || !entries.has(primary)) {
      primary = null;
      for (const [el, entry] of entries.entries()) {
        if (entry.playing) {
          primary = el;
          break;
        }
      }
      primaryRef.current = primary;
    }

    const nextKeys: string[] = [];
    const seen = new Set<string>();
    for (const [el, entry] of entries.entries()) {
      if (entry.playing || el === primary) {
        if (!seen.has(entry.rowKey)) {
          seen.add(entry.rowKey);
          nextKeys.push(entry.rowKey);
        }
      }
    }
    setPinnedRowKeys((prev) => (arraysEqual(prev, nextKeys) ? prev : nextKeys));

    if (primary === null) {
      setActiveMedia((prev) => (prev === null ? prev : null));
      setOffscreen((prev) => (prev ? false : prev));
      return;
    }

    const primaryEntry = entries.get(primary);
    if (primaryEntry === undefined) {
      setActiveMedia((prev) => (prev === null ? prev : null));
      setOffscreen((prev) => (prev ? false : prev));
      return;
    }

    const rowIndex = nodeIndexesRef.current.get(primaryEntry.rowKey);
    const nextOffscreen = computeElementOffscreen(
      scrollElementRef.current,
      primary,
      rowIndex,
      visibleRangeRef.current,
    );

    if (!primaryEntry.playing && !nextOffscreen) {
      entries.delete(primary);
      primaryRef.current = null;
      setPinnedRowKeys((prev) => (prev.length === 0 ? prev : []));
      setActiveMedia((prev) => (prev === null ? prev : null));
      setOffscreen((prev) => (prev ? false : prev));
      return;
    }

    const nextSnapshot: ActiveTranscriptMediaSnapshot = {
      rowKey: primaryEntry.rowKey,
      kind: primaryEntry.kind,
      playing: primaryEntry.playing,
      currentTimeSec: safeSeconds(primary.currentTime),
      durationSec: safeDuration(primary.duration),
    };
    setActiveMedia((prev) =>
      prev !== null &&
      prev.rowKey === nextSnapshot.rowKey &&
      prev.kind === nextSnapshot.kind &&
      prev.playing === nextSnapshot.playing &&
      prev.currentTimeSec === nextSnapshot.currentTimeSec &&
      prev.durationSec === nextSnapshot.durationSec
        ? prev
        : nextSnapshot,
    );
    setOffscreen((prev) => (prev === nextOffscreen ? prev : nextOffscreen));
  }, []);

  useEffect(() => {
    for (const el of Array.from(entriesRef.current.keys())) {
      unregisterInlineMediaElement(el);
      try {
        if (!el.paused && !el.ended) el.pause();
      } catch {
        // Ignore synthetic/detached media element pause errors.
      }
    }
    entriesRef.current.clear();
    primaryRef.current = null;
    setPinnedRowKeys([]);
    setActiveMedia(null);
    setOffscreen(false);
  }, [scopeKey]);

  useEffect(() => {
    if (scrollElement === null || activeMedia === null || typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(() => {
      for (const el of Array.from(entriesRef.current.keys())) {
        if (!el.isConnected) {
          unregisterInlineMediaElement(el);
          syncState();
          return;
        }
      }
    });
    observer.observe(scrollElement, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [scrollElement, activeMedia, syncState]);

  useEffect(() => {
    if (scrollElement === null) return;

    const handlePlay = (event: Event) => {
      if (!isMediaElement(event.target)) return;
      const el = event.target;
      const rowKey = resolveRowKey(el);
      if (rowKey === undefined) return;
      const kind: 'audio' | 'video' = el.tagName.toUpperCase() === 'VIDEO' ? 'video' : 'audio';
      for (const [other, entry] of Array.from(entriesRef.current.entries())) {
        if (other === el) continue;
        entry.playing = false;
        entriesRef.current.delete(other);
        try {
          if (!other.paused && !other.ended) other.pause();
        } catch {
          // Ignore synthetic/detached media element pause errors.
        }
      }
      entriesRef.current.set(el, { element: el, rowKey, kind, playing: true });
      primaryRef.current = el;
      syncState();
    };

    const handlePause = (event: Event) => {
      if (!isMediaElement(event.target)) return;
      const el = event.target;
      const entry = entriesRef.current.get(el);
      if (entry === undefined) return;
      entry.playing = false;
      const rowIndex = nodeIndexesRef.current.get(entry.rowKey);
      const isCurrentlyOffscreen = computeElementOffscreen(
        scrollElement,
        el,
        rowIndex,
        visibleRangeRef.current,
      );
      if (el !== primaryRef.current || !isCurrentlyOffscreen) {
        entriesRef.current.delete(el);
        if (primaryRef.current === el) primaryRef.current = null;
      }
      syncState();
    };

    const handleEnded = (event: Event) => {
      if (!isMediaElement(event.target)) return;
      const el = event.target;
      if (!entriesRef.current.has(el)) return;
      entriesRef.current.delete(el);
      if (primaryRef.current === el) primaryRef.current = null;
      syncState();
    };

    const handleTimeOrMeta = (event: Event) => {
      if (!isMediaElement(event.target)) return;
      if (event.target !== primaryRef.current) return;
      syncState();
    };

    const handleScroll = () => {
      if (primaryRef.current === null) return;
      syncState();
    };

    scrollElement.addEventListener('play', handlePlay, true);
    scrollElement.addEventListener('playing', handlePlay, true);
    scrollElement.addEventListener('pause', handlePause, true);
    scrollElement.addEventListener('ended', handleEnded, true);
    scrollElement.addEventListener('emptied', handleEnded, true);
    scrollElement.addEventListener('error', handleEnded, true);
    scrollElement.addEventListener('abort', handleEnded, true);
    scrollElement.addEventListener('timeupdate', handleTimeOrMeta, true);
    scrollElement.addEventListener('loadedmetadata', handleTimeOrMeta, true);
    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener('play', handlePlay, true);
      scrollElement.removeEventListener('playing', handlePlay, true);
      scrollElement.removeEventListener('pause', handlePause, true);
      scrollElement.removeEventListener('ended', handleEnded, true);
      scrollElement.removeEventListener('emptied', handleEnded, true);
      scrollElement.removeEventListener('error', handleEnded, true);
      scrollElement.removeEventListener('abort', handleEnded, true);
      scrollElement.removeEventListener('timeupdate', handleTimeOrMeta, true);
      scrollElement.removeEventListener('loadedmetadata', handleTimeOrMeta, true);
      scrollElement.removeEventListener('scroll', handleScroll);
    };
  }, [scrollElement, syncState]);

  const updateVisibleRange = useCallback((range: { readonly startIndex: number; readonly endIndex: number } | null) => {
    const prev = visibleRangeRef.current;
    if (prev?.startIndex === range?.startIndex && prev?.endIndex === range?.endIndex) return;
    visibleRangeRef.current = range;
    if (primaryRef.current !== null) syncState();
  }, [syncState]);

  const togglePlayback = useCallback(() => {
    const el = primaryRef.current;
    if (el === null) return;
    const entry = entriesRef.current.get(el);
    if (entry === undefined) return;
    if (entry.playing) {
      try { el.pause(); } catch { /* ignore */ }
      entry.playing = false;
      syncState();
    } else {
      entry.playing = true;
      syncState();
      try {
        const result = el.play();
        if (result !== undefined && typeof result.catch === 'function') {
          void result.catch(() => {
            entry.playing = false;
            syncState();
          });
        }
      } catch {
        entry.playing = false;
        syncState();
      }
    }
  }, [syncState]);

  const dismissPaused = useCallback(() => {
    const el = primaryRef.current;
    if (el !== null) {
      try {
        if (!el.paused && !el.ended) el.pause();
      } catch {
        // ignore
      }
      entriesRef.current.delete(el);
      primaryRef.current = null;
    }
    syncState();
  }, [syncState]);

  return {
    pinnedRowKeys,
    activeMedia,
    offscreen,
    updateVisibleRange,
    togglePlayback,
    dismissPaused,
  };
}

export function ActiveTranscriptMediaPill({
  media,
  offscreen,
  onToggle,
  onLocate,
  onDismiss,
}: {
  readonly media: ActiveTranscriptMediaSnapshot | null;
  readonly offscreen: boolean;
  readonly onToggle: () => void;
  readonly onLocate: (rowKey: string) => void;
  readonly onDismiss: () => void;
}) {
  if (media === null || !offscreen) return null;
  const clock = media.durationSec !== undefined
    ? `${formatMediaClock(media.currentTimeSec)} / ${formatMediaClock(media.durationSec)}`
    : formatMediaClock(media.currentTimeSec);
  return (
    <div className="pointer-events-none absolute top-3 right-6 z-20 flex justify-end">
      <div
        data-active-media-pill
        data-active-media-kind={media.kind}
        data-active-media-state={media.playing ? 'playing' : 'paused'}
        className="pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full border border-hairline bg-paper/95 pl-1 pr-2 text-[11.5px] text-ink shadow-sm backdrop-blur-sm"
      >
        <button
          type="button"
          data-active-media-toggle
          onClick={onToggle}
          aria-label={media.playing ? 'Pause' : 'Play'}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-ink transition-colors hover:bg-ink/[0.08] focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          {media.playing ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <rect x="1.5" y="1.5" width="2.4" height="7" rx="0.6" />
              <rect x="6.1" y="1.5" width="2.4" height="7" rx="0.6" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <path d="M2.4 1.6L8.6 5L2.4 8.4V1.6Z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          data-active-media-locate
          onClick={() => { onLocate(media.rowKey); }}
          className="inline-flex h-5 items-center gap-1.5 rounded-full px-1 font-mono text-[11px] tabular-nums text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <span>{clock}</span>
          <Icon name="arrowUp" size={12} className="text-ink-faint" />
        </button>
        {!media.playing ? (
          <button
            type="button"
            data-active-media-dismiss
            onClick={onDismiss}
            aria-label="Close"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
