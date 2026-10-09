import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { extname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IHostFileSystem, type Scope } from '@kiki/agent-core-v2';
import { peerAudience } from '../services/connections/audience';
import { buildEtag, guessMime } from '@kiki/agent-core-v2/_base/utils/fileMeta';
import { HTML_PREVIEW_SANDBOX, htmlPreviewRequestSchema, htmlPreviewResponseSchema, type HtmlPreviewResponse } from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { AdmissionError } from '../services/connections/admission';
import type { RemoteConnectionManager } from '../services/connections/manager';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';

export const HTML_PREVIEW_CSP = `sandbox ${HTML_PREVIEW_SANDBOX}; object-src 'none'`;
const TTL = 30 * 60 * 1000;
const resourceOptions = { config: { htmlPreviewResource: true } };
interface LocalPreview { root: string; expiresAt: number }
interface RemotePreview { connectionId: string; remoteId: string; expiresAt: number; dispose(): void }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function resourcePath(value: string): string {
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some((part) => part === '..' || part === '.' || part.includes(':'))) throw new AdmissionError(403, 'preview_path_outside_root');
  return value;
}
function previewUrl(id: string, path: string): string { return `/html-preview/${id}/${path.split('/').map(encodeURIComponent).join('/')}`; }
function mime(path: string): string {
  const extra: Record<string, string> = { '.htm': 'text/html', '.xhtml': 'application/xhtml+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm' };
  return extra[extname(path).toLowerCase()] ?? guessMime(path, true);
}
function security(reply: FastifyReply): void {
  reply.header('content-security-policy', HTML_PREVIEW_CSP).header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff')
    .header('access-control-allow-origin', '*').header('cache-control', 'no-store');
}
function sendError(error: unknown, reply: FastifyReply): unknown {
  let status: number; let message: string;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (error instanceof AdmissionError) { status = error.status; message = error.reason; }
  else if (error instanceof z.ZodError) { status = 400; message = 'invalid_html_preview_request'; }
  else if (code === 'ENOENT' || code === 'ENOTDIR' || String(code).includes('not_found')) { status = 404; message = 'preview_resource_not_found'; }
  else if (code === 'EACCES' || code === 'EPERM' || String(code).includes('permission_denied')) { status = 403; message = 'preview_resource_forbidden'; }
  else throw error;
  return reply.code(status).type('application/json').send(errEnvelope(status === 400 ? 40001 : status === 404 ? 40409 : 40301, message, reply.request.id));
}

