import { createControlledPromise } from '@antfu/utils';
import {
  CodexAppServerClient,
  CodexClientError,
  CodexRemoteError,
  type CodexModelListResult,
  type CodexServerRequest,
  type CodexServerRequestResponder,
  type CodexThreadResult,
  type CodexTurnHandle,
  type CodexTurnCompletion,
  type HostProcessServiceLike,
} from '@moonshot-ai/codex-client';

import type {
  AgentExecutionStatus,
  AgentExecutorContext,
  AgentExecutorSession,
} from '#/app/agentExecutor/agentExecutor';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { Turn, TurnResult } from '#/agent/loop/loop';
import { turnKey } from '#/agent/loop/turnOps';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { Error2, ErrorCodes } from '#/errors';
import { createHooks } from '#/hooks';
import type { TokenUsage } from '#/kosong/contract/usage';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import {
  ISessionQuestionService,
  type QuestionAnswers,
  type QuestionResult,
} from '#/session/question/question';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { buildHandoff } from './acpAgentExecutorSession';
import {
  ExecutorSessionUpdated,
  externalExecutorKey,
  type ExecutorLossCode,
  type ExecutorResumeMode,
} from './externalExecutorOps';
import { ExternalTurnRecorder } from './externalTurnRecorder';

interface CodexClientLike {
  status(): ReturnType<CodexAppServerClient['status']>;
  connect(signal?: AbortSignal): Promise<void>;
  listModels(signal?: AbortSignal): Promise<CodexModelListResult>;
  startThread(params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<CodexThreadResult>;
  resumeThread(params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<CodexThreadResult>;
  startTurn(params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<CodexTurnHandle>;
  shutdown(reason?: unknown): Promise<void>;
}

interface MutableExternalTurn extends Turn {
  state: NonNullable<Turn['state']>;
}

interface ActiveCodexTurn {
  readonly turn: MutableExternalTurn;
  readonly recorder: ExternalTurnRecorder;
  readonly handle: CodexTurnHandle;
  readonly completion: Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
}

interface OpenedThread {
  readonly threadId: string;
  readonly mode: ExecutorResumeMode;
  readonly handoff?: { readonly text: string; readonly truncated: boolean };
}

interface PermissionContext {
  readonly turn: MutableExternalTurn;
  readonly recorder: ExternalTurnRecorder;
  readonly signal: AbortSignal;
}

const HANDOFF_BEGIN = '--- BEGIN KIKI PRIOR TRANSCRIPT HANDOFF ---';
const HANDOFF_END = '--- END KIKI PRIOR TRANSCRIPT HANDOFF ---';

export class CodexAppServerExecutorSession implements AgentExecutorSession {
  readonly hooks = createHooks<{ onWillRun: { signal: AbortSignal } }, 'onWillRun'>([
    'onWillRun',
  ]);

  readonly #runtimeLease;
  readonly #client: CodexClientLike;
  readonly #states: IAgentStateService;
  readonly #dispatcher: IEventDispatcher;
  readonly #workspace: ISessionWorkspaceContext;
  readonly #memory: IAgentContextMemoryService;
  #threadId: string | undefined;
  #modelValidated = false;
  #active: ActiveCodexTurn | undefined;
  #permissionContext: PermissionContext | undefined;
  #settled: Promise<void> = Promise.resolve();
  #nextReservedTurnId: number | undefined;
  #shutdown = false;

  constructor(
    private readonly context: AgentExecutorContext,
    clientFactory: (
      processService: HostProcessServiceLike,
      onServerRequest: (
        request: CodexServerRequest,
        responder: CodexServerRequestResponder,
        signal: AbortSignal,
      ) => Promise<void>,
    ) => CodexClientLike = (processService, onServerRequest) =>
      new CodexAppServerClient(
        processService,
        {
          id: context.descriptor.id,
          command: requiredCommand(context),
          args: context.descriptor.args,
          env: context.descriptor.env === undefined ? undefined : { ...context.descriptor.env },
          startupTimeoutMs: context.descriptor.startupTimeoutMs,
          shutdownGraceMs: context.descriptor.shutdownGraceMs,
          clientName: 'kiki-agent-core-v2',
        },
        { onServerRequest },
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
    this.#client = clientFactory(
      processService,
      (request, responder, signal) => this.#handleServerRequest(request, responder, signal),
    );
  }

  async run(
    request: AgentRunRequest,
    options: RunAgentOptions,
  ): Promise<AgentRunHandle> {
    if (this.#shutdown) {
      throw new Error2(ErrorCodes.INTERNAL, 'Codex app-server executor session is shut down');
    }
    if (this.#active !== undefined) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_RUNNING, 'Codex app-server executor already has an active turn');
    }
    if (request.kind !== 'prompt') {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Retry is unsupported for Codex app-server executors');
    }
    options.signal.throwIfAborted();
    await this.hooks.onWillRun.run({ signal: options.signal });
    options.signal.throwIfAborted();

    const turnId = this.#reserveTurnId();
    const origin: PromptOrigin = request.origin ?? { kind: 'system_trigger', name: 'subagent' };
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(options.signal.reason);
    options.signal.addEventListener('abort', relayAbort, { once: true });
    if (options.signal.aborted) relayAbort();

    const roots = this.#roots();
    await this.#client.connect(controller.signal);
    await this.#validateModel(controller.signal);
    const opened = await this.#openThread(roots, controller.signal);
    const prior = this.#states.get(externalExecutorKey);
    const priorThreadId = threadIdFromState(prior.sessionRef);
    const sessionEpoch = priorThreadId === opened.threadId
      ? prior.sessionEpoch ?? 1
      : (prior.sessionEpoch ?? 0) + 1;
    const losses = new Set<ExecutorLossCode>(['codex_no_step_boundaries']);
    if (opened.handoff !== undefined) {
      losses.add('resume_new_session_handoff');
      if (opened.handoff.truncated) losses.add('handoff_truncated');
    }
    const remotePrompt = opened.handoff === undefined
      ? request.prompt
      : `${HANDOFF_BEGIN}\n${opened.handoff.text}\n${HANDOFF_END}\n\n${request.prompt}`;
    const recorder = new ExternalTurnRecorder(
      this.context.agent,
      turnId,
      `${opened.threadId}:e${sessionEpoch}`,
      {
        executorId: this.context.descriptor.id,
        protocol: this.context.descriptor.protocol,
        resumeMode: opened.mode,
        profileDelivery: 'native',
        outboundPrompt: remotePrompt,
        initialLosses: [...losses],
      },
    );
    await recorder.begin(request.prompt, origin);

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
        return true;
      },
    };
    this.#permissionContext = { turn, recorder, signal: controller.signal };

    let handle: CodexTurnHandle;
    try {
      handle = await this.#client.startTurn({
        threadId: opened.threadId,
        input: [{ type: 'text', text: remotePrompt }],
        effort: this.context.binding.thinkingLevel === 'off'
          ? undefined
          : this.context.binding.thinkingLevel,
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: roots.additionalDirs,
          networkAccess: false,
        },
      }, controller.signal);
      await this.#dispatcher.dispatch(new ExecutorSessionUpdated({
        executorId: this.context.descriptor.id,
        descriptorRevision: this.context.descriptor.revision,
        sessionRef: {
          executorId: this.context.descriptor.id,
          version: 1,
          ref: { threadId: opened.threadId },
        },
        sessionEpoch,
        profileDeliveredSessionId: opened.threadId,
      }));
      ready.resolve();
      options.onReady?.();
    } catch (error) {
      turn.state = controller.signal.aborted ? 'cancelled' : 'failed';
      ready.reject(toError(error, 'Codex turn failed to start'));
      if (controller.signal.aborted) {
        await recorder.cancel(controller.signal.reason ?? error);
        result.resolve({ type: 'cancelled', steps: 1, reason: controller.signal.reason ?? error });
      } else {
        await recorder.fail(error);
        result.resolve({ type: 'failed', steps: 1, error });
      }
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
    );
    const active: ActiveCodexTurn = { turn, recorder, handle, completion };
    this.#active = active;
    this.#settled = completion.then(() => undefined, () => undefined).finally(() => {
      if (this.#active === active) this.#active = undefined;
    });
    void completion.catch(() => undefined);
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
    if (state === 'spawning' || state === 'initializing') return { state: 'starting' };
    return { state: 'idle' };
  }

  cancel(reason?: unknown): boolean {
    const active = this.#active;
    if (active === undefined) return false;
    const cancelled = active.turn.cancel(reason);
    void active.handle.cancel(reason);
    this.context.agent.accessor.get(ISessionInteractionService).cancelPendingForTurn(active.turn.id);
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
    handle: CodexTurnHandle,
    result: ReturnType<typeof createControlledPromise<TurnResult>>,
    controller: AbortController,
    cleanup: () => void,
  ): Promise<{ readonly summary: string; readonly usage?: TokenUsage }> {
    const pump = (async () => {
      for await (const event of handle.events) await recorder.record(event);
    })();
    try {
      const completed = await handle.completion;
      await pump;
      const turnResult = turnResultFromCodex(completed);
      if (turnResult.type === 'completed') {
        turn.state = 'completed';
        await recorder.complete(completed.status);
        result.resolve(turnResult);
        return { summary: recorder.summary(), usage: usageFromCodex(completed) };
      }
      if (turnResult.type === 'cancelled') {
        turn.state = 'cancelled';
        await recorder.cancel(turnResult.reason);
        result.resolve(turnResult);
        throw toError(turnResult.reason, 'Codex turn was interrupted');
      }
      turn.state = 'failed';
      await recorder.fail(turnResult.error);
      result.resolve(turnResult);
      throw toError(turnResult.error, 'Codex turn failed');
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
      this.context.agent.accessor.get(ISessionInteractionService).cancelPendingForTurn(turn.id);
    }
  }

  async #validateModel(signal: AbortSignal): Promise<void> {
    if (this.#modelValidated) return;
    const model = this.context.binding.modelAlias;
    if (model === undefined || model.length === 0) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Codex app-server requires a pinned model id');
    }
    let listed: CodexModelListResult;
    try {
      listed = await this.#client.listModels(signal);
    } catch (error) {
      throw new Error2(
        ErrorCodes.MODEL_NOT_FOUND,
        'Codex app-server model/list is unavailable or malformed',
        { cause: error },
      );
    }
    if (!listed.data.some((candidate) => candidate.id === model)) {
      throw new Error2(
        ErrorCodes.MODEL_NOT_FOUND,
        `Codex app-server model "${model}" is not advertised by model/list`,
        { details: { model, available: listed.data.map((candidate) => candidate.id) } },
      );
    }
    this.#modelValidated = true;
  }

  async #openThread(
    roots: { readonly workDir: string; readonly additionalDirs?: readonly string[] },
    signal: AbortSignal,
  ): Promise<OpenedThread> {
    if (this.#threadId !== undefined) return { threadId: this.#threadId, mode: 'live' };
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
    const priorThreadId = threadIdFromState(state.sessionRef);
    if (priorThreadId !== undefined) {
      try {
        const resumed = await this.#client.resumeThread({
          threadId: priorThreadId,
          model: this.context.binding.modelAlias,
          cwd: roots.workDir,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          developerInstructions: this.context.binding.systemPrompt,
        }, signal);
        this.#threadId = resumed.thread.id;
        return { threadId: resumed.thread.id, mode: 'resume' };
      } catch (error) {
        if (!isResumeProtocolFailure(error)) throw error;
        const handoff = buildHandoff(this.#memory.get());
        const fresh = await this.#startFreshThread(roots, signal);
        return { threadId: fresh.thread.id, mode: 'handoff', handoff };
      }
    }
    const fresh = await this.#startFreshThread(roots, signal);
    return { threadId: fresh.thread.id, mode: 'new' };
  }

  async #startFreshThread(
    roots: { readonly workDir: string; readonly additionalDirs?: readonly string[] },
    signal: AbortSignal,
  ): Promise<CodexThreadResult> {
    const started = await this.#client.startThread({
      model: this.context.binding.modelAlias,
      cwd: roots.workDir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: this.context.binding.systemPrompt,
    }, signal);
    this.#threadId = started.thread.id;
    return started;
  }

  #roots(): { readonly workDir: string; readonly additionalDirs?: readonly string[] } {
    return this.#runtimeLease.runtime.workspace.mapRoots({
      workDir: this.#workspace.workDir,
      additionalDirs: this.#workspace.additionalDirs,
    });
  }

  #reserveTurnId(): number {
    const modelNextId = this.#states.get(turnKey).nextTurnId;
    const id = Math.max(modelNextId, this.#nextReservedTurnId ?? modelNextId);
    this.#nextReservedTurnId = id + 1;
    return id;
  }

  async #handleServerRequest(
    request: CodexServerRequest,
    responder: CodexServerRequestResponder,
    signal: AbortSignal,
  ): Promise<void> {
    const active = this.#permissionContext;
    if (active === undefined || active.signal.aborted || signal.aborted) {
      await responder.respondError(-32000, 'No active interaction consumer');
      return;
    }
    if (request.method === 'item/commandExecution/requestApproval') {
      await this.#commandApproval(request, responder, active);
      return;
    }
    if (request.method === 'item/fileChange/requestApproval') {
      await this.#fileApproval(request, responder, active);
      return;
    }
    if (request.method === 'item/permissions/requestApproval') {
      await this.#permissionsApproval(request, responder, active);
      return;
    }
    if (request.method === 'item/tool/requestUserInput') {
      await this.#userInput(request, responder, active);
      return;
    }
    await responder.respondError(-32601, `Unsupported server request: ${request.method}`);
  }

  async #commandApproval(
    request: CodexServerRequest,
    responder: CodexServerRequestResponder,
    active: PermissionContext,
  ): Promise<void> {
    const raw = Array.isArray(request.params['availableDecisions'])
      ? request.params['availableDecisions']
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
    const decisions = raw.map((decision) => ({
      id: decisionId(decision),
      raw: decision,
      label: decisionLabel(decision),
      kind: decisionKind(decision),
    }));
    const selected = await this.#approval(
      request,
      active,
      optionalString(request.params['command']) ?? 'Command execution',
      decisions,
    );
    const decision = decisions.find((candidate) => candidate.id === selected)?.raw ?? 'cancel';
    await responder.respond({ decision });
  }

  async #fileApproval(
    request: CodexServerRequest,
    responder: CodexServerRequestResponder,
    active: PermissionContext,
  ): Promise<void> {
    const decisions = ['accept', 'acceptForSession', 'decline', 'cancel'].map((decision) => ({
      id: decision,
      raw: decision,
      label: decisionLabel(decision),
      kind: decisionKind(decision),
    }));
    const selected = await this.#approval(request, active, 'File change', decisions);
    await responder.respond({ decision: decisions.find((candidate) => candidate.id === selected)?.raw ?? 'cancel' });
  }

  async #permissionsApproval(
    request: CodexServerRequest,
    responder: CodexServerRequestResponder,
    active: PermissionContext,
  ): Promise<void> {
    const requested = request.params['permissions'];
    const decisions = [
      { id: 'grant-turn', raw: 'grant-turn', label: 'Allow for this turn', kind: 'allow_once' },
      { id: 'grant-session', raw: 'grant-session', label: 'Allow for this session', kind: 'allow_always' },
      { id: 'deny', raw: 'deny', label: 'Deny', kind: 'reject_once' },
    ];
    const selected = await this.#approval(request, active, 'Additional permissions', decisions);
    if (selected === 'grant-turn' || selected === 'grant-session') {
      await responder.respond({
        permissions: requested,
        scope: selected === 'grant-session' ? 'session' : 'turn',
      });
      return;
    }
    await responder.respond({ permissions: {}, scope: 'turn' });
  }

  async #userInput(
    request: CodexServerRequest,
    responder: CodexServerRequestResponder,
    active: PermissionContext,
  ): Promise<void> {
    const rawQuestions = Array.isArray(request.params['questions']) ? request.params['questions'] : [];
    const questionIds: string[] = [];
    const questions = rawQuestions.flatMap((raw) => {
      if (!isObject(raw) || typeof raw['id'] !== 'string' || typeof raw['question'] !== 'string') return [];
      questionIds.push(raw['id']);
      return [{
        question: raw['question'],
        header: optionalString(raw['header']),
        options: Array.isArray(raw['options'])
          ? raw['options'].flatMap((option) =>
              isObject(option) && typeof option['label'] === 'string'
                ? [{ label: option['label'], description: optionalString(option['description']) }]
                : [])
          : [],
        multiSelect: false,
      }];
    });
    if (questions.length !== rawQuestions.length) {
      await responder.respondError(-32602, 'Invalid user input question payload');
      return;
    }
    const response = await this.context.agent.accessor.get(ISessionQuestionService).request(
      {
        id: `codex:${String(request.id)}`,
        turnId: active.turn.id,
        toolCallId: active.recorder.toolCallId(requiredItemId(request)),
        questions,
      },
      { signal: active.signal, agentId: this.context.agent.id },
    );
    const values = questionAnswerValues(response);
    const answers: Record<string, { readonly answers: readonly string[] }> = {};
    questionIds.forEach((id, index) => {
      const value = values[String(index)] ?? values[id];
      answers[id] = { answers: value === undefined ? [] : [String(value)] };
    });
    await responder.respond({ answers });
  }

  async #approval(
    request: CodexServerRequest,
    active: PermissionContext,
    action: string,
    decisions: readonly {
      readonly id: string;
      readonly raw: unknown;
      readonly label: string;
      readonly kind: string;
    }[],
  ): Promise<string | undefined> {
    let approval: Promise<Awaited<ReturnType<ISessionApprovalService['request']>>>;
    try {
      approval = this.context.agent.accessor.get(ISessionApprovalService).request({
        id: `codex:${String(request.id)}`,
        agentId: this.context.agent.id,
        turnId: active.turn.id,
        toolCallId: active.recorder.toolCallId(requiredItemId(request)),
        toolName: action,
        action,
        display: {
          kind: 'external_permission',
          summary: action,
          detail: request.params,
          options: decisions.map((decision) => ({
            id: decision.id,
            label: decision.label,
            kind: decision.kind,
          })),
        },
      });
    } catch {
      return undefined;
    }
    const response = await raceInteraction(approval, active.signal);
    if (response === undefined || response.decision === 'cancelled') return undefined;
    const selected = response.selectedOptionId;
    return selected !== undefined && decisions.some((decision) => decision.id === selected)
      ? selected
      : undefined;
  }
}

