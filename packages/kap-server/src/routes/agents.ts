import { IAgentLifecycleService, IAppendLogStore, IAtomicDocumentStore, IModelService, IPluginUsageService, ISessionContext, ISessionIndex, ISessionManager, ISessionMetadata, IWorkspaceInstanceManager, type Scope } from '@kiki/agent-core-v2';
import type { SessionMeta } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import { IHookRulesRegistry } from '@kiki/agent-core-v2/features/externalHooks/app/hookRules';
import { IHookRulesSession } from '@kiki/agent-core-v2/features/externalHooks/session/hookRules';
import { projectHookInspection, readPersistedHookInspection } from '@kiki/agent-core-v2/features/externalHooks/internal/inspection';
import { loadWorkspaceHookRules, projectHookRules } from '@kiki/agent-core-v2/features/externalHooks/internal/snapshot';
import { IAgentHookRules } from '@kiki/agent-core-v2/features/externalHooks/agent/hookRules';
import { agentHooksInspectSchema } from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface RouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
}

export function registerAgentHooksRoutes(app: RouteHost, core: Scope): void {
  const route = defineRoute({ method: 'GET', path: '/sessions/{session_id}/agents/{agent_id}/hooks',
    params: z.object({ session_id: z.string().min(1), agent_id: z.string().min(1) }),
    success: { data: agentHooksInspectSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.SESSION_NOT_FOUND]: {} },
    description: 'Inspect effective hook rules, sources and cadence for an agent', tags: ['sessions'],
  }, async (req, reply) => {
    const models = core.accessor.get(IModelService);
    const finish = (snapshot: Parameters<typeof projectHookInspection>[0], persisted: Awaited<ReturnType<typeof readPersistedHookInspection>>) => {
      const binding = { ...persisted.binding, modelId: persisted.binding.modelAlias === undefined ? undefined : models.resolveId(persisted.binding.modelAlias) };
      reply.send(okEnvelope(projectHookInspection(snapshot, binding, persisted.clock), req.id));
    };
    if (core.accessor.get(ISessionManager).get(req.params.session_id) !== undefined) {
      await withSessionOperation(core, req.params.session_id, async session => {
        if (session === undefined) { reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id)); return; }
        const agent = session.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
        if (agent !== undefined) { reply.send(okEnvelope(await agent.accessor.get(IAgentHookRules).inspect(), req.id)); return; }
        const metadata = (await session.accessor.get(ISessionMetadata).read()).agents?.[req.params.agent_id];
        if (metadata === undefined) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent does not exist in this session', req.id)); return; }
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
    if (metadata === undefined) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent does not exist in this session', req.id)); return; }
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
          usage.enabled() ? usage.read(summary.workspaceId).then(value => value.overrides) : undefined,
          readPersistedHookInspection(core.accessor.get(IAppendLogStore), `${scope}/agents/${req.params.agent_id}`, metadata),
        ]);
        finish(projectHookRules(registry.snapshot(), project, registry.disabled(), lease.instance.program.trust.isTrusted(), overrides), persisted);
      } finally { runtime.dispose(); }
    } finally { lease.dispose(); }
  });
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
