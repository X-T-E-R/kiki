import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { IPluginHostService } from '@kiki/agent-core-v2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders, bearerToken } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const CATALOG_URL = 'http://marketplace.test/marketplace.json';

const CATALOG = {
  version: '1',
  plugins: [
    {
      id: 'demo-plugin',
      tier: 'official',
      displayName: 'Demo Plugin',
      version: 'v2.0.0',
      relevance: { fileGlobs: ['**/*.docx'] },
      source: 'https://cdn.example.test/demo.zip',
    },
    {
      id: 'third-party-plugin',
      displayName: 'Third Party',
      source: 'https://github.com/example/third',
    },
    {
      id: 'relative-plugin',
      displayName: 'Relative',
      source: './plugins/relative.zip',
      icon: './icon.svg',
    },
    {
      id: 'alias-plugin',
      displayName: 'Alias',
      source: '   ',
      url: './plugins/alias.zip',
    },
    {
      id: 'blank-tier-plugin',
      displayName: 'Blank Tier',
      tier: '  ',
      source: 'https://example.test/bt.zip',
    },
    {
      id: 'gh-plugin',
      displayName: 'GH Plugin',
      version: 2,
      source: 'https://github.com/example/gh/releases/tag/v2.0.0',
    },
    {
      id: 'kimi-webbridge',
      displayName: 'Kimi WebBridge',
      source: 'https://cdn.example.test/kimi-webbridge.zip',
    },
    {
      id: 'kimi-cu',
      displayName: 'Kimi Computer Use',
      source: 'https://cdn.example.test/kimi-cu.zip',
    },
    {
      id: '  meta-alias-plugin  ',
      name: 'Meta Alias',
      shortDescription: 'Aliased metadata',
      websiteURL: 'https://example.test/meta',
      icon: 'https://example.test/meta-icon.svg',
      keywords: ['web', 3, '  ', 'tools'],
      source: 'https://example.test/meta.zip',
    },
  ],
};

