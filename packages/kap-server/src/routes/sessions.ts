import { randomUUID } from 'node:crypto';
import { materializeAdhocModel } from '@kiki/agent-core-v2/session/adhocEndpoint/adhocEndpointRuntime';
import { readPersistedAgentRuntimeFacts } from '@kiki/agent-core-v2/session/agentRuntimeFacts';
import { PersistedGoalReader } from '@kiki/agent-core-v2/agent/goal/goalRead';
import { DEFAULT_PLAN_CONFIG, PLAN_SECTION, type PlanConfig } from '@kiki/agent-core-v2/features/plan/configSection';
import { planKey } from '@kiki/agent-core-v2/features/plan/planOps';
import { logicalByteSize } from '@kiki/agent-core-v2/persistence/coldSegmentLog';
import { TOKEN_COUNTING_SECTION, type TokenCountingConfig } from '@kiki/agent-core-v2/agent/tokenCounting/configSection';
import { modelWithUsage } from '@kiki/agent-core-v2/kosong/model/parameters';
import { mergeModelParameters, resolveModelProfileEntry } from '@kiki/agent-core-v2/app/agentProfileCatalog/modelProfileOverlay';
import {
  drivesThinkingThroughTraits,
  requiresStrictThinkingValidation,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  type ThinkingConfig,
} from '@kiki/agent-core-v2/kosong/model/thinking';
import { THINKING_SECTION } from '@kiki/agent-core-v2/app/kosongConfig/configSection';
import type { ThinkingEffort } from '@kiki/agent-core-v2/kosong/contract/provider';
import { persistedAgentContextLimit } from './persistedAgentContext';
import { readColdSessionMeta } from '../services/snapshot/coldSessionMeta';
import { isExternalClientMain } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { canonicalWorkspaceRoot } from '@kiki/agent-core-v2/_base/utils/paths';
import { IBotService } from '@kiki/agent-core-v2/app/bot/bot';
import { IPersonaStore } from '@kiki/agent-core-v2/app/persona/personaStore';
import type { AgentMeta, SessionForkedFrom, SessionMeta, SessionPromotedFrom } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { NegotiatedExecutorCapabilities } from '@kiki/agent-core-v2/app/agentExecutor/capabilities';
import { PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET, readPersistedAgentProfileSnapshot } from '@kiki/agent-core-v2/session/agentProfileSnapshot';
import { ISessionDeliveryService } from '@kiki/agent-core-v2/session/delivery/delivery';
import { resolveEffectiveSessionModel } from '@kiki/agent-core-v2/app/sessionLegacy/sessionModel';
import { loadAgentsMdDetailed } from '@kiki/agent-core-v2/agent/profile/context';
import { resolveSpaceInheritance } from '@kiki/agent-core-v2/app/bootstrap/spaceInheritance';
import { ISessionInstructionsProvider } from '@kiki/agent-core-v2/session/sessionInstructions/instructionsProvider';
import { readSessionCursorSeq } from '../lib/sessionObserver';
import { resolveSessionPersonaId } from './sessionPersona';
import { resolveSessionModelBinding } from '@kiki/agent-core-v2/app/sessionLegacy/sessionLegacyService';
import { createUnscopedAgentProfileCatalog } from '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/unscopedAgentProfileCatalog';
import { IInstantiationService } from '@kiki/agent-core-v2/_base/di/instantiation';
import { rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ErrorCodes,
  DEFAULT_AGENT_PROFILE_NAME,
  IAgentProfileRegistry,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentStateService,
  IAppendLogStore,
  IAtomicDocumentStore,
  IBootstrapService,
  IConfigService,
  ICpuWorkerService,
  IFileSystemStorageService,
  IHostFileSystem,
  IModelCatalog,
  IProtocolAdapterRegistry,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  AGENT_PROFILE_SOURCE_PRIORITY,
  SKILL_SOURCE_PRIORITY,
  IAgentActivityView,
  IAgentContextMemoryService,
  IAgentProfileService,
  IAgentConversationUndoService,
  IAgentFullCompactionService,
  IAgentLoopService,
  IAgentExecutionService,
  IAgentLifecycleService,
  IAgentUsageService,
  ILogService,
  IModelService,
  ISessionActivityView,
  ISessionAgentProfileCatalog,
  SessionAgentProfileCatalogService,
  ISessionBranchService,
  ISessionBtwService,
  ISessionContext,
  ISessionIndex,
  ISessionMetadata,
  ISessionLegacyService,
  ISessionSkillCatalog,
  SessionSkillCatalogService,
  ISessionTitleService,
  IEventService,
  SessionCreated,
  IWorkspaceAliases,
  ISessionManager,
  ISessionHistoryMutationService,
  IWorkspaceInstanceManager,
  IWorktreeService,
  IWorkspaceService,
  IWorkspacePersistence,
  MAIN_AGENT_ID,
  ProfileError,
  getLiveSessionById,
  programForSession,
  restoreColdSession,
  setSessionArchivedBatch,
  updateColdSessionProfile,
  archiveSessionFamily,
  isError2,
  Error2,
  type ContextMessage,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type Scope,
  type SessionSummary,
  type SessionUsageSummary,
  type UsageFactTotals,
  type Workspace,
} from '@kiki/agent-core-v2';
import { SessionMetaUpdated } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetaEvents';
import { FORKED_FROM_KEY, forkedFromOf, PROMOTED_FROM_KEY, promotedFromOf } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { workspaceRootKey } from '@kiki/agent-core-v2/_base/utils/workdir-slug';
import { toErrorMessage } from '@kiki/agent-core-v2/_base/errors/errorMessage';
import {
  deleteArchivedSessionRequestSchema,
  deleteArchivedSessionsResponseSchema,
  worktreeRemovalOutcomeSchema,
  sessionCreationStatusSchema,
  toRestContextBreakdown,
  ErrorCode,
  pageResponseSchema,
  archiveSessionResponseSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionBranchRequestSchema,
  createSessionBranchResponseSchema,
  createSessionChildRequestSchema,
  createSessionRequestSchema,
  discardSessionBranchRequestSchema,
  discardSessionBranchResponseSchema,
  foldSessionBranchRequestSchema,
  foldSessionBranchResponseSchema,
  forkSessionRequestSchema,
  getSessionGoalResponseSchema,
  listSessionChildrenResponseSchema,
  sessionAbortResponseSchema,
  sessionStatusResponseSchema,
  sessionWarningsResponseSchema,
  setSessionBranchToolsLockRequestSchema,
  setSessionBranchToolsLockResponseSchema,
  startBtwSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
  emptySessionUsage,
  sessionSchema,
  workspaceIdSchema,
  type Session,
  type SessionPendingInteraction,
  type SessionUsage,
  type SessionUsageError,
} from '@kiki/protocol';
import { deleteArchivedSessions } from '../services/archivedSessionDeletion';
import { toProtocolMessage } from '../services/messages/messageProjection';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { sendMappedError as dispatchMappedError } from './_error';
import { requestLog } from '../lib/requestLog';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { acquireSessionOperation, withSessionOperation } from '../lib/sessionOperationLease';
import { ensureSessionAgent } from '../lib/sessionAgent';
import { ensurePromptAuthReady } from '../lib/promptAuth';
import { defineRoute } from '../middleware/defineRoute';
import {
  IModelPricingService,
  type ModelTokenUsage,
} from '../pricing/modelPricingService';
import { readLegacyStatus } from '../services/legacyStatus/legacyStatus';
import { usageRuntime } from '../usage/usageRuntime';
import type { LeaseRegistry } from '../services/leaseRegistry';
import { loadMessageHistoryEntries } from '../services/messages/messageHistory';
import {
  assertCursor, resolveForkMessageBoundary,
} from '../services/messages/messageActions';
import { ensureMainAgent } from '../transport/mainAgent';
import type { SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { parseActionSuffix } from './action-suffix';
import { applyAgentRuntimeControls, applySessionAgentConfig } from './sessionAgentConfig';
import { updateSessionProfile } from './sessionProfile';
import { registerPersonaSettingsRoutes } from './personaSettings';
import { boundedListPreview } from '../transport/klient/boundedContent';
import { jsonBytes } from '@kiki/transcript';
import {
  SessionCreateReceiptError,
  SessionCreateReceiptStore,
  sessionCreateConnectionScope,
} from '../services/sessionCreateReceipt';
import { AdmissionError } from '../services/connections/admission';
import { peerAudience } from '../services/connections/audience';
import { webPrincipal } from '../services/webAccess';

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

const DEFAULT_SESSION_LIST_PAGE_SIZE = 50;

const SESSION_PIN_METADATA_KEY = 'kiki.pinned';

function sessionMatchesPrivacy(
  isPrivate: boolean | undefined,
  query: { readonly include_private?: boolean; readonly private_only?: boolean; readonly persona?: string },
): boolean {
  const includePrivate = query.private_only === true
    || query.include_private === true
    || (query.include_private === undefined && query.persona !== undefined);
  return (includePrivate || isPrivate !== true) && (query.private_only !== true || isPrivate === true);
}

const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
    include_archive: booleanQueryParam,
    include_ephemeral: booleanQueryParam,
    include_private: booleanQueryParam,
    exclude_empty: booleanQueryParam,
    archived_only: booleanQueryParam,
    private_only: booleanQueryParam,
    pinned: booleanQueryParam,
    q: z.string().max(500).optional(),
    workspace_id: workspaceIdSchema.optional(),
    persona: z.string().min(1).optional(),
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
    if (value.private_only === true && value.include_private === false) {
      ctx.addIssue({
        code: 'custom',
        message: 'private_only and include_private are mutually exclusive',
        path: ['private_only'],
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
    seed: z.enum(['fresh', 'compact', 'verbatim']).optional(),
    carry: z.union([
      z.object({ last: z.number().int().nonnegative() }).strict(),
      z.object({ fromMessageId: z.string().min(1) }).strict(),
    ]).optional(),
    include_attached: z.boolean().optional(),
    exclude_session_ids: z.array(z.string().min(1)).max(100_000).optional(),
    instruction: z.string().optional(),
    strategy: z.enum(['summarize', 'relay']).optional(),
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
    through_message_id: z.string().min(1).optional(),
    expected_cursor: z.object({
      seq: z.number().int().nonnegative(),
      epoch: z.string().min(1),
    }).optional(),
    agent_id: z.string().min(1).optional(),
    parent_agent_id: z.string().min(1).optional(),
    task: z.string().optional(),
    prompt: z.string().optional(),
    model: z.string().min(1).optional(),
    thinking: z.string().min(1).optional(),
    executor: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    tools_locked: z.boolean().optional(),
    branch_id: z.string().min(1).optional(),
    summary: z.string().optional(),
    context: z.string().optional(),
    asks: z.array(z.string().min(1)).optional(),
    done: z.boolean().optional(),
    locked: z.boolean().optional(),
  }),
);

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const sessionSourceOverlaySchema = z.strictObject({
  lease_id: z.string().min(1),
  agent_files: z.array(z.string().min(1)).default([]),
  skill_dirs: z.array(z.string().min(1)).default([]),
});
const sessionSourceOverlayResponseSchema = z.object({
  profiles: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
});

async function removeUnusedAutoWorkspace(
  core: Scope,
  root: string,
  registered: Workspace | undefined,
): Promise<void> {
  const registry = core.accessor.get(IWorkspaceService);
  if (registered !== undefined) {
    const current = await registry.get(registered.id);
    if (
      current === undefined
      || workspaceRootKey(current.root) !== workspaceRootKey(root)
      || current.createdAt !== registered.createdAt
      || current.lastOpenedAt !== registered.lastOpenedAt
      || current.name !== registered.name
      || current.pinned
    ) return;
    if (core.accessor.get(ISessionManager).list().some(
      (session) => session.accessor.get(ISessionContext).workspaceId === registered.id,
    )) return;
    if (core.accessor.get(IWorkspaceInstanceManager).referenceCount(registered.id) > 0) return;
    if (await core.accessor.get(ISessionIndex).count({
      workspaceIds: [registered.id],
      includeArchived: true,
    }) > 0) return;
  }
  try {
    await rmdir(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
    if (code !== 'ENOENT') throw error;
  }
  if (registered !== undefined) await registry.delete(registered.id);
}

export function registerSessionsRoutes(
  app: SessionRouteHost,
  core: Scope,
  broadcaster: SessionEventBroadcaster | undefined,
  onWorkspaceServed: ((workspace: string) => void | Promise<void>) | undefined,
  leaseRegistry: LeaseRegistry,
  externalClients?: import('../externalClients/host').ExternalClientHost,
): void {
  registerPersonaSettingsRoutes(app, core);
  const overlayResourcesBySession = new Map<string, Set<string>>();
  const pendingOverlayCleanups = new Set<Promise<void>>();
  const createReceipts = new SessionCreateReceiptStore(core);
  const creationStatusRoute = defineRoute({
    method: 'GET', path: '/sessions/creation/:creation_id',
    params: z.object({ creation_id: z.string().uuid().transform((value) => value.toLowerCase()) }),
    success: { data: sessionCreationStatusSchema },
    errors: { [ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN]: {} },
    description: 'Read a session creation receipt without starting or waiting for creation', tags: ['sessions'],
  }, async (req, reply) => {
    try {
      const connectionScope = sessionCreateConnectionScope({ peer: peerAudience(req)?.grantId, web: webPrincipal(req)?.sessionId });
      reply.send(okEnvelope(await createReceipts.status(connectionScope, req.params.creation_id), req.id));
    } catch (error) { reply.send(mapSessionError(req, error)); }
  });
  app.get(creationStatusRoute.path, creationStatusRoute.options, creationStatusRoute.handler as Parameters<SessionRouteHost['get']>[2]);
  const log = core.accessor.get(ILogService);
  const trackOverlayCleanup = (result: void | Promise<void>): void => {
    if (!(result instanceof Promise)) return;
    pendingOverlayCleanups.add(result);
    result.finally(() => pendingOverlayCleanups.delete(result)).catch((error: unknown) => {
      log.error('session source overlay release failed', { error });
    });
  };
  const releaseSessionOverlays = (sessionId: string) => {
    const resources = overlayResourcesBySession.get(sessionId);
    if (resources === undefined) return;
    overlayResourcesBySession.delete(sessionId);
    for (const resourceId of resources) leaseRegistry.releaseResource(resourceId);
  };
  core.accessor.get(ISessionManager).onDidCloseSession?.(({ sessionId }) => {
    releaseSessionOverlays(sessionId);
  });
  core.accessor.get(ISessionManager).onDidArchiveSession?.(({ sessionId }) => {
    releaseSessionOverlays(sessionId);
  });
  const ephemeralSessions = async (query: { workspace_id?: string; persona?: string; before_id?: string; page_size?: number; include_private?: boolean; private_only?: boolean }, budget = 62 * 1024) => {
    const eligible: { readonly handle: ISessionScopeHandle; readonly meta: SessionMeta }[] = [];
    for (const handle of core.accessor.get(ISessionManager).listEphemeral()) {
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const ctx = handle.accessor.get(ISessionContext);
      const persona = resolveSessionPersonaId(core, { ...meta, workspaceId: ctx.workspaceId });
      if ((query.workspace_id !== undefined && ctx.workspaceId !== query.workspace_id)
        || (query.persona !== undefined && persona !== query.persona)
        || !sessionMatchesPrivacy(meta.private, query)) continue;
      eligible.push({ handle, meta });
    }
    const anchor = query.before_id === undefined ? -1 : eligible.findIndex(({ handle }) => handle.id === query.before_id);
    const sessions = query.before_id !== undefined && anchor < 0 ? [] : eligible.slice(anchor + 1);
    const items: Session[] = [];
    let bytes = 2;
    for (const { handle, meta } of sessions) {
      if (items.length >= (query.page_size ?? DEFAULT_SESSION_LIST_PAGE_SIZE)) break;
      const ctx = handle.accessor.get(ISessionContext);
      const session = boundedListPreview(toWireSession({ ...meta, workspaceId: ctx.workspaceId }, ctx.cwd, resolveSessionFacts(core, handle.id), (await broadcaster?.getCursor(handle.id))?.seq, true));
      const size = jsonBytes(session) + 1;
      if (bytes + size > budget) break;
      items.push(session);
      bytes += size;
    }
    const more = items.length < sessions.length;
    return { items, has_more: more, next_cursor: more ? items.at(-1)?.id : undefined };
  };
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
        [ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT]: {},
        [ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN]: {},
      },
      description: 'Create a new session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const body = req.body;
      const hasKnownSession = async (sessionId: string, signal?: AbortSignal): Promise<boolean> => {
        if (core.accessor.get(ISessionManager).get(sessionId) !== undefined) return true;
        return (await core.accessor.get(ISessionIndex).get(sessionId, undefined, signal)) !== undefined;
      };
      const createSession = async (forcedSessionId?: string): Promise<Session> => {
        if (forcedSessionId !== undefined) {
          if (await hasKnownSession(forcedSessionId)) {
            throw new SessionCreateReceiptError(
              ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT,
              `The reserved session id ${forcedSessionId} already exists.`,
              { creation_id: body.creation_id, reason: 'session_id_exists' },
            );
          }
        }
        const callerCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
        const workspaceId = body.workspace_id;
        const registry = core.accessor.get(IWorkspaceService);
        let workDir = callerCwd;
        if (workspaceId !== undefined) {
          const workspace = await registry.get(workspaceId);
          if (workspace === undefined) {
            throw new SessionCreateReceiptError(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspaceId} does not exist`,
            );
          }
          if (callerCwd !== undefined && canonicalWorkspaceRoot(callerCwd) !== canonicalWorkspaceRoot(workspace.root)) {
            throw new SessionCreateReceiptError(
              ErrorCode.VALIDATION_FAILED,
              `metadata.cwd: metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})`,
              [{ path: 'metadata.cwd', message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})` }],
            );
          }
          workDir = workspace.root;
        } else if (callerCwd !== undefined && peerAudience(req) !== undefined) {
          const registered = await registry.findRegisteredByRoot(callerCwd);
          if (registered === undefined) {
            throw new AdmissionError(403, 'peer_workspace_not_registered');
          }
          workDir = registered.root;
        }

        let autoRoot: string | undefined;
        let registeredAutoWorkspace: Workspace | undefined;
        let sessionCreated = false;
        let worktreeId: string | undefined;
        let createdSessionId: string | undefined = forcedSessionId;
        let externalConnectionId: string | undefined;
        try {
          const externalMark = body.metadata?.['externalClient'];
          if (externalMark !== undefined) {
            if (externalClients === undefined || externalMark === null || typeof externalMark !== 'object'
              || !('driver' in externalMark) || externalMark.driver !== 'external'
              || !('connectionId' in externalMark) || typeof externalMark.connectionId !== 'string') {
              throw new Error2(ErrorCodes.REQUEST_INVALID, 'Select an available external client connection.');
            }
            externalConnectionId = externalMark.connectionId;
          }
          const personaStore = core.accessor.get(IPersonaStore);
          const persona = body.persona === undefined ? undefined : await personaStore.get(body.persona);
          const personaState = body.persona === undefined ? undefined : await personaStore.getState(body.persona);
          if (personaState?.archived === true) {
            throw new Error2(ErrorCodes.REQUEST_INVALID, 'Restore the archived persona before starting a conversation.');
          }
          if (workDir === undefined && persona !== undefined) {
            const configured = persona.definition.homeWorkspace;
            workDir = configured === undefined
              ? join(core.accessor.get(IBootstrapService).homeDir, 'bots', persona.definition.id)
              : (await registry.get(configured))?.root ?? configured;
            if (persona.definition.homeWorkspace === undefined) await core.accessor.get(IHostFileSystem).mkdir(workDir, { recursive: true });
          }
          let autoWorkspaceName: string | undefined;
          if (workDir === undefined) {
            const date = new Date().toISOString().slice(0, 10);
            const id = randomUUID();
            const root = join(core.accessor.get(IBootstrapService).homeDir, 'workspaces');
            const hostFs = core.accessor.get(IHostFileSystem);
            await hostFs.mkdir(root, { recursive: true });
            workDir = join(root, `${date}-${id}`);
            autoWorkspaceName = `Untitled workspace ${date} ${id.slice(0, 8)}`;
            await hostFs.mkdir(workDir);
            autoRoot = workDir;
          }
          const touched = await registry.createOrTouch(workDir, autoWorkspaceName);
          if (autoRoot === undefined) await onWorkspaceServed?.(touched.root);
          else registeredAutoWorkspace = touched;
          let worktree: Awaited<ReturnType<IWorktreeService['create']>> | undefined;
          if (body.isolation !== undefined) {
            const lease = await core.accessor.get(IWorkspaceInstanceManager).acquire({ workspaceId: touched.id });
            try {
              createdSessionId ??= `session_${randomUUID()}`;
              worktree = await core.accessor.get(IWorktreeService).create({
                sessionId: createdSessionId, workspaceId: touched.id, sourceRoot: touched.root,
                title: body.title, isolation: body.isolation,
              });
              worktreeId = worktree.id;
              workDir = worktree.path;
            } finally { lease.dispose(); }
          }
          if (externalConnectionId !== undefined) {
            createdSessionId ??= `session_${randomUUID()}`;
            await externalClients!.prepareOwnerSession(externalConnectionId, createdSessionId, workDir,
              body.agent_config?.permission_mode ?? 'manual',
              body.agent_config?.profile ?? body.agent_config?.execution?.profile,
              body.agent_config?.execution?.profile_file).catch((error: unknown) => {
                throw new Error2(ErrorCodes.REQUEST_INVALID, toErrorMessage(error));
              });
          }
          const handle = await core.accessor.get(ISessionManager).create({
            workspaceId: touched.id,
            workDir,
            sessionId: createdSessionId,
            ephemeral: body.ephemeral,
            private: body.private ?? (personaState?.hidden === true ? true : undefined),
            delivery: body.delivery ?? persona?.definition.delivery,
            worktree: worktree === undefined ? undefined : {
              worktreeId: worktree.id, branch: worktree.branch,
              sourceRoot: worktree.repo.sourceRoot, baseRef: worktree.base.ref,
            },
            mainAgentBinding: externalConnectionId !== undefined
              ? { driver: 'external', persona: body.persona, profile: body.agent_config?.profile,
                  execution: body.agent_config?.execution }
              : body.persona === undefined
                && body.agent_config?.execution === undefined
                && body.agent_config?.model === undefined
                && body.agent_config?.profile === undefined
                && body.agent_config?.thinking === undefined
                ? undefined
                : {
                    execution: body.agent_config?.execution === undefined ? undefined : { ...body.agent_config.execution, overrides: {
                      ...body.agent_config.execution.overrides,
                      permission_mode: body.agent_config.permission_mode ?? body.agent_config.execution.overrides?.permission_mode,
                    } },
                    persona: body.persona,
                    profile: body.agent_config?.profile
                      ?? (body.persona === undefined ? DEFAULT_AGENT_PROFILE_NAME : undefined),
                    model: body.agent_config?.model,
                    thinking: body.agent_config?.thinking,
                    strictThinking: body.agent_config?.thinking !== undefined,
                  },
          });
          sessionCreated = true;
          if (autoRoot !== undefined) {
            try {
              await onWorkspaceServed?.(touched.root);
            } catch (error) {
              await core.accessor.get(ISessionManager).delete(handle.id);
              sessionCreated = false;
              throw error;
            }
          }
          if (typeof body.title === 'string') {
            await handle.accessor.get(ISessionMetadata).setTitle(body.title);
          }
          if (
            body.agent_config?.permission_mode !== undefined
            || body.agent_config?.plan_mode !== undefined
            || body.agent_config?.plan_gate !== undefined
          ) {
            await applyAgentRuntimeControls(await ensureMainAgent(handle), body.agent_config);
          }
          if (body.metadata !== undefined) {
            const metadata = handle.accessor.get(ISessionMetadata);
            const current = externalConnectionId === undefined ? undefined : await metadata.read();
            const custom = externalConnectionId === undefined ? body.metadata : {
              ...current?.custom, ...body.metadata, externalClient: current?.custom?.['externalClient'],
            };
            await metadata.update({ custom });
          }
          if (body.persona !== undefined && body.persona_home === true && body.ephemeral !== true) {
            await core.accessor.get(IBotService).claimHomeSession(body.persona, handle.id).catch((error) => {
              requestLog(req)?.warn({ session_id: handle.id, error: toErrorMessage(error) }, 'daily chat claim skipped; conversation retained');
            });
          }
          const meta = await handle.accessor.get(ISessionMetadata).read();
          const session = toWireSession(
            { ...meta, workspaceId: touched.id },
            workDir,
            resolveSessionFacts(core, meta.id),
            undefined,
            body.ephemeral === true,
          );
          core.accessor.get(IEventService).publish(
            new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
          );
          const seq = await readSessionCursorSeq(core, broadcaster, meta.id);
          return seq === undefined ? session : { ...session, last_seq: seq };
        } catch (error) {
          if (!sessionCreated && externalConnectionId !== undefined && createdSessionId !== undefined) {
            externalClients?.cancelPreparedSession(createdSessionId);
          }
          if (worktreeId !== undefined) {
            if (sessionCreated && createdSessionId !== undefined) {
              await core.accessor.get(ISessionManager).delete(createdSessionId).catch(() => {
                requestLog(req)?.warn({ session_id: createdSessionId, event_type: 'worktree_rollback_failed' }, 'worktree session rollback failed');
              });
            }
            const result = await core.accessor.get(IWorktreeService).remove(worktreeId).catch(() => undefined);
            if (result?.outcome !== 'removed') requestLog(req)?.warn({ worktree_id: worktreeId, outcome: result?.outcome }, 'worktree rollback retained its checkout');
          }
          if (autoRoot !== undefined && !sessionCreated) {
            try {
              await removeUnusedAutoWorkspace(core, autoRoot, registeredAutoWorkspace);
            } catch {
              requestLog(req)?.warn(
                { event_type: 'automatic_workspace_cleanup_failed' },
                'automatic workspace cleanup failed',
              );
            }
          }
          if (forcedSessionId !== undefined && isError2(error) && error.code === ErrorCodes.SESSION_ALREADY_EXISTS) {
            throw new SessionCreateReceiptError(
              ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT,
              `The reserved session id ${forcedSessionId} already exists.`,
              { creation_id: body.creation_id, reason: 'session_id_exists' },
            );
          }
          throw error;
        }
      };

      if (body.creation_id === undefined) {
        try {
          reply.send(okEnvelope(await createSession(), req.id));
        } catch (error) {
          sendMappedError(reply, req, error);
        }
        return;
      }

      const audience = peerAudience(req);
      const principal = webPrincipal(req);
      const connectionScope = sessionCreateConnectionScope({ peer: audience?.grantId, web: principal?.sessionId });
      let cancelled = false;
      try {
        const session = await withReplyCloseSignal(
          reply as unknown as Parameters<typeof withReplyCloseSignal>[0],
          async (signal) => {
            try {
              const result = await createReceipts.run(
                connectionScope,
                body,
                createSession,
                (error) => {
                  const mapped = mapSessionError(req, error);
                  return { code: mapped.code, message: mapped.msg, details: mapped.details };
                },
                async (sessionId) => (await hasKnownSession(sessionId, signal)) ? 'present' : 'absent',
                signal,
              );
              if (signal.aborted) {
                cancelled = true;
                return undefined;
              }
              return result;
            } catch (error) {
              if (signal.aborted) cancelled = true;
              throw error;
            }
          },
          req,
        );
        if (!cancelled && session !== undefined) reply.send(okEnvelope(session, req.id));
      } catch (error) {
        if (cancelled) return;
        sendMappedError(reply as Parameters<typeof sendMappedError>[0], req, error);
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
      success: { data: pageResponseSchema(sessionSchema).extend({ next_cursor: z.string().optional(), busy_count: z.number().int().nonnegative().optional(), ephemeral: z.array(sessionSchema).optional(), ephemeral_has_more: z.boolean().optional(), ephemeral_next_cursor: z.string().optional() }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.SESSION_INDEX_BUILDING]: {},
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      const raw = req.query;
      let before = raw.before_id;
      let after = raw.after_id;
      if (before?.startsWith('next:')) {
        try {
          const cursor = z.object({ before: z.string().min(1), after: z.string().min(1) }).parse(JSON.parse(Buffer.from(before.slice(5), 'base64url').toString('utf8')));
          before = cursor.before;
          after = cursor.after;
        } catch {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid session page cursor', req.id));
          return;
        }
      }
      const archivedOnly = raw.archived_only === true;
      const needle = raw.q?.trim().toLocaleLowerCase();

      const catalog = await core.accessor.get(IWorkspacePersistence).load();
      const roots = new Map((catalog?.workspaces ?? []).map((w) => [w.id, w.root]));
      const index = core.accessor.get(ISessionIndex);
      const workspaceIds =
        raw.workspace_id === undefined
          ? undefined
          : await core.accessor.get(IWorkspaceAliases).resolveAliasIds(raw.workspace_id);
      if (workspaceIds !== undefined && !workspaceIds.some((id) => roots.has(id)) &&
        (workspaceIds.some((id) => catalog?.deletedIds.includes(id)) || await index.count({ workspaceIds, includeArchived: true }) === 0)) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${raw.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
      const includeArchived = archivedOnly ? true : raw.include_archive;
      const personaNames = new Map<string, Promise<string>>();
      const project = async (summary: SessionSummary, cwd: string, facts = resolveSessionFacts(core, summary.id, summary.usage)): Promise<Session> => {
        if (facts.agentConfig?.persona === undefined) {
          const personaId = resolveSessionPersonaId(core, summary);
          if (personaId !== undefined) {
            let name = personaNames.get(personaId);
            if (name === undefined) {
              name = core.accessor.get(IPersonaStore).get(personaId).then((snapshot) => snapshot?.definition.name ?? personaId);
              personaNames.set(personaId, name);
            }
            facts = { ...facts, agentConfig: { ...facts.agentConfig, model: facts.agentConfig?.model ?? '', persona: {
              id: personaId, name: await name, avatarUrl: `/api/personas/${encodeURIComponent(personaId)}/avatar`,
            } } };
          }
        }
        const seq = await readSessionCursorSeq(core, broadcaster, summary.id, signal, true);
        return toWireSession(summary, cwd, facts, seq);
      };

      interface Eligible {
        readonly summary: SessionSummary;
        readonly cwd: string;
        readonly facts?: SessionFacts;
      }

      const collect = async (pageSize: number): Promise<{ visible: Eligible[]; hasMore: boolean }> => {
        const wanted = pageSize + 1;
        const collected: Eligible[] = [];
        let pageBefore = before;
        const afterCursor = after !== undefined ? await index.get(after) : undefined;
        const newerThanCursor = (summary: SessionSummary): boolean =>
          afterCursor === undefined ||
          summary.updatedAt > afterCursor.updatedAt ||
          (summary.updatedAt === afterCursor.updatedAt && summary.id > afterCursor.id);
        while (collected.length < wanted) {
          signal.throwIfAborted();
          const page = await index.listRecent({
            workspaceIds,
            includeArchived,
            limit: raw.persona === undefined ? wanted - collected.length : Math.max(wanted - collected.length, 500),
            before: pageBefore,
            after: pageBefore === undefined ? after : undefined,
          });
          if (page.items.length === 0) break;
          let exhausted = false;
          for (const summary of page.items) {
            signal.throwIfAborted();
            if (!newerThanCursor(summary)) {
              exhausted = true;
              break;
            }
            if (!sessionMatchesPrivacy(summary.private, raw)) continue;
            const cwd = summary.cwd ?? roots.get(summary.workspaceId) ?? (archivedOnly ? '' : undefined);
            if (cwd === undefined) continue;
            if (needle && ![summary.title ?? '', cwd, summary.workspaceId].some((value) => value.toLocaleLowerCase().includes(needle))) continue;
            if (raw.persona !== undefined && resolveSessionPersonaId(core, summary) !== raw.persona) continue;
            if (raw.exclude_empty === true && (summary.lastPrompt ?? '').length === 0) continue;
            if (archivedOnly && !summary.archived) continue;
            if (raw.pinned !== undefined && (summary.custom?.[SESSION_PIN_METADATA_KEY] === true) !== raw.pinned) continue;
            const facts = raw.busy !== undefined ? resolveSessionFacts(core, summary.id, summary.usage) : undefined;
            if (raw.busy !== undefined && facts?.busy !== raw.busy) continue;
            collected.push({ summary, cwd, facts });
          }
          if (exhausted || page.nextCursor === undefined) break;
          pageBefore = page.nextCursor;
        }
        return { visible: collected.slice(0, pageSize), hasMore: collected.length > pageSize };
      };

      const pageSize = raw.page_size ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
      const { visible, hasMore } = await collect(pageSize);
      const projected = await Promise.all(visible.map(async ({ summary, cwd, facts }) => boundedListPreview(await project(summary, cwd, facts))));
      const ephemeral = raw.include_ephemeral === true ? await ephemeralSessions({
        workspace_id: raw.workspace_id,
        persona: raw.persona,
        include_private: raw.include_private,
        private_only: raw.private_only,
      }, 24 * 1024) : undefined;
      const items: Session[] = [];
      let bytes = 2048 + jsonBytes(ephemeral);
      for (const session of projected) {
        const size = jsonBytes(session) + 1;
        if (bytes + size > 64 * 1024) break;
        items.push(session);
        bytes += size;
      }
      const more = hasMore || items.length < projected.length;
      const last = items.at(-1)?.id;
      const nextCursor = more && last !== undefined ? after === undefined ? last : `next:${Buffer.from(JSON.stringify({ before: last, after })).toString('base64url')}` : undefined;
      const busyCount = core.accessor.get(ISessionManager).list().filter((session) => session.accessor.get(ISessionActivityView).state().busy).length;
      signal.throwIfAborted();
      reply.send(okEnvelope({ items, has_more: more, next_cursor: nextCursor, busy_count: busyCount, ephemeral: ephemeral?.items, ephemeral_has_more: ephemeral?.has_more, ephemeral_next_cursor: ephemeral?.next_cursor }, req.id));
    }),
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const ephemeralListRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/ephemeral',
      querystring: z.object({
        before_id: z.string().min(1).optional(),
        page_size: z.coerce.number().int().min(1).max(100).optional(),
        workspace_id: workspaceIdSchema.optional(),
        persona: z.string().min(1).optional(),
        include_private: booleanQueryParam,
        private_only: booleanQueryParam,
      }).superRefine((value, ctx) => {
        if (value.private_only === true && value.include_private === false) {
          ctx.addIssue({
            code: 'custom',
            message: 'private_only and include_private are mutually exclusive',
            path: ['private_only'],
            params: { code: ErrorCode.VALIDATION_FAILED },
          });
        }
      }),
      success: { data: pageResponseSchema(sessionSchema).extend({ next_cursor: z.string().optional() }) },
      description: 'List live temporary sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await ephemeralSessions(req.query), req.id));
    },
  );
  app.get(ephemeralListRoute.path, ephemeralListRoute.options, ephemeralListRoute.handler as Parameters<SessionRouteHost['get']>[2]);

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
      const manager = core.accessor.get(ISessionManager);
      if (manager.isEphemeral(session_id)) {
        const handle = manager.get(session_id);
        if (handle === undefined) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
          return;
        }
        const ctx = handle.accessor.get(ISessionContext);
        const [meta, seq] = await Promise.all([
          handle.accessor.get(ISessionMetadata).read(),
          readSessionCursorSeq(core, broadcaster, session_id),
        ]);
        reply.send(okEnvelope(toWireSession(
          { ...meta, workspaceId: ctx.workspaceId }, ctx.cwd,
          resolveSessionFacts(core, session_id), seq, true,
        ), req.id));
        return;
      }
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
      let [facts, seq] = await withReplyCloseSignal(
        reply as unknown as Parameters<typeof withReplyCloseSignal>[0],
        (signal) => Promise.all([
          resolveSessionBindingFacts(core, session_id, summary.workspaceId, summary.usage, undefined, signal),
          readSessionCursorSeq(core, broadcaster, session_id, signal, true),
        ]),
      );
      if (facts.agentConfig?.persona === undefined) {
        const personaId = resolveSessionPersonaId(core, summary);
        if (personaId !== undefined) {
          const snapshot = await core.accessor.get(IPersonaStore).get(personaId);
          facts = { ...facts, agentConfig: { ...facts.agentConfig, model: facts.agentConfig?.model ?? '', persona: {
            id: personaId, name: snapshot?.definition.name ?? personaId, avatarUrl: `/api/personas/${encodeURIComponent(personaId)}/avatar`,
          } } };
        }
      }
      reply.send(
        okEnvelope(
          toWireSession(
            summary,
            cwd,
            facts,
            seq,
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
      const cursor = await broadcaster?.getCursor(session_id);
      const manager = core.accessor.get(ISessionManager);
      if (manager.isEphemeral(session_id)) {
        const handle = manager.get(session_id);
        if (handle === undefined) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
          return;
        }
        const ctx = handle.accessor.get(ISessionContext);
        const meta = await handle.accessor.get(ISessionMetadata).read();
        reply.send(okEnvelope(toWireSession(
          { ...meta, workspaceId: ctx.workspaceId }, ctx.cwd,
          resolveSessionFacts(core, session_id), cursor?.seq, true,
        ), req.id));
        return;
      }
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
      let facts = await resolveSessionBindingFacts(core, session_id, summary.workspaceId, summary.usage);
      if (facts.agentConfig?.persona === undefined) {
        const personaId = resolveSessionPersonaId(core, summary);
        if (personaId !== undefined) {
          const snapshot = await core.accessor.get(IPersonaStore).get(personaId);
          facts = { ...facts, agentConfig: { ...facts.agentConfig, model: facts.agentConfig?.model ?? '', persona: {
            id: personaId, name: snapshot?.definition.name ?? personaId, avatarUrl: `/api/personas/${encodeURIComponent(personaId)}/avatar`,
          } } };
        }
      }
      reply.send(
        okEnvelope(
          toWireSession(
            summary,
            cwd,
            facts,
            cursor?.seq,
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
        const { agent_config, delivery, ...profileBody } = req.body;
        const publishMetaUpdated = (fields: { readonly title?: string; readonly private?: boolean }) => {
          const hasCustomTitle = typeof req.body.title === 'string' && req.body.title.trim().length > 0;
          if (!hasCustomTitle && req.body.private === undefined) return;
          core.accessor.get(IEventService).publish(
            new SessionMetaUpdated({
              payload: {
                agentId: 'main',
                sessionId: session_id,
                title: hasCustomTitle ? fields.title : undefined,
                patch: {
                  title: hasCustomTitle ? fields.title : undefined,
                  isCustomTitle: hasCustomTitle ? true : undefined,
                  private: req.body.private === undefined ? undefined : fields.private,
                },
              },
            }),
          );
        };
        if (agent_config === undefined && delivery === undefined) {
          const manager = core.accessor.get(ISessionManager);
          const result = await manager.withLifecycleSerialization(session_id, async () => {
            const live = manager.get(session_id);
            if (live !== undefined) {
              const fields = await updateSessionProfile(live, profileBody);
              return { kind: 'live' as const, fields, ephemeral: manager.isEphemeral(fields.id) };
            }
            if (manager.isEphemeral(session_id)) return { kind: 'not_found' as const };
            return updateColdSessionProfile(core.accessor, session_id, profileBody);
          });
          if (result.kind === 'not_found') {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
          }
          if (result.kind === 'live') {
            publishMetaUpdated(result.fields);
            const cursor = await broadcaster?.getCursor(result.fields.id);
            const session = toWireSession(result.fields, result.fields.root, resolveSessionFacts(core, result.fields.id), cursor?.seq, result.ephemeral);
            reply.send(okEnvelope(session, req.id));
            return;
          }
          const cwd = result.cwd ?? (await core.accessor.get(IWorkspaceService).get(result.workspaceId))?.root;
          if (cwd === undefined) {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} has no recoverable cwd`);
          }
          publishMetaUpdated(result.meta);
          const cursor = await broadcaster?.getCursor(session_id);
          const facts = await resolveSessionBindingFacts(
            core,
            session_id,
            result.workspaceId,
            result.meta.usage,
            result.meta.agents?.[MAIN_AGENT_ID],
            undefined,
            { sessionMetadata: result.meta },
          );
          reply.send(okEnvelope(toWireSession({ ...result.meta, workspaceId: result.workspaceId }, cwd, facts, cursor?.seq), req.id));
          return;
        }
        await withSessionOperation(core, session_id, async (handle) => {
          if (handle === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
          if (delivery !== undefined) await handle.accessor.get(ISessionDeliveryService).set(delivery);
          const fields = await updateSessionProfile(handle, profileBody);
          if (agent_config !== undefined) await applySessionAgentConfig(handle, agent_config);
          publishMetaUpdated(fields);
          const cursor = await broadcaster?.getCursor(fields.id);
          const session = toWireSession(fields, fields.root, resolveSessionFacts(core, fields.id), cursor?.seq, core.accessor.get(ISessionManager).isEphemeral(fields.id));
          reply.send(okEnvelope(session, req.id));
        });
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
      description: 'Generate the session title with the explicitly selected title model',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        await withSessionOperation(core, session_id, async (handle) => {
          if (handle === undefined) {
            reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} not found`, req.id));
            return;
          }
          const title = await handle.accessor
            .get(ISessionTitleService)
            .generateTitle({ force: req.body.force === true, source: req.body.source });
          if (title === undefined) {
            reply.send(errEnvelope(
              ErrorCode.SESSION_TITLE_UNAVAILABLE,
              'Title generation requires a selected session_title.model, the title feature enabled, and conversation text; existing titles require force.',
              req.id,
            ));
            return;
          }
          reply.send(okEnvelope({ title }, req.id));
        });
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

  for (const action of ['end', 'save'] as const) {
    const route = defineRoute(
      {
        method: 'POST',
        path: `/sessions/{session_id}/ephemeral/${action}`,
        params: sessionIdParamSchema,
        body: z.object({ worktree: z.enum(['keep', 'remove']).optional() }).optional(),
        success: { data: action === 'save' ? sessionSchema : z.object({
          ended: z.literal(true),
          worktree: z.object({ id: z.string(), outcome: z.union([z.literal('kept'), worktreeRemovalOutcomeSchema]) }).optional(),
        }) },
        errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.SESSION_BUSY]: {} },
        description: action === 'save' ? 'Save a temporary session' : 'End and delete a temporary session',
        tags: ['sessions'],
      },
      async (req, reply) => {
        try {
          const id = req.params.session_id;
          const manager = core.accessor.get(ISessionManager);
          if (!manager.isEphemeral(id)) {
            reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `temporary session ${id} does not exist`, req.id));
            return;
          }
          if (action === 'end') {
            const worktreeId = (await manager.get(id)?.accessor.get(ISessionMetadata).read())?.worktree?.worktreeId;
            await manager.delete(id);
            if (worktreeId === undefined) {
              reply.send(okEnvelope({ ended: true }, req.id));
              return;
            }
            const outcome = req.body?.worktree === 'keep' ? 'kept' : await core.accessor
              .get(IWorktreeService).remove(worktreeId)
              .then((result) => result.outcome, () => 'failed' as const);
            reply.send(okEnvelope({ ended: true, worktree: { id: worktreeId, outcome } }, req.id));
            return;
          }
          await manager.saveEphemeral(id);
          const summary = await core.accessor.get(ISessionIndex).get(id);
          if (summary === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `saved session ${id} not found`);
          const cursor = await broadcaster?.getCursor(id);
          reply.send(okEnvelope(toWireSession(summary, summary.cwd ?? '', resolveSessionFacts(core, id, summary.usage), cursor?.seq), req.id));
        } catch (error) {
          sendMappedError(reply, req, error);
        }
      },
    );
    app.post(route.path, route.options, route.handler as Parameters<SessionRouteHost['post']>[2]);
  }

  const deleteAllArchivedRoute = defineRoute(
    {
      method: 'POST', path: '/sessions::delete-archived',
      body: z.object({}).strict(),
      success: { data: deleteArchivedSessionsResponseSchema },
      errors: { [ErrorCode.SESSION_INDEX_BUILDING]: {} },
      description: 'Permanently delete all archived conversations in the connected home',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        reply.send(okEnvelope(await deleteArchivedSessions(core), req.id));
      } catch (error) {
        if (isError2(error) && error.code === ErrorCodes.SESSION_INDEX_BUILDING) {
          reply.send(errEnvelope(ErrorCode.SESSION_INDEX_BUILDING, error.message, req.id));
          return;
        }
        throw error;
      }
    },
  );
  app.post(deleteAllArchivedRoute.path, deleteAllArchivedRoute.options, deleteAllArchivedRoute.handler as Parameters<SessionRouteHost['post']>[2]);

  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      querystring: z.object({ agent_id: z.string().min(1).optional() }),
      success: {
        data: z.union([
          sessionSchema,
          compactSessionResponseSchema,
          undoSessionResponseSchema,
          sessionAbortResponseSchema,
          startBtwSessionResponseSchema,
          createSessionBranchResponseSchema,
          foldSessionBranchResponseSchema,
          discardSessionBranchResponseSchema,
          setSessionBranchToolsLockResponseSchema,
          archiveSessionResponseSchema,
          deleteArchivedSessionsResponseSchema,
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
          allowedActions: ['fork', 'compact', 'undo', 'abort', 'btw', 'branch', 'fold', 'discard', 'tools-lock', 'archive', 'restore', 'delete-archived'] as const,
          resourceLabel: 'session',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(buildValidationEnvelope([{ path: 'session_id', message }], req.id));
          return;
        }

        if (parsed.action === 'delete-archived') {
          const body = deleteArchivedSessionRequestSchema.parse(req.body);
          reply.send(okEnvelope(await deleteArchivedSessions(core, parsed.id, body.exclude_session_ids), req.id));
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
          const carry = body.carry;
          let handle: ISessionScopeHandle;
          if (body.through_message_id === undefined) {
            handle = await core.accessor.get(ISessionManager).fork({
              sourceSessionId: parsed.id,
              title: body.title,
              metadata: body.metadata,
              seed: body.seed,
              carry,
            });
          } else {
            const throughMessageId = body.through_message_id;
            handle = await withSessionOperation(core, parsed.id, async (source) => {
              if (source === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
              const mutation = await source.accessor.get(ISessionHistoryMutationService).acquire();
              try {
                if (body.expected_cursor !== undefined && broadcaster !== undefined) await assertCursor(broadcaster, parsed.id, body.expected_cursor);
                const entries = await loadMessageHistoryEntries(core, parsed.id);
                const boundary = resolveForkMessageBoundary(entries, throughMessageId);
                return await core.accessor.get(ISessionManager).fork({
                  sourceSessionId: parsed.id, title: body.title, metadata: body.metadata, seed: body.seed, carry,
                  throughMessageId, turnIndex: boundary.turnIndex, throughUserMessage: boundary.throughUserMessage,
                });
              } finally {
                mutation.dispose();
              }
            });
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
          const cursor = await broadcaster?.getCursor(meta.id);
          requestLog(req)?.info(
            { session_id: parsed.id, action: 'fork', new_session_id: session.id },
            'session action completed',
          );
          reply.send(okEnvelope(cursor === undefined ? session : { ...session, last_seq: cursor.seq }, req.id));
          return;
        }

        if (parsed.action === 'compact') {
          const body = compactSessionRequestSchema.parse(req.body);
          await withMainAgent(core, parsed.id, async (agent) => {
            const compaction = agent.accessor.get(IAgentFullCompactionService);
            const accepted = compaction.begin({ source: 'manual', instruction: normalizeOptional(body.instruction), strategy: body.strategy });
            const status = compaction.queuedManualCompaction ? 'queued' : 'running';
            requestLog(req)?.info({ session_id: parsed.id, action: 'compact', source: 'manual', accepted, status }, 'session compaction requested');
            reply.send(okEnvelope({ accepted, status, source: 'manual' }, req.id));
          });
          return;
        }

        if (parsed.action === 'undo') {
          const body = undoSessionRequestSchema.parse(req.body);
          await withMainAgent(core, parsed.id, async (agent) => {
            await agent.accessor.get(IAgentConversationUndoService).undo(body.count);
            const history = agent.accessor.get(IAgentContextMemoryService).get();
            requestLog(req)?.info({ session_id: parsed.id, action: 'undo' }, 'session action completed');
            const [summary, status] = await Promise.all([
              core.accessor.get(ISessionIndex).get(parsed.id),
              legacy.status(parsed.id),
            ]);
            reply.send(okEnvelope({
              messages: pageUndoMessages(parsed.id, summary?.createdAt ?? 0, history, body.page_size),
              status,
            }, req.id));
          });
          return;
        }

        if (parsed.action === 'abort') {
          await withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], (signal) => withSessionOperation(core, parsed.id, async (session) => {
            signal.throwIfAborted();
            if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
            const agent = await ensureSessionAgent(core, session, req.body.agent_id ?? req.query.agent_id ?? MAIN_AGENT_ID);
            signal.throwIfAborted();
            if ((agent.accessor.get(IAgentProfileService).data().executorId ?? 'native') === 'native') agent.accessor.get(IAgentLoopService).cancelFromUser();
            else agent.accessor.get(IAgentExecutionService).cancel();
            requestLog(req)?.info({ session_id: parsed.id, agent_id: agent.id, action: 'abort' }, 'session action completed');
            reply.send(okEnvelope({ aborted: true }, req.id));
          }, signal), req);
          return;
        }

        if (parsed.action === 'btw') {
          await withSessionOperation(core, parsed.id, async (session) => {
            if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
            const main = await ensureMainAgent(session);
            await ensurePromptAuthReady(session, main.accessor);
            const agentId = await session.accessor.get(ISessionBtwService).start();
            reply.send(okEnvelope({ agent_id: agentId }, req.id));
          });
          return;
        }

        if (parsed.action === 'branch') {
          const body = createSessionBranchRequestSchema.parse(req.body);
          await withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], (signal) => withSessionOperation(core, parsed.id, async (session) => {
            signal.throwIfAborted();
            if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
            const parent = await ensureSessionAgent(core, session, body.parent_agent_id ?? MAIN_AGENT_ID);
            if (body.executor === undefined || body.executor === 'native') {
              await ensurePromptAuthReady(session, parent.accessor, {
                model: body.model || undefined,
                execution: body.executor === 'native' ? { executor: 'native' } : undefined,
              });
            }
            const created = await session.accessor.get(ISessionBranchService).createBranch({
              parentAgentId: body.parent_agent_id,
              initiator: 'user',
              task: body.task,
              prompt: body.prompt,
              seed: body.seed,
              carry: body.carry,
              title: body.title,
              model: body.model,
              thinking: body.thinking,
              executor: body.executor,
              cwd: body.cwd,
              toolsLocked: body.tools_locked,
              signal,
            });
            reply.send(okEnvelope({
              agent_id: created.branchId,
              parent_agent_id: created.parentAgentId,
              seed: created.seed,
              tools_locked: created.toolsLocked,
              title: created.title,
              started: created.started,
            }, req.id));
          }, signal), req);
          return;
        }

        if (parsed.action === 'fold') {
          const body = foldSessionBranchRequestSchema.parse(req.body);
          await withSessionOperation(core, parsed.id, async (session) => {
            if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
            await ensureMainAgent(session);
            const folded = await session.accessor.get(ISessionBranchService).foldBranch({
              branchId: body.branch_id,
              summary: body.summary,
              context: body.context,
              asks: body.asks,
              done: body.done,
            });
            reply.send(okEnvelope({
              branch_id: folded.branchId,
              fold_id: folded.foldId,
              status: folded.status,
              done: folded.done,
              sealed: folded.sealed,
              handed_back_prompts: folded.handedBackCount,
              through_turn_id: folded.throughTurnId,
            }, req.id));
          });
          return;
        }

        if (parsed.action === 'discard') {
          const body = discardSessionBranchRequestSchema.parse(req.body);
          await withSessionOperation(core, parsed.id, async (session) => {
            if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
            const discarded = await session.accessor.get(ISessionBranchService).discardBranch({
              branchId: body.branch_id,
            });
            reply.send(okEnvelope({
              branch_id: discarded.branchId,
              discarded: discarded.discarded,
            }, req.id));
          });
          return;
        }

        if (parsed.action === 'tools-lock') {
          const body = setSessionBranchToolsLockRequestSchema.parse(req.body);
          await withSessionOperation(core, parsed.id, async (session) => {
            if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
            const updated = await session.accessor.get(ISessionBranchService).setToolsLocked({
              branchId: body.branch_id,
              locked: body.locked,
            });
            reply.send(okEnvelope({
              branch_id: updated.branchId,
              tools_locked: updated.toolsLocked,
            }, req.id));
          });
          return;
        }

        if (parsed.action === 'restore') {
          const manager = core.accessor.get(ISessionManager);
          const outcome = await manager.withLifecycleSerialization(parsed.id, async (unguarded) => {
            if (manager.get(parsed.id) !== undefined) {
              const restored = await unguarded.restore();
              return restored === undefined ? { kind: 'not_found' as const } : { kind: 'live' as const, restored };
            }
            if (manager.isEphemeral(parsed.id)) return { kind: 'not_found' as const };
            return restoreColdSession(core.accessor, parsed.id);
          });
          if (outcome.kind === 'not_found') {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
          }
          if (outcome.kind === 'live') {
            const meta = await outcome.restored.accessor.get(ISessionMetadata).read();
            const ctx = outcome.restored.accessor.get(ISessionContext);
            const cursor = await broadcaster?.getCursor(meta.id);
            const session = toWireSession(
              { ...meta, workspaceId: ctx.workspaceId },
              ctx.cwd,
              resolveSessionFacts(core, meta.id),
              cursor?.seq,
            );
            requestLog(req)?.info({ session_id: parsed.id, action: 'restore' }, 'session action completed');
            reply.send(okEnvelope(session, req.id));
            return;
          }
          const cwd = outcome.cwd ?? (await core.accessor.get(IWorkspaceService).get(outcome.workspaceId))?.root;
          if (cwd === undefined) {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} has no recoverable cwd`);
          }
          const cursor = await broadcaster?.getCursor(parsed.id);
          const facts = await resolveSessionBindingFacts(
            core,
            parsed.id,
            outcome.workspaceId,
            outcome.meta.usage,
            outcome.meta.agents?.[MAIN_AGENT_ID],
            undefined,
            { sessionMetadata: outcome.meta },
          );
          const session = toWireSession(
            { ...outcome.meta, workspaceId: outcome.workspaceId },
            cwd,
            facts,
            cursor?.seq,
          );
          requestLog(req)?.info({ session_id: parsed.id, action: 'restore' }, 'session action completed');
          reply.send(okEnvelope(session, req.id));
          return;
        }

        if (req.body.include_attached === true) {
          const outcomes = await archiveSessionFamily(core.accessor, parsed.id, req.body.exclude_session_ids);
          const archived = outcomes.every((outcome) => outcome.ok);
          requestLog(req)?.info({ session_id: parsed.id, action: 'archive', archived, family_count: outcomes.length }, 'session family archive completed');
          reply.send(okEnvelope({ archived, outcomes }, req.id));
          return;
        }
        const archiveOutcome = (await setSessionArchivedBatch(core.accessor, [parsed.id], true))[0]!;
        if (!archiveOutcome.ok) {
          if (archiveOutcome.reason === 'not_found') {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, archiveOutcome.message);
          }
          throw new Error(archiveOutcome.message);
        }
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
        [ErrorCode.SESSION_INDEX_BUILDING]: {},
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
        const projected = await Promise.all(window.map(async (summary) =>
          toWireSession(
            summary,
            summary.cwd ?? roots.get(summary.workspaceId) ?? '',
            resolveSessionFacts(core, summary.id, summary.usage),
            (await broadcaster?.getCursor(summary.id))?.seq,
          ),
        ));
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
        const cursor = await broadcaster?.getCursor(meta.id);
        reply.send(okEnvelope(cursor === undefined ? session : { ...session, last_seq: cursor.seq }, req.id));
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
        const live = getLiveSessionById(core.accessor, session_id);
        if (live === undefined) {
          const status = await readCachedColdSessionStatus(core, session_id);
          reply.send(okEnvelope({ ...status, context_breakdown: undefined }, req.id));
          return;
        }
        const status = await core.accessor.get(ISessionLegacyService).status(session_id);
        const main = live
          .accessor.get(IAgentLifecycleService)
          .list()
          .find((agent) => agent.id === MAIN_AGENT_ID);
        const breakdown =
          main === undefined
            ? undefined
            : readLegacyStatus(main, { contextBreakdown: true })?.contextBreakdown;
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

  const sourceOverlayRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/source-overlay',
      params: sessionIdParamSchema,
      body: sessionSourceOverlaySchema,
      success: { data: sessionSourceOverlayResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Replace one lease-owned source overlay for a live session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        await withSessionOperation(core, session_id, async (session) => {
          if (session === undefined) {
            reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
            return;
          }
          const program = await programForSession(core.accessor, session_id);
          if (program === undefined) {
            reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
            return;
          }
          if (!leaseRegistry.isActive(req.body.lease_id)) {
            reply.send(buildValidationEnvelope([{ path: 'lease_id', message: 'lease is missing or expired' }], req.id));
            return;
          }
          const sourceId = `session-source:${req.body.lease_id}`;
          const resourceId = `${session_id}:${sourceId}`;
          const profiles = session.accessor.get(ISessionAgentProfileCatalog) as SessionAgentProfileCatalogService;
          const skills = session.accessor.get(ISessionSkillCatalog) as SessionSkillCatalogService;
          if (req.body.agent_files.length === 0 && req.body.skill_dirs.length === 0) {
            leaseRegistry.releaseResource(resourceId);
            overlayResourcesBySession.get(session_id)?.delete(resourceId);
            reply.send(okEnvelope({ profiles: 0, skills: 0 }, req.id));
            return;
          }
          const contributions = await program.loadSessionSourceContributions({
            agentFiles: req.body.agent_files,
            skillDirs: req.body.skill_dirs,
          });
          if (!leaseRegistry.isActive(req.body.lease_id)) {
            reply.send(buildValidationEnvelope([{ path: 'lease_id', message: 'lease expired while loading sources' }], req.id));
            return;
          }
          const overlayPin = await acquireSessionOperation(core, session_id, 'source-overlay');
          const releaseOverlayPin = (): void => {
            trackOverlayCleanup(overlayPin.dispose());
          };
          let attached = false;
          try {
            if (overlayPin.handle === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
            leaseRegistry.releaseResource(resourceId);
            if (req.body.agent_files.length === 0) profiles.removeContribution(sourceId);
            else profiles.setContribution(sourceId, contributions.profiles, AGENT_PROFILE_SOURCE_PRIORITY.explicit);
            if (req.body.skill_dirs.length === 0) skills.remove(sourceId);
            else skills.set(sourceId, contributions.skills, { priority: SKILL_SOURCE_PRIORITY.workspace + 1 });
            attached = leaseRegistry.attach(req.body.lease_id, resourceId, () => {
              try {
                profiles.removeContribution(sourceId);
                skills.remove(sourceId);
                const resources = overlayResourcesBySession.get(session_id);
                resources?.delete(resourceId);
                if (resources?.size === 0) overlayResourcesBySession.delete(session_id);
              } finally {
                releaseOverlayPin();
              }
            });
            if (!attached) {
              profiles.removeContribution(sourceId);
              skills.remove(sourceId);
              reply.send(buildValidationEnvelope([{ path: 'lease_id', message: 'lease expired while loading sources' }], req.id));
              return;
            }
            const resources = overlayResourcesBySession.get(session_id) ?? new Set<string>();
            resources.add(resourceId);
            overlayResourcesBySession.set(session_id, resources);
            reply.send(okEnvelope({
              profiles: contributions.profiles.profiles.length,
              skills: contributions.skills.skills.length,
            }, req.id));
          } finally {
            if (!attached) releaseOverlayPin();
          }
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    sourceOverlayRoute.path,
    sourceOverlayRoute.options,
    sourceOverlayRoute.handler as Parameters<SessionRouteHost['post']>[2],
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
        const live = getLiveSessionById(core.accessor, session_id);
        if (live === undefined) {
          const summary = await core.accessor.get(ISessionIndex).get(session_id);
          if (summary === undefined) {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
          }
          const state = getColdSessionCacheState(core);
          state.goalReader ??= new PersistedGoalReader(
            core.accessor.get(IAppendLogStore),
            core.accessor.get(IAtomicDocumentStore),
            core.accessor.get(IFileSystemStorageService),
            core.accessor.get(ICpuWorkerService),
          );
          const goal = await state.goalReader.readReady(`sessions/${summary.workspaceId}/${session_id}/agents/main`);
          reply.send(okEnvelope(goal, req.id));
          return;
        }
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
      try {
        const live = core.accessor.get(ISessionManager).get(session_id);
        const main = live?.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
        let agentsMdWarning: string | undefined;
        if (main !== undefined) {
          agentsMdWarning = main.accessor.get(IAgentProfileService).getAgentsMdWarning();
        } else if (live !== undefined) {
          const instructions = live.accessor.get(ISessionInstructionsProvider);
          await instructions.ready;
          agentsMdWarning = instructions.agentsMdWarning;
        } else {
          const summary = await core.accessor.get(ISessionIndex).get(session_id);
          if (summary === undefined) {
            reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
            return;
          }
          const bootstrap = core.accessor.get(IBootstrapService);
          const resolvedCwd = summary.cwd
            ?? (await readColdSessionMeta(core, summary.workspaceId, session_id))?.cwd
            ?? bootstrap.osHomeDir;
          agentsMdWarning = (await loadAgentsMdDetailed(
            { fs: core.accessor.get(IHostFileSystem), homeDir: bootstrap.osHomeDir },
            resolvedCwd, bootstrap.homeDir,
            { inheritance: resolveSpaceInheritance(bootstrap) },
          )).warning;
        }
        const warnings = agentsMdWarning === undefined ? [] : [{
          code: 'agents-md-oversized', message: agentsMdWarning, severity: 'warning' as const,
        }];
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
  readonly ownUpdatedAt?: number;
  readonly activityUpdatedAt?: number;
  readonly archived: boolean;
  readonly private?: boolean;
  readonly archivedAt?: number;
  readonly executionPhase?: 'running' | 'pausing' | 'paused' | 'resuming' | 'failed';
  readonly worktree?: { readonly worktreeId: string; readonly branch: string; readonly sourceRoot: string; readonly baseRef: string };
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly delivery?: 'reply' | 'message';
  readonly agents?: Readonly<Record<string, AgentMeta>>;
  readonly forkedFrom?: string;
  readonly promotedFrom?: SessionPromotedFrom;
  readonly executorId?: string;
  readonly negotiated?: NegotiatedExecutorCapabilities;
  readonly allowKikiSubagents?: boolean;
}

export function toWireSession(
  fields: SessionWireFields,
  cwd: string,
  facts: SessionFacts,
  lastSeq?: number,
  ephemeral = false,
): Session {
  const mainMeta = fields.agents?.[MAIN_AGENT_ID];
  const persistedExecutor = fields.executorId ?? mainMeta?.executor;
  const executorId = facts.executorId ?? persistedExecutor;
  const negotiated = executorId === persistedExecutor ? fields.negotiated ?? mainMeta?.negotiated : undefined;
  return {
    executor_id: executorId,
    allow_kiki_subagents: facts.allowKikiSubagents ?? fields.allowKikiSubagents ?? mainMeta?.allowKikiSubagents,
    promoted_from: toWirePromotedFrom(promotedFromOf(fields)),
    forked_from: toWireForkedFrom(forkedFromOf(fields)),
    negotiated: negotiated === undefined ? undefined : {
      agent_version: negotiated.agentVersion, image: negotiated.image, audio: negotiated.audio,
      fork: negotiated.fork, native_steering: negotiated.nativeSteering,
      question_form: negotiated.questionForm, plan_approval: negotiated.planApproval,
    },
    id: fields.id,
    workspace_id: fields.workspaceId,
    delivery: facts.delivery ?? fields.delivery ?? 'reply',
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(Math.max(fields.updatedAt, fields.activityUpdatedAt ?? 0)).toISOString(),
    own_updated_at: new Date(fields.ownUpdatedAt ?? fields.updatedAt).toISOString(),
    archived_at:
      fields.archivedAt === undefined ? undefined : new Date(fields.archivedAt).toISOString(),
    busy: facts.busy,
    executing: facts.executing,
    cleanup_pending: facts.cleanupPending,
    main_turn_active: facts.mainTurnActive,
    pending_interaction: facts.pendingInteraction,
    last_turn_reason:
      facts.lastTurnReason ?? (facts.live === false ? fields.lastTurnReason : undefined),
    execution_phase: fields.executionPhase,
    archived: fields.archived,
    private: fields.private,
    ephemeral: ephemeral || undefined,
    last_prompt: fields.lastPrompt,
    metadata: buildWireMetadata(fields.custom, cwd),
    worktree: fields.worktree === undefined ? undefined : {
      worktree_id: fields.worktree.worktreeId,
      branch: fields.worktree.branch,
      source_root: fields.worktree.sourceRoot,
      base_ref: fields.worktree.baseRef,
    },
    agent_config: facts.agentConfig ?? { model: '' },
    usage: fields.private === true ? emptySessionUsage() : facts.usage ?? emptySessionUsage(),
    usage_error: fields.private === true ? undefined : facts.usageError,
    permission_rules: [],
    message_count: 0,
    last_seq: lastSeq ?? 0,
  };
}

/** Live activity and interaction facts projected onto the wire `Session`. */
export interface SessionFacts {
  readonly busy: boolean;
  readonly executing?: boolean;
  readonly cleanupPending?: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly delivery?: 'reply' | 'message';
  readonly agentConfig?: Session['agent_config'];
  readonly executorId?: string;
  readonly allowKikiSubagents?: boolean;
  readonly usage?: SessionUsage;
  /** Why `usage` is missing or short: reading it failed, so the wire's zero
   *  usage is a placeholder (or an understated total) rather than a measured
   *  "no usage". */
  readonly usageError?: SessionUsageError;
  /** False when no live handle exists (cold session); live warm sessions
   *  always report their own outcome, never the persisted fallback. */
  readonly live?: boolean;
}

const COLD_SESSION_CACHE_TTL_MS = 10_000;
const MAX_COLD_SESSION_CACHE = 128;

interface ColdSessionBindingBase {
  readonly contextTokens: number;
  readonly contextLimit: number;
  readonly turnCount: number;
  readonly executorId: string;
  readonly agentConfig: Session['agent_config'];
}

interface ColdSessionBindingCacheEntry {
  revision?: string;
  wireKey?: string;
  expiresAt: number;
  readonly base: ColdSessionBindingBase;
}

interface ColdSessionCacheState {
  configGen: number;
  goalReader?: PersistedGoalReader;
  readonly statusValues: Map<string, { readonly revision: string; readonly expiresAt: number; readonly status: Awaited<ReturnType<ISessionLegacyService['status']>> }>;
  readonly statusInflight: Map<string, Promise<Awaited<ReturnType<ISessionLegacyService['status']>>>>;
  readonly bindingValues: Map<string, ColdSessionBindingCacheEntry>;
  readonly bindingInflight: Map<string, Promise<ColdSessionBindingBase>>;
}

const coldSessionCacheStates = new WeakMap<Scope, ColdSessionCacheState>();

function getColdSessionCacheState(core: Scope): ColdSessionCacheState {
  let state = coldSessionCacheStates.get(core);
  if (state !== undefined) return state;
  state = {
    configGen: 0,
    statusValues: new Map(),
    statusInflight: new Map(),
    bindingValues: new Map(),
    bindingInflight: new Map(),
  };
  coldSessionCacheStates.set(core, state);
  const evict = ({ sessionId }: { readonly sessionId: string }) => {
    state!.statusValues.delete(sessionId);
    state!.bindingValues.delete(sessionId);
  };
  const bumpGeneration = () => {
    state!.configGen += 1;
    state!.statusValues.clear();
    state!.bindingValues.clear();
  };
  try {
    core.accessor.get(IConfigService).onDidChangeConfiguration(bumpGeneration);
  } catch {}
  try {
    const models = core.accessor.get(IModelService);
    models.onDidChangeModels(bumpGeneration);
    models.onDidChangeDefaultModel(bumpGeneration);
  } catch {}
  try {
    core.accessor.get(IAgentProfileRegistry).onDidChange(bumpGeneration);
  } catch {}
  try {
    const manager = core.accessor.get(ISessionManager);
    manager.onDidCreateSession?.(evict);
    manager.onDidCloseSession?.(evict);
    manager.onDidArchiveSession?.(evict);
  } catch {}
  try {
    core.accessor.get(IEventService).onDidPublish((event) => {
      const typed = event as { readonly type?: unknown; readonly payload?: { readonly sessionId?: unknown } };
      const sessionId = typed.payload?.sessionId;
      if (typeof sessionId !== 'string') return;
      if (typed.type === 'session.meta.updated') {
        state!.statusValues.delete(sessionId);
        return;
      }
      evict({ sessionId });
    });
  } catch {}
  return state;
}

function statToken(stat: { readonly size: number; readonly identity?: string; readonly revision?: string } | undefined): string {
  return stat === undefined ? '-' : `${stat.size}:${stat.identity ?? ''}:${stat.revision ?? ''}`;
}

async function coldSessionArtifactStats(
  core: Scope,
  workspaceId: string,
  sessionId: string,
): Promise<{ readonly revision: string; readonly wireRevision: string } | undefined> {
  let storage: IFileSystemStorageService;
  let bootstrap: IBootstrapService;
  try {
    storage = core.accessor.get(IFileSystemStorageService);
    bootstrap = core.accessor.get(IBootstrapService);
  } catch {
    return undefined;
  }
  const state = getColdSessionCacheState(core);
  const statFn = storage.stat?.bind(storage);
  if (statFn === undefined) return undefined;
  const sessionScope = sessionScopeOf(workspacePersistenceScope(bootstrap.scope('sessions'), workspaceId), sessionId);
  const mainScope = agentScopeOf(sessionScope, MAIN_AGENT_ID);
  const [stateStat, wireStat, ckptStat] = await Promise.all([
    statFn(sessionScope, 'state.json').catch(() => undefined),
    statFn(mainScope, 'wire.jsonl').catch(() => undefined),
    statFn(`${mainScope}/replay-checkpoints`, 'engine-v1').catch(() => undefined),
  ]);
  const wireToken = `${statToken(wireStat)}#${statToken(ckptStat)}`;
  return {
    revision: `${state.configGen}#${statToken(stateStat)}#${wireToken}`,
    wireRevision: `${state.configGen}#${wireToken}`,
  };
}

