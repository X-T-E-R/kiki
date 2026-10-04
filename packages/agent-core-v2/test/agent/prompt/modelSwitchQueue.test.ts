import { afterEach, describe, expect, it, vi } from 'vitest';
import { testAgent, agentServices, type TestAgentContext } from '../../harness';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService, promptQueueKey } from '#/agent/prompt/promptService';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { AgentModelSwitchService } from '#/agent/modelSwitch/modelSwitchService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentTaskService } from '#/agent/task/task';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { deferred } from '../../deferred';
import { IAgentLoopService } from '#/agent/loop/loop';

const OLD = 'example/old-model';
const NEW = 'example/new-model';
const hosts: TestAgentContext[] = [];
async function host() {
  const ctx = testAgent({ autoConfigure: false, initialConfig: {
    providers: { example: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' } },
    models: { [OLD]: { provider: 'example', model: 'old-model', maxContextSize: 200_000 },
      [NEW]: { provider: 'example', model: 'new-model', maxContextSize: 100_000 } },
  } }, agentServices((reg) => {
    reg.define(IAgentPromptService, AgentPromptService);
    reg.define(IAgentModelSwitchService, AgentModelSwitchService);
  }));
  hosts.push(ctx);
  await ctx.ready;
  ctx.get(IAgentProfileService).update({ modelAlias: OLD, thinkingLevel: 'off', systemPrompt: 'Test system.' });
  ctx.get(IAgentPromptService);
  await ctx.get(ISessionMetadata).registerAgent('main', { model: OLD, thinkingEffort: 'off', executor: 'native' });
  return ctx;
}
async function records(ctx: TestAgentContext) {
  const out: WireRecord[] = [];
  for await (const record of ctx.get(IWireService).readJournal()) out.push(record);
  return out;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((ctx) => ctx.dispose()));
});

