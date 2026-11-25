import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { parseDaemonFileUrl } from '#/agent/media/mediaRef';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentRemoteToolService } from '#/agent/remoteTools/agentRemoteToolService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TOOL_SELECT_FLAG_ENV } from '#/agent/toolSelect/flag';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { IAgentToolSelectSchemasService } from '#/agent/toolSelect/toolSelectSchemas';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import {
  IRemoteSpaceToolBridgeService,
  REMOTE_SPACE_TOOL_ROUTER,
  remoteSpaceToolCapability,
  type CallRemoteSpaceToolInput,
  type ListRemoteSpaceToolsInput,
  type RemoteBorrowedSpaceCatalog,
  type RemoteSpaceToolConnector,
} from '#/app/remoteTools/remoteSpaceToolBridge';
import { RemoteSpaceToolBridgeService } from '#/app/remoteTools/remoteSpaceToolBridgeService';
import { IConfigService } from '#/app/config/config';
import { MEMORY_SECTION, type MemoryConfig } from '#/app/memory/configSection';
import { THREAD_COMMUNICATION_SECTION } from '#/app/threadCommunication/configSection';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { createTestAgent, type TestAgentContext } from '../../harness';

const OPENAI_PROVIDER = {
  type: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.test/v1',
  model: 'mock-openai-model',
} as const;

const DISCLOSURE_CAPABILITIES = {
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 128_000,
  dynamically_loaded_tools: true,
} as const;

const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function selectToolsCall(id: string, names: readonly string[]) {
  return {
    type: 'function' as const,
    id,
    name: 'SelectTools',
    arguments: JSON.stringify({ names }),
  };
}

