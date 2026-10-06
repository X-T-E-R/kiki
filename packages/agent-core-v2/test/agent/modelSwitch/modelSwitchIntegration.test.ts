import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ConfigUpdate, profileKey } from '#/agent/profile/profileOps';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { AgentModelSwitchService } from '#/agent/modelSwitch/modelSwitchService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService } from '#/agent/prompt/promptService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentLoopService, TurnPersistenceError } from '#/agent/loop/loop';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { Error2, ErrorCodes } from '#/errors';
import { createTestAgent, agentServices, homeDirServices, sessionServices, type TestAgentContext } from '../../harness';

const OLD = 'mock-model';
const NEW = 'new-model';
const hosts: TestAgentContext[] = [];
const homes: string[] = [];

async function createHost() {
  const home = await mkdtemp(join(tmpdir(), 'model-switch-integration-'));
  homes.push(home);
  await mkdir(join(home, 'cognition'));
  await writeFile(join(home, 'cognition/old.md'), 'OLD COGNITION');
  await writeFile(join(home, 'cognition/new.md'), 'NEW COGNITION');
  const notes = { directives: ' KEEP_OLD_RULE ' };
  const meta = { rev: 4, hash: 'original', writtenTurn: 1, writtenStep: 't1.1', reviewedMessageId: 'human-source', coveredMessageId: '', windowEpoch: 0 };
  const setNotes = vi.fn();
  const ctx = createTestAgent(homeDirServices(home), sessionServices((reg) => {
    reg.definePartialInstance(ISessionTodoService, { getTodos: () => [], getNotes: () => ({ notes, meta }), setNotes });
  }), agentServices((reg) => {
    reg.define(IAgentModelSwitchService, AgentModelSwitchService);
    reg.define(IAgentPromptService, AgentPromptService);
  }));
  hosts.push(ctx);
  await ctx.ready;
  const original = ctx.kimiConfig.models?.[OLD];
  expect(original).toBeDefined();
  ctx.kimiConfig = { ...ctx.kimiConfig, models: {
    ...ctx.kimiConfig.models,
    [OLD]: { ...original!, cognition: { overlay: 'cognition/old.md' }, promptOverrides: { fields: { 'system.shared': 'OLD SHARED FIELD' } } },
    [NEW]: { provider: 'test-provider', model: NEW, maxContextSize: 1_000_000, defaultEffort: 'off',
      cognition: { overlay: 'cognition/new.md' }, promptOverrides: { fields: { 'system.shared': 'NEW SHARED FIELD' } } },
  } };
  const metadata = ctx.get(ISessionMetadata);
  await metadata.registerAgent('main', { type: 'main', labels: { preserved: 'label' } });
  const profile = ctx.get(IAgentProfileService);
  await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: OLD, thinking: 'off',
    personaSnapshot: { revision: 'persona-r1', definition: { id: 'integration-persona', name: 'Integration persona', description: 'KEEP PERSONA INSTRUCTIONS' } } });
  await ctx.get(IEventDispatcher).dispatch(new ConfigUpdate({ personaOverrides: { thinking: 'off' } }));
  return { ctx, profile, metadata, notes, meta, setNotes, home };
}

async function journal(ctx: TestAgentContext): Promise<WireRecord[]> {
  const records: WireRecord[] = [];
  for await (const record of ctx.get(IWireService).readJournal()) records.push(record);
  return records;
}

function text(ctx: TestAgentContext): string {
  return ctx.get(IAgentContextMemoryService).get().flatMap((message) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('\n');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((ctx) => ctx.dispose()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })));
});

