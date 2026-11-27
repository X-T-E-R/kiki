import { toDisposable } from '#/_base/di/lifecycle';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { IPluginExtensionPortRegistryReader } from '#/app/pluginExtensionPorts/pluginExtensionPortRegistry';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { frozenExtensionSnapshot } from '#/agent/extensionPorts/frozenSnapshot';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event } from '#/_base/event';
import { defineState } from '#/state/state';
import type { ContentPart, ToolCall } from '#/kosong/contract/message';
import type { ToolInputDisplay } from '@kiki/protocol';

import {
  compileToolArgsValidator,
  validateToolArgsWithCoercion,
  type ToolArgsValidation,
  type ToolArgsValidator,
} from '#/tool/args-validator';
import {
  formatToolArgsTruncationRejection,
  parseToolCallArguments,
} from '#/tool/tool-args-parse';
import { PathSecurityError } from '#/tool/path-access';
import { abortable, isAbortError, isUserCancellation } from '#/_base/utils/abort';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  isToolForegroundPolicy,
  TOOL_FOREGROUND_POLICIES,
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolResult,
  type RunnableToolExecution,
  type ToolExecution,
  type ToolForegroundPolicy,
  type ToolResult,
  type ToolResultSpill,
  type ToolUpdate,
} from '#/tool/toolContract';
import type {
  BeforeResolveToolContext,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  ToolExecutionOutcome,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ILogService } from '#/_base/log/log';
