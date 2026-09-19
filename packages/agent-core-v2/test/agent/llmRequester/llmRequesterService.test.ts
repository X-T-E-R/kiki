import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
  type ProjectionPolicy,
} from '#/agent/contextProjector/contextProjector';
import { AgentContextProjectorService } from '#/agent/contextProjector/contextProjectorService';
import { IAgentCognitionAnchorService } from '#/agent/cognition/cognitionAnchor';
import {
  AgentLLMRequesterService,
  KIKI_INFINITE_RETRY_ENV,
} from '#/agent/llmRequester/llmRequesterService';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestSource,
} from '#/agent/llmRequester/llmRequester';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IWebSearchTool } from '#/agent/tools/web-search/web-search';
import { WebSearchTool } from '#/agent/tools/web-search/webSearchTool';
import {
  appendSharedPromptField,
} from '#/app/promptField/builtinPromptFields';
import { customPromptVariables, type PromptConfig } from '@kiki/agent-profiles/promptConfig';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import {
  IAgentUsageService,
  type UsageRecordContext,
} from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import { INbSearchService } from '#/app/nbSearch/nbSearch';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  APIStatusError,
} from '#/kosong/contract/errors';
import { emptyUsage, type TokenUsage } from '#/kosong/contract/usage';
import {
  isToolCall,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from '#/kosong/contract/message';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import type { ModelCapability } from '#/kosong/contract/capability';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import type { ProvidersSection } from '#/kosong/provider/provider';
import type { RequestIdentityPolicy } from '#/kosong/requestIdentity/requestIdentityPolicy';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import {
  type ModelRequestEvent,
  type ModelRequestInput,
  type ModelRequester,
  type ModelRequestParams,
} from '#/kosong/model/modelRequester';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { WireRecord } from '#/wire/record';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  IRequestIdentityRegistry,
  type RequestIdentityDimensions,
} from '#/session/requestIdentity/requestIdentityRegistry';
import {
  ISessionMetadata,
  type AgentMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';

import {
  recordingWireLog,
  registerTestAgentWire,
  registerTestEventDispatcher,
} from '../../wire/stubs';

const capabilities: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: false,
  max_context_tokens: 1000,
};

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
];

type ProjectionKind = 'normal' | 'strict' | 'degraded' | 'stripped';

function classifyProjectionPolicy(policy: ProjectionPolicy | undefined): ProjectionKind {
  if (typeof policy?.media === 'object') return 'stripped';
  if (policy?.media === 'degraded') return 'degraded';
  if (policy?.structure === 'strict') return 'strict';
  return 'normal';
}

function recordProjectionCalls(): {
  projector: Pick<IAgentContextProjectorService, 'project'>;
  calls: ProjectionKind[];
} {
  const calls: ProjectionKind[] = [];
  return {
    projector: {
      project: (messages: readonly ContextMessage[], policy) => {
        calls.push(classifyProjectionPolicy(policy));
        return messages;
      },
    },
    calls,
  };
}

function createRequester(
  calls: { value: number },
  firstCallError?: Error | null,
  subsequentCallErrors: readonly Error[] = [],
  capturedInputs?: ModelRequestInput[],
  modelOverrides?: Partial<Model>,
): ModelRequester {
  const model: Model = {
    id: 'm',
    name: 'wire-model',
    aliases: [],
    protocol: 'anthropic',
    baseUrl: 'https://example.test',
    headers: {},
    capabilities,
    maxContextSize: 1000,
    alwaysThinking: false,
    providerName: 'p',
    authProvider: { getAuth: async () => undefined },
    ...modelOverrides,
    imagePolicy: modelOverrides?.imagePolicy ?? {
      acceptedTypes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      convertUnsupported: 'off',
    },
  };
  return {
    model,
    request: async function* (input) {
      calls.value += 1;
      capturedInputs?.push(input);
      const error =
        calls.value === 1
          ? firstCallError === null
            ? undefined
            : (firstCallError ??
              new APIStatusError(400, 'messages: `tool_use` ids must be unique'))
          : subsequentCallErrors[calls.value - 2];
      if (error !== undefined) throw error;
      yield {
        type: 'finish',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
        id: 'resp-1',
      };
    },
  };
}

let disposables: DisposableStore;

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => disposables.dispose());

