import { IPersonaStore, type PersonaCardFormat, type PersonaImportPreview } from '@kiki/agent-core-v2/app/persona/personaStore';
import type { Scope } from '@kiki/agent-core-v2';
import {
  ErrorCode as ProtocolErrorCode,
  PERSONA_AVATAR_MAX_BYTES,
  personaArchiveInputSchema,
  personaAvatarUploadResponseSchema,
  personaAvatarDeleteResponseSchema,
  personaAvatarShapeSchema,
  personaCardFormatSchema,
  personaDeleteResponseSchema,
  personaDeleteQuerySchema,
  personaDuplicateInputSchema,
  personaIdParamsSchema,
  personaImportConfirmInputSchema,
  personaImportPreviewSchema,
  personaImportResponseSchema,
  personaListQuerySchema,
  personaPutInputSchema,
  personaSnapshotSchema,
  personaStateSchema,
  personaSummarySchema,
  personaExportQuerySchema,
} from '@kiki/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { buildContentDisposition } from '../lib/contentDisposition';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface PersonasRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string; params: unknown; query: unknown }, reply: PersonaReply) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string; params: unknown; body: unknown; file?: () => Promise<MultipartFileLike | undefined> }, reply: PersonaReply) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string; params: unknown; body: unknown; file?: () => Promise<MultipartFileLike | undefined> }, reply: PersonaReply) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string; params: unknown; query: unknown }, reply: PersonaReply) => Promise<void> | void,
  ): unknown;
}

interface PersonaReply {
  type(mime: string): PersonaReply;
  header(name: string, value: string | number): PersonaReply;
  code(status: number): PersonaReply;
  send(payload: unknown): unknown;
}

interface MultipartFileLike {
  file: NodeJS.ReadableStream;
  filename: string;
  mimetype: string;
  fields: Record<string, unknown>;
}

interface PersonaRequestFile {
  readonly data: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  readonly fields: Record<string, unknown>;
}

