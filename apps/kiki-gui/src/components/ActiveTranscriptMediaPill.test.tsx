// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ActiveTranscriptMediaPill, useActiveTranscriptMedia } from './ActiveTranscriptMediaPill';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function Harness({
  initialRange,
  onLocate,
}: {
  readonly initialRange: { readonly startIndex: number; readonly endIndex: number };
  readonly onLocate: (rowKey: string) => void;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [range, setRange] = useState(initialRange);
  const nodeIndexes = new Map<string, number>([
    ['row-0', 0],
    ['row-1', 1],
    ['row-20', 20],
  ]);
  const media = useActiveTranscriptMedia({
    scrollElement: scrollEl,
    nodeIndexes,
    scopeKey: 'session-1\0main',
  });
  const { updateVisibleRange } = media;
  useEffect(() => {
    updateVisibleRange(range);
  }, [updateVisibleRange, range]);

  const showRow20 = media.pinnedRowKeys.includes('row-20') || (range.startIndex <= 20 && range.endIndex >= 20);

  return (
    <div className="relative">
      <button type="button" data-scroll-up onClick={() => { setRange({ startIndex: 0, endIndex: 5 }); }} />
      <button type="button" data-scroll-back onClick={() => { setRange({ startIndex: 15, endIndex: 25 }); }} />
      <div ref={setScrollEl} data-scroll-container>
        <div data-row-key="row-0">top</div>
        {showRow20 ? (
          <div data-row-key="row-20">
            <audio data-test-audio controls preload="none" src="https://example.test/voice.mp3" />
          </div>
        ) : null}
      </div>
      <ActiveTranscriptMediaPill
        media={media.activeMedia}
        offscreen={media.offscreen}
        onToggle={media.togglePlayback}
        onLocate={onLocate}
        onDismiss={media.dismissPaused}
      />
    </div>
  );
}

describe('useActiveTranscriptMedia and ActiveTranscriptMediaPill', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('pins the playing audio row across scroll-away, renders the compact offscreen pill, and unpins on ended', async () => {
    const locateSpy = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<Harness initialRange={{ startIndex: 15, endIndex: 25 }} onLocate={locateSpy} />);
      });

      const audio = container.querySelector<HTMLAudioElement>('[data-test-audio]');
      expect(audio).not.toBeNull();
      const pauseSpy = vi.spyOn(audio!, 'pause').mockImplementation(() => {});
      const playSpy = vi.spyOn(audio!, 'play').mockResolvedValue(undefined);
      Object.defineProperty(audio!, 'currentTime', { value: 65, configurable: true, writable: true });
      Object.defineProperty(audio!, 'duration', { value: 185, configurable: true });

      // Start playback via non-bubbling HTML media 'play' event (captured at scroll container).
      await act(async () => {
        audio!.dispatchEvent(new Event('play', { bubbles: false }));
      });
      // Pill stays hidden while row is still in viewport.
      expect(container.querySelector('[data-active-media-pill]')).toBeNull();

      // Scroll far upward: row-20 leaves visible range, stays mounted via pinnedRowKeys, pill appears.
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-scroll-up]')!.click();
      });
      expect(container.querySelector('[data-test-audio]')).toBe(audio);
      const pill = container.querySelector<HTMLElement>('[data-active-media-pill]');
      expect(pill).not.toBeNull();
      expect(pill?.dataset['activeMediaState']).toBe('playing');
      expect(pill?.textContent).toContain('01:05 / 03:05');

      // Clicking locate jumps back to row-20.
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-active-media-locate]')!.click();
      });
      expect(locateSpy).toHaveBeenCalledWith('row-20');

      // Pausing from offscreen pill keeps row pinned so user can resume without losing audio position.
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-active-media-toggle]')!.click();
      });
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-test-audio]')).toBe(audio);
      expect(container.querySelector<HTMLElement>('[data-active-media-pill]')?.dataset['activeMediaState']).toBe('paused');

      // Resuming from offscreen pill calls play() on the same unbroken DOM audio element.
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-active-media-toggle]')!.click();
      });
      expect(playSpy).toHaveBeenCalledTimes(1);

      // Ended unpins the row and hides the pill.
      await act(async () => {
        audio!.dispatchEvent(new Event('ended', { bubbles: false }));
      });
      expect(container.querySelector('[data-active-media-pill]')).toBeNull();
      expect(container.querySelector('[data-test-audio]')).toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('detects offscreen media inside a still-intersecting tall row and clears tracking when the media node detaches', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<Harness initialRange={{ startIndex: 15, endIndex: 25 }} onLocate={() => {}} />);
      });
      const scrollEl = container.querySelector<HTMLElement>('[data-scroll-container]')!;
      const rowEl = container.querySelector<HTMLElement>('[data-row-key="row-20"]')!;
      const audio = container.querySelector<HTMLAudioElement>('[data-test-audio]')!;

      vi.spyOn(scrollEl, 'getBoundingClientRect').mockReturnValue({
        top: 0, bottom: 500, left: 0, right: 400, width: 400, height: 500, x: 0, y: 0, toJSON: () => ({}),
      });
      vi.spyOn(rowEl, 'getBoundingClientRect').mockReturnValue({
        top: -200, bottom: 300, left: 0, right: 400, width: 400, height: 500, x: 0, y: -200, toJSON: () => ({}),
      });
      vi.spyOn(audio, 'getBoundingClientRect').mockReturnValue({
        top: -120, bottom: -80, left: 0, right: 200, width: 200, height: 40, x: 0, y: -120, toJSON: () => ({}),
      });

      await act(async () => {
        audio.dispatchEvent(new Event('play', { bubbles: false }));
      });
      expect(container.querySelector('[data-active-media-pill]')).not.toBeNull();

      await act(async () => {
        audio.remove();
        await Promise.resolve();
      });
      expect(container.querySelector('[data-active-media-pill]')).toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
