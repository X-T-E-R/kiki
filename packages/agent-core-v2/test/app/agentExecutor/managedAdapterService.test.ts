import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { ManagedAdapterService } from '#/app/agentExecutor/managedAdapterService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { MANAGED_ADAPTER_RELEASES, SOURCE_OWNED_ADAPTER_ENTRY, SOURCE_OWNED_ADAPTER_FILES, SOURCE_OWNED_ADAPTER_PACKAGE, SOURCE_OWNED_ADAPTER_ROOT_ENV, SOURCE_OWNED_ADAPTER_SOURCE, SOURCE_OWNED_ADAPTER_SUPPORTS_MCP, SOURCE_OWNED_ADAPTER_VERSION, sourceOwnedAdapterScript, withManagedAdapterSource, type ManagedAdapterRelease, type ManagedAdapterState } from '#/app/agentExecutor/managedAdapterRegistry';
import type { AgentExecutorDescriptor } from '#/app/agentExecutor/agentExecutor';
import type { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

const installation = { version: '0.84.0', integrity: MANAGED_ADAPTER_RELEASES['claude-acp']!.integrity,
  source: MANAGED_ADAPTER_RELEASES['claude-acp']!.source, installId: '11111111-1111-4111-8111-111111111111' };
const previous = { ...installation, version: '0.83.0', installId: '22222222-2222-4222-8222-222222222222' };

function documents(initial?: ManagedAdapterState) {
  let current = initial;
  const update = vi.fn(async (_scope: string, _key: string,
    change: (value: ManagedAdapterState | undefined) => ManagedAdapterState | undefined) => {
    current = change(current);
    return current;
  });
  return { store: { get: async () => current, update } as unknown as IAtomicTomlDocumentStore, update };
}

const bootstrap = { homeDir: '/kiki', platform: 'linux',
  getEnv: (name: string) => name === 'PATH' ? '/bin' : undefined } as IBootstrapService;

function processService(filename: string) {
  const spawn = vi.fn(async () => ({
    pid: 1, stdin: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    stdout: Readable.from([`${filename}\n`]), stderr: Readable.from([]),
    wait: async () => 0, kill: async () => {}, dispose: async () => {},
  }));
  return { service: { spawn } as unknown as IHostProcessService, spawn };
}

describe('managed ACP adapter installation', () => {
  it('uses an immutable version root and keeps explicit executable overrides', () => {
    const descriptor = { id: 'claude-acp', protocol: 'acp-v1', args: [], revision: '1',
      sources: [{ id: 'env', kind: 'env', name: 'CLAUDE_AGENT_ACP_PATH' },
        { id: 'kiki-managed', kind: 'node-script', path: '/old/adapter.js' }],
    } as AgentExecutorDescriptor;
    const active = withManagedAdapterSource(descriptor, '/kiki', { active: installation });
    expect(active.sources?.[0]).toEqual(descriptor.sources?.[0]);
    expect(active.sources?.[1]).toEqual({ id: 'kiki-managed', kind: 'node-script',
      path: '/kiki/tools/managed-executors/claude-acp/0.84.0-11111111-1111-4111-8111-111111111111/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js' });
    expect(withManagedAdapterSource({ ...descriptor, sources: [{ id: 'override', kind: 'explicit-path', path: '/custom' }] },
      '/kiki', { active: installation }).sources).toEqual([{ id: 'override', kind: 'explicit-path', path: '/custom' }]);
    const codex = withManagedAdapterSource({ id: 'codex-acp', protocol: 'acp-v1', command: 'codex-acp',
      args: [], revision: '1' }, '/kiki', { active: { ...installation, version: '2.0.0' } });
    expect(codex.sources?.map((source) => source.id)).toEqual(['kiki-managed', 'path']);
  });

  it('swaps the active pointer atomically and preserves the replaced version', async () => {
    const { store, update } = documents({ active: installation, previous });
    const service = new ManagedAdapterService(bootstrap, {} as IHostFileSystem,
      {} as IHostProcessService, store);
    const status = await service.rollback('claude-acp');
    expect(status.active).toEqual(previous);
    expect(status.previous).toEqual(installation);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('refuses a mismatched archive before installation or activation', async () => {
    const { store, update } = documents();
    const { service: process, spawn } = processService('adapter.tgz');
    const fs = {
      mkdir: async () => {},
      stat: async (path: string) => ({ isFile: true, isDirectory: false,
        size: path.endsWith('.tgz') ? 3 : 0 }),
      readBytes: async () => Buffer.from('bad'),
    } as unknown as IHostFileSystem;
    const installer = new ManagedAdapterService(bootstrap, fs, process, store);
    await expect(installer.install('claude-acp')).rejects.toThrow(/checksum mismatch/);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect((await installer.status('claude-acp')).phase).toBe('failed');
  });

  it('activates a verified install only after its executable and package metadata exist', async () => {
    const archive = Buffer.from('verified archive');
    const release = MANAGED_ADAPTER_RELEASES['claude-acp']!;
    const old = MANAGED_ADAPTER_RELEASES['claude-acp'];
    (MANAGED_ADAPTER_RELEASES as Record<string, ManagedAdapterRelease>)['claude-acp'] = {
      ...release, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    };
    try {
      const { store, update } = documents({ active: previous });
      const calls: string[][] = [];
      const spawn = vi.fn(async (_command: string, args: readonly string[]) => {
        calls.push([...args]);
        const result = args[0] === 'pack' ? 'adapter.tgz\n' : 'added 12 packages\n';
        return {
          pid: 1, stdin: new Writable({ write(_chunk, _encoding, done) { done(); } }),
          stdout: Readable.from([result]), stderr: Readable.from([]),
          wait: async () => 0, kill: async () => {}, dispose: async () => {},
        };
      });
      const fs = {
        mkdir: async () => {},
        stat: async (path: string) => ({ isFile: true, isDirectory: false,
          size: path.endsWith('.tgz') ? archive.length : 0 }),
        readBytes: async () => archive,
        readText: async () => JSON.stringify({ name: release.packageName, version: release.version }),
      } as unknown as IHostFileSystem;
      const installer = new ManagedAdapterService(bootstrap, fs, { spawn } as unknown as IHostProcessService, store);
      const status = await installer.install('claude-acp');
      expect(calls).toHaveLength(2);
      expect(calls[0]?.slice(0, 2)).toEqual(['pack', release.source]);
      expect(calls[1]).toEqual(expect.arrayContaining(['install', '--ignore-scripts', '--save-exact']));
      expect(status.active?.version).toBe(release.version);
      expect(status.previous).toEqual(previous);
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      (MANAGED_ADAPTER_RELEASES as Record<string, ManagedAdapterRelease>)['claude-acp'] = old!;
    }
  });

  it('preserves the active release when upgrade installation fails', async () => {
    const { store, update } = documents({ active: previous });
    const { service: process } = processService('fixture.tgz');
    const fs = {
      mkdir: async () => {},
      stat: async (path: string) => ({ isFile: true, isDirectory: false,
        size: path.endsWith('.tgz') ? 3 : 0 }),
      readBytes: async () => Buffer.from('bad'),
    } as unknown as IHostFileSystem;
    const installer = new ManagedAdapterService(bootstrap, fs, process, store);
    await expect(installer.install('claude-acp')).rejects.toThrow(/checksum mismatch/);
    expect((await installer.status('claude-acp')).active).toEqual(previous);
    expect(update).not.toHaveBeenCalled();
  });

  it('serializes two independent installer processes via the TOML cross-process lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'managed-adapter-race-'));
    const childPath = fileURLToPath(new URL('./managedAdapterInstallChild.ts', import.meta.url));
    const children = ['0.84.1', '0.84.2'].map((version) => {
      const child = fork(childPath, [home, version], {
        execArgv: ['--import', new URL('../../../../../build/register-raw-text-loader.mjs', import.meta.url).href, '--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr || `child exited ${code}`)); });
      });
      const completed = new Promise<{ active: string; previous?: string }>((resolve, reject) => {
        child.on('message', (value: unknown) => {
          if (typeof value === 'object' && value !== null) resolve(value as { active: string; previous?: string });
        });
        child.once('error', reject);
        child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr || `child exited ${code}`)); });
      });
      void completed.catch(() => undefined);
      return { child, ready, completed };
    });
    try {
      await Promise.all(children.map((item) => item.ready));
      children.forEach((item) => item.child.send('install'));
      const statuses = await Promise.all(children.map((item) => item.completed));
      const stored = await new TomlAtomicDocumentStore(new FileStorageService(home))
        .get<ManagedAdapterState>('managed-executors', 'claude-acp');
      expect(statuses).toHaveLength(2);
      expect([stored?.active.version, stored?.previous?.version].toSorted()).toEqual(['0.84.1', '0.84.2']);
      expect(stored?.active.installId).not.toBe(stored?.previous?.installId);
    } finally {
      for (const item of children) if (item.child.exitCode === null) item.child.kill();
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});

const OLD_ADAPTER = 'export const legacy = "pre-mcp";\n';
const CUSTOM_FILE = 'export const admission = true;\n';
const AUDIT_DATA = '{"keep":true}\n';

function ownedDescriptor(id: string, sourceId: string, path: string, source?: string): AgentExecutorDescriptor {
  return {
    id, protocol: 'acp-v1', args: [], revision: '1', source,
    sources: [{ id: sourceId, kind: 'node-script', path }],
    env: { KEEP_ME: 'retain-adapter-env' }, supportsMcp: false,
  } as AgentExecutorDescriptor;
}

function ownedRegistry(items: readonly AgentExecutorDescriptor[]): IAgentExecutorRegistry {
  return {
    get: (id: string) => items.find((item) => item.id === id),
    list: () => items,
  } as IAgentExecutorRegistry;
}

async function ownedInstaller(items: readonly AgentExecutorDescriptor[], env?: Record<string, string>, home?: string) {
  const root = home ?? await mkdtemp(join(tmpdir(), 'source-owned-adapter-'));
  const fs = new HostFileSystem();
  const documents = new TomlAtomicDocumentStore(new FileStorageService(root));
  const service = new ManagedAdapterService({
    homeDir: root, osHomeDir: root, platform: 'linux',
    getEnv: (name: string) => env?.[name],
  } as IBootstrapService, fs, {} as IHostProcessService, documents, ownedRegistry(items));
  return { home: root, fs, documents, service, async remove() { if (home === undefined) await rm(root, { recursive: true, force: true }); } };
}

describe('source-owned adapter installation', () => {
  it('installs the selected node-script, keeps unrelated files, and does not rewrite a matching copy', async () => {
    const home = await mkdtemp(join(tmpdir(), 'source-owned-adapter-'));
    const aliasDir = join(home, 'picked');
    const namedDir = join(home, 'agy-cli-adapter-909');
    await mkdir(aliasDir, { recursive: true });
    await mkdir(join(namedDir, 'audit'), { recursive: true });
    await writeFile(join(aliasDir, 'notes.txt'), 'keep-notes');
    await writeFile(join(namedDir, 'agy-file-admission.mjs'), CUSTOM_FILE);
    await writeFile(join(namedDir, 'agy-cli-audit-acp.mjs'), 'audit-copy');
    await writeFile(join(namedDir, 'audit', 'session.ndjson'), AUDIT_DATA);
    const alias = ownedDescriptor('desk-alias', 'picked', join(aliasDir, SOURCE_OWNED_ADAPTER_ENTRY), 'picked');
    const named = ownedDescriptor('agy-cli-909', 'local-adapter', `\${KIKI_HOME}/agy-cli-adapter-909/${SOURCE_OWNED_ADAPTER_ENTRY}`, 'local-adapter');
    const ignored = { ...ownedDescriptor('path-only', 'path', join(namedDir, SOURCE_OWNED_ADAPTER_ENTRY), 'path'),
      sources: [{ id: 'path', kind: 'path-lookup' as const, command: 'agy' },
        { id: 'script', kind: 'node-script' as const, path: join(namedDir, SOURCE_OWNED_ADAPTER_ENTRY) }] };
    const ambiguous = { ...ownedDescriptor('ambiguous', 'one', join(aliasDir, SOURCE_OWNED_ADAPTER_ENTRY)), source: undefined,
      sources: [{ id: 'one', kind: 'node-script' as const, path: join(aliasDir, SOURCE_OWNED_ADAPTER_ENTRY) },
        { id: 'two', kind: 'node-script' as const, path: join(namedDir, SOURCE_OWNED_ADAPTER_ENTRY) }] } as AgentExecutorDescriptor;
    const { service, documents, remove } = await ownedInstaller([alias, named, ignored, ambiguous], undefined, home);
    try {
      expect(sourceOwnedAdapterScript(ignored)).toBeUndefined();
      expect(sourceOwnedAdapterScript(ambiguous)).toBeUndefined();
      expect(await service.installable('path-only')).toBe(false);
      expect(await service.installable('ambiguous')).toBe(false);
      expect(await service.installable('constructor')).toBe(false);
      await expect(service.install('path-only')).rejects.toThrow(/Unknown managed adapter/);
      const relative = ownedDescriptor('relative', 'picked', `tools/${SOURCE_OWNED_ADAPTER_ENTRY}`, 'picked');
      const rejected = new ManagedAdapterService({ homeDir: home, osHomeDir: home, platform: 'linux', getEnv: () => undefined } as unknown as IBootstrapService,
        new HostFileSystem(), {} as IHostProcessService, documents, ownedRegistry([relative]));
      await expect(rejected.install('relative')).rejects.toThrow(/must be absolute/);

      expect((await service.status('desk-alias')).supportsMcp).toBe(false);
      const first = await service.install('desk-alias');
      expect(first.release).toMatchObject({ packageName: SOURCE_OWNED_ADAPTER_PACKAGE, version: SOURCE_OWNED_ADAPTER_VERSION,
        source: SOURCE_OWNED_ADAPTER_SOURCE, entry: SOURCE_OWNED_ADAPTER_ENTRY });
      expect(first.release.integrity.startsWith('sha256-')).toBe(true);
      expect(first.supportsMcp).toBe(true);
      expect(first.previous).toBeUndefined();
      expect(alias.supportsMcp).toBe(false);
      expect(alias.env).toEqual({ KEEP_ME: 'retain-adapter-env' });
      const bundled = await readFile(join(aliasDir, SOURCE_OWNED_ADAPTER_ENTRY), 'utf8');
      expect(bundled).toContain('registerMcpAgent');
      expect(bundled).toContain('--mcp-stdio');
      expect(await readFile(join(aliasDir, 'notes.txt'), 'utf8')).toBe('keep-notes');
      await expect(service.rollback('desk-alias')).rejects.toThrow(/No previous managed adapter installation/);
      const replay = await service.install('desk-alias');
      expect(replay.active?.installId).toBe(first.active?.installId);
      expect(await readFile(join(aliasDir, SOURCE_OWNED_ADAPTER_ENTRY), 'utf8')).toBe(bundled);

      await writeFile(join(namedDir, SOURCE_OWNED_ADAPTER_ENTRY), OLD_ADAPTER);
      expect((await service.status('agy-cli-909')).supportsMcp).toBe(false);
      const upgraded = await service.install('agy-cli-909');
      expect(upgraded.supportsMcp).toBe(true);
      expect(upgraded.previous?.version).toBe('0.0.0');
      expect(await readFile(join(namedDir, SOURCE_OWNED_ADAPTER_ENTRY), 'utf8')).toContain('registerMcpAgent');
      expect(await readFile(join(namedDir, 'agy-file-admission.mjs'), 'utf8')).toBe(CUSTOM_FILE);
      expect(await readFile(join(namedDir, 'agy-cli-audit-acp.mjs'), 'utf8')).toBe('audit-copy');
      expect(await readFile(join(namedDir, 'audit', 'session.ndjson'), 'utf8')).toBe(AUDIT_DATA);
      expect(named.supportsMcp).toBe(false);
      const edited = `${bundled}\nexport const edited = true;\n`;
      await writeFile(join(namedDir, SOURCE_OWNED_ADAPTER_ENTRY), edited);
      expect((await service.status('agy-cli-909')).supportsMcp).toBe(false);
      const refreshed = await service.install('agy-cli-909');
      expect(refreshed.active?.installId).not.toBe(upgraded.active?.installId);
      expect(refreshed.supportsMcp).toBe(true);
      const rolled = await service.rollback('agy-cli-909');
      expect(await readFile(join(namedDir, SOURCE_OWNED_ADAPTER_ENTRY), 'utf8')).toBe(edited);
      expect(rolled.supportsMcp).toBe(false);
      const restored = await service.rollback('agy-cli-909');
      expect(await readFile(join(namedDir, SOURCE_OWNED_ADAPTER_ENTRY), 'utf8')).toContain('registerMcpAgent');
      expect(restored.supportsMcp).toBe(true);
      expect(await readFile(join(namedDir, 'agy-file-admission.mjs'), 'utf8')).toBe(CUSTOM_FILE);
      expect(await readFile(join(namedDir, 'audit', 'session.ndjson'), 'utf8')).toBe(AUDIT_DATA);
      const kept = withManagedAdapterSource(named, home, { active: refreshed.active! }).sources?.[0];
      expect(kept?.kind === 'node-script' ? kept.path : undefined).toContain('agy-cli-adapter-909');
    } finally {
      await remove();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the previous script when the bundled resources or a production write fail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-owned-fail-'));
    const script = join(dir, SOURCE_OWNED_ADAPTER_ENTRY);
    await writeFile(script, OLD_ADAPTER);
    await writeFile(join(dir, 'agy-file-admission.mjs'), CUSTOM_FILE);
    const descriptor = ownedDescriptor('agy-cli-909', 'local-adapter', script, 'local-adapter');
    const empty = await mkdtemp(join(tmpdir(), 'source-owned-empty-'));
    const missing = await ownedInstaller([descriptor], { [SOURCE_OWNED_ADAPTER_ROOT_ENV]: empty });
    try {
      await expect(missing.service.install('agy-cli-909')).rejects.toThrow(/resources are unavailable/);
      expect(await readFile(script, 'utf8')).toBe(OLD_ADAPTER);
      expect(await missing.documents.get('managed-executors', 'agy-cli-909')).toBeUndefined();
      expect((await missing.service.status('agy-cli-909')).phase).toBe('failed');
      expect((await missing.service.status('agy-cli-909')).supportsMcp).toBe(false);
    } finally {
      await missing.remove();
      await rm(empty, { recursive: true, force: true });
    }

    const flaky = await ownedInstaller([descriptor]);
    const realWrite = flaky.fs.writeBytes.bind(flaky.fs);
    let productionWrites = 0;
    flaky.fs.writeBytes = async (path: string, data: Uint8Array) => {
      if (SOURCE_OWNED_ADAPTER_FILES.some((name) => path.endsWith(name)) && !path.includes('managed-executors')) {
        productionWrites += 1;
        if (productionWrites === 2) throw new Error('injected write failure');
      }
      await realWrite(path, data);
    };
    try {
      await expect(flaky.service.install('agy-cli-909')).rejects.toThrow(/injected write failure/);
      expect(await readFile(script, 'utf8')).toBe(OLD_ADAPTER);
      expect(await readFile(join(dir, 'agy-file-admission.mjs'), 'utf8')).toBe(CUSTOM_FILE);
      await expect(readFile(join(dir, 'agy-hook-registration.mjs'))).rejects.toThrow();
      expect(await flaky.documents.get('managed-executors', 'agy-cli-909')).toBeUndefined();
    } finally {
      await flaky.remove();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches the external-harness production manifest', async () => {
    const manifestHref = new URL('../../../../../scripts/external-harness/production-manifest.mjs', import.meta.url).href;
    const manifest = await import(manifestHref) as {
      SOURCE_OWNED_ADAPTER_FILES: readonly string[];
      SOURCE_OWNED_ADAPTER_ENTRY: string;
      SOURCE_OWNED_ADAPTER_VERSION: string;
      SOURCE_OWNED_ADAPTER_SUPPORTS_MCP: boolean;
      SOURCE_OWNED_ADAPTER_ROOT_ENV: string;
      SOURCE_OWNED_ADAPTER_SOURCE: string;
      SOURCE_OWNED_ADAPTER_PACKAGE: string;
    };
    expect([...SOURCE_OWNED_ADAPTER_FILES]).toEqual([...manifest.SOURCE_OWNED_ADAPTER_FILES]);
    expect(SOURCE_OWNED_ADAPTER_ENTRY).toBe(manifest.SOURCE_OWNED_ADAPTER_ENTRY);
    expect(SOURCE_OWNED_ADAPTER_VERSION).toBe(manifest.SOURCE_OWNED_ADAPTER_VERSION);
    expect(SOURCE_OWNED_ADAPTER_SUPPORTS_MCP).toBe(manifest.SOURCE_OWNED_ADAPTER_SUPPORTS_MCP);
    expect(SOURCE_OWNED_ADAPTER_ROOT_ENV).toBe(manifest.SOURCE_OWNED_ADAPTER_ROOT_ENV);
    expect(SOURCE_OWNED_ADAPTER_SOURCE).toBe(manifest.SOURCE_OWNED_ADAPTER_SOURCE);
    expect(SOURCE_OWNED_ADAPTER_PACKAGE).toBe(manifest.SOURCE_OWNED_ADAPTER_PACKAGE);
    const listed = manifest.SOURCE_OWNED_ADAPTER_FILES.join('\n');
    expect(listed).not.toContain('fixture-cli.mjs');
    expect(listed).not.toContain('agy-cli-audit-acp.mjs');
    expect(listed).not.toContain('audit/');
  });
});