function coldSessionBindingWireKey(
  wireRevision: string,
  sessionMeta: SessionMeta,
  mainMeta?: AgentMeta,
): string {
  const main = mainMeta ?? sessionMeta.agents?.[MAIN_AGENT_ID];
  return `${wireRevision}#${JSON.stringify({
    main,
    externalMain: isExternalClientMain(sessionMeta, MAIN_AGENT_ID),
    botPersonaId: sessionMeta.custom?.['bot_persona_id'],
    roomPersonaId: sessionMeta.custom?.['room_persona_id'],
    personaId: sessionMeta.custom?.['persona_id'],
  })}`;
}

async function coldSessionArtifactsRevision(core: Scope, workspaceId: string, sessionId: string): Promise<string | undefined> {
  return (await coldSessionArtifactStats(core, workspaceId, sessionId))?.revision;
}

async function readBoundedGiantColdSessionStatus(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  cwd: string | undefined,
): Promise<Awaited<ReturnType<ISessionLegacyService['status']>> | undefined> {
  const config = core.accessor.get(IConfigService);
  const strategy = config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)?.strategy ?? 'measured+estimated';
  if (strategy === 'estimated') return undefined;
  const storage = core.accessor.get(IFileSystemStorageService);
  const mainScope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId), MAIN_AGENT_ID);
  const wireSize = await logicalByteSize(storage, mainScope, 'wire.jsonl');
  if (wireSize === undefined || wireSize <= PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET) return undefined;
  const saved = await readColdSessionMeta(core, workspaceId, sessionId);
  const mainMetadata = saved?.agents?.[MAIN_AGENT_ID];
  const [profile, runtime] = await Promise.all([
    readPersistedAgentProfileSnapshot(
      core,
      workspaceId,
      sessionId,
      MAIN_AGENT_ID,
      mainMetadata,
      undefined,
      { inlineByteBudget: PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET, skipRequestAndMcp: true },
    ),
    readPersistedAgentRuntimeFacts(core, workspaceId, sessionId, MAIN_AGENT_ID, mainMetadata, undefined, { includeControls: true }),
  ]);
  const needsDefault = !(profile?.modelAlias || profile?.profileName);
  const preview = needsDefault
    ? createUnscopedAgentProfileCatalog(core.accessor.get(IInstantiationService), saved?.cwd ?? cwd, workspaceId, false)
    : undefined;
  try {
    await preview?.catalog.ready;
    const models = core.accessor.get(IModelService);
    await models.ready;
    const binding = resolveEffectiveSessionModel(models, profile ?? {}, needsDefault ? preview?.catalog.getDefault() : undefined);
    let thinkingLevel = profile?.modelAlias ? profile.thinkingLevel ?? '' : '';
    let modelName: string | null = null;
    let maxTokens = 0;
    if (binding.executorId === 'native' && binding.model !== undefined) {
      try {
        const boundProfile = profile?.boundProfile;
        const cognition = boundProfile?.promptBase?.inputs?.cognition;
        const settings = cognition?.modelAlias === binding.model ? cognition.modelSettings ?? cognition.recipe?.resolved.model : undefined;
        const model = modelWithUsage(core.accessor.get(IModelCatalog).get(binding.model, settings), cognition?.position ?? 'main');
        modelName = model.displayName ?? null;
        maxTokens = model.capabilities.max_input_tokens ?? model.capabilities.max_context_tokens;
        if (profile?.modelAlias) {
          const thinking = config.get<ThinkingConfig>(THINKING_SECTION);
          const base = thinkingLevel === 'off' && model.alwaysThinking
            ? resolveThinkingEffortForModel(thinkingLevel, thinking, model, requiresStrictThinkingValidation(
              core.accessor.get(IProtocolAdapterRegistry), model.protocol, model.providerType,
            ))
            : thinkingLevel as ThinkingEffort;
          thinkingLevel = resolveForcedThinkingEffort(thinking?.forcedEffort, base, drivesThinkingThroughTraits(model.providerType)) ?? base;
        }
        const entry = resolveModelProfileEntry(boundProfile?.modelProfiles, model.id, (id) => models.resolveId(id));
        const budget = mergeModelParameters(model, mergeModelParameters(boundProfile ?? {}, entry)).contextBudget;
        if (budget !== undefined) maxTokens = Math.min(maxTokens, budget);
      } catch { modelName = null; }
    }
    const tokens = strategy === 'measured'
      ? (runtime.measuredTokens ?? runtime.contextTokens ?? 0)
      : (runtime.contextTokens ?? 0);
    const controls = runtime.complete ? runtime.controls : undefined;
    return {
      busy: false,
      model: binding.model,
      model_name: modelName,
      thinking_level: thinkingLevel,
      permission: controls?.permissionConfigured ? controls.permissionMode : config.get<string>('defaultPermissionMode') ?? 'auto',
      plan_mode: controls?.planActive ?? false,
      context_tokens: tokens,
      max_context_tokens: maxTokens > 0 ? maxTokens : undefined,
      context_usage: maxTokens > 0 ? Math.min(1, tokens / maxTokens) : 0,
    };
  } finally {
    await preview?.dispose();
  }
}