import type { ToolCallEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { OrderedHookSlot } from '#/hooks';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { BeforeToolExecuteEmitter } from './beforeToolExecuteEvent';
import { resolveAutonomousForegroundTimeoutMs } from '#/agent/task/foregroundPolicy';
import {
  IAgentToolExecutorService,
  type MissingToolDescriber,
  type ToolCallGuard,
  type ToolCallDupType,
  type ToolExecutionResult,
  type ToolExecutorExecuteOptions,
  type UnavailableToolDescriber,
} from './toolExecutor';
import { ToolCallStarted, ToolProgress, ToolResultEvent } from './toolExecutorEvents';
import { ToolScheduler } from './toolScheduler';

const ABORT_GRACE_MS = 2_000;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';

const validators = new WeakMap<
  ExecutableTool,
  { schema: Record<string, unknown>; validator: ToolArgsValidator }
>();

function stringArgument(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function activeRuntimeId(runtime?: LiveRef<IAgentRuntimeService>): string | undefined {
  try {
    return runtime?.current?.inspect().identity.runtimeId;
  } catch {
    return undefined;
  }
}

export interface ToolExecutionTask {
  readonly accesses: ToolAccesses;
  readonly execute: (signal: AbortSignal) => Promise<ToolExecutionRunResult>;
}

export interface ToolExecutionRunResult {
  readonly result: ToolResult;
  readonly outcome: ToolExecutionOutcome;
}

interface PreparedToolTask {
  readonly task: ToolExecutionTask;
  readonly call: PreflightedToolCall;
  readonly readyAt: number;
  readonly resolvedAccesses?: ToolAccesses;
}

type ToolBatchEvent =
  | { readonly type: 'prepared'; readonly result: IteratorResult<PreparedToolTask> }
  | { readonly type: 'prepareRejected'; readonly reason: unknown }
  | { readonly type: 'executed'; readonly settled: SettledTimedToolResult };

interface TimedToolResult {
  readonly index: number;
  readonly prepared: PreparedToolTask;
  readonly result: ToolResult;
  readonly outcome: ToolExecutionOutcome;
  readonly durationMs: number;
}

type SettledTimedToolResult =
  | { readonly status: 'fulfilled'; readonly value: TimedToolResult }
  | { readonly status: 'rejected'; readonly index: number; readonly reason: unknown };

type SettledToolExecutionResult =
  | { readonly status: 'fulfilled'; readonly value: ToolExecutionResult }
  | { readonly status: 'rejected'; readonly reason: unknown };

type ToolExecutionResultPromise = Promise<SettledToolExecutionResult>;

type ToolExecutionStreamEvent =
  | { readonly type: 'timed'; readonly result: IteratorResult<TimedToolResult> }
  | { readonly type: 'timedRejected'; readonly reason: unknown }
  | {
      readonly type: 'finalized';
      readonly promise: ToolExecutionResultPromise;
      readonly settled: SettledToolExecutionResult;
    };

export const toolExecutorToolCallDupTypesKey = defineState<Map<string, ToolCallDupType>>(
  'toolExecutor.toolCallDupTypes',
  () => new Map(),
);
export const toolExecutorDupTypeTurnIdKey = defineState<number | undefined>(
  'toolExecutor.dupTypeTurnId',
  () => undefined as number | undefined,
);

export class AgentToolExecutorService implements IAgentToolExecutorService {
  declare readonly _serviceBrand: undefined;

  private readonly beforeExecuteEmitter = new BeforeToolExecuteEmitter();
  readonly onBeforeExecuteTool: Event<BeforeToolExecuteEvent> = this.beforeExecuteEmitter.event;
  private readonly willExecuteEmitter = new AsyncEmitter<WillExecuteToolEvent>();
  readonly onWillExecuteTool: Event<WillExecuteToolEvent> = this.willExecuteEmitter.event;

  readonly hooks = {
    onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>(),
  };

  private missingToolDescriber: MissingToolDescriber | undefined;
  private unavailableToolDescriber: UnavailableToolDescriber | undefined;
  private toolCallGuard: ToolCallGuard | undefined;
  private readonly beforeResolveHandlers = new Set<(context: BeforeResolveToolContext) => Promise<string | undefined>>();

  registerBeforeResolveTool(handler: (context: BeforeResolveToolContext) => Promise<string | undefined>) {
    this.beforeResolveHandlers.add(handler);
    return toDisposable(() => { this.beforeResolveHandlers.delete(handler); });
  }

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void {
    this.toolCallDupTypes.set(toolCallId, dupType);
  }

  registerToolCallGuard(guard: ToolCallGuard) {
    this.toolCallGuard = guard;
    return toDisposable(() => {
      if (this.toolCallGuard === guard) this.toolCallGuard = undefined;
    });
  }

  registerUnavailableToolDescriber(describer: UnavailableToolDescriber) {
    this.unavailableToolDescriber = describer;
    return toDisposable(() => {
      if (this.unavailableToolDescriber === describer) this.unavailableToolDescriber = undefined;
    });
  }

  registerMissingToolDescriber(describer: MissingToolDescriber) {
    this.missingToolDescriber = describer;
    return toDisposable(() => {
      if (this.missingToolDescriber === describer) this.missingToolDescriber = undefined;
    });
  }

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolResultTruncationService
    private readonly resultTruncation: IAgentToolResultTruncationService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ILogService private readonly log?: ILogService,
    @ref(IPluginExtensionPortRegistryReader) private readonly extensions?: LiveRef<IPluginExtensionPortRegistryReader>,
    @ref(IAgentToolApprovalService) private readonly approval?: LiveRef<IAgentToolApprovalService>,
    @ref(ISessionContext) private readonly session?: LiveRef<ISessionContext>,
    @ref(IAgentScopeContext) private readonly agent?: LiveRef<IAgentScopeContext>,
    @ref(IAgentRuntimeService) private readonly runtime?: LiveRef<IAgentRuntimeService>,
    @ref(IAgentTaskService) private readonly tasks?: LiveRef<IAgentTaskService>,
  ) {
    this.states.contributeState(toolExecutorToolCallDupTypesKey);
    this.states.contributeState(toolExecutorDupTypeTurnIdKey);
  }

  private get toolCallDupTypes(): Map<string, ToolCallDupType> {
    return this.states.get(toolExecutorToolCallDupTypesKey);
  }

  private get dupTypeTurnId(): number | undefined {
    return this.states.get(toolExecutorDupTypeTurnIdKey);
  }

  private set dupTypeTurnId(value: number | undefined) {
    this.states.set(toolExecutorDupTypeTurnIdKey, value);
  }

  async *execute(
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): AsyncIterable<ToolExecutionResult> {
    if (calls.length === 0) return;
    if (options.turnId !== this.dupTypeTurnId) {
      this.dupTypeTurnId = options.turnId;
      this.toolCallDupTypes.clear();
    }

    const preflighted = calls.map((call) =>
      preflightToolCall(
        this.toolRegistry,
        call,
        this.toolCallGuard,
        this.unavailableToolDescriber,
        this.missingToolDescriber,
        this.log,
      ),
    );
    const controller = new AbortController();
    const batchOptions = { ...options, signal: AbortSignal.any([options.signal, controller.signal]) };
    const tasks = this.prepareToolCalls(preflighted, calls, batchOptions);
    const timedResults = this.executeBatch(tasks, batchOptions.signal)[Symbol.asyncIterator]();
    let nextTimed: Promise<IteratorResult<TimedToolResult>> | undefined = timedResults.next();
    let executionFailure: { reason: unknown } | undefined;
    const finalizations = new Set<ToolExecutionResultPromise>();
    const finalize = (timed: TimedToolResult): void => {
      finalizations.add(this.finalizeTimedResult(timed.prepared, timed, options).then(
        (value): SettledToolExecutionResult => ({ status: 'fulfilled', value }),
        (error): SettledToolExecutionResult => ({ status: 'rejected', reason: error }),
      ));
    };

    try {
      while (nextTimed !== undefined || finalizations.size > 0) {
        const candidates: Array<Promise<ToolExecutionStreamEvent>> = [];
        if (nextTimed !== undefined) {
          candidates.push(
            nextTimed.then(
              (result): ToolExecutionStreamEvent => ({ type: 'timed', result }),
              (error): ToolExecutionStreamEvent => ({ type: 'timedRejected', reason: error }),
            ),
          );
        }
        for (const promise of finalizations) {
          candidates.push(
            promise.then((settled): ToolExecutionStreamEvent => ({
              type: 'finalized',
              promise,
              settled,
            })),
          );
        }

        const event = await Promise.race(candidates);
        if (event.type === 'timedRejected') {
          nextTimed = undefined;
          executionFailure = event;
          continue;
        }
        if (event.type === 'timed') {
          if (event.result.done === true) {
            nextTimed = undefined;
            continue;
          }

          finalize(event.result.value);
          nextTimed = timedResults.next();
          continue;
        }

        finalizations.delete(event.promise);
        if (event.settled.status === 'rejected') throw event.settled.reason;
        yield event.settled.value;
      }
      if (executionFailure !== undefined) throw executionFailure.reason;
    } finally {
      controller.abort();
      try {
        while (nextTimed !== undefined) {
          const remaining = await nextTimed;
          if (remaining.done === true) break;
          finalize(remaining.value);
          nextTimed = timedResults.next();
        }
      } finally {
        await timedResults.return?.();
        await Promise.allSettled(finalizations);
      }
    }
  }

  private async *prepareToolCalls(
    preflighted: readonly PreflightedToolCall[],
    calls: readonly ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): AsyncIterable<PreparedToolTask> {
    let stopBatch = false;
    for (const call of preflighted) {
      if (stopBatch) {
        yield { ...this.prepareSkippedToolCall(call, options), call, readyAt: Date.now() };
        continue;
      }
      if (
        options.skipUnstartedToolsOnInput === true &&
        !options.signal.aborted &&
        options.steerSignal?.aborted === true &&
        options.executionWaits?.[call.toolCall.id] === undefined
      ) {
        yield { ...this.prepareSteerSkippedToolCall(call, options), call, readyAt: Date.now() };
        continue;
      }
      const prepared = await this.prepareToolCall(call, calls, options);
      stopBatch = prepared.stopBatchAfterThis === true;
      yield { ...prepared, call, readyAt: Date.now() };
    }
  }

  private async finalizeTimedResult(
    prepared: {
      readonly call: PreflightedToolCall;
      readonly resolvedAccesses?: ToolAccesses;
    },
    timedResult: TimedToolResult,
    options: ToolExecutorExecuteOptions,
  ): Promise<ToolExecutionResult> {
    const { call } = prepared;
    const rawResult = timedResult.result;
    if (rawResult.isError !== true && rawResult.executionWait !== undefined) {
      return { toolCallId: call.toolCall.id, toolName: call.toolName, result: rawResult };
    }
    const finalizeStartedAt = Date.now();
    const extensions = this.extensions?.current;
    let shaped = rawResult;
    let systemReminders: ToolExecutionResult['systemReminders'];
    if (extensions?.hasToolPostExecutePolicies === true && !options.signal.aborted) {
      try {
        const proposal = await extensions.proposeToolPostExecute({
          sessionId: this.session!.current!.sessionId, agentId: this.agent!.current!.agentId,
          turnId: options.turnId, toolCallId: call.toolCall.id, toolName: call.toolName,
          args: frozenExtensionSnapshot(call.args), result: frozenExtensionSnapshot(rawResult),
          wasDenied: timedResult.outcome === 'vetoed', signal: options.signal,
        });
        const auditPath = proposal.preserveOriginalInAudit ? await this.resultTruncation.preserveOriginal?.({
          toolName: call.toolName, toolCallId: call.toolCall.id, result: rawResult,
        }) : undefined;
        const note = [proposal.result.note, auditPath === undefined ? undefined : `Original result: ${auditPath}`].filter(Boolean).join('\n');
        shaped = { ...rawResult, output: proposal.result.output, note: note || undefined };
        systemReminders = proposal.reminders;
      } catch (error) {
        this.log?.warn('Extension tool post-execution proposal failed', { toolName: call.toolName, toolCallId: call.toolCall.id, error });
      }
    }
    const finalized = await this.finalizeToolResult(
      call,
      shaped,
      options,
      timedResult.outcome,
      prepared.resolvedAccesses,
    );
    this.logSlowToolPhase(call, 'finalize', finalizeStartedAt);

    const dispatchStartedAt = Date.now();
    this.dispatchToolResult(call, finalized, options);
    this.logSlowToolPhase(call, 'result_dispatch', dispatchStartedAt);
    this.trackToolCall(call, finalized, timedResult.durationMs, options);

    return {
      toolCallId: call.toolCall.id,
      toolName: call.toolName,
      result: finalized,
      systemReminders,
    };
  }

  private trackToolCall(
    call: PreflightedToolCall,
    result: ToolResult,
    durationMs: number,
    options: ToolExecutorExecuteOptions,
  ): void {
    const outcome = toolTelemetryOutcome(result);
    const toolCallId = call.toolCall.id;
    const dupType = this.toolCallDupTypes.get(toolCallId) ?? 'normal';
    this.toolCallDupTypes.delete(toolCallId);
    const properties: ToolCallEvent = {
      turn_id: options.turnId,
      tool_call_id: toolCallId,
      tool_name: call.toolName,
      outcome,
      duration_ms: durationMs,
      dup_type: dupType,
      trace_id: options.trace?.traceId,
    };
    if (result.isError === true) properties['error_type'] = toolTelemetryErrorType(outcome);
    this.telemetry.track2('tool_call', properties);
  }

  private logSlowToolPhase(call: PreflightedToolCall, phase: string, startedAt: number, details: Record<string, unknown> = {}): void {
    this.logToolPhaseDuration(call, phase, Date.now() - startedAt, details);
  }

  private logToolPhaseDuration(call: PreflightedToolCall, phase: string, durationMs: number, details: Record<string, unknown> = {}): void {
    const data = { tool_name: call.toolName, tool_call_id: call.toolCall.id, phase, duration_ms: durationMs, ...details };
    if (durationMs >= 1000) this.log?.warn('slow tool phase', data);
    else this.log?.debug('tool phase', data);
  }

  private async prepareToolCall(
    call: PreflightedToolCall,
    allCalls: readonly ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): Promise<{
    task: ToolExecutionTask;
    resolvedAccesses?: ToolAccesses;
    stopBatchAfterThis?: boolean;
  }> {
    const settleError = (
      args: unknown,
      output: string,
      outcome: Exclude<ToolExecutionOutcome, 'executed'>,
      displayFields?: ToolCallDisplayFields,
    ): { task: ToolExecutionTask } => {
      this.dispatchToolCall(call, args, options, displayFields);
      return {
        task: makeResolvedTask(makeErrorToolResult(call, args, output), outcome),
      };
    };

    const settleSynthetic = (
      args: unknown,
      result: ExecutableToolResult,
      outcome: Exclude<ToolExecutionOutcome, 'executed'>,
      displayFields?: ToolCallDisplayFields,
    ): {
      task: ToolExecutionTask;
      stopBatchAfterThis?: boolean;
    } => {
      const toolResult = this.normalizeAndMergeResult(result, call.toolName, undefined);
      this.dispatchToolCall(call, args, options, displayFields);
      return {
        task: makeResolvedTask(
          {
            toolCall: call.toolCall,
            toolName: call.toolName,
            args,
            result: toolResult,
            stopTurn: toolResult.stopTurn === true,
          },
          outcome,
        ),
        stopBatchAfterThis: toolResult.stopBatchAfterThis ?? toolResult.stopTurn,
      };
    };

    if (call.kind === 'rejected') {
      return settleError(call.args, call.output, 'preflight-rejected');
    }

    if (options.executionWaits?.[call.toolCall.id] !== undefined) {
      if (call.tool.resumeExecutionWait === undefined) return settleError(call.args, 'The saved observer is unavailable; its original task was not restarted.', 'preflight-rejected');
      return { task: { accesses: ToolAccesses.none(), execute: signal => this.runSingleExecution(call, {
        approvalRule: call.toolName, execute: ctx => call.tool.resumeExecutionWait!(call.args, ctx),
      }, undefined, options, signal, call.tool.foregroundPolicy) } };
    }

    const skipUnstartedOnInput = options.skipUnstartedToolsOnInput === true;
    const admissionSignal = skipUnstartedOnInput && options.steerSignal !== undefined
      ? AbortSignal.any([options.signal, options.steerSignal])
      : options.signal;

    const extensions = this.extensions?.current;
    let validation = validateExecutableToolArgs(call.tool, call.args);
    const preExecutePolicies = extensions?.hasToolPreExecutePolicies === true;
    if (preExecutePolicies && validation.error === null) call.args = validation.args;
    let proposal: Awaited<ReturnType<NonNullable<typeof extensions>['proposeToolPreExecute']>> | undefined;
    if (preExecutePolicies) {
      try {
        proposal = await awaitToolPreparation(() => extensions!.proposeToolPreExecute({
          sessionId: this.session!.current!.sessionId, agentId: this.agent!.current!.agentId,
          turnId: options.turnId, toolCallId: call.toolCall.id, toolName: call.toolName,
          args: frozenExtensionSnapshot(call.args), signal: admissionSignal,
        }), admissionSignal);
      } catch (error) {
        if (options.signal.aborted) return settleError(call.args, abortedToolOutput(call.toolName, options.signal), 'aborted');
        if (skipUnstartedOnInput && options.steerSignal?.aborted === true) return this.prepareSteerSkippedToolCall(call, options);
        throw error;
      }
      if (options.signal.aborted) return settleError(call.args, abortedToolOutput(call.toolName, options.signal), 'aborted');
      if (skipUnstartedOnInput && options.steerSignal?.aborted === true) return this.prepareSteerSkippedToolCall(call, options);
    }
    if (proposal?.veto !== undefined) return settleSynthetic(call.args, proposal.veto, 'vetoed');
    if (proposal !== undefined) validation = validateExecutableToolArgs(call.tool, proposal.args);
    if (validation.error !== null) return settleError(call.args, `Invalid args for tool "${call.toolName}": ${validation.error}`, 'preflight-rejected');
    call.args = proposal === undefined ? validation.args : frozenExtensionSnapshot(validation.args);
    if (proposal?.changed === true) {
      call.toolCall = { ...call.toolCall, arguments: JSON.stringify(call.args) };
      allCalls = allCalls.map(candidate => candidate.id === call.toolCall.id ? call.toolCall : candidate);
      this.log?.info('Extension proposed tool arguments; host approval required', {
        toolCallId: call.toolCall.id, toolName: call.toolName, auditReasons: proposal.auditReasons,
      });
    }

    let execution: ToolExecution;
    const resolveStartedAt = Date.now();
    try {
      for (const handler of this.beforeResolveHandlers) {
        const reason = await awaitToolPreparation(() => handler({
          turnId: options.turnId,
          signal: admissionSignal,
          deduplicationKey: options.deduplicationKey,
          trace: options.trace,
          toolCall: call.toolCall,
          toolCalls: allCalls,
          tool: call.tool,
          args: call.args,
        }), admissionSignal);
        if (reason !== undefined) return settleError(call.args, reason, 'preflight-rejected');
      }
      execution = await awaitToolPreparation(() => call.tool.resolveExecution(call.args), admissionSignal);
    } catch (error) {
      if (options.signal.aborted) return settleError(call.args, abortedToolOutput(call.toolName, options.signal), 'aborted');
      if (skipUnstartedOnInput && options.steerSignal?.aborted === true) return this.prepareSteerSkippedToolCall(call, options);
      const output =
        error instanceof PathSecurityError
          ? error.message
          : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
      return settleError(call.args, output, 'resolution-failed');
    } finally {
      this.logSlowToolPhase(call, 'resolve', resolveStartedAt);
    }

    const displayFields = toolCallDisplayFieldsFromExecution(execution);

    if (options.signal.aborted) {
      return settleError(
        call.args,
        abortedToolOutput(call.toolName, options.signal),
        'aborted',
        displayFields,
      );
    }

    if (skipUnstartedOnInput && isSignalAborted(options.steerSignal)) {
      return this.prepareSteerSkippedToolCall(call, options);
    }

    if (execution.isError === true) {
      return settleSynthetic(call.args, execution, 'synthetic', displayFields);
    }

    const effectiveForegroundPolicy = execution.foregroundPolicy ?? call.tool.foregroundPolicy;
    if (!isToolForegroundPolicy(effectiveForegroundPolicy)) {
      return settleError(
        call.args,
        `Tool "${call.toolName}" must declare a valid foregroundPolicy (${TOOL_FOREGROUND_POLICIES.join(' | ')}), received ${String(effectiveForegroundPolicy)}`,
        'resolution-failed',
        displayFields,
      );
    }

    try {
      const beforeContext = buildBeforeExecuteContext(call, execution, allCalls, {
        ...options,
        signal: admissionSignal,
      });
      const admissionStartedAt = Date.now();
      const decision = await awaitToolPreparation(() => this.beforeExecuteEmitter.fireBeforeExecute(beforeContext), admissionSignal);
      this.logSlowToolPhase(call, 'admission', admissionStartedAt);

      if (decision?.veto !== undefined) {
        return settleSynthetic(call.args, decision.veto, 'vetoed', displayFields);
      }

      if (proposal?.changed === true || proposal?.requireAskReason !== undefined) {
        const approval = this.approval?.current;
        if (approval === undefined) return settleError(call.args, 'Tool extension approval is unavailable.', 'vetoed', displayFields);
        const reason = proposal.requireAskReason ?? 'An extension changed the tool arguments.';
        if (decision?.permissionDecision !== 'approved') {
          const confirmation = await awaitToolPreparation(() => approval.requestToolApproval({
            ...beforeContext, permissionAuthority: 'owner', execution: {
              ...beforeContext.execution, sessionApprovalRule: undefined,
              display: { kind: 'generic', summary: reason, detail: call.args },
            },
          }, { kind: 'ask', reason: { extension: reason } }, 'extension-tool-pre-execute'), admissionSignal);
          if (confirmation?.veto !== undefined) return settleSynthetic(call.args, confirmation.veto, 'vetoed', displayFields);
        }
      }
      const executionMetadata = decision?.executionMetadata;

      let executionVeto: ExecutableToolResult | undefined;
      const beforeExecuteStartedAt = Date.now();
      await awaitToolPreparation(() => this.willExecuteEmitter.fireAsync(
        {
          turnId: options.turnId,
          toolCall: call.toolCall,
          execution,
          args: call.args,
          veto: (result) => { executionVeto ??= result; },
        },
        admissionSignal,
      ), admissionSignal);
      this.logSlowToolPhase(call, 'before_execute', beforeExecuteStartedAt);
      admissionSignal.throwIfAborted();
      if (executionVeto !== undefined) return settleSynthetic(call.args, executionVeto, 'vetoed', displayFields);

      this.dispatchToolCall(call, call.args, options, displayFields);

      return {
        task: {
          accesses: execution.schedulingAccesses ?? execution.accesses ?? ToolAccesses.all(),
          execute: async (taskSignal) =>
            this.runSingleExecution(call, execution, executionMetadata, options, taskSignal, effectiveForegroundPolicy),
        },
        resolvedAccesses: execution.accesses,
        stopBatchAfterThis: execution.stopBatchAfterThis,
      };
    } catch (error) {
      if (options.signal.aborted) {
        return settleError(call.args, abortedToolOutput(call.toolName, options.signal), 'aborted', displayFields);
      }
      if (skipUnstartedOnInput && isSignalAborted(options.steerSignal)) {
        return this.prepareSteerSkippedToolCall(call, options);
      }
      throw error;
    }
  }

  private prepareSkippedToolCall(
    call: PreflightedToolCall,
    options: ToolExecutorExecuteOptions,
  ): { task: ToolExecutionTask } {
    const output = 'Tool skipped because a previous tool call stopped this batch. It was not run; if it is still needed, issue it again in the next step.';
    this.dispatchToolCall(call, call.args, options);
    return {
      task: makeResolvedTask(makeErrorToolResult(call, call.args, output), 'skipped'),
    };
  }

  private prepareSteerSkippedToolCall(
    call: PreflightedToolCall,
    options: ToolExecutorExecuteOptions,
  ): { task: ToolExecutionTask } {
    const output = 'Tool skipped because new input arrived before it started. Read the new input before deciding whether to run it.';
    this.dispatchToolCall(call, call.args, options);
    const result = this.normalizeAndMergeResult({ isError: false, output }, call.toolName, undefined);
    return {
      task: makeResolvedTask(
        {
          toolCall: call.toolCall,
          toolName: call.toolName,
          args: call.args,
          result,
          stopTurn: false,
        },
        'skipped',
      ),
    };
  }

  private async *executeBatch(
    tasks: AsyncIterable<PreparedToolTask>,
    signal: AbortSignal,
  ): AsyncIterable<TimedToolResult> {
    const scheduler = new ToolScheduler<TimedToolResult>();
    const allResults: Array<Promise<TimedToolResult>> = [];
    const pendingResults = new Map<number, Promise<ToolBatchEvent>>();
    const preparation = tasks[Symbol.asyncIterator]();
    const prepareNext = (): Promise<ToolBatchEvent> => preparation.next().then(
      (result) => ({ type: 'prepared', result }),
      (error) => ({ type: 'prepareRejected', reason: error }),
    );
    let nextPrepared: Promise<ToolBatchEvent> | undefined = prepareNext();
    let preparationFailure: { reason: unknown } | undefined;
    let nextIndex = 0;

    try {
      while (nextPrepared !== undefined || pendingResults.size > 0) {
        const candidates = [...pendingResults.values()];
        if (nextPrepared !== undefined) candidates.push(nextPrepared);
        const event = await Promise.race(candidates);
        if (event.type === 'prepareRejected') {
          nextPrepared = undefined;
          preparationFailure = event;
          continue;
        }
        if (event.type === 'prepared') {
          if (event.result.done === true) {
            nextPrepared = undefined;
            continue;
          }
          const prepared = event.result.value;
          const { task, call, readyAt } = prepared;
          const index = nextIndex++;
          const blockedBy = new Map<string, string | undefined>();
          const pendingResult = scheduler.add({
            accesses: task.accesses,
            toolCallId: call.toolCall.id,
            toolName: call.toolName,
            onBlocked: (blockers) => {
              for (const blocker of blockers) {
                if (blocker.toolCallId !== undefined) blockedBy.set(blocker.toolCallId, blocker.toolName);
              }
            },
            start: async () => {
              this.logSlowToolPhase(call, 'schedule', readyAt, {
                blocked_by: [...blockedBy].map(([tool_call_id, tool_name]) => ({ tool_call_id, tool_name })),
              });
              const startedAt = Date.now();
              return {
                result: task.execute(signal).then(({ result, outcome }) => {
                  this.logSlowToolPhase(call, 'execute', startedAt);
                  return { index, prepared, result, outcome, durationMs: Math.max(0, Date.now() - startedAt) };
                }),
              };
            },
          });
          allResults.push(pendingResult);
          pendingResults.set(index, pendingResult.then(
            (value): ToolBatchEvent => ({ type: 'executed', settled: { status: 'fulfilled', value } }),
            (error): ToolBatchEvent => ({ type: 'executed', settled: { status: 'rejected', index, reason: error } }),
          ));
          nextPrepared = prepareNext();
          continue;
        }
        const { settled } = event;
        const index = settled.status === 'fulfilled' ? settled.value.index : settled.index;
        pendingResults.delete(index);
        if (settled.status === 'rejected') throw settled.reason;
        yield settled.value;
      }
      if (preparationFailure !== undefined) throw preparationFailure.reason;
    } finally {
      await preparation.return?.();
      await Promise.allSettled(allResults);
    }
  }

  private async runSingleExecution(
    call: RunnableToolCall,
    execution: RunnableToolExecution,
    metadata: unknown,
    options: ToolExecutorExecuteOptions,
    signal: AbortSignal,
    foregroundPolicy: ToolForegroundPolicy,
  ): Promise<ToolExecutionRunResult> {
    const foregroundStartedAt = Date.now();
    if (signal.aborted) {
      return {
        result: makeErrorToolResult(
          call,
          call.args,
          abortedToolOutput(call.toolName, signal),
        ).result,
        outcome: 'aborted',
      };
    }

    const skipUnstartedOnInput = options.skipUnstartedToolsOnInput === true;
    if (
      skipUnstartedOnInput &&
      options.steerSignal?.aborted === true &&
      options.executionWaits?.[call.toolCall.id] === undefined
    ) {
      return {
        result: this.normalizeAndMergeResult(
          {
            isError: false,
            output: 'Tool skipped because new input arrived before it started. Read the new input before deciding whether to run it.',
          },
          call.toolName,
          execution,
        ),
        outcome: 'skipped',
      };
    }

    let rawResult: ExecutableToolResult;
    let steeredBeforeBody = false;
    let bodyStarted = false;
    let registeredForegroundTaskId: string | undefined;
    let registeredTaskSteerDetachable = true;
    const steerSignal = options.steerSignal;
    const detachRegisteredTaskOnSteer = (): void => {
      if (
        !registeredTaskSteerDetachable ||
        registeredForegroundTaskId === undefined ||
        signal.aborted ||
        options.executionPauseSignal?.aborted === true
      ) {
        return;
      }
      this.tasks?.current?.detach(registeredForegroundTaskId);
    };
    if (foregroundPolicy === 'detachable_task' && steerSignal !== undefined) {
      steerSignal.addEventListener('abort', detachRegisteredTaskOnSteer, { once: true });
    }
    const autonomousTimeoutMs = resolveAutonomousForegroundTimeoutMs(
      foregroundPolicy,
      execution.foregroundTimeoutMs,
    );
    const watchdogController = autonomousTimeoutMs === undefined ? undefined : new AbortController();
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    if (watchdogController !== undefined && autonomousTimeoutMs !== undefined) {
      watchdogTimer = setTimeout(() => {
        watchdogController.abort(
          new DOMException(
            timedOutToolOutput(call.toolName, autonomousTimeoutMs),
            'TimeoutError',
          ),
        );
      }, autonomousTimeoutMs);
      watchdogTimer.unref?.();
    }
    const effectiveSignal =
      watchdogController === undefined
        ? signal
        : AbortSignal.any([signal, watchdogController.signal]);

    const wrapperPreBodyController =
      skipUnstartedOnInput && steerSignal !== undefined && options.executionWaits?.[call.toolCall.id] === undefined
        ? new AbortController()
        : undefined;
    const abortWrapperOnSignal = (): void => {
      wrapperPreBodyController?.abort(effectiveSignal.reason);
    };
    const abortWrapperOnSteer = (): void => {
      if (!bodyStarted) wrapperPreBodyController?.abort(steerSignal?.reason);
    };
    if (wrapperPreBodyController !== undefined) {
      if (effectiveSignal.aborted) abortWrapperOnSignal();
      else effectiveSignal.addEventListener('abort', abortWrapperOnSignal, { once: true });
      if (steerSignal!.aborted) abortWrapperOnSteer();
      else steerSignal!.addEventListener('abort', abortWrapperOnSteer, { once: true });
    }
    try {
      const execContext: import('#/tool/toolContract').ExecutableToolContext = {
        turnId: options.turnId,
        step: options.step,
        toolCallId: call.toolCall.id,
        trace: options.trace,
        metadata,
        signal: effectiveSignal,
        taskOwnerSignal: options.taskOwnerSignal,
        executionPauseSignal: options.executionPauseSignal,
        executionWait: options.executionWaits?.[call.toolCall.id],
        steerSignal,
        skipUnstartedToolsOnInput: options.skipUnstartedToolsOnInput,
        foregroundStartedAt,
        onUpdate: (update) => {
          if (effectiveSignal.aborted) return;
          this.dispatchToolProgress(call, update, options);
        },
        onForegroundTaskStart: foregroundPolicy === 'detachable_task'
          ? (taskId, startOptions) => {
              registeredForegroundTaskId = taskId;
              registeredTaskSteerDetachable = startOptions?.steerDetachable ?? true;
              if (steerSignal?.aborted === true) detachRegisteredTaskOnSteer();
            }
          : undefined,
      };
      const terminal = (executionSignal: AbortSignal): Promise<ExecutableToolResult> => {
        executionSignal.throwIfAborted();
        if (
          skipUnstartedOnInput &&
          steerSignal?.aborted === true &&
          options.executionWaits?.[call.toolCall.id] === undefined
        ) {
          steeredBeforeBody = true;
          return Promise.resolve({
            isError: false,
            output: 'Tool skipped because new input arrived before it started. Read the new input before deciding whether to run it.',
          });
        }
        bodyStarted = true;
        steerSignal?.removeEventListener('abort', abortWrapperOnSteer);
        options.onToolBodyStart?.();
        const bodySignal =
          executionSignal === wrapperPreBodyController?.signal ? effectiveSignal : executionSignal;
        return execution.execute({ ...execContext, signal: bodySignal });
      };
      const extensions = this.extensions?.current;
      if (extensions?.hasToolExecutionWrappers === true && execContext.executionWait === undefined) {
        const wrapperPromise = extensions.executeApprovedTool({
          sessionId: this.session!.current!.sessionId, agentId: this.agent!.current!.agentId,
          turnId: options.turnId, step: options.step, toolCallId: call.toolCall.id,
          toolName: call.toolName, approvedArgs: frozenExtensionSnapshot(call.args),
          execContext: { ...execContext, signal: wrapperPreBodyController?.signal ?? effectiveSignal, metadata: undefined },
        }, terminal);
        if (wrapperPreBodyController !== undefined) {
          void wrapperPromise.catch(() => {});
          rawResult = await raceWithAbortGrace(
            abortable(wrapperPromise, wrapperPreBodyController.signal),
            effectiveSignal,
            call.toolName,
            signal,
            watchdogController?.signal,
            autonomousTimeoutMs,
          );
        } else {
          rawResult = await raceWithAbortGrace(
            wrapperPromise,
            effectiveSignal,
            call.toolName,
            signal,
            watchdogController?.signal,
            autonomousTimeoutMs,
          );
        }
      } else {
        rawResult = await raceWithAbortGrace(
          terminal(effectiveSignal),
          effectiveSignal,
          call.toolName,
          signal,
          watchdogController?.signal,
          autonomousTimeoutMs,
        );
      }
    } catch (error) {
      if (
        skipUnstartedOnInput &&
        !bodyStarted &&
        !effectiveSignal.aborted &&
        steerSignal?.aborted === true &&
        options.executionWaits?.[call.toolCall.id] === undefined
      ) {
        return {
          result: this.normalizeAndMergeResult(
            {
              isError: false,
              output: 'Tool skipped because new input arrived before it started. Read the new input before deciding whether to run it.',
            },
            call.toolName,
            execution,
          ),
          outcome: 'skipped',
        };
      }
      if (
        foregroundPolicy === 'steerable_wait' &&
        !effectiveSignal.aborted &&
        steerSignal?.aborted === true &&
        isAbortError(error)
      ) {
        return {
          result: this.normalizeAndMergeResult(
            {
              isError: false,
              output: `New input ended the foreground wait for "${call.toolName}". Read the new input before deciding whether to continue.`,
            },
            call.toolName,
            execution,
          ),
          outcome: 'executed',
        };
      }
      const timedOut =
        !signal.aborted &&
        watchdogController?.signal.aborted === true &&
        autonomousTimeoutMs !== undefined;
      if (timedOut) {
        return {
          result: makeErrorToolResult(
            call,
            call.args,
            timedOutToolOutput(call.toolName, autonomousTimeoutMs),
          ).result,
          outcome: 'executed',
        };
      }
      const aborted = isAbortError(error) || signal.aborted;
      const output = aborted
        ? abortedToolOutput(call.toolName, signal)
        : `Tool "${call.toolName}" failed: ${errorMessage(error)}`;
      return {
        result: makeErrorToolResult(call, call.args, output).result,
        outcome: 'executed',
      };
    } finally {
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
      effectiveSignal.removeEventListener('abort', abortWrapperOnSignal);
      steerSignal?.removeEventListener('abort', abortWrapperOnSteer);
      if (foregroundPolicy === 'detachable_task' && steerSignal !== undefined) {
        steerSignal.removeEventListener('abort', detachRegisteredTaskOnSteer);
      }
    }

    return {
      result: this.normalizeAndMergeResult(rawResult, call.toolName, execution),
      outcome: steeredBeforeBody ? 'skipped' : 'executed',
    };
  }

  private normalizeAndMergeResult(
    rawResult: unknown,
    toolName: string,
    execution: RunnableToolExecution | undefined,
  ): ToolResult {
    const coerced = coerceToolResult(rawResult, toolName);
    if (coerced.isError !== true && coerced.executionWait !== undefined) return coerced;
    const normalized = normalizeToolResult(coerced);
    return {
      ...normalized,
      description: execution?.description ?? normalized.description,
      display: execution?.display ?? normalized.display,
      approvalRule: execution?.approvalRule,
      stopBatchAfterThis: normalized.stopBatchAfterThis ?? execution?.stopBatchAfterThis,
      delivery: coerced.delivery,
    };
  }

  private dispatchToolCall(
    call: PreflightedToolCall,
    args: unknown,
    options: ToolExecutorExecuteOptions,
    displayFields?: ToolCallDisplayFields,
  ): void {
    if (options.executionWaits?.[call.toolCall.id] !== undefined) return;
    void this.dispatcher.dispatch(
      new ToolCallStarted({
        turnId: options.turnId,
        toolCallId: call.toolCall.id,
        name: call.toolName,
        args,
        description: displayFields?.description,
        display: displayFields?.display,
      }),
    );
    options.onToolCall?.({
      toolCallId: call.toolCall.id,
      name: call.toolName,
      args,
    });
  }

  private dispatchToolResult(
    call: PreflightedToolCall,
    result: ToolResult,
    options: ToolExecutorExecuteOptions,
  ): void {
    void this.dispatcher.dispatch(
      new ToolResultEvent({
        turnId: options.turnId,
        toolCallId: call.toolCall.id,
        output: result.output,
        isError: result.isError,
      }),
    );
  }

  private dispatchToolProgress(
    call: RunnableToolCall,
    update: ToolUpdate,
    options: ToolExecutorExecuteOptions,
  ): void {
    void this.dispatcher.dispatch(
      new ToolProgress({
        turnId: options.turnId,
        toolCallId: call.toolCall.id,
        update,
      }),
    );
  }

  private async finalizeToolResult(
    call: PreflightedToolCall,
    result: ToolResult,
    options: ToolExecutorExecuteOptions,
    outcome: ToolExecutionOutcome,
    resolvedAccesses?: ToolAccesses,
  ): Promise<ToolResult> {
    const didCtx: ToolDidExecuteContext = {
      turnId: options.turnId,
      signal: options.signal,
      deduplicationKey: options.deduplicationKey,
      trace: options.trace,
      toolCall: call.toolCall,
      toolCalls: [call.toolCall],
      tool: call.kind === 'runnable' ? call.tool : undefined,
      args: call.args,
      outcome,
      accesses: resolvedAccesses,
      result: result as ExecutableToolResult,
    };

    try {
      await this.hooks.onDidExecuteTool.run(didCtx, undefined, (hookId, durationMs) => {
        this.logToolPhaseDuration(call, 'finalize_hook', durationMs, { hook_id: hookId });
      });
    } catch (error) {
      this.log?.error('onDidExecuteTool hook failed after tool execution', {
        toolName: call.toolName,
        toolCallId: call.toolCall.id,
        error: errorMessage(error),
      });
      didCtx.result = result;
    }

    const coercedResult = coerceToolResult(didCtx.result, call.toolName);
    const effectiveResult = normalizeToolResult(coercedResult);
    const finalResult: ToolResult = {
      ...effectiveResult,
      description: result.description,
      display: result.display,
      approvalRule: result.approvalRule,
      stopTurn:
        result.stopTurn === true ||
        didCtx.stopTurn === true ||
        effectiveResult.stopTurn === true,
      userDeliveryConfirmed:
        effectiveResult.isError === true
          ? undefined
          : effectiveResult.userDeliveryConfirmed ?? result.userDeliveryConfirmed,
      stopBatchAfterThis: result.stopBatchAfterThis,
      delivery: coercedResult.delivery,
    };
    const truncateStartedAt = Date.now();
    let truncatedResult: ToolResult;
    try {
      truncatedResult = await this.resultTruncation.truncateForModel({
        toolName: call.toolName,
        toolCallId: call.toolCall.id,
        host: stringArgument(call.args, 'host'),
        path: stringArgument(call.args, 'path'),
        cwd: stringArgument(call.args, 'cwd'),
        runtimeId: finalResult.runtimeId,
        activeRuntimeId: activeRuntimeId(this.runtime),
        result: finalResult,
      });
    } finally {
      this.logSlowToolPhase(call, 'finalize_truncate', truncateStartedAt);
    }
    if (truncatedResult.truncated !== true) return truncatedResult;
    return {
      ...truncatedResult,
      readRange: truncatedResult.readRange === undefined
        ? undefined : { ...truncatedResult.readRange, truncated: true },
      fileRead: truncatedResult.fileRead === undefined
        ? undefined : { ...truncatedResult.fileRead, truncated: true },
    };
  }
}

interface RunnableToolCall {
  readonly kind: 'runnable';
  toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  args: unknown;
}

interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface PreparedToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ToolResult;
  readonly stopTurn?: boolean;
}

