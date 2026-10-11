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
 * The page is scaled to the canvas's own measured width, so the aspect ratio is
 * the document's own whether the panel is wide or narrow.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
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

type PdfPage = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;

type PdfLoadingTask = PDFDocumentLoadingTask & {
  readonly promise: Promise<PDFDocumentProxy>;
};

interface PdfSession {
  readonly loadingTask: PdfLoadingTask;
  document?: PDFDocumentProxy;
}

interface ActiveRender {
  readonly cancel: () => void;
}

function ignoreRejection(action: () => unknown): void {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    return;
  }
}

function disposePdfSession(session: PdfSession): void {
  if (session.document !== undefined) {
    ignoreRejection(() => session.document!.destroy());
  } else {
    ignoreRejection(() => session.loadingTask.destroy());
  }
}

function cleanupPage(page: PdfPage): void {
  try {
    page.cleanup();
  } catch {
    return;
  }
}

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (canvas === null) return;
  canvas.width = 0;
  canvas.height = 0;
}

function isRenderCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
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
  /**
   * Stable identity of the source and its connection scope. It must stay the
   * same while only the PDF page changes, and change when the source or scope
   * changes. The asset URL is used as a fallback for direct callers that do not
   * provide an identity.
   */
  readonly sourceKey?: string;
  readonly page: number;
  /** Name for the alternative text and the failure message. */
  readonly name: string;
  /** Real page count, once the document has loaded. */
  readonly onPageCount?: (numPages: number) => void;
  readonly onRetry?: () => void;
}