async function readCachedColdSessionStatus(
  core: Scope,
  sessionId: string,
): Promise<Awaited<ReturnType<ISessionLegacyService['status']>>> {
  const state = getColdSessionCacheState(core);
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary !== undefined) {
    const revision = await coldSessionArtifactsRevision(core, summary.workspaceId, sessionId);
    if (revision !== undefined) {
      const cached = state.statusValues.get(sessionId);
      if (cached !== undefined && cached.revision === revision && Date.now() < cached.expiresAt) {
        return cached.status;
      }
    }
  }
  let pending = state.statusInflight.get(sessionId);
  if (pending === undefined) {
    pending = (async () => {
      const preRevision = summary === undefined
        ? undefined
        : await coldSessionArtifactsRevision(core, summary.workspaceId, sessionId);
      const bounded = summary === undefined
        ? undefined
        : await readBoundedGiantColdSessionStatus(core, summary.workspaceId, sessionId, summary.cwd);
      const status = bounded ?? await core.accessor.get(ISessionLegacyService).status(sessionId);
      if (summary !== undefined && preRevision !== undefined && getLiveSessionById(core.accessor, sessionId) === undefined) {
        const postRevision = await coldSessionArtifactsRevision(core, summary.workspaceId, sessionId);
        if (postRevision === preRevision) {
          if (state.statusValues.size >= MAX_COLD_SESSION_CACHE) {
            const oldest = state.statusValues.keys().next().value;
            if (oldest !== undefined) state.statusValues.delete(oldest);
          }
          state.statusValues.set(sessionId, {
            revision: preRevision,
            expiresAt: Date.now() + COLD_SESSION_CACHE_TTL_MS,
            status,
          });
        }
      }
      return status;
    })().finally(() => {
      if (state.statusInflight.get(sessionId) === pending) {
        state.statusInflight.delete(sessionId);
      }
    });
    state.statusInflight.set(sessionId, pending);
  }
  return pending;
}

