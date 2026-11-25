import type { MetaResponse, Session } from '@kiki/protocol';

interface PrefetchedMeta {
  readonly endpoint: string;
  readonly token: string;
  readonly promise: Promise<MetaResponse | null>;
}

interface PrefetchedSession {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly promise: Promise<Session | null>;
}

let pending: PrefetchedMeta | null = null;
let pendingSession: PrefetchedSession | null = null;

function deepLinkSessionId(pathname: string): string | null {
  const match = /^\/s\/([^/?#]+)$/.exec(pathname);
  if (match === null) return null;
  try {
    const decoded = decodeURIComponent(match[1]!);
    return decoded.trim() === '' ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Start `/api/meta` and `/api/sessions/:id` during early boot when the URL
 * already carries a deep-link token (`?token=...`), so `ConnectionProvider`
 * and `SessionView` adopt warm responses without waiting for serial round-trips
 * after the app bundle finishes loading.
 */
export function prefetchDeepLinkMeta(): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token')?.trim() ?? '';
  if (token === '') return;
  const explicitServer = (params.get('server') ?? params.get('url') ?? '').trim().replace(/\/+$/u, '');
  if (explicitServer !== '' && !/^https?:\/\//iu.test(explicitServer)) return;
  const endpoint = explicitServer;
  const url = endpoint === '' ? '/api/meta' : `${endpoint}/api/meta`;
  const headers = { Authorization: `Bearer ${token}` };
  const promise = fetch(url, {
    headers,
    credentials: 'same-origin',
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { readonly code?: number; readonly data?: MetaResponse };
      return body.code === 0 && body.data !== undefined ? body.data : null;
    })
    .catch(() => null);
  pending = { endpoint, token, promise };

  const sessionId = deepLinkSessionId(window.location.pathname);
  if (sessionId !== null) {
    const sessionUrl = `${endpoint}/api/sessions/${encodeURIComponent(sessionId)}`;
    const sessionPromise = fetch(sessionUrl, {
      headers,
      credentials: 'same-origin',
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { readonly code?: number; readonly data?: Session };
        return body.code === 0 && body.data !== undefined ? body.data : null;
      })
      .catch(() => null);
    pendingSession = { endpoint, sessionId, promise: sessionPromise };
  }
}

export function takePrefetchedMeta(endpoint: string, token: string): Promise<MetaResponse | null> | null {
  if (pending === null) return null;
  const normalized = endpoint.trim().replace(/\/+$/u, '');
  if (pending.endpoint !== normalized || pending.token !== token) return null;
  const match = pending.promise;
  pending = null;
  return match;
}

export function takePrefetchedSession(endpoint: string, sessionId: string): Promise<Session | null> | null {
  if (pendingSession === null) return null;
  const normalized = endpoint.trim().replace(/\/+$/u, '');
  if (pendingSession.endpoint !== normalized || pendingSession.sessionId !== sessionId) return null;
  const match = pendingSession.promise;
  pendingSession = null;
  return match;
}