function createService(
  requester: ModelRequester,
  projector:
    | (Pick<IAgentContextProjectorService, 'project'> &
        Partial<Pick<IAgentContextProjectorService, 'captureMediaStripSnapshot'>>)
    | undefined,
  options: {
    readonly thinkingLevel?: ThinkingEffort;
    readonly mediaResolver?: Partial<IAgentMediaResolverService>;
    readonly contextMessages?: Message[];
    readonly sessionId?: string;
    readonly agentId?: string;
    readonly agentMeta?: AgentMeta;
    readonly requestParams?: ModelRequestParams;
    readonly providers?: ProvidersSection;
    readonly models?: Record<string, ModelRecord>;
    readonly modelAlias?: { value: string };
    readonly globalRequestIdentity?: { value: RequestIdentityPolicy | undefined };
    readonly identitySnapshotCalls?: { value: number };
    readonly identityDimensions?: RequestIdentityDimensions[];
    readonly hostRequestHeaders?: Readonly<Record<string, string>>;
    readonly env?: Record<string, string>;
    readonly nativeWebSearch?: boolean;
    readonly nbSearch?: Partial<INbSearchService>;
    readonly promptConfig?: { value: PromptConfig };
    readonly promptRefresh?: () => Promise<void>;
    readonly systemPrompt?: () => string;
  } = {},
) {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-code-llm-requester-test', options.env ?? {}));
  const thinkingLevel = options.thinkingLevel ?? 'off';
  const sessionId = options.sessionId ?? 'session-test';
  const agentId = options.agentId ?? 'main';
  const agentMeta = options.agentMeta ?? { type: agentId === 'main' ? 'main' : 'sub' };
  const selectedModelAlias = (): string => options.modelAlias?.value ?? 'm';
  const promptFields = () => ({
    values: options.promptConfig?.value.overrides?.fields ?? {},
    fields: [],
  });
  const profile: Partial<IAgentProfileService> = {
    resolveModelContext: () => ({
      modelAlias: selectedModelAlias(),
      modelCapabilities: capabilities,
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      thinkingLevel,
      reservedContextSize: undefined,
      compactionTriggerRatio: undefined,
      compactionMaxAttempts: undefined,
      compactionSoftContextSize: undefined,
    }),
    resolveRequestParams: () => options.requestParams ?? { cacheKey: sessionId },
    getSystemPrompt: () => appendSharedPromptField(
      options.systemPrompt?.() ?? 'system',
      promptFields(),
      customPromptVariables(options.promptConfig?.value.variables),
    ),
    getPromptFieldSnapshot: () => promptFields(),
    refreshSystemPrompt: options.promptRefresh ?? (async () => undefined),
    preparePromptConfiguration: (() => {
      let signature = '';
      return async () => {
        const next = JSON.stringify(options.promptConfig?.value ?? {});
        if (next === signature) return false;
        await options.promptRefresh?.();
        signature = next;
        return true;
      };
    })(),
    data: () => ({
      cwd: '',
      modelAlias: selectedModelAlias(),
      modelCapabilities: capabilities,
      thinkingLevel,
      systemPrompt: 'system',
    }),
  };
  const measuredCalls: { readonly messages: number; readonly usage: TokenUsage }[] = [];
  const tokenCounting = {
    get: () => ({ size: 0, measured: 0, estimated: 0 }),
    measured: (input: readonly Message[], _output: readonly Message[], usage: TokenUsage) => {
      measuredCalls.push({ messages: input.length, usage });
    },
  };
  const usageRecords: {
    readonly model: string;
    readonly usage: TokenUsage;
    readonly source?: AgentLLMRequestSource;
    readonly context?: UsageRecordContext;
  }[] = [];
  const usage = {
    record: (
      model: string,
      usage: TokenUsage,
      source?: AgentLLMRequestSource,
      context?: UsageRecordContext,
    ) => {
      usageRecords.push({ model, usage, source, context });
    },
    status: () => ({}),
  };
  const context = {
    get: () => options.contextMessages ?? history,
  };
  const tools = { list: () => [] };
  const config: Partial<IConfigService> = {
    get: ((section: string) => {
      if (section === 'prompt') return options.promptConfig?.value;
      if (section === 'providers') return options.providers;
      if (section === 'requestIdentity') return options.globalRequestIdentity?.value;
      return undefined;
    }) as IConfigService['get'],
  };
  const log = { info: () => undefined, warn: () => undefined };
  const telemetryRecords: TelemetryRecord[] = [];
  const telemetry = recordingTelemetry(telemetryRecords);
  const toolSelect: Partial<IAgentToolSelectService> = {
    enabled: () => false,
    shapeTools: (entries) => entries,
    shapeHistory: (messages) => messages,
  };
  const testSnapshot = Object.freeze({}) as MediaStripSnapshot;
  const events: Event2[] = [];
  const eventBus: IEventBus = {
    _serviceBrand: undefined,
    publish: (event) => events.push(event),
    subscribe: () => toDisposable(() => {}),
  };

  ix.stub(IAgentContextMemoryService, context);
  ix.stub(ISessionContext, { sessionId });
  ix.stub(ISessionMetadata, {
    read: async () => ({
      id: sessionId,
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents: { [agentId]: agentMeta },
    }),
  });
  ix.stub(IAgentToolSelectService, toolSelect);
  ix.stub(IAgentMediaResolverService, options.mediaResolver ?? { resolve: async (messages) => messages });
  if (projector === undefined) {
    ix.set(
      IAgentContextProjectorService,
      new SyncDescriptor(AgentContextProjectorService),
    );
  } else {
    ix.stub(IAgentContextProjectorService, {
      captureMediaStripSnapshot: () => testSnapshot,
      ...projector,
    });
  }
  ix.stub(IAgentTokenCountingService, tokenCounting);
  ix.stub(IAgentToolRegistryService, tools);
  ix.stub(IAgentProfileService, profile);
  ix.stub(IAgentCognitionAnchorService, {
    project: async () => undefined,
  });
  ix.stub(IAgentUsageService, usage);
  ix.stub(IConfigService, config);
  ix.stub(INbSearchService, { prepareToolDescriptions: async () => undefined, ...options.nbSearch });
  if (options.nativeWebSearch) {
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IWebSearchTool, new SyncDescriptor(WebSearchTool));
    ix.get(IAgentToolRegistryService).register(ix.get(IWebSearchTool));
  }
  ix.stub(IBootstrapService, {
    clientIdentity: { productName: 'test', version: '1.0.0', platform: 'test' },
    platform: 'linux',
    arch: 'x64',
    getEnv: (name) => options.env?.[name],
    args: {
      requestHeaders: options.hostRequestHeaders ?? {
        'X-Msh-Device-Name': 'example-host',
        'X-Msh-Device-Model': 'Example Model',
        'X-Msh-Os-Version': 'Example OS 1',
        'X-Msh-Device-Id': '00000000-0000-4000-8000-000000000009',
      },
    },
  });
  ix.stub(IRequestIdentityRegistry, {
    snapshot: async (input) => {
      if (options.identitySnapshotCalls !== undefined) options.identitySnapshotCalls.value += 1;
      if (input.dimensions !== undefined) options.identityDimensions?.push(input.dimensions);
      return {
        installationId: '00000000-0000-4000-8000-000000000001',
        sharedSessionId: '00000000-0000-4000-8000-000000000002',
        threadId: '00000000-0000-4000-8000-000000000002',
        agentSessionId: '00000000-0000-4000-8000-000000000003',
        logicalId: '00000000-0000-7000-8000-000000000004',
        turnIndex: 1,
        windowId: '00000000-0000-4000-8000-000000000002:1',
        setTurnState: () => undefined,
      };
    },
  });
  ix.stub(ILogService, log);
  ix.stub(ITelemetryService, telemetry);
  ix.stub(IModelCatalog, {
    _serviceBrand: undefined,
    get: () => requester.model,
    getRequester: () => requester,
    findByName: () => [],
  });
  ix.stub(IModelService, {
    resolveId: (id) => (options.models?.[id] === undefined ? undefined : id),
    get: (id) => options.models?.[id],
  });
  const records: WireRecord[] = [];
  registerTestAgentWire(ix, 'wire/llm-requester', {
    log: recordingWireLog(records),
    eventBus,
  });
  ix.stub(IAgentScopeContext, { agentId, scope: () => `agents/${agentId}` });
  registerTestEventDispatcher(ix);
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IAgentLLMRequesterService, new SyncDescriptor(AgentLLMRequesterService));

  return {
    service: ix.get(IAgentLLMRequesterService),
    dispatcher: ix.get(IEventDispatcher),
    records,
    events,
    telemetryRecords,
    measuredCalls,
    usageRecords,
  };
}

function captureRequestParams(requester: ModelRequester): ModelRequestParams[] {
  const captured: ModelRequestParams[] = [];
  const request = requester.request.bind(requester);
  requester.request = async function* (input, signal, params) {
    captured.push(params ?? {});
    yield* request(input, signal, params);
  };
  return captured;
}

