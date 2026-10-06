// @vitest-environment jsdom
/**
 * Plugin icons — the four decisions a reader would be wrong about.
 *
 *  - An icon that says `currentColor` is asking to wear the app's ink, so it
 *    gets the live `--color-ink-soft`, and gets it again when the theme moves.
 *    Without this it renders black on the dark palette and on a skin.
 *  - An icon that paints itself keeps its colours. A third-party brand mark is
 *    not ours to recolour.
 *  - A mark is still an image: the recoloured payload is a data: URI handed to
 *    an `<img>`, never markup written into the page.
 *  - No icon, or an unusable one, leaves the drawn kind tile standing.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilityIcon } from './CapabilityIcon';
import { resetPluginIconCache } from '../../lib/pluginIcon';

const MONO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><path d="M3.9 2.6h4.9l3.1 3.1v7.7H3.9z"/></svg>`;
const BRAND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#c8401a"/></svg>`;
const dataUri = (markup_: string): string => `data:image/svg+xml;base64,${btoa(markup_)}`;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetPluginIconCache();
  document.documentElement.dataset['theme'] = 'light';
  document.documentElement.style.setProperty('--color-ink-soft', '#4b453e');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(MONO, { headers: { 'content-type': 'image/svg+xml' } })));
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  document.documentElement.style.removeProperty('--color-ink-soft');
  vi.unstubAllGlobals();
});

function render(props: Parameters<typeof CapabilityIcon>[0]): void {
  act(() => { root.render(<CapabilityIcon {...props} />); });
}

/** The markup behind whatever the component is currently showing. */
function shownMarkup(): string {
  const img = host.querySelector('img');
  if (img === null) throw new Error('no image rendered');
  const src = img.getAttribute('src') ?? '';
  const match = /^data:image\/svg\+xml;base64,(.*)$/s.exec(src);
  return match === null ? src : atob(match[1] ?? '');
}

