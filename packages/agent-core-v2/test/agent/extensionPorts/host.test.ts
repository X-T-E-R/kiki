import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestAgent, permissionModeServices, type TestAgentContext } from '../../harness';
import { IPluginExtensionPortRegistryReader } from '#/app/pluginExtensionPorts/pluginExtensionPortRegistry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IModelCatalog } from '#/kosong/model/catalog';
import { APIStatusError } from '#/kosong/contract/errors';
import type { LoopFailureSnapshot } from '#/app/plugin/extensionSlots';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';
import type { PreBaselineRequestPatch, LLMStreamTapObserver } from '#/kosong/contract/extensionHooks';

let ctx: TestAgentContext;
afterEach(async () => { vi.restoreAllMocks(); await ctx?.dispose(); });

function agent(): IPluginExtensionPortRegistryReader {
  ctx = createTestAgent(permissionModeServices('yolo'), { initialConfig: { retry: { maxAttempts: 1 }, loopControl: { maxAttemptsPerStep: 1 } } });
  ctx.get(IAgentProfileService).update({ activeToolNames: [] });
  return ctx.get(IPluginExtensionPortRegistryReader);
}

function run() {
  const loop = ctx.get(IAgentLoopService);
  loop.enqueue(new MessageStepRequest({ role: 'user', content: [{ type: 'text', text: 'work' }], toolCalls: [], origin: { kind: 'user' } }));
  return loop.run({ turnId: 1 });
}

async function argon(ports: IPluginExtensionPortRegistryReader) {
  ctx.configure({ provider: { type: 'anthropic', model: 'axon-message/gemini-4-argon', apiKey: 'test-key' } });
  const modulePath = '../../fixtures/plugins/argon-error-recovery/lib/native.mjs';
  const plugin = await import(modulePath);
  return plugin.registerArgonExtensionPorts(ports);
}

