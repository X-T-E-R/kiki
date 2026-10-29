import { IAgentLifecycleService, IAgentMemoryAdvisor, ISessionManager, IConfigService, IMemoryAuthorityService, IMemoryStore, IMemorySelector, IWorkspaceService, MEMORY_SECTION, MemoryConfigSchema, MemoryDomainError, advisorStatus, memoryApplicability, memoryEnabled, type MemoryConfig, type MemoryScope, type Scope } from '@kiki/agent-core-v2';
import { memoryPutBodySchema, memorySettingsPatchSchema, memorySettingsResponseSchema, memoryAdvisorProbeInputSchema, memoryAdvisorProbeResultSchema, memoryAdvisorStatusSchema } from '@kiki/protocol';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface MemoryRouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown } & Pick<FastifyReply, 'then'>) => unknown): unknown;
  put(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown } & Pick<FastifyReply, 'then'>) => unknown): unknown;
  patch(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown } & Pick<FastifyReply, 'then'>) => unknown): unknown;
  post(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown } & Pick<FastifyReply, 'then'>) => unknown): unknown;
  delete(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown } & Pick<FastifyReply, 'then'>) => unknown): unknown;
}
const scopeParams = z.object({ scope: z.enum(['global', 'workspace', 'persona', 'persona_workspace']) });
const entryParams = scopeParams.extend({ id: z.string().regex(/^m_[a-zA-Z0-9_]+$/) });
const personaIdQuery = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional();
const scopeQuery = z.object({ workspace_id: z.string().optional(), persona_id: personaIdQuery });
const entryQuery = scopeQuery.extend({ expected_revision: z.string().optional() });
const body = memoryPutBodySchema.extend({ action: z.enum(['create', 'update', 'supersede', 'archive']).default('create') });
const generic = z.any();
const errors = { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.MEMORY_NOT_FOUND]: {}, [ErrorCode.WORKSPACE_NOT_FOUND]: {}, [ErrorCode.MEMORY_REVISION_CONFLICT]: {} };

