import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { IConfigService, ISessionManager, ISessionActivityView, ISessionInteractionService, IAgentLifecycleService, IInstantiationService, IAgentLoopService, IAgentTaskService, IAgentPromptService, IAgentActivityView, IEventBus, IAgentExecutionService, type Scope } from '@kiki/agent-core-v2';
import { DEFAULT_NOTIFICATIONS_CONFIG, NotificationsConfigSchema } from '@kiki/agent-core-v2/app/notifications/configSection';
import type { NotificationChannel, NotificationSettings } from '@kiki/klient';
import { TestInstantiationService } from '@kiki/agent-core-v2/_base/di/test';
import { SyncDescriptor } from '@kiki/agent-core-v2/_base/di/descriptors';
import { ConfigRegistry, ConfigService } from '@kiki/agent-core-v2/app/config/configService';
import { IConfigRegistry } from '@kiki/agent-core-v2/app/config/config';
import { IBootstrapService } from '@kiki/agent-core-v2/app/bootstrap/bootstrap';
import { ILogService } from '@kiki/agent-core-v2/_base/log/log';
import { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { stubBootstrap } from '../../agent-core-v2/test/app/bootstrap/stubs';
import { stubLog } from '../../agent-core-v2/test/_base/log/stubs';
import { startServer, type RunningServer } from '../src/start';
import { NotificationService } from '../src/services/notifications/notificationService';
import { registerNotificationRoutes } from '../src/routes/notifications';
import { ErrorCode } from '../src/protocol/error-codes';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

vi.mock('@nb-im/core', async (original) => {
  const donor = await original<typeof import('@nb-im/core')>();
  return { ...donor, webhookProvider: (id: Parameters<typeof donor.webhookProvider>[0]) => donor.webhookProvider(id, {
    post: async (_input, permit) => {
      const allowed = permit();
      return allowed === 'ready' ? { status: 200, body: '{}' } : { blocked: allowed };
    },
  }) };
});

type Envelope<T> = { code: number; data: T };

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return { on: (listener: (value: T) => void) => {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
  }, fire: (value: T) => { for (const listener of listeners) listener(value); } };
}

