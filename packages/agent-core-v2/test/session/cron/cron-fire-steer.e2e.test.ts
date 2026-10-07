import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import { createServices } from '#/_base/di/test';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { PromptEnqueued } from '#/agent/prompt/promptService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFsWatchService, type HostFsChange } from '#/os/interface/hostFsWatch';
import type { CronConfig } from '#/app/cron/configSection';
import { ICronScheduler } from '#/app/cron/cronScheduler';
import { CronSchedulerService } from '#/app/cron/cronSchedulerService';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { ISessionManager, type ISessionManager as SessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionCronService } from '#/session/cron/sessionCronService';

import { createTestAgent, sessionService, type TestAgentContext } from '../../harness';

function textOf(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function createAppScheduler(
  ctx: TestAgentContext,
  initiallyLive = false,
): {
  readonly scheduler: ICronScheduler;
  readonly dispose: () => void | Promise<void>;
  readonly acquireCount: () => number;
  readonly leaseActive: () => boolean;
  readonly evictIfIdle: () => Promise<boolean>;
} {
  const disposables = new DisposableStore();
  const session = ctx.get(ISessionContext);
  const sessionId = session.sessionId;
  const cron = ctx.get(ISessionCronService);
  const persistedConfig = ctx.get(IConfigService);
  const config = {
    _serviceBrand: undefined,
    ready: persistedConfig.ready,
    get: <T,>(domain: string): T => persistedConfig.get<T>(domain),
  } as IConfigService;
  const persisted = ctx.get(ICronTaskPersistence);
  const store: ICronTaskPersistence = {
    _serviceBrand: undefined,
    get: (workspaceId, taskId) => persisted.get(workspaceId, taskId),
    list: (query) => persisted.list(query),
    listWorkspaceIds: async () => [session.workspaceId],
    save: (workspaceId, task) => persisted.save(workspaceId, task),
    delete: (workspaceId, taskId) => persisted.delete(workspaceId, taskId),
  };
  const accessor = {
    get: <T,>(id: ServiceIdentifier<T>): T =>
      (id === ISessionCronService ? cron : ctx.get(id)) as T,
  };
  const handle: ISessionScopeHandle = {
    id: sessionId,
    kind: LifecycleScope.Session,
    accessor,
    dispose: () => {},
  };
  let live = initiallyLive;
  let acquisitions = 0;
  let activeLeases = 0;
  const manager = {
    _serviceBrand: undefined,
    acquire: async (id: string) => {
      if (id !== sessionId) return undefined;
      acquisitions += 1;
      activeLeases += 1;
      live = true;
      let released = false;
      return {
        handle,
        dispose: () => {
          if (released) return;
          released = true;
          activeLeases -= 1;
        },
      };
    },
    resume: async (id: string) => {
      if (id !== sessionId) return undefined;
      live = true;
      return handle;
    },
    get: (id: string) => id === sessionId && live ? handle : undefined,
    evictIfIdle: async (id: string) => {
      if (id !== sessionId || !live || activeLeases > 0) return false;
      live = false;
      return true;
    },
    withLifecycleSerialization: async <T,>(
      _id: string,
      work: Parameters<SessionManager['withLifecycleSerialization']>[1],
    ): Promise<T> => work({ archive: async () => {}, restore: async () => handle, delete: async () => {} }) as Promise<T>,
  } as unknown as SessionManager;
  const services = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(IConfigService, config);
      const bootstrap = ctx.get(IBootstrapService);
      reg.defineInstance(IBootstrapService, { interactive: true, homeDir: bootstrap.homeDir, scope: (name) => bootstrap.scope(name) } as IBootstrapService);
      reg.defineInstance(IHostFsWatchService, {
        _serviceBrand: undefined,
        watch: () => ({ ready: Promise.resolve(), onDidChange: Event.None as Event<HostFsChange>, dispose: () => {} }),
      });
      reg.defineInstance(ICronTaskPersistence, store);
      reg.defineInstance(ISessionManager, manager);
      reg.define(ICronScheduler, CronSchedulerService);
    },
  });
  return {
    scheduler: services.get(ICronScheduler),
    dispose: async () => { await disposables.dispose(); },
    acquireCount: () => acquisitions,
    leaseActive: () => activeLeases > 0,
    evictIfIdle: () => manager.evictIfIdle!(sessionId),
  };
}

