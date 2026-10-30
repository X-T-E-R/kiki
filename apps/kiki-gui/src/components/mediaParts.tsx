import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatBytes, type MediaRef } from '@kiki/session-core/composer/media';
import { useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { ApiError, API_CODES } from '@kiki/session-core/transport';
import { useOptionalConnection } from '../state/connection';
import { Icon } from './icons';
import { imagePreviewLabel, safeImagePreviewName } from './imagePreviewName';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { useMediaGalleryOrder, useMediaPreview } from './mediaPreviewContext';
import { copyImageBitmap, httpImageLink, imageMenuEntries, isRemoteConnection, mediaOutcomeKey, saveMediaToDisk, useMediaReady } from './imageActions';
import { imagePreviewDownloadName } from './imagePreviewName';
import { pushToast } from '../lib/toasts';
import { errorToText } from '@kiki/session-core/util';
import { canonicalGalleryItem, galleryImageId, galleryOccurrenceId } from './mediaGallery';

export function useGalleryImage(item: MediaRef, attachmentIndex = 0, agentId?: string, markdownOffset?: number) {
  const preview = useMediaPreview();
  const order = useMediaGalleryOrder();
  const owner = order?.agentId ?? agentId ?? 'main';
  const id = galleryImageId(item, owner);
  const occurrenceId = galleryOccurrenceId(order?.blockId, markdownOffset ?? attachmentIndex, markdownOffset === undefined ? 1 : 0);
  const register = preview?.registerGalleryImage;
  useEffect(() => {
    if (item.kind !== 'image' || id === undefined || item.detail !== undefined || register === undefined) return;
    register({ id, agentId: owner, order: [order?.order ?? 0, markdownOffset === undefined ? 1 : 0, markdownOffset ?? attachmentIndex], occurrenceId, blockId: order?.blockId, item: canonicalGalleryItem(item, owner) });
  }, [register, id, owner, order?.order, attachmentIndex, markdownOffset, occurrenceId, item]);
  return (initialSrc?: string) => {
    const prepared = canonicalGalleryItem(item, owner);
    if (preview?.openGalleryImage !== undefined) {
      preview.openGalleryImage(prepared, owner, initialSrc, occurrenceId);
    } else if (initialSrc !== undefined || item.url !== undefined) {
      preview?.openImage(initialSrc ?? item.url!, safeImagePreviewName({ name: item.name, path: item.path }));
    } else {
      preview?.openAttachment(item, owner);
    }
  };
}
import { useTranscriptDetail } from './transcriptDetail';

type SessionMediaLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'ready';
      readonly bytes: Uint8Array;
      readonly mime: string;
      readonly name?: string;
      readonly url: string;
      readonly thumbnailUrl?: string;
    };

