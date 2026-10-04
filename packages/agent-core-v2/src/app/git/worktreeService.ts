import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { WorktreeChanged } from './worktreeEvents';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { assertUnlinkedAncestors, canonicalPath, createWorktreeParent, insidePath, pathExists, pathKey, readOwnerMarker, readWorktreePointer, severLinksAndRemove, writeOwnerMarker } from '#/persistence/backends/node-fs/worktreeFiles';
import { IWorktreeService, type WorktreeInspection, type WorktreeIsolation, type WorktreeRecord, type WorktreeRemovalOutcome, type WorktreeRemovalRequest } from './worktreeModel';
import { WORKTREE_SECTION, type WorktreeConfig } from './worktreeConfig';

const SCOPE = 'worktrees';
const KEY = 'registry.json';
const GIT_ENV_UNSET = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
];

type Registry = { readonly version: 1; readonly records: Readonly<Record<string, WorktreeRecord>> };

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/, '') || 'session';
}

function parseWorktreeList(text: string): { path: string; lock?: string }[] {
  return text.trim().split(/\r?\n\r?\n/).map((block) => ({
    path: /^worktree (.+)$/m.exec(block)?.[1]?.trim() ?? '',
    lock: /^locked(?: (.*))?$/m.exec(block)?.[1]?.trim() ?? (/(?:^|\n)locked(?:\r?\n|$)/.test(block) ? '(unknown)' : undefined),
  })).filter((item) => item.path !== '');
}

