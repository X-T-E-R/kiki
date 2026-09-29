/**
 * Appearance-pack and background-import calls against the connected server.
 *
 * Direct `fetch` rather than the klient facade, in the same shape as the
 * client's memory routes: these routes move binary bodies (zip in, media and
 * zip out), and a media element cannot send the bearer header, so every file
 * is fetched here and handed to the backdrop as a blob.
 */

import type {
  GetAppearancePackResponse,
  InstallAppearancePackResponse,
  ListAppearancePacksResponse,
} from '@kiki/protocol';

export interface ServerEndpoint {
  /** Server base URL; '' means same origin. */
  readonly url: string;
  readonly token: string;
}

export class AppearanceApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function urlOf(endpoint: ServerEndpoint, path: string): string {
  const root = endpoint.url.trim().replace(/\/+$/u, '');
  return `${root}/api${path}`;
}

function headersOf(endpoint: ServerEndpoint, extra: Record<string, string> = {}): Record<string, string> {
  return endpoint.token === '' ? extra : { ...extra, authorization: `Bearer ${endpoint.token}` };
}

async function envelope<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AppearanceApiError(response.status, `HTTP ${response.status}`);
  }
  const shape = body as { code?: unknown; msg?: unknown; data?: unknown };
  if (typeof shape.code !== 'number') throw new AppearanceApiError(response.status, `HTTP ${response.status}`);
  if (shape.code !== 0) throw new AppearanceApiError(shape.code, typeof shape.msg === 'string' ? shape.msg : 'request failed');
  return shape.data as T;
}

/** Undefined when the server predates the appearance routes. */
export async function listAppearancePacks(endpoint: ServerEndpoint): Promise<ListAppearancePacksResponse | undefined> {
  const response = await fetch(urlOf(endpoint, '/appearance/packs'), { headers: headersOf(endpoint) });
  if (response.status === 404) return undefined;
  return envelope<ListAppearancePacksResponse>(response);
}

export async function getAppearancePack(endpoint: ServerEndpoint, id: string): Promise<GetAppearancePackResponse> {
  return envelope(await fetch(urlOf(endpoint, `/appearance/packs/${encodeURIComponent(id)}`), { headers: headersOf(endpoint) }));
}

export async function fetchPackFile(endpoint: ServerEndpoint, id: string, file: string): Promise<Blob | null> {
  const response = await fetch(urlOf(endpoint, `/appearance/packs/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`), {
    headers: headersOf(endpoint),
  });
  return response.ok ? response.blob() : null;
}

export async function installAppearancePack(endpoint: ServerEndpoint, zip: Blob, replace: boolean): Promise<InstallAppearancePackResponse> {
  const response = await fetch(urlOf(endpoint, `/appearance/packs${replace ? '?replace=true' : ''}`), {
    method: 'POST',
    headers: headersOf(endpoint, { 'content-type': 'application/zip' }),
    body: zip,
  });
  return envelope(response);
}

export async function deleteAppearancePack(endpoint: ServerEndpoint, id: string): Promise<void> {
  await envelope(await fetch(urlOf(endpoint, `/appearance/packs/${encodeURIComponent(id)}`), { method: 'DELETE', headers: headersOf(endpoint) }));
}

export async function exportAppearancePack(endpoint: ServerEndpoint, id: string): Promise<Blob> {
  const response = await fetch(urlOf(endpoint, `/appearance/packs/${encodeURIComponent(id)}/export`), { headers: headersOf(endpoint) });
  if (!response.ok || response.headers.get('content-type') !== 'application/zip') return Promise.reject(await envelope(response).catch((error: unknown) => error));
  return response.blob();
}

/** Import a remote picture or video through the server's media policy. */
export async function importBackgroundUrl(endpoint: ServerEndpoint, url: string): Promise<{ blob: Blob; name: string }> {
  const response = await fetch(urlOf(endpoint, '/appearance/fetch'), {
    method: 'POST',
    headers: headersOf(endpoint, { 'content-type': 'application/json' }),
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(90_000),
  });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || type.includes('json')) {
    if (response.status === 404 && !type.includes('json')) throw new AppearanceApiError(404, 'unsupported');
    await envelope(response);
    throw new AppearanceApiError(response.status, 'import failed');
  }
  const raw = response.headers.get('x-kiki-media-name');
  let name = 'background';
  try {
    name = raw === null ? name : decodeURIComponent(raw);
  } catch {
    // keep the default name
  }
  return { blob: await response.blob(), name };
}