describe('AgentLLMRequesterService prompt snapshot invalidation', () => {
  it('keeps a turn prompt stable until an explicit safe-boundary invalidation', async () => {
    const captured: ModelRequestInput[] = [];
    const requester = createRequester({ value: 0 }, null, [], captured);
    let systemPrompt = 'prompt-old';
    const { service } = createService(requester, undefined, { systemPrompt: () => systemPrompt });
    await service.request({ source: { type: 'turn', turnId: 7, step: 1 } });
    systemPrompt = 'prompt-new';
    await service.request({ source: { type: 'turn', turnId: 7, step: 2 } });
    expect(captured.map((input) => input.systemPrompt)).toEqual(['prompt-old', 'prompt-old']);

    expect(service.invalidatePromptSnapshots()).toBe(1);
    await service.request({ source: { type: 'turn', turnId: 7, step: 3 } });
    expect(captured.at(-1)?.systemPrompt).toBe('prompt-new');
  });
});

describe('AgentLLMRequesterService parameter budgets', () => {
  it('clamps output to the context budget even when operation history has no measured usage', async () => {
    const requester = createRequester({ value: 0 }, null);
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, { requestParams: { maxCompletionTokens: 5000 } });
    await service.request({ messages: history });
    expect(captured[0]).toMatchObject({ maxCompletionTokens: 1000, maxContextTokens: 1000 });
  });

  it('retains the resolved profile output ceiling despite a larger operation override', async () => {
    const requester = createRequester({ value: 0 }, null);
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, { requestParams: { maxCompletionTokens: 300 } });
    await service.request({ maxOutputSize: 900 });
    expect(captured[0]).toMatchObject({ maxCompletionTokens: 300, maxContextTokens: 1000, usedContextTokens: 0 });
  });
});

