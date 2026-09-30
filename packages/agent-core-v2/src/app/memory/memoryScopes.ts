import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IWorkspaceService } from '#/app/workspace/workspace';

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
  constructor(@IWorkspaceService private readonly workspaces: IWorkspaceService) {}

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
    return (await this.workspaces.list()).map(({ id }) => id).filter((id) => MEMORY_WORKSPACE_ID_PATTERN.test(id));
  }

  private async assertWorkspace(workspaceId: string): Promise<void> {
    this.assertWorkspaceId(workspaceId);
    if (await this.workspaces.get(workspaceId) === undefined) throw new Error('Workspace not found');
  }

  private assertWorkspaceId(workspaceId: string): void {
    if (!MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('Invalid workspace id');
  }

  private assertPersona(personaId: string): void {
    if (!MEMORY_PERSONA_ID_PATTERN.test(personaId)) throw new Error('Invalid persona id');
  }
}

registerScopedService(LifecycleScope.App, IMemoryScopes, MemoryScopes, ScopeActivation.OnDemand, 'memory');
