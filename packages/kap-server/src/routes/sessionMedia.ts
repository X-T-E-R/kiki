import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';

import {
  ISessionMediaStore,
  type SessionMediaFile,
} from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { IBootstrapService } from '@kiki/agent-core-v2/app/bootstrap/bootstrap';
import {
  FileErrors,
  IFileService,
  isFileError,
} from '@kiki/agent-core-v2/app/file/fileService';
import { ISessionIndex } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndex';
import { IBlobStore } from '@kiki/agent-core-v2/persistence/interface/blobStore';
import {
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
} from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import type { Scope } from '@kiki/agent-core-v2/_base/di/scope';
import { isPlainAgentId } from '@kiki/transcript';
import { z } from 'zod';

import { buildContentDisposition } from '../lib/contentDisposition';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { requestLog } from '../lib/requestLog';
import { acquireSessionOperation, createDeferredCleanup, type SessionOperationLease } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { openApiDocumentJsonSchema } from '../middleware/schema';
import { ErrorCode } from '../protocol/error-codes';
import { envelopeSchema, errEnvelope } from '../protocol/envelope';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { createMediaPreview, MediaPreviewUnavailableError } from '../services/mediaPreview';
import { inlineDataMediaFile, inlineMediaFile, inlineMediaId, inlineToolMedia, isInlineMediaAddress } from '../services/inlineMedia';
import type { TranscriptService } from '../services/transcript/transcriptService';
import { readSessionViewCanonicalEntity } from '../transport/klient/sessionViewReads';
import type { TranscriptAttachment } from '@kiki/transcript';
import { openContentOriginal } from '../services/contentOriginal';
import { ContentChangedError, contentRevision } from '../transport/klient/boundedContent';

interface SessionMediaRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: SessionMediaRequest, reply: SessionMediaReply) => unknown,
  ): unknown;
}

interface SessionMediaRequest {
  readonly id: string;
  readonly body: unknown;
  readonly params: { readonly session_id: string; readonly file_id: string };
  readonly headers: Record<string, unknown>;
}

interface SessionMediaReply extends Pick<FastifyReply, 'then'> {
  readonly raw: { once(event: 'finish' | 'close', listener: () => void): unknown };
  type(mime: string): SessionMediaReply;
  header(name: string, value: string | number): SessionMediaReply;
  code(status: number): SessionMediaReply;
  send(payload: unknown): unknown;
}

const sessionMediaParamSchema = z.object({
  session_id: z.string().min(1),
  file_id: z.string().min(1),
});

