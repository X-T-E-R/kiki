import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHomeRuntimeService } from '#/app/runtimeHost/runtimeHost';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import { IThreadMailboxStore } from '#/app/threadCommunication/threadMailboxStore';
import { RuntimeThreadMailboxStore } from '#/app/threadCommunication/runtimeThreadMailboxStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { AgentCollaborationMessageStoreAdapter } from '#/session/agentCollaboration/threadMailboxAdapter';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { testAgent, agentServices, type TestAgentContext } from '../../harness';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { AgentModelSwitchService } from '#/agent/modelSwitch/modelSwitchService';
import { AgentModelSwitch, modelSwitchContinuityKey } from '#/agent/modelSwitch/modelSwitchOps';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { contextMemoryKey, contextRevisionKey } from '#/agent/contextMemory/contextOps';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { IAgentCollaborationMessageStore } from '#/session/agentCollaboration/messageMailbox';
import { tokenCountingKey } from '#/agent/tokenCounting/tokenCountingOps';
import { profileKey } from '#/agent/profile/profileOps';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { readTodoState, todoKey, ToolsUpdateStore } from '#/session/todo/todoOps';
import { hashTodoNotes, mergeTodoNotes } from '#/session/todo/todoNotes';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWireService } from '#/wire/wire';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { goalKey } from '#/agent/goal/goalOps';
import { IEventBus } from '#/app/event/eventBus';
import { Error2, ErrorCodes } from '#/errors';
import type { ContextMessage } from '#/agent/contextMemory/types';

const OLD = 'example/old-model';
const NEW = 'example/new-model';
const hosts: TestAgentContext[] = [];
const mailboxCleanups: (() => Promise<void>)[] = [];

