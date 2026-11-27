// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useVisualViewportHeightVar } from './layoutHooks';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.style.removeProperty('--kiki-ime-height');
  delete document.documentElement.dataset['keyboard'];
  while (roots.length > 0) roots.pop()?.unmount();
  while (containers.length > 0) containers.pop()?.remove();
});

describe('useVisualViewportHeightVar (--kiki-ime-height & touch-drag blur seam)', () => {
  it('subtracts native --kiki-ime-height from reference height and toggles :root[data-keyboard]', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 915 });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    containers.push(container);

    function Probe() {
      useVisualViewportHeightVar();
      return (
        <div>
          <div data-transcript-scroll="">Transcript</div>
          <div data-composer-root="">
            <textarea data-test-input="" />
          </div>
        </div>
      );
    }

    act(() => {
      root.render(<Probe />);
    });

    // Simulate Slice 2 native Android/iOS WindowInsetsAnimation writing --kiki-ime-height
    await act(async () => {
      document.documentElement.style.setProperty('--kiki-ime-height', '398px');
      await Promise.resolve();
    });

    expect(document.documentElement.style.getPropertyValue('--kiki-visual-height')).toBe('517px');
    expect(Object.hasOwn(document.documentElement.dataset, 'keyboard')).toBe(true);

    // 32px downward touch drag inside transcript blurs focused composer textarea
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-test-input]')!;
    const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    act(() => {
      scroller.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          touches: [{ clientX: 120, clientY: 200 } as Touch],
        }),
      );
      scroller.dispatchEvent(
        new TouchEvent('touchmove', {
          bubbles: true,
          touches: [{ clientX: 122, clientY: 245 } as Touch],
        }),
      );
    });
    expect(document.activeElement).not.toBe(textarea);

    // Clearing --kiki-ime-height settles data-keyboard after 40ms
    await act(async () => {
      document.documentElement.style.setProperty('--kiki-ime-height', '0px');
      await Promise.resolve();
    });
    expect(Object.hasOwn(document.documentElement.dataset, 'keyboard')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(Object.hasOwn(document.documentElement.dataset, 'keyboard')).toBe(false);
  });
});
