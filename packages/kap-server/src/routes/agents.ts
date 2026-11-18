import { Error2, ErrorCodes, IAgentLifecycleService, IAppendLogStore, IAtomicDocumentStore, IEventService, IFileSystemStorageService, IInstantiationService, IModelService, IPluginUsageService, IProviderService, ISessionContext, ISessionIndex, ISessionManager, ISessionMetadata, IWorkspaceInstanceManager, SessionCreated, type ISessionScopeHandle, type Scope } from '@kiki/agent-core-v2';
import { effectiveModelConfig, resolveModelProviderId } from '@kiki/agent-core-v2/kosong/model/modelAuth';
import type { AgentMeta, SessionMeta } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
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

const PERSISTED_HOOK_CACHE_MAX_ENTRIES = 128;

interface CachedHookInspectionEntry {
  readonly size: number;
  readonly mtime: number | undefined;
  readonly metaStamp: string;
  readonly value: Awaited<ReturnType<typeof readPersistedHookInspection>>;
}

interface HookInspectionCacheState {
  readonly cache: Map<string, CachedHookInspectionEntry>;
  readonly flights: Map<string, Promise<Awaited<ReturnType<typeof readPersistedHookInspection>>>>;
  readonly workspaceFlights: Map<string, Promise<unknown>>;
}

const hookInspectionStates = new WeakMap<Scope, HookInspectionCacheState>();

function hookInspectionState(core: Scope): HookInspectionCacheState {
  let state = hookInspectionStates.get(core);
  if (state !== undefined) return state;
  state = { cache: new Map(), flights: new Map(), workspaceFlights: new Map() };
  hookInspectionStates.set(core, state);
  const captured = state;
  core.accessor.get(IInstantiationService).onWillDispose(() => {
    captured.cache.clear();
    captured.flights.clear();
    captured.workspaceFlights.clear();
    hookInspectionStates.delete(core);
  });
  return state;
}

