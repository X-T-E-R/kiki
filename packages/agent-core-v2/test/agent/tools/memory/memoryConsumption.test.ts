import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestAgent, appService, sessionService, agentService, homeDirServices, type TestAgentContext } from '../../../harness';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { LOOP_CONTROL_SECTION, LoopControlSchema } from '#/agent/loop/configSection';
import { Emitter, Event } from '#/_base/event';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IDynamicPromptInjection } from '#/agent/profile/dynamicPrompt';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { ISqliteMemoryStore, SqliteMemoryStore } from '#/app/memory/sqliteMemoryStore';
import { IMemoryPersistence } from '#/persistence/interface/memoryPersistence';
import { SqliteMemoryPersistence } from '#/persistence/backends/sqliteMemory/sqliteMemoryPersistence';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IMemoryScopes, type MemoryScope } from '#/app/memory/memoryScopes';
import '#/agent/tools/memory/memoryTools';
import { HistoryReadTool, HistorySearchTool, type IHistoryArchive } from '#/agent/tools/history/historyTools';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import '#/agent/tools/todo-list/todoListTool';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IConfigService } from '#/app/config/config';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { MEMORY_SECTION, MemoryConfigSchema } from '#/app/memory/configSection';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { continuityClockKey } from '#/session/todo/continuityState';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';

const contexts: TestAgentContext[] = [];
const memoryCleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) await context.dispose();
  for (const cleanup of memoryCleanup.splice(0)) await cleanup();
});

const sessionContext: ISessionContext = {
  _serviceBrand: undefined, sessionId: 'test-session', workspaceId: 'wd_example_0123456789ab',
  sessionDir: '/test-home/sessions/test-workspace/test-session', metaScope: 'sessions/test-workspace/test-session/session-meta', cwd: '/test/workspace',
  scope: (key) => key ? `sessions/test-workspace/test-session/${key}` : 'sessions/test-workspace/test-session',
};

const memoryScopes: IMemoryScopes = {
  _serviceBrand: undefined,
  resolve: async (scope: MemoryScope) => scope.kind === 'global' ? 'memory/global' : `memory/workspaces/${sessionContext.workspaceId}`,
  listWorkspaceIds: async () => [sessionContext.workspaceId],
};