async function computeColdSessionBindingBase(
  core: Scope,
  sessionId: string,
  workspaceId: string,
  metadata?: AgentMeta,
  signal?: AbortSignal,
  sessionMetadata?: SessionMeta,
): Promise<ColdSessionBindingBase> {
  const saved = sessionMetadata ?? await readColdSessionMeta(core, workspaceId, sessionId);
  const mainMetadata = metadata ?? saved?.agents?.[MAIN_AGENT_ID];
  const [profile, runtime] = await Promise.all([
    readPersistedAgentProfileSnapshot(
      core,
      workspaceId,
      sessionId,
      MAIN_AGENT_ID,
      mainMetadata,
      signal,
      { inlineByteBudget: PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET, skipRequestAndMcp: true },
    ),
    readPersistedAgentRuntimeFacts(core, workspaceId, sessionId, MAIN_AGENT_ID, mainMetadata, signal, { includeControls: true }),
  ]);
  const externallyDriven = profile?.driver === 'external' || saved !== undefined && isExternalClientMain(saved, MAIN_AGENT_ID);
  const preview = !externallyDriven && profile?.endpoint === undefined && !profile?.modelAlias && (profile?.executorId ?? 'native') === 'native'
    ? createUnscopedAgentProfileCatalog(core.accessor.get(IInstantiationService),
      (await core.accessor.get(IWorkspaceService).get(workspaceId))?.root, workspaceId, false) : undefined;
  let binding: { model: string | undefined; executorId: string };
  try {
    await preview?.catalog.ready;
    if (externallyDriven) {
      binding = { model: profile?.modelAlias, executorId: profile?.executorId ?? 'native' };
    } else if (profile?.endpoint !== undefined) {
      binding = { model: profile.modelAlias ?? materializeAdhocModel(profile.endpoint).id, executorId: 'native' };
    } else {
      const models = core.accessor.get(IModelService);
      await models.ready;
      binding = resolveEffectiveSessionModel(models, profile ?? {}, preview?.catalog.getDefault());
    }
  } finally { await preview?.dispose(); }
  const contextLimit = !externallyDriven && binding.executorId === 'native' ? persistedAgentContextLimit(core, profile, binding.model) : undefined;
  const persona = profile?.persona?.definition;
  let wirePersona = persona === undefined ? undefined : {
    id: persona.id, name: persona.name, avatarUrl: `/api/personas/${encodeURIComponent(persona.id)}/avatar`,
  };
  if (wirePersona === undefined) {
    const fallbackPersonaId = resolveSessionPersonaId(core, {
      id: sessionId,
      workspaceId,
      personaId: profile?.personaId ?? mainMetadata?.personaId ?? saved?.agents?.[MAIN_AGENT_ID]?.personaId,
      createdAt: saved?.createdAt ?? 0,
      updatedAt: saved?.updatedAt ?? 0,
      archived: saved?.archived ?? false,
      custom: saved?.custom,
    });
    if (fallbackPersonaId !== undefined) {
      const snapshot = await core.accessor.get(IPersonaStore).get(fallbackPersonaId);
      wirePersona = {
        id: fallbackPersonaId,
        name: snapshot?.definition.name ?? fallbackPersonaId,
        avatarUrl: `/api/personas/${encodeURIComponent(fallbackPersonaId)}/avatar`,
      };
    }
  }
  const controls = runtime.complete ? runtime.controls : undefined;
  let planGate = controls?.planGate;
  if (controls !== undefined && planGate === undefined) {
    try {
      planGate = (core.accessor.get(IConfigService).get<PlanConfig | undefined>(PLAN_SECTION) ?? DEFAULT_PLAN_CONFIG).gate;
    } catch {
      planGate = DEFAULT_PLAN_CONFIG.gate;
    }
  }
  return {
    contextTokens: runtime.contextTokens ?? 0,
    contextLimit: contextLimit ?? 0,
    turnCount: runtime.turnCount ?? 0,
    executorId: binding.executorId,
    agentConfig: {
      execution: profile?.execution,
      model: binding.model ?? '',
      profile: profile?.profileName,
      persona: wirePersona,
      permission_mode: controls?.permissionConfigured ? controls.permissionMode : undefined,
      plan_mode: controls?.planActive,
      plan_gate: planGate,
    },
  };
}

