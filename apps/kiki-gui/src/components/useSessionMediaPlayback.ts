import { useEffect, useRef, useState } from 'react';
import type { MediaRef } from '@kiki/session-core/composer/media';

import type { KikiClient } from '../lib/client';

export type PlaybackLoad =
  | { readonly status: 'fallback' | 'loading' | 'failed' }
  | { readonly status: 'ready'; readonly url: string; readonly mime: string; readonly fail: () => void };

export type HostMediaPreviewLoad =
  | { readonly status: 'idle' | 'loading' | 'fallback' }
  | { readonly status: 'ready'; readonly url: string };

let remoteMediaPlaybackOverride: boolean | null = null;

/** Override whether remote connections attempt Range playback grants (`null` restores `VITE_KIKI_REMOTE_MEDIA_PLAYBACK`). */
export function configureRemoteMediaPlayback(enabled: boolean | null): void {
  remoteMediaPlaybackOverride = enabled;
}

function isRemoteMediaPlaybackEnabled(): boolean {
  if (remoteMediaPlaybackOverride !== null) return remoteMediaPlaybackOverride;
  const env = (import.meta as { readonly env?: Readonly<Record<string, unknown>> }).env;
  const raw = env?.['VITE_KIKI_REMOTE_MEDIA_PLAYBACK'];
  if (typeof raw !== 'string') return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0') return false;
  return true;
}

function unsupportedPlayback(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, reason, message } = error as { code?: number; reason?: string; message?: string };
  return code === 404 || code === 405 || code === 501 || reason === 'media_preview_requires_local_connection'
    || (code === 40301 && message === 'media_preview_requires_local_connection');
}

interface CachedPlaybackEntry {
  readonly key: string;
  readonly client: KikiClient;
  readonly sessionId: string;
  readonly fileId: string;
  status: 'loading' | 'ready' | 'fallback' | 'failed';
  previewId?: string;
  url?: string;
  mime?: string;
  expiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  released: boolean;
  /** Attempt nonce that produced a terminal failure; a higher `attempt` triggers a fresh mint. */
  failedAtAttempt?: number;
  readonly listeners: Set<() => void>;
}

let playbackCacheByClient = new WeakMap<KikiClient, Map<string, CachedPlaybackEntry>>();

/** Reset all cached playback and host-preview grants (for test isolation). */
export function clearSessionMediaPlaybackCache(): void {
  playbackCacheByClient = new WeakMap();
  hostPreviewCacheByClient = new WeakMap();
}

function clientPlaybackMap(client: KikiClient): Map<string, CachedPlaybackEntry> {
  let map = playbackCacheByClient.get(client);
  if (map === undefined) {
    map = new Map();
    playbackCacheByClient.set(client, map);
  }
  return map;
}

function playbackCacheKey(sessionId: string, fileId: string): string {
  return `${sessionId}\0${fileId}`;
}

function notifyEntry(entry: CachedPlaybackEntry): void {
  for (const listener of Array.from(entry.listeners)) listener();
}

function releaseGrant(entry: CachedPlaybackEntry): void {
  if (entry.expiryTimer !== undefined) {
    clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
  }
  if (entry.previewId === undefined || entry.released) return;
  entry.released = true;
  const previewId = entry.previewId;
  const sessions = entry.client.klient.rest?.sessions;
  if (sessions !== undefined && typeof sessions.closeMediaPlayback === 'function') {
    void sessions.closeMediaPlayback(previewId, { timeoutMs: 10_000 }).catch(() => {});
  }
}

function failEntry(entry: CachedPlaybackEntry, attempt: number): void {
  releaseGrant(entry);
  entry.status = 'failed';
  entry.url = undefined;
  entry.mime = undefined;
  entry.expiresAt = undefined;
  entry.failedAtAttempt = attempt;
  notifyEntry(entry);
}

function isEntryUsableReady(entry: CachedPlaybackEntry | undefined): entry is CachedPlaybackEntry & {
  readonly status: 'ready';
  readonly url: string;
  readonly mime: string;
} {
  return entry !== undefined
    && entry.status === 'ready'
    && entry.url !== undefined
    && entry.mime !== undefined
    && (entry.expiresAt === undefined || entry.expiresAt > Date.now());
}

