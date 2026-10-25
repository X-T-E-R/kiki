import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextRebuildService } from '#/agent/contextRebuild/contextRebuild';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { sessionServices, testAgent, type TestAgentContext } from '../../harness';

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
    await ctx.get(IAgentContextRebuildService).setEnabled(true);

    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    await expect(service.compacting!.promise).resolves.toMatchObject({ strategy: 'relay' });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(ctx.compactHistory()).not.toEqual(history);
    expect(ctx.get(IAgentContextRebuildService).control()).toMatchObject({
      enabled: true,
      outcome: 'applied',
      trigger: 'fresh_start',
    });
    expect(profile.data().modelAlias).toBe(before.modelAlias);
    expect(profile.data().thinkingLevel).toBe(before.thinkingLevel);
    expect(profile.data().toolOverride).toEqual(before.toolOverride);
    expect(profile.data().disallowedTools).toEqual(before.disallowedTools);
    expect(ctx.get(IAgentPermissionModeService).mode).toBe(mode);
    expect(todo.getTodos('main')).toEqual(todos);
    const wire = await ctx.persistedWireRecords();
    expect(wire.some((record) => record.type === 'context_rebuild.preference')).toBe(true);
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

  it('does not re-read sources when the switch stays off', async () => {
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const ctx = openAgent(reload);
    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual', strategy: 'relay' })).toBe(true);
    await expect(service.compacting!.promise).resolves.toMatchObject({ strategy: 'relay' });
    expect(reload).not.toHaveBeenCalled();
    expect(ctx.get(IAgentContextRebuildService).control()).toMatchObject({ enabled: false });
    expect(ctx.get(IAgentContextRebuildService).control().outcome).toBeUndefined();
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