export function useSessionMedia(
  item: MediaRef,
  sessionId: string | undefined,
  enabled = true,
  previewOnly = true,
  attempt = 0,
): SessionMediaLoad {
  const client = useOptionalConnection()?.client;
  const source = useMemo(() => ({ client, sessionId, fileId: item.fileId, path: item.path, attempt }), [client, sessionId, item.fileId, item.path, item.mime, item.kind, item.blobHash, previewOnly, attempt]);
  const [loaded, setLoaded] = useState<{ source: typeof source; load: SessionMediaLoad }>({ source, load: { status: 'loading' } });
  const setLoad = useCallback((load: SessionMediaLoad) => { setLoaded({ source, load }); }, [source]);
  const load: SessionMediaLoad = loaded.source === source ? loaded.load : { status: 'loading' };

  useEffect(() => {
    if (!enabled) { setLoad({ status: 'loading' }); return; }
    if (client === undefined || (item.path === undefined && (sessionId === undefined || item.fileId === undefined)) || (previewOnly && item.kind !== 'image' && item.kind !== 'video')) {
      setLoad({ status: 'failed' });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setLoad({ status: 'loading' });
    const options = { ...client.readingOptions(), signal: controller.signal, mediaType: item.mime };
    const read: Promise<{ bytes: Uint8Array; mime: string; name?: string }> = item.path !== undefined
      ? previewOnly ? client.readHostMediaPreviewBytes(item.path, options) : client.readHostFileBytes(item.path, options)
      : previewOnly ? client.readSessionMediaPreviewBytes(sessionId!, item.fileId!, options) : client.readSessionMediaBytes(sessionId!, item.fileId!, options);
    const resolved: Promise<{ bytes: Uint8Array; mime: string; name?: string }> = read.catch((error: unknown) => {
      if (!previewOnly || item.kind !== 'image' || controller.signal.aborted || !(error instanceof ApiError) || error.code !== API_CODES.REQUEST_INVALID) throw error;
      return item.path !== undefined ? client.readHostFileBytes(item.path, options) : client.readSessionMediaBytes(sessionId!, item.fileId!, options);
    });
    resolved.then(({ bytes, mime, name }) => {
      if (controller.signal.aborted) return;
      if (bytes.byteLength === 0) { setLoad({ status: 'failed' }); return; }
      const mediaType = mime === 'application/octet-stream' ? item.mime ?? mime : mime;
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
      setLoad({ status: 'ready', bytes, mime: mediaType, name, url: objectUrl });
    }, () => {
      if (!controller.signal.aborted) setLoad({ status: 'failed' });
    });
    return () => {
      controller.abort();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, enabled, previewOnly, item.blobHash, item.fileId, item.path, item.mime, item.kind, sessionId, setLoad]);

  return load;
}

/** Loads bytes (or starts decoding) only once the slot is near the viewport. */
export function useVisibleOnce(): [(node: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible || node === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [node, visible]);
  return [setNode, visible];
}

export function attachmentName(item: MediaRef, loadedName?: string, fallback = 'attachment'): string {
  return imagePreviewLabel({ name: item.name, metadataName: loadedName, path: item.path }, fallback);
}

/**
 * The right-click menu a message image offers in place: copy image, download,
 * and the same host path/link entries the lightbox shows. `src` is the
 * currently displayed image URL (the decoded preview the thumbnail already
 * holds), so copy and the menu's enablement track the load state; download
 * always saves the original bytes through the canonical/host path when one
 * exists, falling back to the URL.
 */
export function useMessageImageMenu(item: MediaRef, src: string | undefined, label: string) {
  const { t } = useI18n();
  const host = useHost();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const preview = useMediaPreview();
  const remote = isRemoteConnection(connection);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);
  const downloadName = imagePreviewDownloadName({ name: item.name, path: item.path });
  const onSave = useCallback(async () => {
    try {
      await saveMediaToDisk(
        { url: item.url ?? src, path: item.path, fileId: item.fileId },
        downloadName,
        host,
        client as Parameters<typeof saveMediaToDisk>[3],
        preview?.sessionId,
      );
    } catch (error) {
      pushToast({ tone: 'error', text: t('media.copyFailed'), detail: errorToText(error) });
    }
  }, [item.url, item.path, item.fileId, src, downloadName, host, client, preview?.sessionId, t]);
  const onCopyImage = useCallback(async () => {
    if (src === undefined) return;
    try {
      await copyImageBitmap(src);
    } catch (error) {
      pushToast({ tone: 'error', text: t('media.copyFailed'), detail: errorToText(error) });
    }
  }, [src, t]);
  const entries = imageMenuEntries({
    t,
    src,
    path: item.path,
    link: httpImageLink(item.url),
    remote,
    revealPath: host.revealPath,
    openPath: host.openPath,
    canCopyImage: src !== undefined,
    canSave: true,
    annotated: false,
    onCopyImage,
    onSave,
  });
  const menuElement = menu === null ? null : (
    <MiniContextMenu
      x={menu.x}
      y={menu.y}
      entries={entries}
      onClose={() => { setMenu(null); }}
      ariaLabel={label}
      overlayId="message-image-menu"
      dataAttribute="data-message-image-menu"
    />
  );
  return { openMenu, menuElement };
}

function SessionMediaThumb({ item, size = 'default', onOpen }: { item: MediaRef; size?: MediaThumbSize; onOpen?: () => void }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const [hostRef, visible] = useVisibleOnce();
  const [attempt, setAttempt] = useState(0);
  const load = useSessionMedia(item, preview?.sessionId, visible, true, attempt);
  const [failedUrl, setFailedUrl] = useState<string>();
  const failedRef = useRef(false);
  failedRef.current = load.status === 'failed' || (load.status === 'ready' && failedUrl === load.url);
  useMediaReady(mediaOutcomeKey({ sessionId: preview?.sessionId, url: item.url, fileId: item.fileId, path: item.path }), () => {
    if (!failedRef.current) return;
    setFailedUrl(undefined);
    setAttempt((value) => value + 1);
  });
  const fallback = item.kind === 'image' ? t('media.image') : t('media.attachment');
  const name = attachmentName(item, load.status === 'ready' ? load.name : undefined, fallback);
  const readyUrl = load.status === 'ready' && failedUrl !== load.url ? load.url : undefined;
  const imageMenu = useMessageImageMenu(item, readyUrl, name);
  let body: ReactNode;
  if (load.status === 'failed' || load.status === 'ready' && failedUrl === load.url) {
    body = <MediaLoadFailure name={name} decode={load.status === 'ready'} size={size} onRetry={() => { if (onOpen !== undefined) onOpen(); else preview?.openAttachment(item); }} />;
  } else if (load.status === 'loading') {
    body = (
      <span aria-busy="true" className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} text-[11px] text-ink-faint`}>
        {size === 'strip' ? null : t('preview.loading')}
      </span>
    );
  } else {
    body = (
      <button
        type="button"
        title={name}
        onClick={() => { if (onOpen !== undefined) onOpen(); else preview?.openAttachment(item); }}
        onContextMenu={imageMenu.openMenu}
        className={`block overflow-hidden ${THUMB_SIZE[size].frame} transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        <img src={load.url} alt={name} decoding="async" onError={() => { setFailedUrl(load.url); }} className={`${THUMB_SIZE[size].img} object-cover`} />
      </button>
    );
  }
  return <span ref={hostRef} className="inline-flex">{body}{imageMenu.menuElement}</span>;
}

