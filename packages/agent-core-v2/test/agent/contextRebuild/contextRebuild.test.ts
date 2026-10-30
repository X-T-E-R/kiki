import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { OrderedHookSlot } from '#/hooks';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextRebuildService } from '#/agent/contextRebuild/contextRebuild';
import { contextRebuildControlKey } from '#/agent/contextRebuild/contextRebuildOps';
import { AgentContextRebuildService } from '#/agent/contextRebuild/contextRebuildService';
import type { FullCompactionTask } from '#/agent/fullCompaction/fullCompaction';
import { ILogService } from '#/_base/log/log';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService, type AgentLoopStatus } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { TaskNotificationStepRequest } from '#/agent/task/taskService';
import { IAgentModelSwitchService, type ModelSwitchReceipt } from '#/agent/modelSwitch/modelSwitch';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { Event2 } from '#/app/event/event2';

import type { McpSessionCapability } from '#/agent/mcp/mcp';
import { createTestAgent } from '../../harness';

const REBUILT = ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'mcp', 'injections'] as const;

describe('AgentContextRebuildService', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(async () => {
    await disposables.dispose();
  });

  it('refreshes MCP capabilities after source reload and reports a newly admitted server', async () => {
    const order: string[] = [];
    const base = capability('base', 'off');
    const late = capability('late');
    let current: readonly McpSessionCapability[] = [base];
    const host = createHost(disposables, {
      mcp: {
        listMcpSessionCapabilities: async () => current,
        refreshCapabilities: async () => {
          order.push('mcp');
          current = [base, late];
        },
      },
      sources: async () => {
        order.push('sources');
        return { instructionsChanged: false, pluginsChanged: false };
      },
      plugins: async () => { order.push('plugins'); },
    });

    const result = await host.service.rebuild();

    expect(order).toEqual(['sources', 'plugins', 'mcp']);
    expect(result.readiness.plugins).toEqual({ state: 'ready', errors: [] });
    expect(result.readiness.mcp).toEqual([
      { runtimeName: 'base', connection: 'disabled' },
      { runtimeName: 'late', connection: 'connected' },
    ]);
    expect(result.rebuilt).toEqual(REBUILT);
    expect(result.outcome).toBe('applied');
    expect(result.appliesOn).toBe('next_request');
    expect(result.unsupported).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.changes?.mcp).toBe(true);
    expect(current[0]?.override).toBe('off');
    expect(host.service.control()).toMatchObject({ trigger: 'manual', outcome: 'applied', enabled: false });
  });

  it('keeps the freeze while the switch is off, including compaction and restore', async () => {
    const host = createHost(disposables);
    await host.commit.run(compactionTask());
    await host.restore.run({});
    expect(host.reload).not.toHaveBeenCalled();
    expect(host.service.control()).toEqual({ enabled: false, rebuilt: [], unsupported: [] });
  });

  it('re-reads once after an enabled compaction boundary and records the report', async () => {
    const host = createHost(disposables);
    await host.service.setEnabled(true);
    expect(host.reload).not.toHaveBeenCalled();
    await host.commit.run(compactionTask());
    expect(host.reload).toHaveBeenCalledTimes(1);
    expect(host.service.control()).toMatchObject({
      enabled: true,
      outcome: 'applied',
      trigger: 'compaction',
      rebuilt: REBUILT,
    });
    expect(host.service.control().at).toEqual(expect.any(String));
    expect(host.setModel).not.toHaveBeenCalled();
    expect(host.history).toEqual([{ role: 'user', text: 'kept' }]);
  });

  it('records a failed rebuild and leaves the previous binding when the first stage throws', async () => {
    const host = createHost(disposables, { sources: async () => { throw new Error('disk down'); } });
    await host.service.setEnabled(true);
    await host.commit.run(compactionTask());
    expect(host.reload).toHaveBeenCalledTimes(1);
    expect(host.plugins).not.toHaveBeenCalled();
    expect(host.service.control()).toMatchObject({
      outcome: 'failed',
      trigger: 'compaction',
      error: 'disk down',
      rebuilt: [],
    });
    expect(host.service.control().changes).toBeUndefined();
    expect(host.invalidate).not.toHaveBeenCalled();
  });

  it('records a partial rebuild when a later stage throws and does not retry', async () => {
    const host = createHost(disposables, {
      sources: async () => ({ instructionsChanged: true, pluginsChanged: true }),
      profilesReload: async () => { throw new Error('profile catalog down'); },
    });
    await host.service.setEnabled(true);
    await host.commit.run(compactionTask());
    expect(host.reload).toHaveBeenCalledTimes(1);
    expect(host.plugins).not.toHaveBeenCalled();
    const control = host.service.control();
    expect(control.outcome).toBe('partial');
    expect(control.rebuilt).toEqual(['instructions']);
    expect(control.error).toBe('profile catalog down');
    expect(control.changes).toMatchObject({ instructions: true, plugins: false, profile: false });
  });

  it('keeps profile out of a partial report when prompt rebuild throws before it commits', async () => {
    const host = createHost(disposables, {
      rebuildPromptContext: async () => { throw new Error('prompt render failed'); },
    });
    await expect(host.service.rebuild()).rejects.toThrow('prompt render failed');
    const control = host.service.control();
    expect(control.outcome).toBe('partial');
    expect(control.rebuilt).toEqual(['skills', 'instructions']);
    expect(control.rebuilt).not.toContain('profile');
    expect(host.plugins).not.toHaveBeenCalled();
  });

  it('reports profile and prompt fields when prompt rebuild commits and then throws', async () => {
    const host = createHost(disposables, {
      rebuildPromptContext: async () => {
        host.prompt.systemPrompt = 'rebuilt';
        throw new Error('metadata failed');
      },
    });
    await expect(host.service.rebuild()).rejects.toThrow('metadata failed');
    expect(host.service.control().outcome).toBe('partial');
    expect(host.service.control().rebuilt).toEqual(['profile', 'prompt_fields', 'skills', 'instructions']);
    expect(host.service.control().changes?.profile).toBe(true);
    expect(host.invalidate).toHaveBeenCalledTimes(1);
    expect(host.plugins).not.toHaveBeenCalled();
  });

  it('keeps a committed profile in the report when MCP refresh fails afterwards', async () => {
    const host = createHost(disposables, {
      rebuildPromptContext: async () => {
        host.prompt.systemPrompt = 'rebuilt';
      },
      mcp: { refreshCapabilities: async () => { throw new Error('mcp down'); } },
    });
    await expect(host.service.rebuild()).rejects.toThrow('mcp down');
    expect(host.service.control()).toMatchObject({
      outcome: 'partial',
      error: 'mcp down',
      rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins'],
      changes: { profile: true, mcp: false, injections: false },
    });
    expect(host.service.control().rebuilt).not.toContain('mcp');
    expect(host.service.control().rebuilt).not.toContain('injections');
    expect(host.prompt.systemPrompt).toBe('rebuilt');
    expect(host.prompt.modelAlias).toBe('kept-model');
    expect(host.prompt.thinkingLevel).toBe('low');
    expect(host.setModel).not.toHaveBeenCalled();
  });

  it('does not record an unreadable diff as no change after the profile commits', async () => {
    let skillReads = 0;
    const host = createHost(disposables, {
      rebuildPromptContext: async () => {
        host.prompt.systemPrompt = 'rebuilt';
      },
      mcp: { refreshCapabilities: async () => { throw new Error('mcp down'); } },
      listSkills: () => {
        skillReads += 1;
        if (skillReads > 1) throw new Error('skills unreadable');
        return [];
      },
    });
    await expect(host.service.rebuild()).rejects.toThrow('mcp down');
    const control = host.service.control();
    expect(control.outcome).toBe('partial');
    expect(control.changes).toBeUndefined();
    expect(control.rebuilt).toContain('profile');
    expect(control.error).toBe('mcp down');
    expect(host.prompt.systemPrompt).toBe('rebuilt');
    expect(host.prompt.modelAlias).toBe('kept-model');
    expect(host.prompt.thinkingLevel).toBe('low');
    expect(host.logError).toHaveBeenCalledWith('failed to read context rebuild changes', {
      error: expect.objectContaining({ message: 'skills unreadable' }),
      committed: true,
    });
  });

  it('records cancellation without applying a rebuild', async () => {
    const host = createHost(disposables);
    await host.service.setEnabled(true);
    const task = compactionTask();
    task.abortController.abort();
    await host.commit.run(task);
    expect(host.reload).not.toHaveBeenCalled();
    expect(host.service.control()).toMatchObject({
      outcome: 'failed',
      error: 'Context rebuild was cancelled.',
      rebuilt: [],
    });
  });

  it('rebuilds an idle loop while preserving a task notification for the next turn', async () => {
    const ctx = disposables.add(createTestAgent());
    const loop = ctx.get(IAgentLoopService);
    const notification = taskNotification('Task finished');
    const materialize = vi.spyOn(notification, 'resolveContextMessages');
    const start = vi.spyOn(ctx.get(IAgentLLMRequesterService), 'start');
    const receipt = loop.enqueue(notification);
    const host = createHost(disposables, { loop });

    expect(loop.status()).toMatchObject({ state: 'idle', pendingTurnIds: [], pendingRequestKinds: ['task_notification'] });
    try {
      await expect(host.service.rebuild()).resolves.toMatchObject({ outcome: 'applied' });
      expect(loop.status()).toMatchObject({ state: 'idle', pendingTurnIds: [], pendingRequestKinds: ['task_notification'] });
      expect(notification.state).toBe('pending');
      expect(host.reload).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      ctx.mockNextResponse({ type: 'text', text: 'Done' });
      const prompt = loop.enqueue(new MessageStepRequest({
        role: 'user', content: [{ type: 'text', text: 'Continue' }], toolCalls: [],
      }, { admission: 'newTurn' }));
      const { turn } = await prompt.assigned;
      expect((await receipt.assigned).turn).toBe(turn);
      expect((await turn.result).type).toBe('completed');
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect(loop.status().hasPendingRequests).toBe(false);
    } finally {
      receipt.abort();
    }
  });

  it.each([false, true])('releases held notifications and prompts exactly once after rebuild failure=%s', async (fails) => {
    const ctx = disposables.add(createTestAgent());
    const loop = ctx.get(IAgentLoopService);
    const start = vi.spyOn(ctx.get(IAgentLLMRequesterService), 'start');
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = createHost(disposables, { loop, sources: async () => {
      enter();
      await gate;
      if (fails) throw new Error('source reload failed');
      return { instructionsChanged: false, pluginsChanged: false };
    } });
    const rebuilding = host.service.rebuild();
    const rebuilt = fails
      ? expect(rebuilding).rejects.toThrow('source reload failed')
      : expect(rebuilding).resolves.toMatchObject({ outcome: 'applied' });
    await entered;
    const notification = taskNotification('Finished during rebuild');
    const materialize = vi.spyOn(notification, 'resolveContextMessages');
    const receipt = loop.enqueue(notification);
    ctx.mockNextResponse({ type: 'text', text: 'Done' });
    const prompt = loop.enqueue(new MessageStepRequest({
      role: 'user', content: [{ type: 'text', text: 'Continue' }], toolCalls: [],
    }, { admission: 'newTurn' }));
    try {
      expect(loop.status()).toMatchObject({ state: 'idle', pendingTurnIds: [], pendingRequestKinds: ['task_notification', 'message'] });
      expect(start).not.toHaveBeenCalled();
      expect(loop.tryAcquireQuiescence({ pendingSteps: 'preserve' })).toBeUndefined();
    } finally {
      release();
      await rebuilt;
    }
    const { turn } = await prompt.assigned;
    expect((await receipt.assigned).turn).toBe(turn);
    expect((await turn.result).type).toBe('completed');
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(loop.status().hasPendingRequests).toBe(false);
    const admission = loop.tryAcquireQuiescence({ pendingSteps: 'preserve' });
    expect(admission).toBeDefined();
    await admission!.dispose();
  });

  it('rejects a manual rebuild while real active and queued turns exist', async () => {
    const ctx = disposables.add(createTestAgent());
    const loop = ctx.get(IAgentLoopService);
    const host = createHost(disposables, { loop });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    disposables.add(loop.hooks.onWillBeginStep.register('context-rebuild-test', async (_context, next) => {
      enter();
      await gate;
      await next();
    }));
    ctx.mockNextResponse({ type: 'text', text: 'First done' });
    ctx.mockNextResponse({ type: 'text', text: 'Second done' });
    const prompt = () => loop.enqueue(new MessageStepRequest({
      role: 'user', content: [{ type: 'text', text: 'Run' }], toolCalls: [],
    }, { admission: 'newTurn' }));
    const first = (await prompt().assigned).turn;
    await entered;
    let second: typeof first | undefined;
    try {
      expect(loop.status().state).toBe('running');
      await expect(host.service.rebuild()).rejects.toThrow('The session is busy.');
      second = (await prompt().assigned).turn;
      expect(loop.status().pendingTurnIds).toEqual([second.id]);
      await expect(host.service.rebuild()).rejects.toThrow('The session is busy.');
      expect(host.reload).not.toHaveBeenCalled();
    } finally {
      release();
      await first.result;
      await second?.result;
    }
  });

  it('does not record a busy rejection as a failed rebuild', async () => {
    const host = createHost(disposables, { busy: true });
    await expect(host.service.rebuild()).rejects.toThrow('The session is busy. Wait for the current turn to finish, then rebuild context again.');
    expect(host.service.control().outcome).toBeUndefined();
    expect(host.reload).not.toHaveBeenCalled();
  });

  it('rebuilds manually while the switch is off and does not call model or history mutation', async () => {
    const host = createHost(disposables);
    const result = await host.service.rebuild();
    expect(result.outcome).toBe('applied');
    expect(host.service.control().trigger).toBe('manual');
    expect(host.service.control().enabled).toBe(false);
    expect(host.setModel).not.toHaveBeenCalled();
    expect(host.history).toEqual([{ role: 'user', text: 'kept' }]);
  });

  it('re-reads a restored agent only when that agent\'s saved switch is on', async () => {
    const enabled = createHost(disposables);
    await enabled.service.setEnabled(true);
    const saved = structuredClone(enabled.states.get(contextRebuildControlKey));
    const restored = createHost(disposables);
    restored.states.set(contextRebuildControlKey, saved);
    await restored.restore.run({});
    expect(enabled.reload).not.toHaveBeenCalled();
    expect(restored.reload).toHaveBeenCalledTimes(1);
    expect(restored.service.control()).toMatchObject({ enabled: true, trigger: 'restore', outcome: 'applied' });

    const frozen = createHost(disposables);
    await frozen.restore.run({});
    expect(frozen.reload).not.toHaveBeenCalled();
  });

  it('names the executor surfaces it does not refresh', async () => {
    const host = createHost(disposables, { executorId: 'codex' });
    const result = await host.service.rebuild();
    expect(result.outcome).toBe('applied');
    expect(result.rebuilt).toEqual(['profile', 'prompt_fields', 'skills', 'instructions', 'mcp']);
    expect(result.rebuilt).not.toContain('plugins');
    expect(result.rebuilt).not.toContain('injections');
    expect(result.unsupported.map((item) => item.surface)).toEqual(['executor_session', 'plugins', 'injections']);
    expect(result.unsupported[0]?.reason).toContain('codex');
    expect(result.changes?.plugins).toBe(false);
    expect(result.changes?.injections).toBe(false);
    expect(host.plugins).not.toHaveBeenCalled();
    expect(host.injector).not.toHaveBeenCalled();
  });

  it('refuses a manual rebuild on a child and still runs that child\'s own enabled boundary', async () => {
    const child = createHost(disposables, { agentId: 'child' });
    await expect(child.service.rebuild()).rejects.toThrow('Context rebuild is only available for the main agent.');
    expect(child.reload).not.toHaveBeenCalled();
    await child.service.setEnabled(true);
    await child.commit.run(compactionTask());
    expect(child.reload).toHaveBeenCalledTimes(1);
    expect(child.service.control()).toMatchObject({ enabled: true, outcome: 'applied', trigger: 'compaction' });
  });

  it('serializes overlapping boundaries instead of retrying', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inflight = 0;
    let peak = 0;
    const host = createHost(disposables, {
      sources: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await gate;
        inflight -= 1;
        return { instructionsChanged: false, pluginsChanged: false };
      },
    });
    await host.service.setEnabled(true);
    const first = host.commit.run(compactionTask());
    const second = host.commit.run(compactionTask());
    await vi.waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
    expect(peak).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(host.reload).toHaveBeenCalledTimes(2);
    expect(host.service.control().outcome).toBe('applied');
  });

  it('names a committed fresh start and a summary separately from an unspecified compaction', async () => {
    const host = createHost(disposables);
    await host.service.setEnabled(true);
    await host.commit.run({ ...compactionTask(), committedStrategy: 'relay' });
    expect(host.service.control().trigger).toBe('fresh_start');
    await host.commit.run({ ...compactionTask(), committedStrategy: 'summarize' });
    expect(host.reload).toHaveBeenCalledTimes(2);
    expect(host.service.control().trigger).toBe('summary');
    expect(host.setModel).not.toHaveBeenCalled();
  });

  it('re-reads after a fresh or compacted context window and ignores a direct switch', async () => {
    const host = createHost(disposables);
    await host.service.setEnabled(true);
    await host.modelWindow.run(windowReceipt('direct'));
    expect(host.reload).not.toHaveBeenCalled();
    await host.modelWindow.run(windowReceipt('fresh'));
    expect(host.service.control().trigger).toBe('model_switch_fresh');
    await host.modelWindow.run(windowReceipt('compact'));
    expect(host.reload).toHaveBeenCalledTimes(2);
    expect(host.service.control().trigger).toBe('model_switch_compact');
    expect(host.setModel).not.toHaveBeenCalled();
    expect(host.prompt.modelAlias).toBe('kept-model');
  });

  it('re-reads after an idle context clear and skips a clear while the loop is running', async () => {
    const host = createHost(disposables);
    await host.service.setEnabled(true);
    await host.cleared.run({ deleteCount: 2 });
    expect(host.reload).toHaveBeenCalledTimes(1);
    expect(host.service.control().trigger).toBe('context_clear');
    const busy = createHost(disposables, { loopStatus: { state: 'running' } });
    await busy.service.setEnabled(true);
    await busy.cleared.run({ deleteCount: 2 });
    expect(busy.reload).not.toHaveBeenCalled();
    const compacting = createHost(disposables, { compacting: true });
    await compacting.service.setEnabled(true);
    await compacting.cleared.run({ deleteCount: 2 });
    expect(compacting.reload).not.toHaveBeenCalled();
  });

  it('re-reads an idle context clear without consuming next-turn task notifications', async () => {
    const ctx = disposables.add(createTestAgent());
    const loop = ctx.get(IAgentLoopService);
    const receipt = loop.enqueue(taskNotification('Still pending'));
    const host = createHost(disposables, { loop });
    await host.service.setEnabled(true);
    try {
      await host.cleared.run({ deleteCount: 2 });
      expect(host.reload).toHaveBeenCalledTimes(1);
      expect(host.service.control()).toMatchObject({ trigger: 'context_clear', outcome: 'applied' });
      expect(loop.status()).toMatchObject({ state: 'idle', pendingRequestKinds: ['task_notification'] });
    } finally {
      receipt.abort();
    }
  });

  it.each([
    { pendingTurnIds: [1] },
    { finalizing: true },
  ])('skips a context clear with queued or finalizing work: %j', async (loopStatus) => {
    const host = createHost(disposables, { loopStatus });
    await host.service.setEnabled(true);
    await host.cleared.run({ deleteCount: 2 });
    expect(host.reload).not.toHaveBeenCalled();
  });
});

