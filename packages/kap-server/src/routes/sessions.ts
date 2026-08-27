import {
  ErrorCodes,
  DEFAULT_AGENT_PROFILE_NAME,
  IAgentActivityView,
  IAgentContextMemoryService,
  IAgentProfileService,
  IAgentConversationUndoService,
  IAgentFullCompactionService,
  IAgentLoopService,
  IAgentLifecycleService,
  IAgentUsageService,
  IAuthSummaryService,
  ISessionActivityView,
  ISessionBtwService,
  ISessionContext,
  ISessionHistoryMutationService,
  ISessionIndex,
  ISessionMetadata,
  ISessionLegacyService,
  ISessionTitleService,
  IEventService,
  SessionCreated,
  IWorkspaceAliases,
  ISessionManager,
  IWorkspaceService,
  MAIN_AGENT_ID,
  getLiveSessionById,
  programForSession,
  resumeSessionById,
  isError2,
  Error2,
  type ContextMessage,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type Scope,
  type SessionSummary,
  type SessionUsageSummary,
} from '@moonshot-ai/agent-core-v2';
import { SessionMetaUpdated } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetaEvents';
import { toRestContextBreakdown } from '../protocol/context-usage';
import { ErrorCode } from '../protocol/error-codes';
import { pageResponseSchema } from '../protocol/pagination';
import { toProtocolMessage } from '../services/messages/messageProjection';
import {
  archiveSessionResponseSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionChildRequestSchema,
  createSessionRequestSchema,
  forkSessionRequestSchema,
  getSessionGoalResponseSchema,
  listSessionChildrenResponseSchema,
  sessionAbortResponseSchema,
  sessionStatusResponseSchema,
  sessionWarningsResponseSchema,
  startBtwSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
} from '../protocol/rest-session';
import {
  emptySessionUsage,
  sessionSchema,
  type Session,
  type SessionPendingInteraction,
  type SessionUsage,
} from '../protocol/session';
import { workspaceIdSchema } from '../protocol/workspace';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import {
  IModelPricingService,
  type ModelTokenUsage,
} from '../pricing/modelPricingService';
import { readLegacyStatus } from '../services/legacyStatus/legacyStatus';
import { loadMessageHistoryEntries } from '../services/messages/messageHistory';
import {
  assertCursor,
  assertSessionIdle,
  resolveForkMessageBoundary,
} from '../services/messages/messageActions';
import { ensureMainAgent } from '../transport/mainAgent';
import type { SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { parseActionSuffix } from './action-suffix';
import { applySessionAgentConfig } from './sessionAgentConfig';
import { updateSessionProfile } from './sessionProfile';

interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const booleanQueryParam = z.preprocess((value) => {
  if (value === 'true' || value === '1' || value === 1 || value === true) return true;
  if (value === 'false' || value === '0' || value === 0 || value === false) return false;
  return value;
}, z.boolean().optional());

const DEFAULT_SESSION_LIST_PAGE_SIZE = 20;

const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
    include_archive: booleanQueryParam,
    exclude_empty: booleanQueryParam,
    archived_only: booleanQueryParam,
    workspace_id: workspaceIdSchema.optional(),
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
    if (value.archived_only === true && value.include_archive === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'archived_only and include_archive are mutually exclusive',
        path: ['archived_only'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionChildrenListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
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

const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const sessionActionRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({
    title: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    instruction: z.string().optional(),
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
    through_message_id: z.string().min(1).optional(),
    expected_cursor: z.object({
      seq: z.number().int().nonnegative(),
      epoch: z.string().min(1),
    }).optional(),
  }),
);

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerSessionsRoutes(
  app: SessionRouteHost,
  core: Scope,
  broadcaster?: SessionEventBroadcaster,
): void {
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions',
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
      },
      description: 'Create a new session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const body = req.body;
      const callerCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
      const workspaceId = body.workspace_id;
      if (workspaceId === undefined && callerCwd === undefined) {
        reply.send(
          buildValidationEnvelope(
            [{ path: 'metadata.cwd', message: 'either workspace_id or metadata.cwd is required' }],
            req.id,
          ),
        );
        return;
      }

      const registry = core.accessor.get(IWorkspaceService);
      let workDir: string;
      if (workspaceId !== undefined) {
        const workspace = await registry.get(workspaceId);
        if (workspace === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspaceId} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if (callerCwd !== undefined && callerCwd !== workspace.root) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: 'metadata.cwd',
                  message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})`,
                },
              ],
              req.id,
            ),
          );
          return;
        }
        workDir = workspace.root;
      } else {
        workDir = callerCwd as string;
      }

      try {
        const touched = await registry.createOrTouch(workDir);
        const handle = await core.accessor.get(ISessionManager).create({
          workspaceId: touched.id,
          workDir,
          mainAgentBinding:
            body.agent_config?.model === undefined
              && body.agent_config?.profile === undefined
              && body.agent_config?.thinking === undefined
              ? undefined
              : {
                  profile: body.agent_config.profile ?? DEFAULT_AGENT_PROFILE_NAME,
                  model: body.agent_config.model,
                  thinking: body.agent_config.thinking,
                  strictThinking: body.agent_config.thinking !== undefined,
                },
        });
        if (typeof body.title === 'string') {
          await handle.accessor.get(ISessionMetadata).setTitle(body.title);
        }
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const session = toWireSession(
          { ...meta, workspaceId: touched.id },
          touched.root,
          resolveSessionFacts(core, meta.id),
        );
        core.accessor.get(IEventService).publish(
          new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions',
      querystring: sessionsListQueryCoercion,
      success: { data: pageResponseSchema(sessionSchema) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.SESSION_INDEX_BUILDING]: {},
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const raw = req.query;
      const archivedOnly = raw.archived_only === true;

      const workspaces = await core.accessor.get(IWorkspaceService).list();
      const roots = new Map(workspaces.map((w) => [w.id, w.root]));

      if (raw.workspace_id !== undefined && !roots.has(raw.workspace_id)) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${raw.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      const workspaceIds =
        raw.workspace_id === undefined
          ? undefined
          : await core.accessor.get(IWorkspaceAliases).resolveAliasIds(raw.workspace_id);
      const index = core.accessor.get(ISessionIndex);
      const includeArchived = archivedOnly ? true : raw.include_archive;

      interface Eligible {
        readonly summary: SessionSummary;
        readonly cwd: string;
        readonly facts?: SessionFacts;
      }

      const collect = async (pageSize: number): Promise<{ visible: Eligible[]; hasMore: boolean }> => {
        const wanted = pageSize + 1;
        const collected: Eligible[] = [];
        let before = raw.before_id;
        const after = raw.after_id;
        const afterCursor = after !== undefined ? await index.get(after) : undefined;
        const newerThanCursor = (summary: SessionSummary): boolean =>
          afterCursor === undefined ||
          summary.updatedAt > afterCursor.updatedAt ||
          (summary.updatedAt === afterCursor.updatedAt && summary.id > afterCursor.id);
        while (collected.length < wanted) {
          const page = await index.listRecent({
            workspaceIds,
            includeArchived,
            limit: wanted - collected.length,
            before,
            after: before === undefined ? after : undefined,
          });
          if (page.items.length === 0) break;
          let exhausted = false;
          for (const summary of page.items) {
            if (!newerThanCursor(summary)) {
              exhausted = true;
              break;
            }
            const cwd = summary.cwd ?? roots.get(summary.workspaceId);
            if (cwd === undefined) continue;
            if (raw.exclude_empty === true && (summary.lastPrompt ?? '').length === 0) continue;
            if (archivedOnly) {
              if (!summary.archived) continue;
              const facts = resolveSessionFacts(core, summary.id, summary.usage);
              if (raw.busy !== undefined && facts.busy !== raw.busy) continue;
              collected.push({ summary, cwd, facts });
            } else {
              collected.push({ summary, cwd });
            }
          }
          if (exhausted || page.nextCursor === undefined) break;
          before = page.nextCursor;
        }
        return { visible: collected.slice(0, pageSize), hasMore: collected.length > pageSize };
      };

      if (!archivedOnly && raw.page_size === undefined) {
        const page = await index.listRecent({
          workspaceIds,
          includeArchived,
          before: raw.before_id,
          after: raw.after_id,
        });
        const eligible: Eligible[] = [];
        for (const summary of page.items) {
          const cwd = summary.cwd ?? roots.get(summary.workspaceId);
          if (cwd === undefined) continue;
          if (raw.exclude_empty === true && (summary.lastPrompt ?? '').length === 0) continue;
          eligible.push({ summary, cwd });
        }
        const projected = eligible.map(({ summary, cwd }) =>
          toWireSession(
            summary,
            cwd,
            resolveSessionFacts(core, summary.id, summary.usage),
          ),
        );
        const items =
          raw.busy !== undefined
            ? projected.filter((session) => session.busy === raw.busy)
            : projected;
        reply.send(okEnvelope({ items, has_more: false }, req.id));
        return;
      }

      const pageSize = raw.page_size ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
      const { visible, hasMore } = await collect(pageSize);
      const projected = visible.map(({ summary, cwd, facts }) =>
        toWireSession(
          summary,
          cwd,
          facts ?? resolveSessionFacts(core, summary.id, summary.usage),
        ),
      );
      const items =
        raw.busy !== undefined && !archivedOnly
          ? projected.filter((session) => session.busy === raw.busy)
          : projected;
      reply.send(okEnvelope({ items, has_more: hasMore }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get a session by ID',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const cwd =
        summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(
          toWireSession(
            summary,
            cwd,
            resolveSessionFacts(core, session_id, summary.usage),
          ),
          req.id,
        ),
      );
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const getProfileRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session profile',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const cwd =
        summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(
          toWireSession(
            summary,
            cwd,
            resolveSessionFacts(core, session_id, summary.usage),
          ),
          req.id,
        ),
      );
    },
  );
  app.get(
    getProfileRoute.path,
    getProfileRoute.options,
    getProfileRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const updateProfileRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      body: updateSessionProfileRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Update session profile (title, metadata, agent_config)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const { agent_config, ...profileBody } = req.body;
        const fields = await updateSessionProfile(core, session_id, profileBody);
        if (agent_config !== undefined) {
          await applySessionAgentConfig(core, session_id, agent_config);
        }
        const session = toWireSession(fields, fields.root, resolveSessionFacts(core, fields.id));
        if (typeof req.body.title === 'string' && req.body.title.trim().length > 0) {
          core.accessor.get(IEventService).publish(
            new SessionMetaUpdated({
              payload: {
                agentId: 'main',
                sessionId: session_id,
                title: session.title,
                patch: { title: session.title, isCustomTitle: true },
              },
            }),
          );
        }
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const generateTitleRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/title/generate',
      params: sessionIdParamSchema,
      body: z.preprocess(
        (value) => (value === undefined ? {} : value),
        z.object({
          force: z.boolean().optional(),
          source: z.enum(['user_prompts', 'first_turn', 'digest']).optional(),
        }),
      ),
      success: { data: z.object({ title: z.string() }) },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_TITLE_UNAVAILABLE]: {},
      },
      description: 'Generate the session title via the managed chat_title tool',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const handle = await resumeSessionById(core.accessor, session_id);
        if (handle === undefined) {
          reply.send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} not found`, req.id),
          );
          return;
        }
        const title = await handle.accessor
          .get(ISessionTitleService)
          .generateTitle({ force: req.body.force === true, source: req.body.source });
        if (title === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SESSION_TITLE_UNAVAILABLE,
              'session title generation is unavailable (no managed OAuth login, no prompt yet, or the backend request failed)',
              req.id,
            ),
          );
          return;
        }
        reply.send(okEnvelope({ title }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    generateTitleRoute.path,
    generateTitleRoute.options,
    generateTitleRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      success: {
        data: z.union([
          sessionSchema,
          compactSessionResponseSchema,
          undoSessionResponseSchema,
          sessionAbortResponseSchema,
          startBtwSessionResponseSchema,
          archiveSessionResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.SESSION_LOCKED]: {},
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
        [ErrorCode.MESSAGE_ACTION_UNAVAILABLE]: {},
        [ErrorCode.SESSION_CURSOR_MISMATCH]: {},
      },
      description: 'Run a session action',
      tags: ['sessions'],
      operationId: 'runSessionAction',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['fork', 'compact', 'undo', 'abort', 'btw', 'archive', 'restore'] as const,
          resourceLabel: 'session',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(buildValidationEnvelope([{ path: 'session_id', message }], req.id));
          return;
        }

        const legacy = core.accessor.get(ISessionLegacyService);

        if (parsed.action === 'fork') {
          const body = forkSessionRequestSchema.parse(req.body);
          const forkHandler = await programForSession(core.accessor, parsed.id);
          if (forkHandler === undefined) {
            throw new Error2(
              ErrorCodes.SESSION_NOT_FOUND,
              `session ${parsed.id} does not exist`,
            );
          }
          let handle: ISessionScopeHandle;
          if (body.through_message_id === undefined) {
            handle = await core.accessor.get(ISessionManager).fork({
              sourceSessionId: parsed.id,
              title: body.title,
              metadata: body.metadata,
            });
          } else {
            if (broadcaster === undefined || body.expected_cursor === undefined) {
              throw new Error2(ErrorCodes.REQUEST_INVALID, 'Targeted fork is unavailable');
            }
            const source = await resumeSessionById(core.accessor, parsed.id);
            if (source === undefined) {
              throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
            }
            const gate = source.accessor.get(ISessionHistoryMutationService);
            const lease = await gate.acquire();
            try {
              await assertCursor(broadcaster, parsed.id, body.expected_cursor);
              assertSessionIdle(source);
              const entries = await loadMessageHistoryEntries(core, parsed.id);
              const boundary = resolveForkMessageBoundary(entries, body.through_message_id);
              handle = await core.accessor.get(ISessionManager).fork({
                sourceSessionId: parsed.id,
                title: body.title,
                metadata: body.metadata,
                turnIndex: boundary.turnIndex,
                throughUserMessage: boundary.throughUserMessage,
              });
            } finally {
              lease.dispose();
            }
          }
          const meta = await handle.accessor.get(ISessionMetadata).read();
          const ctx = handle.accessor.get(ISessionContext);
          const session = toWireSession(
            { ...meta, workspaceId: ctx.workspaceId },
            ctx.cwd,
            resolveSessionFacts(core, meta.id),
          );
          core.accessor.get(IEventService).publish(
            new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
          );
          requestLog(req)?.info(
            { session_id: parsed.id, action: 'fork', new_session_id: session.id },
            'session action completed',
          );
          reply.send(okEnvelope(session, req.id));
          return;
        }

        if (parsed.action === 'compact') {
          const body = compactSessionRequestSchema.parse(req.body);
          const agent = await resolveMainAgent(core, parsed.id);
          agent.accessor
            .get(IAgentFullCompactionService)
            .begin({ source: 'manual', instruction: normalizeOptional(body.instruction) });
          requestLog(req)?.info({ session_id: parsed.id, action: 'compact' }, 'session action completed');
          reply.send(okEnvelope({}, req.id));
          return;
        }

        if (parsed.action === 'undo') {
          const body = undoSessionRequestSchema.parse(req.body);
          const agent = await resolveMainAgent(core, parsed.id);
          await agent.accessor.get(IAgentConversationUndoService).undo(body.count);
          const history = agent.accessor.get(IAgentContextMemoryService).get();
          requestLog(req)?.info({ session_id: parsed.id, action: 'undo' }, 'session action completed');
          const [summary, status] = await Promise.all([
            core.accessor.get(ISessionIndex).get(parsed.id),
            legacy.status(parsed.id),
          ]);
          reply.send(
            okEnvelope(
              {
                messages: pageUndoMessages(
                  parsed.id,
                  summary?.createdAt ?? 0,
                  history,
                  body.page_size,
                ),
                status,
              },
              req.id,
            ),
          );
          return;
        }

        if (parsed.action === 'abort') {
          const agent = await resolveMainAgent(core, parsed.id);
          agent.accessor.get(IAgentLoopService).cancelFromUser();
          requestLog(req)?.info({ session_id: parsed.id, action: 'abort' }, 'session action completed');
          reply.send(okEnvelope({ aborted: true }, req.id));
          return;
        }

        if (parsed.action === 'btw') {
          const session = await resumeSessionById(core.accessor, parsed.id);
          if (session === undefined) {
            throw new Error2(
              ErrorCodes.SESSION_NOT_FOUND,
              `session ${parsed.id} does not exist`,
            );
          }
          await core.accessor.get(IAuthSummaryService).ensureReady();
          const agentId = await session.accessor.get(ISessionBtwService).start();
          reply.send(okEnvelope({ agent_id: agentId }, req.id));
          return;
        }

        if (parsed.action === 'restore') {
          const restoreHandler = await programForSession(core.accessor, parsed.id);
          const restored =
            restoreHandler === undefined
              ? undefined
              : await core.accessor.get(ISessionManager).restore(parsed.id);
          if (restored === undefined) {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
          }
          const meta = await restored.accessor.get(ISessionMetadata).read();
          const ctx = restored.accessor.get(ISessionContext);
          const session = toWireSession(
            { ...meta, workspaceId: ctx.workspaceId },
            ctx.cwd,
            resolveSessionFacts(core, meta.id),
          );
          requestLog(req)?.info({ session_id: parsed.id, action: 'restore' }, 'session action completed');
          reply.send(okEnvelope(session, req.id));
          return;
        }

        const archiveHandler = await programForSession(core.accessor, parsed.id);
        const archived =
          archiveHandler === undefined
            ? undefined
            : await core.accessor.get(ISessionManager).resume(parsed.id);
        if (archived === undefined || archiveHandler === undefined) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
        }
        await core.accessor.get(ISessionManager).archive(parsed.id);
        requestLog(req)?.info({ session_id: parsed.id, action: 'archive' }, 'session action completed');
        reply.send(okEnvelope({ archived: true }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    sessionActionRoute.path,
    sessionActionRoute.options,
    sessionActionRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const listChildrenRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      querystring: sessionChildrenListQueryCoercion,
      success: { data: listSessionChildrenResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List child sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const exists =
          getLiveSessionById(core.accessor, session_id) !== undefined ||
          (await core.accessor.get(ISessionIndex).get(session_id)) !== undefined;
        if (!exists) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
        }

        const pageSize = req.query.page_size ?? 100;
        const page = await core.accessor.get(ISessionIndex).listRecent({
          childOf: session_id,
          before: req.query.before_id,
          after: req.query.after_id,
          limit: pageSize + 1,
        });
        const window = page.items.slice(0, pageSize);

        const roots = new Map(
          (await core.accessor.get(IWorkspaceService).list()).map((w) => [w.id, w.root]),
        );
        const projected = window.map((summary) =>
          toWireSession(
            summary,
            summary.cwd ?? roots.get(summary.workspaceId) ?? '',
            resolveSessionFacts(core, summary.id, summary.usage),
          ),
        );
        const items =
          req.query.busy !== undefined
            ? projected.filter((session) => session.busy === req.query.busy)
            : projected;
        reply.send(okEnvelope({ items, has_more: page.nextCursor !== undefined }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    listChildrenRoute.path,
    listChildrenRoute.options,
    listChildrenRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const createChildRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      body: createSessionChildRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.SESSION_LOCKED]: {},
      },
      description: 'Create a child session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const childHandler = await programForSession(core.accessor, session_id);
        if (childHandler === undefined) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
        }
        const handle = await core.accessor.get(ISessionManager).createChild({
          sourceSessionId: session_id,
          title: req.body.title,
          metadata: req.body.metadata,
        });
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const ctx = handle.accessor.get(ISessionContext);
        const session = toWireSession(
          { ...meta, workspaceId: ctx.workspaceId },
          ctx.cwd,
          resolveSessionFacts(core, meta.id),
        );
        core.accessor.get(IEventService).publish(
          new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createChildRoute.path,
    createChildRoute.options,
    createChildRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const statusRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/status',
      params: sessionIdParamSchema,
      success: { data: sessionStatusResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get realtime session status (best-effort in this slice)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const status = await core.accessor.get(ISessionLegacyService).status(session_id);
        const live = getLiveSessionById(core.accessor, session_id);
        const main = live
          ?.accessor.get(IAgentLifecycleService)
          .list()
          .find((agent) => agent.id === MAIN_AGENT_ID);
        const breakdown = main === undefined ? undefined : readLegacyStatus(main)?.contextBreakdown;
        reply.send(
          okEnvelope(
            {
              ...status,
              context_breakdown:
                breakdown === undefined ? undefined : toRestContextBreakdown(breakdown),
            },
            req.id,
          ),
        );
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    statusRoute.path,
    statusRoute.options,
    statusRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const goalRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/goal',
      params: sessionIdParamSchema,
      success: { data: getSessionGoalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get the current session goal (null when none is active)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const goal = await core.accessor.get(ISessionLegacyService).goal(session_id);
        reply.send(okEnvelope(goal, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    goalRoute.path,
    goalRoute.options,
    goalRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const sessionWarningsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/warnings',
      params: sessionIdParamSchema,
      success: { data: sessionWarningsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session-level warnings (e.g. oversized AGENTS.md)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      try {
        const agent = await ensureMainAgent(session);
        const agentsMdWarning = agent.accessor.get(IAgentProfileService).getAgentsMdWarning();
        const warnings =
          agentsMdWarning === undefined
            ? []
            : [
                {
                  code: 'agents-md-oversized',
                  message: agentsMdWarning,
                  severity: 'warning' as const,
                },
              ];
        reply.send(okEnvelope({ warnings }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    sessionWarningsRoute.path,
    sessionWarningsRoute.options,
    sessionWarningsRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}

export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export function toWireSession(
  fields: SessionWireFields,
  cwd: string,
  facts: SessionFacts,
): Session {
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    archived_at:
      fields.archivedAt === undefined ? undefined : new Date(fields.archivedAt).toISOString(),
    busy: facts.busy,
    main_turn_active: facts.mainTurnActive,
    pending_interaction: facts.pendingInteraction,
    last_turn_reason:
      facts.lastTurnReason ?? (facts.live === false ? fields.lastTurnReason : undefined),
    archived: fields.archived,
    last_prompt: fields.lastPrompt,
    metadata: buildWireMetadata(fields.custom, cwd),
    agent_config: facts.agentConfig ?? { model: '' },
    usage: facts.usage ?? emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

/** Live activity and interaction facts projected onto the wire `Session`. */
export interface SessionFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly agentConfig?: Session['agent_config'];
  readonly usage?: SessionUsage;
  /** False when no live handle exists (cold session); live warm sessions
   *  always report their own outcome, never the persisted fallback. */
  readonly live?: boolean;
}

/**
 * Resolve a session's live wire facts from the core `ISessionActivityView`
 * aggregate (`busy` = any agent with an active turn or background task; the
 * reason is the main agent's latest turn outcome, `blocked` folds into
 * `failed`). A cold session (no live handle) is not busy and carries no
 * outcome.
 */
export function resolveSessionFacts(
  core: Scope,
  sessionId: string,
  persistedUsage?: SessionUsageSummary,
): SessionFacts {
  const handle = getLiveSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    return {
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
      usage:
        persistedUsage === undefined
          ? undefined
          : readPersistedSessionUsage(
              persistedUsage,
              core.accessor.get(IModelPricingService),
            ),
      live: false,
    };
  }
  const agents = handle.accessor.get(IAgentLifecycleService).list();
  const main = agents.find((agent) => agent.id === MAIN_AGENT_ID);
  const sessionUsage = handle.accessor.get(ISessionMetadata).usage() ?? persistedUsage;
  const profile = main?.accessor.get(IAgentProfileService).data();
  return {
    ...handle.accessor.get(ISessionActivityView).state(),
    agentConfig: profile === undefined
      ? undefined
      : { model: profile.modelAlias ?? '', profile: profile.profileName },
    usage:
      main === undefined
        ? undefined
        : readSessionUsage(
            main,
            agents,
            core.accessor.get(IModelPricingService),
            sessionUsage,
          ),
    live: true,
  };
}

interface MutableModelTokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

function addModelUsage(
  target: Map<string, MutableModelTokenUsage>,
  byModel: Readonly<Record<string, ModelTokenUsage>> | undefined,
): void {
  if (byModel === undefined) return;
  for (const [model, modelUsage] of Object.entries(byModel)) {
    const accumulated = target.get(model) ?? {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };
    accumulated.inputOther += modelUsage.inputOther ?? 0;
    accumulated.output += modelUsage.output ?? 0;
    accumulated.inputCacheRead += modelUsage.inputCacheRead ?? 0;
    accumulated.inputCacheCreation += modelUsage.inputCacheCreation ?? 0;
    target.set(model, accumulated);
  }
}

function applyModelPricing(
  usage: SessionUsage,
  byModel: ReadonlyMap<string, MutableModelTokenUsage>,
  pricing: IModelPricingService,
): void {
  const tokensByModel: Record<string, number> = {};
  const costByModel: Record<string, number> = {};
  const unknownModels: string[] = [];
  for (const [model, modelUsage] of byModel) {
    tokensByModel[model] =
      modelUsage.inputOther +
      modelUsage.output +
      modelUsage.inputCacheRead +
      modelUsage.inputCacheCreation;
    const cost = pricing.calculate(model, modelUsage);
    if (cost === undefined) {
      unknownModels.push(model);
    } else {
      costByModel[model] = cost;
      usage.total_cost_usd += cost;
    }
  }
  usage.tokens_by_model = Object.keys(tokensByModel).length === 0 ? undefined : tokensByModel;
  usage.by_model = Object.keys(costByModel).length === 0 ? undefined : costByModel;
  usage.cost_unknown_models =
    unknownModels.length === 0 ? undefined : unknownModels.toSorted();
}

function readPersistedSessionUsage(
  persisted: SessionUsageSummary | undefined,
  pricing: IModelPricingService,
): SessionUsage | undefined {
  if (persisted === undefined) return undefined;
  const byModel = new Map<string, MutableModelTokenUsage>();
  addModelUsage(byModel, persisted.byModel);
  const usage: SessionUsage = {
    input_tokens: persisted.total.inputOther,
    output_tokens: persisted.total.output,
    cache_read_tokens: persisted.total.inputCacheRead,
    cache_creation_tokens: persisted.total.inputCacheCreation,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  };
  applyModelPricing(usage, byModel, pricing);
  return usage;
}

function readSessionUsage(
  main: IAgentScopeHandle,
  agents: readonly IAgentScopeHandle[],
  pricing: IModelPricingService,
  persisted?: SessionUsageSummary,
): SessionUsage | undefined {
  try {
    const status = readLegacyStatus(main);
    if (status === undefined) return undefined;
    const total = persisted?.total ?? status.usage?.total;
    const byModel = new Map<string, MutableModelTokenUsage>();
    addModelUsage(byModel, persisted?.byModel ?? status.usage?.byModel);
    const activity = main.accessor.get(IAgentActivityView).state();
    const latestTurnId = activity.turn?.turnId ?? activity.lastTurn?.turnId;
    const usage: SessionUsage = {
      input_tokens: total?.inputOther ?? 0,
      output_tokens: total?.output ?? 0,
      cache_read_tokens: total?.inputCacheRead ?? 0,
      cache_creation_tokens: total?.inputCacheCreation ?? 0,
      total_cost_usd: 0,
      context_tokens: status.contextTokens,
      context_limit: status.maxContextTokens ?? 0,
      turn_count: latestTurnId === undefined ? 0 : latestTurnId + 1,
    };
    if (persisted === undefined) {
      for (const agent of agents) {
        if (agent.id === MAIN_AGENT_ID) continue;
        try {
          const agentStatus = agent.accessor.get(IAgentUsageService).status();
          const agentTotal = agentStatus.total;
          usage.input_tokens += agentTotal?.inputOther ?? 0;
          usage.output_tokens += agentTotal?.output ?? 0;
          usage.cache_read_tokens += agentTotal?.inputCacheRead ?? 0;
          usage.cache_creation_tokens += agentTotal?.inputCacheCreation ?? 0;
          addModelUsage(byModel, agentStatus.byModel);
        } catch {}
      }
    }

    applyModelPricing(usage, byModel, pricing);
    return usage;
  } catch {
    return undefined;
  }
}

async function resolveMainAgent(core: Scope, sessionId: string): Promise<IAgentScopeHandle> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return ensureMainAgent(session);
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

function pageUndoMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  history: readonly ContextMessage[],
  requestedPageSize: number | undefined,
): { items: ReturnType<typeof toProtocolMessage>[]; has_more: boolean } {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

function buildWireMetadata(
  custom: Record<string, unknown> | undefined,
  cwd: string,
): { cwd: string; [key: string]: unknown } {
  if (custom === undefined) return { cwd };
  const { goal: _drop, ...rest } = custom as { goal?: unknown; [key: string]: unknown };
  return { ...rest, cwd };
}

function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'session.fork_active_turn':
      case ErrorCodes.SESSION_BUSY:
        reply.send({
          code: ErrorCode.SESSION_BUSY,
          msg: err.message,
          data: null,
          request_id: requestId,
          details: err.details,
          stack: err.stack,
        });
        return;
      case ErrorCodes.STORAGE_LOCKED:
        reply.send(errEnvelope(ErrorCode.SESSION_LOCKED, err.message, requestId, err.stack));
        return;
      case 'compaction.unable':
        reply.send(errEnvelope(ErrorCode.COMPACTION_UNABLE, err.message, requestId, err.stack));
        return;
      case 'session.undo_unavailable':
        reply.send({
          code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
          msg: err.message,
          data: (err as { details?: unknown }).details ?? null,
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case 'message.action_unavailable':
      case 'session.cursor_mismatch':
        reply.send({
          code: err.code === 'message.action_unavailable'
            ? ErrorCode.MESSAGE_ACTION_UNAVAILABLE
            : ErrorCode.SESSION_CURSOR_MISMATCH,
          msg: err.message,
          data: null,
          request_id: requestId,
          details: err.details,
          stack: err.stack,
        });
        return;
      case ErrorCodes.GOAL_ALREADY_EXISTS:
        reply.send(errEnvelope(ErrorCode.GOAL_ALREADY_EXISTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.GOAL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_STATUS_INVALID:
        reply.send(errEnvelope(ErrorCode.GOAL_STATUS_INVALID, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_NOT_RESUMABLE:
        reply.send(errEnvelope(ErrorCode.GOAL_NOT_RESUMABLE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_OBJECTIVE_EMPTY:
        reply.send(errEnvelope(ErrorCode.GOAL_OBJECTIVE_EMPTY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_OBJECTIVE_TOO_LONG:
        reply.send(
          errEnvelope(ErrorCode.GOAL_OBJECTIVE_TOO_LONG, err.message, requestId, err.stack),
        );
        return;
      case ErrorCodes.FS_PATH_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'request.invalid':
      case 'validation.failed':
      case ErrorCodes.CONFIG_INVALID:
      case ErrorCodes.MODEL_NOT_CONFIGURED:
      case ErrorCodes.MODEL_CONFIG_INVALID:
      case ErrorCodes.THINKING_ALIAS_CONFLICT:
      case ErrorCodes.PROFILE_UNKNOWN:
      case ErrorCodes.ROUTE_BINDING_CONFLICT:
      case ErrorCodes.ROUTE_MODEL_ALIAS_MISSING:
      case ErrorCodes.ROUTE_SWITCH_FORBIDDEN:
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
    }
  }
  log?.error({ err }, 'session request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}