function questionAnswerValues(response: QuestionResult): QuestionAnswers {
  if (response === null) return {};
  const nested = response['answers'];
  return typeof nested === 'object' && nested !== null ? nested : response as QuestionAnswers;
}

function requiredCommand(context: AgentExecutorContext): string {
  const command = context.descriptor.command;
  if (command === undefined || command.trim().length === 0) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `External executor "${context.descriptor.id}" has no resolved command`,
    );
  }
  return command;
}

function threadIdFromState(
  ref: { readonly ref: Readonly<Record<string, unknown>> } | undefined,
): string | undefined {
  const threadId = ref?.ref['threadId'];
  return typeof threadId === 'string' ? threadId : undefined;
}

function isResumeProtocolFailure(error: unknown): boolean {
  return error instanceof CodexRemoteError ||
    error instanceof CodexClientError && error.code === 'protocol';
}

function turnResultFromCodex(completed: CodexTurnCompletion): TurnResult {
  if (completed.status === 'completed') return { type: 'completed', steps: 1, truncated: false };
  if (completed.status === 'interrupted') {
    return { type: 'cancelled', steps: 1, reason: new Error('Codex turn interrupted') };
  }
  return {
    type: 'failed',
    steps: 1,
    error: completed.error ?? new Error(`Codex turn completed with status ${completed.status}`),
  };
}

