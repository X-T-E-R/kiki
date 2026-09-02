import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  type ExternalDelegationSessionProvision,
  ISessionExternalDelegationProvisionStore,
} from './externalDelegation';

const STORE_SCOPE = 'external-delegation-provisions';

export class SessionExternalDelegationProvisionStore
  implements ISessionExternalDelegationProvisionStore
{
  declare readonly _serviceBrand: undefined;
  private readonly scope: string;
  private readonly key: string;

  constructor(
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ISessionContext session: ISessionContext,
  ) {
    this.scope = `${STORE_SCOPE}/${session.workspaceId}`;
    this.key = session.sessionId;
  }

  read(): Promise<ExternalDelegationSessionProvision | undefined> {
    return this.store.get<ExternalDelegationSessionProvision>(this.scope, this.key);
  }

  write(provision: ExternalDelegationSessionProvision): Promise<void> {
    return this.store.set(this.scope, this.key, provision);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExternalDelegationProvisionStore,
  SessionExternalDelegationProvisionStore,
  ScopeActivation.OnDemand,
  'externalDelegationProvisionStore',
);
