import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';

import { IHostFileSystem, type Scope } from '@kiki/agent-core-v2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { AdmissionError } from '../services/connections/admission';
import { stripPort } from '../middleware/hostnames';
import type { TranscriptService } from '../services/transcript/transcriptService';
import { openSessionMedia } from './sessionMedia';

const TTL_MS = 30 * 60 * 1000;
const MAX_GRANTS = 64;
const ID_RE = /^[a-f0-9]{64}$/u;
const openSchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const sessionOpenSchema = z.object({ file_id: z.string().min(1).max(4096) }).strict();

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

interface HostGrant {
  readonly kind: 'host';
  readonly path: string;
  readonly mime: string;
  readonly size: number;
  readonly expiresAt: number;
}

interface SessionGrant {
  readonly kind: 'session';
  readonly sessionId: string;
  readonly fileId: string;
  readonly mime: string;
  readonly size: number;
  readonly expiresAt: number;
}

type MediaGrant = HostGrant | SessionGrant;

function mediaExtension(path: string): string {
  const base = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function playbackMime(mediaType: string, name: string): string | undefined {
  const typed = mediaType.toLowerCase();
  if (typed.startsWith('video/') || typed.startsWith('audio/')) return mediaType;
  return MEDIA_MIME[mediaExtension(name)];
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

function unsatisfiableRange(raw: string | undefined, size: number): boolean {
  if (raw === undefined || !raw.startsWith('bytes=')) return false;
  const spec = raw.slice('bytes='.length);
  if (spec.includes(',')) return false;
  const dash = spec.indexOf('-');
  if (dash <= 0) return false;
  const start = Number.parseInt(spec.slice(0, dash), 10);
  const right = spec.slice(dash + 1);
  if (!Number.isFinite(start) || start < 0) return false;
  if (right !== '') {
    const end = Number.parseInt(right, 10);
    if (!Number.isFinite(end) || end < start) return false;
  }
  return start >= size;
}

function applyRange(reply: FastifyReply, raw: string | undefined, size: number): { readonly start: number; readonly end: number } | null | 'unsatisfiable' {
  reply.header('accept-ranges', 'bytes').header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff');
  if (unsatisfiableRange(raw, size)) {
    reply.code(416).header('content-range', `bytes */${size}`).header('content-length', 0);
    return 'unsatisfiable';
  }
  const range = parseRangeHeader(raw, size);
  if (range !== null) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.length);
  else reply.code(200).header('content-length', size);
  return range === null ? null : { start: range.start, end: range.end };
}

export function registerHostMediaPreviewRoutes(app: FastifyInstance, core: Scope, transcriptService?: TranscriptService): void {
  const grants = new Map<string, MediaGrant>();
  const hostFs = core.accessor.get(IHostFileSystem);
  const sweep = (): void => {
    const now = Date.now();
    for (const [id, grant] of grants) if (grant.expiresAt <= now) grants.delete(id);
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  const release = (id: string): void => { grants.delete(id); };
  const issue = (req: FastifyRequest, reply: FastifyReply, grant: Omit<HostGrant, 'expiresAt'> | Omit<SessionGrant, 'expiresAt'>): unknown => {
    sweep();
    if (grants.size >= MAX_GRANTS) throw new AdmissionError(429, 'too_many_media_previews');
    const id = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + TTL_MS;
    const stored: MediaGrant = grant.kind === 'host'
      ? { kind: 'host', path: grant.path, mime: grant.mime, size: grant.size, expiresAt }
      : { kind: 'session', sessionId: grant.sessionId, fileId: grant.fileId, mime: grant.mime, size: grant.size, expiresAt };
    grants.set(id, stored);
    return reply.send(okEnvelope({
      preview_id: id,
      url: previewUrl(req, id),
      mime: grant.mime,
      size: grant.size,
      expires_at: expiresAt,
    }, req.id));
  };
  app.post('/api/fs:media-preview', async (req, reply) => {
    try {
      requireLocalClient(req);
      const body = openSchema.parse(req.body);
      if (!isAbsolute(body.path)) throw new AdmissionError(400, 'media_preview_path_must_be_absolute');
      const mime = MEDIA_MIME[mediaExtension(body.path)];
      if (mime === undefined) throw new AdmissionError(400, 'media_preview_type_unsupported');
      const path = await hostFs.realpath(body.path);
      const stat = await hostFs.stat(path);
      if (!stat.isFile) throw new AdmissionError(404, 'media_preview_not_found');
      const openedMime = MEDIA_MIME[mediaExtension(path)];
      if (openedMime === undefined) throw new AdmissionError(400, 'media_preview_type_unsupported');
      return issue(req, reply, { kind: 'host', path, mime: openedMime, size: stat.size });
    } catch (error) {
      return sendError(error, reply);
    }
  });
  app.post('/api/sessions/:sessionId/media-playback', async (req, reply) => {
    let opened: Awaited<ReturnType<typeof openSessionMedia>> | undefined;
    try {
      requireLocalClient(req);
      const sessionId = (req.params as { sessionId: string }).sessionId;
      if (sessionId.length === 0) throw new AdmissionError(400, 'invalid_media_preview_request');
      const body = sessionOpenSchema.parse(req.body);
      opened = await openSessionMedia(core, sessionId, body.file_id, transcriptService);
      if (!opened.sessionExists || opened.file === undefined) throw new AdmissionError(404, 'media_preview_not_found');
      const mime = playbackMime(opened.file.mediaType, opened.file.name);
      if (mime === undefined) throw new AdmissionError(400, 'media_preview_type_unsupported');
      return issue(req, reply, { kind: 'session', sessionId, fileId: body.file_id, mime, size: opened.file.size });
    } catch (error) {
      return sendError(error, reply);
    } finally {
      await opened?.operation?.dispose();
    }
  });
  app.delete('/api/fs:media-preview/:previewId', async (req, reply) => {
    release((req.params as { previewId: string }).previewId);
    return reply.send(okEnvelope(null, req.id));
  });
  app.delete('/api/sessions/media-playback/:previewId', async (req, reply) => {
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
      if (grant.kind === 'host') return await sendHost(hostFs, grant, req, reply);
      return await sendSession(core, transcriptService, grant, req, reply);
    } catch (error) {
      return sendError(error, reply);
    }
  });
  app.addHook('preClose', async () => {
    clearInterval(timer);
    grants.clear();
  });
}

async function sendHost(hostFs: { stat(path: string): Promise<{ isFile: boolean; size: number }> }, grant: HostGrant, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const stat = await hostFs.stat(grant.path);
  if (!stat.isFile) throw new AdmissionError(404, 'media_preview_not_found');
  reply.type(grant.mime);
  const range = applyRange(reply, pickHeader(req.headers, 'range'), stat.size);
  if (range === 'unsatisfiable') return reply.send('');
  const stream = createReadStream(grant.path, range === null ? undefined : { start: range.start, end: range.end });
  const stop = (): void => { stream.destroy(); };
  reply.raw.once('close', stop);
  stream.once('close', () => { reply.raw.off('close', stop); });
  return reply.send(stream);
}

async function sendSession(core: Scope, transcriptService: TranscriptService | undefined, grant: SessionGrant, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const opened = await openSessionMedia(core, grant.sessionId, grant.fileId, transcriptService);
  let streamed = false;
  try {
    if (!opened.sessionExists || opened.file === undefined) throw new AdmissionError(404, 'media_preview_not_found');
    const file = opened.file;
    reply.type(grant.mime);
    const range = applyRange(reply, pickHeader(req.headers, 'range'), file.size);
    if (range === 'unsatisfiable') return reply.send('');
    const stream = Readable.from(file.stream(range === undefined || range === null ? undefined : { start: range.start, end: range.end }));
    streamed = true;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      stream.destroy();
      void opened.operation?.dispose();
    };
    reply.raw.once('close', release);
    reply.raw.once('finish', release);
    stream.once('close', () => { reply.raw.off('close', release); });
    return reply.send(stream);
  } finally {
    if (!streamed) await opened.operation?.dispose();
  }
}
