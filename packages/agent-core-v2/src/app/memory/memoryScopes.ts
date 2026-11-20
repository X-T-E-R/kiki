import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  isValidProjectId,
  resolveProjectIdentity,
  type ProjectIdentity,
  type ResolveProjectIdentityOptions,
} from '#/_base/utils/workdir-slug';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ProjectIdentityBindingIndex, type ProjectBindingRecord } from './projectIdentityBindings';

export type MemoryPublicScopeKind = 'global' | 'workspace';
export type MemoryScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'persona'; readonly personaId: string }
  | { readonly kind: 'persona_workspace'; readonly workspaceId: string; readonly personaId: string };

export const MEMORY_PERSONA_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MEMORY_WORKSPACE_ID_PATTERN = /^(?:wd_[a-z0-9._-]+_[0-9a-f]{12}|prj_[a-z0-9][a-z0-9._-]{0,63})$/;

export interface IMemoryScopes {
  readonly _serviceBrand: undefined;
  resolve(scope: MemoryScope): Promise<string>;
  resolveReadBases?(scope: MemoryScope): Promise<readonly string[]>;
  listWorkspaceIds?(): Promise<readonly string[]>;
  bindWorkspace?(
    cwd: string,
    options?: ResolveProjectIdentityOptions & { readonly hostId?: string },
  ): Promise<ProjectIdentity>;
  resolveCanonicalWorkspaceId?(workspaceId: string): Promise<string>;
  listProjectBindings?(): Promise<readonly ProjectBindingRecord[]>;
}
export const IMemoryScopes = createDecorator<IMemoryScopes>('memoryScopes');

export class MemoryScopes implements IMemoryScopes {
  declare readonly _serviceBrand: undefined;
  private readonly bindings: ProjectIdentityBindingIndex;
  private readonly autoBindAttempted = new Set<string>();
  private readonly autoBindFlights = new Map<string, Promise<string>>();

