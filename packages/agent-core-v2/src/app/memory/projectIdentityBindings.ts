import {
  encodeWorkDirKey,
  isValidProjectId,
  resolveProjectIdentity,
  type ProjectIdentity,
  type ProjectIdentitySource,
  type ResolveProjectIdentityOptions,
} from '#/_base/utils/workdir-slug';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

const BINDINGS_SCOPE = 'memory';
const BINDINGS_KEY = 'project-bindings.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ProjectBindingRecord {
  readonly workDirKey: string;
  readonly projectId: string;
  readonly source: ProjectIdentitySource;
  readonly rootPath: string;
  readonly hostId?: string;
  readonly updatedAt: string;
}

interface StoredProjectBindings {
  readonly version: 1;
  readonly bindings: Record<string, ProjectBindingRecord>;
}

/** Per-machine binding index mapping local `wd_*` workspace keys to portable `prj_*` project IDs. */
export class ProjectIdentityBindingIndex {
  private cache: Record<string, ProjectBindingRecord> | undefined;

  constructor(private readonly storage: IFileSystemStorageService) {}

  async load(): Promise<Readonly<Record<string, ProjectBindingRecord>>> {
    if (this.cache !== undefined) return this.cache;
    const bytes = await this.storage.read(BINDINGS_SCOPE, BINDINGS_KEY, { recoverMissing: false });
    if (bytes === undefined) {
      this.cache = {};
      return this.cache;
    }
    try {
      const parsed = JSON.parse(decoder.decode(bytes)) as Partial<StoredProjectBindings>;
      if (parsed.version === 1 && parsed.bindings !== undefined && typeof parsed.bindings === 'object') {
        this.cache = { ...parsed.bindings };
        return this.cache;
      }
    } catch {
    }
    this.cache = {};
    return this.cache;
  }

  async bindWorkspace(
    cwd: string,
    options?: ResolveProjectIdentityOptions & { readonly hostId?: string },
  ): Promise<ProjectIdentity> {
    const identity = await resolveProjectIdentity(cwd, options);
    const current = { ...(await this.load()) };
    const workDirKey = encodeWorkDirKey(cwd);
    current[workDirKey] = {
      workDirKey,
      projectId: identity.projectId,
      source: identity.source,
      rootPath: cwd,
      ...(options?.hostId === undefined ? {} : { hostId: options.hostId }),
      updatedAt: new Date().toISOString(),
    };
    const payload: StoredProjectBindings = { version: 1, bindings: current };
    await this.storage.write(
      BINDINGS_SCOPE,
      BINDINGS_KEY,
      encoder.encode(`${JSON.stringify(payload, null, 2)}\n`),
      { atomic: true },
    );
    this.cache = current;
    return identity;
  }

  async resolveCanonicalWorkspaceId(workspaceId: string): Promise<string> {
    if (isValidProjectId(workspaceId)) return workspaceId;
    const bindings = await this.load();
    return bindings[workspaceId]?.projectId ?? workspaceId;
  }

  async listBindings(): Promise<readonly ProjectBindingRecord[]> {
    const bindings = await this.load();
    return Object.values(bindings).toSorted((a, b) => a.workDirKey.localeCompare(b.workDirKey));
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

export interface HostScopedMemoryLike {
  readonly applicability?: 'portable' | 'machine-local' | 'expired' | 'recheck' | 'unrecorded';
  readonly host_applicability?: 'portable' | 'machine-local';
  readonly origin_host_id?: string;
}

/** Returns whether a memory entry may be synchronized across machines. */
export function isMemoryPortableForSync(entry: HostScopedMemoryLike): boolean {
  return entry.host_applicability !== 'machine-local' && entry.applicability !== 'machine-local';
}

/** Returns whether a memory entry is visible on the given host (isolating `machine-local` entries to their originating host). */
export function isMemoryVisibleOnHost(
  entry: HostScopedMemoryLike,
  currentHostId: string,
): boolean {
  if (isMemoryPortableForSync(entry)) return true;
  if (entry.origin_host_id === undefined) return true;
  return entry.origin_host_id === currentHostId;
}

/** Filters memories visible on `currentHostId`, excluding foreign `machine-local` entries. */
export function filterMemoriesForHost<T extends HostScopedMemoryLike>(
  entries: readonly T[],
  currentHostId: string,
): readonly T[] {
  return entries.filter((entry) => isMemoryVisibleOnHost(entry, currentHostId));
}

/** Filters memories eligible for cross-machine sync, omitting all `machine-local` entries. */
export function filterMemoriesForSync<T extends HostScopedMemoryLike>(
  entries: readonly T[],
): readonly T[] {
  return entries.filter((entry) => isMemoryPortableForSync(entry));
}
