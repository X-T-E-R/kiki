import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginManager } from '#/app/plugin/manager';
import { PluginHost } from '#/app/plugin/host';
import { readInstalled, writeInstalled, type InstalledRecord } from '#/app/plugin/store';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginSettingsService, PluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { StubConfigService } from '../../kosong/stubs';
import { smallPdf } from '../../fixtures/smallPdf';
import { officialPluginFixture } from '../../fixtures/officialPlugins';

describe('PluginManager', () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'plugin-manager-home-'));
    root = await mkdtemp(join(tmpdir(), 'plugin-manager-root-'));
    await mkdir(join(home, 'plugins'), { recursive: true });
    await mkdir(join(root, 'commands'), { recursive: true });
    await writeFile(join(root, 'commands', 'deploy.md'), '---\ndescription: Deploy\n---\n\nBody', 'utf8');
    await writeFile(
      join(root, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        commands: ['./commands'],
        hooks: [{ event: 'Stop', command: 'echo stop' }],
      }),
      'utf8',
    );
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root,
            source: 'local-path',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('loads installed plugins and exposes summaries, hooks, and commands', async () => {
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    expect(manager.summaries()).toEqual([
      expect.objectContaining({
        id: 'demo',
        state: 'ok',
        commandCount: 1,
        hookCount: 1,
      }),
    ]);
    expect(manager.enabledHooks()).toEqual([
      {
        event: 'Stop',
        command: 'echo stop',
        cwd: root,
        env: { KIKI_HOME: home, KIKI_PLUGIN_ROOT: root },
      },
    ]);
    await expect(manager.enabledCommands()).resolves.toEqual([
      expect.objectContaining({ pluginId: 'demo', name: 'deploy', description: 'Deploy' }),
    ]);
  });

  it('installs self-contained Documents and reads artifacts through the real plugin host', async () => {
    const packaged = await officialPluginFixture('kiki-extract', join(root, 'documents-package'));
    const workspace = join(root, 'documents-workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'report.txt'), '# Installed document\nProof value 42.\n');
    const manager = new PluginManager({ kimiHomeDir: home });
    const installed = await manager.install(packaged, { consent: true });
    await manager.setEnabled(installed.id, true);
    const info = manager.get(installed.id)!;
    expect(info.state).toBe('ok');
    expect(info.diagnostics).toEqual([]);
    expect(info.manifest?.skills).toHaveLength(1);
    expect(await stat(join(installed.root, 'runtime/node_modules')).catch(() => undefined)).toBeUndefined();
    const host = new PluginHost(info.id, info.manifest!.kiki!.entry!, info.manifest!.kiki!.tools!);
    const signal = new AbortController().signal;
    const scope = { workspaceRoot: workspace };
    try {
      await rm(packaged, { recursive: true, force: true });
      const text = await host.execute('documents_extract', { file: 'report.txt', outputDir: 'text', previewChars: 5 }, signal, undefined, {}, scope);
      expect(text.isError).not.toBe(true);
      const data = JSON.parse(text.output as string);
      expect(data).toMatchObject({ status: 'succeeded', engine: 'direct', previewTruncated: true, artifactTruncated: false });
      expect(await readFile(data.markdownPath, 'utf8')).toContain('Proof value 42');
      if (process.env['NB_EXTRACT_TEST_PYTHON'] !== undefined) {
        const pdf = smallPdf();
        await writeFile(join(workspace, 'report.pdf'), pdf);
        await writeFile(join(workspace, 'scan.pdf'), smallPdf(null));
        const settings = { pythonPath: process.env['NB_EXTRACT_TEST_PYTHON'] };
        const converted = await host.execute('documents_extract', { file: 'report.pdf', outputDir: 'pdf' }, signal, undefined, settings, scope);
        expect(converted.isError).not.toBe(true);
        const result = JSON.parse(converted.output as string);
        expect(result).toMatchObject({ status: 'succeeded', engine: 'markitdown', assets: [] });
        expect(result.warnings.join(' ')).toContain('no assets');
        expect(result.warnings.join(' ')).toContain('does not perform OCR');
        expect(await readFile(result.markdownPath, 'utf8')).toContain('Readable PDF extraction proof');
        expect(JSON.parse(await readFile(result.metadataPath, 'utf8')).source.value).toBe(join(workspace, 'report.pdf'));
        expect(await readFile(join(workspace, 'report.pdf'))).toEqual(pdf);
        const empty = await host.execute('documents_extract', { file: 'scan.pdf', outputDir: 'scan' }, signal, undefined, settings, scope);
        expect(empty.isError).toBe(true);
        expect(JSON.parse(empty.output as string).code).toBe('EMPTY_CONTENT');
        expect(await stat(join(workspace, 'scan')).catch(() => undefined)).toBeUndefined();
        const proof = process.env['KIKI_DOCUMENTS_PROOF_DIR'];
        if (proof !== undefined) {
          await mkdir(proof, { recursive: true });
          await cp(join(workspace, 'pdf'), join(proof, 'pdf'), { recursive: true });
          await writeFile(join(proof, 'receipt.json'), JSON.stringify({ installedRoot: installed.root, result, empty: JSON.parse(empty.output as string) }, null, 2));
        }
      }
    } finally { await host.stopAndWait(); }
  }, 60_000);

  it('installs a local-path plugin disabled and preserves explicit enablement on reinstall', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'plugin-install-source-'));
    try {
      await writeFile(join(sourceRoot, 'kimi.plugin.json'), JSON.stringify({ name: 'other' }), 'utf8');
      const manager = new PluginManager({ kimiHomeDir: home });

      const record = await manager.install(sourceRoot);

      expect(record.id).toBe('other');
      expect(record.enabled).toBe(false);
      expect(record.root).toContain(join(home, 'plugins', 'managed', 'other'));
      expect(manager.get('other')?.manifest?.name).toBe('other');

      await manager.setEnabled('other', true);
      const reinstalled = await manager.install(sourceRoot);
      expect(reinstalled.enabled).toBe(true);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('installs a zip-url plugin', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'plugin-zip-source-'));
    const zipPath = join(tmpdir(), `plugin-${Date.now()}.zip`);
    const server = createServer((_req, res) => {
      void readFile(zipPath).then((data) => res.end(data));
    });
    try {
      await writeFile(join(sourceRoot, 'kimi.plugin.json'), JSON.stringify({ name: 'zip-plugin' }), 'utf8');
      execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceRoot });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('bad server address');
      const manager = new PluginManager({ kimiHomeDir: home });

      const sha256 = createHash('sha256').update(await readFile(zipPath)).digest('hex');
      const record = await manager.install(`http://127.0.0.1:${address.port}/plugin.zip`, { sha256 });

      expect(record.id).toBe('zip-plugin');
      expect(record.source).toBe('zip-url');
      expect(manager.get('zip-plugin')?.manifest?.name).toBe('zip-plugin');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err === undefined ? resolve() : reject(err))));
      await rm(sourceRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      await rm(zipPath, { force: true });
    }
  });

  it('installs a github plugin through codeload', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'plugin-github-source-'));
    const zipPath = join(tmpdir(), `plugin-github-${Date.now()}.zip`);
    try {
      await writeFile(join(sourceRoot, 'kimi.plugin.json'), JSON.stringify({ name: 'github-plugin' }), 'utf8');
      execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceRoot });
      const zip = await readFile(zipPath);
      const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/commits/v1.atom')) {
          return new Response(
            '<entry><id>tag:github.com,2008:Grit::Commit/1111111111111111111111111111111111111111</id></entry>',
          );
        }
        return new Response(zip);
      });
      vi.stubGlobal('fetch', fetchMock as typeof fetch);
      const manager = new PluginManager({ kimiHomeDir: home });

      const record = await manager.install('https://github.com/owner/repo/tree/v1');

      expect(record.id).toBe('github-plugin');
      expect(record.source).toBe('github');
      expect(record.github).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'v1' },
        installedSha: '1111111111111111111111111111111111111111',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://codeload.github.com/owner/repo/zip/1111111111111111111111111111111111111111',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const stored = JSON.parse(
        await readFile(join(home, 'plugins', 'installed.json'), 'utf8'),
      ) as { plugins: Array<{ id: string; github?: { installedSha?: string } }> };
      expect(stored.plugins.find((plugin) => plugin.id === 'github-plugin')?.github?.installedSha)
        .toBe('1111111111111111111111111111111111111111');
      expect(manager.get('github-plugin')?.manifest?.name).toBe('github-plugin');
    } finally {
      await rm(sourceRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      await rm(zipPath, { force: true });
    }
  });

  it('checks github plugin updates against latest release', async () => {
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root,
            source: 'github',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
            originalSource: 'https://github.com/owner/repo',
            github: { owner: 'owner', repo: 'repo', ref: { kind: 'branch', value: 'v1' } },
          },
        ],
      }),
      'utf8',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 302,
        ok: false,
        headers: new Headers({ location: 'https://github.com/owner/repo/releases/tag/v2' }),
      }),
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.checkUpdates()).resolves.toEqual([
      {
        id: 'demo',
        source: 'github',
        current: { kind: 'branch', value: 'v1' },
        latest: { kind: 'tag', value: 'v2' },
        displayVersion: 'v2',
        updateAvailable: true,
      },
    ]);
  });

  it('reports a pinned branch update only when its commit advances', async () => {
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root,
            source: 'github',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
            originalSource: 'https://github.com/owner/repo/tree/main',
            github: {
              owner: 'owner',
              repo: 'repo',
              ref: { kind: 'branch', value: 'main' },
              installedSha: '1111111111111111111111111111111111111111',
            },
          },
        ],
      }),
      'utf8',
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            '<entry><id>tag:github.com,2008:Grit::Commit/1111111111111111111111111111111111111111</id></entry>',
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            '<entry><id>tag:github.com,2008:Grit::Commit/2222222222222222222222222222222222222222</id></entry>',
          ),
        ),
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.checkUpdates()).resolves.toEqual([
      expect.objectContaining({ id: 'demo', updateAvailable: false }),
    ]);
    await expect(manager.checkUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: 'demo',
        current: { kind: 'branch', value: 'main' },
        latest: { kind: 'branch', value: 'main' },
        updateAvailable: true,
      }),
    ]);
  });

  it('treats legacy commit metadata without originalSource as pinned', async () => {
    const sha = '1111111111111111111111111111111111111111';
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root,
            source: 'github',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
            github: { owner: 'owner', repo: 'repo', ref: { kind: 'sha', value: sha } },
          },
        ],
      }),
      'utf8',
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.checkUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: 'demo',
        latest: { kind: 'sha', value: sha },
        updateAvailable: false,
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps successful update results when another repository lookup fails', async () => {
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: ['good', 'offline'].map((id) => ({
          id,
          root,
          source: 'github',
          enabled: true,
          installedAt: '2026-01-01T00:00:00.000Z',
          github: {
            owner: 'owner',
            repo: id,
            ref: { kind: 'tag', value: 'v1' },
          },
        })),
      }),
      'utf8',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/offline/')) throw new Error('network offline');
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/owner/good/releases/tag/v2' },
        });
      }) as typeof fetch,
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.checkUpdates()).resolves.toEqual([
      expect.objectContaining({ id: 'good', updateAvailable: true }),
    ]);
  });

  it('persists enabled state changes', async () => {
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await manager.setEnabled('demo', false);

    expect(manager.get('demo')?.enabled).toBe(false);
    const stored = JSON.parse(await readFile(join(home, 'plugins', 'installed.json'), 'utf8')) as {
      plugins: Array<{ id: string; enabled: boolean }>;
    };
    expect(stored.plugins).toEqual([expect.objectContaining({ id: 'demo', enabled: false })]);
  });
});


