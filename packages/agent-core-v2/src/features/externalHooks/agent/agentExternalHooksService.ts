/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { IInstantiationService, ref, type LiveRef } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { sliceUtf16 } from '#/_base/text/utf16';
import { defineState } from '#/state/state';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTaskService, type AgentTaskInfo, type AgentTaskNotificationContext } from '#/agent/task/task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import { isSubstantiveContentPart } from '#/agent/contextMemory/vacuousContent';
import {
  IAgentFullCompactionService,
  type FullCompactionTask,
} from '#/agent/fullCompaction/fullCompaction';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import { IAgentLoopService, type AfterStepContext, type LoopErrorContext } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted, TurnStepStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  IAgentPromptService,
  type PromptSubmitContext,
} from '#/agent/prompt/prompt';
import { PromptQueued } from '#/agent/prompt/promptService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TaskNotified, TaskStarted } from '#/agent/task/taskOps';
import {
  PermissionApprovalRequested,
  PermissionApprovalResolved,
} from '#/agent/toolApproval/toolApprovalService';
import { IEventBus } from '#/app/event/eventBus';
import { Event2 } from '#/app/event/event2';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ResolvedToolExecutionHookContext, ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { toKimiErrorPayload } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentProfileService } from '#/agent/profile/profile';

import { IAgentExternalHooksService } from './agentExternalHooks';
import {
  IExternalHooksRunnerService,
  triggerBlockingResults,
} from '../app/externalHooksRunner';
import { resolveHookBinding } from '../internal/bindingContext';
import { extractHookPromptText, extractHookTextParts, extractOriginChannel } from '../internal/rules';
import type { HookMatcherValue } from '../internal/types';
import { failureHookInput, permitsFailureContinuation, MAX_FAILURE_RECOVERIES_PER_STREAK } from '../internal/failureRecovery';
import { ISessionHookWorkspace } from '../session/hookRules';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from '../internal/userPrompt';

export interface HookResultPayload {
  readonly turnId?: number;
  readonly hookEvent: string;
  readonly content: string;
  readonly blocked?: boolean;
}

export class HookResult extends Event2<HookResultPayload> {
  static override readonly type = 'hook.result';
  static override readonly observable = true;
}
export interface HookResult extends HookResultPayload {}

export const externalHooksStopHookContinuationUsedKey = defineState<boolean>(
  'externalHooks.stopHookContinuationUsed',
  () => false,
);

