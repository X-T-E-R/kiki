import { useEffect, useMemo, useState } from 'react';
import type { MediaRef } from '@kiki/session-core/composer/media';

import type { KikiClient } from '../lib/client';

type PlaybackLoad =
  | { readonly status: 'fallback' | 'loading' | 'failed' }
  | { readonly status: 'ready'; readonly url: string; readonly mime: string; readonly fail: () => void };

let remoteMediaPlaybackOverride: boolean | null = null;

/** Override whether remote connections attempt Range playback grants (`null` restores `VITE_KIKI_REMOTE_MEDIA_PLAYBACK`). */
export function configureRemoteMediaPlayback(enabled: boolean | null): void {
  remoteMediaPlaybackOverride = enabled;
}

function isRemoteMediaPlaybackEnabled(): boolean {
  if (remoteMediaPlaybackOverride !== null) return remoteMediaPlaybackOverride;
  const env = (import.meta as { readonly env?: Readonly<Record<string, unknown>> }).env;
  const raw = env?.['VITE_KIKI_REMOTE_MEDIA_PLAYBACK'];
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function unsupportedPlayback(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, reason, message } = error as { code?: number; reason?: string; message?: string };
  return code === 404 || code === 405 || code === 501 || reason === 'media_preview_requires_local_connection'
    || (code === 40301 && message === 'media_preview_requires_local_connection');
}

/**
 * Owns one canonical session playback grant through its minting client. Remote
 * connections use Range playback grants when `VITE_KIKI_REMOTE_MEDIA_PLAYBACK`
 * is enabled (falling back cleanly if the server declines with 40301/404);
 * otherwise remote connections and unsupported routes retain the existing
 * authenticated byte read. Teardown observes a pending mint for at most its
 * 15-second request deadline, then revokes any late grant through that same client.
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
  const source = useMemo(() => ({ client, sessionId, fileId: item.fileId, eligible, remoteBlocked, attempt }),
    [client, sessionId, item.fileId, eligible, remoteBlocked, attempt]);
  const initial: PlaybackLoad = !eligible || remoteBlocked ? { status: 'fallback' } : { status: 'loading' };
  const [loaded, setLoaded] = useState<{ source: typeof source; load: PlaybackLoad }>({ source, load: initial });

  useEffect(() => {
    if (!eligible || remoteBlocked) { setLoaded({ source, load: { status: 'fallback' } }); return; }
    if (client === undefined) return;
    const sessions = client.klient.rest?.sessions;
    if (sessions === undefined) { setLoaded({ source, load: { status: 'fallback' } }); return; }
    let active = true;
    let previewId: string | undefined;
    let released = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const release = () => {
      if (previewId === undefined || released) return;
      released = true;
      void sessions.closeMediaPlayback(previewId, { timeoutMs: 10_000 }).catch(() => {});
    };
    const fail = () => {
      if (!active) return;
      if (expiry !== undefined) clearTimeout(expiry);
      release();
      setLoaded({ source, load: { status: 'failed' } });
    };
    setLoaded({ source, load: { status: 'loading' } });
    const pending = sessions.openMediaPlayback(sessionId!, item.fileId!, { signal: controller.signal, timeoutMs: 15_000 });
    if (pending === undefined || typeof pending.then !== 'function') {
      setLoaded({ source, load: { status: 'fallback' } });
      return;
    }
    void pending.then((grant) => {
      previewId = grant.preview_id;
      if (!active) { release(); return; }
      const remaining = grant.expires_at - Date.now();
      if (remaining <= 0) { fail(); return; }
      const base = client.baseUrl || globalThis.location.origin;
      const url = new URL(grant.url, `${base.replace(/\/+$/u, '')}/`).toString();
      expiry = setTimeout(fail, remaining);
      setLoaded({ source, load: { status: 'ready', url, mime: grant.mime, fail } });
    }).catch((error: unknown) => {
      release();
      if (active) setLoaded({ source, load: { status: unsupportedPlayback(error) ? 'fallback' : 'failed' } });
    });
    return () => {
      active = false;
      if (expiry !== undefined) clearTimeout(expiry);
      release();
      // Keep a pending mint observable until its bounded deadline so a late grant
      // is revoked through the client that created it, rather than losing its ID.
      if (previewId !== undefined) controller.abort();
    };
  }, [source, eligible, remoteBlocked, client, sessionId, item.fileId]);

  return loaded.source === source ? loaded.load : initial;
}
