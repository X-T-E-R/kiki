import { IConfigService, IMemoryStore, IWorkspaceService, MEMORY_SECTION, memoryEnabled, type MemoryConfig, type MemoryScope, type MemoryType, type Scope } from '@kiki/agent-core-v2';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface MemoryRouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown }) => unknown): unknown;
  put(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown }) => unknown): unknown;
  patch(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown }) => unknown): unknown;
  post(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown }) => unknown): unknown;
  delete(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: any, reply: { send(payload: unknown): unknown }) => unknown): unknown;
}
const scopeParams = z.object({ scope: z.enum(['global', 'workspace']) });
const entryParams = scopeParams.extend({ id: z.string().regex(/^m_[a-zA-Z0-9_]+$/) });
const scopeQuery = z.object({ workspace_id: z.string().optional() });
const entryQuery = scopeQuery.extend({ expected_revision: z.string().optional() });
const body = z.object({ action: z.enum(['create', 'update', 'supersede', 'archive']).default('create'), type: z.enum(['user', 'feedback', 'project', 'reference']), title: z.string().min(1).max(200), body: z.string().min(1).max(1_500), reason: z.string().min(1), expected_revision: z.string().optional(), pinned: z.boolean().optional() });
const generic = z.any();
const errors = { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.MEMORY_NOT_FOUND]: {}, [ErrorCode.WORKSPACE_NOT_FOUND]: {}, [ErrorCode.MEMORY_REVISION_CONFLICT]: {} };

export function registerMemoryRoutes(app: MemoryRouteHost, core: Scope): void {
  const config = core.accessor.get(IConfigService);
  const store = () => core.accessor.get(IMemoryStore);
  const add = (method: keyof MemoryRouteHost, route: ReturnType<typeof defineRoute>): void => {
    app[method](route.path, route.options, route.handler);
  };
  const settings = () => config.get<MemoryConfig>(MEMORY_SECTION);
  const resolve = async (kind: 'global' | 'workspace', workspaceId?: string): Promise<MemoryScope> => {
    if (kind === 'global') return { kind: 'global' };
    if (workspaceId === undefined || await core.accessor.get(IWorkspaceService).get(workspaceId) === undefined) throw new Error('Workspace not found');
    return { kind: 'workspace', workspaceId };
  };
  const handle = async (requestId: string, reply: { send(payload: unknown): unknown }, operation: () => Promise<unknown>): Promise<void> => {
    try { reply.send(okEnvelope(await operation(), requestId)); }
    catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const code = msg.includes('revision conflict') ? ErrorCode.MEMORY_REVISION_CONFLICT : msg === 'Workspace not found' ? ErrorCode.WORKSPACE_NOT_FOUND : msg.includes('not found') ? ErrorCode.MEMORY_NOT_FOUND : ErrorCode.VALIDATION_FAILED;
      reply.send(errEnvelope(code, msg, requestId));
    }
  };

  add('get', defineRoute({ method: 'GET', path: '/memory/settings', success: { data: generic }, tags: ['memory'] }, (req, reply) => {
    const value = settings();
    reply.send(okEnvelope({ ...value, effective_enabled: value.enabled }, req.id));
  }));
  add('patch', defineRoute({ method: 'PATCH', path: '/memory/settings', body: z.object({ enabled: z.boolean().optional(), approval: z.enum(['auto', 'review', 'off']).optional(), budget: z.number().int().min(0).max(4_000).optional() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => { await config.set(MEMORY_SECTION, req.body); return settings(); });
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
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/inbox', params: scopeParams, querystring: scopeQuery, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => (await store().list(await resolve(req.params.scope, req.query.workspace_id), true)).filter((entry) => entry.status === 'pending'));
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/journal', params: scopeParams, querystring: scopeQuery.extend({ id: z.string().optional() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => store().journal(await resolve(req.params.scope, req.query.workspace_id), req.query.id));
  }));
  add('post', defineRoute({ method: 'POST', path: '/memory/{scope}/undo', params: scopeParams, querystring: scopeQuery, body: z.object({ operation_id: z.string().uuid() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => ({ entry: await store().undo(await resolve(req.params.scope, req.query.workspace_id), req.body.operation_id) ?? null }));
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}', params: scopeParams, querystring: scopeQuery.extend({ query: z.string().optional(), type: z.enum(['user', 'feedback', 'project', 'reference']).optional(), include_inactive: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }), success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      const target = await resolve(req.params.scope, req.query.workspace_id);
      return { items: req.query.query ? await store().search([target], req.query.query, req.query.type as MemoryType | undefined, req.query.include_inactive) : await store().list(target, req.query.include_inactive) };
    });
  }));
  add('get', defineRoute({ method: 'GET', path: '/memory/{scope}/{id}', params: entryParams, querystring: scopeQuery, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => {
      const entry = await store().get(await resolve(req.params.scope, req.query.workspace_id), req.params.id);
      if (entry === undefined) throw new Error('Memory not found');
      return entry;
    });
  }));
  add('put', defineRoute({ method: 'PUT', path: '/memory/{scope}/{id}', params: z.object({ scope: scopeParams.shape.scope, id: z.union([z.literal('new'), entryParams.shape.id]) }), querystring: scopeQuery, body, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => store().put({
      scope: await resolve(req.params.scope, req.query.workspace_id),
      action: req.params.id === 'new' ? 'create' : req.body.action, id: req.params.id === 'new' ? undefined : req.params.id,
      type: req.body.type, title: req.body.title, body: req.body.body, reason: req.body.reason,
      expectedRevision: req.body.expected_revision, pinned: req.body.pinned, source: { writer: 'user' },
    }));
  }));
  add('delete', defineRoute({ method: 'DELETE', path: '/memory/{scope}/{id}', params: entryParams, querystring: entryQuery, success: { data: generic }, errors, tags: ['memory'] }, async (req, reply) => {
    await handle(req.id, reply, async () => ({ operation_id: await store().delete(await resolve(req.params.scope, req.query.workspace_id), req.params.id, req.query.expected_revision ?? '') }));
  }));
}
