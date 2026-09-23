import { createControlledPromise } from '@antfu/utils';
import {
  AcpProcessClient,
  type AcpOpenSessionOptions,
  type AcpOpenSessionResult,
  type AcpPermissionOption,
  type AcpPermissionRequest,
  type AcpProcessClient as AcpProcessClientType,
  type AcpSessionConfigOption,
  type AcpSessionConfigSelection,
  type AcpTurnHandle,
  type AcpTurnResult,
  type ExecutorSessionRefEnvelope,
  type HostProcessServiceLike,
  type NormalizedExecutorEvent,
} from '@kiki/acp-client';

import {
  agentExecutorBindingFingerprint,
  type AgentExecutionStatus,
  type AgentExecutorContext,
  type AgentExecutorPermissionModeMapping,
  type AgentExecutorSession,
} from '#/app/agentExecutor/agentExecutor';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { Turn, TurnResult } from '#/agent/loop/loop';
import { turnKey } from '#/agent/loop/turnOps';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { Error2, ErrorCodes } from '#/errors';
import { createHooks } from '#/hooks';
import type { TokenUsage } from '#/kosong/contract/usage';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  ExecutorSessionUpdated,
  externalExecutorKey,
  type ExecutorCumulativeUsage,
  type ExecutorLossCode,
  type ExecutorResumeMode,
} from './externalExecutorOps';
import {
  ExternalTurnRecorder,
  type ExternalExecutorEvent,
  resolveExternalModelProvider,
} from './externalTurnRecorder';

interface AcpClientLike {
  status(): ReturnType<AcpProcessClientType['status']>;
  openSession(options: AcpOpenSessionOptions): Promise<AcpOpenSessionResult>;
  configureSession(
    options: Parameters<AcpProcessClientType['configureSession']>[0],
  ): Promise<AcpOpenSessionResult>;
  startTurn(
    request: Parameters<AcpProcessClientType['startTurn']>[0],
  ): Promise<AcpTurnHandle<NormalizedExecutorEvent>>;
  cancel(reason?: unknown): Promise<boolean>;
  shutdown(reason?: unknown): Promise<void>;
}

interface ActiveExternalTurn {
  readonly turn: MutableExternalTurn;
  readonly recorder: ExternalTurnRecorder;
  readonly handle: AcpTurnHandle<NormalizedExecutorEvent>;
  readonly completion: Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
}

interface MutableExternalTurn extends Turn {
  state: NonNullable<Turn['state']>;
}

interface SelectedConfig {
  readonly selection: AcpSessionConfigSelection;
  readonly option: AcpSessionConfigOption;
}

const PROFILE_PREAMBLE_BEGIN = '--- BEGIN KIKI FROZEN PROFILE INSTRUCTIONS ---';
const PROFILE_PREAMBLE_END = '--- END KIKI FROZEN PROFILE INSTRUCTIONS ---';
const HANDOFF_BEGIN = '--- BEGIN KIKI PRIOR TRANSCRIPT HANDOFF ---';
const HANDOFF_END = '--- END KIKI PRIOR TRANSCRIPT HANDOFF ---';
const MAX_HANDOFF_TURNS = 8;
const MAX_HANDOFF_BYTES = 32 * 1024;

export class AcpAgentExecutorSession implements AgentExecutorSession {
  readonly hooks = createHooks<{ onWillRun: { signal: AbortSignal } }, 'onWillRun'>([
    'onWillRun',
  ]);

  readonly #runtimeLease;
  readonly #client: AcpClientLike;
  readonly #states: IAgentStateService;
  readonly #dispatcher: IEventDispatcher;
  readonly #workspace: ISessionWorkspaceContext;
  readonly #memory: IAgentContextMemoryService;
  readonly #interaction: ISessionInteractionService;
  readonly #permissionMode: IAgentPermissionModeService;
  #active: ActiveExternalTurn | undefined;
  #permissionContext:
    | { readonly turn: MutableExternalTurn; readonly recorder: ExternalTurnRecorder }
    | undefined;
  #settled: Promise<void> = Promise.resolve();
  #nextReservedTurnId: number | undefined;
  #shutdown = false;

