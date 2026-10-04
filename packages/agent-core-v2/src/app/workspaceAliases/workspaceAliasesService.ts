import { LifecycleScope } from '#/app/scopes';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  workspaceIdFromSessionDir,
  workspaceRootKey,
  workDirKeyAliases,
} from '#/_base/utils/workdir-slug';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import {
  readSessionIndexEntries,
  SESSION_INDEX_KEY,
  SESSION_INDEX_SCOPE,
} from '#/app/workspace/workspaceAlias';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IWorkspaceAliases } from './workspaceAliases';

interface CatalogSnapshot {
  readonly byId: ReadonlyMap<string, Workspace>;
  readonly idsByRootKey: ReadonlyMap<string, readonly string[]>;
}

interface SessionIndexSnapshot {
  readonly idsByRootKey: ReadonlyMap<string, readonly string[]>;
  readonly rootKeyById: ReadonlyMap<string, string>;
}

function rootKeyIndex<T>(
  items: readonly T[],
  rootOf: (item: T) => string,
  idOf: (item: T) => string,
): Map<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const key = workspaceRootKey(rootOf(item));
    const id = idOf(item);
    const bucket = map.get(key);
    if (bucket === undefined) {
      map.set(key, [id]);
    } else if (!bucket.includes(id)) {
      bucket.push(id);
    }
  }
  return map;
}

export class WorkspaceAliasesService extends Disposable implements IWorkspaceAliases {
  declare readonly _serviceBrand: undefined;

  private catalogCache: CatalogSnapshot | undefined;
  private sessionIndexCache: { snapshot: SessionIndexSnapshot; size: number | undefined } | undefined;
  private catalogPromise:
    | Promise<{ snapshot: CatalogSnapshot; generation: number }>
    | undefined;
  private sessionIndexPromise:
    | Promise<{ snapshot: SessionIndexSnapshot; generation: number }>
    | undefined;
  private invalidationGeneration = 0;
  private catalogMergePrimed = false;

  constructor(
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAppendLogStore private readonly appendLogs: IAppendLogStore,
  ) {
    super();
    this._register(
      this.store.onDidChange(() => {
        this.invalidationGeneration += 1;
        this.catalogCache = undefined;
      }),
    );
    this._register(
      this.appendLogs.onDidWrite((write) => {
        if (write.scope === SESSION_INDEX_SCOPE && write.key === SESSION_INDEX_KEY) {
          this.invalidationGeneration += 1;
          this.sessionIndexCache = undefined;
        }
      }),
    );
  }

  async resolveAliasIds(id: string): Promise<readonly string[]> {
    for (;;) {
      const generation = this.invalidationGeneration;
      const [catalog, index] = await Promise.all([this.catalog(), this.sessionIndex()]);
      if (generation !== this.invalidationGeneration) continue;
      const entry = catalog.byId.get(id);
      const rootKey = entry === undefined ? index.rootKeyById.get(id) : workspaceRootKey(entry.root);
      if (rootKey === undefined) return [id];
      const fromCatalog = catalog.idsByRootKey.get(rootKey);
      const fromIndex = index.idsByRootKey.get(rootKey);
      if (fromCatalog === undefined) return fromIndex ?? [id];
      if (fromIndex === undefined) return fromCatalog;
      const merged = [...fromCatalog];
      for (const alias of fromIndex) {
        if (!merged.includes(alias)) merged.push(alias);
      }
      return merged;
    }
  }

  private async catalog(): Promise<CatalogSnapshot> {
    if (this.catalogCache !== undefined) return this.catalogCache;
    this.catalogPromise ??= this.loadCatalog();
    const { snapshot, generation } = await this.catalogPromise;
    if (generation !== this.invalidationGeneration) return this.catalog();
    return snapshot;
  }

  private async loadCatalog(): Promise<{ snapshot: CatalogSnapshot; generation: number }> {
    try {
      if (!this.catalogMergePrimed) {
        await this.workspaces.list();
        this.catalogMergePrimed = true;
      }
      const generation = this.invalidationGeneration;
      const workspaces = (await this.store.load())?.workspaces ?? [];
      const snapshot: CatalogSnapshot = {
        byId: new Map(workspaces.map((ws) => [ws.id, ws] as const)),
        idsByRootKey: rootKeyIndex(
          workspaces,
          (ws) => ws.root,
          (ws) => ws.id,
        ),
      };
      if (generation === this.invalidationGeneration) {
        this.catalogCache = snapshot;
      }
      return { snapshot, generation };
    } finally {
      this.catalogPromise = undefined;
    }
  }

  private async sessionIndex(): Promise<SessionIndexSnapshot> {
    const cache = this.sessionIndexCache;
    if (
      cache !== undefined &&
      (await this.storage.size(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY)) === cache.size
    ) {
      return cache.snapshot;
    }
    this.sessionIndexPromise ??= this.loadSessionIndex();
    const { snapshot, generation } = await this.sessionIndexPromise;
    if (generation !== this.invalidationGeneration) return this.sessionIndex();
    return snapshot;
  }

  private async loadSessionIndex(): Promise<{ snapshot: SessionIndexSnapshot; generation: number }> {
    try {
      const generation = this.invalidationGeneration;
      const entries = await readSessionIndexEntries(this.storage);
      const idsByRootKey = new Map<string, string[]>();
      for (const entry of entries) {
        const root = entry.sourceRoot ?? entry.workDir;
        const key = workspaceRootKey(root);
        const ids = idsByRootKey.get(key) ?? [];
        for (const alias of workDirKeyAliases(root)) {
          if (!ids.includes(alias)) ids.push(alias);
        }
        const storageId = workspaceIdFromSessionDir(entry.sessionDir);
        if (storageId !== undefined && !ids.includes(storageId)) ids.push(storageId);
        idsByRootKey.set(key, ids);
      }
      const rootsById = new Map<string, Set<string>>();
      for (const [rootKey, ids] of idsByRootKey) {
        for (const id of ids) {
          const roots = rootsById.get(id) ?? new Set<string>();
          roots.add(rootKey);
          rootsById.set(id, roots);
        }
      }
      const rootKeyById = new Map<string, string>();
      for (const [id, roots] of rootsById) {
        if (roots.size === 1) rootKeyById.set(id, [...roots][0]!);
      }
      for (const [rootKey, ids] of idsByRootKey) {
        idsByRootKey.set(rootKey, ids.filter((id) => rootKeyById.get(id) === rootKey));
      }
      const snapshot: SessionIndexSnapshot = { idsByRootKey, rootKeyById };
      if (generation === this.invalidationGeneration) {
        this.sessionIndexCache = {
          snapshot,
          size: await this.storage.size(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY),
        };
      }
      return { snapshot, generation };
    } finally {
      this.sessionIndexPromise = undefined;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceAliases,
  WorkspaceAliasesService,
  ScopeActivation.OnScopeCreated,
  'workspaceAliases',
);