export function MediaLoadFailure({ name, decode, size = 'default', onRetry }: { name: string; decode: boolean; size?: MediaThumbSize; onRetry: () => void }) {
  const { t } = useI18n();
  const safeName = imagePreviewLabel({ name }, t('media.attachment'));
  const label = decode ? t('media.unavailable', { name: safeName }) : t('preview.failed');
  return (
    <button type="button" data-media-broken={decode ? 'decode' : 'read'} onClick={onRetry} title={safeName} aria-label={`${label} · ${t('transcript.detail.retry')}`}
      className={`flex ${THUMB_SIZE[size].slot} flex-col items-center justify-center gap-1 ${THUMB_SIZE[size].frame} border border-dashed border-hairline-strong bg-panel p-2 text-[11px] text-ink-faint hover:border-accent focus-visible:outline-2 focus-visible:outline-selected-ink`}>
      <Icon name="file" size={size === 'strip' ? 12 : 16} />
      {size === 'strip' ? null : <>{decode ? null : <span className="max-w-full truncate">{safeName}</span>}<span>{label}</span><span className="text-accent">{t('transcript.detail.retry')}</span></>}
    </button>
  );
}

function AudioPart({ item }: { item: MediaRef }) {
  const preview = useMediaPreview();
  const [hostRef, visible] = useVisibleOnce();
  const load = useSessionMedia(item, preview?.sessionId, visible && item.url === undefined, false);
  const src = item.url ?? (load.status === 'ready' ? load.url : undefined);
  if (src === undefined) return <FileChip item={item} />;
  return <span ref={hostRef} className="inline-flex max-w-full"><audio controls src={src} preload="none" className="h-10 max-w-full" /></span>;
}

