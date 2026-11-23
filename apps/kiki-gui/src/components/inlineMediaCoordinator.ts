export const MAX_ACTIVE_INLINE_VIDEOS = 2;

const activeInlineVideos = new Map<symbol, () => void>();
const playingInlineMedia = new Set<HTMLMediaElement>();

/**
 * Register an active inline timeline `<video>` facade and release the oldest
 * active inline video when more than `MAX_ACTIVE_INLINE_VIDEOS` decoders would
 * be mounted simultaneously.
 */
export function activateInlineVideo(id: symbol, release: () => void): () => void {
  activeInlineVideos.delete(id);
  activeInlineVideos.set(id, release);
  while (activeInlineVideos.size > MAX_ACTIVE_INLINE_VIDEOS) {
    const oldest = activeInlineVideos.entries().next().value;
    if (oldest === undefined) break;
    const [oldestId, releaseOldest] = oldest;
    if (oldestId === id) break;
    activeInlineVideos.delete(oldestId);
    releaseOldest();
  }
  return () => {
    activeInlineVideos.delete(id);
  };
}

/** Pause any other inline timeline audio/video element when `element` begins playback. */
export function notifyInlineMediaPlay(element: HTMLMediaElement): void {
  for (const existing of Array.from(playingInlineMedia)) {
    if (existing === element) continue;
    playingInlineMedia.delete(existing);
    if (!existing.isConnected) continue;
    try {
      if (!existing.paused && !existing.ended) existing.pause();
    } catch {
      // Ignore synthetic/detached media element pause errors.
    }
  }
  playingInlineMedia.add(element);
}

/** Remove an unmounted or ended inline media element from the active coordinator set. */
export function unregisterInlineMediaElement(element: HTMLMediaElement | null | undefined): void {
  if (element === null || element === undefined) return;
  playingInlineMedia.delete(element);
}

/** React 19 ref callback that unregisters a media element on unmount or replacement. */
export function inlineMediaCleanupRef(element: HTMLMediaElement | null): (() => void) | undefined {
  if (element === null) return undefined;
  return () => {
    unregisterInlineMediaElement(element);
  };
}

/** Test-only reset helper for deterministic coordinator state between test cases. */
export function resetInlineMediaCoordinator(): void {
  activeInlineVideos.clear();
  playingInlineMedia.clear();
}
