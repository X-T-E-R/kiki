import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { IPluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { IFlagService } from '#/app/flag/flag';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { PluginUsageService } from '#/app/pluginUsage/pluginUsageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import type { ModelRequestInput, ModelRequestParams, ModelRequestEvent } from '#/kosong/model/modelRequester';
import type { FinishReason } from '#/kosong/contract/provider';
import { IOutputLayerService } from '#/app/outputLayer/outputLayer';
import { OutputLayerService } from '#/app/outputLayer/outputLayerService';
import { OUTPUT_LAYER_DEFAULT_PRESETS, OUTPUT_LAYER_DEFAULT_SETTINGS, type OutputLayerRequest } from '@kiki/protocol';
import { IConfigService } from '#/app/config/config';
import type { RetryConfig } from '#/agent/stepRetry/configSection';
import { APIConnectionError, APIStatusError, APIEmptyResponseError, APIProviderQuotaExhaustedError, markProviderEventError, noteExecutedRequestDelivery } from '#/kosong/contract/errors';
import type { StreamedMessagePart } from '#/kosong/contract/message';
import { attachErrorDetails } from '#/errors';

const containers: TestInstantiationService[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const ix of containers.splice(0)) await ix.dispose(); });

function setup(usageEnabled = true, retry?: RetryConfig) {
  const calls: { input: ModelRequestInput; params: ModelRequestParams; signal?: AbortSignal }[] = [];
  let enabled = true;
  let fail = false;
  let finishReason: FinishReason | undefined;
  let scripted: ((attempt: number) => AsyncIterable<ModelRequestEvent>) | undefined;
  const requester = {
    model: { id: 'chosen-model', name: 'remote-model', providerName: 'example-provider', maxContextSize: 32768 } as Model,
    async *request(input: ModelRequestInput, signal: AbortSignal | undefined, params: ModelRequestParams): AsyncIterable<ModelRequestEvent> {
      calls.push({ input: structuredClone(input), params, signal });
      signal?.throwIfAborted();
      if (scripted !== undefined) { yield* scripted(calls.length); return; }
      yield { type: 'part', part: { type: 'think', think: 'not displayed' } };
      yield { type: 'part', part: { type: 'text', text: 'old' } };
      yield { type: 'attempt.discarded', responseInstanceId: 'first' };
      yield { type: 'part', part: { type: 'text', text: '译文' } };
      if (fail) throw new Error('fixture provider failure');
      yield { type: 'finish', providerFinishReason: finishReason, rawFinishReason: 'length',
        message: { role: 'assistant', content: [{ type: 'text', text: '译文' }], toolCalls: [] } };
    },
  };
  const catalog = { getRequester: vi.fn(() => requester), getConnectionRequester: vi.fn(() => requester) };
  const hosts = { requestPanel: vi.fn(async () => ({ enabled: true, presets: OUTPUT_LAYER_DEFAULT_PRESETS, templates: OUTPUT_LAYER_DEFAULT_PRESETS, settings: OUTPUT_LAYER_DEFAULT_SETTINGS })) };
  const settings = { update: vi.fn(async () => ({ values: {}, secretsConfigured: [] })) };
  const ix = new TestInstantiationService(); containers.push(ix);
  let globalEnabled = true;
  const documents = new Map<string, unknown>();
  ix.stub(IAtomicDocumentStore, {
    get: async <T>(scope: string, key: string) => documents.get(`${scope}:${key}`) as T | undefined,
    set: async <T>(scope: string, key: string, value: T) => { documents.set(`${scope}:${key}`, value); },
  });
  ix.stub(IPluginService, { listPlugins: async () => enabled ? [{ id: 'kiki-output-layer', displayName: 'Output Layer', enabled: true, globalEnabled, state: 'ok',
    skillCount: 0, mcpServerCount: 0, enabledMcpServerCount: 0, hookCount: 0, commandCount: 0, hasErrors: false, source: 'local-path' }] : [] });
  ix.stub(IPluginHostService, hosts);
  ix.stub(IPluginSettingsService, settings);
  ix.stub(IModelCatalog, catalog);
  ix.stub(IConfigService, { get: <T>(section: string): T => (section === 'retry' ? retry : undefined) as T });
  ix.stub(IModelService, { getDefaultModel: () => 'default-model' });
  ix.stub(IFlagService, { enabled: () => usageEnabled });
  ix.stub(ISessionIndex, { get: async (id) => ['session-example', 'session-other'].includes(id) ? { id, workspaceId: 'workspace-example', createdAt: 1, updatedAt: 1, archived: false } : undefined });
  ix.stub(IWorkspaceService, { get: async (id) => ({ id, root: '/example', name: 'Example', createdAt: 1, lastOpenedAt: 1, pinned: false }) });
  ix.set(IPluginUsageService, new SyncDescriptor(PluginUsageService));
  const usage = ix.get(IPluginUsageService);
  usage.registerPluginStateReader(() => ({ allowed: enabled, globalEnabled }));
  ix.set(IOutputLayerService, new SyncDescriptor(OutputLayerService));
  return { service: ix.get(IOutputLayerService), calls, catalog, hosts, settings, documents, usage,
    global: (value: boolean) => { globalEnabled = value; }, disable: () => { enabled = false; }, fail: () => { fail = true; },
    finish: (reason?: FinishReason) => { finishReason = reason; },
    script: (run: NonNullable<typeof scripted>) => { scripted = run; } };
}

