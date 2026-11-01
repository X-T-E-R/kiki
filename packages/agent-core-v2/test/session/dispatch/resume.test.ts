import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import { SubagentToolInputSchema } from '#/agent/tools/agent/agent';
import { addSubagentBindingSchemaConstraints } from '#/session/subagent/configSection';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IUsageFactStore } from '#/app/usageFacts/usageFactStore';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentCollaborationRegistry } from '#/session/agentCollaboration/registry';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionExecutionControl } from '#/session/executionControl/executionControl';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import { ISessionDispatchService, type DispatchChild, type DispatchRunOptions } from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import { acknowledgeResumeOutcome, bindResumeTask, pruneResumeRecords, readResumeRecord, writeResumeRecord, type DispatchResumeRecord } from '#/session/dispatch/resume';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { ExternalTurnRecorder } from '#/agent/execution/externalTurnRecorder';
import { resolveAgentRunSource } from '#/agent/prompt/agentReferences';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentExecutorRegistry, type ResolvedAgentExecutor } from '#/app/agentExecutor/agentExecutor';
import { recordNegotiatedSnapshot } from '#/agent/execution/negotiatedSnapshot';
import { nativeTargets } from '@kiki/agent-profiles/nativeTarget';
import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { AGENT_RUN_PROMPT_ORIGIN, runAgentTurn } from '#/session/subagent/runAgentTurn';
import { createHooks } from '#/hooks';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { Error2, ErrorCodes } from '#/errors';
import { agentServices, appServices, testAgent, type TestAgentContext } from '../../harness';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { Event } from '#/_base/event';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTask } from '#/agent/task/types';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentCollaborationMessageStore, IAgentCollaborationMessagingService, type AcceptedAgentMessage } from '#/session/agentCollaboration/messageMailbox';
import { AgentCollaborationMessagingService } from '#/session/agentCollaboration/messagingService';
import type { ThreadDeliveryClaim } from '#/app/threadCommunication/threadMailboxStore';
import { IAgentListTool, type AgentListOutput } from '#/agent/tools/agent-list/agent-list';
import { AgentListTool } from '#/agent/tools/agent-list/agentListTool';
import { executeTool } from '../../tools/fixtures/execute-tool';

const OLD = 'example/old-model';
const NEW = 'example/new-model';
const CHILD = 'saved-child';
const hosts: TestAgentContext[] = [];
const containers: TestInstantiationService[] = [];

async function host(realAppend = false) {
  const ctx = testAgent({ autoConfigure: false, initialConfig: {
    providers: { example: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' } },
    models: {
      [OLD]: { provider: 'example', model: 'old-model', maxContextSize: 200_000, capabilities: ['thinking'], supportEfforts: ['low', 'high'], defaultEffort: 'high' },
      [NEW]: { provider: 'example', model: 'new-model', maxContextSize: 100_000, capabilities: ['thinking'], supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    },
  } }, agentServices((reg) => reg.defineInstance(IAgentScopeContext, {
    _serviceBrand: undefined, agentId: CHILD, parentAgentId: 'main',
    scope: (subKey) => `test-session/agents/${CHILD}${subKey ? `/${subKey}` : ''}`,
  })), appServices((reg) => { if (realAppend) reg.define(IAppendLogStore, AppendLogStore); }));
  hosts.push(ctx);
  await ctx.ready;
  await ctx.get(IAgentProfileService).bind({ model: OLD, thinking: 'off', delegationPosition: 'sub',
    resolvedProfile: normalizeAgentProfile({ name: 'example-worker', modelAlias: OLD, allowedModels: [OLD, NEW], tools: [], systemPrompt: () => 'Test role.' }) });
  await ctx.get(ISessionMetadata).registerAgent(CHILD, { type: 'sub', parentAgentId: 'main', delegator: { kind: 'agent', agentId: 'main' },
    userLabel: 'Saved task', labels: { taskName: 'saved_child', agentType: 'example-worker', customState: 'preserved' }, model: OLD });
  ctx.get(IAgentContextMemoryService).append({ role: 'user', content: [{ type: 'text', text: 'Original task' }], toolCalls: [], origin: { kind: 'user' } });
  ctx.get(IAgentContextMemoryService).append({ role: 'assistant', content: [{ type: 'text', text: 'OLD_BODY' }, { type: 'think', think: 'OLD_THINK', encrypted: 'OLD_SIGNATURE' }], toolCalls: [] });
  const handle: IAgentScopeHandle = { kind: 'agent', id: CHILD, accessor: { get: (id) => ctx.get(id) }, dispose: () => {} };
  vi.spyOn(ctx.get(IAgentLifecycleService), 'get').mockImplementation((id) => id === CHILD ? handle : undefined);
  ctx.get(IAgentExecutionService);
  return ctx;
}

function dispatchFor(ctx: TestAgentContext) {
  const ix = new TestInstantiationService();
  containers.push(ix);
  const childHandle: IAgentScopeHandle = { kind: 'agent', id: CHILD, accessor: { get: (id) => ctx.get(id) }, dispose: () => {} };
  const callerHandle: IAgentScopeHandle = { kind: 'agent', id: 'main', accessor: { get: (id) => ctx.get(id) }, dispose: () => {} };
  ix.stub(IAgentLifecycleService, { onDidCreate: Event.None as IAgentLifecycleService['onDidCreate'],
    get: (id) => id === CHILD ? childHandle : id === 'main' ? callerHandle : undefined });
  ix.stub(IAgentCollaborationRegistry, {});
  ix.set(IConfigService, ctx.get(IConfigService));
  ix.set(IModelService, ctx.get(IModelService));
  ix.set(IModelCatalog, ctx.get(IModelCatalog));
  ix.set(IAgentExecutorRegistry, ctx.get(IAgentExecutorRegistry));
  ix.set(ISessionMetadata, ctx.get(ISessionMetadata));
  ix.set(ISessionAgentProfileCatalog, ctx.get(ISessionAgentProfileCatalog));
  ix.set(ILogService, ctx.get(ILogService));
  ix.set(IBootstrapService, ctx.get(IBootstrapService));
  ix.set(IFlagService, ctx.get(IFlagService));
  ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
  ix.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
  const dispatch = ix.get(ISessionDispatchService);
  const child: DispatchChild = { agent: childHandle, agentId: CHILD, name: 'saved_child', profileName: 'example-worker', thinkingEffort: 'off' };
  return { dispatch, child, runs: ix.get(ISessionSubagentService) };
}

async function defaultExternal(id = 'claude-acp', modelAlias?: string) {
  const ctx = await host();
  const registry = ctx.get(IAgentExecutorRegistry);
  const delivered: unknown[] = [];
  const resolved: ResolvedAgentExecutor = { descriptor: { id, protocol: 'acp', args: [], revision: 'fixture' }, options: {},
    provider: { id, protocol: 'acp', validateOptions: () => ({}), validateBinding: binding => ({ ok: true, binding }),
      create: context => ({ hooks: createHooks(['onWillRun']), status: () => ({ state: 'idle' }), cancel: () => false,
        settled: async () => {}, shutdown: async () => {}, run: async request => {
          delivered.push({ request, binding: context.binding });
          throw new Error('fixture-native-run-reached');
        } }) } };
  vi.spyOn(registry, 'resolve').mockReturnValue(resolved);
  vi.spyOn(registry, 'resolveExecutable').mockResolvedValue(resolved);
  vi.spyOn(registry, 'validateBinding').mockImplementation((_id, _options, binding) => ({ ok: true, binding }));
  vi.spyOn(registry, 'get').mockReturnValue(resolved.descriptor);
  await ctx.get(IAgentProfileService).bind({ resolvedProfile: modelAlias === undefined
    ? nativeTargets([resolved.descriptor])[0]
    : normalizeAgentProfile({ name: 'external-worker', executor: id, modelAlias, allowedModels: [modelAlias], tools: [], systemPrompt: () => 'External test role.' }),
  model: modelAlias, thinking: modelAlias === undefined ? undefined : 'off', delegationPosition: 'sub' });
  return { ctx, delivered, ...dispatchFor(ctx) };
}

async function journal(ctx: TestAgentContext): Promise<WireRecord[]> {
  await ctx.get(IWireService).flush();
  const records: WireRecord[] = [];
  for await (const record of ctx.get(IWireService).readJournal()) records.push(record);
  return records;
}

function options(operationId: string, bindingOverride?: DispatchRunOptions['bindingOverride']): DispatchRunOptions {
  return { operationId, signal: new AbortController().signal, requesterAgentId: 'main', bindingOverride };
}

async function complete(ctx: TestAgentContext, operationId: string, bindingOverride?: DispatchRunOptions['bindingOverride']) {
  const { dispatch, child } = dispatchFor(ctx);
  ctx.mockNextResponse({ type: 'text', text: 'Resumed result.' });
  const run = await dispatch.runOnExisting(child, 'Continue exactly once.', options(operationId, bindingOverride));
  const handle = await run.started;
  await handle.completion;
  return { dispatch, child, run, handle };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(containers.splice(0).map(async (ix) => { await ix.dispose(); }));
  await Promise.all(hosts.splice(0).map(async (ctx) => { await ctx.dispose(); }));
});

describe('AgentRun context mode shape', () => {
  it.each(['direct', 'compact', 'fresh'] as const)('requires resume for explicit %s and rejects legacy option mixtures', (context_mode) => {
    const input = { prompt: 'Continue', description: 'Continue task', context_mode };
    expect(SubagentToolInputSchema.safeParse(input).success).toBe(false);
    expect(SubagentToolInputSchema.safeParse({ ...input, resume: CHILD }).success).toBe(true);
    for (const flag of ['new_window', 'allow_model_change']) {
      for (const value of [true, false]) {
        const parsed = SubagentToolInputSchema.safeParse({ ...input, resume: CHILD, model_alias: NEW, [flag]: value });
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.message).toContain('mutually exclusive');
      }
    }
    const schema = toInputJsonSchema(SubagentToolInputSchema, addSubagentBindingSchemaConstraints);
    expect(schema['properties']).toHaveProperty('context_mode');
    expect(schema['allOf']).toContainEqual(JSON.parse('{"if":{"required":["context_mode"]},"then":{"required":["resume"]}}'));
    expect(schema['allOf']).toContainEqual({ not: { allOf: [{ required: ['context_mode'] }, { anyOf: [{ required: ['new_window'] }, { required: ['allow_model_change'] }] }] } });
  });
  it.each([false, true])('requires resume whenever new_window is %s', (new_window) => {
    expect(SubagentToolInputSchema.safeParse({ prompt: 'Continue', description: 'Continue task', new_window }).success).toBe(false);
    expect(SubagentToolInputSchema.safeParse({ prompt: 'Continue', description: 'Continue task', resume: CHILD, new_window }).success).toBe(true);
  });
  it('retains allow_model_change shape and exposes new_window JSON shape', () => {
    expect(SubagentToolInputSchema.safeParse({ prompt: '', description: '', resume: CHILD, allow_model_change: false, new_window: true }).success).toBe(false);
    const schema = toInputJsonSchema(SubagentToolInputSchema, addSubagentBindingSchemaConstraints);
    expect(schema['properties']).toHaveProperty('new_window');
    expect(schema['allOf']).toContainEqual(JSON.parse('{"if":{"required":["new_window"]},"then":{"required":["resume"]}}'));
  });
});