type ToolCallDisplayFields = { description?: string | undefined; display?: ToolInputDisplay | undefined };

function buildBeforeExecuteContext(
  call: RunnableToolCall,
  execution: RunnableToolExecution,
  allCalls: readonly ToolCall[],
  options: ToolExecutorExecuteOptions,
): ResolvedToolExecutionHookContext {
  return {
    turnId: options.turnId,
    signal: options.signal,
    deduplicationKey: options.deduplicationKey,
    trace: options.trace,
    toolCall: call.toolCall,
    toolCalls: allCalls,
    tool: call.tool,
    args: call.args,
    execution,
  };
}

function preflightToolCall(
  toolRegistry: IAgentToolRegistryService,
  toolCall: ToolCall,
  guard: ToolCallGuard | undefined,
  describeUnavailableTool: UnavailableToolDescriber | undefined,
  describeMissingTool: MissingToolDescriber | undefined,
  log?: ILogService,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  if (parsedArgs.parseFailed || parsedArgs.repaired === true) {
    log?.warn(
      parsedArgs.parseFailed ? 'tool args JSON parse failed' : 'tool args JSON repaired',
      {
        toolName,
        toolCallId: toolCall.id,
        rawLength: typeof toolCall.arguments === 'string' ? toolCall.arguments.length : 0,
        kind: parsedArgs.truncation?.kind,
        offset: parsedArgs.truncation?.offset,
        field: parsedArgs.truncation?.field,
        error: parsedArgs.error,
      },
    );
  }
  const tool = toolRegistry.resolve(toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: describeMissingTool?.(toolName) ?? `Tool "${toolName}" not found`,
    };
  }
  const source = toolRegistry.listReferences().find((entry) => entry.name === toolName)?.source ?? 'builtin';
  const denied = guard?.({ name: toolName, source });
  if (denied !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: denied,
    };
  }
  const unavailable = describeUnavailableTool?.(toolName);
  if (unavailable !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: unavailable,
    };
  }
  if (parsedArgs.parseFailed) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: parsedArgs.truncation === undefined
        ? `Invalid args for tool "${toolName}": malformed JSON. This tool call was not executed. ${parsedArgs.error ?? ''}`
        : formatToolArgsTruncationRejection(
          toolName,
          toolCall.arguments,
          parsedArgs.truncation,
          false,
        ),
    };
  }
  return { kind: 'runnable', toolCall, toolName, tool, args: parsedArgs.data };
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): ToolArgsValidation {
  const schema = tool.parameters;
  let cached = validators.get(tool);
  if (cached === undefined || cached.schema !== schema) {
    try {
      cached = { schema, validator: compileToolArgsValidator(schema) };
      validators.set(tool, cached);
    } catch (error) {
      return { args, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return validateToolArgsWithCoercion(cached.validator, schema, args);
}

function toolCallDisplayFieldsFromExecution(
  execution: ToolExecution,
): ToolCallDisplayFields | undefined {
  if (execution.isError === true) return undefined;
  const description = execution.description;
  const display = execution.display;
  return {
    description: description !== undefined && description.length > 0 ? description : undefined,
    display,
  };
}

function makeResolvedTask(
  result: PreparedToolResult,
  outcome: ToolExecutionOutcome,
): ToolExecutionTask {
  return {
    accesses: ToolAccesses.none(),
    execute: async () => ({ result: result.result, outcome }),
  };
}

function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
): PreparedToolResult {
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result: { output, isError: true },
  };
}

function coerceToolResult(value: unknown, toolName: string): ExecutableToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  return value as ExecutableToolResult;
}