function createMailbox(ctx: TestAgentContext): IAgentCollaborationMessageStore {
  const homeDir = mkdtempSync(join(tmpdir(), 'model-switch-mailbox-'));
  const ix = new TestInstantiationService();
  ix.set(IBootstrapService, { ...ctx.get(IBootstrapService), homeDir, storeDir: join(homeDir, 'store'), platform: process.platform, getEnv: () => undefined });
  ix.set(IHostFileSystem, new HostFileSystem());
  ix.set(IHomeRuntimeService, new SyncDescriptor(HomeRuntimeHostService));
  ix.set(IThreadMailboxStore, new SyncDescriptor(RuntimeThreadMailboxStore));
  ix.set(IAgentCollaborationMessageStore, new SyncDescriptor(AgentCollaborationMessageStoreAdapter));
  const store = ix.get(IThreadMailboxStore);
  const runtime = ix.get(IHomeRuntimeService);
  mailboxCleanups.push(async () => {
    await store.close();
    await runtime.close();
    ix.dispose();
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  return ix.get(IAgentCollaborationMessageStore);
}

async function createHost(): Promise<TestAgentContext> {
  const ctx = testAgent({ autoConfigure: false, initialConfig: {
    providers: { example: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' } },
    models: {
      [OLD]: { provider: 'example', model: 'old-model', maxContextSize: 200_000 },
      [NEW]: { provider: 'example', model: 'new-model', maxContextSize: 100_000 },
    },
  } }, agentServices((reg) => reg.define(IAgentModelSwitchService, AgentModelSwitchService)));
  hosts.push(ctx);
  await ctx.ready;
  ctx.get(IAgentProfileService).update({ modelAlias: OLD, thinkingLevel: 'off', systemPrompt: 'Test system prompt.' });
  await ctx.get(ISessionMetadata).registerAgent('main', { type: 'main', model: OLD, thinkingEffort: 'off' });
  const todo = ctx.get(ISessionTodoService);
  const current = () => readTodoState(ctx.get(IAgentStateService).get(todoKey));
  vi.spyOn(todo, 'getTodos').mockImplementation(() => current().items);
  vi.spyOn(todo, 'getNotes').mockImplementation(() => ({ notes: current().notes, meta: current().notesMeta }));
  vi.spyOn(todo, 'setTodos').mockImplementation((items) => { void ctx.get(IEventDispatcher).dispatch(new ToolsUpdateStore({ key: 'todo', value: items })); });
  vi.spyOn(todo, 'setNotes').mockImplementation((patch, source) => {
    const notes = mergeTodoNotes(current().notes, patch);
    void ctx.get(IEventDispatcher).dispatch(new ToolsUpdateStore({ key: 'todo_notes', value: { notes, notesMeta: {
      hash: hashTodoNotes(notes), rev: (current().notesMeta?.rev ?? 0) + 1, writtenTurn: source.turnId,
      writtenStep: `t${source.turnId}.${source.step}`, coveredMessageId: `toolcall:${source.toolCallId}`,
      windowEpoch: ctx.get(IAgentStateService).get(contextWindowEpochKey),
    } } }));
  });
  return ctx;
}

function appendOldContext(ctx: TestAgentContext): void {
  ctx.get(IAgentContextMemoryService).append({ role: 'user', content: [{ type: 'text', text: 'Investigate the saved task.' }], toolCalls: [],
    id: 'human-input', origin: { kind: 'user' }, source: { turnId: 2, step: 0 } });
  ctx.get(IAgentContextMemoryService).append({ role: 'assistant', content: [{ type: 'think', think: 'OLD_REASONING', encrypted: 'OLD_SIGNATURE' },
    { type: 'text', text: 'OLD_ASSISTANT_BODY' }], toolCalls: [{ type: 'function', id: 'call-old', name: 'Read', arguments: '{}', extras: { signature: 'OLD_TOOL_SIGNATURE' } }] });
  ctx.get(IAgentContextMemoryService).append({ role: 'tool', content: [{ type: 'text', text: 'OLD_TOOL_BODY' }], toolCalls: [], toolCallId: 'call-old' });
  ctx.get(IAgentContextMemoryService).append({ role: 'user', content: [{ type: 'text', text: 'OLD_SUMMARY_CHAIN' }], toolCalls: [], origin: { kind: 'compaction_summary' } });
}

function body(messages: readonly ContextMessage[]): string {
  return messages.flatMap((message) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('\n');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((ctx) => ctx.dispose()));
  await Promise.all(mailboxCleanups.splice(0).map((cleanup) => cleanup()));
});

describe('model switch engine', () => {
  it('prepares a binding without publishing it, then direct commits only the binding with zero requests', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const profile = ctx.get(IAgentProfileService);
    const prepared = await profile.prepareModelSwitchBinding(NEW);
    expect(profile.getModel()).toBe(OLD);
    prepared.assertCurrent();
    const before = ctx.get(IAgentContextMemoryService).get();
    const revision = ctx.get(IAgentStateService).get(contextRevisionKey);
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'direct-1', model: NEW, mode: 'direct' }, { binding: prepared });
    expect(result).toMatchObject({ state: 'completed', fromModel: OLD, toModel: NEW, windowEpoch: 0, summaryGenerated: false });
    expect(profile.getModel()).toBe(NEW);
    expect(ctx.get(IAgentContextMemoryService).get()).toBe(before);
    expect(ctx.get(IAgentStateService).get(contextRevisionKey)).toBe(revision);
    expect(ctx.llmCalls).toHaveLength(0);
    expect(body(before)).toContain('OLD_TOOL_BODY');
  });

  it('fresh works with empty notes and an offline old model, retaining only task state and history entry', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const requester = vi.spyOn(ctx.get(IAgentLLMRequesterService), 'start').mockImplementation(() => { throw new Error('old model offline'); });
    const before = ctx.get(IAgentContextMemoryService).get();
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'fresh-1', model: NEW, mode: 'fresh' });
    expect(result).toMatchObject({ state: 'completed', windowEpoch: 1, summaryGenerated: false });
    expect(requester).not.toHaveBeenCalled();
    const active = ctx.get(IAgentContextMemoryService).get();
    expect(body(active)).toContain('Investigate the saved task.');
    expect(body(active)).toContain('HistoryRead');
    expect(body(active)).toContain('test-session');
    for (const token of ['OLD_REASONING', 'OLD_SIGNATURE', 'OLD_TOOL_SIGNATURE', 'OLD_ASSISTANT_BODY', 'OLD_TOOL_BODY', 'OLD_SUMMARY_CHAIN']) {
      expect(JSON.stringify(active)).not.toContain(token);
      expect(JSON.stringify(before)).toContain(token);
    }
    expect(active.every((message) => message.origin?.kind === 'compaction_summary')).toBe(true);
  });

  it('compact summarizes the entire old window under the old binding and preserves original notes and todo metadata', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    ctx.get(IAgentContextMemoryService).append({ role: 'assistant', content: [{ type: 'text', text: 'OLD_NATIVE_TAIL' }], toolCalls: [] });
    const todo = ctx.get(ISessionTodoService);
    todo.setTodos([{ title: 'Verify result', status: 'in_progress' }]);
    todo.setNotes({ goal: 'Saved task', decided: 'Original decision', next: 'Run the remaining check' }, { turnId: 2, step: 1, toolCallId: 'notes-write' });
    const beforeNotes = structuredClone(todo.getNotes());
    const models: string[] = [];
    const requester = ctx.get(IAgentLLMRequesterService);
    const start = requester.start.bind(requester);
    vi.spyOn(requester, 'start').mockImplementation((...args) => { models.push(ctx.get(IAgentProfileService).getModel()); return start(...args); });
    ctx.mockNextResponse({ type: 'text', text: 'A portable visible summary.' });
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'compact-1', model: NEW, mode: 'compact' });
    expect(result).toMatchObject({ state: 'completed', summaryGenerated: true, windowEpoch: 1 });
    expect(models).toEqual([OLD]);
    expect(JSON.stringify(ctx.llmCalls)).toContain('OLD_NATIVE_TAIL');
    const active = ctx.get(IAgentContextMemoryService).get();
    expect(body(active)).toContain('A portable visible summary.');
    expect(body(active)).toContain('Original decision');
    expect(JSON.stringify(active)).not.toContain('OLD_NATIVE_TAIL');
    expect(JSON.stringify(active)).not.toContain('OLD_SIGNATURE');
    expect(active.every((message) => message.role === 'user' && message.toolCalls.length === 0)).toBe(true);
    expect(todo.getNotes()).toEqual(beforeNotes);
    expect(todo.getTodos()).toEqual([{ title: 'Verify result', status: 'in_progress' }]);
  });

  it('preserves text presentation when compact rebuilds the model-switch context', async () => {
    const ctx = await createHost();
    const text = 'Inspect the marked image caption.';
    const presentation = { spans: [{ start: 0, end: text.length, kind: 'image_compression' }] };
    ctx.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text, presentation }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    ctx.get(IAgentContextMemoryService).append({
      role: 'assistant',
      content: [{ type: 'text', text: 'Acknowledge.' }],
      toolCalls: [],
    });
    ctx.mockNextResponse({ type: 'text', text: 'Portable summary.' });

    const result = await ctx.get(IAgentModelSwitchService).execute({
      operationId: 'presentation-compact',
      model: NEW,
      mode: 'compact',
    });

    expect(result).toMatchObject({ state: 'completed', summaryGenerated: true });
    const active = ctx.get(IAgentContextMemoryService).get();
    expect(active.flatMap((message) => message.content)).toContainEqual({ type: 'text', text, presentation });
  });

  it('a failed summary leaves the old binding and context intact and fresh recovery never calls the old model', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const before = ctx.get(IAgentContextMemoryService).get();
    const requester = vi.spyOn(ctx.get(IAgentLLMRequesterService), 'start').mockImplementation(() => { throw new Error2(ErrorCodes.PROVIDER_AUTH_ERROR, 'old model offline'); });
    const svc = ctx.get(IAgentModelSwitchService);
    expect(await svc.execute({ operationId: 'failed-summary', model: NEW, mode: 'compact' })).toMatchObject({ state: 'failed' });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.get(IAgentContextMemoryService).get()).toBe(before);
    const count = requester.mock.calls.length;
    expect(await svc.execute({ operationId: 'recover-fresh', model: NEW, mode: 'fresh' })).toMatchObject({ state: 'completed' });
    expect(requester).toHaveBeenCalledTimes(count);
  });

  it('does not commit after the active context changes during asynchronous preparation', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    vi.spyOn(ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary').mockImplementation(async () => {
      ctx.appendUserMessage([{ type: 'text', text: 'A newly delivered input' }]);
      return 'Prepared summary';
    });
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'revision-race', model: NEW, mode: 'compact' });
    expect(result).toMatchObject({ state: 'failed', error: { code: ErrorCodes.REQUEST_INVALID } });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(body(ctx.get(IAgentContextMemoryService).get())).toContain('A newly delivered input');
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
  });

  it('a flush failure remains preparing and holds admission; retry confirms the same single window commit', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const splices: ContextSpliced[] = [];
    const subscription = ctx.get(IEventBus).subscribe(ContextSpliced, (event) => splices.push(event));
    const log = ctx.get(IAppendLogStore);
    const originalFlush = log.flush.bind(log);
    const flush = vi.spyOn(log, 'flush').mockRejectedValueOnce(new Error2(ErrorCodes.STORAGE_IO_FAILED, 'test disk unavailable')).mockImplementation(originalFlush);
    const svc = ctx.get(IAgentModelSwitchService);
    const input = { operationId: 'durable-retry', model: NEW, mode: 'fresh' as const };
    expect(await svc.execute(input)).toMatchObject({ state: 'preparing', error: { code: ErrorCodes.STORAGE_IO_FAILED } });
    expect(svc.get(input.operationId)?.state).toBe('preparing');
    expect(splices).toHaveLength(0);
    expect(ctx.get(IAgentLoopService).tryAcquireQuiescence()).toBeUndefined();
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(await svc.execute(input)).toMatchObject({ state: 'completed', windowEpoch: 1 });
    expect(flush).toHaveBeenCalledTimes(2);
    const lease = ctx.get(IAgentLoopService).tryAcquireQuiescence();
    expect(lease).toBeDefined();
    lease?.dispose();
    expect(await svc.execute(input)).toMatchObject({ state: 'completed', windowEpoch: 1 });
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(splices).toHaveLength(1);
    subscription.dispose();
  });

  it('replays the completion as one consistent binding/context/token/window fact and deduplicates the operation', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const input = { operationId: 'replay-1', model: NEW, mode: 'fresh' as const };
    const result = await ctx.get(IAgentModelSwitchService).execute(input);
    const records: import('#/wire/record').WireRecord[] = [];
    for await (const record of ctx.get(IWireService).readJournal()) records.push(record);
    const events = records.filter((record) => record.type === AgentModelSwitch.type);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    const restored = await createHost();
    await restored.restore(records);
    const states = restored.get(IAgentStateService);
    expect(states.get(profileKey).modelAlias).toBe(NEW);
    expect(states.get(contextMemoryKey)).toEqual(event['context']);
    expect(states.get(tokenCountingKey).tokens).toBe(event['contextTokens']);
    expect(states.get(contextWindowEpochKey)).toBe(1);
    const service = restored.get(IAgentModelSwitchService);
    const metadata = restored.get(ISessionMetadata);
    await metadata.registerAgent('main', { type: 'main', model: OLD, labels: { preserved: 'label' } });
    const update = metadata.updateAgent.bind(metadata);
    vi.spyOn(metadata, 'updateAgent').mockRejectedValueOnce(new Error2(ErrorCodes.STORAGE_IO_FAILED, 'metadata projection unavailable')).mockImplementation(update);
    const summary = vi.spyOn(restored.get(IAgentFullCompactionService), 'prepareModelSwitchSummary');
    const status = vi.spyOn(restored.get(IAgentProfileService), 'republishStatus');
    expect(service.get(input.operationId)?.state).toBe('preparing');
    expect(await service.execute(input)).toMatchObject({ state: 'preparing', error: { code: ErrorCodes.STORAGE_IO_FAILED } });
    expect(restored.get(IAgentLoopService).tryAcquireQuiescence()).toBeUndefined();
    expect(service.get(input.operationId)?.state).toBe('preparing');
    expect(await service.execute(input)).toEqual(result);
    expect(service.get(input.operationId)).toEqual(result);
    expect((await metadata.read()).agents?.['main']).toMatchObject({ model: NEW, contextTokens: event['contextTokens'],
      labels: { preserved: 'label', contextWindowEpoch: '1' } });
    expect(status).toHaveBeenCalledTimes(1);
    expect(summary).not.toHaveBeenCalled();
    expect(states.get(contextWindowEpochKey)).toBe(1);
    expect(restored.llmCalls).toHaveLength(0);
    const missingProjection = await createHost();
    await missingProjection.restore(records);
    const missingMetadata = missingProjection.get(ISessionMetadata);
    await missingMetadata.update({ agents: {} });
    expect(await missingProjection.get(IAgentModelSwitchService).execute(input)).toMatchObject({ state: 'preparing',
      error: { code: 'agent_metadata_missing' } });
    expect((await missingMetadata.read()).agents?.['main']).toBeUndefined();
    expect(missingProjection.get(IAgentModelSwitchService).get(input.operationId)).toMatchObject({ state: 'preparing',
      error: { code: 'agent_metadata_missing' } });
    expect(missingProjection.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(missingProjection.llmCalls).toHaveLength(0);
  });

  it('serializes model projections with a concurrent resume-label write without losing other metadata', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const metadata = ctx.get(ISessionMetadata);
    await metadata.registerAgent('main', { type: 'sub', parentAgentId: 'parent', model: OLD,
      displayName: 'preserved display', labels: { preserved: 'label' } });
    const documents = ctx.get(IAtomicDocumentStore);
    const set = documents.set.bind(documents);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(documents, 'set').mockImplementationOnce(async (...args) => {
      started();
      await blocked;
      return set(...args);
    });
    const labelWrite = metadata.updateAgent('main', (current) => ({ ...current, status: 'completed', resultSummary: 'Concurrent receipt',
      labels: { ...current.labels, modelSwitchResumeOperationId: 'resume-1', unrelated: 'new value' } }));
    await entered;
    const switchWrite = ctx.get(IAgentModelSwitchService).execute({ operationId: 'metadata-interleave', model: NEW, mode: 'direct' });
    await vi.waitFor(() => expect(ctx.get(IAgentProfileService).getModel()).toBe(NEW));
    expect(ctx.get(IAgentModelSwitchService).get('metadata-interleave')?.state).toBe('preparing');
    release();
    await labelWrite;
    expect(await switchWrite).toMatchObject({ state: 'completed' });
    expect((await metadata.read()).agents?.['main']).toMatchObject({ type: 'sub', parentAgentId: 'parent', model: NEW,
      displayName: 'preserved display', status: 'completed', resultSummary: 'Concurrent receipt',
      labels: { preserved: 'label', modelSwitchResumeOperationId: 'resume-1', unrelated: 'new value', contextWindowEpoch: '0' } });
  });

  it('inherits goal budget, child identities, background handles and refreshed structured state without rewriting them', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const states = ctx.get(IAgentStateService);
    states.set(goalKey, { goalId: 'goal-1', objective: 'Complete verification', status: 'paused', turnsUsed: 3,
      tokensUsed: 800, wallClockMs: 900, budgetLimits: { tokenBudget: 4000 }, controlRevision: 2, followUpTiming: 'subagents_done' });
    const goal = states.get(goalKey);
    const metadata = ctx.get(ISessionMetadata);
    await metadata.registerAgent('child-a', { type: 'sub', parentAgentId: 'main', model: OLD, labels: { collaborationTaskName: 'child_a' } });
    await metadata.registerAgent('child-b', { type: 'sub', parentAgentId: 'main', model: OLD, labels: { collaborationTaskName: 'child_b' } });
    const children = (await metadata.read()).agents;
    const liveTasks = [{ taskId: 'process-1', kind: 'process' as const, status: 'running' as const, description: 'Isolated worker',
      startedAt: 1, endedAt: null, command: 'test', pid: 123, exitCode: null }];
    vi.spyOn(ctx.get(IAgentTaskService), 'list').mockReturnValue(liveTasks);
    vi.spyOn(ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary').mockImplementation(async () => {
      ctx.get(ISessionTodoService).setNotes({ next: 'New state written during preparation' }, { turnId: 4, step: 1, toolCallId: 'notes-during-prepare' });
      return 'Portable summary';
    });
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'inherit-1', model: NEW, mode: 'compact' });
    expect(result.state).toBe('completed');
    expect(states.get(goalKey)).toBe(goal);
    const agents = (await metadata.read()).agents!;
    expect(agents['child-a']).toEqual(children?.['child-a']);
    expect(agents['child-b']).toEqual(children?.['child-b']);
    expect(ctx.get(IAgentTaskService).list()).toBe(liveTasks);
    const text = body(ctx.get(IAgentContextMemoryService).get());
    for (const value of ['New state written during preparation', 'goal-1', 'child-a', 'child-b', 'process-1']) expect(text).toContain(value);
  });

  it('does not revive withdrawn human input in a fresh continuity package', async () => {
    const ctx = await createHost();
    ctx.get(IAgentModelSwitchService);
    ctx.appendTurnExchange('Keep the original objective.', 'First result.');
    ctx.appendTurnExchange('WITHDRAWN_INPUT', 'Second result.');
    const states = ctx.get(IAgentStateService);
    expect(states.get(modelSwitchContinuityKey).latestHumanInput?.text).toBe('WITHDRAWN_INPUT');
    await ctx.get(IAgentConversationUndoService).undo(1);
    expect(states.get(modelSwitchContinuityKey).latestHumanInput?.text).toBe('Keep the original objective.');
    expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: 'undo-input-fresh', model: NEW, mode: 'fresh' })).toMatchObject({ state: 'completed' });
    const text = body(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain('Keep the original objective.');
    expect(text).not.toContain('WITHDRAWN_INPUT');
  });

  it('keeps direct undo checkpoints but establishes a new checkpoint boundary for fresh without changing todo values', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const todo = ctx.get(ISessionTodoService);
    todo.setTodos([{ title: 'Preserved item', status: 'pending' }]);
    const dispatcher = ctx.get(IEventDispatcher);
    const depth = dispatcher.checkpointDepth(todoKey);
    expect(depth).toBeGreaterThan(0);
    await ctx.get(IAgentModelSwitchService).execute({ operationId: 'undo-direct', model: NEW, mode: 'direct' });
    expect(dispatcher.checkpointDepth(todoKey)).toBe(depth);
    await ctx.get(IAgentModelSwitchService).execute({ operationId: 'undo-fresh', model: NEW, mode: 'fresh' });
    expect(dispatcher.checkpointDepth(todoKey)).toBe(0);
    expect(todo.getTodos()).toEqual([{ title: 'Preserved item', status: 'pending' }]);
  });

  it('rejects target capacity failure before committing and supports same-model fresh without history tools', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const binding = await ctx.get(IAgentProfileService).prepareModelSwitchBinding(NEW);
    expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: 'capacity-1', model: NEW, mode: 'fresh' },
      { binding: { ...binding, maxContextTokens: 1, reservedTokens: 0 } })).toMatchObject({ state: 'failed', error: { code: ErrorCodes.CONTEXT_OVERFLOW } });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: 'same-fresh', model: OLD, mode: 'fresh' })).toMatchObject({ state: 'completed', fromModel: OLD, toModel: OLD, windowEpoch: 1 });
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('empty and human-only compact never call the summary requester, and cancellation preserves the old state', async () => {
    const ctx = await createHost();
    const svc = ctx.get(IAgentModelSwitchService);
    expect(await svc.execute({ operationId: 'empty-1', model: NEW, mode: 'compact' })).toMatchObject({ state: 'completed', summaryGenerated: false });
    expect(ctx.get(IAgentContextMemoryService).get()).toEqual([]);
    ctx.appendUserMessage([{ type: 'text', text: 'A waiting human input' }]);
    expect(await svc.execute({ operationId: 'human-only', model: OLD, mode: 'compact' })).toMatchObject({ state: 'completed', summaryGenerated: false });
    expect(body(ctx.get(IAgentContextMemoryService).get())).toContain('A waiting human input');
    const before = ctx.get(IAgentContextMemoryService).get();
    const controller = new AbortController();
    controller.abort();
    expect(await svc.execute({ operationId: 'cancelled-1', model: NEW, mode: 'fresh' }, { signal: controller.signal })).toMatchObject({ state: 'cancelled' });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.get(IAgentContextMemoryService).get()).toBe(before);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('shares concurrent and reentrant retries and rejects reused operation IDs with different choices', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const svc = ctx.get(IAgentModelSwitchService);
    const input = { operationId: 'single-flight', model: NEW, mode: 'compact' as const };
    const retries: Promise<unknown>[] = [];
    let observed = false;
    const subscription = svc.onDidChange((receipt) => {
      if (receipt.state === 'preparing' && !observed) { observed = true; retries.push(svc.execute(input)); }
    });
    ctx.mockNextResponse({ type: 'text', text: 'One summary request.' });
    const first = svc.execute(input);
    const second = svc.execute(input);
    expect(await Promise.all([first, second, ...retries])).toEqual(Array(3).fill(await first));
    subscription.dispose();
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    await expect(svc.execute({ ...input, mode: 'fresh' })).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
  });

  it('preserves saved task input and latest human source through repeated fresh windows without carrying the old package', async () => {
    const ctx = await createHost();
    ctx.get(IAgentContextMemoryService).append({ role: 'user', toolCalls: [], content: [{ type: 'text', text: 'Saved child task description' }],
      origin: { kind: 'system_trigger', name: 'subagent' }, source: { turnId: 1, step: 0 } });
    appendOldContext(ctx);
    const svc = ctx.get(IAgentModelSwitchService);
    await svc.execute({ operationId: 'repeat-fresh-1', model: NEW, mode: 'fresh' });
    await svc.execute({ operationId: 'repeat-fresh-2', model: OLD, mode: 'fresh' });
    const text = body(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain('Saved child task description');
    expect(text).toContain('Investigate the saved task.');
    expect(text).toContain('step_id:"t2.0"');
    expect(text.match(/This context starts from existing task state/g)).toHaveLength(1);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('fits a bounded state preview to the target window and leaves full source notes unchanged', async () => {
    const ctx = await createHost();
    ctx.get(IAgentContextMemoryService).append({ role: 'user', toolCalls: [], content: [{ type: 'text', text: 'Latest input '.repeat(2000) }],
      origin: { kind: 'user' }, source: { ref: 'source-human-ref', turnId: 7, step: 0 } });
    ctx.get(ISessionTodoService).setNotes({ next: 'Next action '.repeat(100) }, { turnId: 7, step: 1, toolCallId: 'long-notes' });
    const notes = structuredClone(ctx.get(ISessionTodoService).getNotes());
    const binding = await ctx.get(IAgentProfileService).prepareModelSwitchBinding(NEW);
    const overhead = ctx.get(IAgentTokenCountingService).requestSize({ systemPrompt: binding.config.systemPrompt ?? ctx.get(IAgentProfileService).getSystemPrompt(),
      tools: ctx.get(IAgentToolSelectService).shapeTools(ctx.get(IAgentToolRegistryService).list()).filter((tool) => tool.deferred !== true)
        .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters ?? {} })), messages: [] });
    const maxContextTokens = overhead + 1500;
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'bounded-state', model: NEW, mode: 'fresh' },
      { binding: { ...binding, maxContextTokens, reservedTokens: 0 } });
    expect(result).toMatchObject({ state: 'completed' });
    expect(ctx.get(IAgentStateService).get(tokenCountingKey).tokens).toBeLessThanOrEqual(maxContextTokens);
    expect(body(ctx.get(IAgentContextMemoryService).get())).toContain('Preview only');
    expect(body(ctx.get(IAgentContextMemoryService).get())).toContain('source-human-ref');
    expect(ctx.get(ISessionTodoService).getNotes()).toEqual(notes);
  });

  it('rejects an inconsistent prepared binding before any fold or durable completion', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const binding = await ctx.get(IAgentProfileService).prepareModelSwitchBinding(NEW);
    const before = ctx.get(IAgentContextMemoryService).get();
    expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: 'invalid-binding', model: NEW, mode: 'direct' },
      { binding: { ...binding, config: { ...binding.config, modelAlias: OLD } } })).toMatchObject({ state: 'failed', error: { code: ErrorCodes.REQUEST_INVALID } });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.get(IAgentContextMemoryService).get()).toBe(before);
  });

  it('uses non-applicable executor capacity only for direct and refuses context rebuilding before summary requests', async () => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const prepared = await ctx.get(IAgentProfileService).prepareModelSwitchBinding(NEW);
    const binding = { ...prepared, maxContextTokens: undefined, reservedTokens: undefined };
    const summary = vi.spyOn(ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary');
    const before = ctx.get(IAgentContextMemoryService).get();
    for (const mode of ['fresh', 'compact'] as const) {
      expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: `unsupported-${mode}`, model: NEW, mode }, { binding }))
        .toMatchObject({ state: 'failed', error: { code: ErrorCodes.REQUEST_INVALID } });
    }
    expect(summary).not.toHaveBeenCalled();
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: 'executor-direct', model: NEW, mode: 'direct' }, { binding }))
      .toMatchObject({ state: 'completed', windowEpoch: 0 });
    expect(ctx.get(IAgentContextMemoryService).get()).toBe(before);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it.each(['direct', 'compact', 'fresh'] as const)('%s preserves the durable mailbox claim and notification dedup identities', async (mode) => {
    const ctx = await createHost();
    appendOldContext(ctx);
    const mailbox = createMailbox(ctx);
    const accepted = await mailbox.accept({ sessionId: 'test-session', sourceAgentId: 'child-a', sourceTaskName: 'child_a',
      targetAgentId: 'main', targetTaskName: 'main', content: 'A pending attributed receipt', idempotencyKey: 'receipt-1' });
    const claimed = await mailbox.nextQueued('test-session', 'main');
    expect(claimed?.message.messageId).toBe(accepted.message.messageId);
    const states = ctx.get(IAgentStateService);
    states.set(taskNotificationDeliveryKey, ['already-delivered-notification']);
    const delivered = states.get(taskNotificationDeliveryKey);
    if (mode === 'compact') ctx.mockNextResponse({ type: 'text', text: 'Portable summary' });
    expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: `mailbox-${mode}`, model: NEW, mode })).toMatchObject({ state: 'completed' });
    expect(states.get(taskNotificationDeliveryKey)).toBe(delivered);
    expect(await mailbox.listPendingAgents('test-session')).toEqual(['main']);
    expect(await mailbox.markDelivered(claimed!.claim)).toBe(true);
    expect(await mailbox.listPendingAgents('test-session')).toEqual([]);
    expect(await mailbox.nextQueued('test-session', 'main')).toBeUndefined();
  });
});
