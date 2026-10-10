import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IBootstrapService, IConfigRegistry, IConfigService, ILogService, ISshHostService, IWorkspaceService, type Scope } from '@kiki/agent-core-v2';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerHomesRoutes } from '../src/routes/homes';

type Route = (req: { id: string; params: { id: string }; body: unknown }, reply: { send(value: unknown): void }) => Promise<void>;
type Result = { code: number; data: Record<string, unknown>; msg: string };

const account = (workspaceId: string | undefined, hostId: string) => JSON.stringify([workspaceId ?? '', hostId]);

describe('main-space SSH credential copying', () => {
  let root: string | undefined;
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0)) await close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    root = undefined;
  });

  async function fixture() {
    root = await mkdtemp(join(tmpdir(), 'kiki-homes-ssh-'));
    const main = root;
    const child = join(root, 'cold-space');
    const routes = new Map<string, Route>();
    const app = {
      ...Object.fromEntries(['get', 'post', 'patch', 'delete'].map((method) => [method,
        (path: string, _options: unknown, handler: Route) => { routes.set(`${method.toUpperCase()} ${path.replaceAll('::', ':')}`, handler); },
      ])),
      addHook: (_name: 'onClose', handler: () => Promise<void>) => { cleanups.push(handler); },
    };
    const saved = new Map<string, string>();
    const writes: Array<{ home: string; id?: string; key: string; kind: string; value: string }> = [];
    let failAfter = Infinity;
    const hosts = [
      { id: 'global', name: 'Global', source: 'kiki' as const },
      { id: 'dev', name: 'Dev', source: 'kiki' as const },
    ];
    const scope = { accessor: { get: (token: unknown) => {
      if (token === IBootstrapService) return { homeDir: main, spaceId: undefined };
      if (token === IConfigService) return { ready: Promise.resolve(), getAll: () => ({}), origins: () => ({}), onDidChangeConfiguration: () => ({ dispose: () => undefined }) };
      if (token === IConfigRegistry) return { listSections: () => [] };
      if (token === ILogService) return { error: () => undefined };
      if (token === IWorkspaceService) return { list: async () => [{ id: 'workspace-1' }] };
      if (token === ISshHostService) return { list: async (workspaceId?: string) => workspaceId === undefined ? hosts.slice(0, 1) : hosts };
      throw new Error('Unexpected service');
    } } } as unknown as Scope;
    const factory = (home: string, id?: string) => ({
      read: async (key: string, kind: 'password' | 'passphrase' | 'identityFile') =>
        home === main ? saved.get(`${key}:${kind}`) : undefined,
      save: async (key: string, kind: 'password' | 'passphrase' | 'identityFile', value: string) => {
        if (writes.length >= failAfter) throw new Error('simulated credential write failure');
        writes.push({ home, id, key, kind, value });
        return 'memory' as const;
      },
    });
    registerHomesRoutes(app as unknown as Parameters<typeof registerHomesRoutes>[0], scope, factory);
    async function request(method: string, path: string, body?: object, id = ''): Promise<Result> {
      const handler = routes.get(`${method} ${path}`);
      if (!handler) throw new Error(`Missing ${method} ${path}`);
      let result: Result | undefined;
      await handler({ id: 'req', params: { id }, body }, { send: (payload) => { result = payload as Result; } });
      return result!;
    }
    const created = await request('POST', '/homes', { name: 'Cold', path: child });
    expect(created.code).toBe(0);
    const id = created.data['id'] as string;
    const update = (copy_ssh_credentials: true | { hosts: { hostId: string; workspaceId?: string }[] }) =>
      request('PATCH', '/homes/:id', { inherit: { credentials: 'isolated' }, copy_ssh_credentials }, id);
    const candidates = () => request('GET', '/homes/:id/ssh-copy-candidates', undefined, id);
    return { main, child, id, scope, request, saved, writes, update, candidates, fail: (after: number) => { failAfter = after; } };
  }

  it('registers inspection alongside attachment and creation on the real HTTP router', async () => {
    const { main, child, scope } = await fixture();
    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    try {
      registerHomesRoutes(app as unknown as Parameters<typeof registerHomesRoutes>[0], scope);
      const path = join(main, 'http-folder');
      await mkdir(path);
      await writeFile(join(path, 'notes.txt'), 'Keep HTTP content');
      const inspected = await app.inject({ method: 'POST', url: '/homes:inspect', payload: { path } });
      expect(inspected.json()).toMatchObject({ code: 0, data: { state: 'nonempty' } });
      const created = await app.inject({ method: 'POST', url: '/homes', payload: { path, name: 'HTTP space' } });
      expect(created.json()).toMatchObject({ code: 0, data: { name: 'HTTP space', path } });
      expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('Keep HTTP content');
      const attached = await app.inject({ method: 'POST', url: '/homes:attach', payload: { path: child } });
      expect(attached.json()).toMatchObject({ msg: expect.stringContaining('already registered') });
    } finally {
      await app.close();
    }
  });

  it.each([false, true])('creates in an existing directory, preserving its contents (nonempty=%s)', async (nonempty) => {
    const { main, request } = await fixture();
    const path = join(main, nonempty ? 'with-content' : 'empty');
    await mkdir(path);
    if (nonempty) {
      await writeFile(join(path, 'notes.txt'), 'Keep these notes');
      await mkdir(join(path, 'assets'));
      await writeFile(join(path, 'assets', 'example.txt'), 'Keep nested content');
    }
    expect(await request('POST', '/homes:inspect', { path })).toMatchObject({ code: 0, data: { state: nonempty ? 'nonempty' : 'empty' } });
    expect(await request('POST', '/homes', { path, name: 'Project', inherit: { credentials: 'isolated' } }))
      .toMatchObject({ code: 0, data: { name: 'Project', path } });
    expect(await readFile(join(path, 'home.toml'), 'utf8')).toContain('credentials = "isolated"');
    if (nonempty) {
      expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('Keep these notes');
      expect(await readFile(join(path, 'assets', 'example.txt'), 'utf8')).toBe('Keep nested content');
    }
  });

  it('creates a missing nested location after a read-only inspection', async () => {
    const { main, request } = await fixture();
    const path = join(main, 'parent', 'new-space');
    expect(await request('POST', '/homes:inspect', { path })).toMatchObject({ code: 0, data: { state: 'missing' } });
    expect(await readdir(main)).not.toContain('parent');
    expect(await request('POST', '/homes', { path, name: 'Nested' })).toMatchObject({ code: 0, data: { name: 'Nested' } });
  });

  it('reuses an existing space identity and settings after removal, and does not duplicate its registration', async () => {
    const { main, child, id, request } = await fixture();
    const original = await readFile(join(child, 'home.toml'), 'utf8');
    await writeFile(join(child, 'notes.txt'), 'User content');
    expect(await request('POST', '/homes:inspect', { path: child })).toMatchObject({ code: 0, data: { state: 'space' } });
    expect((await request('DELETE', '/homes/:id', undefined, id)).code).toBe(0);
    for (let i = 0; i < 2; i++) {
      expect(await request('POST', '/homes', { path: child, name: 'Ignored name', inherit: { credentials: 'isolated' } }))
        .toMatchObject({ code: 0, data: { id, name: 'Cold', path: child } });
    }
    expect(await readFile(join(child, 'home.toml'), 'utf8')).toBe(original);
    expect(await readFile(join(child, 'notes.txt'), 'utf8')).toBe('User content');
    expect(JSON.parse(await readFile(join(main, 'homes.json'), 'utf8'))).toHaveLength(1);
  });

  it('does not overwrite a file or invalid space metadata', async () => {
    const { main, request } = await fixture();
    const file = join(main, 'not-a-folder');
    await writeFile(file, 'Preserve file');
    expect((await request('POST', '/homes', { path: file, name: 'File' })).code).not.toBe(0);
    expect(await readFile(file, 'utf8')).toBe('Preserve file');
    const path = join(main, 'invalid-space');
    await mkdir(path);
    await writeFile(join(path, 'home.toml'), 'Unrelated content');
    expect((await request('POST', '/homes', { path, name: 'Invalid' })).code).not.toBe(0);
    expect(await readFile(join(path, 'home.toml'), 'utf8')).toBe('Unrelated content');
  });

  it('does not reparent a space belonging to another main home', async () => {
    const { main, child, request } = await fixture();
    const other = join(main, 'other-main');
    await mkdir(other);
    const file = join(child, 'home.toml');
    const original = (await readFile(file, 'utf8')).replace(`base = ${JSON.stringify(main)}`, `base = ${JSON.stringify(other)}`);
    await writeFile(file, original);
    expect((await request('POST', '/homes', { path: child, name: 'Other' })).code).not.toBe(0);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('copies every saved password and passphrase from the main space into a cold child before switching mode', async () => {
    const { child, id, saved, writes, update, candidates } = await fixture();
    saved.set(`${account(undefined, 'global')}:password`, 'global-secret');
    saved.set(`${account('workspace-1', 'dev')}:password`, 'workspace-secret');
    saved.set(`${account('workspace-1', 'dev')}:passphrase`, 'key-secret');
    expect((await candidates()).data).toEqual({ hosts: [
      { hostId: 'global', name: 'Global', credential_kinds: ['password'] },
      { hostId: 'dev', workspaceId: 'workspace-1', name: 'Dev', credential_kinds: ['password', 'passphrase'] },
    ] });
    const response = await update(true);
    expect(response).toMatchObject({ code: 0, data: { copied_ssh_entries: 3, restart_required: false, space: { credentials_shared: false } } });
    expect(writes).toEqual([
      { home: child, id, key: account(undefined, 'global'), kind: 'password', value: 'global-secret' },
      { home: child, id, key: account('workspace-1', 'dev'), kind: 'password', value: 'workspace-secret' },
      { home: child, id, key: account('workspace-1', 'dev'), kind: 'passphrase', value: 'key-secret' },
    ]);
    expect(await readFile(join(child, 'home.toml'), 'utf8')).toContain('credentials = "isolated"');
  });

  it('copies only selected hosts and keeps the workspace identifier in the credential account', async () => {
    const { child, saved, writes, update } = await fixture();
    saved.set(`${account(undefined, 'global')}:password`, 'global-secret');
    saved.set(`${account('workspace-1', 'dev')}:password`, 'dev-secret');
    expect(await update({ hosts: [{ hostId: 'dev', workspaceId: 'workspace-1' }, { hostId: 'dev', workspaceId: 'workspace-1' }] }))
      .toMatchObject({ code: 0, data: { copied_ssh_entries: 1 } });
    expect(writes).toMatchObject([{ home: child, key: account('workspace-1', 'dev'), kind: 'password', value: 'dev-secret' }]);
    expect(writes).toHaveLength(1);
  });

  it('leaves home.toml unchanged when a credential write fails, including after a partial copy', async () => {
    const { child, saved, update, fail, writes } = await fixture();
    saved.set(`${account(undefined, 'global')}:password`, 'global-secret');
    saved.set(`${account('workspace-1', 'dev')}:password`, 'dev-secret');
    const before = await readFile(join(child, 'home.toml'), 'utf8');
    fail(1);
    const result = await update(true);
    expect(result).toMatchObject({ code: expect.any(Number), msg: expect.stringContaining('simulated credential write failure') });
    expect(result.code).not.toBe(0);
    expect(writes).toHaveLength(1);
    expect(await readFile(join(child, 'home.toml'), 'utf8')).toBe(before);
  });
});
