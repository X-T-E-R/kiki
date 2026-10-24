// @vitest-environment jsdom
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { MediaLightbox } from './MediaLightbox';
import { clearToasts, getToasts } from '../lib/toasts';
import { renderAnnotatedImage, type ImageAnnotation } from './ImageViewportAnnotations';

let root: Root;
let container: HTMLDivElement;

function renderLightbox(props: Partial<Parameters<typeof MediaLightbox>[0]> & { src?: string }) {
  act(() => {
    root.render(<I18nProvider><MediaLightbox src={props.src ?? 'data:image/png;base64,AAAA'} name={props.name} identity={props.identity} loading={props.loading} failed={props.failed} onRetry={props.onRetry} index={props.index} count={props.count} onSelect={props.onSelect} onClose={props.onClose ?? (() => {})} mime={props.mime} size={props.size} sourcePath={props.sourcePath} linkUrl={props.linkUrl} remote={props.remote} /></I18nProvider>);
  });
}

function loadImage(width: number, height: number) {
  const image = document.querySelector('img')!;
  Object.defineProperty(image, 'naturalWidth', { configurable: true, get: () => width });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, get: () => height });
  act(() => { image.dispatchEvent(new Event('load')); });
  return image;
}

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  Element.prototype.setPointerCapture = () => {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('lightbox viewing', () => {
  it('fits a wide image and a narrow long image to available area and pages scroller at actual size', () => {
    renderLightbox({ name: 'wide.png' });
    const wide = loadImage(2000, 80);
    expect(wide.className).toContain('h-auto');
    expect(wide.className).toContain('w-full');
    expect(wide.className).not.toContain('object-contain');
    expect(document.querySelector('[data-lightbox-viewport]')?.getAttribute('data-lightbox-viewport')).toBe('fit');
    expect((wide.parentElement as HTMLElement).style.width).toBe(`${Math.min(2000, window.innerWidth * 0.92)}px`);

    renderLightbox({ name: 'tall.png', identity: 'tall' });
    const tall = loadImage(80, 900);
    // In fit mode, fits within window.innerHeight * 0.75
    const expectedFitWidth = 80 * Math.min(1, (window.innerWidth * 0.92) / 80, (window.innerHeight * 0.75) / 900);
    expect((tall.parentElement as HTMLElement).style.width).toBe(`${expectedFitWidth}px`);

    // Toggle to actual size, where tall image reaches full natural width 80px and height 900px, enabling page scrolling
    const zoomButton = document.querySelector<HTMLButtonElement>('button[data-autofocus]')!;
    act(() => { zoomButton.click(); });
    expect((tall.parentElement as HTMLElement).style.width).toBe('80px');

    const scroller = document.querySelector<HTMLDivElement>('[data-lightbox-viewport]')!;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
    scroller.scrollTop = 0;
    act(() => { document.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })); });
    expect(scroller.scrollTop).toBe(170);
  });

  it('moves between images from the controls and from the keyboard, including after a failed image', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderLightbox({ name: 'one.png', index: 0, count: 2, onSelect, onClose });
    const previous = document.querySelector<HTMLButtonElement>('[aria-label="Previous image"]')!;
    const next = document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!;
    expect(previous.disabled).toBe(true);
    expect(document.body.textContent).toContain('1 / 2');
    act(() => { next.click(); });
    expect(onSelect).toHaveBeenCalledWith(1);
    act(() => { document.querySelector('[aria-label="Next image"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(onSelect).toHaveBeenCalledTimes(2);

    renderLightbox({ failed: true, index: 0, count: 2, onSelect, onClose, identity: 'broken' });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    act(() => { document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(); });
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('draws in natural pixels, keeps the drawing on save failure, and drops it on cancel', async () => {
    const onClose = vi.fn();
    renderLightbox({ name: 'marked.png', onClose });
    loadImage(400, 200);
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Annotate image')!.click(); });
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Annotation mode');
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Rectangle')!.click(); });
    const svg = document.querySelector<SVGSVGElement>('[data-image-annotations]')!;
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON() { return {}; } });
    const point = (type: string, x: number, y: number) => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
    act(() => { point('pointerdown', 50, 25); point('pointermove', 100, 50); point('pointerup', 100, 50); });
    const rect = svg.querySelector('rect')!;
    expect(rect.getAttribute('x')).toBe('100');
    expect(rect.getAttribute('y')).toBe('50');
    expect(rect.getAttribute('width')).toBe('100');
    expect(rect.getAttribute('height')).toBe('50');

    const OriginalImage = globalThis.Image;
    vi.stubGlobal('Image', class {
      crossOrigin: string | null = null;
      src = '';
      decode() { return Promise.reject(new Error('tainted')); }
    });
    try {
      act(() => { svg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 })); });
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-menu-item="save-annotated-image"]')!.click();
        await Promise.resolve();
      });
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save the annotated image');
      expect(svg.querySelector('rect')).not.toBeNull();
      act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click(); });
      expect(document.querySelector('[data-image-annotations] rect')).toBeNull();
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('Image', OriginalImage);
    }
  });

  it('defaults to fit on open, toggles to actual size and back, and resets to fit on image change or reopen', () => {    renderLightbox({ name: 'reset-test-1.png', identity: 'img-1' });
    const img1 = loadImage(1000, 500);
    const viewport = () => document.querySelector('[data-lightbox-viewport]');
    const zoomButton = () => document.querySelector<HTMLButtonElement>('button[data-autofocus]');

    // 1. Opens with fit by default
    expect(viewport()?.getAttribute('data-lightbox-viewport')).toBe('fit');
    expect(zoomButton()?.textContent).toBe('Actual size');

    // 2. Click toggles to actual size
    act(() => { zoomButton()?.click(); });
    expect(viewport()?.getAttribute('data-lightbox-viewport')).toBe('actual');
    expect(zoomButton()?.textContent).toBe('Fit to screen');

    // 3. Image click toggles back to fit
    act(() => { img1.click(); });
    expect(viewport()?.getAttribute('data-lightbox-viewport')).toBe('fit');
    expect(zoomButton()?.textContent).toBe('Actual size');

    // 4. Toggle back to actual size, then switch identity (next image)
    act(() => { zoomButton()?.click(); });
    expect(viewport()?.getAttribute('data-lightbox-viewport')).toBe('actual');

    renderLightbox({ name: 'reset-test-2.png', identity: 'img-2' });
    loadImage(800, 600);
    // Verified: Resets to fit by default on new image identity
    expect(viewport()?.getAttribute('data-lightbox-viewport')).toBe('fit');
    expect(zoomButton()?.textContent).toBe('Actual size');

    // 5. Toggle to actual size, close, and reopen with the SAME identity
    act(() => { zoomButton()?.click(); });
    expect(viewport()?.getAttribute('data-lightbox-viewport')).toBe('actual');

    // Close lightbox (unmount)
    act(() => { root.render(null); });
    expect(document.querySelector('[data-lightbox-viewport]')).toBeNull();

    // Reopen with the SAME identity 'img-2'
    renderLightbox({ name: 'reset-test-2.png', identity: 'img-2' });
    loadImage(800, 600);
    // Verified: Reopening with the same identity mounts afresh with fit by default
    expect(viewport()?.getAttribute('data-lightbox-viewport')).toBe('fit');
    expect(zoomButton()?.textContent).toBe('Actual size');

    // 6. Window resize recalculates display width while remaining open
    act(() => {
      window.innerWidth = 500;
      window.innerHeight = 400;
      window.dispatchEvent(new Event('resize'));
    });
    const resizedStyleWidth = (document.querySelector('[data-lightbox-viewport] img')?.parentElement as HTMLElement).style.width;
    const expectedResized = 800 * Math.min(1, (500 * 0.92) / 800, (400 * 0.75) / 600);
    expect(resizedStyleWidth).toBe(`${expectedResized}px`);
  });
});