describe('server-v2 /api plugins', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const createdDirs: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-plugins-'));
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          return new Response(JSON.stringify(CATALOG), { status: 200 });
        }
        if (url === 'https://github.com/example/third/releases/latest') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/example/third/releases/tag/v3.1.0' },
          });
        }
        if (typeof url === 'string' && url.includes('/releases/latest')) {
          return new Response(null, { status: 404 });
        }
        return realFetch(url as never, init);
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      pluginMarketplaceUrl: CATALOG_URL,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function install<T>(source: string): Promise<{ status: number; body: Envelope<T> }> {
    const preview = await call<{ fingerprint: string; consentRequired: boolean }>('POST', '/api/plugins:preview', { source });
    expect(preview.body.code).toBe(0);
    return call<T>('POST', '/api/plugins', { source, fingerprint: preview.body.data.fingerprint, consent: true });
  }

  async function makePluginDir(id: string, version: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `kimi-test-plugin-${id}-`));
    createdDirs.push(dir);
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({ name: id, version, description: 'test plugin' }),
    );
    return dir;
  }

  it('serves an enabled writing panel as CSP-protected srcdoc and lists its command', async () => {
    const source = join(import.meta.dirname, '../../../plugins/official/kiki-writing');
    expect((await install(source)).body.code).toBe(0);
    expect((await call('POST', '/api/plugins/kiki-writing:enable')).body.code).toBe(0);
    const listed = await call<{ panels: { pluginId: string; id: string }[] }>('GET', '/api/plugins/panels');
    expect(listed.body.data.panels).toContainEqual(expect.objectContaining({ pluginId: 'kiki-writing', id: 'manuscript' }));
    const document = await call<{ html: string; sandbox: string }>('GET', '/api/plugins/kiki-writing/panels/manuscript/document');
    expect(document.body.code).toBe(0);
    expect(document.body.data.sandbox).toBe('allow-scripts');
    expect(document.body.data.html).toContain('Content-Security-Policy');
    expect(document.body.data.html).toContain("connect-src 'none'");
    expect(document.body.data.html).toContain('kiki.panel.v1');
    const commands = await call<{ commands: { name: string }[] }>('GET', '/api/plugins/commands');
    expect(commands.body.data.commands).toContainEqual(expect.objectContaining({ name: 'continue-draft' }));
    const rejected = await call('POST', '/api/plugins/kiki-writing/panels/manuscript/bridge', {
      method: 'plugin.call', session_id: 'missing', action: 'unknown', args: {},
    });
    expect(rejected.body.code).toBe(40401);
    const session = await call<{ id: string }>('POST', '/api/sessions', { metadata: { cwd: home! } });
    expect(session.body.code).toBe(0);
    const summary = await call<{ result: { id: string } }>('POST', '/api/plugins/kiki-writing/panels/manuscript/bridge', {
      method: 'session.summary', session_id: session.body.data.id,
    });
    expect(summary.body.data.result.id).toBe(session.body.data.id);
    const submitted = await call('POST', '/api/plugins/kiki-writing/panels/manuscript/bridge', {
      method: 'session.sendMessage', session_id: session.body.data.id, text: 'Continue the manuscript.',
    });
    expect(submitted.body.code, submitted.body.msg).toBe(40110);
    await call('POST', '/api/plugins/kiki-writing:remove');
    expect((await call<{ panels: unknown[] }>('GET', '/api/plugins/panels')).body.data.panels).toEqual([]);
  });

  it('returns the shipped manifest icon of an installed plugin in list and detail', async () => {
    const plugins = ['kiki-office', 'kiki-writing'];
    const expected: Record<string, string> = {};
    for (const id of plugins) {
      const source = join(import.meta.dirname, `../../../plugins/official/${id}`);
      expected[id] = `data:image/svg+xml;base64,${(await readFile(join(source, 'icon.svg'))).toString('base64')}`;
      expect((await install(source)).body.code, id).toBe(0);
    }

    const listed = await call<{ plugins: { id: string; icon?: string }[] }>('GET', '/api/plugins');
    expect(listed.body.code).toBe(0);
    for (const id of plugins) {
      expect(listed.body.data.plugins.find((plugin) => plugin.id === id)?.icon, id).toBe(expected[id]);
      const info = await call<{ icon?: string }>('GET', `/api/plugins/${id}`);
      expect(info.body.data.icon, id).toBe(expected[id]);
    }

    const manifest = await call<{ manifest: { icon?: string } }>('GET', '/api/plugins/kiki-office');
    expect(manifest.body.data.manifest.icon).toBe(expected['kiki-office']);
  });

  it('stores declared secrets in credentials without exposing them to settings reads', async () => {
    const source = await makePluginDir('settings-fixture', '1.0.0');
    await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({
      name: 'settings-fixture', version: '1.0.0',
      'x-kiki': {
        engines: { kiki: '^0.4.0' }, permissions: { secrets: true },
        settings: { schemaVersion: 1, schema: { type: 'object', properties: {
          apiKey: { type: 'string', secret: true }, label: { type: 'string' },
        } } },
      },
    }));
    expect((await install(source)).body.code).toBe(0);
    const updated = await call<{ values: Record<string, string>; secretsConfigured: string[] }>(
      'POST', '/api/plugins/settings-fixture/settings', { values: { apiKey: 'test-secret-value', label: 'visible' } },
    );
    expect(updated.body.code).toBe(0);
    expect(updated.body.data).toMatchObject({ values: { label: 'visible' }, secretsConfigured: ['apiKey'] });
    expect(JSON.stringify(updated.body.data)).not.toContain('test-secret-value');
    const fetched = await call<{ values: Record<string, string>; secretsConfigured: string[] }>(
      'GET', '/api/plugins/settings-fixture/settings',
    );
    expect(fetched.body.data).toMatchObject({ values: { label: 'visible' }, secretsConfigured: ['apiKey'] });
    expect(await readFile(join(home!, 'config.toml'), 'utf8')).not.toContain('test-secret-value');
    expect(await readFile(join(home!, 'credentials', 'credentials.toml'), 'utf8')).toContain('test-secret-value');
    expect((await call('POST', '/api/plugins/settings-fixture:remove', { deleteData: true })).body.code).toBe(0);
  });

  it('installs, lists, disables, enables, and removes a plugin', async () => {
    const empty = await call<{ plugins: unknown[] }>('GET', '/api/plugins');
    expect(empty.body.data.plugins).toEqual([]);

    const source = await makePluginDir('demo-plugin', '1.0.0');
    const installed = await install<{ id: string; version: string; enabled: boolean }>(source);
    expect(installed.body.code).toBe(0);
    expect(installed.body.data).toMatchObject({ id: 'demo-plugin', version: '1.0.0', enabled: false });

    const list = await call<{ plugins: { id: string; enabled: boolean }[] }>(
      'GET',
      '/api/plugins',
    );
    expect(list.body.data.plugins.map((p) => [p.id, p.enabled])).toEqual([['demo-plugin', false]]);

    const disabled = await call<{ ok: true }>('POST', '/api/plugins/demo-plugin:disable');
    expect(disabled.body.code).toBe(0);
    const afterDisable = await call<{ plugins: { enabled: boolean }[] }>('GET', '/api/plugins');
    expect(afterDisable.body.data.plugins[0]?.enabled).toBe(false);

    const enabled = await call<{ ok: true }>('POST', '/api/plugins/demo-plugin:enable');
    expect(enabled.body.code).toBe(0);

    const removed = await call<{ ok: true }>('POST', '/api/plugins/demo-plugin:remove');
    expect(removed.body.code).toBe(0);
    const afterRemove = await call<{ plugins: unknown[] }>('GET', '/api/plugins');
    expect(afterRemove.body.data.plugins).toEqual([]);
  });

  it('keeps tool hosts lazy and retires them when the plugin is removed', async () => {
    const source = await mkdtemp(join(tmpdir(), 'kiki-tool-fixture-'));
    createdDirs.push(source);
    await cp(join(import.meta.dirname, '../../agent-core-v2/test/fixtures/plugin-host'), source, { recursive: true });
    const installed = await install<{ id: string }>(source);
    expect(installed.body.code).toBe(0);
    await call('POST', '/api/plugins/fixture-tool:enable');
    const hosts = server!.core.accessor.get(IPluginHostService);
    expect((await hosts.list()).map((item) => item.definition.name)).toEqual(['fixture_echo']);
    expect(hosts.running('fixture-tool')).toBe(false);
    await expect(hosts.execute('fixture-tool', 'fixture_echo', { value: 'server' }, new AbortController().signal))
      .resolves.toEqual({ output: 'server' });
    expect(hosts.running('fixture-tool')).toBe(true);
    const session = await call<{ id: string }>('POST', '/api/sessions', { metadata: { cwd: home! } });
    expect(session.body.code).toBe(0);
    const panel = await call<{ result: { args: { value: string } } }>('POST',
      '/api/plugins/fixture-tool/panels/fixture/bridge', {
        method: 'plugin.call', session_id: session.body.data.id, action: 'echo', args: { value: 'panel' },
      });
    expect(panel.body.data.result.args).toEqual({ value: 'panel' });
    await call('POST', '/api/plugins/fixture-tool:remove');
    expect(hosts.running('fixture-tool')).toBe(false);
    expect(await hosts.list()).toEqual([]);
  });

  it('matches only curated catalog relevance and honors do-not-remind', async () => {
    const matched = await call<{ entries: { id: string }[] }>('POST', '/api/plugins/recommendations/match', {
      files: ['draft.docx'], commands: [], dependencies: [],
    });
    expect(matched.body.code).toBe(0);
    expect(matched.body.data.entries.map((entry) => entry.id)).toEqual(['demo-plugin']);
    expect((await call('POST', '/api/plugins/demo-plugin:dismiss-recommendation')).body.code).toBe(0);
    const suppressed = await call<{ entries: unknown[] }>('POST', '/api/plugins/recommendations/match', { files: ['draft.docx'] });
    expect(suppressed.body.data.entries).toEqual([]);
    expect((await call<{ plugins: unknown[] }>('GET', '/api/plugins')).body.data.plugins).toEqual([]);
  });

  it('does not expose project plugin recommendations before workspace trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-project-recommendation-'));
    createdDirs.push(root);
    await mkdir(join(root, '.kiki'));
    await writeFile(join(root, '.kiki', 'plugins.json'), JSON.stringify({ recommendations: [
      { id: 'kiki-office', source: 'https://example.org/office.zip' },
    ] }));
    const session = await call<{ workspace_id: string }>('POST', '/api/sessions', { metadata: { cwd: root } });
    expect(session.body.code).toBe(0);
    const workspaceId = session.body.data.workspace_id;
    const untrusted = await call<{ trusted: boolean; recommendations: unknown[] }>('GET',
      `/api/workspaces/${workspaceId}/plugin-recommendations`);
    expect(untrusted.body.data).toEqual({ trusted: false, recommendations: [] });
    expect((await call('POST', `/api/workspaces/${workspaceId}/trust`)).body.code).toBe(0);
    const trusted = await call<{ trusted: boolean; recommendations: { id: string }[] }>('GET',
      `/api/workspaces/${workspaceId}/plugin-recommendations`);
    expect(trusted.body.code).toBe(0);
    expect(trusted.body.data.recommendations).toContainEqual(expect.objectContaining({ id: 'kiki-office' }));
  });

  it('requires explicit consent to install a declared prerequisite and persists its own path', async () => {
    const source = await mkdtemp(join(tmpdir(), 'kiki-prerequisite-fixture-'));
    createdDirs.push(source);
    await cp(join(import.meta.dirname, '../../agent-core-v2/test/fixtures/plugin-host'), source, { recursive: true });
    expect((await install(source)).body.code).toBe(0);
    const withoutConsent = await call('POST', '/api/plugins/fixture-tool:install-prerequisite', { id: 'fixture-binary', consent: false });
    expect(withoutConsent.body.code).toBe(40001);
    const installed = await call('POST', '/api/plugins/fixture-tool:install-prerequisite', { id: 'fixture-binary', consent: true });
    expect(installed.body.code).toBe(0);
    const destination = join(home!, 'plugins', 'data', 'fixture-tool', `fixture-binary-1.0.0${process.platform === 'win32' ? '.exe' : ''}`);
    expect(await readFile(destination, 'utf8')).toBe('pinned fixture binary');
    expect((await call<{ values: { binaryPath: string } }>('GET', '/api/plugins/fixture-tool/settings')).body.data.values.binaryPath).toBe(destination);
    expect(server!.core.accessor.get(IPluginHostService).running('fixture-tool')).toBe(false);
    await call('POST', '/api/plugins/fixture-tool:remove', { deleteData: true });
    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.env['KIKI_OFFICE_E2E'] === '1')('installs OfficeCLI with consent, creates a docx, and retires the tool host', async () => {
    const source = join(import.meta.dirname, '../../../plugins/official/kiki-office');
    const installed = await install<{ id: string }>(source);
    expect(installed.body.code).toBe(0);
    expect(installed.body.data.id).toBe('kiki-office');
    expect((await call('POST', '/api/plugins/kiki-office:enable')).body.code).toBe(0);
    const hosts = server!.core.accessor.get(IPluginHostService);
    expect((await hosts.list()).filter((item) => item.pluginId === 'kiki-office')).toHaveLength(9);
    expect(hosts.running('kiki-office')).toBe(false);
    expect((await call('POST', '/api/plugins/kiki-office:install-prerequisite', { id: 'officecli', consent: true })).body.code).toBe(0);
    const binary = join(home!, 'plugins', 'data', 'kiki-office', `officecli-1.0.152${process.platform === 'win32' ? '.exe' : ''}`);
    expect((await stat(binary)).isFile()).toBe(true);
    expect(hosts.running('kiki-office')).toBe(false);
    const document = join(home!, 'demo.docx');
    const created = await hosts.execute('kiki-office', 'office_create', { file: document }, new AbortController().signal, undefined,
      { workspaceRoot: home!, approvedPaths: [], imageIn: false });
    expect(created.isError).toBeFalsy();
    expect((await stat(document)).isFile()).toBe(true);
    expect(hosts.running('kiki-office')).toBe(true);
    expect((await call('POST', '/api/plugins/kiki-office:remove', { deleteData: true })).body.code).toBe(0);
    expect(hosts.running('kiki-office')).toBe(false);
    expect(await hosts.list()).toEqual([]);
    await expect(stat(binary)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('rejects bare ids, bogus actions, and unknown plugins', async () => {
    const bare = await call('POST', '/api/plugins/demo-plugin');
    expect(bare.body.code).toBe(40001);
    const bogus = await call('POST', '/api/plugins/demo-plugin:explode');
    expect(bogus.body.code).toBe(40001);
    const unknown = await call('POST', '/api/plugins/nope:remove');
    expect(unknown.body.code).toBe(40419);
    const badSource = await call('POST', '/api/plugins', { source: '' });
    expect(badSource.body.code).toBe(40001);
  });

  it('fans out event.plugin.changed over WS on install and remove', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws`, [
      `kimi-code.bearer.${bearerToken(server!)}`,
    ]);
    const types: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('message', () => {
          resolve();
        });
        ws.once('error', reject);
      });
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString('utf8')) as { type?: string };
        if (frame.type !== undefined) types.push(frame.type);
      });

      const source = await makePluginDir('demo-plugin', '1.0.0');
      await install(source);
      await vi.waitFor(() => {
        expect(types).toContain('event.plugin.changed');
      });

      await call('POST', '/api/plugins/demo-plugin:remove');
      await vi.waitFor(() => {
        expect(types.filter((t) => t === 'event.plugin.changed').length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      ws.close();
    }
  });

  it('maps client-fixable install input errors to 4xx, never 50001', async () => {
    const relative = await call('POST', '/api/plugins:preview', { source: 'relative/dir' });
    expect(relative.body.code).toBe(40001);
    const missing = await call('POST', '/api/plugins:preview', {
      source: join(home!, 'no-such-plugin-dir'),
    });
    expect(missing.body.code).toBe(40409);
    const noManifest = await mkdtemp(join(tmpdir(), 'kimi-no-manifest-'));
    createdDirs.push(noManifest);
    const unloadable = await call('POST', '/api/plugins:preview', { source: noManifest });
    expect(unloadable.body.code).toBe(40001);
  });

  it('serves the marketplace catalog merged with live install state', async () => {
    const before = await call<{
      configured: boolean;
      source?: string;
      entries: {
        id: string;
        tier: string;
        displayName: string;
        source: string;
        version?: string;
        capabilityId?: string;
        description?: string;
        homepage?: string;
        icon?: string;
        keywords?: string[];
        installed?: { version?: string };
      }[];
    }>('GET', '/api/plugins/marketplace');
    expect(before.body.code).toBe(0);
    expect(before.body.data.configured).toBe(true);
    expect(before.body.data.source).toBe(CATALOG_URL);
    expect(before.body.data.entries.map((e) => [e.id, e.tier])).toEqual([
      ['demo-plugin', 'official'],
      ['third-party-plugin', 'third-party'],
      ['relative-plugin', 'third-party'],
      ['alias-plugin', 'third-party'],
      ['blank-tier-plugin', 'third-party'],
      ['gh-plugin', 'third-party'],
      ['kimi-webbridge', 'third-party'],
      ['kimi-cu', 'third-party'],
      ['meta-alias-plugin', 'third-party'],
    ]);
    expect(before.body.data.entries[0]?.installed).toBeUndefined();
    const relative = before.body.data.entries.find((e) => e.id === 'relative-plugin');
    expect(relative?.source).toBe('http://marketplace.test/plugins/relative.zip');
    const alias = before.body.data.entries.find((e) => e.id === 'alias-plugin');
    expect(alias?.source).toBe('http://marketplace.test/plugins/alias.zip');
    expect(before.body.data.entries.find((e) => e.id === 'gh-plugin')?.version).toBe('2.0.0');
    expect(before.body.data.entries.find((e) => e.id === 'third-party-plugin')?.version).toBe(
      '3.1.0',
    );
    expect(
      before.body.data.entries.find((e) => e.id === 'kimi-webbridge')?.capabilityId,
    ).toBeUndefined();
    expect(before.body.data.entries.some((e) => e.source.startsWith('capability:'))).toBe(false);
    const meta = before.body.data.entries.find((e) => e.id === 'meta-alias-plugin');
    expect(meta?.displayName).toBe('Meta Alias');
    expect(meta?.description).toBe('Aliased metadata');
    expect(meta?.homepage).toBe('https://example.test/meta');
    expect(meta?.keywords).toEqual(['web', 'tools']);
    expect(meta?.icon).toBe('https://example.test/meta-icon.svg');
    expect(relative?.icon).toBeUndefined();

    const source = await makePluginDir('demo-plugin', '1.0.0');
    await install(source);

    const after = await call<{
      entries: {
        id: string;
        installed?: { version?: string; enabled: boolean };
        updateAvailable?: boolean;
      }[];
    }>('GET', '/api/plugins/marketplace');
    const demo = after.body.data.entries.find((e) => e.id === 'demo-plugin');
    expect(demo?.installed).toEqual({ version: '1.0.0', enabled: false });
    expect(demo?.updateAvailable).toBe(true);

    const ghSource = await makePluginDir('gh-plugin', '1.5.0');
    await install(ghSource);
    const afterGh = await call<{
      entries: { id: string; updateAvailable?: boolean }[];
    }>('GET', '/api/plugins/marketplace');
    expect(afterGh.body.data.entries.find((e) => e.id === 'gh-plugin')?.updateAvailable).toBe(true);
  });

  it('rejects a catalog whose entry has no usable source', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          return new Response(
            JSON.stringify({ plugins: [{ id: 'bad', source: '   ' }] }),
            { status: 200 },
          );
        }
        return realFetch(url as never, init);
      }),
    );
    const { body } = await call('GET', '/api/plugins/marketplace');
    expect(body.code).toBe(50001);
    expect(body.msg).toContain('invalid catalog');
  });

  it('rejects a catalog with an unsupported entry type', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          return new Response(
            JSON.stringify({
              plugins: [{ id: 'bad', type: 'integration', source: 'https://example.test/x.zip' }],
            }),
            { status: 200 },
          );
        }
        return realFetch(url as never, init);
      }),
    );
    const { body } = await call('GET', '/api/plugins/marketplace');
    expect(body.code).toBe(50001);
    expect(body.msg).toContain('invalid catalog');
  });

  it('uses the env marketplace URL without injecting capability markers', async () => {
    await server?.close();
    vi.stubEnv('KIKI_PLUGIN_MARKETPLACE_URL', CATALOG_URL);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{
      configured: boolean;
      source?: string;
      entries: { id: string; capabilityId?: string }[];
    }>('GET', '/api/plugins/marketplace');
    expect(body.code).toBe(0);
    expect(body.data.configured).toBe(true);
    expect(body.data.source).toBe(CATALOG_URL);
    expect(body.data.entries.find((e) => e.id === 'kimi-webbridge')?.capabilityId).toBeUndefined();
    expect(body.data.entries.find((e) => e.id === 'kimi-cu')?.capabilityId).toBeUndefined();
  });

  it('maps an unreachable marketplace to 50001', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          throw new Error('network down');
        }
        return realFetch(url as never, init);
      }),
    );
    const { body } = await call('GET', '/api/plugins/marketplace');
    expect(body.code).toBe(50001);
    expect(body.msg).toContain('unreachable');
  });

  it('reads a local marketplace catalog from disk (plain path or file://)', async () => {
    await server?.close();
    const catalogDir = await mkdtemp(join(tmpdir(), 'kimi-local-catalog-'));
    createdDirs.push(catalogDir);
    const fileUrlPluginPath = join(catalogDir, 'plugins', 'file.zip');
    await writeFile(
      join(catalogDir, 'marketplace.json'),
      JSON.stringify({
        plugins: [
          { id: 'local-plugin', source: './zips/local.zip' },
          { id: 'file-url-plugin', source: pathToFileURL(fileUrlPluginPath).href },
        ],
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
      pluginMarketplaceUrl: join(catalogDir, 'marketplace.json'),
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{
      configured: boolean;
      source?: string;
      entries: { id: string; source: string }[];
    }>('GET', '/api/plugins/marketplace');
    expect(body.code).toBe(0);
    expect(body.data.configured).toBe(true);
    expect(body.data.entries).toEqual([
      {
        id: 'local-plugin',
        tier: 'third-party',
        displayName: 'local-plugin',
        source: join(catalogDir, 'zips', 'local.zip'),
      },
      {
        id: 'file-url-plugin',
        tier: 'third-party',
        displayName: 'file-url-plugin',
        source: fileUrlPluginPath,
      },
    ]);
    expect(body.data.source).toBe(join(catalogDir, 'marketplace.json'));
  });

  it('reports an unconfigured marketplace without fetching a remote catalog', async () => {
    await server?.close();
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/')) return realFetch(url as never, init);
      throw new Error(`unexpected fetch: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('KIKI_PLUGIN_MARKETPLACE_URL', undefined as unknown as string);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{ configured: boolean; source?: string; entries: unknown[] }>(
      'GET',
      '/api/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ configured: false, entries: [] });
    expect(fetchMock.mock.calls.some(([url]) => String(url) === CATALOG_URL)).toBe(false);
  });

  it('reads [plugins] marketplace_url from config.toml', async () => {
    await server?.close();
    await writeFile(join(home!, 'config.toml'), `[plugins]\nmarketplace_url = "${CATALOG_URL}"\n`);
    vi.stubEnv('KIKI_PLUGIN_MARKETPLACE_URL', undefined as unknown as string);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{ configured: boolean; source?: string; entries: { id: string }[] }>(
      'GET',
      '/api/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(body.data.configured).toBe(true);
    expect(body.data.source).toBe(CATALOG_URL);
    expect(body.data.entries.map((e) => e.id)).toContain('demo-plugin');
  });

  it('returns plugin info including MCP servers and diagnostics', async () => {
    const source = await makePluginDir('demo-plugin', '1.0.0');
    await install(source);
    const info = await call<{
      id: string;
      mcpServers: unknown[];
      diagnostics: unknown[];
      root: string;
      manifest?: { name: string };
    }>('GET', '/api/plugins/demo-plugin');
    expect(info.body.code).toBe(0);
    expect(info.body.data.id).toBe('demo-plugin');
    expect(info.body.data.mcpServers).toEqual([]);
    expect(Array.isArray(info.body.data.diagnostics)).toBe(true);
    expect(info.body.data.manifest?.name).toBe('demo-plugin');
    const missing = await call('GET', '/api/plugins/nope');
    expect(missing.body.code).toBe(40419);
  });

  it('reports plugin-declared prerequisites without granting compatibility to a spoofed official name', async () => {
    const source = await makePluginDir('kimi-webbridge', '1.11.3');
    await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({ name: 'kimi-webbridge', version: '1.11.3',
      'x-kiki': { prerequisites: { schemaVersion: 1, items: [
        { id: 'browser', kind: 'browser-extension', required: true },
      ] } },
    }));
    await install(source);
    const info = await call<{ prerequisites?: { origin: string; items: { items: { id: string }[] } } }>(
      'GET', '/api/plugins/kimi-webbridge');
    expect(info.body.data.prerequisites).toMatchObject({
      origin: 'plugin-declared', items: { items: [{ id: 'browser' }] },
    });
  });

  it('expands ~ in local catalog paths like the CLI loader', async () => {
    await server?.close();
    const fakeHome = await mkdtemp(join(tmpdir(), 'kimi-tilde-home-'));
    createdDirs.push(fakeHome);
    await writeFile(
      join(fakeHome, 'marketplace.json'),
      JSON.stringify({
        plugins: [
          { id: 'tilde-plugin', source: 'https://example.test/t.zip' },
          { id: 'tilde-entry-plugin', source: '~/plugins/t.zip' },
        ],
      }),
    );
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
      pluginMarketplaceUrl: '~/marketplace.json',
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{ entries: { id: string; source: string }[] }>(
      'GET',
      '/api/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(body.data.entries.map((e) => e.id)).toEqual(['tilde-plugin', 'tilde-entry-plugin']);
    expect(body.data.entries[1]?.source).toBe(join(fakeHome, 'plugins', 't.zip'));
  });
});
