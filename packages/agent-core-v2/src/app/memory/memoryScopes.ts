import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isValidProjectId, type ProjectIdentity, type ResolveProjectIdentityOptions } from '#/_base/utils/workdir-slug';
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
    return this.bindings.bindWorkspace(cwd, options);
  }

  async resolveCanonicalWorkspaceId(workspaceId: string): Promise<string> {
    return this.bindings.resolveCanonicalWorkspaceId(workspaceId);
  }

  async listProjectBindings(): Promise<readonly ProjectBindingRecord[]> {
    return this.bindings.listBindings();
  }

  async resolve(scope: MemoryScope): Promise<string> {
    switch (scope.kind) {
      case 'global':
        return 'memory/global';
      case 'workspace': {
        const canonicalId = await this.resolveCanonicalWorkspaceId(scope.workspaceId);
        await this.assertWorkspace(canonicalId, scope.workspaceId);
        return `memory/workspaces/${canonicalId}`;
      }
      case 'persona':
        this.assertPersona(scope.personaId);
        return `memory/global/personas/${scope.personaId}`;
      case 'persona_workspace': {
        this.assertPersona(scope.personaId);
        const canonicalId = await this.resolveCanonicalWorkspaceId(scope.workspaceId);
        this.assertWorkspaceId(canonicalId);
        return `memory/workspaces/${canonicalId}/personas/${scope.personaId}`;
      }
    }
  }

  async listWorkspaceIds(): Promise<readonly string[]> {
    const catalog = await this.workspaces.load();
    const disk = await this.storage.list('memory/workspaces');
    const bound = (await this.bindings.listBindings()).map((binding) => binding.projectId);
    return [...new Set([...(catalog?.workspaces.map(({ id }) => id) ?? []), ...disk, ...bound])].filter((id) => MEMORY_WORKSPACE_ID_PATTERN.test(id));
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
