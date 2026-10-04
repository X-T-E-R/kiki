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

  async function settings(server: RunningServer, id: string) {
    const response = await call(server, `/api/homes/${id}/settings`);
    expect(response.code, JSON.stringify(response)).toBe(0);
    return (await import('@kiki/protocol')).spaceDetailSchema.parse(response.data);
  }
  async function preview(server: RunningServer, id: string, request: import('@kiki/protocol').SpacePlanRequest) {
    const response = await call(server, `/api/homes/${id}/settings/preview`, 'POST', request);
    expect(response.code, JSON.stringify(response)).toBe(0);
    return (await import('@kiki/protocol')).spacePreviewSchema.parse(response.data);
  }
  async function apply(server: RunningServer, id: string, plan: import('@kiki/protocol').SpacePreview, selected = plan.rows.filter((row) => row.selected).map((row) => row.id)) {
    const response = await call(server, `/api/homes/${id}/settings/apply`, 'POST', { token: plan.token, selected });
    expect(response.code, JSON.stringify(response)).toBe(0);
    return (await import('@kiki/protocol')).spaceMutationResponseSchema.parse(response.data);
  }
  async function edit(server: RunningServer, id: string, changes: { id: string; value: unknown }[]) {
    return apply(server, id, await preview(server, id, { action: 'edit', changes }));
  }
  async function pair() {
    root = await mkdtemp(join(tmpdir(), 'kiki-space-settings-'));
    await writeFile(join(root, 'config.toml'), '[search]\nenabled = false\n');
    const main = await boot(root);
    const path = join(root, 'space');
    const created = await call(main, '/api/homes', 'POST', { name: 'Example research', path });
    expect(created.code).toBe(0);
    const id = (created.data as SpaceRecord).id;
    const child = await boot(path);
    return { main, child, path, id };
  }

  it('persists follow, same-value fixed and one-item edits across independent clients and restart', async () => {
    const { main, child, path, id } = await pair();
    expect((await settings(child, id)).preferences.theme).toBe('system');
    await edit(main, 'main', [{ id: 'pref:theme', value: 'dark' }, { id: 'pref:foldSteps', value: false }]);
    const independentClientCache = structuredClone((await settings(main, id)).preferences);
    expect(independentClientCache).toMatchObject({ theme: 'dark', foldSteps: false });
    const fixed = await preview(child, id, { action: 'fixed', items: ['pref:theme'] });
    expect(fixed.rows[0]).toMatchObject({ same_value: true, selected: true });
    await apply(child, id, fixed);
    await edit(main, 'main', [{ id: 'pref:theme', value: 'light' }, { id: 'pref:foldSteps', value: true }]);
    expect((await settings(child, id)).preferences).toMatchObject({ theme: 'dark', foldSteps: true });
    await edit(child, id, [{ id: 'pref:defaultAppendTiming', value: 'tasks_done' }]);
    const detail = await settings(child, id);
    expect(detail.items.find((item) => item.id === 'pref:defaultAppendTiming')?.selection).toMatchObject({ mode: 'fixed', reason: 'edited' });
    expect(detail.items.find((item) => item.id === 'pref:foldSteps')?.selection.mode).toBe('follow');
    await child.close(); servers.splice(servers.indexOf(child), 1);
    const reopened = await boot(path);
    expect((await settings(reopened, id)).preferences).toMatchObject({ theme: 'dark', defaultAppendTiming: 'tasks_done', foldSteps: true });
    expect((await settings(main, id)).preferences).toEqual((await settings(reopened, id)).preferences);
  });

  it('keeps deselected group exceptions, cancels with zero writes and rejects either-side preview changes', async () => {
    const { main, child, path, id } = await pair();
    await edit(child, id, [{ id: 'pref:theme', value: 'dark' }, { id: 'pref:proseFont', value: 'sans' }]);
    const before = await readFile(join(path, 'space-preferences.json'), 'utf8');
    const cancelled = await preview(child, id, { action: 'follow', groups: ['appearance'] });
    await apply(child, id, cancelled, []);
    expect(await readFile(join(path, 'space-preferences.json'), 'utf8')).toBe(before);
    const partial = await preview(child, id, { action: 'follow', groups: ['appearance'] });
    await apply(child, id, partial, partial.rows.filter((row) => row.selected && row.id !== 'pref:proseFont').map((row) => row.id));
    const detail = await settings(child, id);
    expect(detail.preferences).toMatchObject({ theme: 'system', proseFont: 'sans' });
    expect(detail.groups.find((group) => group.domain === 'appearance')).toMatchObject({ mode: 'follow', fixed_count: 1 });
    expect((await settings(main, 'main')).preferences.theme).toBe('system');
    const staleMain = await preview(child, id, { action: 'fixed', items: ['pref:theme'] });
    await edit(main, 'main', [{ id: 'pref:theme', value: 'light' }]);
    expect((await call(child, `/api/homes/${id}/settings/apply`, 'POST', { token: staleMain.token, selected: ['pref:theme'] })).code).not.toBe(0);
    const staleOwn = await preview(child, id, { action: 'follow', items: ['pref:proseFont'] });
    await edit(child, id, [{ id: 'pref:proseFont', value: 'serif' }]);
    expect((await call(child, `/api/homes/${id}/settings/apply`, 'POST', { token: staleOwn.token, selected: ['pref:proseFont'] })).code).not.toBe(0);
    const sibling = await call(main, '/api/homes', 'POST', { name: 'Sibling', path: join(root!, 'sibling') });
    expect((await call(child, `/api/homes/${(sibling.data as SpaceRecord).id}/settings/preview`, 'POST', { action: 'fixed', items: ['pref:theme'] })).code).not.toBe(0);
  });

  it('pushes only explicitly selected non-secret items and undo refuses later main writes', async () => {
    const { main, child, id } = await pair();
    await edit(child, id, [{ id: 'pref:theme', value: 'dark' }, { id: 'pref:foldSteps', value: false }]);
    const plan = await preview(child, id, { action: 'push-to-main', items: ['pref:theme', 'pref:foldSteps', 'source:credentials'] });
    expect(plan.rows.find((row) => row.id === 'source:credentials')).toMatchObject({ selected: false, blocked_reason: expect.any(String) });
    const result = await apply(child, id, plan, ['pref:theme']);
    expect((await settings(main, 'main')).preferences).toMatchObject({ theme: 'dark', foldSteps: true });
    const own = await settings(child, id);
    expect(own.items.find((item) => item.id === 'pref:theme')?.selection.mode).toBe('follow');
    expect(own.items.find((item) => item.id === 'pref:foldSteps')?.selection.mode).toBe('fixed');
    expect((await call(child, `/api/homes/${id}/settings/undo`, 'POST', { undo_id: result.undo_id })).code).toBe(0);
    expect((await settings(main, 'main')).preferences.theme).toBe('system');
    expect((await settings(child, id)).preferences.theme).toBe('dark');
    const again = await apply(child, id, await preview(child, id, { action: 'push-to-main', items: ['pref:theme'] }), ['pref:theme']);
    await edit(main, 'main', [{ id: 'pref:theme', value: 'light' }]);
    expect((await call(child, `/api/homes/${id}/settings/undo`, 'POST', { undo_id: again.undo_id })).code).not.toBe(0);
    expect((await settings(main, 'main')).preferences.theme).toBe('light');
  });

  it('imports legacy preferences once without resetting local or false resource choices', async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-legacy-space-'));
    await writeFile(join(root, 'config.toml'), '[search]\nenabled = false\n');
    const path = join(root, 'legacy'); await mkdir(path);
    await writeFile(join(path, 'home.toml'), `schema = 1\nid = "h-example-legacy"\nname = "Legacy"\nbase = ${JSON.stringify(root)}\n[inherit]\nappearance = true\nskills = false\nconfig = false\ninstructions = "stack"\ncredentials = "isolated"\n`);
    await writeFile(join(path, 'config.toml'), 'default_plan_mode = true\n');
    const main = await boot(root); await call(main, '/api/homes:attach', 'POST', { path });
    await edit(main, 'main', [{ id: 'pref:theme', value: 'dark' }]);
    const child = await boot(path); const id = 'h-example-legacy';
    expect(await settings(child, id)).toMatchObject({ preference_authority: false, preferences: { theme: 'system', skin: { source: 'builtin', id: 'paper' } }, inherit: { skills: false, config: false, instructions: 'stack', credentials: 'isolated' } });
    expect(await call(child, `/api/homes/${id}/settings/import-preferences`, 'POST', { device_id: 'first-device', values: { theme: 'light', skin: { source: 'builtin', id: 'porcelain' }, tweaks: { accent: '#123456' }, foldSteps: false } })).toMatchObject({ code: 0, data: { imported: true, device_conflict: false } });
    expect(await call(child, `/api/homes/${id}/settings/import-preferences`, 'POST', { device_id: 'other-device', values: { theme: 'dark' } })).toMatchObject({ code: 0, data: { imported: false, device_conflict: true } });
    expect((await settings(child, id)).preferences).toMatchObject({ theme: 'light', tweaks: { accent: '#123456' }, foldSteps: false });
    expect((await settings(child, id)).items.find((item) => item.id === 'config:default_plan_mode')?.selection.mode).toBe('fixed');
    expect((await readFile(join(path, 'home.toml'), 'utf8'))).toContain('skills = false');
  });

  it('really freezes resource files, reports restart, follows deletion, and keeps retained copies inactive', async () => {
    const { main, child, path, id } = await pair();
    await mkdir(join(root!, 'skills/example'), { recursive: true });
    await writeFile(join(root!, 'skills/example/SKILL.md'), 'first content');
    const resource = 'resource:skills:skills/example';
    await apply(child, id, await preview(child, id, { action: 'fixed', items: [resource] }));
    expect(await readFile(join(path, 'skills/example/SKILL.md'), 'utf8')).toBe('first content');
    await writeFile(join(root!, 'skills/example/SKILL.md'), 'second content');
    expect(await readFile(join(path, 'skills/example/SKILL.md'), 'utf8')).toBe('first content');
    expect((await settings(child, id)).items.find((item) => item.id === resource)).toMatchObject({ selection: { mode: 'fixed' }, pending: true, activation: 'restart' });
    const follow = await preview(child, id, { action: 'follow', items: [resource] });
    await apply(child, id, follow);
    await expect(readFile(join(path, 'skills/example/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await child.close(); servers.splice(servers.indexOf(child), 1);
    const reopened = await boot(path);
    expect((await settings(reopened, id)).items.find((item) => item.id === resource)).toMatchObject({ selection: { mode: 'follow' }, pending: false, available: true });
    await rm(join(root!, 'skills/example'), { recursive: true });
    expect((await settings(reopened, id)).items.find((item) => item.id === resource)).toMatchObject({ available: false, effective: null });
    expect((await settings(main, 'main')).primary).toBe(true);
  });

  it('does not lose local overrides when resource dependencies or main publication fail', async () => {
    const { child, path, id } = await pair();
    await edit(child, id, [{ id: 'pref:theme', value: 'dark' }]);
    const plan = await preview(child, id, { action: 'push-to-main', items: ['pref:theme'] });
    const before = await readFile(join(path, 'space-preferences.json'), 'utf8');
    await mkdir(join(root!, '.space-preferences-lock'));
    expect((await call(child, `/api/homes/${id}/settings/apply`, 'POST', { token: plan.token, selected: ['pref:theme'] })).code).not.toBe(0);
    expect(await readFile(join(path, 'space-preferences.json'), 'utf8')).toBe(before);
    await rm(join(root!, '.space-preferences-lock'), { recursive: true });
    await mkdir(join(root!, 'agents'), { recursive: true });
    await writeFile(join(root!, 'SYSTEM.md'), 'first system');
    await writeFile(join(root!, 'agents/example.md'), 'agent definition');
    const fixed = await preview(child, id, { action: 'fixed', items: ['resource:agents:agents/example.md', 'resource:agents:SYSTEM.md'] });
    await writeFile(join(root!, 'SYSTEM.md'), 'changed system');
    expect((await call(child, `/api/homes/${id}/settings/apply`, 'POST', { token: fixed.token, selected: fixed.rows.map((row) => row.id) })).code).not.toBe(0);
    await expect(readFile(join(path, 'agents/example.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back a publication failure after main was written before clearing local overrides', async () => {
    const { main, child, path, id } = await pair();
    await edit(child, id, [{ id: 'pref:theme', value: 'dark' }]);
    const before = await readFile(join(path, 'space-preferences.json'), 'utf8');
    const mainBefore = (await settings(main, 'main')).preferences;
    const plan = await preview(child, id, { action: 'push-to-main', items: ['pref:theme'] });
    await rm(join(path, '.space-preferences-undo.json'));
    await mkdir(join(path, '.space-preferences-undo.json'));
    expect((await call(child, `/api/homes/${id}/settings/apply`, 'POST', { token: plan.token, selected: ['pref:theme'] })).code).not.toBe(0);
    expect(await readFile(join(path, 'space-preferences.json'), 'utf8')).toBe(before);
    expect((await settings(main, 'main')).preferences).toEqual(mainBefore);
    await rm(join(path, '.space-preferences-undo.json'), { recursive: true });
    await apply(child, id, plan, ['pref:theme']);
    expect((await settings(main, 'main')).preferences.theme).toBe('dark');
  });

  it('preserves config identity, same-value local intent and unselected domains through fixed and follow', async () => {
    const { main, child, path, id } = await pair();
    await edit(main, 'main', [{ id: 'config:default_plan_mode', value: false }]);
    await edit(child, id, [{ id: 'config:default_plan_mode', value: false }]);
    await edit(main, 'main', [{ id: 'config:default_plan_mode', value: true }]);
    expect((await settings(child, id)).items.find((item) => item.id === 'config:default_plan_mode')).toMatchObject({ selection: { mode: 'fixed' }, effective: false, actual: false });
    const metadataBefore = await readFile(join(path, 'home.toml'), 'utf8');
    const plan = await preview(child, id, { action: 'follow', items: ['config:default_plan_mode'] });
    await apply(child, id, plan);
    expect(await readFile(join(path, 'home.toml'), 'utf8')).toBe(metadataBefore);
    expect((await call(child, '/api/config')).data).toMatchObject({ default_plan_mode: true });
    expect((await settings(child, id)).items.find((item) => item.id === 'pref:theme')?.selection.mode).toBe('follow');
    expect((await readFile(join(path, 'config.toml'), 'utf8'))).not.toContain('default_plan_mode');
    expect((await call(child, '/api/config', 'POST', { default_plan_mode: false })).code).toBe(0);
    expect((await settings(child, id)).items.find((item) => item.id === 'config:default_plan_mode')?.selection).toMatchObject({ mode: 'fixed', reason: 'edited' });
  });

  it('hot reloads explicit config follow exceptions while a fixed group keeps independent defaults', async () => {
    const { child, path, id } = await pair();
    await child.close(); servers.splice(servers.indexOf(child), 1);
    const metadata = await readFile(join(path, 'home.toml'), 'utf8');
    expect(metadata).toContain('[inherit]');
    expect(metadata).not.toContain('config =');
    await writeFile(join(path, 'home.toml'), metadata.replace('[inherit]', '[inherit]\nconfig = false'));
    const choices = JSON.parse(await readFile(join(path, 'space-preferences.json'), 'utf8'));
    choices.groups.config = 'fixed';
    choices.selections['config:default_plan_mode'] = { mode: 'follow' };
    choices.selections['config:space_ui.landing_page'] = { mode: 'fixed' };
    await writeFile(join(path, 'space-preferences.json'), JSON.stringify(choices));
    await writeFile(join(path, 'config.toml'), '[search]\nenabled = false\n');
    await writeFile(join(root!, 'config.toml'), 'default_plan_mode = true\n[search]\nenabled = false\n[space_ui]\nlanding_page = "/usage"\n');
    const reopened = await boot(path);
    expect((await call(reopened, '/api/config')).data).toMatchObject({ default_plan_mode: true, space_ui: { landingPage: '/new' } });
    await writeFile(join(root!, 'config.toml'), 'default_plan_mode = false\n[search]\nenabled = false\n[space_ui]\nlanding_page = "/memory"\n');
    await expect.poll(async () => (await call(reopened, '/api/config')).data, { timeout: 5000 }).toMatchObject({ default_plan_mode: false, space_ui: { landingPage: '/new' } });
    expect((await settings(reopened, id)).items.find((item) => item.id === 'config:default_plan_mode')).toMatchObject({ selection: { mode: 'follow' }, effective: false, actual: false });
  });

  it('reports confirmed remote runtime config instead of saved values and clears actual when the backend closes', async () => {
    const { main, child, id } = await pair();
    const { IConfigService, ConfigTarget } = await import('@kiki/agent-core-v2');
    await child.core.accessor.get(IConfigService).set('defaultPlanMode', true, ConfigTarget.Memory);
    expect((await settings(child, id)).items.find((item) => item.id === 'config:default_plan_mode')).toMatchObject({ effective: false, actual: true, origin: 'environment' });
    await expect.poll(async () => (await settings(main, id)).items.find((item) => item.id === 'config:default_plan_mode')).toMatchObject({ effective: false, actual: true, origin: 'environment' });
    await child.close(); servers.splice(servers.indexOf(child), 1);
    expect((await settings(main, id)).items.find((item) => item.id === 'config:default_plan_mode')).toMatchObject({ effective: false, actual: null });
  });

  it('uses inherited JSON skin list/get consistently and excludes an item without enabling plugins', async () => {
    const { main, child, path, id } = await pair();
    const skin = { kind: 'kiki-skin', version: 1, name: 'Example skin', variants: { light: { colors: { paper: '#ffffff' } } } };
    await mkdir(join(root!, 'themes'), { recursive: true });
    await writeFile(join(root!, 'themes/example.json'), JSON.stringify(skin));
    expect(await call(child, '/api/skins')).toMatchObject({ code: 0, data: { items: [{ id: 'example', name: 'Example skin' }] } });
    expect(await call(child, '/api/skins/example')).toMatchObject({ code: 0, data: { skin: { name: 'Example skin' } } });
    await mkdir(join(path, 'themes'), { recursive: true });
    await writeFile(join(path, 'themes/example.json'), JSON.stringify({ ...skin, name: 'Local skin' }));
    expect(await call(child, '/api/skins/example')).toMatchObject({ code: 0, data: { skin: { name: 'Local skin' } } });
    const item = 'resource:appearance:themes/example.json';
    await apply(child, id, await preview(child, id, { action: 'exclude', items: [item] }));
    expect((await settings(main, id)).restart_required).toBe(true);
    await child.close(); servers.splice(servers.indexOf(child), 1);
    const reopened = await boot(path);
    expect(await call(reopened, '/api/skins')).toMatchObject({ code: 0, data: { items: [] } });
    expect((await call(reopened, '/api/skins/example')).code).not.toBe(0);
    expect((await settings(reopened, id)).inherit.plugins).toBe(false);
    await apply(reopened, id, await preview(reopened, id, { action: 'follow', items: [item] }));
    await reopened.close(); servers.splice(servers.indexOf(reopened), 1);
    const followed = await boot(path);
    expect(await call(followed, '/api/skins/example')).toMatchObject({ code: 0, data: { skin: { name: 'Example skin' } } });
  });

  it('freezes main instructions separately from an existing local stack supplement and preserves order', async () => {
    const { main, child, path, id } = await pair();
    await edit(child, id, [{ id: 'source:instructions', value: 'stack' }]);
    await writeFile(join(root!, 'AGENTS.md'), 'main version one');
    await writeFile(join(path, 'AGENTS.md'), 'local supplement');
    const plan = await preview(child, id, { action: 'fixed', groups: ['instructions'] });
    expect(plan.rows.find((row) => row.id === 'source:instructions')?.selected).toBe(false);
    await apply(child, id, plan);
    expect(await readFile(join(path, 'AGENTS.md'), 'utf8')).toBe('local supplement');
    await writeFile(join(root!, 'AGENTS.md'), 'main version two');
    await child.close(); servers.splice(servers.indexOf(child), 1);
    const reopened = await boot(path);
    const { resolveSpaceInheritance } = await import('@kiki/agent-core-v2/app/bootstrap/spaceInheritance');
    const { loadAgentsMd } = await import('@kiki/agent-core-v2/agent/profile/context');
    const { IHostFileSystem } = await import('@kiki/agent-core-v2');
    const inheritance = resolveSpaceInheritance(reopened.core.accessor.get(IBootstrapService));
    await mkdir(join(path, 'project'));
    const instructions = await loadAgentsMd({ fs: reopened.core.accessor.get(IHostFileSystem), homeDir: path }, join(path, 'project'), path, { inheritance });
    expect(instructions).toContain('main version one');
    expect(instructions).not.toContain('main version two');
    expect(instructions.indexOf('main version one')).toBeLessThan(instructions.indexOf('local supplement'));
    expect((await settings(main, id)).inherit.instructions).toBe('stack');
  });

  it('uses real MCP entry adapters, preserves other entries and never puts account data in ordinary undo', async () => {
    const { child, path, id } = await pair();
    await writeFile(join(root!, 'mcp.json'), JSON.stringify({ mcpServers: { example: { command: 'example-command', args: ['one'] }, account: { command: 'example-command', env: { TOKEN: 'FIXTURE_ACCOUNT_VALUE' } } } }));
    const item = 'resource:mcp:example';
    await apply(child, id, await preview(child, id, { action: 'fixed', items: [item] }));
    expect(JSON.parse(await readFile(join(path, 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { example: { command: 'example-command', args: ['one'] } } });
    await writeFile(join(root!, 'mcp.json'), JSON.stringify({ mcpServers: { example: { command: 'example-command', args: ['two'] }, account: { command: 'example-command', env: { TOKEN: 'FIXTURE_ACCOUNT_VALUE' } } } }));
    const accountBefore = await readFile(join(root!, 'mcp.json'), 'utf8');
    const localBefore = await readFile(join(path, 'mcp.json'), 'utf8');
    const stateBefore = await readFile(join(path, 'space-preferences.json'), 'utf8');
    const blocked = await preview(child, id, { action: 'fixed', items: ['resource:mcp:account'] });
    expect(blocked.rows[0]).toMatchObject({ selected: false, blocked_reason: expect.any(String) });
    expect((await call(child, `/api/homes/${id}/settings/apply`, 'POST', { token: blocked.token, selected: ['resource:mcp:account'] })).code).not.toBe(0);
    expect(await readFile(join(root!, 'mcp.json'), 'utf8')).toBe(accountBefore);
    expect(await readFile(join(path, 'mcp.json'), 'utf8')).toBe(localBefore);
    expect(await readFile(join(path, 'space-preferences.json'), 'utf8')).toBe(stateBefore);
    expect((await settings(child, id)).items.find((entry) => entry.id === 'resource:mcp:account')?.selection.mode).toBe('follow');
    await apply(child, id, await preview(child, id, { action: 'exclude', items: [item] }));
    expect(await readFile(join(path, '.space-preferences-undo.json'), 'utf8')).not.toContain('FIXTURE_ACCOUNT_VALUE');
    await child.close(); servers.splice(servers.indexOf(child), 1);
    const reopened = await boot(path);
    const { resolveSpaceInheritance, resolveSpaceMcpBaseSelection } = await import('@kiki/agent-core-v2/app/bootstrap/spaceInheritance');
    const { loadMcpServers } = await import('@kiki/agent-core-v2/app/mcpConfig/configLoader');
    const { IHostFileSystem } = await import('@kiki/agent-core-v2');
    const bootstrap = reopened.core.accessor.get(IBootstrapService);
    const inherited = resolveSpaceInheritance(bootstrap);
    const mcpServers = await loadMcpServers({ fs: reopened.core.accessor.get(IHostFileSystem), cwd: path, homeDir: path, baseHomeDir: bootstrap.baseHomeDir, baseSelection: resolveSpaceMcpBaseSelection(bootstrap), includeProject: false });
    expect(mcpServers).not.toHaveProperty('example');
    expect(mcpServers).toHaveProperty('account');
    await expect(readFile(join(inherited.baseHomeDir!, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const catalog = await call(reopened, '/api/mcp/servers');
    expect(JSON.stringify(catalog.data)).not.toContain('FIXTURE_ACCOUNT_VALUE');
    expect(JSON.stringify(catalog.data)).not.toContain('"name":"example"');
    expect((await settings(reopened, id)).items.find((entry) => entry.id === item)).toMatchObject({ available: false, selection: { excluded: true } });
  });

  it('keeps group exceptions and freezes membership while resource undo restores retained content', async () => {
    const { child, path, id } = await pair();
    for (const name of ['one', 'two']) {
      await mkdir(join(root!, 'skills', name), { recursive: true });
      await writeFile(join(root!, 'skills', name, 'SKILL.md'), `${name} initial`);
    }
    const plan = await preview(child, id, { action: 'fixed', groups: ['skills'] });
    await apply(child, id, plan, plan.rows.filter((row) => row.selected && row.id !== 'resource:skills:skills/two').map((row) => row.id));
    await mkdir(join(root!, 'skills/new'), { recursive: true });
    await writeFile(join(root!, 'skills/new/SKILL.md'), 'later member');
    const detail = await settings(child, id);
    expect(detail.groups.find((group) => group.domain === 'skills')).toMatchObject({ mode: 'fixed', follow_count: 1 });
    expect(detail.items.find((item) => item.id === 'resource:skills:skills/new')).toMatchObject({ available: false });
    expect(detail.items.find((item) => item.id === 'resource:skills:skills/two')?.selection.mode).toBe('follow');
    const followed = await apply(child, id, await preview(child, id, { action: 'follow', items: ['resource:skills:skills/one'] }));
    await expect(readFile(join(path, 'skills/one/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await call(child, `/api/homes/${id}/settings/undo`, 'POST', { undo_id: followed.undo_id })).code).toBe(0);
    expect(await readFile(join(path, 'skills/one/SKILL.md'), 'utf8')).toBe('one initial');
    await child.close(); servers.splice(servers.indexOf(child), 1);
    const reopened = await boot(path);
    const { resolveSpaceInheritance } = await import('@kiki/agent-core-v2/app/bootstrap/spaceInheritance');
    const inheritance = resolveSpaceInheritance(reopened.core.accessor.get(IBootstrapService));
    expect(inheritance.skills).toBe(true);
    expect(await readFile(join(inheritance.baseHomeDir!, 'skills/two/SKILL.md'), 'utf8')).toBe('two initial');
    await writeFile(join(root!, 'skills/two/SKILL.md'), 'two followed update');
    expect(await readFile(join(inheritance.baseHomeDir!, 'skills/two/SKILL.md'), 'utf8')).toBe('two followed update');
    await expect(readFile(join(inheritance.baseHomeDir!, 'skills/new/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await reopened.close(); servers.splice(servers.indexOf(reopened), 1);
    const rebuilt = await boot(path);
    expect(await readFile(join(root!, 'skills/two/SKILL.md'), 'utf8')).toBe('two followed update');
    const rebuiltInheritance = resolveSpaceInheritance(rebuilt.core.accessor.get(IBootstrapService));
    expect(await readFile(join(rebuiltInheritance.baseHomeDir!, 'skills/two/SKILL.md'), 'utf8')).toBe('two followed update');
  });

  it('keeps self edits available after detaching but does not grant an unregistered backend main write authority', async () => {
    const { main, child, id } = await pair();
    await edit(child, id, [{ id: 'pref:theme', value: 'dark' }]);
    await call(main, `/api/homes/${id}`, 'DELETE');
    const push = await preview(child, id, { action: 'push-to-main', items: ['pref:theme'] });
    expect((await call(child, `/api/homes/${id}/settings/apply`, 'POST', { token: push.token, selected: ['pref:theme'] })).code).not.toBe(0);
    expect((await settings(main, 'main')).preferences.theme).toBe('system');
    await edit(child, id, [{ id: 'pref:foldSteps', value: false }]);
    expect((await settings(child, id)).preferences).toMatchObject({ theme: 'dark', foldSteps: false });
  });

  it('freezes ordinary MCP env and existing account references without treating names as secrets', async () => {
    const { child, path, id } = await pair();
    const plain = { command: 'example-command', args: ['one'], env: { MODE: 'private', WORKSPACE_KIND: 'docs' } };
    const referenced = { url: 'https://example.test/mcp', auth: 'oauth', bearerTokenEnvVar: 'EXAMPLE_TOKEN', headers: { 'X-Mode': 'private' } };
    await writeFile(join(root!, 'mcp.json'), JSON.stringify({ mcpServers: { plain, referenced } }));
    const plan = await preview(child, id, { action: 'fixed', items: ['resource:mcp:plain', 'resource:mcp:referenced'] });
    expect(plan.rows.every((row) => row.selected && row.blocked_reason === undefined)).toBe(true);
    await apply(child, id, plan);
    expect(JSON.parse(await readFile(join(path, 'mcp.json'), 'utf8')).mcpServers).toEqual({ plain, referenced });
    expect((await settings(child, id)).inherit.credentials).toBe('shared');
    await apply(child, id, await preview(child, id, { action: 'follow', items: ['resource:mcp:plain'] }));
    expect(JSON.parse(await readFile(join(path, 'mcp.json'), 'utf8')).mcpServers).toEqual({ referenced });
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