describe('AgentLLMRequesterService native tool and shared prompt preparation', () => {
  it.each(['main', 'standalone-child'])('sends lane schema, freshly prepared descriptions and shared guidance once for %s', async (agentId) => {
    const inputs: ModelRequestInput[] = [];
    let description = 'not prepared';
    const prepare = vi.fn(async () => { description = 'Default: exa.search; available sync: gma.research (typed research answer)'; });
    const promptConfig = { value: { variables: { search_guidance: 'Prefer native GMA SSE.' }, overrides: { fields: { 'system.shared': 'ALL_AGENTS', 'tool.web-search.description': 'CUSTOM SEARCH', 'tool.web-search.guidance': '${search_guidance}' } } } };
    const { service } = createService(createRequester({ value: 0 }, null, [], inputs), undefined, {
      agentId, nativeWebSearch: true, promptConfig,
      nbSearch: { prepareToolDescriptions: prepare, toolDescription: () => description },
    });
    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    for (const input of inputs) {
      expect(input.systemPrompt).toBe('system\n\nALL_AGENTS');
      const search = input.tools?.find((tool) => tool.name === 'WebSearch');
      const ajv = new Ajv({ strict: false });
      addFormats(ajv);
      const validate = ajv.compile(search!.parameters);
      expect(validate({ query: 'example', lane: 'gma.research' })).toBe(true);
      expect(validate({ action: 'read', job_id: '00000000-0000-4000-8000-000000000001', page_size: 2 })).toBe(true);
      expect(validate({ query: 'example', unknown_field: true })).toBe(false);
      expect(search?.description).toContain('CUSTOM SEARCH');
      expect(search?.description).toContain('available sync: gma.research');
      expect(search?.description).toContain('Prefer native GMA SSE.');
      expect(search?.description).not.toContain('not prepared');
    }
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('omits disabled-tool guidance and preserves explicit overrides while refreshing configured variables next request', async () => {
    const inputs: ModelRequestInput[] = [];
    const promptConfig: { value: PromptConfig } = { value: { variables: { value: 'first', search_guidance: 'SEARCH_ONLY' }, overrides: { fields: { 'system.shared': 'Shared ${value}', 'tool.web-search.guidance': '${search_guidance}' } } } };
    let base = 'first base';
    const refresh = vi.fn(async () => { base = `${promptConfig.value.variables?.['value']} base`; });
    const prepare = vi.fn();
    const { service } = createService(createRequester({ value: 0 }, null, [], inputs), undefined, {
      promptConfig, promptRefresh: refresh, systemPrompt: () => base,
      nbSearch: { prepareToolDescriptions: prepare },
    });
    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    promptConfig.value = { ...promptConfig.value, variables: { value: 'second', search_guidance: 'SEARCH_ONLY' } };
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    await service.request({ source: { type: 'turn', turnId: 2, step: 1 } });
    await service.request({ systemPrompt: 'EXPLICIT', tools: [], source: { type: 'operation', requestKind: 'test' } });
    expect(inputs.map((input) => input.systemPrompt)).toEqual(['first base\n\nShared first', 'first base\n\nShared first', 'second base\n\nShared second', 'EXPLICIT\n\nShared second']);
    expect(JSON.stringify(inputs)).not.toContain('SEARCH_ONLY');
    expect(prepare).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('AgentLLMRequesterService request attribution headers', () => {
  it('projects a complete Codex-compatible Responses identity', async () => {
    const identityDimensions: RequestIdentityDimensions[] = [];
    const requester = createRequester({ value: 0 }, null, [], undefined, {
      protocol: 'openai_responses',
      providerType: 'openai',
    });
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, {
      providers: { p: { requestIdentity: { preset: 'codex_compatible' } } },
      identityDimensions,
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(captured[0]?.headers).toMatchObject({
      'session-id': '00000000-0000-4000-8000-000000000002',
      'thread-id': '00000000-0000-4000-8000-000000000002',
      'x-client-request-id': '00000000-0000-4000-8000-000000000002',
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/1.0.0 (linux; x64)',
    });
    expect(captured[0]?.cacheKey).toBe('00000000-0000-4000-8000-000000000002');
    expect(captured[0]?.requestIdentity?.responsesClientMetadata).toMatchObject({
      session_id: '00000000-0000-4000-8000-000000000002',
      thread_id: '00000000-0000-4000-8000-000000000002',
      turn_id: '00000000-0000-7000-8000-000000000004',
    });
    expect(identityDimensions).toEqual([{
      installationIdentity: true,
      sharedSessionIdentity: true,
      agentSessionIdentity: false,
      threadIdentity: true,
      logicalRequestIdentity: true,
      turnIndex: false,
      turnState: true,
    }]);
  });

  it('rejects Codex-compatible identity on Messages before the requester runs', async () => {
    const calls = { value: 0 };
    const identitySnapshotCalls = { value: 0 };
    const requester = createRequester(calls, null);
    const { service } = createService(requester, undefined, {
      providers: { p: { requestIdentity: { preset: 'codex_compatible' } } },
      identitySnapshotCalls,
    });

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toMatchObject({ code: 'request_identity.unsupported' });
    expect(calls.value).toBe(0);
    expect(identitySnapshotCalls.value).toBe(0);
  });

  it('projects Codex format with all identity leaves disabled without allocating a snapshot', async () => {
    const identitySnapshotCalls = { value: 0 };
    const requester = createRequester({ value: 0 }, null, [], undefined, {
      protocol: 'openai_responses',
    });
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, {
      providers: {
        p: {
          requestIdentity: {
            preset: 'none',
            overrides: {
              lineage: { format: 'codex' },
              client: { userAgent: 'host' },
            },
          },
        },
      },
      identitySnapshotCalls,
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(identitySnapshotCalls.value).toBe(0);
    expect(captured[0]?.headers).toBeUndefined();
    expect(captured[0]?.cacheKey).toBeUndefined();
    expect(captured[0]?.requestIdentity).toMatchObject({
      suppressUserAgent: false,
      suppressIdentity: false,
      responsesClientMetadata: undefined,
    });
  });

  it('rejects case-insensitive policy-owned custom header collisions before the requester runs', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, null, [], undefined, {
      protocol: 'openai_responses',
    });
    const { service } = createService(requester, undefined, {
      providers: {
        p: {
          requestIdentity: { preset: 'codex_compatible' },
          customHeaders: { 'X-Codex-Installation-Id': 'user-supplied' },
        },
      },
    });

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toMatchObject({ code: 'request_identity.conflict' });
    expect(calls.value).toBe(0);
  });

  it('rejects Kimi Code device-header collisions before the requester runs', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, null, [], undefined, { providerType: 'kimi' });
    const { service } = createService(requester, undefined, {
      providers: {
        p: {
          requestIdentity: { preset: 'kimi_code' },
          customHeaders: { 'x-MsH-DeViCe-Id': 'user-supplied' },
        },
      },
    });

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toMatchObject({ code: 'request_identity.conflict' });
    expect(calls.value).toBe(0);
  });

  it('projects Grok Build identity without Messages cache metadata', async () => {
    const identityDimensions: RequestIdentityDimensions[] = [];
    const requester = createRequester({ value: 0 }, null);
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, {
      providers: { p: { requestIdentity: { preset: 'grok_build_compatible' } } },
      identityDimensions,
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(captured[0]?.headers).toMatchObject({
      'x-grok-conv-id': '00000000-0000-4000-8000-000000000003',
      'x-grok-session-id': '00000000-0000-4000-8000-000000000003',
      'x-grok-req-id': '00000000-0000-7000-8000-000000000004',
      'x-grok-turn-idx': '1',
      'x-grok-agent-id': '00000000-0000-4000-8000-000000000001',
      'x-grok-model-override': 'wire-model',
    });
    expect(captured[0]?.cacheKey).toBeUndefined();
    expect(identityDimensions).toEqual([{
      installationIdentity: true,
      sharedSessionIdentity: false,
      agentSessionIdentity: true,
      threadIdentity: false,
      logicalRequestIdentity: true,
      turnIndex: true,
      turnState: false,
    }]);
  });

  it('reads an override-only global request identity layer', async () => {
    const requester = createRequester({ value: 0 }, null, [], undefined, {
      protocol: 'openai_responses',
    });
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, {
      globalRequestIdentity: {
        value: {
          overrides: { client: { originator: { mode: 'custom', value: 'global-client' } } },
        },
      },
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(captured[0]?.headers?.['originator']).toBe('global-client');
    expect(captured[0]?.headers?.['User-Agent']).toBe('kimi-code-cli/1.0.0');
  });

  it('resolves two selected aliases on the same provider with different model layers', async () => {
    const requester = createRequester({ value: 0 }, null, [], undefined, {
      protocol: 'openai_responses',
    });
    const captured = captureRequestParams(requester);
    const modelAlias = { value: 'a' };
    const models: Record<string, ModelRecord> = {
      a: { requestIdentity: { preset: 'grok_build_compatible' } },
      b: { requestIdentity: { preset: 'none' } },
    };
    const { service } = createService(requester, undefined, { modelAlias, models });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    modelAlias.value = 'b';
    await service.request({ source: { type: 'turn', turnId: 2, step: 1 } });

    expect(captured[0]?.headers).toHaveProperty('x-grok-conv-id');
    expect(captured[1]?.headers).toEqual({
      'x-kiki-internal-suppress-request-identity': '1',
    });
  });

  it('freezes global and model policy changes until the next turn', async () => {
    const requester = createRequester({ value: 0 }, null, [], undefined, {
      protocol: 'openai_responses',
    });
    const captured = captureRequestParams(requester);
    const globalRequestIdentity: { value: RequestIdentityPolicy | undefined } = {
      value: { preset: 'grok_build_compatible' },
    };
    const models: Record<string, ModelRecord> = {
      m: { requestIdentity: { overrides: { client: { userAgent: 'host' } } } },
    };
    const { service } = createService(requester, undefined, {
      globalRequestIdentity,
      models,
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    globalRequestIdentity.value = { preset: 'codex_compatible' };
    models['m'] = { requestIdentity: { overrides: { cache: { responses: 'none' } } } };
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    await service.request({ source: { type: 'turn', turnId: 2, step: 1 } });

    expect(captured[1]?.headers).toEqual(captured[0]?.headers);
    expect(captured[1]?.cacheKey).toBe(captured[0]?.cacheKey);
    expect(captured[2]?.headers).toHaveProperty('session-id');
    expect(captured[2]?.cacheKey).toBeUndefined();
  });

  it('snapshots policy and identity for every step in a turn', async () => {
    const requester = createRequester({ value: 0 }, null, [], undefined, {
      protocol: 'openai_responses',
    });
    const captured = captureRequestParams(requester);
    const providers: ProvidersSection = {
      p: { requestIdentity: { preset: 'grok_build_compatible' } },
    };
    const { service } = createService(requester, undefined, { providers });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    providers['p'] = { requestIdentity: { preset: 'none' } };
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    await service.request({ source: { type: 'turn', turnId: 2, step: 1 } });

    expect(captured[1]?.headers).toEqual(captured[0]?.headers);
    expect(captured[1]?.cacheKey).toBe(captured[0]?.cacheKey);
    expect(captured[2]?.headers).toEqual({
      'x-kiki-internal-suppress-request-identity': '1',
    });
  });

  it('suppresses policy headers, cache identity, and User-Agent for true none', async () => {
    const identitySnapshotCalls = { value: 0 };
    const requester = createRequester({ value: 0 }, null, [], undefined, {
      protocol: 'openai_responses',
    });
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, {
      providers: { p: { requestIdentity: { preset: 'none' } } },
      requestParams: {
        requestParams: {
          prompt_cache_key: 'caller-cache-key',
          client_metadata: 'caller-metadata',
          seed: 42,
        },
      },
      identitySnapshotCalls,
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(captured[0]?.cacheKey).toBeUndefined();
    expect(captured[0]?.headers).toEqual({
      'x-kiki-internal-suppress-request-identity': '1',
    });
    expect(captured[0]?.requestIdentity?.suppressUserAgent).toBe(true);
    expect(captured[0]?.requestIdentity?.suppressIdentity).toBe(true);
    expect(captured[0]?.requestParams).toEqual({ seed: 42 });
    expect(identitySnapshotCalls.value).toBe(0);
  });

  it('fails closed for true none when an adapter has no final-fetch suppression seam', async () => {
    const calls = { value: 0 };
    const identitySnapshotCalls = { value: 0 };
    const requester = createRequester(calls, null, [], undefined, { protocol: 'openai' });
    const { service } = createService(requester, undefined, {
      providers: { p: { requestIdentity: { preset: 'none' } } },
      identitySnapshotCalls,
    });

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toMatchObject({ code: 'request_identity.unsupported' });
    expect(calls.value).toBe(0);
    expect(identitySnapshotCalls.value).toBe(0);
  });

  it('projects Kimi Code identity by provider family without x-kiki lineage', async () => {
    for (const [providerType, hasDeviceIdentity] of [
      ['kimi', true],
      ['openai', false],
    ] as const) {
      const requester = createRequester({ value: 0 }, null, [], undefined, { providerType });
      const captured = captureRequestParams(requester);
      const identitySnapshotCalls = { value: 0 };
      const { service } = createService(requester, undefined, {
        sessionId: 'session-main',
        identitySnapshotCalls,
      });

      await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

      expect(captured[0]?.headers?.['User-Agent']).toBe('kimi-code-cli/1.0.0');
      expect(captured[0]?.headers?.['X-Msh-Device-Id'] !== undefined).toBe(hasDeviceIdentity);
      if (hasDeviceIdentity) {
        expect(captured[0]?.headers).toMatchObject({
          'X-Msh-Platform': 'kimi_code_cli',
          'X-Msh-Version': '1.0.0',
          'X-Msh-Device-Name': 'example-host',
          'X-Msh-Device-Model': 'Example Model',
          'X-Msh-Os-Version': 'Example OS 1',
          'X-Msh-Device-Id': '00000000-0000-4000-8000-000000000009',
        });
      }
      expect(captured[0]?.headers).not.toHaveProperty('x-kiki-session-id');
      expect(captured[0]?.headers).not.toHaveProperty('x-kiki-agent-id');
      expect(captured[0]?.cacheKey).toBe('session-main');
      expect(identitySnapshotCalls.value).toBe(0);
    }
  });

  it('allocates only installation identity when Kimi host device identity is unavailable', async () => {
    const requester = createRequester({ value: 0 }, null, [], undefined, { providerType: 'kimi' });
    const captured = captureRequestParams(requester);
    const identityDimensions: RequestIdentityDimensions[] = [];
    const { service } = createService(requester, undefined, {
      sessionId: 'session-main',
      hostRequestHeaders: {},
      identityDimensions,
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(captured[0]?.headers?.['X-Msh-Device-Id']).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(identityDimensions).toEqual([{
      installationIdentity: true,
      sharedSessionIdentity: false,
      agentSessionIdentity: false,
      threadIdentity: false,
      logicalRequestIdentity: false,
      turnIndex: false,
      turnState: false,
    }]);
  });

  it('keeps canonical session, agent, turn, and lineage inputs unchanged', async () => {
    const agentMeta = Object.freeze({
      type: 'sub' as const,
      parentAgentId: 'main',
      labels: Object.freeze({ parentAgentId: 'main', swarmItem: 'review' }),
    });
    const source = Object.freeze({ type: 'turn' as const, turnId: 7, step: 2 });
    const requester = createRequester({ value: 0 }, null, [], undefined, { providerType: 'kimi' });
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, {
      sessionId: 'canonical-session',
      agentId: 'canonical-agent',
      agentMeta,
    });

    await service.request({ source });

    expect(source).toEqual({ type: 'turn', turnId: 7, step: 2 });
    expect(agentMeta).toEqual({
      type: 'sub',
      parentAgentId: 'main',
      labels: { parentAgentId: 'main', swarmItem: 'review' },
    });
    expect(captured[0]?.cacheKey).toBe('canonical-session');
    expect(captured[0]?.headers?.['X-Msh-Device-Id']).not.toBe('canonical-session');
    expect(captured[0]?.headers?.['X-Msh-Device-Id']).not.toBe('canonical-agent');
  });

  it('projects custom originator only through the new policy axis', async () => {
    const requester = createRequester({ value: 0 }, null, [], undefined, {
      protocol: 'openai_responses',
    });
    const captured = captureRequestParams(requester);
    const { service } = createService(requester, undefined, {
      providers: {
        p: {
          requestIdentity: {
            preset: 'kimi_code',
            overrides: { client: { originator: { mode: 'custom', value: 'example-client' } } },
          },
        },
      },
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(captured[0]?.headers?.['originator']).toBe('example-client');
  });
});

describe('AgentLLMRequesterService measured anchors', () => {
  it('skips the measured anchor when the stream reports no usage', async () => {
    const { service, measuredCalls } = createService(createRequester({ value: 0 }), undefined);

    await service.request();

    expect(measuredCalls).toHaveLength(0);
  });

  it('writes the measured anchor from the reported usage', async () => {
    const requester = createRequester({ value: 0 });
    const base = requester.request.bind(requester);
    requester.request = async function* (input, signal, options) {
      yield {
        type: 'usage',
        usage: { inputOther: 40, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
        model: 'wire-model',
      };
      yield* base(input, signal, options);
    };
    const { service, measuredCalls } = createService(requester, undefined);

    await service.request();

    expect(measuredCalls).toHaveLength(1);
    expect(measuredCalls[0]?.usage.inputOther).toBe(40);
  });

  it('marks missing usage unknown while preserving provider-reported zero as known', async () => {
    const missing = createService(createRequester({ value: 0 }, null), undefined);
    await missing.service.request();
    expect(missing.usageRecords[0]?.usage).toEqual(emptyUsage());
    expect(missing.usageRecords[0]?.context?.usageKnown).toBe(false);

    const requester = createRequester({ value: 0 }, null);
    const base = requester.request.bind(requester);
    requester.request = async function* (input, signal, options) {
      yield { type: 'usage', usage: emptyUsage(), model: 'wire-model' };
      yield* base(input, signal, options);
    };
    const known = createService(requester, undefined);
    await known.service.request();
    expect(known.usageRecords[0]?.usage).toEqual(emptyUsage());
    expect(known.usageRecords[0]?.context?.usageKnown).toBe(true);
  });
});

describe('AgentLLMRequesterService Anthropic effort diagnostics', () => {
  it('warns and sends when the effort is not listed by the model', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, null);
    Object.defineProperty(requester.model, 'supportEfforts', { value: ['max'] });
    const { service, events } = createService(requester, undefined, { thinkingLevel: 'high' });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(1);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        type: 'warning',
        code: 'anthropic-thinking-effort-not-listed',
        message:
          'Thinking effort "high" is not listed for model "wire-model" (known: max). The configured value will be sent unchanged to the Anthropic-compatible backend.',
      }),
    ]);
  });
});

describe('AgentLLMRequesterService strict resend', () => {
  it('resends once with strict projection after a recoverable structural 400', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(createRequester(calls), projection.projector);

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.usage).toEqual(emptyUsage());
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'strict']);
  });

  it('does not resend for non-recoverable errors', async () => {
    const requester = createRequester({ value: 0 });
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(401, 'unauthorized');
      },
    });
    const projection = recordProjectionCalls();
    const { service } = createService(requester, projection.projector);

    await expect(service.request()).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(projection.calls).toEqual(['normal']);
  });
});

