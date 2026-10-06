import type { IDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IInstantiationService } from '#/_base/di/instantiation';
import { timeoutOutcome } from '#/_base/utils/promise';
import { IFlagService } from '#/app/flag/flag';
import { TASK_BOARD_FLAG_ID } from '#/app/taskBoard/flag';
import { ITaskBoardService } from '#/app/taskBoard/taskBoard';
import { Service } from "#/_base/di/service";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import { renderPrompt } from "#/_base/utils/render-prompt";
import { buildCompactionSummaryText, buildContextCompactionShape, isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { retryBackoffDelay, sleepForRetry } from '#/_base/utils/retry';
import { IAgentLoopService, type LoopErrorContext } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { isAbortError } from '#/_base/utils/abort';
import { IAgentProfileService, type ProfileModelContext } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { stripDynamicToolContext } from '#/agent/toolSelect/dynamicTools';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { renderTodoList, type TodoItem } from '#/session/todo/todoItem';
import { compactionDirectivesBudget, renderTodoNotes } from '#/session/todo/todoNotes';
import { IAgentMemorySnapshot, memoryEntryReference } from '#/app/memory/memorySnapshot';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IConfigService } from '#/app/config/config';
import { type LoopControl } from '#/agent/loop/configSection';
import { contextWindowEpochKey } from './windowEpoch';
import { ContextStrategyOverrideChanged, contextStrategyOverrideKey } from './contextStrategyOps';
import { evaluateFreshEligibility, type ReasonCode } from './freshEligibility';
import { renderLinkedBoardCards, renderPendingReceipts, renderRelay, renderStandingDirectives, type RelayInput } from './relayPackage';
import {
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
} from '#/kosong/contract/errors';
import { createUserMessage, type Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { inputTotal, type TokenUsage } from '#/kosong/contract/usage';
import { IEventBus } from '#/app/event/eventBus';
import type { CompactionFailedEvent, CompactionFinishedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isCodedError, isError2, toKimiErrorPayload } from "#/errors";
import { AgentErrorEvent } from '#/agent/mcp/mcpEvents';
import { IEventDispatcher } from '#/state/eventDispatcher';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import {
  IAgentFullCompactionService,
  type FullCompactionInput,
  type FullCompactionTask,
} from './fullCompaction';
import {
  RuntimeCompactionStrategy,
  type CompactionStrategy,
} from './strategy';
import {
  CompactionBlocked,
  CompactionCancelled,
  CompactionCompleted,
  fullCompactionKey,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
} from './compactionOps';
import {
  type CompactionBeginData,
  type CompactionResult,
} from './types';
import { Emitter, type Event } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import { resolveAutoCompact, type ResolvedAutoCompact } from './autoCompact';
import { AutoCompactOverrideChanged, autoCompactOverrideKey } from './autoCompactOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { describeCompactionFailure, isRetryableCompactionError } from './compactionFailure';

export const MAX_COMPACTION_RETRY_ATTEMPTS = 3;
const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;
const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;
const OVERFLOW_STATUS_RECOVERY_RATIO = 0.5;
const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

type CompactionTelemetryProperties = Pick<
  CompactionFinishedEvent,
  'input_tokens' | 'output_tokens' | 'input_cache_read' | 'input_cache_creation'
>;

interface ActiveCompaction extends FullCompactionTask {
  readonly originTurnId?: number;
  readonly quiescence?: IDisposable;
  trace?: LLMRequestTrace;
  blockedByTurn: boolean;
}

interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
  readonly traceId?: string;
}

class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export const fullCompactionCompactionCountInTurnKey = defineState<number>(
  'fullCompaction.compactionCountInTurn',
  () => 0,
);
export const fullCompactionObservedMaxContextTokensByModelKey = defineState<Map<string, number>>(
  'fullCompaction.observedMaxContextTokensByModel',
  () => new Map(),
);
export const fullCompactionLastCompactedTokenCountKey = defineState<number | null>(
  'fullCompaction.lastCompactedTokenCount',
  () => null,
);
export const fullCompactionConsecutiveOverflowCompactionsKey = defineState<number>(
  'fullCompaction.consecutiveOverflowCompactions',
  () => 0,
);
export const fullCompactionActiveTurnIdKey = defineState<number | undefined>(
  'fullCompaction.activeTurnId',
  () => undefined as number | undefined,
);

export class AgentFullCompactionService extends Service implements IAgentFullCompactionService {
  declare readonly _serviceBrand: undefined;
  readonly hooks: IAgentFullCompactionService['hooks'] = {
    onWillCompact: new OrderedHookSlot<FullCompactionTask>(),
  };
  private readonly _onDidFinishCompaction = this._register(new Emitter<FullCompactionTask>());
  readonly onDidFinishCompaction: Event<FullCompactionTask> = this._onDidFinishCompaction.event;

