import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { appendToDraft, mentionToken, resolveActiveDraftKey } from '@kiki/session-core/composer';
import { basenameOf, formatBytes, resolveHostPath, type FileReference, type MediaRef } from '@kiki/session-core/composer/media';
import { openExternalUrl, useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { ApiError, API_CODES } from '@kiki/session-core/transport';
import { useOptionalConnection } from '../state/connection';
import { resourceActions, resourceMutability, type PreviewEnvironment, type PreviewResource } from '../state/previewResource';
import { hostFileResource, mediaRefResource } from '../state/previewWorkspace';
import { Icon } from './icons';
import { imagePreviewDownloadName, imagePreviewLabel, safeImagePreviewName } from './imagePreviewName';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { useMediaGalleryOrder, useMediaPreview } from './mediaPreviewContext';
import { copyImageBitmap, hostActionPath, httpImageLink, imageCopyFailureText, imageDownloadFailureText, imageMenuEntries, isOnKikiComputer, mediaOutcomeKey, resolveImageMime, saveMediaToDisk, useMediaReady } from './imageActions';
import { pushToast } from '../lib/toasts';
import { errorToText } from '@kiki/session-core/util';
import { canonicalGalleryItem, galleryImageId, galleryOccurrenceId } from './mediaGallery';
import { RemoteImageGate } from './RemoteImageGate';
import { useHostMediaPreview, useSessionMediaPlayback } from './useSessionMediaPlayback';
import { useTranscriptDetail } from './transcriptDetail';
import { activateInlineVideo, inlineMediaCleanupRef, notifyInlineMediaPlay, unregisterInlineMediaElement } from './inlineMediaCoordinator';

const ActiveDraftKeyContext = createContext<{
  readonly sessionId: string | undefined;
  readonly draftKey: string | undefined;
} | null>(null);

export function ActiveDraftKeyProvider({
  sessionId,
  draftKey,
  children,
}: {
  readonly sessionId: string | undefined;
  readonly draftKey: string | undefined;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ sessionId, draftKey }), [sessionId, draftKey]);
  return <ActiveDraftKeyContext.Provider value={value}>{children}</ActiveDraftKeyContext.Provider>;
}

export function useActiveDraftKey(sessionId?: string): string | undefined {
  const context = useContext(ActiveDraftKeyContext);
  const connection = useOptionalConnection();
  const effectiveSessionId = sessionId ?? context?.sessionId;
  if (context?.draftKey !== undefined && context.sessionId === effectiveSessionId) {
    return context.draftKey;
  }
  const pathname = typeof window !== 'undefined' ? window.location.pathname : undefined;
  return resolveActiveDraftKey(connection?.scopeId, effectiveSessionId, pathname);
}

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

export type MediaFailureKind = 'missing' | 'decode' | 'preview_unavailable' | 'transient';

type SessionMediaLoad =
  | { readonly status: 'loading'; readonly thumbnailUrl?: string }
  | {
      readonly status: 'failed';
      readonly thumbnailUrl?: string;
      readonly previewUnavailable?: boolean;
      readonly failureKind?: MediaFailureKind;
    }
  | {
      readonly status: 'ready';
      readonly bytes: Uint8Array;
      readonly mime: string;
      readonly name?: string;
      readonly url: string;
      readonly thumbnailUrl?: string;
    };

interface CachedMediaEntry {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly name?: string;
  readonly etag?: string;
}

export interface MediaFetchConfig {
  readonly loopbackConcurrency: number;
  readonly remoteConcurrency: number;
  readonly concurrencyOverride?: number;
  readonly inlineFallbackMaxBytes: number;
  readonly cacheMaxEntries: number;
  readonly cacheMaxBytes: number;
  readonly cacheMaxItemBytes: number;
}

const DEFAULT_MEDIA_FETCH_CONFIG: MediaFetchConfig = {
  loopbackConcurrency: 4,
  remoteConcurrency: 3,
  inlineFallbackMaxBytes: 4 * 1024 * 1024,
  cacheMaxEntries: 256,
  cacheMaxBytes: 32 * 1024 * 1024,
  cacheMaxItemBytes: 16 * 1024 * 1024,
};

let mediaFetchConfigOverrides: Partial<MediaFetchConfig> = {};

function readMediaPositiveIntEnv(key: string, min = 1, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const env = (import.meta as { readonly env?: Readonly<Record<string, unknown>> }).env;
  const raw = env?.[key];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return undefined;
  return Math.min(max, parsed);
}

/** Resolved media scheduler and cache configuration (`DEFAULT` <- `VITE_KIKI_*` <- runtime override). */
export function getMediaFetchConfig(): MediaFetchConfig {
  const envConcurrency = readMediaPositiveIntEnv('VITE_KIKI_MEDIA_FETCH_CONCURRENCY', 1, 16);
  return {
    loopbackConcurrency: mediaFetchConfigOverrides.loopbackConcurrency ?? DEFAULT_MEDIA_FETCH_CONFIG.loopbackConcurrency,
    remoteConcurrency: mediaFetchConfigOverrides.remoteConcurrency ?? DEFAULT_MEDIA_FETCH_CONFIG.remoteConcurrency,
    concurrencyOverride: mediaFetchConfigOverrides.concurrencyOverride ?? envConcurrency,
    inlineFallbackMaxBytes:
      mediaFetchConfigOverrides.inlineFallbackMaxBytes ??
      readMediaPositiveIntEnv('VITE_KIKI_MEDIA_INLINE_FALLBACK_MAX_BYTES', 0, 256 * 1024 * 1024) ??
      DEFAULT_MEDIA_FETCH_CONFIG.inlineFallbackMaxBytes,
    cacheMaxEntries:
      mediaFetchConfigOverrides.cacheMaxEntries ??
      readMediaPositiveIntEnv('VITE_KIKI_MEDIA_CACHE_MAX_ENTRIES', 1, 4096) ??
      DEFAULT_MEDIA_FETCH_CONFIG.cacheMaxEntries,
    cacheMaxBytes:
      mediaFetchConfigOverrides.cacheMaxBytes ??
      readMediaPositiveIntEnv('VITE_KIKI_MEDIA_CACHE_MAX_BYTES', 64 * 1024, 512 * 1024 * 1024) ??
      DEFAULT_MEDIA_FETCH_CONFIG.cacheMaxBytes,
    cacheMaxItemBytes:
      mediaFetchConfigOverrides.cacheMaxItemBytes ??
      readMediaPositiveIntEnv('VITE_KIKI_MEDIA_CACHE_MAX_ITEM_BYTES', 64 * 1024, 256 * 1024 * 1024) ??
      DEFAULT_MEDIA_FETCH_CONFIG.cacheMaxItemBytes,
  };
}

/** Override media scheduler/cache limits at runtime (pass `null` to restore defaults/env). */
export function configureMediaFetchConfig(patch: Partial<MediaFetchConfig> | null): MediaFetchConfig {
  mediaFetchConfigOverrides = patch === null ? {} : { ...mediaFetchConfigOverrides, ...patch };
  return getMediaFetchConfig();
}

/** LIFO bounded-concurrency media fetch scheduler (interactive reads ahead of scrolling previews). */
export class MediaFetchScheduler {
  private active = 0;
  private readonly interactiveWaiters: Array<{ readonly enter: () => void; readonly cancel: () => void }> = [];
  private readonly previewWaiters: Array<{ readonly enter: () => void; readonly cancel: () => void }> = [];
  private readonly resolveLimit: () => number;

  constructor(limit: number | (() => number)) {
    this.resolveLimit = typeof limit === 'function' ? limit : () => limit;
  }

  private limit(): number {
    return Math.max(1, this.resolveLimit());
  }

  private pump(): void {
    const cap = this.limit();
    while (this.active < cap) {
      const next = this.interactiveWaiters.pop() ?? this.previewWaiters.pop();
      if (next === undefined) break;
      next.enter();
    }
  }

