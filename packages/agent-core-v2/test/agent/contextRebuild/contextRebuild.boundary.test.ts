import { afterEach, describe, expect, it, vi } from 'vitest';
import { Event } from '#/_base/event';
import { resolvedRecipeSchema } from '@kiki/protocol';
import { IRecipeService } from '#/app/recipes/recipes';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextRebuildService } from '#/agent/contextRebuild/contextRebuild';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { DEFAULT_AGENT_PROFILE_NAME, normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IWireService } from '#/wire/wire';
import { appServices, InMemoryWireRecordPersistence, sessionServices, testAgent, type TestAgentContext } from '../../harness';

const PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example/v1',
  model: 'kimi-code',
} as const;
const CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

const agents: TestAgentContext[] = [];

describe('context rebuild at the committed compaction boundary', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  });

  it('re-reads sources after a committed compaction and keeps explicit settings', async () => {
    const reload = vi.fn(async () => ({ instructionsChanged: true, pluginsChanged: false }));
    const ctx = openAgent(reload);
    const profile = ctx.get(IAgentProfileService);
    const before = profile.data();
    const mode = ctx.get(IAgentPermissionModeService).mode;
    const todo = ctx.get(ISessionTodoService);
    todo.setTodos([{ title: 'Keep the task', status: 'pending' }]);
    const todos = todo.getTodos('main');
    const history = ctx.compactHistory();
    expect(ctx.get(IAgentContextRebuildService).control().enabled).toBe(true);

    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    await expect(service.compacting!.promise).resolves.toMatchObject({ strategy: 'relay' });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(ctx.compactHistory()).not.toEqual(history);
    expect(ctx.get(IAgentContextRebuildService).control().error).toBeUndefined();
    expect(ctx.get(IAgentContextRebuildService).control()).toMatchObject({
      enabled: true,
      outcome: 'applied',
      trigger: 'fresh_start',
      rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'mcp', 'injections'],
    });
    expect(ctx.llmCalls).toHaveLength(0);
    expect(profile.data().modelAlias).toBe(before.modelAlias);
    expect(profile.data().thinkingLevel).toBe(before.thinkingLevel);
    expect(profile.data().toolOverride).toEqual(before.toolOverride);
    expect(profile.data().disallowedTools).toEqual(before.disallowedTools);
    expect(ctx.get(IAgentPermissionModeService).mode).toBe(mode);
    expect(todo.getTodos('main')).toEqual(todos);
    const wire = await ctx.persistedWireRecords();
    expect(wire.some((record) => record.type === 'context_rebuild.preference')).toBe(false);
  }, 30_000);

  it('keeps the committed compaction when the refresh fails once', async () => {
    const reload = vi.fn(async () => { throw new Error('sources unavailable'); });
    const ctx = openAgent(reload);
    await ctx.get(IAgentContextRebuildService).setEnabled(true);
    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    const compacted = service.compacting!.promise.then((result) => {
      expect(ctx.compactHistory().length).toBeGreaterThan(0);
      return result;
    });
    await expect(compacted).resolves.toMatchObject({ strategy: 'relay' });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ctx.get(IAgentContextRebuildService).control()).toMatchObject({
      enabled: true,
      outcome: 'failed',
      trigger: 'fresh_start',
      error: 'sources unavailable',
      rebuilt: [],
    });
    expect(service.isCompacting()).toBe(false);
  }, 30_000);

  it('does not rebuild when compaction is cancelled before it commits', async () => {
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const ctx = openAgent(reload);
    await ctx.get(IAgentContextRebuildService).setEnabled(true);
    const history = ctx.compactHistory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const service = ctx.get(IAgentFullCompactionService);
    const hook = service.hooks.onWillCompact.register('rebuild-cancel', async (_task, next) => {
      started();
      await gate;
      await next();
    });
    try {
      expect(service.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
      const task = service.compacting!;
      await startedPromise;
      service.cancel();
      release();
      await expect(task.promise).rejects.toThrow();
      expect(reload).not.toHaveBeenCalled();
      expect(ctx.compactHistory()).toEqual(history);
      expect(ctx.get(IAgentContextRebuildService).control().outcome).toBeUndefined();
    } finally {
      await hook.dispose();
    }
  }, 30_000);

  it('does not rebuild when compaction fails before commit', async () => {
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const ctx = openAgent(reload);
    await ctx.get(IAgentContextRebuildService).setEnabled(true);
    const history = ctx.compactHistory();
    const service = ctx.get(IAgentFullCompactionService);
    const hook = service.hooks.onWillCompact.register('rebuild-fail', async () => {
      throw new Error('compact failed');
    });
    try {
      expect(service.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
      await expect(service.compacting!.promise).rejects.toThrow('compact failed');
      expect(reload).not.toHaveBeenCalled();
      expect(ctx.compactHistory()).toEqual(history);
      expect(ctx.get(IAgentContextRebuildService).control().outcome).toBeUndefined();
    } finally {
      await hook.dispose();
    }
  }, 30_000);

  it('re-reads after an idle context clear and ignores strategy reset, undo, and another message', async () => {
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const ctx = openAgent(reload);
    const profile = ctx.get(IAgentProfileService);
    const memory = ctx.get(IAgentContextMemoryService);
    const model = profile.getModel();
    const thinking = profile.data().thinkingLevel;
    await ctx.get(IAgentContextRebuildService).setEnabled(false);
    await memory.clear();
    await ctx.get(IAgentContextRebuildService).setEnabled(true);
    await memory.clear();
    ctx.get(IAgentFullCompactionService).setContextStrategyOverride('fresh');
    ctx.get(IAgentFullCompactionService).setContextStrategyOverride(null);
    memory.append({
      role: 'user', content: [{ type: 'text', text: 'ordinary next message' }], toolCalls: [], id: 'ordinary',
    });
    memory.append({
      role: 'user', content: [{ type: 'text', text: 'still not a restart' }], toolCalls: [], id: 'ordinary-2',
    });
    memory.undo(1);
    expect(reload).not.toHaveBeenCalled();
    await memory.clear();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ctx.get(IAgentContextRebuildService).control()).toMatchObject({ trigger: 'context_clear', outcome: 'applied' });
    expect(profile.getModel()).toBe(model);
    expect(profile.data().thinkingLevel).toBe(thinking);
  }, 30_000);

  it('matches the next request to a partial report after the profile commits and MCP refresh fails', async () => {
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const ctx = openAgent(reload);
    const profile = ctx.get(IAgentProfileService);
    profile.update({ thinkingLevel: 'low', disallowedTools: ['Bash'], systemPrompt: 'before rebuild' });
    const mode = ctx.get(IAgentPermissionModeService).mode;
    const model = profile.getModel();
    await ctx.get(IAgentContextRebuildService).setEnabled(false);
    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    await expect(service.compacting!.promise).resolves.toMatchObject({ strategy: 'relay' });
    const compacted = ctx.compactHistory();
    const rebuildPrompt = profile.rebuildPromptContext.bind(profile);
    vi.spyOn(profile, 'rebuildPromptContext').mockImplementation(async () => {
      await rebuildPrompt();
      profile.update({ systemPrompt: `${profile.data().systemPrompt}\nREBUILT_MARKER` });
    });
    vi.spyOn(ctx.get(IAgentMcpService), 'refreshCapabilities').mockRejectedValue(new Error('mcp catalog failed'));
    await expect(ctx.get(IAgentContextRebuildService).rebuild()).rejects.toThrow('mcp catalog failed');
    const report = ctx.get(IAgentContextRebuildService).control();
    expect(report.outcome).toBe('partial');
    expect(report.rebuilt).toContain('profile');
    expect(report.rebuilt).not.toContain('mcp');
    expect(report.rebuilt).not.toContain('injections');
    expect(report.changes?.profile).toBe(true);
    expect(report.error).toBe('mcp catalog failed');
    expect(profile.data().systemPrompt).toContain('REBUILT_MARKER');
    expect(profile.getModel()).toBe(model);
    expect(profile.data().thinkingLevel).toBe('low');
    expect(profile.data().disallowedTools).toEqual(['Bash']);
    expect(ctx.get(IAgentPermissionModeService).mode).toBe(mode);
    const afterCompaction = ctx.compactHistory();
    expect(afterCompaction.slice(0, compacted.length)).toEqual(compacted);
    expect(afterCompaction.length).toBe(compacted.length + 1);
    const callsBefore = ctx.llmCalls.length;
    ctx.mockNextResponse({ type: 'text', text: 'next binding' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use the current binding.' }] });
    await ctx.untilTurnEnd();
    expect(ctx.llmCalls.length).toBe(callsBefore + 1);
    expect(ctx.llmCalls.at(-1)?.systemPrompt).toBe(profile.data().systemPrompt);
    expect(ctx.llmCalls.at(-1)?.systemPrompt).toContain('REBUILT_MARKER');
  }, 30_000);

  it('assembles a configured Recipe on the first enabled boundary even without a named profile', async () => {
    const selected = resolvedRecipeSchema.parse({ revision: 'recipe-latest', branches: {
      main: { system: 'RECIPE CURRENT BODY', fields: {} }, sub: { fields: {} }, independent: { fields: {} },
    }, dependencies: [], origins: [], model: { parameters: { temperature: 0.62 } }, model_origins: {} });
    const ctx = testAgent(sessionServices((reg) => reg.defineInstance(ISessionContextSourceReloader, {
      _serviceBrand: undefined, reload: async () => ({ instructionsChanged: false, pluginsChanged: false }),
    })), appServices((reg) => reg.definePartialInstance(IRecipeService, {
      resolve: async () => structuredClone(selected), onDidChange: Event.None as IRecipeService['onDidChange'],
    })));
    agents.push(ctx);
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPABILITIES });
    const original = ctx.kimiConfig.models![PROVIDER.model]!;
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [PROVIDER.model]: { ...original, recipe: 'example-recipe' } } };
    ctx.notifyModelConfigChanged();
    ctx.appendExchange(1, 'earlier question', 'earlier answer', 80);
    const profile = ctx.get(IAgentProfileService);
    expect(profile.data().profileName).toBeUndefined();
    profile.update({ thinkingLevel: 'off', disallowedTools: ['Bash'] });
    const modelAlias = profile.data().modelAlias;
    const compaction = ctx.get(IAgentFullCompactionService);
    expect(compaction.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    await expect(compaction.compacting!.promise).resolves.toMatchObject({ strategy: 'relay' });
    expect(ctx.get(IAgentContextRebuildService).control()).toMatchObject({ outcome: 'applied', trigger: 'fresh_start' });
    expect(profile.data().modelAlias).toBe(modelAlias);
    expect(profile.data().thinkingLevel).toBe('off');
    expect(profile.data().disallowedTools).toContain('Bash');
    expect(profile.getSystemPrompt()).toContain('RECIPE CURRENT BODY');
    expect(profile.getRecipeModelSettings()?.['parameters']).toMatchObject({ temperature: 0.62 });
    ctx.mockNextResponse({ type: 'text', text: 'reply' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'next request' }] });
    await ctx.untilTurnEnd();
    expect(ctx.llmCalls.at(-1)?.systemPrompt).toContain('RECIPE CURRENT BODY');
    expect((await profile.getPromptDiagnostics()).request?.binding_revision).toBe((await profile.getPromptDiagnostics()).binding_revision);
  }, 30_000);

  it.each([false, true])('restores the same history and binding, refreshing sources only without an explicit off: %s', async (off) => {
    const persistence = new InMemoryWireRecordPersistence();
    let body = 'PROFILE OLD';
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const create = () => {
      const ctx = testAgent({ persistence, autoConfigure: false }, sessionServices((reg) => {
        reg.defineInstance(ISessionContextSourceReloader, { _serviceBrand: undefined, reload });
      }));
      agents.push(ctx);
      const role = normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, systemPrompt: () => body });
      const catalog = ctx.get(ISessionAgentProfileCatalog);
      vi.spyOn(catalog, 'get').mockImplementation((name) => name === role.name ? role : undefined);
      vi.spyOn(catalog, 'getDefault').mockReturnValue(role);
      ctx.get(IAgentContextRebuildService);
      return ctx;
    };
    const first = create();
    await first.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'mock-model', thinking: 'off',
      toolOverride: { disallowedTools: ['Bash'] } });
    expect(first.get(IAgentProfileService).getSystemPrompt()).toContain('PROFILE OLD');
    if (off) await first.get(IAgentContextRebuildService).setEnabled(false);
    first.appendExchange(1, 'retained question', 'retained answer', 80);
    const history = first.compactHistory();
    await first.get(IWireService).flush();
    await first.dispose();
    body = 'PROFILE NEW';

    const reopened = create();
    await reopened.restorePersisted();
    await reopened.get(IAgentProfileService).syncBindingMetadata();
    expect(reload).toHaveBeenCalledTimes(off ? 0 : 1);
    expect(reopened.get(IAgentProfileService).getSystemPrompt()).toContain(off ? 'PROFILE OLD' : 'PROFILE NEW');
    expect(reopened.get(IAgentProfileService).data()).toMatchObject({ modelAlias: 'mock-model', thinkingLevel: 'off', disallowedTools: ['Bash'] });
    expect(reopened.compactHistory().slice(0, history.length)).toEqual(history);
    expect(reopened.llmCalls).toHaveLength(0);
    expect(reopened.get(IAgentContextRebuildService).control()).toMatchObject(off
      ? { enabled: false, rebuilt: [] }
      : { enabled: true, trigger: 'restore', outcome: 'applied', rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'mcp', 'injections'] });
  }, 30_000);

  it.each([false, true])('persists the first explicit choice once and applies it at the boundary: %s', async (enabled) => {
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const ctx = openAgent(reload);
    await ctx.get(IAgentContextRebuildService).setEnabled(enabled);
    await ctx.get(IAgentContextRebuildService).setEnabled(enabled);
    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    await expect(service.compacting!.promise).resolves.toMatchObject({ strategy: 'relay' });
    expect(reload).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(ctx.get(IAgentContextRebuildService).control().enabled).toBe(enabled);
    expect(ctx.get(IAgentContextRebuildService).control().outcome).toBe(enabled ? 'applied' : undefined);
    expect((await ctx.persistedWireRecords()).filter((record) => record.type === 'context_rebuild.preference'))
      .toEqual([expect.objectContaining({ enabled })]);
    expect(ctx.llmCalls).toHaveLength(0);
  }, 30_000);
});

function openAgent(reload: () => Promise<{ instructionsChanged: boolean; pluginsChanged: boolean }>): TestAgentContext {
  const ctx = testAgent(sessionServices((reg) => {
    reg.defineInstance(ISessionContextSourceReloader, { _serviceBrand: undefined, reload });
  }));
  agents.push(ctx);
  ctx.configure({ provider: PROVIDER, modelCapabilities: CAPABILITIES });
  ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
  ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
  return ctx;
}
