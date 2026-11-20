import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '@kiki/session-core/composer/media';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import type { HostSaveSink } from '../host/host';
import { browserSaveSink, bufferedSaveSink } from '../host/saveSink';
import { useCoarsePointer } from '../lib/layoutHooks';
import { useOptionalConnection } from '../state/connection';
import { Dialog } from './Dialog';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { Icon } from './icons';
import { copyImageBitmap, httpImageLink, imageCopyFailureText, imageDownloadFailureText, imageDownloadSink, imageDownloadStep, imageMenuEntries, isOnKikiComputer, noteMediaReady, saveMediaToDisk } from './imageActions';
import { copyImageToClipboard } from '../lib/clipboard';
import { imagePreviewDownloadName, imagePreviewLabel } from './imagePreviewName';
import { useDevicePixelRatio, useDragPan, MAX_ZOOM, MIN_ZOOM, ZOOM_STEPS, zoomPercentOf } from './ImageViewport';
import { ImageViewportAnnotations, renderAnnotatedImage, scaleAnnotationMarks, type AnnotationTool, type ImageAnnotation } from './ImageViewportAnnotations';
import { errorToText } from '@kiki/session-core/util';
import { pushToast } from '../lib/toasts';

const controlClass = 'rounded-full border border-shell-hairline bg-shell-hover px-3 py-1 text-[11.5px] font-medium text-shell-ink transition-colors hover:bg-shell-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink';
const zoomButtonClass = 'flex h-6 w-6 items-center justify-center rounded-full text-shell-ink transition-colors hover:bg-shell-hairline disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink';

/**
 * The address a reader can act on, with credentials stripped: a query or hash
 * can carry a token, and an info line is not the place to publish one.
 */
