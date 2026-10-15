import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';

import { copyImageToClipboard, copyTextToClipboard, isPngBlob } from '../lib/clipboard';
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

export async function copyImageBitmap(src: string): Promise<void> {
  let blob: Blob;
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Image could not be read (${response.status})`);
    blob = await response.blob();
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

  const isBlobUrl = src.startsWith('blob:') || src.startsWith('data:');
  const image = new Image();
  if (!isBlobUrl) {
    image.crossOrigin = 'anonymous';
  }
  image.src = src;
  await image.decode();
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
