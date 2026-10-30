import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { HostTerminalService } from '#/os/backends/node-local/hostTerminalService';
import { IBootstrapService } from './bootstrap';
import { kikiChildDefaults } from './childEnvironment';

export class AppHostProcessService extends HostProcessService {
  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super(kikiChildDefaults(bootstrap.homeDir));
  }
}

export class AppHostTerminalService extends HostTerminalService {
  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super(kikiChildDefaults(bootstrap.homeDir));
  }
}

registerScopedService(LifecycleScope.App, IHostProcessService, AppHostProcessService, ScopeActivation.OnScopeCreated, 'hostProcess');
registerScopedService(LifecycleScope.App, IHostTerminalService, AppHostTerminalService, ScopeActivation.OnScopeCreated, 'terminal');
