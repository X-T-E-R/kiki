import { Readable } from 'node:stream';

import multipart from '@fastify/multipart';

import {
  ErrorCodes,
  IFileService,
  Error2,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';

import { requestLog } from '../lib/requestLog';
import { buildContentDisposition } from '../lib/contentDisposition';
import { defineRoute } from '../middleware/defineRoute';
import { sendMappedError as dispatchMappedError, type MappedErrorSpec } from './_error';
import { ErrorCode, errEnvelope, okEnvelope } from '@kiki/protocol';
import {
  deleteFileParamSchema,
  deleteFileResponseSchema,
  getFileParamSchema,
  uploadFileResponseSchema,
} from '../protocol/rest-file';

interface FilesRouteHost {
  register(plugin: unknown, opts?: unknown): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: FastifyRequestLike, reply: FilesReply) => unknown,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: FastifyRequestLike, reply: FilesReply) => unknown,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: FastifyRequestLike, reply: FilesReply) => unknown,
  ): unknown;
}

interface FastifyRequestLike {
  id: string;
  params: unknown;
  headers: Record<string, string | string[] | undefined>;
  parts?: () => AsyncIterableIterator<MultipartPartLike>;
}

interface MultipartFieldLike {
  readonly type: 'field';
  readonly fieldname: string;
  readonly value: unknown;
}

interface MultipartFileLike {
  readonly type: 'file';
  readonly file: Readable;
  readonly fieldname: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly fields: Record<string, unknown>;
}

type MultipartPartLike = MultipartFieldLike | MultipartFileLike;

interface FilesReply {
  readonly raw?: {
    readonly destroyed?: boolean;
    once(event: 'close', listener: () => void): unknown;
    off?(event: 'close', listener: () => void): unknown;
  };
  type(mime: string): FilesReply;
  header(name: string, value: string | number): FilesReply;
  code(status: number): FilesReply;
  send(payload: unknown): unknown;
}

const DEFAULT_UPLOAD_MAX_CONCURRENCY = 8;
const DEFAULT_UPLOAD_MAX_QUEUE = 64;

function readPositiveIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function configuredUploadMaxConcurrency(): number {
  return readPositiveIntEnv('KIKI_FILES_UPLOAD_MAX_CONCURRENCY', DEFAULT_UPLOAD_MAX_CONCURRENCY, 1, 256);
}

function configuredUploadMaxQueue(): number {
  return readPositiveIntEnv('KIKI_FILES_UPLOAD_MAX_QUEUE', DEFAULT_UPLOAD_MAX_QUEUE, 0, 1024);
}

class UploadConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<{ readonly enter: () => void; readonly cancel: () => void }> = [];

  acquire(reply: FilesReply): Promise<(() => void) | 'rejected' | 'aborted'> {
    if (reply.raw?.destroyed === true) return Promise.resolve('aborted');
    const maxConcurrency = configuredUploadMaxConcurrency();
    const release = () => {
      this.active = Math.max(0, this.active - 1);
      while (this.active < configuredUploadMaxConcurrency() && this.waiters.length > 0) {
        const next = this.waiters.shift();
        if (next !== undefined) {
          this.active += 1;
          next.enter();
          return;
        }
      }
    };
    if (this.active < maxConcurrency) {
      this.active += 1;
      return Promise.resolve(release);
    }
    if (this.waiters.length >= configuredUploadMaxQueue()) {
      return Promise.resolve('rejected');
    }
    return new Promise((resolve) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve('aborted');
      };
      const waiter = {
        enter: () => {
          if (settled) {
            release();
            return;
          }
          settled = true;
          reply.raw?.off?.('close', onClose);
          resolve(release);
        },
        cancel: onClose,
      };
      this.waiters.push(waiter);
      reply.raw?.once('close', onClose);
    });
  }
}

