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

  async read(): Promise<ExternalDelegationSessionProvision | undefined> {
    const raw = await this.store.get<unknown>(this.scope, this.key);
    if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
    const candidate = raw as Partial<ExternalDelegationSessionProvision>;
    if (candidate.version !== 1) return undefined;
    if (candidate.ownership !== 'dedicated' && candidate.ownership !== 'attached') {
      return undefined;
    }
    return { version: 1, ownership: candidate.ownership };
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
