import { randomUUID } from 'node:crypto';
import { sliceUtf16 } from '#/_base/text/utf16';
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
import { CLAUDE_EXPLICIT_SETTINGS_SOURCES } from '#/app/agentExecutor/claudeCredentials';
import { antigravityProcessService } from '#/app/agentExecutor/antigravityProcess';
import type { HarnessMcpLease } from '#/app/agentExecutor/harnessMcp';
import { acquireHarnessMcp } from './harnessMcpLease';
import { harnessContextProcess } from './harnessContextProcess';
import { harnessAccountError, harnessAccountProcess, HarnessAccountStartupError } from './harnessAccountProcess';
import { acpAttachments, externalAttachments } from './externalAttachments';
import { resolvePromptDelivery, type NegotiatedExecutorCapabilities } from '#/app/agentExecutor/capabilities';
import { recordNegotiatedSnapshot } from './negotiatedSnapshot';
import { acpAuthObservation, recordExecutorAuth } from './executorAuth';
import { executorLaunchArgs, executorProcessOptions } from '#/app/agentExecutor/executorOverrides';
import { executorSourceId, IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { wrapWindowsNodeShims } from '#/app/agentExecutor/windowsNodeShim';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { kikiChildDefaults } from '#/app/bootstrap/childEnvironment';
import {
  agentExecutorBindingFingerprint,
  agentExecutorBindingMatches,
  agentExecutorSameFamilyBindingMatches,
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
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { Error2, ErrorCodes } from '#/errors';
import { createHooks } from '#/hooks';
import type { TokenUsage } from '#/kosong/contract/usage';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISessionQuestionService } from '#/session/question/question';
import { IAgentCollaborationMessagingService } from '#/session/agentCollaboration/messageMailbox';
import { acpFormFields, acpFormResponse } from './acpElicitation';
import { assertExternalPermissionSupport, externalPermissionMeta, externalPermissionMode } from './externalPermission';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';
import type { RuntimeWorkspaceRoots } from '#/runtime/runtime';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  ExecutorSessionUpdated,
  externalExecutorKey,
  externalStateForGeneration,
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
  steer?(prompt: Parameters<AcpProcessClientType['steer']>[0]): Promise<boolean | 'unknown'>;
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
const STEER_TOOL_BOUNDARY_MS = 60_000;

export class AcpAgentExecutorSession implements AgentExecutorSession {
  readonly hooks = createHooks<{ onWillRun: { signal: AbortSignal } }, 'onWillRun'>([
    'onWillRun',
  ]);

  readonly #runtimeLease;
  readonly #client: AcpClientLike;
  readonly #states: IAgentStateService;
  readonly #dispatcher: IEventDispatcher;
  readonly #workspace: RuntimeWorkspaceRoots;
  readonly #memory: IAgentContextMemoryService;
  readonly #interaction: ISessionInteractionService;
  #active: ActiveExternalTurn | undefined;
  #permissionContext:
    | { readonly turn: MutableExternalTurn; readonly recorder: ExternalTurnRecorder }
    | undefined;
  #settled: Promise<void> = Promise.resolve();
  #nextReservedTurnId: number | undefined;
  #shutdown = false;
  #promptAttempted = false;
  #harnessMcp: HarnessMcpLease | undefined;
  #permissionRestore: { readonly sessionId: string; readonly config?: AcpSessionConfigSelection; readonly modeId?: string } | undefined;

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
          sourceId: executorSourceId(context.descriptor),
          command: requiredCommand(context),
          args: resolveAcpProcessArgs(context),
          ...executorProcessOptions(context.descriptor, processService.redactDiagnostic),
          startupTimeoutMs: context.descriptor.startupTimeoutMs,
          shutdownGraceMs: context.descriptor.shutdownGraceMs,
          stdinCloseGraceMs: context.descriptor.stdinCloseGraceMs,
          clientName: 'kiki-agent-core-v2',
        },
        { permissionHandler,
          elicitationHandler: ['codex-acp', 'deepseek-acp'].includes(executorSourceId(context.descriptor)) ? elicitationHandler : undefined,
          planApprovalHandler: executorSourceId(context.descriptor) === 'grok-acp' ? planApprovalHandler : undefined,
          contextHookHandler: executorSourceId(context.descriptor) === 'grok-acp' ? contextHookHandler : undefined },
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
    this.#workspace = inspectAgentWorkspaceRoots(
      runtime,
      context.agent.accessor.get(ISessionWorkspaceContext),
    );
    this.#memory = context.agent.accessor.get(IAgentContextMemoryService);
    this.#interaction = context.agent.accessor.get(ISessionInteractionService);
    const processes = wrapWindowsNodeShims(processService, this.#runtimeLease.runtime.fs,
      () => context.agent.accessor.get(IBootstrapService));
    const contextProcess = harnessContextProcess(['antigravity-acp', 'agy-cli'].includes(executorSourceId(context.descriptor)) ? antigravityProcessService(processes, context.descriptor,
      context.agent.accessor.get(IBootstrapService)) : processes, () => this.#harnessMcp);
    this.#client = clientFactory(
      harnessAccountProcess(contextProcess, context, this.#runtimeLease.runtime.identity.runtimeId).processes,
      (request, options) => this.#requestPermission(request, options),
      (request, options) => this.#requestElicitation(request, options.signal),
      (request, options) => this.#requestPlanApproval(request, options.signal),
      async (event, options) => {
        options.signal.throwIfAborted();
        return { additionalContext: await this.#harnessMcp?.contextHook?.(event) ?? '' };
      },
    );
  }

  async run(request: AgentRunRequest, options: RunAgentOptions): Promise<AgentRunHandle> {
    const attempt = { possibleDelivery: false };
    try { return await this.#runOnce(request, options, attempt); }
    catch (error) {
      if (!attempt.possibleDelivery) await options.onExternalRunNotSent?.();
      throw error;
    }
  }

  async #runOnce(
    request: AgentRunRequest,
    options: RunAgentOptions,
    attempt: { possibleDelivery: boolean },
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
    assertExternalPermissionSupport(this.context);
    const sessionOptions = await this.#sessionOptions(options.signal);
    const opened = await this.#client.openSession({ ...sessionOptions, onFork: async (sessionRef) => {
      const prior = externalStateForGeneration(this.#states.get(externalExecutorKey), this.context.binding.execution?.generation);
      await this.#dispatcher.dispatch(new ExecutorSessionUpdated({
        executionGeneration: this.context.binding.execution?.generation,
        executorId: this.context.descriptor.id, descriptorRevision: this.context.descriptor.revision,
        bindingFingerprint: agentExecutorBindingFingerprint(this.context.binding), sessionRef,
        sessionEpoch: (prior.sessionEpoch ?? 0) + 1,
        profileDelivery: prior.profileDelivery,
      }));
      await this.#dispatcher.flush();
    } }).catch(async (error: unknown) => {
      if (error instanceof AcpClientError && error.cause instanceof HarnessAccountStartupError) throw error.cause;
      const auth = acpAuthObservation(error);
      if (auth !== undefined) await recordExecutorAuth(this.context, sessionOptions.cwd, auth);
      if (error instanceof AcpClientError && typeof error.details?.['resumeSupported'] === 'boolean' &&
          typeof error.details['loadSupported'] === 'boolean') {
        this.context.agent.accessor.get(IAgentExecutorRegistry).recordNegotiated?.(
          this.context.descriptor.id, this.context.descriptor.version, {
            resume: error.details['resumeSupported'], load: error.details['loadSupported'],
          }, this.context.descriptor.registryRevision,
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
    const prior = externalStateForGeneration(this.#states.get(externalExecutorKey), this.context.binding.execution?.generation);
    const bindingFingerprint = agentExecutorBindingFingerprint(this.context.binding);
    const reusablePrior = this.#reusablePriorState(prior) || sessionOptions.sessionMeta?.['kiki.agyLegacyRecovery'] !== undefined;
    const priorSessionId = reusablePrior ? sessionIdFromState(prior.sessionRef) : undefined;
    const sessionEpoch = priorSessionId === opened.sessionId
      ? prior.sessionEpoch ?? 1
      : (prior.sessionEpoch ?? 0) + 1;
    if (this.#permissionRestore?.sessionId !== opened.sessionId) this.#permissionRestore = undefined;
    if (opened.mode !== 'new' && priorSessionId === opened.sessionId) this.#permissionRestore ??= permissionRestoreFromRef(prior.sessionRef);
    await this.#dispatcher.dispatch(new ExecutorSessionUpdated({
      executionGeneration: this.context.binding.execution?.generation,
      executorId: this.context.descriptor.id,
      descriptorRevision: this.context.descriptor.revision,
      bindingFingerprint,
      sessionRef: this.#permissionSessionRef(opened.sessionRef, prior.sessionRef?.ref['localSource']),
      sessionEpoch,
      profileDeliveredSessionId: priorSessionId === opened.sessionId ? prior.profileDeliveredSessionId : undefined,
      profileDelivery: priorSessionId === opened.sessionId ? prior.profileDelivery : undefined,
    }));
    await this.#dispatcher.flush();
    let configured = await this.#configure(opened, options.signal, losses).catch(async (error: unknown) => {
      const auth = acpAuthObservation(error);
      if (auth !== undefined) await recordExecutorAuth(this.context, sessionOptions.cwd, auth);
      throw error;
    });
    const negotiated: NegotiatedExecutorCapabilities = {
      models: advertisedSelectValues(configured.configOptions, 'model'),
      thinkingLevels: advertisedSelectValues(configured.configOptions, 'thought_level'),
      nativeAgents: advertisedSelectValues(configured.configOptions, 'native_agent') ?? [],
      authMethods: opened.initialize.authMethods?.map((method) => method.id),
      agentVersion: opened.initialize.agentInfo?.version,
      image: opened.capabilities.promptCapabilities?.image === true || executorSourceId(this.context.descriptor) === 'grok-acp',
      audio: opened.capabilities.promptCapabilities?.audio === true,
      fork: opened.capabilities.sessionCapabilities?.fork !== undefined && opened.capabilities.sessionCapabilities?.fork !== null,
      nativeSteering: (opened.initialize._meta?.['steering'] as { supported?: unknown } | undefined)?.supported === true,
      questionForm: ['codex-acp', 'deepseek-acp'].includes(executorSourceId(this.context.descriptor)),
      planApproval: executorSourceId(this.context.descriptor) === 'grok-acp',
      resume: opened.capabilities.sessionCapabilities?.resume !== undefined && opened.capabilities.sessionCapabilities?.resume !== null,
      load: opened.capabilities.loadSession === true,
      permissionModes: opened.availableModes,
    };
    await recordNegotiatedSnapshot(this.context, negotiated);
    this.context.agent.accessor.get(IAgentExecutorRegistry).recordNegotiated?.(
      this.context.descriptor.id, this.context.descriptor.version, negotiated, this.context.descriptor.registryRevision,
    );
    const handoff = this.context.binding.execution === undefined && opened.mode === 'new' && prior.sessionRef !== undefined
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
      ? opened.mode
      : 'handoff';
    const recorder = new ExternalTurnRecorder(
      this.context.agent,
      turnId,
      `${configured.sessionId}:e${sessionEpoch}`,
      {
        parentReceiptManaged: options.parentReceiptManaged,
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
    await recorder.begin(prompt, origin, externalAttachments(request), request.kind === 'prompt' ? request.promptId : undefined,
      request.kind === 'prompt' ? request.contextMessages : undefined);
    if (executorSourceId(this.context.descriptor) === 'claude-acp' || this.context.descriptor.claudeSettingsFile !== undefined) {
      const actualModel = configured.configOptions.find((option) =>
        option.category === 'model' && typeof option.currentValue === 'string')?.currentValue;
      const agentVersion = opened.initialize.agentInfo?.version;
      if (actualModel !== undefined || agentVersion !== undefined) {
        await recorder.record({
          type: 'session.info',
          meta: {
            source: 'claude-acp',
            actualModel,
            agentVersion,
          },
        });
      }
    }

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
      this.#promptAttempted = true;
      handle = await this.#client.startTurn({
        prompt: remotePrompt,
        attachments: acpAttachments(externalAttachments(request)),
        signal: controller.signal,
        session: { ...sessionOptions, sessionRef: configured.sessionRef, requireResume: true },
        onDeliveryAttempt: () => { attempt.possibleDelivery = true; },
        prepareSession: async actual => {
          if (actual.sessionId !== configured.sessionId) throw new Error2(ErrorCodes.CONFIG_INVALID, 'ACP session identity changed before prompt');
          const restored = actual.mode === 'live' ? actual :
            await this.#configure(actual, controller.signal, losses);
          const permissionId = this.context.descriptor.permissionModeMapping?.configId ??
            (this.context.descriptor.permission?.via === 'config_option' ? this.context.descriptor.permission.configId : undefined);
          const controlIds = [this.context.descriptor.modelConfigId, this.context.descriptor.thoughtConfigId, permissionId];
          for (const option of configured.configOptions) {
            if (!['model', 'thought_level', 'native_agent', 'mode'].includes(option.category ?? '') && !controlIds.includes(option.id)) continue;
            assertConfigured(restored.configOptions, { configId: option.id, value: option.currentValue }, 'resumed session control');
          }
          if (configured.currentModeId !== undefined && restored.currentModeId !== configured.currentModeId) {
            throw new Error2(ErrorCodes.CONFIG_INVALID, 'External executor did not restore its configured session mode');
          }
          configured = restored;
        },
      });
      attempt.possibleDelivery = true;
      await this.#dispatcher.dispatch(
        new ExecutorSessionUpdated({
          executionGeneration: this.context.binding.execution?.generation,
          executorId: this.context.descriptor.id,
          descriptorRevision: this.context.descriptor.revision,
          bindingFingerprint,
          sessionRef: this.#permissionSessionRef(configured.sessionRef, prior.sessionRef?.ref['localSource']),
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
      const auth = acpAuthObservation(error);
      if (auth !== undefined) await recordExecutorAuth(this.context, sessionOptions.cwd, auth);
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
        sessionRef: this.#permissionSessionRef(configured.sessionRef, prior.sessionRef?.ref['localSource']),
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

  canResumeBrokenOriginal(): boolean {
    if (this.#shutdown || this.#active !== undefined) return false;
    if (this.#client.status().state !== 'broken') return false;
    const state = externalStateForGeneration(this.#states.get(externalExecutorKey), this.context.binding.execution?.generation);
    if (!this.#stateMatchesDescriptorOrFamily(state)) return false;
    if (state.sessionRef?.ref['localSource'] !== undefined &&
        !agentExecutorBindingMatches(this.context.binding, state.bindingFingerprint)) return false;
    const legacy = this.#legacyAgyRecovery(state);
    const resume = originalRemoteResumeFields(this.context.binding, this.context.descriptor, state, false, this.#reusablePriorState(state) || legacy !== undefined);
    if (resume.sessionRef === undefined) return false;
    const negotiated = this.context.agent.accessor.get(IAgentExecutorRegistry).negotiated?.(
      this.context.descriptor.id,
      this.context.descriptor.version,
    );
    return negotiated?.resume !== false || negotiated?.load !== false || legacy !== undefined;
  }

  #legacyAgyBindingMatches(state: ReturnType<typeof externalStateForGeneration>): boolean {
    if (this.#reusablePriorState(state)) return true;
    const { binding } = this.context;
    return binding.execution === undefined &&
      binding.renderGeneration === 2 &&
      state.descriptorRevision === this.context.descriptor.revision &&
      agentExecutorBindingMatches({ ...binding, renderGeneration: 1 }, state.bindingFingerprint);
  }

  #legacyAgyRecovery(
    state: ReturnType<typeof externalStateForGeneration>,
    roots = this.#runtimeLease.runtime.workspace.mapRoots({
      workDir: this.#workspace.workDir,
      additionalDirs: this.#workspace.additionalDirs,
    }),
  ) {
    const { descriptor, binding } = this.context;
    const sessionId = sessionIdFromState(state.sessionRef);
    const turn = this.#states.get(turnKey).lastEnded;
    const disclosedCwd = binding.environmentDisclosure?.cwd;
    const hasAdditionalDirs = (roots.additionalDirs?.length ?? 0) > 0;
    const terminalError = legacyAgyTerminalError(turn?.error?.message);
    if (executorSourceId(descriptor) !== 'agy-cli' || state.executorId !== descriptor.id ||
        launchHome(descriptor) !== '' || !sameLaunchHome(state.sessionRef, descriptor) ||
        state.sessionRef?.ref['localSource'] !== undefined || state.sessionEpoch !== 1 ||
        sessionId === undefined || !AGY_UUID.test(sessionId) || state.profileDeliveredSessionId !== sessionId ||
        binding.modelAlias === undefined || !this.#legacyAgyBindingMatches(state) ||
        (hasAdditionalDirs && disclosedCwd === undefined) ||
        (disclosedCwd !== undefined && !sameWorkspacePath(disclosedCwd, roots.workDir)) ||
        turn?.turnId !== 0 || turn.reason !== 'failed' || turn.error?.code !== 'executor.protocol_error' ||
        terminalError.length === 0 || AGY_UNRECOVERABLE_TERMINAL_ERROR.test(terminalError)) return undefined;
    return legacyAgyRecoveryProof(
      this.#memory.get(),
      sessionId,
      binding.modelAlias,
      binding.thinkingEffortExplicit === true ? binding.thinkingLevel : 'engine-default',
      terminalError,
      disclosedCwd,
      roots.additionalDirs,
    );
  }

  canRetryBrokenConstruction(): boolean {
    const state = externalStateForGeneration(this.#states.get(externalExecutorKey), this.context.binding.execution?.generation);
    return !this.#promptAttempted && state.sessionRef === undefined;
  }

  async steer(message: ContextMessage): Promise<boolean | 'unknown'> {
    const active = this.#active;
    if (active === undefined || active.turn.signal.aborted || this.#client.steer === undefined) return false;
    const boundary = AbortSignal.any([active.turn.signal, AbortSignal.timeout(STEER_TOOL_BOUNDARY_MS)]);
    if (!await active.recorder.toolsSettled(boundary) || this.#active !== active) return false;
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    const discardEcho = active.recorder.expectUserEcho(text);
    let outcome: boolean | 'unknown' = false;
    try {
      outcome = await this.#client.steer([
        { type: 'text', text },
        ...acpAttachments(message.content.filter((part) => part.type !== 'text')),
      ]);
      return outcome;
    } finally {
      if (outcome !== true) discardEcho();
    }
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
      try {
        for await (const event of handle.events) {
          await recorder.record(event as ExternalExecutorEvent);
        }
      } catch (error) {
        await handle.cancel(error);
        throw error;
      }
    })();
    try {
      const [completed] = await Promise.all([handle.completion, pump]);
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
              executionGeneration: this.context.binding.execution?.generation,
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
      const error = harnessAccountError(this.context.descriptor, turnResult.error);
      await recorder.fail(error);
      result.resolve({ ...turnResult, error });
      throw toError(error, 'External ACP turn failed');
    } catch (error) {
      await pump.catch(() => undefined);
      const auth = acpAuthObservation(error);
      if (auth !== undefined) await recordExecutorAuth(this.context, this.#runtimeLease.runtime.workspace.mapRoots(this.#workspace).workDir, auth);
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
    const mcp = this.context.binding.execution === undefined ? this.context.agent.accessor.get(ISessionMcpHandle) : undefined;
    await mcp?.ready;
    signal.throwIfAborted();
    const runtime = this.#runtimeLease.runtime;
    const roots = runtime.workspace.mapRoots({
      workDir: this.#workspace.workDir,
      additionalDirs: this.#workspace.additionalDirs,
    });
    const state = externalStateForGeneration(this.#states.get(externalExecutorKey), this.context.binding.execution?.generation);
    if (!this.#stateMatchesDescriptorOrFamily(state)) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Executor session state does not match descriptor "${this.context.descriptor.id}"`,
      );
    }
    if (state.sessionRef?.ref['localSource'] !== undefined &&
        !agentExecutorBindingMatches(this.context.binding, state.bindingFingerprint)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Imported local session binding fingerprint changed');
    }
    const systemPrompt = this.context.binding.systemPrompt;
    this.#harnessMcp ??= await acquireHarnessMcp(this.context, roots.workDir);
    const servers = this.#harnessMcp !== undefined ? [this.#harnessMcp.server]
      : this.context.descriptor.supportsMcp === false || mcp === undefined ? []
        : acpMcpServers(mcp.connectionManager, roots.workDir,
          (name) => process.env[name], this.context.descriptor.mcpTransports,
          kikiChildDefaults(this.context.agent.accessor.get(IBootstrapService).homeDir));
    const legacy = servers.length === 0 ? this.#legacyAgyRecovery(state, roots) : undefined;
    const sessionMeta = { ...this.#harnessMcp?.sessionMeta, 'kiki.permission': externalPermissionMeta(this.context), 'kiki.agyLegacyRecovery': legacy };
    const settings = this.context.descriptor.claudeSettingsFile;
    return {
      cwd: roots.workDir,
      additionalDirectories: roots.additionalDirs,
      mcpServers: servers,
      sessionMeta: settings === undefined ? sessionMeta : {
        ...sessionMeta,
        claudeCode: { options: { settings, settingSources: [...CLAUDE_EXPLICIT_SETTINGS_SOURCES] } },
      },
      ...originalRemoteResumeFields(
        this.context.binding,
        this.context.descriptor,
        state,
        this.#client.status().state === 'broken',
        this.#reusablePriorState(state) || legacy !== undefined,
      ),
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
    const nativeAgent = this.context.binding.execution?.effective.native_agent;
    if (nativeAgent !== undefined && nativeAgent !== 'engine-default') {
      const choices = configured.configOptions.filter((option) => option.category === 'native_agent');
      if (choices.length !== 1) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'External ACP native agent selection is unsupported or ambiguous');
      }
      const agent = selectConfig(choices, choices[0]!.id, 'native_agent', nativeAgent, 'native agent');
      configured = await this.#client.configureSession({ configOptions: [agent.selection], signal });
      assertConfigured(configured.configOptions, agent.selection, 'native agent');
    }
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

    const thinking = this.context.binding.execution === undefined
      ? this.context.binding.thinkingEffortExplicit === true && this.context.binding.thinkingLevel !== 'off'
        ? this.context.binding.thinkingLevel : undefined
      : this.context.binding.execution.effective.thinking;
    if (thinking !== undefined) {
      const thought = selectConfigIfAvailable(
        configured.configOptions,
        this.context.descriptor.thoughtConfigId,
        this.context.descriptor.thoughtConfigCategory ?? 'thought_level',
        thinking,
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

    const prior = externalStateForGeneration(this.#states.get(externalExecutorKey), this.context.binding.execution?.generation);
    if (this.#permissionRestore?.sessionId !== configured.sessionId) this.#permissionRestore = undefined;
    if (this.#permissionRestore === undefined && opened.mode !== 'new' && sessionIdFromState(prior.sessionRef) === configured.sessionId) {
      this.#permissionRestore = permissionRestoreFromRef(prior.sessionRef);
    }
    if (externalPermissionMode(this.context) === undefined) {
      const restore = this.#permissionRestore;
      if (restore === undefined) return configured;
      const restored = await this.#client.configureSession({ configOptions: restore.config === undefined ? undefined : [restore.config],
        modeId: restore.modeId, signal });
      if (restore.config !== undefined) assertConfigured(restored.configOptions, restore.config, 'inherited permission mode');
      if (restore.modeId !== undefined && restored.currentModeId !== restore.modeId) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'External executor did not restore its inherited permission mode');
      }
      this.#permissionRestore = undefined;
      await this.#persistPermissionRestore(restored);
      return restored;
    }
    const declared = this.context.descriptor.permission;
    const mapping = this.context.descriptor.permissionModeMapping ?? (declared?.via === 'config_option'
      ? { configId: declared.configId, configCategory: declared.configCategory,
          manual: declared.manual, auto: declared.auto, yolo: declared.yolo }
      : undefined);
    const mode = externalPermissionMode(this.context);
    if (mode === 'review') throw new Error2(ErrorCodes.CONFIG_INVALID, 'Kiki reviewer permission mode requires the native Kiki executor');
    const vendorMode = mode ?? 'manual';
    if (mapping !== undefined) {
      const permission = permissionConfig(configured.configOptions, mapping, vendorMode);
      this.#permissionRestore ??= { sessionId: configured.sessionId, config: { configId: permission.option.id, value: permission.option.currentValue } };
      await this.#persistPermissionRestore(configured);
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
      const selected = declared[vendorMode] ?? declared.manual;
      if (opened.availableModes !== undefined && !opened.availableModes.includes(selected)) {
        throw new Error2(ErrorCodes.CONFIG_INVALID,
          `External executor "${this.context.descriptor.id}" does not advertise ${selected} permission mode`);
      }
      if (this.#permissionRestore === undefined) {
        if (opened.currentModeId === undefined) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, 'External executor does not expose its inherited permission mode for restoration');
        }
        this.#permissionRestore = { sessionId: configured.sessionId, modeId: opened.currentModeId };
      }
      await this.#persistPermissionRestore(configured);
      configured = await this.#client.configureSession({ modeId: selected, signal });
      if (configured.currentModeId === selected) return configured;
    }
    if (mode !== undefined) throw new Error2(ErrorCodes.CONFIG_INVALID,
      `External executor "${this.context.descriptor.id}" cannot verify ${mode} permission mode with its declared session controls`);
    losses.add('permission_mode_unverified');
    return configured;
  }

  async #persistPermissionRestore(opened: AcpOpenSessionResult): Promise<void> {
    const prior = externalStateForGeneration(this.#states.get(externalExecutorKey), this.context.binding.execution?.generation);
    const sameSession = sessionIdFromState(prior.sessionRef) === opened.sessionId;
    await this.#dispatcher.dispatch(new ExecutorSessionUpdated({
      executionGeneration: this.context.binding.execution?.generation,
      executorId: this.context.descriptor.id, descriptorRevision: this.context.descriptor.revision,
      bindingFingerprint: agentExecutorBindingFingerprint(this.context.binding),
      sessionRef: this.#permissionSessionRef(opened.sessionRef, prior.sessionRef?.ref['localSource']),
      sessionEpoch: sameSession ? prior.sessionEpoch ?? 1 : (prior.sessionEpoch ?? 0) + 1,
      profileDeliveredSessionId: sameSession ? prior.profileDeliveredSessionId : undefined,
      profileDelivery: sameSession ? prior.profileDelivery : undefined,
    }));
    await this.#dispatcher.flush();
  }

  #stateMatchesDescriptorOrFamily(state: ReturnType<typeof externalStateForGeneration>): boolean {
    if (state.executorId === undefined) return true;
    if (state.executorId === this.context.descriptor.id && state.descriptorRevision === this.context.descriptor.revision) return true;
    if (executorSourceId(this.context.descriptor) !== 'agy-cli') return false;
    const registry = this.context.agent.accessor.get(IAgentExecutorRegistry);
    const priorDescriptor = registry.get?.(state.executorId);
    if (priorDescriptor === undefined || priorDescriptor.protocol !== this.context.descriptor.protocol) return false;
    return executorSourceId(priorDescriptor) === 'agy-cli' && launchHome(priorDescriptor) === launchHome(this.context.descriptor);
  }

  #reusablePriorState(state: ReturnType<typeof externalStateForGeneration>): boolean {
    if (agentExecutorBindingMatches(this.context.binding, state.bindingFingerprint)) return true;
    if (!this.#stateMatchesDescriptorOrFamily(state) || state.executorId === undefined) return false;
    return agentExecutorSameFamilyBindingMatches(this.context.binding, state.bindingFingerprint, {
      executorId: state.executorId,
      descriptorRevision: state.descriptorRevision,
    });
  }

  #permissionSessionRef(sessionRef: ExecutorSessionRefEnvelope, localSource: unknown): ExecutorSessionRefEnvelope {
    const snapshot = sessionRefWithLocalSource(sessionRef, localSource);
    const home = launchHome(this.context.descriptor);
    const ref: Record<string, unknown> = { ...snapshot.ref };
    if (home.length > 0) ref['kikiLaunchHome'] = home;
    else delete ref['kikiLaunchHome'];
    if (this.#permissionRestore === undefined) delete ref['kikiPermissionRestore'];
    else ref['kikiPermissionRestore'] = this.#permissionRestore;
    return { ...snapshot, executorId: this.context.descriptor.id, ref };
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
    const feedback = sliceUtf16(response.feedback?.trim() ?? '', 0, 16_384);
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
    const vendorDefault = context.options.find((option) => option.optionId === 'kiki.vendor_default');
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
  const mode = externalPermissionMode(context);
  if (mode === 'review') throw new Error2(ErrorCodes.CONFIG_INVALID, 'Kiki reviewer permission mode requires the native Kiki executor');
  const permissionArgs = [...context.descriptor.launchArgs ?? [],
    ...declared?.via !== 'argv' || declared.flag === undefined || mode === undefined ? []
      : [declared.flag, declared[mode]]];
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

function advertisedSelectValues(options: readonly AcpSessionConfigOption[], category: string): readonly string[] | undefined {
  const matched = options.filter((option) => option.category === category);
  if (matched.length === 0) return undefined;
  return matched.flatMap(selectValues);
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
  mode: Exclude<IAgentPermissionModeService['mode'], 'review'>,
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
  if (input.systemPrompt !== undefined && input.systemPrompt.length > 0) {
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
    if (encoder.encode(sliceUtf16(value, 0, mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return sliceUtf16(value, 0, low);
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

function launchHome(descriptor: AgentExecutorContext['descriptor']): string {
  return descriptor.homeDir ?? '';
}

function sameLaunchHome(ref: ExecutorSessionRefEnvelope | undefined, descriptor: AgentExecutorContext['descriptor']): boolean {
  const saved = ref?.ref['kikiLaunchHome'];
  if (typeof saved === 'string') return saved === launchHome(descriptor);
  return launchHome(descriptor).length === 0;
}

function originalRemoteResumeFields(
  binding: AgentExecutorContext['binding'],
  descriptor: AgentExecutorContext['descriptor'],
  state: ReturnType<typeof externalStateForGeneration>,
  broken = false,
  reusable = agentExecutorBindingMatches(binding, state.bindingFingerprint),
): { readonly sessionRef: ExecutorSessionRefEnvelope | undefined; readonly requireResume: boolean } {
  const homeMatches = sameLaunchHome(state.sessionRef, descriptor);
  const changedInstance = state.executorId !== undefined && (state.executorId !== descriptor.id || state.descriptorRevision !== descriptor.revision);
  return {
    sessionRef:
      homeMatches && reusable && state.sessionRef !== undefined
        ? { ...sessionRefWithLocalSource(state.sessionRef, state.sessionRef.ref['localSource']), executorId: descriptor.id }
        : undefined,
    requireResume: homeMatches && (state.sessionRef?.ref['localSource'] !== undefined ||
      ((broken || changedInstance || binding.execution !== undefined || descriptor.permission?.via === 'argv' || executorSourceId(descriptor) === 'agy-cli') && state.sessionRef !== undefined)),
  };
}

const AGY_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const AGY_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/i;
const AGY_TERMINAL_ERROR_PREFIX = 'AGY terminal status ERROR: ';
const AGY_EARLY_EXIT_DIAGNOSTIC = /^AGY exited before terminal result \(code: \d+, signal: none\): (?:error:\s*)?(.+)$/i;
const AGY_UNRECOVERABLE_TERMINAL_ERROR = /^(?:interrupted|canceled|cancelled)$/i;
const AGY_SYNTHETIC_TOOL_ERROR = /^(?:External tool did not report a terminal result before the turn ended\.|AGY turn (?:canceled|cancelled|interrupted)|AGY permission denied|tool call denied by pre-tool hook:|AGY terminal result arrived before a tool terminal update:|AGY terminal status )/i;

function legacyAgyTerminalError(message: string | undefined): string {
  if (message === undefined) return '';
  if (message.startsWith(AGY_TERMINAL_ERROR_PREFIX)) return message.slice(AGY_TERMINAL_ERROR_PREFIX.length).trim();
  return AGY_EARLY_EXIT_DIAGNOSTIC.exec(message)?.[1]?.trim() ?? '';
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const cleaned = value.replaceAll('\\', '/').replace(/\/+$/u, '');
    return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
  };
  return normalize(left) === normalize(right);
}

function legacyAgyRecoveryProof(
  messages: readonly ContextMessage[],
  sessionId: string,
  model: string,
  effort: string | undefined,
  terminalError: string,
  disclosedCwd?: string,
  additionalDirectories?: readonly string[],
) {
  const prefix = `external:${encodeURIComponent(`${sessionId}:e1`)}:`;
  const calls = new Map<string, string>();
  const completed = new Map<string, { readonly failed: boolean; readonly errorText?: string }>();
  for (const message of messages) {
    for (const call of message.toolCalls) {
      if (!call.id.startsWith(prefix)) continue;
      if (calls.has(call.id)) return undefined;
      calls.set(call.id, call.name);
    }
    const id = message.toolCallId;
    if (message.role !== 'tool' || !id?.startsWith(prefix)) continue;
    if (completed.has(id)) return undefined;
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
    if (message.isError === true && (text.length === 0 || AGY_SYNTHETIC_TOOL_ERROR.test(text) || /execution state is unknown/i.test(text))) {
      return undefined;
    }
    completed.set(id, { failed: message.isError === true, errorText: message.isError === true ? text : undefined });
  }
  if (calls.size === 0 || calls.size > 1000 || calls.size !== completed.size) return undefined;
  let conversationId: string | undefined;
  const tools: { stepIndex: number; name: string; failed?: true; error?: string }[] = [];
  for (const [id, name] of calls) {
    const parts = /^agy-(.+)-(\d+)$/.exec(id.slice(prefix.length));
    const outcome = completed.get(id);
    if (parts === null || !AGY_UUID.test(parts[1]!) || outcome === undefined || !AGY_TOOL_NAME.test(name)) return undefined;
    if (conversationId !== undefined && conversationId !== parts[1]) return undefined;
    conversationId = parts[1];
    const stepIndex = Number(parts[2]);
    if (!Number.isSafeInteger(stepIndex)) return undefined;
    tools.push({
      stepIndex,
      name,
      failed: outcome.failed ? true : undefined,
      error: outcome.errorText,
    });
  }
  return {
    version: 1,
    sessionId,
    conversationId,
    model,
    effort,
    terminalError,
    disclosedCwd,
    additionalDirectories: additionalDirectories?.length ? [...additionalDirectories] : undefined,
    tools: tools.sort((a, b) => a.stepIndex - b.stepIndex),
  };
}

function sessionRefWithLocalSource(sessionRef: ExecutorSessionRefEnvelope, localSource: unknown): ExecutorSessionRefEnvelope {
  const ref = { ...sessionRef.ref };
  if (localSource === undefined) delete ref['localSource'];
  else ref['localSource'] = localSource;
  return { ...sessionRef, ref };
}

function permissionRestoreFromRef(ref: ExecutorSessionRefEnvelope | undefined) {
  const saved = objectOf(ref?.ref['kikiPermissionRestore']);
  if (typeof saved?.['sessionId'] !== 'string' || saved['sessionId'] !== sessionIdFromState(ref)) return undefined;
  const config = objectOf(saved['config']);
  if (config !== undefined && typeof config['configId'] === 'string' &&
      (typeof config['value'] === 'string' || typeof config['value'] === 'boolean')) {
    return { sessionId: saved['sessionId'], config: { configId: config['configId'], value: config['value'] } };
  }
  return typeof saved['modeId'] === 'string' ? { sessionId: saved['sessionId'], modeId: saved['modeId'] } : undefined;
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
