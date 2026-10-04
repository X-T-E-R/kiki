import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { ManagedAdapterService } from '#/app/agentExecutor/managedAdapterService';
import { MANAGED_ADAPTER_RELEASES, withManagedAdapterSource, type ManagedAdapterRelease, type ManagedAdapterState } from '#/app/agentExecutor/managedAdapterRegistry';
import type { AgentExecutorDescriptor } from '#/app/agentExecutor/agentExecutor';
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
