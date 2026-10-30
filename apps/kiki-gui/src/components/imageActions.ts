import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';

import { copyImageToClipboard, copyTextToClipboard, isPngBlob, readBlobBytes } from '../lib/clipboard';
import { browserSaveSink, bufferedSaveSink } from '../host/saveSink';
import type { HostSaveSink } from '../host/host';
import type { MiniMenuEntry } from './MiniContextMenu';

const COPY_IMAGE = 'media.copyImage' as I18nKey;
const URL_SCHEME = /^(?:https?|data|blob|kimi-file|blobref):/i;

export function isRemoteConnection(connection: {
  readonly scopeId?: string;
  readonly spaceKey?: string;
  readonly connectionSource?: string | null;
} | null | undefined): boolean {
  if (connection === null || connection === undefined) return false;
  if (connection.scopeId?.startsWith('ssh:') || connection.scopeId === 'direct:peer') return true;
  if (connection.connectionSource === 'remote') return true;
  if (connection.spaceKey?.startsWith('remote:')) return true;
  return false;
}

export function localImagePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.trim();
  if (trimmed === '' || URL_SCHEME.test(trimmed)) return undefined;
  return trimmed;
}

export function hostActionPath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

export function httpImageLink(url: string | undefined): string | undefined {
  if (url === undefined || !/^https?:\/\//i.test(url)) return undefined;
  return url;
}

export function mediaOutcomeKey(item: { sessionId?: string; url?: string; fileId?: string; path?: string }): string | undefined {
  if (item.fileId !== undefined && item.fileId !== '') return `file:${item.sessionId ?? ''}:${item.fileId}`;
  if (localImagePath(item.path) !== undefined) return `path:${item.sessionId ?? ''}:${item.path}`;
  if (item.url !== undefined && item.url !== '') return `url:${item.url}`;
  return undefined;
}

const readyGeneration = new Map<string, number>();
const listeners = new Set<() => void>();

export function noteMediaReady(key: string | undefined): void {
  if (key === undefined) return;
  readyGeneration.set(key, (readyGeneration.get(key) ?? 0) + 1);
  for (const listener of listeners) listener();
}

export function resetMediaOutcomes(): void {
  readyGeneration.clear();
  for (const listener of listeners) listener();
}

function subscribeMediaOutcome(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMediaReady(key: string | undefined, onReady: () => void): void {
  const generation = useSyncExternalStore(
    subscribeMediaOutcome,
    () => (key === undefined ? 0 : readyGeneration.get(key) ?? 0),
    () => 0,
  );
  const seen = useRef<{ key: string | undefined; generation: number } | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    const current = seen.current;
    if (current === null || current.key !== key) {
      seen.current = { key, generation };
      return;
    }
    if (current.generation === generation) return;
    seen.current = { key, generation };
    onReadyRef.current();
  }, [key, generation]);
}

/**
 * The subset of the GUI client a media save reads from: the same canonical and
 * host download entry points the lightbox and attachment dialog already use.
 */