export function PdfPageView({ client, assetUrl, sourceKey, page, name, onPageCount, onRetry }: PdfPageViewProps) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const session = useRef<PdfSession | undefined>(undefined);
  const activeRender = useRef<ActiveRender | undefined>(undefined);
  const reportedPages = useRef(0);
  const renderedKey = useRef<string | undefined>(undefined);
  const lastError = useRef<string | undefined>(undefined);
  const assetUrlRef = useRef(assetUrl);
  const onPageCountRef = useRef(onPageCount);
  const tRef = useRef(t);
  const [state, setState] = useState<PdfPageState>('loading');
  const [aspect, setAspect] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [documentVersion, setDocumentVersion] = useState(0);
  const [contentWidth, setContentWidth] = useState<number | undefined>(undefined);
  const sourceIdentity = sourceKey ?? assetUrl;
  const layoutWidth = contentWidth ?? 640;
  const renderKey = `${sourceIdentity}\u0000${attempt}\u0000${page}\u0000${layoutWidth}`;
  const isCurrentRender = state === 'ready' && renderedKey.current === renderKey;

  assetUrlRef.current = assetUrl;
  onPageCountRef.current = onPageCount;
  tRef.current = t;

  const cancelActiveRender = useCallback(() => {
    const render = activeRender.current;
    activeRender.current = undefined;
    if (render === undefined) return;
    try {
      render.cancel();
    } catch {
      return;
    }
  }, []);

  const reload = useCallback(() => { setAttempt((value) => value + 1); }, []);

  useLayoutEffect(() => {
    clearCanvas(canvas.current);
    renderedKey.current = undefined;
    reportedPages.current = 0;
    setAspect(null);
  }, [attempt, client, sourceIdentity]);

  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const measure = (reported?: number) => {
      const measured = reported && reported > 0
        ? reported
        : element.getBoundingClientRect().width || element.clientWidth || canvas.current?.clientWidth || element.parentElement?.clientWidth || 640;
      const next = Math.max(1, Math.round(measured));
      setContentWidth((current) => current === next ? current : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => { measure(); };
      globalThis.addEventListener('resize', onResize);
      return () => { globalThis.removeEventListener('resize', onResize); };
    }
    const observer = new ResizeObserver((entries) => { measure(entries[0]?.contentRect.width); });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    const previous = session.current;
    session.current = undefined;
    cancelActiveRender();
    if (previous !== undefined) disposePdfSession(previous);
    reportedPages.current = 0;
    renderedKey.current = undefined;
    setState('loading');
    setFailure(undefined);
    setAspect(null);
    lastError.current = undefined;

    if (client === undefined) {
      setState('failed');
      setFailure(tRef.current('preview.failed'));
      return () => {
        cancelled = true;
        abort.abort();
      };
    }

    const run = async (): Promise<void> => {
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) return;
        const { bytes } = await client.readDocumentPreviewAsset(assetUrlRef.current, abort.signal);
        if (cancelled) return;
        const loadingTask = pdfjs.getDocument({
          data: bytes.slice().buffer,
          cMapUrl,
          cMapPacked: true,
          standardFontDataUrl,
        }) as PdfLoadingTask;
        const nextSession: PdfSession = { loadingTask };
        session.current = nextSession;
        const document = await loadingTask.promise;
        if (cancelled || session.current !== nextSession) {
          disposePdfSession({ loadingTask, document });
          return;
        }
        nextSession.document = document;
        if (reportedPages.current !== document.numPages) {
          reportedPages.current = document.numPages;
          onPageCountRef.current?.(document.numPages);
        }
        setDocumentVersion((value) => value + 1);
      } catch (error: unknown) {
        if (cancelled || abort.signal.aborted) return;
        setState('failed');
        lastError.current = error instanceof Error ? error.message : String(error);
        setFailure(tRef.current('preview.pdfFailed'));
      }
    };

    void run();
    return () => {
      cancelled = true;
      abort.abort();
      cancelActiveRender();
      const active = session.current;
      session.current = undefined;
      if (active !== undefined) disposePdfSession(active);
    };
  }, [attempt, cancelActiveRender, client, sourceIdentity]);

  useEffect(() => {
    const currentSession = session.current;
    const document = currentSession?.document;
    const node = canvas.current;
    if (document === undefined || node === null) return;
    let cancelled = false;
    let pageProxy: PdfPage | undefined;
    let render: ActiveRender | undefined;
    setState('loading');
    setFailure(undefined);
    clearCanvas(node);
    setAspect(null);

    const run = async (): Promise<void> => {
      try {
        const pageNumber = Math.min(Math.max(1, page), document.numPages);
        pageProxy = await document.getPage(pageNumber);
        if (cancelled || session.current !== currentSession) {
          cleanupPage(pageProxy);
          return;
        }
        const unit = pageProxy.getViewport({ scale: 1 });
        const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
        const viewport = pageProxy.getViewport({ scale: (layoutWidth / unit.width) * dpr });
        node.width = Math.floor(viewport.width);
        node.height = Math.floor(viewport.height);
        setAspect(unit.width / unit.height);
        const context = node.getContext('2d');
        if (context === null) throw new Error('PDF canvas is unavailable.');
        if (cancelled || session.current !== currentSession) return;
        const renderTask = pageProxy.render({ canvasContext: context, viewport });
        render = { cancel: () => { renderTask.cancel(); } };
        activeRender.current = render;
        await renderTask.promise;
        if (cancelled || session.current !== currentSession) return;
        renderedKey.current = renderKey;
        setState('ready');
      } catch (error: unknown) {
        if (cancelled || isRenderCancellation(error)) return;
        setState('failed');
        lastError.current = error instanceof Error ? error.message : String(error);
        setFailure(tRef.current('preview.pdfFailed'));
      } finally {
        if (render !== undefined && activeRender.current === render) activeRender.current = undefined;
        if (pageProxy !== undefined) cleanupPage(pageProxy);
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (render === undefined || activeRender.current !== render) return;
      activeRender.current = undefined;
      try {
        render.cancel();
      } catch {
        return;
      }
    };
  }, [cancelActiveRender, documentVersion, layoutWidth, page, renderKey, sourceIdentity]);

  return (
    <div ref={frame} className="mx-auto w-full max-w-[900px]" data-pdf-page data-page={page} data-state={state} title={lastError.current}>
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
            style={{ visibility: isCurrentRender ? 'visible' : 'hidden', ...(aspect === null ? {} : { aspectRatio: String(aspect) }) }}
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
