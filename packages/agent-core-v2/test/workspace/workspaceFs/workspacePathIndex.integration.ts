import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { CpuWorkerPool, type CpuRequestOptions } from '#/app/cpuWorker/host';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { FileEditService } from '#/app/edit/fileEditService';
import { computeFuzzyScore } from '#/_base/text/fuzzy';
import { EditTool } from '#/agent/tools/edit/editTool';
import { IEditTool } from '#/agent/tools/edit/edit';
import { WriteTool } from '#/agent/tools/os/write/writeTool';
import { IWriteTool } from '#/agent/tools/os/write/write';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { workspacePathEntry, workspacePathFilter, workspacePathInventory } from '#/os/backends/node-local/workspacePathInventory';
import { WorkspacePathIndex } from '#/os/backends/node-local/workspacePathIndex';
import { LocalRuntime } from '#/runtime/localRuntime';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';
import { IFileEditService } from '#/app/edit/fileEdit';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { WorkspaceFsService } from '#/workspace/workspaceFs/fsService';
import { IWorkspaceFsService, fsGrepRequestSchema, fsSearchRequestSchema, fsSuggestRequestSchema } from '#/workspace/workspaceFs/fs';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { IGlobTool, GlobInputSchema } from '#/agent/tools/os/glob/glob';
import { GrepTool } from '#/agent/tools/os/grep/grepTool';
import { IGrepTool, GrepInputSchema } from '#/agent/tools/os/grep/grep';
import type { ToolExecution } from '#/tool/toolContract';
import { stubBootstrap } from '../../app/bootstrap/stubs';

const execFileAsync = promisify(execFile);

async function execute(execution: ToolExecution): Promise<string> {
  if (!('execute' in execution)) throw new Error('expected executable search');
  const result = await execution.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: 'search' });
  expect(result.isError).not.toBe(true);
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

async function withLocalIndex<T>(setup: (root: string) => Promise<void>, run: (fixture: { readonly fixture: string; readonly root: string; readonly pool: CpuWorkerPool; readonly index: WorkspacePathIndex }) => Promise<T>): Promise<T> {
  await mkdir(resolve('.tmp'), { recursive: true });
  const fixture = await mkdtemp(resolve('.tmp', 'workspace-path-index-'));
  const root = join(fixture, 'root');
  await mkdir(root);
  await setup(root);
  const pool = new CpuWorkerPool(new URL('../../../src/app/cpuWorker/bootstrap.mjs', import.meta.url), { maxWorkers: 1 });
  const index = new WorkspacePathIndex(root, { _serviceBrand: undefined, request: (operation, options) => pool.request(operation, options) }, join(fixture, 'cache'));
  try {
    await index.refresh();
    await index.refresh();
    return await run({ fixture, root, pool, index });
  } finally {
    await index.dispose();
    await pool.close();
    await rm(fixture, { recursive: true, force: true });
  }
}

