// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DiffHunk } from '@kiki/session-core/util';
import { I18nProvider } from '../i18n';
import { AddMenu } from './ComposerControls';
import { DiffCard } from './DiffCard';
import { MessageRowActions } from './RowActions';

const mounts: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  while (mounts.length > 0) {
    const entry = mounts.pop()!;
    await act(async () => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
  vi.unstubAllGlobals();
});

function stubPhoneCoarseMatchMedia(enabled: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: enabled && (
      query.includes('pointer: coarse') ||
      query.includes('max-width: 639px') ||
      query.includes('max-width: 767px') ||
      query.includes('max-width: 899px')
    ),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('Mobile DiffCard, RowActions & AddMenu primitives', () => {
  it('renders unified single-gutter mobile diff with diffWordsWithSpace intraline highlights, swipe-ignore="x", and 80-line cap', async () => {
    stubPhoneCoarseMatchMedia(true);
    const hunk: DiffHunk = [
      { tag: 'delete', lo: 10, ln: 0, text: 'const label = [agentName, modelShortLabel].join(" · ");' },
      { tag: 'insert', lo: 0, ln: 10, text: 'const label = isDefaultAgent ? modelShortLabel : fullLabel;' },
      ...Array.from({ length: 85 }, (_, idx) => ({
        tag: 'equal' as const,
        lo: 11 + idx,
        ln: 11 + idx,
        text: `const line_${idx} = ${idx};`,
      })),
    ];

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ root, container });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DiffCard hunks={[hunk]} />
        </I18nProvider>,
      );
    });

    const card = container.querySelector<HTMLElement>('[data-diff-card]')!;
    expect(card).not.toBeNull();
    expect(card.dataset['baseUiSwipeIgnore']).toBe('x');
    expect(Object.hasOwn(card.dataset, 'diffMobile')).toBe(true);

    const marks = [...card.querySelectorAll('mark')].map((el) => el.textContent);
    expect(marks.some((t) => t?.includes('[agentName,'))).toBe(true);
    expect(marks.some((t) => t?.includes('isDefaultAgent'))).toBe(true);

    // 87 total lines capped at 80 on phone until expanded
    expect(card.querySelectorAll('[data-diff-tag]').length).toBe(80);
    const expandBtn = container.querySelector<HTMLButtonElement>('[data-diff-expand]')!;
    expect(expandBtn).not.toBeNull();

    await act(async () => {
      expandBtn.click();
    });
    expect(card.querySelectorAll('[data-diff-tag]').length).toBe(87);
  });

  it('renders always-visible assistant touch action strip with 44px tiles on coarse pointers (P0-3)', async () => {
    stubPhoneCoarseMatchMedia(true);
    const onRegenerate = vi.fn();
    const onFork = vi.fn();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ root, container });

    await act(async () => {
      root.render(
        <I18nProvider>
          <MessageRowActions
            role="assistant"
            copyText="Hello from Kiki"
            canRegenerate
            canFork
            onRegenerate={onRegenerate}
            onFork={onFork}
          />
        </I18nProvider>,
      );
    });

    const strip = container.querySelector<HTMLElement>('[data-row-actions]')!;
    expect(strip.className).toContain('opacity-100');
    expect(strip.className).not.toContain('opacity-0');

    const copyBtn = strip.querySelector<HTMLButtonElement>('[data-row-action="copy"]')!;
    const retryBtn = strip.querySelector<HTMLButtonElement>('[data-row-action="regenerate"]')!;
    const moreBtn = strip.querySelector<HTMLButtonElement>('[data-row-more]')!;
    expect(copyBtn.className).toContain('pointer-coarse:h-11');
    expect(retryBtn.className).toContain('pointer-coarse:h-11');
    expect(moreBtn.className).toContain('pointer-coarse:h-11');

    await act(async () => {
      retryBtn.click();
    });
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('renders Camera, Photos, and Files media strip inside @base-ui/react/drawer AddMenu on phoneMode (P0-2)', async () => {
    stubPhoneCoarseMatchMedia(true);
    const onCaptureCamera = vi.fn();
    const onPickPhotos = vi.fn();
    const onAttach = vi.fn();
    const onViewChange = vi.fn();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ root, container });

    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <I18nProvider>
            <AddMenu
              view="root"
              onViewChange={onViewChange}
              attachDisabled={false}
              onAttach={onAttach}
              onCaptureCamera={onCaptureCamera}
              onPickPhotos={onPickPhotos}
            />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    const panel = document.body.querySelector<HTMLElement>('[data-add-panel="root"]')!;
    expect(panel).not.toBeNull();
    expect(panel.classList.contains('kiki-drawer-bottom')).toBe(true);
    expect(Object.hasOwn(panel.dataset, 'open')).toBe(true);
    expect(document.body.querySelector('.kiki-drawer-backdrop')).not.toBeNull();

    const cameraBtn = panel.querySelector<HTMLButtonElement>('[data-add-camera]')!;
    const photosBtn = panel.querySelector<HTMLButtonElement>('[data-add-photos]')!;
    const filesBtn = panel.querySelector<HTMLButtonElement>('[data-attach-button]')!;
    expect(cameraBtn).not.toBeNull();
    expect(photosBtn).not.toBeNull();
    expect(filesBtn).not.toBeNull();

    await act(async () => {
      cameraBtn.click();
    });
    expect(onCaptureCamera).toHaveBeenCalledTimes(1);
  });
});