export function registerSessionMediaRoutes(app: SessionMediaRouteHost, core: Scope, transcriptService?: TranscriptService): void {
  const errorResponse = openApiDocumentJsonSchema(envelopeSchema(z.null()), 'output');
  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/media/{file_id}',
      params: sessionMediaParamSchema,
      rawResponse: {
        200: { type: 'string', format: 'binary' },
        206: { type: 'string', format: 'binary' },
        404: errorResponse,
        500: errorResponse,
      },
      description: 'Download session-canonical prompt media by file ID',
      tags: ['files'],
    },
    async (req, reply) => {
      const r = reply as unknown as SessionMediaReply;
      const { session_id, file_id } = req.params;
      let operation: SessionOperationLease | undefined;
      let stream: Readable | undefined;
      let responseCleanup: ReturnType<typeof createDeferredCleanup> | undefined;
      try {
        const opened = await openSessionMedia(core, session_id, file_id, transcriptService);
        operation = opened.operation;
        if (!opened.sessionExists) {
          r.code(404).send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'session not found', req.id));
          return;
        }
        const file = opened.file;
        if (file === undefined) {
          return r.code(404).send(errEnvelope(ErrorCode.FILE_NOT_FOUND, 'file not found', req.id)) as void;
        }

        const etag = `"${session_id}-${file_id}-${file.size}"`;
        r.type(file.mediaType)
          .header('content-disposition', buildContentDisposition(file.name, file.mediaType))
          .header('accept-ranges', 'bytes')
          .header('etag', etag);
        if (pickHeader(req.headers, 'range') === undefined && pickHeader(req.headers, 'if-none-match') === etag) {
          return r.code(304).send(null) as void;
        }

        const range = parseRangeHeader(pickHeader(req.headers, 'range'), file.size);
        if (range !== null) {
          r.header('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
            .header('content-length', range.length).code(206);
        } else {
          r.header('content-length', file.size).code(200);
        }
        stream = Readable.from(file.stream(range === null ? undefined : { start: range.start, end: range.end }));
        const downloadStream = stream;
        responseCleanup = createDeferredCleanup(
          () => operation?.dispose(),
          (error) => {
            requestLog(req)?.error({ session_id, file_id, err: error }, 'session media cleanup failed');
            downloadStream.destroy(error instanceof Error ? error : new Error(String(error)));
          },
        );
        downloadStream.on('error', (error: unknown) => {
          requestLog(req)?.warn({ session_id, file_id, err: error }, 'session media stream error');
          downloadStream.destroy();
        });
        r.raw.once('finish', () => { responseCleanup?.release(); });
        r.raw.once('close', () => { downloadStream.destroy(); responseCleanup?.release(); });
        return r.send(downloadStream) as void;
      } catch (error) {
        stream?.destroy();
        responseCleanup?.release();
        await responseCleanup?.wait();
        throw error;
      } finally {
        if (stream === undefined) await operation?.dispose();
      }
    },
  );
  app.get(
    route.path,
    route.options,
    async (req, reply) => {
      try {
        await route.handler(req, reply);
      } catch (error) {
        if (error instanceof ContentChangedError) { reply.code(409).send(errEnvelope(ErrorCode.PAGE_TOKEN_MISMATCH, error.message, req.id)); return; }
        requestLog(req)?.error({ err: error }, 'session media download failed');
        reply.code(500).send(errEnvelope(
          ErrorCode.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'file download failed',
          req.id,
        ));
      }
    },
  );
  const preview = defineRoute({
    method: 'GET', path: '/sessions/{session_id}/media/{file_id}/preview', params: sessionMediaParamSchema,
    querystring: z.object({ media_type: z.string().min(1).max(128).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u).optional() }),
    rawResponse: { 200: { type: 'string', format: 'binary' }, 206: { type: 'string', format: 'binary' }, 304: { type: 'null' }, 404: errorResponse, 415: errorResponse },
    description: 'Small source-generated session media preview; media_type is a MIME hint, not file authorization', tags: ['files'],
  }, async (req, reply) => {
    const r = reply as unknown as SessionMediaReply;
    const { session_id, file_id } = req.params;
    const opened = await openSessionMedia(core, session_id, file_id, transcriptService);
    try {
      if (!opened.sessionExists) return r.code(404).send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'session not found', req.id)) as void;
      const file = opened.file;
      if (file === undefined) return r.code(404).send(errEnvelope(ErrorCode.FILE_NOT_FOUND, 'file not found', req.id)) as void;
      const etag = `"preview-v2-${session_id}-${file_id}-${file.size}-${req.query.media_type ?? file.mediaType}"`;
      r.header('etag', etag).header('accept-ranges', 'bytes');
      if (pickHeader(req.headers, 'range') === undefined && pickHeader(req.headers, 'if-none-match') === etag) return r.code(304).send(null) as void;
      const result = await withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], (signal) => createMediaPreview(file, req.query.media_type, signal));
      r.type(result.mime).header('content-disposition', buildContentDisposition(file.name, result.mime));
      const range = parseRangeHeader(pickHeader(req.headers, 'range'), result.bytes.byteLength);
      const bytes = range === null ? result.bytes : result.bytes.subarray(range.start, range.end + 1);
      if (range !== null) r.code(206).header('content-range', `bytes ${range.start}-${range.end}/${result.bytes.byteLength}`);
      else r.code(200);
      return r.header('content-length', bytes.byteLength).send(Buffer.from(bytes)) as void;
    } catch (error) {
      if (!(error instanceof MediaPreviewUnavailableError)) throw error;
      return r.code(415).send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id)) as void;
    } finally {
      await opened.operation?.dispose();
    }
  });
  app.get(preview.path, preview.options, preview.handler as unknown as Parameters<SessionMediaRouteHost['get']>[2]);
  const canonicalIdRoute = defineRoute({
    method: 'GET', path: '/sessions/{session_id}/media/*',
    params: z.object({ session_id: z.string().min(1), '*': z.string().min(1) }),
    querystring: z.object({ media_type: z.string().min(1).max(128).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u).optional() }),
    rawResponse: { 200: { type: 'string', format: 'binary' }, 206: { type: 'string', format: 'binary' } },
    description: 'Canonical inline and original-content media IDs', tags: ['files'],
  }, async (req, reply) => {
    const wildcard = req.params['*'];
    const isPreview = wildcard.endsWith('/preview');
    const params = { session_id: req.params.session_id, file_id: isPreview ? wildcard.slice(0, -8) : wildcard };
    try {
      const request = { id: req.id, body: req.body, headers: req.headers, params, query: req.query };
      if (isPreview) await preview.handler(request, reply);
      else await route.handler(request, reply);
    } catch (error) {
      if (error instanceof ContentChangedError) { (reply as unknown as SessionMediaReply).code(409).send(errEnvelope(ErrorCode.PAGE_TOKEN_MISMATCH, error.message, req.id)); return; }
      throw error;
    }
  });
  app.get(canonicalIdRoute.path, canonicalIdRoute.options, canonicalIdRoute.handler as unknown as Parameters<SessionMediaRouteHost['get']>[2]);
}

