import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { constants as zlibConstants, createBrotliCompress, createGzip } from 'node:zlib';

import type { FastifyReply, FastifyRequest } from 'fastify';

const PRECOMPRESSIBLE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.wasm']);

interface WebAssetRouteHost {
  get(
    path: string,
    options: { config: { webGui: true } },
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ): unknown;
}

export async function registerWebAssetRoutes(
  app: WebAssetRouteHost,
  assetsDir: string,
): Promise<void> {
  await assertWebAssets(assetsDir);

  const options = { config: { webGui: true as const } };
  app.get('/', options, async (req, reply) => serveWebAsset(req, reply, assetsDir));
  app.get('/*', options, async (req, reply) => serveWebAsset(req, reply, assetsDir));
}

async function assertWebAssets(assetsDir: string): Promise<void> {
  try {
    const info = await stat(join(assetsDir, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Kiki web assets were not found at ${assetsDir}. Run the package build before starting the server.`,
    );
  }
}

async function serveWebAsset(
  req: FastifyRequest,
  reply: FastifyReply,
  assetsDir: string,
): Promise<unknown> {
  const requestUrl = new URL(req.url, 'http://kimi-web.local');
  if (isReservedPath(requestUrl.pathname)) {
    reply.callNotFound();
    return;
  }

  const filePath = await resolveStaticFile(assetsDir, requestUrl.pathname);
  if (filePath === undefined) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }

  const fileInfo = await statIfFile(filePath);
  if (fileInfo === undefined) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }

  const compressible = isPrecompressible(filePath);
  if (compressible) mergeVaryHeader(reply, 'Accept-Encoding');
  const encoding = compressible ? negotiateAssetEncoding(req.headers['accept-encoding']) : 'identity';
  if (encoding === undefined) return reply.code(406).send();

  reply.type(mimeType(filePath)).header('Cache-Control', cacheControl(assetsDir, filePath));
  if (compressible) {
    const etag = assetEtag(fileInfo, encoding);
    reply.header('ETag', etag);
    if (encoding !== 'identity') reply.header('Content-Encoding', encoding);
    if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) return reply.code(304).send();
  }

  if (encoding === 'identity') {
    reply.header('Content-Length', String(fileInfo.size));
    return reply.send(createReadStream(filePath));
  }

  const sidecarPath = `${filePath}.${encoding === 'gzip' ? 'gz' : 'br'}`;
  const sidecarInfo = await statIfFile(sidecarPath);
  if (sidecarInfo !== undefined) {
    reply.header('Content-Length', String(sidecarInfo.size));
    return reply.send(createReadStream(sidecarPath));
  }

  const compressor = encoding === 'br'
    ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
    : createGzip();
  const source = createReadStream(filePath);
  pipeline(source, compressor, (error) => {
    if (error !== null && !reply.raw.destroyed) req.log.debug({ err: error }, 'Asset compression stream closed');
  });
  return reply.send(compressor);
}

type AssetEncoding = 'br' | 'gzip' | 'identity';

function isPrecompressible(filePath: string): boolean {
  return PRECOMPRESSIBLE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function negotiateAssetEncoding(
  acceptEncoding: string | string[] | undefined,
): AssetEncoding | undefined {
  if (acceptEncoding === undefined) return 'identity';
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
  const qualities = new Map<string, number>();
  for (const part of header.split(',')) {
    const [rawCoding, ...parameters] = part.trim().split(';');
    const coding = rawCoding?.trim().toLowerCase() ?? '';
    if (coding === '') continue;
    let quality = 1;
    let valid = true;
    for (const parameter of parameters) {
      const item = parameter.trim();
      if (!item.toLowerCase().startsWith('q=')) continue;
      const value = Number.parseFloat(item.slice(2));
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        valid = false;
        break;
      }
      quality = value;
    }
    if (!valid) continue;
    const existing = qualities.get(coding);
    if (existing === undefined || quality > existing) qualities.set(coding, quality);
  }

  const wildcard = qualities.get('*');
  const compressed: { readonly encoding: 'br' | 'gzip'; readonly quality: number }[] = [
    { encoding: 'br', quality: qualities.get('br') ?? wildcard ?? 0 },
    { encoding: 'gzip', quality: qualities.get('gzip') ?? wildcard ?? 0 },
  ];
  compressed.sort((left, right) => right.quality - left.quality);
  const selected = compressed.find((candidate) => candidate.quality > 0);
  const explicitIdentity = qualities.get('identity');
  if (selected !== undefined && selected.quality >= (explicitIdentity ?? 0)) return selected.encoding;
  const identityQuality = explicitIdentity ?? (wildcard === 0 ? 0 : 1);
  return identityQuality > 0 ? 'identity' : undefined;
}

function assetEtag(
  fileInfo: { readonly size: number; readonly mtimeMs: number },
  encoding: AssetEncoding,
): string {
  return `W/"${fileInfo.size.toString(16)}-${fileInfo.mtimeMs.toString(16)}-${encoding}"`;
}

function matchesIfNoneMatch(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const weakEtag = etag.replace(/^W\//, '');
  return raw.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === '*' || trimmed.replace(/^W\//, '') === weakEtag;
  });
}

async function statAssetPath(filePath: string): Promise<Stats | null | undefined> {
  try {
    return await stat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ENOTDIR' || code === 'ENAMETOOLONG' || code === 'ERR_INVALID_ARG_VALUE' || code === 'EINVAL') return null;
    throw error;
  }
}

async function statIfFile(filePath: string): Promise<Stats | undefined> {
  const info = await statAssetPath(filePath);
  return info?.isFile() ? info : undefined;
}

function mergeVaryHeader(reply: FastifyReply, token: string): void {
  const current = reply.getHeader('vary');
  if (current === undefined) {
    reply.header('Vary', token);
    return;
  }
  const raw = Array.isArray(current) ? current.join(', ') : String(current);
  const existing = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (existing.includes('*') || existing.some((entry) => entry.toLowerCase() === token.toLowerCase())) return;
  reply.header('Vary', [...existing, token].join(', '));
}

function cacheControl(assetsDir: string, filePath: string): string {
  const assetPath = relative(assetsDir, filePath);
  const fileName = filePath.slice(filePath.lastIndexOf(sep) + 1);
  if (assetPath.startsWith(`assets${sep}`) && /[-.][A-Za-z0-9_-]{8}\.[^.]+$/.test(fileName)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

async function resolveStaticFile(
  assetsDir: string,
  pathname: string,
): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  if (decoded.includes('\0')) return undefined;

  const normalized = normalize(decoded).replace(/^(\.\.(?:[/\\]|$))+/, '');
  const relative = normalized === sep ? 'index.html' : normalized.replace(/^[/\\]/, '');
  const root = resolve(assetsDir);
  const candidate = resolve(
    root,
    relative.endsWith(sep) ? join(relative, 'index.html') : relative,
  );
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return undefined;
  }

  const info = await statAssetPath(candidate);
  if (info?.isFile()) return candidate;
  if (info === null || extname(decoded) !== '') return undefined;

  if (info === undefined) {
    let parent = candidate;
    while (parent !== root) {
      parent = dirname(parent);
      if (parent === root) break;
      const ancestor = await statAssetPath(parent);
      if (ancestor === undefined) continue;
      if (!ancestor?.isDirectory()) return undefined;
      break;
    }
  }
  return join(root, 'index.html');
}

function isReservedPath(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/documentation' ||
    pathname.startsWith('/documentation/')
  );
}

function mimeType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
