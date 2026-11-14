import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IBootstrapService,
  IAtomicDocumentStore,
  IConfigService,
  IEventService,
  IFlagService,
  IInstantiationService,
  ILogService,
  IModelCatalog,
  IOAuthService,
  IPluginExtensionPortRegistry,
  IPluginHostService,
  IPluginService,
  IPluginSettingsService,
  IPluginUsageService,
  IProviderService,
  ISessionIndex,
  ISessionManager,
  ISkillDiscovery,
  IWorkspaceService,
  LifecycleScope,
  type IDisposable,
  type PluginHttpRouteHandlerContext,
  type PluginHttpRouteResult,
  type PluginInfo,
  type PluginSummary,
  type Scope,
  type Workspace,
} from '@kiki/agent-core-v2';
import { Event } from '@kiki/agent-core-v2/_base/event';
import { _clearScopedRegistryForTests, registerScopedService, ScopeActivation } from '@kiki/agent-core-v2/_base/di/scope';
import { createScopedTestHost, stubPair } from '@kiki/agent-core-v2/_base/di/test';
import { TestInstantiationService } from '@kiki/agent-core-v2/_base/di/testInstantiationService';
import { PluginHostService } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import { PluginService } from '@kiki/agent-core-v2/app/plugin/pluginService';
import { PluginSettingsService } from '@kiki/agent-core-v2/app/plugin/pluginSettingsService';
import { PluginUsageService } from '@kiki/agent-core-v2/app/pluginUsage/pluginUsageService';
import { PluginExtensionPortRegistryService } from '@kiki/agent-core-v2/app/pluginExtensionPorts/pluginExtensionPortRegistryService';
import { IRequestIdentityCatalog } from '@kiki/agent-core-v2/app/requestIdentity/requestIdentityCatalog';
import {
  ErrorCode,
  type ListPluginGuiSlotsResponse,
  type PluginGuiSlotContribution,
  type PluginWsTopicEvent,
} from '@kiki/protocol';

import { createAuthHook } from '../../src/middleware/auth';
import { registerPluginBrokerRoutes } from '../../src/routes/pluginBroker';
import { registerPluginsRoutes } from '../../src/routes/plugins';
import {
  type BroadcastTarget,
  SessionEventBroadcaster,
} from '../../src/transport/ws/v1/sessionEventBroadcaster';
import type { EventEnvelope } from '../../src/transport/ws/v1/sessionEventJournal';

type StoredUsageValue = {
  readonly revision: number;
  readonly overrides: Record<string, boolean>;
};

class MemoryAtomicDocuments {
  private readonly values = new Map<string, unknown>();

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.values.get(`${scope}:${key}`) as T | undefined;
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.values.set(`${scope}:${key}`, value);
  }

  async update<T>(scope: string, key: string, updater: (current: T | undefined) => T): Promise<T> {
    const next = updater(await this.get<T>(scope, key));
    await this.set(scope, key, next);
    return next;
  }
}

class InMemoryEventService {
  private readonly listeners = new Set<(event: { type: string; payload: unknown }) => void>();