describe('CapabilityIcon', () => {
  it('draws a currentColor icon in the live ink token, not black', () => {
    render({ icon: dataUri(MONO) });
    expect(shownMarkup()).toContain('#4b453e');
    expect(shownMarkup()).not.toContain('currentColor');
  });

  it('leaves a painted brand icon in its own colours', () => {
    render({ icon: dataUri(BRAND) });
    expect(shownMarkup()).toContain('#c8401a');
  });

  it('re-reads the token when the theme moves', async () => {
    render({ icon: dataUri(MONO) });
    document.documentElement.style.setProperty('--color-ink-soft', '#a2acaf');
    // The theme hook watches <html data-theme>; the token is what moves.
    act(() => { document.documentElement.dataset['theme'] = 'dark'; });
    await act(async () => { await Promise.resolve(); });
    expect(shownMarkup()).toContain('#a2acaf');
  });

  it('follows a skin, which lands as an inline custom property', async () => {
    render({ icon: dataUri(MONO) });
    // A skin is applied by writing tokens on <html> (lib/skins/apply.ts), not
    // by flipping data-theme. A watcher on the attribute alone would miss this.
    act(() => { document.documentElement.style.setProperty('--color-ink-soft', '#7a1f6b'); });
    await act(async () => { await Promise.resolve(); });
    expect(shownMarkup()).toContain('#7a1f6b');
  });

  it('ignores a style write that did not move the ink', async () => {
    render({ icon: dataUri(MONO) });
    const before = host.querySelector('img')?.getAttribute('src');
    act(() => { document.documentElement.style.setProperty('--color-accent', '#123456'); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('img')?.getAttribute('src')).toBe(before);
  });

  it('fetches a remote icon and tints it', async () => {
    render({ icon: 'https://example.com/icon.svg' });
    await act(async () => { await Promise.resolve(); });
    expect(shownMarkup()).toContain('#4b453e');
  });

  it('falls back when fetch fails instead of emitting a CSP-blocked remote img', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render({ icon: 'https://example.com/icon.svg' });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[data-capability-icon="fallback"]')).not.toBeNull();
  });

  it('falls back to the drawn tile when there is no icon', () => {
    render({ icon: undefined, kind: 'skill' });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[data-capability-icon="fallback"]')).not.toBeNull();
  });

  it('waits for remote bytes and uses the latest ink even if a skin changes while pending', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    render({ icon: 'https://example.test/slow.svg' });
    expect(host.querySelector('img')).toBeNull();
    act(() => { document.documentElement.style.setProperty('--color-ink-soft', '#a2acaf'); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('img')).toBeNull();
    await act(async () => { finish(new Response(MONO)); });
    expect(shownMarkup()).toContain('#a2acaf');
  });

  it('recovers on source change after image decoding fails', () => {
    render({ icon: dataUri(MONO) });
    act(() => { host.querySelector('img')?.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
    render({ icon: dataUri(BRAND) });
    expect(shownMarkup()).toContain('#c8401a');
    render({ icon: dataUri(MONO) });
    expect(shownMarkup()).toContain('#4b453e');
  });

  it('recovers on source change after an HTTP failure', async () => {
    const fetchIcon = vi.fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response(MONO));
    vi.stubGlobal('fetch', fetchIcon);
    render({ icon: 'https://example.test/missing.svg' });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('img')).toBeNull();
    render({ icon: 'https://example.test/good.svg' });
    await act(async () => { await Promise.resolve(); });
    expect(shownMarkup()).toContain('#4b453e');
  });

  it('ignores a late response for the previous source', async () => {
    let finishOld!: (response: Response) => void;
    const fetchIcon = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(new Response(BRAND));
    vi.stubGlobal('fetch', fetchIcon);
    render({ icon: 'https://example.test/old.svg' });
    render({ icon: 'https://example.test/new.svg' });
    await act(async () => { await Promise.resolve(); });
    expect(shownMarkup()).toContain('#c8401a');
    await act(async () => { finishOld(new Response(MONO)); });
    expect(shownMarkup()).toContain('#c8401a');
  });

  it('does not restore a removed icon when its request finishes', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    render({ icon: 'https://example.test/removed.svg' });
    render({ icon: undefined });
    await act(async () => { finish(new Response(MONO)); });
    expect(host.querySelector('img')).toBeNull();
  });

  it('deduplicates concurrent consumers and reuses bytes on remount and skin changes', async () => {
    let finish!: (response: Response) => void;
    const fetchIcon = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchIcon);
    const icon = 'https://example.test/shared.svg';
    act(() => { root.render(<><CapabilityIcon icon={icon} /><CapabilityIcon icon={icon} /></>); });
    expect(fetchIcon).toHaveBeenCalledTimes(1);
    await act(async () => { finish(new Response(MONO)); });
    expect(host.querySelectorAll('img')).toHaveLength(2);
    act(() => { root.render(null); });
    render({ icon });
    act(() => { document.documentElement.style.setProperty('--color-ink-soft', '#7a1f6b'); });
    await act(async () => { await Promise.resolve(); });
    expect(shownMarkup()).toContain('#7a1f6b');
    expect(fetchIcon).toHaveBeenCalledTimes(1);
  });

  it('keeps remote fixed-colour SVGs inert and unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(BRAND, { headers: { 'content-type': 'image/svg+xml' } })));
    render({ icon: 'https://example.test/brand.svg' });
    await act(async () => { await Promise.resolve(); });
    expect(shownMarkup()).toBe(BRAND);
    expect(host.querySelector('img')?.src).toMatch(/^data:/);
  });

  it('preserves binary raster bytes without treating their text as SVG', async () => {
    const bytes = new TextEncoder().encode('binary currentColor <svg');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } })));
    render({ icon: 'https://example.test/raster.png' });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${btoa('binary currentColor <svg')}`);
  });

  it('does not fetch an inline raster', () => {
    render({ icon: 'data:image/png;base64,YmluYXJ5' });
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,YmluYXJ5');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an oversized stream while reading and cancels the body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-type': 'image/svg+xml' } })));
    render({ icon: 'https://example.test/large.svg' });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('img')).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized declared lengths before reading the body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-length': '262145' } })));
    render({ icon: 'https://example.test/declared-large.svg' });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('img')).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-image payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>missing</html>', { headers: { 'content-type': 'text/html' } })));
    render({ icon: 'https://example.test/not-an-image' });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('img')).toBeNull();
  });

  it('bounds remembered sources without losing the ink of a mounted consumer', async () => {
    const pinned = 'https://example.test/pinned.svg';
    const rotate = async (rotating: string): Promise<void> => {
      await act(async () => {
        root.render(<><CapabilityIcon icon={pinned} /><CapabilityIcon icon={rotating} /></>);
      });
    };
    for (let i = 0; i < 65; i += 1) await rotate(`https://example.test/${i}.svg`);
    expect(fetch).toHaveBeenCalledTimes(66);
    act(() => { document.documentElement.style.setProperty('--color-ink-soft', '#7a1f6b'); });
    await act(async () => { await Promise.resolve(); });
    expect(shownMarkup()).toContain('#7a1f6b');
    act(() => { root.render(null); });
    render({ icon: pinned });
    await act(async () => { await Promise.resolve(); });
    expect(fetch).toHaveBeenCalledTimes(67);
    expect(shownMarkup()).toContain('#7a1f6b');
  });

  it('never writes an icon into the page as markup', () => {
    render({ icon: dataUri(MONO) });
    // The tint is an <img src>; the document holds no svg element from it.
    expect(host.querySelector('svg')).toBeNull();
    expect(host.querySelector('img')).not.toBeNull();
  });
});