describe('PluginManager renamed installations', () => {
  let scratch: string;
  let home: string;
  const legacyId = 'kiki-documents';
  const id = 'kiki-extract';

  beforeEach(async () => {
    const base = resolve(import.meta.dirname, '../../../../../.tmp');
    await mkdir(base, { recursive: true });
    scratch = await mkdtemp(join(base, 'plugin-rename-'));
    home = join(scratch, 'home');
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function packageAt(directory: string, name: string, version = '1.0.0'): Promise<void> {
    await mkdir(join(directory, 'skills', 'extract'), { recursive: true });
    await mkdir(join(directory, 'agents'), { recursive: true });
    await mkdir(join(directory, 'commands'), { recursive: true });
    await writeFile(join(directory, 'skills', 'extract', 'SKILL.md'), '---\nname: extract\ndescription: Extract a document\n---\nRead the document.');
    await writeFile(join(directory, 'commands', 'extract.md'), '---\ndescription: Extract\n---\nRead the document.');
    await writeFile(join(directory, 'entry.mjs'), `export function register(api) { api.registerTool({ schemaVersion: 1, name: 'extract', description: 'Extract' }, async (_args, ctx) => ({ output: JSON.stringify({ version: '${version}', pythonPath: ctx.settings.pythonPath }) })); }`);
    await writeFile(join(directory, 'kimi.plugin.json'), JSON.stringify({
      name, version, skills: ['./skills'], agents: ['./agents'], commands: ['./commands'],
      mcpServers: { parser: { command: 'fixture-parser' } },
      'x-kiki': { engines: { kiki: '^0.4.0' }, entry: './entry.mjs',
        tools: [{ schemaVersion: 1, name: 'extract', description: 'Extract' }],
        settings: { schemaVersion: 1, schema: { type: 'object', properties: { pythonPath: { type: 'string' } } } } },
    }));
  }

  function entry(root: string, entryId = legacyId, enabled = true): InstalledRecord {
    return { id: entryId, root, source: 'local-path', originalSource: join(scratch, 'original-source'), enabled,
      installedAt: '2026-01-01T00:00:00.000Z', capabilities: { mcpServers: { parser: { enabled: false } } } };
  }

  it('migrates legacy paths before discovering capabilities and preserves settings through upgrade and rollback', async () => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    const current = join(home, 'plugins', 'managed', id);
    await packageAt(legacy, legacyId);
    await mkdir(join(home, 'plugins', 'data', legacyId), { recursive: true });
    await writeFile(join(home, 'plugins', 'data', legacyId, 'user.txt'), 'user-owned data');
    await writeInstalled(home, { version: 1, plugins: [entry(legacy)] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = manager.get(id)!;
    expect(record).toMatchObject({ root: current, enabled: true, state: 'ok', skillCount: 1 });
    expect(record.manifestPath).toBe(join(current, 'kimi.plugin.json'));
    expect(manager.pluginSkillRoots()[0]?.path).toBe(join(current, 'skills'));
    expect(manager.pluginAgentRoots()[0]?.path).toBe(join(current, 'agents'));
    expect((await manager.enabledCommands())[0]?.path).toBe(join(current, 'commands', 'extract.md'));
    expect(record.manifest?.kiki?.entry).toBe(join(current, 'entry.mjs'));
    expect(manager.enabledMcpServers()).toEqual({});
    expect(await readFile(join(home, 'plugins', 'data', legacyId, 'user.txt'), 'utf8')).toBe('user-owned data');
    expect((await readInstalled(home)).plugins).toEqual([expect.objectContaining({ id, root: current, enabled: true, capabilities: record.capabilities })]);
    const ix = new TestInstantiationService();
    ix.stub(IConfigService, new StubConfigService({ pluginSettings: { [legacyId]: { pythonPath: 'fixture-python' } } }));
    ix.stub(IPluginService, { getPluginInfo: async ({ id: pluginId }: { id: string }) => manager.info(pluginId) } as unknown as IPluginService);
    ix.set(IPluginSettingsService, new SyncDescriptor(PluginSettingsService));
    async function execute(expectedVersion: string) {
      const info = manager.get(id)!;
      const host = new PluginHost(id, info.manifest!.kiki!.entry!, info.manifest!.kiki!.tools!);
      try {
        const settings = await ix.get(IPluginSettingsService).forExecution(id);
        expect(settings).toEqual({ pythonPath: 'fixture-python' });
        const result = await host.execute('extract', {}, new AbortController().signal, undefined, settings);
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.output as string)).toEqual({ version: expectedVersion, pythonPath: 'fixture-python' });
      } finally { await host.stopAndWait(); }
    }
    try {
      await execute('1.0.0');
      const source = join(scratch, 'new-source');
      await packageAt(source, id, '2.0.0');
      const installed = await manager.install(source);
      expect(installed).toMatchObject({ enabled: true, installedAt: record.installedAt, capabilities: record.capabilities, rollback: { version: '1.0.0' } });
      await execute('2.0.0');
      await manager.rollback(id);
      await execute('1.0.0');
      await manager.load();
      await manager.reload();
      expect(manager.list()).toHaveLength(1);
      expect(manager.get(id)).toMatchObject({ enabled: true, state: 'ok', skillCount: 1 });
      expect(await readFile(join(home, 'plugins', 'data', legacyId, 'user.txt'), 'utf8')).toBe('user-owned data');
      expect(await readFile(join(source, 'kimi.plugin.json'), 'utf8')).toContain('2.0.0');
    } finally { ix.dispose(); }
  });

  it('keeps installed prerequisite absolute paths usable through load, execution, upgrade and rollback', async () => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    const data = join(home, 'plugins', 'data', legacyId);
    const component = join(data, `parser-1.0.0${process.platform === 'win32' ? '.exe' : ''}`);
    const config = new StubConfigService({ pluginSettings: { [legacyId]: { pythonPath: component } } });
    await mkdir(data, { recursive: true });
    await writeFile(component, 'installed-component');
    await packageAt(legacy, legacyId);
    const code = `import { readFile } from 'node:fs/promises'; export function register(api) { api.registerTool({ schemaVersion: 1, name: 'extract', description: 'Extract' }, async (_args, ctx) => ({ output: await readFile(ctx.settings.pythonPath, 'utf8') })); }`;
    await writeFile(join(legacy, 'entry.mjs'), code);
    await writeInstalled(home, { version: 1, plugins: [entry(legacy)] });
    const manager = new PluginManager({ kimiHomeDir: home });
    const ix = new TestInstantiationService();
    ix.stub(IConfigService, config);
    ix.stub(IPluginService, { getPluginInfo: async ({ id: pluginId }: { id: string }) => manager.info(pluginId) } as unknown as IPluginService);
    ix.set(IPluginSettingsService, new SyncDescriptor(PluginSettingsService));
    async function execute() {
      const settings = await ix.get(IPluginSettingsService).forExecution(id);
      expect(settings).toEqual({ pythonPath: component });
      const info = manager.get(id)!;
      const host = new PluginHost(id, info.manifest!.kiki!.entry!, info.manifest!.kiki!.tools!);
      try {
        const result = await host.execute('extract', {}, new AbortController().signal, undefined, settings);
        expect(result.isError).not.toBe(true);
        expect(result.output).toBe('installed-component');
        expect(await readFile(settings['pythonPath'] as string, 'utf8')).toBe('installed-component');
      } finally { await host.stopAndWait(); }
    }
    try {
      await manager.load();
      await execute();
      const currentData = join(home, 'plugins', 'data', id);
      await mkdir(currentData);
      await writeFile(join(currentData, 'new-component'), 'new-installed-component');
      await manager.reload();
      await execute();
      await ix.get(IPluginSettingsService).update({ pluginId: id, values: { pythonPath: component } });
      expect(config.get('pluginSettings')).toEqual({ [id]: { pythonPath: component } });
      const source = join(scratch, 'new-component-source');
      await packageAt(source, id, '2.0.0');
      await writeFile(join(source, 'entry.mjs'), code);
      await manager.install(source);
      await execute();
      await manager.rollback(id);
      await execute();
      await manager.load();
      await execute();
    } finally { ix.dispose(); }
  });

  it.each([false, true])('only deletes both renamed data locations when explicitly requested (%s)', async (deleteData) => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    await packageAt(legacy, legacyId);
    await writeInstalled(home, { version: 1, plugins: [entry(legacy)] });
    for (const pluginId of [legacyId, id, 'other-plugin']) {
      const data = join(home, 'plugins', 'data', pluginId);
      await mkdir(data, { recursive: true });
      await writeFile(join(data, 'component'), pluginId);
    }
    const external = join(scratch, 'external-component');
    await writeFile(external, 'external');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.remove(id, deleteData);
    for (const pluginId of [legacyId, id]) {
      const component = join(home, 'plugins', 'data', pluginId, 'component');
      if (deleteData) await expect(stat(component)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(component, 'utf8')).toBe(pluginId);
    }
    expect(await readFile(join(home, 'plugins', 'data', 'other-plugin', 'component'), 'utf8')).toBe('other-plugin');
    expect(await readFile(external, 'utf8')).toBe('external');
  });

  it('recovers a moved managed root after migration persistence fails', async () => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    const current = join(home, 'plugins', 'managed', id);
    await packageAt(legacy, legacyId);
    await writeInstalled(home, { version: 1, plugins: [entry(legacy)] });
    const blocked = join(home, 'plugins', 'installed.json.tmp');
    await mkdir(blocked);
    const failed = new PluginManager({ kimiHomeDir: home });
    await expect(failed.load()).rejects.toThrow();
    expect(failed.list()).toEqual([]);
    await rm(blocked, { recursive: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    expect(manager.get(id)).toMatchObject({ root: current, manifestPath: join(current, 'kimi.plugin.json'), state: 'ok', skillCount: 1 });
    expect((await readInstalled(home)).plugins).toEqual([expect.objectContaining({ id, root: current })]);
  });

  it('migrates a legacy record introduced during reload without publishing stale paths', async () => {
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const legacy = join(home, 'plugins', 'managed', legacyId);
    await packageAt(legacy, legacyId);
    await writeInstalled(home, { version: 1, plugins: [entry(legacy)] });
    expect(await manager.reload()).toEqual({ added: [id], removed: [], errors: [] });
    expect(manager.pluginSkillRoots()[0]?.path).toBe(join(home, 'plugins', 'managed', id, 'skills'));
    expect((await readInstalled(home)).plugins[0]?.id).toBe(id);
  });

  it('keeps managed-directory collisions separate and refuses to overwrite an unrecorded current copy', async () => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    const current = join(home, 'plugins', 'managed', id);
    await packageAt(legacy, legacyId);
    await packageAt(current, id, '9.0.0');
    await writeInstalled(home, { version: 1, plugins: [entry(legacy)] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    expect(manager.get(id)).toMatchObject({ root: legacy, state: 'ok', manifest: { version: '1.0.0' } });
    await expect(manager.install(legacy)).rejects.toThrow(/directory.*exists/i);
    expect(await readFile(join(current, 'kimi.plugin.json'), 'utf8')).toContain('9.0.0');
    expect(await readFile(join(legacy, 'kimi.plugin.json'), 'utf8')).toContain('1.0.0');
  });

  it('does not swap an unrelated current rollback copy into a migrated legacy install', async () => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    const oldRollback = join(home, 'plugins', 'rollback', legacyId);
    const newRollback = join(home, 'plugins', 'rollback', id);
    await packageAt(legacy, legacyId, '2.0.0');
    await packageAt(oldRollback, legacyId);
    await packageAt(newRollback, id, '9.0.0');
    await writeInstalled(home, { version: 1, plugins: [{ ...entry(legacy), rollback: { version: '1.0.0', source: 'local-path' } }] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await expect(manager.rollback(id)).rejects.toThrow('mismatched plugin version');
    expect(manager.get(id)?.manifest?.version).toBe('2.0.0');
    expect(await readFile(join(oldRollback, 'kimi.plugin.json'), 'utf8')).toContain('1.0.0');
    expect(await readFile(join(newRollback, 'kimi.plugin.json'), 'utf8')).toContain('9.0.0');
  });

  it('carries an existing legacy rollback copy into the current lifecycle', async () => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    await packageAt(legacy, legacyId, '2.0.0');
    await packageAt(join(home, 'plugins', 'rollback', legacyId), legacyId);
    await writeInstalled(home, { version: 1, plugins: [{ ...entry(legacy), rollback: { version: '1.0.0', source: 'local-path' } }] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await expect(manager.rollback(id)).resolves.toMatchObject({ manifest: { version: '1.0.0' }, enabled: true });
    expect(manager.pluginSkillRoots()[0]?.path).toBe(join(home, 'plugins', 'managed', id, 'skills'));
  });

  it.each([false, true])('keeps the current install when both ids are recorded regardless of order (%s)', async (legacyFirst) => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    const current = join(home, 'plugins', 'managed', id);
    await packageAt(legacy, legacyId);
    await packageAt(current, id, '3.0.0');
    const entries = [entry(current, id, false), entry(legacy)];
    await writeInstalled(home, { version: 1, plugins: legacyFirst ? entries.toReversed() : entries });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    expect(manager.list()).toHaveLength(1);
    expect(manager.get(id)).toMatchObject({ root: current, enabled: false, manifest: { name: id, version: '3.0.0' } });
    expect(await readFile(join(legacy, 'kimi.plugin.json'), 'utf8')).toContain(legacyId);
    await manager.reload();
    expect(manager.get(id)).toMatchObject({ root: current, enabled: false, manifest: { version: '3.0.0' } });
  });

  it('preserves an external local root instead of adopting an unrelated managed directory', async () => {
    const source = join(scratch, 'local-source');
    const unrelated = join(home, 'plugins', 'managed', id);
    await packageAt(source, legacyId);
    await packageAt(unrelated, id, '9.0.0');
    await writeInstalled(home, { version: 1, plugins: [entry(source)] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    expect(manager.get(id)).toMatchObject({ root: source, manifest: { name: legacyId, version: '1.0.0' } });
    await expect(manager.install(source)).rejects.toThrow(/directory.*exists/i);
    expect(await readFile(join(unrelated, 'kimi.plugin.json'), 'utf8')).toContain('9.0.0');
    expect(await readFile(join(source, 'kimi.plugin.json'), 'utf8')).toContain(legacyId);
  });

  it('preserves both data directories on collision without overwriting current user files', async () => {
    const legacy = join(home, 'plugins', 'managed', legacyId);
    await packageAt(legacy, legacyId);
    for (const pluginId of [legacyId, id]) {
      await mkdir(join(home, 'plugins', 'data', pluginId), { recursive: true });
      await writeFile(join(home, 'plugins', 'data', pluginId, 'user.txt'), pluginId);
    }
    await writeInstalled(home, { version: 1, plugins: [entry(legacy)] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    for (const pluginId of [legacyId, id]) {
      expect(await readFile(join(home, 'plugins', 'data', pluginId, 'user.txt'), 'utf8')).toBe(pluginId);
    }
  });

  it('loads and reloads an inherited legacy install without moving or persisting base-home files', async () => {
    const base = join(scratch, 'base-home');
    const legacy = join(base, 'plugins', 'managed', legacyId);
    await packageAt(legacy, legacyId);
    await writeInstalled(base, { version: 1, plugins: [entry(legacy)] });
    const before = await readFile(join(base, 'plugins', 'installed.json'), 'utf8');
    const manager = new PluginManager({ kimiHomeDir: home, inheritedHomeDir: base });
    await manager.load();
    expect(manager.get(id)).toMatchObject({ root: legacy, enabled: true, inherited: true, skillCount: 1 });
    await expect(manager.setEnabled(id, false)).rejects.toMatchObject({ code: 'plugin.read_only' });
    await manager.reload();
    expect(manager.pluginSkillRoots()[0]?.path).toBe(join(legacy, 'skills'));
    expect(await readFile(join(base, 'plugins', 'installed.json'), 'utf8')).toBe(before);
    expect((await readInstalled(home)).plugins).toEqual([]);
  });
});
