import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryConfigSchema, IConfigService, IMemoryStore, IMemorySelector, ISessionManager, advisorStatus, ISessionIndex, IWorkspaceService, decodeMemoryEntry, type MemoryConfig, type Scope } from '@kiki/agent-core-v2';
import { registerMemoryRoutes } from '../src/routes/memory';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface CapturedRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: (req: any, reply: { send(payload: unknown): unknown }) => Promise<void> | void;
}

function setup(lazy = false) {
  const routes: CapturedRoute[] = [];
  let settings: MemoryConfig = MemoryConfigSchema.parse({ enabled: false });
  let prepared = false;
  const prepare = vi.fn(async () => { prepared = true; });
  const store = {
    prepare,
    get snapshot() { return lazy && prepared ? async () => ({ generation: 'g1', entries: [] }) : undefined; },
    list: async () => [], inventory: async () => ({ entries: [], complete: true, warnings: [], fingerprint: 'empty' }), get: async () => undefined, journal: async () => [], undo: async () => undefined,
    put: async (input: Record<string, unknown>) => ({ entry: input, operationId: 'receipt-id' }),
    delete: async () => 'receipt-id', search: async () => [],
    query: async (_scopes: unknown, input: { statuses?: string[] }) => ({ items: [], mode: 'list', next_cursor: null, coverage: { scopes: [{ kind: 'global' }], statuses: input.statuses ?? ['active'], complete: true, exhausted: true, warnings: [] } }),
  };
  const config = {
    onDidChangeConfiguration: () => ({ dispose() {} }),
    get: () => settings,
    set: async (_section: string, patch: Partial<MemoryConfig>) => { settings = MemoryConfigSchema.parse({ ...settings, ...patch }); },
    replace: async (_section: string, value: MemoryConfig) => { settings = MemoryConfigSchema.parse(value); },
  };
  const workspaces = { get: async (id: string) => id === 'wd_example_0123456789ab' ? { id } : undefined };
  const selector = { describe: (advisor: MemoryConfig['advisor']) => advisorStatus(advisor?.mode === 'off' ? 'off' : 'ready', { destination: 'example@https://example.test', consent_required: false }), probe: vi.fn(async () => ({ ok: false, status: advisorStatus('failed', { reason: 'protocol' }), duration_ms: 0, usage_known: false })) };
  const services = new Map<unknown, unknown>([[IMemoryStore, store], [IConfigService, config], [IWorkspaceService, workspaces], [IMemorySelector, selector], [ISessionManager, { get: () => undefined }]]);
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
  return { request, getSettings: () => settings, getService, prepare };
}