describe('lightbox zoom controls and details', () => {
  const zoomSlider = () => document.querySelector<HTMLInputElement>('[data-lightbox-zoom-slider]')!;
  const zoomLabel = () => document.querySelector('[data-lightbox-zoom]')?.textContent;
  const setSlider = (value: number) => {
    const slider = zoomSlider();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(slider, String(value));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  beforeEach(() => {
    window.innerWidth = 1024;
    window.innerHeight = 768;
  });

  it('steps up to 500% with the buttons and hands the picture back to fit from the chip', () => {
    renderLightbox({ name: 'long.png' });
    const picture = loadImage(1940, 5170);
    const zoomIn = document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
    const zoomOut = document.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!;
    for (let step = 0; step < 12; step += 1) act(() => { zoomIn.click(); });
    expect(zoomSlider().value).toBe('500');
    expect(zoomLabel()).toBe('500%');
    expect(document.querySelector('[data-lightbox-viewport]')?.getAttribute('data-lightbox-viewport')).toBe('custom');
    expect((picture.parentElement as HTMLElement).style.width).toBe(`${1940 * 5}px`);
    expect(zoomIn.disabled).toBe(true);

    act(() => { zoomOut.click(); });
    expect(zoomLabel()).toBe('400%');

    act(() => { document.querySelector<HTMLButtonElement>('button[data-autofocus]')!.click(); });
    const fitPercent = Math.round(Math.min(1, (1024 * 0.92) / 1940, (768 * 0.75) / 5170) * 100);
    expect(zoomLabel()).toBe(`${fitPercent}%`);
    expect(document.querySelector('[data-lightbox-viewport]')?.getAttribute('data-lightbox-viewport')).toBe('fit');
  });

  it('takes an exact percentage from the slider and keeps fit and 100% one key away', () => {
    renderLightbox({ name: 'long.png' });
    const picture = loadImage(1000, 500);
    setSlider(250);
    expect(zoomLabel()).toBe('250%');
    expect((picture.parentElement as HTMLElement).style.width).toBe('2500px');

    act(() => { picture.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); });
    expect(zoomLabel()).toBe('100%');
    expect(document.querySelector('[data-lightbox-viewport]')?.getAttribute('data-lightbox-viewport')).toBe('actual');

    act(() => { picture.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })); });
    expect(document.querySelector('[data-lightbox-viewport]')?.getAttribute('data-lightbox-viewport')).toBe('fit');
  });

  it('shows the details it holds and strips credentials from a link', () => {
    renderLightbox({ name: 'long.png', mime: 'image/png', size: 155769, linkUrl: 'https://example.test/shot.png?token=secret' });
    loadImage(1940, 5170);
    expect(document.querySelector('[data-lightbox-info]')).toBeNull();
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Image details"]')!;
    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const info = document.querySelector('[data-lightbox-info]')!;
    expect(info.textContent).toContain('1940 × 5170');
    expect(info.textContent).toContain('image/png');
    expect(info.textContent).toContain('152 KB');
    expect(info.querySelector('[data-lightbox-source]')?.textContent).toBe('https://example.test/shot.png?…');
    expect(info.textContent).not.toContain('secret');
  });

  it('does not present a remote path as a local one and shows a real local path', () => {
    renderLightbox({ name: 'shot.png', sourcePath: '/C:/fixture/viewer/shot.png' });
    loadImage(80, 90);
    act(() => { document.querySelector<HTMLButtonElement>('[aria-label="Image details"]')!.click(); });
    expect(document.querySelector('[data-lightbox-source]')?.textContent).toBe('/C:/fixture/viewer/shot.png');

    renderLightbox({ name: 'shot.png', identity: 'remote', remote: true, sourcePath: '/srv/images/shot.png' });
    loadImage(80, 90);
    act(() => { document.querySelector<HTMLButtonElement>('[aria-label="Image details"]')!.click(); });
    expect(document.querySelector('[data-lightbox-info]')?.textContent).not.toContain('/srv/images');
    expect(document.querySelector('[data-lightbox-source]')).toBeNull();
  });

  it('drops the old measurements when a retry finally loads the image', () => {
    const onRetry = vi.fn();
    renderLightbox({ name: 'retry.png', onRetry });
    loadImage(100, 50);
    act(() => { document.querySelector('[data-lightbox-viewport] img')!.dispatchEvent(new Event('error')); });
    expect(document.querySelector('[data-lightbox-failure]')).not.toBeNull();
    act(() => { document.querySelector<HTMLButtonElement>('[data-lightbox-failure] button')!.click(); });
    expect(onRetry).toHaveBeenCalledOnce();
    const reloaded = loadImage(300, 150);
    expect((reloaded.parentElement as HTMLElement).style.width).toBe(`${Math.min(300, 1024 * 0.92)}px`);
  });

  it('reports a refused clipboard write in the reader words and keeps the cause beneath it', async () => {
    clearToasts();
    const denied = new Error('Write permission denied.');
    renderLightbox({ name: 'shot.png', src: 'https://example.test/shot.png' });
    loadImage(400, 200);
    vi.stubGlobal('fetch', vi.fn(async () => { throw denied; }));
    vi.stubGlobal('Image', class { crossOrigin: string | null = null; src = ''; decode() { return Promise.reject(denied); } });
    try {
      act(() => { document.querySelector('[data-lightbox-viewport]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 })); });
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-menu-item="copy-image"]')!.click();
        await Promise.resolve();
      });
      const toasts = getToasts();
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.text).toBe('Could not copy the image. Try downloading it instead.');
      expect(toasts[0]?.detail).toContain('Write permission denied.');
      expect(toasts[0]?.retry).toBeDefined();
    } finally {
      clearToasts();
    }
  });
});

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

