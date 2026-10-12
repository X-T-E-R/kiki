// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { resetMediaOutcomes } from './imageActions';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { MediaGalleryOrder, useMediaPreview } from './mediaPreviewContext';
import type { MediaRef } from '@kiki/session-core/composer/media';

vi.mock('../state/connection', () => ({ useOptionalConnection: () => ({ client: undefined, scopeId: 'gallery' }) }));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

function render(node: ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  act(() => { flushSync(() => { root.render(<I18nProvider>{node}</I18nProvider>); }); });
  return container;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  vi.unstubAllGlobals();
});

describe('image gallery', () => {
  it('orders by the block index rather than mount order and ignores another agent', () => {
    const first: MediaRef = { kind: 'image', url: 'https://example.test/first.png', name: 'first.png' };
    const second: MediaRef = { kind: 'image', url: 'https://example.test/second.png', name: 'second.png' };
    const other: MediaRef = { kind: 'image', url: 'https://example.test/other.png', name: 'other.png' };
    const container = render(
      <MediaPreviewProvider sessionId="session">
        <MediaGalleryOrder agentId="main" order={2} blockId="later">
          <MediaPartList media={[second]} />
        </MediaGalleryOrder>
        <MediaGalleryOrder agentId="other" order={0} blockId="foreign">
          <MediaPartList media={[other]} />
        </MediaGalleryOrder>
        <MediaGalleryOrder agentId="main" order={1} blockId="earlier">
          <MediaPartList media={[first]} />
        </MediaGalleryOrder>
      </MediaPreviewProvider>,
    );
    const open = (name: string) => container.querySelector<HTMLButtonElement>(`img[alt="${name}"]`)!.closest('button')!;
    act(() => { open('second.png').click(); });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('2 / 2');
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe(second.url);
    act(() => { dialog?.querySelector<HTMLButtonElement>('[aria-label="Previous image"]')?.click(); });
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(first.url);
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('other.png');
  });

  it('keeps registered images after the thumbnails unmount and can leave a broken image', () => {
    const first: MediaRef = { kind: 'image', url: 'https://example.test/keep-a.png', name: 'keep-a.png' };
    const second: MediaRef = { kind: 'image', url: 'https://example.test/keep-b.png', name: 'keep-b.png' };
    function Open({ item }: { item: MediaRef }) {
      const preview = useMediaPreview();
      return <button type="button" data-open-kept onClick={() => { preview?.openGalleryImage?.(item, 'main'); }}>open</button>;
    }
    const container = render(<MediaPreviewProvider sessionId="session"><MediaPartList media={[first, second]} /><Open item={first} /></MediaPreviewProvider>);
    expect(container.querySelectorAll('img')).toHaveLength(2);
    act(() => {
      flushSync(() => {
        roots[0]!.render(<I18nProvider><MediaPreviewProvider sessionId="session"><Open item={first} /></MediaPreviewProvider></I18nProvider>);
      });
    });
    expect(container.querySelector('img')).toBeNull();
    act(() => { container.querySelector<HTMLButtonElement>('[data-open-kept]')!.click(); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('1 / 2');
    act(() => { document.querySelector('[role="dialog"] img')?.dispatchEvent(new Event('error')); });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    act(() => { document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(); });
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(second.url);
  });

  it('restores only the url thumbnail whose viewer retry loaded', () => {
    resetMediaOutcomes();
    const broken: MediaRef = { kind: 'image', url: 'https://example.test/broken.png', name: 'broken.png' };
    const kept: MediaRef = { kind: 'image', url: 'https://example.test/kept.png', name: 'kept.png' };
    const foreign: MediaRef = { kind: 'image', url: 'https://example.test/foreign.png', name: 'foreign.png' };
    const container = render(
      <MediaPreviewProvider sessionId="session">
        <MediaGalleryOrder agentId="other" order={0} blockId="foreign">
          <MediaPartList media={[foreign]} />
        </MediaGalleryOrder>
        <MediaGalleryOrder agentId="main" order={0} blockId="main">
          <MediaPartList media={[broken, kept]} />
        </MediaGalleryOrder>
      </MediaPreviewProvider>,
    );
    const keptImage = container.querySelector<HTMLImageElement>('img[alt="kept.png"]')!;
    const foreignImage = container.querySelector<HTMLImageElement>('img[alt="foreign.png"]')!;
    act(() => { container.querySelector('img[alt="broken.png"]')!.dispatchEvent(new Event('error')); });
    expect(container.querySelector('[data-media-broken="decode"]')).not.toBeNull();
    act(() => { keptImage.closest('button')!.click(); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('2 / 2');
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('foreign.png');
    act(() => { document.querySelector<HTMLButtonElement>('[aria-label="Previous image"]')!.click(); });
    act(() => { document.querySelector('[role="dialog"] img')!.dispatchEvent(new Event('error')); });
    act(() => { document.querySelector<HTMLButtonElement>('[role="dialog"] [role="alert"] button')!.click(); });
    act(() => { document.querySelector('[role="dialog"] img')!.dispatchEvent(new Event('load')); });
    expect(container.querySelector('[data-media-broken]')).toBeNull();
    expect(container.querySelector('img[alt="broken.png"]')?.getAttribute('src')).toBe(broken.url);
    expect(container.querySelector('img[alt="kept.png"]')).toBe(keptImage);
    expect(container.querySelector('img[alt="foreign.png"]')).toBe(foreignImage);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('1 / 2');
  });
});