describe('memory REST', () => {
  it('prepares authority before diagnosing a lazy snapshot getter while off and unconfigured reads stay lazy', async () => {
    const api = setup(true);
    await api.request('get', '/memory/settings'); expect(api.prepare).not.toHaveBeenCalled();
    await api.request('patch', '/memory/settings', { body: { enabled: true, advisor: { mode: 'off', selector: { protocol: 'chat_json', model: 'any-user-model' } } } });
    await api.request('get', '/memory/settings'); expect(api.prepare).not.toHaveBeenCalled();
    const enabled = await api.request('patch', '/memory/settings', { body: { advisor: { mode: 'rank' } } });
    expect(api.prepare).toHaveBeenCalledOnce(); expect(enabled.data.advisor_status).toMatchObject({ state: 'ready', consent_required: false });
    expect(enabled.data.advisor.egress_ack).toEqual([]);
    expect((await api.request('get', '/memory/settings')).data.advisor_status.state).toBe('ready');
  });
  it('patches advisor preferences sparsely, preserves the selector when toggled off, and supports explicit removal', async () => {
    const api = setup();
    const oldAck = [{ workspace_id: 'old-workspace', destination: 'old@https://old.test' }];
    await api.request('patch', '/memory/settings', { body: { enabled: true, advisor: { selector: { protocol: 'chat_json', model: 'any-user-model' }, timeout_ms: 2000, egress_ack: oldAck } } });
    const disabled = await api.request('patch', '/memory/settings', { body: { advisor: { mode: 'off' } } });
    expect(disabled.data.advisor).toMatchObject({ mode: 'off', timeout_ms: 2000, selector: { model: 'any-user-model' }, egress_ack: oldAck });
    expect(disabled.data.advisor_status.consent_required).toBe(false);
    expect(disabled.data.advisor_status.state).toBe('off');
    await api.request('patch', '/memory/settings', { body: { advisor: { mode: 'rank', selector: null } } });
    expect(api.getSettings().advisor?.selector).toBeUndefined();
    expect((await api.request('get', '/memory/settings')).data.advisor_status.state).toBe('unconfigured');
    await api.request('patch', '/memory/settings', { body: { advisor: null } });
    expect(api.getSettings().advisor).toBeUndefined();
    expect((await api.request('get', '/memory/advisor/status', { query: { session_id: 'cold', agent_id: 'main' } })).data).toBeNull();
  });
  it('keeps an unset first-step wait unset, saves an explicit one, and clears it with null', async () => {
    const api = setup();
    await api.request('patch', '/memory/settings', { body: { enabled: true, advisor: { source: { kind: 'connection', connection: 'judge' } } } });
    expect(api.getSettings().advisor?.first_step_wait_ms).toBeUndefined();
    await api.request('patch', '/memory/settings', { body: { advisor: { first_step_wait_ms: 1500 } } });
    expect(api.getSettings().advisor?.first_step_wait_ms).toBe(1500);
    await api.request('patch', '/memory/settings', { body: { advisor: { timeout_ms: 2000 } } });
    expect(api.getSettings().advisor?.first_step_wait_ms).toBe(1500);
    await api.request('patch', '/memory/settings', { body: { advisor: { first_step_wait_ms: null } } });
    expect(api.getSettings().advisor?.first_step_wait_ms).toBeUndefined();
    expect(api.getSettings().advisor).toMatchObject({ timeout_ms: 2000, source: { connection: 'judge' } });
  });
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

  it('filters every type with and without search and inactive entries through Fastify', async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    const home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-filters-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const base = `http://127.0.0.1:${server.port}/api/memory/global`;
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as { code: number; data: any };
    };
    const types = ['user', 'feedback', 'project', 'reference'] as const;
    const entries: { id: string; type: string; matches: boolean; inactive: boolean }[] = [];
    try {
      for (const type of types) {
        for (const variant of ['match', 'other', 'archived'] as const) {
          const body = { type, title: `${type} ${variant}`, body: variant === 'other' ? 'Unrelated content.' : 'Needle content.', reason: 'Test memory filters' };
          const saved = await request('PUT', '/new', body);
          expect(saved.code).toBe(0);
          const entry = saved.data.entry as { id: string; revision: string };
          if (variant === 'archived') {
            expect((await request('PUT', `/${entry.id}`, { ...body, action: 'archive', expected_revision: entry.revision })).code).toBe(0);
          }
          entries.push({ id: entry.id, type, matches: variant !== 'other', inactive: variant === 'archived' });
        }
      }
      for (const search of ['', 'needle']) {
        for (const includeInactive of [false, true]) {
          for (const type of [undefined, ...types]) {
            const query = new URLSearchParams({ include_inactive: String(includeInactive) });
            if (search) query.set('query', search);
            if (type !== undefined) query.set('type', type);
            const result = await request('GET', `?${query}`);
            expect(result.code).toBe(0);
            const expected = entries.filter((entry) =>
              (type === undefined || entry.type === type)
              && (includeInactive || !entry.inactive)
              && (search === '' || entry.matches));
            expect(result.data.items.map((entry: { id: string }) => entry.id).sort(), query.toString()).toEqual(expected.map((entry) => entry.id).sort());
          }
        }
      }
      const unfiltered = await request('GET', '');
      expect(unfiltered.data.items.map((entry: { id: string }) => entry.id).sort()).toEqual(entries.filter((entry) => !entry.inactive).map((entry) => entry.id).sort());
      expect((await request('GET', '?type=reference&query=absent&include_inactive=true')).data.items).toEqual([]);
      expect((await request('GET', '?type=invalid')).code).toBe(40001);
    } finally {
      await server.close();
      await rm(home, { force: true, recursive: true });
    }
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
      await server.core.accessor.get(ISessionIndex).prepare();
      const workspace = await server.core.accessor.get(IWorkspaceService).createOrTouch(process.cwd());
      for (const scope of ['persona', 'persona_workspace']) {
        const query = `persona_id=example-role${scope === 'persona_workspace' ? `&workspace_id=${workspace.id}` : ''}`;
        const saved = await request('PUT', `/${scope}/new?${query}`, { type: 'user', title: 'Private', body: 'Role-owned memory.', reason: 'Explicit user choice' });
        expect(saved.envelope.code).toBe(0);
        expect((await request('GET', `/${scope}/${saved.envelope.data.entry.id}?${query}`)).envelope.data.body).toBe('Role-owned memory.');
        expect((await request('GET', `/${scope}?${query}`)).envelope.data.items).toHaveLength(1);
        expect((await request('GET', `/${scope}?${query}&type=user`)).envelope.data.items).toHaveLength(1);
        expect((await request('GET', `/${scope}?${query}&type=reference`)).envelope.data.items).toEqual([]);
        expect((await request('GET', `/${scope}?${query.replace('example-role', 'other-role')}`)).envelope.data.items).toEqual([]);
        expect((await request('GET', `/${scope}?workspace_id=${workspace.id}`)).envelope.code).toBe(40001);
      }
      expect((await request('GET', '/global')).envelope.data.items).toEqual([]);
    } finally {
      await server.close();
      await rm(home, { force: true, recursive: true });
    }
  });

  it('preserves metadata across real HTTP editing, archive, approval and undo while exposing no-op and cursor errors', async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    const home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-metadata-http-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const base = `http://127.0.0.1:${server.port}/api/memory/global`;
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as { code: number; data: any; details?: { code: string; recovery: string } };
    };
    const basis = { kind: 'derived', note: 'The peer proposed the numeric plan; the human supplied the communication constraint.', refs: ['history:example/t2', 'peer:example-plan'] };
    const validity = { check: 'Read the current authority before relying on the resource arrangement.', until: '2099-01-01T00:00:00Z' };
    try {
      const body = { type: 'project', title: 'Mutable arrangement', body: 'Use the current authority; preserve the specialist exception.', reason: 'Useful discovery pointer', basis, validity };
      const saved = await request('PUT', '/new', body);
      expect(saved.code).toBe(0);
      expect(saved.data).toMatchObject({ outcome: 'applied', entry: { basis, validity } });
      const original = saved.data.entry;
      const unchanged = await request('PUT', `/${original.id}`, { ...body, action: 'update', expected_revision: original.revision, reason: 'Repeated confirmation' });
      expect(unchanged.data).toMatchObject({ outcome: 'unchanged', operationId: null, entry: { revision: original.revision, source: original.source, updated: original.updated } });
      expect((await request('GET', `/journal?id=${original.id}`)).data).toHaveLength(1);
      const edited = await request('PUT', `/${original.id}`, { type: body.type, title: body.title, body: 'Read example-authority.md; the authority owns the schedule.', action: 'update', expected_revision: original.revision, reason: 'Retire copied schedule' });
      expect(edited.code).toBe(0);
      expect(edited.data.entry.basis).toEqual({ kind: 'unknown', note: 'content changed without refreshed attribution' });
      expect(edited.data.entry.validity).toEqual(validity);
      const read = await request('GET', `/${original.id}`);
      expect(read.data).toMatchObject({ scope: { kind: 'global' }, target: { scope: 'global', id: original.id, expected_revision: edited.data.entry.revision }, applicability: 'recheck', complete: true });
      const retained = (await request('PUT', '/new', { ...body, title: 'Retained complete rule', body: 'The retained authority owns the schedule; preserve the specialist exception.' })).data.entry;
      const proposal = await server.core.accessor.get(IMemoryStore).put({ action: 'archive', scope: { kind: 'global' }, id: original.id, expectedRevision: edited.data.entry.revision, reason: 'Consolidation review', source: { writer: 'agent' }, pending: true, covered_by: { id: retained.id, expected_revision: retained.revision } });
      const accepted = await request('PUT', `/${proposal.entry.id}`, { action: 'update', type: proposal.entry.type, title: proposal.entry.title, body: proposal.entry.body, expected_revision: proposal.entry.revision, reason: 'Approve consolidation' });
      expect(accepted.code).toBe(0);
      expect(accepted.data.entry).toMatchObject({ id: original.id, status: 'archived', body: edited.data.entry.body, validity, covered_by: { id: retained.id, revision: retained.revision } });
      expect((await request('POST', '/undo', { operation_id: accepted.data.operationId })).data.entry).toMatchObject({ id: original.id, status: 'active', validity });
      expect((await request('GET', `/${proposal.entry.id}`)).data.status).toBe('pending');
      const archived = await request('PUT', `/${retained.id}`, { action: 'archive', expected_revision: retained.revision, reason: 'Explicit revocation' });
      expect(archived.data.entry).toMatchObject({ body: retained.body, basis, validity, status: 'archived' });
      expect((await request('PUT', `/${original.id}`, { action: 'archive', reason: 'Missing CAS' })).details?.code).toBe('missing_revision');
      const list = await request('GET', '?mode=list&page_size=1&statuses=active,pending,archived');
      expect(list.data.coverage).toMatchObject({ complete: true, exhausted: false });
      expect(list.data.next_cursor).toEqual(expect.any(String));
      const added = await request('PUT', '/new', { ...body, title: 'Concurrent addition', body: 'A separately confirmed condition for this pagination change.' });
      const continuation = await request('GET', `?cursor=${encodeURIComponent(list.data.next_cursor)}`);
      expect(continuation.code).toBe(0);
      expect(continuation.data.items.every((entry: { id: string }) => entry.id !== added.data.entry.id)).toBe(true);
      const invalid = await request('GET', '?cursor=invalid');
      expect(invalid.details?.code).toBe('cursor_invalidated');
      expect((await request('GET', '?mode=search&query=!!!')).details?.code).toBe('invalid_query');
      const journal = (await request('GET', '/journal')).data;
      expect(journal.some((record: { before: string | null }) => record.before?.includes('history:example/t2'))).toBe(true);
    } finally {
      await server.close();
      await rm(home, { force: true, recursive: true });
    }
  }, 30_000);
});