describe('AgentLLMRequesterService attempt retry notification', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies before resending with a repaired projection', async () => {
    const calls = { value: 0 };
    const { service } = createService(createRequester(calls), undefined);
    const onAttemptRetry = vi.fn();

    const result = await service.request({ onAttemptRetry });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(onAttemptRetry).toHaveBeenCalledTimes(1);
  });

  it('notifies before each indefinite-retry backoff', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIConnectionError('socket hang up'), [
      new APIConnectionError('socket hang up again'),
    ]);
    const { service } = createService(requester, undefined, {
      env: { [KIKI_INFINITE_RETRY_ENV]: '1' },
    });
    const onAttemptRetry = vi.fn();

    const promise = service.request({ onAttemptRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(calls.value).toBe(3);
    expect(onAttemptRetry).toHaveBeenCalledTimes(2);
  });

  it('does not notify when the error is final', async () => {
    const calls = { value: 0 };
    const { service } = createService(
      createRequester(calls, new APIStatusError(400, 'max_tokens must be positive')),
      undefined,
    );
    const onAttemptRetry = vi.fn();

    await expect(service.request({ onAttemptRetry })).rejects.toMatchObject({ statusCode: 400 });
    expect(onAttemptRetry).not.toHaveBeenCalled();
  });
});