interface HostOptions {
  readonly agentId?: string;
  readonly executorId?: string;
  readonly busy?: boolean;
  readonly loop?: IAgentLoopService;
  readonly loopStatus?: Partial<AgentLoopStatus>;
  readonly compacting?: boolean;
  readonly sources?: () => Promise<{ instructionsChanged: boolean; pluginsChanged: boolean }>;
  readonly profilesReload?: () => Promise<void>;
  readonly plugins?: () => Promise<void>;
  readonly rebuildPromptContext?: () => Promise<void>;
  readonly mcp?: {
    listMcpSessionCapabilities?: () => Promise<readonly McpSessionCapability[]>;
    refreshCapabilities?: () => Promise<void>;
  };
  readonly listSkills?: () => readonly unknown[];
}

function createHost(disposables: DisposableStore, options: HostOptions = {}) {
  const states = disposables.add(new AgentStateService());
  const commit = new OrderedHookSlot<FullCompactionTask>();
  const restore = new OrderedHookSlot<Record<string, never>>();
  const modelWindow = new OrderedHookSlot<ModelSwitchReceipt>();
  const cleared = new OrderedHookSlot<{ readonly deleteCount: number }>();
  const reload = vi.fn(options.sources ?? (async () => ({ instructionsChanged: false, pluginsChanged: false })));
  const plugins = vi.fn(options.plugins ?? (async () => undefined));
  const injector = vi.fn(async () => undefined);
  const invalidate = vi.fn(() => 0);
  const setModel = vi.fn();
  const logError = vi.fn();
  const profilesReload = vi.fn(options.profilesReload ?? (async () => undefined));
  const history = [{ role: 'user', text: 'kept' }];
  const prompt = {
    boundProfile: { id: 'bound' },
    systemPrompt: 'old',
    profileName: 'agent',
    modelAlias: 'kept-model',
    thinkingLevel: 'low',
    executorId: options.executorId,
  };
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(IAgentStateService, states);
      reg.definePartialInstance(IEventDispatcher, {
        hooks: { onDidRestore: restore },
        dispatch: async (event: Event2<any>) => {
          applyControl(states, event);
        },
      });
      reg.definePartialInstance(IAgentFullCompactionService, {
        hooks: { onWillCompact: new OrderedHookSlot<FullCompactionTask>(), onDidCommit: commit },
        isCompacting: () => options.compacting === true,
      });
      reg.definePartialInstance(IAgentModelSwitchService, {
        hooks: { onDidCommitContextWindow: modelWindow },
      });
      reg.definePartialInstance(ILogService, { error: logError });
      reg.definePartialInstance(IAgentScopeContext, { agentId: options.agentId ?? 'main' });
      reg.definePartialInstance(IAgentLoopService, options.loop ?? {
        tryAcquireQuiescence: () => options.busy === true ? undefined : toDisposable(() => {}),
        status: () => ({
          state: 'idle',
          pendingTurnIds: [],
          hasPendingRequests: false,
          ...options.loopStatus,
        }),
      });
      reg.definePartialInstance(IAgentContextInjectorService, { reconcileAllAtSafeBoundary: injector });
      reg.definePartialInstance(IAgentContextMemoryService, {
        get: () => history as never,
        hooks: { onDidClear: cleared },
      });
      reg.definePartialInstance(IAgentProfileService, {
        data: () => prompt as unknown as ReturnType<IAgentProfileService['data']>,
        getPromptFieldSnapshot: () => ({ field: 'same' } as unknown as ReturnType<IAgentProfileService['getPromptFieldSnapshot']>),
        rebuildPromptContext: options.rebuildPromptContext ?? (async () => undefined),
        setModel,
      });
      reg.definePartialInstance(IAgentLLMRequesterService, { invalidatePromptSnapshots: invalidate });
      reg.definePartialInstance(IAgentPluginService, { refreshSessionStartAtSafeBoundary: plugins });
      reg.definePartialInstance(ISessionPluginUsageService, {
        read: async () => ({ workspaceId: 'workspace', sessionId: 'session', revision: 1, overrides: { disabled: false }, applyState: 'applied' as const, errors: [] }),
      });
      reg.definePartialInstance(ISessionAgentProfileCatalog, { reload: profilesReload });
      reg.definePartialInstance(ISessionSkillCatalog, {
        ready: Promise.resolve(),
        catalog: { listSkills: options.listSkills ?? (() => []) } as unknown as ISessionSkillCatalog['catalog'],
        reload: async () => undefined,
      });
      reg.definePartialInstance(ISessionContextSourceReloader, { reload });
      reg.definePartialInstance(IAgentMcpService, {
        list: () => [],
        resolved: () => undefined,
        listMcpSessionCapabilities: options.mcp?.listMcpSessionCapabilities ?? (async () => []),
        refreshCapabilities: options.mcp?.refreshCapabilities ?? (async () => undefined),
      });
      reg.define(IAgentContextRebuildService, AgentContextRebuildService);
    },
  });
  return {
    service: ix.get(IAgentContextRebuildService) as AgentContextRebuildService,
    states,
    commit,
    restore,
    modelWindow,
    cleared,
    reload,
    plugins,
    injector,
    invalidate,
    setModel,
    logError,
    profilesReload,
    history,
    prompt,
  };
}

