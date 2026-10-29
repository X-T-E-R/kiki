import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryAdvisorConfigSchema } from '@kiki/protocol';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { Emitter, Event } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import { IConfigService, type ConfigChangedEvent } from '#/app/config/config';
import { MemoryConfigSchema } from '#/app/memory/configSection';
import { AgentMemoryAdvisor, IAgentMemoryAdvisor } from '#/app/memory/memoryAdvisor';
import { AgentMemorySnapshot, IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IMemoryStore, type MemoryStoreChange } from '#/app/memory/memoryStore';
import { memoryAdviceKey, advisorStatus, type MemoryAdvice } from '#/app/memory/memoryAdvisorTypes';
import { renderMemoryWorkingSet, renderMemoryWorkingSetText } from '#/app/memory/memoryContext';
import {
  IMemorySelector,
  MemorySelector,
  MemorySelectorError,
  selectorInputTokens,
  selectorStats,
  validateSelectorAnswers,
  type MemorySelectorCall,
} from '#/app/memory/memorySelector';
import { memorySelectorBatches } from '#/app/memory/memoryAdvisorCatalog';
import type { MemoryRecallEntry } from '#/app/memory/memoryRecall';
import {
  IAgentLoopService,
  type BeforeStepContext,
  type AfterStepContext,
  type AppendedToolResultContext,
} from '#/agent/loop/loop';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IEventBus } from '#/app/event/eventBus';
import { ILogService } from '#/_base/log/log';
import { IModelService } from '#/kosong/model/model';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IRequestAdmission } from '#/kosong/model/requestAdmission';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';

