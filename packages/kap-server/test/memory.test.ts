import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryConfigSchema, IConfigService, IMemoryStore, IWorkspaceService, type MemoryConfig, type Scope } from '@kiki/agent-core-v2';
import { registerMemoryRoutes } from '../src/routes/memory';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface CapturedRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: (req: any, reply: { send(payload: unknown): unknown }) => Promise<void> | void;
}

function setup() {
  const routes: CapturedRoute[] = [];
  let settings: MemoryConfig = MemoryConfigSchema.parse({ enabled: false });
  const store = {
    list: async () => [], get: async () => undefined, journal: async () => [], undo: async () => undefined,
    put: async (input: Record<string, unknown>) => ({ entry: input, operationId: 'receipt-id' }),
    delete: async () => 'receipt-id', search: async () => [],
  };
  const config = {
    get: () => settings,
    set: async (_section: string, patch: Partial<MemoryConfig>) => { settings = MemoryConfigSchema.parse({ ...settings, ...patch }); },
    replace: async (_section: string, value: MemoryConfig) => { settings = MemoryConfigSchema.parse(value); },
  };
  const workspaces = { get: async (id: string) => id === 'wd_example_0123456789ab' ? { id } : undefined };
  const services = new Map<unknown, unknown>([[IMemoryStore, store], [IConfigService, config], [IWorkspaceService, workspaces]]);
  const getService = vi.fn((key: unknown) => services.get(key));
  const core = { accessor: { get: getService } } as unknown as Scope;
  const host = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path: string, _options: unknown, handler: CapturedRoute['handler']) => routes.push({ method, path, handler })]));
  registerMemoryRoutes(host as never, core);
  async function request(method: string, path: string, extras: { params?: object; body?: object; query?: object } = {}) {
    const route = routes.find((entry) => entry.method === method && entry.path === path);
    expect(route).toBeDefined();
    let response: unknown;
    await route!.handler({ id: 'request-memory', params: extras.params ?? {}, body: extras.body ?? {}, query: extras.query ?? {} }, { send: (payload) => { response = payload; } });
    return response as { code: number; data: any };
  }
  return { request, getSettings: () => settings, getService };
}

describe('memory REST', () => {
  it('reads and writes global and workspace switches without enabling workspace memory when global is off', async () => {
    const api = setup();
    const id = 'wd_example_0123456789ab';
    expect(api.getService).not.toHaveBeenCalledWith(IMemoryStore);
    expect((await api.request('get', '/memory/settings')).data.enabled).toBe(false);
    expect((await api.request('patch', '/memory/workspaces/:workspace_id/settings', { params: { workspace_id: id }, body: { enabled: true } })).data.effective_enabled).toBe(false);
    expect((await api.request('patch', '/memory/settings', { body: { enabled: true } })).data.enabled).toBe(true);
    expect((await api.request('get', '/memory/workspaces/:workspace_id/settings', { params: { workspace_id: id } })).data.effective_enabled).toBe(true);
    expect(api.getSettings().workspaces[id]).toBe(true);
    expect((await api.request('patch', '/memory/workspaces/:workspace_id/settings', { params: { workspace_id: id }, body: { enabled: null } })).data.enabled).toBe(null);
    expect(api.getSettings().workspaces[id]).toBeUndefined();
    expect((await api.request('patch', '/memory/workspaces/:workspace_id/settings', { params: { workspace_id: 'missing' }, body: { enabled: true } })).code).toBe(40410);
    expect(api.getService).not.toHaveBeenCalledWith(IMemoryStore);
  });

  it('exposes list/get/put/delete/journal/undo/inbox and passes user-sourced writes', async () => {
    const api = setup();
    expect(api.getService).not.toHaveBeenCalledWith(IMemoryStore);
    const scope = { scope: 'global' };
    const write = await api.request('put', '/memory/:scope/:id', { params: { ...scope, id: 'new' }, body: { action: 'create', type: 'user', title: 'Style', body: 'Reply in Chinese', reason: 'User preference' } });
    expect(write.code).toBe(0);
    expect(api.getService).toHaveBeenCalledWith(IMemoryStore);
    expect(write.data.entry.source.writer).toBe('user');
    expect(write.data.operationId).toBe('receipt-id');
    for (const path of ['/memory/:scope', '/memory/:scope/:id', '/memory/:scope/journal', '/memory/:scope/inbox']) {
      const result = await api.request('get', path, { params: { ...scope, id: 'm_test' } });
      expect([0, 40423]).toContain(result.code);
    }
    expect((await api.request('post', '/memory/:scope/undo', { params: scope, body: { operation_id: '0eb0e68b-5268-4412-98ac-ad585e4499c4' } })).code).toBe(0);
    expect((await api.request('delete', '/memory/:scope/:id', { params: { ...scope, id: 'm_test' }, query: { expected_revision: 'rev' } })).data.operation_id).toBe('receipt-id');
  });

  it('serves an authenticated write/read/undo round trip through Fastify', async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    const home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-rest-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const base = `http://127.0.0.1:${server.port}/api/memory`;
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
      return { http: response.status, envelope: await response.json() as { code: number; data: any; msg: string } };
    };
    try {
      expect((await request('GET', '/settings')).envelope.data.enabled).toBe(true);
      expect((await request('PATCH', '/settings', { enabled: true })).envelope.code).toBe(0);
      const write = await request('PUT', '/global/new', { type: 'user', title: 'Language', body: 'Reply in Chinese.', reason: 'User preference' });
      expect(write.http).toBe(200);
      expect(write.envelope.code).toBe(0);
      const { id } = write.envelope.data.entry as { id: string };
      const read = await request('GET', `/global/${id}`);
      expect(read.envelope.data.body).toBe('Reply in Chinese.');
      const undo = await request('POST', '/global/undo', { operation_id: write.envelope.data.operationId });
      expect(undo.envelope.code).toBe(0);
      expect((await request('GET', `/global/${id}`)).envelope.code).toBe(40423);
      const workspace = await server.core.accessor.get(IWorkspaceService).createOrTouch(process.cwd());
      for (const scope of ['persona', 'persona_workspace']) {
        const query = `persona_id=example-role${scope === 'persona_workspace' ? `&workspace_id=${workspace.id}` : ''}`;
        const saved = await request('PUT', `/${scope}/new?${query}`, { type: 'user', title: 'Private', body: 'Role-owned memory.', reason: 'Explicit user choice' });
        expect(saved.envelope.code).toBe(0);
        expect((await request('GET', `/${scope}/${saved.envelope.data.entry.id}?${query}`)).envelope.data.body).toBe('Role-owned memory.');
        expect((await request('GET', `/${scope}?${query}`)).envelope.data.items).toHaveLength(1);
        expect((await request('GET', `/${scope}?${query.replace('example-role', 'other-role')}`)).envelope.data.items).toEqual([]);
        expect((await request('GET', `/${scope}?workspace_id=${workspace.id}`)).envelope.code).toBe(40001);
      }
      expect((await request('GET', '/global')).envelope.data.items).toEqual([]);
    } finally {
      await server.close();
      await rm(home, { force: true, recursive: true });
    }
  });
});
