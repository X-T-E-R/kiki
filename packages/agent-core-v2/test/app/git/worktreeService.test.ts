import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IWorktreeService } from '#/app/git/worktreeModel';
import { WorktreeService } from '#/app/git/worktreeService';
import { IEventService } from '#/app/event/event';
import { WORKTREE_SECTION, worktreeConfigSchema } from '#/app/git/worktreeConfig';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { Runtime } from '#/runtime/runtime';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('managed worktree removal', () => {
  let root: string;
  let source: string;
  let ix: TestInstantiationService;
  let services: DisposableStore;
  let worktrees: IWorktreeService;
  let archived: boolean;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kiki-worktree-test-'));
    source = join(root, 'source');
    mkdirSync(source);
    git(source, 'init');
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(source, 'file.txt'), 'original\n');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'initial');
    archived = true;
    services = new DisposableStore();
    const documents = new Map<string, unknown>();
    const runtime = { process: new HostProcessService() } as unknown as Runtime;
    ix = createServices(services, { additionalServices: (reg) => {
      reg.definePartialInstance(IBootstrapService, { homeDir: root });
      reg.definePartialInstance(IConfigService, {
        ready: Promise.resolve(),
        get: ((section: string) => section === WORKTREE_SECTION ? worktreeConfigSchema.parse({ root: join(root, 'worktrees'), cleanup: { auto: false } }) : undefined) as IConfigService['get'],
      });
      reg.definePartialInstance(IAtomicDocumentStore, {
        get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
        update: async <T>(_scope: string, key: string, change: (value: T | undefined) => T | undefined) => {
          const next = change(documents.get(key) as T | undefined);
          documents.set(key, next);
          return next;
        },
      });
      reg.definePartialInstance(IRuntimeResolver, {
        acquire: () => ({ runtime, track: <T>(resource: T) => resource, dispose: () => {} }),
      });
      reg.definePartialInstance(ISessionIndex, { get: async () => ({ id: 'session_test', workspaceId: 'workspace_test', createdAt: 0, updatedAt: 0, archived }) });
      reg.definePartialInstance(ISessionManager, { list: () => [] });
      reg.definePartialInstance(IEventService, { publish: () => {} });
      reg.define(IWorktreeService, WorktreeService);
    } });
    worktrees = ix.get(IWorktreeService);
  });

  afterEach(() => {
    services.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('severs an NTFS junction without touching its external sentinel', async () => {
    if (process.platform !== 'win32') return;
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    const sentinel = join(root, 'sentinel');
    mkdirSync(sentinel);
    writeFileSync(join(sentinel, 'keep.txt'), 'important');
    const scope = join(record.path, 'node_modules', '@scope');
    mkdirSync(scope, { recursive: true });
    symlinkSync(sentinel, join(scope, 'pkg'), 'junction');
    expect(lstatSync(join(scope, 'pkg')).isSymbolicLink()).toBe(true);
    expect((await worktrees.remove(record.id)).outcome).toBe('removed');
    expect(existsSync(record.path)).toBe(false);
    expect(readFileSync(join(sentinel, 'keep.txt'), 'utf8')).toBe('important');
    expect(git(source, 'worktree', 'list', '--porcelain')).not.toContain(record.path);
  }, 30000);

  it('keeps an edited checkout unless the loss was inspected and confirmed', async () => {
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    writeFileSync(join(record.path, 'file.txt'), 'changed\n');
    expect((await worktrees.remove(record.id)).outcome).toBe('retained_dirty');
    expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('original\n');
    await worktrees.inspect(record.id);
    expect((await worktrees.remove(record.id, { confirmLoss: { dirty: true, ignored: false, unpushed: false } })).outcome).toBe('removed');
    expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('original\n');
  }, 30000);

  it('retains an unowned checkout when the owner marker is removed', async () => {
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    const controlDir = git(record.path, 'rev-parse', '--path-format=absolute', '--git-dir');
    rmSync(join(controlDir, 'kiki-owner.json'));
    expect((await worktrees.remove(record.id)).outcome).toBe('retained_unowned');
    expect(existsSync(record.path)).toBe(true);
  }, 30000);

  it('rejects a linked source checkout before creating a managed worktree', async () => {
    const linked = join(root, 'linked-source');
    symlinkSync(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: linked, isolation: { kind: 'worktree' } }))
      .rejects.toThrow(/linked path/);
    expect(git(source, 'worktree', 'list', '--porcelain')).not.toContain(join(root, 'worktrees'));
  }, 30000);

  it('retains an unpushed commit', async () => {
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    git(record.path, 'config', 'user.email', 'test@example.com');
    git(record.path, 'config', 'user.name', 'Test');
    writeFileSync(join(record.path, 'file.txt'), 'committed\n');
    git(record.path, 'add', 'file.txt');
    git(record.path, 'commit', '-m', 'change');
    expect((await worktrees.remove(record.id)).outcome).toBe('retained_unpushed');
    expect(existsSync(record.path)).toBe(true);
  }, 30000);

  it('retains a new branch with unpushed commits after returning to the original branch', async () => {
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    git(record.path, 'config', 'user.email', 'test@example.com');
    git(record.path, 'config', 'user.name', 'Test');
    git(record.path, 'switch', '-c', 'alternate');
    writeFileSync(join(record.path, 'file.txt'), 'alternate\n');
    git(record.path, 'add', 'file.txt');
    git(record.path, 'commit', '-m', 'alternate change');
    git(record.path, 'switch', record.branch);
    expect((await worktrees.inspect(record.id)).unpushedCommits).toBe(1);
    expect((await worktrees.remove(record.id)).outcome).toBe('retained_unpushed');
    expect(existsSync(record.path)).toBe(true);
  }, 30000);

  it('retains commits on a pre-existing branch advanced in the worktree', async () => {
    git(source, 'branch', 'alternate');
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    git(record.path, 'config', 'user.email', 'test@example.com');
    git(record.path, 'config', 'user.name', 'Test');
    git(record.path, 'switch', 'alternate');
    writeFileSync(join(record.path, 'file.txt'), 'existing alternate\n');
    git(record.path, 'add', 'file.txt');
    git(record.path, 'commit', '-m', 'advance existing branch');
    git(record.path, 'switch', record.branch);
    expect((await worktrees.inspect(record.id)).unpushedCommits).toBe(1);
    expect((await worktrees.remove(record.id)).outcome).toBe('retained_unpushed');
  }, 30000);

  it('retains a custom ref created in the worktree after leaving detached HEAD', async () => {
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    git(record.path, 'config', 'user.email', 'test@example.com');
    git(record.path, 'config', 'user.name', 'Test');
    git(record.path, 'switch', '--detach');
    writeFileSync(join(record.path, 'file.txt'), 'custom ref\n');
    git(record.path, 'add', 'file.txt');
    git(record.path, 'commit', '-m', 'custom ref change');
    git(record.path, 'update-ref', 'refs/keep/demo', git(record.path, 'rev-parse', 'HEAD'));
    git(record.path, 'switch', record.branch);
    expect((await worktrees.inspect(record.id)).unpushedCommits).toBe(1);
    expect((await worktrees.remove(record.id)).outcome).toBe('retained_unpushed');
  }, 30000);

  it('retains an ignored file outside disposable directories', async () => {
    writeFileSync(join(source, '.gitignore'), 'node_modules/\nprivate.log\n');
    git(source, 'add', '.gitignore');
    git(source, 'commit', '-m', 'ignore private log');
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    writeFileSync(join(record.path, 'private.log'), 'retain');
    expect((await worktrees.remove(record.id)).outcome).toBe('retained_ignored');
    expect(existsSync(join(record.path, 'private.log'))).toBe(true);
  }, 30000);

  it('dry-run and actual cleanup agree for an old archived session', async () => {
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    const preview = await worktrees.gc(true);
    expect(preview).toEqual([{ id: record.id, outcome: 'removed' }]);
    expect(existsSync(record.path)).toBe(true);
    expect(await worktrees.gc(false)).toEqual(preview);
    expect(existsSync(record.path)).toBe(false);
  }, 30000);

  it('refuses to delete a worktree while its owner session is active', async () => {
    const record = await worktrees.create({ sessionId: 'session_test', workspaceId: 'workspace_test', sourceRoot: source, isolation: { kind: 'worktree' } });
    archived = false;
    expect((await worktrees.remove(record.id)).outcome).toBe('retained_in_use');
    expect(existsSync(record.path)).toBe(true);
  }, 30000);
});
