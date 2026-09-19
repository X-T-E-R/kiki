import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/errors';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { agentProfileFromFile } from '@kiki/agent-profiles/agentProfileFromFile';

import {
  SHIPPED_AGENT_PROFILE_SCHEME,
  IShippedAgentProfileSource,
  renderShippedBasePrompt,
} from './shippedAgentProfileSource';
import { SHIPPED_AGENT_PROFILE_TEMPLATES } from './shippedAgentProfiles';

/** `shippedAgentProfiles` domain — the in-binary originals of the profiles that ship with the
 *  product. They are the install/restore input for the on-disk managed copies under
 *  `<userAgentProfileHomeDir>/agents/builtin/` and the terminal render base for file-defined
 *  profiles and `SYSTEM.md`; they are never contributed to the agent-profile registry, so they
 *  never participate in runtime same-name resolution. */
export class ShippedAgentProfileSourceService
  extends Disposable
  implements IShippedAgentProfileSource
{
  declare readonly _serviceBrand: undefined;

  private readonly byName: Map<string, AgentProfile>;

  constructor() {
    super();
    this.byName = new Map(
      SHIPPED_AGENT_PROFILE_TEMPLATES.map((template) => {
        const definition = parseAgentFileText({
          path: `${SHIPPED_AGENT_PROFILE_SCHEME}${template.fileName}`,
          source: 'user',
          text: template.text,
        });
        return [
          definition.name,
          agentProfileFromFile(definition, renderShippedBasePrompt, renderShippedBasePrompt),
        ];
      }),
    );
  }

  list(): readonly AgentProfile[] {
    return [...this.byName.values()];
  }

  get(name: string): AgentProfile | undefined {
    return this.byName.get(name);
  }

  getDefault(): AgentProfile {
    const profile = this.byName.get(DEFAULT_AGENT_PROFILE_NAME);
    if (profile === undefined) {
      throw new BugIndicatingError(
        `Shipped default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is unavailable`,
      );
    }
    return profile;
  }
}

registerScopedService(
  LifecycleScope.App,
  IShippedAgentProfileSource,
  ShippedAgentProfileSourceService,
  ScopeActivation.OnScopeCreated,
  'shippedAgentProfiles',
);
