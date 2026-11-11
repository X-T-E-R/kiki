import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ICordisRuntimeService, IPluginIsolationPoolService } from './cordisRuntime';
import { CordisRuntimeService } from './cordisRuntimeService';
import { PluginIsolationPoolService } from './pluginIsolationPoolService';

interface ICordisAppAssembly { readonly _serviceBrand: undefined }
const ICordisAppAssembly: ServiceIdentifier<ICordisAppAssembly> = createDecorator<ICordisAppAssembly>('cordisAppAssembly');

class CordisAppAssembly extends Disposable implements ICordisAppAssembly {
  declare readonly _serviceBrand: undefined;
  constructor(@ISessionManager manager: ISessionManager, @ICordisRuntimeService runtime: ICordisRuntimeService) {
    super();
    if (manager.onWillCreateSession) this._register(manager.onWillCreateSession(event => (runtime as CordisRuntimeService).attachSession(event)));
  }
}

interface ICordisSessionAssembly { readonly _serviceBrand: undefined }
const ICordisSessionAssembly: ServiceIdentifier<ICordisSessionAssembly> = createDecorator<ICordisSessionAssembly>('cordisSessionAssembly');

class CordisSessionAssembly extends Disposable implements ICordisSessionAssembly {
  declare readonly _serviceBrand: undefined;
  constructor(@ISessionContext session: ISessionContext, @IAgentLifecycleService agents: IAgentLifecycleService, @ICordisRuntimeService runtime: ICordisRuntimeService) {
    super();
    this._register((runtime as CordisRuntimeService).attachAgentLifecycle(session.sessionId, agents));
  }
}

registerScopedService(LifecycleScope.App, ICordisRuntimeService, CordisRuntimeService, ScopeActivation.OnScopeCreated, 'plugin');
registerScopedService(LifecycleScope.App, IPluginIsolationPoolService, PluginIsolationPoolService, ScopeActivation.OnScopeCreated, 'plugin');
registerScopedService(LifecycleScope.App, ICordisAppAssembly, CordisAppAssembly, ScopeActivation.OnScopeCreated, 'plugin');
registerScopedService(LifecycleScope.Session, ICordisSessionAssembly, CordisSessionAssembly, ScopeActivation.OnScopeCreated, 'plugin');