export interface MediaDownloadClient {
  readingOptions(): { timeoutMs: number };
  downloadSessionMedia(sessionId: string, fileId: string, sink: (chunk: Uint8Array, progress: { bytes: number; totalBytes?: number }) => Promise<void>, options?: { signal?: AbortSignal }): Promise<unknown>;
  downloadHostFile(path: string, sink: (chunk: Uint8Array, progress: { bytes: number; totalBytes?: number }) => Promise<void>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface MediaSaveHost {
  openSaveSink?: (filename: string) => Promise<HostSaveSink | null>;
  saveBlob?: (blob: Blob, filename: string) => Promise<boolean>;
}

/**
 * Save one media reference to a host save sink, streaming the original bytes.
 * A session-media id or host path streams through the client; a ready URL
 * (data:, blob:, http) is fetched once and written. Returns false when the
 * user cancelled the picker, true when the bytes landed.
 */
export async function saveMediaToDisk(
  item: { url?: string; path?: string; fileId?: string },
  downloadName: string,
  host: MediaSaveHost,
  client: MediaDownloadClient | undefined,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  // A canonical or host path streams its original bytes through the client into
  // the host save sink (the desktop's native save dialog, or the browser's
  // picker/anchor). A bare URL has no canonical source to stream, so it falls
  // through to the same URL fetch the lightbox uses.
  if ((item.path !== undefined || (item.fileId !== undefined && sessionId !== undefined)) && client !== undefined) {
    const sink = host.openSaveSink !== undefined ? await host.openSaveSink(downloadName)
      : host.saveBlob !== undefined ? bufferedSaveSink((blob) => host.saveBlob!(blob, downloadName))
        : await browserSaveSink(downloadName);
    if (sink === null) return false;
    try {
      if (item.path !== undefined) {
        await client.downloadHostFile(item.path, async (chunk) => { await sink.write(chunk); }, { signal });
      } else {
        await client.downloadSessionMedia(sessionId!, item.fileId!, async (chunk) => { await sink.write(chunk); }, { signal });
      }
      return await sink.close();
    } catch (error) {
      await sink.abort().catch(() => {});
      throw error;
    }
  }
  if (item.url === undefined) throw new Error('This image has no readable source');
  // On the desktop the shell owns the save dialog; in a plain browser the URL
  // downloads directly through an anchor, matching the lightbox's URL path.
  if (host.saveBlob !== undefined) {
    const response = await fetch(item.url, { signal });
    if (!response.ok) throw new Error(`Image could not be read (${response.status})`);
    return host.saveBlob(await response.blob(), downloadName);
  }
  const anchor = document.createElement('a');
  anchor.href = item.url;
  anchor.download = downloadName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  return true;
}

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;

function matches(head: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

const ASCII = (text: string): readonly number[] => Array.from(new TextEncoder().encode(text));

/**
 * The image type the bytes actually are, from their signature alone. A media
 * store answers saved tool results as `application/octet-stream`, and a
 * transcoded preview can arrive under a type the decoder will not open, so the
 * bytes decide — a declared type is only a hint.
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const head = bytes.subarray(0, 64);
  if (matches(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (matches(head, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matches(head, 0, ASCII('GIF87a')) || matches(head, 0, ASCII('GIF89a'))) return 'image/gif';
  if (matches(head, 0, ASCII('RIFF')) && matches(head, 8, ASCII('WEBP'))) return 'image/webp';
  if (matches(head, 4, ASCII('ftyp')) && (matches(head, 8, ASCII('avif')) || matches(head, 8, ASCII('avis')))) return 'image/avif';
  if (matches(head, 0, [0x42, 0x4d])) return 'image/bmp';
  const text = new TextDecoder().decode(head).trimStart().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
  return undefined;
}

/** A concrete image type for these bytes, preferring what they are over what they claim. */
export function resolveImageMime(bytes: Uint8Array, declared?: string): string | undefined {
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== undefined) return sniffed;
  const trimmed = declared?.split(';')[0]?.trim().toLowerCase();
  if (trimmed === undefined || trimmed === 'image/*' || !IMAGE_MIME.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The same bytes under the image type they really are. A decoder refuses a blob
 * typed `application/octet-stream` on some engines, and the clipboard bridge
 * only takes an image type, so the generic label has to be replaced before
 * either sees it.
 */
export async function typedImageBlob(blob: Blob): Promise<Blob> {
  const bytes = await readBlobBytes(blob);
  const mime = resolveImageMime(bytes, blob.type);
  if (mime === undefined || blob.type === mime) return blob;
  return new Blob([bytes as BlobPart], { type: mime });
}

export async function copyImageBitmap(src: string): Promise<void> {
  let blob: Blob;
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Image could not be read (${response.status})`);
    blob = await typedImageBlob(await response.blob());
    if (blob.size === 0) throw new Error('Image could not be read');
  } catch (error) {
    if (src.startsWith('blob:') || src.startsWith('data:')) throw error;
    try {
      blob = await rasterPng(src);
    } catch {
      throw error;
    }
  }
  if (blob.type !== 'image/png' || !(await isPngBlob(blob))) {
    blob = await rasterPng(src, blob);
  }
  await copyImageToClipboard(blob);
}

async function rasterPng(src: string, blob?: Blob): Promise<Blob> {
  if (blob !== undefined && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('Canvas is unavailable');
        context.drawImage(bitmap, 0, 0);
        const out = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png'); });
        if (out !== null) return out;
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall through to Image loading
    }
  }

  // Decode the retyped blob rather than the source URL: the source may be a
  // `blob:` URL whose generic type the decoder rejects, and the URL may need
  // authorization a plain <img> cannot send.
  const decodable = blob !== undefined && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    : src;
  const isBlobUrl = decodable.startsWith('blob:') || decodable.startsWith('data:');
  const image = new Image();
  if (!isBlobUrl) {
    image.crossOrigin = 'anonymous';
  }
  image.src = decodable;
  try {
    await image.decode();
  } finally {
    if (decodable !== src) URL.revokeObjectURL(decodable);
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas is unavailable');
  context.drawImage(image, 0, 0);
  const out = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png'); });
  if (out === null) throw new Error('Image could not be copied');
  return out;
}

export function imageMenuEntries({
  t,
  src,
  path,
  link,
  remote,
  revealPath,
  openPath,
  canCopyImage,
  canSave,
  annotated,
  onCopyImage,
  onSave,
  onSaveAnnotated,
}: {
  t: (key: I18nKey) => string;
  src?: string;
  path?: string;
  link?: string;
  remote: boolean;
  revealPath?: (path: string) => Promise<void>;
  openPath?: (path: string) => Promise<void>;
  canCopyImage: boolean;
  canSave: boolean;
  annotated: boolean;
  onCopyImage: () => Promise<void>;
  onSave: () => void | Promise<void>;
  onSaveAnnotated?: () => void | Promise<void>;
}): MiniMenuEntry[] {
  const entries: MiniMenuEntry[] = [];
  const filePath = localImagePath(path);
  if (canCopyImage && src !== undefined) entries.push({ key: 'copy-image', label: t(COPY_IMAGE), run: onCopyImage });
  if (link !== undefined) entries.push({ key: 'copy-link', label: t('link.copyLink'), run: () => copyTextToClipboard(link) });
  if (filePath !== undefined) entries.push({ key: 'copy-path', label: t('file.copyPath'), run: () => copyTextToClipboard(filePath) });
  if (!remote && filePath !== undefined) {
    const actionable = hostActionPath(filePath);
    const hasHostAction = revealPath !== undefined || openPath !== undefined;
    if (hasHostAction) entries.push({ separator: true });
    if (revealPath !== undefined) {
      entries.push({ key: 'show-in-folder', label: t('file.showInFolder'), run: () => revealPath(actionable) });
    }
    if (openPath !== undefined) {
      entries.push({ key: 'open-default-app', label: t('file.openDefaultApp'), run: () => openPath(actionable) });
    }
  }
  if (canSave) {
    if (entries.length > 0) entries.push({ separator: true });
    entries.push({ key: 'save-image', label: t('media.download'), run: onSave });
    if (annotated && onSaveAnnotated !== undefined) entries.push({ key: 'save-annotated-image', label: t('media.downloadAnnotated'), run: onSaveAnnotated });
  }
  return entries;
}
