import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type { AgentProfile } from './agentProfileCatalog';
import { IBuiltinAgentProfileLoader } from './builtinAgentProfileLoader';
import { IShippedAgentProfileSource } from '#/app/shippedAgentProfiles/shippedAgentProfileSource';

/** Compatibility facade over the shipped agent-profile originals. The shipped profiles are no
 *  longer contributed to the agent-profile registry as a privileged "builtin" lane; this service
 *  only exposes them as the terminal render base for file-defined profiles and `SYSTEM.md`. */
export class BuiltinAgentProfileLoaderService
  extends Disposable
  implements IBuiltinAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  constructor(@IShippedAgentProfileSource private readonly shipped: IShippedAgentProfileSource) {
    super();
  }

  get(name: string): AgentProfile | undefined {
    return this.shipped.get(name);
  }

  getDefault(): AgentProfile {
    return this.shipped.getDefault();
  }

  list(): readonly AgentProfile[] {
    return this.shipped.list();
  }
}

registerScopedService(
  LifecycleScope.App,
  IBuiltinAgentProfileLoader,
  BuiltinAgentProfileLoaderService,
  ScopeActivation.OnScopeCreated,
  'agentProfileCatalog',
);