describe('model switch control queue with real engine', () => {
  it.each(['direct', 'fresh', 'compact'] as const)('runs %s without a chat turn and replays one operation', async (mode) => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const input = { operationId: `switch-${mode}`, model: NEW, mode };
    const receipt = await svc.switchModel(input);
    expect(receipt).toMatchObject({ state: 'completed', toModel: NEW });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(NEW);
    expect(ctx.llmCalls).toHaveLength(0);
    expect(await svc.switchModel(input)).toEqual(receipt);
    const journal = await records(ctx);
    expect(journal.filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(journal.some((record) => record.type === 'turn.started')).toBe(false);
    const cold = await host();
    await cold.restore(journal);
    expect(cold.get(IAgentPromptService).getModelSwitch(input.operationId)).toMatchObject({ ...receipt, state: 'preparing' });
    expect(await cold.get(IAgentPromptService).switchModel(input)).toEqual(receipt);
    expect(cold.get(IAgentProfileService).getModel()).toBe(NEW);
  });

  it('keeps control items behind edit holds, edits and cancels pending choices, and preserves recovery holds', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    vi.spyOn(ctx.get(IAgentTaskService), 'list').mockReturnValue([{ kind: 'agent', taskId: 'child', status: 'running' } as never]);
    await svc.enqueue({ id: 'prior', message: { role: 'user', content: [{ type: 'text', text: 'Wait for child.' }], toolCalls: [] }, appendTiming: 'subagents_done', execution: { model: OLD } });
    svc.setEditHold('prior', true);
    expect(await svc.switchModel({ operationId: 'pending', model: NEW, mode: 'fresh' })).toMatchObject({ state: 'pending' });
    await svc.updateModelSwitch({ operationId: 'pending', model: NEW, mode: 'direct' }, 0);
    expect(svc.listModelSwitches()[0]).toMatchObject({ revision: 1, queueIndex: 1, input: { mode: 'direct' } });
    const cold = await host();
    await cold.restore(await records(ctx));
    expect(cold.get(IAgentPromptService).list().hold).toEqual({ reason: 'recovery', count: 2 });
    expect(await svc.cancelModelSwitch('pending')).toMatchObject({ state: 'cancelled' });
    expect(svc.list().pending[0]).toMatchObject({ id: 'prior', revision: 0, appendTiming: 'subagents_done', execution: { model: OLD } });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
  });

  it('skips an earlier not-ready message and runs a successful dependency exactly once on its committed binding', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    vi.spyOn(ctx.get(IAgentTaskService), 'list').mockReturnValue([{ kind: 'agent', taskId: 'child', status: 'running' } as never]);
    await svc.enqueue({ id: 'delayed', message: { role: 'user', content: [{ type: 'text', text: 'Old delayed message.' }, { type: 'image_url', imageUrl: { url: 'https://example.test/attachment.png', id: 'original-attachment', name: 'attachment.png' } }], toolCalls: [] }, appendTiming: 'subagents_done', execution: { model: OLD } });
    const previous = svc.list().pending[0];
    const receipt = await svc.switchModel({ operationId: 'ready-control', model: NEW, mode: 'fresh' });
    expect(receipt.state).toBe('completed');
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    const dependency = await svc.enqueue({ id: 'dependent', message: { role: 'user', content: [{ type: 'text', text: 'Continue on new model.' }], toolCalls: [] }, execution: { afterModelSwitch: 'ready-control' } });
    await dependency.completion;
    expect(ctx.get(IAgentProfileService).getModel()).toBe(NEW);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(svc.list().pending.map((item) => item.id)).toEqual(['delayed']);
    expect(svc.list().pending[0]).toEqual(previous);
    expect((await records(ctx)).filter((record) => record.type === 'prompt.launch_committed' && record['promptId'] === 'dependent')).toHaveLength(1);
  });

  it('holds failed dependencies without blocking independent messages and supports retry', async () => {
    const ctx = await host();
    ctx.get(IAgentContextMemoryService).append({ role: 'user', content: [{ type: 'text', text: 'Existing task.' }], toolCalls: [] });
    const svc = ctx.get(IAgentPromptService);
    const summary = vi.spyOn(ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary').mockRejectedValueOnce(new Error('offline'));
    expect(await svc.switchModel({ operationId: 'failed', model: NEW, mode: 'compact' })).toMatchObject({ state: 'failed' });
    const dependent = await svc.enqueue({ id: 'dependent', message: { role: 'user', content: [{ type: 'text', text: 'Wait for successful switch.' }], toolCalls: [] }, execution: { afterModelSwitch: 'failed' } });
    expect(dependent.state).toBe('pending');
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    ctx.mockNextResponse({ type: 'text', text: 'Independent result.' });
    const independent = await svc.enqueue({ id: 'independent', message: { role: 'user', content: [{ type: 'text', text: 'Use the original model.' }], toolCalls: [] } });
    await independent.completion;
    expect(svc.list().pending.map((item) => item.id)).toEqual(['dependent']);
    summary.mockRestore();
    ctx.mockNextResponse({ type: 'text', text: 'Portable summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'Dependent result.' });
    expect(await svc.recoverModelSwitch('failed', 'retry')).toMatchObject({ state: 'completed' });
    await dependent.completion;
    expect(ctx.get(IAgentProfileService).getModel()).toBe(NEW);
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('retains preparing on uncertain flush; retry only finishes M1 and never advances the window twice', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const dispatcher = ctx.get(IEventDispatcher);
    const flush = vi.spyOn(dispatcher, 'flush').mockRejectedValueOnce(new Error('disk unavailable'));
    const input = { operationId: 'flush', model: NEW, mode: 'fresh' as const };
    expect(await svc.switchModel(input)).toMatchObject({ state: 'preparing' });
    expect(svc.hasReadyPending()).toBe(true);
    expect(await svc.recoverModelSwitch('flush', 'retry')).toMatchObject({ state: 'completed' });
    expect(flush).toHaveBeenCalledTimes(2);
    expect((await records(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(promptQueueKey).order).toHaveLength(0);
  });
});

describe('prompt identity and recovery boundaries', () => {
  it('reuses a stable prompt ID live and cold for all origins and rejects conflicting input', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const input = { id: 'stable-run-prompt', message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Continue exactly once.' }], toolCalls: [], origin: { kind: 'system_trigger' as const, name: 'subagent' } } };
    ctx.mockNextResponse({ type: 'text', text: 'Completed once.' });
    const [first, retry] = await Promise.all([svc.enqueue(input), svc.enqueue(input)]);
    expect(retry).toBe(first);
    await first.completion;
    await ctx.get(IEventDispatcher).flush();
    expect(await svc.enqueue(input)).toBe(first);
    expect(svc.lookup(input.id)).toMatchObject({ phase: 'terminal', terminal: { promptId: input.id, state: 'completed' } });
    await expect(svc.enqueue({ ...input, message: { ...input.message, content: [{ type: 'text', text: 'Different request.' }] } })).rejects.toMatchObject({ code: 'prompt.id_conflict' });
    const journal = await records(ctx);
    const cold = await host();
    await cold.restore(journal);
    const restored = cold.get(IAgentPromptService);
    expect(restored.lookup(input.id)).toMatchObject({ phase: 'terminal', terminal: { state: 'completed' } });
    expect((await restored.enqueue(input)).state).toBe('completed');
    expect(cold.llmCalls).toHaveLength(0);
    expect(restored.list().pending).toHaveLength(0);
    const uncertain = await host();
    const committed = journal.findIndex((record) => record.type === 'prompt.launch_committed');
    await uncertain.restore(journal.slice(0, committed + 1));
    expect(uncertain.get(IAgentPromptService).lookup(input.id)?.phase).toBe('launched');
    await expect(uncertain.get(IAgentPromptService).enqueue(input)).rejects.toMatchObject({ code: 'prompt.id_conflict' });
    expect(uncertain.llmCalls).toHaveLength(0);
  });

  it('recovers a committed switch with failed metadata without redoing context or losing the dependent prompt', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    vi.spyOn(ctx.get(ISessionMetadata), 'updateAgent').mockRejectedValueOnce(new Error('metadata unavailable'));
    const input = { operationId: 'metadata-gap', model: NEW, mode: 'fresh' as const };
    expect(await svc.switchModel(input)).toMatchObject({ state: 'preparing' });
    await svc.enqueue({ id: 'after-metadata', message: { role: 'user', content: [{ type: 'text', text: 'Continue once after confirmation.' }], toolCalls: [] }, execution: { afterModelSwitch: input.operationId } });
    const cold = await host();
    await cold.restore(await records(ctx));
    const restored = cold.get(IAgentPromptService);
    expect(restored.getModelSwitch(input.operationId)?.state).toBe('preparing');
    expect(restored.list().pending[0]).toMatchObject({ id: 'after-metadata', revision: 0, execution: { afterModelSwitch: input.operationId } });
    await expect(restored.cancelModelSwitch(input.operationId)).rejects.toThrow('Recover this switch');
    expect(await restored.recoverModelSwitch(input.operationId, 'retry')).toMatchObject({ state: 'completed', windowEpoch: 1 });
    expect(cold.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(cold.llmCalls).toHaveLength(0);
    cold.mockNextResponse({ type: 'text', text: 'Recovered completion.' });
    const handle = await restored.enqueue({ id: 'after-metadata', message: { role: 'user', content: [{ type: 'text', text: 'Continue once after confirmation.' }], toolCalls: [] }, execution: { afterModelSwitch: input.operationId } });
    restored.resumeRecoveredQueue();
    await handle.completion;
    expect(cold.llmCalls).toHaveLength(1);
    expect((await records(cold)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
  });

  it('lets the current turn finish naturally before the control item and leaves children running', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const gate = deferred<void>();
    const entered = deferred<void>();
    ctx.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-current-turn', async () => { entered.resolve(); await gate.promise; });
    ctx.mockNextResponse({ type: 'text', text: 'Current turn completed normally.' });
    const active = await svc.enqueue({ id: 'current-turn', message: { role: 'user', content: [{ type: 'text', text: 'Finish this turn.' }], toolCalls: [] } });
    await entered.promise;
    const tasks = vi.spyOn(ctx.get(IAgentTaskService), 'list').mockReturnValue([{ kind: 'agent', taskId: 'still-running-child', status: 'running' } as never]);
    expect(await svc.switchModel({ operationId: 'busy-control', model: NEW, mode: 'direct' })).toMatchObject({ state: 'pending' });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    gate.resolve();
    expect((await active.completion).state).toBe('completed');
    await ctx.get(IAgentLoopService).settled();
    await vi.waitFor(() => { expect(svc.getModelSwitch('busy-control')?.state).toBe('completed'); });
    expect(tasks()).toMatchObject([{ taskId: 'still-running-child', status: 'running' }]);
    expect(ctx.llmCalls).toHaveLength(1);
  });
});

describe('model switch recovery actions', () => {
  it('keeps queue projection flush uncertainty preparing and retries completion without another commit', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const wire = ctx.get(IWireService);
    const realFlush = wire.flush.bind(wire);
    let calls = 0;
    vi.spyOn(wire, 'flush').mockImplementation(async () => {
      calls++;
      if (calls === 3) throw new Error('queue status flush uncertain');
      await realFlush();
    });
    const input = { operationId: 'queue-flush', model: NEW, mode: 'fresh' as const };
    expect(await svc.switchModel(input)).toMatchObject({ state: 'preparing' });
    expect(svc.getModelSwitch(input.operationId)?.state).toBe('preparing');
    expect(ctx.get(IAgentProfileService).getModel()).toBe(NEW);
    expect(await svc.recoverModelSwitch(input.operationId, 'retry')).toMatchObject({ state: 'completed' });
    expect((await records(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
  });

  it('cancels preparation at its signal boundary and retains the old binding for a dependent message', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const entered = deferred<void>();
    vi.spyOn(ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary').mockImplementation(async (_history, signal) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true }); });
      return undefined;
    });
    const request = svc.switchModel({ operationId: 'cancel-preparation', model: NEW, mode: 'compact' });
    await entered.promise;
    const dependent = await svc.enqueue({ id: 'retain-old', message: { role: 'user', content: [{ type: 'text', text: 'Continue on a working binding.' }], toolCalls: [] }, execution: { afterModelSwitch: 'cancel-preparation' } });
    expect(await svc.cancelModelSwitch('cancel-preparation')).toMatchObject({ state: 'cancelled' });
    expect(await request).toMatchObject({ state: 'cancelled' });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    ctx.mockNextResponse({ type: 'text', text: 'Continued with original binding.' });
    expect(await svc.recoverModelSwitch('cancel-preparation', 'keep_original')).toMatchObject({ state: 'cancelled' });
    await dependent.completion;
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(dependent.revision).toBe(0);
    expect(dependent.userMessageId).toBe('retain-old');
    expect((await records(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(0);
  });

  it('reports unsupported external execution honestly without mutating a shadow context', async () => {
    const ctx = await host();
    const profile = ctx.get(IAgentProfileService);
    const binding = profile.data();
    vi.spyOn(profile, 'data').mockReturnValue({ ...binding, executorId: 'example-external' });
    const before = ctx.get(IAgentContextMemoryService).get();
    expect(await ctx.get(IAgentPromptService).switchModel({ operationId: 'external', model: NEW, mode: 'fresh' })).toMatchObject({ state: 'failed', error: { code: 'request.invalid' } });
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.get(IAgentContextMemoryService).get()).toBe(before);
    expect((await records(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(0);
  });
});

describe('missing metadata ownership', () => {
  it('retains the committed preparing fact until lifecycle restores the missing agent entry', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const meta = ctx.get(ISessionMetadata);
    await meta.update({ agents: {} });
    const input = { operationId: 'missing-entry', model: NEW, mode: 'fresh' as const };
    expect(await svc.switchModel(input)).toMatchObject({ state: 'preparing', error: { code: 'agent_metadata_missing' } });
    const prompt = await svc.enqueue({ id: 'held-after-missing-entry', message: { role: 'user', content: [{ type: 'text', text: 'Wait for lifecycle recovery.' }], toolCalls: [] }, execution: { afterModelSwitch: input.operationId } });
    expect(prompt.state).toBe('pending');
    expect((await meta.read()).agents?.['main']).toBeUndefined();
    expect(await svc.recoverModelSwitch(input.operationId, 'retry')).toMatchObject({ state: 'preparing', error: { code: 'agent_metadata_missing' } });
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    const cold = await host();
    const coldMeta = cold.get(ISessionMetadata);
    await coldMeta.update({ agents: {} });
    await cold.restore(await records(ctx));
    const restored = cold.get(IAgentPromptService);
    expect(restored.getModelSwitch(input.operationId)).toMatchObject({ state: 'preparing', error: { code: 'agent_metadata_missing' } });
    expect(await restored.recoverModelSwitch(input.operationId, 'retry')).toMatchObject({ state: 'preparing', error: { code: 'agent_metadata_missing' } });
    expect((await coldMeta.read()).agents?.['main']).toBeUndefined();
    expect(restored.list().pending[0]).toMatchObject({ id: prompt.id, execution: { afterModelSwitch: input.operationId } });
    expect(cold.llmCalls).toHaveLength(0);
    await coldMeta.registerAgent('main', { model: OLD, executor: 'native', labels: { lifecycleRestored: 'true' } });
    cold.mockNextResponse({ type: 'text', text: 'Recovered by lifecycle.' });
    expect(await restored.recoverModelSwitch(input.operationId, 'retry')).toMatchObject({ state: 'completed', windowEpoch: 1 });
    const handle = await restored.enqueue({ id: prompt.id, message: { role: 'user', content: [{ type: 'text', text: 'Wait for lifecycle recovery.' }], toolCalls: [] }, execution: { afterModelSwitch: input.operationId } });
    restored.resumeRecoveredQueue();
    await handle.completion;
    expect((await coldMeta.read()).agents?.['main']?.labels).toMatchObject({ lifecycleRestored: 'true', contextWindowEpoch: '1' });
    expect(cold.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect((await records(cold)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
  });
});
