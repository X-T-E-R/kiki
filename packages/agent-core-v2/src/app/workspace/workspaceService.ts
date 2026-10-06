import { basename, isAbsolute } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  encodeWorkDirKey,
  isWorkDirKeyForRoot,
  workspaceIdFromSessionDir,
  workspaceRootKey,
  workDirKeyAliases,
} from '#/_base/utils/workdir-slug';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IWorkspaceService, type Workspace, type WorkspaceUpdate } from './workspace';
import {
  collectAliasIds,
  dedupeByRoot,
  readSessionIndexEntries,
} from './workspaceAlias';
import { IWorkspacePersistence, type WorkspaceCatalog } from './workspacePersistence';

export class WorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined;

  private merged = false;
  private merging: Promise<void> | undefined;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
  ) {}

  async list(): Promise<readonly Workspace[]> {
    await this.ensureMerged();
    const catalog = await this.loadCatalog();
    return dedupeByRoot(new Map(catalog.workspaces.map((ws) => [ws.id, ws])));
  }

  async get(id: string): Promise<Workspace | undefined> {
    const stored = (await this.loadCatalog()).workspaces.find((ws) => ws.id === id);
    if (stored !== undefined) return stored;
    await this.ensureMerged();
    return (await this.loadCatalog()).workspaces.find((ws) => ws.id === id);
  }

  createOrTouch(root: string, name?: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      let stat;
      try {
        stat = await this.hostFs.stat(root);
      } catch (error) {
        const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} does not exist`);
        }
        throw error;
      }
      if (!stat.isDirectory) {
        try {
          stat = await this.hostFs.stat(await this.hostFs.realpath(root));
        } catch {
        }
      }
      if (!stat.isDirectory) {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
      }
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      const deletedIds = new Set(catalog.deletedIds);
      let id = encodeWorkDirKey(root);
      let existing = byId.get(id);
      if (existing === undefined) {
        const rootKey = workspaceRootKey(root);
        for (const entry of byId.values()) {
          if (workspaceRootKey(entry.root) === rootKey) {
            existing = entry;
            break;
          }
        }
      }
      if (existing === undefined) {
        const storedId = await this.findStoredWorkspaceId(root);
        if (storedId !== undefined) {
          id = storedId;
          existing = byId.get(storedId);
        }
      }
      const now = Date.now();
      const ws: Workspace =
        existing !== undefined
          ? { ...existing, lastOpenedAt: now }
          : {
              id,
              root,
              name: name ?? basename(root),
              createdAt: now,
              lastOpenedAt: now,
              pinned: false,
            };
      byId.set(ws.id, ws);
      deletedIds.delete(ws.id);
      await this.store.save({ workspaces: [...byId.values()], deletedIds: [...deletedIds] });
      return ws;
    });
  }

  async update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    await this.ensureMerged();
    return this.runExclusive(async () => {
      const catalog = await this.loadCatalog();
      const existing = catalog.workspaces.find((ws) => ws.id === id);
      if (existing === undefined) return undefined;
      const updated: Workspace = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      };
      await this.store.save({
        workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated : ws)),
        deletedIds: catalog.deletedIds,
      });
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.ensureMerged();
    return this.runExclusive(async () => {
      const catalog = await this.loadCatalog();
      let root = catalog.workspaces.find((ws) => ws.id === id)?.root;
      if (root === undefined) {
        const entry = (await readSessionIndexEntries(this.storage)).find(
          (line) => isWorkDirKeyForRoot(id, line.sourceRoot ?? line.workDir),
        );
        root = entry?.sourceRoot ?? entry?.workDir;
      }
      if (root === undefined) {
        await this.store.save({
          workspaces: catalog.workspaces.filter((ws) => ws.id !== id),
          deletedIds: [...new Set([...catalog.deletedIds, id])],
        });
        return;
      }
      const rootKey = workspaceRootKey(root);
      const aliasIds = collectAliasIds(
        catalog.workspaces,
        await readSessionIndexEntries(this.storage),
        root,
      );
      await this.store.save({
        workspaces: catalog.workspaces.filter((ws) => workspaceRootKey(ws.root) !== rootKey),
        deletedIds: [...new Set([...catalog.deletedIds, ...aliasIds])],
      });
    });
  }

  private ensureMerged(): Promise<void> {
    if (this.merged) return Promise.resolve();
    if (this.merging !== undefined) return this.merging;
    this.merging = this.mergeCatalog().finally(() => { this.merging = undefined; });
    return this.merging;
  }

  private async mergeCatalog(): Promise<void> {
    const loaded = await this.loadCatalog();
    const discovered = new Map<string, Workspace>();
    const deletedIds = new Set(loaded.deletedIds);
    await this.mergeFromSessionIndex(discovered, deletedIds);
    if (loaded.workspaces.length === 0 && discovered.size === 0) await this.mergeFromSessions(discovered, deletedIds);
    await this.runExclusive(async () => {
      const current = await this.loadCatalog();
      const byId = new Map(current.workspaces.map((ws) => [ws.id, ws]));
      const deleted = new Set(current.deletedIds);
      const roots = new Set(current.workspaces.map((ws) => workspaceRootKey(ws.root)));
      let changed = false;
      for (const [id, workspace] of discovered) {
        if (byId.has(id) || roots.has(workspaceRootKey(workspace.root)) || deleted.has(id)
          || workDirKeyAliases(workspace.root).some((alias) => deleted.has(alias))) continue;
        byId.set(id, workspace);
        roots.add(workspaceRootKey(workspace.root));
        changed = true;
      }
      if (changed) await this.store.save({ workspaces: [...byId.values()], deletedIds: current.deletedIds });
      this.merged = true;
    });
  }

  private async loadCatalog(): Promise<WorkspaceCatalog> {
    return (await this.store.load()) ?? { workspaces: [], deletedIds: [] };
  }

  private async mergeFromSessionIndex(
    byId: Map<string, Workspace>,
    deletedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    const seenRootKeys = new Set([...byId.values()].map((workspace) => workspaceRootKey(workspace.root)));
    for (const entry of await readSessionIndexEntries(this.storage)) {
      const root = entry.sourceRoot ?? entry.workDir;
      if (!isAbsolute(root)) continue;
      const rootKey = workspaceRootKey(root);
      if (seenRootKeys.has(rootKey)) continue;
      const id = workspaceIdForRoot(root, workspaceIdFromSessionDir(entry.sessionDir));
      if (workDirKeyAliases(root).some((alias) => deletedIds.has(alias))) continue;
      seenRootKeys.add(rootKey);
      byId.set(id, {
        id,
        root,
        name: basename(root),
        createdAt: now,
        lastOpenedAt: now,
        pinned: false,
      });
      changed = true;
    }
    return changed;
  }

  private async mergeFromSessions(
    byId: Map<string, Workspace>,
    deletedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    let before: string | undefined;
    const now = Date.now();
    const seenRootKeys = new Set(
      [...byId.values()].map((workspace) => workspaceRootKey(workspace.root)),
    );
    do {
      const page = await this.sessionIndex.listRecent({
        includeArchived: true,
        limit: 100,
        before,
      });
      for (const session of page.items) {
        const root = session.worktree?.sourceRoot ?? session.cwd;
        if (root === undefined || !isAbsolute(root)) continue;
        const id = workspaceIdForRoot(root, session.workspaceId);
        const rootKey = workspaceRootKey(root);
        if (
          byId.has(id) ||
          workDirKeyAliases(root).some((alias) => deletedIds.has(alias)) ||
          deletedIds.has(session.workspaceId) ||
          seenRootKeys.has(rootKey)
        ) {
          continue;
        }
        seenRootKeys.add(rootKey);
        byId.set(id, {
          id,
          root,
          name: basename(root),
          createdAt: now,
          lastOpenedAt: now,
          pinned: false,
        });
        changed = true;
      }
      if (page.nextCursor === before) break;
      before = page.nextCursor;
    } while (before !== undefined);
    return changed;
  }

  private async findStoredWorkspaceId(root: string): Promise<string | undefined> {
    const aliases = workDirKeyAliases(root).slice(1);
    if (aliases.length === 0) return undefined;
    let stored: readonly string[];
    try {
      stored = await this.storage.list('sessions');
    } catch {
      return undefined;
    }
    return aliases.find((id) => stored.includes(id));
  }

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

function workspaceIdForRoot(root: string, storedId: string | undefined): string {
  return storedId !== undefined && isWorkDirKeyForRoot(storedId, root)
    ? storedId
    : encodeWorkDirKey(root);
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceService,
  WorkspaceService,
  ScopeActivation.OnScopeCreated,
  'workspace',
);