export async function resolveSessionBindingFacts(
  core: Scope,
  sessionId: string,
  workspaceId: string,
  persistedUsage?: SessionUsageSummary,
  metadata?: AgentMeta,
  signal?: AbortSignal,
  options: { readonly includeAccounting?: boolean; readonly sessionMetadata?: SessionMeta } = {},
): Promise<SessionFacts> {
  let facts = resolveSessionFacts(core, sessionId, persistedUsage);
  if (facts.live && !facts.agentConfig?.model) {
    const binding = await resolveSessionModelBinding(getLiveSessionById(core.accessor, sessionId)!);
    facts = { ...facts, executorId: binding.executorId, agentConfig: { ...facts.agentConfig, model: binding.model ?? '' } };
  }
  if (facts.live && facts.usage?.accounting?.complete) return facts;
  if (options.includeAccounting !== false) {
    try {
      const accounting = usageRuntime(core).service.readSessionAccountingSnapshot(workspaceId, sessionId, facts.usage?.accounting);
      facts = { ...facts, usage: { ...(facts.usage ?? emptySessionUsage()), accounting } };
    } catch (error) {
      signal?.throwIfAborted();
      facts = { ...facts, usageError: 'read-failed' };
      core.accessor.get(ILogService).warn('Session Usage accounting projection pending', { error: toErrorMessage(error) });
    }
  }
  if (facts.live) return facts;

  let base: ColdSessionBindingBase;
  if (metadata === undefined && options.sessionMetadata === undefined && signal === undefined) {
    const state = getColdSessionCacheState(core);
    const revision = await coldSessionArtifactsRevision(core, workspaceId, sessionId);
    const cached = revision === undefined ? undefined : state.bindingValues.get(sessionId);
    if (cached !== undefined && cached.revision === revision && Date.now() < cached.expiresAt) {
      base = cached.base;
    } else {
      let pending = state.bindingInflight.get(sessionId);
      if (pending === undefined) {
        pending = (async () => {
          const computed = await computeColdSessionBindingBase(core, sessionId, workspaceId);
          if (revision !== undefined && getLiveSessionById(core.accessor, sessionId) === undefined) {
            const postRevision = await coldSessionArtifactsRevision(core, workspaceId, sessionId);
            if (postRevision === revision) {
              if (state.bindingValues.size >= MAX_COLD_SESSION_CACHE) {
                const oldest = state.bindingValues.keys().next().value;
                if (oldest !== undefined) state.bindingValues.delete(oldest);
              }
              state.bindingValues.set(sessionId, {
                revision,
                expiresAt: Date.now() + COLD_SESSION_CACHE_TTL_MS,
                base: computed,
              });
            }
          }
          return computed;
        })().finally(() => {
          if (state.bindingInflight.get(sessionId) === pending) {
            state.bindingInflight.delete(sessionId);
          }
        });
        state.bindingInflight.set(sessionId, pending);
      }
      base = await pending;
    }
  } else if (metadata === undefined && options.sessionMetadata === undefined) {
    const state = getColdSessionCacheState(core);
    signal?.throwIfAborted();
    const revision = await coldSessionArtifactsRevision(core, workspaceId, sessionId);
    signal?.throwIfAborted();
    const cached = revision === undefined ? undefined : state.bindingValues.get(sessionId);
    if (cached !== undefined && cached.revision === revision && Date.now() < cached.expiresAt) {
      base = cached.base;
    } else {
      base = await computeColdSessionBindingBase(core, sessionId, workspaceId, undefined, signal, undefined);
      if (revision !== undefined && !signal?.aborted && getLiveSessionById(core.accessor, sessionId) === undefined) {
        const postRevision = await coldSessionArtifactsRevision(core, workspaceId, sessionId);
        if (postRevision === revision) {
          if (state.bindingValues.size >= MAX_COLD_SESSION_CACHE) {
            const oldest = state.bindingValues.keys().next().value;
            if (oldest !== undefined) state.bindingValues.delete(oldest);
          }
          state.bindingValues.set(sessionId, {
            revision,
            expiresAt: Date.now() + COLD_SESSION_CACHE_TTL_MS,
            base,
          });
        }
      }
    }
  } else if (options.sessionMetadata !== undefined) {
    const state = getColdSessionCacheState(core);
    signal?.throwIfAborted();
    const stats = await coldSessionArtifactStats(core, workspaceId, sessionId);
    signal?.throwIfAborted();
    const wireKey = stats === undefined ? undefined : coldSessionBindingWireKey(stats.wireRevision, options.sessionMetadata, metadata);
    const cached = wireKey === undefined ? undefined : state.bindingValues.get(sessionId);
    if (cached !== undefined && cached.wireKey === wireKey && Date.now() < cached.expiresAt) {
      cached.revision = stats!.revision;
      cached.expiresAt = Date.now() + COLD_SESSION_CACHE_TTL_MS;
      base = cached.base;
    } else {
      base = await computeColdSessionBindingBase(core, sessionId, workspaceId, metadata, signal, options.sessionMetadata);
      if (stats !== undefined && wireKey !== undefined && !signal?.aborted && getLiveSessionById(core.accessor, sessionId) === undefined) {
        const postStats = await coldSessionArtifactStats(core, workspaceId, sessionId);
        if (postStats?.wireRevision === stats.wireRevision) {
          if (state.bindingValues.size >= MAX_COLD_SESSION_CACHE) {
            const oldest = state.bindingValues.keys().next().value;
            if (oldest !== undefined) state.bindingValues.delete(oldest);
          }
          state.bindingValues.set(sessionId, {
            revision: postStats.revision,
            wireKey,
            expiresAt: Date.now() + COLD_SESSION_CACHE_TTL_MS,
            base,
          });
        }
      }
    }
  } else {
    base = await computeColdSessionBindingBase(core, sessionId, workspaceId, metadata, signal, options.sessionMetadata);
  }

  const usage = {
    ...(facts.usage ?? emptySessionUsage()),
    context_tokens: base.contextTokens,
    context_limit: base.contextLimit,
    turn_count: base.turnCount,
  };
  return {
    ...facts,
    usage,
    executorId: base.executorId,
    agentConfig: base.agentConfig,
  };
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
      executing: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
      usage:
        persistedUsage === undefined
          ? undefined
          : readPersistedSessionUsage(
              persistedUsage,
              core.accessor.get(IModelPricingService),
              sessionId,
            ),
      live: false,
    };
  }
  const agents = handle.accessor.get(IAgentLifecycleService).list();
  const main = agents.find((agent) => agent.id === MAIN_AGENT_ID);
  const sessionUsage = handle.accessor.get(ISessionMetadata).usage() ?? persistedUsage;
  const profile = main?.accessor.get(IAgentProfileService).data();
  const persona = profile?.persona?.definition;
  const usage: SessionUsageReadResult = main === undefined
    ? {}
    : readSessionUsage(
        main,
        agents,
        core.accessor.get(IModelPricingService),
        core.accessor.get(ILogService),
        sessionUsage,
      );
  let livePermissionMode: Session['agent_config']['permission_mode'];
  let livePlanMode: boolean | undefined;
  let livePlanGate: Session['agent_config']['plan_gate'];
  if (main !== undefined) {
    try {
      livePermissionMode = main.accessor.get(IAgentPermissionModeService).mode;
      livePlanMode = main.accessor.get(IAgentStateService).get(planKey).active;
      livePlanGate = main.accessor.get(IAgentPlanService).planGate;
    } catch {}
  }
  return {
    ...handle.accessor.get(ISessionActivityView).state(),
    delivery: handle.accessor.get(ISessionDeliveryService).mode(),
    executorId: profile === undefined ? undefined : profile.executorId ?? 'native',
    allowKikiSubagents: profile?.allowKikiSubagents,
    agentConfig: profile === undefined
      ? undefined
      : {
          execution: profile.execution,
          model: profile.modelAlias ?? '',
          profile: profile.profileName,
          persona: persona === undefined
            ? undefined
            : { id: persona.id, name: persona.name, avatarUrl: `/api/personas/${encodeURIComponent(persona.id)}/avatar` },
          permission_mode: livePermissionMode,
          plan_mode: livePlanMode,
          plan_gate: livePlanGate,
        },
    usage: usage.usage === undefined ? undefined : {
      ...usage.usage,
      accounting: sessionUsage?.accounting?.version === 2 ? sessionAccounting(sessionUsage.accounting, sessionId, core.accessor.get(IModelPricingService), sessionUsage.wireComplete === true && usage.error === undefined) : undefined,
    },
    usageError: usage.error,
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

function sessionAccounting(totals: UsageFactTotals, sessionId: string, pricing: IModelPricingService, complete: boolean): NonNullable<SessionUsage['accounting']> {
  let cost = 0;
  let unknown = totals.partial || !complete;
  for (const [model, masks] of Object.entries(totals.byModelMask ?? {})) {
    for (const value of Object.values(masks)) {
      const quoted = pricing.calculate(model, value);
      if (quoted === undefined || !Number.isFinite(cost + quoted)) unknown = true;
      else cost += quoted;
    }
  }
  return { version: 2, subject: { session_id: sessionId, scope: 'session' }, covered_at: Date.now(), complete, tokens: { input_other: totals.usage.inputOther, output: totals.usage.output, input_cache_read: totals.usage.inputCacheRead, input_cache_creation: totals.usage.inputCacheCreation }, tokens_unknown: totals.partial, cost_usd_estimated: cost, cost_unknown: unknown };
}

function readPersistedSessionUsage(
  persisted: SessionUsageSummary | undefined,
  pricing: IModelPricingService,
  sessionId: string,
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
  if (persisted.accounting?.version === 2) usage.accounting = sessionAccounting(persisted.accounting, sessionId, pricing, persisted.wireComplete === true);
  return usage;
}

interface SessionUsageReadResult {
  readonly usage?: SessionUsage;
  readonly error?: SessionUsageError;
}

function readSessionUsage(
  main: IAgentScopeHandle,
  agents: readonly IAgentScopeHandle[],
  pricing: IModelPricingService,
  log: ILogService,
  persisted?: SessionUsageSummary,
): SessionUsageReadResult {
  try {
    const status = readLegacyStatus(main, { contextBreakdown: false });
    if (status === undefined) return {};
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
    let agentUsageUnavailable = false;
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
        } catch (error) {
          agentUsageUnavailable = true;
          log.warn('session usage: agent usage unavailable', {
            agent_id: agent.id,
            error: toErrorMessage(error),
          });
        }
      }
    }

    applyModelPricing(usage, byModel, pricing);
    return agentUsageUnavailable
      ? { usage, error: 'agent-read-failed' }
      : { usage };
  } catch (error) {
    log.warn('session usage: read failed', { error: toErrorMessage(error) });
    return { error: 'read-failed' };
  }
}