  subscribe(listener: (event: { type: string; payload: unknown }) => void): IDisposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  publish(event: { type: string; payload: unknown }): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

function makeWorkspace(id: string): Workspace {
  return {
    id,
    root: `C:/workspaces/${id}`,
    name: id,
    createdAt: 1,
    lastOpenedAt: 2,
    pinned: false,
  };
}

function makePluginSummary(
  id: string,
  options: { readonly enabled?: boolean; readonly state?: 'ok' | 'error' } = {},
): PluginSummary {
  const state = options.state ?? 'ok';
  return {
    id,
    displayName: id,
    version: '1.0.0',
    enabled: options.enabled ?? true,
    globalEnabled: options.enabled ?? true,
    state,
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: state === 'error',
    source: 'local-path',
  };
}

function makePluginInfo(record: PluginSummary): PluginInfo {
  return {
    ...record,
    root: `C:/plugins/${record.id}`,
    installedAt: '2026-01-01T00:00:00.000Z',
    mcpServers: [],
    diagnostics: [],
  };
}

const SERVER_TOKEN = 'test-broker-bearer-token';

describe('plugin HTTP/WS broker routes and topic ACL', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup !== undefined) await cleanup();
    }
  });

  async function createHarness(options: {
    readonly registerPort?: boolean;
    readonly spaceId?: string;
  } = {}) {
    const tempDir = await mkdtemp(join(tmpdir(), 'kap-plugin-broker-'));
    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    app.addHook(
      'onRequest',
      createAuthHook({
        isValid: async (candidate: string) => candidate === SERVER_TOKEN,
      } as never),
    );

    const docs = new MemoryAtomicDocuments();
    const usage = new PluginUsageService(
      docs as unknown as IAtomicDocumentStore,
      { enabled: () => true } as never,
    );
    const eventService = new InMemoryEventService();
    const port =
      options.registerPort === false
        ? undefined
        : new PluginExtensionPortRegistryService({} as never);

    const pluginStates = new Map<string, PluginSummary>([
      ['alpha', makePluginSummary('alpha')],
      ['beta', makePluginSummary('beta')],
      ['disabled-plugin', makePluginSummary('disabled-plugin', { enabled: false })],
    ]);

    usage.registerPluginStateReader((id) => {
      const record = pluginStates.get(id);
      if (record === undefined) return { allowed: false, globalEnabled: false };
      return { allowed: record.enabled && record.state === 'ok', globalEnabled: record.globalEnabled };
    });

    const workspaces = new Map<string, Workspace>([
      ['ws-a', makeWorkspace('ws-a')],
      ['ws-b', makeWorkspace('ws-b')],
    ]);
    const coldSessions = new Map<string, { readonly id: string; readonly workspaceId: string }>([
      ['sess-a', { id: 'sess-a', workspaceId: 'ws-a' }],
      ['sess-b', { id: 'sess-b', workspaceId: 'ws-b' }],
    ]);

    const getSessionIndex = vi.fn(async (sessionId: string) => coldSessions.get(sessionId));
    const acquireSession = vi.fn<(id: string) => Promise<unknown>>(async () => undefined);
    const liveHandles = new Map<string, unknown>();

    const pluginService = {
      listPlugins: vi.fn(async () => [...pluginStates.values()]),
      getPluginInfo: vi.fn(async ({ id }: { readonly id: string }) => {
        const record = pluginStates.get(id);
        if (record === undefined) throw new Error(`missing plugin ${id}`);
        return makePluginInfo(record);
      }),
      setPluginEnabled: vi.fn(async ({ id, enabled }: { readonly id: string; readonly enabled: boolean }) => {
        const current = pluginStates.get(id);
        if (current !== undefined) {
          pluginStates.set(id, { ...current, enabled, globalEnabled: enabled });
          eventService.publish({ type: 'event.plugin.changed', payload: { pluginId: id } });
        }
      }),
    } as unknown as IPluginService;

    const container = new TestInstantiationService();
    container.set(IInstantiationService, container);
    container.set(IBootstrapService, {
      homeDir: tempDir,
      spaceId: options.spaceId ?? 'space-main',
      getEnv: () => undefined,
    } as unknown as IBootstrapService);
    container.set(IEventService, eventService as unknown as IEventService);
    container.set(IPluginService, pluginService);
    container.set(IPluginHostService, {
      navigation: vi.fn(() => null),
    } as unknown as IPluginHostService);
    container.set(IPluginUsageService, usage);
    container.set(IAtomicDocumentStore, docs as unknown as IAtomicDocumentStore);
    container.set(ISessionIndex, { get: getSessionIndex } as unknown as ISessionIndex);
    container.set(IWorkspaceService, {
      get: vi.fn(async (id: string) => workspaces.get(id)),
    } as unknown as IWorkspaceService);
    container.set(ISessionManager, {
      get: (id: string) => liveHandles.get(id),
      list: () => [...liveHandles.values()],
      acquire: acquireSession,
      onDidCloseSession: () => ({ dispose: () => {} }),
      onDidArchiveSession: () => ({ dispose: () => {} }),
    } as unknown as ISessionManager);
    if (port !== undefined) {
      container.set(IPluginExtensionPortRegistry, port);
    }

    const core = { accessor: container } as unknown as Scope;

    await app.register(
      async (api) => {
        registerPluginsRoutes(api as never, core, {
          marketplaceUrl: () => undefined,
          serverToken: () => SERVER_TOKEN,
        });
        registerPluginBrokerRoutes(api as never, core);
      },
      { prefix: '/api' },
    );
    await app.ready();

    cleanups.push(async () => {
      port?.dispose();
      await usage.dispose();
      await container.dispose();
      await app.close();
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    return {
      app,
      core,
      port,
      usage,
      docs,
      tempDir,
      eventService,
      pluginStates,
      getSessionIndex,
      acquireSession,
      liveHandles,
    };
  }

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${SERVER_TOKEN}`,
      ...extra,
    };
  }

  it('gracefully returns empty slots and 404 when IPluginExtensionPortRegistry is not registered', async () => {
    const { app } = await createHarness({ registerPort: false });

    const slotsRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/gui-slots',
      headers: authHeaders(),
    });
    expect(slotsRes.statusCode).toBe(200);
    expect(slotsRes.json()).toMatchObject({
      code: 0,
      data: { slots: [] },
    });

    const routeRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/ping?session_id=sess-a',
      headers: authHeaders(),
      payload: { ok: true },
    });
    expect(routeRes.statusCode).toBe(200);
    expect(routeRes.json()).toMatchObject({
      code: ErrorCode.PLUGIN_NOT_FOUND,
    });
  });

  it('requires bearer authentication on both gui-slots and plugin routes', async () => {
    const { app } = await createHarness();

    const unauthSlots = await app.inject({
      method: 'GET',
      url: '/api/plugins/gui-slots',
    });
    expect(unauthSlots.statusCode).toBe(401);
    expect(unauthSlots.json()).toMatchObject({ code: ErrorCode.AUTH_INVALID_TOKEN });

    const unauthRoute = await app.inject({
      method: 'GET',
      url: '/api/plugins/alpha/routes/status',
    });
    expect(unauthRoute.statusCode).toBe(401);
    expect(unauthRoute.json()).toMatchObject({ code: ErrorCode.AUTH_INVALID_TOKEN });
  });

  it('preserves existing /api/plugins management endpoints alongside broker routes', async () => {
    const { app, port } = await createHarness();
    port!.registerHttpRoute(
      {
        pluginId: 'alpha',
        method: 'GET',
        subpath: '/health',
        scopeAcl: 'global',
        maxBodyBytes: 4096,
      },
      async () => ({ status: 200, data: { alive: true } }),
    );

    const navRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/navigation',
      headers: authHeaders(),
    });
    expect(navRes.statusCode).toBe(200);
    expect(navRes.json()).toMatchObject({ code: 0, data: { request: null } });

    const infoRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/alpha',
      headers: authHeaders(),
    });
    expect(infoRes.statusCode).toBe(200);
    expect(infoRes.json()).toMatchObject({ code: 0, data: { id: 'alpha' } });

    const brokerRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/alpha/routes/health',
      headers: authHeaders(),
    });
    expect(brokerRes.statusCode).toBe(200);
    expect(brokerRes.json()).toMatchObject({ code: 0, data: { alive: true } });

    const disableRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha:disable',
      headers: authHeaders(),
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json()).toMatchObject({ code: 0, data: { ok: true } });
  });

  it('filters GET /api/plugins/gui-slots by workspace and cold session usage without resuming sessions', async () => {
    const { app, port, usage, getSessionIndex, acquireSession } = await createHarness();

    const alphaSlot: PluginGuiSlotContribution = {
      slot: 'status-capsule',
      pluginId: 'alpha',
      id: 'lsp-status',
      label: { default: 'LSP', zh: '语言服务' },
      valueText: 'ready',
      dotTone: 'ok',
      order: 10,
    };
    const betaSlot: PluginGuiSlotContribution = {
      slot: 'composer-toolbar',
      pluginId: 'beta',
      id: 'quick-check',
      label: { default: 'Check' },
      tone: 'neutral',
      order: 20,
      action: { kind: 'insert_prompt', text: 'Run checks' },
    };
    const disabledSlot: PluginGuiSlotContribution = {
      slot: 'settings-section',
      pluginId: 'disabled-plugin',
      id: 'sec',
      title: { default: 'Hidden' },
      order: 0,
    };

    port!.registerGuiSlot(alphaSlot);
    port!.registerGuiSlot(betaSlot);
    port!.registerGuiSlot(disabledSlot);

    await usage.set({ workspaceId: 'ws-a', pluginId: 'beta', override: 'off' });

    const wsARes = await app.inject({
      method: 'GET',
      url: '/api/plugins/gui-slots?workspace_id=ws-a',
      headers: authHeaders(),
    });
    const wsABody = wsARes.json() as { code: number; data: ListPluginGuiSlotsResponse };
    expect(wsABody.code).toBe(0);
    expect(wsABody.data.slots.map((s) => s.pluginId)).toEqual(['alpha']);

    const coldSessionRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/gui-slots?session_id=sess-b',
      headers: authHeaders(),
    });
    const coldBody = coldSessionRes.json() as { code: number; data: ListPluginGuiSlotsResponse };
    expect(coldBody.code).toBe(0);
    expect(coldBody.data.slots.map((s) => s.pluginId)).toEqual(['alpha', 'beta']);
    expect(getSessionIndex).toHaveBeenCalledWith('sess-b');
    expect(acquireSession).not.toHaveBeenCalled();
  });

  it('rejects dot-segment traversal, encoded slashes, reserved management segments, oversized bodies, and cross-scope access before running handlers', async () => {
    const { app, port, usage } = await createHarness({ spaceId: 'space-main' });
    const handler = vi.fn(async (ctx: PluginHttpRouteHandlerContext): Promise<PluginHttpRouteResult> => ({
      status: 200,
      data: {
        echo: ctx.body,
        hasAuthHeader: ctx.headers['authorization'] !== undefined,
        spaceId: ctx.spaceId,
        sessionId: ctx.sessionId,
      },
    }));

    const reg = port!.registerHttpRoute(
      {
        pluginId: 'alpha',
        method: 'POST',
        subpath: '/tasks/run',
        scopeAcl: 'session',
        maxBodyBytes: 64,
      },
      handler,
    );

    const dotRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/tasks/../settings?session_id=sess-a',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(dotRes.json().code).not.toBe(0);

    const rawDotRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/..%2fsettings?session_id=sess-a',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(rawDotRes.json()).toMatchObject({ code: ErrorCode.FS_PATH_ESCAPES_SESSION });

    const encodedBackslashRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/tasks%5csecret?session_id=sess-a',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(encodedBackslashRes.json()).toMatchObject({ code: ErrorCode.FS_PATH_ESCAPES_SESSION });

    const reservedRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/settings/secret?session_id=sess-a',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(reservedRes.json()).toMatchObject({ code: ErrorCode.VALIDATION_FAILED });

    const missingSessionRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/tasks/run',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(missingSessionRes.json()).toMatchObject({ code: ErrorCode.FS_PERMISSION_DENIED });

    const wrongSpaceRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/tasks/run?session_id=sess-a&space_id=space-other',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(wrongSpaceRes.json()).toMatchObject({ code: ErrorCode.FS_PERMISSION_DENIED });

    const crossPluginRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/beta/routes/tasks/run?session_id=sess-a',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(crossPluginRes.json()).toMatchObject({ code: ErrorCode.PLUGIN_NOT_FOUND });

    const largeRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/tasks/run?session_id=sess-a',
      headers: authHeaders(),
      payload: { text: 'x'.repeat(200) },
    });
    expect(largeRes.json()).toMatchObject({ code: ErrorCode.FS_TOO_LARGE });

    await usage.set({ workspaceId: 'ws-b', pluginId: 'alpha', override: 'off' });
    const disabledWorkspaceRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/tasks/run?session_id=sess-b',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(disabledWorkspaceRes.json()).toMatchObject({ code: ErrorCode.FS_PERMISSION_DENIED });

    expect(handler).not.toHaveBeenCalled();

    const okRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/tasks/run?session_id=sess-a',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(okRes.json()).toMatchObject({
      code: 0,
      data: {
        echo: { a: 1 },
        hasAuthHeader: false,
        spaceId: 'space-main',
        sessionId: 'sess-a',
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);

    reg.dispose();
    const afterDisposeRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/tasks/run?session_id=sess-a',
      headers: authHeaders(),
      payload: { a: 1 },
    });
    expect(afterDisposeRes.json()).toMatchObject({ code: ErrorCode.PLUGIN_NOT_FOUND });
  });

  it('rejects TOCTOU route hot-replacement during async ACL checks without invoking the replacement handler', async () => {
    const { app, port, getSessionIndex } = await createHarness({ spaceId: 'space-main' });
    const oldHandler = vi.fn(async (): Promise<PluginHttpRouteResult> => ({
      status: 200,
      data: { version: 'old' },
    }));
    const strictReplacementHandler = vi.fn(async (): Promise<PluginHttpRouteResult> => ({
      status: 200,
      data: { version: 'strict-new' },
    }));

    const oldReg = port!.registerHttpRoute(
      {
        pluginId: 'alpha',
        method: 'POST',
        subpath: '/hot-swap',
        scopeAcl: 'global',
        maxBodyBytes: 4096,
      },
      oldHandler,
    );

    getSessionIndex.mockImplementationOnce(async () => {
      oldReg.dispose();
      port!.registerHttpRoute(
        {
          pluginId: 'alpha',
          method: 'POST',
          subpath: '/hot-swap',
          scopeAcl: 'session',
          maxBodyBytes: 16,
        },
        strictReplacementHandler,
      );
      return { id: 'sess-a', workspaceId: 'ws-a' };
    });

    const raceRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/alpha/routes/hot-swap?session_id=sess-a',
      headers: authHeaders(),
      payload: { largePayload: 'x'.repeat(128) },
    });
    expect(raceRes.statusCode).toBe(200);
    expect(raceRes.json()).toMatchObject({ code: ErrorCode.PLUGIN_NOT_FOUND });
    expect(oldHandler).not.toHaveBeenCalled();
    expect(strictReplacementHandler).not.toHaveBeenCalled();
  });

  it('propagates request close cancellation into plugin route AbortSignal', async () => {
    const { port } = await createHarness();
    let observedSignal: AbortSignal | undefined;
    port!.registerHttpRoute(
      {
        pluginId: 'alpha',
        method: 'GET',
        subpath: '/slow',
        scopeAcl: 'global',
        maxBodyBytes: 0,
      },
      async (ctx) => {
        observedSignal = ctx.signal;
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
        return { status: 200, data: { ok: true } };
      },
    );

    const rawReq = new EventEmitter() as EventEmitter & { url: string; destroyed: boolean };
    rawReq.url = '/api/plugins/alpha/routes/slow';
    rawReq.destroyed = false;
    const rawReply = new EventEmitter() as EventEmitter & { destroyed: boolean; writableEnded: boolean };
    rawReply.destroyed = false;
    rawReply.writableEnded = false;

    const hostApp = Fastify();
    cleanups.push(async () => {
      await hostApp.close();
    });
    const routes = new Map<string, (req: unknown, reply: unknown) => Promise<void>>();
    registerPluginBrokerRoutes(
      {
        get: (path, _opts, handler) => {
          routes.set(`GET:${path}`, handler as (req: unknown, reply: unknown) => Promise<void>);
        },
        post: () => undefined,
        put: () => undefined,
        delete: () => undefined,
      },
      {
        accessor: {
          get: (token: unknown) => {
            if (token === IPluginExtensionPortRegistry) return port;
            if (token === IBootstrapService) return { spaceId: 'space-main' };
            return undefined;
          },
        },
      } as unknown as Scope,
    );

    const getHandler = routes.get('GET:/plugins/:pluginId/routes/*')!;
    const sent: unknown[] = [];
    const callPromise = getHandler(
      {
        id: 'req-abort-1',
        raw: rawReq,
        params: { pluginId: 'alpha', '*': 'slow' },
        query: {},
        headers: {},
      },
      {
        raw: rawReply,
        send: (payload: unknown) => {
          sent.push(payload);
        },
        then: (resolve: () => void) => resolve(),
      },
    );

    await vi.waitFor(() => {
      expect(observedSignal).toBeDefined();
    });
    expect(observedSignal?.aborted).toBe(false);

    rawReply.destroyed = true;
    rawReply.emit('close');
    await callPromise;

    expect(observedSignal?.aborted).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('enforces scopeAcl on event.plugin.topic across sessions and spaces and drops events immediately on plugin disable or topic dispose', async () => {
    const mainHarness = await createHarness({ spaceId: 'space-main' });
    const otherSpaceHarness = await createHarness({ spaceId: 'space-other' });

    function makeLiveHandle(sessionId: string, workspaceId: string) {
      return {
        id: sessionId,
        accessor: {
          get(token: unknown) {
            const tokenId = String(token);
            if (tokenId.includes('sessionContext')) {
              return { sessionId, workspaceId };
            }
            if (tokenId.includes('sessionActivityView')) {
              return {
                state: () => ({ busy: false, executing: false }),
                onDidChange: () => ({ dispose: () => {} }),
              };
            }
            if (tokenId.includes('agentLifecycle')) {
              return {
                list: () => [],
                onDidCreate: () => ({ dispose: () => {} }),
                onDidDispose: () => ({ dispose: () => {} }),
              };
            }
            if (tokenId.includes('sessionInteraction')) {
              return {
                listPending: () => [],
                acquireConsumer: () => undefined,
                releaseConsumer: () => undefined,
                onDidChangePending: () => ({ dispose: () => {} }),
                onDidResolve: () => ({ dispose: () => {} }),
              };
            }
            return undefined;
          },
        },
      };
    }

    mainHarness.liveHandles.set('sess-a', makeLiveHandle('sess-a', 'ws-a'));
    mainHarness.liveHandles.set('sess-b', makeLiveHandle('sess-b', 'ws-b'));
    mainHarness.acquireSession.mockImplementation(async (id: string) => {
      const handle = mainHarness.liveHandles.get(id);
      return handle === undefined ? undefined : ({ handle, dispose: async () => {} } as never);
    });

    const mainBroadcaster = new SessionEventBroadcaster({
      eventsDir: join(mainHarness.tempDir, 'events'),
      core: mainHarness.core,
    });
    const otherBroadcaster = new SessionEventBroadcaster({
      eventsDir: join(otherSpaceHarness.tempDir, 'events'),
      core: otherSpaceHarness.core,
    });
    cleanups.push(async () => {
      await mainBroadcaster.close();
      await otherBroadcaster.close();
    });

    const receivedA: EventEnvelope[] = [];
    const receivedB: EventEnvelope[] = [];
    const receivedUnattachedMain: EventEnvelope[] = [];
    const receivedOtherSpace: EventEnvelope[] = [];

    const targetA: BroadcastTarget = { send: (env) => receivedA.push(env) };
    const targetB: BroadcastTarget = { send: (env) => receivedB.push(env) };
    const targetUnattachedMain: BroadcastTarget = { send: (env) => receivedUnattachedMain.push(env) };
    const targetOtherSpace: BroadcastTarget = { send: (env) => receivedOtherSpace.push(env) };

    mainBroadcaster.addGlobalTarget(targetA);
    mainBroadcaster.addGlobalTarget(targetB);
    mainBroadcaster.addGlobalTarget(targetUnattachedMain);
    otherBroadcaster.addGlobalTarget(targetOtherSpace);

    expect(await mainBroadcaster.subscribe('sess-a', targetA)).toBe(true);
    expect(await mainBroadcaster.subscribe('sess-b', targetB)).toBe(true);

    const sessionTopic = mainHarness.port!.registerWsTopic({
      pluginId: 'alpha',
      topic: 'diagnostics',
      scopeAcl: 'session',
    });
    mainHarness.port!.registerWsTopic({
      pluginId: 'alpha',
      topic: 'space-feed',
      scopeAcl: 'space',
    });
    otherSpaceHarness.port!.registerWsTopic({
      pluginId: 'alpha',
      topic: 'space-feed',
      scopeAcl: 'space',
    });

    mainHarness.port!.publishWsTopicEvent({
      pluginId: 'alpha',
      topic: 'diagnostics',
      sessionId: 'sess-a',
      payload: { count: 3 },
    });

    await vi.waitFor(() => {
      expect(receivedA.filter((e) => e.type === 'event.plugin.topic')).toHaveLength(1);
    });
    expect(receivedB.filter((e) => e.type === 'event.plugin.topic')).toHaveLength(0);
    expect(receivedUnattachedMain.filter((e) => e.type === 'event.plugin.topic')).toHaveLength(0);
    expect((receivedA[0]?.payload as unknown as PluginWsTopicEvent).payload).toEqual({ count: 3 });

    mainHarness.port!.publishWsTopicEvent({
      pluginId: 'alpha',
      topic: 'space-feed',
      spaceId: 'space-other',
      payload: { leaked: true },
    });
    otherSpaceHarness.port!.publishWsTopicEvent({
      pluginId: 'alpha',
      topic: 'space-feed',
      spaceId: 'space-other',
      payload: { spaceOnly: 'other' },
    });

    await vi.waitFor(() => {
      expect(receivedOtherSpace.filter((e) => e.type === 'event.plugin.topic')).toHaveLength(1);
    });
    expect(receivedUnattachedMain.filter((e) => e.type === 'event.plugin.topic')).toHaveLength(0);

    await mainHarness.usage.set({ workspaceId: 'ws-b', pluginId: 'alpha', override: 'off' });
    mainHarness.port!.publishWsTopicEvent({
      pluginId: 'alpha',
      topic: 'diagnostics',
      sessionId: 'sess-b',
      payload: { blockedByUsage: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(receivedB.filter((e) => e.type === 'event.plugin.topic')).toHaveLength(0);

    sessionTopic.dispose();
    mainHarness.port!.publishWsTopicEvent({
      pluginId: 'alpha',
      topic: 'diagnostics',
      sessionId: 'sess-a',
      payload: { afterDispose: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(receivedA.filter((e) => e.type === 'event.plugin.topic')).toHaveLength(1);

    mainHarness.port!.registerWsTopic({
      pluginId: 'alpha',
      topic: 'diagnostics',
      scopeAcl: 'session',
    });
    mainHarness.pluginStates.set('alpha', makePluginSummary('alpha', { enabled: false }));
    mainHarness.eventService.publish({ type: 'event.plugin.changed', payload: { pluginId: 'alpha' } });

    mainHarness.port!.publishWsTopicEvent({
      pluginId: 'alpha',
      topic: 'diagnostics',
      sessionId: 'sess-a',
      payload: { afterDisable: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(receivedA.filter((e) => e.type === 'event.plugin.topic')).toHaveLength(1);
  });

  it('serves synthesized + dynamic E12 GUI slots and HTTP routes end-to-end from an installed plugin via PluginHostService', async () => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand, 'plugin');
    registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnDemand, 'plugin');
    registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnDemand, 'plugin');
    registerScopedService(LifecycleScope.App, IPluginUsageService, PluginUsageService, ScopeActivation.OnDemand, 'plugin');

    const root = await mkdtemp(join(tmpdir(), 'kap-plugin-e2e-'));
    const docs = new MemoryAtomicDocuments();
    const config: Record<string, unknown> = {};
    const port = new PluginExtensionPortRegistryService({} as never);
    const eventService = new InMemoryEventService();
    const workspaces = new Map<string, Workspace>([
      ['ws-a', makeWorkspace('ws-a')],
      ['ws-b', makeWorkspace('ws-b')],
    ]);
    const coldSessions = new Map<string, { readonly id: string; readonly workspaceId: string }>([
      ['sess-a', { id: 'sess-a', workspaceId: 'ws-a' }],
      ['sess-b', { id: 'sess-b', workspaceId: 'ws-b' }],
    ]);

    const scopedHost = createScopedTestHost([
      stubPair(ILogService, {
        _serviceBrand: undefined,
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child: function () { return this; },
      } as unknown as ILogService),
      stubPair(IFlagService, { enabled: () => true } as unknown as IFlagService),
      stubPair(IBootstrapService, {
        _serviceBrand: undefined,
        homeDir: join(root, 'home'),
        osHomeDir: join(root, 'user'),
        spaceId: 'main',
        getEnv: () => undefined,
      } as unknown as IBootstrapService),
      stubPair(IProviderService, {} as IProviderService),
      stubPair(IModelCatalog, { _serviceBrand: undefined, listModels: async () => [], listProviders: async () => [] } as unknown as IModelCatalog),
      stubPair(IOAuthService, {} as IOAuthService),
      stubPair(IRequestIdentityCatalog, {} as IRequestIdentityCatalog),
      stubPair(ISessionManager, {
        list: () => [],
        get: () => undefined,
        onDidCreateSession: Event.None,
        onDidCloseSession: Event.None,
        onDidArchiveSession: Event.None,
      } as unknown as ISessionManager),
      stubPair(IConfigService, {
        ready: Promise.resolve(),
        get: (key: string) => config[key] ?? {},
        replace: async (key: string, value: unknown) => { config[key] = value; },
        onDidSectionChange: Event.None,
      } as unknown as IConfigService),
      stubPair(IAtomicDocumentStore, docs as unknown as IAtomicDocumentStore),
      stubPair(ISkillDiscovery, { _serviceBrand: undefined, discover: async () => ({ skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }) } satisfies ISkillDiscovery),
      stubPair(IPluginExtensionPortRegistry, port),
      stubPair(ISessionIndex, { get: async (id: string) => coldSessions.get(id) } as unknown as ISessionIndex),
      stubPair(IWorkspaceService, { get: async (id: string) => workspaces.get(id) } as unknown as IWorkspaceService),
      stubPair(IEventService, eventService as unknown as IEventService),
    ]);

    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    app.addHook(
      'onRequest',
      createAuthHook({
        isValid: async (candidate: string) => candidate === SERVER_TOKEN,
      } as never),
    );
    await app.register(
      async (api) => {
        registerPluginsRoutes(api as never, scopedHost.app, {
          marketplaceUrl: () => undefined,
          serverToken: () => SERVER_TOKEN,
        });
        registerPluginBrokerRoutes(api as never, scopedHost.app);
      },
      { prefix: '/api' },
    );
    await app.ready();

    cleanups.push(async () => {
      await scopedHost.app.accessor.get(IPluginHostService).stopAll();
      port.dispose();
      await scopedHost.dispose();
      await app.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const pluginService = scopedHost.app.accessor.get(IPluginService);
    const pluginHosts = scopedHost.app.accessor.get(IPluginHostService);
    const usage = scopedHost.app.accessor.get(IPluginUsageService);
    await pluginHosts.ready;

    const source = join(root, 'kiki-phone');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'preview.html'), '<h1>Phone Preview</h1>');
    await writeFile(join(source, 'entry.mjs'), `
      export function register() {}
      export const slots = {
        'E12:server-gui-slots': async (payload) => {
          if (payload?.kind === 'describe') {
            return {
              guiSlots: [
                {
                  slot: 'composer-toolbar',
                  id: 'phone-quick-open',
                  label: { default: 'Phone', zh: '手机' },
                  action: { kind: 'open_plugin_panel', panelId: 'preview' },
                },
              ],
              routes: [
                { method: 'POST', subpath: '/device/tap', scopeAcl: 'session' },
                { method: 'POST', subpath: '/device/space-ping', scopeAcl: 'space' },
              ],
            };
          }
          if (payload?.kind === 'http-route' && payload.method === 'POST' && (payload.subpath === '/device/tap' || payload.subpath === '/device/space-ping')) {
            return {
              status: 200,
              data: {
                tapped: payload.body,
                workspaceId: payload.scope.workspaceId,
                sessionId: payload.scope.sessionId,
              },
            };
          }
          return { status: 404, errorMessage: 'unknown route' };
        },
      };
    `);
    await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({
      name: 'kiki-phone',
      version: '0.2.0',
      'x-kiki': {
        engines: { kiki: '^0.4.3' },
        entry: './entry.mjs',
        permissions: { uiPanel: true },
        panels: [{ schemaVersion: 1, id: 'preview', label: 'Kiki Phone', slot: 'sidebar', path: './preview.html' }],
        slots: ['E12:server-gui-slots'],
      },
    }));

    const plan = await pluginService.previewPlugin({ source });
    await pluginService.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });

    const installedInfoRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/kiki-phone',
      headers: authHeaders(),
    });
    expect(installedInfoRes.json()).toMatchObject({
      code: 0,
      data: { id: 'kiki-phone', enabled: true, globalEnabled: false, defaultEnabled: false },
    });

    const blockedSlotsRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/gui-slots?workspace_id=ws-a',
      headers: authHeaders(),
    });
    expect(blockedSlotsRes.json()).toMatchObject({
      code: 0,
      data: { slots: [] },
    });

    await usage.set({ workspaceId: 'ws-a', pluginId: 'kiki-phone', override: 'on' });

    await vi.waitFor(() => {
      expect(port.resolveHttpRoute('kiki-phone', 'POST', '/device/tap')).toBeDefined();
    });

    const allowedSlotsRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/gui-slots?workspace_id=ws-a',
      headers: authHeaders(),
    });
    const allowedSlotsBody = allowedSlotsRes.json() as { code: number; data: ListPluginGuiSlotsResponse };
    expect(allowedSlotsBody.code).toBe(0);
    expect(allowedSlotsBody.data.slots.map((slot) => `${slot.slot}:${slot.id}`).toSorted()).toEqual([
      'composer-toolbar:phone-quick-open',
      'sidebar-panel:panel:preview',
    ]);

    const tapAllowedRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/kiki-phone/routes/device/tap?session_id=sess-a',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ x: 540, y: 1200 }),
    });
    expect(tapAllowedRes.json()).toMatchObject({
      code: 0,
      data: {
        tapped: { x: 540, y: 1200 },
        workspaceId: 'ws-a',
        sessionId: 'sess-a',
      },
    });

    const tapBlockedRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/kiki-phone/routes/device/tap?session_id=sess-b',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ x: 100, y: 200 }),
    });
    expect(tapBlockedRes.json()).toMatchObject({
      code: ErrorCode.FS_PERMISSION_DENIED,
    });

    const mismatchWorkspaceRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/kiki-phone/routes/device/space-ping?workspace_id=ws-a&session_id=sess-b',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ ping: true }),
    });
    expect(mismatchWorkspaceRes.json()).toMatchObject({
      code: ErrorCode.FS_PERMISSION_DENIED,
    });

    const spaceRouteWithWorkspaceOnlyRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/kiki-phone/routes/device/space-ping?workspace_id=ws-a',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ ping: true }),
    });
    expect(spaceRouteWithWorkspaceOnlyRes.json()).toMatchObject({
      code: 0,
      data: {
        tapped: { ping: true },
        workspaceId: 'ws-a',
      },
    });

    const explicitlyGlobalRes = await app.inject({
      method: 'POST',
      url: '/api/plugins/kiki-phone:enable',
      headers: authHeaders(),
    });
    expect(explicitlyGlobalRes.json()).toMatchObject({ code: 0 });
    const enabledInfoRes = await app.inject({
      method: 'GET',
      url: '/api/plugins/kiki-phone',
      headers: authHeaders(),
    });
    expect(enabledInfoRes.json()).toMatchObject({
      code: 0,
      data: { globalEnabled: true, defaultEnabled: true },
    });
  });
});
