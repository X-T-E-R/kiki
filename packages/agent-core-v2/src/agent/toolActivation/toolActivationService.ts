import { type CollectionView } from '#/_base/di/collection';
import { IInstantiationService } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IShippedAgentProfileManager } from '#/app/shippedAgentProfiles/shippedAgentProfileManager';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { CALL_TOOL_NAME, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';

import { IAgentToolActivationService } from './toolActivation';
import { toolGroupForName } from '#/agent/toolRegistry/toolGroups';

const SEND_MESSAGE_TOOL_NAME = 'SendMessage';

export class AgentToolActivationService extends Service implements IAgentToolActivationService {
  declare readonly _serviceBrand: undefined;

  private readonly registrations = new Map<AgentToolContribution, IDisposable>();

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IEventBus eventBus: IEventBus,
    @IConfigService config: IConfigService,
    @ISessionDeliveryService private readonly delivery: ISessionDeliveryService,
    @IShippedAgentProfileManager private readonly shippedProfiles: IShippedAgentProfileManager,
    @AgentToolContribution private readonly contributions: CollectionView<AgentToolContribution>,
  ) {
    super();
    this._register(
      eventBus.subscribe(AgentStatusUpdated, () => {
        this.refreshConditionalRecords();
      }),
    );
    this._register(delivery.onDidChangeEffective(() => {
      this.refreshConditionalRecords();
    }));
    this._register(this.runtime.onDidChange(() => {
      this.refreshRuntimeRecords();
    }));
    this._register(config.onDidSectionChange(() => {
      this.refreshConditionalRecords();
    }));
    this._register(
      this.contributions.onDidChange((change) => {
        this.activateRecords(change.added);
        for (const record of change.removed) {
          this.deactivateRecord(record);
        }
      }),
    );
  }

  async activate(): Promise<void> {
    await this.shippedProfiles.ready;
    this.activateRecords(this.contributions.items);
  }

  capabilities(): ReturnType<IAgentToolActivationService['capabilities']> {
    return this.instantiationService.invokeFunction((accessor) => this.contributions.items.map((record) => ({
      name: record.options.name,
      source: record.options.source ?? 'builtin',
      category: record.options.domain ?? 'other',
      group: toolGroupForName(record.options.name),
      runtimeAvailable: this.runtimeAllows(record),
      conditionAvailable: record.options.when?.(accessor) ?? true,
    })));
  }

  private activateRecords(records: readonly AgentToolContribution[]): void {
    if (records.length === 0) return;
    const data = this.profile.data();
    const policy = {
      tools: data.activeToolNames,
      toolAllowPolicies: data.toolAllowPolicies,
      disallowedTools: data.disallowedTools,
      disabledToolGroups: data.disabledToolGroups,
    };
    const workspaceVeto = { disallowedTools: this.toolPolicyGate.disabledTools };
    this.instantiationService.invokeFunction((accessor) => {
      for (const record of records) {
        const { id, options } = record;
        const source = options.source ?? 'builtin';
        if (this.toolRegistry.resolve(options.name) !== undefined) continue;
        if (!this.runtimeAllows(record)) continue;
        if (!isToolActive(workspaceVeto, options.name, source)) continue;
        const disclosureControl = options.name === SELECT_TOOLS_TOOL_NAME || options.name === CALL_TOOL_NAME;
        const policyActive = isToolActive(disclosureControl
          ? { disallowedTools: policy.disallowedTools, disabledToolGroups: policy.disabledToolGroups }
          : policy, options.name, source);
        const compatibilityActive = options.name === SEND_MESSAGE_TOOL_NAME &&
          this.isLegacyShippedMessageBinding(policy, options.name, source);
        if (!policyActive && !compatibilityActive) continue;
        if (options.when !== undefined && !options.when(accessor)) continue;
        const tool = accessor.get(id);
        const registration = this.toolRegistry.register(tool, {
          source: options.source,
          disclosure: options.disclosure,
        });
        this.registrations.set(record, registration);
        this._register(registration);
      }
    });
  }

  private isLegacyShippedMessageBinding(
    policy: {
      readonly tools?: readonly string[];
      readonly toolAllowPolicies?: readonly (readonly string[])[];
      readonly disallowedTools?: readonly string[];
      readonly disabledToolGroups?: readonly import('@kiki/agent-profiles/toolGroups').ToolGroupId[];
    },
    name: string,
    source: 'builtin' | 'user' | 'mcp' | 'plugin',
  ): boolean {
    const data = this.profile.data();
    if (
      this.delivery.effectiveMode() !== 'message' ||
      data.activeToolNames === undefined ||
      data.activeToolNames.includes(name)
    ) return false;
    const definitionId = data.profileDefinitionId ?? data.boundProfile?.definitionId;
    if (definitionId === undefined) return false;
    const shipped = definitionId.startsWith('shipped://agent-profiles/') ||
      this.shippedProfiles.isCleanActivePath(definitionId);
    if (!shipped) return false;
    return isToolActive({ ...policy, tools: undefined }, name, source);
  }

  private refreshRuntimeRecords(): void {
    for (const record of this.contributions.items) {
      if (!this.runtimeAllows(record)) this.deactivateRecord(record);
    }
    this.activateRecords(this.contributions.items);
  }

  private refreshConditionalRecords(): void {
    this.instantiationService.invokeFunction((accessor) => {
      for (const record of this.contributions.items) {
        if (record.options.when?.(accessor) === false) this.deactivateRecord(record);
      }
    });
    this.activateRecords(this.contributions.items);
  }

  private runtimeAllows(record: AgentToolContribution): boolean {
    const required = record.options.requiredRuntimeCapabilities;
    return required === undefined || this.runtime.isAvailable(required);
  }

  private deactivateRecord(record: AgentToolContribution): void {
    const registration = this.registrations.get(record);
    if (registration === undefined) return;
    this.registrations.delete(record);
    registration.dispose();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolActivationService,
  AgentToolActivationService,
  ScopeActivation.OnScopeCreated,
  'toolActivation',
);
