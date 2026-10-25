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
import { IAgentLoopService } from '#/agent/loop/loop';
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
    const busy = createHost(disposables, { loopState: 'running' });
    await busy.service.setEnabled(true);
    await busy.cleared.run({ deleteCount: 2 });
    expect(busy.reload).not.toHaveBeenCalled();
    const compacting = createHost(disposables, { compacting: true });
    await compacting.service.setEnabled(true);
    await compacting.cleared.run({ deleteCount: 2 });
    expect(compacting.reload).not.toHaveBeenCalled();
  });
});

interface HostOptions {
  readonly agentId?: string;
  readonly executorId?: string;
  readonly busy?: boolean;
  readonly loopState?: 'idle' | 'running';
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
      reg.definePartialInstance(ILogService, { error: () => undefined });
      reg.definePartialInstance(IAgentScopeContext, { agentId: options.agentId ?? 'main' });
      reg.definePartialInstance(IAgentLoopService, {
        tryAcquireQuiescence: () => options.busy === true ? undefined : toDisposable(() => {}),
        status: () => ({
          state: options.loopState ?? 'idle',
          pendingTurnIds: [],
          hasPendingRequests: false,
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
