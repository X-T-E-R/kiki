import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { IPersonaStore } from './personaStore';
import type { PersonaListOptions, PersonaSummary } from './personaStore';
import { IPersonaCatalog } from './personaCatalog';
import type { PersonaSnapshot } from '@kiki/agent-profiles/personaFile';

export class PersonaCatalog extends Disposable implements IPersonaCatalog {
  declare readonly _serviceBrand: undefined;

  private readonly changeEmitter = this._register(new Emitter<void>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(@IPersonaStore private readonly store: IPersonaStore) {
    super();
    this._register(this.store.onDidChange(() => this.changeEmitter.fire()));
  }

  list(options?: PersonaListOptions): Promise<readonly PersonaSummary[]> {
    return this.store.list(options);
  }

  get(id: string): Promise<PersonaSnapshot | undefined> {
    return this.store.get(id);
  }
}

registerScopedService(LifecycleScope.App, IPersonaCatalog, PersonaCatalog, ScopeActivation.OnDemand, 'persona');