describe('notification coordinator', () => {
  let home: string;
  afterEach(async () => { vi.useRealTimers(); if (home) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

  it('persists switches and completes only after the whole work chain settles', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-notifications-idle-'));
    const makeConfig = async () => {
      const ix = new TestInstantiationService();
      ix.stub(ILogService, stubLog());
      ix.stub(IBootstrapService, stubBootstrap(home));
      ix.stub(IFileSystemStorageService, new FileStorageService(home));
      ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
      ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
      ix.set(IConfigService, new SyncDescriptor(ConfigService));
      const config = ix.get(IConfigService);
      await config.ready;
      return { ix, config };
    };
    let stored = await makeConfig();
    const work = emitter<unknown>();
    const events = emitter<{ type: string }>();
    const noEvent = emitter<never>();
    const activity = { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: 'completed' };
    const loop = { state: 'idle', finalizing: false, pendingTurnIds: [] as number[], hasPendingRequests: false };
    let unfinished = false;
    let readyPrompt = false;
    let heldPrompt = false;
    let executionState = 'idle';
    const main = { id: 'main', accessor: { get: (key: unknown) => {
      if (key === IEventBus) return { subscribe: events.on };
      if (key === IAgentLoopService) return { status: () => loop, settled: async () => {} };
      if (key === IAgentExecutionService) return { status: () => ({ state: executionState }), settled: async () => {} };
      if (key === IAgentPromptService) return { hasReadyPending: () => readyPrompt, list: () => ({ pending: heldPrompt ? [{}] : [] }) };
      if (key === IAgentTaskService) return { hasUnfinishedWork: () => unfinished };
      if (key === IAgentActivityView) return { state: () => ({ background: [] }) };
      throw new Error('unexpected_agent_service');
    } } };
    const session = { id: 'work-chain', accessor: { get: (key: unknown) => {
      if (key === IInstantiationService) return { onWillDispose: noEvent.on };
      if (key === ISessionActivityView) return { state: () => activity, onDidChange: work.on };
      if (key === ISessionInteractionService) return { listPending: () => [], onDidChangePending: noEvent.on, onDidResolve: noEvent.on };
      if (key === IAgentLifecycleService) return { list: () => [main], onDidCreate: noEvent.on, onDidDispose: noEvent.on };
      throw new Error('unexpected_session_service');
    } } };
    const core = { accessor: { get: (key: unknown) => {
      if (key === IConfigService) return stored.config;
      if (key === ISessionManager) return { list: () => [session] };
      throw new Error('unexpected_app_service');
    } } } as unknown as Scope;
    let service = new NotificationService(core, home, () => false, () => { throw new Error('unexpected_notification_error'); });
    const app = Fastify();
    const proxy = new Proxy({} as NotificationService, { get: (_target, key) => {
      const value = service[key as keyof NotificationService];
      return typeof value === 'function' ? value.bind(service) : value;
    } });
    registerNotificationRoutes(app, proxy);
    try {
      await service.start();
      expect(service.getSettings().global).toMatchObject({ enabled: true, min_work_ms: 0 });
      const channel = { provider_instance_id: 'hook', enabled: true, revision: 'v1', target: {}, directions: ['send'] as ['send'], scenes: { work_complete: true, question_pending: false } };
      await service.upsertInstance('hook', { provider_id: 'http', enabled: true, revision: 'v1', options: { endpoint: 'https://example.test/', format: 'json' } }, {});
      await service.upsertChannel('enabled', channel);
      await service.upsertChannel('disabled', { ...channel, enabled: false });
      const global = { ...service.getSettings().global, work_stable_ms: 100 };
      const saved = await app.inject({ method: 'PUT', url: '/notifications/settings', payload: { ...global, enabled: false } });
      expect(saved.json().code).toBe(0);
      await service.close();
      stored.ix.dispose();
      stored = await makeConfig();
      service = new NotificationService(core, home, () => false, () => { throw new Error('unexpected_notification_error'); });
      await service.start();
      expect(service.getSettings().global.enabled).toBe(false);
      expect(service.getSettings().channels['disabled']?.enabled).toBe(false);
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('enabled = false');
      vi.useFakeTimers();
      const begin = () => { activity.mainTurnActive = true; loop.state = 'running'; work.fire({}); };
      const end = () => { activity.mainTurnActive = false; loop.state = 'idle'; work.fire({}); };
      begin(); end();
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listDeliveries()).toEqual([]);
      vi.useRealTimers();
      expect((await app.inject({ method: 'PUT', url: '/notifications/settings', payload: global })).json().code).toBe(0);
      vi.useFakeTimers();
      begin();
      unfinished = true;
      end();
      await vi.advanceTimersByTimeAsync(400);
      expect(service.listCompletions()).toEqual([]);
      expect(service.listDeliveries()).toEqual([]);
      unfinished = false;
      loop.hasPendingRequests = true;
      events.fire({ type: 'task.settlement_ready' });
      await vi.advanceTimersByTimeAsync(400);
      expect(service.listCompletions()).toEqual([]);
      loop.hasPendingRequests = false;
      readyPrompt = true;
      events.fire({ type: 'prompt.queued' });
      await vi.advanceTimersByTimeAsync(400);
      expect(service.listCompletions()).toEqual([]);
      readyPrompt = false;
      heldPrompt = true;
      events.fire({ type: 'prompt.queued' });
      await vi.advanceTimersByTimeAsync(400);
      expect(service.listCompletions()).toEqual([]);
      heldPrompt = false;
      begin(); end();
      loop.finalizing = true;
      await vi.advanceTimersByTimeAsync(400);
      expect(service.listDeliveries()).toEqual([]);
      loop.finalizing = false;
      executionState = 'running';
      events.fire({ type: 'turn.ended' });
      await vi.advanceTimersByTimeAsync(400);
      expect(service.listCompletions()).toEqual([]);
      executionState = 'idle';
      events.fire({ type: 'turn.ended' });
      activity.busy = true;
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listCompletions()).toHaveLength(1);
      expect(service.listDeliveries()).toHaveLength(1);
      expect(service.listDeliveries()[0]?.channel_id).toBe('enabled');
      events.fire({ type: 'task.notified' });
      work.fire({});
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listDeliveries()).toHaveLength(1);
      for (const reason of ['failed', 'cancelled']) {
        begin(); activity.lastTurnReason = reason; end();
        await vi.advanceTimersByTimeAsync(120);
        expect(service.listCompletions()).toEqual([]);
        expect(service.listDeliveries()).toHaveLength(1);
      }
      begin(); activity.lastTurnReason = 'completed'; activity.pendingInteraction = 'approval'; end();
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listCompletions()).toEqual([]);
      activity.pendingInteraction = 'none';
      begin(); end();
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listCompletions()).toHaveLength(1);
      vi.useRealTimers();
      await vi.waitFor(() => { expect(service.listDeliveries()[0]?.status).toBe('accepted_by_provider'); }, { timeout: 2000 });
      await service.close();
      service = new NotificationService(core, home, () => false, () => { throw new Error('unexpected_notification_error'); });
      await service.start();
      expect(service.listCompletions()).toEqual([]);
      expect(service.listDeliveries()).toHaveLength(1);
      expect(NotificationsConfigSchema.parse({ ...DEFAULT_NOTIFICATIONS_CONFIG, global: { ...global, enabled: false } }).global.enabled).toBe(false);
    } finally {
      vi.useRealTimers();
      await app.close();
      await service.close();
      stored.ix.dispose();
    }
  });

  it('sends one long-work completion, cancels answered questions and waits for background work', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-notifications-core-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
    const work = emitter<unknown>();
    const pendingEvent = emitter<unknown>();
    const resolved = emitter<{ id: string }>();
    const created = emitter<unknown>();
    const closed = emitter<{ sessionId: string }>();
    const archived = emitter<{ sessionId: string }>();
    const activity = { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: 'completed' };
    let pending: string[] = [];
    const activityView = { state: () => activity, onDidChange: work.on };
    const interaction = {
      listPending: (kind: string) => kind === 'question' ? pending.map((id) => ({ id, kind: 'question' })) : [],
      onDidChangePending: pendingEvent.on, onDidResolve: resolved.on,
    };
    const disposing = emitter<void>();
    let sessionDisposed = false;
    const agentEvents = emitter<{ type: string }>();
    const main = { id: 'main', accessor: { get: (key: unknown) => {
      if (key === IEventBus) return { subscribe: agentEvents.on };
      if (key === IAgentLoopService) return { status: () => ({ state: activity.mainTurnActive ? 'running' : 'idle', pendingTurnIds: [], hasPendingRequests: false }), settled: async () => {} };
      if (key === IAgentExecutionService) return { status: () => ({ state: 'idle' }), settled: async () => {} };
      if (key === IAgentPromptService) return { hasReadyPending: () => false, list: () => ({ pending: [] }) };
      if (key === IAgentTaskService) return { hasUnfinishedWork: () => activity.busy && !activity.mainTurnActive };
      if (key === IAgentActivityView) return { state: () => ({ background: [] }) };
      throw new Error('unexpected_agent_service');
    } } };
    const session = { id: 'session1', accessor: { get: (key: unknown) => {
      if (sessionDisposed) throw new Error('session_scope_disposed');
      if (key === IInstantiationService) return { onWillDispose: disposing.on };
      if (key === ISessionActivityView) return activityView;
      if (key === ISessionInteractionService) return interaction;
      if (key === IAgentLifecycleService) return { list: () => [main], onDidCreate: created.on, onDidDispose: disposing.on };
      throw new Error('unexpected_session_service');
    } } };
    const settings = { global: { enabled: true, suppress_viewing_session: true, min_work_ms: 1000,
      work_stable_ms: 100, question_delay_ms: 100 }, provider_instances: {
      hook: { provider_id: 'http', enabled: true, revision: 'v1', options: { endpoint: 'https://example.com/', format: 'json' } },
    }, channels: { mine: { provider_instance_id: 'hook', enabled: true, revision: 'v1', target: {}, directions: ['send'],
      scenes: { work_complete: true, question_pending: true } } }, credential_slots: {}, credential_values: {} };
    const manager = { list: () => [session], get: (id: string) => id === session.id ? session : undefined,
      onDidCreateSession: created.on, onDidCloseSession: closed.on, onDidArchiveSession: archived.on };
    const config = { ready: Promise.resolve(), get: () => settings, replaceSections: async () => {} };
    const core = { accessor: { get: (key: unknown) => {
      if (key === ISessionManager) return manager;
      if (key === IConfigService) return config;
      throw new Error('unexpected_app_service');
    } } } as unknown as Scope;
    const service = new NotificationService(core, home, () => false, () => { throw new Error('unexpected_notification_error'); });
    try {
      await service.start();
      activity.mainTurnActive = true;
      activity.busy = true;
      work.fire({});
      await vi.advanceTimersByTimeAsync(1100);
      activity.mainTurnActive = false;
      work.fire({});
      await vi.advanceTimersByTimeAsync(350);
      expect(service.listDeliveries()).toEqual([]);
      activity.busy = false;
      work.fire({});
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listDeliveries().filter((item) => item.status === 'queued')).toHaveLength(1);
      work.fire({});
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listDeliveries()).toHaveLength(1);
      pending = ['q1'];
      pendingEvent.fire({});
      pending = [];
      resolved.fire({ id: 'q1' });
      pendingEvent.fire({});
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listDeliveries()).toHaveLength(1);
      pending = ['q2'];
      pendingEvent.fire({});
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listDeliveries()).toHaveLength(2);
      pending = [];
      resolved.fire({ id: 'q2' });
      expect(service.listDeliveries().find((item) => item.status === 'cancelled')).toBeDefined();
      expect(await service.checkCredential('hook')).toMatchObject({ result: 'requires_test_send', health: 'unknown' });
      await service.updateSettings({ ...service.getSettings().global,
        quiet_hours: { start: '00:00', end: '23:59', time_zone: 'UTC' } });
      pending = ['q3'];
      pendingEvent.fire({});
      await vi.advanceTimersByTimeAsync(120);
      expect(service.listDeliveries()).toHaveLength(2);
      pending = ['q4'];
      pendingEvent.fire({});
      activity.busy = true;
      work.fire({});
      await vi.advanceTimersByTimeAsync(1100);
      activity.busy = false;
      pending = [];
      work.fire({});
      disposing.fire();
      sessionDisposed = true;
      work.fire({});
      pendingEvent.fire({});
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.listDeliveries()).toHaveLength(2);
    } finally {
      await service.close();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

describe('notification REST and secret boundary', () => {
  let home: string;
  let server: RunningServer | undefined;
  afterEach(async () => {
    if (server) await server.close();
    if (home) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  it('round-trips instance/channel and stores credentials outside bulk GET and logs', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-notifications-rest-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'info' });
    let base = `http://127.0.0.1:${server.port}`;
    const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<Envelope<T>> => {
      const response = await authedFetch(server!, base, `/api${path}`, { method,
        headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as Envelope<T>;
    };
    const secret = '123456789:' + 'A'.repeat(35);
    const instance = { provider_id: 'telegram', enabled: false, revision: 'v1', options: { token_slot: 'bot_token' }, label: 'Personal bot' };
    const slots = { bot_token: { provider_id: 'telegram', provider_instance_id: 'bot', purpose: 'telegram_bot', env: 'NB_IM_BOT_TOKEN' } };
    expect((await call('/notifications/instances/bot', 'PUT', { instance, slots })).code).toBe(0);
    const channel: NotificationChannel = { provider_instance_id: 'bot', enabled: false, revision: 'v1',
      target: { chat_id: '123456789' }, directions: ['send'], scenes: { work_complete: true, question_pending: true }, label: 'My chat' };
    expect((await call('/notifications/channels/mine', 'PUT', channel)).code).toBe(0);
    expect((await call('/notifications/credentials/bot_token', 'PUT', { value: secret })).code).toBe(0);
    const settings = await call<NotificationSettings>('/notifications/settings');
    expect(settings.data.channels['mine']?.scenes.question_pending).toBe(true);
    expect(settings.data.provider_instances['bot']?.label).toBe('Personal bot');
    expect(settings.data.credential_slots['bot_token']?.configured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(secret);
    const bulk = await call('/config');
    expect(JSON.stringify(bulk)).not.toContain(secret);
    const revealed = await call<{ value: string }>('/secrets:reveal', 'POST', { ref: { kind: 'notification_credential', slot_id: 'bot_token' } });
    expect(revealed.data.value).toBe(secret);
    const config = await readFile(join(home, 'config.toml'), 'utf8');
    expect(config).not.toContain(secret);
    await server.close();
    server = undefined;
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'info' });
    base = `http://127.0.0.1:${server.port}`;
    const restored = await call<NotificationSettings>('/notifications/settings');
    expect(restored.data.channels['mine']?.label).toBe('My chat');
    expect(restored.data.credential_slots['bot_token']?.configured).toBe(true);
    expect(JSON.stringify(restored)).not.toContain(secret);
    expect((await call<{ value: string }>('/secrets:reveal', 'POST', { ref: { kind: 'notification_credential', slot_id: 'bot_token' } })).data.value).toBe(secret);
    expect((await call('/notifications/instances/bot', 'PUT', { instance: { ...instance, enabled: true }, slots })).code).toBe(0);
    expect((await call('/notifications/channels/mine', 'PUT', { ...channel, enabled: true })).code).toBe(0);
    const activated = await call<NotificationSettings>('/notifications/settings');
    expect(activated.data.credential_slots['bot_token']?.configured).toBe(true);
    expect(activated.data.channels['mine']?.enabled).toBe(true);
    expect(activated.data.provider_instances['bot']?.enabled).toBe(true);
    const queued = await call<{ delivery_id: string }>('/notifications/channels/mine:test', 'POST', {});
    expect(queued.data.delivery_id).toBeTruthy();
    expect((await call('/notifications/credentials/bot_token', 'PUT', { value: 'invalid-token' })).code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const deliveries = await call<readonly { delivery_id: string; result: { diagnostic_code?: string } | null }[]>('/notifications/deliveries');
    expect(deliveries.data.find((item) => item.delivery_id === queued.data.delivery_id)?.result?.diagnostic_code).toBe('dispatch_stale');
    expect(JSON.stringify(deliveries)).not.toMatch(/account_epoch|channel_revision|invalid-token/u);
    expect((await call<NotificationSettings>('/notifications/settings')).data.provider_instances['bot']?.health).toBe('unknown');
    const localCheck = await call<{ result: string; error_kind: string }>('/notifications/instances/bot:check', 'POST', {});
    expect(localCheck.data).toMatchObject({ result: 'failed', error_kind: 'auth' });
    expect((await call<NotificationSettings>('/notifications/settings')).data.provider_instances['bot']?.health).toBe('unauthorized');
    const registry = await call<readonly { id: string; status: string; can_receive: boolean }[]>('/notifications/providers');
    expect(registry.data.find((provider) => provider.id === 'telegram')).toMatchObject({ status: 'unverified', can_receive: false });
    expect(registry.data.find((provider) => provider.id === 'script')).toMatchObject({ status: 'dependency_missing' });
    await server.close();
    server = undefined;
    const files = await readdir(join(home, 'logs')).catch(() => []);
    for (const file of files.filter((name) => name.endsWith('.log'))) {
      expect(await readFile(join(home, 'logs', file), 'utf8')).not.toContain(secret);
    }
  });
});

describe('notification route failures', () => {
  it('reports invalid request fields separately from storage failures', async () => {
    const app = Fastify();
    registerNotificationRoutes(app, { getSettings: () => { throw Object.assign(new Error('disk is full'), { code: 'ENOSPC' }); } } as unknown as NotificationService);
    try {
      const bad = await app.inject({ method: 'PUT', url: '/notifications/settings', payload: {} });
      const invalid = bad.json() as Envelope<null> & { msg: string };
      expect(invalid.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(invalid.msg).toContain('enabled');
      const failed = await app.inject({ method: 'GET', url: '/notifications/settings' });
      const internal = failed.json() as Envelope<null> & { msg: string };
      expect(internal.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(internal.msg).toBe('ENOSPC: disk is full');
    } finally {
      await app.close();
    }
  });
});
