import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { IBootstrapService } from '@kiki/agent-core-v2';

import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface SpaceRecord { id: string; name: string; path: string; primary?: boolean }
interface Envelope<T> { code: number; data: T }

describe('space registration REST', () => {
  let root: string | undefined;
  const servers: RunningServer[] = [];
  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    root = undefined;
  });
  async function boot(home: string): Promise<RunningServer> {
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    servers.push(server);
    return server;
  }
  async function call(server: RunningServer, path: string, method = 'GET', body?: object): Promise<Envelope<unknown>> {
    const response = await authedFetch(server, `http://127.0.0.1:${server.port}`, path, {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<Envelope<unknown>>;
  }

  it('lists bundled templates and derives display and config values without copying defaults into user files', async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-presets-'));
    const main = await boot(root);
    const catalog = await call(main, '/api/homes/presets');
    expect(catalog).toEqual({ code: 0, msg: 'success', request_id: expect.any(String), data: { items: [
      { id: 'kiki', name: 'Kiki', description: 'A general-purpose space.' },
    ] } });
    const invalidPath = join(root, 'invalid');
    expect((await call(main, '/api/homes', 'POST', { path: invalidPath, preset: 'unknown' })).code).toBe(40427);
    await expect(stat(invalidPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const path = join(root, 'derived');
    expect(await call(main, '/api/homes', 'POST', { path, preset: 'kiki' })).toMatchObject({ code: 0, data: { name: 'Kiki', preset: 'kiki' } });
    const home = await readFile(join(path, 'home.toml'), 'utf8');
    expect(home).toContain('preset = "kiki"');
    expect(home).not.toContain('name =');
    expect(home).not.toContain('color =');
    const child = await boot(path);
    const config = await call(child, '/api/config');
    expect(config, JSON.stringify(config)).toMatchObject({ code: 0, data: {
      space_ui: { defaultSkin: 'paper', landingPage: '/new', plugins: [] },
      origins: { space_ui: { defaultSkin: 'preset' } },
    } });
    expect(await call(child, '/api/config', 'POST', { space_ui: { default_skin: 'linen' } })).toMatchObject({ code: 0, data: { space_ui: { defaultSkin: 'linen' } } });
    expect((await readFile(join(path, 'config.toml'), 'utf8'))).not.toContain('landing_page');
    expect(await call(main, '/api/homes', 'POST', { path: join(root, 'custom'), preset: 'kiki', name: 'My desk', color: '#be185d' })).toMatchObject({ code: 0, data: { name: 'My desk', color: '#be185d', preset: 'kiki' } });
    expect(await call(main, '/api/homes')).toMatchObject({ data: { items: [{ id: 'main' }, { name: 'Kiki', preset: 'kiki' }, { name: 'My desk', preset: 'kiki' }] } });
  });

  it('creates, lists, removes from the launcher, and reattaches a space without deleting its files', async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-homes-'));
    const main = await boot(root);
    const path = join(root, 'space');
    const initial = await call(main, '/api/homes');
    expect(initial).toMatchObject({ code: 0, data: { items: [{ id: 'main', primary: true }] } });
    const created = await call(main, '/api/homes', 'POST', {
      name: 'Secret', color: '#C2410C', path, inherit: { credentials: 'isolated', generic_roots: false },
    });
    expect(created).toMatchObject({ code: 0, data: { id: expect.stringMatching(/^h-/), name: 'Secret', path } });
    const id = (created.data as SpaceRecord).id;
    expect(await readFile(join(path, 'home.toml'), 'utf8')).toContain('credentials = "isolated"');
    expect((await stat(join(root, 'homes.json'))).isFile()).toBe(true);
    const list = await call(main, '/api/homes');
    expect(list).toMatchObject({ code: 0, data: { items: [{ id: 'main' }, { id }] } });
    const removed = await call(main, `/api/homes/${id}`, 'DELETE');
    expect((removed.data as { items: SpaceRecord[] }).items.map((space) => space.id)).toEqual(['main']);
    expect((await stat(join(path, 'home.toml'))).isFile()).toBe(true);
    expect(await call(main, '/api/homes:attach', 'POST', { path })).toMatchObject({ code: 0, data: { id } });
    expect((await call(main, '/api/homes:attach', 'POST', { path })).code).not.toBe(0);
  });

  it('lets a child list spaces but rejects child-origin changes to main homes.json', async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-homes-'));
    const main = await boot(root);
    const path = join(root, 'space');
    const created = await call(main, '/api/homes', 'POST', { name: 'Child', path });
    expect(created.code).toBe(0);
    const child = await boot(path);
    expect((await call(child, '/api/homes')).data).toMatchObject({ items: [{ id: 'main' }, { id: (created.data as SpaceRecord).id }] });
    const before = await readFile(join(root, 'homes.json'), 'utf8');
    expect((await call(child, `/api/homes/${(created.data as SpaceRecord).id}`, 'DELETE')).code).not.toBe(0);
    expect((await call(child, '/api/homes', 'POST', { name: 'Other', path: join(root, 'other') })).code).not.toBe(0);
    expect(await readFile(join(root, 'homes.json'), 'utf8')).toBe(before);
  });

  it('switches credential modes without deleting isolated secrets, and reports live backends needing restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-homes-'));
    const main = await boot(root);
    const path = join(root, 'credentials-space');
    const created = await call(main, '/api/homes', 'POST', { name: 'Credentials', path, inherit: { config: false } });
    const id = (created.data as SpaceRecord).id;
    const child = await boot(path);
    expect(normalize(child.core.accessor.get(IBootstrapService).credentialsHomeDir)).toBe(normalize(root));
    expect(await call(main, `/api/homes/${id}/ssh-copy-candidates`)).toMatchObject({ code: 0, data: { hosts: [] } });
    expect((await call(child, `/api/homes/${id}/ssh-copy-candidates`)).code).not.toBe(0);
    const before = await readFile(join(path, 'home.toml'), 'utf8');
    expect((await call(child, `/api/homes/${id}`, 'PATCH', { inherit: { credentials: 'isolated' } })).code).not.toBe(0);
    expect(await readFile(join(path, 'home.toml'), 'utf8')).toBe(before);
    const isolated = await call(main, `/api/homes/${id}`, 'PATCH', { inherit: { credentials: 'isolated' } });
    expect(isolated).toMatchObject({ code: 0, data: { space: { credentials_shared: false }, restart_required: true } });
    expect((await call(main, '/api/homes')).data).toMatchObject({ items: [{ id: 'main' }, { id, credentials_shared: false }] });
    expect(normalize(child.core.accessor.get(IBootstrapService).credentialsHomeDir)).toBe(normalize(root));
    expect(await readFile(join(path, 'home.toml'), 'utf8')).toContain('config = false');
    await child.close();
    servers.splice(servers.indexOf(child), 1);
    const restarted = await boot(path);
    expect(normalize(restarted.core.accessor.get(IBootstrapService).credentialsHomeDir)).toBe(normalize(path));
    await restarted.close();
    servers.splice(servers.indexOf(restarted), 1);
    await mkdir(join(path, 'credentials', 'ssh'), { recursive: true });
    await writeFile(join(path, 'credentials', 'ssh', 'keyring-accounts.json'), JSON.stringify([`${id}/password-abc`]));
    await writeFile(join(path, 'credentials', 'ssh', 'password-abc.secret'), 'isolated example');
    const shared = await call(main, `/api/homes/${id}`, 'PATCH', { inherit: { credentials: 'shared' } });
    expect(shared).toMatchObject({ code: 0, data: { space: { credentials_shared: true }, restart_required: false, retained_isolated_ssh_entries: 1 } });
    expect(await readFile(join(path, 'credentials', 'ssh', 'password-abc.secret'), 'utf8')).toBe('isolated example');
    const returned = await boot(path);
    expect(normalize(returned.core.accessor.get(IBootstrapService).credentialsHomeDir)).toBe(normalize(root));
  });

  it('requires exact-name confirmation and a stopped backend before permanent deletion', async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-homes-'));
    const main = await boot(root);
    const path = join(root, 'disposable');
    const created = await call(main, '/api/homes', 'POST', { name: 'Disposable', path });
    const id = (created.data as SpaceRecord).id;
    expect(created.code).toBe(0);
    await writeFile(join(path, 'example.txt'), 'owned child data');
    const child = await boot(path);
    expect((await call(main, `/api/homes/${id}:delete`, 'POST', { confirm_name: 'Disposable' })).code).not.toBe(0);
    expect((await stat(join(path, 'example.txt'))).isFile()).toBe(true);
    await child.close();
    servers.splice(servers.indexOf(child), 1);
    expect((await call(main, `/api/homes/${id}:delete`, 'POST', { confirm_name: 'Wrong' })).code).not.toBe(0);
    expect((await stat(join(path, 'example.txt'))).isFile()).toBe(true);
    expect((await call(main, `/api/homes/${id}:delete`, 'POST', { confirm_name: 'Disposable' })).code).toBe(0);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await call(main, '/api/homes')).data).toMatchObject({ items: [{ id: 'main' }] });
  });

  it('refuses creation over an existing directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-homes-'));
    const main = await boot(root);
    const path = join(root, 'existing');
    await mkdir(path);
    expect((await call(main, '/api/homes', 'POST', { name: 'No overwrite', path })).code).not.toBe(0);
    expect((await call(main, '/api/homes')).data).toMatchObject({ items: [{ id: 'main' }] });
  });
});