function FileChip({ item }: { item: MediaRef }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const fallback = item.kind === 'image' ? t('media.image') : t('media.attachment');
  const label = attachmentName(item, undefined, fallback);
  const detail = item.size !== undefined ? formatBytes(item.size) : item.mime;
  const openable = (item.path !== undefined || item.fileId !== undefined) && preview !== null;
  const className = `inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left ${
    openable ? 'border-hairline bg-paper transition-colors hover:border-accent' : 'border-hairline bg-paper/60'
  }`;
  const body = (
    <>
      <Icon name="file" className="h-3.5 w-3.5 text-ink-faint" />
      <span className="min-w-0 truncate font-mono text-[12px] text-ink">{label}</span>
      {detail !== undefined && detail !== '' ? <span className="shrink-0 font-mono text-[11px] text-ink-faint">{detail}</span> : null}
    </>
  );
  if (!openable) return <span className={className} title={label}>{body}</span>;
  return (
    <button
      type="button"
      className={className}
      title={label}
      onClick={() => {
        if ((item.kind === 'image' || item.kind === 'video') && item.path !== undefined) preview.openAttachment(item);
        else if (item.path !== undefined) preview.openFile(item.path);
        else if (item.fileId !== undefined) preview.openAttachment(item);
      }}
    >
      {body}
    </button>
  );
}

/** Host media uses the same bounded source-preview and explicit-original UI. */
function HostMediaThumb({ item, size = 'default', onOpen }: { item: MediaRef & { kind: 'image' | 'video'; path: string }; size?: MediaThumbSize; onOpen?: () => void }) {
  return <SessionMediaThumb item={item} size={size} onOpen={onOpen} />;
}

export type MediaThumbSize = 'default' | 'strip' | 'preview';
const THUMB_SIZE: Record<MediaThumbSize, { img: string; slot: string; frame: string }> = {
  default: { img: 'h-28 w-auto', slot: 'h-28 w-40', frame: 'rounded-lg' },
  strip: { img: 'h-9 w-auto max-w-[96px]', slot: 'h-9 w-12', frame: 'rounded-[5px]' },
  preview: { img: 'h-[120px] w-auto max-w-[240px]', slot: 'h-[120px] w-40', frame: 'rounded-lg' },
};
const LOADABLE_MEDIA_URL = /^(?:data:|blob:|https?:\/\/)/i;

function UrlMediaPart({ item, size, onOpen }: { item: MediaRef & { url: string }; size: MediaThumbSize; onOpen?: () => void }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const client = useOptionalConnection()?.client;
  const source = useMemo(() => ({ client, sessionId: preview?.sessionId, url: item.url }), [client, preview?.sessionId, item.url]);
  const [failed, setFailed] = useState<typeof source | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [hostRef, visible] = useVisibleOnce();
  const failedRef = useRef(failed);
  const sourceRef = useRef(source);
  failedRef.current = failed;
  sourceRef.current = source;
  useMediaReady(mediaOutcomeKey({ sessionId: preview?.sessionId, url: item.url, fileId: item.fileId, path: item.path }), () => {
    if (failedRef.current !== sourceRef.current) return;
    setFailed(null);
    setAttempt((value) => value + 1);
  });
  const fallback = item.kind === 'image' ? t('media.image') : t('media.attachment');
  const name = attachmentName(item, undefined, fallback);
  const downloadName = safeImagePreviewName({ name: item.name, path: item.path });
  const imageFailed = failed === source;
  const imageMenu = useMessageImageMenu(item, item.kind === 'image' && !imageFailed ? item.url : undefined, name);
  if (!LOADABLE_MEDIA_URL.test(item.url)) return <FileChip item={item} />;
  const body = imageFailed ? <MediaLoadFailure name={name} decode size={size} onRetry={() => { setFailed(null); setAttempt((value) => value + 1); }} />
    : !visible ? <span aria-busy="true" className={`${THUMB_SIZE[size].slot} ${THUMB_SIZE[size].frame}`} />
    : item.kind === 'video' ? <video key={attempt} src={item.url} controls onError={() => { setFailed(source); }} className="max-h-52 rounded-lg border border-hairline" />
    : <button type="button" onClick={() => { if (onOpen !== undefined) onOpen(); else preview?.openImage(item.url, downloadName); }} onContextMenu={imageMenu.openMenu} title={name} className={`block overflow-hidden ${THUMB_SIZE[size].frame} transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-selected-ink`}><img key={attempt} src={item.url} alt={name} decoding="async" onError={() => { setFailed(source); }} className={`${THUMB_SIZE[size].img} object-cover`} /></button>;
  return <span ref={hostRef} className="inline-flex">{body}{imageMenu.menuElement}</span>;
}