async function openSessionMedia(core: Scope, sessionId: string, fileId: string, service?: TranscriptService): Promise<{ readonly sessionExists: boolean; readonly file?: SessionMediaFile; readonly operation?: SessionOperationLease }> {
  if (fileId.startsWith('raw:')) return { sessionExists: true, file: service === undefined ? undefined : await openContentOriginal(service, sessionId, fileId) };
  if (fileId.startsWith('inline-content:')) {
    const parts = fileId.split(':');
    if (service === undefined || parts.length !== 4 || !isPlainAgentId(parts[1]!) || parts[2]!.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/u.test(parts[2]!) || !/^[0-9a-f]{64}$/u.test(parts[3]!)) return { sessionExists: true };
    let address: unknown;
    try { address = JSON.parse(Buffer.from(parts[2]!, 'base64url').toString('utf8')); }
    catch { return { sessionExists: true }; }
    const parsed = z.object({
      source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('frame'), id: z.string().min(1).max(256), turnId: z.string().min(1).max(256), stepId: z.string().min(1).max(256) }).strict(),
        z.object({ kind: z.literal('prompt'), id: z.string().min(1).max(256) }).strict(),
      ]),
      path: z.array(z.union([z.string().max(256), z.number().int().nonnegative()])).min(1).max(16),
    }).strict().safeParse(address);
    if (!parsed.success || !isInlineMediaAddress(parsed.data.source, parsed.data.path)) return { sessionExists: true };
    const entity = await readSessionViewCanonicalEntity(service, sessionId, { agentId: parts[1]!, ref: { source: parsed.data.source } });
    let selected: unknown = entity;
    for (const key of parsed.data.path) {
      if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) return { sessionExists: true };
      selected = (selected as Record<string | number, unknown>)[key];
    }
    const media = inlineToolMedia(selected);
    return { sessionExists: true, file: media === undefined || contentRevision(media.url) !== parts[3]
      ? undefined : await inlineDataMediaFile(media.url, `${parsed.data.source.id}.${media.kind}`) };
  }
  if (fileId.startsWith('inline:')) {
    const parts = fileId.split(':');
    if (service === undefined || parts.length !== 4 || !isPlainAgentId(parts[1]!) || !/^[A-Za-z0-9_-]+$/u.test(parts[2]!) || !/^[0-9a-f]{64}$/u.test(parts[3]!)) return { sessionExists: true };
    const attachmentId = Buffer.from(parts[2]!, 'base64url').toString('utf8');
    const entity = await readSessionViewCanonicalEntity(service, sessionId, { agentId: parts[1]!, ref: { source: { kind: 'attachment', id: attachmentId } } });
    const attachment = entity as TranscriptAttachment | undefined;
    return { sessionExists: true, file: attachment === undefined || inlineMediaId(attachment, parts[1]!) !== fileId ? undefined : await inlineMediaFile(attachment) };
  }
  if (fileId.startsWith('blobref:')) {
    const summary = await core.accessor.get(ISessionIndex).get(sessionId);
    return summary === undefined ? { sessionExists: false } : { sessionExists: true, file: await openPersistedToolMedia(core, sessionId, summary.workspaceId, fileId) };
  }
  const operation = await acquireSessionOperation(core, sessionId, 'operation');
  if (operation.handle === undefined) return { sessionExists: false, operation };
  try {
    const file = await operation.handle.accessor.get(ISessionMediaStore).open(fileId) ?? await openStagedUpload(core, fileId);
    return { sessionExists: true, file, operation };
  } catch (error) {
    await operation.dispose();
    throw error;
  }
}

async function openPersistedToolMedia(
  core: Scope,
  sessionId: string,
  workspaceId: string,
  fileId: string,
): Promise<SessionMediaFile | undefined> {
  const match = /^blobref:([A-Za-z0-9._-]{1,128}):([0-9a-f]{64})$/.exec(fileId);
  if (match === null || !isPlainAgentId(match[1]!)) return undefined;
  const sessionScope = sessionScopeOf(
    workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'), workspaceId),
    sessionId,
  );
  const blobs = core.accessor.get(IBlobStore);
  const scope = `${agentScopeOf(sessionScope, match[1]!)}/blobs`;
  const bytes = blobs.size === undefined ? await blobs.get(scope, match[2]!) : undefined;
  const size = blobs.size === undefined ? bytes?.byteLength : await blobs.size(scope, match[2]!);
  if (size === undefined) return undefined;
  return {
    name: 'tool-result.bin',
    mediaType: 'application/octet-stream',
    size,
    stream: bytes === undefined
      ? (range) => blobs.getStream(scope, match[2]!, range)
      : async function* (range) {
          yield range === undefined ? bytes : bytes.subarray(range.start, range.end + 1);
        },
  };
}

async function openStagedUpload(
  core: Scope,
  fileId: string,
): Promise<SessionMediaFile | undefined> {
  try {
    const uploaded = await core.accessor.get(IFileService).get(fileId);
    return {
      name: uploaded.meta.name,
      mediaType: uploaded.meta.media_type,
      size: uploaded.meta.size,
      stream: (range) => uploaded.stream(range),
    };
  } catch (error) {
    if (isFileError(error, FileErrors.codes.FILE_NOT_FOUND)) return undefined;
    throw error;
  }
}