class DirectoryMemoryStorage extends InMemoryStorageService {
  override async list(scope: string, prefix?: string): Promise<readonly string[]> {
    const slash = scope.lastIndexOf('/');
    const nested = slash < 0 ? [] : (await super.list(scope.slice(0, slash), `${scope.slice(slash + 1)}/`))
      .map((key) => key.slice(scope.length - slash));
    return [...new Set([...await super.list(scope, prefix), ...nested.filter((key) => prefix === undefined || key.startsWith(prefix))])];
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function installReadableCapabilityOrigins(ctx: TestAgentContext): void {
  const config = ctx.get(IConfigService);
  if (typeof config.origins === 'function') return;
  const origins = (domain: string): Record<string, 'memory'> => {
    let value: unknown;
    try { value = config.get(domain); } catch { return {}; }
    const result: Record<string, 'memory'> = {};
    const visit = (entry: unknown, path: string[]): void => {
      if (isRecord(entry) && Object.keys(entry).length > 0) {
        for (const [key, child] of Object.entries(entry)) visit(child, [...path, key]);
        return;
      }
      if (path.length === 0) return;
      result[path.join('.')] = 'memory';
    };
    visit(value, []);
    return result;
  };
  Object.defineProperty(config, 'origins', { configurable: true, value: origins });
}

function memoryAgent(storage?: IFileSystemStorageService, agentId = 'main', store?: IMemoryStore): TestAgentContext {
  const willCreate = new Emitter<IAgentScopeHandle>();
  const didCreate = new Emitter<IAgentScopeHandle>();
  let handle: IAgentScopeHandle | undefined;
  const todo = new SessionTodoService({
    _serviceBrand: undefined, onWillCreate: willCreate.event, onDidCreate: didCreate.event, onDidDispose: Event.None as Event<string>,
    list: () => [], get: (id) => id === agentId ? handle : undefined,
    create: async () => { throw new Error('Memory fixture does not create agents.'); },
    commitCreate: () => {}, discard: async () => {}, fork: async () => { throw new Error('Memory fixture does not fork agents.'); },
    broadcastPermissionMode: () => {}, countPendingBackgroundTasks: () => 0, drainBackgroundTasks: async () => {}, remove: async () => {},
  });
  const ctx = createTestAgent(sessionService(ISessionContext, sessionContext), appService(IMemoryScopes, memoryScopes),
    sessionService(ISessionTodoService, todo),
    sessionService(ISessionInstructionsProvider, { _serviceBrand: undefined, ready: Promise.resolve(), agentsMd: '', agentsMdWarning: undefined, agentsMdPaths: [], onDidChange: Event.None as Event<void> }),
    agentService(IAgentScopeContext, { _serviceBrand: undefined, agentId, scope: (key) => `sessions/test-workspace/test-session/agents/${agentId}${key ? `/${key}` : ''}` }),
    appService(IFileSystemStorageService, storage ?? new DirectoryMemoryStorage()),
    ...(store === undefined ? [] : [appService(IMemoryStore, store)]),
    { autoConfigure: storage === undefined, initialConfig: { [MEMORY_SECTION]: MemoryConfigSchema.parse({}), [LOOP_CONTROL_SECTION]: LoopControlSchema.parse({}) } });
  installReadableCapabilityOrigins(ctx);
  contexts.push(ctx);
  handle = { id: agentId, kind: 'agent', accessor: { get: (id) => ctx.get(id) }, dispose: () => {} };
  ctx.get(ISessionTodoService);
  willCreate.fire(handle);
  didCreate.fire(handle);

  willCreate.dispose();
  didCreate.dispose();
  return ctx;
}
async function defaultAgent(): Promise<TestAgentContext> {
  const ctx = memoryAgent();
  await ctx.get(IAgentProfileService).applyProfile(ctx.get(IBuiltinAgentProfileLoader).getDefault());
  ctx.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
  return ctx;
}
async function prompt(ctx: TestAgentContext, input: string): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: 'Continue the authorized task.' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: input }] });
  await ctx.get(IAgentLoopService).settled();
}
function requestText(ctx: TestAgentContext): string {
  const request = ctx.llmCalls.at(-1)!;
  return request.history.flatMap((message) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('\n');
}

describe('actual default memory contract consumption', () => {
  it('sends the current default system, schema and merged E1/M1 through an actual mock LLM request', async () => {
    const ctx = await defaultAgent();
    await prompt(ctx, '以后回答都用中文');
    const request = ctx.llmCalls.at(-1)!;
    expect(request.systemPrompt).toContain('You are Kiki, an interactive general AI agent');
    expect(request.systemPrompt).toContain('Understand the latest request in the full conversation');
    expect(request.systemPrompt).toContain('Preserve named objects, numbers, units, versions, negative requirements, and interaction details');
    expect(request.systemPrompt).toContain('When memory tools are available, maintain saved memory');
    const search = request.tools.find((tool) => tool.name === 'MemorySearch')!;
    const write = request.tools.find((tool) => tool.name === 'MemoryWrite')!;
    expect(search).toBeDefined();
    expect(write).toBeDefined();
    expect(JSON.stringify(search.parameters)).toContain('page_size');
    expect(JSON.stringify(search.parameters)).toContain('cursor');
    for (const field of ['basis', 'validity', 'covered_by']) expect(JSON.stringify(write.parameters)).toContain(field);
    expect(write.description).toContain('omit generic permission, safety, or honesty disclaimers added by the agent');
    const text = requestText(ctx);
    expect(text).toContain('Human input t0 may change a constraint or decision');
    expect(text).toContain('choose its durable home');
    expect(text).not.toContain('This human input may change guidance beyond the current task');
    expect(text).not.toContain('MemoryWrite type=feedback');
    const event = ctx.allEvents.findLast((entry) => entry.type === '[wire]' && entry.event === 'llm.request')!;
    expect(event.args).toMatchObject({ toolsHash: expect.any(String), systemPromptHash: expect.any(String) });
    console.info('memory-consumption identity', JSON.stringify(event.args));
    await ctx.expectResumeMatches();
  });

  it('consumes M1 alone, allows no-write across windows and consumes sparse M3 only for material work', async () => {
    const ctx = await defaultAgent();
    ctx.get(ISessionTodoService).setNotes({ directives: '以后回答都用中文' }, { turnId: 0, step: 0, toolCallId: 'fixture-notes' });
    await prompt(ctx, '以后回答都用中文');
    expect(requestText(ctx)).toContain('This human input may change guidance beyond the current task');
    expect(requestText(ctx)).not.toContain('Human input t0 may change a constraint or decision');
    const states = ctx.get(IAgentStateService);
    const clock = states.get(continuityClockKey);
    expect(clock.memoryMaintenance?.failures ?? []).toEqual([]);
    states.set(contextWindowEpochKey, 1);
    await prompt(ctx, 'Continue this task');
    expect(requestText(ctx)).not.toContain('A memory write attempted in this window');
    states.set(continuityClockKey, { ...states.get(continuityClockKey), humanTurnOrdinal: 15, workStepOrdinal: 40, materialWorkStepOrdinal: 30, materialWorkTokens: 40_000 });
    await prompt(ctx, 'Continue the next implementation step');
    expect(requestText(ctx)).toContain('Consider only the new material already encountered');
    const offered = states.get(continuityClockKey);
    expect(offered.memoryMaintenance?.periodicEpoch).toBe(1);
    states.set(continuityClockKey, { ...offered, humanTurnOrdinal: 100, workStepOrdinal: 200, materialWorkStepOrdinal: 150 });
    await prompt(ctx, 'Continue the remaining step');
    const reminders = ctx.llmCalls.at(-1)!.history.filter((message) => message.content.some((part) => part.type === 'text' && part.text.includes('Consider only the new material already encountered')));
    expect(reminders).toHaveLength(1);
  });

  it('consumes an actual failed write M2 once and carries validity through relay compaction and a restored request', async () => {
    const ctx = await defaultAgent();
    const session = ctx.get(ISessionContext);
    const saved = await ctx.get(IMemoryStore).put({ action: 'create', scope: { kind: 'workspace', workspaceId: session.workspaceId }, type: 'project', title: 'Batch resource availability', body: 'Exclusive for the named batch.', validity: { check: 'Check the current schedule.', until: '2020-01-01T00:00:00Z' }, reason: 'explicit endpoint', source: { writer: 'agent', session: session.sessionId } });
    ctx.mockNextResponse({ type: 'function', id: 'failed-write', name: 'MemoryWrite', arguments: JSON.stringify({ action: 'update', id: saved.entry.id, expected_revision: 'stale', type: 'project', title: saved.entry.title, body: saved.entry.body, reason: 'test' }) });
    ctx.mockNextResponse({ type: 'text', text: 'Continue independent work.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue work' }] });
    await ctx.get(IAgentLoopService).settled();
    expect(ctx.get(IAgentStateService).get(continuityClockKey).memoryMaintenance?.failures).toMatchObject([{ callId: 'failed-write', code: 'revision_conflict' }]);
    const compact = ctx.get(IAgentFullCompactionService);
    vi.spyOn(compact, 'getAutoCompact').mockReturnValue({ ...compact.getAutoCompact(), tokens: 100_000 });
    const counting = ctx.get(IAgentTokenCountingService);
    const measured = counting.get();
    vi.spyOn(counting, 'get').mockReturnValue({ ...measured, size: 85_000 });
    await prompt(ctx, 'Continue independent implementation');
    expect(requestText(ctx)).toContain('A memory write attempted in this window still has an unresolved result or error');
    expect(requestText(ctx)).toContain(`failed-write → visible/id:${saved.entry.id} (revision_conflict)`);
    vi.restoreAllMocks();
    ctx.mockNextResponse({ type: 'function', id: 'review-notes', name: 'TodoList', arguments: JSON.stringify({ notes: { goal: 'Continue the named batch work.', next: 'Check the schedule before using exclusive availability.', evidence: `MemoryWrite failed-write → visible/id:${saved.entry.id} (revision_conflict); preserve the unsaved change and read the owning target before one corrected retry.` }, review_handoff: true }) });
    ctx.mockNextResponse({ type: 'text', text: 'Current handoff reviewed.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Review the current handoff before renewal' }] });
    await ctx.get(IAgentLoopService).settled();
    const archive: IHistoryArchive = { _serviceBrand: undefined,
      search: async () => ({ items: [], hasMore: false, indexState: { state: 'ready' }, source: 'live', coverage: { complete: true, domain: 'full_text' } }),
      readTurn: async () => undefined,
    };
    const registry = ctx.get(IAgentToolRegistryService);
    const args = [archive, session, ctx.get(IWorkspaceService), ctx.get(ISessionIndex), ctx.get(IAgentScopeContext)] as const;
    registry.register(new HistoryReadTool(...args), { source: 'builtin' });
    registry.register(new HistorySearchTool(archive, session, ctx.get(IWorkspaceService), ctx.get(IAgentScopeContext), ctx.get(ISessionIndex)), { source: 'builtin' });
    expect(await ctx.get(IAgentMemorySnapshot).liveSessionEntries()).toMatchObject([{ id: saved.entry.id, validity: saved.entry.validity }]);
    const callsBeforeRelay = ctx.llmCalls.length;
    const completed = ctx.once('compaction.completed');
    expect(compact.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    await completed;
    expect(ctx.llmCalls).toHaveLength(callsBeforeRelay);
    const history = ctx.get(IAgentContextMemoryService).get();
    expect(JSON.stringify(history)).toContain('applicability=expired');
    expect(JSON.stringify(history)).toContain('Check the current schedule.');
    const records: WireRecord[] = [];
    for await (const record of ctx.get(IAppendLogStore).read<WireRecord>(ctx.get(IAgentScopeContext).scope(), AGENT_WIRE_RECORD_KEY)) records.push(record);
    const restored = memoryAgent(ctx.get(IFileSystemStorageService));
    await restored.restore(records);
    restored.mockNextResponse({ type: 'text', text: 'Recovered the task with the required schedule check.' });
    await restored.rpc.prompt({ input: [{ type: 'text', text: 'Resume independent work' }] });
    await restored.untilTurnEnd();
    expect(restored.llmCalls.at(-1)!.systemPrompt).toContain('You are Kiki, an interactive general AI agent');
    expect(requestText(restored)).toContain('applicability=expired');
    expect(requestText(restored)).not.toContain('A memory write attempted in this window still has an unresolved result or error');
    expect(restored.get(IAgentStateService).get(continuityClockKey).memoryMaintenance?.failures?.[0]?.handedOff).toBe(true);
  });

  it.each(['fresh', 'compact'] as const)('carries status, validity and applicability through an actual %s model switch and its next request', async (mode) => {
    const ctx = await defaultAgent();
    const saved = await ctx.get(IMemoryStore).put({ action: 'create', scope: { kind: 'workspace', workspaceId: sessionContext.workspaceId }, type: 'project', title: 'Conditional capacity', body: 'Capacity is exclusive only for the named batch.', validity: { check: 'Read the current capacity schedule.', until: '2020-01-01T00:00:00Z' }, reason: 'supported endpoint', source: { writer: 'agent', session: sessionContext.sessionId } });
    await prompt(ctx, 'Continue the named batch work');
    const old = ctx.kimiConfig.models!['mock-model']!;
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, 'next-model': { ...old, model: 'next-model' } } };
    await ctx.get(ISessionMetadata).registerAgent('main', { type: 'main', model: 'mock-model' });
    if (mode === 'compact') ctx.mockNextResponse({ type: 'text', text: 'Continue independent work and check the capacity schedule.' });
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: `memory-${mode}`, model: 'next-model', mode });
    expect(result.state).toBe('completed');
    const history = JSON.stringify(ctx.get(IAgentContextMemoryService).get());
    expect(history).toContain(`[${saved.entry.id}]`);
    expect(history).toContain('status=active; applicability=expired');
    expect(history).toContain('Read the current capacity schedule.');
    await prompt(ctx, 'Resume the remaining work');
    expect(ctx.allEvents.findLast((event) => event.type === '[wire]' && event.event === 'llm.request')?.args).toMatchObject({ modelAlias: 'next-model' });
    expect(requestText(ctx)).toContain('status=active; applicability=expired');
    expect(requestText(ctx)).toContain('Read the current capacity schedule.');
  });

  it('does not project write tools or human memory-maintenance prompts into a read-only child request', async () => {
    const ctx = memoryAgent(undefined, 'child-reader');
    await ctx.get(IAgentProfileService).applyProfile(ctx.get(IBuiltinAgentProfileLoader).getDefault());
    await prompt(ctx, '以后回答都用中文');
    expect(ctx.llmCalls.at(-1)!.tools.some((tool) => tool.name === 'MemoryWrite')).toBe(false);
    expect(requestText(ctx)).not.toContain('choose its durable home');
    expect(requestText(ctx)).not.toContain('This human input may change guidance beyond the current task');
    expect(await ctx.get(IAgentMemorySnapshot).get()).toBe('');
  });

  it.each(['off', 'deny', 'disabled'] as const)('does not advertise an unavailable write capability (%s)', async (mode) => {
    const ctx = await defaultAgent();
    if (mode === 'deny') ctx.get(IAgentProfileService).update({ disallowedTools: ['MemoryWrite'] });
    else ctx.kimiConfig = { ...ctx.kimiConfig, [MEMORY_SECTION]: MemoryConfigSchema.parse({ enabled: mode !== 'disabled', approval: 'off' }) };
    await prompt(ctx, '以后回答都用中文');
    expect(ctx.llmCalls.at(-1)!.tools.some((tool) => tool.name === 'MemoryWrite')).toBe(false);
    expect(requestText(ctx)).not.toContain('choose its durable home');
    expect(requestText(ctx)).not.toContain('This human input may change guidance beyond the current task');
    expect(ctx.llmCalls.at(-1)!.systemPrompt).toContain('You are Kiki, an interactive general AI agent');
  });
});