export class WorktreeService implements IWorktreeService {
  declare readonly _serviceBrand: undefined;
  private operation: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IRuntimeResolver private readonly runtimes: IRuntimeResolver,
    @ISessionIndex private readonly sessions: ISessionIndex,
    @ISessionManager private readonly manager: ISessionManager,
    @IEventService private readonly events: IEventService,
  ) {
    void this.config.ready.then(() => {
      if (this.config.get<WorktreeConfig | undefined>(WORKTREE_SECTION)?.cleanup.auto !== true) return;
      void this.gc(false).catch(() => undefined);
      this.timer = setInterval(() => void this.gc(false).catch(() => undefined), 6 * 60 * 60 * 1000);
      this.timer.unref?.();
    });
  }

  dispose(): void { if (this.timer !== undefined) clearInterval(this.timer); }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.operation.then(fn, fn);
    this.operation = task.catch(() => undefined);
    return task;
  }

  private async registry(): Promise<Registry> {
    return (await this.docs.get<Registry>(SCOPE, KEY)) ?? { version: 1, records: {} };
  }

  private async save(record: WorktreeRecord): Promise<void> {
    await this.docs.update<Registry>(SCOPE, KEY, (previous) => ({
      version: 1, records: { ...previous?.records, [record.id]: record },
    }));
    this.events.publish(new WorktreeChanged({ payload: {
      sessionId: record.owner.sessionId, worktreeId: record.id,
      state: record.state, inspection: record.lastInspection,
    } }));
  }

  private async git(workspaceId: string, cwd: string, args: readonly string[], allowFailure = false): Promise<string> {
    const lease = this.runtimes.acquire({ workspaceId, runtimeId: 'local' }, ['process']);
    const safeArgs = ['-c', 'core.longpaths=true', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args];
    try {
      const proc = await lease.runtime.process!.spawn('git', safeArgs, {
        cwd, env: { GIT_TERMINAL_PROMPT: '0' }, envUnset: GIT_ENV_UNSET,
      });
      proc.stdin.end();
      const collect = async (stream: AsyncIterable<Uint8Array | string>): Promise<string> => {
        let output = '';
        for await (const chunk of stream) {
          output += chunk.toString();
          if (output.length > 16 * 1024 * 1024) throw new Error('git output exceeds limit');
        }
        return output;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = Promise.all([collect(proc.stdout), collect(proc.stderr), proc.wait()]);
        const limit = this.config.get<WorktreeConfig>(WORKTREE_SECTION).gitTimeoutMs;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`git command timed out: ${args[0]}`)), limit);
        });
        const [stdout, stderr, exitCode] = await Promise.race([work, timeout]).catch(async (error) => {
          await proc.kill('SIGKILL');
          await work.catch(() => undefined);
          throw error;
        });
        if (exitCode !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')}: ${stderr.trim() || `exit ${exitCode}`}`);
        return exitCode === 0 ? stdout.trim() : '';
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        await proc.dispose();
      }
    } finally { lease.dispose(); }
  }

  async list(query?: { workspaceId?: string; state?: WorktreeRecord['state'] }): Promise<readonly WorktreeRecord[]> {
    const records = Object.values((await this.registry()).records);
    return records.filter((record) => (query?.workspaceId === undefined || record.repo.workspaceId === query.workspaceId) &&
      (query?.state === undefined || record.state === query.state));
  }

  async get(id: string): Promise<WorktreeRecord | undefined> { return (await this.registry()).records[id]; }

  async forPath(path: string): Promise<WorktreeRecord | undefined> {
    return (await this.list()).find((record) => record.state !== 'removed' && insidePath(path, record.path));
  }

  async create(input: { sessionId: string; workspaceId: string; sourceRoot: string; title?: string; isolation: WorktreeIsolation }): Promise<WorktreeRecord> {
    return this.exclusive(async () => {
      await this.config.ready;
      const config = this.config.get<WorktreeConfig>(WORKTREE_SECTION);
      if (!config.enabled) throw new Error('WORKTREE_DISABLED');
      await assertUnlinkedAncestors(input.sourceRoot);
      const sourceRoot = await canonicalPath(input.sourceRoot);
      await assertUnlinkedAncestors(sourceRoot);
      const commonDir = resolve(sourceRoot, await this.git(input.workspaceId, sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      const actualRoot = await this.git(input.workspaceId, sourceRoot, ['rev-parse', '--show-toplevel']);
      if (pathKey(actualRoot) !== pathKey(sourceRoot)) throw new Error('worktree source must be a git root');
      await this.git(input.workspaceId, sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
      const fingerprint = createHash('sha256').update(pathKey(commonDir)).digest('hex').slice(0, 8);
      const root = config.root || join(this.bootstrap.homeDir, 'worktrees');
      if (!isAbsolute(root) || insidePath(root, sourceRoot) || insidePath(sourceRoot, root)) throw new Error('worktree root overlaps source checkout');
      const base = input.isolation.base ?? config.defaultBase;
      let baseRef: string;
      if (base === 'head') baseRef = 'HEAD';
      else if (base === 'fresh') {
        const candidates = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];
        baseRef = '';
        for (const candidate of candidates) {
          if (await this.git(input.workspaceId, sourceRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], true)) { baseRef = candidate; break; }
        }
        if (baseRef === '') throw new Error('no fresh base found');
      } else baseRef = base.ref;
      const commit = await this.git(input.workspaceId, sourceRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
      let branch = input.isolation.branch;
      if (branch === undefined) branch = `${config.branchPrefix}${slugify(input.title ?? '')}-${randomBytes(3).toString('hex')}`;
      if (branch.length > 40 || branch.startsWith('-') || branch === 'HEAD' ||
        !(await this.git(input.workspaceId, sourceRoot, ['check-ref-format', '--branch', branch], true))) throw new Error('invalid worktree branch');
      const existing = await this.git(input.workspaceId, sourceRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true);
      const branchCreated = existing === '';
      const refBaseline = Object.fromEntries((await this.git(input.workspaceId, sourceRoot,
        ['for-each-ref', '--format=%(refname) %(objectname)', 'refs']))
        .split('\n').filter(Boolean).map((line) => {
          const [ref, tip] = line.split(' ');
          return [ref!, tip!] as const;
        }));
      const id = `wt_${randomBytes(8).toString('hex')}`;
      const path = join(root, fingerprint, randomBytes(2).toString('hex'));
      await createWorktreeParent(path);
      const now = Date.now();
      const record: WorktreeRecord = {
        id, version: 1, repo: { fingerprint, commonDir, sourceRoot, workspaceId: input.workspaceId }, path, branch, branchCreated, refBaseline,
        base: { mode: base === 'head' ? 'head' : base === 'fresh' ? 'fresh' : 'ref', ref: baseRef, commit },
        owner: { kind: 'session', sessionId: input.sessionId }, state: 'creating', createdAt: now, updatedAt: now,
      };
      const registered = parseWorktreeList(await this.git(input.workspaceId, sourceRoot, ['worktree', 'list', '--porcelain']));
      if (registered.some((entry) => pathKey(entry.path) === pathKey(path))) throw new Error('worktree path already registered');
      if (registered.some((entry) => entry.path !== sourceRoot && entry.lock === branch)) throw new Error('branch is locked');
      await this.git(input.workspaceId, sourceRoot, ['worktree', 'add', ...(branchCreated ? ['-b', branch, path, commit] : [path, branch])]);
      try {
        const controlDir = await readWorktreePointer(path);
        if (controlDir === undefined || !insidePath(controlDir, join(commonDir, 'worktrees'))) throw new Error('new worktree has no valid git control directory');
        await assertUnlinkedAncestors(controlDir);
        await writeOwnerMarker(join(controlDir, 'kiki-owner.json'), { version: 1, worktreeId: id, sessionId: input.sessionId, createdAt: now });
        await this.save(record);
      } catch (error) {
        throw new Error(`worktree registration failed; checkout retained at ${path}: ${String(error)}`);
      }
      try {
        await this.git(input.workspaceId, sourceRoot, ['worktree', 'lock', '--reason', `kiki:${id}`, path]);
        await this.save({ ...record, state: 'ready' });
      } catch (error) {
        const outcome = await this.removeInner(id, { deleteBranch: true }, 'user');
        if (outcome.outcome !== 'removed') throw new Error(`worktree creation failed; checkout retained at ${path}: ${String(error)}`);
        throw error;
      }
      return { ...record, state: 'ready' };
    });
  }

  async inspect(id: string): Promise<WorktreeInspection> {
    return this.exclusive(async () => {
      const record = await this.get(id);
      if (record === undefined) throw new Error(`worktree not found: ${id}`);
      const inspection = await this.measure(record);
      await this.save({ ...record, lastInspection: inspection, updatedAt: Date.now() });
      return inspection;
    });
  }

  private async measure(record: WorktreeRecord): Promise<WorktreeInspection> {
    const initial: WorktreeInspection = { inspectedAt: Date.now(), failed: true, dirtyFiles: 0, untrackedFiles: 0, aheadOfBase: 0, unpushedCommits: 0, ignoredNonDisposable: [] };
    try {
      const { workspaceId } = record.repo;
      const status = await this.git(workspaceId, record.path, ['status', '--porcelain=v1', '--untracked-files=all', '-z']);
      const dirty = status.split('\0').filter(Boolean);
      const ahead = await this.git(workspaceId, record.path, ['rev-list', '--count', `${record.base.commit}..HEAD`]);
      const refs = (await this.git(workspaceId, record.path,
        ['for-each-ref', '--format=%(refname) %(objectname)', 'refs']))
        .split('\n').filter(Boolean).map((line) => {
          const [ref, tip] = line.split(' ');
          return [ref!, tip!] as const;
        }).filter(([ref]) => !ref.startsWith('refs/remotes/'));
      const ownedRefs = refs.filter(([ref, tip]) => ref === `refs/heads/${record.branch}` ||
        record.refBaseline === undefined || record.refBaseline[ref] !== tip).map(([ref]) => ref);
      const unpushed = await this.git(workspaceId, record.path,
        ['rev-list', '--count', 'HEAD', ...ownedRefs, '--not', record.base.commit, '--remotes']);
      const ignored = await this.git(workspaceId, record.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
      const disposable = this.config.get<WorktreeConfig>(WORKTREE_SECTION).cleanup.disposableIgnored;
      const nonDisposable = ignored.split('\0').filter(Boolean).filter((name) => !disposable.some((pattern) => {
        const path = name.replace(/\\/g, '/');
        return !pattern.includes('..') && !pattern.startsWith('/') && pattern.endsWith('/') && path.startsWith(pattern);
      }));
      const entry = parseWorktreeList(await this.git(workspaceId, record.repo.sourceRoot, ['worktree', 'list', '--porcelain']))
        .find((item) => pathKey(item.path) === pathKey(record.path));
      return { ...initial, failed: false, dirtyFiles: dirty.length, untrackedFiles: dirty.filter((line) => line.startsWith('??')).length,
        aheadOfBase: Number(ahead), unpushedCommits: Number(unpushed), ignoredNonDisposable: [...new Set(nonDisposable.map((path) => path.split('/')[0]!))].slice(0, 50),
        foreignLock: entry?.lock !== undefined && entry.lock !== `kiki:${record.id}` ? entry.lock : undefined };
    } catch { return initial; }
  }

  async remove(id: string, request: WorktreeRemovalRequest = {}, trigger: 'user' | 'gc' = 'user'): Promise<{ outcome: WorktreeRemovalOutcome }> {
    return this.exclusive(() => this.removeInner(id, request, trigger));
  }

  private async removeInner(id: string, request: WorktreeRemovalRequest, trigger: 'user' | 'gc', dryRun = false): Promise<{ outcome: WorktreeRemovalOutcome }> {
    const record = await this.get(id);
    if (record === undefined) return { outcome: 'retained_unowned' };
    const finish = async (outcome: WorktreeRemovalOutcome): Promise<{ outcome: WorktreeRemovalOutcome }> => {
      if (dryRun) return { outcome };
      await this.save({ ...record, state: outcome === 'removed' ? 'removed' : outcome.startsWith('failed') ? 'remove_failed' : record.state,
        removal: { requestedAt: Date.now(), trigger, outcome }, updatedAt: Date.now() });
      return { outcome };
    };
    if (record.state === 'removed') return { outcome: 'removed' };
    return finish(await this.removeOutcome(id, record, request, trigger, dryRun));
  }

  private async removeOutcome(id: string, record: WorktreeRecord, request: WorktreeRemovalRequest, trigger: 'user' | 'gc', dryRun: boolean): Promise<WorktreeRemovalOutcome> {
    try {
      await assertUnlinkedAncestors(record.path);
      if (pathKey(record.path) === pathKey(record.repo.sourceRoot) ||
        !insidePath(record.path, join(this.config.get<WorktreeConfig>(WORKTREE_SECTION).root || join(this.bootstrap.homeDir, 'worktrees'), record.repo.fingerprint))) return 'retained_unowned';
      if (this.manager.list().some((session) => insidePath(session.accessor.get(ISessionContext).cwd, record.path))) return 'retained_in_use';
      const summary = await this.sessions.get(record.owner.sessionId);
      if (summary !== undefined && !summary.archived) return 'retained_in_use';
      if (!await pathExists(record.path)) return 'retained_unowned';
      const controlDir = await readWorktreePointer(record.path);
      if (controlDir === undefined || !insidePath(controlDir, join(record.repo.commonDir, 'worktrees'))) return 'retained_unowned';
      await assertUnlinkedAncestors(controlDir);
      const marker = await readOwnerMarker(join(controlDir, 'kiki-owner.json')).catch(() => undefined) as
        { version?: unknown; worktreeId?: unknown; sessionId?: unknown; createdAt?: unknown } | undefined;
      if (marker?.version !== 1 || marker.worktreeId !== id || marker.sessionId !== record.owner.sessionId || marker.createdAt !== record.createdAt) return 'retained_unowned';
      const commonDir = resolve(record.path, await this.git(record.repo.workspaceId, record.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      if (pathKey(commonDir) !== pathKey(record.repo.commonDir)) return 'retained_unowned';
      const listed = parseWorktreeList(await this.git(record.repo.workspaceId, record.repo.sourceRoot, ['worktree', 'list', '--porcelain']))
        .find((item) => pathKey(item.path) === pathKey(record.path));
      if (listed === undefined) return 'retained_unowned';
      if (listed.lock !== undefined && listed.lock !== `kiki:${id}`) return 'retained_foreign_lock';
      const previous = record.lastInspection;
      const inspection = await this.measure(record);
      if (inspection.failed) return 'failed';
      const loss = { dirty: inspection.dirtyFiles > 0, ignored: inspection.ignoredNonDisposable.length > 0, unpushed: inspection.unpushedCommits > 0 };
      if (trigger === 'user' && request.confirmLoss !== undefined && (previous === undefined || previous.failed ||
        previous.dirtyFiles !== inspection.dirtyFiles || previous.untrackedFiles !== inspection.untrackedFiles ||
        previous.unpushedCommits !== inspection.unpushedCommits || JSON.stringify(previous.ignoredNonDisposable) !== JSON.stringify(inspection.ignoredNonDisposable) ||
        Object.entries(loss).some(([key, value]) => request.confirmLoss?.[key as keyof typeof loss] !== value))) throw new Error('worktree inspection changed; inspect again before confirming loss');
      if (loss.dirty && request.confirmLoss?.dirty !== true) return 'retained_dirty';
      if (loss.unpushed && request.confirmLoss?.unpushed !== true) return 'retained_unpushed';
      if (loss.ignored && request.confirmLoss?.ignored !== true) return 'retained_ignored';
      if (trigger === 'user' && request.confirmLoss !== undefined &&
        (previous?.inspectedAt === undefined || Date.now() - previous.inspectedAt > 30_000)) throw new Error('worktree inspection expired; inspect again before confirming loss');
      if (dryRun) return 'removed';
      await this.save({ ...record, state: 'removing', updatedAt: Date.now() });
      await this.git(record.repo.workspaceId, record.path, ['fsmonitor--daemon', 'stop'], true);
      await assertUnlinkedAncestors(record.path);
      await severLinksAndRemove(record.path);
      if (listed.lock === `kiki:${id}`) await this.git(record.repo.workspaceId, record.repo.sourceRoot, ['worktree', 'unlock', record.path], true);
      await this.git(record.repo.workspaceId, record.repo.sourceRoot, ['worktree', 'prune']);
      if (await pathExists(record.path)) throw new Error('worktree remains after removal');
      if (parseWorktreeList(await this.git(record.repo.workspaceId, record.repo.sourceRoot, ['worktree', 'list', '--porcelain']))
        .some((entry) => pathKey(entry.path) === pathKey(record.path))) throw new Error('worktree remains registered after prune');
      if (request.deleteBranch !== false && record.branchCreated) {
        const tip = await this.git(record.repo.workspaceId, record.repo.sourceRoot, ['rev-parse', record.branch], true);
        const mergedBase = await this.git(record.repo.workspaceId, record.repo.sourceRoot, ['merge-base', record.branch, record.base.ref], true);
        if (tip === record.base.commit || tip !== '' && tip === mergedBase) {
          await this.git(record.repo.workspaceId, record.repo.sourceRoot, ['branch', '-d', record.branch], true);
        }
      }
      return 'removed';
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('worktree inspection ')) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      return ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '') ? 'failed_busy' : 'failed';
    }
  }

  async gc(dryRun: boolean): Promise<readonly { id: string; outcome: WorktreeRemovalOutcome }[]> {
    await this.config.ready;
    const config = this.config.get<WorktreeConfig>(WORKTREE_SECTION);
    const candidates: { id: string; outcome: WorktreeRemovalOutcome }[] = [];
    for (const record of await this.list()) {
      if (!['ready', 'remove_failed'].includes(record.state)) continue;
      const session = await this.sessions.get(record.owner.sessionId);
      if (session !== undefined && !session.archived) continue;
      const archivedAt = session?.archivedAt ?? session?.updatedAt ?? record.updatedAt;
      if (Date.now() - archivedAt < config.cleanup.afterDays * 86_400_000) continue;
      const result = dryRun
        ? await this.exclusive(() => this.removeInner(record.id, {}, 'gc', true))
        : await this.remove(record.id, {}, 'gc');
      candidates.push({ id: record.id, outcome: result.outcome });
    }
    return candidates;
  }
}

registerScopedService(LifecycleScope.App, IWorktreeService, WorktreeService, ScopeActivation.OnScopeCreated, 'worktree');