const workspace = 'wd_example_0123456789ab';
const destination = 'example@https://example.test';
const disposables: Array<{ dispose(): unknown }> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const value of disposables.splice(0)) await value.dispose();
});
function entry(
  id: string,
  title = id,
  body = 'Complete remembered condition.',
  scope: MemoryRecallEntry['scope'] = { kind: 'global' },
): MemoryRecallEntry {
  return {
    id,
    title,
    body,
    scope,
    type: 'feedback',
    status: 'active',
    pinned: false,
    revision: 'r1',
    source: { writer: 'user' },
    created: '2026-10-29T00:00:00Z',
    updated: '2026-10-29T00:00:00Z',
    reason: 'Synthetic test',
    basis: { kind: 'human', note: 'Use the whole condition.' },
  };
}
function fixture(
  options: {
    mode?: 'rank' | 'select' | 'off';
    advisorHook?: boolean;
    publishRefreshOnly?: boolean;
    unconfigured?: boolean;
    child?: boolean;
    allowedModels?: string[];
    allowedEfforts?: string[];
    permitted?: boolean;
    supported?: boolean;
    lazy?: boolean;
    enabled?: boolean;
    wait?: number;
    timeout?: number;
    maxCalls?: number;
    source?: import('@kiki/protocol').DecisionSource;
    protocol?: 'chat_json' | 'system_one' | 'pair_score';
    selector?: IMemorySelector;
    call?: (input: MemorySelectorCall) => ReturnType<IMemorySelector['call']>;
  } = {},
) {
  const ix = new TestInstantiationService();
  disposables.push(ix);
  const configChanges = new Emitter<ConfigChangedEvent>();
  disposables.push(configChanges);
  const storeChanges = new Emitter<MemoryStoreChange>();
  disposables.push(storeChanges);
  const policyChanges = new Emitter<{ sessionId?: string }>();
  disposables.push(policyChanges);
  let settings = MemoryConfigSchema.parse({
    enabled: options.enabled ?? true,
    budget: 4_000,
    advisor: options.unconfigured
      ? undefined
      : {
          mode: options.mode ?? 'rank',
          selector: { protocol: options.protocol ?? 'chat_json', model: 'chosen' },
          source: options.source,
          first_step_wait_ms: 'wait' in options ? options.wait : 0,
          timeout_ms: options.timeout ?? 1000,
          max_calls_per_turn: options.maxCalls ?? 3,
        },
  });
  let query = 'Need advice without literal overlap';
  let requestId = 1;
  let generation = 'g1';
  let entries = [
    entry(
      'm_semantic',
      'Old release exception',
      `${'Context. '.repeat(30)}Exception: this must only be used as history.`,
    ),
    entry('m_lexical', 'Need advice', 'Lexical baseline.'),
  ];
  let permitted = options.permitted ?? true;
  const before = new OrderedHookSlot<BeforeStepContext>();
  const tools = new OrderedHookSlot<ToolDidExecuteContext>();
  let published = '';
  const calls = vi.fn(
    options.call ?? options.selector?.call.bind(options.selector) ??
      (async (input: MemorySelectorCall) => {
        input.stats.requests++;
        return input.units.map((unit) => ({
          handle: unit.handle,
          use: input.stage === 'discover' ? ('read' as const) : ('history' as const),
        }));
      }),
  );
  ix.stub(IConfigService, {
    get: <T = unknown>() => settings as T,
    onDidChangeConfiguration: configChanges.event,
  });
  ix.stub(ISessionContext, { sessionId: 'synthetic-session', workspaceId: workspace });
  ix.stub(IAgentScopeContext, {
    agentId: options.child ? 'child' : 'main',
    parentAgentId: options.child ? 'main' : undefined,
  });
  ix.stub(IAgentContextMemoryService, {
    get: () => [
      {
        id: `prompt-${requestId}`,
        role: 'user',
        content: [{ type: 'text', text: query }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    ],
  });
  ix.stub(ISessionTodoService, { getNotes: () => ({ notes: {} }) });
  let prepared = !options.lazy;
  const prepare = vi.fn(async () => {
    prepared = true;
  });
  ix.stub(IMemoryStore, {
    prepare,
    get snapshot() {
      return options.supported === false || !prepared
        ? undefined
        : async () => ({ generation, entries: [...entries] });
    },
    checkpoint: async () => generation,
    get: async (scope, id) =>
      entries.find(
        (item) => item.id === id && JSON.stringify(item.scope) === JSON.stringify(scope),
      ),
    onDidChange: storeChanges.event,
  });
  ix.stub(IOptionalCapabilityPolicy, {
    load: async () => {},
    admit: () => ({ admitted: permitted, reason: permitted ? 'admitted' : 'session_off' }),
    onDidChange: policyChanges.event,
  });
  ix.stub(IAgentLoopService, {
    hooks: {
      onWillBeginStep: before,
      onDidAppendToolResult: new OrderedHookSlot<AppendedToolResultContext>(),
      onDidFinishStep: new OrderedHookSlot<AfterStepContext>(),
    },
  });
  ix.stub(IAgentToolExecutorService, { hooks: { onDidExecuteTool: tools } });
  ix.stub(IAgentContextInjectorService, {});
  ix.stub(IAgentProfileService, {
    data: () => ({
      modelCapabilities: UNKNOWN_CAPABILITY,
      thinkingLevel: 'off',
      systemPrompt: '',
      boundProfile: options.child
        ? {
            name: 'synthetic-child',
            allowedModels: options.allowedModels ?? ['chosen'],
            allowedEfforts: options.allowedEfforts,
          }
        : undefined,
    }),
  });
  ix.stub(IModelService, { resolveId: (id) => id });
  ix.stub(IModelCatalog, {
    get: () => ({ capabilities: UNKNOWN_CAPABILITY, alwaysThinking: false } as Model),
  });
  const record = vi.fn();
  ix.stub(IAgentUsageService, { record });
  ix.stub(IEventBus, { subscribe: () => ({ dispose() {} }) });
  ix.stub(ILogService, { debug() {} });
  ix.stub(IMemorySelector, {
    describe: options.selector?.describe.bind(options.selector) ?? ((config) =>
      advisorStatus('ready', {
        destination,
        model: config?.selector?.model,
        applicability: 'full_units',
      })),
    call: calls,
  });
  ix.set(IAgentMemorySnapshot, new SyncDescriptor(AgentMemorySnapshot));
  const snapshot = ix.get(IAgentMemorySnapshot);
  before.register('context-injector', async (_context, next) => {
    const refreshed = await snapshot.refreshIfDirty();
    if (options.publishRefreshOnly) published = refreshed ?? published;
    else published = await snapshot.get();
    await next();
  });
  ix.set(IAgentMemoryAdvisor, new SyncDescriptor(AgentMemoryAdvisor));
  const advisor = ix.get(IAgentMemoryAdvisor);
  if (options.advisorHook === false) before.delete('memory-advisor');
  return {
    ix,
    snapshot,
    advisor,
    calls,
    record,
    tools,
    prepare,
    step: async (turnId = 1, firstStepOfTurn = true, signal = new AbortController().signal) =>
      before.run({ turnId, firstStepOfTurn, step: 1, signal }),
    published: () => published,
    setQuery: (value: string) => {
      query = value;
      requestId++;
    },
    settings: () => settings,
    connectionChanged: () => configChanges.fire({ domain: 'providers', source: 'set', value: {}, previousValue: undefined }),
    configure: (patch: Record<string, unknown>) => {
      settings = MemoryConfigSchema.parse({ ...settings, ...patch });
      configChanges.fire({
        domain: 'memory',
        source: 'set',
        value: settings,
        previousValue: undefined,
      });
    },
    revoke: () => {
      permitted = false;
      policyChanges.fire({});
    },
    mutate: (values: MemoryRecallEntry[]) => {
      entries = values;
      generation += 'x';
      snapshot.invalidate();
    },
    entries: () => entries,
  };
}
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Memory Advisor lifecycle and snapshot publication', () => {
  it.each([{ mode: 'off' as const }, { unconfigured: true }, { enabled: false }])(
    'keeps disabled paths equivalent to the same snapshot input without the Advisor hook: %j',
    async (options) => {
      const f = fixture({ ...options, lazy: true, wait: 100 });
      const baseline = fixture({ ...options, lazy: true, wait: 100, advisorHook: false });
      for (const firstStepOfTurn of [true, false]) {
        await baseline.step(1, firstStepOfTurn);
        await f.step(1, firstStepOfTurn);
        expect(f.calls).not.toHaveBeenCalled();
        expect(f.prepare.mock.calls).toEqual(baseline.prepare.mock.calls);
        expect(f.published()).toBe(baseline.published());
        expect(f.snapshot.projectionView?.workset?.entries).toEqual(
          baseline.snapshot.projectionView?.workset?.entries,
        );
      }
      if (options.enabled !== false)
        expect(f.published()).toBe(
          renderMemoryWorkingSet(
            { generation: 'g1', entries: f.entries() },
            'Need advice without literal overlap',
            4_000,
            1_000,
          ).text,
        );
    },
  );
  it('prepares lazy snapshot authority only when Advisor is enabled and permissions are admitted', async () => {
    const active = fixture({ lazy: true, wait: 100 });
    await active.step();
    expect(active.prepare).toHaveBeenCalled();
    expect(active.published()).toContain('use=history');
    const denied = fixture({ lazy: true, permitted: false });
    await denied.step();
    expect(denied.prepare).not.toHaveBeenCalled();
    expect(denied.calls).not.toHaveBeenCalled();
  });
  it('discovers outside lexical matches, reads the complete same-revision unit and publishes only at the next step head', async () => {
    const f = fixture();
    await f.step();
    await flush();
    expect(f.published()).not.toContain('use=history');
    await f.step(1, false);
    expect(f.published()).toContain('use=history');
    expect(f.published()).toContain('Exception: this must only be used as history.');
    const discovery = f.calls.mock.calls.find(([input]) => input.stage === 'discover')![0];
    const judgment = f.calls.mock.calls.find(([input]) => input.stage === 'judge')![0];
    expect(discovery.units[0]!.text).not.toContain('this must only be used as history');
    expect(judgment.units[0]!.text).toContain('this must only be used as history');
    expect(judgment.units[0]!.text).toContain('Use the whole condition.');
    expect(f.advisor.status()).toMatchObject({ state: 'selected', logical_calls: 1, requests: 2 });
  });
  it('publishes in the same first step when the bounded wait completes', async () => {
    const f = fixture({ wait: 100 });
    await f.step();
    expect(f.published()).toContain('use=history');
    expect(f.calls).toHaveBeenCalledTimes(2);
    await f.step(1, false);
    expect(f.calls).toHaveBeenCalledTimes(2);
  });
  it('hands the refreshed projection to the prompt publisher after the Advisor reads the request', async () => {
    const gate = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
    const pending = fixture({ publishRefreshOnly: true, call: async () => gate.promise });
    const baseline = fixture({ publishRefreshOnly: true, advisorHook: false });
    await pending.step();
    await baseline.step();
    expect(pending.calls).toHaveBeenCalledOnce();
    expect(pending.published()).toContain('[m_lexical]');
    expect(pending.published()).toBe(baseline.published());
    const f = fixture({ wait: 100, publishRefreshOnly: true });
    await f.step();
    expect(f.calls).toHaveBeenCalledTimes(2);
    expect(f.published()).toContain('use=history');
    expect(f.published()).toContain('Exception: this must only be used as history.');
    const disabled = fixture({ mode: 'off', publishRefreshOnly: true });
    const disabledBaseline = fixture({ mode: 'off', publishRefreshOnly: true, advisorHook: false });
    await disabled.step();
    await disabledBaseline.step();
    expect(disabled.published()).toBe(disabledBaseline.published());
    expect(disabled.published()).toContain('<memory-workset');
    gate.resolve([]);
  });
  it('cancels in-flight work and clears advice on hot disable; a selector ignoring abort cannot publish late results', async () => {
    const gate = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
    const f = fixture({ call: async () => gate.promise });
    await f.step();
    const signal = f.calls.mock.calls[0]![0].signal;
    f.configure({ advisor: { ...f.settings().advisor, mode: 'off' } });
    expect(signal.aborted).toBe(true);
    expect(f.advisor.status().state).toBe('off');
    gate.resolve([{ handle: 'c0', use: 'read' }]);
    await flush();
    await f.step(1, false);
    expect(f.published()).toBe(
      renderMemoryWorkingSet(
        { generation: 'g1', entries: f.entries() },
        'Need advice without literal overlap',
        4_000,
        1_000,
      ).text,
    );
    expect(f.calls).toHaveBeenCalledTimes(1);
  });
  it.each(['source', 'legacy'] as const)('calls a configured %s without acknowledgements, cancels an old origin and keeps off byte-identical', async (kind) => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const requests: string[] = [];
    async function upstream(old: boolean): Promise<{ server: Server; origin: string }> {
      const server = createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += String(chunk);
        requests.push(old ? 'old' : 'new');
        const body = JSON.parse(text);
        if (old) { firstStarted.resolve(); await releaseFirst.promise; }
        const answers = Object.fromEntries(Object.entries(body.questions).map(([handle, raw]) => {
          const question = raw as { criteria: Record<string, string> };
          const choice = question.criteria['read'] !== undefined ? 'read' : old ? 'history' : 'apply';
          return [handle, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((name) => [name, name === choice ? 1 : 0])) }];
        }));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ answers }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      disposables.push({ async dispose() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
      return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
    }
    const old = await upstream(true);
    const next = await upstream(false);
    let baseUrl = `${old.origin}/v1`;
    const ix = new TestInstantiationService();
    disposables.push(ix);
    const model = () => ({ id: 'chosen', name: 'synthetic-model', providerName: 'example', baseUrl, headers: {}, capabilities: UNKNOWN_CAPABILITY, alwaysThinking: false, authProvider: { getAuth: async () => undefined }, credentialSource: 'none' as const });
    ix.stub(IModelCatalog, { get: () => model() as Model, getConnectionEndpoint: () => ({ ...model(), protocol: 'system_one', defaultModel: 'synthetic-model' }) });
    ix.stub(IRequestAdmission, { acquire: async () => ({ release() {} }) });
    ix.set(IMemorySelector, new SyncDescriptor(MemorySelector));
    const f = fixture({ selector: ix.get(IMemorySelector), protocol: 'system_one', source: kind === 'source' ? { kind: 'connection', connection: 'example' } : undefined, timeout: 5_000 });
    expect(f.settings().advisor?.egress_ack).toEqual([]);
    expect(f.advisor.status()).toMatchObject({ state: 'ready', consent_required: false, origin: old.origin });
    await f.step();
    await firstStarted.promise;
    const oldSignal = f.calls.mock.calls[0]![0].signal;
    baseUrl = `${next.origin}/v1`;
    f.connectionChanged();
    expect(oldSignal.aborted).toBe(true);
    expect(f.advisor.status()).toMatchObject({ state: 'ready', consent_required: false, origin: next.origin });
    await f.step(1, false);
    await vi.waitFor(() => expect(f.advisor.status().state).toBe('selected'));
    await f.step(1, false);
    expect(f.published()).toContain('use=apply');
    expect(f.published()).not.toContain('use=history');
    releaseFirst.resolve();
    await flush();
    expect(requests).toEqual(['old', 'new', 'new']);
    const saved = f.settings().advisor;
    f.configure({ advisor: { ...saved, mode: 'off' } });
    await f.step(2);
    expect(f.advisor.status()).toMatchObject({ state: 'off', consent_required: false });
    expect(f.settings().advisor).toEqual({ ...saved, mode: 'off' });
    expect(f.published()).toBe(renderMemoryWorkingSet({ generation: 'g1', entries: f.entries() }, 'Need advice without literal overlap', 4_000, 1_000).text);
    expect(requests).toEqual(['old', 'new', 'new']);
  });
  it('drops old advice immediately on request changes and permits only the new single flight', async () => {
    const first = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
    const f = fixture({
      call: async (input) =>
        input.query.startsWith('Need')
          ? first.promise
          : input.units.map((unit) => ({
              handle: unit.handle,
              use: input.stage === 'discover' ? 'read' : 'apply',
            })),
    });
    await f.step();
    const old = f.calls.mock.calls[0]![0].signal;
    f.setQuery('Changed request');
    await f.step(2);
    expect(old.aborted).toBe(true);
    first.resolve([{ handle: 'c0', use: 'read' }]);
    await flush();
    await f.step(2, false);
    expect(f.published()).toContain('use=apply');
    expect(f.published()).not.toContain('use=history');
    expect(f.advisor.status().logical_calls).toBe(1);
  });
  it('falls back byte-for-byte after failure and distinguishes a successful zero-selection response', async () => {
    const failed = fixture({
      wait: 100,
      call: async () => {
        throw new MemorySelectorError('invalid_output');
      },
    });
    await failed.step();
    const baseline = renderMemoryWorkingSet(
      { generation: 'g1', entries: failed.entries() },
      'Need advice without literal overlap',
      4_000,
      1_000,
    );
    expect(failed.published()).toBe(baseline.text);
    expect(failed.snapshot.projectionView?.workset?.entries).toEqual(baseline.entries);
    expect(failed.advisor.status()).toMatchObject({ state: 'failed', reason: 'invalid_output' });
    const none = fixture({ wait: 100, call: async () => [] });
    await none.step();
    expect(none.advisor.status().state).toBe('none');
    expect(none.published()).toBe(baseline.text);
  });
  it('resets the circuit after successful requests between structural failures', async () => {
    const f = fixture({ wait: 100 });
    const successful = f.calls.getMockImplementation()!;
    const states: string[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      f.setQuery(`Independent synthetic request ${turn}`);
      f.calls.mockImplementation(
        turn % 2 === 0 ? successful : async () => {
          throw new MemorySelectorError('auth');
        },
      );
      await f.step(turn);
      states.push(f.advisor.status().state);
    }
    expect(states).toEqual(['failed', 'selected', 'failed', 'selected', 'failed', 'selected']);
    expect(f.calls).toHaveBeenCalledTimes(9);
  });
  it.each(['auth', 'protocol', 'capability_mismatch', 'not_permitted'] as const)(
    'opens the circuit only after three consecutive %s failures and resets on configuration changes',
    async (reason) => {
      const f = fixture({
        wait: 100,
        call: async () => {
          throw new MemorySelectorError(reason);
        },
      });
      for (let turn = 1; turn <= 3; turn++) {
        f.setQuery(`Independent synthetic request ${turn}`);
        await f.step(turn);
        expect(f.advisor.status()).toMatchObject({ state: 'failed', reason });
      }
      f.setQuery('Request after three same-class failures');
      await f.step(4);
      expect(f.advisor.status().state).toBe('limited');
      expect(f.calls).toHaveBeenCalledTimes(3);
      f.configure({ advisor: { ...f.settings().advisor, timeout_ms: 2_000 } });
      await f.step(5);
      expect(f.advisor.status()).toMatchObject({ state: 'failed', reason });
      expect(f.calls).toHaveBeenCalledTimes(4);
    },
  );
  it('keeps different failure classes and invalid output from accumulating into a circuit', async () => {
    const f = fixture({ wait: 100 });
    const successful = f.calls.getMockImplementation()!;
    const failures = [
      'auth', 'protocol', 'auth', 'invalid_output', 'auth',
      'invalid_output', 'invalid_output', 'invalid_output',
    ] as const;
    for (const [index, reason] of failures.entries()) {
      f.setQuery(`Independent synthetic request ${index}`);
      f.calls.mockImplementation(async () => {
        throw new MemorySelectorError(reason);
      });
      await f.step(index + 1);
      expect(f.advisor.status()).toMatchObject({ state: 'failed', reason });
    }
    f.calls.mockImplementation(successful);
    f.setQuery('Request after distinct failures');
    await f.step(failures.length + 1);
    expect(f.advisor.status().state).toBe('selected');
    expect(f.calls).toHaveBeenCalledTimes(failures.length + 2);
  });
  it.each(['timeout', 'rate_limited'] as const)(
    'backs off %s and breaks a structural failure streak',
    async (reason) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const f = fixture({ wait: 100 });
      const successful = f.calls.getMockImplementation()!;
      for (const [index, failure] of (['auth', 'auth', reason, 'auth', 'auth'] as const).entries()) {
        f.setQuery(`Independent synthetic request ${index}`);
        f.calls.mockImplementation(async () => {
          throw new MemorySelectorError(failure);
        });
        await f.step(index + 1);
        expect(f.advisor.status()).toMatchObject({ state: 'failed', reason: failure });
        if (failure === reason) {
          f.setQuery('Request during backoff');
          await f.step(index + 10);
          expect(f.advisor.status().state).toBe('limited');
          expect(f.calls).toHaveBeenCalledTimes(index + 1);
          vi.setSystemTime(Date.now() + 5_001);
        }
      }
      f.calls.mockImplementation(successful);
      f.setQuery('Recovered after backoff');
      await f.step(20);
      expect(f.advisor.status().state).toBe('selected');
      expect(f.calls).toHaveBeenCalledTimes(7);
    },
  );
  it('revalidates forgotten/revised units and retains new unjudged lexical units in select mode', async () => {
    const f = fixture({
      mode: 'select',
      wait: 100,
      call: async (input) =>
        input.units.map((unit) => ({
          handle: unit.handle,
          use: input.stage === 'discover' ? 'read' : 'skip',
        })),
    });
    await f.step();
    expect(f.snapshot.projectionView?.workset?.entries).toEqual([]);
    const newEntry = entry('m_new', 'Need advice', 'New unjudged unit.');
    f.mutate([newEntry, { ...f.entries()[0]!, revision: 'r2' }]);
    await f.step(1, false);
    expect(f.published()).toContain('New unjudged unit.');
    expect(f.advisor.status().enumeration).toBe('partial');
    expect(
      f.snapshot.projectionView?.workset?.entries.map((unit) => [unit.id, unit.revision]),
    ).toEqual([['m_new', 'r1']]);
    expect(f.calls).toHaveBeenCalledTimes(2);
  });
  it('stays lazy with unsupported stores and denies capability/child model constraints without contacting a selector', async () => {
    for (const options of [
      { supported: false },
      { permitted: false },
      { child: true, permitted: false },
    ]) {
      const f = fixture(options);
      await f.step();
      expect(f.calls).not.toHaveBeenCalled();
      expect(f.advisor.status().reason).toBe(
        options.supported === false ? 'unsupported_store' : 'not_permitted',
      );
    }
  });
  it('honors independent deadlines, first-step cancellation and per-turn logical budgets', async () => {
    vi.useFakeTimers();
    const gate = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
    const f = fixture({ wait: 100, timeout: 200, maxCalls: 1, call: async () => gate.promise });
    const stepController = new AbortController();
    const step = f.step(1, true, stepController.signal);
    await flush();
    stepController.abort();
    await step;
    expect(f.calls.mock.calls[0]![0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(201);
    expect(f.advisor.status().reason).toBe('timeout');
    f.setQuery('New request in same turn');
    await f.step(1, false);
    expect(f.calls).toHaveBeenCalledTimes(1);
    expect(f.advisor.status().state).toBe('limited');
    gate.resolve([]);
    await flush();
    expect(f.published()).not.toContain('use=');
  });
  it.each([
    { protocol: 'system_one' as const, wait: undefined, expected: 3_000 },
    { protocol: 'pair_score' as const, wait: undefined, expected: 3_000 },
    { protocol: 'chat_json' as const, wait: undefined, expected: 1_500 },
    { protocol: 'system_one' as const, wait: 1_500, expected: 1_500 },
  ])('waits $expected ms on the first step for $protocol with first_step_wait_ms=$wait', async ({ protocol, wait, expected }) => {
    vi.useFakeTimers();
    const gate = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
    const f = fixture({ protocol, wait, timeout: 10_000, call: async () => gate.promise, selector: {
      _serviceBrand: undefined,
      describe: (config) => advisorStatus('ready', { destination, protocol: config?.selector?.protocol, applicability: 'full_units' }),
      call: async () => gate.promise,
      probe: async () => { throw new Error('unused'); },
    } });
    expect(f.settings().advisor?.first_step_wait_ms).toBe(wait);
    let done = false;
    const step = f.step().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(expected - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await step;
    expect(done).toBe(true);
    gate.resolve([]);
  });
  it('lets the default first-step wait follow a source switch without saving it', async () => {
    vi.useFakeTimers();
    const gate = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
    const f = fixture({ protocol: 'system_one', wait: undefined, timeout: 10_000, call: async () => gate.promise, selector: {
      _serviceBrand: undefined,
      describe: (config) => advisorStatus('ready', { destination, protocol: config?.selector?.protocol, applicability: 'full_units' }),
      call: async () => gate.promise,
      probe: async () => { throw new Error('unused'); },
    } });
    f.configure({ advisor: { ...f.settings().advisor, selector: { protocol: 'chat_json', model: 'chosen' } } });
    expect(f.settings().advisor?.first_step_wait_ms).toBeUndefined();
    let done = false;
    const step = f.step().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_500);
    await step;
    expect(done).toBe(true);
    gate.resolve([]);
  });
  it('cancels an in-flight request when permissions are revoked', async () => {
    const gate = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
    const f = fixture({ call: async () => gate.promise });
    await f.step();
    const signal = f.calls.mock.calls[0]![0].signal;
    f.revoke();
    expect(signal.aborted).toBe(true);
    gate.resolve([{ handle: 'c0', use: 'read' }]);
    await flush();
    await f.step(1, false);
    expect(f.advisor.status().reason).toBe('not_permitted');
    expect(f.published()).not.toContain('use=');
  });
  it('recognizes repeated real prompts but does not wake again for an unchanged continuation', async () => {
    const f = fixture({ wait: 100 });
    await f.step();
    await f.step(2);
    expect(f.calls).toHaveBeenCalledTimes(2);
    f.setQuery('Need advice without literal overlap');
    await f.step(3);
    expect(f.calls).toHaveBeenCalledTimes(4);
  });
  it('applies native child model and effort constraints before sending memory', async () => {
    const allowed = fixture({ child: true, wait: 100 });
    await allowed.step();
    expect(allowed.published()).toContain('use=history');
    for (const options of [{ allowedModels: ['other'] }, { allowedEfforts: ['high'] }]) {
      const denied = fixture({ child: true, ...options });
      await denied.step();
      expect(denied.calls).not.toHaveBeenCalled();
      expect(denied.advisor.status().reason).toBe('not_permitted');
    }
  });
  it('drops discoveries revised or expired before the complete-unit read', async () => {
    const gate = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
    const f = fixture({ call: async () => gate.promise });
    await f.step();
    f.mutate(
      f.entries().map((value, index) =>
        index === 0
          ? { ...value, revision: 'r2' }
          : {
              ...value,
              validity: { until: '2000-01-01T00:00:00Z', check: 'Expired test condition' },
            },
      ),
    );
    gate.resolve([
      { handle: 'c0', use: 'read' },
      { handle: 'c1', use: 'read' },
    ]);
    await flush();
    await f.step(1, false);
    expect(f.calls).toHaveBeenCalledTimes(1);
    expect(f.published()).not.toContain('use=');
    expect(f.advisor.status()).toMatchObject({ state: 'none', enumeration: 'partial' });
  });
  it('wakes on changed task notes and deduplicates the same tool error within a turn', async () => {
    const f = fixture({ wait: 100 });
    await f.step();
    f.ix.stub(ISessionTodoService, { getNotes: () => ({ notes: { goal: 'Different goal' } }) });
    await f.step(1, false);
    await flush();
    await f.step(1, false);
    expect(f.calls).toHaveBeenCalledTimes(4);
    const failure = {
      turnId: 1,
      toolCall: { id: 'synthetic-call', name: 'ExampleTool', arguments: '{}' },
      result: { output: 'Synthetic failure', isError: true },
      outcome: 'executed',
    } as ToolDidExecuteContext;
    await f.tools.run(failure);
    await f.step(1, false);
    await flush();
    await f.step(1, false);
    expect(f.calls).toHaveBeenCalledTimes(6);
    expect(f.calls.mock.calls[4]![0].query).toContain('Synthetic failure');
    await f.tools.run(failure);
    await f.step(1, false);
    expect(f.calls).toHaveBeenCalledTimes(6);
  });
  it.each([{ enabled: false }, { advisor: undefined }])(
    'hot-disables and removes in-flight configuration: %j',
    async (patch) => {
      const gate = deferred<Awaited<ReturnType<IMemorySelector['call']>>>();
      const f = fixture({ call: async () => gate.promise });
      await f.step();
      const signal = f.calls.mock.calls[0]![0].signal;
      f.configure(patch);
      expect(signal.aborted).toBe(true);
      gate.resolve([{ handle: 'c0', use: 'read' }]);
      await flush();
      await f.step(1, false);
      expect(f.calls).toHaveBeenCalledTimes(1);
      expect(f.published()).not.toContain('use=');
    },
  );
});