export function registerFilesRoutes(app: FilesRouteHost, core: Scope): void {
  const uploadGate = new UploadConcurrencyGate();
  app.register(multipart, {
    limits: {
      fileSize: Number.MAX_SAFE_INTEGER,
      files: 1,
    },
  });

  const uploadRoute = defineRoute(
    {
      method: 'POST',
      path: '/files',
      success: { data: uploadFileResponseSchema },
      consumes: ['multipart/form-data'],
      description: 'Upload a file',
      tags: ['files'],
    },
    async (req, reply) => {
      const filesReply = reply as unknown as FilesReply;
      const lease = await uploadGate.acquire(filesReply);
      if (lease === 'aborted') return;
      if (lease === 'rejected') {
        filesReply.code(429).send(errEnvelope(42901, 'too_many_uploads', req.id));
        return;
      }
      let activeFileStream: Readable | undefined;
      try {
        const fastifyReq = req as unknown as FastifyRequestLike;
        const parts = fastifyReq.parts?.();
        if (parts === undefined) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'multipart not initialized', req.id));
          return;
        }
        let part: MultipartFileLike | undefined;
        while (part === undefined) {
          const next = await parts.next();
          if (next.done) break;
          if (next.value.type === 'file') part = next.value;
        }
        if (part === undefined) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'missing `file` field', req.id));
          return;
        }

        const filePart = part;
        activeFileStream = filePart.file;
        const source = Readable.from((async function* () {
          for await (const chunk of filePart.file) yield chunk;
          while (true) {
            const next = await parts.next();
            if (next.done) break;
            if (next.value.type === 'file') {
              for await (const chunk of next.value.file) {
                void chunk;
              }
            }
          }
        })());
        const store = core.accessor.get(IFileService);

        try {
          const meta = await store.save(source, filePart.filename, () => ({
            name: readFieldString(filePart.fields['name']) ?? filePart.filename,
            mimeType: filePart.mimetype,
            expiresInSec: readFieldNumber(filePart.fields['expires_in_sec']),
            sessionId: readFieldString(filePart.fields['session_id']),
          }));
          reply.send(okEnvelope(meta, req.id));
        } catch (error) {
          if (!filePart.file.destroyed) filePart.file.destroy();
          sendMappedError(filesReply, req, error);
        }
      } catch (error) {
        if (activeFileStream !== undefined && !activeFileStream.destroyed) activeFileStream.destroy();
        sendMappedError(filesReply, req, error);
      } finally {
        lease();
      }
    },
  );
  app.post(
    uploadRoute.path,
    uploadRoute.options,
    uploadRoute.handler as unknown as Parameters<FilesRouteHost['post']>[2],
  );

  const downloadRoute = defineRoute(
    {
      method: 'GET',
      path: '/files/{file_id}',
      params: getFileParamSchema,
      rawResponse: {
        200: { type: 'string', format: 'binary' },
      },
      errors: {
        [ErrorCode.FILE_NOT_FOUND]: {},
      },
      description: 'Download a file by ID',
      tags: ['files'],
    },
    async (req, reply) => {
      try {
        const { file_id } = req.params;
        const store = core.accessor.get(IFileService);
        const file = await store.get(file_id);
        const r = reply as unknown as FilesReply;
        const { meta } = file;
        const size = meta.size;
        r.type(meta.media_type)
          .header('content-disposition', buildContentDisposition(meta.name, meta.media_type))
          .header('accept-ranges', 'bytes')
          .header('etag', `"${meta.id}-${size}"`);

        const range = parseRange(
          readRangeHeader((req as unknown as FastifyRequestLike).headers['range']),
          size,
        );
        if (range) {
          r.header('content-range', `bytes ${range.start}-${range.end}/${size}`)
            .header('content-length', range.end - range.start + 1)
            .code(206);
          return r.send(file.stream(range)) as unknown as void;
        }

        r.header('content-length', size).code(200);
        return r.send(file.stream()) as unknown as void;
      } catch (error) {
        sendMappedError(reply as unknown as FilesReply, req, error);
        return;
      }
    },
  );
  app.get(
    downloadRoute.path,
    downloadRoute.options,
    downloadRoute.handler as unknown as Parameters<FilesRouteHost['get']>[2],
  );

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/files/{file_id}',
      params: deleteFileParamSchema,
      success: { data: deleteFileResponseSchema },
      description: 'Delete a file by ID',
      tags: ['files'],
    },
    async (req, reply) => {
      try {
        const { file_id } = req.params;
        const store = core.accessor.get(IFileService);
        await store.delete(file_id);
        requestLog(req)?.info({ file_id }, 'file deleted');
        reply.send(okEnvelope({ deleted: true as const }, req.id));
      } catch (error) {
        sendMappedError(reply as unknown as FilesReply, req, error);
      }
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as unknown as Parameters<FilesRouteHost['delete']>[2],
  );
}

const FILES_ERROR_SPEC: MappedErrorSpec = {
  custom: (err, requestId, reply) => {
    if (err instanceof Error2 && err.code === ErrorCodes.FILE_NOT_FOUND) {
      reply.code?.(404).send(errEnvelope(ErrorCode.FILE_NOT_FOUND, 'file not found', requestId));
      return true;
    }
    return false;
  },
  fallback: {
    logMessage: 'file request failed',
    httpStatus: 500,
    includeStack: false,
    nonErrorMessage: 'internal',
  },
};

function sendMappedError(reply: FilesReply, req: { id: string }, err: unknown): void {
  dispatchMappedError(reply, req, err, FILES_ERROR_SPEC);
}

const fieldValueSchema = z.object({ value: z.unknown() });

function readFieldString(field: unknown): string | undefined {
  const parsed = fieldValueSchema.safeParse(field);
  if (!parsed.success) return undefined;
  const v = parsed.data.value;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readFieldNumber(field: unknown): number | undefined {
  const parsed = fieldValueSchema.safeParse(field);
  if (!parsed.success) return undefined;
  const v = parsed.data.value;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return undefined;
}

function readRangeHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(header: string | undefined, size: number): ByteRange | undefined {
  if (!header || size <= 0) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return undefined;
  const startStr = m[1]!;
  const endStr = m[2]!;
  if (startStr === '' && endStr === '') return undefined;

  let start: number;
  let end: number;
  if (startStr === '') {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isFinite(start) || start < 0 || start >= size) return undefined;
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isFinite(end) || end < 0) return undefined;
  }
  if (start > end) return undefined;
  return { start, end: Math.min(end, size - 1) };
}
