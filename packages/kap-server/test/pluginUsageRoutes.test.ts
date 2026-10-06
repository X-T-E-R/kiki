import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { IPluginHostService } from '@kiki/agent-core-v2';
import { registerPluginsRoutes } from '../src/routes/plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IBootstrapService,
  IPluginService,
  IPluginUsageService,
  ISessionIndex,
  IWorkspaceService,
  type PluginInfo,
  type PluginSummary,
  type Scope,
  type Workspace,
} from '@kiki/agent-core-v2';
import { PluginUsageService } from '@kiki/agent-core-v2/app/pluginUsage/pluginUsageService';
import type { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { ErrorCode, type PluginUsageResponse } from '@kiki/protocol';

import { registerPluginUsageRoutes } from '../src/routes/pluginUsage';

type StoredValue = { readonly revision: number; readonly overrides: Record<string, boolean> };

class MemoryDocuments {
  readonly values = new Map<string, StoredValue>();

  async get<T>(_scope: string, key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(_scope: string, key: string, value: T): Promise<void> {
    this.values.set(key, value as StoredValue);
  }
}

function workspace(id: string): Workspace {
  return {
    id,
    root: `C:/workspace/${id}`,
    name: id,
    createdAt: 1,
    lastOpenedAt: 2,
    pinned: false,
  };
}

function summary(
  id: string,
  options: { readonly enabled?: boolean; readonly state?: 'ok' | 'error' } = {},
): PluginSummary {
  const state = options.state ?? 'ok';
  return {
    id,
    displayName: id,
    version: '1.0.0',
    enabled: options.enabled ?? true,
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

function info(record: PluginSummary): PluginInfo {
  return {
    ...record,
    root: `C:/plugins/${record.id}`,
    installedAt: '2026-01-01T00:00:00.000Z',
    mcpServers: [],
    diagnostics: record.state === 'error'
      ? [{ severity: 'error', message: 'invalid manifest' }]
      : [],
  };
}

describe('plugin usage routes', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const services: PluginUsageService[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const service of services.splice(0)) await service.dispose();
  });

  function createRoute(options: { readonly enabled?: boolean } = {}) {
    const app = Fastify();
    apps.push(app);
    const docs = new MemoryDocuments();
    const usage = new PluginUsageService(
      docs as unknown as IAtomicDocumentStore,
      { enabled: () => options.enabled ?? true } as never,
    );
    services.push(usage);

    const installed = [
      summary('demo'),
      summary('home-off', { enabled: false }),
      summary('broken', { state: 'error' }),
    ];
    const byId = new Map(installed.map((plugin) => [plugin.id, info(plugin)]));
    const workspaces = new Map([
      ['workspace-a', workspace('workspace-a')],
      ['workspace-b', workspace('workspace-b')],
    ]);
    const getWorkspace = vi.fn(async (id: string) => workspaces.get(id));
    const createOrTouch = vi.fn();
    const getSession = vi.fn(async (id: string) =>
      id === 'cold-session' ? { id, workspaceId: 'workspace-a' } : undefined,
    );
    const plugins = {
      listPlugins: vi.fn(async () => installed),
      getPluginInfo: vi.fn(async ({ id }: { readonly id: string }) => byId.get(id)!),
    } as unknown as IPluginService;
    const servicesByToken = new Map<unknown, unknown>([
      [IBootstrapService, { homeDir: 'C:/home', spaceId: 'main' }],
      [IPluginService, plugins],
      [IPluginUsageService, usage],
      [ISessionIndex, { get: getSession }],
      [IWorkspaceService, { get: getWorkspace, createOrTouch }],
    ]);
    const core = {
      accessor: {
        get<T>(token: unknown): T {
          return servicesByToken.get(token) as T;
        },
      },
    } as unknown as Scope;
    registerPluginUsageRoutes(
      app as unknown as Parameters<typeof registerPluginUsageRoutes>[0],
      core,
    );
    return { app, getWorkspace, getSession, createOrTouch, plugins, core, servicesByToken, byId, usage };
  }

  it('reads a cold session target without resuming or creating a workspace', async () => {
    const { app, getWorkspace, getSession, createOrTouch } = createRoute();

    const response = await app.inject({
      method: 'GET',
      url: '/plugins/usage?session_id=cold-session',
    });
    const body = response.json() as { code: number; data: PluginUsageResponse };

    expect(response.statusCode).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.target.workspace_id).toBe('workspace-a');
    expect(getSession).toHaveBeenCalledWith('cold-session');
    expect(getWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(createOrTouch).not.toHaveBeenCalled();
  });

  it('applies an off override only to its target workspace and keeps home-disabled plugins off', async () => {
    const { app } = createRoute();

    const off = await app.inject({
      method: 'POST',
      url: '/plugins/usage',
      payload: { target: { workspace_id: 'workspace-a' }, plugin_id: 'demo', override: 'off' },
    });
    const offBody = off.json() as { code: number; data: PluginUsageResponse };
    expect(offBody.code).toBe(0);
    expect(offBody.data.plugins.find((plugin) => plugin.id === 'demo')).toMatchObject({
      home_enabled: true,
      override: 'off',
      effective: false,
      reason: 'workspace_disabled',
    });

    const other = await app.inject({
      method: 'GET',
      url: '/plugins/usage?workspace_id=workspace-b',
    });
    const otherBody = other.json() as { code: number; data: PluginUsageResponse };
    expect(otherBody.data.plugins.find((plugin) => plugin.id === 'demo')).toMatchObject({
      override: 'inherit',
      effective: true,
    });

    const homeOff = await app.inject({
      method: 'POST',
      url: '/plugins/usage',
      payload: { target: { workspace_id: 'workspace-a' }, plugin_id: 'home-off', override: 'on' },
    });
    const homeOffBody = homeOff.json() as { code: number; data: PluginUsageResponse };
    expect(homeOffBody.data.plugins.find((plugin) => plugin.id === 'home-off')).toMatchObject({
      home_enabled: false,
      override: 'on',
      effective: false,
      reason: 'home_disabled',
    });
  });

  it('restores inherit, exposes installed errors, and rejects unknown plugins', async () => {
    const { app } = createRoute();

    await app.inject({
      method: 'POST',
      url: '/plugins/usage',
      payload: { target: { workspace_id: 'workspace-a' }, plugin_id: 'demo', override: 'off' },
    });
    const restored = await app.inject({
      method: 'POST',
      url: '/plugins/usage',
      payload: { target: { workspace_id: 'workspace-a' }, plugin_id: 'demo', override: 'inherit' },
    });
    const restoredBody = restored.json() as { code: number; data: PluginUsageResponse };
    expect(restoredBody.data.plugins.find((plugin) => plugin.id === 'demo')).toMatchObject({
      override: 'inherit',
      effective: true,
    });
    expect(restoredBody.data.plugins.find((plugin) => plugin.id === 'broken')).toMatchObject({
      state: 'error',
      effective: false,
      reason: 'invalid_plugin',
    });

    const unknown = await app.inject({
      method: 'POST',
      url: '/plugins/usage',
      payload: { target: { workspace_id: 'workspace-a' }, plugin_id: 'missing', override: 'off' },
    });
    expect(unknown.json().code).toBe(ErrorCode.PLUGIN_NOT_FOUND);
  });

  it('gates workspace panel documents, late bridges and commands without stopping sidebar services', async () => {
    const { app, core, byId, plugins, servicesByToken, usage, getSession, createOrTouch } = createRoute();
    const root = await mkdtemp(join(tmpdir(), 'plugin-panels-'));
    const file = join(root, 'panel.html');
    await writeFile(file, '<html><body>Example panel</body></html>');
    const record = byId.get('demo')!;
    byId.set('demo', { ...record, root, manifest: { name: 'demo', version: '1.0.0', kiki: { panels: [
      { schemaVersion: 1, id: 'work', label: 'Workspace', slot: 'workspace', path: './panel.html', file, assetFiles: {} },
      { schemaVersion: 1, id: 'side', label: 'Service', slot: 'sidebar', path: './panel.html', file, assetFiles: {} },
    ] } } as PluginInfo['manifest'] });
    const requestPanel = vi.fn(async () => 'service-result');
    servicesByToken.set(IPluginHostService, { requestPanel });
    getSession.mockImplementation(async (id: string) => id === 'cold-session' ? { id, workspaceId: 'workspace-a' }
      : id === 'other-session' ? { id, workspaceId: 'workspace-b' } : undefined);
    plugins.listPluginCommands = vi.fn(async (workspaceId?: string) => workspaceId !== undefined && !await usage.allows(workspaceId, 'demo') ? []
      : [{ pluginId: 'demo', name: 'example', description: 'Example', body: 'Example prompt', path: 'example.md' }]);
    registerPluginsRoutes(app as unknown as Parameters<typeof registerPluginsRoutes>[0], core, { marketplaceUrl: () => undefined, serverToken: () => 'test-token' });
    try {
      const document = '/plugins/demo/panels/work/document';
      expect((await app.inject({ method: 'GET', url: `${document}?session_id=cold-session` })).json().code).toBe(0);
      await usage.set({ workspaceId: 'workspace-a', pluginId: 'demo', override: 'off' });
      const panels = (await app.inject({ method: 'GET', url: '/plugins/panels?session_id=cold-session' })).json();
      expect(panels.data.panels.map((panel: { id: string }) => panel.id)).toEqual(['side']);
      expect((await app.inject({ method: 'GET', url: `${document}?session_id=cold-session` })).json().code).toBe(ErrorCode.PLUGIN_NOT_FOUND);
      expect((await app.inject({ method: 'POST', url: '/plugins/demo/panels/work/bridge', payload: { method: 'plugin.call', session_id: 'cold-session', action: 'inspect', args: {} } })).json().code).toBe(ErrorCode.PLUGIN_NOT_FOUND);
      expect(requestPanel).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'GET', url: `${document}?session_id=other-session` })).json().code).toBe(0);
      expect((await app.inject({ method: 'POST', url: '/plugins/demo/panels/work/bridge', payload: { method: 'plugin.call', session_id: 'other-session', action: 'inspect', args: {} } })).json().code).toBe(0);
      expect((await app.inject({ method: 'POST', url: '/plugins/demo/panels/side/bridge', payload: { method: 'plugin.call', action: 'inspect', args: {} } })).json().code).toBe(0);
      expect(requestPanel).toHaveBeenCalledTimes(2);
      expect((await app.inject({ method: 'GET', url: '/plugins/commands?session_id=cold-session' })).json().data.commands).toEqual([]);
      expect((await app.inject({ method: 'GET', url: '/plugins/commands?session_id=other-session' })).json().data.commands).toHaveLength(1);
      for (const path of ['/plugins/panels', '/plugins/commands', document]) {
        const invalid = (await app.inject({ method: 'GET', url: `${path}?workspace_id=missing` })).json();
        expect(invalid.code, `${path}: ${JSON.stringify(invalid)}`).toBe(ErrorCode.VALIDATION_FAILED);
      }
      expect(createOrTouch).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns capability unsupported for both operations when the flag is off', async () => {
    const { app } = createRoute({ enabled: false });

    const read = await app.inject({ method: 'GET', url: '/plugins/usage?workspace_id=workspace-a' });
    expect(read.json().code).toBe(ErrorCode.CAPABILITY_UNSUPPORTED);

    const write = await app.inject({
      method: 'POST',
      url: '/plugins/usage',
      payload: { target: { workspace_id: 'workspace-a' }, plugin_id: 'demo', override: 'off' },
    });
    expect(write.json().code).toBe(ErrorCode.CAPABILITY_UNSUPPORTED);
  });
});
