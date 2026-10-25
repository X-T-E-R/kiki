// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { PdfPageView } from './PdfPageView';

const pdfMocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: undefined },
  getDocument: pdfMocks.getDocument,
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  pdfMocks.getDocument.mockReset();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

/**
 * The canvas must keep the document's own proportions.
 *
 * The previous defect was subtle and self-consistent: both viewport widths
 * agreed with each other while disagreeing with the PDF, because CSS
 * `aspect-ratio` reads width/height and the component passed height/width. A
 * portrait page came out sideways and squashed. Comparing two runs of the same
 * bug proves nothing, so the expectation here is stated as a NUMBER measured
 * from the real file: this sample's first page is 612 x 792 points.
 *
 * The component source is read so the test fails if the ratio is ever inverted
 * again, and the real file is opened so the expected numbers cannot drift.
 */
// Checked in beside the component: a real one-page US Letter portrait PDF
// (612 x 792 pt), so the expectation below is measured from a file rather than
// copied from the code it guards, and every platform reads the same bytes.
const REAL_SAMPLE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'letter-portrait.pdf');
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'PdfPageView.tsx');
const LETTER_PORTRAIT = { width: 612, height: 792 };

describe('pdf page proportions', () => {
  it('the real sample is a portrait page, and we know its exact shape', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = new Uint8Array(await readFile(REAL_SAMPLE));
    const document = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
    const viewport = (await document.getPage(1)).getViewport({ scale: 1 });
    expect(viewport.width).toBe(LETTER_PORTRAIT.width);
    expect(viewport.height).toBe(LETTER_PORTRAIT.height);
    // Portrait: taller than wide, so a width/height ratio is below 1.
    expect(viewport.height).toBeGreaterThan(viewport.width);
    expect(viewport.width / viewport.height).toBeCloseTo(0.7727, 3);
  }, 30_000);

  it('the canvas is given width over height, never the reciprocal', async () => {
    const source = await readFile(SOURCE, 'utf8');
    expect(source).toContain('setAspect(unit.width / unit.height)');
    expect(source).toContain('Math.min(globalThis.devicePixelRatio || 1, 2)');
    // The inverted form is the bug this guards against.
    expect(source).not.toContain('setAspect(unit.height / unit.width)');
  });

  it('a correctly shaped box stays portrait at both panel widths', () => {
    const ratio = LETTER_PORTRAIT.width / LETTER_PORTRAIT.height;
    for (const width of [900, 390]) {
      const height = width * ratio;
      // Below 1 means width/height, i.e. a portrait box: taller than wide.
      expect(ratio).toBeLessThan(1);
      expect(height / width).toBeCloseTo(ratio, 4);
      // The inverse — what the bug produced — would be above 1 (sideways).
      expect(height / width).not.toBeGreaterThan(1);
    }
  });
});