function normalizeToolResult(result: ExecutableToolResult): ToolResult {
  let output: ToolResult['output'];
  if (typeof result.output === 'string') {
    output = result.output.length > 0 ? result.output : TOOL_OUTPUT_EMPTY;
  } else if (result.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = result.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = result.output.some(
        (part) => part.type === 'text' && part.text.length > 0,
      );
      output = hasNonEmptyText
        ? result.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...result.output];
    } else {
      const textJoined = result.output
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  const base: {
    output: ToolResult['output'];
    stopTurn?: boolean;
    userDeliveryConfirmed?: boolean;
    truncated?: true;
    note?: string;
    runtimeId?: string;
    spill?: ToolResultSpill;
    spillExempt?: true;
    readRange?: ToolResult['readRange'];
    fileRead?: ToolResult['fileRead'];
    memoryReceipt?: ToolResult['memoryReceipt'];
  } = {
    output,
    stopTurn: result.stopTurn,
    userDeliveryConfirmed: result.isError === true ? undefined : result.userDeliveryConfirmed,
    runtimeId: result.runtimeId,
    spill: result.spill,
    spillExempt: result.spillExempt,
    readRange: result.readRange,
    fileRead: result.fileRead,
    memoryReceipt: result.memoryReceipt,
  };
  if (result.truncated === true) base.truncated = true;
  if (typeof result.note === 'string' && result.note.length > 0) base.note = result.note;
  if (result.isError === true) {
    return {
      ...base,
      isError: true,
    };
  }
  return { ...base, allowsTurnEndWithSendMessage: result.allowsTurnEndWithSendMessage };
}

