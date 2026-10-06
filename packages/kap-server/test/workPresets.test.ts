import { describe, expect, it, vi } from 'vitest';
import { IPluginHostService, IPluginService } from '@kiki/agent-core-v2';
import { ErrorCode } from '@kiki/protocol';
import { WorkPresetManager } from '../src/services/workPresets/manager';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

function fixture(homeId: string) {
  const values = new Map<string, unknown>();
  const documents = { get: async <T>(scope: string, key: string) => structuredClone(values.get(`${scope}/${key}`)) as T | undefined,
    set: async <T>(scope: string, key: string, value: T) => { values.set(`${scope}/${key}`, structuredClone(value)); } };
  const recordFor = (id: string) => ({ id, displayName: id, enabled: false, version: '1.0.0', state: 'ok' as const, source: 'local-path' as const, skillCount: 0, mcpServerCount: 0, enabledMcpServerCount: 0, hookCount: 0, commandCount: 0, hasErrors: false });
  const installed: ReturnType<typeof recordFor>[] = [];
  const plugins = {
    listPlugins: vi.fn(async () => installed),
    previewPlugin: vi.fn(async ({ source }: { source: string }) => ({ id: source, fingerprint: 'test', changes: [], consentRequired: false, contributions: [], contextTokens: 0, unsupported: [] })),
    installPlugin: vi.fn(async ({ source }: { source: string }) => {
      if (source === 'kiki-extract' && failExtract) throw new Error('dependency unavailable');
      const record = recordFor(source); installed.push(record); return record;
    }),
    setPluginEnabled: vi.fn(async ({ id, enabled }: { id: string; enabled: boolean }) => { installed.find((plugin) => plugin.id === id)!.enabled = enabled; }),
  };
  let failExtract = false;
  const host = { installPrerequisite: vi.fn(async () => 'officecli') };
  const sources = async () => new Map(['kiki-office', 'kiki-writing', 'kiki-extract', 'kiki-work'].map((id) => [id, { source: id }]));
  return { manager: new WorkPresetManager(documents, plugins, host, sources, homeId), plugins, host, installed,
    failExtract: (value: boolean) => { failExtract = value; } };
}