async function canonicalMemory(onPeer?: (peer: ISqliteMemoryStore) => void): Promise<ISqliteMemoryStore> {
  const home = await mkdtemp(join(tmpdir(), 'memory-request-'));
  const containers: TestInstantiationService[] = [];
  const open = () => {
    const ix = new TestInstantiationService();
    ix.stub(IBootstrapService, { storeDir: join(home, 'store') });
    ix.stub(IMemoryScopes, memoryScopes);
    ix.set(IMemoryPersistence, new SyncDescriptor(SqliteMemoryPersistence));
    ix.set(ISqliteMemoryStore, new SyncDescriptor(SqliteMemoryStore));
    containers.push(ix);
    return ix.get(ISqliteMemoryStore);
  };
  const store = open();
  if (onPeer !== undefined) onPeer(open());
  memoryCleanup.push(async () => {
    for (const ix of containers) { await ix.get(IMemoryPersistence).close(); await ix.dispose(); }
    await rm(home, { recursive: true, force: true });
  });
  return store;
}

describe('canonical Memory actual request working sets', () => {
  it.each(['main', 'child'])('delivers complete relevant guidance to the %s actual request and removes replaced workset bodies', async (agentId) => {
    const store = await canonicalMemory();
    const scope = { kind: 'workspace', workspaceId: sessionContext.workspaceId } as const;
    const saved = await store.put({ action: 'create', scope, type: 'feedback', title: 'Deployment instructions', body: 'Use exactly 17 workers. Never publish artifacts; isolated smoke tests are the exception.', source: { writer: 'user' }, reason: 'Human guidance' });
    await store.put({ action: 'create', scope, type: 'project', title: 'Unrelated garden', body: 'Water the unrelated garden every morning.', source: { writer: 'user' }, reason: 'Another topic' });
    const ctx = memoryAgent(undefined, agentId, store);
    ctx.get(IDynamicPromptInjection);
    await ctx.get(IAgentProfileService).applyProfile(ctx.get(IBuiltinAgentProfileLoader).getDefault());
    ctx.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
    const send = async (input: string) => {
      if (agentId === 'main') return prompt(ctx, input);
      ctx.mockNextResponse({ type: 'text', text: 'Continue the delegated task.' });
      const run = await runAgentTurn({ id: agentId, accessor: { get: (id) => ctx.get(id) } }, { kind: 'prompt', prompt: input }, { signal: new AbortController().signal });
      await run.completion;
      await ctx.get(IAgentLoopService).settled();
    };
    await send('Apply the deployment instructions');
    expect(requestText(ctx)).toContain(saved.entry.body);
    expect(requestText(ctx)).not.toContain('Water the unrelated garden');
    expect(requestText(ctx)).toContain(`[full; revision=${saved.entry.revision}`);
    const changed = await store.put({ action: 'update', scope, id: saved.entry.id, expectedRevision: saved.entry.revision, type: 'feedback', title: saved.entry.title, body: 'Use exactly 9 workers. Never publish artifacts; isolated smoke tests remain the exception.', source: { writer: 'user' }, reason: 'Corrected limit' });
    await send('Continue the deployment instructions');
    expect(requestText(ctx)).toContain(changed.entry.body);
    expect(requestText(ctx)).not.toContain(saved.entry.body);
    expect(JSON.stringify(ctx.get(IAgentContextMemoryService).get())).toContain(saved.entry.body);
    await store.forget(scope, (await store.previewForget(scope, [saved.entry.id])).targets, `forget-request-${agentId}`);
    await send('Continue the deployment instructions');
    expect(requestText(ctx)).not.toContain(changed.entry.body);
  });

  it.each([['main', 'relay'], ['child', 'relay'], ['main', 'summarize']] as const)('removes stale explicit Memory tool payloads from %s requests and restored %s histories', async (agentId, strategy) => {
    let writer!: ISqliteMemoryStore;
    const store = await canonicalMemory((peer) => { writer = peer; });
    const scope = { kind: 'workspace', workspaceId: sessionContext.workspaceId } as const;
    const saved = await store.put({ action: 'create', scope, type: 'feedback', title: 'Deployment instructions', body: 'Use exactly 9 workers. Never publish artifacts; isolated smoke tests are the exception.', source: { writer: 'user' }, reason: 'Human guidance' });
    const ctx = memoryAgent(undefined, agentId, store);
    ctx.get(IDynamicPromptInjection);
    await ctx.get(IAgentProfileService).applyProfile(ctx.get(IBuiltinAgentProfileLoader).getDefault());
    ctx.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
    const send = async (input: string) => {
      const run = await runAgentTurn({ id: agentId, accessor: { get: (id) => ctx.get(id) } }, { kind: 'prompt', prompt: input }, { signal: new AbortController().signal });
      await run.completion;
      await ctx.get(IAgentLoopService).settled();
    };
    ctx.mockNextResponse({ type: 'function', id: 'explicit-search', name: 'MemorySearch', arguments: JSON.stringify({ query: 'Deployment instructions' }) });
    ctx.mockNextResponse({ type: 'function', id: 'explicit-read', name: 'MemoryRead', arguments: JSON.stringify({ id: saved.entry.id }) });
    if (agentId === 'main') ctx.mockNextResponse({ type: 'function', id: 'explicit-write', name: 'MemoryWrite', arguments: JSON.stringify({ action: 'update', id: saved.entry.id, expected_revision: saved.entry.revision, type: saved.entry.type, title: saved.entry.title, body: saved.entry.body, reason: 'Already complete guidance' }) });
    ctx.mockNextResponse({ type: 'text', text: 'Continue the authorized task.' });
    await send('Read the deployment instructions');
    const currentTools = ctx.llmCalls.at(-1)!.history.filter((message) => message.role === 'tool');
    expect(JSON.stringify(currentTools)).toContain(saved.entry.body);
    expect(JSON.stringify(ctx.llmCalls.at(-1)!.history).split(saved.entry.body)).toHaveLength(2);
    const changed = await writer.put({ action: 'update', scope, id: saved.entry.id, expectedRevision: saved.entry.revision, type: 'feedback', title: saved.entry.title, body: 'Use exactly 5 workers. Never publish artifacts; isolated smoke tests remain the exception.', source: { writer: 'user' }, reason: 'Human correction' });
    ctx.mockNextResponse({ type: 'text', text: 'Apply the current instructions.' });
    await send('Continue the deployment instructions');
    expect(requestText(ctx)).toContain(changed.entry.body);
    expect(requestText(ctx)).not.toContain(saved.entry.body);
    const revised = ctx.llmCalls.at(-1)!.history.filter((message) => message.role === 'tool');
    expect(revised.map((message) => message.toolCallId)).toEqual(['explicit-search', 'explicit-read', ...(agentId === 'main' ? ['explicit-write'] : [])]);
    expect(JSON.stringify(ctx.llmCalls.at(-1)!.history)).not.toContain(saved.entry.body);
    expect(JSON.stringify(revised)).toContain('memory_revision_changed');
    expect(JSON.stringify(ctx.get(IAgentContextMemoryService).get())).toContain(saved.entry.body);
    const records: WireRecord[] = [];
    for await (const record of ctx.get(IAppendLogStore).read<WireRecord>(ctx.get(IAgentScopeContext).scope(), AGENT_WIRE_RECORD_KEY)) records.push(record);
    await store.forget(scope, (await store.previewForget(scope, [saved.entry.id])).targets, `forget-explicit-${agentId}`);
    const restored = memoryAgent(ctx.get(IFileSystemStorageService), agentId, store);
    restored.get(IDynamicPromptInjection);
    await restored.restore(records);
    restored.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
    restored.mockNextResponse({ type: 'text', text: 'Continue independent work.' });
    const run = await runAgentTurn({ id: agentId, accessor: { get: (id) => restored.get(id) } }, { kind: 'prompt', prompt: 'Continue the deployment instructions' }, { signal: new AbortController().signal });
    await run.completion;
    expect(requestText(restored)).not.toContain(saved.entry.body);
    expect(requestText(restored)).not.toContain(changed.entry.body);
    expect(requestText(restored)).toContain('memory_unavailable');
    expect(JSON.stringify(restored.get(IAgentContextMemoryService).get())).toContain(saved.entry.body);
    const completed = restored.once('compaction.completed');
    if (strategy === 'summarize') restored.mockNextResponse({ type: 'text', text: 'Continue from the current governed Memory entries.' });
    expect(restored.get(IAgentFullCompactionService).begin({ source: 'manual', strategy })).toBe(true);
    await completed;
    expect(JSON.stringify(restored.llmCalls.at(-1)!.history)).not.toContain(saved.entry.body);
    expect(JSON.stringify(restored.llmCalls.at(-1)!.history)).not.toContain(changed.entry.body);
    restored.mockNextResponse({ type: 'text', text: 'Continue independent work after compaction.' });
    const after = await runAgentTurn({ id: agentId, accessor: { get: (id) => restored.get(id) } }, { kind: 'prompt', prompt: 'Continue independent work' }, { signal: new AbortController().signal });
    await after.completion;
    expect(requestText(restored)).not.toContain(saved.entry.body);
    expect(requestText(restored)).not.toContain(changed.entry.body);
  });

  it.each(['relay', 'summarize'] as const)('preserves exact explicit-only Memory references across %s for a current scoped reread', async (strategy) => {
    const store = await canonicalMemory();
    const scope = { kind: 'workspace', workspaceId: sessionContext.workspaceId } as const;
    const saved = await store.put({ action: 'create', scope, type: 'feedback', title: 'A rule outside the automatic working set', body: 'Use exactly 9 workers; isolated checks never publish artifacts.', source: { writer: 'user' }, reason: 'Human guidance' });
    const ctx = memoryAgent(undefined, 'main', store);
    ctx.kimiConfig = { ...ctx.kimiConfig, [MEMORY_SECTION]: MemoryConfigSchema.parse({ budget: 0 }) };
    ctx.get(IDynamicPromptInjection);
    await ctx.get(IAgentProfileService).applyProfile(ctx.get(IBuiltinAgentProfileLoader).getDefault());
    ctx.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
    ctx.mockNextResponse({ type: 'function', id: 'reference-read', name: 'MemoryRead', arguments: JSON.stringify({ id: saved.entry.id, scope: 'workspace' }) });
    await prompt(ctx, 'Retrieve the exact saved rule');
    expect(requestText(ctx)).toContain(saved.entry.body);
    expect(await ctx.get(IAgentMemorySnapshot).get()).toBe('');
    if (strategy === 'summarize') ctx.mockNextResponse({ type: 'text', text: 'Continue using current governed sources.' });
    const compact = ctx.get(IAgentFullCompactionService);
    expect(compact.begin({ source: 'manual', strategy })).toBe(true);
    expect(await compact.compacting!.promise).toMatchObject({ strategy });
    const summary = ctx.get(IAgentContextMemoryService).get().find((message) => message.origin?.kind === 'compaction_summary')!;
    const text = summary.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
    const reference = JSON.parse(text.split('\n').find((line) => line.startsWith('- {') && line.includes('"observed_revision"'))!.slice(2)) as { scope: MemoryScope; id: string; observed_revision: string };
    expect(reference).toEqual({ scope, id: saved.entry.id, observed_revision: saved.entry.revision });
    expect(text).toContain('Historical observations only');
    expect(text).not.toContain(saved.entry.title);
    expect(text).not.toContain(saved.entry.body);
    const changed = await store.put({ action: 'update', scope, id: saved.entry.id, expectedRevision: saved.entry.revision, type: saved.entry.type, title: saved.entry.title, body: 'Use exactly 5 workers; isolated checks never publish artifacts.', source: { writer: 'user' }, reason: 'Human correction' });
    ctx.mockNextResponse({ type: 'function', id: 'reference-reread', name: 'MemoryRead', arguments: JSON.stringify({ id: reference.id, scope: reference.scope.kind }) });
    await prompt(ctx, 'Recheck the observed Memory reference before continuing');
    expect(requestText(ctx)).toContain(changed.entry.body);
    expect(requestText(ctx)).not.toContain(saved.entry.body);
  });

  it('validates inherited explicit tool payloads in an actual lifecycle fork before its first request', async () => {
    const store = await canonicalMemory();
    const scope = { kind: 'workspace', workspaceId: sessionContext.workspaceId } as const;
    const saved = await store.put({ action: 'create', scope, type: 'feedback', title: 'Deployment instructions', body: 'Use exactly 9 workers. Never publish artifacts; isolated smoke tests are the exception.', source: { writer: 'user' }, reason: 'Human guidance' });
    const forkHome = await mkdtemp(join(tmpdir(), 'memory-fork-'));
    memoryCleanup.push(async () => { await rm(forkHome, { recursive: true, force: true }); });
    const ctx = createTestAgent(homeDirServices(forkHome), appService(IMemoryStore, store), appService(IMemoryScopes, memoryScopes),
      appService(IRuntimeResolver, { _serviceBrand: undefined,
        inspect: (binding) => new FakeRuntime({ ...binding, generation: 'memory-fixture' }),
        acquire: (binding) => ({ runtime: new FakeRuntime({ ...binding, generation: 'memory-fixture' }), track: (resource) => resource, dispose: () => {} }),
      }), sessionService(ISessionStateService, new SyncDescriptor(SessionStateService)),
      sessionService(ISessionContext, sessionContext), sessionService(ISessionMetadata, new SyncDescriptor(SessionMetadata)),
      sessionService(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService)),
      sessionService(ISessionInstructionsProvider, { _serviceBrand: undefined, ready: Promise.resolve(), agentsMd: '', agentsMdWarning: undefined, agentsMdPaths: [], onDidChange: Event.None as Event<void> }),
      { initialConfig: { [MEMORY_SECTION]: MemoryConfigSchema.parse({}), [LOOP_CONTROL_SECTION]: LoopControlSchema.parse({}) } });
    contexts.push(ctx);
    installReadableCapabilityOrigins(ctx);
    const lifecycle = ctx.get(IAgentLifecycleService);
    const source = await lifecycle.create({ agentId: 'fork-source' });
    await source.accessor.get(IAgentProfileService).applyProfile(ctx.get(IBuiltinAgentProfileLoader).getDefault());
    source.accessor.get(IDynamicPromptInjection);
    source.accessor.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
    ctx.mockNextResponse({ type: 'function', id: 'fork-search', name: 'MemorySearch', arguments: JSON.stringify({ query: 'Deployment instructions' }) });
    ctx.mockNextResponse({ type: 'text', text: 'Continue the authorized task.' });
    await (await runAgentTurn(source, { kind: 'prompt', prompt: 'Read deployment instructions' }, { signal: new AbortController().signal })).completion;
    expect(requestText(ctx)).toContain(saved.entry.body);
    const child = await lifecycle.fork(source.id, { agentId: 'fork-copy' });
    child.accessor.get(IDynamicPromptInjection);
    child.accessor.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
    expect(JSON.stringify(child.accessor.get(IAgentContextMemoryService).get())).toContain(saved.entry.body);
    await store.forget(scope, (await store.previewForget(scope, [saved.entry.id])).targets, 'forget-before-fork-request');
    ctx.mockNextResponse({ type: 'text', text: 'Continue independent work.' });
    await (await runAgentTurn(child, { kind: 'prompt', prompt: 'Continue deployment instructions' }, { signal: new AbortController().signal })).completion;
    expect(requestText(ctx)).not.toContain(saved.entry.body);
    expect(requestText(ctx)).toContain('memory_unavailable');
    expect(JSON.stringify(child.accessor.get(IAgentContextMemoryService).get())).toContain(saved.entry.body);
    await lifecycle.remove(child.id);
    await lifecycle.remove(source.id);
  });

  it('rebuilds current revisions after actual relay compaction and a restored profile request', async () => {
    const store = await canonicalMemory();
    const scope = { kind: 'workspace', workspaceId: sessionContext.workspaceId } as const;
    const saved = await store.put({ action: 'create', scope, type: 'feedback', title: 'Compilation policy', body: 'Compile with exactly 17 jobs; never upload output.', source: { writer: 'user' }, reason: 'Human policy' });
    const ctx = memoryAgent(undefined, 'main', store);
    ctx.get(IDynamicPromptInjection);
    await ctx.get(IAgentProfileService).applyProfile(ctx.get(IBuiltinAgentProfileLoader).getDefault());
    ctx.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
    await prompt(ctx, 'Apply the compilation policy');
    const completed = ctx.once('compaction.completed');
    expect(ctx.get(IAgentFullCompactionService).begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    await completed;
    const changed = await store.put({ action: 'update', scope, id: saved.entry.id, expectedRevision: saved.entry.revision, type: 'feedback', title: saved.entry.title, body: 'Compile with exactly 9 jobs; never upload output.', source: { writer: 'user' }, reason: 'Human correction' });
    await prompt(ctx, 'Continue the compilation policy');
    expect(requestText(ctx)).toContain(changed.entry.body);
    expect(requestText(ctx)).not.toContain(saved.entry.body);
    await ctx.expectResumeMatches();
    const records: WireRecord[] = [];
    for await (const record of ctx.get(IAppendLogStore).read<WireRecord>(ctx.get(IAgentScopeContext).scope(), AGENT_WIRE_RECORD_KEY)) records.push(record);
    const latest = await store.put({ action: 'update', scope, id: changed.entry.id, expectedRevision: changed.entry.revision, type: changed.entry.type, title: changed.entry.title, body: 'Compile with exactly 5 jobs; never upload output.', source: { writer: 'user' }, reason: 'Correction while suspended' });
    const restored = memoryAgent(ctx.get(IFileSystemStorageService), 'main', store);
    restored.get(IDynamicPromptInjection);
    await restored.restore(records);
    restored.get(IAgentFullCompactionService).setAutoCompactOverride(100_000);
    await prompt(restored, 'Resume the compilation policy');
    expect(requestText(restored)).toContain(latest.entry.body);
    expect(requestText(restored)).not.toContain(changed.entry.body);
    expect(requestText(restored)).not.toContain(saved.entry.body);
  });
});