  private readonly strategy: CompactionStrategy;
  private _compacting: ActiveCompaction | null = null;
  private pendingManual: CompactionBeginData | null = null;
  private compactedHistoryLength: number | null = null;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTokenCountingService private readonly tokenCounting: IAgentTokenCountingService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IEventBus private readonly eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IConfigService private readonly appConfig: IConfigService,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentMemorySnapshot private readonly memorySnapshot: IAgentMemorySnapshot,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.states.contributeState(contextStrategyOverrideKey);
    this.states.contributeState(contextWindowEpochKey);
    this.states.contributeState(fullCompactionKey);
    this.states.contributeState(autoCompactOverrideKey);
    this.states.contributeState(fullCompactionCompactionCountInTurnKey);
    this.states.contributeState(fullCompactionObservedMaxContextTokensByModelKey);
    this.states.contributeState(fullCompactionLastCompactedTokenCountKey);
    this.states.contributeState(fullCompactionConsecutiveOverflowCompactionsKey);
    this.states.contributeState(fullCompactionActiveTurnIdKey);
    this.strategy = new RuntimeCompactionStrategy(
      () => this.resolveModelContextWithEffectiveMax(),
      (message) => this.tokenCounting.estimateMessage(message),
      () => this.requestTokens([]),
    );
    this._register(this.eventBus.subscribe(AgentStatusUpdated, (event) => {
      if (event.model !== undefined) this.publishAutoCompactStatus();
    }));
    this._register(
      this.dispatcher.hooks.onDidRestore.register('full-compaction', async (_ctx, next) => {
        this.normalizeAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe(TurnStarted, () => this.resetForTurn()),
    );
    this._register(
      this.eventBus.subscribe(TurnEnded, () => {
        this.activeTurnId = undefined;
      }),
    );
    this._register(
      this.loopService.hooks.onWillBeginStep.register('full-compaction', async (ctx, next) => {
        await this.beforeStep(ctx.signal, ctx.turnId);
        await next();
      }),
    );
    this._register(
      this.loopService.hooks.onDidFinishStep.register('full-compaction', async (_ctx, next) => {
        await this.afterStep();
        await next();
      }),
    );
    this._register(
      this.loopService.registerLoopErrorHandler({
        id: 'full-compaction',
        match: (context) => this.shouldRecoverFromContextOverflow(context.error),
        handle: (context) => this.recoverFromContextOverflow(context),
      }),
    );
  }

  private get compactionCountInTurn(): number {
    return this.states.get(fullCompactionCompactionCountInTurnKey);
  }

  private set compactionCountInTurn(value: number) {
    this.states.set(fullCompactionCompactionCountInTurnKey, value);
  }

  private get observedMaxContextTokensByModel(): Map<string, number> {
    return this.states.get(fullCompactionObservedMaxContextTokensByModelKey);
  }

  private get lastCompactedTokenCount(): number | null {
    return this.states.get(fullCompactionLastCompactedTokenCountKey);
  }

  private set lastCompactedTokenCount(value: number | null) {
    this.states.set(fullCompactionLastCompactedTokenCountKey, value);
  }

  private get consecutiveOverflowCompactions(): number {
    return this.states.get(fullCompactionConsecutiveOverflowCompactionsKey);
  }

  private set consecutiveOverflowCompactions(value: number) {
    this.states.set(fullCompactionConsecutiveOverflowCompactionsKey, value);
  }

  private get activeTurnId(): number | undefined {
    return this.states.get(fullCompactionActiveTurnIdKey);
  }

  private set activeTurnId(value: number | undefined) {
    this.states.set(fullCompactionActiveTurnIdKey, value);
  }

  get compacting(): FullCompactionTask | null {
    return this._compacting;
  }

  isCompacting(): boolean {
    return this._compacting !== null;
  }

  cancel(): void {
    if (this.pendingManual !== null) {
      this.pendingManual = null;
      void this.dispatcher.dispatch(new FullCompactionCancel({ queued: true }));
      void this.dispatcher.dispatch(new CompactionCancelled({ trigger: 'manual' }));
    }
    const active = this._compacting;
    if (active !== null) {
      this.telemetry.track2('cancel', {
        from: 'compacting',
        trace_id: active.traceId,
      });
    }
    active?.abortController.abort();
  }

  private getEffectiveMaxContextTokens(): number {
    const capability = this.profile.getModelCapabilities();
    const configured = capability.max_input_tokens ?? capability.max_context_tokens;
    const modelAlias = this.profile.data().modelAlias;
    const observed =
      modelAlias === undefined ? undefined : this.observedMaxContextTokensByModel.get(modelAlias);
    if (observed === undefined) return configured;
    if (configured <= 0) return observed;
    return Math.min(configured, observed);
  }

  private resolveModelContextWithEffectiveMax(): ProfileModelContext {
    const resolved = this.profile.resolveModelContext();
    const effectiveMax = this.getEffectiveMaxContextTokens();
    return {
      ...resolved,
      sessionAutoCompact: this.states.get(autoCompactOverrideKey)[resolved.modelAlias],
      modelCapabilities: {
        ...resolved.modelCapabilities,
        max_context_tokens: effectiveMax,
        max_input_tokens: effectiveMax,
      },
    };
  }

  getAutoCompact(): ResolvedAutoCompact {
    const resolved = this.resolveModelContextWithEffectiveMax();
    return resolveAutoCompact(resolved, resolved.sessionAutoCompact, this.requestTokens([]));
  }

  getDefaultAutoCompact(): ResolvedAutoCompact {
    return resolveAutoCompact(this.resolveModelContextWithEffectiveMax(), undefined, this.requestTokens([]));
  }

  setAutoCompactOverride(tokens: number | null): void {
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'session auto_compact must be an absolute positive integer token count, not a percentage');
    }
    const modelId = this.profile.resolveModelContext().modelAlias;
    void this.dispatcher.dispatch(new AutoCompactOverrideChanged({ modelId, tokens }));
    this.publishAutoCompactStatus();
  }

  getContextStrategy(): { strategy: 'summarize' | 'auto' | 'fresh'; source: 'session' | 'profile' | 'global' | 'default' | 'subagent' | 'executor'; shadow: boolean } {
    if (this.profile.data().executorId !== undefined && this.profile.data().executorId !== 'native') return { strategy: 'summarize', source: 'executor', shadow: false };
    const config = this.appConfig.get<LoopControl>('loopControl');
    const shadow = config?.relayShadow === true;
    const profileStrategy = this.profile.resolveContextStrategy?.();
    if (this.scope.agentId !== 'main') {
      if (profileStrategy !== undefined) return { strategy: profileStrategy, source: 'profile', shadow };
      return { strategy: config?.subagentContextStrategy ?? 'summarize', source: 'subagent', shadow };
    }
    const override = this.states.get(contextStrategyOverrideKey);
    if (override !== null) return { strategy: override, source: 'session', shadow };
    if (profileStrategy !== undefined) return { strategy: profileStrategy, source: 'profile', shadow };
    if (config?.contextStrategy !== undefined) return { strategy: config.contextStrategy, source: 'global', shadow };
    return { strategy: 'auto', source: 'default', shadow };
  }

  setContextStrategyOverride(strategy: 'summarize' | 'auto' | 'fresh' | null): void {
    if (this.scope.agentId !== 'main') throw new Error2(ErrorCodes.REQUEST_INVALID, 'Session strategy override belongs to the main agent.');
    void this.dispatcher.dispatch(new ContextStrategyOverrideChanged({ strategy }));
    this.publishAutoCompactStatus();
  }

  private publishAutoCompactStatus(): void {
    if (!this.profile.hasModel() || !this.profile.isRunnable()) return;
    try {
      const resolved = this.getAutoCompact();
      void this.dispatcher.dispatch(new AgentStatusUpdated({
        autoCompactTokens: resolved.tokens,
        autoCompactSource: resolved.source,
        effectiveMaxContextTokens: resolved.effectiveMaxContextTokens,
        reservedContextTokens: resolved.reservedContextTokens,
        contextStrategy: this.getContextStrategy().strategy,
        contextStrategySource: this.getContextStrategy().source,
      }));
    } catch (error) {
      this.log.warn('failed to publish auto compaction status', { error });
    }
  }

  private currentRequestTokens(): number {
    return this.requestTokens(this.context.get());
  }

  private requestTokens(messages: readonly Message[]): number {
    return this.tokenCounting.requestSize({
      systemPrompt: this.profile.getSystemPrompt(),
      tools: this.defaultTools().filter((tool) => tool.deferred !== true),
      messages,
    });
  }

  private defaultTools(): readonly Tool[] {
    return this.toolSelect
      .shapeTools(this.toolRegistry.list())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
  }

  private shouldRecoverFromContextOverflow(
    error: unknown,
    estimatedRequestTokens = this.currentRequestTokens(),
  ): boolean {
    if (isCodedError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW) return true;
    const statusError = findAPIStatusError(error);
    if (statusError instanceof APIContextOverflowError) return true;
    if (statusError === undefined || statusError.statusCode !== 413) return false;
    const effectiveMax = this.getEffectiveMaxContextTokens();
    return (
      effectiveMax > 0 &&
      estimatedRequestTokens >= effectiveMax * OVERFLOW_STATUS_RECOVERY_RATIO
    );
  }

  private observeContextOverflow(estimatedRequestTokens: number): void {
    if (!Number.isFinite(estimatedRequestTokens) || estimatedRequestTokens <= 0) return;
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) return;
    const observed = Math.max(
      1,
      Math.floor(estimatedRequestTokens * OVERFLOW_CONTEXT_SAFETY_RATIO),
    );
    const current = this.getEffectiveMaxContextTokens();
    if (current > 0 && observed >= current) return;
    this.observedMaxContextTokensByModel.set(modelAlias, observed);
    this.publishAutoCompactStatus();
  }

  get queuedManualCompaction(): boolean {
    return this.pendingManual !== null;
  }

  begin(input: FullCompactionInput): boolean {
    const data: CompactionBeginData = { source: input.source, instruction: input.instruction, strategy: input.strategy };
    if (data.source === 'manual') {
      if (this.pendingManual !== null || this._compacting?.trigger === 'manual') return false;
      const quiescence = this._compacting === null ? this.loopService.tryAcquireQuiescence() : undefined;
      if (quiescence !== undefined) return this.startCompaction(data, quiescence);
      this.pendingManual = data;
      void this.dispatcher.dispatch(new FullCompactionBegin({ ...data, queued: true }));
      void this.runPendingWhenIdle(data);
      return true;
    }
    if (this._compacting || this.pendingManual !== null) return false;
    return this.startCompaction(data);
  }

  private async runPendingWhenIdle(data: CompactionBeginData): Promise<void> {
    await this.loopService.settled();
    if (this.pendingManual !== data) return;
    const quiescence = this.loopService.tryAcquireQuiescence();
    if (quiescence === undefined) return;
    try {
      await this.runPendingManual();
    } finally {
      await quiescence.dispose();
    }
  }

  private async runPendingManual(): Promise<void> {
    const data = this.pendingManual;
    if (data === null) return;
    if (this._compacting !== null) await this._compacting.promise.catch(() => undefined);
    if (this.pendingManual !== data) return;
    this.pendingManual = null;
    let started = false;
    try {
      started = this.startCompaction(data);
      await this._compacting?.promise;
    } catch (error) {
      if (!started) {
        void this.dispatcher.dispatch(new FullCompactionCancel({ queued: true }));
        void this.dispatcher.dispatch(new CompactionCancelled({ trigger: 'manual', reason: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  private startCompaction(data: CompactionBeginData, quiescence?: IDisposable): boolean {
    try {
      const tokenCount = this.validateCompactionStart(data.source);
      if (!this.reserveCompactionSlot(data.source)) {
        const cleanup = quiescence?.dispose();
        if (isPromiseLike(cleanup)) cleanup.catch(onUnexpectedError);
        return false;
      }
      void this.dispatcher.dispatch(new FullCompactionBegin(data));

      const active = this.createActiveCompaction(
        data.source,
        tokenCount,
        data.source === 'auto' ? this.activeTurnId : undefined,
        quiescence,
      );
      this._compacting = active.task;
      active.task.abortController.signal.addEventListener(
        'abort',
        () => this.cancelActive(active.task),
        { once: true },
      );
      void this.compactionWorker(active.task, data).then(active.resolve, active.reject);
      void active.task.promise.catch(() => undefined);
      return true;
    } catch (error) {
      const cleanup = quiescence?.dispose();
      if (isPromiseLike(cleanup)) cleanup.catch(onUnexpectedError);
      throw error;
    }
  }

  private reserveCompactionSlot(source: CompactionBeginData['source']): boolean {
    if (source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    return this.compactionCountInTurn <= this.strategy.maxCompactionPerTurn;
  }

  private validateCompactionStart(source: CompactionBeginData['source']): number {
    const history = this.context.get();
    if (history.length === 0) {
      throw new Error2(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact in current history.');
    }
    if (this.strategy.computeCompactCount(history, source) <= 0) {
      throw new Error2(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact in current history.');
    }
    return this.requestTokens(history);
  }

  private createActiveCompaction(
    trigger: CompactionBeginData['source'],
    tokenCount: number,
    originTurnId: number | undefined,
    quiescence: IDisposable | undefined,
  ): {
    readonly task: ActiveCompaction;
    readonly resolve: (result: CompactionResult) => void;
    readonly reject: (reason: unknown) => void;
  } {
    const abortController = new AbortController();
    let resolve!: (result: CompactionResult) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<CompactionResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return {
      task: {
        abortController,
        promise,
        trigger,
        tokenCount,
        originTurnId,
        quiescence,
        get traceId() {
          return this.trace?.traceId;
        },
        blockedByTurn: false,
      },
      resolve,
      reject,
    };
  }

  override dispose(): void | Promise<void> {
    this.pendingManual = null;
    if (this._compacting !== null && !this._compacting.abortController.signal.aborted) {
      this._compacting.abortController.abort();
    }
    return super.dispose();
  }

  private cancelActive(active: ActiveCompaction, reason?: string): boolean {
    if (this._compacting !== active) return false;
    void this.dispatcher.dispatch(new FullCompactionCancel({}));
    this._compacting = null;
    if (!active.abortController.signal.aborted) {
      active.abortController.abort();
    }
    void this.dispatcher.dispatch(new CompactionCancelled({ trigger: active.trigger, reason }));
    return true;
  }

  private markCompleted(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    void this.dispatcher.dispatch(new FullCompactionComplete({}));
    this._compacting = null;
    return true;
  }

  private normalizeAfterReplay(): void {
    const state = this.states.get(fullCompactionKey);
    if (state.phase !== 'running' && state.phase !== 'queued') return;
    void this.dispatcher.dispatch(new FullCompactionCancel({ queued: true }));
    void this.dispatcher.dispatch(new FullCompactionCancel({}));
  }

  private resetForTurn(): void {
    this.compactionCountInTurn = 0;
    this.lastCompactedTokenCount = null;
    this.compactedHistoryLength = null;
    this.consecutiveOverflowCompactions = 0;
  }

  private async recoverFromContextOverflow(
    context: LoopErrorContext,
  ): Promise<boolean> {
    this.recordOverflowRecovery(context.error);
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this._compacting) return false;

    await this.block(context.signal, context.turnId);
    return this.retryFailedDriver(context);
  }

  private recordOverflowRecovery(error: unknown): void {
    this.observeContextOverflow(this.currentRequestTokens());
    this.consecutiveOverflowCompactions += 1;
    const maxAttempts = this.strategy.maxOverflowCompactionAttempts;
    if (this.consecutiveOverflowCompactions <= maxAttempts) return;
    throw new Error2(
      ErrorCodes.CONTEXT_OVERFLOW,
      `Compaction failed to bring the context under the model window after ${String(maxAttempts)} attempts.`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  private retryFailedDriver(context: LoopErrorContext): boolean {
    const driver = context.failedDriver;
    if (driver === undefined || context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }

  private async beforeStep(signal: AbortSignal, turnId?: number): Promise<void> {
    this.activeTurnId = turnId;
    await this.runPendingManual();
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending())) {
      await this.block(signal, turnId);
    }
  }

  private async afterStep(): Promise<void> {
    await this.runPendingManual();
    this.consecutiveOverflowCompactions = 0;
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
  }

  private checkAutoCompaction(throwOnLimit = true): boolean {
    if (this._compacting) return true;
    this.foldReemittedRemindersIntoCompactionBaseline();
    if (
      this.lastCompactedTokenCount !== null &&
      this.tokenCountWithPending() <= this.lastCompactedTokenCount
    ) {
      return false;
    }
    if (!this.strategy.shouldCompact(this.tokenCountWithPending())) return false;
    return this.beginAutoCompaction(throwOnLimit);
  }

  private foldReemittedRemindersIntoCompactionBaseline(): void {
    const baseline = this.lastCompactedTokenCount;
    if (baseline === null) return;
    if (!this.onlyRemindersAppendedSinceCompaction()) return;
    const pending = this.tokenCountWithPending();
    if (pending > baseline) this.lastCompactedTokenCount = pending;
  }

  private onlyRemindersAppendedSinceCompaction(): boolean {
    const boundary = this.compactedHistoryLength;
    if (boundary === null) return false;
    const history = this.context.get();
    if (history.length <= boundary) return false;
    return history.slice(boundary).every((message) => message.origin?.kind === 'injection');
  }

  private beginAutoCompaction(throwOnLimit = true): boolean {
    if (this._compacting) return true;
    const maxCompactions = this.strategy.maxCompactionPerTurn;
    if (this.compactionCountInTurn >= maxCompactions) {
      if (throwOnLimit) {
        throw new Error2(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
          details: { maxCompactions },
        });
      }
      return false;
    }
    return this.begin({ source: 'auto' });
  }

  private async block(signal?: AbortSignal, turnId?: number): Promise<void> {
    const active = this._compacting;
    if (active === null) return;
    active.blockedByTurn = true;
    this.propagateBlockingAbort(active, signal);
    void this.dispatcher.dispatch(new CompactionBlocked({ turnId }));
    try {
      await active.promise;
    } catch (error) {
      if (this.wasBlockingWaitAborted(active, signal, error)) return;
      throw error;
    }
  }

  private propagateBlockingAbort(active: ActiveCompaction, signal: AbortSignal | undefined): void {
    signal?.addEventListener(
      'abort',
      () => {
        if (this._compacting === active) active.abortController.abort();
      },
      { once: true },
    );
  }

  private wasBlockingWaitAborted(
    active: ActiveCompaction,
    signal: AbortSignal | undefined,
    error: unknown,
  ): boolean {
    return (
      signal?.aborted === true &&
      (active.abortController.signal.aborted || isAbortError(error))
    );
  }

  private async compactionWorker(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult> {
    try {
      const result = await this.compactionRound(active, data);
      if (this._compacting !== active) throw compactionCancelledReason(active);
      try {
        await this.profile.refreshSystemPrompt();
      } catch (error) {
        this.log.error('failed to refresh system prompt after compaction', { error });
      }
      this.lastCompactedTokenCount = result.tokensAfter;
      this.compactedHistoryLength = this.context.get().length;
      if (!this.markCompleted(active)) {
        throw compactionCancelledReason(active);
      }
      const { contextSummary: _contextSummary, ...eventResult } = result;
      void _contextSummary;
      void this.dispatcher.dispatch(new CompactionCompleted({ trigger: active.trigger, result: eventResult }));
      return result;
    } catch (error) {
      if (active.abortController.signal.aborted || isAbortError(error)) {
        this.cancelActive(active);
        throw error;
      }
      const blockedByTurn = this._compacting === active && active.blockedByTurn;
      if (this._compacting === active) {
        this.cancelActive(active, error instanceof Error ? error.message : String(error));
      }
      if (blockedByTurn) {
        throw error;
      }
      void this.dispatcher.dispatch(new AgentErrorEvent(toKimiErrorPayload(error)));
      throw error;
    } finally {
      try {
        this._onDidFinishCompaction.fire(active);
      } finally {
        await active.quiescence?.dispose();
      }
    }
  }

  private startSummaryRequest(messages: readonly Message[], maxOutputSize: number, signal: AbortSignal, turnId?: number, droppedCount = 0) {
    return this.llmRequester.start({ messages, maxOutputSize, source: {
      type: 'operation', turnId, requestKind: 'full_compaction', logFields: { droppedCount },
    } }, undefined, signal);
  }

  async prepareModelSwitchSummary(history: readonly ContextMessage[], signal: AbortSignal): Promise<string | undefined> {
    if (!history.some((message) => message.role === 'assistant' || message.role === 'tool' || message.origin?.kind === 'compaction_summary')) return undefined;
    const model = this.profile.resolveModelContext();
    const instruction = renderPrompt(compactionInstructionTemplate, { custom_instruction_block: '' }).trimEnd();
    const messages: Message[] = [...stripDynamicToolContext(history), createUserMessage(instruction)];
    const tokensBefore = this.requestTokens(history);
    const notes = this.todo.getNotes?.(this.scope.agentId) ?? {};
    const [liveEntries, memoryReferences, linkedBoardCards] = await Promise.all([
      this.memorySnapshot.liveSessionEntries(),
      this.memorySnapshot.resolveReferences([notes.notes?.directives, notes.notes?.decided].filter(Boolean).join('\n')),
      this.readLinkedBoardCards(),
    ]);
    const relayInput: RelayInput = {
      history, compactCount: history.length, agentId: this.scope.agentId,
      sessionId: this.session.sessionId, epoch: this.states.get(contextWindowEpochKey),
      notes: notes.notes, meta: notes.meta, todos: this.currentTodos(),
      estimateText: (text) => this.tokenCounting.estimateText(text),
      memoryEntries: liveEntries.map((entry) => memoryEntryReference(entry)), memoryReferences, linkedBoardCards,
    };
    const startedAt = Date.now();
    const maxAttempts = model.compactionMaxAttempts ?? MAX_COMPACTION_RETRY_ATTEMPTS;
    let retryCount = 0;
    while (true) {
      signal.throwIfAborted();
      try {
        const request = this.startSummaryRequest(messages, model.maxOutputSize ?? DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS, signal);
        const attempt = collectSummary(await request.result);
        this.telemetry.track2('compaction_finished', {
          source: 'manual', tokens_before: tokensBefore, tokens_after: this.tokenCounting.estimateText(attempt.summary),
          duration_ms: Date.now() - startedAt, compacted_count: history.length, retry_count: retryCount, round: 1,
          thinking_effort: model.thinkingLevel, trace_id: attempt.traceId, strategy: 'summarize', ...usageTelemetry(attempt.usage),
        });
        return this.postProcessSummary(attempt.summary, relayInput);
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (retryCount + 1 >= maxAttempts || (!(error instanceof CompactionTruncatedError) && !isRetryableCompactionError(error))) {
          this.telemetry.track2('compaction_failed', { source: 'manual', tokens_before: tokensBefore,
            duration_ms: Date.now() - startedAt, round: 1, retry_count: retryCount,
            thinking_effort: model.thinkingLevel, error_type: error instanceof Error ? error.name : 'Unknown', strategy: 'summarize' });
          throw error;
        }
        const status = findAPIStatusError(error);
        await sleepForRetry(status?.retryAfterMs === undefined || status.retryAfterMs === null ? retryBackoffDelay(retryCount) : Math.min(status.retryAfterMs, 60_000), signal);
        retryCount += 1;
      }
    }
  }

  private async compactionRound(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult> {
    const startedAt = Date.now();
    const originalHistory = [...this.context.get()];
    const tokensBefore = this.requestTokens(originalHistory);
    let retryCount = 0;
    let requestAttempts = 0;
    let thinkingEffort = this.profile.data().thinkingLevel;
    let attemptedStrategy: 'summarize' | 'relay' = 'summarize';
    let failureReasons: string[] = [];

    try {
      const signal = active.abortController.signal;
      signal.throwIfAborted();

      await this.hooks.onWillCompact.run(active);

      const resolvedModel = this.profile.resolveModelContext();
      thinkingEffort = resolvedModel.thinkingLevel;
      const compactionMaxOutputSize = resolvedModel.maxOutputSize ?? DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS;

      const customInstruction = data.instruction?.trim() ?? '';
      const instruction = renderPrompt(compactionInstructionTemplate, {
        custom_instruction_block:
          customInstruction.length > 0 ? `\nOptional user instruction:\n${customInstruction}\n` : '',
      }).trimEnd();

      let compactCount = this.strategy.computeCompactCount(originalHistory, data.source);
      if (compactCount <= 0) {
        throw new Error2(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact in current history.');
      }

      const choice = data.strategy === undefined ? this.getContextStrategy() : {
        strategy: data.strategy === 'relay' ? 'fresh' as const : 'summarize' as const,
        source: 'session' as const, shadow: false,
      };
      const epoch = this.states.get(contextWindowEpochKey);
      const notes = this.todo.getNotes?.(this.scope.agentId) ?? {};
      const [liveEntries, memoryReferences, linkedBoardCards] = await Promise.all([
        this.memorySnapshot.liveSessionEntries(),
        this.memorySnapshot.resolveReferences([notes.notes?.directives, notes.notes?.decided].filter(Boolean).join('\n')),
        this.readLinkedBoardCards(),
      ]);
      const memoryEntries = liveEntries.map((entry) => memoryEntryReference(entry));
      const relayInput: RelayInput = {
        history: originalHistory, compactCount, agentId: this.scope.agentId,
        sessionId: this.session.sessionId, epoch,
        notes: notes.notes, meta: notes.meta, todos: this.currentTodos(),
        estimateText: (text) => this.tokenCounting.estimateText(text), memoryEntries, memoryReferences, linkedBoardCards,
      };
      let relaySummary: string | undefined;
      let relayError: unknown;
      let renderFailed = false;
      if (choice.strategy !== 'summarize' || choice.shadow) {
        try {
          relaySummary = renderRelay(relayInput);
        } catch (error) {
          relayError = error;
          if (data.strategy === 'relay') throw error;
          this.log.warn('relay render failed; summarizing', { error });
          renderFailed = true;
        }
      }
      if (data.strategy === 'relay') {
        if (relaySummary === undefined) {
          if (relayError instanceof Error) throw relayError;
          throw relayError === undefined
            ? new Error2(ErrorCodes.COMPACTION_UNABLE, 'Relay compaction did not produce a fresh context.')
            : new Error('Relay compaction failed.', { cause: relayError });
        }
        if (!historySafeToCompact(this.context.get(), originalHistory)) throw compactionCancelledReason(active);
        attemptedStrategy = 'relay';
        const result = this.context.applyCompaction({
          summary: relaySummary, contextSummary: relaySummary, compactedCount: compactCount, tokensBefore,
          requestOverheadTokens: this.requestTokens([]), strategy: 'relay', shapeVersion: 1,
          reasonCodes: [],
        });
        this.telemetry.track2('compaction_finished', {
          source: data.source, turn_id: active.originTurnId, tokens_before: result.tokensBefore,
          tokens_after: result.tokensAfter, duration_ms: Date.now() - startedAt,
          compacted_count: result.compactedCount, retry_count: 0, round: 1,
          thinking_effort: thinkingEffort, strategy: 'relay', reason_codes: [],
        });
        return result;
      }
      const projected = relaySummary === undefined ? 0 : buildContextCompactionShape(originalHistory, {
        summary: relaySummary, compactedCount: compactCount, tokensBefore,
        requestOverheadTokens: this.requestTokens([]),
      }).tokensAfter;
      const visibleTools = this.toolSelect.shapeTools(this.toolRegistry.list());
      const historyToolAvailable = (name: string) => this.toolPolicy.isToolActive(name, 'builtin') &&
        visibleTools.some((tool) => tool.name === name);
      const eligibility = choice.strategy === 'summarize' && !choice.shadow
        ? { eligible: false, safe: false, reasons: [] as ReasonCode[] }
        : renderFailed ? { eligible: false, safe: false, reasons: ['relay_render_failed'] as ReasonCode[] }
          : evaluateFreshEligibility({
            history: originalHistory, compactCount, notes: notes.notes, meta: notes.meta,
            windowEpoch: epoch, strategy: choice.strategy, threshold: this.getAutoCompact().tokens,
            projectedTokens: projected, instruction: customInstruction,
            historyAvailable: historyToolAvailable('HistoryRead') && historyToolAvailable('HistorySearch'),
            estimateMessage: (message) => this.tokenCounting.estimateMessage(message),
            estimateText: relayInput.estimateText, sessionId: relayInput.sessionId, agentId: relayInput.agentId,
          });
      const reasons: ReasonCode[] = [...eligibility.reasons];
      failureReasons = reasons;
      const fallbackFrom = choice.strategy !== 'summarize' && !eligibility.eligible ? 'relay' as const : undefined;
      const useRelay = choice.strategy !== 'summarize' && eligibility.eligible && relaySummary !== undefined;
      if (useRelay && relaySummary !== undefined) {
        attemptedStrategy = 'relay';
        if (!historySafeToCompact(this.context.get(), originalHistory)) throw compactionCancelledReason(active);
        const result = this.context.applyCompaction({
          summary: relaySummary, contextSummary: relaySummary, compactedCount: compactCount, tokensBefore,
          requestOverheadTokens: this.requestTokens([]), strategy: 'relay', shapeVersion: 1,
          reasonCodes: reasons,
        });
        this.telemetry.track2('compaction_finished', {
          source: data.source, turn_id: active.originTurnId, tokens_before: result.tokensBefore,
          tokens_after: result.tokensAfter, duration_ms: Date.now() - startedAt,
          compacted_count: result.compactedCount, retry_count: 0, round: 1,
          thinking_effort: thinkingEffort, strategy: 'relay', reason_codes: reasons,
        });
        return result;
      }

      const maxAttempts = resolvedModel.compactionMaxAttempts ?? MAX_COMPACTION_RETRY_ATTEMPTS;
      let attempt: CompactionAttemptResult | undefined;
      let droppedCount = 0;
      let overflowShrinkCount = 0;
      let leadingDropRounds = 0;
      const selectHistoryForModel = (): readonly ContextMessage[] => {
        let selected = stripDynamicToolContext(originalHistory.slice(0, compactCount));
        droppedCount = 0;
        for (let i = 0; i < leadingDropRounds; i++) {
          const reduced = dropOldestMessageAndLeadingToolResults(selected);
          droppedCount += selected.length - reduced.length;
          selected = reduced;
        }
        return selected;
      };
      let historyForModel = selectHistoryForModel();
      try {
      while (true) {
        const messagesToCompact = historyForModel;
        const messages: Message[] = [...messagesToCompact, createUserMessage(instruction)];
        const estimatedCompactionRequestTokens = this.requestTokens(messages);
        requestAttempts += 1;

        try {
          const request = this.startSummaryRequest(messages, compactionMaxOutputSize, signal, active.originTurnId, droppedCount);
          active.trace = request.trace;
          attempt = collectSummary(await request.result);
          break;
        } catch (error) {
          const isContextOverflow = this.shouldRecoverFromContextOverflow(
            error,
            estimatedCompactionRequestTokens,
          );
          if (isContextOverflow) {
            this.observeContextOverflow(estimatedCompactionRequestTokens);
            overflowShrinkCount += 1;
            if (
              overflowShrinkCount > MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS ||
              requestAttempts >= maxAttempts
            ) {
              throw error;
            }
            const reducedCount = this.strategy.reduceCompactOnOverflow(
              originalHistory.slice(0, compactCount),
            );
            if (reducedCount <= 0) {
              throw error;
            }
            if (reducedCount < compactCount) {
              compactCount = reducedCount;
            } else {
              if (messagesToCompact.length <= 1) {
                throw error;
              }
              leadingDropRounds += 1;
            }
            historyForModel = selectHistoryForModel();
            retryCount = 0;
            continue;
          }
          if (!(error instanceof CompactionTruncatedError) && !isRetryableCompactionError(error)) {
            throw error;
          }
          if (requestAttempts >= maxAttempts) {
            throw error;
          }
          const status = findAPIStatusError(error);
          const delay = status?.retryAfterMs === null || status?.retryAfterMs === undefined
            ? retryBackoffDelay(retryCount)
            : Math.min(status.retryAfterMs, 60_000);
          await sleepForRetry(delay, signal);
          retryCount += 1;
        }
      }
      } catch (error) {
        if (choice.strategy === 'summarize' || !eligibility.safe || customInstruction ||
            !(this.shouldRecoverFromContextOverflow(error) || isRetryableCompactionError(error) || error instanceof CompactionTruncatedError)) throw error;
        if (!historySafeToCompact(this.context.get(), originalHistory)) throw error;
        const rescueReasons = [...reasons, 'summarize_failed_relay_rescue'];
        const summary = renderRelay(relayInput);
        const result = this.context.applyCompaction({ summary, contextSummary: summary, compactedCount: relayInput.compactCount,
          tokensBefore, requestOverheadTokens: this.requestTokens([]), strategy: 'relay', shapeVersion: 1,
          reasonCodes: rescueReasons, fallbackFrom: 'summarize' });
        this.telemetry.track2('compaction_finished', { source: data.source, turn_id: active.originTurnId,
          tokens_before: result.tokensBefore, tokens_after: result.tokensAfter, duration_ms: Date.now() - startedAt,
          compacted_count: result.compactedCount, retry_count: retryCount, round: 1,
          thinking_effort: thinkingEffort, strategy: 'relay', reason_codes: rescueReasons, fallback_from: 'summarize' });
        return result;
      }

      if (attempt === undefined) {
        throw new APIEmptyResponseError(
          'The compaction response did not contain a usable summary.',
        );
      }

      if (!historySafeToCompact(this.context.get(), originalHistory)) {
        const active = this._compacting;
        if (active !== null) {
          this.cancelActive(active);
        }
        throw compactionCancelledReason(active);
      }

      const summarizedDirectives = attempt.summary.split(/^## (?:Standing directives|Pending directive review)[ \t]*\r?\n/m)[1]?.split(/^## [^\r\n]+/m)[0]?.trim();
      const directiveBudget = summarizedDirectives && summarizedDirectives !== '(none)' ? compactionDirectivesBudget(notes.notes, summarizedDirectives) : undefined;
      if (directiveBudget?.exceeded) reasons.push('notes_directives_budget');
      const summary = this.postProcessSummary(attempt.summary, { ...relayInput, compactCount });
      const result = this.context.applyCompaction({
        summary,
        contextSummary: buildCompactionSummaryText(summary),
        compactedCount: compactCount,
        tokensBefore,
        summaryOutputTokens: attempt.usage?.output,
        requestOverheadTokens: this.requestTokens([]),
        droppedCount: droppedCount === 0 ? undefined : droppedCount,
        ...(choice.shadow || choice.strategy !== 'summarize' || directiveBudget?.exceeded ? { strategy: 'summarize' as const, shapeVersion: 1, reasonCodes: reasons, fallbackFrom } : {}),
      });

      const properties: CompactionFinishedEvent = {
        turn_id: active.originTurnId,
        source: data.source,
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        duration_ms: Date.now() - startedAt,
        compacted_count: result.compactedCount,
        dropped_count: result.droppedCount,
        retry_count: retryCount,
        round: 1,
        thinking_effort: thinkingEffort,
        trace_id: attempt.traceId,
        ...(choice.shadow || choice.strategy !== 'summarize' ? { strategy: 'summarize' as const, reason_codes: reasons, fallback_from: fallbackFrom } : {}),
        ...usageTelemetry(attempt.usage),
      };
      this.telemetry.track2('compaction_finished', properties);
      return result;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const properties: CompactionFailedEvent = {
        turn_id: active.originTurnId,
        source: data.source,
        tokens_before: tokensBefore,
        duration_ms: Date.now() - startedAt,
        round: 1,
        retry_count: retryCount,
        thinking_effort: thinkingEffort,
        error_type: error instanceof Error ? error.name : 'Unknown',
        trace_id: findAPIStatusError(error)?.traceId ?? active.traceId,
        strategy: attemptedStrategy,
        reason_codes: failureReasons,
      };
      this.telemetry.track2('compaction_failed', properties);
      const code = isError2(error) &&
        (error.code === ErrorCodes.AUTH_LOGIN_REQUIRED || error.code === ErrorCodes.PROVIDER_AUTH_ERROR)
        ? error.code : ErrorCodes.COMPACTION_FAILED;
      throw new Error2(code, describeCompactionFailure(
        error,
        this.profile.getModelProviderType() ?? 'unknown-provider',
        this.profile.data().modelAlias ?? 'unknown-model',
        requestAttempts,
        data.source,
      ), { cause: error, details: isError2(error) ? error.details : undefined });
    }
  }

  private async readLinkedBoardCards(): Promise<NonNullable<RelayInput['linkedBoardCards']>> {
    if (!this.toolPolicy.isToolActive('BoardRead')) return [];
    const timeout = timeoutOutcome(500, undefined);
    try {
      const board = this.instantiation.invokeFunction((accessor) => accessor.get(IFlagService).enabled(TASK_BOARD_FLAG_ID)
        ? accessor.get(ITaskBoardService) : undefined);
      if (board === undefined) return [];
      const result = await Promise.race([board.read({ action: 'list', workspaceId: this.session.workspaceId,
        sessionId: this.session.sessionId, limit: 5 }), timeout]);
      if (result === undefined) {
        this.log.debug('Linked board cards skipped', { reason: 'deadline' });
        return [];
      }
      if (!result.ok || !('cards' in result.value)) return [];
      return result.value.cards.filter((card) => card.workspaceId === this.session.workspaceId && card.sessionIds.includes(this.session.sessionId))
        .slice(0, 5).map(({ id, title, status }) => ({ id, title, status }));
    } catch {
      this.log.debug('Linked board cards skipped', { reason: 'read_failed' });
      return [];
    } finally { timeout.clear(); }
  }

  private postProcessSummary(summary: string, input: RelayInput): string {
    const todos = this.currentTodos();
    const notes = renderTodoNotes(this.todo.getNotes?.(this.scope.agentId)?.notes);
    const receipts = renderPendingReceipts(input);
    const candidate = summary.trim().replaceAll(/^## Standing directives[ \t]*$/gm, '## Pending directive review');
    const extracted = candidate.split(/^## Pending directive review[ \t]*\r?\n/m)[1]?.split(/^## [^\r\n]+/m)[0]?.trim();
    const budget = extracted && extracted !== '(none)' ? compactionDirectivesBudget(input.notes, extracted) : undefined;
    const notice = extracted ? `Summary candidates have not changed current notes. Reconcile them with original human sources before an explicit TodoList update.${budget?.exceeded ? ` Automatic promotion skipped: budget. Required directives ${budget.sectionChars}/1500 characters, notes total ${budget.totalChars}/7500; notes revision ${input.meta?.rev ?? 0} is unchanged. The complete candidate remains above.` : ''}` : '';
    return [candidate, notice ? `## Directive review status\n${notice}` : '', todos.length ? renderTodoList(todos, '## TODO List') : '',
      notes ? `## Working notes\n${notes}` : '', renderStandingDirectives(input), renderLinkedBoardCards(input), receipts].filter(Boolean).join('\n\n');
  }

  private currentTodos(): readonly TodoItem[] {
    return this.todo.getTodos(this.scope.agentId);
  }

  private tokenCountWithPending(): number {
    return this.tokenCounting.get().size;
  }
}

function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof APIStatusError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function collectSummary(finish: AgentLLMRequestFinish): CompactionAttemptResult {
  if (finish.providerFinishReason === 'truncated') {
    throw new CompactionTruncatedError();
  }

  const summary = finish.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  if (summary.length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }

  return { summary, usage: finish.usage, traceId: finish.traceId };
}

function historySafeToCompact(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index])) return false;
  return current.slice(original.length).every(isRealUserInput);
}

function dropOldestMessageAndLeadingToolResults<T extends { readonly role: string }>(
  messages: readonly T[],
): T[] {
  if (messages.length <= 1) return messages.slice();
  return dropLeadingToolResults(messages.slice(1));
}

function dropLeadingToolResults<T extends { readonly role: string }>(messages: readonly T[]): T[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === 'tool') {
    start += 1;
  }
  return messages.slice(start);
}

function usageTelemetry(usage: TokenUsage | null): CompactionTelemetryProperties {
  if (usage === null) return {};
  return {
    input_tokens: inputTotal(usage),
    output_tokens: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function compactionCancelledReason(active: ActiveCompaction | null): Error {
  const reason = active?.abortController.signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Compaction cancelled.');
  error.name = 'AbortError';
  return error;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFullCompactionService,
  AgentFullCompactionService,
  ScopeActivation.OnScopeCreated,
  'fullCompaction',
);