describe('Extension ports on the native host', () => {
  it('forwards E2 patches and E3 taps before the transport and observes the normalized settled response', async () => {
    const ports = agent();
    const modelCatalog = ctx.get(IModelCatalog);
    const getRequester = modelCatalog.getRequester.bind(modelCatalog);
    const captured: Array<ModelRequestParams & { preBaselinePatch?: PreBaselineRequestPatch; streamTaps?: readonly LLMStreamTapObserver[] }> = [];
    vi.spyOn(modelCatalog, 'getRequester').mockImplementation((...args) => {
      const requester = getRequester(...args);
      return { ...requester, model: requester.model, request: (input, signal, params) => {
        captured.push(params);
        return requester.request(input, signal, params);
      } };
    });
    ports.registerPromptSection({ pluginId: 'test', sectionId: 'late', order: 2, render: () => 'Late section' });
    ports.registerPromptSection({ pluginId: 'test', sectionId: 'early', order: 1, render: () => 'Early section' });
    ports.registerRequestPolicy('test', snapshot => {
      expect(Object.isFrozen(snapshot.messages)).toBe(true);
      expect(snapshot.systemPrompt).toContain('Early section\n\nLate section');
      return { sampling: { temperature: 0.3 }, forceFullResponsesInput: true };
    });
    ports.registerStreamTap('test', () => undefined);
    const observed = vi.fn();
    ports.registerSettledResponseObserver('test', observed);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    expect((await run()).type).toBe('completed');
    expect(captured[0]?.preBaselinePatch).toMatchObject({ sampling: { temperature: 0.3 }, forceFullResponsesInput: true });
    expect(captured[0]?.streamTaps).toHaveLength(1);
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ message: { content: [{ type: 'text', text: 'done' }] } });
  });

  it('reconciles E5 reminders at step heads and withdraws their provider with the registration', async () => {
    const ports = agent();
    const collect = vi.fn(() => 'Current extension state');
    const registration = ports.registerStepContextReminder({ pluginId: 'test', reminderKey: 'current_state', collect });
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    expect((await run()).type).toBe('completed');
    expect(collect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turnId: 1, step: 1, isNewTurn: false }));
    expect(JSON.stringify(ctx.llmCalls[0]?.history)).toContain('Current extension state');
    expect(ctx.get(IAgentContextMemoryService).get().filter(message => message.origin?.kind === 'user')).toHaveLength(1);
    await registration.dispose();
    ctx.mockNextResponse({ type: 'text', text: 'done again' });
    expect((await run()).type).toBe('completed');
    expect(collect).toHaveBeenCalledOnce();
  });

  it('runs native Argon recovery through a safe injection without adding an undo anchor', async () => {
    const ports = agent();
    await argon(ports);
    const snapshots: LoopFailureSnapshot[] = [];
    ports.registerRecoveryPolicy('observe', snapshot => { snapshots.push(snapshot); return { action: 'pass' }; });
    ctx.mockNextProviderResponse({ error: new APIStatusError(400, 'fixture request rejected') });
    ctx.mockNextResponse({ type: 'text', text: 'recovered' });
    expect((await run()).type).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
    const history = ctx.get(IAgentContextMemoryService).get();
    expect(history.filter(message => message.origin?.kind === 'user')).toHaveLength(1);
    expect(history.find(message => message.origin?.kind === 'injection' && message.origin.variant === 'argon_error_recovery')).toBeDefined();
    expect(snapshots).toEqual([]);
  });

  it('brakes a persistent native Argon failure at the shared recovery budget', async () => {
    const ports = agent();
    await argon(ports);
    for (let index = 0; index < 3; index++) ctx.mockNextProviderResponse({ error: new APIStatusError(400, 'fixture persistent failure') });
    expect((await run()).type).toBe('failed');
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('rejects same-step replay after a sent request', async () => {
    const ports = agent();
    const phases: string[] = [];
    ports.registerRecoveryPolicy('test', snapshot => {
      phases.push(snapshot.deliveryPhase);
      return { action: 'retry_same_step', delayMs: 0 };
    });
    ctx.mockNextProviderResponse({ error: new APIStatusError(400, 'fixture rejected') });
    expect((await run()).type).toBe('failed');
    expect(phases).toEqual(['sent_outcome_unknown']);
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('bounds E7 prevent-stop continuations using the same host budget', async () => {
    const ports = agent();
    const streaks: number[] = [];
    ports.registerPostStepPolicy('test', snapshot => {
      streaks.push(snapshot.continuationStreakCount);
      return { action: 'prevent_stop_and_continue', reminderText: 'Inspect the remaining work.', variant: 'extension_test' };
    });
    for (let index = 0; index < 3; index++) ctx.mockNextResponse({ type: 'text', text: 'answer' });
    expect((await run()).type).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(3);
    expect(streaks).toEqual([0, 1, 2]);
  });

  it('applies E6 guidance and retains a file index through the host compaction transaction', async () => {
    const ports = agent();
    await ctx.ready;
    ctx.appendExchange(1, 'Read the file and continue.', 'Read src/main.ts.', 20);
    ctx.appendExchange(2, 'Keep the current objective.', 'Ready.', 80);
    const guidance = vi.fn(async () => ({ additionalInstructions: 'Include the open verification step.',
      preservedFileIndexMarkdown: '## Historical file index\n- src/main.ts' }));
    ports.registerCompactionPolicy({ pluginId: 'test', buildSummaryGuidance: guidance });
    ctx.mockNextResponse({ type: 'text', text: 'The next step is verification.' });
    const compaction = ctx.get(IAgentFullCompactionService);
    expect(compaction.begin({ source: 'manual', strategy: 'summarize' })).toBe(true);
    const result = await compaction.compacting!.promise;
    expect(guidance).toHaveBeenCalledOnce();
    expect(JSON.stringify(ctx.llmCalls[0]?.history)).toContain('Include the open verification step.');
    expect(result.summary).toContain('## Historical file index\n- src/main.ts');
    expect(ctx.get(IAgentContextMemoryService).get().some(message => message.origin?.kind === 'compaction_summary'
      && JSON.stringify(message.content).includes('Historical file index'))).toBe(true);
  });

  it('intersects E9 model advice with profile and caller lease constraints before child creation', async () => {
    const ports = agent();
    const own = ctx.get(IAgentProfileService).data();
    const model = own.modelAlias!;
    ports.registerSubagentDispatchAdvisor('test', snapshot => {
      expect(snapshot.allowedModels).toEqual([model]);
      return { recommendedModelAlias: 'outside/forbidden' };
    });
    const lifecycle = ctx.get(IAgentLifecycleService);
    vi.spyOn(lifecycle, 'get').mockImplementation(id => id === 'main'
      ? { id, kind: 'agent', accessor: { get: ctx.get.bind(ctx) }, dispose: () => {} }
      : undefined);
    const stopAtCreate = new Error('test lifecycle boundary');
    const create = vi.spyOn(lifecycle, 'create').mockRejectedValue(stopAtCreate);
    const runtime = ctx.get(IAgentRuntimeService).acquire(['process']);
    try {
      await expect(ctx.get(ISessionDispatchService).launch({
        requesterAgentId: 'main', delegator: { kind: 'agent', agentId: 'main' },
        requesterProfileData: { ...own, profileName: 'extension-parent', subagentLeases: { 'extension-child': { name: 'extension-child', allowedModels: [model] } } },
        resolvedProfile: normalizeAgentProfile({ name: 'extension-child', description: 'test child', modelAlias: model,
          allowedModels: [model, 'outside/forbidden'], systemPrompt: () => 'Child system prompt' }),
        message: 'run', runtime: runtime.runtime, workDir: '/workspace', signal: new AbortController().signal,
      })).rejects.toBe(stopAtCreate);
      expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding: expect.objectContaining({ model }) }));
    } finally { runtime.dispose(); }
  });

  it('settles the original save after persistence failure without invoking recovery or another request', async () => {
    const ports = agent();
    const recover = vi.fn(() => ({ action: 'enqueue_recovery_continuation' as const, reminderText: 'continue', variant: 'test' }));
    ports.registerRecoveryPolicy('test', recover);
    const loop = ctx.get(IAgentLoopService);
    const originalFlush = ctx.wire.flush.bind(ctx.wire);
    let failSave = true;
    ctx.wire.flush = async () => { if (failSave && loop.status().finalizing) throw new Error('fixture save failed'); await originalFlush(); };
    ctx.mockNextResponse({ type: 'text', text: 'computed once' });
    const handle = await ctx.get(IAgentPromptService).enqueue({ message: {
      role: 'user', content: [{ type: 'text', text: 'compute' }], toolCalls: [], origin: { kind: 'user' },
    } });
    const turn = await handle.launched;
    await expect(turn!.result).rejects.toMatchObject({ details: { persistenceOutcome: 'failed' } });
    failSave = false;
    expect(await loop.recoverPersistence()).toBe(true);
    await handle.completion;
    expect(ctx.llmCalls).toHaveLength(1);
    expect(recover).not.toHaveBeenCalled();
    ctx.wire.flush = originalFlush;
  });
});
