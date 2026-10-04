import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { basenameOf, formatBytes, type MediaRef } from '@kiki/session-core/composer/media';
import { useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { useOptionalConnection } from '../state/connection';
import { Icon } from './icons';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { useMediaPreview } from './mediaPreviewContext';
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
): SessionMediaLoad {
  const client = useOptionalConnection()?.client;
  const source = useMemo(() => ({ client, sessionId, fileId: item.fileId, path: item.path }), [client, sessionId, item.fileId, item.path, item.mime, item.kind, previewOnly]);
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
    const options = { signal: controller.signal, mediaType: item.mime, timeoutMs: previewOnly ? undefined : 0 };
    const read: Promise<{ bytes: Uint8Array; mime: string; name?: string }> = item.path !== undefined
      ? previewOnly ? client.readHostMediaPreviewBytes(item.path, options) : client.readHostFileBytes(item.path, options)
      : previewOnly ? client.readSessionMediaPreviewBytes(sessionId!, item.fileId!, options) : client.readSessionMediaBytes(sessionId!, item.fileId!, options);
    read.then(({ bytes, mime, name }) => {
      if (controller.signal.aborted) return;
      const mediaType = !previewOnly && item.blobHash !== undefined ? item.mime ?? mime : mime;
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
      setLoad({ status: 'ready', bytes, mime: mediaType, name, url: objectUrl });
    }, () => {
      if (!controller.signal.aborted) setLoad({ status: 'failed' });
    });
    return () => {
      controller.abort();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, enabled, previewOnly, item.blobHash, item.fileId, item.mime, item.kind, sessionId, setLoad]);

  return load;
}

function useVisibleOnce(): [(node: HTMLElement | null) => void, boolean] {
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

export function attachmentName(item: MediaRef, loadedName?: string): string {
  return item.name ?? loadedName ?? item.fileId ?? item.path ?? 'attachment';
}

function SessionMediaThumb({ item, size = 'default' }: { item: MediaRef; size?: MediaThumbSize }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const [hostRef, visible] = useVisibleOnce();
  const load = useSessionMedia(item, preview?.sessionId, visible);
  const name = attachmentName(item, load.status === 'ready' ? load.name : undefined);
  let body: ReactNode;
  if (load.status === 'failed') {
    body = size === 'default'
      ? <FileChip item={item} />
      : <button type="button" onClick={() => { preview?.openAttachment(item); }} title={name}><BrokenThumb size={size} name={name} /></button>;
  } else if (load.status === 'loading') {
    body = (
      <span className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} border border-hairline bg-paper text-[11px] text-ink-faint`}>
        {size === 'strip' ? null : t('preview.loading')}
      </span>
    );
  } else {
    body = (
      <button
        type="button"
        title={name}
        onClick={() => { preview?.openAttachment(item); }}
        className={`block overflow-hidden ${THUMB_SIZE[size].frame} border border-hairline transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        <img src={load.thumbnailUrl ?? load.url} alt={name} className={`${THUMB_SIZE[size].img} object-cover`} />
      </button>
    );
  }
  return <span ref={hostRef} className="inline-flex">{body}</span>;
}