function installRasterCanvas() {
  const pixels = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
  const proto = HTMLCanvasElement.prototype as HTMLCanvasElement & { toBlob?: (callback: BlobCallback) => void };
  const originalContext = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return originalContext.call(this, kind);
    return rasterContext(this);
  } as typeof HTMLCanvasElement.prototype.getContext;
  function rasterContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    let strokeStyle = '#000000';
    let lineWidth = 1;
    const commands: { op: 'move' | 'line' | 'rect'; x: number; y: number; w?: number; h?: number }[] = [];
    const buffer = () => {
      let data = pixels.get(canvas);
      if (data === undefined || data.length !== canvas.width * canvas.height * 4) {
        data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        pixels.set(canvas, data);
      }
      return data;
    };
    const color = () => {
      const match = /^#([0-9a-f]{6})$/i.exec(strokeStyle);
      const value = match === null ? 0 : Number.parseInt(match[1]!, 16);
      return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255] as const;
    };
    const plot = (x: number, y: number) => {
      const data = buffer();
      const [red, green, blue, alpha] = color();
      const radius = Math.max(0, Math.round(lineWidth / 2) - 1);
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const px = Math.round(x) + dx;
          const py = Math.round(y) + dy;
          if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
          const offset = (py * canvas.width + px) * 4;
          data[offset] = red; data[offset + 1] = green; data[offset + 2] = blue; data[offset + 3] = alpha;
        }
      }
    };
    const line = (x0: number, y0: number, x1: number, y1: number) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let step = 0; step <= steps; step += 1) plot(x0 + (x1 - x0) * step / steps, y0 + (y1 - y0) * step / steps);
    };
    return {
      set strokeStyle(value: string) { strokeStyle = value; },
      get strokeStyle() { return strokeStyle; },
      set lineWidth(value: number) { lineWidth = value; },
      get lineWidth() { return lineWidth; },
      lineCap: 'round',
      lineJoin: 'round',
      beginPath() { commands.length = 0; },
      moveTo(x: number, y: number) { commands.push({ op: 'move', x, y }); },
      lineTo(x: number, y: number) { commands.push({ op: 'line', x, y }); },
      rect(x: number, y: number, w: number, h: number) { commands.push({ op: 'rect', x, y, w, h }); },
      drawImage() {
        const data = buffer();
        for (let index = 0; index < data.length; index += 4) {
          data[index] = 20; data[index + 1] = 40; data[index + 2] = 80; data[index + 3] = 255;
        }
      },
      stroke() {
        let cursor: { x: number; y: number } | undefined;
        for (const command of commands) {
          if (command.op === 'move') cursor = command;
          else if (command.op === 'line' && cursor !== undefined) { line(cursor.x, cursor.y, command.x, command.y); cursor = command; }
          else if (command.op === 'rect') {
            const x = command.x; const y = command.y; const w = command.w ?? 0; const h = command.h ?? 0;
            line(x, y, x + w, y); line(x + w, y, x + w, y + h); line(x + w, y + h, x, y + h); line(x, y + h, x, y);
          }
        }
      },
    } as unknown as CanvasRenderingContext2D;
  }
  proto.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback) {
    const data = pixels.get(this);
    if (data === undefined) { callback(null); return; }
    const raw = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (this.width * 4 + 1)] = 0;
      Buffer.from(data.buffer, data.byteOffset + y * this.width * 4, this.width * 4).copy(raw, y * (this.width * 4 + 1) + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8;
    header[9] = 6;
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    callback(new Blob([png], { type: 'image/png' }));
  };
}

