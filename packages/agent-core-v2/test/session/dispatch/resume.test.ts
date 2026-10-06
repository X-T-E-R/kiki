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
import { SubagentToolInputSchema } from '#/agent/tools/agent/agent';
import { addSubagentBindingSchemaConstraints } from '#/session/subagent/configSection';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentCollaborationRegistry } from '#/session/agentCollaboration/registry';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import { ISessionDispatchService, type DispatchChild, type DispatchRunOptions } from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import { readResumeRecord, writeResumeRecord } from '#/session/dispatch/resume';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentExecutorRegistry, type ResolvedAgentExecutor } from '#/app/agentExecutor/agentExecutor';
import { recordNegotiatedSnapshot } from '#/agent/execution/negotiatedSnapshot';
import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { AGENT_RUN_PROMPT_ORIGIN, runAgentTurn } from '#/session/subagent/runAgentTurn';
import { createHooks } from '#/hooks';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { Error2, ErrorCodes } from '#/errors';
import { agentServices, testAgent, type TestAgentContext } from '../../harness';
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

const OLD = 'example/old-model';
const NEW = 'example/new-model';
const CHILD = 'saved-child';
const hosts: TestAgentContext[] = [];
const containers: TestInstantiationService[] = [];

async function host() {
  const ctx = testAgent({ autoConfigure: false, initialConfig: {
    providers: { example: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' } },
    models: {
      [OLD]: { provider: 'example', model: 'old-model', maxContextSize: 200_000, capabilities: ['thinking'], supportEfforts: ['low', 'high'], defaultEffort: 'high' },
      [NEW]: { provider: 'example', model: 'new-model', maxContextSize: 100_000, capabilities: ['thinking'], supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    },
  } }, agentServices((reg) => reg.defineInstance(IAgentScopeContext, {
    _serviceBrand: undefined, agentId: CHILD, parentAgentId: 'main',
    scope: (subKey) => `test-session/agents/${CHILD}${subKey ? `/${subKey}` : ''}`,
  })));
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
  ix.stub(IAgentLifecycleService, { get: (id) => id === CHILD ? childHandle : id === 'main' ? callerHandle : undefined });
  ix.stub(IAgentCollaborationRegistry, {});
  ix.set(IConfigService, ctx.get(IConfigService));
  ix.set(IModelService, ctx.get(IModelService));
  ix.set(IModelCatalog, ctx.get(IModelCatalog));
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

describe('AgentRun new_window shape', () => {
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

  it.each(['allowed', 'deny', 'menu', 'caller'] as const)('new_window does not bypass frozen %s constraints', async (constraint) => {
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
    await expect(dispatch.runOnExisting(child, 'Blocked fresh', options(`blocked-${constraint}`, { modelAlias: NEW, newWindow: true }))).rejects.toThrow();
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

  it('rejects an active child and foreign ownership without switching or launching', async () => {
    const ctx = await host();
    const { dispatch, child, runs } = dispatchFor(ctx);
    vi.spyOn(ctx.get(IAgentExecutionService), 'status').mockReturnValue({ state: 'running', turnId: 10 });
    const start = vi.spyOn(runs, 'run');
    await expect(dispatch.runOnExisting(child, 'Must wait', options('running', { newWindow: true }))).rejects.toMatchObject({ code: ErrorCodes.AGENT_ALREADY_RUNNING });
    await expect(dispatch.resolveOwnedChild({ kind: 'agent', agentId: 'foreign-parent' }, CHILD)).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_OWNED });
    expect(start).not.toHaveBeenCalled();
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
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
    ix.set(ILogService, ctx.get(ILogService));
    ix.stub(ISessionManager, {});
    ix.set(IAgentCollaborationMessagingService, new SyncDescriptor(AgentCollaborationMessagingService));
    return { messaging: ix.get(IAgentCollaborationMessagingService), delivered: () => delivered };
  }

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
    expect(compaction.begin({ source: 'manual' })).toBe(true);
    const task = compaction.compacting!;
    await requested;
    try {
      expect(ctx.get(IAgentLoopService).status().state).toBe('idle');
      expect(compaction.isCompacting()).toBe(true);
      await expect(ctx.get(IAgentModelSwitchService).execute({ operationId: 'compacting-switch', model: OLD, mode: 'direct' })).rejects.toMatchObject({ code: ErrorCodes.TURN_AGENT_BUSY });
    } finally {
      compaction.cancel();
      await task.promise.catch(() => {});
    }
  });
});