export function registerHtmlPreviewRoutes(app: FastifyInstance, core: Scope, manager: RemoteConnectionManager): void {
  const local = new Map<string, LocalPreview>();
  const remote = new Map<string, RemotePreview>();
  const active = new Map<string, Set<() => void>>();
  const hostFs = core.accessor.get(IHostFileSystem);
  const release = (id: string): void => {
    const entry = remote.get(id);
    local.delete(id); remote.delete(id); entry?.dispose();
    for (const stop of active.get(id) ?? []) stop();
    active.delete(id);
  };
  const track = (id: string, stop: () => void): (() => void) => {
    const set = active.get(id) ?? new Set(); set.add(stop); active.set(id, set);
    return () => { set.delete(stop); if (set.size === 0) active.delete(id); };
  };
  const sweep = () => {
    for (const [id, entry] of [...local, ...remote]) if (entry.expiresAt <= Date.now()) release(id);
  };
  const timer = setInterval(() => {
    sweep();
    for (const [id, entry] of remote) {
      try { manager.resolveTransport(entry.connectionId); } catch { release(id); }
    }
  }, 30_000);
  timer.unref();
  const reserve = () => { sweep(); if (local.size + remote.size >= 128) throw new AdmissionError(429, 'too_many_html_previews'); };
  const entryOf = (id: string): LocalPreview => {
    sweep(); const entry = local.get(id); if (entry === undefined) throw new AdmissionError(404, 'html_preview_expired'); return entry;
  };
  const open = async (body: unknown): Promise<HtmlPreviewResponse> => {
    reserve();
    const input = htmlPreviewRequestSchema.parse(body);
    if (!isAbsolute(input.path) || !isAbsolute(input.root)) throw new AdmissionError(400, 'preview_path_and_root_must_be_absolute');
    const root = await hostFs.realpath(input.root);
    if (root === parse(root).root || !(await hostFs.stat(root)).isDirectory || !inside(resolve(input.root), resolve(input.path))) throw new AdmissionError(403, 'preview_path_outside_root');
    const path = await hostFs.realpath(input.path);
    if (!inside(root, path)) throw new AdmissionError(403, 'preview_path_outside_root');
    if (!(await hostFs.stat(path)).isFile || !/\.(html?|xhtml)$/iu.test(path)) throw new AdmissionError(400, 'html_document_required');
    const id = randomBytes(32).toString('base64url'); const expiresAt = Date.now() + TTL;
    local.set(id, { root, expiresAt });
    return { preview_id: id, expires_at: expiresAt, sandbox: HTML_PREVIEW_SANDBOX, url: previewUrl(id, relative(resolve(input.root), resolve(input.path)).split(sep).join('/')) };
  };
  const serveLocal = async (id: string, path: string, req: FastifyRequest, reply: FastifyReply) => {
    const entry = entryOf(id);
    const candidate = resolve(entry.root, resourcePath(path));
    if (!inside(entry.root, candidate)) throw new AdmissionError(403, 'preview_path_outside_root');
    const canonical = await hostFs.realpath(candidate);
    if (!inside(entry.root, canonical)) throw new AdmissionError(403, 'preview_path_outside_root');
    const stat = await hostFs.stat(canonical);
    if (!stat.isFile) throw new AdmissionError(404, 'preview_resource_not_found');
    const etag = buildEtag(stat);
    reply.header('etag', etag).header('accept-ranges', 'bytes').type(mime(canonical));
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const range = parseRangeHeader(pickHeader(req.headers, 'range'), stat.size);
    if (range !== null) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${stat.size}`);
    reply.header('content-length', range?.length ?? stat.size);
    const stream = createReadStream(canonical, range ?? undefined);
    const stop = () => stream.destroy(); const untrack = track(id, stop);
    stream.once('close', untrack); reply.raw.once('close', stop);
    return reply.send(stream);
  };
  const forward = async (connectionId: string, operation: 'htmlPreviewOpen' | 'htmlPreviewClose', body?: unknown, remoteId?: string) => {
    const lease = manager.lease(connectionId, AbortSignal.timeout(30_000));
    try {
      const response = await manager.forward(connectionId, { operation, body, params: { previewId: remoteId ?? '' } }, lease.signal);
      const envelope = await readBoundedJsonBody(response, 8192) as { code: number; msg: string; data: unknown };
      if (!response.ok || envelope.code !== 0) throw new AdmissionError(response.ok ? 400 : response.status, envelope.msg);
      return envelope.data;
    } finally { lease.release(); }
  };
  const close = async (id: string) => {
    const entry = remote.get(id); release(id);
    if (entry !== undefined) await forward(entry.connectionId, 'htmlPreviewClose', undefined, entry.remoteId).catch(() => {});
  };
  app.post('/api/fs::html-preview', async (req, reply) => {
    try {
      if (peerAudience(req) !== undefined) throw new AdmissionError(403, 'html_preview_target_owner_grant_required');
      return reply.send(okEnvelope(await open(req.body), req.id));
    } catch (error) { return sendError(error, reply); }
  });
  app.delete('/api/fs::html-preview/:previewId', async (req, reply) => {
    await close((req.params as { previewId: string }).previewId); return reply.send(okEnvelope(null, req.id));
  });
  app.post('/api/remote-connections/:connectionId/html-preview', async (req, reply) => {
    try {
      reserve(); const { connectionId } = req.params as { connectionId: string };
      const result = htmlPreviewResponseSchema.parse(await forward(connectionId, 'htmlPreviewOpen', htmlPreviewRequestSchema.parse(req.body)));
      const id = randomBytes(32).toString('base64url');
      const lease = manager.lease(connectionId);
      const stop = () => release(id);
      lease.signal.addEventListener('abort', stop, { once: true });
      remote.set(id, { connectionId, remoteId: result.preview_id, expiresAt: result.expires_at, dispose: () => { lease.signal.removeEventListener('abort', stop); lease.release(); } });
      const path = result.url.slice(`/html-preview/${result.preview_id}/`.length);
      return reply.send(okEnvelope({ ...result, preview_id: id, url: `/html-preview/${id}/${path}` }, req.id));
    } catch (error) { return sendError(error, reply); }
  });
  app.get('/api/html-preview/:previewId/resource', resourceOptions, async (req, reply) => {
    security(reply);
    try { return await serveLocal((req.params as { previewId: string }).previewId, z.object({ path: z.string() }).parse(req.query).path, req, reply); }
    catch (error) { return sendError(error, reply); }
  });
  app.get('/html-preview/:previewId/*', resourceOptions, async (req, reply) => {
    security(reply);
    const { previewId, '*': path } = req.params as { previewId: string; '*': string };
    try {
      sweep(); const entry = remote.get(previewId);
      if (entry === undefined) return await serveLocal(previewId, path, req, reply);
      resourcePath(path);
      const controller = new AbortController(); const lease = manager.lease(entry.connectionId, controller.signal);
      const stop = () => controller.abort(); const untrack = track(previewId, stop);
      reply.raw.once('close', stop);
      const cleanup = () => { untrack(); lease.release(); reply.raw.off('close', stop); };
      try {
        const response = await manager.forward(entry.connectionId, { operation: 'htmlPreviewResource', params: { previewId: entry.remoteId }, query: { path }, headers: { range: pickHeader(req.headers, 'range'), ifNoneMatch: pickHeader(req.headers, 'if-none-match') } }, lease.signal);
        for (const name of ['content-type', 'content-length', 'content-range', 'etag', 'accept-ranges']) {
          const value = response.headers.get(name); if (value !== null) reply.header(name, value);
        }
        reply.code(response.status);
        if (response.body === null || response.status === 304) { cleanup(); return reply.send(); }
        const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        stream.once('close', cleanup); lease.signal.addEventListener('abort', () => stream.destroy(), { once: true });
        return reply.send(stream);
      } catch (error) { cleanup(); throw error; }
    } catch (error) { return sendError(error, reply); }
  });
  app.addHook('preClose', async () => { clearInterval(timer); for (const id of [...local.keys(), ...remote.keys()]) await close(id); });
}