function usageFromCodex(completed: CodexTurnCompletion): TokenUsage | undefined {
  const usage = completed.usage;
  if (usage === undefined) return undefined;
  return {
    inputOther: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
    inputCacheRead: usage.cachedInputTokens,
    inputCacheCreation: 0,
    output: usage.outputTokens,
  };
}

function decisionId(value: unknown): string {
  return typeof value === 'string' ? value : `json:${JSON.stringify(value)}`;
}

function decisionLabel(value: unknown): string {
  if (value === 'accept') return 'Allow once';
  if (value === 'acceptForSession') return 'Allow for session';
  if (value === 'decline') return 'Decline';
  if (value === 'cancel') return 'Cancel turn';
  if (isObject(value) && Object.hasOwn(value, 'acceptWithExecpolicyAmendment')) {
    return 'Allow with command policy amendment';
  }
  if (isObject(value) && Object.hasOwn(value, 'applyNetworkPolicyAmendment')) {
    return 'Apply network policy amendment';
  }
  return 'Provider decision';
}

function decisionKind(value: unknown): string {
  if (value === 'accept') return 'allow_once';
  if (value === 'acceptForSession') return 'allow_always';
  if (value === 'decline') return 'reject_once';
  if (value === 'cancel') return 'reject_always';
  return 'allow_always';
}

function requiredItemId(request: CodexServerRequest): string {
  const itemId = request.params['itemId'];
  if (typeof itemId !== 'string') {
    throw new CodexClientError('protocol', `${request.method}.itemId must be a string`);
  }
  return itemId;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalTurnState(state: NonNullable<Turn['state']>): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : fallback);
}

async function raceInteraction<T>(
  interaction: Promise<T>,
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
    void interaction.then((value) => finish(value), () => finish(undefined));
  });
}
