import { randomUUID } from 'node:crypto';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { ISessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';
import { assertPluginSkillUsage } from './pluginSkillUsage';
import { IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { validatePromptRuntimeControls } from '#/agent/prompt/runtimeControls';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '#/kosong/contract/message';

import type {
  BundledSkillActivation,
  ContextMessage,
  SkillActivationOrigin,
} from '#/agent/contextMemory/types';
import { promptMetadataTextFromSkill, renderUserSlashSkillPrompt } from './prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { promptLaunchFailure } from '#/agent/prompt/promptFailure';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { Service } from '#/_base/di/service';
import { ErrorCodes, Error2 } from '#/errors';
import { isUserActivatableSkillType, normalizeSkillName, type SkillDefinition } from '#/app/skillCatalog/types';
import { IAgentPromptService, promptRetryFor, reservePrompt, type PromptLaunchResult, type PromptReservation } from '#/agent/prompt/prompt';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentSkillService,
  skillPromptAdmission,
  type PromptSkillActivation,
  type PromptWithSkillsInput,
  type PromptWithSkillsResult,
  type SkillActivationInput,
} from './skill';
import { SkillActivate, skillKey } from './skillOps';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IEventService } from '#/app/event/event';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

export class AgentSkillService extends Service implements IAgentSkillService {
  declare readonly _serviceBrand: undefined;
  private readonly discovery?: ISkillDiscovery;
  private readonly sessionPluginUsage?: ISessionPluginUsageService;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService agentState: IAgentStateService,
    @IPluginService private readonly plugins?: IPluginService,
    @IPluginUsageService private readonly usage?: IPluginUsageService,
  ) {
    super();
    this.discovery = optionalService(this.instantiation, ISkillDiscovery);
    this.sessionPluginUsage = optionalService(this.instantiation, ISessionPluginUsageService);
    agentState.contributeState(skillKey);
  }

  async activate(input: SkillActivationInput): Promise<PromptLaunchResult> {
    if (input.promptId !== undefined && input.retryFingerprint !== undefined) {
      const receipt = await promptRetryFor(this.prompt).lookup(input.promptId, input.retryFingerprint);
      if (receipt !== undefined) {
        const turnId = this.prompt.lookup(input.promptId)?.turnId;
        if (turnId === undefined) throw new Error2(ErrorCodes.INTERNAL, `Prompt "${input.promptId}" has no assigned turn`);
        return { turn_id: turnId };
      }
    }
    await this.skillCatalog.ready;
    let skill = this.skillCatalog.catalog.getSkill(input.name);
    if (skill === undefined) {
      const managementSkill = await this.findManagementPluginSkill(input.name);
      if (managementSkill?.plugin?.id !== undefined && this.sessionPluginUsage !== undefined) {
        await this.sessionPluginUsage.set(managementSkill.plugin.id, 'on');
        await this.skillCatalog.reload();
        skill = this.skillCatalog.catalog.getSkill(input.name);
      }
    }
    if (skill === undefined) {
      throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new Error2(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${skill.name}" cannot be activated by the user`,
      );
    }

    await this.enableExplicitPluginSkill(skill.path);
    await assertPluginSkillUsage(
      skill.path,
      this.sessionContext.workspaceId,
      this.plugins,
      this.usage,
      this.sessionContext.sessionId,
    );
    const skillArgs = input.args ?? '';
    const skillContent = this.renderSkillPrompt(skill, skillArgs);
    const content: ContentPart[] = [
      {
        type: 'text',
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
      },
      ...(input.content ?? []),
    ];

    const turn = await this.recordActivation(
      {
        kind: 'skill_activation',
        activationId: randomUUID(),
        skillName: skill.name,
        trigger: 'user-slash',
        skillType: skill.metadata.type,
        skillPath: skill.path,
        skillSource: skill.source,
        skillArgs: input.args,
        userInput: input.userInput ?? `/${input.name}${skillArgs === '' ? '' : ` ${skillArgs}`}`,
      },
      content,
      input,
    );
    if (turn === undefined) {
      throw new Error2(
        ErrorCodes.TURN_AGENT_BUSY,
        'Cannot activate skill while another turn is active',
      );
    }
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      await applyPromptMetadataUpdate(
        {
          metadata: this.metadata,
          eventService: this.eventService,
          sessionId: this.sessionContext.sessionId,
        },
        promptMetadataTextFromSkill(input),
      );
    }
    return { turn_id: turn.id };
  }

  async promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult> {
    return this[skillPromptAdmission](input, reservePrompt(this.prompt));
  }

  async [skillPromptAdmission](input: PromptWithSkillsInput, reservation: PromptReservation): Promise<PromptWithSkillsResult> {
    try {
      return await this.submitReserved(input, reservation);
    } finally {
      await reservation.dispose();
    }
  }

  private async submitReserved(input: PromptWithSkillsInput, reservation: PromptReservation): Promise<PromptWithSkillsResult> {
    if (input.input.length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'promptWithSkills requires a non-empty prompt');
    }
    if (input.skills.length === 0) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'promptWithSkills requires at least one skill',
      );
    }
    await this.skillCatalog.ready;
    const prepared = await Promise.all(input.skills.map(async (inputSkill) => {
      let skill = this.skillCatalog.catalog.getSkill(inputSkill.name);
      if (skill === undefined) {
        const managementSkill = await this.findManagementPluginSkill(inputSkill.name);
        if (managementSkill?.plugin?.id !== undefined && this.sessionPluginUsage !== undefined) {
          await this.sessionPluginUsage.set(managementSkill.plugin.id, 'on');
          await this.skillCatalog.reload();
          skill = this.skillCatalog.catalog.getSkill(inputSkill.name);
        }
      }
      if (skill === undefined) throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${inputSkill.name}" was not found`);
      await this.enableExplicitPluginSkill(skill.path);
      await assertPluginSkillUsage(
        skill.path,
        this.sessionContext.workspaceId,
        this.plugins,
        this.usage,
        this.sessionContext.sessionId,
      );
      const activation = this.prepareBundled(inputSkill);
      return activation;
    }));
    this.instantiation.invokeFunction((accessor) => validatePromptRuntimeControls(accessor, input.execution));
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      await applyPromptMetadataUpdate(
        {
          metadata: this.metadata,
          eventService: this.eventService,
          sessionId: this.sessionContext.sessionId,
        },
        promptMetadataTextFromContentParts(input.input),
      );
    }
    for (const activation of prepared) {
      void this.recordActivation(activation.origin);
    }
    const handle = await reservation.submit({
      role: 'user',
      content: [...prepared.map((activation) => activation.part), ...input.input],
      toolCalls: [],
      origin: {
        kind: 'user',
        skillActivations: prepared.map((activation) => activation.entry),
        originalInput: input.input.filter((part) => part.type === 'text'),
      },
    }, input.execution, input.deferredDisabledTools, input.appendTiming);
    if (handle.state === 'pending') {
      return {
        prompt_id: handle.id,
        created_at: handle.createdAt,
        state: 'queued',
        append_timing: handle.appendTiming ?? 'agent_idle',
        revision: handle.revision ?? 0,
      };
    }
    const turn = await handle.launched;
    if (turn === undefined && handle.state !== 'blocked') {
      throw promptLaunchFailure(handle);
    }
    return {
      turn_id: turn?.id,
      prompt_id: handle.id,
      created_at: handle.createdAt,
      state: handle.state === 'blocked' ? 'blocked' : 'running',
      append_timing: handle.appendTiming ?? 'agent_idle',
      revision: handle.revision ?? 0,
    };
  }

  recordModelToolActivation(origin: SkillActivationOrigin): void {
    void this.recordActivation(origin);
  }

  private async findManagementPluginSkill(name: string): Promise<SkillDefinition | undefined> {
    if (this.plugins === undefined || this.discovery === undefined) return undefined;
    const roots = await this.plugins.pluginSkillRoots('*');
    const contribution = await this.discovery.discover(roots);
    const target = normalizeSkillName(name);
    return contribution.skills.find((skill) => normalizeSkillName(skill.name) === target);
  }

  private async enableExplicitPluginSkill(path: string): Promise<void> {
    if (this.plugins === undefined || this.sessionPluginUsage === undefined) return;
    const pluginId = await this.plugins.pluginSkillOwner(path);
    if (pluginId !== undefined) await this.sessionPluginUsage.set(pluginId, 'on');
  }

  private prepareBundled(input: PromptSkillActivation): {
    readonly origin: SkillActivationOrigin;
    readonly part: ContentPart;
    readonly entry: BundledSkillActivation;
  } {
    const skill = this.skillCatalog.catalog.getSkill(input.name);
    if (skill === undefined) {
      throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new Error2(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${skill.name}" cannot be activated by the user`,
      );
    }

    const skillArgs = input.args ?? '';
    const skillContent = this.renderSkillPrompt(skill, skillArgs);
    const origin: SkillActivationOrigin = {
      kind: 'skill_activation',
      activationId: randomUUID(),
      skillName: skill.name,
      trigger: 'user-slash',
      skillType: skill.metadata.type,
      skillPath: skill.path,
      skillSource: skill.source,
      skillArgs: input.args,
    };
    return {
      origin,
      part: {
        type: 'text',
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
      },
      entry: {
        activationId: origin.activationId,
        skillName: origin.skillName,
        skillArgs: origin.skillArgs,
        skillType: origin.skillType,
        skillPath: origin.skillPath,
        skillSource: origin.skillSource,
      },
    };
  }

  private async recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
    activation?: SkillActivationInput,
  ): Promise<Turn | undefined> {
    await this.dispatcher.dispatch(new SkillActivate({ origin }));
    this.publishActivation(origin);

    if (input === undefined) return undefined;
    const message: ContextMessage = {
      role: 'user',
      content: [...input],
      toolCalls: [],
      origin,
    };
    if (this.loop.status().state === 'running') {
      return this.prompt.inject(message, activation?.promptId === undefined ? undefined : {
        promptId: activation.promptId,
        userMessageId: activation.promptId,
        retryFingerprint: activation.retryFingerprint,
      });
    }
    return (await this.prompt.enqueue({
      id: activation?.promptId,
      userMessageId: activation?.promptId,
      retryFingerprint: activation?.retryFingerprint,
      message,
    })).launched;
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.skillCatalog.catalog.renderSkillPrompt(skill, rawArgs, {
      sessionId: this.sessionContext.sessionId,
    });
  }

  private publishActivation(origin: SkillActivationOrigin): void {
    this.telemetry.track2('skill_invoked', {
      skill_name: origin.skillName,
      trigger: origin.trigger,
    });
    if (origin.skillType === 'flow') {
      this.telemetry.track2('flow_invoked', {
        flow_name: origin.skillName,
      });
    }
  }
}

function optionalService<T>(instantiation: IInstantiationService, id: ServiceIdentifier<T>): T | undefined {
  try {
    return instantiation.invokeFunction((accessor) => accessor.get(id));
  } catch {
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillService,
  AgentSkillService,
  ScopeActivation.OnScopeCreated,
  'skill',
);