async function readCachedPersistedHookInspection(
  core: Scope,
  agentScope: string,
  metadata: AgentMeta | undefined,
  knownSize?: number,
): Promise<Awaited<ReturnType<typeof readPersistedHookInspection>>> {
  const state = hookInspectionState(core);
  const storage = core.accessor.get(IFileSystemStorageService);
  const [size, mtime] = await Promise.all([
    knownSize !== undefined ? Promise.resolve(knownSize) : logicalByteSize(storage, agentScope, 'wire.jsonl'),
    storage.mtime(agentScope, 'wire.jsonl'),
  ]);
  const resolvedSize = size ?? 0;
  const metaStamp = JSON.stringify(metadata ?? null);
  const cached = state.cache.get(agentScope);
  if (cached !== undefined && cached.size === resolvedSize && cached.mtime === mtime && cached.metaStamp === metaStamp) {
    state.cache.delete(agentScope);
    state.cache.set(agentScope, cached);
    return cached.value;
  }
  const flightKey = `${agentScope}\0${resolvedSize}\0${mtime ?? ''}\0${metaStamp}`;
  const existingFlight = state.flights.get(flightKey);
  if (existingFlight !== undefined) return existingFlight;
  const promise = readPersistedHookInspection(core.accessor.get(IAppendLogStore), agentScope, metadata)
    .then(async (value) => {
      const [afterSize, afterMtime] = await Promise.all([
        logicalByteSize(storage, agentScope, 'wire.jsonl'),
        storage.mtime(agentScope, 'wire.jsonl'),
      ]);
      if ((afterSize ?? 0) === resolvedSize && afterMtime === mtime) {
        state.cache.delete(agentScope);
        state.cache.set(agentScope, { size: resolvedSize, mtime, metaStamp, value });
        while (state.cache.size > PERSISTED_HOOK_CACHE_MAX_ENTRIES) {
          const oldest = state.cache.keys().next().value;
          if (oldest === undefined) break;
          state.cache.delete(oldest);
        }
      }
      return value;
    })
    .finally(() => {
      if (state.flights.get(flightKey) === promise) state.flights.delete(flightKey);
    });
  state.flights.set(flightKey, promise);
  return promise;
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
    const providers = core.accessor.get(IProviderService);
    const finish = (snapshot: Parameters<typeof projectHookInspection>[0], persisted: Awaited<ReturnType<typeof readPersistedHookInspection>>) => {
      const modelAlias = persisted.binding.modelAlias;
      const canonicalModelId = modelAlias === undefined ? undefined : (models.resolveId(modelAlias) ?? modelAlias);
      const modelRecord = canonicalModelId === undefined
        ? undefined
        : (models.get(canonicalModelId) ?? (modelAlias === undefined ? undefined : models.get(modelAlias)));
      const providerId = modelRecord === undefined
        ? undefined
        : resolveModelProviderId(modelRecord, providers.getDefaultProvider());
      const providerRecord = providerId === undefined ? undefined : providers.get(providerId);
      const providerType = providerRecord?.type ?? modelRecord?.protocol;
      const effectiveModel = modelRecord === undefined ? undefined : effectiveModelConfig(modelRecord, providerType);
      const remoteModelId = effectiveModel === undefined
        ? canonicalModelId
        : (effectiveModel.name ?? effectiveModel.model ?? canonicalModelId);
      const materialized = persisted.binding.profileId !== undefined || modelAlias !== undefined || persisted.binding.permissionMode !== undefined;
      const binding = {
        ...persisted.binding,
        modelId: canonicalModelId,
        remoteModelId,
        providerId,
        providerType,
        permissionMode: persisted.binding.permissionMode ?? (materialized ? 'auto' : undefined),
      };
      reply.send(okEnvelope(projectHookInspection(snapshot, binding, persisted.clock), req.id));
    };
    const live = core.accessor.get(ISessionManager).get(req.params.session_id);
    const agent = live?.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
    if (agent !== undefined) { reply.send(okEnvelope(await agent.accessor.get(IAgentHookRules).inspect(), req.id)); return; }
    if (live !== undefined) {
      const liveAgentScope = live.accessor.get(ISessionContext).scope(`agents/${req.params.agent_id}`);
      const liveWireSize = req.query.observe === 'true'
        ? (await logicalByteSize(core.accessor.get(IFileSystemStorageService), liveAgentScope, 'wire.jsonl') ?? 0)
        : undefined;
      if (liveWireSize !== undefined && liveWireSize > 8 * 1024 * 1024) {
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, 'Hook cadence is unavailable while the agent is not active', req.id));
        return;
      }
      await withSessionOperation(core, req.params.session_id, async session => {
        if (session === undefined) { reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id)); return; }
        const resident = session.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
        if (resident !== undefined) { reply.send(okEnvelope(await resident.accessor.get(IAgentHookRules).inspect(), req.id)); return; }
        const metadata = (await session.accessor.get(ISessionMetadata).read()).agents?.[req.params.agent_id];
        if (metadata === undefined && req.params.agent_id !== 'main') { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent does not exist in this session', req.id)); return; }
        const rules = session.accessor.get(IHookRulesSession);
        const [, persisted] = await Promise.all([
          rules.ready,
          readCachedPersistedHookInspection(core, session.accessor.get(ISessionContext).scope(`agents/${req.params.agent_id}`), metadata, liveWireSize),
        ]);
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
    const coldAgentScope = `${scope}/agents/${req.params.agent_id}`;
    const coldWireSize = req.query.observe === 'true'
      ? (await logicalByteSize(core.accessor.get(IFileSystemStorageService), coldAgentScope, 'wire.jsonl') ?? 0)
      : undefined;
    if (coldWireSize !== undefined && coldWireSize > 8 * 1024 * 1024) {
      reply.send(errEnvelope(ErrorCode.SESSION_BUSY, 'Hook cadence is unavailable while the agent is not active', req.id));
      return;
    }
    const state = hookInspectionState(core);
    const workspaceKey = `${summary.workspaceId}\0${summary.id}`;
    let workspaceRulesFlight = state.workspaceFlights.get(workspaceKey) as Promise<Parameters<typeof projectHookInspection>[0]> | undefined;
    if (workspaceRulesFlight === undefined) {
      const flight = (async () => {
        const lease = await core.accessor.get(IWorkspaceInstanceManager).acquire({ workspaceId: summary.workspaceId });
        try {
          await lease.instance.program.ready;
          const runtime = lease.instance.runtimes.acquire(lease.instance.program.binding, ['fs']);
          try {
            const registry = core.accessor.get(IHookRulesRegistry);
            const usage = core.accessor.get(IPluginUsageService);
            const [, project, overrides] = await Promise.all([
              registry.ready,
              loadWorkspaceHookRules({ _serviceBrand: undefined, runtime: runtime.runtime, root: lease.instance.root, trust: lease.instance.program.trust }, alias => models.resolveId(alias)),
              registry.ready.then(async () => {
                const ids = [...new Set(registry.snapshot().rules.filter(rule => rule.namespace.startsWith('plugin/')).map(rule => rule.namespace.slice(7)))];
                return Object.fromEntries(await Promise.all(ids.map(async id => [id, await usage.allows(summary.workspaceId, id, summary.id)])));
              }),
            ]);
            return projectHookRules(registry.snapshot(), project, registry.disabled(), lease.instance.program.trust.isTrusted(), overrides);
          } finally { runtime.dispose(); }
        } finally { lease.dispose(); }
      })().finally(() => {
        if (state.workspaceFlights.get(workspaceKey) === flight) state.workspaceFlights.delete(workspaceKey);
      });
      state.workspaceFlights.set(workspaceKey, flight);
      workspaceRulesFlight = flight;
    }
    const [rulesSnapshot, persisted] = await Promise.all([
      workspaceRulesFlight,
      readCachedPersistedHookInspection(core, coldAgentScope, metadata, coldWireSize),
    ]);
    finish(rulesSnapshot, persisted);
  });
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