describe('AgentLLMRequesterService infinite retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries every request error while KIKI_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken'), [
      new APIStatusError(404, 'model not found'),
      new APIConnectionError('socket hang up'),
      new APIProviderQuotaExhaustedError('quota exhausted'),
    ]);
    const { service } = createService(requester, undefined, {
      env: { [KIKI_INFINITE_RETRY_ENV]: '1' },
    });

    const promise = service.request();
    await vi.runAllTimersAsync();
    const finish = await promise;

    expect(calls.value).toBe(5);
    expect(finish.message.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('honors the provider retry-after delay while retrying indefinitely', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIProviderRateLimitError('slow down', null, 1));
    const { service } = createService(requester, undefined, {
      env: { [KIKI_INFINITE_RETRY_ENV]: '1' },
    });

    const startedAt = Date.now();
    await service.request();

    expect(calls.value).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('stops retrying when the caller aborts during the backoff wait', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken'));
    const { service } = createService(requester, undefined, {
      env: { [KIKI_INFINITE_RETRY_ENV]: '1' },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 100);

    const promise = service.request({}, undefined, controller.signal);
    const assertion = expect(promise).rejects.toThrow('stop');
    await vi.runAllTimersAsync();
    await assertion;

    expect(calls.value).toBe(1);
  });

  it('keeps deterministic projection recovery ahead of infinite retry', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIRequestTooLargeError(413, 'Request Entity Too Large'));
    const { service } = createService(requester, undefined, {
      env: { [KIKI_INFINITE_RETRY_ENV]: '1' },
    });

    await service.request();

    expect(calls.value).toBe(2);
  });

  it('lets context overflow reach deterministic recovery instead of retrying', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(
      calls,
      new APIContextOverflowError(400, 'context length exceeded'),
    );
    const { service } = createService(requester, undefined, {
      env: { [KIKI_INFINITE_RETRY_ENV]: '1' },
    });

    await expect(service.request()).rejects.toBeInstanceOf(APIContextOverflowError);
    expect(calls.value).toBe(1);
  });

  it('retries operation requests indefinitely', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken'), [
      new APIStatusError(404, 'model not found'),
    ]);
    const { service } = createService(requester, undefined, {
      env: { [KIKI_INFINITE_RETRY_ENV]: '1' },
    });

    const promise = service.request({
      source: { type: 'operation', requestKind: 'full_compaction' },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(calls.value).toBe(3);
  });

  it('does not retry when the switch is unset', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken'));
    const { service } = createService(requester, undefined);

    await expect(service.request()).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
  });
});

describe('AgentLLMRequesterService media-stripped resend', () => {
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );

  it('resends once with the media-stripped projection after an image-format 400', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(createRequester(calls, IMAGE_FORMAT_400), projection.projector);

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'stripped']);
  });

  it('keeps later steps of the same turn on the stripped projection', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(createRequester(calls, IMAGE_FORMAT_400), projection.projector);

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'stripped']);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projection.calls).toEqual(['normal', 'stripped', 'stripped']);
  });

  it('does not resend for an unrelated 400', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(calls, new APIStatusError(400, 'some other validation problem')),
      projection.projector,
    );

    await expect(service.request()).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
    expect(projection.calls).toEqual(['normal']);
  });
});