function historyText(history: readonly ContextMessage[]): string {
  return history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

async function closeMemoryAndThread(agent: TestAgentContext): Promise<void> {
  const config = agent.get(IConfigService);
  await config.replace(MEMORY_SECTION, {
    enabled: false,
    approval: 'auto',
    budget: 2_000,
    workspaces: {},
  } satisfies MemoryConfig);
  await config.replace(THREAD_COMMUNICATION_SECTION, { enabled: false });
}

describe('RemoteSpaceToolBridgeService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks connector attachment, caches per workspace session with 15s TTL, coalesces concurrent reads, and falls back on rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));

    const bridge = new RemoteSpaceToolBridgeService();
    const capability = remoteSpaceToolCapability(bridge);
    const changeListener = vi.fn();
    bridge.onDidChange(changeListener);

    expect(bridge.hasConnector()).toBe(false);
    await expect(
      bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-1' } }),
    ).resolves.toEqual([]);
    await expect(
      bridge.callBorrowedTool({
        bridgeId: 'b-1',
        connectionId: 'c-1',
        caller: { workspaceId: 'ws-a', sessionId: 's-1' },
        remoteName: 'ping',
        arguments: {},
        callId: 'call-1',
      }),
    ).rejects.toThrow('Remote space tool connector is unavailable.');

    const initialCatalogs: RemoteBorrowedSpaceCatalog[] = [
      {
        bridgeId: 'b-1',
        connectionId: 'c-1',
        spaceLabel: 'Lab Workstation',
        platform: 'linux',
        tools: [
          {
            remoteName: 'mcp:fs:list',
            kind: 'mcp',
            serverName: 'fs',
            toolName: 'list',
            description: 'List files.',
          },
        ],
      },
    ];
    let currentCatalogs: readonly RemoteBorrowedSpaceCatalog[] = initialCatalogs;
    let pendingResolve: ((value: readonly RemoteBorrowedSpaceCatalog[]) => void) | undefined;
    let deferList = false;

    const listSpy = vi.fn(async (_input: ListRemoteSpaceToolsInput) => {
      if (deferList) {
        return new Promise<readonly RemoteBorrowedSpaceCatalog[]>((resolve) => {
          pendingResolve = resolve;
        });
      }
      return currentCatalogs;
    });
    const callSpy = vi.fn(async (input: CallRemoteSpaceToolInput) => ({
      output: `called ${input.remoteName}`,
    }));
    const connector: RemoteSpaceToolConnector = {
      listBorrowedTools: listSpy,
      callBorrowedTool: callSpy,
    };

    capability[REMOTE_SPACE_TOOL_ROUTER](connector);
    expect(bridge.hasConnector()).toBe(true);
    expect(changeListener).toHaveBeenCalledTimes(1);

    deferList = true;
    const p1 = bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-1' } });
    const p2 = bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-1' } });
    expect(listSpy).toHaveBeenCalledTimes(1);
    pendingResolve!(initialCatalogs);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(initialCatalogs);
    expect(r2).toEqual(initialCatalogs);

    deferList = false;
    await expect(
      bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-1' } }),
    ).resolves.toEqual(initialCatalogs);
    expect(listSpy).toHaveBeenCalledTimes(1);

    await bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-2' } });
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(listSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ caller: { workspaceId: 'ws-a', sessionId: 's-2' } }),
    );

    await bridge.listBorrowedTools({ caller: { workspaceId: 'ws-b', sessionId: 's-1' } });
    expect(listSpy).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(15_001);
    await bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-1' } });
    expect(listSpy).toHaveBeenCalledTimes(4);

    const updatedCatalogs: RemoteBorrowedSpaceCatalog[] = [
      {
        bridgeId: 'b-1',
        connectionId: 'c-1',
        spaceLabel: 'Lab Workstation',
        platform: 'linux',
        tools: [
          {
            remoteName: 'mcp:fs:read',
            kind: 'mcp',
            serverName: 'fs',
            toolName: 'read',
            description: 'Read file.',
          },
        ],
      },
    ];
    currentCatalogs = updatedCatalogs;
    capability.notifyChanged();
    expect(changeListener).toHaveBeenCalledTimes(2);
    await expect(
      bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-1' } }),
    ).resolves.toEqual(updatedCatalogs);
    expect(listSpy).toHaveBeenCalledTimes(5);

    capability.notifyChanged();
    listSpy.mockRejectedValueOnce(new Error('transient tunnel drop'));
    await expect(
      bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-1' } }),
    ).resolves.toEqual(updatedCatalogs);

    listSpy.mockRejectedValueOnce(new Error('no prior cache'));
    await expect(
      bridge.listBorrowedTools({ caller: { workspaceId: 'ws-never-cached', sessionId: 's-8' } }),
    ).resolves.toEqual([]);

    await expect(
      bridge.callBorrowedTool({
        bridgeId: 'b-1',
        connectionId: 'c-1',
        caller: { workspaceId: 'ws-a', sessionId: 's-1' },
        remoteName: 'mcp:fs:read',
        arguments: { path: '/tmp/a.txt' },
        callId: 'call-2',
      }),
    ).resolves.toEqual({ output: 'called mcp:fs:read' });
    expect(callSpy).toHaveBeenCalledTimes(1);

    capability[REMOTE_SPACE_TOOL_ROUTER](undefined);
    expect(bridge.hasConnector()).toBe(false);
    await expect(
      bridge.listBorrowedTools({ caller: { workspaceId: 'ws-a', sessionId: 's-9' } }),
    ).resolves.toEqual([]);

    bridge.dispose();
  });
});