const input: OutputLayerRequest = {
  sessionId: 'session-example', sourceId: 'assistant-1:0', sourceRevision: '1', text: 'Visible Assistant output',
  preset: { ...OUTPUT_LAYER_DEFAULT_PRESETS[0]!, modelId: 'chosen-model' }, history: [], historyTokens: 16384, cycleId: 'cycle-1',
};
async function collect(service: IOutputLayerService, request = input, signal = new AbortController().signal) {
  const events = [];
  for await (const event of service.stream(request, signal)) events.push(event);
  return events;
}

function failedStream(error: unknown): AsyncIterable<ModelRequestEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: async () => { throw error; } }) };
}

async function* recoveredOutput(): AsyncGenerator<ModelRequestEvent> {
  yield { type: 'part', part: { type: 'text', text: 'recovered' } };
  yield { type: 'finish', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], toolCalls: [] } };
}

describe('output layer bounded recovery', () => {
  it.each(['connection', '503'] as const)('recovers zero-output %s without rebuilding history or its cycle', async kind => {
    vi.useFakeTimers();
    const fixture = setup(true, { maxAttempts: 3, policies: [{ match: '.*', backoff: 7, retry: true }] });
    fixture.script(async function* (attempt) {
      if (attempt === 1) throw kind === 'connection' ? new APIConnectionError('fixture disconnected') : new APIStatusError(503, 'fixture overloaded');
      yield* recoveredOutput();
    });
    const pending = collect(fixture.service, { ...input, history: [{ sourceId: 'earlier', sourceRevision: '1', original: 'earlier', output: 'prior' }], historyTokens: kind === 'connection' ? 0 : 16384 });
    await vi.runAllTimersAsync();
    const events = await pending;
    expect(fixture.calls).toHaveLength(2);
    expect(events.map(event => event.type)).toEqual(['started', 'delta', 'completed']);
    expect(events.at(-1)).toEqual({ type: 'completed', text: 'recovered' });
    expect(fixture.calls[1]!.input).toEqual(fixture.calls[0]!.input);
    expect(fixture.calls[1]!.params).toBe(fixture.calls[0]!.params);
    expect(fixture.calls[0]!.input.messages).toHaveLength(kind === 'connection' ? 1 : 3);
    expect(fixture.hosts.requestPanel).toHaveBeenCalledOnce();
    expect(fixture.catalog.getRequester).toHaveBeenCalledOnce();
    expect(events[0]).toMatchObject({ type: 'started', historyReset: kind === 'connection' });
  });

  it('exhausts five total attempts with the existing exponential backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = setup();
    fixture.script(() => failedStream(new APIStatusError(503, 'fixture overload')));
    const startedAt = Date.now();
    const pending = collect(fixture.service);
    await vi.runAllTimersAsync();
    expect((await pending).map(event => event.type)).toEqual(['started', 'failed']);
    expect(fixture.calls).toHaveLength(5);
    expect(Date.now() - startedAt).toBe(30_000);
  });

  it.each([
    { providers: ['example-provider'], retry: true, attempts: 2 },
    { providers: ['other-provider'], retry: true, attempts: 3 },
    { providers: ['example-provider'], retry: false, attempts: 1 },
  ])('honors exact provider policy selectors and budgets: $attempts attempts', async ({ providers, retry, attempts }) => {
    vi.useFakeTimers();
    const fixture = setup(true, { maxAttempts: 3, policies: [{ match: 'APIConnectionError', models: ['chosen-model'], providers, maxAttempts: 2, backoff: 1, retry }] });
    fixture.script(() => failedStream(new APIConnectionError('fixture disconnect')));
    const pending = collect(fixture.service);
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toMatchObject({ type: 'failed' });
    expect(fixture.calls).toHaveLength(attempts);
  });

  it('honors Retry-After before the matching fixed backoff', async () => {
    vi.useFakeTimers();
    const fixture = setup(true, { policies: [{ match: 'APIStatusError', backoff: 1, retry: true }] });
    fixture.script(async function* (attempt) {
      if (attempt === 1) throw new APIStatusError(429, 'fixture rate limit', undefined, 250);
      yield* recoveredOutput();
    });
    const pending = collect(fixture.service);
    await vi.advanceTimersByTimeAsync(249);
    expect(fixture.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).at(-1)).toEqual({ type: 'completed', text: 'recovered' });
    expect(fixture.calls).toHaveLength(2);
  });

  it.each([
    new APIStatusError(400, 'fixture invalid request'),
    new APIProviderQuotaExhaustedError('fixture quota exhausted'),
    new APIEmptyResponseError('fixture blocked', { finishReason: 'filtered' }),
    markProviderEventError(new APIStatusError(503, 'fixture safety'), 'antigravity_safety'),
    attachErrorDetails(new APIConnectionError('fixture explicit veto'), { retry: false }),
    new Error('connection failed, retry this arbitrary message'),
  ])('keeps nonretryable errors and safety vetoes terminal: $message', async failure => {
    const fixture = setup(true, { maxAttempts: 2, policies: [{ match: '.*', retry: true, backoff: 0 }] });
    fixture.script(() => failedStream(failure));
    const events = await collect(fixture.service);
    expect(events.map(event => event.type)).toEqual(['started', 'failed']);
    expect(fixture.calls).toHaveLength(1);
  });

  it.each([
    { type: 'text', text: 'partial' }, { type: 'text', text: ' ' },
    { type: 'think', think: 'hidden thought' }, { type: 'think', think: '', encrypted: 'encrypted-fixture' },
    { type: 'function', id: 'fixture-tool', name: 'Lookup', arguments: '{}' },
    { type: 'tool_call_part', argumentsPart: '{' },
  ] satisfies StreamedMessagePart[])('does not replay observed $type output even when a discarded attempt clears display text', async part => {
    const fixture = setup(true, { maxAttempts: 2, policies: [{ match: '.*', backoff: 0, retry: true }] });
    fixture.script(async function* () {
      yield { type: 'part', part };
      yield { type: 'attempt.discarded', responseInstanceId: 'fixture-attempt' };
      throw new APIStatusError(503, 'failure after observed output');
    });
    const events = await collect(fixture.service);
    expect(events.at(-1)).toMatchObject({ type: 'failed' });
    expect(events.some(event => event.type === 'completed')).toBe(false);
    expect(fixture.calls).toHaveLength(1);
  });

  it('honors an output mark without yielded parts', async () => {
    const failure = new APIConnectionError('observed remotely');
    noteExecutedRequestDelivery(failure);
    const fixture = setup();
    fixture.script(() => failedStream(failure));
    expect((await collect(fixture.service)).at(-1)).toMatchObject({ type: 'failed' });
    expect(fixture.calls).toHaveLength(1);
  });

  it('cancels during backoff without another request or a failed receipt', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const controller = new AbortController();
    fixture.script(() => failedStream(new APIConnectionError('fixture disconnect')));
    const pending = collect(fixture.service, input, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.calls).toHaveLength(1);
    controller.abort();
    expect((await pending).map(event => event.type)).toEqual(['started', 'cancelled']);
    await vi.runAllTimersAsync();
    expect(fixture.calls).toHaveLength(1);
  });
});