describe('dispatch resume through model switch and real native run', () => {
  it.each(['direct', 'compact', 'fresh'].flatMap(contextMode => [undefined, NEW].map(modelAlias => ({ contextMode: contextMode as 'direct' | 'compact' | 'fresh', modelAlias }))))(
    'continues explicit $contextMode with model=$modelAlias through the same native child', async ({ contextMode, modelAlias }) => {
      const ctx = await host();
      const todo = ctx.get(ISessionTodoService);
      todo.setTodos([{ title: 'Remaining verification', status: 'in_progress' }], CHILD);
      todo.setNotes({ goal: 'Saved task goal', evidence: 'Sourced task evidence' }, { turnId: 3, step: 1, toolCallId: 'notes-source' }, CHILD);
      const beforeNotes = structuredClone(todo.getNotes(CHILD));
      const beforeMeta = (await ctx.get(ISessionMetadata).read()).agents![CHILD]!;
      const models: string[] = [];
      const requester = ctx.get(IAgentLLMRequesterService);
      const start = requester.start.bind(requester);
      vi.spyOn(requester, 'start').mockImplementation((...args) => { models.push(ctx.get(IAgentProfileService).getModel()); return start(...args); });
      if (contextMode === 'compact') ctx.mockNextResponse({ type: 'text', text: 'Portable summary of the original work.' });
      const { child, handle } = await complete(ctx, 'explicit-mode', { contextMode, modelAlias });
      expect(child.agentId).toBe(CHILD);
      expect(handle.agentId).toBe(CHILD);
      expect(models).toEqual(contextMode === 'compact' ? [OLD, modelAlias ?? OLD] : [modelAlias ?? OLD]);
      const continuation = JSON.stringify(ctx.llmCalls.at(-1));
      expect(continuation.includes('OLD_BODY')).toBe(contextMode === 'direct');
      if (contextMode === 'compact') {
        expect(JSON.stringify(ctx.llmCalls[0])).toContain('OLD_BODY');
        expect(continuation).toContain('Portable summary of the original work.');
        expect(continuation).not.toContain('OLD_SIGNATURE');
      }
      expect((continuation.match(/Continue exactly once\./g) ?? [])).toHaveLength(1);
      expect(ctx.get(IAgentModelSwitchService).get('explicit-mode')).toMatchObject({ state: 'completed', mode: contextMode, summaryGenerated: contextMode === 'compact' });
      expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(contextMode === 'direct' ? 0 : 1);
      expect(todo.getNotes(CHILD)).toEqual(beforeNotes);
      expect(todo.getTodos(CHILD)).toEqual([{ title: 'Remaining verification', status: 'in_progress' }]);
      expect((await ctx.get(ISessionMetadata).read()).agents![CHILD]).toMatchObject({ parentAgentId: beforeMeta.parentAgentId, delegator: beforeMeta.delegator,
        labels: { customState: 'preserved', taskName: 'saved_child' } });
      const records = await journal(ctx);
      expect(records.some(record => record.type === 'context.append_message' && JSON.stringify(record).includes('OLD_BODY'))).toBe(true);
    },
  );

  it('rejects conflicting runtime modes before binding preparation or launch', async () => {
    const ctx = await host();
    const { dispatch, child, runs } = dispatchFor(ctx);
    const prepare = vi.spyOn(ctx.get(IAgentProfileService), 'prepareResumeBinding');
    const start = vi.spyOn(runs, 'run');
    await expect(dispatch.runOnExisting(child, 'Conflict', options('conflict', { contextMode: 'compact', newWindow: false }))).rejects.toThrow('mutually exclusive');
    await expect(ctx.get(IAgentProfileService).prepareResumeBinding({ contextMode: 'direct', allowModelChange: true })).rejects.toThrow('mutually exclusive');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('rechecks launch admission after a compact summary before committing the binding', async () => {
    const ctx = await host();
    const { dispatch, child, runs } = dispatchFor(ctx);
    const startRun = vi.spyOn(runs, 'run');
    let planActive = false;
    const plan = dispatch.registerPlanStateReader('main', () => planActive);
    const requester = ctx.get(IAgentLLMRequesterService);
    const start = requester.start.bind(requester);
    vi.spyOn(requester, 'start').mockImplementation((...args) => { planActive = true; return start(...args); });
    ctx.mockNextResponse({ type: 'text', text: 'Prepared summary under old admission.' });
    try {
      await expect(dispatch.runOnExisting(child, 'Must not launch', options('admission-race', { contextMode: 'compact', modelAlias: NEW }))).rejects.toThrow();
      expect(startRun).not.toHaveBeenCalled();
      expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
      expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
      expect(ctx.llmCalls).toHaveLength(1);
    } finally { await plan.dispose(); }
  });

  it.each(['failure', 'cancel'] as const)('preserves old binding on compact summary %s and can continue fresh', async (outcome) => {
    const ctx = await host();
    const { dispatch, child, runs } = dispatchFor(ctx);
    const startRun = vi.spyOn(runs, 'run');
    const context = ctx.get(IAgentContextMemoryService).get();
    const controller = new AbortController();
    const requester = vi.spyOn(ctx.get(IAgentLLMRequesterService), 'start').mockImplementation(() => {
      if (outcome === 'cancel') controller.abort(new Error('Summary cancelled'));
      throw new Error2(ErrorCodes.PROVIDER_AUTH_ERROR, 'Summary unavailable');
    });
    await expect(dispatch.runOnExisting(child, 'Continue after compact', { ...options('compact-interrupted', { contextMode: 'compact', modelAlias: NEW }), signal: controller.signal })).rejects.toThrow();
    expect(startRun).not.toHaveBeenCalled();
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.get(IAgentContextMemoryService).get()).toBe(context);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
    expect(ctx.get(IAgentModelSwitchService).get('compact-interrupted')).toBeUndefined();
    requester.mockRestore();
    await complete(ctx, 'fresh-after-interruption', { contextMode: 'fresh', modelAlias: NEW });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(NEW);
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('recovers a durably committed compact resume after restart without summarizing or replaying its launched prompt', async () => {
    const original = await host();
    const { dispatch, child, runs } = dispatchFor(original);
    const startRun = vi.spyOn(runs, 'run');
    const opts = options('cold-compact', { contextMode: 'compact', modelAlias: NEW });
    const metadata = original.get(ISessionMetadata);
    const update = metadata.updateAgent.bind(metadata);
    vi.spyOn(metadata, 'updateAgent').mockImplementation(async (id, updater) => {
      const current = (await metadata.read()).agents?.[id];
      if (current !== undefined && readResumeRecord(updater(current), 'cold-compact')?.state === 'ready') throw new Error('Interrupted before launch');
      await update(id, updater);
    });
    original.mockNextResponse({ type: 'text', text: 'Durable portable summary.' });
    await expect(dispatch.runOnExisting(child, 'Continue recovered compact', opts)).rejects.toThrow('Interrupted before launch');
    expect(startRun).not.toHaveBeenCalled();
    expect(original.llmCalls).toHaveLength(1);
    const records = await journal(original);
    const meta = structuredClone((await metadata.read()).agents![CHILD]!);
    const cold = await host();
    await cold.restore(records);
    await cold.get(ISessionMetadata).registerAgent(CHILD, meta);
    const restored = dispatchFor(cold);
    cold.mockNextResponse({ type: 'text', text: 'Recovered compact result.' });
    const run = await restored.dispatch.runOnExisting(restored.child, 'Continue recovered compact', opts);
    const handle = await run.started;
    await handle.completion;
    expect(cold.llmCalls).toHaveLength(1);
    expect(JSON.stringify(cold.llmCalls[0])).toContain('Durable portable summary.');
    expect(cold.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    const terminal = await journal(cold);
    const terminalMeta = structuredClone((await cold.get(ISessionMetadata).read()).agents![CHILD]!);
    const retry = await host();
    await retry.restore(terminal);
    await retry.get(ISessionMetadata).registerAgent(CHILD, terminalMeta);
    const replay = dispatchFor(retry);
    const recovered = await replay.dispatch.runOnExisting(replay.child, 'Continue recovered compact', opts);
    const recoveredHandle = await recovered.started;
    expect(await recoveredHandle.completion).toMatchObject({ summary: 'Recovered compact result.' });
    expect(recoveredHandle.turn.id).toBe(handle.turn.id);
    expect(retry.llmCalls).toHaveLength(0);
    expect((await journal(retry)).filter(record => record.type === 'agent.model_switch')).toHaveLength(1);
    await expect(replay.dispatch.runOnExisting(replay.child, 'Continue recovered compact', options('cold-compact', { contextMode: 'fresh', modelAlias: NEW }))).rejects.toThrow('different request or binding');
  });

  it('keeps an ordinary external prompt source in live and replayed caller context without duplicating a materialized source', async () => {
    const ctx = await host();
    const ref = { refId: 'ar:external-input:example-worker', profile: 'example-worker', executor: 'native', configuration: 'profile' as const, label: 'Worker', engine_label: 'Kiki' };
    const origin = { kind: 'user' as const, agentRefs: [ref] };
    const makeRecorder = (turnId: number) => new ExternalTurnRecorder({ id: CHILD, accessor: { get: id => ctx.get(id) } }, turnId, 'remote-1', {
      executorId: 'claude-acp', protocol: 'acp-v1', model: 'vendor-default', resumeMode: 'new', profileDelivery: 'native', parentReceiptManaged: true,
    });
    await makeRecorder(3).begin('kiki://agents/example-worker', origin, [], 'external-input');
    const memory = ctx.get(IAgentContextMemoryService);
    expect(resolveAgentRunSource(memory.get(), 'example-worker', 'native', 'profile', ref.refId))
      .toMatchObject({ messageId: 'external-input', engine_label: 'Kiki' });
    await makeRecorder(4).begin('kiki://agents/example-worker', origin, [], 'different-request');
    expect(memory.get().filter(message => message.origin?.kind === 'user' && message.origin.agentRefs?.some(item => item.refId === ref.refId))).toHaveLength(1);
    const records = await journal(ctx);
    expect(records.filter(record => record.type === 'context.append_message' && (record['message'] as { id?: string }).id === 'external-input')).toHaveLength(1);
    const cold = await host();
    await cold.restore(records);
    expect(resolveAgentRunSource(cold.get(IAgentContextMemoryService).get(), 'example-worker', 'native', 'profile', ref.refId))
      .toMatchObject({ messageId: 'external-input', engine_label: 'Kiki' });
  });

  it.each([undefined, false, true].flatMap((allowModelChange) => [undefined, false, true].map((newWindow) => ({ allowModelChange, newWindow }))))(
    'canonical change allow=$allowModelChange new_window=$newWindow', async ({ allowModelChange, newWindow }) => {
      const ctx = await host();
      const { dispatch, child, runs } = dispatchFor(ctx);
      const start = vi.spyOn(runs, 'run');
      const admitted = allowModelChange === true || newWindow === true;
      const invocation = () => dispatch.runOnExisting(child, 'Resume truth table.', options('truth-table', { modelAlias: NEW, allowModelChange, newWindow }));
      if (!admitted) {
        await expect(invocation()).rejects.toThrow(/allow_model_change:true|allow_model_change: true/);
        expect(start).not.toHaveBeenCalled();
        expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
        expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
        return;
      }
      ctx.mockNextResponse({ type: 'text', text: 'Truth table result.' });
      const run = await invocation();
      await (await run.started).completion;
      expect(start).toHaveBeenCalledTimes(1);
      expect(ctx.get(IAgentModelSwitchService).get('truth-table')).toMatchObject({ state: 'completed', mode: newWindow ? 'fresh' : 'direct' });
      expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(newWindow ? 1 : 0);
      expect(ctx.llmCalls).toHaveLength(1);
      const input = JSON.stringify(ctx.llmCalls[0]);
      expect(input.includes('OLD_BODY')).toBe(!newWindow);
      expect((input.match(/Resume truth table\./g) ?? [])).toHaveLength(1);
    },
  );

  it.each([undefined, OLD])('same-model fresh-only model=%s preserves child and state without old-model requests', async (modelAlias) => {
    const ctx = await host();
    const requestedModels: string[] = [];
    const requester = ctx.get(IAgentLLMRequesterService);
    const start = requester.start.bind(requester);
    vi.spyOn(requester, 'start').mockImplementation((...args) => { requestedModels.push(ctx.get(IAgentProfileService).getModel()); return start(...args); });
    const before = (await ctx.get(ISessionMetadata).read()).agents![CHILD]!;
    const { child, handle } = await complete(ctx, 'fresh-only', { modelAlias, newWindow: true });
    expect(child.agentId).toBe(CHILD);
    expect(handle.agentId).toBe(CHILD);
    expect(requestedModels).toEqual([OLD]);
    const after = (await ctx.get(ISessionMetadata).read()).agents![CHILD]!;
    expect(after).toMatchObject({ parentAgentId: before.parentAgentId, delegator: before.delegator, userLabel: before.userLabel,
      labels: { customState: 'preserved', taskName: 'saved_child' } });
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(JSON.stringify(ctx.llmCalls[0])).not.toContain('OLD_SIGNATURE');
    expect(JSON.stringify(ctx.llmCalls[0])).not.toContain('OLD_BODY');
    expect(readResumeRecord(after, 'fresh-only')).toMatchObject({ state: 'started', turnId: handle.turn.id });
  });

  it('keeps ordinary and effort-only resumes direct with unchanged context', async () => {
    const ctx = await host();
    await complete(ctx, 'ordinary');
    await complete(ctx, 'effort-only', { thinkingEffort: 'high' });
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
    expect(JSON.stringify(ctx.get(IAgentContextMemoryService).get())).toContain('OLD_BODY');
    expect(ctx.get(IAgentProfileService).getEffectiveThinkingLevel()).toBe('high');
    const { dispatch, child } = dispatchFor(ctx);
    await expect(dispatch.runOnExisting(child, 'Bad effort', options('bad-effort', { thinkingEffort: 'unknown' }))).rejects.toThrow(/not supported/);
  });

  it('keeps an explicit native resume behind the durable session execution hold', async () => {
    const ctx = await host();
    const control = ctx.get(ISessionExecutionControl);
    await control.pause({ operationId: 'pause-session' });
    await vi.waitFor(async () => expect(await control.read()).toMatchObject({ phase: 'paused' }));
    const { dispatch, child } = dispatchFor(ctx);
    const execution = ctx.get(IAgentExecutionService);
    const entered = vi.spyOn(execution, 'run');
    const controller = new AbortController();
    ctx.mockNextResponse({ type: 'text', text: 'Explicit result after session resume.' });
    const run = await dispatch.runOnExisting(child, 'Wait for the session control.', { ...options('held-native'), signal: controller.signal });
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
      expect(ctx.llmCalls).toHaveLength(0);
      expect(await control.read()).toMatchObject({ phase: 'paused' });
      await control.resume({ operationId: 'resume-session', pauseOperationId: 'pause-session' });
      await (await run.started).completion;
      await execution.settled();
      expect(ctx.llmCalls).toHaveLength(1);
    } finally { controller.abort(); }
  });

  it.each(['fresh', 'same'] as const)('launches only the %s explicit resume across a restored recovery hold', async (identity) => {
    const original = await host();
    await complete(original, 'interrupted-before-launch');
    const records = await journal(original);
    const pendingEnd = records.findIndex((record) => record.type === 'prompt.enqueued');
    const ctx = await host();
    const taskId = 'bash-restored';
    await ctx.restore([...records.slice(0, pendingEnd + 1), { type: 'task.started', info: {
      taskId, kind: 'process', command: 'example-command', description: 'Unconfirmed earlier execution',
      pid: 0, startedAt: 1, endedAt: null, exitCode: null, status: 'running', detached: true,
    } }]);
    const prompts = ctx.get(IAgentPromptService);
    const execution = ctx.get(IAgentExecutionService);
    const loop = ctx.get(IAgentLoopService);
    expect(prompts.list()).toMatchObject({ hold: { reason: 'recovery', count: 1 },
      pending: [{ id: 'resume-prompt:interrupted-before-launch' }] });
    expect(execution.status().state).toBe('idle');
    expect(loop.status()).toMatchObject({ state: 'idle', pendingRequestKinds: ['task_notification'] });
    expect(ctx.get(IAgentTaskService).getTask(taskId)?.status).toBe('lost');
    expect(ctx.get(IAgentTaskService).list(true)).toHaveLength(0);
    const controller = new AbortController();
    const { dispatch, child } = dispatchFor(ctx);
    const operationId = identity === 'same' ? 'interrupted-before-launch' : 'fresh-after-restore';
    const prompt = identity === 'same' ? 'Continue exactly once.' : 'Inspect preserved work; do not repeat unknown actions.';
    let started = false;
    let failure: unknown;
    ctx.mockNextResponse({ type: 'text', text: 'Explicit fresh result.' });
    const opts = { ...options(operationId), signal: controller.signal };
    const [run, duplicate] = await Promise.all([
      dispatch.runOnExisting(child, prompt, opts), dispatch.runOnExisting(child, prompt, opts),
    ]);
    expect(duplicate).toBe(run);
    void run.started.then(() => { started = true; }, (error: unknown) => { failure = error; });
    try {
      await vi.waitFor(() => {
        expect(failure).toBeUndefined();
        expect(started, 'an explicit resume must not retain an execution lease while parked by recovery').toBe(true);
      });
      const handle = await run.started;
      expect(handle.agentId).toBe(CHILD);
      await handle.completion;
      await execution.settled();
      expect(execution.status().state).toBe('idle');
      expect(loop.status()).toMatchObject({ state: 'idle', hasPendingRequests: false });
      expect(prompts.list().pending.map((item) => item.id)).toEqual(identity === 'fresh' ? ['resume-prompt:interrupted-before-launch'] : []);
      expect(prompts.list().hold).toEqual(identity === 'fresh' ? { reason: 'recovery', count: 1 } : undefined);
      expect(ctx.llmCalls).toHaveLength(1);
      expect(JSON.stringify(ctx.llmCalls[0]!.history)).toContain('task.lost');
      expect(ctx.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId)).toHaveLength(1);
      const after = await journal(ctx);
      expect(after.filter((record) => record.type === 'turn.prompt')).toHaveLength(1);
      expect(after.filter((record) => record.type === 'prompt.launch_committed')).toHaveLength(1);
      expect(after.filter((record) => record.type === 'agent.model_switch')).toHaveLength(identity === 'fresh' ? 2 : 1);
      expect(await dispatch.runOnExisting(child, prompt, opts)).toBe(run);
      expect(ctx.llmCalls).toHaveLength(1);
    } finally {
      controller.abort();
      await run.started.catch(() => undefined);
    }
  });

  it.each(['cancelled', 'restored_cancelled', 'launch_failure'] as const)('releases a recovery-held resume after %s without replaying its prompt', async (outcome) => {
    const original = await host();
    await complete(original, 'preserved-unlaunched');
    const records = await journal(original);
    const ctx = await host();
    await ctx.restore(records.slice(0, records.findIndex((record) => record.type === 'prompt.enqueued') + 1));
    const prompts = ctx.get(IAgentPromptService);
    const execution = ctx.get(IAgentExecutionService);
    const { dispatch, child } = dispatchFor(ctx);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const hook = prompts.hooks.onBeforeSubmitPrompt.register('recovery-launch-fixture', async (_context, next) => {
      enter();
      await blocked;
      if (outcome === 'launch_failure') throw new Error('fixture preparation failed');
      await next();
    });
    const controller = new AbortController();
    const restored = outcome === 'restored_cancelled';
    const operationId = restored ? 'preserved-unlaunched' : 'interrupted-recovery';
    const prompt = restored ? 'Continue exactly once.' : 'This attempt must not call a model.';
    const opts = { ...options(operationId), signal: controller.signal };
    const run = await dispatch.runOnExisting(child, prompt, opts);
    const rejected = expect(run.started).rejects.toBeDefined();
    try {
      await entered;
      expect(execution.status().state).toBe('starting');
      expect(ctx.get(IAgentTaskService).list(true)).toHaveLength(0);
      await expect(dispatch.runOnExisting(child, 'Must not run concurrently.', options('competing-recovery')))
        .rejects.toMatchObject({ code: ErrorCodes.AGENT_ALREADY_RUNNING });
      if (outcome !== 'launch_failure') controller.abort();
      release();
      await rejected;
      await execution.settled();
      expect(execution.status().state).toBe('idle');
      expect(ctx.llmCalls).toHaveLength(0);
      expect(prompts.lookup(`resume-prompt:${operationId}`)).toMatchObject({ phase: 'terminal', terminal: { state: outcome === 'launch_failure' ? 'failed' : 'cancelled' } });
      await hook.dispose();
      const replay = await dispatch.runOnExisting(child, prompt, options(operationId));
      await expect(replay.started).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      expect(ctx.llmCalls).toHaveLength(0);
      ctx.mockNextResponse({ type: 'text', text: 'Recovered on the same child.' });
      const next = await dispatch.runOnExisting(child, 'Inspect and continue.', options('after-interruption'));
      const handle = await next.started;
      expect(handle.agentId).toBe(CHILD);
      await handle.completion;
      await execution.settled();
      expect(execution.status().state).toBe('idle');
      expect(ctx.llmCalls).toHaveLength(1);
      expect(prompts.list().pending.map((item) => item.id)).toEqual(restored ? [] : ['resume-prompt:preserved-unlaunched']);
      expect(prompts.list().hold).toEqual(restored ? undefined : { reason: 'recovery', count: 1 });
    } finally {
      release();
      controller.abort();
      await run.started.catch(() => undefined);
      await hook.dispose();
    }
  });

  it('continues its own summary across a recovery hold without releasing historical prompts', async () => {
    const original = await host();
    await complete(original, 'preserved-unlaunched');
    const records = await journal(original);
    const ctx = await host();
    await ctx.restore(records.slice(0, records.findIndex((record) => record.type === 'prompt.enqueued') + 1));
    const { runs } = dispatchFor(ctx);
    const controller = new AbortController();
    ctx.mockNextResponse({ type: 'text', text: 'Short.' });
    const summary = 'Completed the requested work with an adequate final summary.';
    ctx.mockNextResponse({ type: 'text', text: summary });
    const run = await runs.run(CHILD, { kind: 'prompt', prompt: 'Continue only this request.', promptId: 'summary-resume' }, {
      signal: controller.signal, summaryPolicy: { minChars: 40, retries: 1, continuationPrompt: 'Report the result in full.' },
    });
    try {
      await expect(run.completion).resolves.toMatchObject({ summary });
      await ctx.get(IAgentExecutionService).settled();
      expect(ctx.get(IAgentExecutionService).status().state).toBe('idle');
      expect(ctx.get(IAgentPromptService).list()).toMatchObject({ hold: { reason: 'recovery', count: 1 }, pending: [{ id: 'resume-prompt:preserved-unlaunched' }] });
      expect(ctx.llmCalls).toHaveLength(2);
      expect((await journal(ctx)).filter((record) => record.type === 'prompt.launch_committed')).toHaveLength(2);
    } finally { controller.abort(); }
  });

  it('merges pending lost notifications into the explicit resume instead of starting a competing turn', async () => {
    const ctx = await host();
    const { dispatch, child } = dispatchFor(ctx);
    const taskId = 'bash-lost0000';
    await ctx.dispatch({ type: 'task.started', info: {
      taskId, kind: 'process', command: 'example-command', description: 'Unconfirmed earlier execution',
      pid: 0, startedAt: 1, endedAt: null, exitCode: null, status: 'running', detached: true,
    } });
    await ctx.get(IWireService).flush();
    await ctx.dispatcher.restore();
    const tasks = ctx.get(IAgentTaskService);
    const loop = ctx.get(IAgentLoopService);
    const enqueue = vi.spyOn(loop, 'enqueue');
    ctx.mockNextResponse({ type: 'text', text: 'Inspected preserved work; the external outcome stays unconfirmed.' });
    const run = await dispatch.runOnExisting(child, 'Continue the preserved task without repeating external actions', {
      ...options('lost-during-resume'),
      onBeforeRun: async () => {
        await tasks.resumeRestoration?.();
        expect(tasks.getTask(taskId)?.status).toBe('lost');
        expect(loop.status()).toMatchObject({ state: 'idle', pendingTurnIds: [], pendingRequestKinds: ['task_notification'] });
        expect(ctx.llmCalls).toHaveLength(0);
      },
    });
    const handle = await run.started;
    await handle.completion;
    await ctx.get(IAgentExecutionService).settled();
    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.llmCalls[0]!.history)).toContain('task.lost');
    expect(JSON.stringify(ctx.llmCalls[0]!.history)).toContain('external execution outcome is unconfirmed');
    expect(enqueue.mock.calls.filter(([request]) => request.kind === 'prompt')).toHaveLength(1);
    expect(ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'turn.started')).toHaveLength(1);
    expect(ctx.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId)).toHaveLength(1);
    expect(loop.status()).toMatchObject({ state: 'idle', hasPendingRequests: false });
  });

  it('coalesces repeated requests and rejects same ID with different request or binding', async () => {
    const ctx = await host();
    const { dispatch, child, runs } = dispatchFor(ctx);
    const start = vi.spyOn(runs, 'run');
    ctx.mockNextResponse({ type: 'text', text: 'Single result.' });
    const opts = options('duplicate', { modelAlias: NEW, newWindow: true });
    const [first, second] = await Promise.all([dispatch.runOnExisting(child, 'Continue once', opts), dispatch.runOnExisting(child, 'Continue once', opts)]);
    expect(first).toBe(second);
    await (await first.started).completion;
    expect(await dispatch.runOnExisting(child, 'Continue once', opts)).toBe(first);
    await expect(dispatch.runOnExisting(child, 'Different prompt', opts)).rejects.toThrow(/different request or binding/);
    await expect(dispatch.runOnExisting(child, 'Continue once', options('duplicate', { modelAlias: NEW, newWindow: false }))).rejects.toThrow(/different request or binding/);
    expect(start).toHaveBeenCalledTimes(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('retries preparing only to finish and recovers a completed switch before run starts', async () => {
    const ctx = await host();
    const { dispatch, child, runs } = dispatchFor(ctx);
    const start = vi.spyOn(runs, 'run');
    const store = ctx.get(IAppendLogStore);
    const flush = store.flush.bind(store);
    vi.spyOn(store, 'flush').mockRejectedValueOnce(new Error2(ErrorCodes.STORAGE_IO_FAILED, 'test disk unavailable')).mockImplementation(flush);
    const opts = options('recover-commit', { modelAlias: NEW, newWindow: true });
    await expect(dispatch.runOnExisting(child, 'Recover original prompt', opts)).rejects.toMatchObject({ code: ErrorCodes.STORAGE_IO_FAILED });
    expect(start).not.toHaveBeenCalled();
    expect(ctx.get(IAgentModelSwitchService).get('recover-commit')).toMatchObject({ state: 'preparing' });
    const prepare = vi.spyOn(ctx.get(IAgentProfileService), 'prepareResumeBinding');
    const savedMetadata = structuredClone(await ctx.get(ISessionMetadata).read());
    const metadata = ctx.get(ISessionMetadata);
    const update = metadata.updateAgent.bind(metadata);
    vi.spyOn(metadata, 'updateAgent').mockImplementation(async (id, updater) => {
      const value = (await metadata.read()).agents?.[id];
      if (value !== undefined && readResumeRecord(updater(value), 'recover-commit')?.state === 'ready') throw new Error('post-switch interruption');
      await update(id, updater);
    });
    await expect(dispatch.runOnExisting(child, 'Recover original prompt', opts)).rejects.toThrow('post-switch interruption');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({ modelAlias: NEW, allowModelChange: true });
    expect(start).not.toHaveBeenCalled();
    expect(ctx.get(IAgentModelSwitchService).get('recover-commit')).toMatchObject({ state: 'completed' });
    expect(savedMetadata.agents![CHILD]!.labels).toHaveProperty('dispatchResume:recover-commit');
    vi.restoreAllMocks();
    const restored = dispatchFor(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'Recovered result.' });
    const run = await restored.dispatch.runOnExisting(restored.child, 'Recover original prompt', opts);
    await (await run.started).completion;
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('uses queue facts after enqueue succeeds but started metadata confirmation fails', async () => {
    const ctx = await host();
    const metadata = ctx.get(ISessionMetadata);
    const update = metadata.updateAgent.bind(metadata);
    vi.spyOn(metadata, 'updateAgent').mockImplementation(async (id, updater) => {
      const value = (await metadata.read()).agents?.[id];
      if (value !== undefined && readResumeRecord(updater(value), 'enqueue-gap')?.state === 'started') throw new Error('metadata unavailable after enqueue');
      await update(id, updater);
    });
    const opts = options('enqueue-gap', { modelAlias: NEW, newWindow: true });
    const { dispatch, child } = dispatchFor(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'Original terminal result.' });
    const run = await dispatch.runOnExisting(child, 'Deliver this once', opts);
    const first = await run.started;
    await first.completion;
    await journal(ctx);
    expect(readResumeRecord((await metadata.read()).agents![CHILD], 'enqueue-gap')).toMatchObject({ state: 'ready' });
    expect(ctx.get(IAgentPromptService).lookup('resume-prompt:enqueue-gap')).toMatchObject({ phase: 'terminal', turnId: first.turn.id });
    const restored = dispatchFor(ctx);
    const replay = await restored.dispatch.runOnExisting(restored.child, 'Deliver this once', opts);
    const replayed = await replay.started;
    await replayed.completion;
    expect(replayed.turn.id).toBe(first.turn.id);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
  });

  it.each(['terminal', 'launched'] as const)('cold journal replay uses the original %s prompt fact rather than launching again', async (phase) => {
    const original = await host();
    const { handle } = await complete(original, 'cold-retry', { modelAlias: NEW, newWindow: true });
    const records = await journal(original);
    const meta = structuredClone((await original.get(ISessionMetadata).read()).agents![CHILD]!);
    const cold = await host();
    await cold.restore(phase === 'terminal' ? records : records.filter((record) => record.type !== 'prompt.outcome_committed'));
    await cold.get(ISessionMetadata).registerAgent(CHILD, meta);
    expect(cold.get(IAgentPromptService).lookup('resume-prompt:cold-retry')).toMatchObject({ phase, turnId: handle.turn.id });
    const { dispatch, child } = dispatchFor(cold);
    const run = await dispatch.runOnExisting(child, 'Continue exactly once.', options('cold-retry', { modelAlias: NEW, newWindow: true }));
    if (phase === 'terminal') {
      const replayed = await run.started;
      expect(replayed.turn.id).toBe(handle.turn.id);
      expect(await replayed.completion).toMatchObject({ summary: 'Resumed result.' });
    } else {
      await expect(run.started).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID, details: { phase: 'launched', turnId: handle.turn.id } });
    }
    expect(cold.llmCalls).toHaveLength(0);
    expect(cold.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    const after = await journal(cold);
    expect(after.filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
  });

  it.each(['pending', 'launched', 'terminal'] as const)('rejects changed prompt or origin against a cold %s identity before enqueue', async (phase) => {
    const original = await host();
    await complete(original, 'cold-input-conflict', { newWindow: true });
    const records = await journal(original);
    const cold = await host();
    const pendingEnd = records.findIndex((record) => record.type === 'prompt.enqueued');
    expect(pendingEnd).toBeGreaterThan(-1);
    await cold.restore(phase === 'pending' ? records.slice(0, pendingEnd + 1)
      : phase === 'launched' ? records.filter((record) => record.type !== 'prompt.outcome_committed') : records);
    const prompts = cold.get(IAgentPromptService);
    const promptId = 'resume-prompt:cold-input-conflict';
    const input = { id: promptId, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Continue exactly once.' }],
      toolCalls: [], origin: AGENT_RUN_PROMPT_ORIGIN } };
    expect(prompts.lookup(promptId)).toMatchObject({ phase });
    expect(prompts.lookup(promptId, input)).toEqual(prompts.lookup(promptId));
    const before = prompts.list();
    const enqueue = vi.spyOn(prompts, 'enqueue');
    const target = dispatchFor(cold).child.agent;
    await expect(runAgentTurn(target, { kind: 'prompt', promptId, prompt: 'A different task' },
      { signal: new AbortController().signal })).rejects.toMatchObject({ code: ErrorCodes.PROMPT_ID_CONFLICT });
    await expect(runAgentTurn(target, { kind: 'prompt', promptId, prompt: 'Continue exactly once.', origin: { kind: 'user' } },
      { signal: new AbortController().signal })).rejects.toMatchObject({ code: ErrorCodes.PROMPT_ID_CONFLICT });
    expect(enqueue).not.toHaveBeenCalled();
    expect(prompts.list()).toEqual(before);
    expect(cold.llmCalls).toHaveLength(0);
  });

  it('cold terminal failure preserves the actual error without issuing another request', async () => {
    const original = await host();
    vi.spyOn(original.get(IAgentLLMRequesterService), 'start').mockImplementation(() => { throw new Error2(ErrorCodes.PROVIDER_AUTH_ERROR, 'Target authentication failed'); });
    const { dispatch, child } = dispatchFor(original);
    const opts = options('failed-terminal', { modelAlias: NEW, newWindow: true });
    const run = await dispatch.runOnExisting(child, 'Original failed request', opts);
    const started = await run.started;
    await expect(started.completion).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_AUTH_ERROR });
    const records = await journal(original);
    const meta = structuredClone((await original.get(ISessionMetadata).read()).agents![CHILD]!);
    const cold = await host();
    await cold.restore(records);
    await cold.get(ISessionMetadata).registerAgent(CHILD, meta);
    const restored = dispatchFor(cold);
    const replay = await restored.dispatch.runOnExisting(restored.child, 'Original failed request', opts);
    const replayed = await replay.started;
    await expect(replayed.completion).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_AUTH_ERROR, message: 'Target authentication failed' });
    expect(cold.llmCalls).toHaveLength(0);
    expect(replayed.turn.id).toBe(started.turn.id);
  });

  it('does not recreate missing metadata after commit, and finishes once after the lifecycle restores its entry', async () => {
    const ctx = await host();
    const metadata = ctx.get(ISessionMetadata);
    const store = ctx.get(IAppendLogStore);
    const flush = store.flush.bind(store);
    let saved: import('#/session/sessionMetadata/sessionMetadata').AgentMeta | undefined;
    vi.spyOn(store, 'flush').mockImplementationOnce(async () => {
      saved = structuredClone((await metadata.read()).agents![CHILD]!);
      await metadata.unregisterAgent?.(CHILD);
      await flush();
    }).mockImplementation(flush);
    const { dispatch, child, runs } = dispatchFor(ctx);
    const start = vi.spyOn(runs, 'run');
    const opts = options('missing-entry', { modelAlias: NEW, newWindow: true });
    await expect(dispatch.runOnExisting(child, 'Resume original task', opts)).rejects.toThrow(/metadata entry is missing/);
    expect(ctx.get(IAgentModelSwitchService).get('missing-entry')).toMatchObject({ state: 'preparing' });
    expect((await metadata.read()).agents![CHILD]).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    await expect(dispatch.runOnExisting(child, 'Resume original task', opts)).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_FOUND });
    expect((await metadata.read()).agents![CHILD]).toBeUndefined();
    await metadata.registerAgent(CHILD, saved!);
    ctx.mockNextResponse({ type: 'text', text: 'Restored task result.' });
    const resumed = await dispatch.runOnExisting(child, 'Resume original task', opts);
    await (await resumed.started).completion;
    expect(start).toHaveBeenCalledTimes(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it.each(['allowed', 'deny', 'menu', 'caller'].flatMap(constraint => ['direct', 'compact', 'fresh'].map(contextMode => ({ constraint, contextMode: contextMode as 'direct' | 'compact' | 'fresh' }))))('$contextMode does not bypass frozen $constraint constraints', async ({ constraint, contextMode }) => {
    const ctx = await host();
    const profile = ctx.get(IAgentProfileService);
    const previous = profile.data();
    const boundProfile = previous.boundProfile!;
    profile.applyBindingSnapshot({ ...previous,
      boundProfile: { ...boundProfile,
        allowedModels: constraint === 'allowed' ? [OLD] : boundProfile.allowedModels,
        denyModels: constraint === 'deny' ? [NEW] : boundProfile.denyModels,
        restrictModelsToMenu: constraint === 'menu',
      },
      lockedModelAlias: undefined,
      spawnPolicy: constraint === 'caller' ? { allowedModels: [OLD] } : undefined,
    });
    const { dispatch, child, runs } = dispatchFor(ctx);
    const start = vi.spyOn(runs, 'run');
    await expect(dispatch.runOnExisting(child, 'Blocked mode', options(`blocked-${constraint}`, { modelAlias: NEW, contextMode }))).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(profile.getModel()).toBe(OLD);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
  });

  it('preserves existing route-pin advisory and detached semantics rather than adding a new hard veto', async () => {
    const ctx = await host();
    const profile = ctx.get(IAgentProfileService);
    profile.applyBindingSnapshot({ ...profile.data(), routeId: 'example.route', lockedModelAlias: OLD });
    await complete(ctx, 'route-advisory', { modelAlias: NEW, newWindow: true });
    expect(profile.data()).toMatchObject({ routeId: 'example.route', lockedModelAlias: OLD, routeDetached: true });
  });

  it.each(['running', 'cancelling'] as const)('rejects a %s child and foreign ownership without switching or launching', async (state) => {
    const ctx = await host();
    const { dispatch, child, runs } = dispatchFor(ctx);
    vi.spyOn(ctx.get(IAgentExecutionService), 'status').mockReturnValue({ state, turnId: 10 });
    const start = vi.spyOn(runs, 'run');
    await expect(dispatch.runOnExisting(child, 'Must wait', options(`${state}-resume`, { newWindow: true }))).rejects.toMatchObject({ code: ErrorCodes.AGENT_ALREADY_RUNNING });
    await expect(dispatch.resolveOwnedChild({ kind: 'agent', agentId: 'foreign-parent' }, CHILD)).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_OWNED });
    expect(start).not.toHaveBeenCalled();
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
  });

  it.each(['original', 'construction'] as const)('admits a recoverable %s failure and still rejects a busy child', async (recovery) => {
    const ctx = await host();
    const execution = ctx.get(IAgentExecutionService);
    const { dispatch, child, runs } = dispatchFor(ctx);
    const start = vi.spyOn(runs, 'run');
    vi.spyOn(execution, 'status').mockReturnValue({ state: 'broken' });
    await expect(dispatch.runOnExisting(child, 'Must not start', options('native-broken'))).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL,
      message: 'Agent instance "saved-child" is broken and its original remote session cannot be resumed. The saved message stays queued. Do not call AgentSend again. Do not open a new remote session.',
    });
    expect(start).not.toHaveBeenCalled();

    vi.spyOn(execution, 'status').mockReturnValue({ state: 'starting' });
    vi.spyOn(execution, 'canResumeBrokenOriginal').mockReturnValue(true);
    await expect(dispatch.runOnExisting(child, 'Still busy', options('starting-broken'))).rejects.toMatchObject({
      code: ErrorCodes.AGENT_ALREADY_RUNNING,
    });
    expect(start).not.toHaveBeenCalled();

    vi.spyOn(execution, 'status').mockReturnValue({ state: 'broken' });
    vi.spyOn(execution, 'canResumeBrokenOriginal').mockReturnValue(recovery === 'original');
    vi.spyOn(execution, 'canRetryBrokenExecution').mockReturnValue(recovery === 'construction');
    vi.spyOn(ctx.get(IAgentProfileService), 'prepareResumeBinding').mockRejectedValue(new Error('admitted past idle gate'));
    await expect(dispatch.runOnExisting(child, 'Original remote', options('recoverable-broken'))).rejects.toThrow('admitted past idle gate');
    expect(start).not.toHaveBeenCalled();
  });

  it('retains todo and note values and sources through fresh resume', async () => {
    const ctx = await host();
    const todo = ctx.get(ISessionTodoService);
    todo.setTodos([{ title: 'Remaining verification', status: 'in_progress' }], CHILD);
    todo.setNotes({ goal: 'Saved goal', next: 'Run the remaining verification', evidence: 'Original sourced evidence' }, { turnId: 3, step: 1, toolCallId: 'notes-source' }, CHILD);
    const before = structuredClone(todo.getNotes(CHILD));
    await complete(ctx, 'state-preservation', { modelAlias: NEW, newWindow: true });
    expect(todo.getNotes(CHILD)).toEqual(before);
    expect(todo.getTodos(CHILD)).toEqual([{ title: 'Remaining verification', status: 'in_progress' }]);
    expect(JSON.stringify(ctx.llmCalls[0])).toContain('Original sourced evidence');
  });

  it('merges actual completion, negotiated, profile and resume labels in the original metadata write queue', async () => {
    const ctx = await host();
    const { run, handle } = await complete(ctx, 'interleaved', { modelAlias: NEW, newWindow: true });
    const metadata = ctx.get(ISessionMetadata);
    const record = readResumeRecord((await metadata.read()).agents![CHILD], 'interleaved')!;
    const store = ctx.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(store, 'set').mockImplementationOnce(async (...args) => { entered(); await gate; await set(...args); });
    const saveTask = writeResumeRecord(metadata, CHILD, { ...record, taskId: 'agent-new-task' });
    await writing;
    const completed = mirrorAgentRun(run.child.agent, handle, { profileName: 'example-worker', signal: new AbortController().signal });
    const negotiated = recordNegotiatedSnapshot({ agent: run.child.agent,
      descriptor: { id: 'example-acp', protocol: 'acp', args: [], revision: 'fixture' },
      binding: ctx.get(IAgentProfileService).data() }, { image: true });
    const profile = ctx.get(IAgentProfileService).syncBindingMetadata();
    release();
    await Promise.all([saveTask, completed, negotiated, profile]);
    const after = (await metadata.read()).agents![CHILD]!;
    expect(after).toMatchObject({ parentAgentId: 'main', delegator: { kind: 'agent', agentId: 'main' },
      status: 'completed', resultSummary: 'Resumed result.', model: NEW, negotiated: undefined,
      contextTokens: ctx.get(IAgentTokenCountingService).statusSize(),
      labels: { customState: 'preserved', taskName: 'saved_child' } });
    expect(readResumeRecord(after, 'interleaved')).toMatchObject({ taskId: 'agent-new-task', turnId: handle.turn.id, state: 'started' });
    await metadata.unregisterAgent?.(CHILD);
    await recordNegotiatedSnapshot({ agent: run.child.agent, descriptor: { id: 'example-acp', protocol: 'acp', args: [], revision: 'fixture' }, binding: ctx.get(IAgentProfileService).data() }, { image: false });
    expect((await metadata.read()).agents![CHILD]).toBeUndefined();
  });

  it.each(['profile_file', 'route'] as const)('does not attach a registered reference to a same-name %s child on resume', async selectionKind => {
    const ctx = await host();
    const profile = ctx.get(IAgentProfileService);
    const bound = profile.data();
    vi.spyOn(profile, 'data').mockReturnValue({ ...bound,
      dispatchDecision: { ...bound.dispatchDecision, version: 2, selectionKind },
    } as ReturnType<IAgentProfileService['data']>);
    const ref = { refId: 'ar:registered:example-worker', profile: 'example-worker', executor: 'native', configuration: 'profile' as const, label: 'Worker' };
    ctx.get(IAgentContextMemoryService).append({ id: 'registered', role: 'user', content: [{ type: 'text', text: 'kiki://agents/example-worker' }], toolCalls: [], origin: { kind: 'user', agentRefs: [ref] } });
    const { dispatch, child, runs } = dispatchFor(ctx);
    const started = vi.spyOn(runs, 'run');
    const explicit = dispatch.runOnExisting(child, 'Continue', { ...options('file-source'), sourceRef: ref.refId });
    void explicit.then(value => value.started.catch(() => {}), () => {});
    await expect(explicit).rejects.toThrow('source_ref');
    expect(started).not.toHaveBeenCalled();
    ctx.mockNextResponse({ type: 'text', text: 'File role completed.' });
    const automatic = await dispatch.runOnExisting(child, 'Continue', options('file-no-source'));
    expect(automatic.child.sourceRef).toBeUndefined();
    await (await automatic.started).completion;
  });

  it('retains registered target references on a genuine registered child resume', async () => {
    const ctx = await host();
    const ref = { refId: 'ar:registered:example-worker', profile: 'example-worker', executor: 'native', configuration: 'profile' as const, label: 'Worker' };
    ctx.get(IAgentContextMemoryService).append({ id: 'registered', role: 'user', content: [{ type: 'text', text: 'kiki://agents/example-worker' }], toolCalls: [], origin: { kind: 'user', agentRefs: [ref] } });
    const { dispatch, child } = dispatchFor(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'Registered role completed.' });
    const run = await dispatch.runOnExisting(child, 'Continue', { ...options('registered-source'), sourceRef: ref.refId });
    expect(run.child.sourceRef).toMatchObject({ ...ref, messageId: 'registered' });
    await (await run.started).completion;
  });

  it.each([{ tools: ['Read'] }, { disallowedTools: ['Bash'] }])('rejects vendor-default resume tool override %j before a run or binding change', async toolOverride => {
    const { ctx, dispatch, child, runs } = await defaultExternal();
    const before = ctx.get(IAgentProfileService).data();
    const run = vi.spyOn(runs, 'run');
    const attempt = dispatch.runOnExisting(child, 'Continue', { ...options('default-tool-override'), toolOverride });
    void attempt.then(value => value.started.catch(() => {}), () => {});
    await expect(attempt).rejects.toThrow('does not support AgentRun tools or disallowed_tools overrides');
    expect(run).not.toHaveBeenCalled();
    expect(ctx.get(IAgentProfileService).data()).toEqual(before);
    expect(readResumeRecord((await ctx.get(ISessionMetadata).read()).agents![CHILD], 'default-tool-override')).toBeUndefined();
  });

  it('retries a vendor-default start failure with the same operation and prompt id', async () => {
    const { ctx, dispatch, child, runs, delivered } = await defaultExternal();
    const run = vi.spyOn(runs, 'run');
    const opts = options('retry-default-start');
    const first = await dispatch.runOnExisting(child, 'Continue', opts);
    await expect(first.started).rejects.toThrow('fixture-native-run-reached');
    const second = await dispatch.runOnExisting(child, 'Continue', opts);
    await expect(second.started).rejects.toThrow('fixture-native-run-reached');
    expect(run).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([expect.objectContaining({ request: expect.objectContaining({ promptId: 'resume-prompt:retry-default-start' }) }),
      expect.objectContaining({ request: expect.objectContaining({ promptId: 'resume-prompt:retry-default-start' }) })]);
    expect(readResumeRecord((await ctx.get(ISessionMetadata).read()).agents![CHILD], opts.operationId!)).toMatchObject({ state: 'ready' });
    await expect(dispatch.runOnExisting(child, 'Changed request', opts)).rejects.toThrow('different request');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'vendor-model'])('keeps the same resume operation after an outcome-unknown start with model %s', async modelAlias => {
    const { ctx, dispatch, child, runs } = await defaultExternal('codex-app-server', modelAlias);
    const failure = new Error2(ErrorCodes.EXECUTOR_SESSION_FAILED, 'Prompt delivery could not be confirmed', {
      details: { deliveryOutcome: 'unknown', executorId: 'codex-app-server' },
    });
    const run = vi.spyOn(runs, 'run').mockRejectedValue(failure);
    const opts = options('unknown-start');
    const first = await dispatch.runOnExisting(child, 'Continue exactly once', opts);
    await expect(first.started).rejects.toBe(failure);
    const second = await dispatch.runOnExisting(child, 'Continue exactly once', opts);
    expect(second).toBe(first);
    await expect(second.started).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
    expect(readResumeRecord((await ctx.get(ISessionMetadata).read()).agents![CHILD], opts.operationId!)).toMatchObject({ state: 'ready' });
    await expect(dispatch.runOnExisting(child, 'Changed request', opts)).rejects.toThrow('different request');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'vendor-model'])('retries a pre-send failure with the same operation and model %s', async modelAlias => {
    const { dispatch, child, runs } = await defaultExternal('codex-app-server', modelAlias);
    const run = vi.spyOn(runs, 'run');
    const opts = options('pre-send-start');
    const first = await dispatch.runOnExisting(child, 'Continue', opts);
    await expect(first.started).rejects.toThrow('fixture-native-run-reached');
    const second = await dispatch.runOnExisting(child, 'Continue', opts);
    await expect(second.started).rejects.toThrow('fixture-native-run-reached');
    expect(second).not.toBe(first);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps an already-started vendor-default run when metadata confirmation fails', async () => {
    const { ctx, dispatch, child, runs } = await defaultExternal();
    const handle = { agentId: CHILD, turn: { id: 42 }, completion: Promise.resolve({ summary: 'Done' }) } as Awaited<ReturnType<ISessionSubagentService['run']>>;
    const run = vi.spyOn(runs, 'run').mockResolvedValue(handle);
    const metadata = ctx.get(ISessionMetadata);
    const update = metadata.updateAgent.bind(metadata);
    let updates = 0;
    vi.spyOn(metadata, 'updateAgent').mockImplementation(async (...args) => {
      if (++updates === 2) throw new Error('fixture confirmation unavailable');
      return update(...args);
    });
    const opts = options('started-default');
    const first = await dispatch.runOnExisting(child, 'Continue', opts);
    await expect(first.started).resolves.toBe(handle);
    const second = await dispatch.runOnExisting(child, 'Continue', opts);
    expect(second).toBe(first);
    await expect(second.started).resolves.toBe(handle);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['codex-app-server', 'claude-acp', 'agy-cli', 'grok-acp'])('resumes %s native defaults without manufacturing a Kiki model', async (id) => {
    const { ctx, dispatch, child, delivered } = await defaultExternal(id);
    const run = await dispatch.runOnExisting(child, 'Continue native task', options(`native-${id}`));
    await expect(run.started).rejects.toThrow('fixture-native-run-reached');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ request: { prompt: 'Continue native task', promptId: `resume-prompt:native-${id}` },
      binding: { execution: { selection: { executor: id } }, systemPrompt: '' } });
    expect(ctx.get(IAgentProfileService).data().modelAlias).toBeUndefined();
    expect(ctx.get(IAgentModelSwitchService).get(`native-${id}`)).toBeUndefined();
    await expect(dispatch.runOnExisting(child, 'Fresh default', options(`fresh-${id}`, { newWindow: true })))
      .rejects.toThrow('explicit vendor model');
  });

  it.each(['compact', 'fresh'] as const)('rejects external %s rebuilding without summary, binding mutation or remote launch', async contextMode => {
    const { ctx, dispatch, child, delivered } = await defaultExternal('claude-acp', 'vendor-model');
    const before = ctx.get(IAgentContextMemoryService).get();
    await expect(dispatch.runOnExisting(child, 'Rebuild external', options('external-mode', { contextMode }))).rejects.toThrow('does not support rebuilding');
    expect(ctx.llmCalls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(ctx.get(IAgentProfileService).getModel()).toBe('vendor-model');
    expect(ctx.get(IAgentContextMemoryService).get()).toBe(before);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
  });

  it('does not mark actual external model application successful merely because canonical binding committed', async () => {
    const ctx = await host();
    const registry = ctx.get(IAgentExecutorRegistry);
    const appliedModels: string[] = [];
    const resolved: ResolvedAgentExecutor = { descriptor: { id: 'example-acp', protocol: 'acp', args: [], revision: 'fixture' }, options: {},
      provider: { id: 'example-acp', protocol: 'acp', validateOptions: () => ({}), validateBinding: (binding) => ({ ok: true, binding }),
        create: (context) => ({ hooks: createHooks(['onWillRun']), status: () => ({ state: 'idle' }), cancel: () => false, settled: async () => {}, shutdown: async () => {},
          run: async () => { appliedModels.push(context.binding.modelAlias!); throw new Error2(ErrorCodes.CONFIG_INVALID, 'Remote executor rejected target model'); } }),
      } };
    vi.spyOn(registry, 'resolve').mockReturnValue(resolved);
    vi.spyOn(registry, 'resolveExecutable').mockResolvedValue(resolved);
    vi.spyOn(registry, 'get').mockReturnValue(resolved.descriptor);
    vi.spyOn(registry, 'validateBinding').mockImplementation((_id, _options, binding) => ({ ok: true, binding }));
    await ctx.get(IAgentProfileService).bind({ model: 'external-old', thinking: 'off', delegationPosition: 'sub',
      resolvedProfile: normalizeAgentProfile({ name: 'external-worker', executor: 'example-acp', modelAlias: 'external-old', allowedModels: ['external-old', 'external-new'], tools: [], systemPrompt: () => 'External test role.' }) });
    const { dispatch, child } = dispatchFor(ctx);
    const run = await dispatch.runOnExisting(child, 'Remote continuation', options('external-direct', { modelAlias: 'external-new', allowModelChange: true }));
    await expect(run.started).rejects.toThrow('Remote executor rejected target model');
    expect(appliedModels).toEqual(['external-new']);
    expect(ctx.get(IAgentModelSwitchService).get('external-direct')).toMatchObject({ state: 'completed', toModel: 'external-new' });
    expect(readResumeRecord((await ctx.get(ISessionMetadata).read()).agents![CHILD], 'external-direct')).toMatchObject({ state: 'ready' });
    expect(ctx.llmCalls).toHaveLength(0);
    await expect(dispatch.runOnExisting(child, 'Unsupported fresh', options('external-fresh', { newWindow: true }))).rejects.toThrow(/adapter|unsupported|executor/i);
    expect(appliedModels).toHaveLength(1);
    const metadata = ctx.get(ISessionMetadata);
    const record = readResumeRecord((await metadata.read()).agents![CHILD], 'external-direct')!;
    const store = ctx.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(store, 'set').mockImplementationOnce(async (...args) => { entered(); await gate; await set(...args); });
    const labels = writeResumeRecord(metadata, CHILD, { ...record, taskId: 'external-task' });
    await writing;
    const negotiated = recordNegotiatedSnapshot({ agent: child.agent, descriptor: resolved.descriptor, binding: ctx.get(IAgentProfileService).data() }, { image: true });
    const profile = ctx.get(IAgentProfileService).syncBindingMetadata();
    release();
    await Promise.all([labels, negotiated, profile]);
    expect((await metadata.read()).agents![CHILD]).toMatchObject({ executor: 'example-acp', negotiated: { image: true }, model: 'external-new',
      parentAgentId: 'main', labels: { customState: 'preserved' } });
    expect(readResumeRecord((await metadata.read()).agents![CHILD], 'external-direct')).toMatchObject({ taskId: 'external-task', state: 'ready' });
  });
});

