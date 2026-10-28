import { LifecycleScope } from '#/app/scopes';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { Workspace } from './workspace';
import {
  IWorkspacePersistence,
  type PersistedWorkspaceEntry,
  type PersistedWorkspaceFile,
  type WorkspaceCatalog,
} from './workspacePersistence';

const WORKSPACE_CATALOG_VERSION = 1;
const WORKSPACE_CATALOG_SCOPE = '';
const WORKSPACE_CATALOG_KEY = 'workspaces.json';

export class FileWorkspacePersistence extends Disposable implements IWorkspacePersistence {
  declare readonly _serviceBrand: undefined;

  private readonly changeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.changeEmitter.event;

  private generation = 0;
  private cached: { readonly fingerprint: string; readonly catalog: WorkspaceCatalog | undefined } | undefined;
  private loading: Promise<WorkspaceCatalog | undefined> | undefined;

  constructor(
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {
    super();
    this._register(
      this.docs.watch(WORKSPACE_CATALOG_SCOPE, WORKSPACE_CATALOG_KEY)(() => this.invalidate()),
    );
  }

  load(): Promise<WorkspaceCatalog | undefined> {
    if (this.loading !== undefined) return this.loading;
    const loading = this.loadCurrent();
    this.loading = loading;
    void loading.finally(() => { if (this.loading === loading) this.loading = undefined; }).catch(() => {});
    return loading;
  }

  private invalidate(notify = true): void {
    this.generation++;
    this.cached = undefined;
    if (notify) this.changeEmitter.fire();
  }

  private async fingerprint(): Promise<string> {
    const [size, mtime] = await Promise.all([
      this.storage.size(WORKSPACE_CATALOG_SCOPE, WORKSPACE_CATALOG_KEY),
      this.storage.mtime(WORKSPACE_CATALOG_SCOPE, WORKSPACE_CATALOG_KEY),
    ]);
    return `${size}:${mtime}`;
  }

  private async loadCurrent(): Promise<WorkspaceCatalog | undefined> {
    for (;;) {
      const generation = this.generation;
      const before = await this.fingerprint();
      if (generation !== this.generation) continue;
      if (this.cached?.fingerprint === before) return this.cached.catalog;
      const catalog = await this.readCatalog();
      const after = await this.fingerprint();
      if (generation !== this.generation || before !== after) continue;
      this.cached = { fingerprint: after, catalog };
      return catalog;
    }
  }

  private async readCatalog(): Promise<WorkspaceCatalog | undefined> {
    const file = await this.docs.get<PersistedWorkspaceFile>(
      WORKSPACE_CATALOG_SCOPE,
      WORKSPACE_CATALOG_KEY,
    );
    if (file === undefined) return undefined;
    if (
      typeof file !== 'object' ||
      file === null ||
      typeof (file as { workspaces?: unknown }).workspaces !== 'object' ||
      (file as { workspaces?: unknown }).workspaces === null
    ) {
      return undefined;
    }
    const now = Date.now();
    const workspaces: Workspace[] = [];
    for (const [id, raw] of Object.entries(file.workspaces)) {
      const entry = sanitizeEntry(raw);
      if (entry === null) continue;
      workspaces.push({
        id,
        root: entry.root,
        name: entry.name,
        createdAt: parseTime(entry.created_at, now),
        lastOpenedAt: parseTime(entry.last_opened_at, now),
        pinned: entry.pinned === true,
      });
    }
    const rawDeleted = (file as { deleted_workspace_ids?: unknown }).deleted_workspace_ids;
    const deletedIds = Array.isArray(rawDeleted)
      ? rawDeleted.filter((id): id is string => typeof id === 'string')
      : [];
    return Object.freeze({ workspaces: Object.freeze(workspaces.map((workspace) => Object.freeze(workspace))), deletedIds: Object.freeze(deletedIds) });
  }

  async save(catalog: WorkspaceCatalog): Promise<void> {
    const record: Record<string, PersistedWorkspaceEntry> = {};
    for (const ws of catalog.workspaces) {
      record[ws.id] = {
        root: ws.root,
        name: ws.name,
        created_at: new Date(ws.createdAt).toISOString(),
        last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
        ...(ws.pinned ? { pinned: true } : {}),
      };
    }
    const file: PersistedWorkspaceFile = {
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: record,
      deleted_workspace_ids: [...catalog.deletedIds],
    };
    this.invalidate(false);
    let committed = false;
    try {
      await this.docs.set(WORKSPACE_CATALOG_SCOPE, WORKSPACE_CATALOG_KEY, file);
      committed = true;
    } finally {
      this.invalidate(committed);
    }
  }
}

function sanitizeEntry(value: unknown): PersistedWorkspaceEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<PersistedWorkspaceEntry>;
  if (
    typeof v.root !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.created_at !== 'string' ||
    typeof v.last_opened_at !== 'string'
  ) {
    return null;
  }
  return {
    root: v.root,
    name: v.name,
    created_at: v.created_at,
    last_opened_at: v.last_opened_at,
    ...(v.pinned === true ? { pinned: true } : {}),
  };
}

function parseTime(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

registerScopedService(
  LifecycleScope.App,
  IWorkspacePersistence,
  FileWorkspacePersistence,
  ScopeActivation.OnScopeCreated,
  'workspace',
);
