import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KIMI_CODE_PROVIDER_NAME } from '@kiki/oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
  type ScopeSeed,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { readBundledPluginCatalog, readDefaultPluginCatalog } from '#/app/plugin/defaultCatalog';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService, type PluginUsageSnapshot } from '#/app/pluginUsage/pluginUsage';
import { PluginService } from '#/app/plugin/pluginService';
import * as pluginStore from '#/app/plugin/store';
import type { InstalledFile } from '#/app/plugin/store';
import type { PluginMutationSummary, ReloadSummary } from '#/app/plugin/types';
import { LifecycleScope } from '#/app/scopes';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';
import { fixedPublishedArchive } from '../../fixtures/officialPlugins';

vi.mock('#/app/plugin/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/app/plugin/store')>();
  return {
    ...actual,
    readInstalled: vi.fn(actual.readInstalled),
    writeInstalled: vi.fn(actual.writeInstalled),
  };
});

const readInstalled = vi.mocked(pluginStore.readInstalled);
const writeInstalled = vi.mocked(pluginStore.writeInstalled);

async function installWithConsent(service: IPluginService, source: string, sha256?: string): Promise<void> {
  const plan = await service.previewPlugin({ source, sha256 });
  await service.installPlugin({ source, sha256, fingerprint: plan.fingerprint, consent: true });
}

function makeHost(
  homeDir: string,
  providers = stubProviderService(),
  env: NodeJS.ProcessEnv = {},
  usage: IPluginUsageService = workspaceUsage('__never__', false),
): ScopedTestHost {
  const stubs: ScopeSeed = [
    stubPair(IBootstrapService, stubBootstrap(homeDir, env)),
    stubPair(IProviderService, providers),
    stubPair(IConfigService, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => ({}),
      replace: async () => {},
    } as unknown as IConfigService),
    stubPair(ISkillDiscovery, {
      _serviceBrand: undefined,
      discover: async () => ({
        skills: [],
        skipped: [],
        scannedRoots: [],
        scannedDirectories: [],
      }),
    } satisfies ISkillDiscovery),
    stubPair(IPluginUsageService, usage),
  ];
  return createScopedTestHost(stubs);
}

function workspaceUsage(blockedPluginId: string, enabled = true): IPluginUsageService {
  const snapshot = (workspaceId: string, sessionId?: string): PluginUsageSnapshot => ({
    workspaceId,
    sessionId,
    revision: 0,
    overrides: {},
    applyState: 'applied',
    errors: [],
  });
  type PluginStateReader = Parameters<IPluginUsageService['registerPluginStateReader']>[0];
  let stateReader: PluginStateReader | undefined;
  return {
    _serviceBrand: undefined,
    enabled: () => enabled,
    read: async (workspaceId) => snapshot(workspaceId),
    registerPluginStateReader: (reader) => {
      stateReader = reader;
      return {
        dispose: () => {
          if (stateReader === reader) stateReader = undefined;
        },
      };
    },
    allows: async (workspaceId, pluginId, sessionId) => {
      const state = stateReader?.(pluginId);
      if (state?.allowed === false) return false;
      const global = state?.globalEnabled ?? true;
      if (!enabled || workspaceId === undefined) return global;
      const workspace = workspaceId !== 'workspace-a' || pluginId !== blockedPluginId;
      if (!workspace) return false;
      return sessionId === undefined ? global : snapshot(workspaceId, sessionId).overrides[pluginId] ?? global;
    },
    readSession: async (workspaceId, sessionId) => snapshot(workspaceId, sessionId),
    applySession: async (value) => value,
    set: async ({ workspaceId }) => snapshot(workspaceId),
    onDidChange: Event.None as IPluginUsageService['onDidChange'],
    onDidApply: Event.None as IPluginUsageService['onDidApply'],
  };
}

async function writeInstalledFile(homeDir: string, contents: string): Promise<void> {
  await mkdir(path.join(homeDir, 'plugins'), { recursive: true });
  await writeFile(path.join(homeDir, 'plugins', 'installed.json'), contents, 'utf8');
}

async function writeValidInstalledFile(homeDir: string): Promise<void> {
  await writeInstalledFile(homeDir, JSON.stringify({ version: 1, plugins: [] }));
}

function installedFile(id: string, root: string, enabled = true): InstalledFile {
  return {
    version: 1,
    plugins: [
      {
        id,
        root,
        source: 'local-path',
        enabled,
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        originalSource: root,
      },
    ],
  };
}

function githubInstalledFile(id: string, root: string): InstalledFile {
  const local = installedFile(id, root).plugins[0]!;
  return {
    version: 1,
    plugins: [
      {
        ...local,
        source: 'github',
        originalSource: `https://github.com/example/${id}`,
        github: {
          owner: 'example',
          repo: id,
          ref: { kind: 'tag', value: 'v1.0.0' },
        },
      },
    ],
  };
}

