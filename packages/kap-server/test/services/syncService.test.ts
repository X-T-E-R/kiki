import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { armor } from 'age-encryption';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJsAgeX25519Cipher,
  loadNativeAgeX25519Cipher,
  type AgeX25519Cipher,
  type IConfigRegistry,
  type IConfigService,
  type IFileSystemStorageService,
  type IMemoryStore,
} from '@kiki/agent-core-v2';
import { StorageError, StorageErrors } from '@kiki/agent-core-v2/persistence/interface/storage';
import {
  createJsAgeCodec,
  decodeAge,
  encodeAge,
  loadNativeAge,
  type AgeCodec,
} from '../../src/services/portableSpace/ageCodec';
import { SyncService } from '../../src/services/sync/syncService';
import { exportSessionsTarGzStream, importSessionsTarGzStream } from '../../src/services/sync/sessionArchiveStream';
import type { SessionLiveServices } from '../../src/services/portableSpace/liveSpace';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('SyncService home assets sync', () => {
  it('round-trips prompt overrides, instructions, personas, and custom agents before applying config while excluding builtin/secrets/symlinks', async () => {
    const sandbox = makeTempDir('kiki-sync-home-assets-');
    const sourceHome = join(sandbox, 'source-home');
    const targetHome = join(sandbox, 'target-home');
    const osHome = join(sandbox, 'os-home');
    const outsideFile = join(sandbox, 'outside.txt');
    mkdirSync(join(sourceHome, 'prompt'), { recursive: true });
    mkdirSync(join(sourceHome, 'prompts'), { recursive: true });
    mkdirSync(join(sourceHome, 'cognition'), { recursive: true });
    mkdirSync(join(sourceHome, 'personas'), { recursive: true });
    mkdirSync(join(sourceHome, 'agents', 'builtin'), { recursive: true });
    mkdirSync(join(sourceHome, 'agents', 'custom'), { recursive: true });
    mkdirSync(join(sourceHome, 'recipes', 'daily-digest'), { recursive: true });
    mkdirSync(targetHome, { recursive: true });
    mkdirSync(osHome, { recursive: true });

    writeFileSync(outsideFile, 'do-not-leak\n');
    writeFileSync(join(sourceHome, 'AGENTS.md'), '# Global Instructions\n');
    writeFileSync(join(sourceHome, 'SYSTEM.md'), '# System Prompt\n');
    writeFileSync(join(sourceHome, 'prompt', 'custom.toml'), 'system_prompt = "clean"\n');
    writeFileSync(join(sourceHome, 'prompt', '.env'), 'API_KEY=secret\n');
    writeFileSync(join(sourceHome, 'prompt', 'private.pem'), 'PRIVATE\n');
    writeFileSync(join(sourceHome, 'prompt', 'server.local-owner'), 'SECRET-OWNER\n');
    writeFileSync(join(sourceHome, 'prompts', 'extra.md'), 'extra prompt\n');
    writeFileSync(join(sourceHome, 'cognition', 'style.md'), 'style guide\n');
    writeFileSync(join(sourceHome, 'personas', 'nia.md'), 'persona body\n');
    writeFileSync(join(sourceHome, 'agents', 'custom', 'builder.md'), 'custom agent\n');
    writeFileSync(join(sourceHome, 'agents', 'builtin', 'default.md'), 'builtin agent\n');
    writeFileSync(join(sourceHome, 'recipes', 'daily-digest', 'recipe.toml'), 'name = "daily-digest"\n');
    writeFileSync(join(sourceHome, 'recipes', 'daily-digest', 'instructions.md'), 'digest steps\n');
    try {
      symlinkSync(outsideFile, join(sourceHome, 'prompt', 'linked.toml'));
    } catch {
      void 0;
    }

    const sourceConfigValues: Record<string, unknown> = {
      defaultModel: 'gemini-4-neon',
      models: {
        'gemini-4-neon': {
          provider: 'axon',
          model: 'gemini-4-neon',
          prompt_overrides: { files: ['prompt/custom.toml'] },
        },
      },
    };
    const sourceConfig: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'> = {
      ready: Promise.resolve(),
      get: (<T>(domain: string) => sourceConfigValues[domain] as T) as IConfigService['get'],
      inspect: ((domain: string) => ({ userValue: sourceConfigValues[domain] })) as IConfigService['inspect'],
      replace: async () => undefined,
    };

    const targetConfigValues: Record<string, unknown> = {};
    let promptOverridePresentDuringConfigReplace = false;
    const targetConfig: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'> = {
      ready: Promise.resolve(),
      get: (<T>(domain: string) => targetConfigValues[domain] as T) as IConfigService['get'],
      inspect: ((domain: string) => ({ userValue: targetConfigValues[domain] })) as IConfigService['inspect'],
      replace: async (domain: string, value: unknown) => {
        if (domain === 'models' && existsSync(join(targetHome, 'prompt', 'custom.toml'))) {
          promptOverridePresentDuringConfigReplace = true;
        }
        targetConfigValues[domain] = value;
      },
    };

    const configRegistry: Pick<IConfigRegistry, 'getSection' | 'listSections'> = {
      getSection: () => undefined,
      listSections: () => [{ domain: 'models' } as never],
    };

    const sourceSync = new SyncService({ homeDir: sourceHome, osHomeDir: osHome, configService: sourceConfig, configRegistry });
    const targetSync = new SyncService({ homeDir: targetHome, osHomeDir: osHome, configService: targetConfig, configRegistry });

    const bundle = await sourceSync.exportSyncBundle({
      includeConfig: true,
      includeHomeAssets: true,
      includeCredentials: false,
      includeMemories: false,
      includeSkills: false,
    });
    const exportedPaths = (bundle.homeAssets ?? []).map((entry) => entry.relativePath);
    expect(exportedPaths).toEqual([
      'AGENTS.md',
      'agents/custom/builder.md',
      'cognition/style.md',
      'personas/nia.md',
      'prompt/custom.toml',
      'prompts/extra.md',
      'recipes/daily-digest/instructions.md',
      'recipes/daily-digest/recipe.toml',
      'SYSTEM.md',
    ]);

    const receipt = await targetSync.importSyncBundle({
      ...bundle,
      homeAssets: [
        ...(bundle.homeAssets ?? []),
        { relativePath: '../escape.txt', contentBase64: Buffer.from('bad').toString('base64') },
        { relativePath: 'agents/builtin/default.md', contentBase64: Buffer.from('bad').toString('base64') },
        { relativePath: 'credentials/device.key', contentBase64: Buffer.from('bad').toString('base64') },
        { relativePath: 'prompt/secret.pem', contentBase64: Buffer.from('bad').toString('base64') },
      ],
    });

    expect(promptOverridePresentDuringConfigReplace).toBe(true);
    expect(receipt.homeAssetsApplied).toBe(9);
    expect(receipt.homeAssetsSkipped).toBe(4);
    expect(readFileSync(join(targetHome, 'prompt', 'custom.toml'), 'utf8')).toBe('system_prompt = "clean"\n');
    expect(readFileSync(join(targetHome, 'prompts', 'extra.md'), 'utf8')).toBe('extra prompt\n');
    expect(readFileSync(join(targetHome, 'cognition', 'style.md'), 'utf8')).toBe('style guide\n');
    expect(readFileSync(join(targetHome, 'AGENTS.md'), 'utf8')).toBe('# Global Instructions\n');
    expect(readFileSync(join(targetHome, 'SYSTEM.md'), 'utf8')).toBe('# System Prompt\n');
    expect(readFileSync(join(targetHome, 'personas', 'nia.md'), 'utf8')).toBe('persona body\n');
    expect(readFileSync(join(targetHome, 'agents', 'custom', 'builder.md'), 'utf8')).toBe('custom agent\n');
    expect(readFileSync(join(targetHome, 'recipes', 'daily-digest', 'recipe.toml'), 'utf8')).toBe('name = "daily-digest"\n');
    expect(readFileSync(join(targetHome, 'recipes', 'daily-digest', 'instructions.md'), 'utf8')).toBe('digest steps\n');
    expect(existsSync(join(targetHome, 'agents', 'builtin', 'default.md'))).toBe(false);
    expect(existsSync(join(targetHome, 'prompt', '.env'))).toBe(false);
    expect(existsSync(join(targetHome, 'prompt', 'secret.pem'))).toBe(false);
    expect(existsSync(join(targetHome, 'credentials', 'device.key'))).toBe(false);
    expect(existsSync(join(sandbox, 'escape.txt'))).toBe(false);
  });

  it('confines prompt_overrides.files to prompt/ and agents/ and verifies installation before applying config', async () => {
    const sandbox = makeTempDir('kiki-sync-ref-overrides-');
    const sourceHome = join(sandbox, 'source-home');
    const targetHome = join(sandbox, 'target-home');
    const osHome = join(sandbox, 'os-home');
    mkdirSync(join(sourceHome, 'prompt', 'nested'), { recursive: true });
    mkdirSync(join(sourceHome, 'agents', 'custom', 'overrides'), { recursive: true });
    mkdirSync(join(sourceHome, 'outside-root'), { recursive: true });
    mkdirSync(targetHome, { recursive: true });
    mkdirSync(osHome, { recursive: true });

    writeFileSync(join(sourceHome, 'prompt', 'nested', 'model-tune.toml'), 'system_prompt = "tuned"\n');
    writeFileSync(join(sourceHome, 'agents', 'custom', 'overrides', 'agent-tune.toml'), 'system_prompt = "agent-tuned"\n');
    writeFileSync(join(sourceHome, 'outside-root', 'sneaky.toml'), 'system_prompt = "escape"\n');
    writeFileSync(
      join(sourceHome, 'agents', 'custom', 'builder.md'),
      [
        '---',
        'name: builder',
        'description: Custom builder',
        'prompt_overrides:',
        '  files:',
        '    - agents/custom/overrides/agent-tune.toml',
        '---',
        'Build cleanly.',
        '',
      ].join('\n'),
    );

    const sourceConfigValues: Record<string, unknown> = {
      models: {
        'gemini-4-neon': {
          provider: 'axon',
          model: 'gemini-4-neon',
          prompt_overrides: { files: ['prompt/nested/model-tune.toml'] },
        },
      },
    };
    const sourceConfig: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'> = {
      ready: Promise.resolve(),
      get: (<T>(domain: string) => sourceConfigValues[domain] as T) as IConfigService['get'],
      inspect: ((domain: string) => ({ userValue: sourceConfigValues[domain] })) as unknown as IConfigService['inspect'],
      replace: async () => undefined,
    };
    const targetConfigValues: Record<string, unknown> = {};
    const replaceCalls: string[] = [];
    const targetConfig: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'> = {
      ready: Promise.resolve(),
      get: (<T>(domain: string) => targetConfigValues[domain] as T) as IConfigService['get'],
      inspect: ((domain: string) => ({ userValue: targetConfigValues[domain] })) as unknown as IConfigService['inspect'],
      replace: async (domain: string, value: unknown) => {
        replaceCalls.push(domain);
        targetConfigValues[domain] = value;
      },
    };
    const configRegistry: Pick<IConfigRegistry, 'getSection' | 'listSections'> = {
      getSection: () => undefined,
      listSections: () => [{ domain: 'models' } as never],
    };

    const sourceSync = new SyncService({ homeDir: sourceHome, osHomeDir: osHome, configService: sourceConfig, configRegistry });
    const targetSync = new SyncService({ homeDir: targetHome, osHomeDir: osHome, configService: targetConfig, configRegistry });

    const bundle = await sourceSync.exportSyncBundle({
      includeConfig: true,
      includeHomeAssets: true,
      includeCredentials: false,
      includeMemories: false,
      includeSkills: false,
    });
    const exportedPaths = (bundle.homeAssets ?? []).map((entry) => entry.relativePath);
    expect(exportedPaths).toContain('prompt/nested/model-tune.toml');
    expect(exportedPaths).toContain('agents/custom/overrides/agent-tune.toml');

    const receipt = await targetSync.importSyncBundle({
      ...bundle,
      homeAssets: [
        ...(bundle.homeAssets ?? []),
        { relativePath: 'outside-root/sneaky.toml', contentBase64: Buffer.from('nope').toString('base64') },
      ],
    });
    expect(receipt.homeAssetsApplied).toBe(3);
    expect(receipt.homeAssetsSkipped).toBe(1);
    expect(replaceCalls).toEqual(['models']);
    expect(readFileSync(join(targetHome, 'prompt', 'nested', 'model-tune.toml'), 'utf8')).toBe('system_prompt = "tuned"\n');
    expect(readFileSync(join(targetHome, 'agents', 'custom', 'overrides', 'agent-tune.toml'), 'utf8')).toBe('system_prompt = "agent-tuned"\n');
    expect(existsSync(join(targetHome, 'outside-root', 'sneaky.toml'))).toBe(false);

    replaceCalls.length = 0;
    await expect(
      targetSync.importSyncBundle({
        format: 'kiki.sync-bundle.v1',
        exportedAt: new Date().toISOString(),
        portableConfig: {
          models: {
            'gemini-4-neon': {
              provider: 'axon',
              model: 'gemini-4-neon',
              prompt_overrides: { files: ['outside-root/sneaky.toml'] },
            },
          },
        },
        homeAssets: [
          { relativePath: 'outside-root/sneaky.toml', contentBase64: Buffer.from('escape').toString('base64') },
        ],
      }),
    ).rejects.toThrow(/must stay under prompt\/ or agents\//i);
    expect(replaceCalls).toEqual([]);
    expect(existsSync(join(targetHome, 'outside-root', 'sneaky.toml'))).toBe(false);

    await expect(
      targetSync.importSyncBundle({
        format: 'kiki.sync-bundle.v1',
        exportedAt: new Date().toISOString(),
        portableConfig: {
          models: {
            'gemini-4-neon': {
              provider: 'axon',
              model: 'gemini-4-neon',
              prompt_overrides: { files: ['prompt/missing-override.toml'] },
            },
          },
        },
        homeAssets: [],
      }),
    ).rejects.toThrow(/missing from incoming sync bundle/i);
    expect(replaceCalls).toEqual([]);

    sourceConfigValues['models'] = {
      'gemini-4-neon': {
        provider: 'axon',
        model: 'gemini-4-neon',
        prompt_overrides: { files: ['outside-root/sneaky.toml'] },
      },
    };
    await expect(
      sourceSync.exportSyncBundle({
        includeConfig: true,
        includeHomeAssets: true,
        includeCredentials: false,
        includeMemories: false,
        includeSkills: false,
      }),
    ).rejects.toThrow(/must stay under prompt\/ or agents\//i);

    sourceConfigValues['models'] = {
      'gemini-4-neon': {
        provider: 'axon',
        model: 'gemini-4-neon',
        prompt_overrides: { files: ['prompt/nested/model-tune.toml'] },
      },
    };
    unlinkSync(join(sourceHome, 'prompt', 'nested', 'model-tune.toml'));
    await expect(
      sourceSync.exportSyncBundle({
        includeConfig: true,
        includeHomeAssets: true,
        includeCredentials: false,
        includeMemories: false,
        includeSkills: false,
      }),
    ).rejects.toThrow(/prompt\/nested\/model-tune\.toml/);
  });

  it('enforces requested domains and selectors on pull even when peer returns unrequested data', async () => {
    const sandbox = makeTempDir('kiki-sync-pull-filter-');
    const localHome = join(sandbox, 'local-home');
    const osHome = join(sandbox, 'os-home');
    mkdirSync(localHome, { recursive: true });
    mkdirSync(osHome, { recursive: true });

    const configReplaced: string[] = [];
    const localConfig: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'> = {
      ready: Promise.resolve(),
      get: (() => undefined) as IConfigService['get'],
      inspect: (() => ({ userValue: undefined })) as unknown as IConfigService['inspect'],
      replace: async (domain: string) => {
        configReplaced.push(domain);
      },
    };
    const writtenMemories: Array<{ readonly scope: unknown; readonly title: string }> = [];
    const memoryStore: Pick<IMemoryStore, 'list' | 'put' | 'get'> = {
      get: async () => undefined,
      list: async () => [],
      put: (async (input: { readonly scope: unknown; readonly title: string }) => {
        writtenMemories.push({ scope: input.scope, title: input.title });
        return { entry: { id: 'm_1' } };
      }) as unknown as IMemoryStore['put'],
    };

    const localSync = new SyncService({
      homeDir: localHome,
      osHomeDir: osHome,
      configService: localConfig,
      memoryStore,
      peerTransport: {
        resolvePeerRecipient: async () => undefined,
        pushBundle: async () => { throw new Error('unused'); },
        pullBundle: async () => ({
          format: 'kiki.sync-bundle.v1',
          exportedAt: new Date().toISOString(),
          portableConfig: { defaultModel: 'sneaky-model' },
          homeAssets: [{ relativePath: 'AGENTS.md', contentBase64: Buffer.from('unrequested').toString('base64') }],
          skills: [{ skillName: 'sneaky-skill', relativePath: 'SKILL.md', contentBase64: Buffer.from('---\nname: sneaky-skill\n---\n').toString('base64') }],
          sessions: [{ sessionId: 'sess-unrequested', relativePath: 'state.json', contentBase64: Buffer.from('{}').toString('base64') }],
          memories: [
            {
              id: 'm_allowed',
              type: 'project',
              title: 'Allowed Project Memory',
              body: 'keep me',
              revision: 'r1',
              updated: '2026-01-02T00:00:00.000Z',
              scope: { kind: 'workspace', workspaceId: 'prj_allowed' },
            },
            {
              id: 'm_wrong_proj',
              type: 'project',
              title: 'Other Project Memory',
              body: 'drop me',
              revision: 'r1',
              updated: '2026-01-02T00:00:00.000Z',
              scope: { kind: 'workspace', workspaceId: 'prj_forbidden' },
            },
            {
              id: 'm_wrong_scope',
              type: 'user',
              title: 'Global Memory',
              body: 'drop me too',
              revision: 'r1',
              updated: '2026-01-02T00:00:00.000Z',
              scope: { kind: 'global' },
            },
          ],
        }),
      },
    });

    const receipt = await localSync.pullFromPeer('peer-1', {
      includeConfig: false,
      includeCredentials: false,
      includeMemories: true,
      includeSkills: false,
      memoryScopes: ['workspace'],
      projectIds: ['prj_allowed'],
      sessions: { mode: 'none' },
    });

    expect(configReplaced).toEqual([]);
    expect(existsSync(join(localHome, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(localHome, 'skills', 'sneaky-skill', 'SKILL.md'))).toBe(false);
    expect(receipt.homeAssetsApplied).toBeUndefined();
    expect(receipt.skillsApplied).toBe(0);
    expect(receipt.memoriesApplied).toBe(1);
    expect(writtenMemories).toHaveLength(1);
    expect(writtenMemories[0]!.title).toBe('Allowed Project Memory');
  });

  it('round-trips canonical session streams including execution-control.json and updates existing cold sessions when newer', async () => {
    const sandbox = makeTempDir('kiki-session-stream-unit-');
    const sessionsDirA = join(sandbox, 'sessions-a');
    const sessionsDirB = join(sandbox, 'sessions-b');
    const wsB = 'wd_work_b_1234567890ab';
    const wsA = 'wd_work_a_abcdef123456';
    const sessDirB = join(sessionsDirB, wsB, 'sess-stream-1');
    mkdirSync(join(sessDirB, 'agents', 'main'), { recursive: true });
    writeFileSync(join(sessDirB, 'state.json'), JSON.stringify({ id: 'sess-stream-1', workspaceId: wsB, updatedAt: 1000 }));
    writeFileSync(join(sessDirB, 'execution-control.json'), JSON.stringify({ state: 'paused' }));
    writeFileSync(join(sessDirB, 'agents', 'main', 'wire.jsonl'), '{"seq":1}\n');

    const indexMapB = new Map([[
      'sess-stream-1',
      { id: 'sess-stream-1', workspaceId: wsB, updatedAt: 1000, createdAt: 1000, cwd: '/b', archived: false },
    ]]);
    const liveB: SessionLiveServices = {
      bootstrap: { sessionsDir: sessionsDirB, scope: (kind: string) => kind },
      sessions: { get: () => undefined, isEphemeral: () => false },
      index: {
        status: () => ({ state: 'ready' } as never),
        prepare: async () => ({ state: 'ready' } as never),
        get: async (id: string) => indexMapB.get(id) as never,
        listRecent: async () => ({ items: [...indexMapB.values()] } as never),
        reconcileNow: async () => undefined,
      },
      logs: { flush: async () => undefined },
    };

    const indexMapA = new Map<string, { id: string; workspaceId: string; updatedAt: number; createdAt: number; cwd: string; archived: boolean }>();
    const liveA: SessionLiveServices = {
      bootstrap: { sessionsDir: sessionsDirA, scope: (kind: string) => kind },
      sessions: { get: () => undefined, isEphemeral: () => false },
      index: {
        status: () => ({ state: 'ready' } as never),
        prepare: async () => ({ state: 'ready' } as never),
        get: async (id: string) => indexMapA.get(id) as never,
        listRecent: async () => ({ items: [...indexMapA.values()] } as never),
        reconcileNow: async () => {
          indexMapA.set('sess-stream-1', { id: 'sess-stream-1', workspaceId: wsA, updatedAt: 1000, createdAt: 1000, cwd: '/a', archived: false });
        },
      },
      logs: { flush: async () => undefined },
    };

    const stream1 = await exportSessionsTarGzStream(liveB, { mode: 'ids', sessionIds: ['sess-stream-1'] });
    const first = await importSessionsTarGzStream(liveA, stream1, { workspaceId: wsA, workDir: '/a' });
    expect(first).toEqual({ sessionsApplied: 1, sessionsSkipped: 0 });
    expect(readFileSync(join(sessionsDirA, wsA, 'sess-stream-1', 'execution-control.json'), 'utf8')).toContain('paused');

    const stream2 = await exportSessionsTarGzStream(liveB, { mode: 'ids', sessionIds: ['sess-stream-1'] });
    const noop = await importSessionsTarGzStream(liveA, stream2, { workspaceId: wsA, workDir: '/a' });
    expect(noop).toEqual({ sessionsApplied: 0, sessionsSkipped: 1 });

    writeFileSync(join(sessDirB, 'state.json'), JSON.stringify({ id: 'sess-stream-1', workspaceId: wsB, updatedAt: 2000 }));
    writeFileSync(join(sessDirB, 'agents', 'main', 'wire.jsonl'), '{"seq":1}\n{"seq":2}\n');
    const stream3 = await exportSessionsTarGzStream(liveB, { mode: 'ids', sessionIds: ['sess-stream-1'] });
    const updated = await importSessionsTarGzStream(liveA, stream3, { workspaceId: wsA, workDir: '/a' });
    expect(updated).toEqual({ sessionsApplied: 1, sessionsSkipped: 0 });
    expect(readFileSync(join(sessionsDirA, wsA, 'sess-stream-1', 'agents', 'main', 'wire.jsonl'), 'utf8')).toContain('"seq":2');

    writeFileSync(join(sessDirB, 'state.json'), JSON.stringify({ id: 'sess-stream-1', workspaceId: wsB, updatedAt: 3000 }));
    writeFileSync(join(sessDirB, 'agents', 'main', 'wire.jsonl'), '{"seq":99}\n{"seq":100}\n{"seq":101}\n');
    const divergentStream = await exportSessionsTarGzStream(liveB, { mode: 'ids', sessionIds: ['sess-stream-1'] });
    const divergentResult = await importSessionsTarGzStream(liveA, divergentStream, { workspaceId: wsA, workDir: '/a' });
    expect(divergentResult).toEqual({ sessionsApplied: 0, sessionsSkipped: 1 });
    expect(readFileSync(join(sessionsDirA, wsA, 'sess-stream-1', 'agents', 'main', 'wire.jsonl'), 'utf8')).toBe('{"seq":1}\n{"seq":2}\n');

    writeFileSync(join(sessDirB, 'state.json'), JSON.stringify({ id: 'sess-stream-1', workspaceId: wsB, updatedAt: 4000 }));
    writeFileSync(join(sessDirB, 'agents', 'main', 'wire.jsonl'), '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
    const lockedLiveA: SessionLiveServices = {
      ...liveA,
      storage: {
        acquireLock: async () => {
          throw new StorageError(StorageErrors.codes.STORAGE_LOCKED, 'Session lock held');
        },
      } as unknown as IFileSystemStorageService,
    };
    const lockedStream = await exportSessionsTarGzStream(liveB, { mode: 'ids', sessionIds: ['sess-stream-1'] });
    const lockedResult = await importSessionsTarGzStream(lockedLiveA, lockedStream, { workspaceId: wsA, workDir: '/a' });
    expect(lockedResult).toEqual({ sessionsApplied: 0, sessionsSkipped: 1 });
    expect(readFileSync(join(sessionsDirA, wsA, 'sess-stream-1', 'agents', 'main', 'wire.jsonl'), 'utf8')).toBe('{"seq":1}\n{"seq":2}\n');

    const fullChunks: Buffer[] = [];
    const fullStream = await exportSessionsTarGzStream(liveB, { mode: 'ids', sessionIds: ['sess-stream-1'] });
    for await (const chunk of fullStream) fullChunks.push(Buffer.from(chunk as Uint8Array));
    const rawTar = gunzipSync(Buffer.concat(fullChunks));
    const truncatedTar = rawTar.subarray(0, rawTar.byteLength - 1024);
    await expect(
      importSessionsTarGzStream(liveA, Readable.from([gzipSync(truncatedTar)]), { workspaceId: wsA, workDir: '/a' }),
    ).rejects.toThrow(/Truncated session tar archive stream/);

    const oversizedHeader = Buffer.alloc(512, 0);
    oversizedHeader.write('././@LongLink', 0, 100, 'utf8');
    oversizedHeader.write('0000644\0', 100, 8, 'ascii');
    oversizedHeader.write('0000000\0', 108, 8, 'ascii');
    oversizedHeader.write('0000000\0', 116, 8, 'ascii');
    oversizedHeader.write(`${(8192).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    oversizedHeader.write('00000000000\0', 136, 12, 'ascii');
    oversizedHeader.fill(0x20, 148, 156);
    oversizedHeader.write('L', 156, 1, 'ascii');
    oversizedHeader.write('ustar\0', 257, 6, 'ascii');
    oversizedHeader.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += oversizedHeader[i]!;
    oversizedHeader.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    await expect(
      importSessionsTarGzStream(
        liveA,
        Readable.from([gzipSync(Buffer.concat([oversizedHeader, Buffer.alloc(1024)]))]),
        { workspaceId: wsA, workDir: '/a' },
      ),
    ).rejects.toThrow(/long-name header exceeds path limit/i);

    const exportErrStream = await exportSessionsTarGzStream(liveB, { mode: 'ids', sessionIds: ['sess-stream-1'] });
    unlinkSync(join(sessDirB, 'agents', 'main', 'wire.jsonl'));
    const readExportStream = async () => {
      for await (const _chunk of exportErrStream) {
        void _chunk;
      }
    };
    await expect(readExportStream()).rejects.toThrow(/ENOENT|size changed/i);
  });

  it('short-circuits empty mergeIncomingCredentials([]) without touching cipher or device key and supports pure-JS device key generation', async () => {
    const sandbox = makeTempDir('kiki-sync-empty-creds-');
    const emptyHome = join(sandbox, 'empty-home');
    const jsHome = join(sandbox, 'js-home');
    const osHome = join(sandbox, 'os-home');
    mkdirSync(emptyHome, { recursive: true });
    mkdirSync(jsHome, { recursive: true });
    mkdirSync(osHome, { recursive: true });

    const forbiddenCipher: AgeX25519Cipher = {
      generateX25519Keypair() {
        throw new Error('cipher must not be invoked for empty credential merge');
      },
      recipientFromIdentity() {
        throw new Error('cipher must not be invoked for empty credential merge');
      },
      encryptMultiRecipient() {
        throw new Error('cipher must not be invoked for empty credential merge');
      },
      decryptIdentity() {
        throw new Error('cipher must not be invoked for empty credential merge');
      },
    };
    const emptySync = new SyncService({
      homeDir: emptyHome,
      osHomeDir: osHome,
      cipher: forbiddenCipher,
    });

    const mergeReceipt = await emptySync.mergeIncomingCredentials([]);
    expect(mergeReceipt).toEqual({
      appliedIds: [],
      skippedIds: [],
      conflictIds: [],
      revision: expect.stringMatching(/^cred:[0-9a-f]{16}$/),
    });
    expect(existsSync(join(emptyHome, 'credentials', 'device-x25519.key'))).toBe(false);

    const bundleReceipt = await emptySync.importSyncBundle({
      format: 'kiki.sync-bundle.v1',
      exportedAt: new Date().toISOString(),
      credentialEnvelopes: [],
    });
    expect(bundleReceipt.credentials.appliedIds).toEqual([]);
    expect(existsSync(join(emptyHome, 'credentials', 'device-x25519.key'))).toBe(false);

    const fallbackCipher = loadNativeAgeX25519Cipher(() => {
      const err = new Error("Cannot find module '@kiki/auth-native'") as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    });
    const jsSyncWriter = new SyncService({
      homeDir: jsHome,
      osHomeDir: osHome,
      cipher: fallbackCipher,
    });
    const publicKey = await jsSyncWriter.getDevicePublicKey();
    expect(publicKey.recipient).toMatch(/^age1[a-z0-9]+$/);
    expect(existsSync(join(jsHome, 'credentials', 'device-x25519.key'))).toBe(true);

    const jsSyncReader = new SyncService({
      homeDir: jsHome,
      osHomeDir: osHome,
      cipher: createJsAgeX25519Cipher(),
    });
    const recovered = await jsSyncReader.readExistingDeviceKeypair();
    expect(recovered?.recipient).toBe(publicKey.recipient);
  });

  it(
    'interoperates between Rust @kiki/auth-native and pure-JS ageCodec across 0/65535/65536/65537 bytes, multi-recipient X25519, passphrase scrypt, and ASCII armor',
    async () => {
      const sandbox = makeTempDir('kiki-age-codec-interop-');
      const homeA = join(sandbox, 'home-a');
      const osHome = join(sandbox, 'os-home');
      mkdirSync(homeA, { recursive: true });
      mkdirSync(osHome, { recursive: true });

      const req = createRequire(import.meta.url);
      let nativeRaw: unknown;
      try {
        const oauthEntry = req.resolve('@kiki/oauth');
        nativeRaw = createRequire(oauthEntry)('@kiki/auth-native');
      } catch {
        nativeRaw = req('@kiki/auth-native');
      }
      const rustCodec = nativeRaw as AgeCodec & AgeX25519Cipher;
      const jsCodec = createJsAgeCodec();
      const jsCipher = createJsAgeX25519Cipher();
      const fallbackCodec = loadNativeAge(() => {
        const err = new Error("Cannot find module '@kiki/auth-native'") as NodeJS.ErrnoException;
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      });

      const sync = new SyncService({
        homeDir: homeA,
        osHomeDir: osHome,
        cipher: jsCipher,
      });
      const rustKey = await rustCodec.generateX25519Keypair();
      const jsKey = await jsCipher.generateX25519Keypair();

      for (const size of [0, 65535, 65536, 65537]) {
        const payload = Buffer.alloc(size);
        for (let i = 0; i < size; i += 1) {
          payload[i] = (i * 73 + 29) & 0xff;
        }

        const rustEncoded = await encodeAge(
          payload,
          { mode: 'x25519', recipients: [rustKey.recipient, jsKey.recipient] },
          [],
          sync,
          () => rustCodec,
        );
        const jsDecoded = await decodeAge(
          rustEncoded.bytes,
          { identity: jsKey.identity },
          sync,
          () => fallbackCodec,
        );
        expect(jsDecoded.mode).toBe('x25519');
        expect(jsDecoded.bytes).toEqual(payload);

        const jsEncoded = await encodeAge(
          payload,
          { mode: 'x25519', recipients: [rustKey.recipient, jsKey.recipient] },
          [],
          sync,
          () => jsCodec,
        );
        const rustDecoded = await decodeAge(
          jsEncoded.bytes,
          { identity: rustKey.identity },
          sync,
          () => rustCodec,
        );
        expect(rustDecoded.mode).toBe('x25519');
        expect(rustDecoded.bytes).toEqual(payload);

        if (size === 0 || size === 65537) {
          const armoredBytes = Buffer.from(armor.encode(jsEncoded.bytes), 'ascii');
          const unarmoredByRust = await decodeAge(
            armoredBytes,
            { identity: rustKey.identity },
            sync,
            () => rustCodec,
          );
          const unarmoredByJs = await decodeAge(
            armoredBytes,
            { identity: jsKey.identity },
            sync,
            () => jsCodec,
          );
          expect(unarmoredByRust.bytes).toEqual(payload);
          expect(unarmoredByJs.bytes).toEqual(payload);
        }
      }

      const passphrasePayload = Buffer.from('portable-space-scrypt-interop-payload', 'utf8');
      const passphrase = 'correct-horse-battery-staple';
      const rustPassEncoded = await encodeAge(
        passphrasePayload,
        { mode: 'passphrase', passphrase },
        [],
        sync,
        () => rustCodec,
      );
      const jsPassDecoded = await decodeAge(
        rustPassEncoded.bytes,
        { passphrase },
        sync,
        () => jsCodec,
      );
      expect(jsPassDecoded).toEqual({
        bytes: passphrasePayload,
        mode: 'passphrase',
        matchedPassphrase: passphrase,
      });

      const jsPassEncoded = await encodeAge(
        passphrasePayload,
        { mode: 'passphrase', passphrase },
        [],
        sync,
        () => jsCodec,
      );
      const rustPassDecoded = await decodeAge(
        jsPassEncoded.bytes,
        { passphrase },
        sync,
        () => rustCodec,
      );
      expect(rustPassDecoded).toEqual({
        bytes: passphrasePayload,
        mode: 'passphrase',
        matchedPassphrase: passphrase,
      });
    },
    30_000,
  );
});
