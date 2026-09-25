import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServices } from '#/_base/di/test';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ICronScheduler } from '#/app/cron/cronScheduler';
import { CronSchedulerService } from '#/app/cron/cronSchedulerService';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import type { CronTask } from '#/app/cron/cronTask';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IHostFsWatchService, type HostFsChange } from '#/os/interface/hostFsWatch';
import { ISessionCronService } from '#/session/cron/sessionCronService';

describe('CronSchedulerService wakeups', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps a task table in memory, wakes at its due minute, and reloads on changes', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2025, 0, 1, 0, 0, 59);
    vi.setSystemTime(now);
    const changed = new Emitter<void>();
    const files = new Emitter<HostFsChange>();
    const task: CronTask = {
      id: '01234567', cron: '* * * * *', prompt: 'scheduled', createdAt: now,
      recurring: false, tags: { sessionId: 'session-1' },
    };
    const tasks: CronTask[] = [task];
    let reads = 0;
    let fires = 0;
    const store = {
      _serviceBrand: undefined,
      onDidChange: changed.event,
      get: async (_workspaceId: string, id: string) => tasks.find((item) => item.id === id),
      listWorkspaceIds: async () => ['workspace-1'],
      list: async () => { reads += 1; return [...tasks]; },
      save: async (_workspaceId: string, next: CronTask) => { tasks.push(next); changed.fire(); },
      delete: async (_workspaceId: string, id: string) => {
        tasks.splice(tasks.findIndex((item) => item.id === id), 1);
        changed.fire();
      },
    } satisfies ICronTaskPersistence;
    const cron = {
      tick: async () => { fires += 1; await store.delete('workspace-1', task.id); },
      flushPersist: async () => {},
    } as unknown as ISessionCronService;
    const manager = {
      _serviceBrand: undefined,
      acquire: async () => ({ dispose: () => {} }),
      withLifecycleSerialization: async (_id: string, action: () => Promise<void>) => action(),
      get: () => ({ accessor: { get: () => cron } }),
    } as unknown as ISessionManager;
    const disposables = new DisposableStore();
    const services = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigService, {
          ready: Promise.resolve(),
          get: () => ({ disabled: false, debug: false, noJitter: true, manualTick: false }),
          onDidSectionChange: Event.None,
        } as unknown as IConfigService);
        reg.defineInstance(IBootstrapService, {
          homeDir: '/tmp/cron-scheduler-test', scope: () => 'cron',
        } as unknown as IBootstrapService);
        reg.defineInstance(IHostFsWatchService, {
          _serviceBrand: undefined,
          watch: () => ({ ready: Promise.resolve(), onDidChange: files.event, dispose: () => {} }),
        });
        reg.defineInstance(ICronTaskPersistence, store);
        reg.defineInstance(ISessionManager, manager);
        reg.define(ICronScheduler, CronSchedulerService);
      },
    });
    try {
      services.get(ICronScheduler);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fires).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      const afterFire = reads;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reads).toBe(afterFire);
      expect(fires).toBe(1);
      tasks.push({ ...task, id: '76543210', createdAt: Date.now(), paused: true });
      files.fire({ path: '/tmp/cron-scheduler-test/cron/workspace-1/76543210.json', action: 'created', kind: 'file' });
      await vi.advanceTimersByTimeAsync(250);
      expect(reads).toBeGreaterThan(afterFire);
    } finally {
      disposables.dispose();
      changed.dispose();
      files.dispose();
    }
  });
});