function applyControl(states: AgentStateService, event: Event2<any>): void {
  const fold = contextRebuildControlKey.replayable.folds.get(event.constructor as never);
  if (fold === undefined) throw new Error(`missing fold for ${event.type}`);
  const draft = structuredClone(states.get(contextRebuildControlKey));
  fold(draft as never, event, undefined as never);
  states.set(contextRebuildControlKey, draft);
}

function taskNotification(text: string): TaskNotificationStepRequest {
  return new TaskNotificationStepRequest({
    role: 'user', content: [{ type: 'text', text }], toolCalls: [],
  }, undefined, undefined, 'activeOrNextTurn');
}

function compactionTask(): FullCompactionTask {
  return {
    abortController: new AbortController(),
    promise: Promise.resolve({} as FullCompactionTask['promise'] extends Promise<infer T> ? T : never),
    trigger: 'manual',
    tokenCount: 1,
  };
}

function windowReceipt(mode: ModelSwitchReceipt['mode']): ModelSwitchReceipt {
  return {
    operationId: mode,
    agentId: 'main',
    state: 'completed',
    fromModel: 'kept-model',
    toModel: 'kept-model',
    mode,
  };
}

function capability(
  runtimeName: string,
  override: McpSessionCapability['override'] = 'inherit',
): McpSessionCapability {
  return {
    locator: { source: 'global', name: runtimeName },
    runtimeName,
    origin: 'global',
    config: { transport: 'stdio', command: `${runtimeName}-mcp` },
    authStatus: 'not-applicable',
    connection: override === 'off' ? 'disabled' : 'connected',
    override,
  };
}