export class AgentExternalHooksService extends Service implements IAgentExternalHooksService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ref(IAgentScopeContext) private readonly agentRef: LiveRef<IAgentScopeContext>,
    @ref(IModelService) private readonly modelRef: LiveRef<IModelService>,
    @ref(IProviderService) private readonly providerRef: LiveRef<IProviderService>,
    @ref(IAgentPermissionModeService) private readonly permissionModeRef: LiveRef<IAgentPermissionModeService>,
    @ref(ISessionHookWorkspace) private readonly workspaceRef: LiveRef<ISessionHookWorkspace>,
    @IAgentProfileService private readonly profile?: IAgentProfileService,
  ) {
    super();
    this.states.contributeState(externalHooksStopHookContinuationUsedKey);
    void this.sessionMetadata
      .read()
      .then((meta) => {
        this.sessionTitle = meta.title;
      })
      .catch(() => undefined);
    this._register(
      this.sessionMetadata.onDidChangeMetadata((event) => {
        if (!event.changed.includes('title')) return;
        void this.sessionMetadata
          .read()
          .then((meta) => {
            this.sessionTitle = meta.title;
          })
          .catch(() => undefined);
      }),
    );
    this.registerListeners();
  }

  private sessionTitle: string | undefined;
  private activeTurnId: number | undefined;
  private activeStep: number | undefined;
  private failureTurnId: number | undefined;
  private failureRecoveries = 0;
  private observedFailureTurnId: number | undefined;

  private withSessionFacts(inputData: Record<string, unknown>): Record<string, unknown> {
    const binding = resolveHookBinding({
      profile: this.profile,
      agent: this.agentRef.current,
      models: this.modelRef.current,
      providers: this.providerRef.current,
      permissionMode: this.permissionModeRef.current,
    });
    const agent = this.agentRef.current;
    const workspace = this.workspaceRef.current;
    return {
      sessionTitle: this.sessionTitle,
      workspaceId: workspace?.runtime.identity.workspaceId ?? this.sessionContext.workspaceId,
      executionTarget: workspace?.runtime.identity.runtimeId,
      agentId: agent?.agentId,
      parentAgentId: agent?.parentAgentId,
      agentRole: binding.agentRole,
      profileId: binding.profileId,
      profileName: binding.profileName,
      profilePath: binding.profilePath,
      routeId: binding.routeId,
      modelAlias: binding.modelAlias,
      modelId: binding.remoteModelId,
      providerId: binding.providerId,
      providerType: binding.providerType,
      thinkingEffort: binding.thinkingEffort,
      executorId: binding.executorId,
      permissionMode: binding.permissionMode,
      turnId: this.activeTurnId,
      step: this.activeStep,
      ...inputData,
    };
  }

  private get stopHookContinuationUsed(): boolean {
    return this.states.get(externalHooksStopHookContinuationUsedKey);
  }

  private set stopHookContinuationUsed(value: boolean) {
    this.states.set(externalHooksStopHookContinuationUsedKey, value);
  }

  private fireAndForget(
    event: string,
    inputData: Record<string, unknown>,
    matcherValue?: HookMatcherValue,
    signal?: AbortSignal,
  ): void {
    try {
      void this.runner.fireAndForgetTrigger(event, {
        matcherValue,
        signal,
        cwd: this.sessionContext.cwd,
        sessionId: this.sessionContext.sessionId,
        additionalHooks: () => this.profile?.getRecipeScriptHooks() ?? Promise.resolve([]),
        inputData: this.withSessionFacts(inputData),
      });
    } catch {}
  }

  private registerListeners(): void {
    this.registerPermissionHooks();

    this.registerToolHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentToolExecutorService)),
    );

    this.registerPromptHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentPromptService)),
    );

    this.registerTurnHooks();

    this.registerLoopHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentLoopService)),
    );

    this.registerFullCompactionHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentFullCompactionService)),
    );

    this.registerTaskHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentTaskService)),
    );
  }

  private registerToolHooks(toolExecutor: IAgentToolExecutorService): void {
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        const reason = await this.runPreToolUse(event);
        if (reason !== undefined) {
          event.veto(denyToolExecution(reason));
        }
      }),
    );
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('externalHooks', async (ctx, next) => {
        this.notifyPostToolUse(ctx);
        await next();
      }),
    );
  }

  private registerPermissionHooks(): void {
    this._register(
      this.eventBus.subscribe(PermissionApprovalRequested, (e) => {
        const { type: _type, time: _time, ...inputData } = e;
        this.fireAndForget('PermissionRequest', inputData, e.toolName);
      }),
    );
    this._register(
      this.eventBus.subscribe(PermissionApprovalResolved, (e) => {
        const { type: _type, time: _time, ...inputData } = e;
        this.fireAndForget('PermissionResult', inputData, e.toolName);
      }),
    );
  }

  private registerPromptHooks(prompt: IAgentPromptService): void {
    this._register(
      prompt.hooks.onBeforeSubmitPrompt.register('externalHooks', async (ctx, next) => {
        if (await this.runPromptSubmitHook(ctx)) {
          ctx.block = true;
          return;
        }
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe(PromptQueued, (e) => {
        const origin = e.origin ?? USER_PROMPT_ORIGIN;
        this.fireAndForget(
          'UserPromptQueued',
          {
            promptId: e.promptId,
            userMessageId: e.userMessageId,
            origin,
            channel: extractOriginChannel(origin),
            prompt: e.content,
            promptText: extractHookTextParts(e.content),
            queueLength: e.queueLength,
          },
          e.content,
        );
      }),
    );
  }

  private registerTurnHooks(): void {
    this._register(
      this.eventBus.subscribe(TurnStarted, (e) => this.notifyTurnStarted(e)),
    );
    this._register(
      this.eventBus.subscribe(TurnStepStarted, (e) => {
        this.activeTurnId = e.turnId;
        this.activeStep = e.step;
      }),
    );
    this._register(
      this.eventBus.subscribe(TurnEnded, (e) => this.notifyTurnEnded(e)),
    );
  }

  private notifyTurnStarted(event: TurnStarted): void {
    this.activeTurnId = event.turnId;
    this.activeStep = undefined;
    this.failureTurnId = event.turnId;
    this.failureRecoveries = 0;
    this.observedFailureTurnId = undefined;
    this.fireAndForget(
      'TurnStarted',
      {
        turnId: event.turnId,
        promptId: event.promptId,
        origin: event.origin,
        originKind: event.origin.kind,
        originName: 'name' in event.origin ? event.origin.name : undefined,
        channel: extractOriginChannel(event.origin),
        prompt: event.prompt,
      },
      event.origin.kind,
    );
  }

  private registerLoopHooks(loop: IAgentLoopService): void {
    this._register(loop.registerLoopErrorHandler({
      id: 'externalHooks.failureRecovery',
      match: () => true,
      handle: (ctx) => this.runStopFailure(ctx),
    }, { phase: 'fallback' }));
    this._register(
      loop.hooks.onDidFinishStep.register('externalHooks', async (ctx, next) => {
        if (ctx.modelResponseCompleted === true) {
          this.failureRecoveries = 0;
        }
        await next();
        if (
          ctx.finishReason === 'tool_calls' ||
          ctx.finishReason === 'filtered' ||
          loop.hasPendingRequests()
        ) {
          return;
        }
        const reason = await this.runStop(ctx);
        if (reason !== undefined) {
          this.stopHookContinuationUsed = true;
          this.context.appendObservable({
            role: 'user',
            content: [{ type: 'text', text: reason }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'stop_hook' },
          });
          loop.enqueue(
            new ContinuationStepRequest({
              kind: 'stop_hook',
              mergeable: true,
              admission: 'activeOrNextTurn',
            }),
          );
          return;
        }
      }),
    );
  }

  private registerFullCompactionHooks(fullCompaction: IAgentFullCompactionService): void {
    this._register(
      fullCompaction.hooks.onWillCompact.register('externalHooks', async (ctx, next) => {
        await this.runPreCompact(ctx);
        void ctx.promise
          .then((result) => this.notifyPostCompact(ctx, result))
          .catch(() => undefined);
        await next();
      }),
    );
  }

  private registerTaskHooks(_tasks: IAgentTaskService): void {
    this._register(
      this.eventBus.subscribe(TaskNotified, (e) => {
        const { type: _type, time: _time, ...ctx } = e;
        this.notifyTaskNotification(ctx);
      }),
    );
    this._register(
      this.eventBus.subscribe(TaskStarted, (e) => this.notifyTaskStarted(e.info)),
    );
  }

  private notifyTaskStarted(info: AgentTaskInfo): void {
    this.fireAndForget(
      'TaskStarted',
      {
        taskId: info.taskId,
        kind: info.kind,
        description: info.description,
        status: info.status,
        detached: info.detached,
        startedAt: info.startedAt,
      },
      info.kind,
    );
  }

  private async runPreToolUse(ctx: ResolvedToolExecutionHookContext): Promise<string | undefined> {
    ctx.signal.throwIfAborted();
    const toolInput = isPlainRecord(ctx.args) ? ctx.args : {};
    const block = await this.runner.triggerBlock('PreToolUse', {
      matcherValue: ctx.toolCall.name,
      signal: ctx.signal,
      cwd: this.sessionContext.cwd,
      sessionId: this.sessionContext.sessionId,
      additionalHooks: () => this.profile?.getRecipeScriptHooks() ?? Promise.resolve([]),
      inputData: this.withSessionFacts({
        turnId: ctx.turnId ?? this.activeTurnId,
        toolName: ctx.toolCall.name,
        toolInput,
        toolCallId: ctx.toolCall.id,
      }),
    });
    ctx.signal.throwIfAborted();
    return block?.reason;
  }

  private notifyPostToolUse(ctx: ToolDidExecuteContext): void {
    const output = toolOutputText(ctx.result.output);
    const isError = ctx.result.isError === true;
    this.fireAndForget(
      isError ? 'PostToolUseFailure' : 'PostToolUse',
      {
        turnId: ctx.turnId ?? this.activeTurnId,
        toolName: ctx.toolCall.name,
        toolInput: isPlainRecord(ctx.args) ? ctx.args : {},
        toolCallId: ctx.toolCall.id,
        error: isError ? toKimiErrorPayload(output) : undefined,
        toolOutput: isError ? undefined : sliceUtf16(output, 0, 2000),
      },
      ctx.toolCall.name,
      ctx.signal,
    );
  }

  private async runPromptSubmitHook(
    ctx: PromptSubmitContext,
  ): Promise<boolean> {
    const origin = ctx.promptMessage.origin ?? USER_PROMPT_ORIGIN;
    if (origin.kind !== 'user') return false;

    const signal = new AbortController().signal;
    const input = ctx.promptMessage.content;
    const promptId = ctx.promptId ?? ctx.promptMessage.id;
    const userMessageId = ctx.userMessageId ?? ctx.promptMessage.id;
    const promptText = extractHookPromptText(ctx.promptMessage);
    signal.throwIfAborted();
    const results = await triggerBlockingResults(this.runner, 'UserPromptSubmit', {
      matcherValue: input,
      signal,
      cwd: this.sessionContext.cwd,
      sessionId: this.sessionContext.sessionId,
      additionalHooks: () => this.profile?.getRecipeScriptHooks() ?? Promise.resolve([]),
      inputData: this.withSessionFacts({
        promptId,
        userMessageId,
        origin,
        channel: extractOriginChannel(origin),
        prompt: input,
        promptText: promptText.length > 0 ? promptText : undefined,
        isSteer: ctx.isSteer,
      }),
    });
    signal.throwIfAborted();

    const block = renderUserPromptHookBlockResult(results);
    if (block !== undefined) {
      const message: ContextMessage = { role: 'assistant', content: [{ type: 'text', text: block.text }], toolCalls: [], origin: { kind: 'hook_result', event: block.event, blocked: true } };
      if (ctx.appendMessage !== undefined) ctx.appendMessage(message);
      else this.context.append(message);
      void this.dispatcher.dispatch(
        new HookResult({
          hookEvent: block.event,
          content: block.message,
          blocked: true,
        }),
      );
      return true;
    }

    const append = renderUserPromptHookResult(results);
    if (append !== undefined) {
      const message: ContextMessage = { role: 'user', content: [{ type: 'text', text: append.text }], toolCalls: [], origin: { kind: 'hook_result', event: append.event } };
      if (ctx.appendMessage !== undefined) ctx.appendMessage(message);
      else this.context.appendObservable(message);
      void this.dispatcher.dispatch(
        new HookResult({
          hookEvent: append.event,
          content: append.message,
        }),
      );
    }
    return false;
  }

  private notifyTurnEnded(event: TurnEnded): void {
    this.stopHookContinuationUsed = false;
    this.activeStep = undefined;
    if (event.reason === 'failed' && event.error !== undefined && this.observedFailureTurnId !== event.turnId) {
      const payload = toKimiErrorPayload(event.error);
      this.fireAndForget('StopFailure', {
        ...failureHookInput(payload, this.hasPartialOutput(event.turnId)),
        modelAlias: this.profile?.data?.()?.modelAlias,
        turnId: event.turnId,
        recoverable: false,
      }, payload.name);
    }
    if (event.reason === 'cancelled') {
      this.fireAndForget('Interrupt', { turnId: event.turnId, reason: 'cancelled' });
    }
    this.activeTurnId = undefined;
    this.failureTurnId = undefined;
    this.failureRecoveries = 0;
    this.observedFailureTurnId = undefined;
  }

  private hasPartialOutput(turnId: number, stepId?: string): boolean {
    return this.context.get().some((message) =>
      message.role === 'assistant' && message.partial === true &&
      message.source?.turnId === turnId && (stepId === undefined || message.source.stepId === stepId) &&
      (message.toolCalls.length > 0 || message.content.some(isSubstantiveContentPart)),
    );
  }

  private async runStopFailure(ctx: LoopErrorContext): Promise<boolean> {
    const signal = ctx.currentStep === undefined ? ctx.signal : AbortSignal.any([ctx.signal, ctx.currentStep.signal]);
    signal.throwIfAborted();
    if (this.failureTurnId !== ctx.turnId) {
      this.failureTurnId = ctx.turnId;
      this.failureRecoveries = 0;
    }
    this.observedFailureTurnId = ctx.turnId;
    const payload = toKimiErrorPayload(ctx.error);
    const hasPartialOutput = ctx.requestFailed === true && this.hasPartialOutput(ctx.turnId, ctx.stepId);
    const recoverable = ctx.requestFailed === true && permitsFailureContinuation(payload) &&
      this.failureRecoveries < MAX_FAILURE_RECOVERIES_PER_STREAK;
    let results;
    try {
      results = await this.runner.trigger('StopFailure', {
        matcherValue: payload.name,
        signal,
        cwd: this.sessionContext.cwd,
        sessionId: this.sessionContext.sessionId,
        additionalHooks: () => this.profile?.getRecipeScriptHooks() ?? Promise.resolve([]),
        inputData: this.withSessionFacts({
          ...failureHookInput(payload, hasPartialOutput),
          modelAlias: this.profile?.data?.()?.modelAlias,
          turnId: ctx.turnId,
          step: ctx.step,
          recoverable,
          recoveryAttempts: this.failureRecoveries,
          maxRecoveryAttempts: MAX_FAILURE_RECOVERIES_PER_STREAK,
        }),
      }, 'block');
    } catch {
      signal.throwIfAborted();
      return false;
    }
    signal.throwIfAborted();
    if (!recoverable || results.some((result) => result.action === 'block')) return false;
    const messages = new Set(results.flatMap(({ recovery }) => {
      if (recovery === undefined) return [];
      return [recovery.action === 'retry' || (recovery.action === 'auto' && !hasPartialOutput)
        ? undefined
        : recovery.userMessage];
    }));
    if (messages.size !== 1) return false;
    const [userMessage] = messages;
    this.failureRecoveries += 1;
    this.observedFailureTurnId = undefined;
    if (userMessage !== undefined) {
      this.context.appendObservable({
        role: 'user',
        content: [{ type: 'text', text: userMessage }],
        toolCalls: [],
        origin: { kind: 'system_trigger', name: 'failure_recovery_hook' },
      });
    }
    ctx.retry(new ContinuationStepRequest({ kind: 'failure_recovery_hook', admission: 'activeTurnOnly' }), { at: 'head' });
    return true;
  }

  private async runStop(ctx: AfterStepContext): Promise<string | undefined> {
    ctx.signal.throwIfAborted();
    if (this.stopHookContinuationUsed) return undefined;

    const block = await this.runner.triggerBlock('Stop', {
      signal: ctx.signal,
      cwd: this.sessionContext.cwd,
      sessionId: this.sessionContext.sessionId,
      additionalHooks: () => this.profile?.getRecipeScriptHooks() ?? Promise.resolve([]),
      inputData: this.withSessionFacts({
        turnId: ctx.turnId,
        step: ctx.step,
        stopHookActive: false,
      }),
    });
    ctx.signal.throwIfAborted();
    return block?.reason;
  }

  private async runPreCompact(ctx: FullCompactionTask): Promise<void> {
    const signal = ctx.abortController.signal;
    signal.throwIfAborted();
    await this.runner.trigger('PreCompact', {
      matcherValue: ctx.trigger,
      signal,
      cwd: this.sessionContext.cwd,
      sessionId: this.sessionContext.sessionId,
      additionalHooks: () => this.profile?.getRecipeScriptHooks() ?? Promise.resolve([]),
      inputData: this.withSessionFacts({
        trigger: ctx.trigger,
        tokenCount: ctx.tokenCount,
      }),
    });
    signal.throwIfAborted();
  }

  private notifyPostCompact(ctx: FullCompactionTask, result: CompactionResult): void {
    this.fireAndForget(
      'PostCompact',
      {
        trigger: ctx.trigger,
        estimatedTokenCount: result.tokensAfter,
      },
      ctx.trigger,
    );
  }

  private notifyTaskNotification(ctx: AgentTaskNotificationContext): void {
    const signal = new AbortController().signal;
    this.fireAndForget(
      'Notification',
      { sink: 'context', ...ctx },
      ctx.notificationType,
      signal,
    );
  }
}

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}
