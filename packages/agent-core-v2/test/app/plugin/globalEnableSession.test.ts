import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { TestInstantiationService } from '#/_base/di/testInstantiationService';
import { Event } from '#/_base/event';
import { _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { PluginUsageService } from '#/app/pluginUsage/pluginUsageService';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { AgentPluginToolService } from '#/agent/userTool/pluginToolService';
import type { IAgentPluginMediaService } from '#/agent/pluginMedia/pluginMedia';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { IPluginHostService } from '#/app/plugin/pluginHostService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionPluginUsageService, SessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionSkillCatalogData } from '#/session/sessionSkillCatalog/skillCatalogData';
import { SessionSkillCatalogService } from '#/session/sessionSkillCatalog/skillCatalogService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { ExecutableTool } from '#/tool/toolContract';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { stubSkill } from '../skillCatalog/stubs';

const PLUGIN_ID = 'kiki-media';
const TOOL_NAME = 'plugin__kiki_media__generate';
const SKILL_NAME = 'media-generate';

class MemoryDocuments {
  readonly values = new Map<string, { readonly revision: number; readonly overrides: Record<string, boolean> }>();
  async get<T>(_scope: string, key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async set<T>(_scope: string, key: string, value: T): Promise<void> {
    this.values.set(key, value as { readonly revision: number; readonly overrides: Record<string, boolean> });
  }
}

describe('globally enabled plugin registration on a new session', () => {
  const containers: TestInstantiationService[] = [];
  const directories: string[] = [];

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, ISessionStateService, SessionStateService);
    registerScopedService(LifecycleScope.Session, ISessionSkillCatalog, SessionSkillCatalogService);
  });

  afterEach(async () => {
    for (const container of containers.splice(0)) await container.dispose();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it('registers the tool and the skill, then drops both on an explicit session off', async () => {
    const documents = new MemoryDocuments();
    const container = new TestInstantiationService();
    container.set(IAtomicDocumentStore, documents as unknown as IAtomicDocumentStore);
    container.set(IFlagService, { enabled: () => true } as unknown as IFlagService);
    container.set(IPluginUsageService, new SyncDescriptor(PluginUsageService));
    containers.push(container);
    const usage = container.get(IPluginUsageService);
    usage.registerPluginStateReader(() => ({ allowed: true, globalEnabled: true }));

    const skill = stubSkill(SKILL_NAME, {
      source: 'extra',
      plugin: { id: PLUGIN_ID, instructions: 'Generate images, video and speech.' },
      sourceRoot: '/plugins/kiki-media/skills',
    });
    const plugins = {
      onDidReload: Event.None,
      hasLoadedSnapshot: () => true,
      getPluginInfo: async ({ id }: { id: string }) => ({ id, enabled: true, state: 'ok' as const }),
      pluginSkillRoots: async (workspaceId?: string, sessionId?: string) => (
        await usage.allows(workspaceId, PLUGIN_ID, sessionId)
          ? [{ path: '/plugins/kiki-media/skills', source: 'extra' as const, plugin: { id: PLUGIN_ID } }]
          : []
      ),
    } as unknown as IPluginService;
    const discovery: ISkillDiscovery = {
      _serviceBrand: undefined,
      discover: async (roots) => roots.length === 0
        ? { skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }
        : { skills: [skill], skipped: [], scannedRoots: ['/plugins/kiki-media/skills'], scannedDirectories: [] },
    };

    const open = (sessionId: string) => {
      const host = createScopedTestHost([]);
      const session = host.child(LifecycleScope.Session, sessionId, [
        stubPair(ISessionSkillCatalogData, {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          onDidChange: Event.None,
          catalog: { listSkills: () => [], getSkillRoots: () => [], getSkippedByPolicy: () => [] },
        } as unknown as ISessionSkillCatalogData),
        stubPair(IWorkspaceStateService, new WorkspaceStateService()),
        stubPair(ISessionContext, makeSessionContext({
          sessionId,
          workspaceId: 'workspace-a',
          sessionDir: '',
          cwd: '',
          sessionScope: `workspace-a/${sessionId}`,
        })),
        stubPair(IPluginService, plugins),
        stubPair(IPluginUsageService, usage),
        stubPair(ISkillDiscovery, discovery),
      ]);
      return { host, catalog: session.accessor.get(ISessionSkillCatalog) };
    };

    const workspace = await mkdtemp(path.join(tmpdir(), 'kiki-global-enable-'));
    directories.push(workspace);
    const toolsFor = (sessionId: string) => {
      const tools = new Map<string, ExecutableTool>();
      const registry = {
        register: (tool: ExecutableTool) => {
          tools.set(tool.name, tool);
          return { dispose: () => { tools.delete(tool.name); } };
        },
        resolve: (name: string) => tools.get(name),
        registerPreparation: () => ({ dispose() {} }),
        prepare: async () => {},
      } as unknown as IAgentToolRegistryService;
      const runtime = new FakeRuntime(
        { workspaceId: 'w', runtimeId: 'local', generation: '1' },
        { pathClass: process.platform === 'win32' ? 'win32' : 'posix' },
      );
      Object.assign(runtime, { fs: new HostFileSystem() });
      const service = new AgentPluginToolService(
        plugins,
        { list: async () => [{ pluginId: PLUGIN_ID, definition: {
          schemaVersion: 1, name: 'generate', description: 'Generate an image, video, or speech file.', accesses: [],
        } }] } as unknown as IPluginHostService,
        registry,
        { inspect: () => runtime, acquire: () => ({ runtime, dispose() {} }) } as unknown as IAgentRuntimeService,
        { workDir: workspace, additionalDirs: [] } as unknown as ISessionWorkspaceContext,
        { getModelCapabilities: () => ({ image_in: true }) } as unknown as IAgentProfileService,
        undefined as IAgentPluginMediaService | undefined,
        usage,
        { workspaceId: 'workspace-a', sessionId } as ISessionContext,
      );
      return { service, tools };
    };

    const admitted = open('session-new');
    const other = open('session-other');
    const admittedTools = toolsFor('session-new');
    const otherTools = toolsFor('session-other');
    try {
      await Promise.all([
        admitted.catalog.load(),
        other.catalog.load(),
        admittedTools.service.ready(),
        otherTools.service.ready(),
      ]);
      expect(admitted.catalog.catalog.getSkill(SKILL_NAME)?.plugin?.id).toBe(PLUGIN_ID);
      expect(other.catalog.catalog.getSkill(SKILL_NAME)?.plugin?.id).toBe(PLUGIN_ID);
      expect(admittedTools.tools.has(TOOL_NAME)).toBe(true);
      expect(otherTools.tools.has(TOOL_NAME)).toBe(true);

      const sessionContainer = new TestInstantiationService();
      sessionContainer.set(IAtomicDocumentStore, documents as unknown as IAtomicDocumentStore);
      sessionContainer.set(IPluginUsageService, usage);
      sessionContainer.set(IPluginService, plugins);
      sessionContainer.set(ISessionContext, { workspaceId: 'workspace-a', sessionId: 'session-new' } as ISessionContext);
      sessionContainer.set(ISessionPluginUsageService, new SyncDescriptor(SessionPluginUsageService));
      containers.push(sessionContainer);
      await sessionContainer.get(ISessionPluginUsageService).set(PLUGIN_ID, 'off');

      expect(admitted.catalog.catalog.getSkill(SKILL_NAME)).toBeUndefined();
      expect(admittedTools.tools.has(TOOL_NAME)).toBe(false);
      expect(other.catalog.catalog.getSkill(SKILL_NAME)?.plugin?.id).toBe(PLUGIN_ID);
      expect(otherTools.tools.has(TOOL_NAME)).toBe(true);
    } finally {
      await admittedTools.service.dispose();
      await otherTools.service.dispose();
      await admitted.host.dispose();
      await other.host.dispose();
    }
  });
});
