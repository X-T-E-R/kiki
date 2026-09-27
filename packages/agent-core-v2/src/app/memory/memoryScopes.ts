import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IWorkspaceService } from '#/app/workspace/workspace';

export type MemoryScope = { readonly kind: 'global' } | { readonly kind: 'workspace'; readonly workspaceId: string };

export interface IMemoryScopes {
  readonly _serviceBrand: undefined;
  resolve(scope: MemoryScope): Promise<string>;
}
export const IMemoryScopes = createDecorator<IMemoryScopes>('memoryScopes');

export class MemoryScopes implements IMemoryScopes {
  declare readonly _serviceBrand: undefined;
  constructor(@IWorkspaceService private readonly workspaces: IWorkspaceService) {}

  async resolve(scope: MemoryScope): Promise<string> {
    if (scope.kind === 'global') return 'memory/global';
    if (!/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/.test(scope.workspaceId)) throw new Error('Invalid workspace id');
    if (await this.workspaces.get(scope.workspaceId) === undefined) throw new Error('Workspace not found');
    return `memory/workspaces/${scope.workspaceId}`;
  }
}

registerScopedService(LifecycleScope.App, IMemoryScopes, MemoryScopes, ScopeActivation.OnDemand, 'memory');