describe('Memory authority management over authenticated HTTP', () => {
  const legacyPayload = (id: string) => `---\n${JSON.stringify({ id, type: 'feedback', title: 'Startup deployment rule', status: 'active', pinned: true, created: '2026-01-01', updated: '2026-01-01', source: { writer: 'user' }, reason: 'Owner instruction' })}\n---\nUse 9 workers; retain the 17-unit exception.\n`;
  it('automatically upgrades a disabled legacy home at startup and keeps new writes and readonly state across restarts', async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    const home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-startup-http-'));
    await mkdir(join(home, 'memory/global/entries'), { recursive: true });
    await writeFile(join(home, 'config.toml'), '[memory]\nenabled = false\n');
    const raw = legacyPayload('m_startup_example');
    const sourcePath = join(home, 'memory/global/entries/m_startup_example.md');
    await writeFile(sourcePath, raw);
    const open = () => startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    let server = await open();
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/memory${path}`, { method, headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as { code: number; data: any };
    };
    try {
      await vi.waitFor(async () => { expect((await request('GET', '/authority')).data).toMatchObject({ backend: 'sqlite', mode: 'active' }); }, { timeout: 5000 });
      const state = (await request('GET', '/authority')).data;
      expect((await request('GET', '/settings')).data).toMatchObject({ enabled: false, effective_enabled: false });
      const original = decodeMemoryEntry(raw);
      expect((await request('GET', `/global/${original.id}`)).data).toMatchObject(JSON.parse(JSON.stringify(original)));
      const edit = await request('PUT', `/global/${original.id}`, { action: 'update', type: original.type, title: original.title, expected_revision: original.revision, body: 'Use 5 workers; retain the 17-unit exception.', reason: 'Post-upgrade correction' });
      expect(edit.code).toBe(0);
      expect(await readFile(sourcePath, 'utf8')).toBe(raw);
      const checkpoint = await server.core.accessor.get(IMemoryStore).checkpoint!();
      await server.close(); server = await open();
      await vi.waitFor(async () => { expect((await request('GET', '/authority')).data).toEqual(state); }, { timeout: 5000 });
      expect(await server.core.accessor.get(IMemoryStore).checkpoint!()).toBe(checkpoint);
      expect((await request('GET', `/global/${original.id}`)).data.revision).toBe(edit.data.entry.revision);
      const recovery = await request('POST', '/authority/recover-readonly', { confirm_readonly: true });
      const readonly = (await request('GET', '/authority')).data;
      expect(recovery.code).toBe(0);
      await server.close(); server = await open();
      await vi.waitFor(async () => { expect((await request('GET', '/authority')).data).toEqual(readonly); }, { timeout: 5000 });
      expect((await request('GET', `/global/${original.id}`)).data.body).toBe(edit.data.entry.body);
      expect((await request('PUT', '/global/new', { type: 'feedback', title: 'Blocked startup edit', body: 'Do not resume editing automatically.', reason: 'Fixture' })).code).toBe(40001);
      expect((await request('GET', '/settings')).data.enabled).toBe(false);
    } finally { await server.close(); await rm(home, { force: true, recursive: true }); }
  }, 30_000);

  it('shows startup source failures without fallback and retries a repaired source with the persisted operation id', async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    const home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-startup-failure-'));
    await mkdir(join(home, 'memory/global/entries'), { recursive: true });
    const sourcePath = join(home, 'memory/global/entries/m_startup_repaired.md');
    await writeFile(sourcePath, 'Invalid original Memory payload');
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/memory${path}`, { method, headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as { code: number; data: any };
    };
    try {
      await vi.waitFor(async () => { expect((await request('GET', '/authority')).data.migration?.phase).toBe('failed'); }, { timeout: 5000 });
      const state = (await request('GET', '/authority')).data;
      expect(state).toMatchObject({ backend: 'legacy', mode: 'migrating', migration: { failure: { code: 'memory.source_invalid' }, issues: [{ scope: 'memory/global', key: 'entries/m_startup_repaired.md', issue: 'Invalid memory frontmatter' }] } });
      expect(await readFile(sourcePath, 'utf8')).toBe('Invalid original Memory payload');
      expect((await request('GET', '/global')).code).toBe(40001);
      const raw = legacyPayload('m_startup_repaired');
      await writeFile(sourcePath, raw);
      const retry = await request('POST', '/authority/retry', { operation_id: state.migration.id });
      expect(retry).toMatchObject({ code: 0, data: { backend: 'sqlite', mode: 'active', migrationId: state.migration.id } });
      expect((await request('GET', '/global/m_startup_repaired')).data).toMatchObject(JSON.parse(JSON.stringify(decodeMemoryEntry(raw))));
      expect(await readFile(sourcePath, 'utf8')).toBe(raw);
    } finally { await server.close(); await rm(home, { force: true, recursive: true }); }
  }, 30_000);

  it('starts a new SQLite editor, previews exact irreversible targets and resumes editing from read-only recovery', async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    const home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-authority-http-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const base = `http://127.0.0.1:${server.port}/api/memory`;
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as { code: number; msg: string; data: any };
    };
    try {
      await server.core.accessor.get(IMemoryStore).prepare!();
      const state = (await request('GET', '/authority')).data;
      expect(state).toMatchObject({ backend: 'sqlite', mode: 'active' });
      const input = { type: 'feedback', title: 'Deployment procedure', body: 'Use 9 workers; never upload output.', reason: 'Owner instruction' };
      const saved = (await request('PUT', '/global/new', input)).data.entry;
      expect((await request('POST', '/authority/retry', { operation_id: state.migrationId })).data).toEqual(state);
      const edited = await request('PUT', `/global/${saved.id}`, { ...input, action: 'update', expected_revision: saved.revision, body: 'Use 5 workers; never upload output.' });
      expect(edited.code).toBe(0);
      const current = edited.data.entry;
      const previous = await request('GET', `/global/${saved.id}/revisions/${encodeURIComponent(saved.revision)}`);
      expect(previous.data).toMatchObject({ body: input.body, historical: true });
      const provenance = await request('GET', `/global/${saved.id}/provenance`);
      expect(provenance.data.adjudications).toContainEqual(expect.objectContaining({ kind: 'correction' }));
      const preview = await request('POST', '/global/forget-preview', { ids: [saved.id] });
      expect(preview.data.targets[0]).toMatchObject({ id: current.id, expectedRevision: current.revision });
      const targets = preview.data.targets.map((target: { id: string; expectedRevision: string }) => ({ id: target.id, expected_revision: target.expectedRevision }));
      const forget = { operation_id: 'fcf74ba7-6872-4164-b525-e0b4e6b4eb55', targets };
      expect((await request('POST', '/global/forget', forget)).code).toBe(40001);
      expect((await request('POST', '/global/forget', { ...forget, confirm_irreversible: true })).code).toBe(0);
      expect((await request('GET', `/global/${saved.id}`)).code).toBe(40423);
      expect((await request('GET', `/global/${saved.id}/revisions/${encodeURIComponent(saved.revision)}`)).code).toBe(40423);
      const fresh = (await request('PUT', '/global/new', { ...input, title: 'Keep the new correction', body: 'Use the fresh post-cutover instruction.' })).data.entry;
      expect((await request('POST', '/authority/recover-readonly', {})).code).toBe(40001);
      const recovery = await request('POST', '/authority/recover-readonly', { confirm_readonly: true });
      expect(recovery.code).toBe(0);
      expect(recovery.data).toMatchObject({ mode: 'readonly', resume: 'resumeEditing' });
      const readonly = (await request('GET', '/authority')).data;
      expect(readonly.mode).toBe('readonly');
      expect((await request('GET', `/global/${fresh.id}`)).data.body).toBe(fresh.body);
      expect((await request('PUT', '/global/new', { ...input, title: 'Blocked while readonly' })).code).toBe(40001);
      expect((await request('POST', '/authority/resume-editing', { recovery_id: recovery.data.recoveryId, expected_epoch: readonly.epoch - 1 })).code).toBe(40001);
      expect((await request('POST', '/authority/resume-editing', { recovery_id: recovery.data.recoveryId, expected_epoch: readonly.epoch })).data.mode).toBe('active');
      expect((await request('PUT', '/global/new', { ...input, title: 'Editable again' })).code).toBe(0);
    } finally { await server.close(); await rm(home, { force: true, recursive: true }); }
  }, 30_000);
});

