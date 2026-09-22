import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService, ProfileError, ProfileErrors } from '#/agent/profile/profile';
import { TOOLS_SECTION, type ToolsConfig } from './configSection';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import type { ToolSource } from '#/tool/toolContract';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SUBAGENT_SECTION, type SubagentConfig } from '#/session/subagent/configSection';
import type { SubagentToolPolicy } from '@kiki/agent-profiles/subagentToolPolicy';

import { isToolActiveComposed, type ToolActivationPolicy } from './evaluate';
import { IAgentToolPolicyService } from './toolPolicy';

export class AgentToolPolicyService extends Disposable implements IAgentToolPolicyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IConfigService private readonly config: IConfigService,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
  ) {
    super();
    this._register(
      toolExecutor.registerToolCallGuard(({ name, source }) => {
        const active =
          name === SELECT_TOOLS_TOOL_NAME
            ? this.isToolActiveForDisclosure(name, source)
            : this.isToolActive(name, source);
        return active
          ? undefined
          : `Tool "${name}" is disabled by the active tool policy`;
      }),
    );
  }

  isToolActive(name: string, source: ToolSource = 'builtin'): boolean {
    const profile = this.profile.data();
    return this.evaluate(
      {
        tools: profile.activeToolNames,
        toolAllowPolicies: profile.toolAllowPolicies,
        disallowedTools: profile.disallowedTools,
        disabledToolGroups: profile.disabledToolGroups,
        executionRestriction: profile.executionRestriction,
      },
      name,
      source,
      this.scope.parentAgentId === undefined ? undefined : this.subagentPolicy(profile.boundProfile?.tools),
    );
  }

  isToolActiveForDisclosure(name: string, source: ToolSource = 'builtin'): boolean {
    if (name !== SELECT_TOOLS_TOOL_NAME) return this.isToolActive(name, source);
    const profile = this.profile.data();
    return this.evaluate(
      {
        disallowedTools: profile.disallowedTools,
        disabledToolGroups: profile.disabledToolGroups,
        executionRestriction: profile.executionRestriction,
      },
      name,
      source,
      this.scope.parentAgentId === undefined ? undefined : this.subagentPolicy(profile.boundProfile?.tools),
    );
  }

  isToolActiveForProfile(
    profile: ToolActivationPolicy,
    name: string,
    source: ToolSource = 'builtin',
  ): boolean {
    return this.evaluate(
      {
        ...profile,
        executionRestriction: this.profile.data().executionRestriction ?? profile.executionRestriction,
      },
      name,
      source,
      this.subagentPolicy(profile.tools),
    );
  }

  private subagentPolicy(explicitProfileTools: readonly string[] | undefined): SubagentToolPolicy {
    return {
      explicitProfileTools,
      allowedTools: this.config.get<SubagentConfig>(SUBAGENT_SECTION)?.allowedTools,
    };
  }

  private evaluate(
    profile: ToolActivationPolicy,
    name: string,
    source: ToolSource,
    subagent: SubagentToolPolicy | undefined,
  ): boolean {
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile,
        global: this.config.get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
        subagent,
      },
      name,
      source,
    );
  }

  async setSessionDisabledTools(names: readonly string[]): Promise<void> {
    if (this.profile.data().profileName === undefined) {
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_NOT_BOUND,
        'Cannot set session disabled tools: agent profile is not bound',
      );
    }
    await this.sessionToolPolicy.setDisabledTools(names);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolPolicyService,
  AgentToolPolicyService,
  ScopeActivation.OnScopeCreated,
  'toolPolicy',
);