describe('dispatch resume after cancellation with deferred task notifications', () => {
  function pendingTask(kind: 'agent' | 'process', turnCompletion: Promise<unknown>): AgentTask {
    return {
      kind, idPrefix: kind === 'agent' ? 'agent' : 'bash', description: 'Pending descendant',
      start: (sink) => new Promise<void>((resolve, reject) => {
        const stop = async () => {
          await turnCompletion.catch(() => {});
          await sink.settle({ status: 'killed' });
          resolve();
        };
        if (sink.signal.aborted) void stop().catch(reject);
        else sink.signal.addEventListener('abort', () => { void stop().catch(reject); }, { once: true });
      }),
      toInfo: (base) => kind === 'agent'
        ? { ...base, kind, agentId: 'descendant', profile: 'example-worker' }
        : { ...base, kind, command: 'fixture', pid: 0, exitCode: null },
    };
  }

  async function cancelledChild(stop: 'timeout' | 'user' = 'timeout') {
    const ctx = await host();
    const view = dispatchFor(ctx);
    const execution = ctx.get(IAgentExecutionService);
    const requester = ctx.get(IAgentLLMRequesterService);
    const original = requester.start.bind(requester);
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(requester, 'start').mockImplementationOnce((_options, _onPart, signal) => {
      entered();
      return { trace: { traceId: 'blocked-fixture' }, result: new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => { reject(signal!.reason); }, { once: true });
      }) };
    }).mockImplementation(original);
    const controller = new AbortController();
    const run = await execution.run({ kind: 'prompt', prompt: 'Original cancellable work' }, { signal: controller.signal });
    void run.completion.catch(() => {});
    await requested;
    const tasks = ctx.get(IAgentTaskService);
    const descendant = tasks.registerTask(pendingTask('agent', run.completion));
    const tool = tasks.registerTask(pendingTask('process', run.completion));
    const parent = testAgent();
    hosts.push(parent);
    await parent.ready;
    vi.spyOn(parent.get(IAgentLifecycleService), 'get').mockImplementation((id) => id === CHILD ? view.child.agent : undefined);
    const mirrored = mirrorAgentRun(view.child.agent, run, { profileName: 'example-worker', signal: controller.signal });
    void mirrored.catch(() => {});
    const parentTasks = parent.get(IAgentTaskService);
    const parentTask = parentTasks.registerTask(new SubagentTask({ agentId: CHILD, profileName: 'example-worker',
      completion: mirrored.then((result) => ({ result: result.summary })) }, 'Parent cancellation', controller),
    { timeoutMs: stop === 'timeout' ? 10 : undefined, detached: false });
    const cancelled = expect(run.completion).rejects.toBeDefined();
    if (stop === 'user') await parentTasks.stopByUser(parentTask);
    await cancelled;
    await execution.settled();
    await expect(mirrored).rejects.toBeDefined();
    await parentTasks.wait(parentTask);
    await vi.waitFor(() => {
      expect(tasks.list(false).find((info) => info.taskId === descendant)?.status).toBe('killed');
      expect(tasks.list(false).find((info) => info.taskId === tool)?.status).toBe('killed');
      expect(ctx.get(IAgentLoopService).status().pendingRequestKinds).toEqual(['task_notification', 'task_notification']);
    });
    expect(execution.status()).toEqual({ state: 'idle' });
    expect(ctx.get(IAgentFullCompactionService).isCompacting()).toBe(false);
    expect(ctx.get(IAgentLoopService).status()).toMatchObject({ state: 'idle', finalizing: false, lastTurnResult: 'cancelled', pendingTurnIds: [] });
    expect(tasks.list(true)).toEqual([]);
    expect((await ctx.get(ISessionMetadata).read()).agents![CHILD]).toMatchObject({ status: 'cancelled' });
    const records = await journal(ctx);
    const ended = records.findIndex((record) => record.type === 'turn.ended' && record['reason'] === 'cancelled');
    expect(ended).toBeGreaterThanOrEqual(0);
    expect(records.findIndex((record) => record.type === 'task.terminated' && (record['info'] as { taskId: string }).taskId === descendant)).toBeGreaterThan(ended);
    expect(records.some((record) => record.type === 'prompt.outcome_committed')).toBe(true);
    return { ctx, ...view, descendant, tool };
  }

  it.each(['timeout', 'user'] as const)('resumes the same binding once after parent %s and consumes late descendant notifications', async (stop) => {
    const { ctx, dispatch, child, runs, descendant, tool } = await cancelledChild(stop);
    const start = vi.spyOn(runs, 'run');
    ctx.mockNextResponse({ type: 'text', text: 'Resumed result' });
    const opts = options('cancelled-resume');
    const [first, second] = await Promise.all([
      dispatch.runOnExisting(child, 'Continue exactly once', opts),
      dispatch.runOnExisting(child, 'Continue exactly once', opts),
    ]);
    expect(second).toBe(first);
    const handle = await first.started;
    await handle.completion;
    await ctx.get(IAgentExecutionService).settled();
    expect(handle.agentId).toBe(CHILD);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await dispatch.runOnExisting(child, 'Continue exactly once', opts)).toBe(first);
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
    expect(ctx.llmCalls).toHaveLength(1);
    expect((JSON.stringify(ctx.llmCalls[0]).match(/Continue exactly once/g) ?? [])).toHaveLength(1);
    const messages = ctx.get(IAgentContextMemoryService).get();
    for (const taskId of [descendant, tool]) {
      expect(messages.filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId)).toHaveLength(1);
    }
    expect(ctx.get(IAgentTaskService).list(true)).toEqual([]);
    expect(ctx.get(IAgentLoopService).status()).toMatchObject({ state: 'idle', hasPendingRequests: false, pendingTurnIds: [] });
    expect(readResumeRecord((await ctx.get(ISessionMetadata).read()).agents![CHILD], opts.operationId!)).toMatchObject({ state: 'started', turnId: handle.turn.id });
  });

  function mailboxFor(ctx: TestAgentContext, child: DispatchChild, dispatch: ISessionDispatchService) {
    let message: AcceptedAgentMessage | undefined;
    let delivered = false;
    const claim = {} as ThreadDeliveryClaim;
    const store: IAgentCollaborationMessageStore = {
      _serviceBrand: undefined,
      accept: async (input) => {
        const deduplicated = message !== undefined;
        message ??= { ...input, messageId: 'queued-mailbox', acceptedAt: 1, targetSeq: 1 };
        return { message, deduplicated, delivery: delivered ? 'delivered' : 'queued', payloadConflict: false };
      },
      nextQueued: async () => delivered || message === undefined ? undefined : { message, claim },
      markDelivered: async () => { delivered = true; return true; },
      listPendingAgents: async () => delivered || message === undefined ? [] : [CHILD],
      discardPending: async () => ({ discarded: 0 }),
    };
    const ix = new TestInstantiationService();
    containers.push(ix);
    ix.set(IAgentCollaborationMessageStore, store);
    ix.stub(IAgentLifecycleService, { list: () => [child.agent], get: (id) => id === CHILD ? child.agent : undefined,
      onDidCreate: Event.None as IAgentLifecycleService['onDidCreate'],
      onDidDispose: Event.None as IAgentLifecycleService['onDidDispose'] });
    ix.set(ISessionContext, ctx.get(ISessionContext));
    ix.set(ISessionMetadata, ctx.get(ISessionMetadata));
    ix.set(ISessionDispatchService, dispatch);
    ix.set(IAtomicDocumentStore, ctx.get(IAtomicDocumentStore));
    ix.set(ILogService, ctx.get(ILogService));
    ix.stub(ISessionManager, {});
    ix.set(IAgentCollaborationMessagingService, new SyncDescriptor(AgentCollaborationMessagingService));
    return { messaging: ix.get(IAgentCollaborationMessagingService), delivered: () => delivered };
  }

  async function persistenceBlockedChild(realAppend = false, committed = true, exhaust = true) {
    const ctx = await host(realAppend);
    const parent = testAgent();
    hosts.push(parent);
    await parent.ready;
    parent.mockNextResponse({ type: 'text', text: 'Original task notification received.' });
    const notificationEnd = parent.untilTurnEnd();
    const tasks = parent.get(IAgentTaskService);
    const view = dispatchFor(ctx);
    const loop = ctx.get(IAgentLoopService);
    const wire = ctx.get(IWireService);
    const storage = ctx.get(IFileSystemStorageService);
    const append = storage.append.bind(storage);
    const flush = wire.flush.bind(wire);
    let blocked = true;
    let failures = 0;
    let partial = false;
    const failure = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'storage append failed: no space left on device', {
      details: { op: 'append', errno: 'ENOSPC', committed },
    });
    if (realAppend) {
      vi.spyOn(storage, 'append').mockImplementation(async (scope, key, bytes, options) => {
        if (blocked && key === 'wire.jsonl' && loop.status().finalizing) {
          if (failures++ === 0) vi.useFakeTimers();
          if (committed && !partial) { partial = true; await append(scope, key, bytes.slice(0, Math.max(1, bytes.length - 7)), options); }
          throw failure;
        }
        await append(scope, key, bytes, options);
      });
    } else {
      vi.spyOn(wire, 'flush').mockImplementation(async () => {
        if (blocked && loop.status().finalizing) {
          if (failures++ === 0) vi.useFakeTimers();
          throw failure;
        }
        await flush();
      });
    }
    const action = vi.fn(async () => ({ output: 'saved once' }));
    ctx.get(IAgentPermissionModeService).setMode('yolo', 'ambient');
    ctx.get(IAgentToolRegistryService).register({ name: 'SaveWork', description: 'Save fixture work.', parameters: { type: 'object' },
      resolveExecution: () => ({ approvalRule: 'SaveWork', execute: action }) });
    ctx.get(IAgentProfileService).update({ activeToolNames: ['SaveWork'] });
    ctx.mockNextResponse({ type: 'function', id: 'save-work', name: 'SaveWork', arguments: '{}' });
    ctx.mockNextResponse({ type: 'text', text: 'Original result.' });
    const controller = new AbortController();
    const run = await ctx.get(IAgentExecutionService).run({ kind: 'prompt', prompt: 'Save original work.' }, { signal: controller.signal });
    const taskId = tasks.registerTask(new SubagentTask({ agentId: CHILD, profileName: 'example-worker',
      completion: run.completion.then((result) => ({ result: result.summary })) }, 'Save original work', controller));
    await expect(run.turn.result).rejects.toMatchObject({ details: { executionOutcome: 'completed', persistenceOutcome: 'failed' } });
    if (exhaust) await vi.advanceTimersByTimeAsync(402_600);
    else await vi.advanceTimersByTimeAsync(2_600);
    expect(loop.status()).toMatchObject({ state: 'running', finalizing: true, persistenceFailure: { executionOutcome: 'completed' } });
    expect(tasks.list(true)).toMatchObject([{ taskId, status: 'running' }]);
    expect(ctx.get(IAgentExecutionService).status().state).toBe('running');
    expect(ctx.get(IAgentActivityView).state().persistenceFailure).toMatchObject({ executionOutcome: 'completed',
      message: expect.stringContaining('Turn execution ended, but saving failed') });
    expect(action).toHaveBeenCalledTimes(1);
    expect(ctx.llmCalls).toHaveLength(2);
    return { ctx, parent, notificationEnd, ...view, loop, action, run, tasks, taskId, controller, failures: () => failures, unblock: () => { blocked = false; }, cleanup: async () => {
      blocked = false;
      vi.useRealTimers();
      expect(await loop.recoverPersistence()).toBe(true);
      await run.completion.catch(() => {});
      await tasks.wait(taskId);
    } };
  }

  it('recovers an ENOSPC task after a ninety-minute outage without new reads, writes, or enqueues', async () => {
    const fixture = await persistenceBlockedChild(true);
    const { ctx, loop, run, tasks, taskId, action } = fixture;
    try {
      await ctx.get(IUsageFactStore).checkpoint(ctx.get(IAgentScopeContext).scope());
      const before = fixture.failures();
      await vi.advanceTimersByTimeAsync(90 * 60_000);
      expect(fixture.failures() - before).toBe(36);
      fixture.unblock();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(tasks.list(true)).toMatchObject([{ taskId, status: 'running' }]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await run.completion).toMatchObject({ summary: 'Original result.' });
      expect(loop.status()).toMatchObject({ state: 'idle', finalizing: false });
      await tasks.wait(taskId);
      await fixture.notificationEnd;
      const notifications = fixture.parent.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId);
      expect(notifications).toHaveLength(1);
      expect(JSON.stringify(notifications)).toContain('Original result.');
      expect(action).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(2);
      expect((await journal(ctx)).filter((record) => record.type === 'turn.ended' && record['turnId'] === run.turn.id)).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  it('stops slow recovery when a journal prefix no longer matches', async () => {
    const fixture = await persistenceBlockedChild(true);
    const { ctx, loop } = fixture;
    const storage = ctx.get(IFileSystemStorageService);
    const scope = ctx.get(IAgentScopeContext).scope();
    const original = (await storage.read(scope, 'wire.jsonl'))!;
    const changed = original.slice();
    changed[changed.length - 1] = 0;
    const recovery = vi.spyOn(loop, 'recoverPersistence');
    try {
      await storage.write(scope, 'wire.jsonl', changed);
      fixture.unblock();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(recovery).toHaveBeenCalledTimes(1);
      expect(loop.status()).toMatchObject({ finalizing: true, persistenceFailure: { message: expect.stringContaining('changed journal bytes') } });
      const store = ctx.get(IAppendLogStore);
      store.append('recovery-evidence', 'events.jsonl', { storage: 'writable' });
      await store.flush('recovery-evidence', 'events.jsonl');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(recovery).toHaveBeenCalledTimes(1);
    } finally {
      await storage.write(scope, 'wire.jsonl', original);
      await fixture.cleanup();
    }
  });

  it('disposal stops slow recovery timers and write-event wakeups', async () => {
    const fixture = await persistenceBlockedChild(true);
    const { ctx, loop } = fixture;
    const recovery = vi.spyOn(loop, 'recoverPersistence');
    try {
      await (loop as IAgentLoopService & { dispose(): void | Promise<void> }).dispose();
      fixture.unblock();
      const store = ctx.get(IAppendLogStore);
      store.append('recovery-evidence', 'events.jsonl', { storage: 'writable' });
      await store.flush('recovery-evidence', 'events.jsonl');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(recovery).not.toHaveBeenCalled();
    } finally { await fixture.cleanup(); }
  });

  it.each([false, true])('automatically completes the original task after ENOSPC committed=%s recovers during extended backoff', async (committed) => {
    const fixture = await persistenceBlockedChild(true, committed, false);
    const { ctx, loop, run, tasks, taskId, action } = fixture;
    try {
      fixture.unblock();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await run.completion).toMatchObject({ summary: 'Original result.' });
      await tasks.wait(taskId);
      await fixture.notificationEnd;
      const notifications = fixture.parent.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId);
      expect(notifications).toHaveLength(1);
      expect(JSON.stringify(notifications)).toContain('Original result.');
      expect(tasks.list(false).find((task) => task.taskId === taskId)?.status).toBe('completed');
      expect(loop.status()).toMatchObject({ state: 'idle', finalizing: false });
      expect(action).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(2);
      expect((await journal(ctx)).filter((record) => record.type === 'turn.ended' && record['turnId'] === run.turn.id)).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  it.each([false, true])('recovers on an actual successful journal write after timer exhaustion with prior cancellation=%s', async (cancelled) => {
    const fixture = await persistenceBlockedChild(true);
    const { ctx, loop, run, tasks, taskId, action } = fixture;
    try {
      if (cancelled) {
        const completion = expect(run.completion).rejects.toBeDefined();
        await tasks.stopByUser(taskId);
        await completion;
        await tasks.wait(taskId);
      }
      fixture.unblock();
      const store = ctx.get(IAppendLogStore);
      store.append('recovery-evidence', 'events.jsonl', { storage: 'writable' });
      await store.flush('recovery-evidence', 'events.jsonl');
      if (!cancelled) expect(await run.completion).toMatchObject({ summary: 'Original result.' });
      await loop.settled();
      await tasks.wait(taskId);
      expect(tasks.list(false).find((task) => task.taskId === taskId)?.status).toBe(cancelled ? 'killed' : 'completed');
      expect(loop.status()).toMatchObject({ state: 'idle', finalizing: false });
      expect(action).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(2);
    } finally { await fixture.cleanup(); }
  });

  it('recovers the original task on a journal read after storage returns and timers are exhausted', async () => {
    const fixture = await persistenceBlockedChild(true);
    const { ctx, loop, run, tasks, taskId, action } = fixture;
    try {
      fixture.unblock();
      const records = await journal(ctx);
      expect(await run.completion).toMatchObject({ summary: 'Original result.' });
      await tasks.wait(taskId);
      expect(tasks.list(false).find((task) => task.taskId === taskId)?.status).toBe('completed');
      expect(loop.status()).toMatchObject({ state: 'idle', finalizing: false });
      expect(records.filter((record) => record.type === 'turn.ended' && record['turnId'] === run.turn.id)).toHaveLength(1);
      expect(action).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(2);
    } finally { await fixture.cleanup(); }
  });

  it.each([false, true])('recovers the same child after exhausted final-save retries with real append=%s', async (realAppend) => {
    const fixture = await persistenceBlockedChild(realAppend);
    const { ctx, child, dispatch, loop, action } = fixture;
    try {
      fixture.unblock();
      vi.useRealTimers();
      ctx.mockNextResponse({ type: 'text', text: 'Continued result.' });
      const opts = options('after-persistence-outage');
      const [first, second] = await Promise.all([
        dispatch.runOnExisting(child, 'Continue saved work.', opts),
        dispatch.runOnExisting(child, 'Continue saved work.', opts),
      ]);
      expect(second).toBe(first);
      const handle = await first.started;
      await handle.completion;
      expect(handle.agentId).toBe(CHILD);
      expect(action).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(3);
      expect(loop.status()).toMatchObject({ state: 'idle', finalizing: false, persistenceFailure: undefined });
      const records = await journal(ctx);
      expect(records.filter((record) => record.type === 'turn.ended' && record['turnId'] === fixture.run.turn.id)).toHaveLength(1);
      expect(records.filter((record) => record.type === 'turn.prompt' && record['turnId'] === fixture.run.turn.id)).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  it('reports persistent save failure on resume and message delivery while preserving the queued message', async () => {
    const fixture = await persistenceBlockedChild();
    const { ctx, child, dispatch, loop, action } = fixture;
    const mail = mailboxFor(ctx, child, dispatch);
    const input = { sourceAgentId: CHILD, sourceTaskName: 'sender', targetAgentId: CHILD, targetTaskName: 'saved_child',
      content: 'Retain this update.', idempotencyKey: 'save-blocked-message', waitForRunningDelivery: true, idleWake: 'owned-child' as const };
    try {
      await expect(dispatch.runOnExisting(child, 'Must remain blocked.', options('still-failing'))).rejects.toMatchObject({
        details: { persistenceOutcome: 'failed', executionOutcome: 'completed' },
      });
      await expect(mail.messaging.send(input)).rejects.toMatchObject({ details: { persistenceOutcome: 'failed' } });
      expect(mail.delivered()).toBe(false);
      expect(loop.status().hasPendingRequests).toBe(false);
      expect(action).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(2);
      fixture.unblock();
      vi.useRealTimers();
      ctx.mockNextResponse({ type: 'text', text: 'Mailbox recovered.' });
      const run = await dispatch.runOnExisting(child, '', options('recover-queued-message'));
      await (await run.started).completion;
      expect(await mail.messaging.send(input)).toMatchObject({ delivery: 'delivered', deduplicated: true });
      expect(ctx.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'agent_message' && message.origin.messageId === 'queued-mailbox')).toHaveLength(1);
      expect(action).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(3);
    } finally { await fixture.cleanup(); }
  });

  it('wakes a persistence-blocked child from AgentSend after storage recovers', async () => {
    const fixture = await persistenceBlockedChild();
    const { ctx, child, dispatch, action } = fixture;
    const mail = mailboxFor(ctx, child, dispatch);
    try {
      fixture.unblock();
      vi.useRealTimers();
      ctx.mockNextResponse({ type: 'text', text: 'Message continuation.' });
      expect(await mail.messaging.send({ sourceAgentId: CHILD, sourceTaskName: 'sender', targetAgentId: CHILD, targetTaskName: 'saved_child',
        content: 'Continue from saved mail.', idempotencyKey: 'wake-after-save-failure', waitForRunningDelivery: true, idleWake: 'owned-child' })).toMatchObject({ delivery: 'delivered', resumed: true });
      await ctx.get(IAgentLoopService).settled();
      expect(action).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(3);
    } finally { await fixture.cleanup(); }
  });

  it('keeps AgentSend queued behind restored work and delivers it once on an explicit same-child resume', async () => {
    const original = await host();
    await complete(original, 'unconfirmed-history');
    const records = await journal(original);
    const ctx = await host();
    await ctx.restore(records.slice(0, records.findIndex((record) => record.type === 'prompt.enqueued') + 1));
    const { dispatch, child } = dispatchFor(ctx);
    const mail = mailboxFor(ctx, child, dispatch);
    const ix = new TestInstantiationService();
    containers.push(ix);
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.set(ISessionMetadata, ctx.get(ISessionMetadata));
    ix.set(IAgentTaskService, ctx.get(IAgentTaskService));
    ix.set(IAgentLifecycleService, ctx.get(IAgentLifecycleService));
    ix.set(IAgentListTool, new SyncDescriptor(AgentListTool));
    const roster = async () => {
      const result = await executeTool(ix.get(IAgentListTool), {
        args: { include_finished: true }, signal: new AbortController().signal, turnId: 1, toolCallId: 'roster',
      });
      expect(result.isError).toBe(false);
      if (typeof result.output !== 'string') throw new Error('AgentList must return its JSON receipt');
      return (JSON.parse(result.output) as AgentListOutput).agents.find((agent) => agent.agent_id === CHILD)?.status;
    };
    const input = { sourceAgentId: CHILD, sourceTaskName: 'sender', targetAgentId: CHILD, targetTaskName: 'saved_child',
      content: 'Use the preserved update.', idempotencyKey: 'held-mailbox', waitForRunningDelivery: true, idleWake: 'owned-child' as const };
    expect(await mail.messaging.send(input)).toMatchObject({ delivery: 'queued', resumed: undefined });
    expect(mail.delivered()).toBe(false);
    expect(ctx.llmCalls).toHaveLength(0);
    expect(await roster()).toBe('untracked');
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const hook = ctx.get(IAgentLoopService).hooks.onWillBeginStep.register('mailbox-recovery-fixture', async (_context, next) => {
      enter();
      await blocked;
      await next();
    });
    const controller = new AbortController();
    ctx.mockNextResponse({ type: 'text', text: 'Used the saved message.' });
    const run = await dispatch.runOnExisting(child, '', { ...options('consume-held-mailbox'), signal: controller.signal });
    try {
      const handle = await run.started;
      await entered;
      expect(await roster()).toBe('running');
      expect(ctx.get(IAgentTaskService).list(true)).toHaveLength(0);
      await expect(dispatch.runOnExisting(child, '', options('parallel-mailbox-resume'))).rejects.toMatchObject({ code: ErrorCodes.AGENT_ALREADY_RUNNING });
      release();
      await handle.completion;
      await ctx.get(IAgentExecutionService).settled();
      expect(await roster()).toBe('untracked');
      expect(await mail.messaging.send(input)).toMatchObject({ delivery: 'delivered', deduplicated: true });
      expect(ctx.llmCalls).toHaveLength(1);
      expect(JSON.stringify(ctx.llmCalls[0]!.history)).toContain('Use the preserved update.');
      expect(ctx.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'agent_message' && message.origin.messageId === 'queued-mailbox')).toHaveLength(1);
      expect(ctx.get(IAgentPromptService).list()).toMatchObject({ hold: { reason: 'recovery', count: 1 }, pending: [{ id: 'resume-prompt:unconfirmed-history' }] });
    } finally {
      release();
      controller.abort();
      await run.started.catch(() => undefined);
      await hook.dispose();
    }
  });

  it('retains queued mailbox and late timeout notifications until the resumed first step', async () => {
    const { ctx, dispatch, child, descendant, tool } = await cancelledChild();
    const mail = mailboxFor(ctx, child, dispatch);
    const input = { sourceAgentId: CHILD, sourceTaskName: 'sender', targetAgentId: CHILD,
      targetTaskName: 'saved_child', content: 'Keep this queued update', idempotencyKey: 'queued-update', waitForRunningDelivery: true };
    expect(await mail.messaging.send(input)).toMatchObject({ delivery: 'queued' });
    expect(mail.delivered()).toBe(false);
    ctx.mockNextResponse({ type: 'text', text: 'Resumed with mailbox' });
    const run = await dispatch.runOnExisting(child, 'Resume with queued mailbox', options('mailbox-resume'));
    await (await run.started).completion;
    expect(mail.delivered()).toBe(true);
    expect(await mail.messaging.send(input)).toMatchObject({ delivery: 'delivered' });
    const messages = ctx.get(IAgentContextMemoryService).get();
    expect(messages.filter((message) => message.origin?.kind === 'agent_message' && message.origin.messageId === 'queued-mailbox')).toHaveLength(1);
    for (const taskId of [descendant, tool]) {
      expect(messages.filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId)).toHaveLength(1);
    }
    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.llmCalls[0])).toContain('Keep this queued update');
    expect(ctx.get(IAgentLoopService).status().hasPendingRequests).toBe(false);
  });

  it('reports a resume queued behind a restored loop turn before that turn ends and runs it once afterwards', async () => {
    const ctx = await host();
    const { child, dispatch } = dispatchFor(ctx);
    const loop = ctx.get(IAgentLoopService);
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let gated = true;
    const hook = loop.hooks.onWillBeginStep.register('restored-turn-fixture', async (_context, next) => {
      if (gated) { gated = false; enter(); await gate; }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'Restored notification handled.' });
    ctx.mockNextResponse({ type: 'text', text: 'Queued resume result.' });
    const switcher = ctx.get(IAgentModelSwitchService);
    const execute = switcher.execute.bind(switcher);
    let restoredTurn: Promise<unknown> = Promise.resolve();
    vi.spyOn(switcher, 'execute').mockImplementationOnce(async (input, executeOptions) => {
      const receipt = await execute(input, executeOptions);
      const restored = loop.enqueue(new MessageStepRequest({ role: 'user', content: [{ type: 'text', text: 'Restored notification' }], toolCalls: [] }, { admission: 'newTurn' }));
      const turn = (await restored.assigned).turn;
      restoredTurn = turn.result;
      await entered;
      expect(ctx.get(IAgentExecutionService).status().state).toBe('idle');
      return receipt;
    });
    let queued = 0;
    let started = false;
    try {
      const run = await dispatch.runOnExisting(child, 'Continue after the restored turn.', { ...options('queued-resume'), onQueued: () => { queued += 1; } });
      void run.started.then(() => { started = true; }, () => undefined);
      await vi.waitFor(() => expect(queued).toBe(1));
      expect(started).toBe(false);
      expect(ctx.get(IAgentPromptService).list().pending.map((item) => item.id)).toEqual(['resume-prompt:queued-resume']);
      await expect(dispatch.runOnExisting(child, 'Second resume', options('second-resume'))).rejects.toMatchObject({ code: ErrorCodes.AGENT_ALREADY_RUNNING });
      release();
      const handle = await run.started;
      expect(handle.turn.id).toBeGreaterThan(0);
      await expect(handle.completion).resolves.toMatchObject({ summary: 'Queued resume result.' });
      expect(queued).toBe(1);
      expect(ctx.llmCalls).toHaveLength(2);
      expect((JSON.stringify(ctx.llmCalls[1]).match(/Continue after the restored turn\./g) ?? [])).toHaveLength(1);
    } finally {
      release();
      await restoredTurn;
      await hook.dispose();
    }
  });

  it('rejects ordinary resume during a real active turn and model switching with queued turns', async () => {
    const ctx = await host();
    const { child, dispatch, runs } = dispatchFor(ctx);
    const loop = ctx.get(IAgentLoopService);
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const hook = loop.hooks.onWillBeginStep.register('busy-fixture', async (_context, next) => { enter(); await gate; await next(); });
    ctx.mockNextResponse({ type: 'text', text: 'First completion' });
    ctx.mockNextResponse({ type: 'text', text: 'Queued completion' });
    const running = await ctx.get(IAgentExecutionService).run({ kind: 'prompt', prompt: 'Still running' }, { signal: new AbortController().signal });
    await entered;
    const queued = loop.enqueue(new MessageStepRequest({ role: 'user', content: [{ type: 'text', text: 'Queued work' }], toolCalls: [] }, { admission: 'newTurn' }));
    const queuedTurn = (await queued.assigned).turn;
    expect(loop.status().pendingTurnIds).toEqual([queuedTurn.id]);
    const start = vi.spyOn(runs, 'run');
    try {
      await expect(dispatch.runOnExisting(child, 'Must wait', options('active-resume'))).rejects.toMatchObject({ code: ErrorCodes.AGENT_ALREADY_RUNNING });
      await expect(ctx.get(IAgentModelSwitchService).execute({ operationId: 'queued-switch', model: OLD, mode: 'direct' })).rejects.toMatchObject({ code: ErrorCodes.TURN_AGENT_BUSY });
      expect(start).not.toHaveBeenCalled();
    } finally {
      release();
      await running.completion;
      await queuedTurn.result;
      await hook.dispose();
    }
  });

  it('keeps quiescence and held admissions exclusive when pending steps are preserved', async () => {
    const ctx = await host();
    const loop = ctx.get(IAgentLoopService);
    const hold = loop.tryAcquireQuiescence();
    expect(hold).toBeDefined();
    const request = new MessageStepRequest({ role: 'user', content: [{ type: 'text', text: 'Held work' }], toolCalls: [] }, { admission: 'newTurn' });
    const admission = loop.enqueue(request);
    try {
      expect(loop.status()).toMatchObject({ state: 'idle', pendingRequestKinds: ['message'], pendingTurnIds: [] });
      await expect(ctx.get(IAgentModelSwitchService).execute({ operationId: 'held-switch', model: OLD, mode: 'direct' })).rejects.toMatchObject({ code: ErrorCodes.TURN_AGENT_BUSY });
      expect(loop.tryAcquireQuiescence({ pendingSteps: 'preserve' })).toBeUndefined();
    } finally {
      admission.abort();
      await hold!.dispose();
    }
  });

  it('keeps real compaction exclusive even when the execution loop is idle', async () => {
    const ctx = await host();
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(ctx.get(IAgentLLMRequesterService), 'start').mockImplementation((_options, _onPart, signal) => {
      entered();
      return { trace: { traceId: 'compaction-fixture' }, result: new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => { reject(signal!.reason); }, { once: true });
      }) };
    });
    const compaction = ctx.get(IAgentFullCompactionService);
    expect(compaction.begin({ source: 'manual', strategy: 'summarize' })).toBe(true);
    const task = compaction.compacting!;
    try {
      await Promise.race([requested, task.promise.then(() => { throw new Error('Compaction completed before the summary request'); })]);
      expect(ctx.get(IAgentLoopService).status().state).toBe('idle');
      expect(compaction.isCompacting()).toBe(true);
      await expect(ctx.get(IAgentModelSwitchService).execute({ operationId: 'compacting-switch', model: OLD, mode: 'direct' })).rejects.toMatchObject({ code: ErrorCodes.TURN_AGENT_BUSY });
    } finally {
      compaction.cancel();
      await task.promise.catch(() => {});
    }
  });
});

