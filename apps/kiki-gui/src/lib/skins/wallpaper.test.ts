// @vitest-environment jsdom

/**
 * Wallpaper-switch robustness. The desktop froze when the wallpaper changed:
 * an 8K picture was decoded on the main thread at full size every time the
 * settings page re-created an element from it (each slider step), and each
 * step also re-read the file and walked the media store. These pin the
 * fixed behavior: one load and one downscale per picture, dial changes that
 * reuse the mounted element, and overlapping picks that end on the last one.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BACKGROUND_LOOK } from '@kiki/protocol';

import { applyBackdrop, setBackdropMediaResolver, type MediaResolver } from './backdrop';
import type { BackgroundMediaRef, BackgroundSlot } from './background';
import { displayBlob, downscaleImage, resetDisplayMedia } from './displayMedia';
import { getMedia, isPersistent, putMedia, resetMediaStore } from './mediaStore';
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

describe('wallpaper material', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../../styles/skin.css'), 'utf8');
  const rule = (selector: string) => {
    const start = css.search(new RegExp(`${selector.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,{ ]`));
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('\n}', start));
  };
  /** Every rule whose selector list starts with `selector`. A selector may be
   * shared by the base rule and a scoped override, so tests that pin the
   * override ask for all of them rather than the first. */
  const rules = (selector: string) => {
    const pattern = new RegExp(`${selector.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,{ ]`, 'g');
    const found: string[] = [];
    for (let match = pattern.exec(css); match !== null; match = pattern.exec(css)) {
      found.push(css.slice(match.index, css.indexOf('\n}', match.index)));
    }
    expect(found.length, selector).toBeGreaterThanOrEqual(1);
    return found;
  };

  it('makes the application shell transparent even inside root wrappers', () => {
    const shell = rule(':root[data-kiki-bg] #root .bg-canvas:has(> .app-stage)');
    expect(shell).toContain('background-color: transparent;');
    expect(css).toContain(':root[data-kiki-bg] #root > .bg-canvas,');
  });

  it('frosts the entire scoped backdrop, including the gaps outside sheets', () => {
    const frost = rule(':root[data-kiki-bg] [data-kiki-backdrop]::after');
    expect(frost).toContain("content: '';");
    expect(frost).toContain('position: absolute;');
    expect(frost).toContain('inset: 0;');
    expect(frost).toContain('-webkit-backdrop-filter: var(--kiki-surface-filter);');
    expect(frost).toContain('\n  backdrop-filter: var(--kiki-surface-filter);');
    expect(frost).not.toMatch(/background(?:-color)?:/);
  });

  it('keeps one opacity dial and does not blur the wallpaper twice under panels', () => {
    for (const [selector, surface] of [
      [":root:is([data-kiki-bg='window'], [data-kiki-bg='sidebar']) .app-sidebar", 'canvas'],
      [":root:is([data-kiki-bg='window'], [data-kiki-bg='main']) .app-sheet > .conversation-shell .conversation-center", 'paper'],
      [":root:is([data-kiki-bg='window'], [data-kiki-bg='main']) :is(.app-rail, [data-preview-workspace])", 'panel'],
    ]) {
      const panel = rule(selector!);
      expect(panel).toContain(`var(--kiki-surface-${surface})`);
      expect(panel).not.toContain('backdrop-filter:');
      expect(panel).toContain('isolation: isolate;');
      expect(css).toContain(`--kiki-surface-${surface}: color-mix(in srgb, var(--color-${surface}) var(--kiki-surface-alpha, 100%), transparent);`);
    }
    expect(css).not.toContain('blur(12px)');
    expect(rule('@media (prefers-reduced-transparency: reduce)')).toContain('--kiki-surface-filter: none;');
  });

  it('splits the work surface into one material by geometry, not by heavier paper', () => {
    const scope = ":root:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    const assist = ":root[data-kiki-bg-assist]:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    const layout = readFileSync(resolve(import.meta.dirname, '../../index.css'), 'utf8');
    // Every reading region is the same paper@dial on the same corner and lies
    // flat: a pane lift beside a flat sheet would read as a second material.
    const regions = [
      `${scope} .app-sheet > .conversation-shell .conversation-center`,
      `${scope} .app-sheet > .conversation-shell :is(.app-rail, .preview-workspace:not(.preview-workspace--overlay))`,
    ];
    for (const selector of regions) {
      const region = rules(selector).at(-1)!;
      expect(region, selector).toContain('background-color: var(--kiki-surface-paper);');
      expect(region, selector).toContain('border-radius: var(--kiki-sheet-radius);');
      expect(region, selector).toContain('box-shadow: none;');
    }
    // The agent tab is a page docked inside the preview pane, so it shares that
    // pane's paper rather than stacking a second layer of it.
    expect(rules(`${scope} [data-agent-tab-workspace]`).at(-1)).toContain('background-color: transparent;');
    // The wrapper is never repainted: the seams between regions show the picture.
    expect(css).not.toContain(`${scope} .app-sheet:has(> .conversation-shell)`);
    // Separation is geometry: the stage's own margin beside the sidebar, and the
    // gap the row already carries between its panes.
    expect(rule(`${scope} .app-stage`)).toContain('padding-left: var(--kiki-stage-gap);');
    expect(layout).toMatch(/\.app-sheet > \.conversation-shell \.conversation-row \{\s*gap: var\(--kiki-stage-gap\);/);
    // With the assist on, the desktop drops the local bands and the per-surface
    // frost: the region ground plus ONE environmental frost carry the text.
    const bands = [
      `${assist} .conversation-center div:has(> [data-transcript-scroll])::before`,
      `${assist} [data-settings-scroll] > .mx-auto::before`,
      `${assist} [data-settings-nav-tree]::before`,
    ];
    for (const selector of bands) {
      expect(rules(selector).some((text) => text.includes('display: none;')), selector).toBe(true);
    }
    expect(rules(`${assist} :is(.app-rail, [data-preview-workspace])`).some((text) => text.includes('backdrop-filter: none;'))).toBe(true);
    expect(css).toContain('--kiki-surface-filter: blur(calc(var(--kiki-surface-blur, 0px) + 8px)) saturate(1.1);');
    // The faint tier rises toward the primary ink on the work surface too.
    const ink = rule(`${assist} .app-sheet`);
    expect(ink).toContain('--color-ink-soft: var(--color-ink);');
    expect(ink).toContain('--color-ink-faint: color-mix(in srgb, var(--color-ink) 92%, var(--kiki-ink-faint-base));');
    // Everything above is the md-and-up layer: it lives inside the desktop media
    // query, and the phone block (which keeps the bands and the frost) comes after.
    const desktop = css.indexOf('@media (min-width: 768px)');
    const phone = css.indexOf('@media (max-width: 767px)');
    expect(desktop).toBeGreaterThan(-1);
    expect(desktop).toBeLessThan(phone);
    for (const selector of [...regions, `${scope} .app-stage`]) {
      expect(css.lastIndexOf(selector), selector).toBeGreaterThan(desktop);
      expect(css.lastIndexOf(selector), selector).toBeLessThan(phone);
    }
    expect(rules(bands[0]!)[0]).toContain('background: var(--kiki-text-paper);');
    // Reduced transparency drops the assist's 8px with the layer it rides: the
    // branch is later in the file at the same specificity, so it wins.
    expect(css.lastIndexOf('--kiki-surface-filter: none;')).toBeGreaterThan(css.indexOf('blur(calc(var(--kiki-surface-blur, 0px) + 8px))'));
  });

  it('keeps page and inspector washes on the dial with assist using frost instead of an opaque floor', () => {
    const scope = ":root:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    const assist = ":root[data-kiki-bg-assist]:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    const page = '.app-sheet:not(:has(> .conversation-shell)):not(:has([data-settings-scroll]))';
    for (const selector of [page, ':is(.app-rail, [data-preview-workspace])']) {
      const reading = rule(`${assist} ${selector}`);
      expect(reading).toContain('backdrop-filter: var(--kiki-reading-filter);');
      expect(reading).not.toMatch(/background(?:-color)?:/);
    }
    expect(rule(`${scope} .app-sheet > .bg-paper`)).toContain('background-color: transparent;');
    expect(rule(`${scope} [data-task-board-page] [data-task-board-container]`)).toContain('background-color: transparent;');
    expect(css).toContain('--kiki-reading-filter: blur(max(6px, var(--kiki-surface-blur, 0px))) saturate(1.1);');
    expect(rule('@media (prefers-reduced-transparency: reduce)')).toContain('--kiki-reading-filter: none;');
    // The solved solid floor stays off every wash surface. Its one use is the
    // rail lifted over a fullscreen preview: that one is a floating piece, and
    // the design says so (see the separate-papers block).
    expect(css.match(/background(?:-color)?: var\(--kiki-solid-(?:paper|panel)\)/g)).toEqual([
      'background-color: var(--kiki-solid-panel)',
    ]);
    expect(rule(`${scope} .conversation-shell:has([data-preview-workspace][data-preview-fullscreen]:not([hidden])) .app-rail`))
      .toContain('background-color: var(--kiki-solid-panel);');
  });

  it('sizes replaced media explicitly instead of falling back to intrinsic dimensions', () => {
    const media = rule('[data-kiki-backdrop-item]');
    expect(media).toContain('inset: calc(-1 * var(--kiki-backdrop-overscan, 0px));');
    expect(media).toContain('width: calc(100% + 2 * var(--kiki-backdrop-overscan, 0px));');
    expect(media).toContain('height: calc(100% + 2 * var(--kiki-backdrop-overscan, 0px));');
    expect(media).toContain('max-width: none;');
    expect(css).not.toContain("[data-kiki-backdrop-item][style*='inset: -']");
  });

  it('shares sheet and header washes with embedded agents and rail sticky chrome', () => {
    const scope = ":root:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    const assist = ":root[data-kiki-bg-assist]:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    expect(rule(`${scope} [data-agent-tab-workspace]`)).toContain('background: var(--kiki-surface-paper);');
    expect(rule(`${scope} [data-agent-relations-surface]`)).toContain('background-color: transparent;');
    expect(rule(`${scope} [data-agent-tab-workspace] header.bg-paper`)).toContain('background-color: transparent;');
    expect(rule(`${scope} .app-rail .sticky.bg-panel`)).toContain('background-color: var(--kiki-surface-panel);');
    expect(rule(`${assist} .app-rail .sticky.bg-panel`)).toContain('background-color: var(--kiki-surface-panel);');
    expect(css).toContain(`${scope} [data-agent-tab-workspace] header.bg-paper,`);
  });

  it('gives the sidebar one ground that follows the dial, instead of a card per row', () => {
    const sidebarAssist = ":root[data-kiki-bg-assist]:is([data-kiki-bg='window'], [data-kiki-bg='sidebar'])";
    // The column keeps the dial wash `.app-sidebar` already carries; the skin
    // layer must not raise it to the solved readability floor, so the requested
    // opacity stays visible at every dial.
    expect(rule(`${sidebarAssist} .app-sidebar`)).not.toMatch(/background(?:-color)?:/);
    expect(rule(":root:is([data-kiki-bg='window'], [data-kiki-bg='sidebar']) .app-sidebar"))
      .toContain('background-color: var(--kiki-surface-canvas);');
    // No row inside the column may raise a slab of its own: the doubled
    // layering is what drew the hard-edged Settings band.
    for (const selector of [
      '.app-sidebar > div:has(> [data-search-toggle])',
      '.app-sidebar [data-primary-nav] > ul',
      '.app-sidebar > div:has(> h2)',
      '.app-sidebar > [data-sidebar-filters]',
      '.app-sidebar > [data-sidebar-footer]',
    ]) {
      expect(rule(`${sidebarAssist} ${selector}`), selector).not.toMatch(/background(?:-color)?:/);
    }
    // The session list body lost its rule entirely, rather than keeping one
    // with the fill taken out.
    expect(css).not.toContain(`${sidebarAssist} .app-sidebar > [data-session-list] > :is([data-session-group-block], [data-sidebar-empty]) {`);
  });

  it('keeps the rail on its dial wash plus frost, never raised to the text floor', () => {
    const scope = ":root:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    const assist = ":root[data-kiki-bg-assist]:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    expect(rule(`${scope} :is(.app-rail, [data-preview-workspace])`)).toContain('background-color: var(--kiki-surface-panel);');
    // The assist rule adds frost, and no opacity of its own, so the dial the
    // user asked for is the one that reaches the rail.
    const rail = rule(`${assist} :is(.app-rail, [data-preview-workspace])`);
    expect(rail).toContain('backdrop-filter: var(--kiki-reading-filter);');
    expect(rail).not.toMatch(/background(?:-color)?:/);
  });

  it('lets the session header inherit its reading column instead of re-declaring a ground', () => {
    const scope = ":root:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    const assist = ":root[data-kiki-bg-assist]:is([data-kiki-bg='window'], [data-kiki-bg='main'])";
    // With no background the header is transparent on the sheet, and the skin
    // layer must not add a second ground over the column the transcript reads
    // on, which is what banded it.
    expect(rule(`${scope} .conversation-center > header.bg-paper`)).toContain('background-color: transparent;');
    expect(css).not.toContain(`${assist} .conversation-center > header.bg-paper {`);
    expect(css).not.toContain(`${assist} [data-agent-relations-surface] {`);
  });

  it('keeps a card only where the app means one action or one place', () => {
    // The two raised marks in the sidebar column are real surfaces and keep
    // their own fill from the app's own classes: "New session" is a paper
    // chip and the selected conversation a paper card. The pane rule above is
    // about ground, so it does not touch either.
    const sidebar = readFileSync(resolve(import.meta.dirname, '../../components/Sidebar.tsx'), 'utf8');
    expect(sidebar).toContain('data-new-session');
    expect(sidebar).toContain('data-session-selected');
    expect(sidebar).toMatch(/data-new-session[\s\S]{0,400}bg-paper/);
    // The skin layer never restyles the app's own cards.
    expect(css).not.toMatch(/\[data-new-session\][^{]*\{[^}]*background/);
    expect(css).not.toMatch(/\[data-session-selected\][^{]*\{[^}]*background/);
  });
});

describe('wallpaper switching', () => {
  it('publishes three blur radii of overscan and clears it with the background', () => {
    setBackdropMediaResolver(async () => null);
    const root = document.documentElement;
    applyBackdrop(slot(image('local-pad-1'), { blur: 20.1 }), false);
    expect(root.style.getPropertyValue('--kiki-backdrop-overscan')).toBe('61px');
    applyBackdrop(slot(image('local-pad-1'), { blur: 0 }), false);
    expect(root.style.getPropertyValue('--kiki-backdrop-overscan')).toBe('0px');
    applyBackdrop(null);
    expect(root.style.getPropertyValue('--kiki-backdrop-overscan')).toBe('');
  });

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


describe('media durability', () => {
  afterEach(resetMediaStore);

  it('waits for transaction commit and reports memory-only bytes after an abort', async () => {
    resetMediaStore();
    const request = { result: 'local-aborted-1' };
    const transaction = {
      objectStore: () => ({ put: () => request }),
      error: null,
      oncomplete: undefined as (() => void) | undefined,
      onabort: undefined as (() => void) | undefined,
    };
    vi.stubGlobal('indexedDB', {
      open: () => {
        const opening = { result: { transaction: () => transaction }, onsuccess: undefined as (() => void) | undefined };
        queueMicrotask(() => opening.onsuccess?.());
        return opening;
      },
    });
    const blob = new Blob(['bytes'], { type: 'video/mp4' });
    let finished = false;
    const write = putMedia('local-aborted-1', blob).then(() => { finished = true; });
    await flush();
    expect(finished).toBe(false);
    transaction.onabort?.();
    await write;
    expect(await isPersistent()).toBe(false);
    expect(await getMedia('local-aborted-1')).toBe(blob);
  });
});
