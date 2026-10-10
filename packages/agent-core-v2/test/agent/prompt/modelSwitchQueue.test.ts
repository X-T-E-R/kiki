import { afterEach, describe, expect, it, vi } from 'vitest';
import { testAgent, agentServices, createScriptedGenerate, type TestAgentContext, type TestAgentOptions } from '../../harness';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService, promptQueueKey } from '#/agent/prompt/promptService';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { AgentModelSwitchService } from '#/agent/modelSwitch/modelSwitchService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ExecutableTool } from '#/tool/toolContract';
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
import { ContinuationStepRequest } from '#/agent/loop/stepRequests';

const OLD = 'example/old-model';
const NEW = 'example/new-model';
const hosts: TestAgentContext[] = [];
async function host(generate?: TestAgentOptions['generate']) {
  const ctx = testAgent({ autoConfigure: false, generate, initialConfig: {
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
  it('prompt-bound fresh survives reopen and retries without a control-only queue row', async () => {
    const ctx = await host();
    vi.spyOn(ctx.get(IAgentTaskService), 'list').mockReturnValue([{ kind: 'agent', taskId: 'child', status: 'running' } as never]);
    const input = { id: 'attached-fresh', message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Use a fresh window for this real question.' }], toolCalls: [] }, appendTiming: 'subagents_done' as const, execution: { model: NEW, modelSwitchMode: 'fresh' as const } };
    const svc = ctx.get(IAgentPromptService);
    const queued = await svc.enqueue(input);
    expect(svc.list().pending).toMatchObject([{ id: input.id, execution: input.execution }]);
    expect(svc.listModelSwitches()).toEqual([]);
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    const cold = await host();
    await cold.restore(await records(ctx));
    cold.mockNextResponse({ type: 'text', text: 'The real question uses the fresh selected window.' });
    const restored = cold.get(IAgentPromptService);
    expect(restored.list().pending).toMatchObject([{ id: input.id, execution: input.execution }]);
    const selected = await restored.enqueue(input);
    await restored.steer([selected.id]);
    expect((await selected.completion).state).toBe('completed');
    const journal = await records(cold);
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: NEW }]);
    expect(journal.filter(record => record.type === 'agent.model_switch')).toMatchObject([{ mode: 'fresh', newEpoch: 1 }]);
    expect(journal.filter(record => record.type === 'prompt.model_switch_queued')).toEqual([]);
    expect(JSON.stringify(cold.llmCalls[0])).toContain('Use a fresh window for this real question.');
    expect(await restored.enqueue(input)).toBe(selected);
    await expect(restored.enqueue({ ...input, execution: { ...input.execution, modelSwitchMode: 'compact' } })).rejects.toMatchObject({ code: 'prompt.id_conflict' });
    expect(cold.llmCalls).toHaveLength(1);
    await svc.drain(new Error('Fixture closed'), 'preserve-pending');
    await queued.completion;
  });
  it('prompt-bound compact Send now preserves the in-flight request and freezes model plus effort', async () => {
    const scripted = createScriptedGenerate();
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const ctx = await host(async (...args) => {
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return scripted.generate(...args);
    });
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [NEW]: { ...ctx.kimiConfig.models![NEW]!, capabilities: ['thinking'], supportEfforts: ['high', 'max'], defaultEffort: 'high' } } };
    scripted.mockNextResponse({ type: 'text', text: 'Original work completed intact.' });
    scripted.mockNextResponse({ type: 'text', text: 'Summary of original completed work.' });
    scripted.mockNextResponse({ type: 'text', text: 'Selected binding receives the real question.' });
    const svc = ctx.get(IAgentPromptService);
    try {
      const active = await svc.enqueue({ id: 'attached-active', message: { role: 'user', content: [{ type: 'text', text: 'Original work.' }], toolCalls: [] } });
      await entered.promise;
      const input = { id: 'attached-compact', message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Continue my real question after compaction.' }], toolCalls: [] }, execution: { model: NEW, thinking: 'max', modelSwitchMode: 'compact' as const } };
      const selected = await svc.enqueue(input);
      expect(await svc.steer([selected.id])).toEqual([selected]);
      expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
      expect(calls).toBe(1);
      release.resolve();
      expect((await selected.completion).state).toBe('completed');
      await active.completion;
      const journal = await records(ctx);
      expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }, { modelAlias: OLD }, { modelAlias: NEW, thinkingEffort: 'max' }]);
      expect(journal.filter(record => record.type === 'agent.model_switch')).toMatchObject([{ mode: 'compact', summaryGenerated: true, thinking: 'max' }]);
      expect(journal.filter(record => record.type === 'prompt.enqueued' && record['promptId'] === selected.id)).toMatchObject([{ execution: input.execution }]);
      expect(journal.filter(record => record.type === 'prompt.model_switch_queued')).toEqual([]);
      expect(journal.filter(record => record.type === 'full_compaction.begin')).toEqual([]);
      expect(JSON.stringify(scripted.calls[2])).toContain('Continue my real question after compaction.');
    } finally { release.resolve(); }
  });

  it('prompt-bound selection rejects mixed legacy controls and unsupported context rebuilds', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const message = { role: 'user' as const, content: [{ type: 'text' as const, text: 'The intended binding must not be silently replaced.' }], toolCalls: [] };
    await expect(svc.enqueue({ id: 'mixed-selection', message, execution: { afterModelSwitch: 'legacy', model: NEW } })).rejects.toMatchObject({ code: 'request.invalid' });
    const profile = ctx.get(IAgentProfileService);
    vi.spyOn(profile, 'data').mockReturnValue({ ...profile.data(), executorId: 'codex', driver: 'external' });
    const selected = await svc.enqueue({ id: 'external-rebuild', message, execution: { model: 'codex/default', modelSwitchMode: 'fresh' } });
    expect((await selected.completion).state).toBe('failed');
    expect(svc.lookup(selected.id)).toMatchObject({ phase: 'terminal', terminal: { state: 'failed' } });
    expect(ctx.llmCalls).toEqual([]);
    expect((await records(ctx)).filter(record => record.type === 'agent.model_switch')).toEqual([]);
  });

  it.each(['cancel', 'summary-failure'] as const)('prompt-bound compact does not launch or commit after %s', async outcome => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    ctx.mockNextResponse({ type: 'text', text: 'Original work remains recoverable.' });
    await (await svc.enqueue({ id: 'before-summary', message: { role: 'user', content: [{ type: 'text', text: 'Original work.' }], toolCalls: [] } })).completion;
    const history = ctx.get(IAgentContextMemoryService).get();
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary').mockImplementation(async (_history, signal) => {
      entered.resolve(); await release.promise; signal.throwIfAborted();
      throw new Error('Example summary failed');
    });
    try {
      const admission = svc.enqueue({ id: 'summary-selected', message: { role: 'user', content: [{ type: 'text', text: 'Do not send this on the old binding.' }], toolCalls: [] }, execution: { model: NEW, modelSwitchMode: 'compact' } });
      await entered.promise;
      if (outcome === 'cancel') expect(svc.abort('summary-selected')).toBe(true);
      release.resolve();
      const selected = await admission;
      expect((await selected.completion).state).toBe(outcome === 'cancel' ? 'cancelled' : 'failed');
      expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
      expect(ctx.get(IAgentContextMemoryService).get()).toBe(history);
      const journal = await records(ctx);
      expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }]);
      expect(journal.filter(record => record.type === 'agent.model_switch')).toEqual([]);
      expect(journal.filter(record => record.type === 'turn.prompt' && record['promptId'] === selected.id)).toEqual([]);
    } finally { release.resolve(); }
  });

  it('safe Send now retains a failed original delivery until an explicit normal retry', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const entered = deferred<void>();
    const release = deferred<void>();
    ctx.get(IAgentLoopService).hooks.onDidFinishStep.register('failed-switch-boundary', async (step, next) => {
      if (step.step === 1) { entered.resolve(); await release.promise; }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'Current work finished.' });
    const active = await svc.enqueue({ id: 'failed-active', message: { role: 'user', content: [{ type: 'text', text: 'Current work.' }], toolCalls: [] } });
    await entered.promise;
    await svc.switchModel({ operationId: 'failed-safe-choice', model: NEW, mode: 'direct' });
    const original = await svc.enqueue({ id: 'failed-safe-original', message: { role: 'user', content: [{ type: 'text', text: 'Preserve this exact question if switching fails.' }], toolCalls: [] }, execution: { afterModelSwitch: 'failed-safe-choice' } });
    const prepare = vi.spyOn(ctx.get(IAgentProfileService), 'prepareModelSwitchBinding').mockRejectedValueOnce(new Error('target unavailable'));
    expect(await svc.steer([original.id])).toEqual([original]);
    release.resolve();
    await active.completion;
    expect(svc.getModelSwitch('failed-safe-choice')).toMatchObject({ state: 'failed', error: { message: 'target unavailable' } });
    expect(original.state).toBe('pending');
    expect(svc.list().pending[0]?.message.content).toEqual(original.message.content);
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    ctx.mockNextResponse({ type: 'text', text: 'Original recovered question answered.' });
    expect(await svc.recoverModelSwitch('failed-safe-choice', 'retry')).toMatchObject({ state: 'completed' });
    expect((await original.completion).state).toBe('completed');
    const journal = await records(ctx);
    expect(journal.filter(record => record.type === 'turn.prompt' && record['promptId'] === original.id)).toHaveLength(1);
    expect(journal.filter(record => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }, { modelAlias: NEW }]);
  });

  it('safe model delivery retains an unrelated permission change for its own turn', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const entered = deferred<void>();
    const release = deferred<void>();
    const resumed = deferred<void>();
    const finish = deferred<void>();
    ctx.get(IAgentLoopService).hooks.onDidFinishStep.register('unrelated-settings-boundary', async (step, next) => {
      if (step.step === 1) { entered.resolve(); await release.promise; }
      if (step.step === 2 && step.turnId === 0) { resumed.resolve(); await finish.promise; }
      await next();
    });
    for (const text of ['Initial response.', 'Existing continuation.', 'Own-turn answer.']) ctx.mockNextResponse({ type: 'text', text });
    const active = await svc.enqueue({ id: 'permission-active', message: { role: 'user', content: [{ type: 'text', text: 'Existing work.' }], toolCalls: [] } });
    await entered.promise;
    ctx.get(IAgentLoopService).enqueue(new ContinuationStepRequest());
    await svc.switchModel({ operationId: 'permission-model-choice', model: NEW, mode: 'direct' });
    const dependent = await svc.enqueue({ id: 'permission-original', message: { role: 'user', content: [{ type: 'text', text: 'Use the selected model in my changed permission mode.' }], toolCalls: [] }, execution: { afterModelSwitch: 'permission-model-choice', permissionMode: 'yolo' } });
    await svc.steer([dependent.id]);
    release.resolve();
    await resumed.promise;
    expect(ctx.get(IAgentPermissionModeService).mode).not.toBe('yolo');
    expect(dependent.state).toBe('pending');
    finish.resolve();
    await active.completion;
    expect((await dependent.completion).state).toBe('completed');
    expect(ctx.get(IAgentPermissionModeService).mode).toBe('yolo');
    const journal = await records(ctx);
    expect(journal.filter(record => record.type === 'turn.prompt' && record['promptId'] === dependent.id)).toHaveLength(1);
    expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === dependent.id)).toHaveLength(0);
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }, { modelAlias: NEW }, { modelAlias: NEW }]);
  });

  it('safe Send now restores a historical completed dependency binding without replaying its context operation', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    await svc.switchModel({ operationId: 'historical-binding', model: NEW, mode: 'fresh' });
    await svc.switchModel({ operationId: 'later-current-binding', model: OLD, mode: 'direct' });
    const entered = deferred<void>();
    const release = deferred<void>();
    ctx.get(IAgentLoopService).hooks.onDidFinishStep.register('historical-boundary', async (step, next) => {
      if (step.step === 1) { entered.resolve(); await release.promise; }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'Current model response.' });
    ctx.mockNextResponse({ type: 'text', text: 'Captured model answer.' });
    const active = await svc.enqueue({ id: 'historical-active', message: { role: 'user', content: [{ type: 'text', text: 'Continue current work.' }], toolCalls: [] } });
    await entered.promise;
    const dependent = await svc.enqueue({ id: 'historical-original', message: { role: 'user', content: [{ type: 'text', text: 'Use the binding captured for this message.' }], toolCalls: [] }, execution: { afterModelSwitch: 'historical-binding' } });
    await svc.steer([dependent.id]);
    release.resolve();
    expect((await dependent.completion).state).toBe('completed');
    await active.completion;
    const journal = await records(ctx);
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }, { modelAlias: NEW }]);
    expect(journal.filter(record => record.type === 'agent.model_switch' && record['operationId'] === 'historical-binding')).toHaveLength(1);
    expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === dependent.id)).toHaveLength(1);
  });

  it('safe Send now consumes different captured switch bindings at separate request boundaries', async () => {
    const scripted = createScriptedGenerate();
    const entered = deferred<void>();
    const release = deferred<void>();
    const ctx = await host(async (...args) => {
      if (scripted.calls.length === 0) { entered.resolve(); await release.promise; }
      return scripted.generate(...args);
    });
    const svc = ctx.get(IAgentPromptService);
    for (const text of ['Initial response.', 'First selected answer.', 'Second selected answer.']) scripted.mockNextResponse({ type: 'text', text });
    const active = await svc.enqueue({ id: 'multi-active', message: { role: 'user', content: [{ type: 'text', text: 'Existing work.' }], toolCalls: [] } });
    await entered.promise;
    await svc.switchModel({ operationId: 'multi-first', model: NEW, mode: 'direct' });
    const first = await svc.enqueue({ id: 'multi-question-first', message: { role: 'user', content: [{ type: 'text', text: 'Question for the first selected binding.' }], toolCalls: [] }, execution: { afterModelSwitch: 'multi-first' } });
    await svc.switchModel({ operationId: 'multi-second', model: OLD, mode: 'direct' });
    const second = await svc.enqueue({ id: 'multi-question-second', message: { role: 'user', content: [{ type: 'text', text: 'Question for the second selected binding.' }], toolCalls: [] }, execution: { afterModelSwitch: 'multi-second' } });
    expect(await svc.steer([first.id, second.id])).toEqual([first, second]);
    release.resolve();
    expect((await first.completion).state).toBe('completed');
    expect((await second.completion).state).toBe('completed');
    await active.completion;
    const journal = await records(ctx);
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }, { modelAlias: NEW }, { modelAlias: OLD }]);
    expect(JSON.stringify(scripted.calls[1])).toContain('Question for the first selected binding.');
    expect(JSON.stringify(scripted.calls[1])).not.toContain('Question for the second selected binding.');
    expect(JSON.stringify(scripted.calls[2])).toContain('Question for the second selected binding.');
    for (const item of [first, second]) expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === item.id)).toHaveLength(1);
  });

  it('safe Send now holds the boundary on uncertain completion and normal retry consumes the accepted message once', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    const entered = deferred<void>();
    const release = deferred<void>();
    loop.hooks.onDidFinishStep.register('uncertain-boundary', async (step, next) => {
      if (step.step === 1) { entered.resolve(); await release.promise; }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'Current request finished.' });
    ctx.mockNextResponse({ type: 'text', text: 'Recovered original message.' });
    const active = await svc.enqueue({ id: 'uncertain-active', message: { role: 'user', content: [{ type: 'text', text: 'Existing work.' }], toolCalls: [] } });
    await entered.promise;
    loop.enqueue(new ContinuationStepRequest());
    await svc.switchModel({ operationId: 'uncertain-safe-switch', model: NEW, mode: 'fresh' });
    const dependent = await svc.enqueue({ id: 'uncertain-original', message: { role: 'user', content: [{ type: 'text', text: 'My original recoverable question.' }], toolCalls: [] }, execution: { afterModelSwitch: 'uncertain-safe-switch' } });
    vi.spyOn(ctx.get(ISessionMetadata), 'updateAgent').mockRejectedValueOnce(new Error('metadata unavailable'));
    await svc.steer([dependent.id]);
    release.resolve();
    await vi.waitFor(() => expect(svc.getModelSwitch('uncertain-safe-switch')).toMatchObject({ state: 'preparing', error: { message: 'metadata unavailable' } }));
    expect(ctx.llmCalls).toHaveLength(1);
    expect(dependent.state).toBe('pending');
    expect(await svc.recoverModelSwitch('uncertain-safe-switch', 'retry')).toMatchObject({ state: 'completed' });
    expect((await dependent.completion).state).toBe('completed');
    await active.completion;
    const journal = await records(ctx);
    expect(journal.filter(record => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === dependent.id)).toHaveLength(1);
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }, { modelAlias: NEW }]);
    expect(JSON.stringify(ctx.llmCalls[1])).toContain('My original recoverable question.');
  });

  it('safe Send now waits for the tool result and preserves it in the next request', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const entered = deferred<void>();
    const release = deferred<void>();
    const tool: ExecutableTool<{ query: string }> = {
      name: 'Lookup', description: 'Look up a test value.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      resolveExecution: () => ({ approvalRule: 'Lookup', execute: async () => {
        entered.resolve(); await release.promise; return { output: 'complete-original-tool-result' };
      } }),
    };
    ctx.get(IAgentPermissionModeService).setMode('yolo');
    ctx.get(IAgentProfileService).update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(tool);
    ctx.mockNextResponse({ type: 'text', text: 'Look up the original value.' }, { type: 'function', id: 'original-lookup', name: 'Lookup', arguments: '{"query":"moon"}' });
    ctx.mockNextResponse({ type: 'text', text: 'Selected model received the complete result.' });
    const active = await svc.enqueue({ id: 'tool-active', message: { role: 'user', content: [{ type: 'text', text: 'Start the lookup.' }], toolCalls: [] } });
    await entered.promise;
    expect(await svc.switchModel({ operationId: 'tool-pending', model: NEW, mode: 'direct' })).toMatchObject({ state: 'pending' });
    const dependent = await svc.enqueue({ id: 'tool-dependent', message: { role: 'user', content: [{ type: 'text', text: 'Use the complete lookup result on my selected model.' }], toolCalls: [] }, execution: { afterModelSwitch: 'tool-pending' } });
    await svc.steer([dependent.id]);
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(ctx.llmCalls).toHaveLength(1);
    release.resolve();
    expect((await dependent.completion).state).toBe('completed');
    await active.completion;
    const journal = await records(ctx);
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }, { modelAlias: NEW }]);
    const switched = journal.findIndex(record => record.type === 'agent.model_switch');
    const result = journal.findIndex(record => record.type === 'context.append_loop_event' && JSON.stringify(record).includes('complete-original-tool-result'));
    expect(result).toBeGreaterThan(-1);
    expect(switched).toBeGreaterThan(result);
    expect(JSON.stringify(ctx.llmCalls[1])).toContain('complete-original-tool-result');
    expect(JSON.stringify(ctx.llmCalls[1])).toContain('Use the complete lookup result on my selected model.');
    expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === dependent.id)).toHaveLength(1);
  });

  it.each(['direct', 'fresh', 'compact'] as const)('safe Send now preserves an in-flight provider request and applies %s before the next request', async mode => {
    const scripted = createScriptedGenerate();
    const streaming = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const ctx = await host(async (...args) => {
      if (++calls === 1) { streaming.resolve(); await release.promise; }
      return scripted.generate(...args);
    });
    const svc = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    scripted.mockNextResponse({ type: 'text', text: 'Old request finished intact.' });
    if (mode === 'compact') scripted.mockNextResponse({ type: 'text', text: 'Portable summary of the completed original work.' });
    scripted.mockNextResponse({ type: 'text', text: 'New request sees the original question.' });
    const active = await svc.enqueue({ id: 'streaming-before-switch', message: { role: 'user', content: [{ type: 'text', text: 'Work already underway.' }], toolCalls: [] } });
    await streaming.promise;
    loop.enqueue(new ContinuationStepRequest());
    expect(await svc.switchModel({ operationId: 'streaming-pending', model: NEW, mode })).toMatchObject({ state: 'pending' });
    const input = { id: 'streaming-selected', message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Unique original question after model selection.' }], toolCalls: [] }, execution: { afterModelSwitch: 'streaming-pending' } };
    const dependent = await svc.enqueue(input);
    expect(await svc.steer([dependent.id])).toEqual([dependent]);
    expect(await svc.steer([dependent.id])).toEqual([dependent]);
    expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    expect(calls).toBe(1);
    release.resolve();
    expect((await dependent.completion).state).toBe('completed');
    expect((await active.completion).state).toBe('completed');
    const journal = await records(ctx);
    const selectedRequest = mode === 'compact' ? 2 : 1;
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject(mode === 'compact' ? [{ modelAlias: OLD }, { modelAlias: OLD }, { modelAlias: NEW }] : [{ modelAlias: OLD }, { modelAlias: NEW }]);
    expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === input.id)).toHaveLength(1);
    expect(scripted.calls).toHaveLength(selectedRequest + 1);
    expect(JSON.stringify(scripted.calls[selectedRequest])).toContain('Unique original question after model selection.');
    expect(svc.getModelSwitch('streaming-pending')).toMatchObject({ state: 'completed', mode });
  });

  it('safe Send now accepts a pending switch and consumes the original message before an old-binding continuation', async () => {
    const ctx = await host();
    const svc = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    const entered = deferred<void>();
    const release = deferred<void>();
    const hook = loop.hooks.onDidFinishStep.register('hold-first-safe-boundary', async (step, next) => {
      if (step.step === 1) { entered.resolve(); await release.promise; }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'Current request completed safely.' });
    ctx.mockNextResponse({ type: 'text', text: 'Original message answered on the selected model.' });
    const active = await svc.enqueue({ id: 'active-before-switch', message: { role: 'user', content: [{ type: 'text', text: 'Continue existing work.' }], toolCalls: [] } });
    await entered.promise;
    loop.enqueue(new ContinuationStepRequest());
    expect(await svc.switchModel({ operationId: 'pending-at-boundary', model: NEW, mode: 'direct' })).toMatchObject({ state: 'pending' });
    const input = { id: 'send-pending-switch', message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Apply my selected model and answer this original message.' }], toolCalls: [] }, execution: { afterModelSwitch: 'pending-at-boundary' } };
    const dependent = await svc.enqueue(input);
    try {
      const [accepted] = await svc.steer([dependent.id]);
      expect(accepted).toBe(dependent);
      expect(svc.getModelSwitch('pending-at-boundary')?.state).toBe('pending');
      expect(ctx.llmCalls).toHaveLength(1);
      expect(ctx.get(IAgentProfileService).getModel()).toBe(OLD);
    } finally { release.resolve(); await hook.dispose(); }
    expect((await dependent.completion).state).toBe('completed');
    await active.completion;
    const journal = await records(ctx);
    expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: OLD }, { modelAlias: NEW }]);
    expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === input.id)).toHaveLength(1);
    expect(svc.getModelSwitch('pending-at-boundary')?.state).toBe('completed');
    expect(svc.list().pending).toEqual([]);
    expect((await svc.enqueue(input)).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
  });

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