describe('AgentLLMRequesterService media-degraded resend', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');

  it('resends once with the media-degraded projection after an HTTP 413', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(
        calls,
        new Error2(ErrorCodes.PROVIDER_API_ERROR, 'Provider request failed', {
          cause: BODY_TOO_LARGE_413,
        }),
      ),
      projection.projector,
    );

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'degraded']);
  });

  it('falls back to media-stripped when the media-degraded request still receives 413', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413]),
      projection.projector,
    );

    const result = await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(3);
    expect(projection.calls).toEqual(['normal', 'degraded', 'stripped']);
  });

  it('records repeated-413 recovery projections on the sticky later request', async () => {
    const calls = { value: 0 };
    const { service, dispatcher, records } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413]),
      {
        project: (messages: readonly ContextMessage[]) => messages,
      },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    await dispatcher.flush();

    expect(
      records
        .filter((record) => record.type === 'llm.request')
        .map((record) => record['projection']),
    ).toEqual([undefined, 'media-degraded', 'media-stripped', 'media-stripped']);
  });

  it('keeps new recovery media visible on later snapshot-stripped steps', async () => {
    const calls = { value: 0 };
    const capturedInputs: ModelRequestInput[] = [];
    const oldUrl = 'data:image/png;base64,REJECTED';
    const newUrl = 'data:image/png;base64,SMALL';
    const imageMessage = (url: string, id: string): Message => ({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url, id } }],
      toolCalls: [],
    });
    const { service } = createService(
      createRequester(
        calls,
        BODY_TOO_LARGE_413,
        [BODY_TOO_LARGE_413],
        capturedInputs,
      ),
      undefined,
    );

    await service.request({
      messages: [imageMessage(oldUrl, 'rejected-id')],
      source: { type: 'turn', turnId: 1, step: 1 },
    });
    await service.request({
      messages: [
        imageMessage(oldUrl, 'rejected-id'),
        imageMessage(newUrl, 'recovery-id'),
      ],
      source: { type: 'turn', turnId: 1, step: 2 },
    });

    const visibleUrls = capturedInputs
      .at(-1)
      ?.messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'image_url')
      .map((part) => part.imageUrl.url);
    expect(visibleUrls).toEqual([newUrl]);
  });

  it('stops after the media-stripped request also receives 413', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413, BODY_TOO_LARGE_413]),
      projection.projector,
    );

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toBe(BODY_TOO_LARGE_413);
    expect(calls.value).toBe(3);
    expect(projection.calls).toEqual(['normal', 'degraded', 'stripped']);
  });

  it('keeps later steps of the same turn on the degraded projection', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(createRequester(calls, BODY_TOO_LARGE_413), projection.projector);

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'degraded']);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projection.calls).toEqual(['normal', 'degraded', 'degraded']);
  });

  it('does not resend for a plain 400 or a non-413 status', async () => {
    for (const error of [
      new APIStatusError(400, 'max_tokens must be positive'),
      new APIStatusError(422, 'unprocessable'),
    ]) {
      const calls = { value: 0 };
      const projection = recordProjectionCalls();
      const { service } = createService(createRequester(calls, error), projection.projector);

      await expect(service.request()).rejects.toBe(error);
      expect(calls.value).toBe(1);
      expect(projection.calls).toEqual(['normal']);
    }
  });
});

describe('AgentLLMRequesterService combined recovery projections', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );
  const STRUCTURAL_400 = new APIStatusError(400, 'messages: `tool_use` ids must be unique');

  function createPolicyRecordingProjector(policies: {
    policies: (ProjectionPolicy | undefined)[];
  }): Pick<IAgentContextProjectorService, 'project'> {
    return {
      project: (messages: readonly ContextMessage[], policy) => {
        policies.policies.push(policy);
        return messages;
      },
    };
  }

  it('accumulates media repairs on top of strict across repeated rejections', async () => {
    const calls = { value: 0 };
    const policies: (ProjectionPolicy | undefined)[] = [];
    const { service, dispatcher, records } = createService(
      createRequester(calls, STRUCTURAL_400, [BODY_TOO_LARGE_413, BODY_TOO_LARGE_413]),
      createPolicyRecordingProjector({ policies }),
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(calls.value).toBe(4);
    expect(policies).toEqual([
      undefined,
      { structure: 'strict' },
      { structure: 'strict', media: 'degraded' },
      { structure: 'strict', media: { strip: expect.anything() } },
    ]);
    await dispatcher.flush();
    expect(
      records.filter((record) => record.type === 'llm.request').map((record) => record['projection']),
    ).toEqual([undefined, 'strict', 'strict-media-degraded', 'strict-media-stripped']);
  });

  it('strips rejected images on top of strict after an image-format rejection on the strict resend', async () => {
    const calls = { value: 0 };
    const policies: (ProjectionPolicy | undefined)[] = [];
    const { service } = createService(
      createRequester(calls, STRUCTURAL_400, [IMAGE_FORMAT_400]),
      createPolicyRecordingProjector({ policies }),
    );

    await service.request();

    expect(calls.value).toBe(3);
    expect(policies.map((policy) => policy?.structure)).toEqual([undefined, 'strict', 'strict']);
    expect(typeof policies[2]?.media).toBe('object');
  });

  it('applies the strict repair on top of degraded media when a structural 400 follows a 413', async () => {
    const calls = { value: 0 };
    const policies: (ProjectionPolicy | undefined)[] = [];
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [STRUCTURAL_400]),
      createPolicyRecordingProjector({ policies }),
    );

    await service.request();

    expect(calls.value).toBe(3);
    expect(policies).toEqual([
      undefined,
      { media: 'degraded' },
      { structure: 'strict', media: 'degraded' },
    ]);
  });
});

