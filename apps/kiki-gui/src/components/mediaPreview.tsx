/**
 * MediaPreviewProvider — owns the transcript's media overlays (image lightbox
 * + file preview pane) and exposes `openImage` / `openFile` plus the session
 * cwd through MediaPreviewContext. Also hosts the small presentational
 * building blocks that consume it: MediaPartList (thumbnails/chips for
 * message media refs) and FilePathLink (clickable host paths).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n';
import { basenameOf, formatBytes, type MediaRef } from '../lib/media';
import { useOptionalConnection } from '../state/connection';
import { FilePreviewPane } from './FilePreviewPane';
import { MediaLightbox } from './MediaLightbox';
import {
  MediaPreviewContext,
  useMediaPreview,
  type MediaPreviewApi,
} from './mediaPreviewContext';

export { useMediaPreview } from './mediaPreviewContext';

export function MediaPreviewProvider({
  cwd,
  children,
}: {
  cwd?: string;
  children: ReactNode;
}) {
  const [image, setImage] = useState<{ src: string; name?: string } | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const api = useMemo<MediaPreviewApi>(
    () => ({
      cwd,
      openImage: (src, name) => { setImage({ src, name }); },
      openFile: (path) => { setFile(path); },
    }),
    [cwd],
  );
  return (
    <MediaPreviewContext.Provider value={api}>
      {children}
      {file !== null ? (
        <FilePreviewPane
          path={file}
          onClose={() => { setFile(null); }}
          onOpenImage={(src, name) => { setImage({ src, name }); }}
        />
      ) : null}
      {image !== null ? (
        <MediaLightbox
          src={image.src}
          name={image.name}
          onClose={() => { setImage(null); }}
        />
      ) : null}
    </MediaPreviewContext.Provider>
  );
}

// ---------------------------------------------------------------------------

function FileChip({ item }: { item: MediaRef }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const label =
    item.name ?? (item.path !== undefined ? basenameOf(item.path) : t('media.attachment'));
  const detail = item.size !== undefined ? formatBytes(item.size) : item.mime;
  const openable = item.path !== undefined && preview !== null;
  const className = `inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left ${
    openable
      ? 'border-hairline bg-paper transition-colors hover:border-accent'
      : 'border-hairline bg-paper/60'
  }`;
  const body = (
    <>
      <span aria-hidden className="shrink-0 text-[11px] text-ink-faint">
        ◧
      </span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-ink">{label}</span>
      {detail !== undefined && detail !== '' ? (
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">{detail}</span>
      ) : null}
    </>
  );
  if (!openable) {
    return (
      <span className={className} title={item.path ?? item.fileId}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={item.path}
      onClick={() => {
        if (item.path !== undefined) preview.openFile(item.path);
      }}
    >
      {body}
    </button>
  );
}

/** Thumbnail for a path-backed image (fs:content needs the bearer header). */
function HostImageThumb({ path, name }: { path: string; name?: string }) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const preview = useMediaPreview();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const client = connection?.client;
    if (client === undefined) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    client.readHostFileBytes(path).then(
      ({ bytes, mime }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        setUrl(objectUrl);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [connection, path]);

  if (failed) {
    return <FileChip item={{ kind: 'image', path, name: name ?? basenameOf(path) }} />;
  }
  if (url === null) {
    return (
      <span className="flex h-28 w-40 items-center justify-center rounded-lg border border-hairline bg-paper text-[11px] text-ink-faint">
        {t('preview.loading')}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={name ?? path}
      onClick={() => { preview?.openImage(url, name ?? basenameOf(path)); }}
      className="overflow-hidden rounded-lg border border-hairline transition-colors hover:border-accent"
    >
      <img src={url} alt={name ?? basenameOf(path)} className="h-28 w-auto object-cover" />
    </button>
  );
}

function MediaPart({ item }: { item: MediaRef }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  if (item.kind === 'image') {
    if (item.url !== undefined) {
      const name = item.name ?? t('media.viewImage');
      const url = item.url;
      const image = (
        <img
          src={url}
          alt={name}
          className="h-28 w-auto rounded-lg border border-hairline object-cover"
        />
      );
      if (preview === null) return image;
      return (
        <button
          type="button"
          title={name}
          onClick={() => { preview.openImage(url, item.name); }}
          className="overflow-hidden rounded-lg transition-shadow hover:shadow-[0_4px_16px_-8px_rgba(28,25,23,0.4)]"
        >
          {image}
        </button>
      );
    }
    if (item.path !== undefined) return <HostImageThumb path={item.path} name={item.name} />;
    return <FileChip item={item} />;
  }
  if (item.kind === 'video') {
    if (item.url !== undefined) {
      return (
        <video src={item.url} controls className="max-h-52 rounded-lg border border-hairline" />
      );
    }
    return <FileChip item={item} />;
  }
  return <FileChip item={item} />;
}

/** Thumbnails + chips for the media refs carried by a transcript block. */
export function MediaPartList({
  media,
  align = 'start',
}: {
  media: readonly MediaRef[];
  align?: 'start' | 'end';
}) {
  if (media.length === 0) return null;
  return (
    <div className={`mt-1.5 flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : ''}`}>
      {media.map((item, index) => (
        <MediaPart key={index} item={item} />
      ))}
    </div>
  );
}

/**
 * Clickable host file path. Without a preview provider (tests, static pages)
 * it degrades to plain text.
 */
export function FilePathLink({ path, className }: { path: string; className?: string }) {
  const preview = useMediaPreview();
  if (preview === null) return <span className={className}>{path}</span>;
  return (
    <span
      role="link"
      tabIndex={0}
      title={path}
      onClick={(event) => {
        event.stopPropagation();
        preview.openFile(path);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.stopPropagation();
          preview.openFile(path);
        }
      }}
      className={`cursor-pointer underline decoration-dotted underline-offset-2 hover:text-accent ${className ?? ''}`}
    >
      {path}
    </span>
  );
}
