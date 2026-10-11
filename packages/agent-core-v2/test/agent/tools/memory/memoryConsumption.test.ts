import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestAgent, appService, sessionService, agentService, type TestAgentContext } from '../../../harness';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { LOOP_CONTROL_SECTION, LoopControlSchema } from '#/agent/loop/configSection';
import { Emitter, Event } from '#/_base/event';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IMemoryScopes, type MemoryScope } from '#/app/memory/memoryScopes';
import '#/agent/tools/memory/memoryTools';
import { HistoryReadTool, HistorySearchTool, type IHistoryArchive } from '#/agent/tools/history/historyTools';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import '#/agent/tools/todo-list/todoListTool';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { MEMORY_SECTION, MemoryConfigSchema } from '#/app/memory/configSection';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { continuityClockKey } from '#/session/todo/continuityState';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';

const contexts: TestAgentContext[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const context of contexts.splice(0)) await context.dispose(); });

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
function memoryAgent(storage?: IFileSystemStorageService, agentId = 'main'): TestAgentContext {
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
    { autoConfigure: storage === undefined, initialConfig: { [MEMORY_SECTION]: MemoryConfigSchema.parse({}), [LOOP_CONTROL_SECTION]: LoopControlSchema.parse({}) } });
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
