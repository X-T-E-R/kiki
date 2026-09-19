import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import { createServices } from '#/_base/di/test';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IConfigService } from '#/app/config/config';
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
  readonly dispose: () => void;
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
    ): Promise<T> => work({ archive: async () => {}, restore: async () => handle }) as Promise<T>,
  } as unknown as SessionManager;
  const services = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(IConfigService, config);
      reg.defineInstance(ICronTaskPersistence, store);
      reg.defineInstance(ISessionManager, manager);
      reg.define(ICronScheduler, CronSchedulerService);
    },
  });
  return {
    scheduler: services.get(ICronScheduler),
    dispose: () => disposables.dispose(),
    acquireCount: () => acquisitions,
    leaseActive: () => activeLeases > 0,
    evictIfIdle: () => manager.evictIfIdle!(sessionId),
  };
}

describe('cron-fired steer turn context', () => {
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

  it('carries earlier tool results into the cron-fired steer turn request', async () => {
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

    ctx.mockNextResponse({ type: 'text', text: 'cron turn done' });
    writeFileSync(clockFile, String(Date.now() + 120_000));
    await ctx.get(ISessionCronService).tick();
    await ctx.get(IAgentLoopService).settled();

    expect(ctx.llmCalls.length).toBe(3);
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
    cron.removeTasks([jobId!]);
    await cron.flushPersist();
  });

  it('resumes a cold session, injects a due one-shot, and deletes it durably', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = cron.addTask({ cron: '* * * * *', prompt: 'cold one-shot', recurring: false });
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
      appScheduler.dispose();
    }
  });

  it('fires once when the app tick overlaps the former live-session tick boundary', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = cron.addTask({ cron: '* * * * *', prompt: 'boundary fire', recurring: true });
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
      cron.removeTasks([task.id]);
      await cron.flushPersist();
      appScheduler.dispose();
    }
  });

  it('does not miss or duplicate a fire across eviction immediately before and after delivery', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = cron.addTask({ cron: '* * * * *', prompt: 'eviction boundary', recurring: true });
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
      const user = request.history.findLast((message) => message.role === 'user');
      expect(user === undefined ? '' : textOf(user)).toContain('eviction boundary');
    } finally {
      cron.removeTasks([task.id]);
      await cron.flushPersist();
      appScheduler.dispose();
    }
  });

  it('does not resume a cold session for a paused due task', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = cron.addTask({ cron: '* * * * *', prompt: 'paused fire', recurring: true });
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
      cron.removeTasks([task.id]);
      await cron.flushPersist();
      appScheduler.dispose();
    }
  });

  it('delivers one final stale fire from the app scheduler and removes the task', async () => {
    const cron = ctx.get(ISessionCronService);
    const task = cron.addTask({ cron: '* * * * *', prompt: 'stale final fire', recurring: true });
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
      appScheduler.dispose();
    }
  });
});
