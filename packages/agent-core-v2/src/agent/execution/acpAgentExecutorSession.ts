import { randomUUID } from 'node:crypto';

import { createControlledPromise } from '@antfu/utils';
import {
  AcpProcessClient,
  AcpClientError,
  type AcpOpenSessionOptions,
  type AcpOpenSessionResult,
  type AcpPlanApprovalHandler,
  type AcpContextHookHandler,
  type AcpElicitationHandler,
  type AcpElicitationRequest,
  type AcpElicitationResponse,
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

import { acpMcpServers } from '#/app/agentExecutor/acpMcpServers';
import { antigravityProcessService } from '#/app/agentExecutor/antigravityProcess';
import type { HarnessMcpLease } from '#/app/agentExecutor/harnessMcp';
import { acquireHarnessMcp } from './harnessMcpLease';
import { harnessContextProcess } from './harnessContextProcess';
import { acpAttachments, externalAttachments } from './externalAttachments';
import { resolvePromptDelivery, type NegotiatedExecutorCapabilities } from '#/app/agentExecutor/capabilities';
import { recordNegotiatedSnapshot } from './negotiatedSnapshot';
import { executorLaunchArgs, executorProcessEnv } from '#/app/agentExecutor/executorOverrides';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { wrapWindowsNodeShims } from '#/app/agentExecutor/windowsNodeShim';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
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
import { ISessionQuestionService } from '#/session/question/question';
import { IAgentCollaborationMessagingService } from '#/session/agentCollaboration/messageMailbox';
import { acpFormFields, acpFormResponse } from './acpElicitation';
import { authorizeExternalTool, externalPermissionHostGate, externalPermissionMeta, externalPermissionMode, externalToolPermission } from './externalPermission';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
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
  type ExecutorProfileDelivery,
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
  steer?(prompt: Parameters<AcpProcessClientType['steer']>[0]): Promise<boolean>;
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
  #active: ActiveExternalTurn | undefined;
  #permissionContext:
    | { readonly turn: MutableExternalTurn; readonly recorder: ExternalTurnRecorder }
    | undefined;
  #settled: Promise<void> = Promise.resolve();
  #nextReservedTurnId: number | undefined;
  #shutdown = false;
  #harnessMcp: HarnessMcpLease | undefined;
  #permissionRestore: { readonly config?: AcpSessionConfigSelection; readonly modeId?: string } | undefined;

  constructor(
    private context: AgentExecutorContext,
    clientFactory: (
      processService: HostProcessServiceLike,
      permissionHandler: (
        request: AcpPermissionRequest,
        options: { readonly signal: AbortSignal; readonly options: readonly AcpPermissionOption[] },
      ) => Promise<{ readonly outcome: 'selected' | 'cancelled'; readonly optionId?: string }>,
      elicitationHandler: AcpElicitationHandler,
      planApprovalHandler: AcpPlanApprovalHandler,
      contextHookHandler: AcpContextHookHandler,
    ) => AcpClientLike = (processService, permissionHandler, elicitationHandler, planApprovalHandler, contextHookHandler) =>
      new AcpProcessClient(
        processService,
        {
          id: context.descriptor.id,
          command: requiredCommand(context),
          args: resolveAcpProcessArgs(context),
          env: executorProcessEnv(context.descriptor),
          startupTimeoutMs: context.descriptor.startupTimeoutMs,
          shutdownGraceMs: context.descriptor.shutdownGraceMs,
          clientName: 'kiki-agent-core-v2',
        },
        { permissionHandler,
          elicitationHandler: ['codex-acp', 'deepseek-acp'].includes(context.descriptor.id) ? elicitationHandler : undefined,
          planApprovalHandler: context.descriptor.id === 'grok-acp' ? planApprovalHandler : undefined,
          contextHookHandler: context.descriptor.id === 'grok-acp' ? contextHookHandler : undefined },
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
    const processes = wrapWindowsNodeShims(processService, this.#runtimeLease.runtime.fs,
      () => context.agent.accessor.get(IBootstrapService));
    this.#client = clientFactory(
      harnessContextProcess(context.descriptor.id === 'antigravity-acp' ? antigravityProcessService(processes, context.descriptor,
        context.agent.accessor.get(IBootstrapService)) : processes, () => this.#harnessMcp),
      (request, options) => this.#requestPermission(request, options),
      (request, options) => this.#requestElicitation(request, options.signal),
      (request, options) => this.#requestPlanApproval(request, options.signal),
      async (event, options) => {
        options.signal.throwIfAborted();
        return { additionalContext: await this.#harnessMcp?.contextHook?.(event) ?? '' };
      },
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
    const sessionOptions = await this.#sessionOptions(options.signal);
    const opened = await this.#client.openSession({ ...sessionOptions, onFork: async (sessionRef) => {
      const prior = this.#states.get(externalExecutorKey);
      await this.#dispatcher.dispatch(new ExecutorSessionUpdated({
        executorId: this.context.descriptor.id, descriptorRevision: this.context.descriptor.revision,
        bindingFingerprint: agentExecutorBindingFingerprint(this.context.binding), sessionRef,
        sessionEpoch: (prior.sessionEpoch ?? 0) + 1,
        profileDelivery: prior.profileDelivery,
      }));
      await this.#dispatcher.flush();
    } }).catch((error: unknown) => {
      if (error instanceof AcpClientError && typeof error.details?.['resumeSupported'] === 'boolean' &&
          typeof error.details['loadSupported'] === 'boolean') {
        this.context.agent.accessor.get(IAgentExecutorRegistry).recordNegotiated?.(
          this.context.descriptor.id, this.context.descriptor.version, {
            resume: error.details['resumeSupported'], load: error.details['loadSupported'],
          },
        );
      }
      throw error;
    });
    const losses = new Set<ExecutorLossCode>(['acp_no_step_boundaries']);
    if (
      (sessionOptions.additionalDirectories?.length ?? 0) > 0 &&
      (opened.capabilities.sessionCapabilities?.additionalDirectories === null
        || opened.capabilities.sessionCapabilities?.additionalDirectories === undefined)
    ) {
      losses.add('additional_directories_dropped');
    }
    const configured = await this.#configure(opened, options.signal, losses);
    const negotiated: NegotiatedExecutorCapabilities = {
      models: configured.configOptions.filter((option) => option.category === 'model').flatMap(selectValues),
      thinkingLevels: configured.configOptions.filter((option) => option.category === 'thought_level').flatMap(selectValues),
      authMethods: opened.initialize.authMethods?.map((method) => method.id),
      agentVersion: opened.initialize.agentInfo?.version,
      image: opened.capabilities.promptCapabilities?.image === true || this.context.descriptor.id === 'grok-acp',
      audio: opened.capabilities.promptCapabilities?.audio === true,
      fork: opened.capabilities.sessionCapabilities?.fork !== undefined && opened.capabilities.sessionCapabilities?.fork !== null,
      nativeSteering: (opened.initialize._meta?.['steering'] as { supported?: unknown } | undefined)?.supported === true,
      questionForm: ['codex-acp', 'deepseek-acp'].includes(this.context.descriptor.id),
      planApproval: this.context.descriptor.id === 'grok-acp',
      resume: opened.capabilities.sessionCapabilities?.resume !== undefined && opened.capabilities.sessionCapabilities?.resume !== null,
      load: opened.capabilities.loadSession === true,
      permissionModes: opened.availableModes,
    };
    await recordNegotiatedSnapshot(this.context, negotiated);
    this.context.agent.accessor.get(IAgentExecutorRegistry).recordNegotiated?.(
      this.context.descriptor.id, this.context.descriptor.version, negotiated,
    );
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
    const profileOverrideDelivered =
      deliverProfile &&
      opened.mode === 'new' &&
      sessionOptions.systemPromptOverride !== undefined;
    if (deliverProfile && !profileOverrideDelivered) losses.add('profile_as_user_preamble');
    if (resolvePromptDelivery(this.context.descriptor, this.context.binding).downgraded) {
      losses.add('prompt_delivery_downgraded');
    }
    const profileDelivery: ExecutorProfileDelivery = deliverProfile
      ? profileOverrideDelivered
        ? 'system_prompt_override'
        : 'first_prompt_preamble'
      : prior.profileDelivery ?? 'first_prompt_preamble';
    const remotePrompt = buildRemotePrompt({
      prompt,
      systemPrompt: deliverProfile && !profileOverrideDelivered
        ? this.context.binding.systemPrompt
        : undefined,
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
        model: this.context.binding.modelAlias ?? 'harness-default',
        modelAlias: this.context.binding.modelAlias,
        provider: resolveExternalModelProvider(
          this.context.agent,
          this.context.binding.modelAlias,
        ),
        resumeMode,
        profileDelivery,
        outboundPrompt: remotePrompt,
        initialLosses: [...losses],
      },
    );
    await recorder.begin(prompt, origin, externalAttachments(request), request.kind === 'prompt' ? request.promptId : undefined);

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
        attachments: acpAttachments(externalAttachments(request)),
        signal: controller.signal,
        session: sessionOptions,
      });
      await this.#dispatcher.dispatch(
        new ExecutorSessionUpdated({
          executorId: this.context.descriptor.id,
          descriptorRevision: this.context.descriptor.revision,
          bindingFingerprint,
          sessionRef: { ...configured.sessionRef, ref: { ...configured.sessionRef.ref, localSource: prior.sessionRef?.ref['localSource'] } },
          sessionEpoch,
          profileDeliveredSessionId: deliverProfile
            ? configured.sessionId
            : prior.profileDeliveredSessionId,
          profileDelivery: deliverProfile ? profileDelivery : prior.profileDelivery,
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
        sessionRef: { ...configured.sessionRef, ref: { ...configured.sessionRef.ref, localSource: prior.sessionRef?.ref['localSource'] } },
        sessionEpoch,
        profileDeliveredSessionId: deliverProfile
          ? configured.sessionId
          : prior.profileDeliveredSessionId,
        profileDelivery: deliverProfile ? profileDelivery : prior.profileDelivery,
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

  async steer(message: ContextMessage): Promise<boolean> {
    const active = this.#active;
    if (active === undefined || active.turn.signal.aborted || this.#client.steer === undefined) return false;
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    return this.#client.steer([
      { type: 'text', text },
      ...acpAttachments(message.content.filter((part) => part.type !== 'text')),
    ]);
  }

  updateBinding(binding: AgentExecutorContext['binding']): void {
    if (this.#active !== undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'ACP binding cannot change during a turn');
    this.context = { ...this.context, binding };
  }

  cancel(reason?: unknown): boolean {
    const active = this.#active;
    if (active === undefined) return false;
    const cancelled = active.turn.cancel(reason);
    void active.handle.cancel(reason);
    this.#interaction.cancelPendingForTurn(active.turn.id, this.context.agent.id);
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
    try {
      await Promise.all([this.settled(), this.#client.shutdown(reason)]);
    } finally {
      this.#harnessMcp?.dispose();
      this.#runtimeLease.dispose();
    }
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
      readonly profileDelivery: ExecutorProfileDelivery | undefined;
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
      if (completed.response._meta?.['usage'] !== undefined) await recorder.reportedUsage(completed.response._meta['usage']);
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
              profileDelivery: accounting.profileDelivery,
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
      this.#interaction.cancelPendingForTurn(turn.id, this.context.agent.id);
    }
  }

  async #sessionOptions(signal: AbortSignal): Promise<AcpOpenSessionOptions> {
    const mcp = this.context.agent.accessor.get(ISessionMcpHandle);
    await mcp.ready;
    signal.throwIfAborted();
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
    if (state.sessionRef?.ref['localSource'] !== undefined &&
        state.bindingFingerprint !== agentExecutorBindingFingerprint(this.context.binding)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Imported local session binding fingerprint changed');
    }
    const systemPrompt = this.context.binding.systemPrompt;
    const servers = this.context.descriptor.supportsMcp === false
      ? [] : acpMcpServers(mcp.connectionManager, roots.workDir,
        (name) => process.env[name], this.context.descriptor.mcpTransports);
    if (this.context.binding.allowKikiSubagents === true || this.context.binding.kikiContext?.length) {
      this.#harnessMcp ??= await acquireHarnessMcp(this.context, roots.workDir);
      if (this.#harnessMcp !== undefined) {
        if (servers.some((server) => server.name === this.#harnessMcp!.server.name)) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, 'The reserved Kiki harness MCP name is already configured');
        }
        servers.push(this.#harnessMcp.server);
      }
    }
    return {
      cwd: roots.workDir,
      additionalDirectories: roots.additionalDirs,
      mcpServers: servers,
      sessionMeta: { ...this.#harnessMcp?.sessionMeta,
        'kiki.permission': externalPermissionMeta(this.context, roots.workDir, roots.additionalDirs) },
      sessionRef:
        state.bindingFingerprint === agentExecutorBindingFingerprint(this.context.binding)
          ? state.sessionRef as ExecutorSessionRefEnvelope | undefined
          : undefined,
      requireResume: state.sessionRef?.ref['localSource'] !== undefined,
      systemPromptOverride:
        resolvePromptDelivery(this.context.descriptor, this.context.binding).actual === 'replace' &&
          this.context.descriptor.profileDelivery === 'system_prompt_override' && systemPrompt.length > 0
          ? systemPrompt : undefined,
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
    if (modelBinding === 'session_config' && this.context.binding.modelAlias !== undefined) {
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

    if (!externalPermissionHostGate(this.context)) {
      const restore = this.#permissionRestore;
      if (restore === undefined) return configured;
      const restored = await this.#client.configureSession({ configOptions: restore.config === undefined ? undefined : [restore.config],
        modeId: restore.modeId, signal });
      if (restore.config !== undefined) assertConfigured(restored.configOptions, restore.config, 'inherited permission mode');
      if (restore.modeId !== undefined && restored.currentModeId !== restore.modeId) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'External executor did not restore its inherited permission mode');
      }
      this.#permissionRestore = undefined;
      return restored;
    }
    const declared = this.context.descriptor.permission;
    const mapping = this.context.descriptor.permissionModeMapping ?? (declared?.via === 'config_option'
      ? { configId: declared.configId, configCategory: declared.configCategory,
          manual: declared.manual, auto: declared.auto, yolo: declared.yolo }
      : undefined);
    const mode = externalPermissionMode(this.context);
    if (mapping !== undefined) {
      const permission = permissionConfig(configured.configOptions, mapping, 'manual');
      this.#permissionRestore ??= { config: { configId: permission.option.id, value: permission.option.currentValue } };
      const verified = await this.#client.configureSession({ configOptions: [permission.selection], signal });
      assertConfigured(verified.configOptions, permission.selection, 'permission mode');
      return verified;
    }
    if (declared?.via === 'argv') {
      if (declared.flag === undefined) {
        throw new Error2(ErrorCodes.CONFIG_INVALID,
          `External executor "${this.context.descriptor.id}" requires a fresh process for ${mode} permission mode`);
      }
      return configured;
    }
    if (declared?.via === 'session_mode') {
      const selected = declared.manual;
      if (opened.availableModes !== undefined && !opened.availableModes.includes(selected)) {
        throw new Error2(ErrorCodes.CONFIG_INVALID,
          `External executor "${this.context.descriptor.id}" does not advertise ${selected} permission mode`);
      }
      if (this.#permissionRestore === undefined) {
        if (opened.currentModeId === undefined) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, 'External executor does not expose its inherited permission mode for restoration');
        }
        this.#permissionRestore = { modeId: opened.currentModeId };
      }
      configured = await this.#client.configureSession({ modeId: selected, signal });
      if (configured.currentModeId === selected) return configured;
    }
    losses.add('permission_mode_unverified');
    return configured;
  }

  #reserveTurnId(): number {
    const modelNextId = this.#states.get(turnKey).nextTurnId;
    const id = Math.max(modelNextId, this.#nextReservedTurnId ?? modelNextId);
    this.#nextReservedTurnId = id + 1;
    return id;
  }

  async #requestPlanApproval(request: Parameters<AcpPlanApprovalHandler>[0], signal: AbortSignal): ReturnType<AcpPlanApprovalHandler> {
    const active = this.#permissionContext;
    if (active === undefined || signal.aborted || request.sessionId !== this.#client.status().sessionId) return { outcome: 'keep_planning', feedback: '' };
    const approvalId = `grok-plan:${randomUUID()}`;
    const response = await raceApproval(this.context.agent.accessor.get(ISessionApprovalService).request({
      id: approvalId, agentId: this.context.agent.id, turnId: active.turn.id,
      toolCallId: request.toolCallId === undefined ? undefined : active.recorder.toolCallId(request.toolCallId),
      toolName: 'Exit plan mode', action: 'Review external plan', display: { kind: 'plan_review', plan: request.plan },
    }), signal);
    if (response === undefined || response.decision === 'cancelled') {
      return { outcome: 'keep_planning', feedback: '' };
    }
    const feedback = response.feedback?.trim().slice(0, 16_384) ?? '';
    if (response.decision === 'approved') return { outcome: 'approved', feedback };
    if (response.selectedLabel === 'Reject and Exit') return { outcome: 'abandoned', feedback };
    if (feedback.length > 0) await this.context.agent.accessor.get(IAgentCollaborationMessagingService).send({
      sourceAgentId: this.context.agent.id, sourceTaskName: 'user', senderKind: 'user',
      targetAgentId: this.context.agent.id, targetTaskName: this.context.agent.id, idleWake: 'parent',
      content: `Revise the plan according to this feedback:\n\n${feedback}`,
      idempotencyKey: `${approvalId}:feedback`,
    });
    return { outcome: 'keep_planning', feedback };
  }

  async #requestElicitation(request: AcpElicitationRequest, signal: AbortSignal): Promise<AcpElicitationResponse> {
    const active = this.#permissionContext;
    if (active === undefined || signal.aborted) return { action: 'cancel' };
    if (request.mode !== 'form' || ('sessionId' in request && request.sessionId !== this.#client.status().sessionId)) return { action: 'decline' };
    const fields = acpFormFields(request);
    if (fields === undefined) return { action: 'decline' };
    const toolCallId = 'toolCallId' in request && typeof request.toolCallId === 'string' ? active.recorder.toolCallId(request.toolCallId) : undefined;
    if (fields.length === 0 || request._meta?.['codex_approval_kind'] === 'mcp_tool_call') {
      const scopes = fields.length === 0 ? [] : fields.length === 1 && fields[0]?.key === 'persist'
        ? fields[0].choices.filter((choice) => ['once', 'session', 'always'].includes(choice.value)) : undefined;
      if (scopes === undefined || (fields.length > 0 && scopes.length === 0)) return { action: 'decline' };
      const choices = scopes.length === 0 ? [{ value: 'once', label: 'Allow once' }] : scopes;
      const response = await raceApproval(this.context.agent.accessor.get(ISessionApprovalService).request({
        agentId: this.context.agent.id, turnId: active.turn.id, toolCallId,
        toolName: 'External approval', action: request.message,
        display: { kind: 'external_permission', summary: request.message, detail: request,
          options: [...choices.map((choice) => ({ id: choice.value, label: choice.label, kind: choice.value === 'once' ? 'allow_once' : 'allow_always' })),
            { id: 'decline', label: 'Decline', kind: 'reject_once' }] },
      }), signal);
      if (response === undefined || response.decision === 'cancelled') {
        return { action: 'cancel' };
      }
      if (response.decision !== 'approved') return { action: 'decline' };
      const selected = response.selectedOptionId ?? 'once';
      return choices.some((choice) => choice.value === selected)
        ? scopes.length === 0 ? { action: 'accept' } : { action: 'accept', content: { persist: selected } }
        : { action: 'decline' };
    }
    const result = await this.context.agent.accessor.get(ISessionQuestionService).request({
      turnId: active.turn.id, toolCallId, questions: fields.map((field) => field.question),
    }, { signal, agentId: this.context.agent.id });
    return signal.aborted ? { action: 'cancel' } : acpFormResponse(request, fields, result);
  }

  async #requestPermission(
    request: AcpPermissionRequest,
    context: { readonly signal: AbortSignal; readonly options: readonly AcpPermissionOption[] },
  ): Promise<{ readonly outcome: 'selected' | 'cancelled'; readonly optionId?: string }> {
    const active = this.#permissionContext;
    if (active === undefined || context.signal.aborted) return { outcome: 'cancelled' };
    if (request.sessionId !== this.#client.status().sessionId) return { outcome: 'cancelled' };
    const toolCallId = active.recorder.toolCallId(request.toolCall.toolCallId);
    const rawInput = objectOf(request.toolCall.rawInput);
    const kinds: Readonly<Record<string, string>> = { read: 'Read', edit: 'Write', delete: 'Write',
      search: 'Grep', execute: 'Bash' };
    const tool = externalToolPermission(request._meta?.['kiki.tool']) ?? externalToolPermission({
      name: kinds[request.toolCall.kind ?? ''] ?? rawInput?.['name'] ?? request.toolCall.title ?? request.toolCall.kind ?? 'External tool',
      input: { ...rawInput, paths: rawInput?.['paths'] ?? (request.toolCall.locations?.length
        ? request.toolCall.locations.map((location) => location.path) : undefined) },
    })!;
    try {
      const result = await authorizeExternalTool(this.context, tool, active.turn.id, toolCallId, context.signal,
        { kind: 'external_permission', summary: request.toolCall.title ?? tool.name, detail: boundedPermissionDetail(request),
          options: context.options.filter((option) => option.optionId !== 'kiki.vendor_default')
            .map((option) => ({ id: option.optionId, label: option.name, kind: option.kind, changes: optionChanges(option) })) });
      if (result === 'inherit') {
        const vendorDefault = context.options.find((candidate) => candidate.optionId === 'kiki.vendor_default');
        if (vendorDefault !== undefined) return { outcome: 'selected', optionId: vendorDefault.optionId };
        const response = await raceApproval(this.context.agent.accessor.get(ISessionApprovalService).request({
          agentId: this.context.agent.id, turnId: active.turn.id, toolCallId,
          toolName: request.toolCall.title ?? request.toolCall.kind ?? 'External tool',
          action: request.toolCall.title ?? 'Run external tool',
          display: { kind: 'external_permission', summary: request.toolCall.title ?? 'External tool permission',
            detail: boundedPermissionDetail(request), options: context.options.map((option) => ({
              id: option.optionId, label: option.name, kind: option.kind, changes: optionChanges(option) })) },
        }), context.signal);
        const selected = context.options.find((option) => option.optionId === response?.selectedOptionId);
        return response === undefined || response.decision === 'cancelled' || selected === undefined ||
          (response.decision === 'approved') !== selected.kind.startsWith('allow_')
          ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: selected.optionId };
      }
      const option = context.options.find((candidate) => candidate.optionId !== 'kiki.vendor_default' &&
        candidate.kind === (result === 'allow' ? 'allow_once' : 'reject_once'));
      return result === 'cancelled' || option === undefined ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: option.optionId };
    } catch {
      return { outcome: 'cancelled' };
    }
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
  const declared = context.descriptor.permission;
  const permissionArgs = [...context.descriptor.launchArgs ?? [],
    ...declared?.via !== 'argv' || declared.flag === undefined || !externalPermissionHostGate(context) ? [] : [declared.flag, declared.manual]];
  if (context.descriptor.modelBinding !== 'argv') return executorLaunchArgs(context.descriptor, [...permissionArgs, ...context.descriptor.args]);
  const model = context.binding.modelAlias;
  if (model === undefined) return executorLaunchArgs(context.descriptor, [...permissionArgs, ...context.descriptor.args]);
  if (model.length === 0) {
    throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'External argv model cannot be empty');
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
  return executorLaunchArgs(context.descriptor, [...permissionArgs, ...modelArgs, ...context.descriptor.args]);
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
      (option) =>
        option.category !== null
        && option.category !== undefined
        && option.category === category,
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
      { details: { reason_code: `executor_${label.replaceAll(' ', '_')}_unavailable`,
        config_id: option.id, requested_value: value, available_values: values,
        hint: `Select an executor-advertised ${label} (${values.join(', ')}), or leave it unpinned to use the executor default.` } },
    );
  }
  return { option, selection: { configId: option.id, value } };
}

function uncategorizedSelectOptions(option: AcpSessionConfigOption): boolean {
  return option.category === null || option.category === undefined;
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
  const value = mapping[mode === 'review' ? 'manual' : mode];
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
  return value instanceof Error
    ? value
    : new Error(
      value === undefined
        ? fallback
        : typeof value === 'string'
          ? value
          : JSON.stringify(value) ?? Object.prototype.toString.call(value),
    );
}
