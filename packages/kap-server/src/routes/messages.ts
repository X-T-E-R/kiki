import { join } from 'node:path';

import {
  Error2,
  IBootstrapService,
  IFileService,
  IAgentProfileService,
  ISessionContext,
  ITelemetryService,
  IWorkAdmissionService,
  ensureMainAgent,
  ISessionMediaStore,
  sessionMediaOriginalsDir,
  type Scope,
} from '@kiki/agent-core-v2';
import {
  ErrorCode,
  messageRoleSchema,
  editMessageRequestSchema,
  getMessageResponseSchema,
  listMessagesResponseSchema,
  messageActionResponseSchema,
  regenerateMessageRequestSchema,
} from '@kiki/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { sendMappedError as dispatchMappedError, type MappedErrorSpec } from './_error';
import {
  assertPromptFileRefs,
  resolvePromptMediaFiles,
  resolvePromptSessionMediaRefs,
  sessionPromptFiles,
} from '../lib/promptMedia';
import { publishedInlineMediaReader } from '../services/publishedMedia';
import { acquireSessionOperation, type SessionOperationLease } from '../lib/sessionOperationLease';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';
import {
  editAndResendMessage,
  regenerateMessage,
  replayMessageOperation,
} from '../services/messages/messageActions';
import type { TranscriptService } from '../services/transcript/transcriptService';
import type { SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { PROMPT_BODY_LIMIT_BYTES, projectPromptHandle } from './prompts';
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
    options: { preHandler: unknown[]; schema?: Record<string, unknown>; bodyLimit?: number } | undefined,
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
    order: z.enum(['asc', 'desc']).optional(),
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

export function registerMessagesRoutes(app: MessageRouteHost, deps: MessageRouteDeps): void {
  const { core } = deps;
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
    async (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      try {
        const { session_id } = req.params;
        const page = await listMessages(core, session_id, req.query, signal);
        if (signal.aborted) return;
        reply.send(okEnvelope(page, req.id));
      } catch (err) {
        if (signal.aborted) return;
        sendMappedError(reply, req, err);
      }
    }, req),
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
    async (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      try {
        const { session_id, message_id } = req.params;
        const message = await getMessage(core, session_id, message_id, signal);
        if (signal.aborted) return;
        reply.send(okEnvelope(message, req.id));
      } catch (err) {
        if (signal.aborted) return;
        sendMappedError(reply, req, err);
      }
    }, req),
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
        [ErrorCode.PROMPT_ID_CONFLICT]: {},
        [ErrorCode.WORK_ADMISSION_FENCED]: {},
      },
      description: 'Edit-resend or regenerate a message',
      tags: ['messages'],
      operationId: 'messageAction',
    },
    async (req, reply) => {
      let preparedMedia: Awaited<ReturnType<typeof resolvePromptMediaFiles>> | undefined;
      let lease: SessionOperationLease | undefined;
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
        lease = await acquireSessionOperation(core, session_id, 'operation');
        const session = lease.handle;
        if (session === undefined) throw new Error2('session.not_found', `session ${session_id} does not exist`);
        const agent = await ensureMainAgent(session);
        if (parsed.action === 'edit') {
          const body = editMessageRequestSchema.parse(req.body);
          const replay = await replayMessageOperation(agent, parsed.id, body);
          if (replay !== undefined) {
            reply.send(okEnvelope(projectPromptHandle(replay), req.id));
            return;
          }
          const sessionMedia = session.accessor.get(ISessionMediaStore);
          const files = sessionPromptFiles(core.accessor.get(IFileService), sessionMedia);
          await assertPromptFileRefs(body.content, files);
          const editedContent = await withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], (signal) => resolvePromptSessionMediaRefs(
            body.content,
            sessionMedia,
            publishedInlineMediaReader(core, deps.transcriptService, session_id, signal),
            files,
          ));
          preparedMedia = await resolvePromptMediaFiles(
            editedContent,
            files,
            core.accessor.get(IBootstrapService).cacheDir,
            {
              telemetry: core.accessor.get(ITelemetryService).withContext({ sessionId: session_id }),
              sessionMedia,
              providerType: agent.accessor.get(IAgentProfileService).getModelProviderType(),
              resolveOriginalsDir: async () =>
                sessionMediaOriginalsDir(session.accessor.get(ISessionContext).sessionDir),
              resolveAttachmentsDir: async () =>
                join(session.accessor.get(ISessionContext).sessionDir, 'attachments'),
            },
          );
          const handle = await core.accessor.get(IWorkAdmissionService).run(
            'http:messages.edit',
            () => editAndResendMessage(
              deps,
              session,
              agent,
              parsed.id,
              body,
              preparedMedia!.content,
            ),
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
        const replay = await replayMessageOperation(agent, parsed.id, body, 'regenerate');
        if (replay !== undefined) {
          reply.send(okEnvelope(projectPromptHandle(replay), req.id));
          return;
        }
        const handle = await core.accessor.get(IWorkAdmissionService).run(
          'http:messages.regenerate',
          () => regenerateMessage(deps, session, agent, parsed.id, body),
        );
        reply.send(okEnvelope(projectPromptHandle(handle), req.id));
      } catch (err) {
        if (!enqueued) await preparedMedia?.discard();
        sendMappedError(reply, req, err);
      } finally {
        await lease?.dispose();
      }
    },
  );
  app.post(
    actionRoute.path,
    { ...actionRoute.options, bodyLimit: PROMPT_BODY_LIMIT_BYTES },
    actionRoute.handler as Parameters<MessageRouteHost['post']>[2],
  );
}

const MESSAGES_ERROR_SPEC: MappedErrorSpec = {
  includeDetails: true,
  custom: (err, requestId, reply) => {
    if (err instanceof SessionNotFoundError) {
      reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
      return true;
    }
    if (err instanceof MessageNotFoundError) {
      reply.send(errEnvelope(ErrorCode.MESSAGE_NOT_FOUND, err.message, requestId, err.stack));
      return true;
    }
    return false;
  },
  codes: {
    'session.not_found': ErrorCode.SESSION_NOT_FOUND,
    'file.not_found': ErrorCode.FILE_NOT_FOUND,
    'auth.provisioning_required': ErrorCode.AUTH_PROVISIONING_REQUIRED,
    'auth.token_missing': ErrorCode.AUTH_TOKEN_MISSING,
    'auth.token_unauthorized': ErrorCode.AUTH_TOKEN_UNAUTHORIZED,
    'auth.model_not_resolved': ErrorCode.AUTH_MODEL_NOT_RESOLVED,
    'session.busy': ErrorCode.SESSION_BUSY,
    'session.undo_unavailable': ErrorCode.SESSION_UNDO_UNAVAILABLE,
    'message.action_unavailable': ErrorCode.MESSAGE_ACTION_UNAVAILABLE,
    'session.cursor_mismatch': ErrorCode.SESSION_CURSOR_MISMATCH,
    'prompt.id_conflict': ErrorCode.PROMPT_ID_CONFLICT,
    'work.admission_fenced': ErrorCode.WORK_ADMISSION_FENCED,
    'request.invalid': ErrorCode.VALIDATION_FAILED,
    'validation.failed': ErrorCode.VALIDATION_FAILED,
  },
  fallback: { logMessage: 'message request failed' },
};

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  dispatchMappedError(reply, req, err, MESSAGES_ERROR_SPEC);
}
