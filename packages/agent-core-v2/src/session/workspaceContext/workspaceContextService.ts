import { isAbsolute, relative, resolve } from 'node:path';

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

import { ISessionWorkspaceContext } from './workspaceContext';

export const workspaceContextWorkDirKey = defineState<string>('workspaceContext.workDir', () => '');
export const workspaceContextAdditionalDirsKey = defineState<string[]>(
  'workspaceContext.additionalDirs',
  () => [],
);

export class SessionWorkspaceContextService extends Service implements ISessionWorkspaceContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext ctx: ISessionContext,
    @ISessionWorkspaceInfo workspaceInfo: ISessionWorkspaceInfo,
  ) {
    super();
    this.states.contributeState(workspaceContextWorkDirKey);
    this.states.contributeState(workspaceContextAdditionalDirsKey);
    this.states.set(workspaceContextWorkDirKey, resolve(ctx.cwd));
    this.states.set(workspaceContextAdditionalDirsKey, [
      ...new Set(workspaceInfo.additionalDirs.map((d) => resolve(d))),
    ]);
    this._register(
      workspaceInfo.onDidChange(() => {
        this.states.set(workspaceContextAdditionalDirsKey, [
          ...new Set(workspaceInfo.additionalDirs.map((d) => resolve(d))),
        ]);
      }),
    );
  }

  private get _workDir(): string {
    return this.states.get(workspaceContextWorkDirKey);
  }

  private get _additionalDirs(): string[] {
    return this.states.get(workspaceContextAdditionalDirsKey);
  }

  get workDir(): string {
    return this._workDir;
  }

  get additionalDirs(): readonly string[] {
    return this._additionalDirs;
  }

  resolve(rel: string): string {
    return isAbsolute(rel) ? resolve(rel) : resolve(this._workDir, rel);
  }

  isWithin(absPath: string): boolean {
    const target = resolve(absPath);
    if (target === this._workDir) return true;
    const rel = relative(this._workDir, target);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true;
    return this._additionalDirs.some((dir) => {
      const r = relative(dir, target);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionWorkspaceContext,
  SessionWorkspaceContextService,
  ScopeActivation.OnScopeCreated,
  'workspaceContext',
);
