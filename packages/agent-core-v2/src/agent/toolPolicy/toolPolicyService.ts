import { Disposable } from '#/_base/di/lifecycle';
import { IInstantiationService, ref, type LiveRef } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService, ProfileError, ProfileErrors, type ProfileData } from '#/agent/profile/profile';
import { TOOLS_SECTION, type ToolsConfig } from './configSection';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IConfigService } from '#/app/config/config';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { MEMORY_SECTION, type MemoryConfig } from '#/app/memory/configSection';
import { admitSendMessageCapability, capabilityToolsSource, optionalCapabilityForTool } from '#/app/optionalCapability/admit';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { IShippedAgentProfileManager } from '#/app/shippedAgentProfiles/shippedAgentProfileManager';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { CALL_TOOL_NAME, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import type { ToolSource } from '#/tool/toolContract';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SUBAGENT_SECTION, type SubagentConfig } from '#/session/subagent/configSection';
import type { SubagentToolPolicy } from '@kiki/agent-profiles/subagentToolPolicy';

import { isToolActiveComposed, type ToolActivationPolicy } from './evaluate';
import { IAgentToolPolicyService } from './toolPolicy';
import { isLegacyShippedMessageBinding } from './sendMessageAdmission';

export class AgentToolPolicyService extends Disposable implements IAgentToolPolicyService {
  declare readonly _serviceBrand: undefined;
  private noted = false;
  private snapshot: { profile?: ProfileData; optional?: { value: IOptionalCapabilityPolicy | undefined } } | undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IConfigService private readonly config: IConfigService,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @ref(ISessionContext) private readonly session: LiveRef<ISessionContext>,
    @ref(ISessionDeliveryService) private readonly delivery: LiveRef<ISessionDeliveryService>,
    @ref(ICapabilitySnapshotService) private readonly capabilities: LiveRef<ICapabilitySnapshotService>,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this._register(
      toolExecutor.registerToolCallGuard(({ name, source }) => {
        const active =
          name === SELECT_TOOLS_TOOL_NAME || name === CALL_TOOL_NAME
            ? this.isToolActiveForDisclosure(name, source)
            : this.isToolActive(name, source);
        return active
          ? undefined
          : `Tool "${name}" is disabled by the active tool policy`;
      }),
    );
  }

  withSnapshot<T>(evaluate: () => T): T {
    if (this.snapshot !== undefined) return evaluate();
    this.snapshot = {};
    try {
      return evaluate();
    } finally {
      this.snapshot = undefined;
    }
  }

  private profileData(): ProfileData {
    if (this.snapshot === undefined) return this.profile.data();
    return this.snapshot.profile ??= this.profile.data();
  }

  isToolActive(name: string, source: ToolSource = 'builtin'): boolean {
    const profile = this.profileData();
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
      this.scope.parentAgentId === undefined ? undefined : this.subagentPolicy(profile.toolOverride?.tools ?? (profile.boundProfile === undefined ? profile.activeToolNames : profile.boundProfile.tools)),
      profile,
    );
  }

  isToolActiveForDisclosure(name: string, source: ToolSource = 'builtin'): boolean {
    if (name !== SELECT_TOOLS_TOOL_NAME && name !== CALL_TOOL_NAME) return this.isToolActive(name, source);
    const profile = this.profileData();
    return this.evaluate(
      {
        disallowedTools: profile.disallowedTools,
        disabledToolGroups: profile.disabledToolGroups,
        executionRestriction: profile.executionRestriction,
      },
      name,
      source,
      this.scope.parentAgentId === undefined ? undefined : this.subagentPolicy(profile.toolOverride?.tools ?? (profile.boundProfile === undefined ? profile.activeToolNames : profile.boundProfile.tools)),
      profile,
    );
  }

  isToolActiveForProfile(
    profile: ToolActivationPolicy,
    name: string,
    source: ToolSource = 'builtin',
  ): boolean {
    const data = this.profileData();
    return this.evaluate(
      {
        ...profile,
        executionRestriction: data.executionRestriction ?? profile.executionRestriction,
      },
      name,
      source,
      this.subagentPolicy(profile.tools),
      data,
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
    data: ProfileData,
  ): boolean {
    const capabilities = this.capabilities.current;
    const session = this.session.current;
    const optional = this.optionalPolicy();
    const computerServers = typeof optional?.computerServerNames === 'function' ? optional.computerServerNames() : [];
    const capability = optionalCapabilityForTool(name, computerServers);
    const policy = session === undefined || capability === undefined ? undefined : optional;
    let sendMessageAllowListOverride = false;
    if (policy !== undefined && session !== undefined && capability !== undefined) {
      this.note(policy, session.sessionId, session.workspaceId, data);
      const request = { sessionId: session.sessionId, workspaceId: session.workspaceId, agentId: this.scope.agentId };
      const admission = capability === 'send_message'
        ? admitSendMessageCapability(policy, request, this.delivery.current?.effectiveMode() ?? 'reply')
        : policy.admit(capability, request);
      if (!admission.admitted) {
        if (name === 'SendMessage') this.note(policy, session.sessionId, session.workspaceId, data, false);
        return false;
      }
      if (name === 'SendMessage') {
        const choice = policy.choice(session.sessionId, 'send_message');
        sendMessageAllowListOverride = choice === 'on' ||
          (choice === 'inherit' && (policy.globalState('send_message').defaultOn || isLegacyShippedMessageBinding(
            data,
            this.delivery.current?.effectiveMode() ?? 'reply',
            (path) => this.cleanDefaultPath(path),
          )));
      }
      if (name === 'MemoryWrite' && this.config.get<MemoryConfig>(MEMORY_SECTION)?.approval === 'off') return false;
    } else if (capabilities !== undefined && session !== undefined &&
      !capabilities.toolAvailable(name, session.workspaceId, session.sessionId)) return false;
    const effectiveProfile = name === 'SendMessage' && (sendMessageAllowListOverride || isLegacyShippedMessageBinding(
      data,
      this.delivery.current?.effectiveMode() ?? 'reply',
      (path) => this.cleanDefaultPath(path),
    )) ? { ...profile, tools: undefined, toolAllowPolicies: undefined } : profile;
    const active = isToolActiveComposed(
      {
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile: effectiveProfile,
        global: this.config.get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
        subagent,
        subagentDefault: this.registry.resolve(name)?.subagentDefault,
      },
      name,
      source,
    );
    if (policy !== undefined && session !== undefined && name === 'SendMessage') {
      this.note(policy, session.sessionId, session.workspaceId, data, active);
    }
    return active;
  }

  private optionalPolicy(): IOptionalCapabilityPolicy | undefined {
    if (this.snapshot === undefined) return this.lookupOptionalPolicy();
    return (this.snapshot.optional ??= { value: this.lookupOptionalPolicy() }).value;
  }

  private lookupOptionalPolicy(): IOptionalCapabilityPolicy | undefined {
    try {
      return this.instantiation.invokeFunction((accessor) => accessor.get(IOptionalCapabilityPolicy)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private cleanDefaultPath(path: string): boolean {
    try {
      return this.instantiation.invokeFunction((accessor) => accessor.get(IShippedAgentProfileManager))?.isCleanActivePath(path) === true;
    } catch {
      return false;
    }
  }

  private note(policy: IOptionalCapabilityPolicy, sessionId: string, workspaceId: string, profile: ProfileData, sendMessageActive?: boolean): void {
    const bound = profile.boundProfile;
    const source = capabilityToolsSource(bound?.toolsSource, bound, (path) => this.cleanDefaultPath(path));
    policy.retain(sessionId, this.scope.agentId, {
      workspaceId,
      agentKind: this.scope.parentAgentId === undefined ? 'main' : 'child',
      toolsSource: source,
      declaredTools: source === 'declared' ? [...(profile.toolPolicyBase?.tools ?? bound?.tools ?? [])] : undefined,
      taskTools: profile.toolOverride?.tools === undefined ? undefined : [...profile.toolOverride.tools],
      deliveryMode: this.delivery.current?.effectiveMode() ?? 'reply',
      sendMessageActive,
    });
    if (this.noted) return;
    this.noted = true;
    const agentId = this.scope.agentId;
    this._register({ dispose: () => { policy.release(sessionId, agentId); } });
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
