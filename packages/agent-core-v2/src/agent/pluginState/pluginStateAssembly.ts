import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import { IAgentPluginStateService, IPluginStateRegistryService } from './pluginState';
import { AgentPluginStateService, PluginStateRegistryService } from './pluginStateService';

registerScopedService(LifecycleScope.App, IPluginStateRegistryService, PluginStateRegistryService, ScopeActivation.OnScopeCreated, 'pluginState');
registerScopedService(LifecycleScope.Agent, IAgentPluginStateService, AgentPluginStateService, ScopeActivation.OnScopeCreated, 'pluginState');
