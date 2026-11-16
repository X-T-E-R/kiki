import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { CpuWorkerPool } from '#/app/cpuWorker/host';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { WorkspacePathIndex } from '#/os/backends/node-local/workspacePathIndex';
import { LocalRuntime } from '#/runtime/localRuntime';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';
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

async function execute(execution: ToolExecution): Promise<string> {
  if (!('execute' in execution)) throw new Error('expected executable search');
  const result = await execution.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: 'search' });
  expect(result.isError).not.toBe(true);
  return String(result.output);
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
      expect(index.snapshot()?.entries.filter(entry => entry.kind === 'file').length).toBe(1502);
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
      index.dispose();
      expect(index.snapshot()).toBeUndefined();
    } finally {
      runtime?.dispose();
      index?.dispose();
      await ix.dispose();
      await pool.close();
      await rm(fixture, { recursive: true, force: true });
    }
  }, 60_000);
});