describe('indexed workspace search with real files, workers and ripgrep', () => {
  it('preserves regex/context/multiline results, refreshes changes and releases its watcher', async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    const fixture = await mkdtemp(resolve('.tmp', 'workspace-search-'));
    const root = join(fixture, 'root');
    await mkdir(root);
    const pool = new CpuWorkerPool(new URL('../../../src/app/cpuWorker/bootstrap.mjs', import.meta.url), { maxWorkers: 1 });
    const ix = new TestInstantiationService();
    let index: WorkspacePathIndex | undefined;
    let runtime: LocalRuntime | undefined;
    try {
      await mkdir(join(root, 'src'));
      for (let offset = 0; offset < 1500; offset += 100) {
        await Promise.all(Array.from({ length: 100 }, (_, item) => writeFile(join(root, 'src', `file-${offset + item}.ts`),
          offset + item === 123 ? 'before\nuniqueNeedle = 123\nafter\nsecondLine\n' : `ordinary-${offset + item}\n`)));
      }
      await writeFile(join(root, '.gitignore'), 'ignored/\nexcluded.ts\n');
      await writeFile(join(root, 'excluded.ts'), 'uniqueNeedle');
      await writeFile(join(root, 'unicode.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('日本語', 'utf16le')]));
      await symlink(join(root, 'src'), join(root, 'docs-link'), process.platform === 'win32' ? 'junction' : 'dir');
      await mkdir(join(root, 'ignored'));
      await writeFile(join(root, 'ignored', 'secret.ts'), 'uniqueNeedle');
      await writeFile(join(root, '.env'), 'uniqueNeedle');
      index = new WorkspacePathIndex(root, { _serviceBrand: undefined, request: (operation, options) => pool.request(operation, options) }, join(fixture, 'cache'));
      const environment: IHostEnvironment = { _serviceBrand: undefined, osKind: process.platform === 'win32' ? 'Windows' : 'Linux',
        osArch: 'x64', osVersion: 'test', pathClass: process.platform === 'win32' ? 'win32' : 'posix',
        homeDir: root, shellName: 'bash', shellPath: 'bash', ready: Promise.resolve() };
      const fs = new HostFileSystem();
      const processes = new HostProcessService();
      runtime = new LocalRuntime('workspace', environment, fs, processes, undefined, undefined);
      const lease = () => ({ runtime: runtime!, track: <T>(resource: T) => resource, dispose() {} });
      ix.set(IAgentRuntimeService, { _serviceBrand: undefined, onDidChange: () => ({ dispose() {} }),
        inspect: () => runtime!, acquire: lease, isAvailable: () => true });
      ix.set(IRuntimeResolver, { _serviceBrand: undefined, inspect: () => runtime!, acquire: lease });
      ix.set(ISessionWorkspaceContext, { _serviceBrand: undefined, workDir: root, additionalDirs: [],
        resolve: path => resolve(root, path), isWithin: path => path === root || path.startsWith(`${root}/`) });
      ix.set(IWorkspaceContext, { _serviceBrand: undefined, workspaceId: 'workspace', cwd: root } as IWorkspaceContext);
      ix.set(IWorkspaceDirs, { _serviceBrand: undefined, additionalDirs: [] } as unknown as IWorkspaceDirs);
      ix.set(IWorkspaceGitService, {} as IWorkspaceGitService);
      ix.set(IHostFileSystem, fs);
      ix.set(ITelemetryService, noopTelemetryService);
      ix.set(IBootstrapService, stubBootstrap(root));
      ix.set(ISessionSkillCatalog, { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog);
      ix.set(IGlobTool, new SyncDescriptor(GlobTool));
      ix.set(IGrepTool, new SyncDescriptor(GrepTool));
      ix.set(IWorkspaceFsService, new SyncDescriptor(WorkspaceFsService));
      const grep = ix.get(IGrepTool);
      const glob = ix.get(IGlobTool);
      const workspace = ix.get(IWorkspaceFsService);
      const patterns = [
        { pattern: 'uniqueNeedle', literal: true, output_mode: 'files_with_matches' as const },
        { pattern: '日本語', literal: true, output_mode: 'files_with_matches' as const },
        { pattern: 'uniqueNeedle', literal: true, output_mode: 'content' as const, '-C': 1 },
        { pattern: 'uniqueNeedle', literal: true, output_mode: 'count_matches' as const },
        { pattern: 'uniqueNeedle.*after', multiline: true, output_mode: 'content' as const },
        { pattern: 'uniqueNeedle\\s+=\\s+\\d+', output_mode: 'content' as const, head_limit: 3 },
      ];
      const before: string[] = [];
      for (const args of patterns) before.push(await execute(await grep.resolveExecution(GrepInputSchema.parse(args))));
      const coldGlob = await execute(await glob.resolveExecution(GlobInputSchema.parse({ pattern: '**/*.ts', head_limit: 0 })));
      expect(coldGlob).not.toContain('excluded.ts');
      await index.refresh();
      expect(index.error).toBeUndefined();
      expect(index.snapshot()?.entries.filter(entry => entry.kind === 'file').length).toBe(1503);
      expect(index.snapshot()?.entries.find(entry => entry.path === 'excluded.ts')).toBeUndefined();
      expect(index.snapshot()?.entries.find(entry => entry.path === '.env')).toMatchObject({ path: '.env', sensitive: true });
      await index.trigram!.whenReady();
      expect(index.trigram!.error).toBeUndefined();
      Object.defineProperty(runtime, 'pathIndex', { value: index });
      for (let item = 0; item < patterns.length; item++) {
        expect(await execute(await grep.resolveExecution(GrepInputSchema.parse(patterns[item])))).toBe(before[item]);
      }
      expect(await execute(await grep.resolveExecution(GrepInputSchema.parse({ pattern: 'noSuchNeedle', literal: true })))).toBe('No matches found');
      const paths = await execute(await glob.resolveExecution(GlobInputSchema.parse({ pattern: '**/*.ts', head_limit: 0 })));
      expect(paths).toContain('src/file-123.ts');
      expect(paths).not.toContain('ignored/');
      expect(paths).not.toContain('.env');
      expect(paths).not.toContain('excluded.ts');
      const suggested = await workspace.suggest(fsSuggestRequestSchema.parse({ query: 'file-123', follow_gitignore: true, limit: 10 }));
      expect(suggested.items[0]?.path).toBe('src/file-123.ts');
      for (const query of ['/file-123', 'src//file-123']) {
        expect((await workspace.suggest(fsSuggestRequestSchema.parse({ query, follow_gitignore: true, limit: 10 }))).items[0]?.path).toBe('src/file-123.ts');
      }
      expect((await workspace.suggest(fsSuggestRequestSchema.parse({ query: 'src/', follow_gitignore: true, limit: 10 }))).items[0]?.path).toBe('src');
      expect((await workspace.search(fsSearchRequestSchema.parse({ query: 'docs-link', follow_gitignore: true }))).items).toContainEqual(expect.objectContaining({ path: 'docs-link', kind: 'symlink' }));
      const search = await workspace.search(fsSearchRequestSchema.parse({ query: 'file-', follow_gitignore: true, limit: 2 }));
      expect(search.next_cursor).toMatch(/^pi1_/u);
      const next = await workspace.search(fsSearchRequestSchema.parse({ query: 'file-', follow_gitignore: true, limit: 2, cursor: search.next_cursor }));
      expect(next.items.every(item => !search.items.some(previous => previous.path === item.path))).toBe(true);
      const found = await workspace.grep(fsGrepRequestSchema.parse({ pattern: 'uniqueNeedle', regex: false, case_sensitive: true, follow_gitignore: true }));
      expect(found.files).toHaveLength(1);
      expect(found.files[0]?.path.replaceAll('\\', '/')).toContain('src/file-123.ts');
      await writeFile(join(root, 'src', 'file-124.ts'), 'uniqueNeedle changed\n');
      await expect.poll(() => index!.snapshot()?.entries.find(entry => entry.path === 'src/file-124.ts')?.size, { timeout: 15_000 }).toBe(21);
      expect(await execute(await grep.resolveExecution(GrepInputSchema.parse({ pattern: 'uniqueNeedle', literal: true })))).toContain('src/file-124.ts');
      await expect(workspace.search(fsSearchRequestSchema.parse({ query: 'file-', follow_gitignore: true, limit: 2, cursor: search.next_cursor }))).rejects.toThrow();
      await index.dispose();
      expect(index.snapshot()).toBeUndefined();
    } finally {
      if (runtime !== undefined) await runtime.dispose();
      if (index !== undefined) await index.dispose();
      await ix.dispose();
      await pool.close();
      await rm(fixture, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not publish a stale full trigram build after a smaller refresh', async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    const fixture = await mkdtemp(resolve('.tmp', 'workspace-trigram-rebuild-'));
    const root = join(fixture, 'root');
    await mkdir(join(root, 'src'), { recursive: true });
    for (let offset = 0; offset < 1500; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, item) => writeFile(
        join(root, 'src', `file-${offset + item}.txt`),
        `ordinary-${offset + item}\n`,
      )));
    }
    const pool = new CpuWorkerPool(new URL('../../../src/app/cpuWorker/bootstrap.mjs', import.meta.url), { maxWorkers: 1 });
    let unblock: () => void = () => {};
    const finishGate = new Promise<void>((resolveGate) => { unblock = resolveGate; });
    let enteredResolve: () => void = () => {};
    const entered = new Promise<void>((resolveEntered) => { enteredResolve = resolveEntered; });
    let paused = false;
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown, options?: CpuRequestOptions) => {
        if (!paused && (operation as { readonly type?: unknown }).type === 'workspace.trigram.finish') {
          paused = true;
          enteredResolve();
          await finishGate;
        }
        return pool.request<T>(operation, options);
      },
    };
    const index = new WorkspacePathIndex(root, cpu, join(fixture, 'cache'));
    let runtime: LocalRuntime | undefined;
    try {
      await index.refresh();
      await entered;
      const environment: IHostEnvironment = { _serviceBrand: undefined, osKind: process.platform === 'win32' ? 'Windows' : 'Linux',
        osArch: 'x64', osVersion: 'test', pathClass: process.platform === 'win32' ? 'win32' : 'posix',
        homeDir: root, shellName: 'bash', shellPath: 'bash', ready: Promise.resolve() };
      runtime = new LocalRuntime('workspace', environment, new HostFileSystem(), undefined, undefined, undefined, index);
      await runtime.fs!.remove(join(root, 'src', 'file-0.txt'));
      await runtime.fs!.remove(join(root, 'src', 'file-1.txt'));
      const added = join(root, 'src', 'new-matching.txt');
      await runtime.fs!.writeText(added, 'matchingNeedle\n');
      await index.whenSettled();
      index.invalidate();
      await index.refresh();
      await index.refresh();
      const snapshot = index.snapshot();
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) throw new Error('workspace path snapshot did not settle');
      expect(snapshot.entries.filter((entry) => entry.kind === 'file')).toHaveLength(1499);
      expect(snapshot.entries.some((entry) => entry.path === 'src/new-matching.txt')).toBe(true);
      unblock();
      await index.trigram!.whenReady();
      expect(await index.trigram!.candidates(snapshot, 'matchingNeedle', true, false)).toBeUndefined();
      expect((await new HostFileSystem().stat(added)).isFile).toBe(true);
    } finally {
      unblock();
      if (runtime !== undefined) await runtime.dispose();
      else await index.dispose();
      await pool.close();
      await rm(fixture, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps fuzzy candidates positive across ASCII, digits, whitespace, accents, CJK, and sensitive entries', async () => {
    await withLocalIndex(
      async (root) => {
        await Promise.all([
          writeFile(join(root, 'Alpha README.txt'), 'alpha'),
          writeFile(join(root, 'build 42 log.txt'), 'digits'),
          writeFile(join(root, 'café.txt'), 'accent'),
          writeFile(join(root, '日本語.md'), 'cjk'),
          writeFile(join(root, '.env'), 'sensitive'),
        ]);
      },
      async ({ index }) => {
        for (const [query, expected] of [['alpha', 'Alpha README.txt'], ['42', 'build 42 log.txt'], ['alpha r', 'Alpha README.txt'], ['café', 'café.txt'], ['日本語', '日本語.md'], ['env', '.env']] as const) {
          const matches = index.fuzzy(query, false) ?? [];
          expect(matches.length).toBeGreaterThan(0);
          expect(matches.every((entry) => computeFuzzyScore(entry.name, query.toLowerCase()) > 0)).toBe(true);
          expect(matches.some((entry) => entry.name === expected)).toBe(true);
        }
        expect(index.snapshot()?.entries.find((entry) => entry.path === '.env')).toMatchObject({ path: '.env', sensitive: true });
      },
    );
  });

  it('updates glob and trigram candidates through runtime filesystem and Write/Edit operations without polling', async () => {
    await withLocalIndex(
      async (root) => {
        await mkdir(join(root, 'src'));
        for (let offset = 0; offset < 1500; offset += 100) {
          await Promise.all(Array.from({ length: 100 }, (_, item) => writeFile(join(root, 'src', `file-${offset + item}.ts`), offset + item === 123 ? 'seedNeedle\n' : `ordinary-${offset + item}\n`)));
        }
      },
      async ({ root, index }) => {
        const hostFs = new HostFileSystem();
        const environment: IHostEnvironment = { _serviceBrand: undefined, osKind: process.platform === 'win32' ? 'Windows' : 'Linux',
          osArch: 'x64', osVersion: 'test', pathClass: process.platform === 'win32' ? 'win32' : 'posix',
          homeDir: root, shellName: 'bash', shellPath: 'bash', ready: Promise.resolve() };
        const runtime = new LocalRuntime('workspace', environment, hostFs, undefined, undefined, undefined, index);
        const lease = () => ({ runtime, track: <T>(resource: T) => resource, dispose() {} });
        const ix = new TestInstantiationService();
        ix.set(IAgentRuntimeService, { _serviceBrand: undefined, onDidChange: () => ({ dispose() {} }), inspect: () => runtime,
          acquire: lease, isAvailable: () => true });
        ix.set(ISessionWorkspaceContext, { _serviceBrand: undefined, workDir: root, additionalDirs: [],
          resolve: path => resolve(root, path), isWithin: path => path === root || path.startsWith(`${root}/`) });
        ix.set(IHostFileSystem, hostFs);
        ix.set(IFileEditService, new SyncDescriptor(FileEditService));
        ix.set(IWriteTool, new SyncDescriptor(WriteTool));
        ix.set(IEditTool, new SyncDescriptor(EditTool));
        try {
          await index.trigram!.whenReady();
          const initial = await index.trigram!.candidates(index.snapshot()!, 'seedNeedle', true, false);
          expect(initial).toContain('src/file-123.ts');

          const runtimePath = join(root, 'src', 'runtime-added.txt');
          await runtime.fs!.writeText(runtimePath, 'runtimeNeedle\n');
          expect(await index.glob(root, 'runtime-*.txt')).toContain(runtimePath);
          await index.trigram!.whenReady();
          expect(await index.trigram!.candidates(index.snapshot()!, 'runtimeNeedle', true, false)).toContain('src/runtime-added.txt');

          await runtime.fs!.appendText(runtimePath, 'appendNeedle\n');
          await index.trigram!.whenReady();
          expect(await index.trigram!.candidates(index.snapshot()!, 'appendNeedle', true, false)).toContain('src/runtime-added.txt');

          const exclusivePath = join(root, 'src', 'exclusive.txt');
          expect(await runtime.fs!.createExclusive(exclusivePath, Buffer.from('exclusiveNeedle\n'))).toBe(true);
          expect(await index.glob(root, 'exclusive.txt')).toContain(exclusivePath);
          await runtime.fs!.remove(exclusivePath);
          expect(await index.glob(root, 'exclusive.txt')).not.toContain(exclusivePath);

          const write = ix.get(IWriteTool);
          const toolPath = join(root, 'src', 'tool-created.txt');
          await execute(await write.resolveExecution({ path: 'src/tool-created.txt', content: 'toolNeedle\n' }));
          await index.whenSettled();
          expect((await hostFs.stat(toolPath)).isFile).toBe(true);
          expect(index.snapshot()?.entries.find((entry) => entry.path === 'src/tool-created.txt')).toMatchObject({ path: 'src/tool-created.txt', kind: 'file' });
          expect(await index.glob(root, 'tool-*.txt')).toContain(toolPath);
          await index.trigram!.whenReady();
          expect(await index.trigram!.candidates(index.snapshot()!, 'toolNeedle', true, false)).toContain('src/tool-created.txt');

          const edit = ix.get(IEditTool);
          await execute(await edit.resolveExecution({ path: 'src/tool-created.txt', old_string: 'toolNeedle', new_string: 'editedNeedle' }));
          await index.trigram!.whenReady();
          expect(await index.trigram!.candidates(index.snapshot()!, 'editedNeedle', true, false)).toContain('src/tool-created.txt');
        } finally {
          await runtime.dispose();
          await ix.dispose();
        }
      },
    );
  }, 60_000);

  it('matches ripgrep when a parent .ignore negation outranks a nested .gitignore', async () => {
    await withLocalIndex(
      async (root) => {
        await mkdir(join(root, '.git'));
        await mkdir(join(root, 'nested'));
        await writeFile(join(root, '.ignore'), '!*.txt\n');
        await writeFile(join(root, 'nested', '.gitignore'), '*.txt\n*.log\n');
        await writeFile(join(root, 'nested', 'keep.txt'), 'keep');
        await writeFile(join(root, 'nested', 'drop.log'), 'drop');
        await writeFile(join(root, 'nested', 'plain.md'), 'plain');
      },
      async ({ root }) => {
        const keep = join(root, 'nested', 'keep.txt');
        const drop = join(root, 'nested', 'drop.log');
        const inventory = workspacePathInventory(root, 100);
        expect(inventory.entries.filter((entry) => entry.path.endsWith('.txt'))).toEqual([
          expect.objectContaining({ path: 'nested/keep.txt', kind: 'file' }),
        ]);
        expect(inventory.entries.some((entry) => entry.path === 'nested/drop.log')).toBe(false);
        expect(workspacePathEntry(root, keep)).toMatchObject({ path: 'nested/keep.txt', kind: 'file' });
        expect(workspacePathEntry(root, drop)).toBeUndefined();
        expect(workspacePathFilter(root, [keep, drop])).toEqual([keep]);
        const { stdout } = await execFileAsync('rg', ['--files', '--hidden'], { cwd: root, encoding: 'utf8' });
        const rgFiles = stdout.split(/\r?\n/u).filter(Boolean).map((path) => path.replaceAll('\\', '/'));
        expect(rgFiles.filter((path) => path.endsWith('.txt'))).toEqual(['nested/keep.txt']);
        expect(rgFiles).not.toContain('nested/drop.log');
      },
    );
  });

  it('honors parent-child ignore precedence and brace basename/path fallback', async () => {
    await withLocalIndex(
      async (root) => {
        await mkdir(join(root, 'nested'));
        await writeFile(join(root, '.gitignore'), '*.parent-ignore\n');
        await writeFile(join(root, 'nested', '.ignore'), '!keep.parent-ignore\n');
        await writeFile(join(root, 'nested', 'keep.parent-ignore'), 'keep');
        await writeFile(join(root, 'nested', 'drop.parent-ignore'), 'drop');
        await writeFile(join(root, 'brace-a.ts'), 'a');
        await writeFile(join(root, 'brace-b.ts'), 'b');
      },
      async ({ root, index }) => {
        const entries = index.snapshot()?.entries.map((entry) => entry.path) ?? [];
        expect(entries).toContain('nested/keep.parent-ignore');
        expect(entries).not.toContain('nested/drop.parent-ignore');
        expect((await index.glob(root, '{brace-a,brace-b}.ts'))?.toSorted()).toEqual([join(root, 'brace-a.ts'), join(root, 'brace-b.ts')].toSorted());
        expect(await index.glob(root, 'nested/{brace-a,brace-b}.ts')).toBeUndefined();
      },
    );
  });

  it('preserves inventory boundaries, metadata and symlink pruning', async () => {
    await withLocalIndex(
      async (root) => {
        await mkdir(join(root, 'nested'));
        await mkdir(join(root, 'ignored'));
        await mkdir(join(root, '.git'));
        await writeFile(join(root, '.gitignore'), 'ignored/\n');
        await writeFile(join(root, 'nested', 'visible.ts'), 'visible');
        await writeFile(join(root, 'nested', '.env'), 'secret');
        await writeFile(join(root, 'ignored', 'hidden.ts'), 'hidden');
        await writeFile(join(root, '.git', 'internal'), 'internal');
        await symlink(join(root, 'nested'), join(root, 'nested-link'), process.platform === 'win32' ? 'junction' : 'dir');
      },
      async ({ root }) => {
        const inventory = workspacePathInventory(root, 100);
        expect(inventory.overflow).toBe(false);
        expect(inventory.entries).toContainEqual(expect.objectContaining({ path: 'nested/visible.ts', kind: 'file' }));
        expect(inventory.entries).toContainEqual(expect.objectContaining({ path: 'nested/.env', kind: 'file', sensitive: true }));
        expect(inventory.entries).toContainEqual(expect.objectContaining({ path: 'nested-link', kind: 'symlink' }));
        expect(inventory.entries.some((entry) => entry.path.startsWith('nested-link/'))).toBe(false);
        expect(inventory.entries.some((entry) => entry.path.startsWith('ignored/'))).toBe(false);
        expect(inventory.entries.some((entry) => entry.path.startsWith('.git/'))).toBe(false);
        expect(workspacePathInventory(root, 1)).toEqual({ entries: [], overflow: true });
      },
    );
  });

  it.skipIf(process.platform !== 'win32')('accepts a Windows root with different casing', async () => {
    await withLocalIndex(
      async (root) => { await writeFile(join(root, 'case.txt'), 'case'); },
      async ({ root, index }) => { expect(await index.glob(root.toUpperCase(), '*.txt')).toContain(join(root, 'case.txt')); },
    );
  });

  it.skipIf(process.platform !== 'win32')('keeps case aliases as one display entry across runtime writes and removal', async () => {
    await withLocalIndex(
      async (root) => {
        await mkdir(join(root, 'src'));
        for (let offset = 0; offset < 1498; offset += 100) {
          await Promise.all(Array.from({ length: Math.min(100, 1498 - offset) }, (_, item) => writeFile(
            join(root, 'src', `file-${offset + item}.txt`),
            `ordinary-${offset + item}\n`,
          )));
        }
        await writeFile(join(root, 'src', 'InventoryMixed.txt'), 'inventoryNeedle\n');
        await writeFile(join(root, 'src', 'RemoveMixed.txt'), 'removeNeedle\n');
      },
      async ({ root, index }) => {
        const environment: IHostEnvironment = { _serviceBrand: undefined, osKind: 'Windows', osArch: 'x64', osVersion: 'test',
          pathClass: 'win32', homeDir: root, shellName: 'bash', shellPath: 'bash', ready: Promise.resolve() };
        const runtime = new LocalRuntime('workspace', environment, new HostFileSystem(), undefined, undefined, undefined, index);
        try {
          await index.trigram!.whenReady();
          expect(await index.trigram!.candidates(index.snapshot()!, 'removeNeedle', true, false)).toContain('src/RemoveMixed.txt');
          const inventoryAlias = join(root, 'src', 'inventorymixed.txt');
          await runtime.fs!.writeText(inventoryAlias, 'inventoryNeedle\n');
          await index.whenSettled();
          const inventoryEntries = index.snapshot()?.entries.filter((entry) => entry.path.toLowerCase() === 'src/inventorymixed.txt') ?? [];
          expect(inventoryEntries).toHaveLength(1);
          expect(inventoryEntries[0]?.path).toBe('src/InventoryMixed.txt');
          expect((await runtime.fs!.stat(inventoryAlias)).isFile).toBe(true);
          await index.trigram!.whenReady();
          const removeAlias = join(root, 'src', 'removemixed.txt');
          await runtime.fs!.remove(removeAlias);
          await index.whenSettled();
          expect(index.snapshot()?.entries.some((entry) => entry.path.toLowerCase() === 'src/removemixed.txt')).toBe(false);
          expect(await index.glob(root, 'remove*.txt')).toEqual([]);
          await index.trigram!.whenReady();
          const candidates = await index.trigram!.candidates(index.snapshot()!, 'removeNeedle', true, false);
          expect(candidates ?? []).not.toContain('src/RemoveMixed.txt');
        } finally {
          await runtime.dispose();
        }
      },
    );
  }, 60_000);
});
