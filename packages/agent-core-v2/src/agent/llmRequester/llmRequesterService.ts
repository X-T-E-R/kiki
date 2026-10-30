import { createHash, randomUUID } from 'node:crypto';
import { isRequestGovernanceError } from '#/app/requestGovernance/errors';
import { LifecycleScope } from '#/app/scopes';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
  type ProjectionPolicy,
} from '#/agent/contextProjector/contextProjector';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentCognitionAnchorService } from '#/agent/cognition/cognitionAnchor';
import { IAgentProfileService, type ProfileModelContext } from '#/agent/profile/profile';
import { injectDelegationContext } from '#/agent/profile/delegationContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ISubagentTool } from '#/agent/tools/agent/agent';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { IAgentUsageService } from '#/agent/usage/usage';
import { RETRY_SECTION, type RetryConfig } from '#/agent/stepRetry/configSection';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';
import { findRetryPolicy } from '#/agent/stepRetry/retryPolicy';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { INbSearchService } from '#/app/nbSearch/nbSearch';
import { PROMPT_SECTION, type PromptConfig } from '#/app/prompt/configSection';
import {
  appendSharedPromptField,
  applyToolPromptFields,
} from '#/app/promptField/builtinPromptFields';
import type { ResolvedPromptFieldOverrides } from '#/app/promptField/promptFieldRegistry';
import { customPromptVariables } from '@kiki/agent-profiles/promptConfig';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  APIContextOverflowError,
  APIRequestTooLargeError,
  APIStatusError,
  classifyApiError,
  requestDeliveryProvenance,
  readProviderEventErrorCode,
  isImageFormatError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
  isRetryableRequestInterruption,
} from '#/kosong/contract/errors';
import { isContentPart, isVacuousContentPart, isToolCall, type Message, type StreamedMessagePart } from '#/kosong/contract/message';
import { readGenerateFailureUsage } from '#/kosong/contract/generate';
import type { ResponsesRequestTransport, ResponsesTransportDiagnostics } from '#/kosong/contract/responsesTransport';
import { safeResponsesTransportDiagnostics } from '#/kosong/contract/streamDiagnostics';
import { type ThinkingEffort } from '#/kosong/contract/provider';
import { type Tool } from '#/kosong/contract/tool';
import { emptyUsage, inputTotal, type TokenUsage } from '#/kosong/contract/usage';
import { ILogService, type LogContext } from '#/_base/log/log';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import {
  effectiveMaxCompletionTokens,
  stripKikiReservedRequestParams,
  type ModelRequestEvent,
  type ModelRequestParams,
  type ModelRequester,
  type ModelRequestTiming,
} from '#/kosong/model/modelRequester';
import type { ModelOverrides } from '#/kosong/model/model.types';
import { IModelService } from '#/kosong/model/model';
import { completionBudgetParams, resolveCompletionBudget } from '#/kosong/model/completionBudget';
import { resolveThinkingKeep, type ThinkingConfig } from '#/kosong/model/thinking';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  REQUEST_COMPRESSION_SECTION,
  REQUEST_IDENTITY_SECTION,
  RESPONSES_WEB_SOCKET_SECTION,
  THINKING_SECTION,
} from '#/app/kosongConfig/configSection';
import type { Protocol } from '#/kosong/protocol/protocol';
import { googleGenAIRejectsTrailingModelTurn } from '#/kosong/provider/bases/google-genai/googleModelTurn';
import { ResponsesWebSocketTransport } from '#/kosong/provider/bases/openai/responses-websocket';
import {
  IProviderService,
  type ProviderConfig,
  type ProvidersSection,
} from '#/kosong/provider/provider';
import { getProviderDefinition, usesKimiToolSchema } from '#/kosong/provider/providerDefinition';
import {
  REQUEST_IDENTITY_RESERVED_HEADERS,
  defaultOAuthRequestIdentity,
  type RequestIdentityPolicy,
  type ResolvedRequestIdentityPolicy,
} from '#/kosong/requestIdentity/requestIdentityPolicy';
import {
  preflightRequestIdentityProjection,
  projectRequestIdentity,
  type RequestIdentityProjection,
} from '#/kosong/requestIdentity/requestIdentityProjector';
import type { ApiErrorEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  isSubagentMeta,
  requestIdentitySpawnContext,
  subagentParentAgentId,
} from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
} from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { WarningIssued } from '#/agent/profile/profileOps';
import {
  IRequestIdentityRegistry,
  type RequestIdentityDimensions,
  type RequestIdentitySnapshot,
} from '#/session/requestIdentity/requestIdentityRegistry';
import { RequestIdentityErrors } from '#/kosong/requestIdentity/errors';
import { IRequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { AnthropicResponseCapture, type AnthropicResponseCaptureInput, type AnthropicResponseCaptureStatus } from './anthropicResponseCapture';

import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type AgentLLMRequestLogFields,
  type AgentLLMRequestOverrides,
  type AgentLLMRequestPartHandler,
  type AgentLLMRequestSource,
  type AgentLLMRequestTask,
  type PreparedTurnRequestConfig,
} from './llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import {
  ToolCallIdNormalizer,
  type ToolCallIdResponseNormalizer,
} from './toolCallIdNormalizer';
import { projectDynamicToolSchemas } from './dynamicToolProjection';
import {
  LlmRequest,
  llmRequestTraceKey,
  LlmToolsSnapshot,
  type LlmRequestPayload,
  type LlmRequestToolSchema,
} from './llmRequestOps';
import { isAbortError } from '#/_base/utils/abort';
import { parseBooleanEnv } from '#/_base/utils/env';
import { ErrorCodes, Error2, attachErrorDetails, readAttachedErrorDetails, unwrapErrorCause } from '#/errors';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  readRetryAfterMs,
  retryBackoffDelay,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const noopOnPart: AgentLLMRequestPartHandler = () => {};

export const KIKI_INFINITE_RETRY_ENV = 'KIKI_INFINITE_RETRY';

function hasExplicitRetryVeto(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    if (readAttachedErrorDetails(current)?.['retry'] === false ||
      (current instanceof Error2 && current.details?.['retry'] === false)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function responseTransportLogFields(error: unknown): Partial<ResponsesTransportDiagnostics> {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const details = readAttachedErrorDetails(current)?.['responsesTransport'] ??
      (current instanceof Error2 ? current.details?.['responsesTransport'] : undefined);
    const diagnostics = safeResponsesTransportDiagnostics(details);
    if (diagnostics !== undefined) return diagnostics;
    current = current instanceof Error ? current.cause : undefined;
  }
  return {};
}

interface RequestIdentityAttemptContext {
  readonly policy: ResolvedRequestIdentityPolicy;
  readonly parentAgentId?: string;
  readonly subagentKind?: string;
  readonly parentTurnKey?: string;
  readonly rootAgentId?: string;
  readonly rootTurnKey?: string;
  readonly isKimiProvider: boolean;
  readonly hostRequestHeaders: Readonly<Record<string, string>>;
}

interface ResolvedLLMRequest {
  readonly requester: ModelRequester;
  readonly model: Model;
  readonly params: ModelRequestParams;
  readonly identity: RequestIdentityAttemptContext;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: Message[];
  readonly source: AgentLLMRequestSource | undefined;
  readonly logFields: AgentLLMRequestLogFields;
}

interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly protocolSource?: 'model' | 'provider' | 'vendor';
  readonly providerType?: string;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: AgentLLMRequestLogFields;
}

interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
  readonly promptFields: ResolvedPromptFieldOverrides;
  readonly promptPrepared: boolean;
  readonly cognition?: import('#/agent/cognition/cognitionConfig').CognitionBinding;
  readonly providerConfig: ProviderConfig | undefined;
  readonly requestIdentity: ResolvedRequestIdentityPolicy;
}

