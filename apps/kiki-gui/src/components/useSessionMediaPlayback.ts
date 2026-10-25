import { useEffect, useMemo, useState } from 'react';
import type { MediaRef } from '@kiki/session-core/composer/media';

import type { KikiClient } from '../lib/client';

type PlaybackLoad =
  | { readonly status: 'fallback' | 'loading' | 'failed' }
  | { readonly status: 'ready'; readonly url: string; readonly mime: string; readonly fail: () => void };

function unsupportedPlayback(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, reason, message } = error as { code?: number; reason?: string; message?: string };
  return code === 404 || code === 405 || code === 501 || reason === 'media_preview_requires_local_connection'
    || (code === 40301 && message === 'media_preview_requires_local_connection');
}

/**
 * Owns one canonical session playback grant through its minting client. Remote
 * connections and unsupported routes retain the existing authenticated byte read;
 * other failures require retry. Teardown observes a pending mint for at most its
 * 15-second request deadline, then revokes any late grant through that same client.
 */
export function useSessionMediaPlayback(
  item: MediaRef,
  sessionId: string | undefined,
  client: KikiClient | undefined,
  remote: boolean,
  attempt: number,
): PlaybackLoad {
  const eligible = item.path === undefined && item.fileId !== undefined && sessionId !== undefined
    && (item.kind === 'video' || /^(?:video|audio)\//i.test(item.mime ?? ''));
  const source = useMemo(() => ({ client, sessionId, fileId: item.fileId, eligible, remote, attempt }),
    [client, sessionId, item.fileId, eligible, remote, attempt]);
  const initial: PlaybackLoad = !eligible || remote ? { status: 'fallback' } : { status: 'loading' };
  const [loaded, setLoaded] = useState<{ source: typeof source; load: PlaybackLoad }>({ source, load: initial });

  useEffect(() => {
    if (!eligible || remote) { setLoaded({ source, load: { status: 'fallback' } }); return; }
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
    void sessions.openMediaPlayback(sessionId!, item.fileId!, { signal: controller.signal, timeoutMs: 15_000 }).then((grant) => {
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
  }, [source, eligible, remote, client, sessionId, item.fileId]);

  return loaded.source === source ? loaded.load : initial;
}
