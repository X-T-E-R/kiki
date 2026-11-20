import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip, zstdCompress } from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PerMessageDeflateOptions } from 'ws';

const zstdCompressAsync = promisify(zstdCompress);
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export type HttpCompressionMode = 'always' | 'non-loopback' | 'off';
export type WireEncoding = 'zstd' | 'br' | 'gzip';

export interface WireCompressionOptions {
  /** Override `KIKI_HTTP_COMPRESSION` (`always` | `non-loopback` | `off`). Defaults to `non-loopback`. */
  readonly mode?: HttpCompressionMode;
  /** Override `KIKI_HTTP_COMPRESS_THRESHOLD_BYTES`. Defaults to `2048`. */
  readonly thresholdBytes?: number;
  /** Override `KIKI_HTTP_COMPRESS_ZSTD_LEVEL`. Defaults to `3`. */
  readonly zstdLevel?: number;
  /** Override `KIKI_HTTP_COMPRESS_BROTLI_QUALITY`. Defaults to `4`. */
  readonly brotliQuality?: number;
  /** Override `KIKI_HTTP_COMPRESS_GZIP_LEVEL`. Defaults to `6`. */
  readonly gzipLevel?: number;
  /** Environment bag used when option overrides are omitted. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface WsCompressionOptions {
  /** Override `KIKI_WS_COMPRESSION` (`on` | `off`). Defaults to `on`. */
  readonly enabled?: boolean;
  /** Override `KIKI_WS_COMPRESS_THRESHOLD_BYTES`. Defaults to `2048`. */
  readonly thresholdBytes?: number;
  /** Override `KIKI_WS_COMPRESS_LEVEL`. Defaults to `3`. */
  readonly level?: number;
  /** Override `KIKI_WS_COMPRESS_CONCURRENCY`. Defaults to `8`. */
  readonly concurrencyLimit?: number;
  /** Environment bag used when option overrides are omitted. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export const DEFAULT_HTTP_COMPRESS_THRESHOLD_BYTES = 2048;
export const DEFAULT_HTTP_COMPRESS_ZSTD_LEVEL = 3;
export const DEFAULT_HTTP_COMPRESS_BROTLI_QUALITY = 4;
export const DEFAULT_HTTP_COMPRESS_GZIP_LEVEL = 6;
export const DEFAULT_WS_COMPRESS_THRESHOLD_BYTES = 2048;
export const DEFAULT_WS_COMPRESS_LEVEL = 3;
export const DEFAULT_WS_COMPRESS_CONCURRENCY = 8;

const IPV4_LOOPBACK_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ENCODING_PREFERENCE: readonly WireEncoding[] = ['zstd', 'br', 'gzip'];

function parsePositiveInt(raw: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Resolve HTTP wire compression mode from explicit option or `KIKI_HTTP_COMPRESSION`. */
export function resolveHttpCompressionMode(
  override?: HttpCompressionMode,
  env: NodeJS.ProcessEnv = process.env,
): HttpCompressionMode {
  if (override !== undefined) return override;
  const raw = env['KIKI_HTTP_COMPRESSION']?.trim().toLowerCase();
  if (raw === 'always' || raw === 'non-loopback' || raw === 'off') return raw;
  return 'non-loopback';
}

/** Return true for IPv4/IPv6 loopback peers and local Unix domain sockets. */
export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined || remoteAddress === '') return true;
  const normalized = remoteAddress.trim().toLowerCase();
  if (normalized === '::1' || normalized === '127.0.0.1') return true;
  if (IPV4_LOOPBACK_RE.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return mapped === '127.0.0.1' || IPV4_LOOPBACK_RE.test(mapped);
  }
  return false;
}

/** Return true when the response Content-Type is eligible for buffered wire compression. */
export function isCompressibleContentType(contentType: string | number | readonly string[] | undefined): boolean {
  if (contentType === undefined) return false;
  const raw = Array.isArray(contentType) ? contentType[0] : String(contentType);
  if (typeof raw !== 'string') return false;
  const mime = raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mime === '' || mime === 'text/event-stream' || mime === 'application/x-ndjson') return false;
  if (mime === 'application/json' || mime === 'application/problem+json' || mime === 'image/svg+xml') return true;
  return mime.startsWith('text/');
}

/** Select the best supported encoding from an `Accept-Encoding` header respecting quality weights and `;q=0` exclusions. */
export function negotiateWireEncoding(acceptEncoding: string | readonly string[] | undefined): WireEncoding | undefined {
  if (acceptEncoding === undefined) return undefined;
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
  if (typeof header !== 'string' || header.trim() === '') return undefined;

  const weights = new Map<string, number>();
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const segments = trimmed.split(';');
    const coding = segments[0]?.trim().toLowerCase() ?? '';
    if (coding === '') continue;
    let quality = 1;
    let valid = true;
    for (let i = 1; i < segments.length; i += 1) {
      const param = segments[i]?.trim().toLowerCase() ?? '';
      if (!param.startsWith('q=')) continue;
      const value = Number.parseFloat(param.slice(2));
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        valid = false;
        break;
      }
      quality = value;
    }
    if (!valid) continue;
    const existing = weights.get(coding);
    if (existing === undefined || quality > existing) {
      weights.set(coding, quality);
    }
  }

  const wildcard = weights.get('*');
  let bestEncoding: WireEncoding | undefined;
  let bestQuality = 0;
  for (const candidate of ENCODING_PREFERENCE) {
    const quality = weights.get(candidate) ?? wildcard ?? 0;
    if (quality > bestQuality) {
      bestQuality = quality;
      bestEncoding = candidate;
    }
  }
  return bestEncoding;
}