async function persistedPluginIds(homeDir: string): Promise<readonly string[]> {
  const contents = await readFile(path.join(homeDir, 'plugins', 'installed.json'), 'utf8');
  return (JSON.parse(contents) as InstalledFile).plugins.map((plugin) => plugin.id);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function makePluginDir(name: string, manifest: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-${name}-`));
  await writeFile(
    path.join(root, 'kimi.plugin.json'),
    JSON.stringify({ name, ...manifest }),
    'utf8',
  );
  return realpath(root);
}

describe('PluginService (plugin boundary)', () => {
  const createdDirs: string[] = [];

  async function makeHome(): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    createdDirs.push(home);
    return home;
  }

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IPluginService,
      PluginService,
      ScopeActivation.OnDemand,
      'plugin',
    );
    readInstalled.mockClear();
    writeInstalled.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('installs every bundled official entry from fixed published ZIP responses through IPluginService', async () => {
    const scratchRoot = path.resolve(import.meta.dirname, '../../../../../.tmp');
    await mkdir(scratchRoot, { recursive: true });
    const home = await mkdtemp(path.join(scratchRoot, 'official-plugin-service-'));
    createdDirs.push(home);
    const { marketplace } = await readDefaultPluginCatalog({ fetchImpl: async () => { throw new Error('Catalog offline'); } });
    const installable = marketplace.plugins.filter((entry) => entry.tier === 'official' && entry.source !== '');
    expect(installable.length).toBe(marketplace.plugins.filter((entry) => entry.tier === 'official').length);
    const archives = new Map(await Promise.all(installable.map(async (entry) => {
      expect(entry.source).toMatch(/^https:\/\/.+\.zip$/);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      return [entry.source, await fixedPublishedArchive(entry.source, entry.sha256!)] as const;
    })));
    const fetchArchive: typeof fetch = async (input) => {
      const source = input instanceof Request ? input.url : input.toString();
      const bytes = archives.get(source);
      if (bytes === undefined) throw new Error(`Unexpected plugin fixture URL: ${source}`);
      return new Response(new Uint8Array(bytes), { status: 200 });
    };
    await expect(fetchArchive('https://example.test/unexpected.zip')).rejects.toThrow('Unexpected plugin fixture URL');
    vi.stubGlobal('fetch', vi.fn(fetchArchive));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.previewPlugin({ source: installable[0]!.source, sha256: '0'.repeat(64) })).rejects.toThrow('Plugin ZIP sha256 mismatch');
      expect(await svc.listPlugins()).toEqual([]);
      for (const entry of installable) {
        await installWithConsent(svc, entry.source, entry.sha256);
        const info = await svc.getPluginInfo({ id: entry.id });
        expect(info, entry.id).toMatchObject({ id: entry.id, version: entry.version, state: 'ok', enabled: true, globalEnabled: false, zipSha256: entry.sha256 });
        expect(info.root).toBe(path.join(home, 'plugins/managed', entry.id));
        expect(info.root).not.toBe(entry.source);
        if (entry.id.startsWith('kiki-')) expect(await readFile(path.join(info.root, 'LICENSE'), 'utf8')).not.toBe('');
      }
      expect((await svc.listPlugins()).map((plugin) => plugin.id).toSorted())
        .toEqual(installable.map((entry) => entry.id).toSorted());
      const office = await svc.getPluginInfo({ id: 'kiki-office' });
      expect(await readFile(path.join(office.root, 'entry.mjs'), 'utf8')).toContain('export');
      expect(vi.mocked(fetch)).toHaveBeenCalled();
      for (const [input] of vi.mocked(fetch).mock.calls) {
        expect(archives.has(input instanceof Request ? input.url : input.toString())).toBe(true);
      }
    } finally {
      await host.dispose();
    }
  }, 30_000);

  it('installs a bundled official ZIP when the caller omits sha256 and rejects an unknown ZIP', async () => {
    const entry = readBundledPluginCatalog().marketplace.plugins.find((item) => item.id === 'kiki-cloudflare');
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const bytes = await fixedPublishedArchive(entry!.source, entry!.sha256!);
    const fetchArchive = vi.fn(async (input: string | URL | Request) => {
      const source = input instanceof Request ? input.url : String(input);
      if (source !== entry!.source) throw new Error(`Unexpected plugin fixture URL: ${source}`);
      return new Response(new Uint8Array(bytes), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchArchive);
    const home = await makeHome();
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const plan = await svc.previewPlugin({ source: entry!.source });
      expect(plan).toMatchObject({ id: 'kiki-cloudflare', consentRequired: true });
      await svc.installPlugin({ source: entry!.source, fingerprint: plan.fingerprint, consent: true });
      expect(await svc.getPluginInfo({ id: 'kiki-cloudflare' })).toMatchObject({
        id: 'kiki-cloudflare',
        version: entry!.version,
        state: 'ok',
        zipSha256: entry!.sha256,
      });
      await expect(svc.previewPlugin({ source: 'https://downloads.example.test/unknown.zip' })).rejects.toThrow(
        'ZIP plugins require a sha256 checksum',
      );
      await expect(svc.previewPlugin({ source: entry!.source, sha256: '0'.repeat(64) })).rejects.toThrow(
        'Plugin ZIP sha256 mismatch',
      );
      expect(fetchArchive.mock.calls.map(([input]) => input instanceof Request ? input.url : String(input)))
        .not.toContain('https://downloads.example.test/unknown.zip');
    } finally {
      await host.dispose();
    }
  }, 30_000);

  it('degrades non-blocking consumption reads but rejects hook reads when installed.json is corrupt', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.pluginSkillRoots()).resolves.toEqual([]);
      await expect(svc.enabledSessionStarts()).resolves.toEqual([]);
      await expect(svc.enabledSystemPrompts()).resolves.toEqual([]);
      await expect(svc.enabledHooks()).rejects.toMatchObject({ code: 'plugin.load_failed' });
    } finally {
      await host.dispose();
    }
  });

  it('rejects hook reads when an enabled plugin has an invalid matcher', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('invalid-hook', {
      hooks: [{ event: 'PreToolUse', matcher: '[invalid', command: 'echo blocked' }],
    });
    createdDirs.push(pluginRoot);
    await writeInstalledFile(home, JSON.stringify(installedFile('invalid-hook', pluginRoot)));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.enabledHooks()).rejects.toMatchObject({ code: 'plugin.load_failed' });
    } finally {
      await host.dispose();
    }
  });

  it('resolves empty plugin MCP servers instead of failing when installed.json is corrupt', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.enabledMcpServers()).resolves.toEqual({});
      const failure = await svc.mcpServerEntries().catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'plugin.load_failed' });
    } finally {
      await host.dispose();
    }
  });

  it('throws plugin.load_failed with a repair hint on management-plane calls when installed.json is corrupt', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const failure = await svc.listPlugins().catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'plugin.load_failed' });
      expect((failure as Error).message).toContain('installed.json');
      expect((failure as Error).message).toContain('/plugins reload');
    } finally {
      await host.dispose();
    }
  });

  it('keeps the first load failure latched after the file is fixed', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.pluginSkillRoots()).resolves.toEqual([]);

      const pluginRoot = await makePluginDir('recovery-demo', {});
      createdDirs.push(pluginRoot);
      await writeInstalledFile(home, JSON.stringify(installedFile('recovery-demo', pluginRoot)));

      await expect(svc.listPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });
      await expect(svc.pluginSkillRoots()).resolves.toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('recovers the management plane through an explicit reload after the file is fixed', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });

      const pluginRoot = await makePluginDir('recovery-demo', {});
      createdDirs.push(pluginRoot);
      await writeInstalledFile(home, JSON.stringify(installedFile('recovery-demo', pluginRoot)));
      const reloads: ReloadSummary[] = [];
      svc.onDidReload(({ added, removed, errors }) => reloads.push({ added, removed, errors }));

      await expect(svc.reloadPlugins()).resolves.toEqual({
        added: ['recovery-demo'],
        removed: [],
        errors: [],
      });
      await expect(svc.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'recovery-demo' }),
      ]);
      expect(reloads).toEqual([{ added: ['recovery-demo'], removed: [], errors: [] }]);
    } finally {
      await host.dispose();
    }
  });

  it('fires onDidReload after install / enable / disable / remove so workspace consumers refresh immediately', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const pluginRoot = await makePluginDir('notify-demo', { description: 'demo plugin' });
    createdDirs.push(pluginRoot);
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const reloads: ReloadSummary[] = [];
      svc.onDidReload((summary) => reloads.push(summary));

      await installWithConsent(svc, pluginRoot);
      await svc.setPluginEnabled({ id: 'notify-demo', enabled: false });
      await svc.setPluginEnabled({ id: 'notify-demo', enabled: true });
      await svc.removePlugin({ id: 'notify-demo' });

      expect(reloads).toHaveLength(4);
      await expect(svc.listPlugins()).resolves.toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('fires onDidMutate after install / enable / disable / remove but not on an explicit reloadPlugins', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const pluginRoot = await makePluginDir('mutate-demo', { description: 'demo plugin' });
    createdDirs.push(pluginRoot);
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const mutations: PluginMutationSummary[] = [];
      svc.onDidMutate((summary) => mutations.push(summary));

      await installWithConsent(svc, pluginRoot);
      await svc.setPluginEnabled({ id: 'mutate-demo', enabled: false });
      await svc.setPluginEnabled({ id: 'mutate-demo', enabled: true });
      await svc.removePlugin({ id: 'mutate-demo' });
      expect(mutations).toHaveLength(4);
      expect(mutations.map((summary) => summary.mutation)).toEqual([
        { kind: 'install', id: 'mutate-demo' },
        { kind: 'disable', id: 'mutate-demo' },
        { kind: 'enable', id: 'mutate-demo' },
        { kind: 'remove', id: 'mutate-demo' },
      ]);

      await svc.reloadPlugins();
      expect(mutations).toHaveLength(4);
    } finally {
      await host.dispose();
    }
  });

  it('resolves a mutation only after reload listeners settle their waitUntil work', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('barrier-demo', {});
    createdDirs.push(pluginRoot);
    await writeInstalledFile(home, JSON.stringify(installedFile('barrier-demo', pluginRoot)));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).resolves.toHaveLength(1);

      const listenerCalled = deferred<void>();
      const reconcileGate = deferred<void>();
      let reconciled = false;
      svc.onDidReload((event) => {
        listenerCalled.resolve(undefined);
        event.waitUntil(
          reconcileGate.promise.then(() => {
            reconciled = true;
          }),
        );
      });

      const mutation = svc.setPluginEnabled({ id: 'barrier-demo', enabled: false });
      let mutationSettled = false;
      void mutation.then(() => {
        mutationSettled = true;
      });
      await listenerCalled.promise;
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(mutationSettled).toBe(false);

      reconcileGate.resolve(undefined);
      await mutation;
      expect(reconciled).toBe(true);
      await expect(svc.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'barrier-demo', enabled: false }),
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('does not reject a mutation when a reload listener waitUntil promise rejects', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('tolerant-demo', {});
    createdDirs.push(pluginRoot);
    await writeInstalledFile(home, JSON.stringify(installedFile('tolerant-demo', pluginRoot)));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).resolves.toHaveLength(1);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      svc.onDidReload((event) => {
        event.waitUntil(Promise.reject(new Error('workspace reconcile failed')));
      });

      await expect(
        svc.setPluginEnabled({ id: 'tolerant-demo', enabled: false }),
      ).resolves.toBeUndefined();
      await expect(svc.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'tolerant-demo', enabled: false }),
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('serves enabled plugin system-prompt sections on the consumption plane', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('prompt-demo', { systemPrompt: 'Always cite sources.' });
    createdDirs.push(pluginRoot);
    await writeInstalledFile(home, JSON.stringify(installedFile('prompt-demo', pluginRoot)));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.enabledSystemPrompts()).resolves.toEqual([
        { pluginId: 'prompt-demo', content: 'Always cite sources.' },
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('filters every workspace-scoped consumption surface without reviving home-disabled plugins', async () => {
    const home = await makeHome();
    const makeAllSurfacePlugin = async (id: string, hooks: unknown): Promise<string> => {
      const root = await makePluginDir(id, {
        skills: './skills/',
        agents: './agents/',
        sessionStart: { skill: `${id}-skill` },
        systemPrompt: `${id} prompt`,
        mcpServers: { api: { command: `${id}-mcp` } },
        commands: './commands',
        hooks,
      });
      await mkdir(path.join(root, 'skills', `${id}-skill`), { recursive: true });
      await writeFile(
        path.join(root, 'skills', `${id}-skill`, 'SKILL.md'),
        `---\nname: ${id}-skill\ndescription: ${id} skill\n---\nbody`,
        'utf8',
      );
      await mkdir(path.join(root, 'agents'), { recursive: true });
      await writeFile(
        path.join(root, 'agents', `${id}-agent.md`),
        `---\nname: ${id}-agent\ndescription: ${id} agent\n---\nbody`,
        'utf8',
      );
      await mkdir(path.join(root, 'commands'), { recursive: true });
      await writeFile(
        path.join(root, 'commands', `${id}.md`),
        `---\nname: ${id}-command\ndescription: ${id} command\n---\nrun`,
        'utf8',
      );
      return root;
    };
    const rootA = await makeAllSurfacePlugin('plugin-a', [
      { event: 'PreToolUse', command: 'echo plugin-a' },
    ]);
    const rootB = await makeAllSurfacePlugin('plugin-b', {
      schemaVersion: 2,
      enabled: true,
      disabled: [],
      files: [],
      rules: [{ id: 'rule-b', event: 'prompt.submit', action: { type: 'inject', text: 'plugin-b rule' } }],
      legacy: [{ event: 'PreToolUse', command: 'echo plugin-b' }],
    });
    const rootSkillsOnly = await makePluginDir('skills-only', { skills: './skills/' });
    await mkdir(path.join(rootSkillsOnly, 'skills', 'only-skill'), { recursive: true });
    await writeFile(
      path.join(rootSkillsOnly, 'skills', 'only-skill', 'SKILL.md'),
      '---\nname: only-skill\ndescription: only skill\n---\nbody',
      'utf8',
    );
    createdDirs.push(rootA, rootB, rootSkillsOnly);
    await writeValidInstalledFile(home);
    const host = makeHost(home, stubProviderService(), {}, workspaceUsage('plugin-a'));
    try {
      const svc = host.app.accessor.get(IPluginService);
      await installWithConsent(svc, rootA);
      await installWithConsent(svc, rootB);
      await installWithConsent(svc, rootSkillsOnly);
      await svc.setPluginEnabled({ id: 'plugin-a', enabled: true });
      await svc.setPluginEnabled({ id: 'plugin-b', enabled: true });
      await svc.setPluginEnabled({ id: 'skills-only', enabled: true });

      const workspaceA = {
        commands: await svc.listPluginCommands('workspace-a'),
        skills: await svc.pluginSkillRoots('workspace-a'),
        agents: await svc.pluginAgentRoots('workspace-a'),
        starts: await svc.enabledSessionStarts('workspace-a'),
        prompts: await svc.enabledSystemPrompts('workspace-a'),
        mcp: await svc.enabledMcpServers('workspace-a'),
        hooks: await svc.enabledHooks('workspace-a'),
        rules: await svc.enabledHookRules('workspace-a'),
      };
      expect(workspaceA.commands.map((entry) => entry.pluginId)).toEqual(['plugin-b']);
      expect(workspaceA.skills.map((entry) => entry.plugin?.id).toSorted()).toEqual(['plugin-b', 'skills-only']);
      expect(workspaceA.agents.every((entry) => entry.path.includes('plugin-b'))).toBe(true);
      expect(workspaceA.agents).toHaveLength(1);
      expect(workspaceA.starts).toEqual([{ pluginId: 'plugin-b', skillName: 'plugin-b-skill' }]);
      expect(workspaceA.prompts).toEqual([{ pluginId: 'plugin-b', content: 'plugin-b prompt' }]);
      expect(Object.keys(workspaceA.mcp)).toEqual(['plugin-plugin-b:api']);
      expect(workspaceA.hooks).toEqual([
        expect.objectContaining({ command: 'echo plugin-b' }),
      ]);
      expect(workspaceA.rules).toEqual([
        expect.objectContaining({ namespace: 'plugin/plugin-b' }),
      ]);

      await svc.reloadPlugins();
      expect((await svc.pluginSkillRoots('workspace-a')).map((entry) => entry.plugin?.id)).not.toContain('plugin-a');
      expect(Object.keys(await svc.enabledMcpServers('workspace-a'))).not.toContain('plugin-plugin-a:api');

      const workspaceB = {
        commands: await svc.listPluginCommands('workspace-b'),
        skills: await svc.pluginSkillRoots('workspace-b'),
        agents: await svc.pluginAgentRoots('workspace-b'),
        starts: await svc.enabledSessionStarts('workspace-b'),
        prompts: await svc.enabledSystemPrompts('workspace-b'),
        mcp: await svc.enabledMcpServers('workspace-b'),
        hooks: await svc.enabledHooks('workspace-b'),
        rules: await svc.enabledHookRules('workspace-b'),
      };
      expect(workspaceB.commands.map((entry) => entry.pluginId).toSorted()).toEqual(['plugin-a', 'plugin-b']);
      expect(workspaceB.skills.map((entry) => entry.plugin?.id).toSorted()).toEqual(['plugin-a', 'plugin-b', 'skills-only']);
      expect(workspaceB.agents).toHaveLength(2);
      expect(workspaceB.starts.map((entry) => entry.pluginId).toSorted()).toEqual(['plugin-a', 'plugin-b']);
      expect(workspaceB.prompts.map((entry) => entry.pluginId).toSorted()).toEqual(['plugin-a', 'plugin-b']);
      expect(Object.keys(workspaceB.mcp).toSorted()).toEqual(['plugin-plugin-a:api', 'plugin-plugin-b:api']);
      expect(workspaceB.hooks).toHaveLength(2);
      expect(workspaceB.rules).toEqual([
        expect.objectContaining({ namespace: 'plugin/plugin-b' }),
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('resolves plugin skill owners through canonical paths with strict directory boundaries', async () => {
    const home = await makeHome();
    const root = await makePluginDir('owner-demo', { skills: './skills/' });
    await mkdir(path.join(root, 'skills', 'demo'), { recursive: true });
    await writeFile(path.join(root, 'skills', 'demo', 'SKILL.md'), 'body', 'utf8');
    createdDirs.push(root);
    const host = makeHost(home);
    const aliasBase = await mkdtemp(path.join(tmpdir(), 'plugin-skill-owner-alias-'));
    createdDirs.push(aliasBase);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await installWithConsent(svc, root);
      await svc.setPluginEnabled({ id: 'owner-demo', enabled: true });
      const managedRoot = await realpath(path.join(home, 'plugins', 'managed', 'owner-demo'));
      const skillRoot = path.join(managedRoot, 'skills');
      const aliasRoot = path.join(aliasBase, 'skills-alias');
      await symlink(skillRoot, aliasRoot, 'junction');

      await expect(svc.pluginSkillOwner(path.join(skillRoot, 'demo', 'SKILL.md'))).resolves.toBe('owner-demo');
      await expect(svc.pluginSkillOwner(path.join(aliasRoot, 'demo', 'SKILL.md'))).resolves.toBe('owner-demo');
      await expect(svc.pluginSkillOwner(path.join(managedRoot, 'skills-other', 'SKILL.md'))).resolves.toBeUndefined();
      await expect(svc.pluginSkillOwner(path.join(skillRoot, '..', 'outside', 'SKILL.md'))).resolves.toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('keeps the last valid consumption snapshot after a reload failure', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('stable-demo', { skills: './skills/' });
    createdDirs.push(pluginRoot);
    await mkdir(path.join(pluginRoot, 'skills'));
    await writeInstalledFile(home, JSON.stringify(installedFile('stable-demo', pluginRoot)));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.pluginSkillRoots()).resolves.toEqual([
        expect.objectContaining({ plugin: expect.objectContaining({ id: 'stable-demo' }) }),
      ]);

      await writeInstalledFile(home, '{ not json');
      await expect(svc.reloadPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });
      await expect(svc.listPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });
      await expect(svc.pluginSkillRoots()).resolves.toEqual([
        expect.objectContaining({ plugin: expect.objectContaining({ id: 'stable-demo' }) }),
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('uses one initial plugin snapshot for concurrent readers', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const pluginRoot = await makePluginDir('snapshot-demo', { skills: './skills/' });
    createdDirs.push(pluginRoot);
    await mkdir(path.join(pluginRoot, 'skills'));
    readInstalled.mockImplementationOnce(async () => installedFile('snapshot-demo', pluginRoot));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const [plugins, roots] = await Promise.all([svc.listPlugins(), svc.pluginSkillRoots()]);

      expect(plugins).toEqual([expect.objectContaining({ id: 'snapshot-demo' })]);
      expect(roots).toEqual([
        expect.objectContaining({
          plugin: expect.objectContaining({ id: 'snapshot-demo' }),
        }),
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('serves committed management and consumption reads while a preview is blocked', async () => {
    const home = await makeHome();
    const root = await makePluginDir('stable-preview', { systemPrompt: 'Committed prompt', skills: './skills/' });
    createdDirs.push(root);
    const pluginSkill = path.join(root, 'skills', 'example', 'SKILL.md');
    const ordinarySkill = path.join(home, 'ordinary-skill', 'SKILL.md');
    await mkdir(path.dirname(pluginSkill), { recursive: true });
    await mkdir(path.dirname(ordinarySkill), { recursive: true });
    await writeFile(pluginSkill, 'Plugin skill body');
    await writeFile(ordinarySkill, 'Ordinary skill body');
    await writeInstalledFile(home, JSON.stringify(installedFile('stable-preview', root)));
    const downloadStarted = deferred<void>();
    const downloadResponse = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => {
      downloadStarted.resolve(undefined);
      return downloadResponse.promise;
    }) as typeof fetch);
    const host = makeHost(home);
    let preview: Promise<unknown> | undefined;
    try {
      const svc = host.app.accessor.get(IPluginService);
      await svc.listPlugins();
      preview = svc.previewPlugin({ source: 'https://downloads.example.test/plugin.zip', sha256: '0'.repeat(64) }).catch((error: unknown) => error);
      await downloadStarted.promise;
      const reads = Promise.all([
        svc.listPlugins(), svc.getPluginInfo({ id: 'stable-preview' }),
        svc.enabledSystemPrompts(), svc.listPluginCommands(), svc.enabledHooks(),
        svc.pluginSkillOwner(ordinarySkill), svc.pluginSkillOwner(pluginSkill), svc.pluginSkillRoots(),
      ]);
      const result = await Promise.race([reads, new Promise<undefined>((resolve) => { setTimeout(() => { resolve(undefined); }, 150); })]);
      expect(result).toEqual([
        [expect.objectContaining({ id: 'stable-preview', enabled: true })],
        expect.objectContaining({ id: 'stable-preview', enabled: true }),
        [{ pluginId: 'stable-preview', content: 'Committed prompt' }], [], [],
        undefined, 'stable-preview', [expect.objectContaining({ plugin: { id: 'stable-preview', instructions: undefined } })],
      ]);
    } finally {
      downloadResponse.resolve(new Response('not a zip archive', { status: 200 }));
      await preview;
      await host.dispose();
    }
  });

  it('cancels one preview waiting for a mutation without cancelling other waiters or replaying IO', async () => {
    const home = await makeHome();
    const root = await makePluginDir('queued-preview', { systemPrompt: 'Committed' });
    createdDirs.push(root);
    await writeInstalledFile(home, JSON.stringify(installedFile('queued-preview', root)));
    const host = makeHost(home);
    const persisted = deferred<void>();
    const writing = deferred<void>();
    try {
      const svc = host.app.accessor.get(IPluginService);
      await svc.listPlugins();
      const originalWrite = writeInstalled.getMockImplementation()!;
      writeInstalled.mockImplementationOnce(async (...args) => {
        writing.resolve(undefined);
        await persisted.promise;
        return originalWrite(...args);
      });
      const mutation = svc.setPluginEnabled({ id: 'queued-preview', enabled: false });
      await writing.promise;
      const cancelled = new AbortController();
      const first = svc.previewPlugin({ source: 'https://example.test/cancelled.zip', sha256: '0'.repeat(64) }, cancelled.signal).catch((error: unknown) => error);
      const second = svc.previewPlugin({ source: root });
      const reads = svc.listPlugins();
      let readsSettled = false;
      void reads.then(() => { readsSettled = true; });
      const network = vi.fn(() => { throw new Error('Cancelled preview started IO'); });
      vi.stubGlobal('fetch', network);
      cancelled.abort();
      expect(await first).toMatchObject({ name: 'AbortError' });
      expect(network).not.toHaveBeenCalled();
      expect(readsSettled).toBe(false);
      persisted.resolve(undefined);
      await mutation;
      expect((await reads)[0]).toMatchObject({ id: 'queued-preview', enabled: false });
      expect(await second).toMatchObject({ id: 'queued-preview' });
      expect(network).not.toHaveBeenCalled();
      expect(await svc.enabledSystemPrompts()).toEqual([]);
    } finally {
      persisted.resolve(undefined);
      await host.dispose();
    }
  });

  it('aborts active preview download on service disposal and leaves later reads usable after caller cancellation', async () => {
    const home = await makeHome();
    const host = makeHost(home);
    const started = deferred<void>();
    let activeSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      activeSignal = options.signal ?? undefined;
      activeSignal?.addEventListener('abort', () => { reject(activeSignal?.reason); }, { once: true });
      started.resolve(undefined);
    })));
    const svc = host.app.accessor.get(IPluginService);
    const controller = new AbortController();
    const preview = svc.previewPlugin({ source: 'https://example.test/cancel.zip', sha256: '0'.repeat(64) }, controller.signal).catch((error: unknown) => error);
    await started.promise;
    controller.abort();
    expect(await preview).toMatchObject({ name: 'AbortError' });
    expect(activeSignal?.aborted).toBe(true);
    expect(await svc.listPlugins()).toEqual([]);
    const another = svc.previewPlugin({ source: 'https://example.test/dispose.zip', sha256: '0'.repeat(64) }).catch((error: unknown) => error);
    await vi.waitFor(() => { expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); });
    await host.dispose();
    expect(await another).toMatchObject({ name: 'AbortError' });
  });

  it('requires an unchanged complete fingerprint and consent before the normal preview-install chain', async () => {
    const home = await makeHome();
    const root = await makePluginDir('integrity-preview', { systemPrompt: 'Trusted contribution', hooks: [{ event: 'Stop', command: 'echo done' }] });
    createdDirs.push(root);
    await mkdir(path.join(root, 'node_modules', 'example'), { recursive: true });
    const dependency = path.join(root, 'node_modules', 'example', 'index.js');
    await writeFile(dependency, 'export const value = 1;');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const plan = await svc.previewPlugin({ source: root });
      await expect(svc.installPlugin({ source: root, fingerprint: plan.fingerprint })).rejects.toThrow('consent');
      await writeFile(dependency, 'export const value = 2;');
      await expect(svc.installPlugin({ source: root, fingerprint: plan.fingerprint, consent: true })).rejects.toThrow('changed');
      expect(await svc.listPlugins()).toEqual([]);
      const current = await svc.previewPlugin({ source: root });
      await svc.installPlugin({ source: root, fingerprint: current.fingerprint, consent: true });
      expect(await svc.getPluginInfo({ id: 'integrity-preview' })).toMatchObject({ state: 'ok', enabled: true, globalEnabled: false });
      expect(await svc.enabledSystemPrompts()).toEqual([]);
      await svc.setPluginEnabled({ id: 'integrity-preview', enabled: true });
      expect(await svc.enabledSystemPrompts()).toEqual([{ pluginId: 'integrity-preview', content: 'Trusted contribution' }]);
    } finally {
      await host.dispose();
    }
  });

  it('restores the previous managed copy when reinstall persistence fails', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const previousSource = await makePluginDir('demo', { version: '1.0.0' });
    const nextSource = await makePluginDir('demo', { version: '2.0.0' });
    createdDirs.push(previousSource, nextSource);
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await installWithConsent(svc, previousSource);
      const previous = await svc.getPluginInfo({ id: 'demo' });

      const plan = await svc.previewPlugin({ source: nextSource });
      writeInstalled.mockRejectedValueOnce(new Error('persist failed'));
      await expect(svc.installPlugin({ source: nextSource, fingerprint: plan.fingerprint, consent: true })).rejects.toThrow('persist failed');

      await expect(svc.getPluginInfo({ id: 'demo' })).resolves.toEqual(
        expect.objectContaining({ root: previous.root, version: '1.0.0' }),
      );
      await expect(
        readFile(path.join(previous.root, 'kimi.plugin.json'), 'utf8'),
      ).resolves.toContain('"version":"1.0.0"');
      await expect(readdir(path.join(home, 'plugins', 'managed'))).resolves.toEqual(['demo']);
    } finally {
      await host.dispose();
    }
  });

  it('does not block consumption reads while an update check is pending', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('github-demo', { skills: './skills/' });
    createdDirs.push(pluginRoot);
    await mkdir(path.join(pluginRoot, 'skills'));
    await writeInstalledFile(home, JSON.stringify(githubInstalledFile('github-demo', pluginRoot)));
    const lookupStarted = deferred<void>();
    const lookupResponse = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        lookupStarted.resolve(undefined);
        return lookupResponse.promise;
      }) as typeof fetch,
    );
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'github-demo' }),
      ]);

      const updates = svc.checkUpdates();
      await lookupStarted.promise;

      await expect(svc.pluginSkillRoots()).resolves.toEqual([
        expect.objectContaining({ plugin: expect.objectContaining({ id: 'github-demo' }) }),
      ]);

      lookupResponse.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://github.com/example/github-demo/releases/tag/v2.0.0',
          },
        }),
      );
      await expect(updates).resolves.toEqual([
        expect.objectContaining({ id: 'github-demo', updateAvailable: true }),
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('keeps an explicit reload result when the first load is still in flight', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const pluginRoot = await makePluginDir('old-demo', {});
    createdDirs.push(pluginRoot);
    const firstRead = deferred<InstalledFile>();
    const firstReadStarted = deferred<void>();
    readInstalled.mockImplementationOnce(async () => {
      firstReadStarted.resolve(undefined);
      return firstRead.promise;
    });
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const reloads: ReloadSummary[] = [];
      svc.onDidReload(({ added, removed, errors }) => reloads.push({ added, removed, errors }));

      const firstList = svc.listPlugins();
      await firstReadStarted.promise;
      const reload = svc.reloadPlugins();
      firstRead.resolve(installedFile('old-demo', pluginRoot));

      await expect(firstList).resolves.toEqual([expect.objectContaining({ id: 'old-demo' })]);
      await expect(reload).resolves.toEqual({ added: [], removed: ['old-demo'], errors: [] });
      await expect(svc.listPlugins()).resolves.toEqual([]);
      await expect(persistedPluginIds(home)).resolves.toEqual([]);
      expect(reloads).toEqual([{ added: [], removed: ['old-demo'], errors: [] }]);
    } finally {
      await host.dispose();
    }
  });

  it('keeps a queued removal when reload is already reading the installed file', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('demo', {});
    createdDirs.push(pluginRoot);
    await writeInstalledFile(home, JSON.stringify(installedFile('demo', pluginRoot)));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'demo', enabled: true }),
      ]);
      const reloadRead = deferred<InstalledFile>();
      const reloadReadStarted = deferred<void>();
      readInstalled.mockImplementationOnce(async () => {
        reloadReadStarted.resolve(undefined);
        return reloadRead.promise;
      });

      const reload = svc.reloadPlugins();
      await reloadReadStarted.promise;
      const remove = svc.removePlugin({ id: 'demo' });
      await Promise.resolve();
      reloadRead.resolve(installedFile('demo', pluginRoot));

      await expect(reload).resolves.toEqual({ added: [], removed: [], errors: [] });
      await expect(remove).resolves.toBeUndefined();
      await expect(svc.listPlugins()).resolves.toEqual([]);
      await expect(persistedPluginIds(home)).resolves.toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('throws plugin.not_found from getPluginInfo for an unknown plugin', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.getPluginInfo({ id: 'nope' })).rejects.toMatchObject({
        code: 'plugin.not_found',
      });
    } finally {
      await host.dispose();
    }
  });

  it('injects the managed Kimi endpoint env into stdio plugin MCP servers only', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(
      home,
      stubProviderService({
        [KIMI_CODE_PROVIDER_NAME]: {
          baseUrl: 'https://api.example.test/',
          oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.example.test' },
        },
      }),
    );
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('demo', {
        mcpServers: {
          finance: { command: 'finance-mcp', env: { CUSTOM: '1' } },
          docs: { url: 'https://example.test/mcp' },
        },
      });
      createdDirs.push(pluginRoot);
      await installWithConsent(svc, pluginRoot);
      await svc.setPluginEnabled({ id: 'demo', enabled: true });

      const servers = await svc.enabledMcpServers();
      const managedRoot = path.join(home, 'plugins', 'managed', 'demo');
      expect(servers['plugin-demo:finance']).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            KIKI_CODE_BASE_URL: 'https://api.example.test/',
            KIKI_CODE_OAUTH_HOST: 'https://auth.example.test',
            CUSTOM: '1',
            KIKI_HOME: home,
            KIKI_PLUGIN_ROOT: await realpath(managedRoot),
          }),
        }),
      );
      expect(JSON.stringify(servers['plugin-demo:docs'])).not.toContain('KIKI_CODE_BASE_URL');
    } finally {
      await host.dispose();
    }
  });

  it('merges the managed Kimi endpoint env into stdio MCP server entries with provenance', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(
      home,
      stubProviderService({
        [KIMI_CODE_PROVIDER_NAME]: {
          baseUrl: 'https://api.example.test/',
          oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.example.test' },
        },
      }),
    );
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('demo', {
        mcpServers: {
          finance: { command: 'finance-mcp', env: { CUSTOM: '1' } },
          docs: { url: 'https://example.test/mcp' },
        },
      });
      createdDirs.push(pluginRoot);
      await installWithConsent(svc, pluginRoot);
      await svc.setPluginEnabled({ id: 'demo', enabled: true });
      await svc.setPluginMcpServerEnabled({ id: 'demo', server: 'finance', enabled: false });

      const entries = await svc.mcpServerEntries();
      const managedRoot = await realpath(path.join(home, 'plugins', 'managed', 'demo'));
      const finance = entries.find((entry) => entry.name === 'plugin-demo:finance');
      expect(finance).toEqual(expect.objectContaining({ pluginId: 'demo', serverName: 'finance' }));
      expect(finance?.config).toEqual(
        expect.objectContaining({
          enabled: false,
          env: expect.objectContaining({
            KIKI_CODE_BASE_URL: 'https://api.example.test/',
            KIKI_CODE_OAUTH_HOST: 'https://auth.example.test',
            CUSTOM: '1',
            KIKI_HOME: home,
            KIKI_PLUGIN_ROOT: managedRoot,
          }),
        }),
      );
      const docs = entries.find((entry) => entry.name === 'plugin-demo:docs');
      expect(docs).toEqual(expect.objectContaining({ pluginId: 'demo', serverName: 'docs' }));
      expect(docs?.config.enabled).toBe(true);
      expect(JSON.stringify(docs?.config)).not.toContain('KIKI_CODE_BASE_URL');
    } finally {
      await host.dispose();
    }
  });

  it('waits for provider config before injecting persisted managed endpoints', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const providerConfigs: Record<string, ProviderConfig> = {};
    const readyAccessed = deferred<void>();
    const readyGate = deferred<void>();
    const providers = stubProviderService(providerConfigs, readyGate.promise);
    Object.defineProperty(providers, 'ready', {
      get: () => {
        readyAccessed.resolve(undefined);
        return readyGate.promise;
      },
    });
    const host = makeHost(home, providers);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('ready-demo', {
        mcpServers: { finance: { command: 'finance-mcp' } },
      });
      createdDirs.push(pluginRoot);
      await installWithConsent(svc, pluginRoot);
      await svc.setPluginEnabled({ id: 'ready-demo', enabled: true });

      const servers = svc.enabledMcpServers();
      await readyAccessed.promise;
      providerConfigs[KIMI_CODE_PROVIDER_NAME] = {
        baseUrl: 'https://ready.example.test/',
        oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.ready.example.test' },
      };
      readyGate.resolve(undefined);

      await expect(servers).resolves.toMatchObject({
        'plugin-ready-demo:finance': {
          env: {
            KIKI_CODE_BASE_URL: 'https://ready.example.test/',
            KIKI_CODE_OAUTH_HOST: 'https://auth.ready.example.test',
          },
        },
      });
    } finally {
      await host.dispose();
    }
  });

  it('prefers explicit KIKI_CODE_BASE_URL / KIKI_OAUTH_HOST env over the persisted provider', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(
      home,
      stubProviderService({
        [KIMI_CODE_PROVIDER_NAME]: {
          baseUrl: 'https://api.example.test',
          oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.example.test' },
        },
      }),
      {
        KIKI_CODE_BASE_URL: 'https://env.example.test/',
        KIKI_OAUTH_HOST: 'https://legacy.example.test',
      },
    );
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('demo', {
        mcpServers: { finance: { command: 'finance-mcp' } },
      });
      createdDirs.push(pluginRoot);
      await installWithConsent(svc, pluginRoot);
      await svc.setPluginEnabled({ id: 'demo', enabled: true });

      const servers = await svc.enabledMcpServers();
      expect(servers['plugin-demo:finance']).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            KIKI_CODE_BASE_URL: 'https://env.example.test',
            KIKI_CODE_OAUTH_HOST: 'https://legacy.example.test',
          }),
        }),
      );
    } finally {
      await host.dispose();
    }
  });

  it('does not inject managed env when neither env nor the kimi provider supplies it', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('demo', {
        mcpServers: { finance: { command: 'finance-mcp', env: { CUSTOM: '1' } } },
      });
      createdDirs.push(pluginRoot);
      await installWithConsent(svc, pluginRoot);
      await svc.setPluginEnabled({ id: 'demo', enabled: true });

      const servers = await svc.enabledMcpServers();
      const env = (servers['plugin-demo:finance'] as { env?: Record<string, string> }).env ?? {};
      expect(env['CUSTOM']).toBe('1');
      expect(env).not.toHaveProperty('KIKI_CODE_BASE_URL');
      expect(env).not.toHaveProperty('KIKI_CODE_OAUTH_HOST');
    } finally {
      await host.dispose();
    }
  });
});