function DeferredMediaPart({ item, size }: { item: MediaRef & { detail: NonNullable<MediaRef['detail']> }; size: MediaThumbSize }) {
  const { t } = useI18n();
  const detail = useTranscriptDetail({ agentId: item.detail.agentId, kind: 'attachment', id: item.detail.attachmentId });
  const name = attachmentName(item, undefined, item.kind === 'image' ? t('media.image') : t('media.attachment'));
  const client = useOptionalConnection()?.client;
  const preview = useMediaPreview();
  const [hostRef, visible] = useVisibleOnce();
  const target = useMemo(() => ({ client, sessionId: preview?.sessionId, agentId: item.detail.agentId, id: item.detail.attachmentId }), [client, preview?.sessionId, item.detail.agentId, item.detail.attachmentId]);
  const attempted = useRef<typeof target | undefined>(undefined);
  const status = detail.status?.status;
  useEffect(() => {
    if (!visible || item.kind === 'file' || detail.request === undefined || attempted.current === target || status === 'error') return;
    attempted.current = target;
    detail.request();
  }, [visible, item.kind, detail.request, target, status]);
  if (detail.request === undefined) return <FileChip item={item} />;
  const label = status === 'loading' ? t('media.detail.loading', { name }) : status === 'error' ? t('media.detail.failed', { name }) : t('media.detail.open', { name });
  const meta = item.size !== undefined ? formatBytes(item.size) : item.mime;
  if (size === 'strip') {
    return (
      <button
        type="button"
        ref={hostRef}
        data-media-deferred={status ?? 'idle'}
        onClick={detail.request}
        disabled={status === 'loading'}
        aria-label={label}
        title={label}
        className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} border border-dashed ${status === 'error' ? 'border-danger/60 text-danger' : 'border-hairline-strong text-ink-faint'} bg-panel transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        <Icon name="file" size={12} />
      </button>
    );
  }
  return (
    <button
      ref={hostRef}
      type="button"
      data-media-deferred={status ?? 'idle'}
      onClick={detail.request}
      disabled={status === 'loading'}
      aria-busy={status === 'loading'}
      aria-label={label}
      title={label}
      className={`flex ${THUMB_SIZE[size].slot} flex-col items-start justify-between gap-1 ${THUMB_SIZE[size].frame} border border-dashed ${status === 'error' ? 'border-danger/60' : 'border-hairline-strong'} bg-panel p-2 text-left transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default motion-reduce:transition-none`}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5 text-ink-faint">
        <Icon name="file" size={14} />
        {meta !== undefined && meta !== '' ? <span className="truncate font-mono text-[11px]">{meta}</span> : null}
      </span>
      <span className="w-full min-w-0">
        <span className="block truncate font-mono text-[12px] text-ink" title={name}>{name}</span>
        <span className={`mt-0.5 flex items-center gap-1.5 text-[12px] font-medium ${status === 'error' ? 'text-danger' : 'text-accent-ink'}`}>
          {status === 'loading' ? <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" /> : null}
          {status === 'loading' ? t('preview.loading') : status === 'error' ? t('transcript.detail.retry') : t('media.detail.action')}
        </span>
      </span>
    </button>
  );
}

