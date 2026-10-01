import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { IAgentExternalHooksService } from './agent/agentExternalHooks';
import { AgentExternalHooksService, HookResult } from './agent/agentExternalHooksService';
import { IExternalHooksRunnerService } from './app/externalHooksRunner';
import { ExternalHooksRunnerService } from './app/externalHooksRunnerService';
import { ISessionExternalHooksService } from './session/sessionExternalHooks';
import { SessionExternalHooksService } from './session/sessionExternalHooksService';
import { IHookRulesRegistry } from './app/hookRules';
import { HookRulesRegistry } from './app/hookRulesService';
import { IHookRulesSession } from './session/hookRules';
import { HookRulesSession } from './session/hookRulesService';
import { IAgentHookRules } from './agent/hookRules';
import { AgentHookRules } from './agent/hookRulesService';
import { IEventDispatcher } from '#/state/eventDispatcher';

export class ExternalHooksFeature extends Feature {
  static override readonly name = 'externalHooks';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.App,
      IExternalHooksRunnerService,
      ExternalHooksRunnerService,
    );
    this.contributeService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      SessionExternalHooksService,
    );
    this.contributeAgentService(IAgentExternalHooksService, AgentExternalHooksService);
    this.contributeService(LifecycleScope.App, IHookRulesRegistry, HookRulesRegistry);
    this.contributeService(LifecycleScope.Session, IHookRulesSession, HookRulesSession);
    this.contributeAgentService(IAgentHookRules, AgentHookRules);
    this.contributeCommand({
      name: 'hooks-inspect', description: 'Inspect effective hooks, diagnostics and completed-step clocks',
      run: (ctx) => {
        const hooks = ctx.get(IAgentHookRules);
        const dispatcher = ctx.get(IEventDispatcher);
        return hooks.inspect().then((view) => dispatcher.dispatch(new HookResult({ hookEvent: 'hooks.inspect', content: JSON.stringify(view, undefined, 2) })));
      },
    });
  }
}

registerFeature(ExternalHooksFeature);