/** An image that could not be read, in the slot it would have taken: neutral, never an error. */
function BrokenThumb({ size, name }: { size: MediaThumbSize; name: string }) {
  const { t } = useI18n();
  return (
    <span
      data-media-broken
      role="img"
      aria-label={t('media.unavailable', { name })}
      title={name}
      className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} border border-dashed border-hairline-strong bg-panel text-ink-faint`}
    >
      <Icon name="file" size={size === 'strip' ? 12 : 16} />
    </span>
  );
}

function FileChip({ item }: { item: MediaRef }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const label = item.name ?? (item.path !== undefined ? basenameOf(item.path) : t('media.attachment'));
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
  if (!openable) return <span className={className} title={item.path ?? item.fileId}>{body}</span>;
  return (
    <button
      type="button"
      className={className}
      title={item.path ?? item.fileId}
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
function HostMediaThumb({ item, size = 'default' }: { item: MediaRef & { kind: 'image' | 'video'; path: string }; size?: MediaThumbSize }) {
  return <SessionMediaThumb item={item} size={size} />;
}

export type MediaThumbSize = 'default' | 'strip' | 'preview';
const THUMB_SIZE: Record<MediaThumbSize, { img: string; slot: string; frame: string }> = {
  default: { img: 'h-28 w-auto', slot: 'h-28 w-40', frame: 'rounded-lg' },
  strip: { img: 'h-9 w-auto max-w-[96px]', slot: 'h-9 w-12', frame: 'rounded-[5px]' },
  preview: { img: 'h-[120px] w-auto max-w-[240px]', slot: 'h-[120px] w-40', frame: 'rounded-lg' },
};
const LOADABLE_MEDIA_URL = /^(?:data:|blob:|https?:\/\/)/i;

function UrlMediaPart({ item, size }: { item: MediaRef & { url: string }; size: MediaThumbSize }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const client = useOptionalConnection()?.client;
  const source = useMemo(() => ({ client, sessionId: preview?.sessionId, url: item.url }), [client, preview?.sessionId, item.url]);
  const [opened, setOpened] = useState<typeof source | null>(null);
  const name = attachmentName(item);
  if (!LOADABLE_MEDIA_URL.test(item.url)) return <FileChip item={item} />;
  if (opened !== source) return (
    <button type="button" onClick={() => { setOpened(source); }} title={name} className={`flex ${THUMB_SIZE[size].slot} flex-col items-center justify-center gap-2 ${THUMB_SIZE[size].frame} border border-hairline bg-paper p-2 text-[11px] text-accent`}>
      <Icon name="file" /><span>{t('preview.loadFullFile')}</span>
    </button>
  );
  return <span className="flex flex-col gap-1">
    {item.kind === 'video' ? <video src={item.url} controls className="max-h-52 rounded-lg border border-hairline" /> :
      <button type="button" onClick={() => { preview?.openImage(item.url, name); }} title={name}><img src={item.url} alt={name} className={`${THUMB_SIZE[size].img} ${THUMB_SIZE[size].frame} border border-hairline object-cover`} /></button>}
    <a href={item.url} download={name} target="_blank" rel="noopener noreferrer" className="text-[11px] text-accent">{t('media.download')}</a>
  </span>;
}

function DeferredMediaPart({ item, size }: { item: MediaRef & { detail: NonNullable<MediaRef['detail']> }; size: MediaThumbSize }) {
  const { t } = useI18n();
  const detail = useTranscriptDetail({ agentId: item.detail.agentId, kind: 'attachment', id: item.detail.attachmentId });
  const name = item.name ?? t('media.attachment');
  if (detail.request === undefined) return <FileChip item={item} />;
  const status = detail.status?.status;
  const label = status === 'loading' ? t('media.detail.loading', { name }) : status === 'error' ? t('media.detail.failed', { name }) : t('media.detail.open', { name });
  const meta = item.size !== undefined ? formatBytes(item.size) : item.mime;
  if (size === 'strip') {
    return (
      <button
        type="button"
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

export function MediaPart({ item, agentId, size = 'default' }: { item: MediaRef; agentId?: string; size?: MediaThumbSize }) {
  if (item.detail !== undefined) return <DeferredMediaPart item={{ ...item, detail: item.detail }} size={size} />;
  if (item.blobHash !== undefined) {
    const savedItem = {
      ...item,
      path: undefined,
      name: item.name ?? (item.path === undefined ? undefined : basenameOf(item.path)),
      fileId: item.fileId ?? (agentId === undefined ? undefined : `blobref:${agentId}:${item.blobHash}`),
    };
    return savedItem.fileId === undefined ? <FileChip item={savedItem} /> : <SessionMediaThumb item={savedItem} size={size} />;
  }
  if (item.kind === 'image') {
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} />;
    if (item.url !== undefined) return <UrlMediaPart item={{ ...item, url: item.url }} size={size} />;
    if (item.path !== undefined) return <HostMediaThumb item={{ ...item, kind: 'image', path: item.path }} size={size} />;
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} />;
    return <FileChip item={item} />;
  }
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
      {media.map((item, index) => <MediaPart key={index} item={item} agentId={agentId} />)}
    </div>
  );
}

/** Clickable host path; without a provider it degrades to plain text. */
export function FilePathLink({ path, className }: { path: string; className?: string }) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const remoteScope = useOptionalConnection()?.scopeId.startsWith('ssh:') ?? false;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (preview === null) return <span className={className}>{path}</span>;
  const filePath = /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
  const entries: MiniMenuEntry[] = [
    { key: 'open-preview', label: t('file.openPreview'), run: () => { preview.openFile(path); } },
    { key: 'copy-path', label: t('file.copyPath'), run: () => copyTextToClipboard(path) },
    ...(!remoteScope && host.revealPath !== undefined && host.openPath !== undefined
      ? [
          { separator: true } as const,
          { key: 'show-in-folder', label: t('file.showInFolder'), run: () => host.revealPath?.(filePath) } as const,
          { key: 'open-default-app', label: t('file.openDefaultApp'), run: () => host.openPath?.(filePath) } as const,
        ]
      : []),
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