function startPlaybackMint(
  client: KikiClient,
  sessionId: string,
  fileId: string,
  attempt: number,
): CachedPlaybackEntry {
  const map = clientPlaybackMap(client);
  const key = playbackCacheKey(sessionId, fileId);
  const existing = map.get(key);
  if (existing !== undefined) {
    if (isEntryUsableReady(existing)) return existing;
    if (existing.status === 'loading') return existing;
    if (existing.status === 'fallback') return existing;
    if (existing.status === 'failed' && existing.failedAtAttempt === attempt) return existing;
    releaseGrant(existing);
  }

  const sessions = client.klient.rest?.sessions;
  const entry: CachedPlaybackEntry = {
    key,
    client,
    sessionId,
    fileId,
    status: 'loading',
    released: false,
    listeners: existing?.listeners ?? new Set(),
  };
  map.set(key, entry);

  if (sessions === undefined || typeof sessions.openMediaPlayback !== 'function') {
    entry.status = 'fallback';
    notifyEntry(entry);
    return entry;
  }

  const controller = new AbortController();
  const pending = sessions.openMediaPlayback(sessionId, fileId, { signal: controller.signal, timeoutMs: 15_000 });
  if (pending === undefined || typeof pending.then !== 'function') {
    entry.status = 'fallback';
    notifyEntry(entry);
    return entry;
  }

  void pending.then((grant) => {
    if (map.get(key) !== entry) {
      if (typeof sessions.closeMediaPlayback === 'function') {
        void sessions.closeMediaPlayback(grant.preview_id, { timeoutMs: 10_000 }).catch(() => {});
      }
      return;
    }
    entry.previewId = grant.preview_id;
    const remaining = grant.expires_at - Date.now();
    if (remaining <= 0) {
      failEntry(entry, attempt);
      return;
    }
    const base = client.baseUrl || globalThis.location.origin;
    entry.url = new URL(grant.url, `${base.replace(/\/+$/u, '')}/`).toString();
    entry.mime = grant.mime;
    entry.expiresAt = grant.expires_at;
    entry.status = 'ready';
    entry.expiryTimer = setTimeout(() => {
      if (map.get(key) === entry) {
        map.delete(key);
        failEntry(entry, attempt);
      }
    }, remaining);
    notifyEntry(entry);
  }).catch((error: unknown) => {
    if (map.get(key) !== entry) return;
    releaseGrant(entry);
    entry.status = unsupportedPlayback(error) ? 'fallback' : 'failed';
    if (entry.status === 'failed') entry.failedAtAttempt = attempt;
    notifyEntry(entry);
  });

  return entry;
}

/** Evict and revoke all cached playback grants for a session (or all sessions on a client). */
export function evictSessionMediaPlayback(client: KikiClient | undefined, sessionId?: string): void {
  if (client === undefined) return;
  const map = playbackCacheByClient.get(client);
  if (map === undefined) return;
  for (const [key, entry] of Array.from(map.entries())) {
    if (sessionId === undefined || entry.sessionId === sessionId) {
      map.delete(key);
      releaseGrant(entry);
    }
  }
}

function snapshotEntry(entry: CachedPlaybackEntry | undefined, attempt: number): PlaybackLoad {
  if (entry === undefined) return { status: 'loading' };
  if (isEntryUsableReady(entry)) {
    return {
      status: 'ready',
      url: entry.url,
      mime: entry.mime,
      fail: () => { failEntry(entry, attempt); },
    };
  }
  if (entry.status === 'fallback') return { status: 'fallback' };
  if (entry.status === 'failed' && entry.failedAtAttempt === attempt) return { status: 'failed' };
  return { status: 'loading' };
}

/**
 * Shared client/session-scoped playback grant hook.
 *
 * Grants are cached by `(client, sessionId, fileId)` so scrolling a virtualized
 * audio row or opening an audio attachment in `AttachmentTabView` reuses the
 * active grant in 0ms without flashing a loading skeleton or firing a duplicate
 * `POST /api/sessions/:id/media-playback`. Grants remain live until TTL expiry,
 * explicit playback error (`fail`), or `evictSessionMediaPlayback`.
 */
export function useSessionMediaPlayback(
  item: MediaRef,
  sessionId: string | undefined,
  client: KikiClient | undefined,
  remote: boolean,
  attempt: number,
): PlaybackLoad {
  const remoteBlocked = remote && !isRemoteMediaPlaybackEnabled();
  const eligible = item.path === undefined && item.fileId !== undefined && sessionId !== undefined
    && (item.kind === 'video' || item.kind === 'audio' || /^(?:video|audio)\//i.test(item.mime ?? ''));
  const fileId = item.fileId;
  const activeEntryRef = useRef<CachedPlaybackEntry | undefined>(undefined);
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!eligible || remoteBlocked || client === undefined || sessionId === undefined || fileId === undefined) {
      activeEntryRef.current = undefined;
      return;
    }
    const entry = startPlaybackMint(client, sessionId, fileId, attempt);
    activeEntryRef.current = entry;
    const bump = () => { setVersion((v) => v + 1); };
    entry.listeners.add(bump);
    // Sync once immediately in case mint settled synchronously or before subscribe.
    bump();
    return () => {
      entry.listeners.delete(bump);
    };
  }, [eligible, remoteBlocked, client, sessionId, fileId, attempt]);

  if (!eligible || remoteBlocked || sessionId === undefined || fileId === undefined) {
    return { status: 'fallback' };
  }
  if (client === undefined) {
    return { status: 'loading' };
  }
  const key = playbackCacheKey(sessionId, fileId);
  const cached = playbackCacheByClient.get(client)?.get(key)
    ?? (activeEntryRef.current?.key === key && activeEntryRef.current.client === client
      ? activeEntryRef.current
      : undefined);
  return snapshotEntry(cached, attempt);
}