  constructor(
    private readonly context: AgentExecutorContext,
    clientFactory: (
      processService: HostProcessServiceLike,
      permissionHandler: (
        request: AcpPermissionRequest,
        options: { readonly signal: AbortSignal; readonly options: readonly AcpPermissionOption[] },
      ) => Promise<{ readonly outcome: 'selected' | 'cancelled'; readonly optionId?: string }>,
    ) => AcpClientLike = (processService, permissionHandler) =>
      new AcpProcessClient(
        processService,
        {
          id: context.descriptor.id,
          command: requiredCommand(context),
          args: resolveAcpProcessArgs(context),
          env: context.descriptor.env === undefined ? undefined : { ...context.descriptor.env },
          startupTimeoutMs: context.descriptor.startupTimeoutMs,
          shutdownGraceMs: context.descriptor.shutdownGraceMs,
          clientName: 'kiki-agent-core-v2',
        },
        { permissionHandler },
      ),
  ) {
    const runtime = context.agent.accessor.get(IAgentRuntimeService);
    this.#runtimeLease = runtime.acquire(['process']);
    const processService = this.#runtimeLease.runtime.process;
    if (processService === undefined) {
      this.#runtimeLease.dispose();
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Runtime for external executor "${context.descriptor.id}" has no process service`,
      );
    }
    this.#states = context.agent.accessor.get(IAgentStateService);
    this.#dispatcher = context.agent.accessor.get(IEventDispatcher);
    this.#workspace = context.agent.accessor.get(ISessionWorkspaceContext);
    this.#memory = context.agent.accessor.get(IAgentContextMemoryService);
    this.#interaction = context.agent.accessor.get(ISessionInteractionService);
    this.#permissionMode = context.agent.accessor.get(IAgentPermissionModeService);
    this.#client = clientFactory(
      processService,
      (request, options) => this.#requestPermission(request, options),
    );
  }

  async run(
    request: AgentRunRequest,
    options: RunAgentOptions,
  ): Promise<AgentRunHandle> {
    if (this.#shutdown) {
      throw new Error2(ErrorCodes.INTERNAL, 'ACP executor session is shut down');
    }
    if (this.#active !== undefined) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_RUNNING, 'ACP executor already has an active turn');
    }
    if (request.kind === 'retry') {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Retry is unsupported for external ACP executors');
    }
    options.signal.throwIfAborted();
    await this.hooks.onWillRun.run({ signal: options.signal });
    options.signal.throwIfAborted();

    const turnId = this.#reserveTurnId();
    const prompt = request.prompt;
    const origin: PromptOrigin = request.kind === 'mailbox'
      ? request.message.origin ?? { kind: 'system_trigger', name: 'subagent' }
      : request.origin ?? { kind: 'system_trigger', name: 'subagent' };
    const sessionOptions = this.#sessionOptions(options.signal);
    const opened = await this.#client.openSession(sessionOptions);
    const losses = new Set<ExecutorLossCode>(['acp_no_step_boundaries']);
    if (
      (sessionOptions.additionalDirectories?.length ?? 0) > 0 &&
      opened.capabilities.sessionCapabilities?.additionalDirectories == null
    ) {
      losses.add('additional_directories_dropped');
    }
    const configured = await this.#configure(opened, options.signal, losses);
    const prior = this.#states.get(externalExecutorKey);
    const bindingFingerprint = agentExecutorBindingFingerprint(this.context.binding);
    const reusablePrior = prior.bindingFingerprint === bindingFingerprint;
    const priorSessionId = reusablePrior ? sessionIdFromState(prior.sessionRef) : undefined;
    const sessionEpoch = priorSessionId === configured.sessionId
      ? prior.sessionEpoch ?? 1
      : (prior.sessionEpoch ?? 0) + 1;
    const handoff = opened.mode === 'new' && prior.sessionRef !== undefined
      ? buildHandoff(this.#memory.get())
      : undefined;
    if (handoff !== undefined) {
      losses.add('resume_new_session_handoff');
      if (handoff.truncated) losses.add('handoff_truncated');
    }
    const deliverProfile =
      !reusablePrior || prior.profileDeliveredSessionId !== configured.sessionId;
    if (deliverProfile) losses.add('profile_as_user_preamble');
    const remotePrompt = buildRemotePrompt({
      prompt,
      systemPrompt: deliverProfile ? this.context.binding.systemPrompt : undefined,
      handoff: handoff?.text,
    });
    const resumeMode: ExecutorResumeMode = handoff === undefined
      ? configured.mode
      : 'handoff';
    const recorder = new ExternalTurnRecorder(
      this.context.agent,
      turnId,
      `${configured.sessionId}:e${sessionEpoch}`,
      {
        executorId: this.context.descriptor.id,
        protocol: this.context.descriptor.protocol,
        model: this.context.binding.modelAlias!,
        modelAlias: this.context.binding.modelAlias,
        provider: resolveExternalModelProvider(
          this.context.agent,
          this.context.binding.modelAlias,
        ),
        resumeMode,
        profileDelivery: 'first_prompt_preamble',
        outboundPrompt: remotePrompt,
        initialLosses: [...losses],
      },
    );
    await recorder.begin(prompt, origin);

    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(options.signal.reason);
    options.signal.addEventListener('abort', relayAbort, { once: true });
    if (options.signal.aborted) relayAbort();
    const ready = createControlledPromise<void>();
    const result = createControlledPromise<TurnResult>();
    void ready.catch(() => undefined);
    const turn: MutableExternalTurn = {
      id: turnId,
      state: 'running',
      signal: controller.signal,
      ready,
      result,
      cancel: (reason?: unknown) => {
        if (controller.signal.aborted || isTerminalTurnState(turn.state)) return false;
        controller.abort(reason);
        void this.#client.cancel(reason);
        return true;
      },
    };
    this.#permissionContext = { turn, recorder };

    let handle: AcpTurnHandle<NormalizedExecutorEvent>;
    try {
      handle = await this.#client.startTurn({
        prompt: remotePrompt,
        signal: controller.signal,
        session: sessionOptions,
      });
      await this.#dispatcher.dispatch(
        new ExecutorSessionUpdated({
          executorId: this.context.descriptor.id,
          descriptorRevision: this.context.descriptor.revision,
          bindingFingerprint,
          sessionRef: configured.sessionRef,
          sessionEpoch,
          profileDeliveredSessionId: deliverProfile
            ? configured.sessionId
            : prior.profileDeliveredSessionId,
        }),
      );
      ready.resolve();
      options.onReady?.();
    } catch (error) {
      turn.state = 'failed';
      ready.reject(error instanceof Error ? error : new Error(String(error)));
      await recorder.fail(error);
      result.resolve({ type: 'failed', steps: 1, error });
      this.#permissionContext = undefined;
      options.signal.removeEventListener('abort', relayAbort);
      throw error;
    }

    const completion = this.#completeTurn(
      turn,
      recorder,
      handle,
      result,
      controller,
      () => options.signal.removeEventListener('abort', relayAbort),
      {
        bindingFingerprint,
        sessionRef: configured.sessionRef,
        sessionEpoch,
        profileDeliveredSessionId: deliverProfile
          ? configured.sessionId
          : prior.profileDeliveredSessionId,
        priorCumulativeUsage: reusablePrior ? prior.lastCumulativeUsage : undefined,
        sameSession: priorSessionId !== undefined && priorSessionId === configured.sessionId,
      },
    );
    const active: ActiveExternalTurn = { turn, recorder, handle, completion };
    this.#active = active;
    this.#settled = completion.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.#active === active) this.#active = undefined;
    });
    void completion.catch(() => {});
    return { agentId: this.context.agent.id, turn, completion };
  }

  status(): AgentExecutionStatus {
    if (this.#active !== undefined) {
      return {
        state: this.#active.turn.signal.aborted ? 'cancelling' : 'running',
        turnId: this.#active.turn.id,
      };
    }
    const state = this.#client.status().state;
    if (state === 'broken') return { state: 'broken' };
    if (
      state === 'spawning' ||
      state === 'initializing' ||
      state === 'opening_session' ||
      state === 'configuring'
    ) {
      return { state: 'starting' };
    }
    return { state: 'idle' };
  }

  cancel(reason?: unknown): boolean {
    const active = this.#active;
    if (active === undefined) return false;
    const cancelled = active.turn.cancel(reason);
    void active.handle.cancel(reason);
    this.#interaction.cancelPendingForTurn(active.turn.id);
    return cancelled;
  }

  async settled(): Promise<void> {
    await this.#settled;
  }

  async shutdown(reason?: unknown): Promise<void> {
    if (this.#shutdown) {
      await this.settled();
      return;
    }
    this.#shutdown = true;
    this.cancel(reason);
    await Promise.all([this.settled(), this.#client.shutdown(reason)]);
    this.#runtimeLease.dispose();
  }

  async #completeTurn(
    turn: MutableExternalTurn,
    recorder: ExternalTurnRecorder,
    handle: AcpTurnHandle<NormalizedExecutorEvent>,
    result: ReturnType<typeof createControlledPromise<TurnResult>>,
    controller: AbortController,
    cleanup: () => void,
    accounting: {
      readonly bindingFingerprint: string;
      readonly sessionRef: ExecutorSessionRefEnvelope;
      readonly sessionEpoch: number;
      readonly profileDeliveredSessionId: string | undefined;
      readonly priorCumulativeUsage: ExecutorCumulativeUsage | undefined;
      readonly sameSession: boolean;
    },
  ): Promise<{ readonly summary: string; readonly usage?: TokenUsage }> {
    const pump = (async () => {
      for await (const event of handle.events) {
        await recorder.record(event as ExternalExecutorEvent);
      }
    })();
    try {
      const completed = await handle.completion;
      await pump;
      const turnResult = turnResultFromAcp(completed);
      if (turnResult.type === 'completed') {
        const accounted = usageFromAcp(
          completed,
          accounting.priorCumulativeUsage,
          accounting.sameSession,
        );
        if (accounted !== undefined) {
          await this.#dispatcher.dispatch(
            new ExecutorSessionUpdated({
              executorId: this.context.descriptor.id,
              descriptorRevision: this.context.descriptor.revision,
              bindingFingerprint: accounting.bindingFingerprint,
              sessionRef: accounting.sessionRef,
              sessionEpoch: accounting.sessionEpoch,
              profileDeliveredSessionId: accounting.profileDeliveredSessionId,
              lastCumulativeUsage: accounted.cumulative,
            }),
          );
        }
        const usage = accounted?.usage;
        turn.state = 'completed';
        await recorder.complete(completed.response.stopReason, usage);
        result.resolve(turnResult);
        if (turnResult.truncated) {
          throw new Error2(
            ErrorCodes.AGENT_MAX_TOKENS_EXCEEDED,
            'External ACP executor reached its token or turn-request limit',
          );
        }
        return {
          summary: recorder.summary(),
          usage,
        };
      }
      if (turnResult.type === 'cancelled') {
        turn.state = 'cancelled';
        await recorder.cancel(turnResult.reason);
        result.resolve(turnResult);
        throw toError(turnResult.reason, 'External ACP turn was cancelled');
      }
      turn.state = 'failed';
      await recorder.fail(turnResult.error);
      result.resolve(turnResult);
      throw toError(turnResult.error, 'External ACP turn failed');
    } catch (error) {
      await pump.catch(() => undefined);
      if (controller.signal.aborted) {
        const reason = controller.signal.reason ?? error;
        turn.state = 'cancelled';
        await recorder.cancel(reason);
        result.resolve({ type: 'cancelled', steps: 1, reason });
      } else if (!isTerminalTurnState(turn.state)) {
        turn.state = 'failed';
        await recorder.fail(error);
        result.resolve({ type: 'failed', steps: 1, error });
      }
      throw error;
    } finally {
      cleanup();
      if (this.#permissionContext?.turn === turn) this.#permissionContext = undefined;
      this.#interaction.cancelPendingForTurn(turn.id);
    }
  }

  #sessionOptions(signal: AbortSignal): AcpOpenSessionOptions {
    const runtime = this.#runtimeLease.runtime;
    const roots = runtime.workspace.mapRoots({
      workDir: this.#workspace.workDir,
      additionalDirs: this.#workspace.additionalDirs,
    });
    const state = this.#states.get(externalExecutorKey);
    if (
      state.executorId !== undefined &&
      (state.executorId !== this.context.descriptor.id ||
        state.descriptorRevision !== this.context.descriptor.revision)
    ) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Executor session state does not match descriptor "${this.context.descriptor.id}"`,
      );
    }
    return {
      cwd: roots.workDir,
      additionalDirectories: roots.additionalDirs,
      mcpServers: [],
      sessionRef:
        state.bindingFingerprint === agentExecutorBindingFingerprint(this.context.binding)
          ? state.sessionRef as ExecutorSessionRefEnvelope | undefined
          : undefined,
      signal,
    };
  }

  async #configure(
    opened: AcpOpenSessionResult,
    signal: AbortSignal,
    losses: Set<ExecutorLossCode>,
  ): Promise<AcpOpenSessionResult> {
    const modelBinding = this.context.descriptor.modelBinding ?? 'session_config';
    if (modelBinding !== 'session_config' && modelBinding !== 'argv') {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Unsupported ACP model binding "${modelBinding}"`,
      );
    }
    let configured = opened;
    if (modelBinding === 'session_config') {
      const model = selectConfig(
        configured.configOptions,
        this.context.descriptor.modelConfigId,
        this.context.descriptor.modelConfigCategory ?? 'model',
        this.context.binding.modelAlias,
        'model',
      );
      configured = await this.#client.configureSession({
        configOptions: [model.selection],
        signal,
      });
      assertConfigured(configured.configOptions, model.selection, 'model');
    }

    if (this.context.binding.thinkingLevel !== 'off') {
      const thought = selectConfigIfAvailable(
        configured.configOptions,
        this.context.descriptor.thoughtConfigId,
        this.context.descriptor.thoughtConfigCategory ?? 'thought_level',
        this.context.binding.thinkingLevel,
        'thought level',
      );
      if (thought === undefined) {
        losses.add('thought_level_unconfigured');
      } else {
        configured = await this.#client.configureSession({
          configOptions: [thought.selection],
          signal,
        });
        assertConfigured(configured.configOptions, thought.selection, 'thought level');
      }
    }

    const mapping = this.context.descriptor.permissionModeMapping;
    if (mapping === undefined) {
      losses.add('permission_mode_unverified');
      return configured;
    }
    const permission = permissionConfig(
      configured.configOptions,
      mapping,
      this.#permissionMode.mode,
    );
    const verified = await this.#client.configureSession({
      configOptions: [permission.selection],
      signal,
    });
    assertConfigured(verified.configOptions, permission.selection, 'permission mode');
    return verified;
  }

  #reserveTurnId(): number {
    const modelNextId = this.#states.get(turnKey).nextTurnId;
    const id = Math.max(modelNextId, this.#nextReservedTurnId ?? modelNextId);
    this.#nextReservedTurnId = id + 1;
    return id;
  }

  async #requestPermission(
    request: AcpPermissionRequest,
    context: { readonly signal: AbortSignal; readonly options: readonly AcpPermissionOption[] },
  ): Promise<{ readonly outcome: 'selected' | 'cancelled'; readonly optionId?: string }> {
    const active = this.#permissionContext;
    if (active === undefined || context.signal.aborted) return { outcome: 'cancelled' };
    const toolCallId = active.recorder.toolCallId(request.toolCall.toolCallId);
    let approval: Promise<Awaited<ReturnType<ISessionApprovalService['request']>>>;
    try {
      approval = this.context.agent.accessor.get(ISessionApprovalService).request({
        agentId: this.context.agent.id,
        turnId: active.turn.id,
        toolCallId,
        toolName: request.toolCall.title ?? request.toolCall.kind ?? 'External tool',
        action: request.toolCall.title ?? 'Run external tool',
        display: {
          kind: 'external_permission',
          summary: request.toolCall.title ?? 'External tool permission',
          detail: boundedPermissionDetail(request),
          options: context.options.map((option) => ({
            id: option.optionId,
            label: option.name,
            kind: option.kind,
            changes: optionChanges(option),
          })),
        },
      });
    } catch {
      return { outcome: 'cancelled' };
    }
    const response = await raceApproval(approval, context.signal);
    if (response === undefined || response.decision === 'cancelled') {
      this.#interaction.cancelPendingForTurn(active.turn.id);
      return { outcome: 'cancelled' };
    }
    const selectedOptionId = response.selectedOptionId;
    if (
      selectedOptionId === undefined ||
      !context.options.some((option) => option.optionId === selectedOptionId)
    ) {
      return { outcome: 'cancelled' };
    }
    return { outcome: 'selected', optionId: selectedOptionId };
  }
}

function sessionIdFromState(ref: ExecutorSessionRefEnvelope | undefined): string | undefined {
  const sessionId = ref?.ref['sessionId'];
  return typeof sessionId === 'string' ? sessionId : undefined;
}

function requiredCommand(context: AgentExecutorContext): string {
  const command = context.descriptor.command;
  if (command === undefined || command.trim().length === 0) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `External executor "${context.descriptor.id}" has no command`,
    );
  }
  return command;
}

export function resolveAcpProcessArgs(context: AgentExecutorContext): readonly string[] {
  if (context.descriptor.modelBinding !== 'argv') return context.descriptor.args;
  const model = context.binding.modelAlias;
  if (model === undefined || model.length === 0) {
    throw new Error2(
      ErrorCodes.MODEL_NOT_CONFIGURED,
      `External executor "${context.descriptor.id}" requires a pinned argv model`,
    );
  }
  const template = context.descriptor.modelArgs;
  if (template === undefined || template.length === 0) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `External executor "${context.descriptor.id}" has argv model binding without model_args`,
    );
  }
  let replacements = 0;
  const modelArgs = template.map((value) => value.replaceAll('{model}', () => {
    replacements += 1;
    return model;
  }));
  if (replacements !== 1) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `External executor "${context.descriptor.id}" model_args must contain exactly one {model} placeholder`,
    );
  }
  return [...modelArgs, ...context.descriptor.args];
}

function isTerminalTurnState(state: NonNullable<Turn['state']>): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function turnResultFromAcp(result: AcpTurnResult): TurnResult {
  switch (result.response.stopReason) {
    case 'end_turn':
      return { type: 'completed', steps: 1, truncated: false };
    case 'max_tokens':
    case 'max_turn_requests':
      return { type: 'completed', steps: 1, truncated: true };
    case 'cancelled':
      return { type: 'cancelled', steps: 1, reason: new Error('External ACP turn cancelled') };
    case 'refusal':
      return { type: 'failed', steps: 1, error: new Error('External ACP agent refused the request') };
    default:
      return {
        type: 'failed',
        steps: 1,
        error: new Error(`External ACP agent returned unknown stop reason ${String(result.response.stopReason)}`),
      };
  }
}

function usageFromAcp(
  result: AcpTurnResult,
  priorCumulative: ExecutorCumulativeUsage | undefined,
  sameSession: boolean,
): { readonly usage: TokenUsage | undefined; readonly cumulative: ExecutorCumulativeUsage } | undefined {
  const usage = result.response.usage;
  if (usage === undefined || usage === null) return undefined;
  const cumulative: ExecutorCumulativeUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    thoughtTokens: numberOrUndefined(usage.thoughtTokens),
    cachedReadTokens: numberOrUndefined(usage.cachedReadTokens),
    cachedWriteTokens: numberOrUndefined(usage.cachedWriteTokens),
  };
  if (!hasTrustworthyCumulativeBaseline(sameSession, cumulative, priorCumulative)) {
    return { usage: undefined, cumulative };
  }
  const baseline = sameSession ? priorCumulative! : undefined;
  return {
    usage: {
      inputOther: cumulative.inputTokens - (baseline?.inputTokens ?? 0),
      output: cumulative.outputTokens - (baseline?.outputTokens ?? 0),
      inputCacheRead: (cumulative.cachedReadTokens ?? 0) - (baseline?.cachedReadTokens ?? 0),
      inputCacheCreation: (cumulative.cachedWriteTokens ?? 0) - (baseline?.cachedWriteTokens ?? 0),
    },
    cumulative,
  };
}

function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hasTrustworthyCumulativeBaseline(
  sameSession: boolean,
  cumulative: ExecutorCumulativeUsage,
  priorCumulative: ExecutorCumulativeUsage | undefined,
): boolean {
  if (!sameSession) return true;
  if (priorCumulative === undefined) return false;
  return cumulativeUsageMonotonic(cumulative, priorCumulative);
}

function cumulativeUsageMonotonic(
  next: ExecutorCumulativeUsage,
  prior: ExecutorCumulativeUsage,
): boolean {
  const fields = [
    ['inputTokens', next.inputTokens, prior.inputTokens],
    ['outputTokens', next.outputTokens, prior.outputTokens],
    ['totalTokens', next.totalTokens, prior.totalTokens],
    ['thoughtTokens', next.thoughtTokens, prior.thoughtTokens],
    ['cachedReadTokens', next.cachedReadTokens, prior.cachedReadTokens],
    ['cachedWriteTokens', next.cachedWriteTokens, prior.cachedWriteTokens],
  ] as const;
  return fields.every(([, value, before]) =>
    value === undefined || before === undefined ? true : value >= before
  );
}

function selectConfig(
  options: readonly AcpSessionConfigOption[],
  configId: string | undefined,
  category: string,
  value: string | undefined,
  label: string,
): SelectedConfig {
  const selected = resolveSelectConfig(options, configId, category, value, label);
  if (selected === undefined) {
    throw new Error2(
      ErrorCodes.MODEL_NOT_FOUND,
      `External ACP ${label} config category "${category}" is missing`,
    );
  }
  return selected;
}

function selectConfigIfAvailable(
  options: readonly AcpSessionConfigOption[],
  configId: string | undefined,
  category: string,
  value: string | undefined,
  label: string,
): SelectedConfig | undefined {
  return resolveSelectConfig(options, configId, category, value, label);
}

function resolveSelectConfig(
  options: readonly AcpSessionConfigOption[],
  configId: string | undefined,
  category: string,
  value: string | undefined,
  label: string,
): SelectedConfig | undefined {
  if (value === undefined || value.length === 0) {
    throw new Error2(ErrorCodes.MODEL_NOT_FOUND, `External ACP ${label} is not configured`);
  }
  const selects = options.filter((option) => option.type === 'select');
  let candidates: readonly AcpSessionConfigOption[];
  if (configId !== undefined) {
    candidates = selects.filter((option) => option.id === configId);
    if (candidates.length === 0) {
      throw new Error2(
        ErrorCodes.MODEL_NOT_FOUND,
        `External ACP ${label} config id "${configId}" is missing`,
      );
    }
  } else {
    const categorized = selects.filter(
      (option) => option.category != null && option.category === category,
    );
    if (categorized.length > 0) {
      candidates = categorized;
    } else {
      candidates = selects.filter(uncategorizedSelectOptions);
    }
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) {
    throw new Error2(
      ErrorCodes.MODEL_NOT_FOUND,
      `External ACP ${label} config category "${category}" is ambiguous`,
    );
  }
  const option = candidates[0]!;
  const values = selectValues(option);
  if (!values.includes(value)) {
    throw new Error2(
      ErrorCodes.MODEL_NOT_FOUND,
      `External ACP ${label} "${value}" is unavailable in config "${option.id}"`,
    );
  }
  return { option, selection: { configId: option.id, value } };
}

function uncategorizedSelectOptions(option: AcpSessionConfigOption): boolean {
  return option.category == null;
}

function selectValues(option: AcpSessionConfigOption): string[] {
  if (option.type !== 'select') return [];
  const values: string[] = [];
  for (const candidate of option.options) {
    if ('value' in candidate) values.push(candidate.value);
    else for (const nested of candidate.options) values.push(nested.value);
  }
  return values;
}

function permissionConfig(
  options: readonly AcpSessionConfigOption[],
  mapping: AgentExecutorPermissionModeMapping | undefined,
  mode: IAgentPermissionModeService['mode'],
): SelectedConfig {
  if (mapping === undefined) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      'External ACP permission mode mapping is not configured',
    );
  }
  const matches = options.filter((option) =>
    mapping.configId === undefined
      ? option.category === mapping.configCategory
      : option.id === mapping.configId);
  if (matches.length !== 1) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `External ACP permission config is ${matches.length === 0 ? 'missing' : 'ambiguous'}`,
    );
  }
  const option = matches[0]!;
  const value = mapping[mode];
  if (typeof value === 'boolean') {
    if (option.type !== 'boolean') {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `External ACP permission config "${option.id}" is not boolean`,
      );
    }
  } else if (option.type !== 'select' || !selectValues(option).includes(value)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `External ACP permission mode "${value}" is unavailable in config "${option.id}"`,
    );
  }
  return { option, selection: { configId: option.id, value } };
}

function assertConfigured(
  options: readonly AcpSessionConfigOption[],
  selection: AcpSessionConfigSelection,
  label: string,
): void {
  const option = options.find((candidate) => candidate.id === selection.configId);
  if (option === undefined || option.currentValue !== selection.value) {
    throw new Error2(
      ErrorCodes.MODEL_NOT_FOUND,
      `External ACP ${label} config "${selection.configId}" did not accept the selected value`,
    );
  }
}

function buildRemotePrompt(input: {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly handoff?: string;
}): string {
  const sections: string[] = [];
  if (input.systemPrompt !== undefined) {
    sections.push(`${PROFILE_PREAMBLE_BEGIN}\n${input.systemPrompt}\n${PROFILE_PREAMBLE_END}`);
  }
  if (input.handoff !== undefined) {
    sections.push(`${HANDOFF_BEGIN}\n${input.handoff}\n${HANDOFF_END}`);
  }
  sections.push(input.prompt);
  return sections.join('\n\n');
}

export function buildHandoff(
  messages: readonly ContextMessage[],
): { readonly text: string; readonly truncated: boolean } {
  const turns: string[][] = [];
  let current: string[] | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      current = [`User: ${messageText(message)}`];
      turns.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (message.role === 'assistant') {
      const text = messageText(message);
      if (text.length > 0) current.push(`Assistant: ${text}`);
      for (const toolCall of message.toolCalls) {
        current.push(`Tool: ${toolCall.name}`);
      }
    } else if (message.role === 'tool') {
      current.push(`Tool status: ${message.isError === true ? 'failed' : 'completed'}`);
    }
  }
  const selected = turns.slice(-MAX_HANDOFF_TURNS);
  let text = selected.map((turn) => turn.join('\n')).join('\n\n');
  let truncated = turns.length > selected.length;
  while (Buffer.byteLength(text, 'utf8') > MAX_HANDOFF_BYTES && selected.length > 1) {
    selected.shift();
    text = selected.map((turn) => turn.join('\n')).join('\n\n');
    truncated = true;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_HANDOFF_BYTES) {
    text = truncateUtf8(text, MAX_HANDOFF_BYTES);
    truncated = true;
  }
  return { text, truncated };
}

function messageText(message: ContextMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: 'text' }> =>
      part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

async function raceApproval<T>(
  approval: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    void approval.then((value) => finish(value), () => finish(undefined));
  });
}

function optionChanges(option: AcpPermissionOption): readonly unknown[] | undefined {
  const meta = objectOf(option._meta);
  const permission = objectOf(meta?.['permission']);
  const changes = permission?.['changes'];
  return Array.isArray(changes) ? changes : undefined;
}

function boundedPermissionDetail(request: AcpPermissionRequest): unknown {
  return {
    toolCall: {
      title: request.toolCall.title,
      kind: request.toolCall.kind,
      status: request.toolCall.status,
      rawInput: request.toolCall.rawInput,
      content: request.toolCall.content,
      locations: request.toolCall.locations,
    },
    meta: request._meta,
  };
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(value === undefined ? fallback : String(value));
}