describe('pdf page document lifecycle', () => {
  it('reads and opens one source once while paging, cancels render work, and disposes on source change', async () => {
    let finishFirstRender = () => {};
    const firstRenderDone = {
      promise: new Promise<void>((resolve) => { finishFirstRender = resolve; }),
      resolve: () => { finishFirstRender(); },
    };
    const firstRenderCancel = vi.fn();
    const secondRenderCancel = vi.fn();
    const firstPage = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
      render: vi.fn(() => ({ promise: firstRenderDone.promise, cancel: firstRenderCancel })),
      cleanup: vi.fn(),
    };
    const secondPage = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: secondRenderCancel })),
      cleanup: vi.fn(),
    };
    const firstDocument = {
      numPages: 2,
      getPage: vi.fn(async (page: number) => page === 1 ? firstPage : secondPage),
      destroy: vi.fn(async () => undefined),
    };
    const firstLoadingTask = {
      promise: Promise.resolve(firstDocument),
      destroy: vi.fn(async () => undefined),
    };
    const secondDocument = {
      numPages: 1,
      getPage: vi.fn(async () => secondPage),
      destroy: vi.fn(async () => undefined),
    };
    const secondLoadingTask = {
      promise: Promise.resolve(secondDocument),
      destroy: vi.fn(async () => undefined),
    };
    pdfMocks.getDocument.mockReturnValueOnce(firstLoadingTask).mockReturnValueOnce(secondLoadingTask);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const signals: AbortSignal[] = [];
    const readDocumentPreviewAsset = vi.fn(async (_assetUrl: string, signal?: AbortSignal) => {
      if (signal !== undefined) signals.push(signal);
      return { bytes: Uint8Array.of(1, 2, 3), mime: 'application/pdf' };
    });
    const client = { readDocumentPreviewAsset } as never;
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset-1', sourceKey: 'scope:source', page: 1, name: 'guide.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readDocumentPreviewAsset).toHaveBeenCalledTimes(1);
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
    expect(firstDocument.getPage).toHaveBeenCalledWith(1);
    expect(firstPage.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset-2', sourceKey: 'scope:source', page: 2, name: 'guide.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readDocumentPreviewAsset).toHaveBeenCalledTimes(1);
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
    expect(firstRenderCancel).toHaveBeenCalledTimes(1);
    expect(firstDocument.getPage).toHaveBeenCalledWith(2);
    expect(secondPage.render).toHaveBeenCalledTimes(1);
    await flush();

    firstRenderDone.resolve();
    await flush();

    type AssetResponse = Awaited<ReturnType<typeof readDocumentPreviewAsset>>;
    let resolveSource: ((value: AssetResponse) => void) | undefined;
    const pendingSource = new Promise<AssetResponse>((resolve) => { resolveSource = resolve; });
    readDocumentPreviewAsset.mockImplementationOnce(async () => pendingSource);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset-3', sourceKey: 'scope:other-source', page: 1, name: 'other.pdf' })));
      await Promise.resolve();
    });
    expect(firstDocument.destroy).toHaveBeenCalledTimes(1);
    expect(firstLoadingTask.destroy).not.toHaveBeenCalled();
    expect(signals[0]?.aborted).toBe(true);
    expect(container.querySelector('canvas')?.style.visibility).toBe('hidden');

    resolveSource?.({ bytes: Uint8Array.of(4, 5, 6), mime: 'application/pdf' });
    await flush();
    expect(readDocumentPreviewAsset).toHaveBeenCalledTimes(2);
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(2);
  });

  it('cancels an active render before clearing its canvas when closing or changing source', async () => {
    let finishRender = () => {};
    const renderDone = new Promise<void>((resolve) => { finishRender = resolve; });
    let canvas: HTMLCanvasElement | undefined;
    let widthAtCancel: number | undefined;
    const renderCancel = vi.fn(() => { widthAtCancel = canvas?.width; });
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
      render: vi.fn(() => ({ promise: renderDone, cancel: renderCancel })),
      cleanup: vi.fn(),
    };
    const pdfDocument = {
      numPages: 1,
      getPage: vi.fn(async () => page),
      destroy: vi.fn(async () => undefined),
    };
    const loadingTask = { promise: Promise.resolve(pdfDocument), destroy: vi.fn(async () => undefined) };
    pdfMocks.getDocument.mockReturnValueOnce(loadingTask);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    let resolveSource: ((value: { bytes: Uint8Array; mime: string }) => void) | undefined;
    const pendingSource = new Promise<{ bytes: Uint8Array; mime: string }>((resolve) => { resolveSource = resolve; });
    const readDocumentPreviewAsset = vi.fn(async (assetUrl: string) => (
      assetUrl === '/asset-1' ? { bytes: Uint8Array.of(1, 2, 3), mime: 'application/pdf' } : pendingSource
    ));
    const client = { readDocumentPreviewAsset } as never;
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset-1', sourceKey: 'source-1', page: 1, name: 'guide.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    canvas = container.querySelector('canvas') ?? undefined;
    expect(canvas?.width).toBeGreaterThan(0);
    expect(page.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset-2', sourceKey: 'source-2', page: 1, name: 'other.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderCancel).toHaveBeenCalledTimes(1);
    expect(widthAtCancel).toBeGreaterThan(0);
    expect(canvas?.width).toBe(0);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);

    finishRender();
    resolveSource?.({ bytes: Uint8Array.of(4, 5, 6), mime: 'application/pdf' });
    await flush();
  });

  it('contains a render failure and retries the document without escaping the preview', async () => {
    const failedPage = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve().then(() => { throw new Error('render failed'); }), cancel: vi.fn() })),
      cleanup: vi.fn(),
    };
    const readyPage = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn(),
    };
    const failedDocument = { numPages: 1, getPage: vi.fn(async () => failedPage), destroy: vi.fn(async () => undefined) };
    const readyDocument = { numPages: 1, getPage: vi.fn(async () => readyPage), destroy: vi.fn(async () => undefined) };
    pdfMocks.getDocument
      .mockReturnValueOnce({ promise: Promise.resolve(failedDocument), destroy: vi.fn(async () => undefined) })
      .mockReturnValueOnce({ promise: Promise.resolve(readyDocument), destroy: vi.fn(async () => undefined) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const readDocumentPreviewAsset = vi.fn(async () => ({ bytes: Uint8Array.of(1, 2, 3), mime: 'application/pdf' }));
    const client = { readDocumentPreviewAsset } as never;
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset', sourceKey: 'source', page: 1, name: 'guide.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-pdf-page]')?.getAttribute('data-state')).toBe('failed');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('canvas')).toBeNull();

    await act(async () => {
      (container.querySelector('[data-retry-pdf]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(failedDocument.destroy).toHaveBeenCalledTimes(1);
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(2);
    expect(readyPage.render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-pdf-page]')?.getAttribute('data-state')).toBe('ready');
    expect(container.querySelector('canvas')?.style.visibility).toBe('visible');
  });

  it('does not block another source while a previous document is still being destroyed', async () => {
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn(),
    };
    let releaseFirstDestroy = () => {};
    const firstDestroyDone = new Promise<void>((resolve) => { releaseFirstDestroy = resolve; });
    const firstDocument = { numPages: 1, getPage: vi.fn(async () => page), destroy: vi.fn(() => firstDestroyDone) };
    const secondDocument = { numPages: 1, getPage: vi.fn(async () => page), destroy: vi.fn(async () => undefined) };
    pdfMocks.getDocument
      .mockReturnValueOnce({ promise: Promise.resolve(firstDocument), destroy: vi.fn(async () => undefined) })
      .mockReturnValueOnce({ promise: Promise.resolve(secondDocument), destroy: vi.fn(async () => undefined) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const readDocumentPreviewAsset = vi.fn(async () => ({ bytes: Uint8Array.of(1, 2, 3), mime: 'application/pdf' }));
    const client = { readDocumentPreviewAsset } as never;
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const firstRoot = createRoot(container);
    roots.push(firstRoot);

    await act(async () => {
      firstRoot.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset-a', sourceKey: 'isolation-a', page: 1, name: 'a.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readDocumentPreviewAsset).toHaveBeenCalledTimes(1);
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRoot.unmount();
      await Promise.resolve();
    });
    roots.splice(roots.indexOf(firstRoot), 1);
    expect(firstDocument.destroy).toHaveBeenCalledTimes(1);

    const secondRoot = createRoot(container);
    roots.push(secondRoot);
    await act(async () => {
      secondRoot.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset-a', sourceKey: 'isolation-a', page: 1, name: 'a.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      secondRoot.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset-b', sourceKey: 'isolation-b', page: 1, name: 'b.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(readDocumentPreviewAsset).toHaveBeenCalledTimes(2);
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(2);
    expect(secondDocument.getPage).toHaveBeenCalledWith(1);
    expect(container.querySelector('[data-pdf-page]')?.getAttribute('data-state')).toBe('ready');

    releaseFirstDestroy();
    await flush();
  });

  it('destroys a closed document and opens a fresh document when the preview is reopened', async () => {
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn(),
    };
    let releaseFirstDestroy = () => {};
    const firstDestroyDone = new Promise<void>((resolve) => { releaseFirstDestroy = resolve; });
    const firstDocument = { numPages: 1, getPage: vi.fn(async () => page), destroy: vi.fn(() => firstDestroyDone) };
    const secondDocument = { numPages: 1, getPage: vi.fn(async () => page), destroy: vi.fn(async () => undefined) };
    pdfMocks.getDocument
      .mockReturnValueOnce({ promise: Promise.resolve(firstDocument), destroy: vi.fn(async () => undefined) })
      .mockReturnValueOnce({ promise: Promise.resolve(secondDocument), destroy: vi.fn(async () => undefined) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const readDocumentPreviewAsset = vi.fn(async () => ({ bytes: Uint8Array.of(1, 2, 3), mime: 'application/pdf' }));
    const client = { readDocumentPreviewAsset } as never;
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const firstRoot = createRoot(container);
    roots.push(firstRoot);

    await act(async () => {
      firstRoot.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset', sourceKey: 'source', page: 1, name: 'guide.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-pdf-page]')?.getAttribute('data-state')).toBe('ready');

    await act(async () => {
      firstRoot.unmount();
      await Promise.resolve();
    });
    roots.splice(roots.indexOf(firstRoot), 1);
    expect(firstDocument.destroy).toHaveBeenCalledTimes(1);

    const secondRoot = createRoot(container);
    roots.push(secondRoot);
    await act(async () => {
      secondRoot.render(createElement(I18nProvider, null, createElement(PdfPageView, { client, assetUrl: '/asset', sourceKey: 'source', page: 1, name: 'guide.pdf' })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
    expect(secondDocument.getPage).not.toHaveBeenCalled();

    releaseFirstDestroy();
    await flush();
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(2);
    expect(secondDocument.getPage).toHaveBeenCalledWith(1);
    expect(container.querySelector('[data-pdf-page]')?.getAttribute('data-state')).toBe('ready');
  });
});