export function mediaSourceLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  if (!/^(?:https?|wss?):\/\//i.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    const credentials = url.username === '' && url.password === '' ? '' : '…@';
    const redacted = url.search !== '' || url.hash !== '';
    return `${url.protocol}//${credentials}${url.host}${url.pathname}${redacted ? '?…' : ''}`;
  } catch {
    return trimmed.replace(/(?:\?|#).*$/, '?…');
  }
}

export interface AnnotationRecord {
  readonly baseWidth: number;
  readonly baseHeight: number;
  readonly marks: readonly ImageAnnotation[];
}

function projectAnnotations(
  record: AnnotationRecord | undefined,
  targetWidth: number | undefined,
  targetHeight: number | undefined,
): readonly ImageAnnotation[] {
  if (record === undefined || record.marks.length === 0) return [];
  if (
    targetWidth === undefined ||
    targetHeight === undefined ||
    targetWidth <= 0 ||
    targetHeight <= 0 ||
    record.baseWidth <= 0 ||
    record.baseHeight <= 0 ||
    (record.baseWidth === targetWidth && record.baseHeight === targetHeight)
  ) {
    return record.marks;
  }
  return scaleAnnotationMarks(record.marks, targetWidth / record.baseWidth, targetHeight / record.baseHeight);
}

export const LIGHTBOX_THUMB_WINDOW_RADIUS = 16;

export interface MediaLightboxThumbnail {
  readonly id: string;
  readonly src?: string;
  readonly label?: string;
}

export function computeLightboxThumbWindow(
  index: number,
  count: number,
  radius = LIGHTBOX_THUMB_WINDOW_RADIUS,
): { readonly start: number; readonly end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  const maxWindow = radius * 2 + 1;
  if (count <= maxWindow) return { start: 0, end: count };
  const clamped = Math.max(0, Math.min(count - 1, index));
  const start = Math.max(0, Math.min(clamped - radius, count - maxWindow));
  return { start, end: Math.min(count, start + maxWindow) };
}

export function MediaLightbox({ src, name, identity = src ?? 'image', loading = false, failed: sourceFailed = false, onRetry, index = 0, count = 1, thumbnails, onSelect, onClose, sourcePath, linkUrl, outcomeKey, localKikiComputer, remote, mime, size, onSaveOriginal, savedAnnotations, onAnnotationsChange, onAttachAnnotatedImage }: {
  src?: string; name?: string; identity?: string; loading?: boolean; failed?: boolean; onRetry?: () => void;
  index?: number; count?: number; thumbnails?: readonly MediaLightboxThumbnail[]; onSelect?: (index: number) => void; onClose: () => void;
  sourcePath?: string; linkUrl?: string; outcomeKey?: string; localKikiComputer?: boolean; remote?: boolean;
  /** What the viewer actually holds, when the caller knows it — never inferred here. */
  mime?: string; size?: number;
  onSaveOriginal?: (sink: HostSaveSink, signal: AbortSignal, onProgress: (bytes: number, total?: number) => void) => Promise<void>;
  savedAnnotations?: Readonly<Record<string, AnnotationRecord>>;
  onAnnotationsChange?: (updater: (previous: Record<string, AnnotationRecord>) => Record<string, AnnotationRecord>) => void;
  onAttachAnnotatedImage?: (blob: Blob, filename: string) => Promise<boolean> | boolean;
}) {
  const { t } = useI18n();
  const host = useHost();
  const coarsePointer = useCoarsePointer();
  const connection = useOptionalConnection();
  const onKikiComputer =
    localKikiComputer ??
    (remote !== undefined ? !remote : isOnKikiComputer(connection));
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [natural, setNatural] = useState<{ width: number; height: number }>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>('arrow');
  const [selected, setSelected] = useState<number>();
  const [localAnnotations, setLocalAnnotations] = useState<Record<string, AnnotationRecord>>({});
  const annotations = savedAnnotations ?? localAnnotations;
  const setAnnotations = onAnnotationsChange ?? setLocalAnnotations;
  const [history, setHistory] = useState<AnnotationRecord[]>([]);
  const [saveFailed, setSaveFailed] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [transfer, setTransfer] = useState<{ status: 'idle' | 'downloading' | 'saving' | 'saved' | 'failed'; bytes?: number; total?: number; message?: string }>({ status: 'idle' });
  const downloadController = useRef<AbortController | null>(null);
  const editStart = useRef<AnnotationRecord | undefined>(undefined);
  const currentAnnotationRecord = annotations[identity];
  const marks = useMemo(
    () => projectAnnotations(currentAnnotationRecord, natural?.width, natural?.height),
    [currentAnnotationRecord, natural?.width, natural?.height],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const handleScrollerRef = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    setScrollerEl((current) => (current === node ? current : node));
  }, []);
  const image = useRef<HTMLImageElement>(null);
  const zoomAnchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const dpr = useDevicePixelRatio();
  const detailsId = useId();
  const pan = useDragPan(zoom !== 'fit' && !editing);
  const label = imagePreviewLabel({ name }, t('media.image'));
  const [viewportDims, setViewportDims] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  }));
  const [scrollerDims, setScrollerDims] = useState<{ readonly width: number; readonly height: number }>({ width: 0, height: 0 });

  useEffect(() => () => { downloadController.current?.abort(); }, []);

  useEffect(() => {
    const onResize = () => {
      setViewportDims({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, []);

  useLayoutEffect(() => {
    const node = scrollerEl;
    if (node === null) return;
    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setScrollerDims((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [scrollerEl, identity, loading, failed, sourceFailed]);

  useLayoutEffect(() => {
    setZoom('fit');
    setNatural(undefined);
    setDetailsOpen(false);
    setFailed(false);
    setMenu(null);
    setEditing(false);
    setSelected(undefined);
    setHistory([]);
    setSaveFailed(false);
    downloadController.current?.abort();
    setTransfer({ status: 'idle' });
    zoomAnchor.current = null;
    if (scroller.current !== null) { scroller.current.scrollTop = 0; scroller.current.scrollLeft = 0; }
  }, [identity]);
  useEffect(() => { setFailed(false); }, [src]);
  useEffect(() => {
    if (loading || failed || sourceFailed || scroller.current === null) return;
    const active = document.activeElement;
    const panel = scroller.current.closest('[role="dialog"]');
    if (!(active instanceof HTMLElement) || panel === null || !panel.contains(active)) scroller.current.focus({ preventScroll: true });
  }, [loading, failed, sourceFailed, src, editing]);
  useEffect(() => {
    if (menu !== null) document.querySelector<HTMLButtonElement>('[data-lightbox-image-menu] [role="menuitem"]')?.focus();
  }, [menu]);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (anchor === null || scroller.current === null || image.current === null) return;
    scroller.current.scrollLeft = image.current.offsetLeft + anchor.fx * image.current.offsetWidth - anchor.px;
    scroller.current.scrollTop = image.current.offsetTop + anchor.fy * image.current.offsetHeight - anchor.py;
  }, [zoom, natural]);

  const anchorAt = (point?: { x: number; y: number }) => {
    if (scroller.current === null || image.current === null) return;
    const box = scroller.current.getBoundingClientRect();
    const rect = image.current.getBoundingClientRect();
    const x = point?.x ?? box.left + box.width / 2;
    const y = point?.y ?? box.top + box.height / 2;
    zoomAnchor.current = { fx: rect.width === 0 ? 0.5 : Math.max(0, Math.min(1, (x - rect.left) / rect.width)), fy: rect.height === 0 ? 0.5 : Math.max(0, Math.min(1, (y - rect.top) / rect.height)), px: x - box.left, py: y - box.top };
  };
  const applyZoom = (next: 'fit' | number, point?: { x: number; y: number }) => {
    // Enlarging from fit with no pointer under it starts at the picture's own
    // top-left: a long screenshot opened at its middle is a screenshot lost.
    if (point === undefined && zoom === 'fit') zoomAnchor.current = { fx: 0, fy: 0, px: 0, py: 0 };
    else anchorAt(point);
    setZoom(next);
  };
  /** Fit ⇄ 100%, the gesture the chip and a click on the picture share. */
  const switchZoom = (point?: { x: number; y: number }) => {
    applyZoom(zoom === 'fit' ? 100 : 'fit', point);
  };
  const zoomIn = () => {
    const current = zoom === 'fit' ? fitPercent : zoom;
    applyZoom(ZOOM_STEPS.find((step) => step > current) ?? MAX_ZOOM);
  };
  const zoomOut = () => {
    const current = zoom === 'fit' ? fitPercent : zoom;
    applyZoom(ZOOM_STEPS.toReversed().find((step) => step < current) ?? MIN_ZOOM);
  };
  const changeMarks = (next: readonly ImageAnnotation[]) => {
    const baseWidth = natural?.width ?? currentAnnotationRecord?.baseWidth ?? 1;
    const baseHeight = natural?.height ?? currentAnnotationRecord?.baseHeight ?? 1;
    setHistory((previous) => [
      ...previous,
      currentAnnotationRecord ?? { baseWidth, baseHeight, marks: [] },
    ]);
    setAnnotations((previous) => ({
      ...previous,
      [identity]: { baseWidth, baseHeight, marks: next },
    }));
    setSaveFailed(false);
  };
  const finishEdit = () => {
    setEditing(false);
    setSelected(undefined);
    setHistory([]);
  };
  const cancelEdit = () => {
    setAnnotations((previous) => {
      if (editStart.current === undefined) {
        const next = { ...previous };
        delete next[identity];
        return next;
      }
      return { ...previous, [identity]: editStart.current };
    });
    setEditing(false);
    setSelected(undefined);
    setHistory([]);
  };
  const dismiss = () => {
    if (menu !== null) setMenu(null);
    else if (transfer.status === 'saving') return;
    else if (editing) finishEdit();
    else onClose();
  };
  const save = async (annotated: boolean) => {
    if (src === undefined && (annotated || onSaveOriginal === undefined)) return;
    setSaveFailed(false);
    const downloadName = imagePreviewDownloadName({ name });
    if (annotated) {
      if (src === undefined) return;
      try {
        const blob = await renderAnnotatedImage(
          src,
          currentAnnotationRecord?.marks ?? marks,
          currentAnnotationRecord === undefined
            ? undefined
            : { width: currentAnnotationRecord.baseWidth, height: currentAnnotationRecord.baseHeight },
        );
        const filename = `${downloadName.replace(/\.[^.]+$/, '')}-annotated.png`;
        if (host.saveBlob !== undefined) await host.saveBlob(blob, filename);
        else {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
          document.body.append(anchor); anchor.click(); anchor.remove();
          setTimeout(() => { URL.revokeObjectURL(url); }, 0);
        }
      } catch (error) {
        setSaveFailed(true);
        pushToast({ tone: 'error', text: t('media.annotationDownloadFailed'), detail: errorToText(error) });
      }
      return;
    }

    if (onSaveOriginal !== undefined) {
      downloadController.current?.abort();
      const controller = new AbortController();
      downloadController.current = controller;
      let sink: HostSaveSink | null = null;
      setTransfer({ status: 'downloading', bytes: 0 });
      try {
        sink = await imageDownloadStep('write', () => host.openSaveSink !== undefined ? host.openSaveSink(downloadName)
          : host.saveBlob !== undefined ? Promise.resolve(bufferedSaveSink((blob) => host.saveBlob!(blob, downloadName)))
          : browserSaveSink(downloadName));
        if (sink === null) {
          if (!controller.signal.aborted) setTransfer({ status: 'idle' });
          return;
        }
        controller.signal.throwIfAborted();
        const target = imageDownloadSink(sink);
        await imageDownloadStep('read', () => onSaveOriginal(target, controller.signal, (bytes, total) => {
          if (!controller.signal.aborted) setTransfer({ status: 'downloading', bytes, total });
        }));
        controller.signal.throwIfAborted();
        setTransfer({ status: 'saving' });
        const saved = await target.close();
        if (!controller.signal.aborted) setTransfer({ status: saved ? 'saved' : 'idle' });
      } catch (error) {
        await sink?.abort().catch(() => {});
        if (!controller.signal.aborted) {
          const message = imageDownloadFailureText(error, t);
          setTransfer({ status: 'failed', message });
          pushToast({ tone: 'error', text: message, detail: errorToText(error) });
        }
      } finally {
        if (downloadController.current === controller) downloadController.current = null;
      }
      return;
    }

    try {
      await saveMediaToDisk({ url: src }, downloadName, host, undefined, undefined);
    } catch (error) {
      pushToast({ tone: 'error', text: imageDownloadFailureText(error, t), detail: errorToText(error) });
    }
  };
  const copyImage = async () => {
    if (src === undefined) return;
    try {
      if (marks.length > 0) {
        const blobPromise = renderAnnotatedImage(
          src,
          currentAnnotationRecord?.marks ?? marks,
          currentAnnotationRecord === undefined
            ? undefined
            : { width: currentAnnotationRecord.baseWidth, height: currentAnnotationRecord.baseHeight },
        );
        await copyImageToClipboard(blobPromise);
        return;
      }
      await copyImageBitmap(src);
    } catch (error) {
      pushToast({
        tone: 'error',
        text: imageCopyFailureText(error, t, host.kind),
        detail: errorToText(error),
        retry: { run: () => { void copyImage(); } },
      });
    }
  };
  const attachAnnotatedImage = async () => {
    if (src === undefined || onAttachAnnotatedImage === undefined || marks.length === 0 || attaching) return;
    setSaveFailed(false);
    setAttaching(true);
    try {
      const downloadName = imagePreviewDownloadName({ name });
      const blob = await renderAnnotatedImage(
        src,
        currentAnnotationRecord?.marks ?? marks,
        currentAnnotationRecord === undefined
          ? undefined
          : { width: currentAnnotationRecord.baseWidth, height: currentAnnotationRecord.baseHeight },
      );
      const filename = `${downloadName.replace(/\.[^.]+$/, '')}-annotated.png`;
      const attached = await onAttachAnnotatedImage(blob, filename);
      if (attached) onClose();
    } catch (error) {
      setSaveFailed(true);
      pushToast({ tone: 'error', text: t('media.annotationDownloadFailed'), detail: errorToText(error) });
    } finally {
      setAttaching(false);
    }
  };
  const menuEntries: MiniMenuEntry[] = imageMenuEntries({
    t,
    src,
    path: sourcePath,
    link: linkUrl ?? httpImageLink(src),
    localKikiComputer: onKikiComputer,
    revealPath: host.revealPath,
    openPath: host.openPath,
    canCopyImage: src !== undefined && !loading && !failed && !sourceFailed,
    canSave: src !== undefined || onSaveOriginal !== undefined,
    annotated: marks.length > 0,
    onCopyImage: copyImage,
    onSave: () => save(false),
    onSaveAnnotated: () => save(true),
  });

  const fitWidth = scrollerDims.width > 0 ? scrollerDims.width : viewportDims.width * 0.92;
  const fitHeight = scrollerDims.height > 0 ? scrollerDims.height : viewportDims.height * 0.75;
  const fitScale = natural === undefined || natural.width <= 0 || natural.height <= 0 ? 1
    : Math.min(1, fitWidth / natural.width, fitHeight / natural.height);
  const fitPercent = zoomPercentOf(fitScale, dpr);
  const percent = zoom === 'fit' ? fitPercent : zoom;
  const scale = zoom === 'fit' ? fitScale : zoom / (100 * dpr);
  const displayWidth = natural === undefined ? undefined : natural.width * scale;
  const sliderMin = Math.min(MIN_ZOOM, Math.max(1, Math.floor(fitPercent)));
  const mode = zoom === 'fit' ? 'fit' : percent === 100 ? 'actual' : 'custom';
  const source = !onKikiComputer ? linkUrl : (linkUrl ?? sourcePath);
  const shownSource = mediaSourceLabel(source);
  const zoomable = natural !== undefined && !loading && !failed && !sourceFailed;
  const wheelZoomRef = useRef({ zoomable, percent, sliderMin, applyZoom });
  wheelZoomRef.current = { zoomable, percent, sliderMin, applyZoom };
  useEffect(() => {
    const node = scrollerEl;
    if (node === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const current = wheelZoomRef.current;
      if (!current.zoomable || event.deltaY === 0) return;
      event.preventDefault();
      const factor = Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * 0.0025);
      const raw = Math.round(current.percent * factor);
      const stepped = raw === current.percent ? current.percent + (event.deltaY < 0 ? 1 : -1) : raw;
      const next = Math.min(MAX_ZOOM, Math.max(current.sliderMin, stepped));
      current.applyZoom(next, { x: event.clientX, y: event.clientY });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => { node.removeEventListener('wheel', onWheel); };
  }, [scrollerEl]);
  const thumbWindow = useMemo(
    () => (thumbnails !== undefined && thumbnails.length > 1 ? computeLightboxThumbWindow(index, thumbnails.length) : null),
    [thumbnails, index],
  );
  const details = [
    natural === undefined ? undefined : `${natural.width} × ${natural.height}`,
    mime,
    size === undefined ? undefined : formatBytes(size),
  ].filter((part): part is string => part !== undefined && part !== '');

  return <Dialog onClose={dismiss} ariaLabel={label} overlayId="media-lightbox"
    overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-shell/85 p-4 pt-[max(1rem,var(--kiki-safe-top-inset))] pb-[max(1rem,var(--kiki-safe-bottom-inset))]"
    panelClassName="anim-enter flex max-h-full w-full max-w-[94vw] flex-col items-center gap-3 outline-none">
    <div className="flex w-full min-h-0 flex-col items-center gap-3" onKeyDown={(event) => {
      if (event.defaultPrevented || menu !== null || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]') !== null)) return;
      if (editing) {
        if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== undefined) { event.preventDefault(); event.stopPropagation(); changeMarks(marks.filter((mark) => mark.id !== selected)); setSelected(undefined); }
        return;
      }
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); event.stopPropagation(); onSelect?.(index - 1); }
      else if (event.key === 'ArrowRight' && index < count - 1) { event.preventDefault(); event.stopPropagation(); onSelect?.(index + 1); }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); event.stopPropagation(); zoomIn(); }
      else if (event.key === '-') { event.preventDefault(); event.stopPropagation(); zoomOut(); }
      else if (event.key === '0') { event.preventDefault(); event.stopPropagation(); applyZoom('fit'); }
      else if (event.key === '1') { event.preventDefault(); event.stopPropagation(); applyZoom(100); }
      else if (event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        if (scroller.current !== null) scroller.current.scrollTop += (event.key === 'PageUp' || event.key === 'ArrowUp' ? -1 : 1) * (event.key.startsWith('Page') ? scroller.current.clientHeight * 0.85 : 60);
      }
    }}>
      {/* Header: the object's own name, then one row of viewing controls */}
      <div className="flex w-full max-w-full items-center gap-2">
        <div className="min-w-0 flex-1 truncate px-2 font-mono text-[11px] text-shell-ink">
          {name !== undefined && name !== '' ? <span title={name}>{name}</span> : null}
          {natural !== undefined ? <span className="ml-1.5 text-shell-ink/70">{natural.width} × {natural.height}</span> : null}
        </div>
        {coarsePointer && menuEntries.length > 0 ? (
          <button
            type="button"
            data-lightbox-more
            aria-label={t('preview.moreActions')}
            title={t('preview.moreActions')}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right, y: rect.bottom + 4 });
            }}
            className={`${controlClass} flex h-11 w-11 items-center justify-center !p-0`}
          >
            <Icon name="more" size={16} />
          </button>
        ) : null}
        <button
          type="button"
          disabled={transfer.status === 'saving'}
          onClick={onClose}
          aria-label={t('common.close')}
          className={coarsePointer ? `${controlClass} flex h-11 w-11 items-center justify-center !p-0` : controlClass}
        >
          <Icon name="close" size={coarsePointer ? 16 : 12} />
        </button>
      </div>
      <div className="relative flex max-w-full flex-wrap items-center justify-center gap-2">
        {count > 1 ? <>
          <button type="button" disabled={index === 0 || editing} onClick={() => onSelect?.(index - 1)} aria-label={t('media.previousImage')} className={controlClass}>‹</button>
          <span aria-live="polite" className="font-mono text-[11px] text-shell-ink">{t('media.imagePosition', { current: index + 1, total: count })}</span>
          <button type="button" disabled={index === count - 1 || editing} onClick={() => onSelect?.(index + 1)} aria-label={t('media.nextImage')} className={controlClass}>›</button>
        </> : null}
        <div role="group" aria-label={t('preview.zoomGroup')} data-lightbox-zoom-controls
          className="flex items-center gap-1 rounded-full border border-shell-hairline bg-shell-hover px-1.5 py-1">
          <button type="button" aria-label={t('media.zoomOut')} title={t('media.zoomOut')} disabled={!zoomable || percent <= sliderMin} onClick={zoomOut} className={zoomButtonClass}><Icon name="dash" size={14} /></button>
          <input type="range" min={sliderMin} max={MAX_ZOOM} step={1} value={Math.min(MAX_ZOOM, Math.max(sliderMin, percent))}
            aria-label={t('preview.zoomGroup')} aria-valuetext={`${percent}%`} data-lightbox-zoom-slider disabled={!zoomable}
            onChange={(event) => { applyZoom(Number(event.currentTarget.value)); }}
            className="h-1 w-24 cursor-pointer accent-accent disabled:cursor-default disabled:opacity-40" />
          <button type="button" aria-label={t('media.zoomIn')} title={t('media.zoomIn')} disabled={!zoomable || percent >= MAX_ZOOM} onClick={zoomIn} className={zoomButtonClass}><Icon name="plus" size={14} /></button>
          <span data-lightbox-zoom className="w-10 shrink-0 text-right font-mono text-[11px] text-shell-ink">{percent}%</span>
        </div>
        <button type="button" data-autofocus disabled={!zoomable} onClick={() => { switchZoom(); }} className={controlClass}>{zoom === 'fit' ? t('media.zoomActual') : t('media.zoomFit')}</button>
        {details.length === 0 && shownSource === undefined ? null : (
          // Details ride a hover/keyboard popup, not a click toggle: the picture
          // keeps the whole stage, and a click or tap never pins a panel over it.
          // Keyboard entry is Tab focus (:focus-visible) or an explicit
          // Enter/Space expand. A mouse click or touch tap focuses without
          // :focus-visible, so it opens nothing and leaves nothing behind.
          <span className="group static inline-flex">
            <button type="button" aria-label={t('media.details')} title={t('media.details')}
              aria-describedby={detailsId} aria-expanded={detailsOpen}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                setDetailsOpen((value) => !value);
              }}
              onBlur={() => { setDetailsOpen(false); }}
              className={`${controlClass} focus-visible:!border-accent focus-visible:!text-accent group-hover:!border-accent group-hover:!text-accent`}>
              <Icon name="info" />
            </button>
            <span id={detailsId} data-lightbox-info role="tooltip"
              className={`absolute left-1/2 top-full z-10 mt-1.5 flex w-max max-w-[min(92vw,560px)] -translate-x-1/2 flex-col items-center gap-1 rounded-2xl border border-shell-hairline bg-shell/90 px-3.5 py-2 font-mono text-[11px] text-shell-ink shadow-lg backdrop-blur-md transition-opacity duration-150 ${
                detailsOpen ? 'visible opacity-100' : 'invisible opacity-0 group-hover:visible group-hover:opacity-100 group-has-[:focus-visible]:visible group-has-[:focus-visible]:opacity-100'
              }`}>
              {details.length === 0 ? null : <span className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">{details.map((part) => <span key={part}>{part}</span>)}</span>}
              {shownSource === undefined ? null : (
                <span className="flex min-w-0 max-w-full items-start gap-1.5">
                  <Icon name={/^https?:/i.test(shownSource) ? 'web' : 'folder'} size={12} className="mt-0.5 shrink-0 text-shell-ink/60" />
                  <span data-lightbox-source className="min-w-0 break-all">{shownSource}</span>
                </span>
              )}
            </span>
          </span>
        )}
      </div>

      {transfer.status !== 'idle' ? (
        <div role={transfer.status === 'failed' ? 'alert' : 'status'} className="flex shrink-0 items-center justify-center gap-3 rounded-full border border-shell-hairline bg-shell/80 px-3 py-1 text-[11px] text-shell-ink shadow-sm backdrop-blur-md">
          {transfer.status === 'downloading' ? <>
            <span className="font-mono">{formatBytes(transfer.bytes ?? 0)}{transfer.total === undefined ? '' : ` / ${formatBytes(transfer.total)}`}</span>
            <button type="button" onClick={() => { downloadController.current?.abort(); setTransfer({ status: 'idle' }); }} className="text-accent">{t('common.cancel')}</button>
          </> : transfer.status === 'saving' ? t('preview.saving') : transfer.status === 'saved' ? t('preview.saved') : <>
            <span className="text-danger">{transfer.message}</span>
            <button type="button" onClick={() => { void save(false); }} className="text-accent underline">{t('transcript.detail.retry')}</button>
          </>}
        </div>
      ) : null}
      {saveFailed ? <div role="alert" className="text-sm text-shell-ink">{t('media.annotationDownloadFailed')}</div> : null}
      <div ref={handleScrollerRef} tabIndex={0} data-lightbox-viewport={mode} aria-label={label}
        {...pan.handlers}
        onContextMenu={(event) => { if (src === undefined) return; event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: event.clientX || rect.left, y: event.clientY || rect.top }); }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const target = image.current ?? scroller.current;
            if (target !== null) {
              const rect = target.getBoundingClientRect();
              setMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }
          }
        }}
        className={`relative min-h-0 max-h-[75vh] w-full select-none overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${editing ? '' : zoom !== 'fit' ? pan.dragging ? 'cursor-grabbing' : 'cursor-grab' : 'cursor-zoom-in'}`}>
        {loading ? <div aria-busy="true" className="flex min-h-48 items-center justify-center text-sm text-shell-ink">{t('preview.loading')}</div>
          : failed || sourceFailed ? <div role="alert" data-lightbox-failure className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-shell-ink"><span>{t('media.unavailable', { name: label })}</span><button type="button" onClick={() => { setFailed(false); setNatural(undefined); setAttempt((value) => value + 1); onRetry?.(); }} className={controlClass}>{t('transcript.detail.retry')}</button></div>
            : <div className="relative mx-auto" style={{ width: displayWidth, maxWidth: zoom === 'fit' ? '100%' : 'none' }}>
              <img ref={image} key={`${identity}:${attempt}`} src={src} alt={label} referrerPolicy="no-referrer" tabIndex={0} draggable={false} decoding="async"
                onError={() => { setFailed(true); }} onLoad={(event) => {
                  const nextWidth = event.currentTarget.naturalWidth;
                  const nextHeight = event.currentTarget.naturalHeight;
                  if (
                    natural !== undefined &&
                    natural.width > 0 &&
                    natural.height > 0 &&
                    nextWidth > 0 &&
                    nextHeight > 0 &&
                    (nextWidth !== natural.width || nextHeight !== natural.height) &&
                    zoom !== 'fit'
                  ) {
                    anchorAt();
                    const nextFitScale = Math.min(1, fitWidth / nextWidth, fitHeight / nextHeight);
                    const nextSliderMin = Math.min(MIN_ZOOM, Math.max(1, Math.floor(zoomPercentOf(nextFitScale, dpr))));
                    setZoom(Math.min(MAX_ZOOM, Math.max(nextSliderMin, Math.round(zoom * (natural.width / nextWidth)))));
                  }
                  setNatural({ width: nextWidth, height: nextHeight });
                  noteMediaReady(outcomeKey ?? (src === undefined ? undefined : `url:${src}`));
                }}
                onClick={(event) => { if (!editing && !pan.consumePan()) switchZoom({ x: event.clientX, y: event.clientY }); }} className="block h-auto w-full rounded-lg" />
              {natural === undefined ? null : <ImageViewportAnnotations key={`${identity}:${editing}`} width={natural.width} height={natural.height} marks={marks} tool={tool} editing={editing} selected={selected} onSelect={setSelected} onChange={changeMarks} />}
            </div>}
      </div>

      {/* Windowed filmstrip for multi-image galleries: mounts only ~33 thumbnails around active index */}
      {!editing && thumbnails !== undefined && thumbWindow !== null ? (
        <div
          data-lightbox-filmstrip
          role="listbox"
          aria-label={t('media.image')}
          className="flex max-w-full items-center gap-1.5 overflow-x-auto rounded-full border border-shell-hairline bg-shell/75 px-2.5 py-1.5 backdrop-blur-md"
        >
          {thumbWindow.start > 0 ? (
            <span data-lightbox-filmstrip-before className="shrink-0 px-1 font-mono text-[10.5px] text-shell-ink/60 tabular-nums">
              +{thumbWindow.start}
            </span>
          ) : null}
          {thumbnails.slice(thumbWindow.start, thumbWindow.end).map((thumb, offset) => {
            const thumbIndex = thumbWindow.start + offset;
            const active = thumbIndex === index;
            const thumbLabel = thumb.label ?? `${t('media.image')} ${thumbIndex + 1}`;
            return (
              <button
                key={thumb.id}
                type="button"
                role="option"
                aria-selected={active}
                data-lightbox-thumb={thumbIndex}
                title={thumbLabel}
                aria-label={thumbLabel}
                onClick={() => { onSelect?.(thumbIndex); }}
                className={`relative flex h-8 w-10 shrink-0 items-center justify-center overflow-hidden rounded border transition-opacity focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${
                  active
                    ? 'border-accent opacity-100 ring-1 ring-accent'
                    : 'border-shell-hairline/70 opacity-60 hover:opacity-100'
                }`}
              >
                {thumb.src !== undefined ? (
                  <img
                    src={thumb.src}
                    alt={thumbLabel}
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="font-mono text-[10px] text-shell-ink/75 tabular-nums">{thumbIndex + 1}</span>
                )}
              </button>
            );
          })}
          {thumbWindow.end < thumbnails.length ? (
            <span data-lightbox-filmstrip-after className="shrink-0 px-1 font-mono text-[10.5px] text-shell-ink/60 tabular-nums">
              +{thumbnails.length - thumbWindow.end}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Bottom dock: viewing mode has clear entry; editing mode has explicit state badge & full toolset */}
      <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
        {!editing ? (
          <>
            <button
              type="button"
              disabled={natural === undefined || loading || failed || sourceFailed}
              onClick={() => { editStart.current = currentAnnotationRecord; setHistory([]); setEditing(true); }}
              className={controlClass}
            >
              {t('media.startAnnotation')}
            </button>
            {marks.length > 0 && onAttachAnnotatedImage !== undefined ? (
              <button
                type="button"
                data-lightbox-attach-annotated
                disabled={attaching || src === undefined || loading || failed || sourceFailed}
                onClick={() => { void attachAnnotatedImage(); }}
                className={`${controlClass} !border-accent !bg-accent font-semibold !text-on-accent hover:opacity-90`}
              >
                {t('preview.addToChat')}
              </button>
            ) : null}
          </>
        ) : (
          <div role="toolbar" aria-label={t('media.annotationMode')} className="flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-shell-hairline bg-shell/80 px-3 py-1 shadow-lg backdrop-blur-md">
            <span role="status" aria-live="polite" className="font-medium text-[11.5px] text-accent-ink px-1.5">{t('media.annotationMode')}</span>
            <div className="h-3 w-px bg-shell-hairline" />
            {(['select', 'arrow', 'rectangle', 'pen'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={tool === option}
                onClick={() => { setTool(option); }}
                className={`${controlClass} ${tool === option ? '!border-accent !bg-accent !text-on-accent' : ''}`}
              >
                {t(option === 'select' ? 'media.annotationSelect' : option === 'arrow' ? 'media.annotationArrow' : option === 'rectangle' ? 'media.annotationRectangle' : 'media.annotationPen')}
              </button>
            ))}
            <button
              type="button"
              disabled={history.length === 0}
              onClick={() => { setAnnotations((previous) => ({ ...previous, [identity]: history.at(-1)! })); setHistory((previous) => previous.slice(0, -1)); setSelected(undefined); }}
              className={controlClass}
            >
              {t('media.annotationUndo')}
            </button>
            <button
              type="button"
              disabled={marks.length === 0}
              onClick={() => { changeMarks([]); setSelected(undefined); }}
              className={controlClass}
            >
              {t('media.annotationClear')}
            </button>
            {selected === undefined ? null : (
              <button
                type="button"
                onClick={() => { changeMarks(marks.filter((mark) => mark.id !== selected)); setSelected(undefined); }}
                className={controlClass}
              >
                {t('media.annotationDelete')}
              </button>
            )}
            <div className="h-3 w-px bg-shell-hairline" />
            {onAttachAnnotatedImage !== undefined ? (
              <button
                type="button"
                data-lightbox-attach-annotated
                disabled={marks.length === 0 || attaching || src === undefined}
                onClick={() => { void attachAnnotatedImage(); }}
                className={`${controlClass} !border-accent !bg-accent font-semibold !text-on-accent hover:opacity-90`}
              >
                {t('preview.addToChat')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={finishEdit}
              className={`${controlClass} !border-shell-hairline bg-shell-hairline/60 font-semibold text-shell-ink hover:bg-shell-hairline`}
            >
              {t('media.annotationDone')}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className={controlClass}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
      </div>
    </div>
    {menu === null ? null : <MiniContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => { setMenu(null); }} ariaLabel={label} overlayId="lightbox-image-menu" dataAttribute="data-lightbox-image-menu" modalOwnerId="media-lightbox" />}
  </Dialog>;
}