describe('output layer independent generation', () => {
  it('honors persisted cold session and workspace usage without an extra feature gate', async () => {
    const f = setup();
    f.global(false);
    expect((await f.service.configuration()).enabled).toBe(false);
    await f.usage.set({ workspaceId: 'workspace-example', pluginId: 'kiki-output-layer', override: 'on' });
    expect((await f.service.configuration('session-example')).enabled).toBe(true);
    f.documents.set('session-plugin-usage:session-example', { revision: 1, overrides: { 'kiki-output-layer': false } });
    expect((await f.service.configuration('session-example')).enabled).toBe(false);
    expect((await collect(f.service)).at(-1)).toMatchObject({ type: 'failed' });
    expect(f.calls).toHaveLength(0);
    expect((await f.service.configuration('session-other')).enabled).toBe(true);
    await f.usage.set({ workspaceId: 'workspace-example', pluginId: 'kiki-output-layer', override: 'off' });
    f.documents.set('session-plugin-usage:session-example', { revision: 2, overrides: { 'kiki-output-layer': true } });
    expect((await f.service.configuration('session-other')).enabled).toBe(false);
    expect((await collect(f.service)).at(-1)).toEqual({ type: 'completed', text: '译文' });
    expect(f.calls).toHaveLength(1);
    await expect(f.service.configuration('unknown-session')).rejects.toThrow('Session was not found');
    expect((await collect(f.service, { ...input, sessionId: 'unknown-session' })).at(-1)).toMatchObject({ type: 'failed', message: 'Session was not found' });
    expect(f.calls).toHaveLength(1);
    const disabledScope = setup(false);
    disabledScope.documents.set('session-plugin-usage:session-example', { revision: 1, overrides: { 'kiki-output-layer': false } });
    expect((await disabledScope.service.configuration('session-example')).enabled).toBe(true);
    disabledScope.global(false);
    expect((await disabledScope.service.configuration('session-example')).enabled).toBe(false);
  });

  it('reads installed plugin configuration and sends only display text and explicit pairs through the native requester', async () => {
    const fixture = setup();
    const history = [{ sourceId: 'previous', sourceRevision: '1', original: 'Earlier visible output', output: 'Earlier translation' }];
    const events = await collect(fixture.service, { ...input, history });
    expect(fixture.hosts.requestPanel).toHaveBeenCalledWith('kiki-output-layer', 'settings', 'configuration', {});
    expect(fixture.catalog.getRequester).toHaveBeenCalledWith('chosen-model');
    const call = fixture.calls[0]!;
    expect(call.input.tools).toEqual([]);
    expect(call.input.messages.map((message) => message.content)).toEqual([
      [{ type: 'text', text: history[0]!.original }], [{ type: 'text', text: history[0]!.output }], [{ type: 'text', text: input.text }],
    ]);
    expect(call.params.attribution).toMatchObject({ sessionId: input.sessionId, agentId: 'output-layer', purpose: 'output_layer' });
    expect(events).toContainEqual({ type: 'reset' });
    expect(events.at(-1)).toEqual({ type: 'completed', text: '译文' });
    expect(JSON.stringify(events)).not.toContain('not displayed');
  });

  it('saves unselected models without using the default and requests only explicit catalog or custom model IDs', async () => {
    const fixture = setup();
    for (const modelId of [undefined, '', '   ']) {
      const events = await collect(fixture.service, { ...input, preset: { ...input.preset, modelId } });
      expect(events).toEqual([expect.objectContaining({ type: 'failed', message: '请先为输出预设选择模型' })]);
    }
    expect(fixture.catalog.getRequester).not.toHaveBeenCalled();
    expect(fixture.catalog.getConnectionRequester).not.toHaveBeenCalled();
    expect(fixture.calls).toHaveLength(0);
    await fixture.service.configure({ presets: [...OUTPUT_LAYER_DEFAULT_PRESETS], settings: OUTPUT_LAYER_DEFAULT_SETTINGS });
    expect(fixture.settings.update).toHaveBeenCalled();
    await collect(fixture.service, { ...input, preset: { ...input.preset, modelId: ' chosen-model ' } });
    expect(fixture.catalog.getRequester).toHaveBeenCalledWith('chosen-model');
    await collect(fixture.service, { ...input, preset: { ...input.preset, modelId: undefined, connectionId: ' existing ', customModelId: ' remote/custom ' } });
    expect(fixture.catalog.getConnectionRequester).toHaveBeenCalledWith('existing', 'remote/custom', 32768);
  });

  it('omits the default output cap while preserving explicit positive limits and remaining input capacity', async () => {
    const fixture = setup();
    await collect(fixture.service);
    expect(fixture.calls[0]!.params.maxCompletionTokens).toBeUndefined();
    expect(fixture.calls[0]!.params.usedContextTokens).toBeGreaterThan(0);
    expect(fixture.calls[0]!.params.maxContextTokens).toBe(32768);
    await collect(fixture.service, { ...input, preset: { ...input.preset, maxOutputTokens: 512 } });
    expect(fixture.calls[1]!.params.maxCompletionTokens).toBe(512);
    expect((await collect(fixture.service, { ...input, preset: { ...input.preset, maxOutputTokens: 0 } })).at(-1)).toMatchObject({ type: 'failed' });
    expect(fixture.calls).toHaveLength(2);
  });

  it('preserves an append-only prefix and clears the whole history at the configured budget', async () => {
    const fixture = setup();
    const first = { sourceId: 'a', sourceRevision: '1', original: '甲'.repeat(200), output: '乙'.repeat(200) };
    const second = { sourceId: 'b', sourceRevision: '1', original: '丙'.repeat(200), output: '丁'.repeat(200) };
    await collect(fixture.service, { ...input, history: [first] });
    await collect(fixture.service, { ...input, history: [first, second] });
    expect(fixture.calls[1]!.input.systemPrompt).toBe(fixture.calls[0]!.input.systemPrompt);
    expect(fixture.calls[1]!.input.messages.slice(0, 2)).toEqual(fixture.calls[0]!.input.messages.slice(0, 2));
    const rebuilt = await collect(fixture.service, { ...input, history: [first, second], historyTokens: 500 });
    expect(rebuilt[0]).toMatchObject({ type: 'started', historyReset: true });
    expect(fixture.calls.at(-1)!.input.messages).toHaveLength(1);
    const reset = rebuilt[0]!;
    if (reset.type !== 'started') throw new Error('Expected started event');
    expect(reset.cycleId).not.toBe(input.cycleId);
    const resetCall = fixture.calls.at(-1)!;
    const pair = { sourceId: input.sourceId, sourceRevision: input.sourceRevision, original: input.text, output: '译文' };
    await collect(fixture.service, { ...input, cycleId: reset.cycleId, history: [pair], text: 'Next visible group', historyTokens: 16384 });
    const continued = fixture.calls.at(-1)!;
    expect(continued.params.cacheKey).toBe(resetCall.params.cacheKey);
    expect(continued.input.systemPrompt).toBe(resetCall.input.systemPrompt);
    expect(continued.input.messages[0]).toEqual(resetCall.input.messages[0]);
    expect(continued.input.messages[1]!.content).toEqual([{ type: 'text', text: pair.output }]);
    await collect(fixture.service, { ...input, history: [first], historyTokens: 0 });
    expect(fixture.calls.at(-1)!.input.messages).toHaveLength(1);
  });

  it('keeps failure and cancellation independent and refuses disabled plugins or non-display fields', async () => {
    const fixture = setup(); fixture.fail();
    expect((await collect(fixture.service)).at(-1)).toMatchObject({ type: 'failed', message: 'fixture provider failure' });
    const abort = new AbortController(); abort.abort();
    expect(await collect(fixture.service, input, abort.signal)).toEqual([{ type: 'cancelled' }]);
    fixture.disable();
    expect((await collect(fixture.service)).at(-1)).toMatchObject({ type: 'failed' });
    expect(fixture.calls).toHaveLength(1);
    expect((await collect(fixture.service, { ...input, messages: ['user secret'] } as OutputLayerRequest)).at(-1)).toMatchObject({ type: 'failed' });
    expect(fixture.calls).toHaveLength(1);
  });

  it('reports explicit provider truncation as a failure after partial deltas without completing or retrying', async () => {
    const fixture = setup();
    fixture.finish('truncated');
    const events = await collect(fixture.service);
    expect(events).toContainEqual({ type: 'delta', text: '译文' });
    expect(events.at(-1)).toMatchObject({ type: 'failed', message: '输出被模型截断，请缩小分组或选择输出窗口更大的模型后重试' });
    expect(events.some(event => event.type === 'completed')).toBe(false);
    expect(fixture.calls).toHaveLength(1);
    expect((await collect(fixture.service, { ...input, preset: { ...input.preset, maxOutputTokens: 512 } })).at(-1))
      .toMatchObject({ type: 'failed', message: '输出被模型截断，请提高或清空预设的输出上限后重试' });
    fixture.finish();
    expect((await collect(fixture.service)).at(-1)).toEqual({ type: 'completed', text: '译文' });
    expect(fixture.calls).toHaveLength(3);
  });

  it('keeps installed templates separate from saved edits and writes only preferences to plugin settings', async () => {
    const fixture = setup();
    const saved = [{ ...OUTPUT_LAYER_DEFAULT_PRESETS[0]!, instruction: 'My saved instruction' }];
    fixture.hosts.requestPanel.mockResolvedValue({ enabled: true, presets: saved, templates: OUTPUT_LAYER_DEFAULT_PRESETS, settings: OUTPUT_LAYER_DEFAULT_SETTINGS });
    const config = await fixture.service.configuration('session-example');
    expect(config.presets).toEqual(saved);
    expect(config.templates?.map(preset => preset.id)).toEqual(['translate', 'translate-en', 'plain', 'catgirl', 'tsundere', 'custom']);
    expect(config.templates).toEqual(OUTPUT_LAYER_DEFAULT_PRESETS);
    for (const preset of config.templates!) {
      expect(preset.modelId).toBeUndefined();
      expect(preset.maxOutputTokens).toBeUndefined();
    }
    await fixture.service.configure({ presets: saved, settings: { ...OUTPUT_LAYER_DEFAULT_SETTINGS, groupChars: 800 } });
    expect(fixture.settings.update).toHaveBeenCalledWith({ pluginId: 'kiki-output-layer', values: { presets: JSON.stringify(config.presets), ...OUTPUT_LAYER_DEFAULT_SETTINGS, groupChars: 800 } });
  });
});
