import { randomUUID } from 'node:crypto';
import { IInstantiationService } from '#/_base/di/instantiation';
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
import { isUserActivatableSkillType, type SkillDefinition } from '#/app/skillCatalog/types';
import { IAgentPromptService, promptRetryFor, reservePrompt, type PromptHandle, type PromptReservation, type PromptTerminalResult } from '#/agent/prompt/prompt';
import { IAgentProfileService } from '#/agent/profile/profile';
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
  type SkillActivationResult,
} from './skill';
import { SkillActivate, skillKey } from './skillOps';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IEventService } from '#/app/event/event';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

interface SkillActivationDelivery {
  readonly turn?: Turn;
  readonly handle?: PromptHandle;
}

function terminalPromptError(terminal: PromptTerminalResult): Error2 {
  const failure = terminal.result?.type === 'failed' ? terminal.result.error : undefined;
  const cancelled = terminal.result?.type === 'cancelled' ? terminal.result.reason : undefined;
  const reason = failure ?? cancelled;
  return new Error2(
    (reason?.code ?? ErrorCodes.INTERNAL) as import('#/errors').ErrorCode,
    reason?.message ?? `Prompt ${terminal.promptId} ended before skill activation could be recovered`,
    { details: reason?.details },
  );
}

function skillActivationResult(
  delivery: SkillActivationDelivery,
  promptId: string | undefined,
): SkillActivationResult {
  if (delivery.handle === undefined) {
    if (delivery.turn === undefined) {
      throw new Error2(ErrorCodes.TURN_AGENT_BUSY, 'Cannot activate skill while another turn is active');
    }
    return { turn_id: delivery.turn.id };
  }
  const handle = delivery.handle;
  if (handle.state === 'failed' || handle.state === 'cancelled') throw promptLaunchFailure(handle);
  return {
    turn_id: delivery.turn?.id,
    prompt_id: promptId ?? handle.id,
    created_at: handle.createdAt,
    state: handle.state === 'pending' ? 'queued' : handle.state === 'blocked' ? 'blocked' : 'running',
    append_timing: handle.appendTiming ?? 'agent_idle',
    revision: handle.revision ?? 0,
  };
}

export class AgentSkillService extends Service implements IAgentSkillService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService agentState: IAgentStateService,
  ) {
    super();
    agentState.contributeState(skillKey);
  }

  async activate(input: SkillActivationInput): Promise<SkillActivationResult> {
    const binding = this.profile.data();
    const executorId = binding.executorId ?? 'native';
    const executorProtocol = binding.executorProtocol ?? 'native';
    if (executorId !== 'native' || executorProtocol !== 'native') {
      const executorLabel = executorId === 'native' ? executorProtocol : executorId;
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `Skill activation is unsupported for external executor "${executorLabel}" on agent "${this.scopeContext.agentId}"; skills cannot be delivered as ordinary prompts`,
        { details: { agentId: this.scopeContext.agentId, executorId, executorProtocol, reason: 'skill_executor_unsupported' } },
      );
    }
    const managed = input.promptId !== undefined && input.retryFingerprint !== undefined;
    if (managed) {
      const receipt = await promptRetryFor(this.prompt).lookup(input.promptId!, input.retryFingerprint!);
      const terminal = this.prompt.lookup(input.promptId!)?.terminal;
      if (terminal?.state === 'failed' || terminal?.state === 'cancelled') throw terminalPromptError(terminal);
      if (receipt !== undefined) {
        const turnId = terminal?.turnId ?? this.prompt.lookup(input.promptId!)?.turnId;
        return {
          turn_id: turnId,
          prompt_id: input.promptId!,
          created_at: receipt.createdAt,
          state: receipt.status === 'queued' ? 'queued' : receipt.status === 'blocked' ? 'blocked' : 'running',
          append_timing: receipt.appendTiming,
          revision: receipt.revision,
        };
      }
    }
    await this.skillCatalog.ready;
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

    const delivery = await this.recordActivation(
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
    let result: SkillActivationResult;
    try {
      result = skillActivationResult(delivery, input.promptId);
    } catch (error) {
      if (managed) await this.commitActivationRetry(input, delivery);
      throw error;
    }
    if (managed) await this.commitActivationRetry(input, delivery);
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
    return result;
  }

  async promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult> {
    return this[skillPromptAdmission](input, reservePrompt(this.prompt));
  }

  async [skillPromptAdmission](input: PromptWithSkillsInput, reservation: PromptReservation): Promise<PromptWithSkillsResult> {
    try {
      return await this.submitReserved(input, reservation);
    } finally {
      reservation.dispose();
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
    const prepared = input.skills.map((skill) => this.prepareBundled(skill));
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
  ): Promise<SkillActivationDelivery> {
    await this.dispatcher.dispatch(new SkillActivate({ origin }));
    this.publishActivation(origin);

    if (input === undefined) return {};
    const message: ContextMessage = {
      role: 'user',
      content: [...input],
      toolCalls: [],
      origin,
    };
    const execution = activation?.afterModelSwitch === undefined
      ? undefined
      : { afterModelSwitch: activation.afterModelSwitch };
    if (this.loop.status().state === 'running' && execution === undefined) {
      return {
        turn: await this.prompt.inject(message, activation?.promptId === undefined ? undefined : {
          promptId: activation.promptId,
          userMessageId: activation.promptId,
          retryFingerprint: activation.retryFingerprint,
        }),
      };
    }
    const handle = await this.prompt.enqueue({
      id: activation?.promptId,
      waitForLaunch: execution === undefined,
      message,
      execution,
    });
    return {
      handle,
      turn: execution === undefined ? await handle.launched : undefined,
    };
  }

  private async commitActivationRetry(
    input: SkillActivationInput,
    delivery: SkillActivationDelivery,
  ): Promise<void> {
    if (input.promptId === undefined || input.retryFingerprint === undefined) return;
    const handle = delivery.handle;
    await promptRetryFor(this.prompt).commit(input.promptId, input.retryFingerprint, {
      status: handle?.state === 'pending' ? 'queued' : handle?.state === 'blocked' ? 'blocked' : 'running',
      createdAt: handle?.createdAt ?? new Date().toISOString(),
      appendTiming: handle?.appendTiming ?? 'agent_idle',
      revision: handle?.revision ?? 0,
    });
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillService,
  AgentSkillService,
  ScopeActivation.OnScopeCreated,
  'skill',
);
