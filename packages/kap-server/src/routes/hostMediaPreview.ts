import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';

import { IHostFileSystem, type Scope } from '@kiki/agent-core-v2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { AdmissionError } from '../services/connections/admission';
import { stripPort } from '../middleware/hostnames';

const TTL_MS = 30 * 60 * 1000;
const MAX_GRANTS = 64;
const ID_RE = /^[a-f0-9]{64}$/u;
const openSchema = z.object({ path: z.string().min(1).max(4096) }).strict();

const MEDIA_MIME: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
};

interface MediaGrant {
  readonly path: string;
  readonly mime: string;
  readonly size: number;
  readonly expiresAt: number;
}

function mediaExtension(path: string): string {
  const base = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function requireLocalClient(req: FastifyRequest): void {
  const host = stripPort(req.headers.host ?? '');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip) || !(['localhost', '127.0.0.1', '::1', '[::1]'].includes(host))) {
    throw new AdmissionError(403, 'media_preview_requires_local_connection');
  }
}

function sendError(error: unknown, reply: FastifyReply): unknown {
  let status = 500;
  let message = 'media_preview_failed';
  const code = (error as NodeJS.ErrnoException)?.code;
  if (error instanceof AdmissionError) {
    status = error.status;
    message = error.reason;
  } else if (error instanceof z.ZodError) {
    status = 400;
    message = 'invalid_media_preview_request';
  } else if (code === 'ENOENT' || code === 'ENOTDIR') {
    status = 404;
    message = 'media_preview_not_found';
  } else if (code === 'EACCES' || code === 'EPERM') {
    status = 403;
    message = 'media_preview_forbidden';
  } else if (!(error instanceof Error)) {
    throw error;
  } else {
    throw error;
  }
  const envelopeCode = status === 400 ? 40001 : status === 404 ? 40409 : status === 403 ? 40301 : status === 429 ? 42901 : 50000;
  return reply.code(status).type('application/json').send(errEnvelope(envelopeCode, message, reply.request.id));
}

function previewUrl(req: FastifyRequest, id: string): string {
  const host = req.headers.host;
  const path = `/media-preview/${id}`;
  if (typeof host !== 'string' || host.length === 0) return path;
  return `${req.protocol === 'https' ? 'https' : 'http'}://${host}${path}`;
}

export function registerHostMediaPreviewRoutes(app: FastifyInstance, core: Scope): void {
  const grants = new Map<string, MediaGrant>();
  const hostFs = core.accessor.get(IHostFileSystem);
  const sweep = (): void => {
    const now = Date.now();
    for (const [id, grant] of grants) if (grant.expiresAt <= now) grants.delete(id);
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  const release = (id: string): void => { grants.delete(id); };
  app.post('/api/fs:media-preview', async (req, reply) => {
    try {
      requireLocalClient(req);
      sweep();
      if (grants.size >= MAX_GRANTS) throw new AdmissionError(429, 'too_many_media_previews');
      const body = openSchema.parse(req.body);
      if (!isAbsolute(body.path)) throw new AdmissionError(400, 'media_preview_path_must_be_absolute');
      const mime = MEDIA_MIME[mediaExtension(body.path)];
      if (mime === undefined) throw new AdmissionError(400, 'media_preview_type_unsupported');
      const path = await hostFs.realpath(body.path);
      const stat = await hostFs.stat(path);
      if (!stat.isFile) throw new AdmissionError(404, 'media_preview_not_found');
      const openedMime = MEDIA_MIME[mediaExtension(path)];
      if (openedMime === undefined) throw new AdmissionError(400, 'media_preview_type_unsupported');
      const id = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + TTL_MS;
      grants.set(id, { path, mime: openedMime, size: stat.size, expiresAt });
      return reply.send(okEnvelope({
        preview_id: id,
        url: previewUrl(req, id),
        mime: openedMime,
        size: stat.size,
        expires_at: expiresAt,
      }, req.id));
    } catch (error) {
      return sendError(error, reply);
    }
  });
  app.delete('/api/fs:media-preview/:previewId', async (req, reply) => {
    release((req.params as { previewId: string }).previewId);
    return reply.send(okEnvelope(null, req.id));
  });
  app.get('/media-preview/:previewId', async (req, reply) => {
    try {
      sweep();
      const id = (req.params as { previewId: string }).previewId;
      if (!ID_RE.test(id)) throw new AdmissionError(404, 'media_preview_not_found');
      const grant = grants.get(id);
      if (grant === undefined) throw new AdmissionError(404, 'media_preview_not_found');
      const stat = await hostFs.stat(grant.path);
      if (!stat.isFile) throw new AdmissionError(404, 'media_preview_not_found');
      reply.header('accept-ranges', 'bytes').header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type(grant.mime);
      const range = parseRangeHeader(pickHeader(req.headers, 'range'), stat.size);
      if (range !== null) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${stat.size}`);
      else reply.code(200);
      reply.header('content-length', range?.length ?? stat.size);
      const stream = createReadStream(grant.path, range === null ? undefined : { start: range.start, end: range.end });
      const stop = (): void => { stream.destroy(); };
      reply.raw.once('close', stop);
      stream.once('close', () => { reply.raw.off('close', stop); });
      return reply.send(stream);
    } catch (error) {
      return sendError(error, reply);
    }
  });
  app.addHook('preClose', async () => {
    clearInterval(timer);
    grants.clear();
  });
}
