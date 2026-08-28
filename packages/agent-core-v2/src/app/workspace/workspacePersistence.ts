import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { Workspace } from './workspace';

export interface PersistedWorkspaceEntry {
  readonly root: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_opened_at: string;
  /** Omitted for unpinned entries, so catalogs written by older builds load
   * unchanged and the file stays free of `false` noise. */
  readonly pinned?: boolean;
}

export interface PersistedWorkspaceFile {
  readonly version: number;
  readonly workspaces: Record<string, PersistedWorkspaceEntry>;
  readonly deleted_workspace_ids: string[];
}

export interface WorkspaceCatalog {
  readonly workspaces: readonly Workspace[];
  readonly deletedIds: readonly string[];
}

export interface IWorkspacePersistence {
  readonly _serviceBrand: undefined;

  load(): Promise<WorkspaceCatalog | undefined>;
  save(catalog: WorkspaceCatalog): Promise<void>;
}

export const IWorkspacePersistence: ServiceIdentifier<IWorkspacePersistence> =
  createDecorator<IWorkspacePersistence>('workspacePersistence');