describe('model switch integration with current prompt projections', () => {
  it.each(['model-switch', 'resume'] as const)('prepares %s without runtime mutation and commits all projections with persona intact', async (path) => {
    const { ctx, profile } = await createHost();
    const before = { data: profile.data(), cognition: profile.getCognitionSnapshot(), fields: profile.getPromptFieldSnapshot(), prompt: profile.getSystemPrompt(), diagnostics: await profile.getPromptDiagnostics() };
    const binding = path === 'resume'
      ? await profile.prepareResumeBinding({ modelAlias: NEW, allowModelChange: true })
      : await profile.prepareModelSwitchBinding(NEW);
    expect(profile.data()).toEqual(before.data);
    expect(profile.getCognitionSnapshot()).toBe(before.cognition);
    expect(profile.getPromptFieldSnapshot()).toBe(before.fields);
    expect(profile.getSystemPrompt()).toBe(before.prompt);
    expect((await profile.getPromptDiagnostics()).binding_revision).toBe(before.diagnostics.binding_revision);
    const engine = ctx.get(IAgentModelSwitchService);
    const receipt = await engine.execute({ operationId: `projection-${path}`, model: NEW, thinking: binding.thinking, mode: 'direct' }, { binding });
    expect(receipt.state).toBe('completed');
    const after = profile.data();
    const diagnostics = await profile.getPromptDiagnostics();
    expect(after).toMatchObject({ modelAlias: NEW, personaId: 'integration-persona', personaRevision: 'persona-r1' });
    expect(ctx.get(IAgentStateService).get(profileKey).personaOverrides).toEqual(path === 'model-switch'
      ? { model: NEW, thinking: 'off' }
      : { thinking: 'off' });
    expect(after.persona).toEqual(before.data.persona);
    expect(profile.getSystemPrompt()).toContain('KEEP PERSONA INSTRUCTIONS');
    expect(profile.getSystemPrompt()).toContain('NEW COGNITION');
    expect(profile.getSystemPrompt()).toContain('NEW SHARED FIELD');
    expect(profile.getSystemPrompt()).not.toContain('OLD SHARED FIELD');
    expect(profile.getPromptFieldSnapshot().values['system.shared']).toBe('NEW SHARED FIELD');
    expect(after.boundProfile?.promptBase?.promptDiagnostics?.binding_revision).toBe(diagnostics.binding_revision);
    expect(profile.getCognitionSnapshot()).toMatchObject({ modelAlias: NEW, revision: before.cognition!.revision + 1, bindingRevision: diagnostics.binding_revision });
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it.each([false, true])('checks the prepared persona override source when recovering metadata (later edit: %s)', async (laterEdit) => {
    const { ctx, profile, metadata } = await createHost();
    const binding = await profile.prepareModelSwitchBinding(NEW);
    expect(binding.config.personaOverrides).toMatchObject({ model: NEW, thinking: 'off' });
    const before = ctx.get(IAgentStateService).get(profileKey).personaOverrides;
    expect(before).toEqual({ thinking: 'off' });
    const update = metadata.updateAgent.bind(metadata);
    vi.spyOn(metadata, 'updateAgent').mockRejectedValueOnce(new Error('metadata unavailable')).mockImplementation(update);
    const engine = ctx.get(IAgentModelSwitchService);
    const input = { operationId: `persona-source-${laterEdit}`, model: NEW, mode: 'direct' as const };
    expect(await engine.execute(input, { binding })).toMatchObject({ state: 'preparing' });
    expect(ctx.get(IAgentStateService).get(profileKey).personaOverrides).toEqual(binding.config.personaOverrides);
    if (laterEdit) {
      await ctx.get(IEventDispatcher).dispatch(new ConfigUpdate({ personaOverrides: { model: OLD, thinking: 'off' } }));
      expect(await engine.execute(input)).toMatchObject({ state: 'preparing', error: { code: ErrorCodes.REQUEST_INVALID } });
      expect(ctx.get(IAgentStateService).get(profileKey).personaOverrides).toEqual({ model: OLD, thinking: 'off' });
    } else {
      expect(await engine.execute(input)).toMatchObject({ state: 'completed' });
      expect(ctx.get(IAgentStateService).get(profileKey).personaOverrides).toEqual(binding.config.personaOverrides);
    }
    expect((await journal(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('preserves committed prepared caches across metadata failure and finishes the same operation only once', async () => {
    const { ctx, profile, metadata } = await createHost();
    const binding = await profile.prepareModelSwitchBinding(NEW);
    const realUpdate = metadata.updateAgent.bind(metadata);
    vi.spyOn(metadata, 'updateAgent').mockRejectedValueOnce(new Error2(ErrorCodes.STORAGE_IO_FAILED, 'metadata unavailable')).mockImplementation(realUpdate);
    const engine = ctx.get(IAgentModelSwitchService);
    const input = { operationId: 'projection-metadata-gap', model: NEW, mode: 'direct' as const };
    expect(await engine.execute(input, { binding })).toMatchObject({ state: 'preparing' });
    const cognition = profile.getCognitionSnapshot();
    const fields = profile.getPromptFieldSnapshot();
    const diagnostics = await profile.getPromptDiagnostics();
    expect(profile.getSystemPrompt()).toContain('NEW SHARED FIELD');
    expect(await engine.execute(input)).toMatchObject({ state: 'completed' });
    expect(profile.getCognitionSnapshot()).toBe(cognition);
    expect(profile.getPromptFieldSnapshot()).toBe(fields);
    expect((await profile.getPromptDiagnostics()).binding_revision).toBe(diagnostics.binding_revision);
    expect((await metadata.read()).agents?.['main']).toMatchObject({ model: NEW, labels: { preserved: 'label' } });
    expect((await journal(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(0);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('rebuilds derived prompt projections from the canonical binding on cold recovery without another commit', async () => {
    const { ctx } = await createHost();
    const input = { operationId: 'cold-projections', model: NEW, mode: 'fresh' as const };
    expect(await ctx.get(IAgentModelSwitchService).execute(input)).toMatchObject({ state: 'completed' });
    const records = await journal(ctx);
    const restored = await createHost();
    await restored.ctx.restore(records);
    const engine = restored.ctx.get(IAgentModelSwitchService);
    const summary = vi.spyOn(restored.ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary');
    expect(engine.get(input.operationId)).toMatchObject({ state: 'preparing' });
    const update = restored.metadata.updateAgent.bind(restored.metadata);
    vi.spyOn(restored.metadata, 'updateAgent').mockRejectedValueOnce(new Error('cold metadata unavailable')).mockImplementation(update);
    expect(await engine.execute(input)).toMatchObject({ state: 'preparing' });
    const cognition = restored.profile.getCognitionSnapshot();
    const fields = restored.profile.getPromptFieldSnapshot();
    expect(await engine.execute(input)).toMatchObject({ state: 'completed' });
    expect(restored.profile.getCognitionSnapshot()).toBe(cognition);
    expect(restored.profile.getPromptFieldSnapshot()).toBe(fields);
    expect(restored.profile.getModel()).toBe(NEW);
    expect(restored.profile.getSystemPrompt()).toContain('NEW COGNITION');
    expect(restored.profile.getSystemPrompt()).toContain('NEW SHARED FIELD');
    expect(restored.profile.getSystemPrompt()).not.toContain('OLD SHARED FIELD');
    expect(restored.profile.getPromptFieldSnapshot().values['system.shared']).toBe('NEW SHARED FIELD');
    const diagnostics = await restored.profile.getPromptDiagnostics();
    expect(restored.profile.getCognitionSnapshot()).toMatchObject({ modelAlias: NEW, bindingRevision: diagnostics.binding_revision });
    expect(restored.profile.data().boundProfile?.promptBase?.promptDiagnostics?.binding_revision).toBe(diagnostics.binding_revision);
    expect(restored.ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect((await journal(restored.ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(summary).not.toHaveBeenCalled();
    expect(restored.ctx.llmCalls).toHaveLength(0);
  });

  it('does not publish cold projections from files that differ from the committed prompt', async () => {
    const { ctx } = await createHost();
    const input = { operationId: 'cold-input-drift', model: NEW, mode: 'direct' as const };
    expect(await ctx.get(IAgentModelSwitchService).execute(input)).toMatchObject({ state: 'completed' });
    const restored = await createHost();
    await restored.ctx.restore(await journal(ctx));
    const cognition = restored.profile.getCognitionSnapshot();
    const fields = restored.profile.getPromptFieldSnapshot();
    await writeFile(join(restored.home, 'cognition/new.md'), 'UNCOMMITTED DISK COGNITION');
    const engine = restored.ctx.get(IAgentModelSwitchService);
    expect(await engine.execute(input)).toMatchObject({ state: 'preparing', error: { code: ErrorCodes.CONFIG_INVALID } });
    expect(restored.profile.getCognitionSnapshot()).toBe(cognition);
    expect(restored.profile.getPromptFieldSnapshot()).toBe(fields);
    await writeFile(join(restored.home, 'cognition/new.md'), 'NEW COGNITION');
    expect(await engine.execute(input)).toMatchObject({ state: 'completed' });
    expect(restored.profile.getSystemPrompt()).toContain('NEW SHARED FIELD');
    expect(restored.profile.getSystemPrompt()).not.toContain('UNCOMMITTED DISK COGNITION');
    expect((await journal(restored.ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(restored.ctx.llmCalls).toHaveLength(0);
  });

  it('keeps runtime unchanged when target prompt fields fail after candidate cognition loading', async () => {
    const { ctx, profile } = await createHost();
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models,
      [NEW]: { ...ctx.kimiConfig.models![NEW]!, promptOverrides: { files: ['missing-candidate-fields.toml'] } },
    } };
    const cognition = profile.getCognitionSnapshot();
    const fields = profile.getPromptFieldSnapshot();
    const prompt = profile.getSystemPrompt();
    await expect(profile.prepareModelSwitchBinding(NEW)).rejects.toThrow(/could not be resolved/);
    expect(profile.getModel()).toBe(OLD);
    expect(profile.getCognitionSnapshot()).toBe(cognition);
    expect(profile.getPromptFieldSnapshot()).toBe(fields);
    expect(profile.getSystemPrompt()).toBe(prompt);
  });

  it('does not apply a stale prepared cache over a later binding during recovery', async () => {
    const { ctx, profile, metadata } = await createHost();
    const binding = await profile.prepareModelSwitchBinding(NEW);
    const realUpdate = metadata.updateAgent.bind(metadata);
    vi.spyOn(metadata, 'updateAgent').mockRejectedValueOnce(new Error('metadata unavailable')).mockImplementation(realUpdate);
    const input = { operationId: 'stale-cache', model: NEW, mode: 'direct' as const };
    const engine = ctx.get(IAgentModelSwitchService);
    expect(await engine.execute(input, { binding })).toMatchObject({ state: 'preparing' });
    profile.update({ systemPrompt: 'LATER BINDING PROMPT' });
    expect(await engine.execute(input)).toMatchObject({ state: 'preparing', error: { code: ErrorCodes.REQUEST_INVALID } });
    expect(profile.getSystemPrompt()).toContain('LATER BINDING PROMPT');
    expect((await journal(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
  });

  it('uses existing pending-directive review post-processing for switch summaries without writing notes', async () => {
    const { ctx, notes, meta, setNotes } = await createHost();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    const candidate = `${'N'.repeat(1500)}\n KEEP_OLD_RULE `;
    ctx.mockNextResponse({ type: 'text', text: `Continue task.\n\n## Standing directives\n${candidate}` });
    expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: 'pending-review', model: NEW, mode: 'compact' })).toMatchObject({ state: 'completed', summaryGenerated: true });
    expect(text(ctx)).toContain('## Pending directive review');
    expect(text(ctx)).toContain(candidate.trim());
    expect(text(ctx)).toContain('Automatic promotion skipped: budget');
    expect(text(ctx)).toContain('notes revision 4 is unchanged');
    expect(setNotes).not.toHaveBeenCalled();
    expect(notes.directives).toBe(' KEEP_OLD_RULE ');
    expect(meta).toMatchObject({ rev: 4, writtenStep: 't1.1', reviewedMessageId: 'human-source' });
  });

  it('settles one outcome only after a real turn persistence failure is recovered', async () => {
    const { ctx } = await createHost();
    const dispatcher = ctx.get(IEventDispatcher);
    const dispatchDurably = dispatcher.dispatchDurably.bind(dispatcher);
    let failed = false;
    vi.spyOn(dispatcher, 'dispatchDurably').mockImplementation(async (...args) => {
      if (args[0].type === 'turn.ended' && !failed) {
        failed = true;
        throw new Error2(ErrorCodes.STORAGE_IO_FAILED, 'turn settlement unavailable');
      }
      return dispatchDurably(...args);
    });
    ctx.mockNextResponse({ type: 'text', text: 'Completed exactly once.' });
    const prompts = ctx.get(IAgentPromptService);
    const input = { id: 'durable-outcome', message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Finish exactly once.' }], toolCalls: [] } };
    const handle = await prompts.enqueue(input);
    const turn = (await handle.launched)!;
    await expect(turn.result).rejects.toBeInstanceOf(TurnPersistenceError);
    expect(prompts.lookup(input.id)?.phase).toBe('launched');
    expect((await journal(ctx)).filter((record) => record.type === 'prompt.outcome_committed')).toHaveLength(0);
    expect(await ctx.get(IAgentLoopService).recoverPersistence()).toBe(true);
    expect((await handle.completion).state).toBe('completed');
    await dispatcher.flush();
    await vi.waitFor(() => expect(prompts.lookup(input.id)?.phase).toBe('terminal'));
    expect(await prompts.enqueue(input)).toBe(handle);
    expect((await journal(ctx)).filter((record) => record.type === 'prompt.outcome_committed' && record['terminal'] !== undefined)).toHaveLength(1);
    expect(ctx.llmCalls).toHaveLength(1);
  });
});

describe('failed switch mode recovery', () => {
  it.each(['direct', 'fresh'] as const)('serializes competing %s recovery before the first queue update settles', async (mode) => {
    const { ctx } = await createHost();
    const service = ctx.get(IAgentPromptService);
    vi.spyOn(ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary').mockRejectedValue(new Error('old model offline'));
    const operationId = 'concurrent-mode';
    expect(await service.switchModel({ operationId, model: NEW, mode: 'compact' })).toMatchObject({ state: 'failed' });
    const dispatcher = ctx.get(IEventDispatcher);
    const dispatch = dispatcher.dispatch.bind(dispatcher);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrival = new Promise<void>((resolve) => { entered = resolve; });
    let gated = false;
    vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (...args) => {
      if (args[0].type === 'prompt.model_switch_queued' && !gated) {
        gated = true;
        entered();
        await gate;
      }
      return dispatch(...args);
    });
    const first = service.recoverModelSwitch(operationId, 'retry', 'fresh');
    await arrival;
    const competing = service.recoverModelSwitch(operationId, 'retry', mode).then(
      (receipt) => ({ receipt }),
      (error: unknown) => ({ error }),
    );
    release();
    expect(await first).toMatchObject({ mode: 'fresh', state: 'completed' });
    expect(await competing).toMatchObject(mode === 'fresh'
      ? { receipt: { mode: 'fresh', state: 'completed' } }
      : { error: { code: ErrorCodes.REQUEST_INVALID } });
    expect(service.listModelSwitches()).toMatchObject([{ input: { operationId, mode: 'fresh' }, revision: 1 }]);
    expect((await journal(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
  });

  it('recovers failed compact as fresh under the original operation and dependent prompt identities', async () => {
    const { ctx, profile } = await createHost();
    const service = ctx.get(IAgentPromptService);
    const summary = vi.spyOn(ctx.get(IAgentFullCompactionService), 'prepareModelSwitchSummary').mockRejectedValue(new Error('old model offline'));
    const operationId = 'compact-to-fresh';
    expect(await service.switchModel({ operationId, model: NEW, mode: 'compact' })).toMatchObject({ state: 'failed' });
    const dependent = await service.enqueue({ id: 'original-dependent', message: { role: 'user', content: [{ type: 'text', text: 'Continue the original task.' }], toolCalls: [] }, execution: { afterModelSwitch: operationId } });
    expect(dependent.state).toBe('pending');
    ctx.mockNextResponse({ type: 'text', text: 'Original task continued once.' });
    expect(await service.recoverModelSwitch(operationId, 'retry', 'fresh')).toMatchObject({ operationId, state: 'completed', mode: 'fresh' });
    expect((await dependent.completion).state).toBe('completed');
    expect(await service.recoverModelSwitch(operationId, 'retry', 'fresh')).toMatchObject({ operationId, state: 'completed', mode: 'fresh' });
    await expect(service.recoverModelSwitch(operationId, 'retry', 'direct')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    await expect(service.recoverModelSwitch(operationId, 'keep_original', 'fresh')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    expect(summary).toHaveBeenCalledTimes(1);
    expect(profile.getModel()).toBe(NEW);
    expect(dependent.userMessageId).toBe('original-dependent');
    expect(dependent.revision).toBe(0);
    expect(dependent.execution?.afterModelSwitch).toBe(operationId);
    expect(service.listModelSwitches()).toMatchObject([{ input: { operationId, mode: 'fresh' }, revision: 1 }]);
    const records = await journal(ctx);
    expect(records.filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(records.filter((record) => record.type === 'prompt.launch_committed' && record['promptId'] === dependent.id)).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('rejects changing pending modes and mode arguments on cancelled recovery', async () => {
    const { ctx } = await createHost();
    const service = ctx.get(IAgentPromptService);
    const lease = ctx.get(IAgentLoopService).tryAcquireQuiescence();
    expect(lease).toBeDefined();
    try {
      expect(await service.switchModel({ operationId: 'unaccepted-mode', model: NEW, mode: 'compact' })).toMatchObject({ state: 'pending' });
      await expect(service.recoverModelSwitch('unaccepted-mode', 'retry', 'fresh')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      expect(await service.cancelModelSwitch('unaccepted-mode')).toMatchObject({ state: 'cancelled' });
      await expect(service.recoverModelSwitch('unaccepted-mode', 'retry', 'compact')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      await expect(service.recoverModelSwitch('unaccepted-mode', 'keep_original', 'compact')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      expect(await service.recoverModelSwitch('unaccepted-mode', 'keep_original')).toMatchObject({ state: 'cancelled', mode: 'compact' });
      expect((await journal(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(0);
      expect(ctx.llmCalls).toHaveLength(0);
    } finally {
      lease?.dispose();
    }
  });

  it('does not change a canonical preparing operation and accepts retry with its already-selected mode', async () => {
    const { ctx, metadata } = await createHost();
    const service = ctx.get(IAgentPromptService);
    const update = metadata.updateAgent.bind(metadata);
    vi.spyOn(metadata, 'updateAgent').mockRejectedValueOnce(new Error('metadata unavailable')).mockImplementation(update);
    expect(await service.switchModel({ operationId: 'canonical-mode', model: NEW, mode: 'fresh' })).toMatchObject({ state: 'preparing' });
    await expect(service.recoverModelSwitch('canonical-mode', 'retry', 'compact')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    expect(await service.recoverModelSwitch('canonical-mode', 'retry', 'fresh')).toMatchObject({ state: 'completed', mode: 'fresh' });
    expect((await journal(ctx)).filter((record) => record.type === 'agent.model_switch')).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
    expect(ctx.llmCalls).toHaveLength(0);
  });
});
