import { basename, isAbsolute } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IWorkspaceService, type Workspace, type WorkspaceUpdate } from './workspace';
import {
  collectAliasIds,
  dedupeByRoot,
  readSessionIndexEntries,
  readSessionIndexWorkDirs,
} from './workspaceAlias';
import { IWorkspacePersistence, type WorkspaceCatalog } from './workspacePersistence';

export class WorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined;

  private merged = false;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
  ) {}

  list(): Promise<readonly Workspace[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      return dedupeByRoot(byId);
    });
  }

  get(id: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      return catalog.workspaces.find((ws) => ws.id === id);
    });
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
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      const deletedIds = new Set(catalog.deletedIds);
      const id = encodeWorkDirKey(root);
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

  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
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

  delete(id: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      let root = catalog.workspaces.find((ws) => ws.id === id)?.root;
      if (root === undefined) {
        root = (await readSessionIndexEntries(this.storage)).find(
          (line) => encodeWorkDirKey(line.workDir) === id,
        )?.workDir;
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

  private async ensureMerged(): Promise<void> {
    if (this.merged) return;
    const loaded = await this.store.load();
    if (loaded === undefined) {
      const rebuilt = await this.rebuildFromSessionIndex();
      if (rebuilt.size === 0) await this.mergeFromSessions(rebuilt, new Set());
      await this.store.save({ workspaces: [...rebuilt.values()], deletedIds: [] });
      this.merged = true;
      return;
    }
    const byId = new Map(loaded.workspaces.map((ws) => [ws.id, ws]));
    const deletedIds = new Set(loaded.deletedIds);
    let changed = await this.mergeFromSessionIndex(byId, deletedIds);
    if (loaded.workspaces.length === 0 && byId.size === 0) {
      changed = (await this.mergeFromSessions(byId, deletedIds)) || changed;
    }
    if (changed) {
      await this.store.save({ workspaces: [...byId.values()], deletedIds: [...deletedIds] });
    }
    this.merged = true;
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
    for (const workDir of await readSessionIndexWorkDirs(this.storage)) {
      const id = encodeWorkDirKey(workDir);
      if (byId.has(id) || deletedIds.has(id)) continue;
      byId.set(id, {
        id,
        root: workDir,
        name: basename(workDir),
        createdAt: now,
        lastOpenedAt: now,
        pinned: false,
      });
      changed = true;
    }
    return changed;
  }

  private async rebuildFromSessionIndex(): Promise<Map<string, Workspace>> {
    const result = new Map<string, Workspace>();
    const now = Date.now();
    const seenRootKeys = new Set<string>();
    for (const entry of await readSessionIndexEntries(this.storage)) {
      if (!isAbsolute(entry.workDir)) continue;
      const rootKey = workspaceRootKey(entry.workDir);
      if (seenRootKeys.has(rootKey)) continue;
      seenRootKeys.add(rootKey);
      const id = encodeWorkDirKey(entry.workDir);
      result.set(id, {
        id,
        root: entry.workDir,
        name: basename(entry.workDir),
        createdAt: now,
        lastOpenedAt: now,
        pinned: false,
      });
    }
    return result;
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
        const root = session.cwd;
        if (root === undefined || !isAbsolute(root)) continue;
        const id = encodeWorkDirKey(root);
        const rootKey = workspaceRootKey(root);
        if (
          byId.has(id) ||
          deletedIds.has(id) ||
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

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceService,
  WorkspaceService,
  ScopeActivation.OnScopeCreated,
  'workspace',
);