export function registerMemoryRoutes(app: MemoryRouteHost, core: Scope): void {
  const config = core.accessor.get(IConfigService);
  const store = () => core.accessor.get(IMemoryStore);
  const authority = () => core.accessor.get(IMemoryAuthorityService);
  const add = (method: keyof MemoryRouteHost, route: ReturnType<typeof defineRoute>): void => {
    app[method](route.path, route.options, route.handler);
  };
  const settings = () => config.get<MemoryConfig>(MEMORY_SECTION);
  const resolve = async (
    kind: 'global' | 'workspace' | 'persona' | 'persona_workspace',
    workspaceId?: string,
    personaId?: string,
  ): Promise<MemoryScope> => {
    if (kind === 'global') return { kind: 'global' };
    if (kind === 'persona') {
      if (personaId === undefined) throw new Error('Persona id is required');
      return { kind: 'persona', personaId };
    }
    if (workspaceId === undefined || await core.accessor.get(IWorkspaceService).get(workspaceId) === undefined) throw new Error('Workspace not found');
    if (kind === 'persona_workspace') {
      if (personaId === undefined) throw new Error('Persona id is required');
      return { kind: 'persona_workspace', workspaceId, personaId };
    }
    return { kind: 'workspace', workspaceId };
  };
  const handle = async (requestId: string, reply: { send(payload: unknown): unknown } & Pick<FastifyReply, 'then'>, operation: () => Promise<unknown>): Promise<void> => {
    try { reply.send(okEnvelope(await operation(), requestId)); }
    catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const code = error instanceof MemoryDomainError && (error.code === 'revision_conflict' || error.code === 'covered_target_changed' || error.code === 'cursor_invalidated') || msg.includes('revision conflict') ? ErrorCode.MEMORY_REVISION_CONFLICT : msg === 'Workspace not found' ? ErrorCode.WORKSPACE_NOT_FOUND : msg.includes('not found') ? ErrorCode.MEMORY_NOT_FOUND : ErrorCode.VALIDATION_FAILED;
      reply.send({ ...errEnvelope(code, msg, requestId), details: error instanceof MemoryDomainError ? { code: error.code, recovery: error.recovery } : undefined });
    }
  };

  add('get', defineRoute({ method: 'GET', path: '/memory/authority', success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, () => authority().status());
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/authority/migrate', body: z.object({ operation_id: z.string().uuid(), older_writers_stopped: z.literal(true).optional(), max_pages: z.number().int().min(1).max(64).optional() }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, () => authority().migrate({ operationId: req.body.operation_id, maxPages: req.body.max_pages }));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/authority/retry', body: z.object({ operation_id: z.string().uuid() }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, () => authority().retryMigration(req.body.operation_id));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/authority/cancel', body: z.object({ operation_id: z.string().uuid() }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, () => authority().cancelMigration(req.body.operation_id));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/authority/recover-readonly', body: z.object({ confirm_readonly: z.literal(true) }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, () => authority().recoverReadOnly());
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/authority/resume-editing', body: z.object({ recovery_id: z.string().uuid(), expected_epoch: z.number().int().nonnegative() }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, () => authority().resumeEditing(req.body.recovery_id, req.body.expected_epoch));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/{scope}/forget-preview', params: scopeParams, querystring: scopeQuery, body: z.object({ ids: z.array(entryParams.shape.id).min(1).max(1000) }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => authority().previewForget(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), req.body.ids));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/{scope}/forget', params: scopeParams, querystring: scopeQuery, body: z.object({ operation_id: z.string().uuid(), confirm_irreversible: z.literal(true), targets: z.array(z.object({ id: entryParams.shape.id, expected_revision: z.string().min(1) }).strict()).min(1).max(1000) }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      await authority().forget(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), req.body.targets.map((target) => ({ id: target.id, expectedRevision: target.expected_revision })), req.body.operation_id);
      return { operation_id: req.body.operation_id, forgotten: req.body.targets.map((target) => target.id) };
    });
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/{id}/export', params: entryParams, querystring: scopeQuery, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => authority().exportMarkdown(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), req.params.id));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/{scope}/import-preview', params: scopeParams, querystring: scopeQuery, body: z.object({ markdown: z.string().max(65_536), source_locator: z.string().trim().min(1).max(2_000), reason: z.string().trim().min(1).max(500) }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => authority().previewImport(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), { markdown: req.body.markdown, sourceLocator: req.body.source_locator, reason: req.body.reason }));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/{scope}/import', params: scopeParams, querystring: scopeQuery, body: z.object({ preview_token: z.string().min(1).max(600_000), operation_id: z.string().uuid(), confirm_import: z.literal(true) }).strict(), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => authority().applyImport(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), req.body.preview_token, req.body.operation_id));
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/{id}/provenance', params: entryParams, querystring: scopeQuery, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => authority().provenance(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), req.params.id));
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/{id}/revisions/{revision}', params: entryParams.extend({ revision: z.string().min(1).max(300) }), querystring: scopeQuery, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      const scope = await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id);
      const entry = await authority().getRevision(scope, req.params.id, req.params.revision);
      if (entry === undefined) throw new Error('Memory revision not found');
      return { ...entry, scope, historical: true, complete: true };
    });
  }));
  const settingsResponse = async (workspaceId?: string) => {
    const value = settings();
    let status = value.advisor === undefined || (value.advisor.source === undefined && value.advisor.selector === undefined)
      ? advisorStatus(value.advisor?.mode === 'off' ? 'off' : 'unconfigured', { reason: value.advisor?.mode === 'off' ? undefined : 'unconfigured' })
      : core.accessor.get(IMemorySelector).describe(value.advisor, workspaceId);
    if (memoryEnabled(value, workspaceId) && value.advisor !== undefined && (value.advisor.source !== undefined || value.advisor.selector !== undefined) && value.advisor.mode !== 'off') {
      const memory = store();
      await memory.prepare?.();
      if (memory.snapshot === undefined) status = { ...status, state: 'unsupported_store', reason: 'unsupported_store' };
    }
    if (!memoryEnabled(value, workspaceId)) status = { ...status, state: 'disabled' };
    return { ...value, effective_enabled: memoryEnabled(value, workspaceId), advisor_status: status };
  };
  const settingsQuery = z.object({ workspace_id: z.string().optional() });
  add('get', defineRoute({ method: 'GET', path: '/memory/settings', querystring: settingsQuery, success: { data: memorySettingsResponseSchema }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => settingsResponse(req.query.workspace_id));
  }));
  add('patch', defineRoute({ method: 'PATCH', path: '/memory/settings', querystring: settingsQuery, body: memorySettingsPatchSchema, success: { data: memorySettingsResponseSchema }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      const patch = req.body;
      const current = settings();
      const advisor = patch.advisor === null ? undefined : patch.advisor === undefined ? current.advisor : { ...current.advisor, ...patch.advisor,
        source: patch.advisor.source === null ? undefined : patch.advisor.source ?? current.advisor?.source,
        selector: patch.advisor.source === null || patch.advisor.selector === null ? undefined : patch.advisor.selector ?? current.advisor?.selector,
        first_step_wait_ms: patch.advisor.first_step_wait_ms === null ? undefined : patch.advisor.first_step_wait_ms ?? current.advisor?.first_step_wait_ms };
      const next = MemoryConfigSchema.parse({ ...current, ...patch, advisor });
      await config.replace(MEMORY_SECTION, next);
      return settingsResponse(req.query.workspace_id);
    });
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/advisor/probe', body: memoryAdvisorProbeInputSchema, success: { data: memoryAdvisorProbeResultSchema }, errors, tags: ['memory'] }, async (req, reply) => {
    const controller = new AbortController();
    const raw = (reply as unknown as { raw?: import('node:http').ServerResponse }).raw;
    const abort = () => controller.abort();
    const onClose = () => { if (raw?.writableFinished !== true) abort(); };
    raw?.once('close', onClose);
    const subscription = config.onDidChangeConfiguration((event) => { if ([MEMORY_SECTION, 'models', 'providers'].includes(event.domain)) abort(); });
    try { await handle(req.id, reply, async () => core.accessor.get(IMemorySelector).probe(settings().advisor, req.body.confirm_destination, controller.signal)); }
    finally { subscription.dispose(); raw?.removeListener('close', onClose); }
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/advisor/status', querystring: z.object({ session_id: z.string(), agent_id: z.string().default('main') }), success: { data: memoryAdvisorStatusSchema.nullable() }, errors, tags: ['memory'] }, (req, reply) => {
    const session = core.accessor.get(ISessionManager).get(req.query.session_id);
    const agent = session?.accessor.get(IAgentLifecycleService).get(req.query.agent_id);
    reply.send(okEnvelope(agent?.accessor.get(IAgentMemoryAdvisor).status() ?? null, req.id));
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/workspaces/{workspace_id}/settings', params: z.object({ workspace_id: z.string() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      await resolve('workspace', req.params.workspace_id);
      const value = settings();
      return { workspace_id: req.params.workspace_id, enabled: value.workspaces[req.params.workspace_id] ?? null, effective_enabled: memoryEnabled(value, req.params.workspace_id) };
    });
  }));
  add('patch', defineRoute({ method: 'PATCH', path: '/memory/workspaces/{workspace_id}/settings', params: z.object({ workspace_id: z.string() }), body: z.object({ enabled: z.boolean().nullable() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      await resolve('workspace', req.params.workspace_id);
      const workspaces = { ...settings().workspaces };
      if (req.body.enabled === null) delete workspaces[req.params.workspace_id];
      else workspaces[req.params.workspace_id] = req.body.enabled;
      await config.replace(MEMORY_SECTION, { ...settings(), workspaces });
      return { workspace_id: req.params.workspace_id, enabled: req.body.enabled, effective_enabled: memoryEnabled(settings(), req.params.workspace_id) };
    });
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/inbox', params: scopeParams, querystring: scopeQuery.extend({ cursor: z.string().optional(), page_size: z.coerce.number().int().min(1).max(20).optional() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      const target = await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id);
      if (req.query.cursor !== undefined && req.query.page_size !== undefined) throw new MemoryDomainError('cursor_invalidated', 'Continue with cursor alone', 'Restart Inbox to change its page size.');
      const page = await store().query([target], req.query.cursor === undefined ? { mode: 'list', statuses: ['pending'], page_size: req.query.page_size } : { cursor: req.query.cursor });
      if (page.mode !== 'list' || page.coverage.statuses.length !== 1 || page.coverage.statuses[0] !== 'pending') throw new MemoryDomainError('cursor_invalidated', 'Cursor does not belong to Inbox', 'Restart Inbox with its own cursor.');
      return page;
    });
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/journal', params: scopeParams, querystring: scopeQuery.extend({ id: z.string().optional() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => store().journal(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), req.query.id));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/{scope}/undo', params: scopeParams, querystring: scopeQuery, body: z.object({ operation_id: z.string().uuid() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => ({ entry: await store().undo(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), req.body.operation_id) ?? null }));
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}', params: scopeParams, querystring: scopeQuery.extend({
    query: z.string().optional(), type: z.enum(['user', 'feedback', 'project', 'reference']).optional(), include_inactive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    mode: z.enum(['search', 'list']).optional(), page_size: z.coerce.number().int().min(1).max(20).optional(), cursor: z.string().optional(),
    statuses: z.string().transform((value) => value.split(',')).pipe(z.array(z.enum(['active', 'pending', 'superseded', 'archived'])).min(1).max(4)).optional(),
  }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      const target = await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id);
      if (req.query.cursor !== undefined && (['mode', 'query', 'type', 'page_size', 'statuses', 'include_inactive'] as const).some((key) => req.query[key] !== undefined)) throw new MemoryDomainError('cursor_invalidated', 'Continue with cursor alone', 'Restart the original query if its filters need changing.');
      const mode = req.query.mode ?? (req.query.query === undefined ? 'list' : 'search');
      return store().query([target], req.query.cursor !== undefined ? { cursor: req.query.cursor } : {
        mode, query: req.query.query, type: req.query.type, page_size: req.query.page_size,
        statuses: req.query.statuses ?? (req.query.include_inactive ? ['active', 'pending', 'superseded', 'archived'] : mode === 'list' ? ['active', 'pending'] : ['active']),
      });
    });
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/{id}', params: entryParams, querystring: scopeQuery, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      const scope = await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id);
      const entry = await store().get(scope, req.params.id);
      if (entry === undefined) throw new Error('Memory not found');
      return { ...entry, scope, target: { scope: scope.kind, id: entry.id, expected_revision: entry.revision }, applicability: memoryApplicability(entry), complete: true };
    });
  }));
  add('put', defineRoute({ method: 'PUT', path: '/memory/{scope}/{id}', params: z.object({ scope: scopeParams.shape.scope, id: z.union([z.literal('new'), entryParams.shape.id]) }), querystring: scopeQuery, body, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => store().put({
      scope: await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id),
      action: req.params.id === 'new' ? 'create' : req.body.action, id: req.params.id === 'new' ? undefined : req.params.id,
      type: req.body.type, title: req.body.title, body: req.body.body, reason: req.body.reason,
      expectedRevision: req.body.expected_revision, pinned: req.body.pinned, basis: req.body.basis, validity: req.body.validity, covered_by: req.body.covered_by, source: { writer: 'user' },
    }));
  }));
  add('delete', defineRoute({ method: 'DELETE', path: '/memory/{scope}/{id}', params: entryParams, querystring: entryQuery, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => ({ operation_id: await store().delete(await resolve(req.params.scope, req.query.workspace_id, req.query.persona_id), req.params.id, req.query.expected_revision ?? '') }));
  }));
}