  schedule<T>(signal: AbortSignal, priority: 'interactive' | 'preview', task: () => Promise<T>): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Media fetch cancelled', 'AbortError'));
    }
    const execute = async (): Promise<T> => {
      this.active += 1;
      try {
        signal.throwIfAborted();
        return await task();
      } finally {
        this.active -= 1;
        this.pump();
      }
    };
    if (this.active < this.limit()) {
      return execute();
    }
    const queue = priority === 'interactive' ? this.interactiveWaiters : this.previewWaiters;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const waiter = {
        enter: () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', waiter.cancel);
          resolve(execute());
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          signal.removeEventListener('abort', waiter.cancel);
          reject(signal.reason ?? new DOMException('Media fetch cancelled', 'AbortError'));
        },
      };
      queue.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
    });
  }
}

const fallbackMediaSchedulers = new WeakMap<object, MediaFetchScheduler>();

function isLocalMediaConnection(connection: ReturnType<typeof useOptionalConnection>): boolean {
  if (connection === null || connection === undefined) return false;
  if (isOnKikiComputer(connection)) return true;
  return connection.connectionSource === undefined && connection.scopeId === 'local';
}

function schedulerForFallbackClient(client: object, localConnection: boolean): MediaFetchScheduler {
  let scheduler = fallbackMediaSchedulers.get(client);
  if (scheduler === undefined) {
    scheduler = new MediaFetchScheduler(() => {
      const config = getMediaFetchConfig();
      return config.concurrencyOverride ?? (localConnection ? config.loopbackConcurrency : config.remoteConcurrency);
    });
    fallbackMediaSchedulers.set(client, scheduler);
  }
  return scheduler;
}

function clientOwnsMediaFetchLane(client: unknown): boolean {
  return typeof client === 'object' && client !== null && (client as { readonly ownsMediaFetchLane?: unknown }).ownsMediaFetchLane === true;
}

class SessionMediaLruCache {
  private readonly entries = new Map<string, CachedMediaEntry>();
  private totalBytes = 0;

  get(key: string): CachedMediaEntry | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, entry: CachedMediaEntry): void {
    const config = getMediaFetchConfig();
    if (entry.bytes.byteLength === 0 || entry.bytes.byteLength > config.cacheMaxItemBytes) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.totalBytes -= previous.bytes.byteLength;
    }
    this.entries.set(key, entry);
    this.totalBytes += entry.bytes.byteLength;
    while (this.entries.size > config.cacheMaxEntries || this.totalBytes > config.cacheMaxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.totalBytes -= this.entries.get(oldest)!.bytes.byteLength;
      this.entries.delete(oldest);
    }
  }
}

const providerMediaCaches = new WeakMap<object, SessionMediaLruCache>();

function sessionMediaCacheKey(
  scopeKey: string,
  sessionId: string | undefined,
  fileId: string | undefined,
  hostPath: string | undefined,
  previewOnly: boolean,
  mime: string | undefined,
): string | undefined {
  if (sessionId !== undefined && fileId !== undefined) {
    return `${scopeKey}\0session\0${sessionId}\0${fileId}\0${previewOnly ? 'preview' : 'full'}\0${previewOnly ? (mime ?? '') : ''}`;
  }
  if (hostPath !== undefined) {
    return `${scopeKey}\0host\0${hostPath}\0${previewOnly ? 'preview' : 'full'}\0${previewOnly ? (mime ?? '') : ''}`;
  }
  return undefined;
}

function clientOwnsPreviewCache(client: unknown): client is {
  peekSessionMediaPreviewBytes: (sid: string, fid: string, mediaType?: string) => CachedMediaEntry | undefined;
  peekHostMediaPreviewBytes: (path: string, mediaType?: string) => CachedMediaEntry | undefined;
} {
  if (client === undefined || client === null || typeof client !== 'object') return false;
  const typed = client as Record<string, unknown>;
  return typeof typed['peekSessionMediaPreviewBytes'] === 'function' && typeof typed['peekHostMediaPreviewBytes'] === 'function';
}

function peekMediaCache(
  client: unknown,
  providerOwner: object | undefined,
  key: string | undefined,
  options: {
    readonly previewOnly: boolean;
    readonly sessionId: string | undefined;
    readonly fileId: string | undefined;
    readonly hostPath: string | undefined;
    readonly mime: string | undefined;
  },
): CachedMediaEntry | undefined {
  if (client === undefined) return undefined;
  if (options.previewOnly && clientOwnsPreviewCache(client)) {
    const direct = options.sessionId !== undefined && options.fileId !== undefined
      ? client.peekSessionMediaPreviewBytes(options.sessionId, options.fileId, options.mime)
      : options.hostPath !== undefined
        ? client.peekHostMediaPreviewBytes(options.hostPath, options.mime)
        : undefined;
    if (direct !== undefined) return direct;
  }
  if (key === undefined) return undefined;
  const typed = client as { peekUiMediaCache?: (cacheKey: string) => CachedMediaEntry | undefined };
  if (typeof typed.peekUiMediaCache === 'function') {
    return typed.peekUiMediaCache(key);
  }
  if (providerOwner === undefined) return undefined;
  return providerMediaCaches.get(providerOwner)?.get(key);
}

function storeMediaCache(
  client: unknown,
  providerOwner: object | undefined,
  key: string | undefined,
  entry: CachedMediaEntry,
  skipClientDuplicatePreview: boolean,
): void {
  if (key === undefined || client === undefined || skipClientDuplicatePreview) return;
  const typed = client as { storeUiMediaCache?: (cacheKey: string, value: CachedMediaEntry) => void };
  if (typeof typed.storeUiMediaCache === 'function') {
    typed.storeUiMediaCache(key, entry);
    return;
  }
  if (providerOwner === undefined) return;
  let cache = providerMediaCaches.get(providerOwner);
  if (cache === undefined) {
    cache = new SessionMediaLruCache();
    providerMediaCaches.set(providerOwner, cache);
  }
  cache.set(key, entry);
}

function peekPreviewFallback(
  client: unknown,
  providerOwner: object | undefined,
  scopeKey: string,
  sessionId: string | undefined,
  fileId: string | undefined,
  hostPath: string | undefined,
  mime: string | undefined,
): CachedMediaEntry | undefined {
  const previewKey = sessionMediaCacheKey(scopeKey, sessionId, fileId, hostPath, true, mime);
  return peekMediaCache(client, providerOwner, previewKey, {
    previewOnly: true,
    sessionId,
    fileId,
    hostPath,
    mime,
  });
}

function effectiveMediaMime(
  bytes: Uint8Array,
  responseMime: string,
  declaredMime: string | undefined,
  kind: MediaRef['kind'],
): string {
  const baseMime = responseMime === 'application/octet-stream' ? (declaredMime ?? responseMime) : responseMime;
  if (kind === 'image' || baseMime.startsWith('image/')) {
    return resolveImageMime(bytes, baseMime) ?? baseMime;
  }
  return baseMime;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

const TRANSIENT_MEDIA_RETRY_DELAYS_MS = [250, 750, 1750] as const;

export function isTransientMediaBusyError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.code === API_CODES.SESSION_BUSY || error.code === 503 || error.code === 40923;
  }
  return error instanceof Error && /\b(?:SESSION_BUSY|HTTP 503|history_canonical_preparing)\b/i.test(error.message);
}

export function isMediaPreviewUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.code === API_CODES.REQUEST_INVALID || error.code === 413 || error.code === 415 || error.reason === 'preview_budget_exceeded') ||
    error instanceof Error && /exceeds its byte budget|preview_budget_exceeded|HTTP 413|HTTP 415/i.test(error.message);
}