describe('AgentLLMRequesterService trace id', () => {
  const passthroughProjector = {
    project: (messages: readonly ContextMessage[]) => messages,
  };

  function createTracedRequester(traceId: string | null): ModelRequester {
    const model: Model = {
      id: 'm',
      name: 'wire-model',
      aliases: [],
      protocol: 'openai',
      baseUrl: 'https://example.test',
      headers: {},
      capabilities,
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
      imagePolicy: {
        acceptedTypes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
        convertUnsupported: 'off',
      },
      authProvider: { getAuth: async () => undefined },
    };
    return {
      model,
      request: async function* (_input, _signal, requestOptions) {
        requestOptions?.onTraceId?.(traceId);
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          traceId: traceId ?? undefined,
        };
      },
    };
  }

  it('exposes the request trace and returns it on finish', async () => {
    const requester = createTracedRequester('trace-req-1');
    const headersArrived = createControlledPromise<void>();
    const releaseStream = createControlledPromise<void>();
    Object.defineProperty(requester, 'request', {
      value: async function* (_input: unknown, _signal: unknown, requestOptions: {
        onTraceId?: (traceId: string | null) => void;
      }) {
        requestOptions.onTraceId?.('trace-req-1');
        headersArrived.resolve();
        await releaseStream;
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          traceId: 'trace-req-1',
        } satisfies ModelRequestEvent;
      },
    });
    const { service } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 1, step: 1 } });
    await headersArrived;
    expect(request.trace.traceId).toBe('trace-req-1');
    releaseStream.resolve();
    const finish = await request.result;

    expect(finish.traceId).toBe('trace-req-1');
    expect(request.trace.traceId).toBe('trace-req-1');
  });

  it('reports an absent trace before a request that returns none', async () => {
    const { service } = createService(createTracedRequester(null), passthroughProjector);
    const request = service.start();
    const finish = await request.result;

    expect(finish.traceId).toBeUndefined();
    expect(request.trace.traceId).toBeUndefined();
  });

  it('attaches trace_id, turn_id and step_no to api_error from the failed request', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(500, 'boom', 'req-1', null, 'trace-fail-1');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 3, step: 2 } });
    await expect(request.result).rejects.toMatchObject({ statusCode: 500 });

    expect(telemetryRecords).toContainEqual({
      event: 'api_error',
      properties: expect.objectContaining({
        error_type: '5xx_server',
        trace_id: 'trace-fail-1',
        turn_id: 3,
        step_no: 2,
      }),
    });
    expect(request.trace.traceId).toBe('trace-fail-1');
  });

  it('keeps the header-captured trace when the request fails after headers arrived', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* (...args: unknown[]) {
        const requestOptions = args[2] as
          | { onTraceId?: (traceId: string | null) => void }
          | undefined;
        requestOptions?.onTraceId?.('trace-mid-stream');
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIEmptyResponseError('no content, no tool calls');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 4, step: 1 } });
    await expect(request.result).rejects.toThrow();

    const apiError = telemetryRecords.find((record) => record.event === 'api_error');
    expect(apiError?.properties?.['trace_id']).toBe('trace-mid-stream');
    expect(request.trace.traceId).toBe('trace-mid-stream');
  });

  it('clears the previous physical request trace before a projection retry', async () => {
    const requester = createTracedRequester(null);
    let attempts = 0;
    Object.defineProperty(requester, 'request', {
      value: async function* (...args: unknown[]) {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        attempts += 1;
        const requestOptions = args[2] as
          | { onTraceId?: (traceId: string | null) => void }
          | undefined;
        if (attempts === 1) {
          requestOptions?.onTraceId?.('trace-first-projection');
          throw new APIRequestTooLargeError(413, 'retry with degraded media');
        }
        throw new APIConnectionError('socket hang up');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start();
    await expect(request.result).rejects.toThrow('socket hang up');

    expect(attempts).toBe(2);
    expect(request.trace.traceId).toBeUndefined();
    expect(
      telemetryRecords.find((record) => record.event === 'api_error')?.properties?.['trace_id'],
    ).toBeUndefined();
  });
});

describe('AgentLLMRequesterService media resolver wiring', () => {
  it('resolves the projected messages through the DI-injected media resolver', async () => {
    const requester = createRequester({ value: 0 }, null);
    const resolve = vi.fn(async (messages: readonly Message[], _requester: ModelRequester) => messages);
    const { service } = createService(requester, undefined, {
      mediaResolver: { resolve },
    });

    await service.request();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[1]).toBe(requester);
  });
});

describe('AgentLLMRequesterService tool call id normalization', () => {
  function createScriptedRequester(
    script: { ids: string[]; error?: Error }[],
  ): ModelRequester {
    const base = createRequester({ value: 0 });
    let callIndex = 0;
    return {
      model: base.model,
      request: async function* () {
        const step = script[Math.min(callIndex++, script.length - 1)]!;
        if (step.error !== undefined) {
          if (step.ids.length > 0) {
            yield {
              type: 'part',
              part: {
                type: 'function',
                id: step.ids[0]!,
                name: 'Bash',
                arguments: null,
                _streamIndex: 0,
              },
            } satisfies ModelRequestEvent;
          }
          throw step.error;
        }
        const toolCalls: ToolCall[] = [];
        for (const [index, id] of step.ids.entries()) {
          yield {
            type: 'part',
            part: { type: 'function', id, name: 'Bash', arguments: null, _streamIndex: index },
          } satisfies ModelRequestEvent;
          yield {
            type: 'part',
            part: { type: 'tool_call_part', argumentsPart: '{"command":"ls"}', index },
          } satisfies ModelRequestEvent;
          toolCalls.push({ type: 'function', id, name: 'Bash', arguments: '{"command":"ls"}' });
        }
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [], toolCalls },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
        } satisfies ModelRequestEvent;
      },
    };
  }

  it('passes provider-unique ids through unchanged', async () => {
    const parts: StreamedMessagePart[] = [];
    const { service } = createService(
      createScriptedRequester([{ ids: ['call_1', 'call_2'] }]),
      undefined,
    );

    const result = await service.request({}, (part) => {
      parts.push(part);
    });

    expect(result.message.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect(parts.filter(isToolCall).map((p) => p.id)).toEqual(['call_1', 'call_2']);
  });

  it('rewrites an id repeated across responses and keeps streamed parts consistent', async () => {
    const parts: StreamedMessagePart[] = [];
    const { service } = createService(
      createScriptedRequester([{ ids: ['Bash_0'] }, { ids: ['Bash_0'] }]),
      undefined,
    );

    const first = await service.request({}, (part) => {
      parts.push(part);
    });
    const second = await service.request({}, (part) => {
      parts.push(part);
    });

    expect(first.message.toolCalls[0]!.id).toBe('Bash_0');
    expect(second.message.toolCalls[0]!.id).toBe('Bash_0__2');
    expect(parts.filter(isToolCall).map((p) => p.id)).toEqual(['Bash_0', 'Bash_0__2']);
  });

  it('rewrites duplicates within a single response', async () => {
    const { service } = createService(
      createScriptedRequester([{ ids: ['Bash_0', 'Bash_0'] }]),
      undefined,
    );

    const result = await service.request();

    expect(result.message.toolCalls.map((c) => c.id)).toEqual(['Bash_0', 'Bash_0__2']);
  });

  it('rolls claims back when the attempt fails mid-stream', async () => {
    const { service } = createService(
      createScriptedRequester([
        { ids: ['Bash_9'], error: new Error('stream boom') },
        { ids: ['Bash_9'] },
      ]),
      undefined,
    );

    await expect(service.request()).rejects.toThrow('stream boom');
    const retry = await service.request();
    expect(retry.message.toolCalls[0]!.id).toBe('Bash_9');
  });

  it('rewrites an id that already exists in the restored context', async () => {
    const { service } = createService(
      createScriptedRequester([{ ids: ['Bash_0'] }]),
      undefined,
      {
        contextMessages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ type: 'function', id: 'Bash_0', name: 'Bash', arguments: '{}' }],
          },
        ],
      },
    );

    const result = await service.request();
    expect(result.message.toolCalls[0]!.id).toBe('Bash_0__2');
  });
});
