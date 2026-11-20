import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { LifecycleScope } from '#/app/scopes';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IMeshLeaseStore } from './meshLeaseStore';

export const MESH_CONTEXT_INJECTION_VARIANT = 'mesh_context';

export interface IAgentMeshContextInjectorService {
  readonly _serviceBrand: undefined;
}

export const IAgentMeshContextInjectorService: ServiceIdentifier<IAgentMeshContextInjectorService> =
  createDecorator<IAgentMeshContextInjectorService>('agentMeshContextInjectorService');

/** Eager Agent-scoped service that injects the session's <= 2 KiB `<mesh-context>` summary at step head when leases exist. */
export class AgentMeshContextInjectorService
  extends Disposable
  implements IAgentMeshContextInjectorService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @ISessionContext private readonly session: ISessionContext,
    @IMeshLeaseStore private readonly leaseStore: IMeshLeaseStore,
  ) {
    super();
    this._register(
      injector.register<string>(MESH_CONTEXT_INJECTION_VARIANT, async ({ lastDisclosure }) => {
        const projection = await this.leaseStore.projectContext(this.session.sessionId);
        if (projection.contextBlock === null) return undefined;
        if (lastDisclosure === projection.contextBlock) return undefined;
        return {
          content: projection.contextBlock,
          disclosure: projection.contextBlock,
        };
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMeshContextInjectorService,
  AgentMeshContextInjectorService,
  ScopeActivation.OnScopeCreated,
  'mesh',
);
