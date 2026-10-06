/**
 * One PDF page, rendered in the browser.
 *
 * PDF.js is loaded through a dynamic import, so a user who never opens a PDF
 * pays nothing at startup and no PDF code ships in the initial bundle. The
 * worker, the standard fonts and the CMaps come with the same lazy chunk: a
 * document in Chinese is ordinary content, not an edge case, so the asset set
 * that renders it is the one that ships.
 *
 * Bytes come from the client, never from a bare URL. The asset route is behind
 * the same bearer gate as the rest of `/api`, so the file is read over the
 * connection it lives on and handed to pdf.js as an ArrayBuffer. That is also
 * what makes a remote scope work: the request goes to the remote host through
 * the client's own transport instead of resolving against this page's origin.
 *
 * The page is scaled to the canvas's own measured width, so the aspect ratio
 * is the document's own whether the panel is wide or narrow.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { cMapUrl, standardFontDataUrl, workerSrc } from 'virtual:kiki-pdf-assets';

import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';

let modulePromise: Promise<typeof import('pdfjs-dist')> | undefined;

/** Loads PDF.js once per app run, on the first PDF the user opens. */
function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  modulePromise ??= import('pdfjs-dist').then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = workerSrc;
    return mod;
  });
  return modulePromise;
}

export type PdfPageState = 'loading' | 'ready' | 'failed';

export interface PdfPageViewProps {
  /** The connection that owns the file; its client carries the bearer token. */
  readonly client: KikiClient | undefined;
  /**
   * The asset URL the document-preview response returned. Read through the
   * client, not fetched from the page, because the route is authenticated.
   */
  readonly assetUrl: string;
  readonly page: number;
  /** Name for the alternative text and the failure message. */
  readonly name: string;
  /** Real page count, once the document has loaded. */
  readonly onPageCount?: (numPages: number) => void;
  readonly onRetry?: () => void;
}

export function PdfPageView({ client, assetUrl, page, name, onPageCount, onRetry }: PdfPageViewProps) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<PdfPageState>('loading');
  const [aspect, setAspect] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => { setAttempt((value) => value + 1); }, []);
  const reportedPages = useRef(0);
  const lastError = useRef<string | undefined>(undefined);

  useEffect(() => { reportedPages.current = 0; }, [assetUrl]);

  useEffect(() => {
    if (client === undefined) {
      setState('failed');
      setFailure(t('preview.failed'));
      return;
    }
    let cancelled = false;
    let document: PDFDocumentProxy | undefined;
    let cancelRender: (() => void) | undefined;
    setState('loading');
    lastError.current = undefined;

    const run = async (): Promise<void> => {
      const pdfjs = await loadPdfJs();
      if (cancelled) return;
      const { bytes } = await client.readDocumentPreviewAsset(assetUrl);
      if (cancelled) return;
      // pdf.js takes ownership of the buffer it is given, so hand it a copy and
      // keep the client's bytes intact for the next page.
      const data = bytes.slice().buffer;
      const task = pdfjs.getDocument({
        data,
        cMapUrl,
        cMapPacked: true,
        standardFontDataUrl,
      });
      document = await task.promise;
      if (cancelled) return;
      if (reportedPages.current !== document.numPages) {
        reportedPages.current = document.numPages;
        onPageCount?.(document.numPages);
      }

      const pageNumber = Math.min(Math.max(1, page), document.numPages);
      const pdfPage = await document.getPage(pageNumber);
      if (cancelled) return;
      const node = canvas.current;
      if (node === null) return;
      // Scale to the canvas's real laid-out width so the page keeps its own
      // proportions in a narrow panel instead of stretching.
      const cssWidth = Math.max(240, node.clientWidth || node.parentElement?.clientWidth || 640);
      const unit = pdfPage.getViewport({ scale: 1 });
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: (cssWidth / unit.width) * dpr });
      node.width = Math.floor(viewport.width);
      node.height = Math.floor(viewport.height);
      // The CSS box is the page's own shape. CSS `aspect-ratio` reads
      // width / height, and the document's proportions are the viewport's —
      // a portrait page must not come out sideways.
      setAspect(unit.width / unit.height);
      const context = node.getContext('2d');
      if (context === null) return;
      const renderTask = pdfPage.render({ canvasContext: context, viewport });
      cancelRender = () => { renderTask.cancel(); };
      await renderTask.promise;
      pdfPage.cleanup();
      if (!cancelled) setState('ready');
    };

    run().catch((error: unknown) => {
      if (cancelled) return;
      setState('failed');
      lastError.current = error instanceof Error ? error.message : String(error);
      setFailure(t('preview.pdfFailed'));
    });

    return () => {
      cancelled = true;
      cancelRender?.();
      document?.destroy();
    };
  }, [assetUrl, attempt, client, onPageCount, page, t]);

  return (
    <div className="mx-auto w-full max-w-[900px]" data-pdf-page data-page={page} data-state={state} title={lastError.current}>
      {state === 'failed' ? (
        <div className="flex flex-col items-start gap-2.5 rounded-lg border border-danger bg-[#fbeceb] px-3 py-2.5" role="alert">
          <p className="text-[12px] text-danger">{failure ?? t('preview.pdfFailed')}</p>
          <button
            type="button"
            onClick={() => { reload(); onRetry?.(); }}
            className="text-[12px] font-medium text-danger underline underline-offset-2"
            data-retry-pdf
          >
            {t('preview.tryAgain')}
          </button>
        </div>
      ) : (
        <>
          <canvas
            ref={canvas}
            className="block w-full rounded-[3px] bg-white shadow-[var(--kiki-sheet-shadow)]"
            style={aspect === null ? undefined : { aspectRatio: String(aspect) }}
            aria-label={t('preview.pageAlt', { name, page: String(page) })}
          />
          {state === 'loading' ? (
            <div className="mt-2 flex items-center justify-center gap-2 text-[11.5px] text-ink-faint" role="status">
              <span className="h-1 w-1 animate-pulse rounded-full bg-ink-faint" aria-hidden />
              {t('preview.rendering')}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