describe('space-local work presets', () => {
  it('leaves experimental Work mutations unavailable without installing packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-work-off-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, env: { ...process.env, KIKI_EXPERIMENTAL_WORK_PRESETS: 'false' }, logLevel: 'silent' });
      for (const [path, method, body] of [['/api/work-presets', 'GET', undefined], ['/api/work-presets/work/enable', 'POST', { consent: true, install_prerequisites: false }]] as const) {
        const response = await authedFetch(server, `http://127.0.0.1:${server.port}`, path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        expect(await response.json()).toMatchObject({ code: ErrorCode.CAPABILITY_UNSUPPORTED });
      }
      expect(await server.core.accessor.get(IPluginService).listPlugins()).toEqual([]);
    } finally { await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
  it('offers the same install flow to a fresh main home and another space, without writes on read', async () => {
    const a = fixture('main'); const b = fixture('h-example');
    expect((await a.manager.list()).items.map((item) => [item.id, item.enabled])).toEqual([['kiki', true], ['work', false]]);
    await b.manager.enable('work', true);
    expect((await b.manager.list()).home_id).toBe('h-example');
    expect((await b.manager.list()).items[1]!.enabled).toBe(true);
    expect((await a.manager.list()).items[1]!.enabled).toBe(false);
    expect(a.plugins.installPlugin).not.toHaveBeenCalled();
    expect(b.host.installPrerequisite).toHaveBeenCalledWith('kiki-office', 'officecli', true);
  });
  it('retains successes on failure and retries only missing packages', async () => {
    const a = fixture('h-example'); a.failExtract(true);
    const partial = await a.manager.enable('work', false);
    expect(partial.failures).toEqual([{ plugin_id: 'kiki-extract', message: 'dependency unavailable' }]);
    expect(partial.completed).toEqual(['kiki-office', 'kiki-writing', 'kiki-work']);
    a.failExtract(false);
    const repaired = await a.manager.enable('work', false);
    expect(repaired.failures).toEqual([]);
    expect(a.plugins.installPlugin).toHaveBeenCalledTimes(5);
    expect(a.host.installPrerequisite).not.toHaveBeenCalled();
  });
  it('never revives removed or disabled plugins on view, preference change, disable or mode removal', async () => {
    const a = fixture('main'); await a.manager.enable('work', false);
    a.installed[0]!.enabled = false; a.installed.splice(1, 1);
    await a.manager.update('work', { preferences: { name: 'Reports', default_task: 'tables' } });
    await a.manager.update('work', { enabled: false });
    await a.manager.remove('work');
    const state = (await a.manager.list()).items[1]!;
    expect(state).toMatchObject({ name: 'Reports', enabled: false, removed: true });
    expect(state.plugins.find((plugin) => plugin.id === 'kiki-office')!.enabled).toBe(false);
    expect(a.plugins.installPlugin).toHaveBeenCalledTimes(4);
    expect(a.plugins.setPluginEnabled).toHaveBeenCalledTimes(4);
    expect(a.installed).toHaveLength(3);
    await expect(a.manager.remove('kiki')).rejects.toThrow('cannot be removed');
  });
  it('installs the same source packages separately in two real homes and preserves disabled packages and original material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-work-rest-'));
    const servers: RunningServer[] = [];
    try {
      const main = join(root, 'main'), child = join(root, 'child'), packages = join(root, 'packages');
      await mkdir(main); await mkdir(child);
      await writeFile(join(child, 'home.toml'), `schema = 1\nid = "h-example"\nname = "Reports"\nbase = ${JSON.stringify(main)}\n[inherit]\ncredentials = "isolated"\nplugins = false\n`);
      await writeFile(join(main, 'source.csv'), 'id,amount\n001,100\n');
      for (const id of ['kiki-office', 'kiki-writing', 'kiki-extract', 'kiki-work']) {
        await mkdir(join(packages, id), { recursive: true });
        await writeFile(join(packages, id, 'kimi.plugin.json'), JSON.stringify({ name: id, version: '0.1.0', description: 'Local test package', license: 'MIT' }));
      }
      for (const homeDir of [main, child]) servers.push(await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir, env: { ...process.env, KIKI_EXPERIMENTAL_WORK_PRESETS: 'true', KIKI_WORK_PLUGIN_ROOT: packages }, logLevel: 'silent' }));
      const call = async (server: RunningServer, path: string, method = 'GET', body?: object) => {
        const response = await authedFetch(server, `http://127.0.0.1:${server.port}`, path, { method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        expect(response.status).toBe(200);
        return await response.json() as { code: number; data: import('@kiki/protocol').WorkPresetsResponse & import('@kiki/protocol').WorkPresetMutationResponse };
      };
      expect((await call(servers[1]!, '/api/work-presets')).data.home_id).toBe('h-example');
      expect((await call(servers[0]!, '/api/work-presets/work/enable', 'POST', { consent: false })).code).not.toBe(0);
      for (const server of servers) {
        const enabled = await call(server, '/api/work-presets/work/enable', 'POST', { consent: true, install_prerequisites: false });
        expect(enabled.code).toBe(0); expect(enabled.data.failures).toEqual([]); expect(enabled.data.completed).toHaveLength(4);
      }
      await call(servers[0]!, '/api/work-presets/work', 'PATCH', { preferences: { name: 'Main reports' } });
      await call(servers[1]!, '/api/work-presets/work', 'PATCH', { preferences: { name: 'Child invoices' } });
      await call(servers[0]!, '/api/plugins/kiki-writing:disable', 'POST', {});
      await call(servers[0]!, '/api/work-presets/work', 'DELETE');
      const a = (await call(servers[0]!, '/api/work-presets')).data.items[1]!;
      const b = (await call(servers[1]!, '/api/work-presets')).data.items[1]!;
      expect(a).toMatchObject({ name: 'Main reports', removed: true, enabled: false });
      expect(a.plugins.find(plugin => plugin.id === 'kiki-writing')!.enabled).toBe(false);
      expect(b).toMatchObject({ name: 'Child invoices', removed: false, enabled: true });
      expect(b.plugins.every(plugin => plugin.enabled)).toBe(true);
      expect(await readFile(join(main, 'source.csv'), 'utf8')).toBe('id,amount\n001,100\n');
    } finally { for (const server of servers.toReversed()) await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
  it.skipIf(process.env['KIKI_WORK_PLUGIN_ROOT'] === undefined)('installs and executes the real Work table helper through PluginHost, then previews a generated report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-real-work-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, env: { ...process.env, KIKI_EXPERIMENTAL_WORK_PRESETS: 'true' }, logLevel: 'silent' });
      const response = await authedFetch(server, `http://127.0.0.1:${server.port}`, '/api/work-presets/work/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, install_prerequisites: false }) });
      const enabled = await response.json() as { code: number; data: import('@kiki/protocol').WorkPresetMutationResponse };
      expect(enabled.code).toBe(0); expect(enabled.data.failures).toEqual([]);
      const before = join(root, 'before.csv'), after = join(root, 'after.csv');
      await writeFile(before, 'id,amount\n001,100\n002,200\n'); await writeFile(after, 'id,amount\n001,120\n003,50\n');
      const result = await server.core.accessor.get(IPluginHostService).execute('kiki-work', 'table_compare', { left: before, right: after, keys: ['id'] }, new AbortController().signal, undefined, { workspaceRoot: root, approvedPaths: [] });
      expect(result.isError).not.toBe(true);
      const parts = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      expect(parts).toContain('120'); expect(parts).toContain('001');
      const changes = JSON.parse(parts) as { changed: { key: string[]; changes: { column: string; before: string; after: string }[] }[]; counts: { added: number; removed: number; changed: number } };
      const report = `# Reconciliation\n\n${changes.changed.map(row => `${row.key.join('/')}: ${row.changes.map(change => `${change.column} ${change.before} → ${change.after}`).join(', ')}`).join('\n')}\n\nAdded: ${changes.counts.added}. Removed: ${changes.counts.removed}.\n`;
      await writeFile(join(root, 'report.md'), report);
      const sessionResponse = await authedFetch(server, `http://127.0.0.1:${server.port}`, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metadata: { cwd: root } }) });
      const session = await sessionResponse.json() as { code: number; data: { id: string } }; expect(session.code).toBe(0);
      const preview = await authedFetch(server, `http://127.0.0.1:${server.port}`, `/api/sessions/${session.data.id}/document-preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: { kind: 'workspace', path: 'report.md' } }) });
      expect(await preview.json()).toMatchObject({ code: 0, data: { kind: 'text', read_only: true, content: expect.stringContaining('100 → 120') } });
      expect(await readFile(before, 'utf8')).toBe('id,amount\n001,100\n002,200\n');
    } finally { await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
});
