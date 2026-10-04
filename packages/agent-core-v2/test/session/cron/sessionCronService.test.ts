import { describe, expect, it, vi } from 'vitest';
import { createServices } from '#/_base/di/test';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import type { CronTask } from '#/app/cron/cronTask';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { SessionCronServiceImpl } from '#/session/cron/sessionCronServiceImpl';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ICronCreateTool } from '#/agent/tools/cron/cron-create/cron-create';
import { CronCreateTool } from '#/agent/tools/cron/cron-create/cronCreateTool';
import { ICronDeleteTool } from '#/agent/tools/cron/cron-delete/cron-delete';
import { CronDeleteTool } from '#/agent/tools/cron/cron-delete/cronDeleteTool';

function fixture() {
  const disposables = new DisposableStore();
  const tasks = new Map<string, CronTask>();
  const save = vi.fn(async (_workspace: string, task: CronTask) => { tasks.set(task.id, task); });
  const remove = vi.fn(async (_workspace: string, id: string) => { tasks.delete(id); });
  const services = createServices(disposables, { additionalServices: (reg) => {
    reg.define(ISessionCronService, SessionCronServiceImpl);
    reg.define(ISessionStateService, SessionStateService);
    reg.define(ICronCreateTool, CronCreateTool);
    reg.define(ICronDeleteTool, CronDeleteTool);
    reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: 'fixture' }));
    reg.definePartialInstance(ISessionContext, { sessionId: 'fixture', workspaceId: 'fixture' });
    reg.definePartialInstance(IAgentLifecycleService, { onWillCreate: Event.None as IAgentLifecycleService['onWillCreate'], list: () => [], get: () => undefined });
    reg.definePartialInstance(ITelemetryService, { track2: () => {} });
    reg.definePartialInstance(IConfigService, { ready: Promise.resolve(), get: <T,>() => ({ disabled: false, noJitter: true }) as T });
    reg.defineInstance(ICronTaskPersistence, { _serviceBrand: undefined, save, delete: remove, get: async (_workspace, id) => tasks.get(id), list: async () => [...tasks.values()], listWorkspaceIds: async () => ['fixture'] });
  } });
  return { disposables, services, cron: services.get(ISessionCronService), tasks, save, remove };
}

const context = { turnId: 1, toolCallId: 'fixture', signal: new AbortController().signal };

describe('Cron durable mutation acknowledgements', () => {
  it('does not acknowledge or project create before persistence and reports the tool save error', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      f.save.mockImplementationOnce(async () => { await gate; throw new Error('ENOSPC fixture'); });
      const execution = f.services.get(ICronCreateTool).resolveExecution({ cron: '* * * * *', prompt: 'fixture reminder', recurring: true });
      if (!('execute' in execution)) throw new Error('Expected create execution');
      const work = execution.execute(context);
      const rejection = expect(work).rejects.toThrow('ENOSPC fixture');
      await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
      expect(f.cron.list()).toEqual([]);
      expect(f.tasks.size).toBe(0);
      release();
      await rejection;
      expect(f.cron.list()).toEqual([]);
      const task = await f.cron.addTask({ cron: '* * * * *', prompt: 'saved reminder' });
      expect(f.tasks.get(task.id)).toEqual(task);
      expect(f.cron.getTask(task.id)).toEqual(task);
    } finally { release(); f.disposables.dispose(); }
  });

  it('preserves the saved state on pause/delete failure and lets later writes on the ID proceed in order', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const task = await f.cron.addTask({ cron: '* * * * *', prompt: 'saved reminder' });
      f.save.mockImplementationOnce(async () => { await gate; throw new Error('EIO pause fixture'); });
      const pause = f.cron.setTaskPaused(task.id, true);
      const pauseFailure = expect(pause).rejects.toThrow('EIO pause fixture');
      await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2));
      const resume = f.cron.setTaskPaused(task.id, false);
      expect(f.cron.getTask(task.id)).toEqual(task);
      release();
      await pauseFailure;
      const resumed = await resume;
      expect(f.cron.getTask(task.id)).toEqual(resumed);
      expect(f.tasks.get(task.id)).toEqual(resumed);
      f.remove.mockRejectedValueOnce(new Error('EIO delete fixture'));
      const execution = f.services.get(ICronDeleteTool).resolveExecution({ id: task.id });
      if (!('execute' in execution)) throw new Error('Expected delete execution');
      await expect(execution.execute(context)).rejects.toThrow('EIO delete fixture');
      expect(f.cron.getTask(task.id)).toEqual(resumed);
      expect(f.tasks.get(task.id)).toEqual(resumed);
      expect(await f.cron.removeTasks([task.id])).toEqual([task.id]);
      expect(f.cron.getTask(task.id)).toBeUndefined();
      expect(f.tasks.get(task.id)).toBeUndefined();
    } finally { release?.(); f.disposables.dispose(); }
  });
});
