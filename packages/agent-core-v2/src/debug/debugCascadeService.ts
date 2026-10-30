import type { CascadeEngine } from '#/_base/di/cascadeEngine';
import {
  IInstantiationService,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventService } from '#/app/event/event';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

import {
  DiUnitChanged,
  IDebugCascadeService,
  type DebugCascadeEntry,
  type DebugFailedUnit,
  type DebugPendingGroup,
  type DebugPendingUnit,
  type DiUnitChangedPayload,
} from './debugCascade';
import {
  resolveScopeContainer,
  scopePathOfEngine,
  walkScopeContainers,
} from './scopeTree';

export class DebugCascadeService implements IDebugCascadeService {
  declare readonly _serviceBrand: undefined;

  private readonly root: InstantiationService;
  private readonly events: IEventService;
  private treeSubscriptions = new DisposableStore();
  private observers = 0;
  private readonly engineSubscriptions = new Map<CascadeEngine, IDisposable>();
  private tornDown = false;

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @IEventService events: IEventService,
  ) {
    this.root = instantiation as InstantiationService;
    this.events = events;
  }

  observeUnitChanges(): IDisposable {
    if (this.tornDown) return { dispose: () => undefined };
    this.observers += 1;
    if (this.observers === 1) this._startWatching();
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        this.observers -= 1;
        if (this.observers === 0 && !this.tornDown) this._stopWatching();
      },
    };
  }

  history(): DebugCascadeEntry[] {
    const entries: DebugCascadeEntry[] = [];
    for (const info of walkScopeContainers(this.root)) {
      for (const entry of info.container.cascade.history()) {
        entries.push({ scopePath: info.path, ...entry });
      }
    }
    return entries.toSorted(
      (a, b) => a.seq - b.seq || a.scopePath.localeCompare(b.scopePath),
    );
  }

  pending(): DebugPendingGroup[] {
    const groups: DebugPendingGroup[] = [];
    for (const info of walkScopeContainers(this.root)) {
      const waiting: DebugPendingUnit[] = [];
      for (const [token, missing] of info.container.cascade.pendingSnapshot()) {
        waiting.push({ token, missing: [...missing] });
      }
      const failed: DebugFailedUnit[] = info.container.cascade
        .unitsSnapshot()
        .filter((unit) => unit.state === 'Failed')
        .map((unit) => ({ token: unit.token, error: unit.error }));
      if (waiting.length > 0 || failed.length > 0) {
        groups.push({ scopePath: info.path, waiting, failed });
      }
    }
    return groups;
  }

  async unprovide(scopePath: string, token: string): Promise<void> {
    const { container, id } = this._resolve(scopePath, token);
    container.unprovide(id);
    await container.cascade.whenIdle();
  }

  async update(scopePath: string, token: string, config?: unknown): Promise<void> {
    const { container, id } = this._resolve(scopePath, token);
    if (config === undefined) {
      await container.cascade.update(id, `debug update ${token}`);
    } else {
      await container.fiberHost.updateToken(id, config, true);
    }
  }

  async dispose(scopePath: string, token: string): Promise<void>;
  async dispose(): Promise<void>;
  async dispose(scopePath?: string, token?: string): Promise<void> {
    if (scopePath === undefined && token === undefined) {
      if (!this.tornDown) {
        this.tornDown = true;
        await this.treeSubscriptions.dispose();
        for (const subscription of this.engineSubscriptions.values()) {
          await subscription.dispose();
        }
        this.engineSubscriptions.clear();
      }
      return;
    }
    if (scopePath === undefined || token === undefined) {
      throw new Error2(
        ErrorCodes.DEBUG_TOKEN_NOT_FOUND,
        'dispose requires both a scope path and a token',
      );
    }
    const { container, id } = this._resolve(scopePath, token);
    await container.cascade.submit({
      action: 'unprovide',
      token: id,
      reason: `debug dispose ${token}`,
    });
  }

  private _resolve(
    scopePath: string,
    token: string,
  ): { container: InstantiationService; id: ServiceIdentifier<unknown> } {
    const container = resolveScopeContainer(this.root, scopePath);
    if (container === undefined) {
      throw new Error2(
        ErrorCodes.DEBUG_SCOPE_NOT_FOUND,
        `no DI container at scope path '${scopePath}'`,
      );
    }
    const id = container.findIdentifier(token);
    if (id === undefined) {
      throw new Error2(
        ErrorCodes.DEBUG_TOKEN_NOT_FOUND,
        `token '${token}' is not registered in container '${scopePath}'`,
      );
    }
    return { container, id };
  }

  private _startWatching(): void {
    const tree = this.root.cascadeTree;
    this.treeSubscriptions = new DisposableStore();
    for (const engine of tree.engines) {
      this._watchEngine(engine);
    }
    this.treeSubscriptions.add(
      tree.onDidAddEngine((engine) => {
        this._watchEngine(engine);
      }),
    );
    this.treeSubscriptions.add(
      tree.onDidRemoveEngine((engine) => {
        this._unwatchEngine(engine);
      }),
    );
  }

  private _stopWatching(): void {
    const result = this.treeSubscriptions.dispose();
    if (result instanceof Promise) result.catch(onUnexpectedError);
    for (const engine of [...this.engineSubscriptions.keys()]) {
      this._unwatchEngine(engine);
    }
  }

  private _watchEngine(engine: CascadeEngine): void {
    if (this.engineSubscriptions.has(engine)) {
      return;
    }
    this.engineSubscriptions.set(
      engine,
      engine.onDidChangeUnitState((change) => {
        const payload: DiUnitChangedPayload = {
          scope: scopePathOfEngine(this.root, engine) ?? '#unknown',
          token: change.token,
          state: change.state,
          error: change.error,
        };
        this.events.publish(new DiUnitChanged({ payload }));
      }),
    );
  }

  private _unwatchEngine(engine: CascadeEngine): void {
    const result = this.engineSubscriptions.get(engine)?.dispose();
    if (result instanceof Promise) result.catch(onUnexpectedError);
    this.engineSubscriptions.delete(engine);
  }
}

registerScopedService(
  LifecycleScope.App,
  IDebugCascadeService,
  DebugCascadeService,
  ScopeActivation.OnScopeCreated,
  'debug',
);
