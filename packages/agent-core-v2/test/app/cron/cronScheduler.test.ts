import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _clearScopedRegistryForTests, registerScopedService, ScopeActivation, type ISessionScopeHandle, type IAgentScopeHandle } from '#/_base/di/scope';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import { CronTaskPersistenceService } from '#/app/cron/cronTaskPersistenceService';
import type { CronConfig } from '#/app/cron/configSection';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { SessionCronServiceImpl } from '#/session/cron/sessionCronServiceImpl';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { stubClientIdentity } from '../bootstrap/stubs';

import { createServices } from '#/_base/di/test';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, Event } from '#/_base/event';
import { IBootstrapService, bootstrap } from '#/app/bootstrap/bootstrap';
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


describe('print bootstrap scoped Cron scheduling', () => {
  it.each([
    { mode: 'automatic', config: {}, fires: 1 },
    { mode: 'manual', config: { manualTick: true }, fires: 0 },
    { mode: 'disabled', config: { disabled: true }, fires: 0 },
    { mode: 'zero poll', config: { pollIntervalMs: 0 }, fires: 0 },
    { mode: 'null poll', config: { pollIntervalMs: null }, fires: 0 },
  ])('honors $mode using the print bootstrap and only the opened session owner', async ({ config, fires }) => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-print-cron-'));
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 58));
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IBootstrapService, BootstrapService, ScopeActivation.OnScopeCreated, 'bootstrap');
    registerScopedService(LifecycleScope.App, IAtomicDocumentStore, JsonAtomicDocumentStore, ScopeActivation.OnScopeCreated, 'storage');
    registerScopedService(LifecycleScope.App, ICronTaskPersistence, CronTaskPersistenceService, ScopeActivation.OnScopeCreated, 'cron');
    registerScopedService(LifecycleScope.App, ICronScheduler, CronSchedulerService, ScopeActivation.OnScopeCreated, 'cron');
    registerScopedService(LifecycleScope.Session, ISessionStateService, SessionStateService, ScopeActivation.OnScopeCreated, 'state');
    registerScopedService(LifecycleScope.Session, ISessionCronService, SessionCronServiceImpl, ScopeActivation.OnDemand, 'cron');
    let opened: ISessionScopeHandle | undefined;
    let main: IAgentScopeHandle | undefined;
    const created = new Emitter<never>();
    const enqueue = vi.fn(async () => ({ state: 'pending' }));
    const acquire = vi.fn(async () => { throw new Error('Print must not resume cold owners'); });
    const resume = vi.fn(async () => { throw new Error('Print must not resume cold owners'); });
    const manager = {
      _serviceBrand: undefined, onDidCreateSession: created.event,
      list: () => opened === undefined ? [] : [opened], get: (id: string) => opened?.id === id ? opened : undefined,
      acquire, resume,
      withLifecycleSerialization: async (_id: string, action: () => Promise<void>) => action(),
    } as unknown as ISessionManager;
    const cfg: CronConfig = { disabled: false, debug: false, noJitter: true, noStale: true, manualTick: false, ...config };
    const { app } = bootstrap({ homeDir: home, osHomeDir: home, cwd: home, env: {}, interactive: false, clientIdentity: stubClientIdentity }, [
      [IConfigService, { ready: Promise.resolve(), get: () => cfg, onDidSectionChange: Event.None } as unknown as IConfigService],
      [ISessionManager, manager],
      [IHostFsWatchService, { _serviceBrand: undefined, watch: () => ({ ready: Promise.resolve(), onDidChange: Event.None, dispose: () => {} }) }],
      [ITelemetryService, { track2: () => {} } as unknown as ITelemetryService],
    ]);
    try {
      expect(app.accessor.get(IBootstrapService).interactive).toBe(false);
      const store = app.accessor.get(ICronTaskPersistence);
      const inventory = vi.spyOn(store, 'listWorkspaceIds');
      const cold: CronTask = { id: '01234567', cron: '* * * * *', prompt: 'unrelated cold reminder', createdAt: Date.now(), recurring: false, tags: { sessionId: 'cold-owner' } };
      await store.save('workspace', cold);
      await store.save('other-workspace', { ...cold, id: '76543210' });
      const session = app.createChild(LifecycleScope.Session, 'print-owner', { seeds: [
        [ISessionContext, makeSessionContext({ sessionId: 'print-owner', workspaceId: 'workspace', cwd: home, sessionDir: home, sessionScope: 'sessions/print-owner' })],
        [IAgentLifecycleService, { onWillCreate: Event.None, list: () => [], get: () => main } as unknown as IAgentLifecycleService],
      ] });
      const cron = session.accessor.get(ISessionCronService);
      main = { id: 'main', kind: LifecycleScope.Agent, dispose: () => {}, accessor: { get: <T,>(id: ServiceIdentifier<T>): T => {
        if (id === IAgentPromptService) return { enqueue } as T;
        if (id === IEventDispatcher) return { dispatch: async () => {} } as T;
        throw new Error(`Unexpected agent service ${id.toString()}`);
      } } };
      opened = { id: 'print-owner', kind: LifecycleScope.Session, accessor: session.accessor, dispose: () => {} };
      created.fire(undefined as never);
      const task = await cron.addTask({ cron: '* * * * *', prompt: 'print reminder', recurring: false });
      await vi.advanceTimersByTimeAsync(250);
      if (fires > 0) await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(1));
      await vi.advanceTimersByTimeAsync(2_000);
      if (fires > 0) await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      else expect(enqueue).not.toHaveBeenCalled();
      expect(inventory).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(await store.get('workspace', cold.id)).toEqual(cold);
      if (fires > 0) {
        expect(enqueue.mock.calls[0]).toEqual([expect.objectContaining({ message: expect.objectContaining({ origin: expect.objectContaining({ jobId: task.id }) }) })]);
        expect(await store.get('workspace', task.id)).toBeUndefined();
        await cron.addTask({ cron: '* * * * *', prompt: 'remains saved after print exit', recurring: false });
      }
      app.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(enqueue).toHaveBeenCalledTimes(fires);
    } finally {
      app.dispose(); created.dispose(); vi.useRealTimers();
      await rm(home, { force: true, recursive: true, maxRetries: 3 });
    }
  });
});
