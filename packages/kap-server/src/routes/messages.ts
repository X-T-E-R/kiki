import { join } from 'node:path';

import {
  Error2,
  IBootstrapService,
  IFileService,
  ISessionContext,
  ITelemetryService,
  ensureMainAgent,
  isError2,
  resumeSessionById,
  sessionMediaOriginalsDir,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import { messageRoleSchema } from '../protocol/message';
import {
  editMessageRequestSchema,
  getMessageResponseSchema,
  listMessagesResponseSchema,
  messageActionResponseSchema,
  regenerateMessageRequestSchema,
} from '../protocol/rest-message';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  assertPromptFileRefs,
  resolvePromptMediaFiles,
} from '../lib/promptMedia';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';
import {
  editAndResendMessage,
  regenerateMessage,
} from '../services/messages/messageActions';
import type { TranscriptService } from '../services/transcript/transcriptService';
import type { SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { projectPromptHandle } from './prompts';
import {
  getMessage,
  listMessages,
  MessageNotFoundError,
  SessionNotFoundError,
} from '../services/messages/messageHistory';

interface MessageRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface MessageRouteDeps {
  readonly core: Scope;
  readonly broadcaster: SessionEventBroadcaster;
  readonly transcriptService: TranscriptService;
}

const messagesListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    role: messageRoleSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const messageIdParamSchema = z.object({
  session_id: z.string().min(1),
  message_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

// --- Registration -----------------------------------------------------------

export function registerMessagesRoutes(app: MessageRouteHost, deps: MessageRouteDeps): void {
  const { core } = deps;
  // GET /sessions/{session_id}/messages --------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/messages',
      params: sessionIdParamSchema,
      querystring: messagesListQueryCoercion,
      success: { data: listMessagesResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List messages for a session',
      tags: ['messages'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const page = await listMessages(core, session_id, req.query);
        reply.send(okEnvelope(page, req.id));
      } catch (err) {
        sendMappedError(reply, req, err);
      }
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<MessageRouteHost['get']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/messages/{message_id}',
      params: messageIdParamSchema,
      success: { data: getMessageResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.MESSAGE_NOT_FOUND]: {},
      },
      description: 'Get a message by ID',
      tags: ['messages'],
    },
    async (req, reply) => {
      try {
        const { session_id, message_id } = req.params;
        const message = await getMessage(core, session_id, message_id);
        reply.send(okEnvelope(message, req.id));
      } catch (err) {
        sendMappedError(reply, req, err);
      }
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<MessageRouteHost['get']>[2],
  );

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/messages/{tail}',
      body: z.union([editMessageRequestSchema, regenerateMessageRequestSchema]),
      success: { data: messageActionResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: {},
        [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: {},
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
        [ErrorCode.MESSAGE_ACTION_UNAVAILABLE]: {},
        [ErrorCode.SESSION_CURSOR_MISMATCH]: {},
      },
      description: 'Edit-resend or regenerate a message',
      tags: ['messages'],
      operationId: 'messageAction',
    },
    async (req, reply) => {
      let preparedMedia: Awaited<ReturnType<typeof resolvePromptMediaFiles>> | undefined;
      let enqueued = false;
      try {
        const { session_id, tail } = req.params as { session_id: string; tail: string };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['edit', 'regenerate'] as const,
          resourceLabel: 'message',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const session = await resumeSessionById(core.accessor, session_id);
        if (session === undefined) throw new Error2('session.not_found', `session ${session_id} does not exist`);
        const agent = await ensureMainAgent(session);
        if (parsed.action === 'edit') {
          const body = editMessageRequestSchema.parse(req.body);
          await assertPromptFileRefs(body.content, core.accessor.get(IFileService));
          preparedMedia = await resolvePromptMediaFiles(
            body.content,
            core.accessor.get(IFileService),
            core.accessor.get(IBootstrapService).cacheDir,
            {
              telemetry: core.accessor.get(ITelemetryService).withContext({ sessionId: session_id }),
              resolveOriginalsDir: async () =>
                sessionMediaOriginalsDir(session.accessor.get(ISessionContext).sessionDir),
              resolveAttachmentsDir: async () =>
                join(session.accessor.get(ISessionContext).sessionDir, 'attachments'),
            },
          );
          const handle = await editAndResendMessage(
            deps,
            session,
            agent,
            parsed.id,
            body,
            preparedMedia.content,
          );
          enqueued = true;
          const staging = preparedMedia;
          void Promise.race([handle.launched, handle.completion]).then(
            () => staging?.discard(),
            () => staging?.discard(),
          );
          reply.send(okEnvelope(projectPromptHandle(handle), req.id));
          return;
        }
        const body = regenerateMessageRequestSchema.parse(req.body);
        const handle = await regenerateMessage(deps, session, agent, parsed.id, body);
        reply.send(okEnvelope(projectPromptHandle(handle), req.id));
      } catch (err) {
        if (!enqueued) await preparedMedia?.discard();
        sendMappedError(reply, req, err);
      }
    },
  );
  app.post(
    actionRoute.path,
    actionRoute.options,
    actionRoute.handler as Parameters<MessageRouteHost['post']>[2],
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
    return;
  }
  if (err instanceof MessageNotFoundError) {
    reply.send(errEnvelope(ErrorCode.MESSAGE_NOT_FOUND, err.message, requestId, err.stack));
    return;
  }
  if (isError2(err)) {
    const code = (() => {
      switch (err.code) {
        case 'session.not_found': return ErrorCode.SESSION_NOT_FOUND;
        case 'file.not_found': return ErrorCode.FILE_NOT_FOUND;
        case 'auth.provisioning_required': return ErrorCode.AUTH_PROVISIONING_REQUIRED;
        case 'auth.token_missing': return ErrorCode.AUTH_TOKEN_MISSING;
        case 'auth.token_unauthorized': return ErrorCode.AUTH_TOKEN_UNAUTHORIZED;
        case 'auth.model_not_resolved': return ErrorCode.AUTH_MODEL_NOT_RESOLVED;
        case 'session.busy': return ErrorCode.SESSION_BUSY;
        case 'session.undo_unavailable': return ErrorCode.SESSION_UNDO_UNAVAILABLE;
        case 'message.action_unavailable': return ErrorCode.MESSAGE_ACTION_UNAVAILABLE;
        case 'session.cursor_mismatch': return ErrorCode.SESSION_CURSOR_MISMATCH;
        case 'request.invalid':
        case 'validation.failed': return ErrorCode.VALIDATION_FAILED;
        default: return undefined;
      }
    })();
    if (code !== undefined) {
      reply.send({
        code,
        msg: err.message,
        data: null,
        request_id: requestId,
        details: err.details,
        stack: err.stack,
      });
      return;
    }
  }
  log?.error({ err }, 'message request failed');
  reply.send(
    errEnvelope(ErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : String(err), requestId, err instanceof Error ? err.stack : undefined),
  );
}