describe('cron-fired prompt admission', () => {
  let ctx: TestAgentContext;
  let clockFile: string;
  let onWillCreate: Emitter<IAgentScopeHandle>;
  let mainHandle: IAgentScopeHandle | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-steer-'));
    clockFile = join(dir, 'clock.txt');
    writeFileSync(clockFile, String(Date.now()));

    onWillCreate = new Emitter<IAgentScopeHandle>();
    const lifecycleStub: IAgentLifecycleService = {
      _serviceBrand: undefined,
      onWillCreate: onWillCreate.event,
      onDidCreate: Event.None as Event<IAgentScopeHandle>,
      onDidDispose: Event.None as Event<string>,
      create: () => Promise.reject(new Error('not supported in this test')),
      commitCreate: () => {
        throw new Error('not supported in this test');
      },
      discard: async () => {
        throw new Error('not supported in this test');
      },
      fork: () => Promise.reject(new Error('not supported in this test')),
      get: (agentId) => (agentId === 'main' ? mainHandle : undefined),
      list: () => (mainHandle === undefined ? [] : [mainHandle]),
      broadcastPermissionMode: () => {},
      countPendingBackgroundTasks: () => {
        throw new Error('IAgentLifecycleService.countPendingBackgroundTasks is not supported in this test');
      },
      drainBackgroundTasks: async () => {
        throw new Error('IAgentLifecycleService.drainBackgroundTasks is not supported in this test');
      },
      remove: () => Promise.resolve(),
    };
    ctx = createTestAgent(sessionService(IAgentLifecycleService, lifecycleStub));

    const accessor = {
      get: <T,>(id: ServiceIdentifier<T>): T => ctx.get(id),
    };
    mainHandle = { id: 'main', kind: LifecycleScope.Agent, accessor, dispose: () => {} };
    onWillCreate.fire(mainHandle);

    const cronConfig: CronConfig = {
      debug: false,
      noJitter: true,
      noStale: false,
      disabled: false,
      manualTick: true,
      clock: `file:${clockFile}`,
    };
    ctx.kimiConfig = { ...ctx.kimiConfig, cron: cronConfig };
    await ctx.restorePersisted();

    await ctx.rpc.setPermission({ mode: 'yolo' });
  });

  afterAll(async () => {
    onWillCreate.dispose();
    await ctx.dispose();
  });

  it('carries earlier tool results into the cron-fired prompt turn', async () => {
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_cron_1',
      name: 'CronCreate',
      arguments: JSON.stringify({ cron: '* * * * *', prompt: 'fire me', recurring: true }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'scheduled' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'remind me every minute' }] });
    await ctx.untilTurnEnd();

    const toolMessages = ctx.contextData().history.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const jobId = textOf(toolMessages[0]!).match(/^id: (\S+)$/m)?.[1];
    expect(jobId).toBeDefined();
    const legacyTask = ctx.get(ISessionCronService).getTask(jobId!)!;
    const session = ctx.get(ISessionContext);
    await ctx.get(ICronTaskPersistence).save(session.workspaceId, { ...legacyTask, deliveryMode: undefined });
    await ctx.get(ISessionCronService).loadFromStore();
    expect(ctx.get(ISessionCronService).getTask(jobId!)?.deliveryMode).toBeUndefined();

    ctx.mockNextResponse({ type: 'text', text: 'cron turn done' });
    writeFileSync(clockFile, String(Date.now() + 120_000));
    await ctx.get(ISessionCronService).tick();
    await ctx.get(IAgentLoopService).settled();

    expect(ctx.llmCalls.length).toBe(3);
    expect(ctx.contextData().history.findLast((message) => message.origin?.kind === 'cron_job')?.origin)
      .toMatchObject({ jobId, deliveryMode: 'idle' });
    const fireRequest = ctx.llmCalls.at(-1)!;

    const lastUser = fireRequest.history.findLast((message) => message.role === 'user');
    const lastUserText = lastUser?.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('') ?? '';
    expect(lastUserText).toContain('fire me');

    const requestToolTexts = fireRequest.history
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .map((part) => (part.type === 'text' ? part.text : ''));
    expect(requestToolTexts.some((text) => text.includes(`id: ${jobId!}`))).toBe(true);

    const cron = ctx.get(ISessionCronService);
    await cron.setTaskPaused(jobId!, true);
    writeFileSync(clockFile, String(Date.now() + 240_000));
    await cron.tick();
    expect(ctx.llmCalls).toHaveLength(3);
    expect(cron.getNextFireForTask(jobId!)).toBeNull();

    ctx.mockNextResponse({ type: 'text', text: 'manual cron turn done' });
    expect(await cron.fireTaskNow(jobId!)).toBe(true);
    await ctx.get(IAgentLoopService).settled();
    expect(ctx.llmCalls).toHaveLength(4);
    const manualRequest = ctx.llmCalls.at(-1)!;
    const manualUser = manualRequest.history.findLast((message) => message.role === 'user');
    expect(manualUser === undefined ? '' : textOf(manualUser)).toContain('fire me');
    await cron.removeTasks([jobId!]);
    await cron.flushPersist();
  });

  it('queues a due fire while the agent is busy', async () => {
    const prompts = ctx.get(IAgentPromptService);
    const cron = ctx.get(ISessionCronService);
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'queued cron fire', recurring: true });
    const callsBefore = ctx.llmCalls.length;
    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_busy_cron',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'do not execute' }),
    });

    try {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start foreground work' }] });
      const approval = await ctx.takeApprovalRequest();
      writeFileSync(clockFile, String(cron.now() + 120_000));
      await cron.tick();

      expect(ctx.llmCalls).toHaveLength(callsBefore + 1);
      expect(prompts.list().pending).toHaveLength(1);
      expect(prompts.list().pending[0]?.message.origin).toMatchObject({
        kind: 'cron_job',
        jobId: task.id,
        coalescedCount: 2,
      });

      ctx.mockNextResponse({ type: 'text', text: 'foreground prompt done' });
      ctx.mockNextResponse({ type: 'text', text: 'queued cron done' });
      approval.respond({ decision: 'rejected', selectedLabel: 'reject' });
      await ctx.untilTurnEnd();
      await vi.waitFor(() => {
        expect(ctx.llmCalls).toHaveLength(callsBefore + 3);
      });
      await ctx.get(IAgentLoopService).settled();
      expect(textOf(ctx.llmCalls[callsBefore + 2]!.history.findLast((message) => message.role === 'user')!))
        .toContain('queued cron fire');
    } finally {
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await cron.removeTasks([task.id]);
      await cron.flushPersist();
    }
  });

  it('coalesces idle ticks ahead of ordinary FIFO while queue mode keeps every fire', async () => {
    const prompts = ctx.get(IAgentPromptService);
    const cron = ctx.get(ISessionCronService);
    const idle = await cron.addTask({ cron: '* * * * *', prompt: 'idle priority' });
    const other = await cron.addTask({ cron: '* * * * *', prompt: 'other idle job' });
    const queued = await cron.addTask({ cron: '* * * * *', prompt: 'FIFO cron', deliveryMode: 'queue' });
    expect(idle.deliveryMode).toBe('idle');
    const callsBefore = ctx.llmCalls.length;
    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.mockNextResponse({ type: 'function', id: 'busy_priority', name: 'Bash', arguments: JSON.stringify({ command: 'do not execute' }) });
    try {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'active priority work' }] });
      const approval = await ctx.takeApprovalRequest();
      const first = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'first user FIFO' }], toolCalls: [] } });
      writeFileSync(clockFile, String(cron.now() + 120_000));
      await cron.tick();
      const second = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'second user FIFO' }], toolCalls: [] } });
      writeFileSync(clockFile, String(cron.now() + 60_000));
      await cron.tick();
      const pending = prompts.list().pending;
      expect(pending).toHaveLength(6);
      const idleEntries = pending.filter((p) => p.message.origin?.kind === 'cron_job' && p.message.origin.deliveryMode === 'idle');
      expect(idleEntries).toHaveLength(2);
      expect(idleEntries.map((p) => p.message.origin)).toMatchObject([
        { jobId: idle.id, coalescedCount: 3 }, { jobId: other.id, coalescedCount: 3 },
      ]);
      expect(textOf(idleEntries[0]!.message)).toContain('coalescedCount="3"');
      expect(pending.filter((p) => p.message.origin?.kind === 'cron_job' && p.message.origin.deliveryMode === 'queue')).toHaveLength(2);
      const journal: WireRecord[] = [];
      for await (const record of ctx.get(IWireService).readJournal()) journal.push(record);
      const cold = createTestAgent();
      try {
        await cold.restore(journal);
        const restored = cold.get(IAgentPromptService);
        expect(restored.list().hold).toEqual({ reason: 'recovery', count: 6 });
        expect(restored.list().pending.map((p) => p.message.origin)).toEqual(pending.map((p) => p.message.origin));
        const merged = await restored.enqueueCron({ origin: { kind: 'cron_job', jobId: idle.id, cron: idle.cron,
          recurring: true, stale: false, coalescedCount: 2, deliveryMode: 'idle' }, prompt: idle.prompt });
        expect(merged.message.origin).toMatchObject({ jobId: idle.id, deliveryMode: 'idle', coalescedCount: 5 });
        expect(restored.list().pending).toHaveLength(6);
        expect(cold.llmCalls).toHaveLength(0);
        for (let i = 0; i < 6; i++) cold.mockNextResponse({ type: 'text', text: 'recovered done' });
        restored.resumeRecoveredQueue();
        await vi.waitFor(() => expect(cold.llmCalls).toHaveLength(6));
        expect(cold.llmCalls.map((call) => textOf(call.history.findLast((m) => m.role === 'user')!)))
          .toEqual([expect.stringContaining('coalescedCount="5"'), expect.stringContaining('other idle job'),
            'first user FIFO', expect.stringContaining('FIFO cron'), 'second user FIFO', expect.stringContaining('FIFO cron')]);
        await cold.get(IAgentLoopService).settled();
      } finally { await cold.dispose(); }
      prompts.setEditHold(first.id, true);
      ctx.mockNextResponse({ type: 'text', text: 'foreground done' });
      ctx.mockNextResponse({ type: 'text', text: 'idle done' });
      ctx.mockNextResponse({ type: 'text', text: 'other done' });
      approval.respond({ decision: 'rejected', selectedLabel: 'reject' });
      await vi.waitFor(() => expect(ctx.llmCalls).toHaveLength(callsBefore + 4));
      await ctx.get(IAgentLoopService).settled();
      expect(ctx.llmCalls.slice(callsBefore + 2).map((call) => textOf(call.history.findLast((m) => m.role === 'user')!)))
        .toEqual([expect.stringContaining('idle priority'), expect.stringContaining('other idle job')]);
      expect(prompts.list().pending.map((p) => p.id)).toEqual([first.id, pending[3]!.id, second.id, pending[5]!.id]);
      for (let i = 0; i < 4; i++) ctx.mockNextResponse({ type: 'text', text: 'FIFO done' });
      prompts.setEditHold(first.id, false);
      await second.completion;
      await vi.waitFor(() => expect(ctx.llmCalls).toHaveLength(callsBefore + 8));
      expect(ctx.llmCalls.slice(callsBefore + 4).map((call) => textOf(call.history.findLast((m) => m.role === 'user')!)))
        .toEqual(['first user FIFO', expect.stringContaining('FIFO cron'), 'second user FIFO', expect.stringContaining('FIFO cron')]);
    } finally {
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await cron.removeTasks([idle.id, other.id, queued.id]);
      await cron.flushPersist();
    }
  });

  it('steers at a safe step without interrupting active work or consuming ordinary queued prompts', async () => {
    const cron = ctx.get(ISessionCronService);
    const prompts = ctx.get(IAgentPromptService);
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'safe step cron', deliveryMode: 'steer' });
    const callsBefore = ctx.llmCalls.length;
    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.mockNextResponse({ type: 'function', id: 'busy_steer', name: 'Bash', arguments: JSON.stringify({ command: 'do not execute' }) });
    const requester = ctx.get(IAgentLLMRequesterService);
    const start = requester.start.bind(requester);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requestSignal: AbortSignal | undefined;
    const heldRequest = vi.spyOn(requester, 'start').mockImplementationOnce((overrides, onPart, signal) => {
      requestSignal = signal;
      const request = start(overrides, onPart, signal);
      return { ...request, result: gate.then(() => request.result) };
    });
    try {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'active steer work' }] });
      await vi.waitFor(() => expect(requestSignal).toBeDefined());
      const activeId = prompts.list().active!.id;
      const user = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'user after steer' }], toolCalls: [] } });
      expect(await cron.fireTaskNow(task.id)).toBe(true);
      expect(ctx.llmCalls).toHaveLength(callsBefore + 1);
      expect(prompts.list().active!.id).toBe(activeId);
      expect(requestSignal!.aborted).toBe(false);
      release();
      const approval = await ctx.takeApprovalRequest();
      ctx.mockNextResponse({ type: 'text', text: 'steered work done' });
      ctx.mockNextResponse({ type: 'text', text: 'user work done' });
      approval.respond({ decision: 'rejected', selectedLabel: 'reject' });
      await user.completion;
      expect(ctx.llmCalls).toHaveLength(callsBefore + 3);
      expect(textOf(ctx.llmCalls[callsBefore + 1]!.history.findLast((m) => m.role === 'user')!)).toContain('safe step cron');
      expect(textOf(ctx.llmCalls[callsBefore + 2]!.history.findLast((m) => m.role === 'user')!)).toBe('user after steer');
      expect(ctx.contextData().history.filter((m) => m.origin?.kind === 'cron_job' && m.origin.jobId === task.id)).toHaveLength(1);
      const journal: WireRecord[] = [];
      for await (const record of ctx.get(IWireService).readJournal()) journal.push(record);
      const steer = journal.findLast((record) => record.type === 'turn.steer');
      expect(steer).toBeDefined();
      expect(steer?.['turnId']).toBe(prompts.lookup(activeId)?.turnId);
      expect(steer?.['turnId']).not.toBe((await user.launched)?.id);
    } finally {
      release();
      heldRequest.mockRestore();
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await cron.removeTasks([task.id]);
      await cron.flushPersist();
    }
  });

  it('restores all modes without migrating already queued legacy cron records', async () => {
    const source = createTestAgent();
    const cold = createTestAgent();
    try {
      await source.ready;
      const dispatcher = source.get(IEventDispatcher);
      const messages: ContextMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'legacy cron' }], toolCalls: [], origin: { kind: 'cron_job', jobId: 'legacy', cron: '* * * * *', recurring: true, coalescedCount: 4, stale: false } },
        { role: 'user', content: [{ type: 'text', text: 'ordinary FIFO' }], toolCalls: [] },
        ...(['queue', 'idle', 'steer'] as const).map((deliveryMode): ContextMessage => ({ role: 'user', content: [{ type: 'text', text: `${deliveryMode} cron` }], toolCalls: [], origin: { kind: 'cron_job', jobId: deliveryMode, cron: '* * * * *', recurring: true, coalescedCount: 1, stale: false, deliveryMode } })),
      ];
      for (let i = 0; i < messages.length; i++) {
        await dispatcher.dispatch(new PromptEnqueued({ schemaVersion: 1, promptId: `replay-${i}`, userMessageId: `replay-${i}`,
          createdAt: new Date().toISOString(), message: messages[i]!, alreadyMaterialized: false,
          appendTiming: 'agent_idle', revision: 0, queueIndex: i }));
      }
      await source.get(IWireService).flush();
      const journal: WireRecord[] = [];
      for await (const record of source.get(IWireService).readJournal()) journal.push(record);
      await cold.restore(journal);
      const prompts = cold.get(IAgentPromptService);
      expect(prompts.list().pending.map((p) => p.message.origin)).toEqual(messages.map((m) => m.origin));
      expect(prompts.list().hold).toEqual({ reason: 'recovery', count: 5 });
      for (let i = 0; i < 5; i++) cold.mockNextResponse({ type: 'text', text: 'replay done' });
      prompts.resumeRecoveredQueue();
      await vi.waitFor(() => expect(cold.llmCalls).toHaveLength(5));
      expect(cold.llmCalls.map((call) => textOf(call.history.findLast((m) => m.role === 'user' && messages.some((original) => textOf(original) === textOf(m)))!)))
        .toEqual(['idle cron', 'steer cron', 'legacy cron', 'ordinary FIFO', 'queue cron']);
      await cold.get(IAgentLoopService).settled();
    } finally { await source.dispose(); await cold.dispose(); }
  });

  it('keeps a cron fire independent from the active goal', async () => {
    const cron = ctx.get(ISessionCronService);
    const goals = ctx.get(IAgentGoalService);
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'independent scheduled work', recurring: true });
    await goals.createGoal({ objective: 'ongoing foreground goal' });
    await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 1_000, turnBudget: 2 } });
    const callsBefore = ctx.llmCalls.length;

    try {
      ctx.mockNextResponse({ type: 'text', text: 'independent cron done' });
      expect(await cron.fireTaskNow(task.id)).toBe(true);
      await ctx.get(IAgentLoopService).settled();

      expect(ctx.llmCalls).toHaveLength(callsBefore + 1);
      expect(goals.getGoal().goal).toMatchObject({
        status: 'active',
        turnsUsed: 0,
        tokensUsed: 0,
      });
      expect(
        ctx.contextData().history.some(
          (message) => message.origin?.kind === 'injection' && message.origin.variant === 'goal',
        ),
      ).toBe(false);
    } finally {
      await goals.cancelGoal();
      await cron.removeTasks([task.id]);
      await cron.flushPersist();
    }
  });

  it('resumes a cold session, admits a due one-shot, and deletes it durably', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'cold one-shot', recurring: false });
    await cron.flushPersist();
    const callsBefore = ctx.llmCalls.length;
    const appScheduler = createAppScheduler(ctx);

    try {
      ctx.mockNextResponse({ type: 'text', text: 'cold cron turn done' });
      writeFileSync(clockFile, String(cron.now() + 120_000));
      await appScheduler.scheduler.tick();
      await ctx.get(IAgentLoopService).settled();

      expect(appScheduler.acquireCount()).toBe(1);
      expect(appScheduler.leaseActive()).toBe(false);
      expect(ctx.llmCalls).toHaveLength(callsBefore + 1);
      const request = ctx.llmCalls[callsBefore]!;
      const user = request.history.findLast((message) => message.role === 'user');
      expect(user === undefined ? '' : textOf(user)).toContain('cold one-shot');
      expect(cron.getTask(task.id)).toBeUndefined();
      const session = ctx.get(ISessionContext);
      await expect(ctx.get(ICronTaskPersistence).get(session.workspaceId, task.id)).resolves.toBeUndefined();
    } finally {
      await appScheduler.dispose();
    }
  });

  it('fires once when the app tick overlaps the former live-session tick boundary', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'boundary fire', recurring: true });
    await cron.flushPersist();
    const callsBefore = ctx.llmCalls.length;
    const appScheduler = createAppScheduler(ctx, true);

    try {
      ctx.mockNextResponse({ type: 'text', text: 'boundary cron turn done' });
      writeFileSync(clockFile, String(cron.now() + 120_000));
      await Promise.all([appScheduler.scheduler.tick(), cron.tick()]);
      await ctx.get(IAgentLoopService).settled();

      expect(ctx.llmCalls).toHaveLength(callsBefore + 1);
      const request = ctx.llmCalls[callsBefore]!;
      const user = request.history.findLast((message) => message.role === 'user');
      expect(user === undefined ? '' : textOf(user)).toContain('boundary fire');
    } finally {
      await cron.removeTasks([task.id]);
      await cron.flushPersist();
      await appScheduler.dispose();
    }
  });

  it('does not miss or duplicate a fire across eviction immediately before and after delivery', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'eviction boundary', recurring: true });
    await cron.flushPersist();
    const callsBefore = ctx.llmCalls.length;
    const appScheduler = createAppScheduler(ctx, true);

    try {
      writeFileSync(clockFile, String(cron.now() + 120_000));
      expect(await appScheduler.evictIfIdle()).toBe(true);
      ctx.mockNextResponse({ type: 'text', text: 'eviction cron turn done' });
      await appScheduler.scheduler.tick();
      expect(appScheduler.leaseActive()).toBe(false);
      expect(await appScheduler.evictIfIdle()).toBe(true);
      await appScheduler.scheduler.tick();
      await ctx.get(IAgentLoopService).settled();

      expect(appScheduler.acquireCount()).toBe(1);
      expect(ctx.llmCalls).toHaveLength(callsBefore + 1);
      const request = ctx.llmCalls[callsBefore]!;
      expect(
        request.history.some(
          (message) => message.role === 'user' && textOf(message).includes('eviction boundary'),
        ),
      ).toBe(true);
    } finally {
      await cron.removeTasks([task.id]);
      await cron.flushPersist();
      await appScheduler.dispose();
    }
  });

  it('does not resume a cold session for a paused due task', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'paused fire', recurring: true });
    await cron.setTaskPaused(task.id, true);
    const callsBefore = ctx.llmCalls.length;
    const appScheduler = createAppScheduler(ctx);

    try {
      writeFileSync(clockFile, String(cron.now() + 120_000));
      await appScheduler.scheduler.tick();

      expect(appScheduler.acquireCount()).toBe(0);
      expect(ctx.llmCalls).toHaveLength(callsBefore);
      expect(cron.getTask(task.id)?.paused).toBe(true);
    } finally {
      await cron.removeTasks([task.id]);
      await cron.flushPersist();
      await appScheduler.dispose();
    }
  });

  it('delivers one final stale fire from the app scheduler and removes the task', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'stale final fire', recurring: true });
    await cron.flushPersist();
    const session = ctx.get(ISessionContext);
    const staleTask = { ...task, createdAt: cron.now() - 8 * 24 * 60 * 60 * 1000 };
    await ctx.get(ICronTaskPersistence).save(session.workspaceId, staleTask);
    await cron.loadFromStore();
    const callsBefore = ctx.llmCalls.length;
    const appScheduler = createAppScheduler(ctx);

    try {
      ctx.mockNextResponse({ type: 'text', text: 'stale cron turn done' });
      writeFileSync(clockFile, String(cron.now() + 120_000));
      await appScheduler.scheduler.tick();
      await ctx.get(IAgentLoopService).settled();

      expect(ctx.llmCalls).toHaveLength(callsBefore + 1);
      const request = ctx.llmCalls[callsBefore]!;
      const user = request.history.findLast((message) => message.role === 'user');
      const text = user === undefined ? '' : textOf(user);
      expect(text).toContain('stale final fire');
      expect(text).toContain('stale="true"');
      expect(cron.getTask(task.id)).toBeUndefined();
      await expect(ctx.get(ICronTaskPersistence).get(session.workspaceId, task.id)).resolves.toBeUndefined();
    } finally {
      await appScheduler.dispose();
    }
  });

  it('returns a failed save as a tool error instead of a scheduled reminder ACK', async () => {
    const cron = ctx.get(ISessionCronService);
    const before = [...cron.list()];
    const save = vi.spyOn(ctx.get(ICronTaskPersistence), 'save').mockRejectedValueOnce(new Error('ENOSPC fixture'));
    try {
      ctx.mockNextResponse({ type: 'function', id: 'call_failed_cron', name: 'CronCreate', arguments: JSON.stringify({ cron: '* * * * *', prompt: 'must not be acknowledged', recurring: false }) });
      ctx.mockNextResponse({ type: 'text', text: 'save failed' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'schedule fixture reminder' }] });
      await ctx.untilTurnEnd();
      const result = ctx.contextData().history.findLast((message) => message.role === 'tool');
      expect(result).toBeDefined();
      expect(textOf(result!)).toContain('ENOSPC fixture');
      expect(textOf(result!)).not.toMatch(/^id: /m);
      expect(cron.list()).toEqual(before);
      expect(save).toHaveBeenCalledOnce();
    } finally { save.mockRestore(); }
  });
});