function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(new Uint8Array(reader.result as ArrayBuffer)); };
    reader.onerror = () => { reject(reader.error); };
    reader.readAsArrayBuffer(blob);
  });
}

function decodePng(bytes: Uint8Array) {
  const png = Buffer.from(bytes);
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') parts.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) rgba.set(raw.subarray(y * (width * 4 + 1) + 1, y * (width * 4 + 1) + 1 + width * 4), y * width * 4);
  return { width, height, rgba };
}

describe('annotated export', () => {
  it('rasters marks at the original pixel size and leaves the interior untouched', async () => {
    installRasterCanvas();
    const size = { width: 160, height: 40 };
    const seen: string[] = [];
    vi.stubGlobal('Image', class {
      crossOrigin: string | null = null;
      src = '';
      get naturalWidth() { return size.width; }
      get naturalHeight() { return size.height; }
      decode() { seen.push(this.crossOrigin ?? '', this.src); return Promise.resolve(); }
    });
    const rect: ImageAnnotation = { id: 1, tool: 'rectangle', points: [{ x: 8, y: 6 }, { x: 40, y: 28 }] };
    const wide = await renderAnnotatedImage('blob:wide', [rect]);
    const wideBytes = await blobBytes(wide);
    const wideImage = decodePng(wideBytes);
    expect(seen).toEqual(['anonymous', 'blob:wide']);
    expect(wideImage).toMatchObject({ width: 160, height: 40 });
    expect([wideImage.rgba[0], wideImage.rgba[1], wideImage.rgba[2]]).toEqual([20, 40, 80]);
    const edge = (6 * 160 + 8) * 4;
    expect([wideImage.rgba[edge], wideImage.rgba[edge + 1], wideImage.rgba[edge + 2]]).toEqual([239, 68, 68]);
    const interior = (16 * 160 + 24) * 4;
    expect([wideImage.rgba[interior], wideImage.rgba[interior + 1], wideImage.rgba[interior + 2]]).toEqual([20, 40, 80]);

    size.width = 40;
    size.height = 180;
    const tall = await renderAnnotatedImage('blob:tall', [{ id: 2, tool: 'arrow', points: [{ x: 4, y: 10 }, { x: 30, y: 80 }] }]);
    const tallBytes = await blobBytes(tall);
    const tallImage = decodePng(tallBytes);
    expect(tallImage).toMatchObject({ width: 40, height: 180 });
    const tail = (10 * 40 + 4) * 4;
    expect([tallImage.rgba[tail], tallImage.rgba[tail + 1], tallImage.rgba[tail + 2]]).toEqual([239, 68, 68]);

    const directory = tmpdir();
    const widePath = join(directory, 'kiki-viewer-wide-annotated.png');
    const tallPath = join(directory, 'kiki-viewer-tall-annotated.png');
    writeFileSync(widePath, Buffer.from(wideBytes));
    writeFileSync(tallPath, Buffer.from(tallBytes));
    expect(widePath).toContain('kiki-viewer-wide-annotated.png');
    expect(tallPath).toContain('kiki-viewer-tall-annotated.png');
  });
});