export function registerPersonasRoutes(app: PersonasRouteHost, core: Scope): void {
  const listRoute = defineRoute({
    method: 'GET',
    path: '/personas',
    querystring: personaListQuerySchema,
    success: { data: z.array(personaSummarySchema) },
    errors: {},
    description: 'List persona summaries',
    tags: ['personas'],
    operationId: 'listPersonas',
  }, async (req, reply) => {
    try {
      const items = await core.accessor.get(IPersonaStore).list(req.query);
      reply.send(okEnvelope(items, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.get(listRoute.path, listRoute.options, listRoute.handler as unknown as Parameters<PersonasRouteHost['get']>[2]);

  const previewImportRoute = defineRoute({
    method: 'POST',
    path: '/personas/import/preview',
    success: { data: personaImportPreviewSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.FILE_TOO_LARGE]: {} },
    consumes: ['multipart/form-data'],
    description: 'Preview a persona card without writing it',
    tags: ['personas'],
    operationId: 'previewPersonaImport',
  }, async (req, reply) => {
    try {
      const file = await readMultipartFile(req as unknown as { file?: () => Promise<MultipartFileLike | undefined> }, PERSONA_CARD_MAX_BYTES);
      const preview = await core.accessor.get(IPersonaStore).previewImport({
        data: file.data,
        format: resolveCardFormat(file.fields, file.filename, file.mimeType),
        filename: file.filename,
      });
      reply.send(okEnvelope(toWireImportPreview(preview), req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.post(previewImportRoute.path, previewImportRoute.options, previewImportRoute.handler as unknown as Parameters<PersonasRouteHost['post']>[2]);

  const importRoute = defineRoute({
    method: 'POST',
    path: '/personas/import',
    success: { data: personaImportResponseSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.FILE_TOO_LARGE]: {}, [ErrorCode.PERSONA_ALREADY_EXISTS]: {} },
    consumes: ['multipart/form-data'],
    description: 'Import a persona card after preview confirmation',
    tags: ['personas'],
    operationId: 'importPersonaCard',
  }, async (req, reply) => {
    try {
      const file = await readMultipartFile(req as unknown as { file?: () => Promise<MultipartFileLike | undefined> }, PERSONA_CARD_MAX_BYTES);
      const fields = readImportFields(file.fields);
      let result = await core.accessor.get(IPersonaStore).importCard({
        data: file.data,
        format: resolveCardFormat(file.fields, file.filename, file.mimeType),
        filename: file.filename,
      }, fields.id === undefined ? undefined : { id: fields.id });
      let snapshot = result.snapshot;
      if (fields.name !== undefined && fields.name !== snapshot.definition.name) {
        snapshot = await core.accessor.get(IPersonaStore).put({
          ...snapshot.definition,
          name: fields.name,
          examples: snapshot.examples,
          expectedRevision: snapshot.revision,
        });
      }
      reply.send(okEnvelope({ snapshot, memory: result.memory }, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.post(importRoute.path, importRoute.options, importRoute.handler as unknown as Parameters<PersonasRouteHost['post']>[2]);

  const exportRoute = defineRoute({
    method: 'GET',
    path: '/personas/{id}/export',
    params: personaIdParamsSchema,
    querystring: personaExportQuerySchema,
    rawResponse: { 200: { type: 'string', format: 'binary' } },
    errors: { [ErrorCode.PERSONA_NOT_FOUND]: {} },
    description: 'Export a persona card',
    tags: ['personas'],
    operationId: 'exportPersonaCard',
  }, async (req, reply) => {
    try {
      const exported = await core.accessor.get(IPersonaStore).exportCard(req.params.id, req.query.format, {
        includeMemory: req.query.includeMemory,
      });
      const filename = `${req.params.id}.${exported.format}`;
      const personaReply = reply as unknown as PersonaReply;
      personaReply.type(exported.mimeType)
        .header('content-disposition', buildContentDisposition(filename, exported.mimeType))
        .header('content-length', exported.data.byteLength)
        .send(Buffer.from(exported.data));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.get(exportRoute.path, exportRoute.options, exportRoute.handler as unknown as Parameters<PersonasRouteHost['get']>[2]);

  const avatarRoute = defineRoute({
    method: 'GET',
    path: '/personas/{id}/avatar',
    params: personaIdParamsSchema,
    rawResponse: { 200: { type: 'string', format: 'binary' } },
    errors: { [ErrorCode.PERSONA_NOT_FOUND]: {} },
    description: 'Read a persona avatar',
    tags: ['personas'],
    operationId: 'getPersonaAvatar',
  }, async (req, reply) => {
    try {
      const avatar = await core.accessor.get(IPersonaStore).getAvatar(req.params.id);
      const personaReply = reply as unknown as PersonaReply;
      if (avatar === undefined) {
        personaReply.code(404).send(errEnvelope(ErrorCode.PERSONA_NOT_FOUND, `persona ${req.params.id} has no avatar`, req.id));
        return;
      }
      personaReply.type(avatar.mimeType)
        .header('content-length', avatar.data.byteLength)
        .send(Buffer.from(avatar.data));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.get(avatarRoute.path, avatarRoute.options, avatarRoute.handler as unknown as Parameters<PersonasRouteHost['get']>[2]);

  const getRoute = defineRoute({
    method: 'GET',
    path: '/personas/{id}',
    params: personaIdParamsSchema,
    success: { data: personaSnapshotSchema },
    errors: { [ErrorCode.PERSONA_NOT_FOUND]: {} },
    description: 'Read one persona snapshot',
    tags: ['personas'],
    operationId: 'getPersona',
  }, async (req, reply) => {
    try {
      const snapshot = await core.accessor.get(IPersonaStore).get(req.params.id);
      if (snapshot === undefined) {
        reply.send(errEnvelope(ErrorCode.PERSONA_NOT_FOUND, `persona ${req.params.id} does not exist`, req.id));
        return;
      }
      reply.send(okEnvelope(snapshot, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.get(getRoute.path, getRoute.options, getRoute.handler as unknown as Parameters<PersonasRouteHost['get']>[2]);

  const putRoute = defineRoute({
    method: 'PUT',
    path: '/personas/{id}',
    params: personaIdParamsSchema,
    body: personaPutInputSchema,
    success: { data: personaSnapshotSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.PERSONA_ALREADY_EXISTS]: {}, [ErrorCode.PERSONA_REVISION_CONFLICT]: {} },
    description: 'Create or update one persona',
    tags: ['personas'],
    operationId: 'putPersona',
  }, async (req, reply) => {
    if (req.body.definition.id !== req.params.id) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'definition.id must match the persona path id', req.id));
      return;
    }
    try {
      const snapshot = await core.accessor.get(IPersonaStore).put({
        ...req.body.definition,
        examples: req.body.examples,
        expectedRevision: req.body.revision,
      });
      reply.send(okEnvelope(snapshot, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.put(putRoute.path, putRoute.options, putRoute.handler as unknown as Parameters<PersonasRouteHost['put']>[2]);

  const duplicateRoute = defineRoute({
    method: 'POST',
    path: '/personas/{id}([^:]+)::duplicate',
    params: personaIdParamsSchema,
    body: personaDuplicateInputSchema,
    success: { data: personaSnapshotSchema },
    errors: { [ErrorCode.PERSONA_NOT_FOUND]: {}, [ErrorCode.PERSONA_ALREADY_EXISTS]: {} },
    description: 'Duplicate a persona without its memory or runtime state',
    tags: ['personas'],
    operationId: 'duplicatePersona',
  }, async (req, reply) => {
    try {
      const snapshot = await core.accessor.get(IPersonaStore).duplicate(req.params.id, req.body);
      reply.send(okEnvelope(snapshot, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.post(duplicateRoute.path, duplicateRoute.options, duplicateRoute.handler as unknown as Parameters<PersonasRouteHost['post']>[2]);

  const archiveRoute = defineRoute({
    method: 'POST',
    path: '/personas/{id}([^:]+)::archive',
    params: personaIdParamsSchema,
    body: personaArchiveInputSchema,
    success: { data: personaStateSchema },
    errors: { [ErrorCode.PERSONA_NOT_FOUND]: {} },
    description: 'Archive or restore a persona',
    tags: ['personas'],
    operationId: 'archivePersona',
  }, async (req, reply) => {
    try {
      const state = await core.accessor.get(IPersonaStore).archive(req.params.id, req.body.archived);
      reply.send(okEnvelope(state, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.post(archiveRoute.path, archiveRoute.options, archiveRoute.handler as unknown as Parameters<PersonasRouteHost['post']>[2]);

  const deleteRoute = defineRoute({
    method: 'DELETE',
    path: '/personas/{id}',
    params: personaIdParamsSchema,
    querystring: personaDeleteQuerySchema,
    success: { data: personaDeleteResponseSchema },
    errors: { [ErrorCode.PERSONA_NOT_FOUND]: {}, [ErrorCode.PERSONA_REVISION_CONFLICT]: {} },
    description: 'Delete a persona and schedule its memory namespace removal',
    tags: ['personas'],
    operationId: 'deletePersona',
  }, async (req, reply) => {
    try {
      const result = await core.accessor.get(IPersonaStore).delete(req.params.id, req.query.expectedRevision);
      if (result.memory.status !== 'committed') {
        reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, result.memory.error ?? 'Persona memory deletion is incomplete; retry deletion', req.id));
        return;
      }
      reply.send(okEnvelope({ deleted: true as const, memory: result.memory }, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.delete(deleteRoute.path, deleteRoute.options, deleteRoute.handler as unknown as Parameters<PersonasRouteHost['delete']>[2]);

  const avatarUploadRoute = defineRoute({
    method: 'PUT',
    path: '/personas/{id}/avatar',
    params: personaIdParamsSchema,
    success: { data: personaAvatarUploadResponseSchema },
    errors: { [ErrorCode.PERSONA_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.FILE_TOO_LARGE]: {} },
    consumes: ['multipart/form-data'],
    description: 'Replace a persona avatar',
    tags: ['personas'],
    operationId: 'putPersonaAvatar',
  }, async (req, reply) => {
    try {
      const file = await readMultipartFile(req as unknown as { file?: () => Promise<MultipartFileLike | undefined> }, PERSONA_AVATAR_MAX_BYTES);
      const mimeType = normalizeAvatarMime(file.mimeType);
      if (mimeType === undefined) {
        (reply as unknown as PersonaReply).code(400).send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'avatar must be PNG, JPEG, or WebP', req.id));
        return;
      }
      const shape = personaAvatarShapeSchema.optional().safeParse(readMultipartField(file.fields['shape']));
      if (!shape.success) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'avatar shape must be circle or square', req.id));
        return;
      }
      const avatar = await core.accessor.get(IPersonaStore).putAvatar(req.params.id, {
        data: file.data,
        mimeType,
        shape: shape.data,
      });
      reply.send(okEnvelope({ id: req.params.id, mimeType: avatar.mimeType, size: avatar.data.byteLength, shape: avatar.shape }, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.put(avatarUploadRoute.path, avatarUploadRoute.options, avatarUploadRoute.handler as unknown as Parameters<PersonasRouteHost['put']>[2]);

  const avatarDeleteRoute = defineRoute({
    method: 'DELETE',
    path: '/personas/{id}/avatar',
    params: personaIdParamsSchema,
    success: { data: personaAvatarDeleteResponseSchema },
    errors: { [ErrorCode.PERSONA_NOT_FOUND]: {} },
    description: 'Remove a persona avatar',
    tags: ['personas'],
    operationId: 'deletePersonaAvatar',
  }, async (req, reply) => {
    try {
      const deleted = await core.accessor.get(IPersonaStore).deleteAvatar(req.params.id);
      reply.send(okEnvelope({ id: req.params.id, deleted }, req.id));
    } catch (error) {
      sendPersonaError(reply as unknown as PersonaReply, req.id, error);
    }
  });
  app.delete(avatarDeleteRoute.path, avatarDeleteRoute.options, avatarDeleteRoute.handler as unknown as Parameters<PersonasRouteHost['delete']>[2]);
}

const PERSONA_CARD_MAX_BYTES = 16 * 1024 * 1024;

async function readMultipartFile(
  request: { file?: () => Promise<MultipartFileLike | undefined> },
  maxBytes: number,
): Promise<PersonaRequestFile> {
  if (request.file === undefined) throw new Error('multipart file support is unavailable');
  const part = await request.file();
  if (part === undefined) throw new Error('missing `file` field');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of part.file as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    size += buffer.byteLength;
    if (size > maxBytes) throw Object.assign(new Error('uploaded file is too large'), { code: ErrorCode.FILE_TOO_LARGE });
    chunks.push(buffer);
  }
  return {
    data: new Uint8Array(Buffer.concat(chunks, size)),
    filename: part.filename,
    mimeType: part.mimetype,
    fields: part.fields,
  };
}

function readImportFields(fields: Record<string, unknown>): { readonly id?: string; readonly name?: string } {
  const id = readMultipartField(fields['id']);
  const name = readMultipartField(fields['name']);
  const parsed = personaImportConfirmInputSchema.safeParse({ id, name });
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues[0]?.message ?? 'invalid import fields'), { code: ErrorCode.VALIDATION_FAILED });
  return parsed.data;
}

function readMultipartField(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const field = (value as { readonly value?: unknown })['value'];
    return typeof field === 'string' ? field.trim() || undefined : undefined;
  }
  return undefined;
}

function resolveCardFormat(fields: Record<string, unknown>, filename: string, mimeType: string): PersonaCardFormat {
  const explicit = readMultipartField(fields['format']);
  const parsed = personaCardFormatSchema.safeParse(explicit);
  if (parsed.success) return parsed.data;
  if (mimeType === 'image/png' || filename.toLowerCase().endsWith('.png')) return 'png';
  if (filename.toLowerCase().endsWith('.charx')) return 'charx';
  return 'json';
}

function normalizeAvatarMime(mimeType: string): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp') return mimeType;
  return undefined;
}

function toWireImportPreview(preview: PersonaImportPreview) {
  return {
    format: preview.format,
    definition: preview.definition,
    examples: preview.examples,
    avatar: preview.avatar === undefined
      ? undefined
      : {
          data: preview.avatar.data,
          mimeType: preview.avatar.mimeType ?? preview.avatarMimeType ?? 'application/octet-stream',
        },
    avatarMimeType: preview.avatarMimeType,
    memoryEntries: preview.memoryEntries,
    ignoredFields: preview.ignoredFields,
    extensions: preview.extensions,
  };
}

function sendPersonaError(reply: PersonaReply, requestId: string, error: unknown): void {
  const code = personaErrorCode(error);
  const message = error instanceof Error ? error.message : 'persona request failed';
  if (code === ErrorCode.FILE_TOO_LARGE) {
    reply.code(413).send(errEnvelope(code, message, requestId));
    return;
  }
  if (code !== undefined) {
    reply.send(errEnvelope(code, message, requestId));
    return;
  }
  reply.code(500).send(errEnvelope(ErrorCode.INTERNAL_ERROR, message, requestId));
}

function personaErrorCode(error: unknown): number | undefined {
  const value = error as { code?: unknown };
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('persona not found')) return ErrorCode.PERSONA_NOT_FOUND;
  if (message.includes('revision conflict')) return ErrorCode.PERSONA_REVISION_CONFLICT;
  if (message.includes('avatar exceeds') || message.includes('uploaded file is too large')) return ErrorCode.FILE_TOO_LARGE;
  if (message.startsWith('avatar is not') || message.startsWith('avatar mime type') || message === 'missing `file` field') return ErrorCode.VALIDATION_FAILED;
  switch (value?.code) {
    case 'persona.not_found':
    case ProtocolErrorCode.PERSONA_NOT_FOUND:
      return ErrorCode.PERSONA_NOT_FOUND;
    case 'persona.already_exists':
    case ProtocolErrorCode.PERSONA_ALREADY_EXISTS:
      return ErrorCode.PERSONA_ALREADY_EXISTS;
    case 'persona.revision_conflict':
    case ProtocolErrorCode.PERSONA_REVISION_CONFLICT:
      return ErrorCode.PERSONA_REVISION_CONFLICT;
    case 'persona.validation_failed':
    case 'persona.import_invalid':
      return ErrorCode.VALIDATION_FAILED;
    case ErrorCode.FILE_TOO_LARGE:
      return ErrorCode.FILE_TOO_LARGE;
    default:
      return undefined;
  }
}