describe('revision-bound Markdown import over authenticated HTTP', () => {
  it('exports and previews complete edits, confirms once and blocks stale or forgotten source replay', async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    const home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-markdown-http-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const base = `http://127.0.0.1:${server.port}/api/memory`;
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as { code: number; data: any; details?: { code: string; recovery: string } };
    };
    try {
      expect((await fetch(`${base}/global/m_example/export`)).status).toBe(401);
      await server.core.accessor.get(ISessionIndex).prepare();
      await server.core.accessor.get(IMemoryStore).prepare!();
      expect((await request('GET', '/authority')).data.backend).toBe('sqlite');
      await request('PATCH', '/settings', { enabled: false });
      const input = { type: 'feedback', title: 'Markdown deployment rule', body: 'Use 9 workers; never upload output; isolated tests remain allowed.', reason: 'Owner instruction' };
      const saved = (await request('PUT', '/global/new', input)).data.entry;
      const exported = (await request('GET', `/global/${saved.id}/export`)).data;
      expect(exported.entry).toMatchObject({ id: saved.id, revision: saved.revision, body: input.body });
      expect(exported.markdown).toContain(saved.revision);
      const source = { markdown: exported.markdown.replace('Use 9 workers', 'Use 5 workers'), source_locator: 'file:///example/memory/rule.md', reason: 'Reviewed Markdown correction' };
      const preview = (await request('POST', '/global/import-preview', source)).data;
      expect(preview).toMatchObject({ canApply: true, action: 'update', current: { body: input.body }, incoming: { body: source.markdown.split('\n---\n')[1].trim() } });
      const confirmation = { preview_token: preview.previewToken, operation_id: '10000000-0000-4000-8000-000000000002' };
      expect((await request('POST', '/global/import', confirmation)).code).toBe(40001);
      expect((await request('GET', `/global/${saved.id}`)).data.body).toBe(input.body);
      const applied = await request('POST', '/global/import', { ...confirmation, confirm_import: true });
      expect(applied.code).toBe(0);
      expect(applied.data.entry.body).toBe('Use 5 workers; never upload output; isolated tests remain allowed.');
      expect((await request('POST', '/global/import-preview', source)).data).toMatchObject({ canApply: false, action: 'retained', current: { id: saved.id, revision: applied.data.entry.revision } });
      const currentFile = (await request('GET', `/global/${saved.id}/export`)).data.markdown;
      const concurrent = (await request('POST', '/global/import-preview', { ...source, markdown: currentFile.replace('Use 5 workers', 'Use 7 workers') })).data;
      const corrected = (await request('PUT', `/global/${saved.id}`, { ...input, action: 'update', expected_revision: applied.data.entry.revision, body: 'Use 3 workers; retain the isolated-test exception.' })).data.entry;
      const stale = await request('POST', '/global/import', { preview_token: concurrent.previewToken, operation_id: '10000000-0000-4000-8000-000000000003', confirm_import: true });
      expect(stale.details?.code).toBe('revision_conflict');
      expect((await request('GET', `/global/${saved.id}`)).data.body).toBe(corrected.body);
      const forget = (await request('POST', '/global/forget-preview', { ids: [saved.id] })).data;
      expect((await request('POST', '/global/forget', { operation_id: '10000000-0000-4000-8000-000000000004', confirm_irreversible: true, targets: forget.targets.map((entry: { id: string; expectedRevision: string }) => ({ id: entry.id, expected_revision: entry.expectedRevision })) })).code).toBe(0);
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(exported.markdown)!;
      const renamed = `---\n${JSON.stringify({ ...JSON.parse(match[1]!), id: 'new', revision: null, title: 'Renamed original extraction' })}\n---\n${match[2]}`;
      const rejected = await request('POST', '/global/import-preview', { ...source, markdown: renamed, source_locator: 'file:///example/renamed.md' });
      expect(rejected.details?.code).toBe('inactive_target');
      expect((await request('GET', '/global')).data.items).toEqual([]);
      const fresh = (await request('PUT', '/global/new', { ...input, title: 'Distinct new owner instruction' })).data.entry;
      expect((await request('POST', '/authority/recover-readonly', { confirm_readonly: true })).code).toBe(0);
      expect((await request('GET', `/global/${fresh.id}/export`)).code).toBe(0);
      expect((await request('POST', '/global/import-preview', source)).code).toBe(40001);
    } finally { await server.close(); await rm(home, { force: true, recursive: true }); }
  }, 30_000);
});