export const llmRequesterLastConfigLogSignatureKey = defineState<string | undefined>(
  'llmRequester.lastConfigLogSignature',
  () => undefined as string | undefined,
);
export const llmRequesterTurnConfigsKey = defineState<Map<number, TurnRequestConfig>>(
  'llmRequester.turnConfigs',
  () => new Map(),
);
export const llmRequesterMediaDegradedTurnsKey = defineState<Set<number>>(
  'llmRequester.mediaDegradedTurns',
  () => new Set(),
);
export const llmRequesterMediaStrippedTurnsKey = defineState<Map<number, MediaStripSnapshot>>(
  'llmRequester.mediaStrippedTurns',
  () => new Map(),
);
export const llmRequesterEmittedThinkingEffortWarningsKey = defineState<Set<string>>(
  'llmRequester.emittedThinkingEffortWarnings',
  () => new Set(),
);

export class AgentLLMRequesterService extends Disposable implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  private retryAttribution: { key: string; value: import('#/kosong/model/requestAdmission').RequestAttribution } | undefined;
  private readonly toolCallIdNormalizer = new ToolCallIdNormalizer();
  private readonly frozenTurnTools = new Map<number, readonly Tool[]>();
  private previousToolset: { hash: string; tools: readonly LlmRequestToolSchema[] } | undefined;
  private responseCapture: AnthropicResponseCapture | undefined;
  private responsesTransport: ResponsesWebSocketTransport | undefined;
  private readonly responsesTransports = new Set<ResponsesWebSocketTransport>();
  private responsesTransportModel: Model | undefined;
  private responsesTransportKey: string | undefined;

  armAnthropicResponseCapture(input: AnthropicResponseCaptureInput): AnthropicResponseCaptureStatus {
    if (input?.sessionId !== this.sessionContext.sessionId || input?.agentId !== this.agentContext.agentId) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Response capture identity must match the addressed session and agent.');
    }
    if (this.responseCapture?.status().enabled) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Stop the existing response capture before arming another.');
    this.responseCapture = new AnthropicResponseCapture(this.captureLogs, this.bootstrap.scope('logs'), {
      sessionId: input.sessionId, agentId: input.agentId, providerId: input.providerId, model: input.model,
      thinkingEffort: input.thinkingEffort, expiresAt: input.expiresAt, maxResponses: input.maxResponses,
    });
    return this.responseCapture.status();
  }

  async anthropicResponseCaptureStatus(): Promise<AnthropicResponseCaptureStatus | null> {
    return this.responseCapture?.flush() ?? null;
  }

  async stopAnthropicResponseCapture(captureId: string): Promise<AnthropicResponseCaptureStatus> {
    if (this.responseCapture === undefined || this.responseCapture.status().captureId !== captureId) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Response capture id does not match the current lease.');
    }
    this.responseCapture.stop();
    return this.responseCapture.flush();
  }

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentTokenCountingService private readonly tokenCounting: IAgentTokenCountingService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentMediaResolverService private readonly mediaResolver: IAgentMediaResolverService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentCognitionAnchorService private readonly cognitionAnchor: IAgentCognitionAnchorService,
    @IAgentScopeContext private readonly agentContext: IAgentScopeContext,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IConfigService private readonly config: IConfigService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @INbSearchService private readonly nbSearch: INbSearchService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IModelService private readonly modelService: IModelService,
    @IProviderService private readonly providers: IProviderService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly states: IAgentStateService,
    @IRequestIdentityRegistry private readonly requestIdentities: IRequestIdentityRegistry,
    @IRequestIdentityCatalog private readonly identityCatalog: IRequestIdentityCatalog,
    @IAppendLogStore private readonly captureLogs: IAppendLogStore,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this._register(toDisposable(() => {
      this.responsesTransport?.dispose();
      this.responsesTransport = undefined;
      for (const transport of this.responsesTransports) transport.dispose();
      this.responsesTransports.clear();
      this.responsesTransportModel = undefined;
      this.responsesTransportKey = undefined;
    }));
    this.states.contributeState(llmRequestTraceKey);
    this.states.contributeState(llmRequesterLastConfigLogSignatureKey);
    this.states.contributeState(llmRequesterTurnConfigsKey);
    this.states.contributeState(llmRequesterMediaDegradedTurnsKey);
    this.states.contributeState(llmRequesterMediaStrippedTurnsKey);
    this.states.contributeState(llmRequesterEmittedThinkingEffortWarningsKey);
    this._register(this.eventBus.subscribe(ContextSpliced, (event) => {
      if (event.deleteCount > 0) this.closeResponsesTransport();
    }));
    const onDidSectionChange = this.config.onDidSectionChange;
    if (onDidSectionChange !== undefined) {
      this._register(onDidSectionChange(({ domain }) => {
        if (isResponsesTransportConfigSection(domain)) this.closeResponsesTransport();
      }));
    }
    this._register(this.providers.onDidChangeProviders(() => this.closeResponsesTransport()));
    this._register(this.providers.onDidChangeDefaultProvider(() => this.closeResponsesTransport()));
    const onDidChangeModels = this.modelService.onDidChangeModels;
    if (onDidChangeModels !== undefined) {
      this._register(onDidChangeModels(() => this.closeResponsesTransport()));
    }
  }

  private get lastConfigLogSignature(): string | undefined {
    return this.states.get(llmRequesterLastConfigLogSignatureKey);
  }

  private set lastConfigLogSignature(value: string | undefined) {
    this.states.set(llmRequesterLastConfigLogSignatureKey, value);
  }

  private get turnConfigs(): Map<number, TurnRequestConfig> {
    return this.states.get(llmRequesterTurnConfigsKey);
  }

  private get mediaDegradedTurns(): Set<number> {
    return this.states.get(llmRequesterMediaDegradedTurnsKey);
  }

  private get mediaStrippedTurns(): Map<number, MediaStripSnapshot> {
    return this.states.get(llmRequesterMediaStrippedTurnsKey);
  }

  private get emittedThinkingEffortWarnings(): Set<string> {
    return this.states.get(llmRequesterEmittedThinkingEffortWarningsKey);
  }

  private closeResponsesTransport(): void {
    const transport = this.responsesTransport;
    this.responsesTransport = undefined;
    this.responsesTransportModel = undefined;
    this.responsesTransportKey = undefined;
    if (transport === undefined) return;
    this.responsesTransports.add(transport);
    void transport.retire().then(() => {
      this.responsesTransports.delete(transport);
    });
  }

  private ensureResponsesTransport(
    request: Pick<ResolvedLLMRequest, 'model' | 'source' | 'identity'>,
  ): ResponsesRequestTransport | undefined {
    const model = request.model;
    const config = model.responsesWebSocket;
    if (request.source?.type !== 'turn' || model.protocol !== 'openai_responses' || config === undefined || config.targets.length === 0) {
      this.closeResponsesTransport();
      return undefined;
    }
    const key = responsesTransportKey(model, request.identity);
    if (this.responsesTransport === undefined || this.responsesTransportModel !== model || this.responsesTransportKey !== key) {
      this.closeResponsesTransport();
      this.responsesTransportModel = model;
      this.responsesTransportKey = key;
      this.responsesTransport = new ResponsesWebSocketTransport();
    }
    return this.responsesTransport;
  }

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined {
    if (!this.profile.hasProvider()) return undefined;
    const config = this.getOrCreateTurnConfig(turnId);
    return { thinkingEffort: config.resolved.thinkingLevel };
  }

  supportsAssistantPrefill(): boolean {
    try {
      if (!this.profile.hasProvider()) return true;
      const alias = this.profile.resolveModelContext().modelAlias;
      const model = this.modelCatalog.get(alias);
      if (model.protocol !== 'google-genai') return true;
      return !googleGenAIRejectsTrailingModelTurn(model.name);
    } catch {
      return true;
    }
  }

  invalidatePromptSnapshots(): number {
    const invalidated = this.turnConfigs.size;
    this.turnConfigs.clear();
    this.closeResponsesTransport();
    return invalidated;
  }

  async request(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish> {
    return this.start(overrides, onPart, signal).result;
  }

  start(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): AgentLLMRequestTask {
    const trace = new MutableLLMRequestTrace();
    return {
      trace,
      result: this.requestWithTrace(trace, overrides, onPart, signal),
    };
  }

  private async requestWithTrace(
    trace: MutableLLMRequestTrace,
    overrides: AgentLLMRequestOverrides,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
  ): Promise<AgentLLMRequestFinish> {
    signal?.throwIfAborted();
    if (overrides.source?.type !== 'turn') this.closeResponsesTransport();
    const startedAt = Date.now();
    trace.set(undefined);
    try {
      return await this.runRequest(
        await this.resolveRequest(overrides),
        onPart,
        signal,
        (traceId) => {
          trace.set(traceId);
        },
        overrides.onAttemptRetry,
        overrides.retry,
      );
    } catch (error) {
      this.logRequestFailure(error, overrides, signal);
      trace.set(this.trackApiError(error, startedAt, signal, overrides.source, trace.traceId));
      throw error;
    }
  }

  private logRequestFailure(
    error: unknown,
    overrides: AgentLLMRequestOverrides,
    signal: AbortSignal | undefined,
  ): void {
    if (isAbortError(error) || signal?.aborted === true) return;
    const payload: LogContext = {
      ...logFieldsForSource(overrides.source),
      model: this.profile.data().modelAlias ?? 'unknown',
      ...retryErrorFields(error),
      ...responseTransportLogFields(error),
    };
    this.log.warn('llm request failed', payload);
  }

  private trackApiError(
    error: unknown,
    startedAt: number,
    signal: AbortSignal | undefined,
    source?: AgentLLMRequestSource,
    requestTraceId?: string,
  ): string | undefined {
    if (isAbortError(error) || signal?.aborted === true) return requestTraceId;
    const modelAlias = this.profile.data().modelAlias;
    const model = this.tryGetModel();
    const traceId = requestTraceId ?? apiTraceId(error);
    const classification = classifyApiError(unwrapErrorCause(error));
    const properties: ApiErrorEvent = {
      error_type: classification.kind,
      model: model?.id ?? modelAlias ?? 'unknown',
      alias: modelAlias,
      provider_type: model?.providerType ?? model?.protocol,
      protocol: model?.protocol,
      retryable: isRetryableGenerateError(error),
      duration_ms: Math.max(0, Date.now() - startedAt),
      turn_id: source?.turnId,
      request_kind: requestKindForTelemetry(source),
      trace_id: traceId,
    };
    if (source?.type === 'turn') {
      if (source.step !== undefined) properties['step_no'] = source.step;
    }
    const statusCode = apiStatusCode(error);
    if (statusCode !== undefined) properties['status_code'] = statusCode;
    const currentTurn = this.usage.status().currentTurn;
    if (currentTurn !== undefined) properties['input_tokens'] = inputTotal(currentTurn);
    this.telemetry.track2('api_error', properties);
    return traceId;
  }

  private tryGetModel(): Model | undefined {
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) return undefined;
    try {
      return this.modelCatalog.get(modelAlias);
    } catch {
      return undefined;
    }
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
    onRequestTrace: (traceId: string | undefined) => void,
    onAttemptRetry: (() => void) | undefined,
    retry: 'never' | undefined,
  ): Promise<AgentLLMRequestFinish> {
    const source = request.source;
    const purpose = source?.type === 'operation' ? source.requestKind ?? 'operation' : source?.type ?? 'system';
    const retryKey = source === undefined ? randomUUID() : JSON.stringify([source.type, source.turnId, source.type === 'turn' ? source.step : purpose]);
    const attribution = this.retryAttribution?.key === retryKey ? this.retryAttribution.value : {
      logicalRequestId: randomUUID(), sessionId: this.sessionContext.sessionId,
      agentId: this.agentContext.agentId, parentAgentId: request.identity.parentAgentId,
      purpose, waitBudget: { waitedMs: 0 },
    };
    this.retryAttribution = { key: retryKey, value: attribution };
    this.toolCallIdNormalizer.seedFrom(this.context.get());
    const shaped = this.toolSelect.shapeHistory(request.messages);
    const recoveredStrip = this.mediaStripSnapshotForTurn(request.source);
    let policy: ProjectionPolicy | undefined =
      recoveredStrip !== undefined
        ? { media: { strip: recoveredStrip } }
        : this.isRecoveryTurn(this.mediaDegradedTurns, request.source)
          ? { media: 'degraded' }
          : undefined;
    const captureMediaStripPolicy = (): { readonly strip: MediaStripSnapshot } => {
      const snapshot = this.projector.captureMediaStripSnapshot(shaped);
      this.markMediaStrippedRecoveryTurn(snapshot, request.source);
      return { strip: snapshot };
    };
    let attemptObservedOutput = false;
    let attemptStartedAt = Date.now();
    let attemptTraceId: string | undefined;
    const run = async (
      policy: ProjectionPolicy | undefined,
      params: ModelRequestParams,
    ): Promise<AgentLLMRequestFinish> => {
      attemptObservedOutput = false;
      attemptStartedAt = Date.now();
      attemptTraceId = undefined;
      onRequestTrace(undefined);
      const projection = projectionNameOf(policy);
      const fields =
        projection === undefined ? request.logFields : { ...request.logFields, projection };
      const input = {
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        messages: projectDynamicToolSchemas(
          await this.mediaResolver.resolve(
            this.projector.project(shaped, policy),
            request.requester,
            signal,
            params.headers,
          ),
          request.model.protocol,
          usesKimiToolSchema(request.model.providerType),
        ),
      };
      this.warnAboutAnthropicThinkingEffort(request);
      const logInput: LLMRequestLogInput = {
        protocol: request.model.protocol,
        protocolSource: request.model.protocolSource,
        providerType: request.model.providerType,
        modelName: request.model.name,
        modelAlias: request.modelAlias,
        thinkingEffort: request.thinkingEffort,
        maxTokens: effectiveMaxCompletionTokens(request.params),
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        messages: input.messages,
        fields,
      };
      this.logRequest(logInput);
      this.recordRequest(logInput);
      this.observeIdentity(request, params);

      let message: Message | undefined;
      let usage: TokenUsage | undefined;
      let timing: ModelRequestTiming | undefined;
      let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;
      let handlingPart = false;
      let toolCallIds = this.toolCallIdNormalizer.beginResponse();

      const setTraceId = (traceId: string | null | undefined): void => {
        const normalized = traceId ?? undefined;
        attemptTraceId = normalized;
        onRequestTrace(normalized);
      };

      const rawResponseObserver = this.responseCapture?.observe({ providerId: request.model.providerName, model: request.model.name,
        thinkingEffort: request.thinkingEffort, protocol: request.model.protocol,
        turnId: request.source?.turnId, step: request.source?.type === 'turn' ? request.source.step : undefined, cacheKey: params.cacheKey });
      try {
        for await (const event of request.requester.request(input, signal, {
          ...params,
          usedContextTokensTrusted: params.usedContextTokensTrusted === true &&
            this.tokenCounting.isCurrentContextMeasured() &&
            isUnchangedModelHistory(this.context.get(), request.messages) &&
            isUnchangedModelHistory(request.messages, input.messages),
          onTraceId: setTraceId,
          rawResponseObserver,
          attribution,
          retry,
        })) {
          signal?.throwIfAborted();
          switch (event.type) {
            case 'attempt.discarded':
              toolCallIds.rollback();
              toolCallIds = this.toolCallIdNormalizer.beginResponse();
              onAttemptRetry?.();
              break;
            case 'part':
              attemptObservedOutput ||= !isContentPart(event.part) || !isVacuousContentPart(event.part);
              handlingPart = true;
              await onPart(this.normalizeStreamPart(toolCallIds, event.part), event.responseInstanceId);
              handlingPart = false;
              signal?.throwIfAborted();
              break;
            case 'usage':
              usage = event.usage;
              break;
            case 'finish':
              finish = event;
              message = event.message;
              setTraceId(event.traceId);
              break;
            case 'timing': {
              const { type: _type, ...streamTiming } = event;
              timing = streamTiming;
              break;
            }
          }
        }
        signal?.throwIfAborted();

        if (message === undefined || finish === undefined) {
          throw new Error2(
            ErrorCodes.PROVIDER_API_ERROR,
            'LLM request stream ended without a finish event.',
          );
        }

        const finalizedCalls = toolCallIds.remapFinalizedCalls(message.toolCalls);
        const routedCalls = finalizedCalls.map((call) => this.toolSelect.resolveBridgeCall(call));
        if (finalizedCalls !== message.toolCalls || routedCalls.some((call, index) => call !== finalizedCalls[index])) {
          message = { ...message, toolCalls: routedCalls };
        }
        for (const { raw, assigned } of toolCallIds.remapped) {
          this.log.warn('Rewrote a duplicate provider tool call id into an agent-unique one.', {
            raw,
            assigned,
            model: request.modelAlias,
          });
        }
      } catch (error) {
        toolCallIds.rollback();
        if (handlingPart || finish !== undefined) attachErrorDetails(error, { retry: false });
        const failureUsage = readGenerateFailureUsage(error);
        if (failureUsage !== undefined) {
          this.usage.record(request.modelAlias, failureUsage, request.source, {
            provider: request.model.providerName,
            modelAlias: request.modelAlias,
            executorId: 'native',
            usageKnown: true,
          });
        }
        throw error;
      } finally {
        rawResponseObserver?.end('request-finished-without-raw-eof');
      }

      this.usage.record(request.modelAlias, usage ?? emptyUsage(), request.source, {
        provider: request.model.providerName,
        modelAlias: request.modelAlias,
        executorId: 'native',
        usageKnown: usage !== undefined,
      });
      if (usage !== undefined) {
        this.tokenCounting.measured(request.messages, [message], usage);
      }
      this.logResponse(request.logFields, usage ?? emptyUsage(), timing);

      return {
        message,
        usage: usage ?? emptyUsage(),
        model: request.modelAlias,
        providerFinishReason: finish.providerFinishReason,
        completionAuthority: finish.completionAuthority,
        rawFinishReason: finish.rawFinishReason,
        providerMessageId: finish.id,
        timing,
        traceId: finish.traceId,
      };
    };

    let interruptionAttempt = 1;
    let infiniteRetryAttempt = 0;
    let params = request.params;
    const refreshIdentityParams = async (): Promise<void> => {
      const projection = await this.resolveIdentityProjection(
        request.identity,
        request.requester,
        request.messages,
        request.source,
      );
      params = {
        ...params,
        headers: projection.headers ?? params.headers,
        requestParams: withIdentityParams(params.requestParams, projection.params),
        requestIdentity: projection.wire ?? params.requestIdentity,
      };
    };
    for (;;) {
      try {
        const result = await run(policy, params);
        if (this.retryAttribution?.value === attribution) this.retryAttribution = undefined;
        return result;
      } catch (error) {
        const retryConfig = this.config.get<RetryConfig>(RETRY_SECTION);
        const raw = unwrapErrorCause(error);
        const retryPolicy = findRetryPolicy(retryConfig?.policies, raw, {
          model: request.model.id, provider: request.model.providerName,
        });
        if (retry === 'never' || retryPolicy?.retry === false || hasExplicitRetryVeto(error) ||
          isAbortError(error) || signal?.aborted === true) throw error;
        if (source?.type === 'turn' && isRetryableRequestInterruption(error)) {
          const discardedPartialOutput = attemptObservedOutput || !isRetryableGenerateError(error);
          if (discardedPartialOutput && (retryConfig?.retryPartialResponses === false || onAttemptRetry === undefined)) throw error;
          const maxAttempts = Math.min(DEFAULT_MAX_RETRY_ATTEMPTS, Math.max(retryPolicy?.maxAttempts ?? retryConfig?.maxAttempts ??
            this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep ?? DEFAULT_MAX_RETRY_ATTEMPTS, 1));
          onAttemptRetry?.();
          if (interruptionAttempt >= maxAttempts) {
            const details = { retry: false, retry_exhausted: true, retry_attempts: interruptionAttempt };
            attachErrorDetails(error, details);
            attachErrorDetails(raw, details);
            this.log.warn('upstream interruption retry exhausted', {
              ...request.logFields, model: request.modelAlias, attempt: interruptionAttempt,
              maxAttempts, discardedPartialOutput, ...retryErrorFields(raw), ...responseTransportLogFields(error),
            });
            throw error;
          }
          this.trackApiError(error, attemptStartedAt, signal, source, attemptTraceId);
          const delayMs = readRetryAfterMs(raw) ?? retryPolicy?.backoff ?? retryBackoffDelay(interruptionAttempt - 1, 2_000);
          const fields = retryErrorFields(raw);
          const errorMessage = `Upstream interrupted; retrying and discarding partial output. ${fields.errorMessage}`;
          this.log.warn('upstream interrupted; retrying and discarding partial output', {
            ...request.logFields, model: request.modelAlias, attempt: interruptionAttempt,
            maxAttempts, delayMs, discardedPartialOutput, ...fields, ...responseTransportLogFields(error),
          });
          void this.dispatcher.dispatch(new TurnStepRetrying({
            turnId: source.turnId, step: source.step ?? 1,
            failedAttempt: interruptionAttempt, nextAttempt: interruptionAttempt + 1,
            maxAttempts, delayMs, ...fields, errorMessage,
          }));
          interruptionAttempt++;
          await sleepForRetry(delayMs, signal);
          await refreshIdentityParams();
          continue;
        }
        if ((requestDeliveryProvenance(error) !== undefined && !isRetryableGenerateError(error)) ||
          readProviderEventErrorCode(error) === 'antigravity_thinking_only') throw error;
        const nextPolicy = this.nextProjectionPolicyForError(
          error,
          policy,
          request,
          signal,
          captureMediaStripPolicy,
        );
        if (nextPolicy !== undefined) {
          onAttemptRetry?.();
          await refreshIdentityParams();
          policy = nextPolicy;
          continue;
        }
        if (
          (requestDeliveryProvenance(error) !== undefined && !isRetryableGenerateError(error)) ||
          !this.infiniteRetryEnabled ||
          isRequestGovernanceError(error) ||
          raw instanceof APIContextOverflowError
        ) {
          throw error;
        }
        infiniteRetryAttempt += 1;
        const delayMs =
          readRetryAfterMs(raw) ??
          retryBackoffDelay(infiniteRetryAttempt - 1);
        this.log.warn('llm request failed; retrying indefinitely (KIKI_INFINITE_RETRY)', {
          model: request.model.name,
          ...request.logFields,
          attempt: infiniteRetryAttempt,
          delayMs,
          ...retryErrorFields(error),
          ...responseTransportLogFields(error),
        });
        onAttemptRetry?.();
        await refreshIdentityParams();
        await sleepForRetry(delayMs, signal);
      }
    }
  }

  private get infiniteRetryEnabled(): boolean {
    return parseBooleanEnv(this.bootstrap.getEnv(KIKI_INFINITE_RETRY_ENV)) === true;
  }

  private nextProjectionPolicyForError(
    error: unknown,
    policy: ProjectionPolicy | undefined,
    request: ResolvedLLMRequest,
    signal: AbortSignal | undefined,
    captureMediaStripPolicy: () => { readonly strip: MediaStripSnapshot },
  ): ProjectionPolicy | undefined {
    if (signal?.aborted === true || (requestDeliveryProvenance(error) !== undefined && !isRetryableGenerateError(error))) return undefined;
    const raw = unwrapErrorCause(error);
    const media = policy?.media;
    if (
      raw instanceof APIRequestTooLargeError &&
      (media === undefined || media === 'degraded')
    ) {
      signal?.throwIfAborted();
      if (media === undefined) {
        this.log.warn('provider rejected request as too large; resending with degraded media', {
          model: request.model.name,
          ...request.logFields,
        });
        this.markRecoveryTurn(this.mediaDegradedTurns, request.source);
        return { ...policy, media: 'degraded' };
      }
      this.log.warn(
        'provider rejected degraded-media request as too large; resending with rejected media stripped',
        {
          model: request.model.name,
          ...request.logFields,
        },
      );
      return { ...policy, media: captureMediaStripPolicy() };
    }
    if (typeof media !== 'object' && isImageFormatError(raw)) {
      signal?.throwIfAborted();
      this.log.warn(
        'provider rejected an image in the request; resending with rejected media stripped',
        {
          model: request.model.name,
          ...request.logFields,
        },
      );
      return { ...policy, media: captureMediaStripPolicy() };
    }
    if (policy?.structure === undefined && isRecoverableRequestStructureError(raw)) {
      signal?.throwIfAborted();
      this.log.warn('provider rejected request structure; resending with strict projection', {
        model: request.model.name,
        ...request.logFields,
      });
      return { ...policy, structure: 'strict' };
    }
    return undefined;
  }

  private normalizeStreamPart(
    toolCallIds: ToolCallIdResponseNormalizer,
    part: StreamedMessagePart,
  ): StreamedMessagePart {
    if (!isToolCall(part)) return part;
    const assigned = toolCallIds.remapStreamedId(part.id, part._streamIndex);
    return assigned === part.id ? part : { ...part, id: assigned };
  }

  private warnAboutAnthropicThinkingEffort(request: ResolvedLLMRequest): void {
    if (request.model.protocol !== 'anthropic') return;
    const effort = request.thinkingEffort;
    if (effort === 'on' || effort === 'off') return;

    let code: string;
    let message: string;
    let knownEfforts: string | undefined;
    const supportEfforts = request.model.supportEfforts?.filter((value) => value.length > 0);
    if (supportEfforts === undefined || supportEfforts.length === 0) return;
    if (supportEfforts.includes(effort)) return;
    code = 'anthropic-thinking-effort-not-listed';
    knownEfforts = supportEfforts.join(',');
    message = `Thinking effort "${effort}" is not listed for model "${request.model.name}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;

    const key = [code, request.modelAlias, request.model.name, effort, knownEfforts].join('\u0000');
    if (this.emittedThinkingEffortWarnings.has(key)) return;
    this.emittedThinkingEffortWarnings.add(key);
    try {
      this.log.warn(message, {
        modelAlias: request.modelAlias,
        model: request.model.name,
        effort,
        knownEfforts,
      });
    } catch {
    }
    try {
      void this.dispatcher.dispatch(new WarningIssued({ code, message }));
    } catch {
    }
  }

  private isRecoveryTurn(set: ReadonlySet<number>, source: AgentLLMRequestSource | undefined): boolean {
    if (source?.type !== 'turn') return false;
    return set.has(source.turnId);
  }

  private mediaStripSnapshotForTurn(
    source: AgentLLMRequestSource | undefined,
  ): MediaStripSnapshot | undefined {
    if (source?.type !== 'turn') return undefined;
    return this.mediaStrippedTurns.get(source.turnId);
  }

  private markMediaStrippedRecoveryTurn(
    snapshot: MediaStripSnapshot,
    source: AgentLLMRequestSource | undefined,
  ): void {
    if (source?.type !== 'turn') return;
    for (const id of this.mediaStrippedTurns.keys()) {
      if (id < source.turnId) this.mediaStrippedTurns.delete(id);
    }
    this.mediaStrippedTurns.set(source.turnId, snapshot);
  }

  private markRecoveryTurn(set: Set<number>, source: AgentLLMRequestSource | undefined): void {
    if (source?.type !== 'turn') return;
    for (const id of set) {
      if (id < source.turnId) set.delete(id);
    }
    set.add(source.turnId);
  }

  private async resolveIdentityProjection(
    identity: RequestIdentityAttemptContext,
    requester: ModelRequester,
    messages: readonly Message[],
    source: AgentLLMRequestSource | undefined,
  ): Promise<RequestIdentityProjection> {
    const dimensions = resolveRequestIdentityDimensions(
      identity.policy,
      identity.isKimiProvider,
      identity.hostRequestHeaders,
    );
    const snapshot = hasRequestIdentityDimensions(dimensions)
      ? await this.requestIdentities.snapshot({
          agentId: this.agentContext.agentId,
          turnKey: requestIdentityTurnKey(source),
          parentAgentId: identity.parentAgentId,
          parentTurnKey: identity.parentTurnKey,
          rootAgentId: identity.rootAgentId,
          rootTurnKey: identity.rootTurnKey,
          compactionWindow: messages.filter(
            (message) =>
              (message as Message & { readonly origin?: { readonly kind?: string } }).origin
                ?.kind === 'compaction_summary',
          ).length,
          logicalIdKind:
            identity.policy.lineage.format === 'codex' ? 'uuidv7' : 'uuidv4',
          dimensions,
        })
      : emptyRequestIdentitySnapshot();
    return projectRequestIdentity({
      policy: identity.policy,
      protocol: requester.model.protocol,
      model: requester.model.name,
      rawSessionId: this.sessionContext.sessionId,
      rawAgentId: this.agentContext.agentId,
      parentAgentId: identity.parentAgentId,
      subagentKind: identity.subagentKind,
      isKimiProvider: identity.isKimiProvider,
      snapshot,
      runtimeVersion: this.bootstrap.clientIdentity.version,
      platform: this.bootstrap.platform,
      arch: this.bootstrap.arch,
      hostRequestHeaders: identity.hostRequestHeaders,
      profile: this.identityCatalog.render(identity.policy, requester.model.name),
    });
  }

  private observeIdentity(request: ResolvedLLMRequest, params: ModelRequestParams): void {
    this.identityCatalog.recordObservation({
      providerId: request.model.providerName,
      model: request.model.name,
      protocol: request.model.protocol,
      policy: request.identity.policy,
      sessionId: this.sessionContext.sessionId,
      agentId: this.agentContext.agentId,
      headers: params.headers,
      params: identityParamsOf(params.requestParams, request.identity.policy, this.identityCatalog, request.model.name),
      cacheKey: params.cacheKey,
      suppressedUserAgent: params.requestIdentity?.suppressUserAgent === true,
    });
  }

  private async resolveRequest(
    overrides: AgentLLMRequestOverrides,
  ): Promise<ResolvedLLMRequest> {
    if (overrides.tools === undefined && this.defaultTools().some((tool) => tool.name === 'WebSearch' || tool.name === 'FetchURL')) {
      await this.nbSearch.prepareToolDescriptions();
    }
    await this.profile.preparePromptConfiguration();
    const promptConfig = this.config.get<PromptConfig>(PROMPT_SECTION);
    const turnConfig = this.resolveTurnConfig(overrides.source);
    const resolved = turnConfig?.resolved ?? this.profile.resolveModelContext();
    const baseParams = turnConfig?.params ?? this.profile.resolveRequestParams();
    const agentMeta = (await this.sessionMetadata.read()).agents?.[this.agentContext.agentId];
    const requester = this.modelCatalog.getRequester(resolved.modelAlias,
      turnConfig?.cognition?.modelSettings ?? turnConfig?.cognition?.recipe?.resolved.model ?? this.profile.getRecipeModelSettings(resolved.modelAlias));
    const useServerOutputDefault = (requester.model.protocol === 'openai' || requester.model.protocol === 'openai_responses') &&
      !isKimiProviderFamily(requester.model.providerType);
    const usedContextTokens = overrides.messages === undefined ? this.tokenCounting.get().measured : undefined;
    const globalCompletionCap = this.config.get<ModelOverrides>('modelOverrides')?.maxCompletionTokens;
    const outputCap = Math.min(
      globalCompletionCap !== undefined && globalCompletionCap <= 0 && (baseParams.maxCompletionTokens !== undefined || baseParams.maxContextTokens !== undefined)
        ? Infinity : globalCompletionCap ?? Infinity,
      baseParams.maxCompletionTokens ?? Infinity,
      resolved.maxOutputSize !== undefined && (!useServerOutputDefault || resolved.maxOutputSize > 0) ? resolved.maxOutputSize : Infinity,
      overrides.maxOutputSize !== undefined && (!useServerOutputDefault || overrides.maxOutputSize > 0) ? overrides.maxOutputSize : Infinity,
    );
    const constrainToContext = !useServerOutputDefault || (Number.isFinite(outputCap) && outputCap > 0) ||
      (baseParams.maxContextTokens ?? 0) > 0;
    const completionCap = Math.min(outputCap,
      constrainToContext && resolved.modelCapabilities.max_context_tokens > 0 ? resolved.modelCapabilities.max_context_tokens : Infinity,
      useServerOutputDefault && (baseParams.maxContextTokens ?? 0) > 0 ? baseParams.maxContextTokens! : Infinity,
    );
    const budgetParams = completionBudgetParams({
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
        maxCompletionTokensCap: Number.isFinite(completionCap) ? completionCap : undefined,
        allowFallback: !useServerOutputDefault,
      }),
      capability: resolved.modelCapabilities,
      usedContextTokens,
    });
    await this.identityCatalog.ready;
    const providerConfig =
      turnConfig?.providerConfig ??
      this.config.get<ProvidersSection>(PROVIDERS_SECTION)?.[requester.model.providerName];
    const requestIdentity =
      turnConfig?.requestIdentity ??
      this.resolveRequestIdentityPolicy(resolved, providerConfig);
    validateRequestIdentityHeaderCollisions(providerConfig);
    preflightRequestIdentityProjection(requestIdentity, requester.model.protocol);

    const messages = overrides.messages ?? this.context.get();
    const isKimiProvider = isKimiProviderFamily(requester.model.providerType);
    const hostIdentity = this.identity.current();
    const identity: RequestIdentityAttemptContext = {
      policy: requestIdentity,
      parentAgentId: subagentParentAgentId(agentMeta),
      subagentKind: isSubagentMeta(agentMeta) ? 'agent' : undefined,
      ...requestIdentitySpawnContext(agentMeta),
      isKimiProvider,
      hostRequestHeaders: isKimiProvider
        ? hostIdentity.upstreamRequestHeaders
        : hostIdentity.requestHeaders,
    };
    const identityProjection = await this.resolveIdentityProjection(
      identity,
      requester,
      messages,
      overrides.source,
    );
    const resolvedSystemPrompt =
      overrides.systemPrompt ?? turnConfig?.systemPrompt ?? this.profile.getSystemPrompt();
    const cognition = turnConfig?.cognition ?? await this.profile.getCognitionBinding();
    const anchoredPrompt = await this.cognitionAnchor.project({
      sourceType: overrides.source?.type,
      turnId: overrides.source?.type === 'turn' ? overrides.source.turnId : undefined,
      step: overrides.source?.type === 'turn' ? overrides.source.step : undefined,
      hasExplicitSystemPrompt: overrides.systemPrompt !== undefined,
      binding: cognition,
    });
    const promptFields = anchoredPrompt === undefined
      ? turnConfig?.promptFields ?? this.profile.getPromptFieldSnapshot()
      : this.profile.getPromptFieldSnapshot({ anchor: true });
    const promptVariables = customPromptVariables(this.profile.data().boundProfile?.promptBase?.inputs?.variables ?? promptConfig?.variables);
    const params: ModelRequestParams = {
      ...baseParams,
      cacheKey: identityProjection.cacheKey,
      requestParams: withIdentityParams(
        stripRequestIdentityBodyParams(stripKikiReservedRequestParams(baseParams.requestParams)),
        identityProjection.params,
      ),
      ...budgetParams,
      usedContextTokens: useServerOutputDefault ? usedContextTokens : budgetParams?.usedContextTokens,
      usedContextTokensTrusted: overrides.messages === undefined && this.tokenCounting.isCurrentContextMeasured(),
      headers: identityProjection.headers,
      requestIdentity: identityProjection.wire,
    };
    const request: ResolvedLLMRequest = {
      requester,
      model: requester.model,
      params,
      identity,
      modelAlias: resolved.modelAlias,
      thinkingEffort: resolved.thinkingLevel,
      systemPrompt: anchoredPrompt ?? (overrides.systemPrompt !== undefined
        ? appendSharedPromptField(
            injectDelegationContext(resolvedSystemPrompt, this.profile.data().boundProfile?.promptBase?.delegationSnippet),
            promptFields,
            promptVariables,
          )
        : resolvedSystemPrompt),
      tools: this.toolsForRequest(overrides, promptFields, promptVariables),
      messages: [...messages],
      source: overrides.source,
      logFields: {
        ...logFieldsForSource(overrides.source),
        anchorApplied: anchoredPrompt !== undefined,
        cognitionRevision: cognition.revision,
        bindingRevision: cognition.bindingRevision,
        anchorSteps: cognition.config?.anchor === undefined ? undefined : cognition.config.anchorSteps ?? 1,
        anchorScope: cognition.config?.anchor === undefined ? undefined : cognition.config.anchorScope ?? 'session',
      },
    };
    return {
      ...request,
      params: {
        ...params,
        responsesTransport: this.ensureResponsesTransport(request),
      },
    };
  }

  private toolsForRequest(
    overrides: AgentLLMRequestOverrides,
    promptFields: ResolvedPromptFieldOverrides,
    promptVariables: ReturnType<typeof customPromptVariables>,
  ): readonly Tool[] {
    const turnId = overrides.source?.type === 'turn' && overrides.tools === undefined
      ? overrides.source.turnId : undefined;
    if (turnId !== undefined) {
      const frozen = this.frozenTurnTools.get(turnId);
      if (frozen !== undefined) return frozen;
      for (const id of this.frozenTurnTools.keys()) {
        if (id < turnId) this.frozenTurnTools.delete(id);
      }
    }
    const tools = (overrides.tools ?? this.defaultTools()).map((tool) => ({
      ...tool,
      description: applyToolPromptFields(tool.name, tool.description, promptFields, promptVariables),
    }));
    if (turnId !== undefined) this.frozenTurnTools.set(turnId, tools);
    return tools;
  }

  private resolveTurnConfig(source: AgentLLMRequestSource | undefined): TurnRequestConfig | undefined {
    if (source?.turnId === undefined) return undefined;
    return this.getOrCreateTurnConfig(source.turnId, true);
  }

  private getOrCreateTurnConfig(turnId: number, preparePrompt = false): TurnRequestConfig {
    for (const id of this.turnConfigs.keys()) {
      if (id < turnId) this.turnConfigs.delete(id);
    }
    let snapshot = this.turnConfigs.get(turnId);
    if (snapshot !== undefined && preparePrompt && !snapshot.promptPrepared) {
      snapshot = {
        ...snapshot,
        systemPrompt: this.profile.getSystemPrompt(),
        promptFields: this.profile.getPromptFieldSnapshot(),
        cognition: this.profile.getCognitionSnapshot(),
        promptPrepared: true,
      };
      this.turnConfigs.set(turnId, snapshot);
    }
    if (snapshot === undefined) {
      const resolved = this.profile.resolveModelContext();
      const requester = this.modelCatalog.getRequester(resolved.modelAlias, this.profile.getRecipeModelSettings(resolved.modelAlias));
      const providerConfig =
        this.config.get<ProvidersSection>(PROVIDERS_SECTION)?.[requester.model.providerName];
      snapshot = {
        resolved,
        params: this.profile.resolveRequestParams(),
        systemPrompt: this.profile.getSystemPrompt(),
        promptFields: this.profile.getPromptFieldSnapshot(),
        cognition: this.profile.getCognitionSnapshot(),
        promptPrepared: preparePrompt,
        providerConfig,
        requestIdentity: this.resolveRequestIdentityPolicy(resolved, providerConfig),
      };
      this.turnConfigs.set(turnId, snapshot);
    }
    return snapshot;
  }

  private resolveRequestIdentityPolicy(
    resolved: ProfileModelContext,
    providerConfig: ProviderConfig | undefined,
  ): ResolvedRequestIdentityPolicy {
    const modelId = this.modelService.resolveId(resolved.modelAlias) ?? resolved.modelAlias;
    const modelConfig = this.modelService.get(modelId);
    return this.identityCatalog.resolveLayers(
      defaultOAuthRequestIdentity(providerConfig),
      this.config.get<RequestIdentityPolicy | undefined>(REQUEST_IDENTITY_SECTION),
      providerConfig?.requestIdentity,
      modelConfig?.requestIdentity,
    );
  }

  private logRequest(input: LLMRequestLogInput): void {
    const logFields: AgentLLMRequestLogFields = input.fields ?? {};
    const wireTools = providerVisibleTools(input.tools);
    const config = {
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      systemPromptChars: input.systemPrompt.length,
      toolCount: wireTools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(input.systemPrompt),
      toolsHash: fingerprint(JSON.stringify(toolSignature(wireTools))),
    });
    if (signature !== this.lastConfigLogSignature) {
      this.lastConfigLogSignature = signature;
      this.log.info('llm config', { ...logFields, ...config });
    }

    const partialMessageCount = input.messages.filter((message) => message.partial === true).length;
    const requestFields: LogContext = { ...logFields };
    if (partialMessageCount > 0) requestFields['partialMessageCount'] = partialMessageCount;
    this.log.info('llm request', requestFields);
  }

  private recordRequest(input: LLMRequestLogInput): void {
    const fields = input.fields ?? {};
    const wireTools = providerVisibleTools(input.tools);
    const tools = toolSignature(wireTools);
    const toolsHash = fingerprint(JSON.stringify(tools));
    const previous = this.previousToolset;
    if (previous !== undefined && previous.hash !== toolsHash) {
      const beforeNames = new Set(previous.tools.map((tool) => tool.name));
      const afterNames = new Set(tools.map((tool) => tool.name));
      const changedNames = [...beforeNames].filter((name) => !afterNames.has(name))
        .concat([...afterNames].filter((name) => !beforeNames.has(name)));
      this.telemetry.track2('tool_cache_breakpoint', {
        reason: changedNames.length === 0 ? 'tool_definition_changed'
          : changedNames.every((name) => name.startsWith('mcp__'))
            ? 'mcp_toolset_changed' : 'tool_configuration_changed',
        before_hash: previous.hash,
        after_hash: toolsHash,
      });
    }
    this.previousToolset = { hash: toolsHash, tools };
    if (!this.states.get(llmRequestTraceKey).seenToolsHashes.includes(toolsHash)) {
      void this.dispatcher.dispatch(new LlmToolsSnapshot({ hash: toolsHash, tools }));
    }

    const systemPromptHash = fingerprint(input.systemPrompt);
    const overrides = this.config.get<ModelOverrides>('modelOverrides');
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const modelId =
      input.modelAlias === undefined ? undefined : this.modelService.resolveId(input.modelAlias);
    const modelConfig = modelId === undefined ? undefined : this.modelService.get(modelId);
    const agentRun = this.tools.resolve('AgentRun') as ISubagentTool | undefined;
    const advertisedTool = wireTools.find((tool) => tool.name === 'AgentRun');
    const advertisedProfiles = advertisedTool !== undefined && typeof agentRun?.advertisedProfileDescriptions === 'function'
      ? [...agentRun.advertisedProfileDescriptions()].filter(([, entry]) => advertisedTool.description.includes(entry.line))
        .map(([name, entry]) => ({ name, ...entry })) : undefined;
    const payload: LlmRequestPayload = {
      kind: requestKindForRecord(fields),
      advertisedProfiles,
      provider: input.protocol,
      protocol: input.protocol,
      protocol_source: input.protocolSource,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      thinkingKeep: resolveThinkingKeep(
        overrides?.thinkingKeep,
        thinkingConfig?.keep,
        input.thinkingEffort ?? 'off',
      ),
      temperature: overrides?.temperature,
      topP: overrides?.topP,
      maxTokens: input.maxTokens,
      betaApi: modelConfig?.betaApi,
      toolSelect: this.toolSelect.enabled(),
      systemPromptHash,
      systemPrompt:
        input.systemPrompt === this.profile.data().systemPrompt
          ? undefined
          : input.systemPrompt,
      toolsHash,
      messageCount: input.messages.length,
      turnStep: stringField(fields, 'turnStep'),
      attempt: stringField(fields, 'attempt'),
      projection: projectionField(fields),
      droppedCount: numberField(fields, 'droppedCount'),
      anchorApplied: typeof fields['anchorApplied'] === 'boolean' ? fields['anchorApplied'] : undefined,
      cognitionRevision: numberField(fields, 'cognitionRevision'),
      bindingRevision: stringField(fields, 'bindingRevision'),
      anchorSteps: numberField(fields, 'anchorSteps'),
      anchorScope: fields['anchorScope'] === 'turn' || fields['anchorScope'] === 'session' ? fields['anchorScope'] : undefined,
    };
    void this.dispatcher.dispatch(new LlmRequest(payload));
  }

  private logResponse(
    fields: AgentLLMRequestLogFields | undefined,
    usage: TokenUsage,
    timing: ModelRequestTiming | undefined,
  ): void {
    if (timing === undefined) return;
    const payload: LogContext = {
      ...fields,
      ttftMs: timing.firstTokenLatencyMs,
      streamDurationMs: timing.streamDurationMs,
      outputTokens: usage.output,
    };
    if (timing.requestBuildMs !== undefined) payload['requestBuildMs'] = timing.requestBuildMs;
    if (timing.serverFirstTokenMs !== undefined) {
      payload['serverFirstTokenMs'] = timing.serverFirstTokenMs;
    }
    if (timing.serverDecodeMs !== undefined) payload['serverDecodeMs'] = timing.serverDecodeMs;
    if (timing.clientConsumeMs !== undefined) payload['clientConsumeMs'] = timing.clientConsumeMs;
    this.log.info('llm response', payload);
  }

  private defaultTools(): readonly Tool[] {
    return this.toolSelect
      .shapeTools(this.tools.list())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
  }
}

class MutableLLMRequestTrace implements LLMRequestTrace {
  traceId: string | undefined;

  set(traceId: string | undefined): void {
    this.traceId = traceId;
  }
}

function requestIdentityTurnKey(source: AgentLLMRequestSource | undefined): string {
  if (source?.turnId !== undefined) return `turn:${String(source.turnId)}`;
  return `operation:${source?.type === 'operation' ? (source.requestKind ?? 'unknown') : 'unknown'}:${randomUUID()}`;
}

function isResponsesTransportConfigSection(domain: string): boolean {
  switch (domain) {
    case DEFAULT_MODEL_SECTION:
    case DEFAULT_PROVIDER_SECTION:
    case MODELS_SECTION:
    case PROVIDERS_SECTION:
    case REQUEST_COMPRESSION_SECTION:
    case REQUEST_IDENTITY_SECTION:
    case RESPONSES_WEB_SOCKET_SECTION:
    case THINKING_SECTION:
    case 'modelOverrides':
      return true;
    default:
      return false;
  }
}

function responsesTransportKey(
  model: Model,
  identity: RequestIdentityAttemptContext,
): string {
  const value = {
    model: {
      id: model.id,
      name: model.name,
      protocol: model.protocol,
      providerName: model.providerName,
      providerType: model.providerType,
      baseUrl: model.baseUrl,
      headers: model.headers,
      requestCompression: model.requestCompression,
      providerOptions: model.providerOptions,
      responsesWebSocket: model.responsesWebSocket,
    },
    policy: identity.policy,
    hostRequestHeaders: identity.hostRequestHeaders,
    isKimiProvider: identity.isKimiProvider,
  };
  try {
    return fingerprint(JSON.stringify(value) ?? '');
  } catch {
    return fingerprint(`${model.id}\u0000${model.name}\u0000${model.providerName}`);
  }
}

function validateRequestIdentityHeaderCollisions(
  provider: ProviderConfig | undefined,
): void {
  for (const key of Object.keys(provider?.customHeaders ?? {})) {
    if (REQUEST_IDENTITY_RESERVED_HEADERS.has(key.toLowerCase())) {
      throw new Error2(
        RequestIdentityErrors.codes.REQUEST_IDENTITY_CONFLICT,
        `custom_headers.${key} conflicts with request_identity`,
      );
    }
  }
}

function stripRequestIdentityBodyParams(
  params: ModelRequestParams['requestParams'],
): ModelRequestParams['requestParams'] {
  if (params === undefined) return params;
  const reserved = new Set(['prompt_cache_key', 'client_metadata', 'metadata', 'metadata.user_id']);
  const entries = Object.entries(params).filter(([key]) => !reserved.has(key.toLowerCase()));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function withIdentityParams(
  params: ModelRequestParams['requestParams'],
  identity: Readonly<Record<string, string | number | boolean>> | undefined,
): ModelRequestParams['requestParams'] {
  if (identity === undefined) return params;
  return { ...params, ...identity };
}

function identityParamsOf(
  params: ModelRequestParams['requestParams'],
  policy: ResolvedRequestIdentityPolicy,
  catalog: IRequestIdentityCatalog,
  model: string,
): Record<string, string | number | boolean> {
  const names = Object.keys(catalog.render(policy, model)?.params ?? {});
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = params?.[name];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [[name, value]] : [];
    }),
  );
}

function isKimiProviderFamily(providerType: string | undefined): boolean {
  return (
    providerType !== undefined &&
    getProviderDefinition(providerType)?.requestIdentityDeviceHeaders === true
  );
}

function resolveRequestIdentityDimensions(
  policy: ResolvedRequestIdentityPolicy,
  isKimiProvider: boolean,
  hostHeaders: Readonly<Record<string, string>>,
): RequestIdentityDimensions {
  const format = policy.lineage.format;
  const hostHasDeviceIdentity = Object.entries(hostHeaders).some(([name, value]) => {
    if (name.toLowerCase() !== 'x-msh-device-id') return false;
    const cleaned = value.replaceAll(/[^\u0020-\u007E]/gu, '').trim();
    return cleaned.length > 0 && cleaned !== 'unknown';
  });
  return {
    installationIdentity:
      policy.client.installationIdentity === 'persistent_local' &&
      (format === 'codex' ||
        format === 'grok_build' ||
        format === 'claude_code' ||
        (format === 'kimi_code' && isKimiProvider && !hostHasDeviceIdentity)),
    sharedSessionIdentity:
      policy.lineage.sessionScope === 'shared_session' && policy.preset !== 'kimi_code',
    agentSessionIdentity: policy.lineage.sessionScope === 'agent_session',
    threadIdentity:
      policy.lineage.threadIdentity === 'agent' ||
      policy.lineage.parentThread === 'immediate_agent',
    logicalRequestIdentity:
      policy.request.logicalId === 'turn' || policy.lineage.turnAncestry === 'spawn_context',
    turnIndex: policy.request.turnIndex === 'agent_session',
    turnState: policy.responsesMetadata === 'codex',
  };
}

function hasRequestIdentityDimensions(dimensions: RequestIdentityDimensions): boolean {
  return Object.values(dimensions).some(Boolean);
}

function emptyRequestIdentitySnapshot(): RequestIdentitySnapshot {
  return { setTurnState: () => undefined };
}

function logFieldsForSource(source: AgentLLMRequestSource | undefined): AgentLLMRequestLogFields {
  switch (source?.type) {
    case 'turn':
      return {
        ...source.logFields,
        ...(source.step === undefined
          ? {}
          : { turnStep: `${String(source.turnId)}.${String(source.step)}` }),
      };
    case 'operation':
      return {
        ...source.logFields,
        ...(source.requestKind === undefined ? {} : { requestKind: source.requestKind }),
      };
    default:
      return {};
  }
}

function requestKindForTelemetry(source: AgentLLMRequestSource | undefined): string | undefined {
  if (source?.type === 'turn') return 'turn';
  if (source?.type === 'operation') return source.requestKind ?? 'operation';
  return undefined;
}

function providerVisibleTools(tools: readonly Tool[]): readonly Tool[] {
  if (!tools.some((tool) => tool.deferred === true)) return tools;
  return tools.filter((tool) => tool.deferred !== true);
}

function toolSignature(tools: readonly Tool[]): readonly LlmRequestToolSchema[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function requestKindForRecord(fields: AgentLLMRequestLogFields): LlmRequestPayload['kind'] {
  if (fields['kind'] === 'compaction') return 'compaction';
  if (fields['requestKind'] === 'full_compaction') return 'compaction';
  return 'loop';
}

function isUnchangedModelHistory(before: readonly Message[], after: readonly Message[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((message, index) => {
    const sent = after[index];
    return sent !== undefined && message.role === sent.role && message.name === sent.name &&
      message.toolCallId === sent.toolCallId && message.partial === sent.partial &&
      message.toolCalls === sent.toolCalls && message.tools === sent.tools &&
      message.content.length === sent.content.length &&
      message.content.every((part, partIndex) => part === sent.content[partIndex]);
  });
}

function stringField(fields: AgentLLMRequestLogFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(fields: AgentLLMRequestLogFields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' ? value : undefined;
}

type LlmRequestProjection = NonNullable<LlmRequestPayload['projection']>;

function projectionNameOf(policy: ProjectionPolicy | undefined): LlmRequestProjection | undefined {
  if (policy?.structure === 'strict') {
    if (policy.media === 'degraded') return 'strict-media-degraded';
    if (typeof policy.media === 'object') return 'strict-media-stripped';
    return 'strict';
  }
  if (policy === undefined) return undefined;
  if (policy.media === 'degraded') return 'media-degraded';
  if (typeof policy.media === 'object') return 'media-stripped';
  return undefined;
}

function projectionField(fields: AgentLLMRequestLogFields): LlmRequestProjection | undefined {
  const value = fields['projection'];
  switch (value) {
    case 'strict':
    case 'media-degraded':
    case 'media-stripped':
    case 'strict-media-degraded':
    case 'strict-media-stripped':
      return value;
    default:
      return undefined;
  }
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function apiStatusCode(error: unknown): number | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError) return raw.statusCode;
  if (typeof raw === 'object' && raw !== null) {
    const statusCode = (raw as Record<string, unknown>)['statusCode'];
    if (typeof statusCode === 'number') return statusCode;
    const status = (raw as Record<string, unknown>)['status'];
    if (typeof status === 'number') return status;
  }
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const statusCode = (details as Record<string, unknown>)['statusCode'];
      if (typeof statusCode === 'number') return statusCode;
    }
  }
  return undefined;
}

function apiTraceId(error: unknown): string | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError && raw.traceId !== null) return raw.traceId;
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const traceId = (details as Record<string, unknown>)['traceId'];
      if (typeof traceId === 'string') return traceId;
    }
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  ScopeActivation.OnScopeCreated,
  'llmRequester',
);