export function classifyMediaFailure(
  error: unknown,
  previewOnly = false,
  _kind?: MediaRef['kind'] | 'audio' | 'file',
): MediaFailureKind {
  if (error instanceof ApiError) {
    const code = error.code;
    const reason = error.reason;
    if (
      code === API_CODES.SESSION_NOT_FOUND ||
      code === 404 ||
      code === 410 ||
      code === 40404 ||
      code === 40407 ||
      code === 40409 ||
      code === 40402 ||
      reason === 'media_preview_not_found' ||
      reason === 'file_not_found'
    ) {
      return 'missing';
    }
    if (code === 415) return 'decode';
    if (
      code === 413 ||
      reason === 'preview_budget_exceeded' ||
      (previewOnly && code === API_CODES.REQUEST_INVALID)
    ) {
      return 'preview_unavailable';
    }
    if (
      code === API_CODES.SESSION_BUSY ||
      code === 503 ||
      code === 40923 ||
      code === API_CODES.TIMEOUT ||
      code === -1 ||
      (code >= 500 && code < 600)
    ) {
      return 'transient';
    }
  }
  if (typeof error === 'object' && error !== null && !(error instanceof Error)) {
    const rec = error as { readonly code?: unknown; readonly status?: unknown; readonly reason?: unknown };
    const code = typeof rec.code === 'number' ? rec.code : typeof rec.status === 'number' ? rec.status : undefined;
    if (code === 404 || code === 410 || code === 40407 || code === 40409 || code === 40402 || rec.reason === 'media_preview_not_found') {
      return 'missing';
    }
    if (code === 415) return 'decode';
    if (code === 413 || rec.reason === 'preview_budget_exceeded') return 'preview_unavailable';
    if (code === 503 || code === 40923 || (code !== undefined && code >= 500 && code < 600)) return 'transient';
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : '';
  if (/\b(?:ENOENT|ENOTDIR|FILE_NOT_FOUND|SESSION_NOT_FOUND|HTTP 404|HTTP 410|40407|40409|40402|not found|no longer available)\b/i.test(message)) {
    return 'missing';
  }
  if (/\b(?:MEDIA_ERR_DECODE|HTTP 415|unsupported media|decode)\b/i.test(message)) {
    return 'decode';
  }
  if (/\b(?:HTTP 413|preview_budget_exceeded|exceeds its byte budget|preview unavailable|preview_unavailable)\b/i.test(message)) {
    return 'preview_unavailable';
  }
  return 'transient';
}

export function useSessionMedia(
  item: MediaRef,
  sessionId: string | undefined,
  enabled = true,
  previewOnly = true,
  attempt = 0,
): SessionMediaLoad {
  const connection = useOptionalConnection();
  const client = connection?.client;
  const localConnection = isLocalMediaConnection(connection);
  const scopeId = (connection as { scopeId?: string } | undefined)?.scopeId ?? '';
  const baseUrl = (client as { baseUrl?: string } | undefined)?.baseUrl ?? '';
  const scopeKey = `${scopeId}\0${baseUrl}`;
  const preview = useMediaPreview();
  const providerOwner = preview?.registerGalleryImage as object | undefined;
  const hostPath = item.path === undefined ? undefined : resolveHostPath(item.path, preview?.cwd);
  const source = useMemo(
    () => ({ client, scopeKey, sessionId, fileId: item.fileId, path: hostPath, attempt }),
    [client, scopeKey, sessionId, item.fileId, hostPath, item.mime, item.kind, item.blobHash, previewOnly, attempt],
  );
  const [loaded, setLoaded] = useState<{ source: typeof source; load: SessionMediaLoad }>({ source, load: { status: 'loading' } });
  const setLoad = useCallback((load: SessionMediaLoad) => { setLoaded({ source, load }); }, [source]);
  const load: SessionMediaLoad = loaded.source === source ? loaded.load : { status: 'loading' };

  useLayoutEffect(() => {
    if (!enabled) { setLoad({ status: 'loading' }); return; }
    const hasSessionMedia = sessionId !== undefined && item.fileId !== undefined;
    if (client === undefined || (!hasSessionMedia && hostPath === undefined) || (previewOnly && item.kind !== 'image' && item.kind !== 'video')) {
      setLoad({ status: 'failed', failureKind: !hasSessionMedia && hostPath === undefined ? 'missing' : 'transient' });
      return;
    }
    const cacheKey = sessionMediaCacheKey(scopeKey, sessionId, item.fileId, hostPath, previewOnly, item.mime);
    let objectUrl: string | undefined;
    let thumbnailUrl: string | undefined;
    const revokeThumbnail = () => {
      if (thumbnailUrl !== undefined) {
        URL.revokeObjectURL(thumbnailUrl);
        thumbnailUrl = undefined;
      }
    };
    const revokeObject = () => {
      if (objectUrl !== undefined) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = undefined;
      }
    };
    const cached = attempt === 0
      ? peekMediaCache(client, providerOwner, cacheKey, {
          previewOnly,
          sessionId,
          fileId: item.fileId,
          hostPath,
          mime: item.mime,
        })
      : undefined;
    if (cached !== undefined) {
      const cachedMime = effectiveMediaMime(cached.bytes, cached.mime, item.mime, item.kind);
      objectUrl = URL.createObjectURL(new Blob([cached.bytes as BlobPart], { type: cachedMime }));
      setLoad({ status: 'ready', bytes: cached.bytes, mime: cachedMime, name: cached.name, url: objectUrl });
      if (hasSessionMedia) {
        return () => {
          revokeObject();
        };
      }
    } else if (attempt === 0 && !previewOnly && item.kind === 'image') {
      const previewHit = peekPreviewFallback(client, providerOwner, scopeKey, sessionId, item.fileId, hostPath, item.mime);
      if (previewHit !== undefined && previewHit.bytes.byteLength > 0) {
        const previewMime = effectiveMediaMime(
          previewHit.bytes,
          previewHit.mime === 'application/octet-stream' ? (item.mime ?? 'image/jpeg') : previewHit.mime,
          item.mime,
          item.kind,
        );
        thumbnailUrl = URL.createObjectURL(new Blob([previewHit.bytes as BlobPart], { type: previewMime }));
      }
    }
    const controller = new AbortController();
    if (cached === undefined) {
      setLoad(thumbnailUrl === undefined ? { status: 'loading' } : { status: 'loading', thumbnailUrl });
    }
    const options = { ...client.readingOptions(), signal: controller.signal, mediaType: item.mime };
    const fetchConfig = getMediaFetchConfig();
    const allowInlineOriginalFallback =
      previewOnly &&
      item.kind === 'image' &&
      localConnection &&
      (item.size === undefined || item.size <= fetchConfig.inlineFallbackMaxBytes);
    let storedByClientPreviewCache = previewOnly && clientOwnsPreviewCache(client);
    const readSession = (): Promise<{ bytes: Uint8Array; mime: string; name?: string; etag?: string; notModified?: boolean }> => {
      const primary = previewOnly
        ? client.readSessionMediaPreviewBytes(sessionId!, item.fileId!, options)
        : client.readSessionMediaBytes(sessionId!, item.fileId!, options);
      return primary.catch((error: unknown) => {
        if (!allowInlineOriginalFallback || controller.signal.aborted || !isMediaPreviewUnavailable(error)) throw error;
        storedByClientPreviewCache = false;
        return client.readSessionMediaBytes(sessionId!, item.fileId!, options);
      });
    };
    const readHost = (): Promise<{ bytes: Uint8Array; mime: string; name?: string; etag?: string; notModified?: boolean }> => {
      const primary = previewOnly
        ? client.readHostMediaPreviewBytes(hostPath!, options)
        : client.readHostFileBytes(hostPath!, cached?.etag === undefined ? options : { ...options, ifNoneMatch: cached.etag });
      return primary.catch((error: unknown) => {
        if (!allowInlineOriginalFallback || controller.signal.aborted || !isMediaPreviewUnavailable(error)) throw error;
        storedByClientPreviewCache = false;
        return client.readHostFileBytes(hostPath!, cached?.etag === undefined ? options : { ...options, ifNoneMatch: cached.etag });
      });
    };
    const scheduleRead = (
      task: () => Promise<{ bytes: Uint8Array; mime: string; name?: string; etag?: string; notModified?: boolean }>,
    ) => {
      if (!previewOnly || clientOwnsMediaFetchLane(client)) return task();
      return schedulerForFallbackClient(client as object, localConnection).schedule(
        controller.signal,
        'preview',
        task,
      );
    };
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let transientRetry = 0;
    const runRead = () => {
      const resolved = scheduleRead(() => (hasSessionMedia ? readSession() : readHost()));
      resolved.then((result) => {
        if (controller.signal.aborted) return;
        if (result.notModified === true && cached !== undefined && objectUrl !== undefined) {
          revokeThumbnail();
          return;
        }
        const { bytes, mime, name, etag } = result;
        if (bytes.byteLength === 0) {
          revokeObject();
          setLoad(thumbnailUrl === undefined ? { status: 'failed', failureKind: 'decode' } : { status: 'failed', thumbnailUrl, failureKind: 'decode' });
          return;
        }
        const mediaType = effectiveMediaMime(bytes, mime, item.mime, item.kind);
        storeMediaCache(client, providerOwner, cacheKey, { bytes, mime: mediaType, name, etag }, storedByClientPreviewCache && etag !== undefined);
        if (
          cached !== undefined &&
          objectUrl !== undefined &&
          ((cached.etag !== undefined && etag === cached.etag) ||
            (etag === undefined && mediaType === cached.mime && sameBytes(bytes, cached.bytes)))
        ) {
          revokeThumbnail();
          return;
        }
        revokeObject();
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
        revokeThumbnail();
        setLoad({ status: 'ready', bytes, mime: mediaType, name, url: objectUrl });
      }, (error: unknown) => {
        if (controller.signal.aborted) return;
        if (isTransientMediaBusyError(error) && transientRetry < TRANSIENT_MEDIA_RETRY_DELAYS_MS.length) {
          const delay = TRANSIENT_MEDIA_RETRY_DELAYS_MS[transientRetry]!;
          transientRetry += 1;
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (!controller.signal.aborted) runRead();
          }, delay);
          return;
        }
        revokeObject();
        const previewUnavailable = previewOnly && item.kind === 'video' && isMediaPreviewUnavailable(error);
        const failureKind = classifyMediaFailure(error, previewOnly, item.kind);
        setLoad(
          thumbnailUrl === undefined
            ? { status: 'failed', previewUnavailable, failureKind }
            : { status: 'failed', thumbnailUrl, previewUnavailable, failureKind },
        );
      });
    };
    runRead();
    return () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      controller.abort();
      revokeThumbnail();
      revokeObject();
    };
  }, [attempt, client, enabled, localConnection, previewOnly, providerOwner, scopeKey, item.blobHash, item.fileId, hostPath, item.mime, item.kind, item.size, sessionId, setLoad]);

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
  const localKikiComputer = isOnKikiComputer(connection);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);
  const effectivePath = item.path ?? (item.origin?.trusted ? item.origin.path : undefined);
  const downloadName = imagePreviewDownloadName({ name: item.name, path: effectivePath });
  const hostPath = effectivePath === undefined ? undefined : hostActionPath(effectivePath, preview?.cwd);
  const onSave = useCallback(async () => {
    try {
      await saveMediaToDisk(
        { url: item.url ?? src, path: hostPath, fileId: item.fileId },
        downloadName,
        host,
        client as Parameters<typeof saveMediaToDisk>[3],
        preview?.sessionId,
      );
    } catch (error) {
      pushToast({ tone: 'error', text: imageDownloadFailureText(error, t), detail: errorToText(error) });
    }
  }, [item.url, hostPath, item.fileId, src, downloadName, host, client, preview?.sessionId, t]);
  const onCopyImage = useCallback(async () => {
    if (src === undefined) return;
    try {
      await copyImageBitmap(src);
    } catch (error) {
      pushToast({ tone: 'error', text: imageCopyFailureText(error, t, host.kind), detail: errorToText(error) });
    }
  }, [src, t, host.kind]);
  const entries = imageMenuEntries({
    t,
    src,
    path: effectivePath,
    cwd: preview?.cwd,
    link: httpImageLink(item.url),
    localKikiComputer,
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

function SessionMediaThumb({
  item,
  size = 'default',
  onOpen,
  onStripFailure,
}: {
  item: MediaRef;
  size?: MediaThumbSize;
  onOpen?: () => void;
  onStripFailure?: (kind: MediaFailureKind) => void;
}) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const [hostRef, visible] = useVisibleOnce();
  const [attempt, setAttempt] = useState(0);
  const load = useSessionMedia(item, preview?.sessionId, visible, true, attempt);
  const [failedUrl, setFailedUrl] = useState<string>();
  const failedRef = useRef(false);
  const isDecodeFailed = load.status === 'ready' && failedUrl === load.url;
  const isBroken = (load.status === 'failed' && !(item.kind === 'video' && load.previewUnavailable === true)) || isDecodeFailed;
  const resolvedFailureKind: MediaFailureKind | undefined = isDecodeFailed
    ? 'decode'
    : load.status === 'failed'
      ? (load.failureKind ?? 'transient')
      : undefined;
  failedRef.current = load.status === 'failed' || isDecodeFailed;
  useMediaReady(mediaOutcomeKey({ sessionId: preview?.sessionId, url: item.url, fileId: item.fileId, path: item.path }), () => {
    if (!failedRef.current) return;
    setFailedUrl(undefined);
    setAttempt((value) => value + 1);
  });
  useEffect(() => {
    if (size === 'strip' && isBroken && resolvedFailureKind !== undefined) {
      onStripFailure?.(resolvedFailureKind);
    }
  }, [size, isBroken, resolvedFailureKind, onStripFailure]);
  const fallback = item.kind === 'image' ? t('media.image') : t('media.attachment');
  const name = attachmentName(item, load.status === 'ready' ? load.name : undefined, fallback);
  const readyUrl = load.status === 'ready' && failedUrl !== load.url ? load.url : undefined;
  const imageMenu = useMessageImageMenu(item, readyUrl, name);
  const originalPath = item.path ?? item.origin?.path;
  const openOriginal = () => { if (onOpen !== undefined) onOpen(); else preview?.openAttachment(item); };
  const retryLoad = () => {
    setFailedUrl(undefined);
    setAttempt((value) => value + 1);
  };
  let body: ReactNode;
  if (item.kind === 'video' && load.status === 'failed' && load.previewUnavailable === true) {
    body = (
      <button
        type="button"
        data-media-video-placeholder
        title={name}
        aria-label={name}
        onClick={openOriginal}
        onContextMenu={imageMenu.openMenu}
        className={`flex ${THUMB_SIZE[size].slot} flex-col items-center justify-center gap-1.5 ${THUMB_SIZE[size].frame} border border-hairline bg-panel px-2 text-[11px] text-ink-soft transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        <span aria-hidden className={`flex items-center justify-center rounded-full bg-ink/10 ${size === 'strip' ? 'h-5 w-5' : 'h-8 w-8'}`}>
          <span className={`ml-0.5 h-0 w-0 border-y-transparent border-l-ink ${size === 'strip' ? 'border-y-[3.5px] border-l-[6px]' : 'border-y-[5px] border-l-[8px]'}`} />
        </span>
        {size === 'strip' ? null : <span className="max-w-full truncate font-mono text-[11px]">{name}</span>}
      </button>
    );
  } else if (isBroken) {
    if (size === 'strip') return null;
    body = (
      <MediaLoadFailure
        name={name}
        decode={isDecodeFailed}
        failureKind={resolvedFailureKind}
        size={size}
        title={originalPath ?? name}
        onRetry={retryLoad}
        onOpen={openOriginal}
        onContextMenu={imageMenu.openMenu}
      />
    );
  } else if (load.status === 'loading') {
    body = (
      <span
        aria-busy="true"
        className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} ${size === 'strip' ? 'animate-pulse bg-ink/[0.06] motion-reduce:animate-none' : 'text-[11px] text-ink-faint'}`}
      >
        {size === 'strip' ? null : t('preview.loading')}
      </span>
    );
  } else if (load.status === 'ready') {
    body = (
      <button
        type="button"
        title={name}
        onClick={openOriginal}
        onContextMenu={imageMenu.openMenu}
        className={`block overflow-hidden ${THUMB_SIZE[size].frame} transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        <img src={load.url} alt={name} referrerPolicy="no-referrer" decoding="async" onError={() => { setFailedUrl(load.url); }} className={`${THUMB_SIZE[size].img} object-cover`} />
      </button>
    );
  } else {
    body = null;
  }
  return <span ref={hostRef} className="inline-flex">{body}{imageMenu.menuElement}</span>;
}

export function MediaLoadFailure({
  name,
  decode,
  failureKind,
  size = 'default',
  title,
  onRetry,
  onOpen,
  onContextMenu,
  retryDataAttr,
}: {
  readonly name: string;
  readonly decode: boolean;
  readonly failureKind?: MediaFailureKind;
  readonly size?: MediaThumbSize;
  readonly title?: string;
  readonly onRetry?: () => void;
  readonly onOpen?: () => void;
  readonly onContextMenu?: (event: React.MouseEvent) => void;
  readonly retryDataAttr?: Record<string, string | undefined>;
}) {
  const { t, locale } = useI18n();
  if (size === 'strip') return null;
  const kind: MediaFailureKind = failureKind ?? (decode ? 'decode' : 'transient');
  const safeName = imagePreviewLabel({ name }, t('media.attachment'));
  const statusText =
    kind === 'missing'
      ? (locale === 'zh' ? '原文件已不在' : 'Original file unavailable')
      : kind === 'decode'
        ? (locale === 'zh' ? '无法预览' : 'Cannot preview')
        : kind === 'preview_unavailable'
          ? (locale === 'zh' ? '文件过大' : 'File too large')
          : (locale === 'zh' ? '暂时无法加载' : 'Temporarily unavailable');
  const tooltip = title !== undefined && title !== '' ? title : safeName;
  const chipClass = 'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-hairline bg-ink/[0.03] px-2.5 text-[12px] text-ink-soft';
  const brokenAttr = kind === 'decode' ? 'decode' : 'read';

  if (kind === 'missing') {
    return (
      <span
        data-media-broken={brokenAttr}
        data-media-failure-kind="missing"
        title={tooltip}
        onContextMenu={onContextMenu}
        className={chipClass}
      >
        <Icon name="file" size={12} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate font-mono">{safeName}</span>
        <span aria-hidden className="shrink-0 text-ink-faint">·</span>
        <span className="shrink-0 text-ink-faint">{statusText}</span>
      </span>
    );
  }

  const interactiveChipClass = `${chipClass} cursor-pointer transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`;

  if (kind === 'transient') {
    if (onRetry === undefined) {
      return (
        <span
          data-media-broken={brokenAttr}
          data-media-failure-kind="transient"
          title={tooltip}
          onContextMenu={onContextMenu}
          className={chipClass}
        >
          <Icon name="file" size={12} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 truncate font-mono">{safeName}</span>
          <span aria-hidden className="shrink-0 text-ink-faint">·</span>
          <span className="shrink-0 text-ink-faint">{statusText}</span>
        </span>
      );
    }
    return (
      <button
        type="button"
        data-media-broken={brokenAttr}
        data-media-failure-kind="transient"
        data-media-retry
        {...retryDataAttr}
        title={tooltip}
        aria-label={`${safeName} · ${statusText} · ${t('transcript.detail.retry')}`}
        onClick={onRetry}
        onContextMenu={onContextMenu}
        className={interactiveChipClass}
      >
        <Icon name="file" size={12} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate font-mono">{safeName}</span>
        <span aria-hidden className="shrink-0 text-ink-faint">·</span>
        <span className="shrink-0 text-ink-faint">{statusText}</span>
        <Icon name="refresh" size={12} className="ml-0.5 shrink-0 text-ink-soft" />
      </button>
    );
  }

  const secondaryAction = onOpen ?? onRetry;
  const actionLabel =
    kind === 'preview_unavailable'
      ? (locale === 'zh' ? '打开原文件' : 'Open original')
      : (locale === 'zh' ? '打开' : 'Open');
  if (secondaryAction === undefined) {
    return (
      <span
        data-media-broken={brokenAttr}
        data-media-failure-kind={kind}
        title={tooltip}
        onContextMenu={onContextMenu}
        className={chipClass}
      >
        <Icon name="file" size={12} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate font-mono">{safeName}</span>
        <span aria-hidden className="shrink-0 text-ink-faint">·</span>
        <span className="shrink-0 text-ink-faint">{statusText}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-media-broken={brokenAttr}
      data-media-failure-kind={kind}
      data-media-open
      {...retryDataAttr}
      title={tooltip}
      onClick={secondaryAction}
      onContextMenu={onContextMenu}
      className={interactiveChipClass}
    >
      <Icon name="file" size={12} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 truncate font-mono">{safeName}</span>
      <span aria-hidden className="shrink-0 text-ink-faint">·</span>
      <span className="shrink-0 text-ink-faint">{statusText}</span>
      <span className="ml-0.5 shrink-0 text-[11.5px] font-medium text-ink">{actionLabel}</span>
    </button>
  );
}

function AudioPart({ item }: { item: MediaRef }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const localKikiComputer = isOnKikiComputer(connection);
  const [hostRef, visible] = useVisibleOnce();
  const [attempt, setAttempt] = useState(0);
  const hostPath = item.path === undefined ? undefined : resolveHostPath(item.path, preview?.cwd);
  const canHostPreview =
    visible &&
    item.url === undefined &&
    item.fileId === undefined &&
    hostPath !== undefined &&
    localKikiComputer &&
    client !== undefined &&
    typeof client.openHostMediaPreview === 'function';
  const hostPreview = useHostMediaPreview(client, hostPath, canHostPreview, attempt);

  const playbackSessionId = visible && item.url === undefined ? preview?.sessionId : undefined;
  const remotePlayback = client === undefined || !localKikiComputer;
  const playback = useSessionMediaPlayback(item, playbackSessionId, client, remotePlayback, attempt);
  const needBlobFallback =
    visible &&
    item.url === undefined &&
    playback.status === 'fallback' &&
    (!canHostPreview || hostPreview.status === 'fallback');
  const load = useSessionMedia(item, preview?.sessionId, needBlobFallback, false, attempt);
  const resolvedSrc =
    item.url ??
    (playback.status === 'ready'
      ? playback.url
      : hostPreview.status === 'ready'
        ? hostPreview.url
        : load.status === 'ready'
          ? load.url
          : undefined);
  // Keep the last valid audio URL mounted across prop/client churn so `<audio>`
  // never flashes back to a loading skeleton once ready.
  const [stickySrc, setStickySrc] = useState<{ readonly key: string; readonly url: string } | null>(null);
  const mediaKey = `${preview?.sessionId ?? ''}\0${item.fileId ?? item.path ?? item.url ?? ''}\0${attempt}`;
  if (resolvedSrc !== undefined && (stickySrc?.key !== mediaKey || stickySrc.url !== resolvedSrc)) {
    setStickySrc({ key: mediaKey, url: resolvedSrc });
  }
  const [audioFailedState, setAudioFailedState] = useState<{ readonly key: string; readonly kind: 'decode' | 'transient' } | null>(null);
  const audioErrorKind = audioFailedState?.key === mediaKey ? audioFailedState.kind : undefined;
  const audioDecodeFailed = audioErrorKind === 'decode';
  const src = audioErrorKind !== undefined ? undefined : (resolvedSrc ?? (playback.status !== 'failed' && stickySrc?.key === mediaKey ? stickySrc.url : undefined));
  const failed = src === undefined && (audioErrorKind !== undefined || playback.status === 'failed' || (needBlobFallback && load.status === 'failed'));
  const audioFailureKind: MediaFailureKind =
    audioErrorKind ??
    (needBlobFallback && load.status === 'failed'
      ? (load.failureKind ?? 'transient')
      : 'transient');
  const label = attachmentName(item, undefined, t('media.attachment'));
  const audioMenu = useMediaRefMenu(item, label);
  const originalPath = item.path ?? item.origin?.path;
  return (
    <span ref={hostRef} className="inline-flex max-w-full" onContextMenu={audioMenu.openMenu}>
      {src !== undefined ? (
        <audio
          ref={inlineMediaCleanupRef}
          controls
          src={src}
          preload="none"
          onPlay={(event) => { notifyInlineMediaPlay(event.currentTarget); }}
          onEnded={(event) => { unregisterInlineMediaElement(event.currentTarget); }}
          onError={(event) => {
            unregisterInlineMediaElement(event.currentTarget);
            const errCode = event.currentTarget.error?.code;
            const isNetwork = errCode === 1 || errCode === 2;
            setAudioFailedState({ key: mediaKey, kind: isNetwork ? 'transient' : 'decode' });
            if (playback.status === 'ready') playback.fail();
          }}
          className="h-10 max-w-full"
        />
      ) : failed ? (
        <MediaLoadFailure
          name={label}
          decode={audioDecodeFailed}
          failureKind={audioFailureKind}
          title={originalPath ?? label}
          onRetry={() => {
            setAudioFailedState(null);
            setAttempt((value) => value + 1);
          }}
          onOpen={audioFailureKind === 'decode' && preview !== null ? () => { preview.openAttachment(item); } : undefined}
          onContextMenu={audioMenu.openMenu}
        />
      ) : !visible || playback.status === 'loading' || hostPreview.status === 'loading' || (needBlobFallback && load.status === 'loading') ? (
        <span aria-busy="true" className="block h-10 w-[220px] max-w-full animate-pulse rounded-lg bg-ink/[0.06] motion-reduce:animate-none" />
      ) : (
        <FileChip item={item} />
      )}
      {audioMenu.menuElement}
    </span>
  );
}

function relativePathForMention(path: string, cwd: string | undefined): string {
  if (cwd === undefined) return path;
  const normPath = resolveHostPath(path).replaceAll('\\', '/');
  const normCwd = resolveHostPath(cwd).replaceAll('\\', '/').replace(/\/+$/, '');
  const prefix = `${normCwd}/`;
  if (normPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normPath.slice(prefix.length);
  }
  return path;
}

export function buildResourceMenuEntries({
  resource,
  rawPath,
  cwd,
  sessionId,
  draftKey,
  localKikiComputer,
  host,
  client,
  t,
  onOpenPreview,
  onOpenCurrentFile,
}: {
  readonly resource: PreviewResource;
  readonly rawPath?: string;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly draftKey?: string;
  readonly localKikiComputer: boolean;
  readonly host: ReturnType<typeof useHost>;
  readonly client?: unknown;
  readonly t: ReturnType<typeof useI18n>['t'];
  readonly onOpenPreview?: () => void;
  readonly onOpenCurrentFile?: (path: string) => void;
}): MiniMenuEntry[] {
  const environment: PreviewEnvironment = {
    isKikiComputer: localKikiComputer,
    hasSession: sessionId !== undefined,
    capabilities: {
      reveal: host.revealPath !== undefined,
      open: host.openPath !== undefined,
    },
  };
  const actions = resourceActions(resource, environment, {
    status: 'ready',
    readableFromDevice:
      resource.source.kind === 'session-copy'
        ? sessionId !== undefined && client !== undefined
        : resource.source.kind === 'url'
          ? resource.source.url !== ''
          : client !== undefined && (localKikiComputer || sessionId !== undefined),
    originalReadable: true,
  });
  const isCopy = resourceMutability(resource) === 'copy';
  const trustedPath =
    resource.origin !== undefined && resource.origin.trusted
      ? resolveHostPath(resource.origin.path, cwd)
      : resource.source.kind === 'host-file'
        ? resolveHostPath(resource.source.path, cwd)
        : undefined;

  const entries: MiniMenuEntry[] = [];
  if (onOpenPreview !== undefined) {
    entries.push({ key: 'open-preview', label: t('file.openPreview'), run: onOpenPreview });
  }
  const hostEntries: MiniMenuEntry[] = [];
  for (const action of actions) {
    if (action.id === 'open-current-file' && trustedPath !== undefined && onOpenCurrentFile !== undefined) {
      entries.push({
        key: 'open-current-file',
        label: t('preview.openCurrentFile'),
        run: () => { onOpenCurrentFile(trustedPath); },
      });
    } else if (action.id === 'download' && resource.source.kind !== 'host-file') {
      const downloadName =
        safeImagePreviewName({ name: resource.name, path: trustedPath }) ?? resource.name ?? t('media.attachment');
      const copySource = resource.source;
      entries.push({
        key: 'download',
        label: t('media.download'),
        run: async () => {
          try {
            await saveMediaToDisk(
              {
                url: copySource.kind === 'url' ? copySource.url : undefined,
                fileId: copySource.kind === 'session-copy' ? copySource.fileId : undefined,
              },
              downloadName,
              host,
              client as Parameters<typeof saveMediaToDisk>[3],
              copySource.kind === 'session-copy' ? (copySource.sessionId || sessionId) : sessionId,
            );
          } catch (error) {
            pushToast({ tone: 'error', text: imageDownloadFailureText(error, t), detail: errorToText(error) });
          }
        },
      });
    } else if (action.id === 'add-to-chat' && (draftKey ?? sessionId) !== undefined && trustedPath !== undefined) {
      const targetDraftKey = draftKey ?? sessionId!;
      entries.push({
        key: 'add-to-chat',
        label: t('preview.addToChat'),
        run: () => {
          appendToDraft(
            targetDraftKey,
            mentionToken({
              kind: 'file',
              path: relativePathForMention(trustedPath, cwd),
              name: basenameOf(trustedPath),
              isDir: false,
            }),
          );
        },
      });
    } else if (action.id === 'copy-path' && trustedPath !== undefined) {
      const copyTarget = rawPath ?? trustedPath;
      entries.push({
        key: 'copy-path',
        label: t('file.copyPath'),
        run: () => copyTextToClipboard(copyTarget),
      });
      if (!isCopy && rawPath !== undefined && trustedPath !== rawPath) {
        entries.push({
          key: 'copy-absolute',
          label: t('file.copyAbsolutePath'),
          run: () => copyTextToClipboard(trustedPath),
        });
      } else {
        const relativePath = relativePathForMention(trustedPath, cwd);
        if (relativePath !== trustedPath && relativePath !== copyTarget) {
          entries.push({
            key: 'copy-relative',
            label: t('file.copyRelativePath'),
            run: () => copyTextToClipboard(relativePath),
          });
        }
      }
    } else if (action.id === 'show-on-this-computer' && trustedPath !== undefined && host.revealPath !== undefined) {
      hostEntries.push({
        key: 'show-in-folder',
        label: isCopy ? t('preview.showOnThisComputer') : t('file.showInFolder'),
        run: () => host.revealPath!(trustedPath),
      });
    } else if (action.id === 'open-with-default-app' && trustedPath !== undefined && host.openPath !== undefined) {
      hostEntries.push({
        key: 'open-default-app',
        label: isCopy ? t('preview.openOriginalFile') : t('file.openDefaultApp'),
        run: () => host.openPath!(trustedPath),
      });
    } else if (action.id === 'open-in-browser' && resource.source.kind === 'url') {
      const url = resource.source.url;
      entries.push({
        key: 'open-link',
        label: t('link.open'),
        run: () => openExternalUrl(host, url, t('common.popupBlocked')),
      });
    }
  }
  if (hostEntries.length > 0) {
    if (entries.length > 0) entries.push({ separator: true });
    entries.push(...hostEntries);
  }
  return entries;
}

export function useMediaRefMenu(item: MediaRef, label: string, sessionIdOverride?: string) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const localKikiComputer = isOnKikiComputer(connection);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const sessionId = sessionIdOverride ?? preview?.sessionId;
  const draftKey = useActiveDraftKey(sessionId);
  const resource = useMemo(
    () =>
      mediaRefResource(item, {
        sessionId,
        origin: item.origin,
        cwd: preview?.cwd,
        name: label,
      }),
    [item, sessionId, preview?.cwd, label],
  );
  const openItem = useCallback(() => {
    if (preview === null) return;
    if ((item.kind === 'image' || item.kind === 'video') && item.path !== undefined) preview.openAttachment(item);
    else if (item.path !== undefined) preview.openFile(item.path);
    else if (item.fileId !== undefined || item.url !== undefined) preview.openAttachment(item);
  }, [item, preview]);
  const canOpen = (item.path !== undefined || item.fileId !== undefined || item.url !== undefined) && preview !== null;
  const entries = useMemo(
    () =>
      buildResourceMenuEntries({
        resource,
        rawPath: item.path,
        cwd: preview?.cwd,
        sessionId,
        draftKey,
        localKikiComputer,
        host,
        client: connection?.client,
        t,
        onOpenPreview: canOpen ? openItem : undefined,
        onOpenCurrentFile: preview === null ? undefined : (targetPath) => { preview.openFile(targetPath); },
      }),
    [resource, item.path, preview, sessionId, draftKey, localKikiComputer, host, connection?.client, t, canOpen, openItem],
  );
  const openMenu = useCallback(
    (event: React.MouseEvent) => {
      if (entries.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY });
    },
    [entries.length],
  );
  const menuElement =
    menu === null || entries.length === 0 ? null : (
      <MiniContextMenu
        x={menu.x}
        y={menu.y}
        entries={entries}
        onClose={() => { setMenu(null); }}
        ariaLabel={label}
        overlayId="media-chip-menu"
        dataAttribute="data-file-link-menu"
      />
    );
  return { openItem, canOpen, openMenu, menuElement };
}

function FileChip({ item }: { item: MediaRef }) {
  const { t } = useI18n();
  const fallback = item.kind === 'image' ? t('media.image') : t('media.attachment');
  const label = attachmentName(item, undefined, fallback);
  const detail = item.size !== undefined ? formatBytes(item.size) : item.mime;
  const chipMenu = useMediaRefMenu(item, label);
  const openable = (item.path !== undefined || item.fileId !== undefined) && chipMenu.canOpen;
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
  if (!openable) {
    return (
      <>
        <span className={className} title={label} onContextMenu={chipMenu.openMenu}>
          {body}
        </span>
        {chipMenu.menuElement}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className={className}
        title={label}
        onClick={chipMenu.openItem}
        onContextMenu={chipMenu.openMenu}
      >
        {body}
      </button>
      {chipMenu.menuElement}
    </>
  );
}

/** Host media uses the same bounded source-preview and explicit-original UI. */
function HostMediaThumb({ item, size = 'default', onOpen, onStripFailure }: { item: MediaRef & { kind: 'image' | 'video'; path: string }; size?: MediaThumbSize; onOpen?: () => void; onStripFailure?: (kind: MediaFailureKind) => void }) {
  return <SessionMediaThumb item={item} size={size} onOpen={onOpen} onStripFailure={onStripFailure} />;
}

export type MediaThumbSize = 'default' | 'strip' | 'preview';
const THUMB_SIZE: Record<MediaThumbSize, { img: string; slot: string; frame: string }> = {
  default: { img: 'h-28 w-auto', slot: 'h-28 w-40', frame: 'rounded-lg' },
  strip: { img: 'h-9 w-auto max-w-[96px]', slot: 'h-9 w-12', frame: 'rounded-[5px]' },
  preview: { img: 'h-[120px] w-auto max-w-[240px]', slot: 'h-[120px] w-40', frame: 'rounded-lg' },
};
const LOADABLE_MEDIA_URL = /^(?:data:|blob:|https?:\/\/)/i;

function InlineUrlVideo({
  url,
  name,
  byteSize,
  size,
  attempt,
  onError,
}: {
  readonly url: string;
  readonly name: string;
  readonly byteSize?: number;
  readonly size: MediaThumbSize;
  readonly attempt: number;
  readonly onError: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const tokenRef = useRef<symbol | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);

  const releaseSlot = useCallback(() => {
    tokenRef.current = null;
    const release = releaseRef.current;
    releaseRef.current = null;
    release?.();
  }, []);

  useEffect(() => {
    releaseSlot();
    setArmed(false);
  }, [url, attempt, releaseSlot]);

  useEffect(() => () => {
    releaseSlot();
  }, [releaseSlot]);

  const handleArm = useCallback(() => {
    const token = Symbol('inline-video');
    releaseRef.current?.();
    tokenRef.current = token;
    releaseRef.current = activateInlineVideo(token, () => {
      if (tokenRef.current !== token) return;
      tokenRef.current = null;
      releaseRef.current = null;
      flushSync(() => {
        setArmed(false);
      });
    });
    setArmed(true);
  }, []);

  if (!armed) {
    const meta = byteSize !== undefined && byteSize > 0 ? formatBytes(byteSize) : undefined;
    return (
      <button
        type="button"
        data-inline-video-facade=""
        data-inline-video-url={url}
        title={name}
        aria-label={name}
        onClick={handleArm}
        className={`flex ${THUMB_SIZE[size].slot} flex-col items-center justify-center gap-1.5 ${THUMB_SIZE[size].frame} border border-hairline bg-panel px-2.5 text-[11px] text-ink-soft transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        <span aria-hidden className={`flex items-center justify-center rounded-full bg-ink/10 ${size === 'strip' ? 'h-5 w-5' : 'h-8 w-8'}`}>
          <span className={`ml-0.5 h-0 w-0 border-y-transparent border-l-ink ${size === 'strip' ? 'border-y-[3.5px] border-l-[6px]' : 'border-y-[5px] border-l-[8px]'}`} />
        </span>
        {size === 'strip' ? null : (
          <span className="max-w-full text-center">
            <span className="block max-w-full truncate font-mono text-[11px] text-ink">{name}</span>
            {meta !== undefined ? <span className="block font-mono text-[10px] text-ink-faint">{meta}</span> : null}
          </span>
        )}
      </button>
    );
  }

  return (
    <video
      ref={inlineMediaCleanupRef}
      key={attempt}
      src={url}
      controls
      autoPlay
      playsInline
      preload="none"
      onPlay={(event) => { notifyInlineMediaPlay(event.currentTarget); }}
      onEnded={(event) => { unregisterInlineMediaElement(event.currentTarget); }}
      onError={(event) => {
        unregisterInlineMediaElement(event.currentTarget);
        releaseSlot();
        onError();
      }}
      className="max-h-52 rounded-lg border border-hairline"
    />
  );
}

function UrlMediaPart({ item, size, onOpen, onStripFailure }: { item: MediaRef & { url: string }; size: MediaThumbSize; onOpen?: () => void; onStripFailure?: (kind: MediaFailureKind) => void }) {
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
  useEffect(() => {
    if (size === 'strip' && imageFailed) onStripFailure?.('decode');
  }, [size, imageFailed, onStripFailure]);
  const imageMenu = useMessageImageMenu(item, item.kind === 'image' && !imageFailed ? item.url : undefined, name);
  if (!LOADABLE_MEDIA_URL.test(item.url)) return <FileChip item={item} />;
  if (imageFailed && size === 'strip') return null;
  const body = imageFailed ? (
    <MediaLoadFailure
      name={name}
      decode
      failureKind="decode"
      size={size}
      title={item.path ?? item.origin?.path ?? name}
      onRetry={() => { setFailed(null); setAttempt((value) => value + 1); }}
      onContextMenu={imageMenu.openMenu}
    />
  )
    : !visible ? <span aria-busy="true" className={`${THUMB_SIZE[size].slot} ${THUMB_SIZE[size].frame}`} />
    : item.kind === 'video' ? <InlineUrlVideo url={item.url} name={name} byteSize={item.size} size={size} attempt={attempt} onError={() => { setFailed(source); }} />
    : <button type="button" onClick={() => { if (onOpen !== undefined) onOpen(); else preview?.openImage(item.url, downloadName); }} onContextMenu={imageMenu.openMenu} title={name} className={`block overflow-hidden ${THUMB_SIZE[size].frame} transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-selected-ink`}><img key={attempt} src={item.url} alt={name} referrerPolicy="no-referrer" decoding="async" onError={() => { setFailed(source); }} className={`${THUMB_SIZE[size].img} object-cover`} /></button>;
  return <span ref={hostRef} className="inline-flex">{body}{imageMenu.menuElement}</span>;
}

function DeferredMediaPart({ item, size, onStripFailure }: { item: MediaRef & { detail: NonNullable<MediaRef['detail']> }; size: MediaThumbSize; onStripFailure?: (kind: MediaFailureKind) => void }) {
  const { t } = useI18n();
  const detail = useTranscriptDetail({ agentId: item.detail.agentId, kind: 'attachment', id: item.detail.attachmentId });
  const name = attachmentName(item, undefined, item.kind === 'image' ? t('media.image') : t('media.attachment'));
  const client = useOptionalConnection()?.client;
  const preview = useMediaPreview();
  const [hostRef, visible] = useVisibleOnce();
  const target = useMemo(() => ({ client, sessionId: preview?.sessionId, agentId: item.detail.agentId, id: item.detail.attachmentId }), [client, preview?.sessionId, item.detail.agentId, item.detail.attachmentId]);
  const attempted = useRef<typeof target | undefined>(undefined);
  const status = detail.status?.status;
  const deferredFailureKind: MediaFailureKind | undefined =
    status === 'error' ? classifyMediaFailure(detail.status?.message, false, item.kind) : undefined;
  const isOmittedPlaceholder = item.kind === 'file' && item.mime === undefined && item.size === undefined &&
    (item.name === undefined || item.origin !== undefined);
  const autoHydrate = item.kind === 'image' || item.kind === 'video' || item.kind === 'audio' || isOmittedPlaceholder;
  useEffect(() => {
    if (!visible || !autoHydrate || detail.request === undefined || attempted.current === target || status === 'error') return;
    attempted.current = target;
    detail.request();
  }, [visible, autoHydrate, detail.request, target, status]);
  useEffect(() => {
    if (size === 'strip' && status === 'error' && deferredFailureKind !== undefined) {
      onStripFailure?.(deferredFailureKind);
    }
  }, [size, status, deferredFailureKind, onStripFailure]);
  if (detail.request === undefined) return <FileChip item={item} />;
  const label = status === 'loading' ? t('media.detail.loading', { name }) : status === 'error' ? t('media.detail.failed', { name }) : t('media.detail.open', { name });
  const meta = item.size !== undefined ? formatBytes(item.size) : item.mime;
  if (status === 'error') {
    if (size === 'strip') return null;
    return (
      <span ref={hostRef} className="inline-flex" data-media-deferred="error">
        <MediaLoadFailure
          name={name}
          decode={deferredFailureKind === 'decode'}
          failureKind={deferredFailureKind}
          size={size}
          title={item.path ?? item.origin?.path ?? name}
          onRetry={detail.request}
        />
      </span>
    );
  }
  if (size === 'strip') {
    const hydrating = status === 'loading' || (status === undefined && autoHydrate);
    return (
      <button
        type="button"
        ref={hostRef}
        data-media-deferred={status ?? 'idle'}
        aria-busy={hydrating || undefined}
        onClick={detail.request}
        disabled={status === 'loading'}
        aria-label={label}
        title={label}
        className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} ${
          hydrating
            ? 'animate-pulse bg-ink/[0.06] text-ink-faint motion-reduce:animate-none'
            : 'border border-hairline bg-ink/[0.03] text-ink-faint'
        } transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        {hydrating ? null : <Icon name="file" size={12} />}
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
      className={`flex ${THUMB_SIZE[size].slot} flex-col items-start justify-between gap-1 ${THUMB_SIZE[size].frame} border border-hairline bg-panel p-2 text-left transition-colors hover:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default motion-reduce:transition-none`}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5 text-ink-faint">
        <Icon name="file" size={14} />
        {meta !== undefined && meta !== '' ? <span className="truncate font-mono text-[11px]">{meta}</span> : null}
      </span>
      <span className="w-full min-w-0">
        <span className="block truncate font-mono text-[12px] text-ink" title={name}>{name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[12px] font-medium text-accent-ink">
          {status === 'loading' ? <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" /> : null}
          {status === 'loading' ? t('preview.loading') : t('media.detail.action')}
        </span>
      </span>
    </button>
  );
}

interface MediaPartProps {
  item: MediaRef;
  agentId?: string;
  size?: MediaThumbSize;
  galleryIndex?: number;
  onStripFailure?: (kind: MediaFailureKind) => void;
}

export function MediaPart(props: MediaPartProps) {
  const { item } = props;
  if (item.kind === 'image' && item.url !== undefined && item.detail === undefined && item.blobHash === undefined && item.fileId === undefined) {
    return <RemoteImageGate source={item.url} alt={item.name}><LoadedMediaPart {...props} /></RemoteImageGate>;
  }
  return <LoadedMediaPart {...props} />;
}

function LoadedMediaPart({ item, agentId, size = 'default', galleryIndex = 0, onStripFailure }: MediaPartProps) {
  const order = useMediaGalleryOrder();
  const openImage = useGalleryImage(item, galleryIndex, agentId);
  const hasLoadableMedia =
    item.blobHash !== undefined ||
    item.fileId !== undefined ||
    (item.url !== undefined && LOADABLE_MEDIA_URL.test(item.url));
  if (item.detail !== undefined && !hasLoadableMedia) {
    return <DeferredMediaPart item={{ ...item, detail: item.detail }} size={size} onStripFailure={onStripFailure} />;
  }
  if (item.blobHash !== undefined) {
    const savedItem = canonicalGalleryItem({ ...item, name: item.name ?? safeImagePreviewName({ path: item.path }) }, order?.agentId ?? agentId ?? 'main');
    return savedItem.kind === 'audio'
      ? <AudioPart item={savedItem} />
      : <SessionMediaThumb item={savedItem} size={size} onOpen={item.kind === 'image' ? openImage : undefined} onStripFailure={onStripFailure} />;
  }
  if (item.kind === 'image') {
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} onOpen={openImage} onStripFailure={onStripFailure} />;
    if (item.url !== undefined) return <UrlMediaPart item={{ ...item, url: item.url }} size={size} onOpen={openImage} onStripFailure={onStripFailure} />;
    if (item.path !== undefined) return <HostMediaThumb item={{ ...item, kind: 'image', path: item.path }} size={size} onOpen={openImage} onStripFailure={onStripFailure} />;
    return <FileChip item={item} />;
  }
  if (item.kind === 'audio') return <AudioPart item={item} />;
  if (item.kind === 'video') {
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} onStripFailure={onStripFailure} />;
    if (item.url !== undefined) return <UrlMediaPart item={{ ...item, url: item.url }} size={size} onStripFailure={onStripFailure} />;
    if (item.path !== undefined) return <HostMediaThumb item={{ ...item, kind: 'video', path: item.path }} size={size} onStripFailure={onStripFailure} />;
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

/**
 * Clickable host path; without a provider it degrades to plain text.
 * `children` replaces how the path reads (a one-line row passes `PathText`);
 * the link, its menu and its title still act on `path`.
 */
export function FilePathLink({
  path,
  line,
  column,
  heading,
  className,
  children,
}: {
  path: string;
  line?: number;
  column?: number;
  heading?: string;
  className?: string;
  children?: ReactNode;
}) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const localKikiComputer = isOnKikiComputer(connection);
  const draftKey = useActiveDraftKey(preview?.sessionId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (preview === null) return <span className={className}>{children ?? path}</span>;
  const filePath = resolveHostPath(path, preview.cwd);
  const target: string | FileReference =
    line !== undefined || column !== undefined || heading !== undefined
      ? { path: filePath, line, column, heading }
      : filePath;
  const openTarget = () => {
    preview.openFile(target);
  };
  const resource = hostFileResource(filePath, preview.cwd);
  const entries = buildResourceMenuEntries({
    resource,
    rawPath: path,
    cwd: preview.cwd,
    sessionId: preview.sessionId,
    draftKey,
    localKikiComputer,
    host,
    client: connection?.client,
    t,
    onOpenPreview: openTarget,
  });
  return (
    <>
      <span
        role="link"
        tabIndex={0}
        title={filePath}
        onClick={(event) => { event.stopPropagation(); openTarget(); }}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }); }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); openTarget(); } }}
        className={`cursor-pointer rounded-[2px] underline-offset-2 decoration-ink-faint hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${className ?? ''}`}
      >
        {children ?? path}
      </span>
      {menu !== null ? <MiniContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => { setMenu(null); }} ariaLabel={t('file.menuAria')} overlayId="file-path-link" dataAttribute="data-file-link-menu" /> : null}
    </>
  );
}