// ---- Shared host-media preview cache (local Kiki computer paths) ----

interface CachedHostPreviewEntry {
  readonly path: string;
  readonly client: KikiClient;
  status: 'loading' | 'ready' | 'fallback';
  previewId?: string;
  url?: string;
  expiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  released: boolean;
  failedAtAttempt?: number;
  readonly listeners: Set<() => void>;
}

let hostPreviewCacheByClient = new WeakMap<KikiClient, Map<string, CachedHostPreviewEntry>>();

function clientHostPreviewMap(client: KikiClient): Map<string, CachedHostPreviewEntry> {
  let map = hostPreviewCacheByClient.get(client);
  if (map === undefined) {
    map = new Map();
    hostPreviewCacheByClient.set(client, map);
  }
  return map;
}

function releaseHostPreview(entry: CachedHostPreviewEntry): void {
  if (entry.expiryTimer !== undefined) {
    clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
  }
  if (entry.previewId === undefined || entry.released) return;
  entry.released = true;
  if (typeof entry.client.closeHostMediaPreview === 'function') {
    void entry.client.closeHostMediaPreview(entry.previewId).catch(() => {});
  }
}

function isHostPreviewReady(entry: CachedHostPreviewEntry | undefined): entry is CachedHostPreviewEntry & {
  readonly status: 'ready';
  readonly url: string;
} {
  return entry !== undefined
    && entry.status === 'ready'
    && entry.url !== undefined
    && (entry.expiresAt === undefined || entry.expiresAt > Date.now());
}

/**
 * Shared client-scoped host media preview hook (`openHostMediaPreview`),
 * gated strictly on `enabled` (e.g. row visibility) and cached across remounts
 * so audio rows never flash back to a skeleton on scroll or preview open.
 */
export function useHostMediaPreview(
  client: KikiClient | undefined,
  hostPath: string | undefined,
  enabled: boolean,
  attempt: number,
): HostMediaPreviewLoad {
  const [, setVersion] = useState(0);
  const canOpen =
    enabled
    && client !== undefined
    && hostPath !== undefined
    && typeof client.openHostMediaPreview === 'function';

  useEffect(() => {
    if (!canOpen || client === undefined || hostPath === undefined) return;
    const map = clientHostPreviewMap(client);
    let entry = map.get(hostPath);
    const bump = () => { setVersion((v) => v + 1); };
    if (entry === undefined || (!isHostPreviewReady(entry) && entry.status !== 'loading' && entry.failedAtAttempt !== attempt)) {
      if (entry !== undefined) releaseHostPreview(entry);
      const next: CachedHostPreviewEntry = {
        path: hostPath,
        client,
        status: 'loading',
        released: false,
        listeners: entry?.listeners ?? new Set(),
      };
      map.set(hostPath, next);
      entry = next;
      const controller = new AbortController();
      void client.openHostMediaPreview({ path: hostPath }, { signal: controller.signal }).then((opened) => {
        if (map.get(hostPath) !== next) {
          void client.closeHostMediaPreview(opened.preview_id).catch(() => {});
          return;
        }
        next.previewId = opened.preview_id;
        next.url = opened.url;
        next.expiresAt = opened.expires_at;
        next.status = 'ready';
        const remaining = opened.expires_at - Date.now();
        if (remaining > 0) {
          next.expiryTimer = setTimeout(() => {
            if (map.get(hostPath) === next) {
              releaseHostPreview(next);
              map.delete(hostPath);
              for (const listener of Array.from(next.listeners)) listener();
            }
          }, remaining);
        }
        for (const listener of Array.from(next.listeners)) listener();
      }).catch(() => {
        if (map.get(hostPath) !== next) return;
        next.status = 'fallback';
        next.failedAtAttempt = attempt;
        for (const listener of Array.from(next.listeners)) listener();
      });
    }
    entry.listeners.add(bump);
    bump();
    return () => {
      entry?.listeners.delete(bump);
    };
  }, [canOpen, client, hostPath, attempt]);

  if (!enabled) return { status: 'idle' };
  if (!canOpen || client === undefined || hostPath === undefined) return { status: 'fallback' };
  const cached = hostPreviewCacheByClient.get(client)?.get(hostPath);
  if (isHostPreviewReady(cached)) return { status: 'ready', url: cached.url };
  if (cached?.status === 'fallback' && cached.failedAtAttempt === attempt) return { status: 'fallback' };
  return { status: 'loading' };
}