  constructor(
    @IWorkspacePersistence private readonly workspaces: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {
    this.bindings = new ProjectIdentityBindingIndex(storage);
  }

  async bindWorkspace(
    cwd: string,
    options?: ResolveProjectIdentityOptions & { readonly hostId?: string },
  ): Promise<ProjectIdentity> {
    const identity = await this.bindings.bindWorkspace(cwd, options);
    this.autoBindAttempted.add(identity.workDirKey);
    return identity;
  }

  async resolveCanonicalWorkspaceId(workspaceId: string, skipCatalogIfOnDisk = false): Promise<string> {
    if (isValidProjectId(workspaceId)) return workspaceId;
    const bound = await this.bindings.resolveCanonicalWorkspaceId(workspaceId);
    if (bound !== workspaceId || !workspaceId.startsWith('wd_')) return bound;
    if (skipCatalogIfOnDisk && (await this.storage.size('memory/workspaces', workspaceId)) !== undefined) {
      return workspaceId;
    }
    if (this.autoBindAttempted.has(workspaceId)) return workspaceId;
    const inflight = this.autoBindFlights.get(workspaceId);
    if (inflight !== undefined) return inflight;
    const flight = this.autoBindFromCatalog(workspaceId);
    this.autoBindFlights.set(workspaceId, flight);
    try {
      return await flight;
    } finally {
      if (this.autoBindFlights.get(workspaceId) === flight) {
        this.autoBindFlights.delete(workspaceId);
      }
    }
  }

  async listProjectBindings(): Promise<readonly ProjectBindingRecord[]> {
    return this.bindings.listBindings();
  }

  async resolve(scope: MemoryScope): Promise<string> {
    switch (scope.kind) {
      case 'global':
        return 'memory/global';
      case 'workspace': {
        this.assertWorkspaceId(scope.workspaceId);
        const canonicalId = await this.resolveCanonicalWorkspaceId(scope.workspaceId, true);
        await this.assertWorkspace(canonicalId, scope.workspaceId);
        return `memory/workspaces/${canonicalId}`;
      }
      case 'persona':
        this.assertPersona(scope.personaId);
        return `memory/global/personas/${scope.personaId}`;
      case 'persona_workspace': {
        this.assertPersona(scope.personaId);
        this.assertWorkspaceId(scope.workspaceId);
        const canonicalId = await this.resolveCanonicalWorkspaceId(scope.workspaceId, true);
        this.assertWorkspaceId(canonicalId);
        return `memory/workspaces/${canonicalId}/personas/${scope.personaId}`;
      }
    }
  }

  async resolveReadBases(scope: MemoryScope): Promise<readonly string[]> {
    switch (scope.kind) {
      case 'global':
        return ['memory/global'];
      case 'persona':
        this.assertPersona(scope.personaId);
        return [`memory/global/personas/${scope.personaId}`];
      case 'workspace': {
        this.assertWorkspaceId(scope.workspaceId);
        const canonicalId = await this.resolveCanonicalWorkspaceId(scope.workspaceId, true);
        await this.assertWorkspace(canonicalId, scope.workspaceId);
        const ids = await this.collectReadIds(canonicalId, scope.workspaceId);
        return ids.map((id) => `memory/workspaces/${id}`);
      }
      case 'persona_workspace': {
        this.assertPersona(scope.personaId);
        this.assertWorkspaceId(scope.workspaceId);
        const canonicalId = await this.resolveCanonicalWorkspaceId(scope.workspaceId, true);
        this.assertWorkspaceId(canonicalId);
        const ids = await this.collectReadIds(canonicalId, scope.workspaceId);
        return ids.map((id) => `memory/workspaces/${id}/personas/${scope.personaId}`);
      }
    }
  }

  async listWorkspaceIds(): Promise<readonly string[]> {
    const catalog = await this.workspaces.load();
    const disk = await this.storage.list('memory/workspaces');
    const bound = (await this.bindings.listBindings()).map((binding) => binding.projectId);
    return [...new Set([...(catalog?.workspaces.map(({ id }) => id) ?? []), ...disk, ...bound])].filter((id) => MEMORY_WORKSPACE_ID_PATTERN.test(id));
  }

  private async collectReadIds(canonicalId: string, originalId: string): Promise<readonly string[]> {
    const ids = new Set<string>([canonicalId]);
    if (originalId !== canonicalId && MEMORY_WORKSPACE_ID_PATTERN.test(originalId)) {
      ids.add(originalId);
    }
    if (isValidProjectId(canonicalId)) {
      await this.ensureCatalogWorkspacesBoundForProject();
      for (const workDirKey of await this.bindings.findWorkDirKeysForProjectId(canonicalId)) {
        if (MEMORY_WORKSPACE_ID_PATTERN.test(workDirKey)) ids.add(workDirKey);
      }
    }
    return [...ids];
  }

  private async ensureCatalogWorkspacesBoundForProject(): Promise<void> {
    const catalog = await this.workspaces.load();
    if (catalog === undefined) return;
    for (const workspace of catalog.workspaces) {
      if (!workspace.id.startsWith('wd_') || this.autoBindAttempted.has(workspace.id)) continue;
      await this.resolveCanonicalWorkspaceId(workspace.id);
    }
  }

  private async autoBindFromCatalog(workspaceId: string): Promise<string> {
    const catalog = await this.workspaces.load();
    const match = catalog?.workspaces.find((workspace) => workspace.id === workspaceId);
    if (match === undefined || match.root.trim().length === 0) {
      this.autoBindAttempted.add(workspaceId);
      return workspaceId;
    }
    const identity = await resolveProjectIdentity(match.root);
    if (!isValidProjectId(identity.projectId)) {
      this.autoBindAttempted.add(workspaceId);
      return workspaceId;
    }
    const bound = await this.bindings.bindWorkspace(match.root);
    this.autoBindAttempted.add(workspaceId);
    return bound.projectId;
  }

  private async assertWorkspace(canonicalId: string, originalId: string): Promise<void> {
    this.assertWorkspaceId(canonicalId);
    if (isValidProjectId(canonicalId)) return;
    if (await this.storage.size('memory/workspaces', canonicalId) !== undefined) return;
    if ((await this.workspaces.load())?.workspaces.some(({ id }) => id === canonicalId || id === originalId)) return;
    throw new Error('Workspace not found');
  }

  private assertWorkspaceId(workspaceId: string): void {
    if (!MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('Invalid workspace id');
  }

  private assertPersona(personaId: string): void {
    if (!MEMORY_PERSONA_ID_PATTERN.test(personaId)) throw new Error('Invalid persona id');
  }
}

registerScopedService(LifecycleScope.App, IMemoryScopes, MemoryScopes, ScopeActivation.OnDemand, 'memory');
