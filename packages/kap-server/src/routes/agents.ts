import { Error2, ErrorCodes, IAgentLifecycleService, IAppendLogStore, IAtomicDocumentStore, IEventService, IFileSystemStorageService, IModelService, IPluginUsageService, ISessionContext, ISessionIndex, ISessionManager, ISessionMetadata, IWorkspaceInstanceManager, SessionCreated, type ISessionScopeHandle, type Scope } from '@kiki/agent-core-v2';
import type { SessionMeta } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import { IHookRulesRegistry } from '@kiki/agent-core-v2/features/externalHooks/app/hookRules';
import { IHookRulesSession } from '@kiki/agent-core-v2/features/externalHooks/session/hookRules';
import { projectHookInspection, readPersistedHookInspection } from '@kiki/agent-core-v2/features/externalHooks/internal/inspection';
import { loadWorkspaceHookRules, projectHookRules } from '@kiki/agent-core-v2/features/externalHooks/internal/snapshot';
import { IAgentHookRules } from '@kiki/agent-core-v2/features/externalHooks/agent/hookRules';
import { logicalByteSize } from '@kiki/agent-core-v2/persistence/coldSegmentLog';
import { agentHooksInspectSchema, promoteAgentRequestSchema } from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { sessionSchema, type Session } from '../protocol/session';
import { parseActionSuffix } from './action-suffix';

interface RouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
  post?(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown; body: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
}

/** Registers `POST /sessions/{session_id}/agents/{agent_id}:promote` — open a subagent as its own thread. */
export function registerAgentPromoteRoutes(
  app: RouteHost,
  core: Scope,
  toSession: (handle: ISessionScopeHandle) => Promise<Session>,
  sendError: (reply: { send(payload: unknown): unknown }, req: { id: string }, error: unknown) => void,
): void {
  const route = defineRoute({ method: 'POST', path: '/sessions/{session_id}/agents/{agent_id}',
    params: z.object({ session_id: z.string().min(1), agent_id: z.string().min(1) }),
    body: promoteAgentRequestSchema,
    success: { data: sessionSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.SESSION_LOCKED]: {} },
    description: 'Open a subagent as an independent top-level thread; the source session is left unchanged', tags: ['sessions'],
    operationId: 'promoteSessionAgent',
  }, async (req, reply) => {
    try {
      const parsed = parseActionSuffix({ tail: req.params.agent_id, allowedActions: ['promote'] as const, resourceLabel: 'agent' });
      if (parsed.kind !== 'action') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${req.params.agent_id}`, req.id));
        return;
      }
      const manager = core.accessor.get(ISessionManager);
      if (manager.promoteAgent === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Opening a subagent as a thread is unavailable');
      const handle = await manager.promoteAgent({
        sourceSessionId: req.params.session_id,
        agentId: parsed.id,
        title: req.body.title,
        profile: req.body.profile,
      });
      const session = await toSession(handle);
      core.accessor.get(IEventService).publish(new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }));
      reply.send(okEnvelope(session, req.id));
    } catch (error) {
      sendError(reply, req, error);
    }
  });
  app.post?.(route.path, route.options, route.handler as Parameters<NonNullable<RouteHost['post']>>[2]);
}

export function registerAgentHooksRoutes(app: RouteHost, core: Scope): void {
  const route = defineRoute({ method: 'GET', path: '/sessions/{session_id}/agents/{agent_id}/hooks',
    params: z.object({ session_id: z.string().min(1), agent_id: z.string().min(1) }),
    querystring: z.object({ observe: z.enum(['true', 'false']).optional() }),
    success: { data: agentHooksInspectSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.SESSION_BUSY]: {} },
    description: 'Inspect effective hook rules, sources and cadence for an agent', tags: ['sessions'],
  }, async (req, reply) => {
    const models = core.accessor.get(IModelService);
    const finish = (snapshot: Parameters<typeof projectHookInspection>[0], persisted: Awaited<ReturnType<typeof readPersistedHookInspection>>) => {
      const binding = { ...persisted.binding, modelId: persisted.binding.modelAlias === undefined ? undefined : models.resolveId(persisted.binding.modelAlias) };
      reply.send(okEnvelope(projectHookInspection(snapshot, binding, persisted.clock), req.id));
    };
    const live = core.accessor.get(ISessionManager).get(req.params.session_id);
    const agent = live?.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
    if (agent !== undefined) { reply.send(okEnvelope(await agent.accessor.get(IAgentHookRules).inspect(), req.id)); return; }
    if (live !== undefined) {
      await withSessionOperation(core, req.params.session_id, async session => {
        if (session === undefined) { reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id)); return; }
        const resident = session.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
        if (resident !== undefined) { reply.send(okEnvelope(await resident.accessor.get(IAgentHookRules).inspect(), req.id)); return; }
        const metadata = (await session.accessor.get(ISessionMetadata).read()).agents?.[req.params.agent_id];
        if (metadata === undefined && req.params.agent_id !== 'main') { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent does not exist in this session', req.id)); return; }
        const rules = session.accessor.get(IHookRulesSession);
        const [, persisted] = await Promise.all([rules.ready, readPersistedHookInspection(core.accessor.get(IAppendLogStore), session.accessor.get(ISessionContext).scope(`agents/${req.params.agent_id}`), metadata)]);
        finish(rules.snapshot(), persisted);
      });
      return;
    }
    const summary = await core.accessor.get(ISessionIndex).get(req.params.session_id);
    if (summary === undefined) { reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id)); return; }
    const scope = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
    const docs = core.accessor.get(IAtomicDocumentStore);
    const metadata = (await docs.get<SessionMeta>(scope, 'state.json') ?? await docs.get<SessionMeta>(`${scope}/session-meta`, 'state.json'))?.agents?.[req.params.agent_id];
    if (metadata === undefined && req.params.agent_id !== 'main') { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent does not exist in this session', req.id)); return; }
    if (req.query.observe === 'true' && (await logicalByteSize(core.accessor.get(IFileSystemStorageService), `${scope}/agents/${req.params.agent_id}`, 'wire.jsonl') ?? 0) > 8 * 1024 * 1024) {
      reply.send(errEnvelope(ErrorCode.SESSION_BUSY, 'Hook cadence is unavailable while the agent is not active', req.id));
      return;
    }
    const lease = await core.accessor.get(IWorkspaceInstanceManager).acquire({ workspaceId: summary.workspaceId });
    try {
      await lease.instance.program.ready;
      const runtime = lease.instance.runtimes.acquire(lease.instance.program.binding, ['fs']);
      try {
        const registry = core.accessor.get(IHookRulesRegistry);
        const usage = core.accessor.get(IPluginUsageService);
        const [, project, overrides, persisted] = await Promise.all([
          registry.ready,
          loadWorkspaceHookRules({ _serviceBrand: undefined, runtime: runtime.runtime, root: lease.instance.root, trust: lease.instance.program.trust }, alias => models.resolveId(alias)),
          registry.ready.then(async () => {
            const ids = [...new Set(registry.snapshot().rules.filter(rule => rule.namespace.startsWith('plugin/')).map(rule => rule.namespace.slice(7)))];
            return Object.fromEntries(await Promise.all(ids.map(async id => [id, await usage.allows(summary.workspaceId, id, summary.id)])));
          }),
          readPersistedHookInspection(core.accessor.get(IAppendLogStore), `${scope}/agents/${req.params.agent_id}`, metadata),
        ]);
        finish(projectHookRules(registry.snapshot(), project, registry.disabled(), lease.instance.program.trust.isTrusted(), overrides), persisted);
      } finally { runtime.dispose(); }
    } finally { lease.dispose(); }
  });
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