function toolTelemetryOutcome(result: ToolResult): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  const text = toolOutputText(result.output).toLowerCase();
  return text.includes('aborted') ||
    text.includes('cancelled') ||
    text.includes('manually interrupted')
    ? 'cancelled'
    : 'error';
}

function toolTelemetryErrorType(outcome: 'success' | 'error' | 'cancelled'): 'cancelled' | 'error' {
  if (outcome === 'cancelled') return 'cancelled';
  return 'error';
}

function toolOutputText(output: ToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

function timedOutToolOutput(toolName: string, timeoutMs: number): string {
  const seconds = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 100) / 10}s` : `${timeoutMs}ms`;
  return `Tool "${toolName}" timed out after ${seconds}`;
}

function abortedToolOutput(toolName: string, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function awaitToolPreparation<Result>(
  prepare: () => Result | PromiseLike<Result>,
  signal: AbortSignal,
): Promise<Result> {
  signal.throwIfAborted();
  return abortable(Promise.resolve().then(() => {
    signal.throwIfAborted();
    return prepare();
  }), signal);
}

async function raceWithAbortGrace<Result>(
  executePromise: Promise<Result>,
  signal: AbortSignal,
  toolName: string,
  callerSignal: AbortSignal = signal,
  watchdogSignal?: AbortSignal,
  watchdogTimeoutMs?: number,
): Promise<Result> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  void executePromise.catch(() => {});

  const graceSentinel: Promise<Result> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        const timedOut =
          !callerSignal.aborted &&
          watchdogSignal?.aborted === true &&
          watchdogTimeoutMs !== undefined;
        resolve({
          output: timedOut
            ? timedOutToolOutput(toolName, watchdogTimeoutMs)
            : abortedToolOutput(toolName, callerSignal),
          isError: true,
        } as unknown as Result);
      }, ABORT_GRACE_MS);
      graceTimer.unref?.();
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolExecutorService,
  AgentToolExecutorService,
  ScopeActivation.OnScopeCreated,
  'toolExecutor',
);
