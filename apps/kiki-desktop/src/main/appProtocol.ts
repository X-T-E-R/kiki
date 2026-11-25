import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { basename, extname, isAbsolute, join, relative, resolve } from 'pathe';

export const KIKI_APP_SCHEME = 'kiki-app';
export const KIKI_APP_ORIGIN = 'kiki-app://localhost';

export async function resolveKikiAppAssetPath(
  webRootDir: string,
  requestUrl: string,
): Promise<{ readonly status: 200; readonly filePath: string } | { readonly status: 400 | 403 | 404 }> {
  const parsed = URL.parse(requestUrl);
  if (
    parsed === null ||
    parsed.protocol.toLowerCase() !== `${KIKI_APP_SCHEME}:` ||
    parsed.hostname.toLowerCase() !== 'localhost'
  ) {
    return { status: 400 };
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname || '/');
  } catch {
    return { status: 400 };
  }
  if (
    decodedPath.includes('\0') ||
    decodedPath.includes('\\') ||
    /(?:^|[/\\])(?:\.|%2e){2}(?:[/\\?#]|$)/i.test(requestUrl) ||
    decodedPath.split('/').includes('..')
  ) {
    return { status: 403 };
  }

  const normalizedRoot = resolve(webRootDir);
  const candidate = resolve(normalizedRoot, `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`);
  const rel = relative(normalizedRoot, candidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    return { status: 403 };
  }

  const candidateStat = await stat(candidate).catch(() => null);
  if (candidateStat !== null && candidateStat.isFile()) {
    return { status: 200, filePath: candidate };
  }

  const leafName = basename(decodedPath);
  if (extname(leafName) === '') {
    const indexHtml = join(normalizedRoot, 'index.html');
    const indexStat = await stat(indexHtml).catch(() => null);
    if (indexStat !== null && indexStat.isFile()) {
      return { status: 200, filePath: indexHtml };
    }
  }

  return { status: 404 };
}

export function createKikiAppProtocolHandler(
  webRootDir: string,
  fetchFile: (fileUrl: string, init?: RequestInit) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const resolved = await resolveKikiAppAssetPath(webRootDir, request.url);
    if (resolved.status !== 200) {
      return new Response(resolved.status === 403 ? 'Forbidden' : 'Not Found', {
        status: resolved.status,
      });
    }
    const fileUrl = pathToFileURL(resolved.filePath).toString();
    return fetchFile(fileUrl, {
      method: request.method,
      headers: request.headers,
    });
  };
}