async function withMainAgent<T>(core: Scope, sessionId: string, work: (agent: IAgentScopeHandle) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withSessionOperation(core, sessionId, async (session) => {
    signal?.throwIfAborted();
    if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    return work(await ensureMainAgent(session));
  }, signal);
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
  const { goal: _drop, [PROMOTED_FROM_KEY]: _promoted, [FORKED_FROM_KEY]: _forked, ...rest } = custom as {
    goal?: unknown;
    [key: string]: unknown;
  };
  return { ...rest, cwd };
}

function toWirePromotedFrom(value: SessionPromotedFrom | undefined): Session['promoted_from'] {
  if (value === undefined) return undefined;
  return {
    session_id: value.sessionId,
    agent_id: value.agentId,
    agent_name: value.agentName,
    profile: value.profile,
    promoted_at: value.promotedAt === undefined ? undefined : new Date(value.promotedAt).toISOString(),
  };
}

function toWireForkedFrom(value: SessionForkedFrom | undefined): Session['forked_from'] {
  if (value === undefined) return undefined;
  return {
    session_id: value.sessionId,
    title: value.title,
    through_message_id: value.throughMessageId,
    turn_index: value.turnIndex,
    through_user_message: value.throughUserMessage,
    seed: value.seed,
    forked_at: value.forkedAt === undefined ? undefined : new Date(value.forkedAt).toISOString(),
  };
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

interface SessionErrorEnvelope {
  readonly code: number;
  readonly msg: string;
  readonly data: unknown;
  readonly request_id: string;
  readonly details?: unknown;
  readonly stack?: string;
}

function mapSessionError(req: { id: string }, err: unknown): SessionErrorEnvelope {
  const requestId = req.id;
  if (err instanceof AdmissionError) {
    return errEnvelope(40301, err.reason, requestId);
  }
  if (err instanceof SessionCreateReceiptError) {
    return { ...errEnvelope(err.code, err.message, requestId), details: err.details };
  }
  if (err instanceof ProfileError) {
    return errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack);
  }
  if (isError2(err)) {
    switch (err.code as unknown as string) {
      case 'session.not_found':
      case 'agent.not_found':
        return errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack);
      case ErrorCodes.SESSION_TITLE_GENERATION_FAILED:
        return errEnvelope(ErrorCode.SESSION_TITLE_UNAVAILABLE, err.message, requestId);
      case 'session.fork_active_turn':
      case ErrorCodes.SESSION_BUSY:
        return {
          code: ErrorCode.SESSION_BUSY,
          msg: err.message,
          data: null,
          request_id: requestId,
          details: err.details,
          stack: err.stack,
        };
      case ErrorCodes.STORAGE_LOCKED:
        return errEnvelope(ErrorCode.SESSION_LOCKED, err.message, requestId, err.stack);
      case ErrorCodes.SESSION_INDEX_BUILDING:
        return errEnvelope(ErrorCode.SESSION_INDEX_BUILDING, err.message, requestId, err.stack);
      case 'compaction.unable':
        return errEnvelope(ErrorCode.COMPACTION_UNABLE, err.message, requestId, err.stack);
      case 'session.undo_unavailable':
        return {
          code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
          msg: err.message,
          data: (err as { details?: unknown }).details ?? null,
          request_id: requestId,
          stack: err.stack,
        };
      case 'message.action_unavailable':
      case 'session.cursor_mismatch':
        return {
          code: err.code === 'message.action_unavailable'
            ? ErrorCode.MESSAGE_ACTION_UNAVAILABLE
            : ErrorCode.SESSION_CURSOR_MISMATCH,
          msg: err.message,
          data: null,
          request_id: requestId,
          details: err.details,
          stack: err.stack,
        };
      case ErrorCodes.GOAL_ALREADY_EXISTS:
        return errEnvelope(ErrorCode.GOAL_ALREADY_EXISTS, err.message, requestId, err.stack);
      case ErrorCodes.GOAL_NOT_FOUND:
        return errEnvelope(ErrorCode.GOAL_NOT_FOUND, err.message, requestId, err.stack);
      case ErrorCodes.GOAL_STATUS_INVALID:
        return errEnvelope(ErrorCode.GOAL_STATUS_INVALID, err.message, requestId, err.stack);
      case ErrorCodes.GOAL_NOT_RESUMABLE:
        return errEnvelope(ErrorCode.GOAL_NOT_RESUMABLE, err.message, requestId, err.stack);
      case ErrorCodes.GOAL_OBJECTIVE_EMPTY:
        return errEnvelope(ErrorCode.GOAL_OBJECTIVE_EMPTY, err.message, requestId, err.stack);
      case ErrorCodes.GOAL_OBJECTIVE_TOO_LONG:
        return errEnvelope(ErrorCode.GOAL_OBJECTIVE_TOO_LONG, err.message, requestId, err.stack);
      case ErrorCodes.FS_PATH_NOT_FOUND:
        return errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack);
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
        return errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack);
      default:
        requestLog(req)?.error({ request_id: requestId, error_type: err.name }, 'session request failed');
        return errEnvelope(ErrorCode.INTERNAL_ERROR, err.message, requestId, err.stack);
    }
  }
  requestLog(req)?.error({ request_id: requestId, error_type: err instanceof Error ? err.name : typeof err }, 'session request failed');
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    err instanceof Error ? err.message : String(err),
    requestId,
    err instanceof Error ? err.stack : undefined,
  );
}

function sendMappedError(
  reply: { code?(status: number): { send(payload: unknown): unknown }; send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  dispatchMappedError(reply, req, err, {
    admission: true,
    custom: (error, _requestId, targetReply) => {
      const mapped = mapSessionError(req, error);
      if (mapped.code === 40301 && targetReply.code !== undefined) {
        targetReply.code(403).send(mapped);
        return true;
      }
      targetReply.send(mapped);
      return true;
    },
  });
}

/** Projects a freshly created or promoted live session onto the wire, including its current event cursor. */
export async function liveWireSession(
  core: Scope,
  handle: ISessionScopeHandle,
  broadcaster: SessionEventBroadcaster | undefined,
): Promise<Session> {
  const meta = await handle.accessor.get(ISessionMetadata).read();
  const ctx = handle.accessor.get(ISessionContext);
  const session = toWireSession({ ...meta, workspaceId: ctx.workspaceId }, ctx.cwd, resolveSessionFacts(core, meta.id));
  const cursor = await broadcaster?.getCursor(meta.id);
  return cursor === undefined ? session : { ...session, last_seq: cursor.seq };
}

export { sendMappedError as sendSessionError };
