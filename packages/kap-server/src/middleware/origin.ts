import type { FastifyReply, FastifyRequest } from 'fastify';

import { isLoopbackHost } from '@kiki/protocol';
import { stripPort } from './hostnames';

const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, X-Kimi-Client-Id, X-Kimi-Client-Name, X-Kimi-Client-Version, X-Kimi-Client-Ui-Mode';
const CORS_MAX_AGE_SECONDS = '600';

export interface OriginHookOptions {
  /** Explicit cross-origin allowlist (full origin strings, scheme + host). */
  readonly allowedOrigins?: readonly string[];
}

/**
 * Parse `KIKI_CORS_ORIGINS` into an allowlist.
 *
 * Comma-separated, trimmed, empties dropped. No `*` wildcard — every entry is
 * an explicit origin (PLAN §3.4).
 */
export function parseCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['KIKI_CORS_ORIGINS'];
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Return the `host` (host[:port], default port dropped) of an `Origin` value,
 * or `undefined` when the origin is missing or malformed.
 */
export function originHost(origin: string | undefined): string | undefined {
  if (origin === undefined) {
    return undefined;
  }
  return URL.parse(origin)?.host;
}

/**
 * Decide whether an `Origin` is allowed for a request to `host`.
 *
 *   - missing/malformed `Origin` → allowed (non-CORS / non-browser client);
 *   - same-origin (`Origin` host === `Host`, port stripped both sides) → allowed;
 *   - otherwise → allowed only when the full origin string is in `allowed`.
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === 'null' || isHtmlDocumentOrigin(origin)) return false;
  if (isDesktopAppOrigin(origin)) {
    return host !== undefined && isLoopbackHost(stripPort(host), { allowSubdomains: true });
  }
  const oh = originHost(origin);
  if (oh === undefined) {
    return true;
  }
  const ohStripped = stripPort(oh);
  if (host !== undefined) {
    const hostStripped = stripPort(host);
    if (ohStripped === hostStripped) {
      return true;
    }
    if (isLoopbackHost(ohStripped, { allowSubdomains: true }) && isLoopbackHost(hostStripped, { allowSubdomains: true })) {
      return true;
    }
  }
  return allowed.includes(origin as string);
}

const DESKTOP_APP_ORIGINS = new Set([
  'kiki-app://localhost',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]);

function isDesktopAppOrigin(origin: string | undefined): boolean {
  return origin !== undefined && DESKTOP_APP_ORIGINS.has(origin.toLowerCase());
}

function isHtmlDocumentOrigin(origin: string | undefined): boolean {
  const host = originHost(origin);
  return host !== undefined && stripPort(host).endsWith('.kiki-document.localhost');
}

/**
 * Build the Fastify `onRequest` CORS hook.
 *
 * Allowed origins get `Access-Control-Allow-Origin/-Methods` echoed and
 * `Access-Control-Allow-Headers` reflected from the preflight's
 * `Access-Control-Request-Headers` (falling back to `CORS_ALLOW_HEADERS` for
 * non-preflight responses), so newly added client request headers do not
 * require a matching server-side allowlist change; `OPTIONS` preflights
 * short-circuit to `204`. Disallowed origins get no CORS headers (the browser
 * blocks the response); their `OPTIONS` preflight still returns `204` so it
 * fails closed without leaking headers.
 */
export function createOriginHook(
  opts: OriginHookOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void> {
  const allowed = opts.allowedOrigins ?? [];
  return async (req, reply) => {
    const origin = req.headers.origin;
    if (isHtmlDocumentOrigin(origin)) return reply.code(403).send({ code: 40301, msg: 'html_document_origin_not_allowed' });
    if (origin === 'null' && req.url.startsWith('/api/')) return reply.code(403).send({ code: 40101, msg: 'opaque_origin_not_allowed' });
    if (origin === undefined) {
      return;
    }
    if (isOriginAllowed(origin, req.headers.host, allowed)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
      reply.header('Access-Control-Expose-Headers', 'ETag, Content-Disposition, Content-Range');
      reply.header(
        'Access-Control-Allow-Headers',
        req.headers['access-control-request-headers'] ?? CORS_ALLOW_HEADERS,
      );
      reply.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        reply.header('Access-Control-Max-Age', CORS_MAX_AGE_SECONDS);
        return reply.code(204).send();
      }
      return;
    }
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  };
}