describe('dispatch resume retention', () => {
  const now = Date.UTC(2026, 9, 31);
  const day = 24 * 60 * 60_000;
  const record = (i: number, overrides: Partial<DispatchResumeRecord> = {}): DispatchResumeRecord => ({
    operationId: `operation-${i}`, fingerprint: 'fingerprint', request: { kind: 'prompt', prompt: 'continue' },
    switchInput: { operationId: `operation-${i}`, model: 'example-model', mode: 'direct' },
    state: 'started', ...overrides,
  });
  const registry = (records: DispatchResumeRecord[]) => ({ labels: Object.fromEntries(records.map((r) => [`dispatchResume:${r.operationId}`, JSON.stringify(r)])) });

  it('keeps every legacy record until quiescence and retains the latest 32 plus recent timestamps', () => {
    const meta = registry(Array.from({ length: 80 }, (_, i) => record(i, i < 40 ? {} : { createdAt: now - day })));
    expect(pruneResumeRecords(meta, false, now)).toBe(meta);
    const compacted = pruneResumeRecords(meta, true, now);
    expect(Object.keys(compacted.labels ?? {})).toHaveLength(40);
    expect(readResumeRecord(compacted, 'operation-0')).toBeUndefined();
    expect(readResumeRecord(compacted, 'operation-40')).toBeDefined();
  });

  it('retains at least 32 old records even when all operations are beyond seven days', () => {
    const meta = registry(Array.from({ length: 80 }, (_, i) => record(i, { createdAt: now - (100 - i) * day })));
    const compacted = pruneResumeRecords(meta, true, now);
    expect(Object.keys(compacted.labels ?? {})).toHaveLength(32);
    expect(readResumeRecord(compacted, 'operation-47')).toBeUndefined();
    expect(readResumeRecord(compacted, 'operation-48')).toBeDefined();
  });

  it('preserves accepted, ready, malformed and unproven new records outside the window', () => {
    const records = Array.from({ length: 40 }, (_, i) => record(i, {
      state: i === 0 ? 'accepted' : i === 1 ? 'ready' : 'started',
      retentionVersion: i === 2 ? 1 : undefined,
      createdAt: now - 10 * day,
    }));
    const meta = registry(records);
    meta.labels['dispatchResume:broken'] = '{';
    const compacted = pruneResumeRecords(meta, true, now);
    for (const i of [0, 1, 2]) expect(readResumeRecord(compacted, `operation-${i}`)).toBeDefined();
    expect(compacted.labels?.['dispatchResume:broken']).toBe('{');
    expect(readResumeRecord(compacted, 'operation-3')).toBeUndefined();
  });

  it('requires matching canonical outcome proof before pruning a new-format operation', () => {
    const meta = registry(Array.from({ length: 40 }, (_, i) => record(i, {
      createdAt: now - 10 * day, retentionVersion: 1,
    })));
    const bound = bindResumeTask(meta, 'operation-0', 'task-0');
    const wrong = acknowledgeResumeOutcome(bound, 'task-other', now - 9 * day);
    expect(pruneResumeRecords(wrong, true, now).labels?.['dispatchResume:operation-0']).toBeDefined();
    const completed = acknowledgeResumeOutcome(bound, 'task-0', now - 9 * day);
    expect(readResumeRecord(completed, 'operation-0')?.outcome).toEqual({ taskId: 'task-0', completedAt: now - 9 * day });
    expect(pruneResumeRecords(completed, false, now).labels?.['dispatchResume:operation-0']).toBeUndefined();
    expect(pruneResumeRecords(completed, false, now).labels?.['dispatchResume:operation-1']).toBeDefined();
  });
});
