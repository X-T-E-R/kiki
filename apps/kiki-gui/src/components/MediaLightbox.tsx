import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatBytes } from '@kiki/session-core/composer/media';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import type { HostSaveSink } from '../host/host';
import { browserSaveSink, bufferedSaveSink } from '../host/saveSink';
import { Dialog } from './Dialog';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { Icon } from './icons';
import { copyImageBitmap, httpImageLink, imageMenuEntries, noteMediaReady } from './imageActions';
import { imagePreviewDownloadName, imagePreviewLabel } from './imagePreviewName';
import { useDevicePixelRatio, useDragPan } from './ImageViewport';
import { ImageViewportAnnotations, renderAnnotatedImage, type AnnotationTool, type ImageAnnotation } from './ImageViewportAnnotations';

const controlClass = 'rounded-full border border-shell-hairline bg-shell-hover px-3 py-1 text-[11.5px] font-medium text-shell-ink transition-colors hover:bg-shell-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink';

export function MediaLightbox({ src, name, identity = src ?? 'image', loading = false, failed: sourceFailed = false, onRetry, index = 0, count = 1, onSelect, onClose, sourcePath, linkUrl, outcomeKey, remote = false, onSaveOriginal }: {
  src?: string; name?: string; identity?: string; loading?: boolean; failed?: boolean; onRetry?: () => void;
  index?: number; count?: number; onSelect?: (index: number) => void; onClose: () => void;
  sourcePath?: string; linkUrl?: string; outcomeKey?: string; remote?: boolean;
  onSaveOriginal?: (sink: HostSaveSink, signal: AbortSignal, onProgress: (bytes: number, total?: number) => void) => Promise<void>;
}) {
  const { t } = useI18n();
  const host = useHost();
  const [actualSize, setActualSize] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number }>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>('arrow');
  const [selected, setSelected] = useState<number>();
  const [annotations, setAnnotations] = useState<Record<string, readonly ImageAnnotation[]>>({});
  const [history, setHistory] = useState<(readonly ImageAnnotation[])[]>([]);
  const [saveFailed, setSaveFailed] = useState(false);
  const [transfer, setTransfer] = useState<{ status: 'idle' | 'downloading' | 'saving' | 'saved' | 'failed'; bytes?: number; total?: number; message?: string }>({ status: 'idle' });
  const downloadController = useRef<AbortController | null>(null);
  const editStart = useRef<readonly ImageAnnotation[]>([]);
  const marks = annotations[identity] ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const zoomAnchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const dpr = useDevicePixelRatio();
  const pan = useDragPan(actualSize && !editing);
  const label = imagePreviewLabel({ name }, t('media.image'));
  const [viewportDims, setViewportDims] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  }));

  useEffect(() => () => { downloadController.current?.abort(); }, []);

  useEffect(() => {
    const onResize = () => {
      setViewportDims({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, []);

  useLayoutEffect(() => {
    setActualSize(false);
    setNatural(undefined);
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
  }, [actualSize]);

  const switchZoom = (point?: { x: number; y: number }) => {
    if (scroller.current !== null && image.current !== null) {
      const box = scroller.current.getBoundingClientRect();
      const rect = image.current.getBoundingClientRect();
      const x = point?.x ?? box.left + box.width / 2;
      const y = point?.y ?? box.top + box.height / 2;
      zoomAnchor.current = { fx: rect.width === 0 ? 0.5 : Math.max(0, Math.min(1, (x - rect.left) / rect.width)), fy: rect.height === 0 ? 0.5 : Math.max(0, Math.min(1, (y - rect.top) / rect.height)), px: x - box.left, py: y - box.top };
    }
    setActualSize((value) => !value);
  };
  const changeMarks = (next: readonly ImageAnnotation[]) => {
    setHistory((previous) => [...previous, marks]);
    setAnnotations((previous) => ({ ...previous, [identity]: next }));
    setSaveFailed(false);
  };
  const finishEdit = () => {
    setEditing(false);
    setSelected(undefined);
    setHistory([]);
  };
  const cancelEdit = () => {
    setAnnotations((previous) => ({ ...previous, [identity]: editStart.current }));
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
    if (src === undefined && onSaveOriginal === undefined) return;
    setSaveFailed(false);
    const downloadName = imagePreviewDownloadName({ name });
    if (annotated) {
      if (src === undefined) return;
      try {
        const blob = await renderAnnotatedImage(src, marks);
        const filename = `${downloadName.replace(/\.[^.]+$/, '')}-annotated.png`;
        if (host.saveBlob !== undefined) await host.saveBlob(blob, filename);
        else {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
          document.body.append(anchor); anchor.click(); anchor.remove();
          setTimeout(() => { URL.revokeObjectURL(url); }, 0);
        }
      } catch {
        setSaveFailed(true);
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
        sink = host.openSaveSink !== undefined ? await host.openSaveSink(downloadName)
          : host.saveBlob !== undefined ? bufferedSaveSink((blob) => host.saveBlob!(blob, downloadName))
          : await browserSaveSink(downloadName);
        if (sink === null) {
          if (!controller.signal.aborted) setTransfer({ status: 'idle' });
          return;
        }
        controller.signal.throwIfAborted();
        await onSaveOriginal(sink, controller.signal, (bytes, total) => {
          if (!controller.signal.aborted) setTransfer({ status: 'downloading', bytes, total });
        });
        controller.signal.throwIfAborted();
        setTransfer({ status: 'saving' });
        const saved = await sink.close();
        if (!controller.signal.aborted) setTransfer({ status: saved ? 'saved' : 'idle' });
      } catch (error) {
        await sink?.abort().catch(() => {});
        if (!controller.signal.aborted) setTransfer({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (downloadController.current === controller) downloadController.current = null;
      }
      return;
    }

    if (host.saveBlob !== undefined) {
      const response = await fetch(src!);
      if (!response.ok) throw new Error(`${response.status}`);
      const blob = await response.blob();
      await host.saveBlob(blob, downloadName);
      return;
    }

    const anchor = document.createElement('a');
    anchor.href = src!;
    anchor.download = downloadName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };
  const menuEntries: MiniMenuEntry[] = imageMenuEntries({
    t,
    src,
    path: sourcePath,
    link: linkUrl ?? httpImageLink(src),
    remote,
    revealPath: host.revealPath,
    openPath: host.openPath,
    canCopyImage: src !== undefined && !loading && !failed && !sourceFailed,
    canSave: true,
    annotated: marks.length > 0,
    onCopyImage: async () => { if (src !== undefined) await copyImageBitmap(src); },
    onSave: () => save(false),
    onSaveAnnotated: () => save(true),
  });

  const fitScale = natural === undefined || natural.width <= 0 || natural.height <= 0 ? 1
    : Math.min(1, (viewportDims.width * 0.92) / natural.width, (viewportDims.height * 0.75) / natural.height);
  const displayWidth = natural === undefined ? undefined : actualSize ? natural.width / dpr : natural.width * fitScale;

  return <Dialog onClose={dismiss} ariaLabel={label} overlayId="media-lightbox"
    overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-shell/85 p-4"
    panelClassName="anim-enter flex max-h-full w-full max-w-[94vw] flex-col items-center gap-3 outline-none">
    <div className="flex w-full min-h-0 flex-col items-center gap-3" onKeyDown={(event) => {
      if (event.defaultPrevented || menu !== null || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]') !== null)) return;
      if (editing) {
        if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== undefined) { event.preventDefault(); event.stopPropagation(); changeMarks(marks.filter((mark) => mark.id !== selected)); setSelected(undefined); }
        return;
      }
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); event.stopPropagation(); onSelect?.(index - 1); }
      else if (event.key === 'ArrowRight' && index < count - 1) { event.preventDefault(); event.stopPropagation(); onSelect?.(index + 1); }
      else if (event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        if (scroller.current !== null) scroller.current.scrollTop += (event.key === 'PageUp' || event.key === 'ArrowUp' ? -1 : 1) * (event.key.startsWith('Page') ? scroller.current.clientHeight * 0.85 : 60);
      }
    }}>
      {/* Top bar: name + dimensions, image browsing controls, zoom toggle, and close */}
      <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
        {name !== undefined && name !== '' ? (
          <div className="flex min-w-0 max-w-[min(50vw,360px)] items-center gap-1.5 px-2 font-mono text-[11px] text-shell-ink">
            <span className="truncate" title={name}>{name}</span>
            {natural !== undefined ? <span className="shrink-0 text-shell-ink/70">{natural.width} × {natural.height}</span> : null}
          </div>
        ) : natural !== undefined ? (
          <span className="shrink-0 font-mono text-[11px] text-shell-ink/70 px-1">{natural.width} × {natural.height}</span>
        ) : null}
        {count > 1 ? <>
          <button type="button" disabled={index === 0 || editing} onClick={() => onSelect?.(index - 1)} aria-label={t('media.previousImage')} className={controlClass}>‹</button>
          <span aria-live="polite" className="font-mono text-[11px] text-shell-ink">{t('media.imagePosition', { current: index + 1, total: count })}</span>
          <button type="button" disabled={index === count - 1 || editing} onClick={() => onSelect?.(index + 1)} aria-label={t('media.nextImage')} className={controlClass}>›</button>
        </> : null}
        <button type="button" data-autofocus onClick={() => { switchZoom(); }} className={controlClass}>{actualSize ? t('media.zoomFit') : t('media.zoomActual')}</button>
        <button type="button" disabled={transfer.status === 'saving'} onClick={onClose} aria-label={t('common.close')} className={controlClass}><Icon name="close" /></button>
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
      {saveFailed ? <div role="alert" className="text-sm text-shell-ink">{t('media.annotationSaveFailed')}</div> : null}
      <div ref={scroller} tabIndex={0} data-lightbox-viewport={actualSize ? 'actual' : 'fit'} aria-label={label}
        {...pan.handlers}
        onContextMenu={(event) => { if (src === undefined) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: event.clientX || rect.left, y: event.clientY || rect.top }); }}
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
        className={`relative min-h-0 max-h-[75vh] w-full select-none overflow-auto overscroll-contain ${editing ? '' : actualSize ? pan.dragging ? 'cursor-grabbing' : 'cursor-grab' : 'cursor-zoom-in'}`}>
        {loading ? <div aria-busy="true" className="flex min-h-48 items-center justify-center text-sm text-shell-ink">{t('preview.loading')}</div>
          : failed || sourceFailed ? <div role="alert" className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-shell-ink"><span>{t('media.unavailable', { name: label })}</span><button type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); onRetry?.(); }} className={controlClass}>{t('transcript.detail.retry')}</button></div>
            : <div className="relative mx-auto" style={{ width: displayWidth, maxWidth: actualSize ? 'none' : '100%' }}>
              <img ref={image} key={`${identity}:${attempt}`} src={src} alt={label} tabIndex={0} draggable={false} decoding="async"
                onError={() => { setFailed(true); }} onLoad={(event) => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); noteMediaReady(outcomeKey ?? (src === undefined ? undefined : `url:${src}`)); }}
                onClick={(event) => { if (!editing && !pan.consumePan()) switchZoom({ x: event.clientX, y: event.clientY }); }} className="block h-auto w-full rounded-lg" />
              {natural === undefined ? null : <ImageViewportAnnotations key={`${identity}:${editing}`} width={natural.width} height={natural.height} marks={marks} tool={tool} editing={editing} selected={selected} onSelect={setSelected} onChange={changeMarks} />}
            </div>}
      </div>

      {/* Bottom dock: viewing mode has clear entry; editing mode has explicit state badge & full toolset */}
      <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
        {!editing ? (
          <button
            type="button"
            disabled={natural === undefined || loading || failed || sourceFailed}
            onClick={() => { editStart.current = marks; setHistory([]); setEditing(true); }}
            className={controlClass}
          >
            {t('media.startAnnotation')}
          </button>
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
