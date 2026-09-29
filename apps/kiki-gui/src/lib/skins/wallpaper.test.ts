// @vitest-environment jsdom

/**
 * Wallpaper-switch robustness. The desktop froze when the wallpaper changed:
 * an 8K picture was decoded on the main thread at full size every time the
 * settings page re-created an element from it (each slider step), and each
 * step also re-read the file and walked the media store. These pin the
 * fixed behavior: one load and one downscale per picture, dial changes that
 * reuse the mounted element, and overlapping picks that end on the last one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BACKGROUND_LOOK } from '@kiki/protocol';

import { applyBackdrop, setBackdropMediaResolver, type MediaResolver } from './backdrop';
import type { BackgroundMediaRef, BackgroundSlot } from './background';
import { displayBlob, downscaleImage, resetDisplayMedia } from './displayMedia';
import { getMedia } from './mediaStore';
import { PACK_MEDIA_CACHE_BYTES, mediaResolverFor, resetPackMediaResolver } from './useAppearancePacks';

const image = (id: string): BackgroundMediaRef => ({ id, kind: 'image', mime: 'image/jpeg', name: `${id}.jpg`, bytes: 30_000_000 });
const slot = (ref: BackgroundMediaRef, look = {}): BackgroundSlot => ({
  media: [ref],
  interval: 0,
  look: { ...DEFAULT_BACKGROUND_LOOK, ...look },
  sample: { dark: 0.2, light: 0.8 },
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const shown = () => document.querySelector<HTMLImageElement>('img[data-kiki-backdrop-item]');

let created = 0;
beforeEach(() => {
  created = 0;
  URL.createObjectURL = vi.fn(() => `blob:kiki-${(created += 1)}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  applyBackdrop(null);
  setBackdropMediaResolver((ref) => getMedia(ref.id));
  resetDisplayMedia();
  vi.unstubAllGlobals();
});

describe('wallpaper switching', () => {
  it('loads a picture once and keeps its element through a burst of dial changes', async () => {
    const resolve = vi.fn<MediaResolver>(async () => new Blob(['x'], { type: 'image/jpeg' }));
    setBackdropMediaResolver(resolve);
    const ref = image('local-big-1');
    // A slider drag: the sync loop re-applies the slot on every input event,
    // the first ones before the bytes have even arrived.
    for (let step = 0; step < 30; step += 1) applyBackdrop(slot(ref, { blur: step }), true);
    await flush();
    const element = shown();
    expect(element).not.toBeNull();
    for (let step = 0; step < 30; step += 1) applyBackdrop(slot(ref, { blur: 30 - step, opacity: 0.5 }), true);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(shown()).toBe(element);
    // The element carries the latest dials, not the first ones.
    expect(element?.style.filter).toBe('blur(1px)');
    expect(element?.style.opacity).toBe('0.5');
    expect(created).toBe(1);
  });

  it('ends on the last pick when picks overlap, and frees what the superseded one made', async () => {
    const gates = new Map<string, () => void>();
    setBackdropMediaResolver((ref) => new Promise((done) => { gates.set(ref.id, () => { done(new Blob([ref.id], { type: 'image/jpeg' })); }); }));
    applyBackdrop(slot(image('local-first-1')), true);
    await flush();
    applyBackdrop(slot(image('local-second-1')), true);
    await flush();
    // The second file arrives first, then the slow first one.
    gates.get('local-second-1')!();
    await flush();
    gates.get('local-first-1')!();
    await flush();
    const urls = vi.mocked(URL.createObjectURL).mock.results.map((result) => result.value as string);
    expect(urls).toHaveLength(2);
    expect(shown()?.getAttribute('src')).toBe(urls[0]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[1]);
    expect(document.querySelectorAll('[data-kiki-backdrop-item]')).toHaveLength(1);
  });

  it('never mounts media after the background was removed mid-load', async () => {
    let release: (() => void) | undefined;
    setBackdropMediaResolver(() => new Promise((done) => { release = () => { done(new Blob(['v'], { type: 'video/mp4' })); }; }));
    applyBackdrop({ ...slot(image('local-vid-1')), media: [{ ...image('local-vid-1'), kind: 'video', mime: 'video/mp4' }] }, true);
    await flush();
    applyBackdrop(null);
    release!();
    await flush();
    expect(document.querySelector('[data-kiki-backdrop]')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(created);
  });
});

describe('display-sized copies', () => {
  it('computes a copy once per picture and edge, and forgets a missing file', async () => {
    const load = vi.fn(async () => new Blob(['x'], { type: 'image/png' }));
    const [a, b] = await Promise.all([displayBlob('local-a-1', 2560, load), displayBlob('local-a-1', 2560, load)]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
    await displayBlob('local-a-1', 320, load);
    expect(load).toHaveBeenCalledTimes(2);
    const missing = vi.fn(async () => null);
    expect(await displayBlob('local-gone-1', 2560, missing)).toBeNull();
    expect(await displayBlob('local-gone-1', 2560, missing)).toBeNull();
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it('downscales a picture larger than the edge off the main thread, and leaves one that fits', async () => {
    const closed: string[] = [];
    const bitmap = (width: number, height: number, name: string) => ({ width, height, close: () => { closed.push(name); } });
    const createImageBitmap = vi.fn(async (_source: unknown, options?: { resizeWidth?: number; resizeHeight?: number }) =>
      options?.resizeWidth === undefined ? bitmap(7680, 4320, 'source') : bitmap(options.resizeWidth, options.resizeHeight!, 'scaled'));
    const out = new Blob(['small'], { type: 'image/webp' });
    let size: [number, number] | null = null;
    class FakeOffscreenCanvas {
      constructor(width: number, height: number) { size = [width, height]; }
      getContext() { return { transferFromImageBitmap: () => undefined }; }
      convertToBlob() { return Promise.resolve(out); }
    }
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const original = new Blob(['huge'], { type: 'image/jpeg' });
    expect(await downscaleImage(original, 2560)).toBe(out);
    expect(size).toEqual([2560, 1440]);
    expect(closed).toContain('source');
    // Already small enough, a GIF (animation), or a video: the original.
    createImageBitmap.mockImplementationOnce(async () => bitmap(1600, 900, 'source'));
    expect(await downscaleImage(original, 2560)).toBe(original);
    const gif = new Blob(['g'], { type: 'image/gif' });
    expect(await downscaleImage(gif, 2560)).toBe(gif);
    const video = new Blob(['v'], { type: 'video/mp4' });
    expect(await downscaleImage(video, 2560)).toBe(video);
  });
});

describe('pack media resolver', () => {
  afterEach(() => { resetPackMediaResolver(); });

  it('is one resolver per server, so a second mount neither re-downloads nor keeps a second copy', async () => {
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['v'], { type: 'video/mp4' }) }));
    vi.stubGlobal('fetch', fetch);
    const endpoint = { url: 'http://127.0.0.1:1', token: 't' };
    const first = mediaResolverFor(endpoint);
    expect(mediaResolverFor({ ...endpoint })).toBe(first);
    await first({ id: 'pack:harbor/drift.mp4' });
    await mediaResolverFor(endpoint)({ id: 'pack:harbor/drift.mp4' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mediaResolverFor({ url: endpoint.url, token: 'other' })).not.toBe(first);
  });

  it('drops the oldest pack file once the cache passes its byte budget', async () => {
    const big = Math.ceil(PACK_MEDIA_CACHE_BYTES / 2) + 1;
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => ({ size: big, type: 'video/mp4' }) }));
    vi.stubGlobal('fetch', fetch);
    const resolve = mediaResolverFor({ url: 'http://127.0.0.1:1', token: '' });
    await resolve({ id: 'pack:a/drift.mp4' });
    await resolve({ id: 'pack:b/drift.mp4' });
    await flush();
    await resolve({ id: 'pack:b/drift.mp4' });
    expect(fetch).toHaveBeenCalledTimes(2);
    await resolve({ id: 'pack:a/drift.mp4' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