function hasNoTransform(cacheControl: string | number | readonly string[] | undefined): boolean {
  if (cacheControl === undefined) return false;
  const raw = Array.isArray(cacheControl) ? cacheControl.join(',') : String(cacheControl);
  return /(?:^|,)\s*no-transform(?:\s*,|$)/i.test(raw);
}

function mergeVaryHeader(reply: FastifyReply, token: string): void {
  const current = reply.getHeader('vary');
  if (current === undefined) {
    reply.header('vary', token);
    return;
  }
  const raw = Array.isArray(current) ? current.join(', ') : String(current);
  const existing = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (existing.includes('*')) return;
  const lower = token.toLowerCase();
  if (existing.some((entry) => entry.toLowerCase() === lower)) return;
  reply.header('vary', [...existing, token].join(', '));
}

function toBuffer(payload: unknown): Buffer | undefined {
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return undefined;
}

/**
 * Create a Fastify `onSend` hook that compresses eligible buffered responses with
 * Node's built-in async `zstd`, `br`, or `gzip` while bypassing loopback peers by default.
 */
export function createWireCompressionHook(
  opts: WireCompressionOptions = {},
): (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown> {
  const env = opts.env ?? process.env;
  const mode = resolveHttpCompressionMode(opts.mode, env);
  const thresholdBytes = opts.thresholdBytes ?? parsePositiveInt(
    env['KIKI_HTTP_COMPRESS_THRESHOLD_BYTES'],
    DEFAULT_HTTP_COMPRESS_THRESHOLD_BYTES,
    0,
  );
  const zstdLevel = opts.zstdLevel ?? parsePositiveInt(
    env['KIKI_HTTP_COMPRESS_ZSTD_LEVEL'],
    DEFAULT_HTTP_COMPRESS_ZSTD_LEVEL,
    1,
    19,
  );
  const brotliQuality = opts.brotliQuality ?? parsePositiveInt(
    env['KIKI_HTTP_COMPRESS_BROTLI_QUALITY'],
    DEFAULT_HTTP_COMPRESS_BROTLI_QUALITY,
    0,
    11,
  );
  const gzipLevel = opts.gzipLevel ?? parsePositiveInt(
    env['KIKI_HTTP_COMPRESS_GZIP_LEVEL'],
    DEFAULT_HTTP_COMPRESS_GZIP_LEVEL,
    1,
    9,
  );

  return async (req, reply, payload) => {
    if (mode === 'off') return payload;
    if (req.method === 'HEAD') return payload;
    if (reply.statusCode < 200 || reply.statusCode === 204 || reply.statusCode === 304 || reply.statusCode >= 400) {
      return payload;
    }
    if (mode === 'non-loopback' && isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      return payload;
    }
    if (reply.getHeader('content-encoding') !== undefined) return payload;
    if (hasNoTransform(reply.getHeader('cache-control'))) return payload;
    if (!isCompressibleContentType(reply.getHeader('content-type'))) return payload;

    const input = toBuffer(payload);
    if (input === undefined || input.byteLength < thresholdBytes) return payload;

    const encoding = negotiateWireEncoding(req.headers['accept-encoding']);
    if (encoding === undefined) return payload;

    let compressed: Buffer;
    if (encoding === 'zstd') {
      compressed = await zstdCompressAsync(input, {
        params: { [zlibConstants.ZSTD_c_compressionLevel]: zstdLevel },
      });
    } else if (encoding === 'br') {
      compressed = await brotliCompressAsync(input, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: brotliQuality },
      });
    } else {
      compressed = await gzipAsync(input, { level: gzipLevel });
    }

    if (compressed.byteLength >= input.byteLength) return payload;

    reply.header('content-encoding', encoding);
    mergeVaryHeader(reply, 'Accept-Encoding');
    reply.header('content-length', compressed.byteLength);
    return compressed;
  };
}

/**
 * Resolve zero-idle-memory WebSocket `perMessageDeflate` options from explicit overrides
 * or `KIKI_WS_COMPRESSION` / `KIKI_WS_COMPRESS_*` environment variables.
 */
export function resolveWsPerMessageDeflate(
  opts: WsCompressionOptions = {},
): PerMessageDeflateOptions | false {
  const env = opts.env ?? process.env;
  const rawEnabled = env['KIKI_WS_COMPRESSION']?.trim().toLowerCase();
  const enabled = opts.enabled ?? (rawEnabled !== 'off' && rawEnabled !== 'false' && rawEnabled !== '0');
  if (!enabled) return false;
  const threshold = opts.thresholdBytes ?? parsePositiveInt(
    env['KIKI_WS_COMPRESS_THRESHOLD_BYTES'],
    DEFAULT_WS_COMPRESS_THRESHOLD_BYTES,
    0,
  );
  const level = opts.level ?? parsePositiveInt(
    env['KIKI_WS_COMPRESS_LEVEL'],
    DEFAULT_WS_COMPRESS_LEVEL,
    1,
    9,
  );
  const concurrencyLimit = opts.concurrencyLimit ?? parsePositiveInt(
    env['KIKI_WS_COMPRESS_CONCURRENCY'],
    DEFAULT_WS_COMPRESS_CONCURRENCY,
    1,
    64,
  );
  return {
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    concurrencyLimit,
    threshold,
    zlibDeflateOptions: { level },
  };
}
