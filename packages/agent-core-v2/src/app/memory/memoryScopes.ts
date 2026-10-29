import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

export type MemoryPublicScopeKind = 'global' | 'workspace';
export type MemoryScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'persona'; readonly personaId: string }
  | { readonly kind: 'persona_workspace'; readonly workspaceId: string; readonly personaId: string };

export const MEMORY_PERSONA_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MEMORY_WORKSPACE_ID_PATTERN = /^wd_[a-z0-9._-]+_[0-9a-f]{12}$/;

export interface IMemoryScopes {
  readonly _serviceBrand: undefined;
  resolve(scope: MemoryScope): Promise<string>;
  listWorkspaceIds?(): Promise<readonly string[]>;
}
export const IMemoryScopes = createDecorator<IMemoryScopes>('memoryScopes');

export class MemoryScopes implements IMemoryScopes {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IWorkspacePersistence private readonly workspaces: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {}

  async resolve(scope: MemoryScope): Promise<string> {
    switch (scope.kind) {
      case 'global':
        return 'memory/global';
      case 'workspace':
        await this.assertWorkspace(scope.workspaceId);
        return `memory/workspaces/${scope.workspaceId}`;
      case 'persona':
        this.assertPersona(scope.personaId);
        return `memory/global/personas/${scope.personaId}`;
      case 'persona_workspace':
        this.assertPersona(scope.personaId);
        this.assertWorkspaceId(scope.workspaceId);
        return `memory/workspaces/${scope.workspaceId}/personas/${scope.personaId}`;
    }
  }

  async listWorkspaceIds(): Promise<readonly string[]> {
    const catalog = await this.workspaces.load();
    const disk = await this.storage.list('memory/workspaces');
    return [...new Set([...(catalog?.workspaces.map(({ id }) => id) ?? []), ...disk])].filter((id) => MEMORY_WORKSPACE_ID_PATTERN.test(id));
  }

  private async assertWorkspace(workspaceId: string): Promise<void> {
    this.assertWorkspaceId(workspaceId);
    if (await this.storage.size('memory/workspaces', workspaceId) !== undefined) return;
    if (!(await this.workspaces.load())?.workspaces.some(({ id }) => id === workspaceId)) throw new Error('Workspace not found');
  }

  private assertWorkspaceId(workspaceId: string): void {
    if (!MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('Invalid workspace id');
  }

  private assertPersona(personaId: string): void {
    if (!MEMORY_PERSONA_ID_PATTERN.test(personaId)) throw new Error('Invalid persona id');
  }
}

registerScopedService(LifecycleScope.App, IMemoryScopes, MemoryScopes, ScopeActivation.OnDemand, 'memory');
