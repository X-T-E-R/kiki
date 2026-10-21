import { Service } from '#/_base/di/service';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import {
  IOptionalCapabilityPolicy,
  type SessionCapabilityView,
} from '#/app/optionalCapability/policy';
import type { CapabilityChoice, OptionalCapabilityId } from '#/app/optionalCapability/admit';
import { onUnexpectedError } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

export interface ISessionOptionalCapabilityService {
  readonly _serviceBrand: undefined;
  read(): Promise<SessionCapabilityView>;
  set(id: OptionalCapabilityId, choice: CapabilityChoice): Promise<SessionCapabilityView>;
}

export const ISessionOptionalCapabilityService = createDecorator<ISessionOptionalCapabilityService>('sessionOptionalCapabilityService');

export class SessionOptionalCapabilityService extends Service implements ISessionOptionalCapabilityService {
  declare readonly _serviceBrand: undefined;
  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @IOptionalCapabilityPolicy private readonly policy: IOptionalCapabilityPolicy,
  ) {
    super();
    void this.policy.load(this.session.sessionId).catch(onUnexpectedError);
  }

  read(): Promise<SessionCapabilityView> {
    return this.policy.readSession(this.session.sessionId, this.session.workspaceId);
  }

  set(id: OptionalCapabilityId, choice: CapabilityChoice): Promise<SessionCapabilityView> {
    return this.policy.setChoice(this.session.sessionId, id, choice, this.session.workspaceId);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionOptionalCapabilityService,
  SessionOptionalCapabilityService,
  ScopeActivation.OnScopeCreated,
  'sessionOptionalCapability',
);