describe('AgentRemoteToolService & progressive disclosure integration', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
    ctx = createTestAgent();
    await closeMemoryAndThread(ctx);
    ctx.get(IAgentToolSelectService);
    ctx.get(IAgentToolSelectAnnouncementsService);
    ctx.get(IAgentToolSelectSchemasService);
    ctx.get(IAgentToolExecutorService);
    ctx.get(IAgentRemoteToolService);
    ctx.configure({ provider: OPENAI_PROVIDER, modelCapabilities: DISCLOSURE_CAPABILITIES });
    await ctx.rpc.setPermission({ mode: 'yolo' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await ctx.dispose();
  });

  it('discovers remote plugin & MCP tools dynamically, dispatches through SelectTools & CallTool, and removes them on disconnect', async () => {
    const bridge = ctx.get(IRemoteSpaceToolBridgeService);
    const capability = remoteSpaceToolCapability(bridge);
    const callSpy = vi.fn(async (input: CallRemoteSpaceToolInput) => ({
      output: `result:${input.remoteName}:${String(input.arguments['q'] ?? '')}`,
    }));

    let activeCatalogs: readonly RemoteBorrowedSpaceCatalog[] = [
      {
        bridgeId: 'bridge-lab',
        connectionId: 'conn-lab-1',
        spaceLabel: 'Lab Workstation',
        platform: 'linux',
        tools: [
          {
            remoteName: 'plugin:notes:notes_search',
            kind: 'plugin',
            pluginId: 'notes',
            toolName: 'notes_search',
            description: 'Search remote lab notes.',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
              additionalProperties: false,
            },
            concurrencySafe: true,
          },
        ],
      },
      {
        bridgeId: 'bridge-cloud',
        connectionId: 'conn-cloud-1',
        spaceLabel: 'Cloud Runner',
        platform: 'win32',
        tools: [
          {
            remoteName: 'mcp:browser:open',
            kind: 'mcp',
            serverName: 'browser',
            toolName: 'open',
            description: 'Open URL in remote runner.',
            parameters: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
              additionalProperties: false,
            },
          },
        ],
      },
    ];

    capability[REMOTE_SPACE_TOOL_ROUTER]({
      listBorrowedTools: async () => activeCatalogs,
      callBorrowedTool: callSpy,
    });
    await ctx.get(IAgentRemoteToolService).ready();

    const pluginToolName = 'plugin__remote_lab_workstat__notes_search';
    const mcpToolName = 'mcp__remote_cloud_runner__browser_open';

    const registry = ctx.get(IAgentToolRegistryService);
    const pluginInfo = registry.list().find((entry) => entry.name === pluginToolName);
    const mcpInfo = registry.list().find((entry) => entry.name === mcpToolName);
    expect(pluginInfo).toMatchObject({
      name: pluginToolName,
      source: 'plugin',
      disclosure: 'deferred',
      description: '[Remote space: Lab Workstation (Linux)] Search remote lab notes.',
    });
    expect(mcpInfo).toMatchObject({
      name: mcpToolName,
      source: 'mcp',
      disclosure: 'deferred',
      description: '[Remote space: Cloud Runner (Windows)] Open URL in remote runner.',
    });

    const pluginExec = await registry.resolve(pluginToolName)!.resolveExecution({ q: 'hello' });
    const mcpExec = await registry.resolve(mcpToolName)!.resolveExecution({ url: 'https://example.test' });
    expect('isError' in pluginExec && pluginExec.isError).toBe(false);
    expect('isError' in mcpExec && mcpExec.isError).toBe(false);
    if (!('isError' in pluginExec && pluginExec.isError)) {
      expect(pluginExec.accesses).toEqual([{ kind: 'all', operation: 'read' }]);
      expect(pluginExec.approvalRule).toBe(pluginToolName);
    }
    if (!('isError' in mcpExec && mcpExec.isError)) {
      expect(mcpExec.accesses).toEqual([{ kind: 'all' }]);
      expect(mcpExec.approvalRule).toBe(mcpToolName);
    }

    ctx.mockNextResponse(selectToolsCall('sel-1', [pluginToolName]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call-remote-1',
      name: 'CallTool',
      arguments: JSON.stringify({ name: pluginToolName, arguments: { q: 'quantum' } }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'Found remote notes.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Search lab notes for quantum' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);
    const firstHistory = historyText(ctx.llmCalls[0]!.history);
    expect(firstHistory).toContain('<tools_added>');
    expect(firstHistory).toContain(pluginToolName);
    expect(firstHistory).toContain(mcpToolName);
    expect(ctx.llmCalls[0]!.tools.some((t) => t.name === 'SelectTools')).toBe(true);
    expect(ctx.llmCalls[0]!.tools.some((t) => t.name === 'CallTool')).toBe(true);
    expect(ctx.llmCalls[0]!.tools.some((t) => t.name === pluginToolName)).toBe(false);

    const session = ctx.get(ISessionContext);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeId: 'bridge-lab',
        connectionId: 'conn-lab-1',
        caller: { workspaceId: session.workspaceId, sessionId: session.sessionId },
        remoteName: 'plugin:notes:notes_search',
        arguments: { q: 'quantum' },
        callId: 'call-remote-1',
      }),
    );
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      'result:plugin:notes:notes_search:quantum',
    );

    activeCatalogs = [];
    capability.notifyChanged();

    ctx.mockNextResponse({ type: 'text', text: 'Remote tools removed.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Check tools after disconnect' }] });
    await ctx.untilTurnEnd();

    const lastHistory = historyText(ctx.llmCalls.at(-1)!.history);
    expect(lastHistory).toContain('<tools_removed>');
    expect(lastHistory).toContain(pluginToolName);
    expect(lastHistory).toContain(mcpToolName);
    expect(registry.resolve(pluginToolName)).toBeUndefined();
    expect(registry.resolve(mcpToolName)).toBeUndefined();
  });

  it('truncates long tool names to <= 60 chars, disambiguates colliding spaces, and never overwrites local tools', async () => {
    const bridge = ctx.get(IRemoteSpaceToolBridgeService);
    const capability = remoteSpaceToolCapability(bridge);
    const registry = ctx.get(IAgentToolRegistryService);

    const localCollisionName = 'mcp__remote_lab_workstat__fs_read';
    const localDisposable = registry.register(
      {
        name: localCollisionName,
        foregroundPolicy: 'instant',
        description: 'Local tool that must not be overwritten',
        parameters: { type: 'object', properties: {} },
        resolveExecution: () => ({
          approvalRule: localCollisionName,
          execute: async () => ({ output: 'local-kept' }),
        }),
      },
      { source: 'mcp', disclosure: 'deferred' },
    );

    try {
      const catalogs: RemoteBorrowedSpaceCatalog[] = [
        {
          bridgeId: 'b-1',
          connectionId: 'conn-alpha',
          spaceLabel: 'Lab Workstation',
          platform: 'darwin',
          tools: [
            {
              remoteName: 'mcp:fs:read',
              kind: 'mcp',
              serverName: 'fs',
              toolName: 'read',
              description: 'Remote read that collides with local name.',
            },
            {
              remoteName: 'plugin:very-long-plugin-identifier:extremely_long_remote_tool_operation_name_exceeding_limits',
              kind: 'plugin',
              pluginId: 'very-long-plugin-identifier',
              toolName: 'extremely_long_remote_tool_operation_name_exceeding_limits',
              description: 'Long plugin tool name.',
            },
          ],
        },
        {
          bridgeId: 'b-2',
          connectionId: 'conn-beta',
          spaceLabel: 'Lab Workstation',
          platform: 'linux',
          tools: [
            {
              remoteName: 'mcp:fs:read',
              kind: 'mcp',
              serverName: 'fs',
              toolName: 'read',
              description: 'Second Lab Workstation read tool.',
            },
          ],
        },
        {
          bridgeId: 'b-3',
          connectionId: 'conn-gamma',
          spaceLabel: '!!!',
          tools: [
            {
              remoteName: 'plugin:util:ping',
              kind: 'plugin',
              pluginId: 'util',
              toolName: 'ping',
              description: 'Fallback space slug tool.',
            },
          ],
        },
      ];

      capability[REMOTE_SPACE_TOOL_ROUTER]({
        listBorrowedTools: async () => catalogs,
        callBorrowedTool: async () => ({ output: 'ok' }),
      });
      await ctx.get(IAgentRemoteToolService).ready();

      expect(registry.resolve(localCollisionName)?.description).toBe(
        'Local tool that must not be overwritten',
      );

      const allTools = registry.list();
      const remoteNames = allTools
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('plugin__remote_') || name.startsWith('mcp__remote_'));

      for (const name of remoteNames) {
        expect(name.length).toBeLessThanOrEqual(60);
        expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      }

      const longPluginEntry = allTools.find((entry) =>
        entry.description === '[Remote space: Lab Workstation (macOS)] Long plugin tool name.',
      );
      expect(longPluginEntry).toBeDefined();
      expect(longPluginEntry!.name.startsWith('plugin__remote_lab_workstat__')).toBe(true);
      expect(longPluginEntry!.name.length).toBeLessThanOrEqual(60);

      const secondSpaceEntry = allTools.find((entry) =>
        entry.description === '[Remote space: Lab Workstation (Linux)] Second Lab Workstation read tool.',
      );
      expect(secondSpaceEntry).toBeDefined();
      expect(secondSpaceEntry!.name).not.toBe(localCollisionName);
      expect(secondSpaceEntry!.name).toMatch(/^mcp__remote_lab_workstat_[a-f0-9]{4}__fs_read$/);

      const fallbackEntry = allTools.find((entry) =>
        entry.description === '[Remote space: !!!] Fallback space slug tool.',
      );
      expect(fallbackEntry).toBeDefined();
      expect(fallbackEntry!.name).toBe('plugin__remote_space__util_ping');
    } finally {
      localDisposable.dispose();
    }
  });

  it('forwards AbortSignal and materializes multimodal PNG attachments into ISessionMediaStore', async () => {
    const bridge = ctx.get(IRemoteSpaceToolBridgeService);
    const capability = remoteSpaceToolCapability(bridge);
    let capturedSignal: AbortSignal | undefined;

    capability[REMOTE_SPACE_TOOL_ROUTER]({
      listBorrowedTools: async () => [
        {
          bridgeId: 'b-media',
          connectionId: 'c-media',
          spaceLabel: 'Lab Workstation',
          platform: 'linux',
          tools: [
            {
              remoteName: 'mcp:cam:snap',
              kind: 'mcp',
              serverName: 'cam',
              toolName: 'snap',
              description: 'Capture remote snapshot.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
        },
      ],
      callBorrowedTool: async (input) => {
        capturedSignal = input.signal;
        input.signal?.throwIfAborted();
        return {
          output: 'Preview at kimi-file://att-inline and extra attached.',
          media: [
            {
              id: 'att-inline',
              mimeType: 'image/png',
              filename: 'inline.png',
              dataBase64: TINY_PNG_BYTES.toString('base64'),
            },
            {
              id: 'att-extra',
              mimeType: 'image/png',
              filename: 'extra.png',
              dataBase64: TINY_PNG_BYTES.toString('base64'),
            },
          ],
        };
      },
    });
    await ctx.get(IAgentRemoteToolService).ready();

    const toolName = 'mcp__remote_lab_workstat__cam_snap';
    const tool = ctx.get(IAgentToolRegistryService).resolve(toolName)!;
    const execution = await tool.resolveExecution({});
    expect('isError' in execution && execution.isError).toBe(false);
    if ('isError' in execution && execution.isError) return;

    const controller = new AbortController();
    const result = await execution.execute({
      turnId: 1,
      toolCallId: 'tc-media-1',
      signal: controller.signal,
    });

    expect(capturedSignal).toBe(controller.signal);
    expect(result.isError).toBeUndefined();
    expect(Array.isArray(result.output)).toBe(true);
    if (!Array.isArray(result.output)) return;

    expect(result.output).toHaveLength(2);
    const textPart = result.output[0]!;
    const imagePart = result.output[1]!;
    expect(textPart.type).toBe('text');
    expect(imagePart.type).toBe('image_url');
    if (textPart.type !== 'text' || imagePart.type !== 'image_url') return;

    expect(textPart.text).not.toContain('kimi-file://att-inline');
    const inlineUriMatch = /kimi-file:\/\/(f_remote_[a-f0-9]+)/.exec(textPart.text);
    expect(inlineUriMatch).not.toBeNull();
    const inlineFileId = inlineUriMatch![1]!;

    const extraRef = parseDaemonFileUrl(imagePart.imageUrl.url);
    expect(extraRef).toBeDefined();
    expect(extraRef!.fileId).toMatch(/^f_remote_[a-f0-9]+$/);
    expect(extraRef!.fileId).not.toBe(inlineFileId);

    const mediaStore = ctx.get(ISessionMediaStore);
    const storedInline = await mediaStore.read(inlineFileId);
    const storedExtra = await mediaStore.read(extraRef!.fileId);
    expect(Buffer.from(storedInline!.data)).toEqual(TINY_PNG_BYTES);
    expect(Buffer.from(storedExtra!.data)).toEqual(TINY_PNG_BYTES);

    const abortController = new AbortController();
    abortController.abort(new Error('cancelled by test'));
    await expect(
      execution.execute({
        turnId: 2,
        toolCallId: 'tc-media-aborted',
        signal: abortController.signal,
      }),
    ).rejects.toThrow();
  });

  it('replaces placeholders inside ContentPart[] outputs and falls back to data URI when media store is absent', async () => {
    const noStoreCtx = createTestAgent({
      sessionId: 'remote-no-media-store',
    });
    await closeMemoryAndThread(noStoreCtx);
    try {
      const bridge = noStoreCtx.get(IRemoteSpaceToolBridgeService);
      const capability = remoteSpaceToolCapability(bridge);
      capability[REMOTE_SPACE_TOOL_ROUTER]({
        listBorrowedTools: async () => [
          {
            bridgeId: 'b-arr',
            connectionId: 'c-arr',
            spaceLabel: 'Cloud Runner',
            platform: 'linux',
            tools: [
              {
                remoteName: 'plugin:plot:render',
                kind: 'plugin',
                pluginId: 'plot',
                toolName: 'render',
                description: 'Render chart.',
              },
            ],
          },
        ],
        callBorrowedTool: async () => ({
          isError: true,
          output: [
            { type: 'text', text: 'Chart failed:' },
            { type: 'image_url', imageUrl: { url: 'kimi-file://att-chart' } },
          ],
          media: [
            {
              id: 'att-chart',
              mimeType: 'image/png',
              filename: 'chart.png',
              dataBase64: TINY_PNG_BYTES.toString('base64'),
            },
          ],
        }),
      });
      await noStoreCtx.get(IAgentRemoteToolService).ready();
      const tool = noStoreCtx.get(IAgentToolRegistryService).resolve('plugin__remote_cloud_runner__plot_render')!;
      Reflect.set(noStoreCtx.get(IAgentRemoteToolService) as unknown as object, 'attachmentStore', undefined);

      const execution = await tool.resolveExecution({});
      if ('isError' in execution && execution.isError) throw new Error('expected runnable execution');
      const res = await execution.execute({
        turnId: 1,
        toolCallId: 'tc-no-store',
        signal: new AbortController().signal,
      });
      expect(res.isError).toBe(true);
      expect(Array.isArray(res.output)).toBe(true);
      if (Array.isArray(res.output)) {
        const img = res.output[1]!;
        expect(img.type).toBe('image_url');
        if (img.type === 'image_url') {
          expect(img.imageUrl.url).toBe(`data:image/png;base64,${TINY_PNG_BYTES.toString('base64')}`);
        }
      }
    } finally {
      await noStoreCtx.dispose();
    }
  });
});