describe('Advisor governed protocols', () => {
  function selector(protocol: 'system_one' | 'pair_score' = 'system_one') {
    const ix = new TestInstantiationService();
    disposables.push(ix);
    const model = {
      id: 'chosen',
      name: 'arbitrary-remote-name',
      providerName: 'example',
      baseUrl: 'https://example.test/v1',
      capabilities: UNKNOWN_CAPABILITY,
      alwaysThinking: false,
      headers: {},
      authProvider: { getAuth: async () => ({ apiKey: 'synthetic-key' }) },
    } as Model;
    const request = vi.fn(async function* (_input, _signal, params: ModelRequestParams) {
      params.onRequestAttempt?.();
      yield { type: 'attempt.discarded' as const, responseInstanceId: 'first' };
      params.onRequestAttempt?.();
      yield {
        type: 'usage' as const,
        usage: { inputOther: 9, inputCacheRead: 2, inputCacheCreation: 0, output: 3 },
      };
      yield {
        type: 'finish' as const,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: '{"answers":[{"handle":"c0","use":"apply"}]}' }],
          toolCalls: [],
        },
      };
    });
    ix.stub(IModelCatalog, { get: () => model, getRequester: () => ({ model, request }),
      getConnectionEndpoint: () => ({ ...model, protocol, defaultModel: 'connection-default', credentialSource: 'provider' }) });
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ release }));
    ix.stub(IRequestAdmission, { acquire });
    ix.set(IMemorySelector, new SyncDescriptor(MemorySelector));
    return { service: ix.get(IMemorySelector), acquire, release, request };
  }
  const attribution = {
    sessionId: 'synthetic-session',
    agentId: 'main',
    purpose: 'memory_advice',
    logicalRequestId: 'logical',
    waitBudget: { waitedMs: 0 },
  };
  function input(protocol: 'chat_json' | 'system_one' | 'pair_score'): MemorySelectorCall {
    return {
      config: memoryAdvisorConfigSchema.parse({
        selector: { protocol, model: 'chosen' },
      }),
      stage: 'judge',
      query: 'Synthetic task',
      units: [{ handle: 'c0', text: 'Full body, basis and validity.' }],
      signal: new AbortController().signal,
      stats: selectorStats(),
      attribution,
    };
  }
  it('prefers new model sources over legacy selectors without changing chat request behavior', async () => {
    const f = selector();
    const call = input('pair_score');
    call.config.source = { kind: 'model', model: 'chosen' };
    expect(await f.service.call(call)).toEqual([{ handle: 'c0', use: 'apply' }]);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.acquire).not.toHaveBeenCalled();
  });
  it('uses connection protocol and arbitrary model overrides, and releases admission on HTTP failure', async () => {
    const f = selector('pair_score');
    const call = input('chat_json');
    call.config.source = { kind: 'connection', connection: 'example', model: 'custom-remote-id' };
    const http = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body).model).toBe('custom-remote-id');
      return Response.json({ results: [{ index: 0, relevance_score: 0.8 }] });
    });
    vi.stubGlobal('fetch', http);
    expect(await f.service.call(call)).toEqual([{ handle: 'c0', score: 0.8 }]);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.service.describe(call.config, workspace)).toMatchObject({ protocol: 'pair_score', applicability: 'rank_only', consent_required: false });
    for (const [status, reason] of [[401, 'auth'], [429, 'rate_limited']] as const) {
      http.mockImplementationOnce(async () => Response.json({}, { status }));
      await expect(f.service.call(call)).rejects.toMatchObject({ reason });
    }
    http.mockImplementationOnce(async () => new Response('{malformed', { headers: { 'content-type': 'application/json' } }));
    await expect(f.service.call(call)).rejects.toMatchObject({ reason: 'invalid_output' });
    expect(f.release).toHaveBeenCalledTimes(4);
  });
  it.each(['aborted', 'timeout'] as const)('ends a synthetic connection probe on %s and never accepts a late result', async (reason) => {
    const f = selector();
    const call = input('system_one');
    call.config.timeout_ms = 100;
    call.config.source = { kind: 'connection', connection: 'example' };
    const gate = deferred<Response>();
    const started = deferred<void>();
    vi.stubGlobal('fetch', vi.fn(async () => { started.resolve(); return gate.promise; }));
    const controller = new AbortController();
    const pending = f.service.probe(call.config, destination, controller.signal);
    await started.promise;
    if (reason === 'aborted') controller.abort();
    expect(await pending).toMatchObject({ ok: false, status: { reason } });
    gate.resolve(Response.json({ answers: {} }));
    await flush();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('keeps chat retries separate from logical calls and records known and unknown usage per actual attempt', async () => {
    const f = selector();
    const call = input('chat_json');
    const record = vi.fn();
    expect(await f.service.call({ ...call, record })).toEqual([{ handle: 'c0', use: 'apply' }]);
    expect(call.stats).toMatchObject({
      requests: 2,
      retries: 1,
      inputTokens: 11,
      outputTokens: 3,
      usageKnown: false,
    });
    expect(record.mock.calls.map((args) => args[2])).toEqual([false, true]);
    expect(f.request.mock.calls[0]![2].attribution).toBe(attribution);
  });
  it('asks chat discovery to list only full reads and leaves room for a whole catalog page', async () => {
    const f = selector();
    const call = { ...input('chat_json'), stage: 'discover' as const, units: Array.from({ length: 40 }, (_, index) => ({ handle: `c${index}`, text: `Entry ${index}` })) };
    f.request.mockImplementationOnce(async function* () {
      yield { type: 'finish' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: '{"answers":[{"handle":"c7","use":"read"}]}' }], toolCalls: [] } };
    });
    expect(await f.service.call(call)).toEqual([{ handle: 'c7', use: 'read' }]);
    const [request, , params] = f.request.mock.calls[0]!;
    const payload = JSON.parse(request.messages[0]!.content[0]!.text);
    expect(payload.contract).toContain('omitted entries are skipped');
    expect(payload.contract).not.toContain('read|skip');
    expect(params.maxCompletionTokens).toBe(5_696);
  });
  it('uses System One criteria and probability answers, admission, provider credentials and real usage fields', async () => {
    const f = selector();
    const http = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(Object.keys(body.questions.c0.criteria)).toEqual(['apply', 'history', 'skip']);
      expect(body.questions.c0.criteria.apply).toContain('current premise');
      expect(body.questions.c0.criteria.history).toContain('without current authority');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-key');
      return Response.json({
        model: 'arbitrary-remote-name',
        answers: {
          c0: {
            type: 'choice',
            choice: 'history',
            confidence: 0.9,
            probabilities: { apply: 0.1, history: 0.8, skip: 0.1 },
          },
        },
        usage: { input_tokens: 17, output_tokens: 4 },
      });
    });
    vi.stubGlobal('fetch', http);
    const call = input('system_one');
    const record = vi.fn();
    expect(await f.service.call({ ...call, record })).toEqual([{ handle: 'c0', use: 'history' }]);
    expect(http.mock.calls[0]![0].toString()).toBe('https://example.test/v1/systemone');
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ inputOther: 17, output: 4 }),
      true,
    );
  });
  it('reports the effective first-step wait and the default of the resolved source protocol', () => {
    const decision = selector('system_one');
    const config = input('system_one').config;
    expect(config.first_step_wait_ms).toBeUndefined();
    expect(decision.service.describe(config, workspace)).toMatchObject({ first_step_wait_ms: 3_000, first_step_wait_default_ms: 3_000 });
    expect(decision.service.describe({ ...config, first_step_wait_ms: 1_500 }, workspace)).toMatchObject({ first_step_wait_ms: 1_500, first_step_wait_default_ms: 3_000 });
    const chat = selector().service.describe(input('chat_json').config, workspace);
    expect(chat).toMatchObject({ protocol: 'chat_json', first_step_wait_ms: 1_500, first_step_wait_default_ms: 1_500 });
  });
  it('describes System One choices so discovery reads defaults and exceptions the answer depends on', async () => {
    const f = selector();
    const http = vi.fn(async (_url, init) => {
      const criteria = JSON.parse(init.body).questions.c0.criteria;
      expect(Object.keys(criteria)).toEqual(['read', 'skip']);
      expect(criteria.read).toContain('default, exception');
      expect(criteria.skip).not.toBe('skip');
      return Response.json({
        answers: { c0: { type: 'choice', choice: 'read', confidence: 0.4, probabilities: { read: 0.7, skip: 0.3 } } },
      });
    });
    vi.stubGlobal('fetch', http);
    expect(await f.service.call({ ...input('system_one'), stage: 'discover' })).toEqual([{ handle: 'c0', use: 'read' }]);
    expect(http).toHaveBeenCalledOnce();
  });
  it('uses standard rerank index/score output without manufacturing applicability and rejects select mode', async () => {
    const f = selector();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ results: [{ index: 0, relevance_score: 0.85 }] })),
    );
    const call = input('pair_score');
    const result = await f.service.call(call);
    expect(result).toEqual([{ handle: 'c0', score: 0.85 }]);
    expect(call.stats.usageKnown).toBe(false);
    const config = { ...call.config, mode: 'select' as const };
    expect(f.service.describe(config, workspace).reason).toBe('capability_mismatch');
    await expect(f.service.call({ ...call, config })).rejects.toMatchObject({
      reason: 'capability_mismatch',
    });
  });
  it('does not require acknowledgements, rejects cross-origin endpoints, and binds synthetic probes to the requested destination', async () => {
    const f = selector();
    const call = input('system_one');
    expect(f.service.describe(call.config, 'other-workspace')).toMatchObject({ state: 'ready', consent_required: false });
    expect(f.service.describe({ ...call.config, egress_ack: [{ workspace_id: 'old-workspace', destination: 'old@https://old.test' }] })).toMatchObject({ state: 'ready', consent_required: false });
    const config = {
      ...call.config,
      selector: { ...call.config.selector!, endpoint: 'https://another.test/systemone' },
    };
    expect(f.service.describe(config, workspace).reason).toBe('protocol');
    const http = vi.fn();
    vi.stubGlobal('fetch', http);
    expect(await f.service.probe(call.config, 'wrong')).toMatchObject({ ok: false, status: { reason: 'protocol', consent_required: false } });
    expect(http).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        expect(JSON.stringify(body)).toContain('Synthetic connection test');
        const probabilities =
          body.questions.c0.criteria.read === undefined
            ? { apply: 1, history: 0, skip: 0 }
            : { read: 1, skip: 0 };
        return Response.json({
          answers: {
            c0: {
              type: 'choice',
              choice: Object.keys(probabilities)[0],
              confidence: 1,
              probabilities,
            },
          },
        });
      }),
    );
    expect((await f.service.probe({ ...call.config, mode: 'off' }, destination)).ok).toBe(true);
  });
  it('classifies malformed HTTP JSON as invalid output and records total-only usage as unknown', async () => {
    const f = selector();
    const call = input('pair_score');
    const record = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(null)),
    );
    await expect(f.service.call({ ...call, record })).rejects.toMatchObject({
      reason: 'invalid_output',
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.anything(), false);
    const next = input('pair_score');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: [{ index: 0, relevance_score: 0.5 }],
          usage: { total_tokens: 15 },
        }),
      ),
    );
    await f.service.call(next);
    expect(next.stats.usageKnown).toBe(false);
    expect(next.stats.inputTokens).toBe(0);
  });
  it('strictly rejects missing, duplicate, foreign and phase-invalid outputs', () => {
    const units = [{ handle: 'c0', text: 'Unit' }];
    for (const raw of [
      [],
      [{ handle: 'foreign', use: 'apply' }],
      [{ handle: 'c0', use: 'read' }],
      [
        { handle: 'c0', use: 'apply' },
        { handle: 'c0', use: 'skip' },
      ],
    ])
      expect(() => validateSelectorAnswers(raw, units, 'judge', false)).toThrow('invalid_output');
    expect(() =>
      validateSelectorAnswers([{ handle: 'c0', score: Infinity }], units, 'judge', true),
    ).toThrow('invalid_output');
    expect(
      memorySelectorBatches([{ handle: 'c0', text: 'x'.repeat(5_000) }], 'query', 40, 256).omitted,
    ).toBe(1);
  });
  it.each(['chat_json', 'system_one', 'pair_score'] as const)(
    'batches the complete %s wire payload and rejects an oversized call before admission',
    async (protocol) => {
      const f = selector();
      const call = input(protocol);
      const config = { ...call.config, judge_input_tokens: 1200 };
      const units = Array.from({ length: 40 }, (_, index) => ({
        handle: `c${index}`,
        text: 'Complete condition. '.repeat(12),
      }));
      const result = memorySelectorBatches(
        units,
        call.query,
        40,
        1200,
        (items) => selectorInputTokens(config, 'judge', call.query, items) + 128,
      );
      expect(result.omitted).toBe(0);
      expect(result.batches.length).toBeGreaterThan(1);
      for (const batch of result.batches)
        expect(selectorInputTokens(config, 'judge', call.query, batch)).toBeLessThanOrEqual(1200);
      const http = vi.fn();
      vi.stubGlobal('fetch', http);
      await expect(
        f.service.call({
          ...call,
          config,
          units: [{ handle: 'c0', text: 'Large condition. '.repeat(10_000) }],
        }),
      ).rejects.toMatchObject({ reason: 'input_budget' });
      expect(f.acquire).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});