export function MediaPart({ item, agentId, size = 'default', galleryIndex = 0 }: { item: MediaRef; agentId?: string; size?: MediaThumbSize; galleryIndex?: number }) {
  const order = useMediaGalleryOrder();
  const openImage = useGalleryImage(item, galleryIndex, agentId);
  if (item.detail !== undefined) return <DeferredMediaPart item={{ ...item, detail: item.detail }} size={size} />;
  if (item.blobHash !== undefined) {
    const savedItem = canonicalGalleryItem({ ...item, name: item.name ?? safeImagePreviewName({ path: item.path }) }, order?.agentId ?? agentId ?? 'main');
    return <SessionMediaThumb item={savedItem} size={size} onOpen={item.kind === 'image' ? openImage : undefined} />;
  }
  if (item.kind === 'image') {
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} onOpen={openImage} />;
    if (item.url !== undefined) return <UrlMediaPart item={{ ...item, url: item.url }} size={size} onOpen={openImage} />;
    if (item.path !== undefined) return <HostMediaThumb item={{ ...item, kind: 'image', path: item.path }} size={size} onOpen={openImage} />;
    return <FileChip item={item} />;
  }
  if (item.kind === 'audio') return <AudioPart item={item} />;
  if (item.kind === 'video') {
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} />;
    if (item.url !== undefined) return <UrlMediaPart item={{ ...item, url: item.url }} size={size} />;
    if (item.path !== undefined) return <HostMediaThumb item={{ ...item, kind: 'video', path: item.path }} />;
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} />;
    return <FileChip item={item} />;
  }
  return <FileChip item={item} />;
}

/** Thumbnails + chips for the media refs carried by a transcript block. */
export function MediaPartList({ media, align = 'start', agentId }: { media: readonly MediaRef[]; align?: 'start' | 'end'; agentId?: string }) {
  if (media.length === 0) return null;
  return (
    <div className={`mt-1.5 flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : ''}`}>
      {media.map((item, index) => <MediaPart key={index} item={item} agentId={agentId} galleryIndex={index} />)}
    </div>
  );
}

/** Clickable host path; without a provider it degrades to plain text. */
export function FilePathLink({ path, className }: { path: string; className?: string }) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const remoteScope = isRemoteConnection(connection);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (preview === null) return <span className={className}>{path}</span>;
  const filePath = /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
  const hostEntries: MiniMenuEntry[] = [];
  if (!remoteScope) {
    if (host.revealPath !== undefined) hostEntries.push({ key: 'show-in-folder', label: t('file.showInFolder'), run: () => host.revealPath?.(filePath) });
    if (host.openPath !== undefined) hostEntries.push({ key: 'open-default-app', label: t('file.openDefaultApp'), run: () => host.openPath?.(filePath) });
  }
  const entries: MiniMenuEntry[] = [
    { key: 'open-preview', label: t('file.openPreview'), run: () => { preview.openFile(path); } },
    { key: 'copy-path', label: t('file.copyPath'), run: () => copyTextToClipboard(path) },
    ...(hostEntries.length > 0 ? [{ separator: true } as const, ...hostEntries] : []),
  ];
  return (
    <>
      <span
        role="link"
        tabIndex={0}
        title={path}
        onClick={(event) => { event.stopPropagation(); preview.openFile(path); }}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }); }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); preview.openFile(path); } }}
        className={`cursor-pointer rounded-[2px] underline-offset-2 decoration-ink-faint hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${className ?? ''}`}
      >
        {path}
      </span>
      {menu !== null ? <MiniContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => { setMenu(null); }} ariaLabel={t('file.menuAria')} overlayId="file-path-link" dataAttribute="data-file-link-menu" /> : null}
    </>
  );
}
