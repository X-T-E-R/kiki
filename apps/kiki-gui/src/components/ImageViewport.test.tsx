// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { ImageViewport } from './ImageViewport';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('devicePixelRatio', 1);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ImageViewport', () => {
  it('displays true fitted zoom percentage and supports Ctrl+Wheel zoom', () => {
    act(() => {
      root.render(
        <I18nProvider>
          <ImageViewport src="data:image/png;base64,AAAA" alt="wide.png" caption="wide.png" />
        </I18nProvider>,
      );
    });
    const scroller = container.querySelector<HTMLDivElement>('[data-image-viewport]')!;
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 424 });
    // Trigger re-render with updated scroller measurement via resize/load
    act(() => {
      root.render(
        <I18nProvider>
          <ImageViewport src="data:image/png;base64,BBBB" alt="wide.png" caption="wide.png" />
        </I18nProvider>,
      );
    });
    const img = container.querySelector<HTMLImageElement>('img')!;
    Object.defineProperty(img, 'naturalWidth', { configurable: true, get: () => 4000 });
    Object.defineProperty(img, 'naturalHeight', { configurable: true, get: () => 2000 });
    act(() => { img.dispatchEvent(new Event('load')); });

    const percentEl = container.querySelector('[data-image-zoom-percent]');
    expect(percentEl?.textContent).toBe('10%');
    const slider = container.querySelector<HTMLInputElement>('[data-image-zoom-slider]')!;
    expect(slider.value).toBe('10');

    // Ctrl+Wheel zooms in relative to actual fitted percentage instead of jumping from 100%
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    const zoomed = Number.parseInt(container.querySelector('[data-image-zoom-percent]')!.textContent!, 10);
    expect(zoomed).toBeGreaterThan(10);
    expect(zoomed).toBeLessThan(50);
  });
});
