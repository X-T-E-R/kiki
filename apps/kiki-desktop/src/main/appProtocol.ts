import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from 'pathe';
import { canonicalHomeKey } from '#/main/launchArgs';

export const KIKI_APP_SCHEME = 'kiki-app';
export const KIKI_APP_ORIGIN = 'kiki-app://localhost';

export const KIKI_APP_CSP =
  "default-src 'self' kiki-app:; " +
  "connect-src 'self' kiki-app: https: http: ws: wss: data: blob:; " +
  "img-src 'self' kiki-app: data: blob: https: http:; " +
  "media-src 'self' kiki-app: blob: data: https: http:; " +
  "font-src 'self' kiki-app: data:; " +
  "style-src 'self' kiki-app: 'unsafe-inline'; " +
  "script-src 'self' kiki-app:; " +
  "frame-src 'self' kiki-app: http://*.kiki-document.localhost:* https: http: blob:; " +
  "worker-src 'self' kiki-app: blob:";

const STATIC_ASSET_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.map',
  '.html',
  '.htm',
  '.json',
  '.webmanifest',
  '.wasm',
  '.txt',
  '.xml',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.woff2',
  '.woff',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.aac',
  '.mp4',
  '.webm',
  '.mov',
  '.pdf',
]);

function isRealPathInsideRoot(realRoot: string, realTarget: string): boolean {
  const rootKey = canonicalHomeKey(realRoot);
  const targetKey = canonicalHomeKey(realTarget);
  const rel = relative(rootKey, targetKey);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

function isStaticAssetPathname(decodedPath: string): boolean {
  if (decodedPath === '/assets' || decodedPath.startsWith('/assets/')) {
    return true;
  }
  const ext = extname(basename(decodedPath)).toLowerCase();
  return ext !== '' && STATIC_ASSET_EXTENSIONS.has(ext);
}

export async function resolveKikiAppAssetPath(
  webRootDir: string,
  requestUrl: string,
): Promise<
  | { readonly status: 200; readonly filePath: string; readonly size: number }
  | { readonly status: 400 | 403 | 404 }
> {
  const parsed = URL.parse(requestUrl);
  if (
    parsed === null ||
    parsed.protocol.toLowerCase() !== `${KIKI_APP_SCHEME}:` ||
    parsed.hostname.toLowerCase() !== 'localhost'
  ) {
    return { status: 400 };
  }

  const afterAuthority = requestUrl.replace(/^kiki-app:\/\/localhost(?::\d+)?/i, '');
  const rawPathname = afterAuthority.split(/[?#]/, 1)[0] || '/';
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname || '/');
  } catch {
    return { status: 400 };
  }

  if (
    rawPathname.includes('\\') ||
    /%5c/i.test(rawPathname) ||
    /(?:^|[/\\])(?:\.|%2e){2}(?:[/\\]|$)/i.test(rawPathname) ||
    decodedPath.includes('\0') ||
    decodedPath.includes('\\') ||
    decodedPath.split('/').includes('..')
  ) {
    return { status: 403 };
  }

  const normalizedRoot = resolve(webRootDir);
  const realRoot = await realpath(normalizedRoot).catch(() => null);
  if (realRoot === null) {
    return { status: 404 };
  }

  const candidate = resolve(
    normalizedRoot,
    `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`,
  );
  const rel = relative(normalizedRoot, candidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    return { status: 403 };
  }

  const candidateStat = await stat(candidate).catch(() => null);
  if (candidateStat !== null && candidateStat.isFile()) {
    const realCandidate = await realpath(candidate).catch(() => null);
    if (realCandidate === null || !isRealPathInsideRoot(realRoot, realCandidate)) {
      return { status: 403 };
    }
    return { status: 200, filePath: normalize(realCandidate), size: candidateStat.size };
  }

  if (!isStaticAssetPathname(decodedPath)) {
    const indexHtml = join(normalizedRoot, 'index.html');
    const indexStat = await stat(indexHtml).catch(() => null);
    if (indexStat !== null && indexStat.isFile()) {
      const realIndex = await realpath(indexHtml).catch(() => null);
      if (realIndex === null || !isRealPathInsideRoot(realRoot, realIndex)) {
        return { status: 403 };
      }
      return { status: 200, filePath: normalize(realIndex), size: indexStat.size };
    }
  }

  return { status: 404 };
}

function parseSingleByteRange(
  rangeHeader: string,
  totalSize: number,
): { readonly start: number; readonly end: number } | null {
  const trimmed = rangeHeader.trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (match === null || totalSize <= 0) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const start = Math.max(0, totalSize - suffixLength);
    return { start, end: totalSize - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) return null;
  if (rawEnd === '') {
    return { start, end: totalSize - 1 };
  }

  const parsedEnd = Number.parseInt(rawEnd, 10);
  if (!Number.isSafeInteger(parsedEnd) || parsedEnd < start) return null;
  return { start, end: Math.min(parsedEnd, totalSize - 1) };
}

function explicitMimeOverride(filePath: string): string | null {
  switch (extname(filePath).toLowerCase()) {
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.mjs':
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.wasm':
      return 'application/wasm';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    default:
      return null;
  }
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

    const ext = extname(resolved.filePath).toLowerCase();
    const isHtml = ext === '.html' || ext === '.htm';
    const rangeHeader = request.headers.get('range');

    if (rangeHeader !== null) {
      const range = parseSingleByteRange(rangeHeader, resolved.size);
      if (range === null) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes */${resolved.size}`,
          },
        });
      }
      const probe = await fetchFile(pathToFileURL(resolved.filePath).toString(), {
        method: 'HEAD',
      }).catch(() => null);
      const headers = new Headers(probe?.headers);
      const mimeOverride = explicitMimeOverride(resolved.filePath);
      if (mimeOverride !== null) {
        headers.set('Content-Type', mimeOverride);
      }
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${resolved.size}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
      if (isHtml) {
        headers.set('Content-Security-Policy', KIKI_APP_CSP);
      }
      const body =
        request.method === 'HEAD'
          ? null
          : (Readable.toWeb(
              createReadStream(resolved.filePath, { start: range.start, end: range.end }),
            ) as unknown as BodyInit);
      return new Response(body, {
        status: 206,
        headers,
      });
    }

    const upstream = await fetchFile(pathToFileURL(resolved.filePath).toString(), {
      method: request.method,
    });
    const headers = new Headers(upstream.headers);
    const mimeOverride = explicitMimeOverride(resolved.filePath);
    if (
      mimeOverride !== null &&
      (ext === '.woff2' ||
        !headers.has('Content-Type') ||
        headers.get('Content-Type') === 'application/octet-stream')
    ) {
      headers.set('Content-Type', mimeOverride);
    }
    headers.set('Accept-Ranges', 'bytes');
    if (isHtml) {
      headers.set('Content-Security-Policy', KIKI_APP_CSP);
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  };
}