describe('Advisor fixed-budget assembly', () => {
  it('replaces lexical results inside the actual renderer budget while exact IDs and complete-unit ceilings remain authoritative', () => {
    const a = entry('m_advice', 'No overlap', 'a'.repeat(100));
    const l1 = entry('m_lex1', 'needle', 'b'.repeat(100));
    const l2 = entry('m_lex2', 'needle', 'c'.repeat(100));
    const view = { generation: 'g1', entries: [a, l1, l2] };
    const advice: MemoryAdvice = {
      fingerprint: 'f',
      generation: 'g1',
      mode: 'rank',
      seen: view.entries.map(memoryAdviceKey),
      items: [{ key: memoryAdviceKey(a), revision: a.revision, use: 'apply' }],
      status: advisorStatus('selected'),
    };
    const budget = renderMemoryWorkingSetText(
      'g1',
      [a, l1],
      new Map([[memoryAdviceKey(a), 'apply']]),
    ).length;
    const baseline = renderMemoryWorkingSet(view, 'needle', budget, 10_000);
    expect(baseline.entries.map((item) => item.id)).toEqual(['m_lex1', 'm_lex2']);
    const ranked = renderMemoryWorkingSet(view, 'needle', budget, 10_000, Date.now(), advice);
    expect(ranked.entries.map((item) => item.id)).toEqual(['m_advice', 'm_lex1']);
    expect(
      renderMemoryWorkingSet(view, '[m_lex2] needle', budget, 10_000, Date.now(), advice)
        .entries[0]!.id,
    ).toBe('m_lex2');
    const huge = { ...l2, body: 'z'.repeat(budget) };
    expect(
      renderMemoryWorkingSet(
        { ...view, entries: [a, l1, huge] },
        '[m_lex2]',
        budget,
        10_000,
        Date.now(),
        advice,
      ).entries.map((item) => item.id),
    ).not.toContain('m_lex2');
  });
  it('labels rank-only advice as recommended and never reports it as empty or applicable', () => {
    const a = entry('m_rank');
    const advice: MemoryAdvice = {
      fingerprint: 'f',
      generation: 'g1',
      mode: 'rank',
      seen: [memoryAdviceKey(a)],
      items: [{ key: memoryAdviceKey(a), revision: a.revision, use: 'recommended', score: 0.8 }],
      status: advisorStatus('selected', { applicability: 'rank_only', recommended_count: 1 }),
    };
    const result = renderMemoryWorkingSet(
      { generation: 'g1', entries: [a] },
      'no overlap',
      4_000,
      1_000,
      Date.now(),
      advice,
    );
    expect(result.text).toContain('use=recommended');
    expect(result.text).not.toContain('use=apply');
    expect(result.entries).toHaveLength(1);
  });
});
