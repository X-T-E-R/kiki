import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  ensureMainAgent,
  IAgentLifecycleService,
  IAgentMcpService,
  IAgentProfileRegistry,
  IAgentProfileService,
  IEventDispatcher,
  IAppendLogStore,
  IConfigService,
  IWorkspaceInstanceManager,
  IWorkspacePersistence,
  IWorkspaceService,
  IFileSystemStorageService,
  ISessionAgentProfileCatalog,
  ISessionContext,
  ISessionManager,
  ISessionMetadata,
  ISessionToolPolicy,
  agentScopeOf,
  normalizeAgentProfile,
  sessionScopeOf,
  workspacePersistenceScope,
} from '@kiki/agent-core-v2';
import { assembleBrowseSnapshotSource } from '../src/routes/snapshot';
import { readPersistedAgentPanelMetrics } from '../src/routes/agentPanelMetrics';
import { usageRuntime } from '../src/usage/usageRuntime';
import type { IModelPricingService } from '../src/pricing/modelPricingService';
import { TokenCountingRebased } from '@kiki/agent-core-v2/agent/tokenCounting/tokenCountingOps';
import { TurnPrompt } from '@kiki/agent-core-v2/agent/loop/turnOps';
import { UsageRecord } from '@kiki/agent-core-v2/agent/usage/usageOps';
import { FullCompactionComplete } from '@kiki/agent-core-v2/agent/fullCompaction/compactionOps';
import { ConfigUpdate, ProfileBind } from '@kiki/agent-core-v2/agent/profile/profileOps';
import { LlmRequest } from '@kiki/agent-core-v2/agent/llmRequester/llmRequestOps';
import { McpConnectionManager } from '@kiki/agent-core-v2/mcpCore/connection-manager';
import { McpToolsDiscovered } from '@kiki/agent-core-v2/agent/mcp/mcpDiscoveryOps';
import { ErrorCode, agentCapabilitiesResponseSchema, type AgentCapabilitiesResponse } from '@kiki/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  readonly code: number;
  readonly data: T;
}

describe('disposed agent capability snapshots', () => {
  let server: RunningServer | undefined;
  let home: string;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-agent-profile-snapshot-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server !== undefined) await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('keeps the bound profile definition when a same-name registration replaces it', async () => {
    await writeStubConfig(home);
    await start();
    const registry = server!.core.accessor.get(IAgentProfileRegistry);
    const original = registry.register({
      sourceId: 'original-fixture',
      priority: 40,
      contribution: { profiles: [normalizeAgentProfile({
        name: 'historical-helper',
        definitionId: 'definition:historical-helper:original',
        description: 'Original helper definition',
        sourcePath: '/fixture/original-helper.md',
        modelAlias: 'stub',
        serviceTier: 'default',
        tools: ['Read'],
        allowedSubagents: ['explore'],
        preferredSubagents: ['explore'],
        systemPrompt: () => 'Original prompt.',
      })] },
    });
    let replacement: ReturnType<typeof registry.register> | undefined;
    try {
      const sessionId = await createSession();
      const session = server!.core.accessor.get(ISessionManager).get(sessionId)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      await lifecycle.create({
        agentId: 'agent-definition-history',
        delegator: { kind: 'agent', agentId: 'main' },
        binding: { profile: 'historical-helper', model: 'stub' },
      });
      replacement = registry.register({
        sourceId: 'replacement-fixture',
        priority: 80,
        contribution: { profiles: [normalizeAgentProfile({
          name: 'historical-helper',
          definitionId: 'definition:historical-helper:replacement',
          description: 'Replacement helper definition',
          sourcePath: '/fixture/replacement-helper.md',
          modelAlias: 'stub',
          serviceTier: 'priority',
          tools: ['AgentRun'],
          allowedSubagents: [],
          preferredSubagents: [],
          systemPrompt: () => 'Replacement prompt.',
        })] },
      });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.reload();
      expect(catalog.inspect('historical-helper')?.profile.definitionId)
        .toBe('definition:historical-helper:replacement');
      const live = await readCapabilities(sessionId, 'agent-definition-history');
      expectBoundOriginal(live, true);
      expect(agentNotifyCapability(live)).toMatchObject({
        state: 'disabled',
        unavailable_reason_code: 'tool_policy_disabled',
      });
      await lifecycle.remove('agent-definition-history');
      const snapshot = await readCapabilities(sessionId, 'agent-definition-history');
      expectBoundOriginal(snapshot, false);
      expect(agentNotifyCapability(snapshot)).toMatchObject({
        state: 'disabled',
        unavailable_reason_code: 'tool_policy_disabled',
      });
    } finally {
      await replacement?.dispose();
      await original.dispose();
    }
  });

  it('preserves AgentNotify binding decisions across disposal and defaults old records to enabled', async () => {
    await writeStubConfig(home);
    await start();
    const registry = server!.core.accessor.get(IAgentProfileRegistry);
    const registration = registry.register({
      sourceId: 'notify-fixture',
      priority: 40,
      contribution: {
        profiles: [
          normalizeAgentProfile({
            name: 'notify-default',
            definitionId: 'definition:notify-default',
            description: 'Default notification role',
            modelAlias: 'stub',
            systemPrompt: () => '',
          }),
          normalizeAgentProfile({
            name: 'notify-disabled',
            definitionId: 'definition:notify-disabled',
            description: 'Disabled notification role',
            modelAlias: 'stub',
            allowParentNotify: false,
            systemPrompt: () => '',
          }),
        ],
      },
    });
    try {
      const sessionId = await createSession();
      const session = server!.core.accessor.get(ISessionManager).get(sessionId)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const cases = [
        {
          agentId: 'agent-profile-notify-disabled',
          profile: 'notify-disabled',
          allowParentNotify: undefined,
          liveState: 'disabled',
          snapshotState: 'disabled',
        },
        {
          agentId: 'agent-dispatch-notify-disabled',
          profile: 'notify-default',
          allowParentNotify: false,
          liveState: 'disabled',
          snapshotState: 'disabled',
        },
        {
          agentId: 'agent-dispatch-notify-enabled',
          profile: 'notify-disabled',
          allowParentNotify: true,
          liveState: 'enabled',
          snapshotState: 'unknown',
        },
        {
          agentId: 'agent-legacy-notify-default',
          profile: 'notify-default',
          allowParentNotify: undefined,
          liveState: 'enabled',
          snapshotState: 'unknown',
        },
      ] as const;
      for (const item of cases) {
        await lifecycle.create({
          agentId: item.agentId,
          delegator: { kind: 'agent', agentId: 'main' },
          binding: {
            profile: item.profile,
            model: 'stub',
            allowParentNotify: item.allowParentNotify,
          },
        });
        const live = agentNotifyCapability(await readCapabilities(sessionId, item.agentId));
        expect(live).toMatchObject({ state: item.liveState });
        if (item.liveState === 'disabled') {
          expect(live).toMatchObject({ unavailable_reason_code: 'activation_condition_unmet' });
        }
        await lifecycle.remove(item.agentId);
        const snapshot = agentNotifyCapability(await readCapabilities(sessionId, item.agentId));
        expect(snapshot).toMatchObject({ state: item.snapshotState });
        expect(snapshot.unavailable_reason_code).toBe(
          item.snapshotState === 'disabled'
            ? 'activation_condition_unmet'
            : 'snapshot_inventory_only',
        );
      }
    } finally {
      await registration.dispose();
    }
  });

  it('keeps the global parent-notify veto after disposal', async () => {
    await writeStubConfig(home);
    await start();
    await server!.core.accessor.get(IConfigService).set('agents', { notify_parent: false });
    const registration = server!.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'notify-global-fixture',
      priority: 40,
      contribution: {
        profiles: [normalizeAgentProfile({
          name: 'notify-global',
          definitionId: 'definition:notify-global',
          description: 'Global notification role',
          modelAlias: 'stub',
          systemPrompt: () => '',
        })],
      },
    });
    try {
      const sessionId = await createSession();
      const session = server!.core.accessor.get(ISessionManager).get(sessionId)!;
      expect(session.accessor.get(IConfigService).get('agents')).toMatchObject({
        notify_parent: false,
      });
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const child = await lifecycle.create({
        agentId: 'agent-global-notify-disabled',
        delegator: { kind: 'agent', agentId: 'main' },
        binding: { profile: 'notify-global', model: 'stub', allowParentNotify: true },
      });
      const live = agentNotifyCapability(await readCapabilities(sessionId, child.id));
      expect(live).toMatchObject({
        state: 'disabled',
        unavailable_reason_code: 'activation_condition_unmet',
      });
      await lifecycle.remove(child.id);
      const snapshot = agentNotifyCapability(await readCapabilities(sessionId, child.id));
      expect(snapshot).toMatchObject({
        state: 'disabled',
        unavailable_reason_code: 'activation_condition_unmet',
      });
    } finally {
      await registration.dispose();
    }
  });

  it('preserves always-thinking effective effort after disposal', async () => {
    await writeFile(join(home, 'config.toml'), [
      'default_model = "always"',
      '[thinking]', 'effort = "low"',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"',
      '[models.always]', 'provider = "stub"', 'model = "always"', 'max_context_size = 1000',
      'capabilities = ["thinking", "always_thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
    ].join('\n'));
    await start();
    const sessionId = await createSession('always');
    const session = server!.core.accessor.get(ISessionManager).get(sessionId)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({
      agentId: 'agent-always-thinking',
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'explore', model: 'always', thinking: 'high' },
    });
    expect(() => child.accessor.get(IAgentProfileService).setThinking('off')).toThrow(/not supported/);
    const live = await readCapabilities(sessionId, 'agent-always-thinking');
    expect(live.profile).toMatchObject({
      model: 'always', thinking_effort: 'high', effort_source: 'config',
    });
    await lifecycle.remove('agent-always-thinking');
    const snapshot = await readCapabilities(sessionId, 'agent-always-thinking');
    expect(snapshot).toMatchObject({ live: false, available: true });
    expect(snapshot.profile).toMatchObject({
      model: 'always', thinking_effort: 'high', effort_source: 'config',
    });
    expect(snapshot.profile?.thinking_effort_source).toBe(live.profile?.thinking_effort_source);
  });

  it('reuses a cached fold until the wire journal identity changes', async () => {
    await writeFile(join(home, 'config.toml'), [
      'default_model = "stub"',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
      'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
      '[models.stub-alt]', 'provider = "stub"', 'model = "stub-alt"', 'max_context_size = 1000',
      'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
    ].join('\n'));
    await start();
    const sessionId = await createSession();
    const session = server!.core.accessor.get(ISessionManager).get(sessionId)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({
      agentId: 'agent-cached-snapshot',
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'explore', model: 'stub-alt', thinking: 'high' },
    });
    await lifecycle.remove(child.id);
    expect((await readCapabilities(sessionId, child.id)).profile).toMatchObject({
      model: 'stub-alt', thinking_effort: 'high',
    });
    const appendLog = server!.core.accessor.get(IAppendLogStore);
    const readStream = vi.spyOn(server!.core.accessor.get(IFileSystemStorageService), 'readStream');
    const scope = agentScopeOf(
      sessionScopeOf(
        workspacePersistenceScope('sessions', session.accessor.get(ISessionContext).workspaceId),
        sessionId,
      ),
      child.id,
    );
    const wireReads = () => readStream.mock.calls.filter(([readScope, key]) => readScope === scope && key === AGENT_WIRE_RECORD_KEY);
    expect((await readCapabilities(sessionId, child.id)).profile).toMatchObject({ model: 'stub-alt' });
    expect(wireReads()).toHaveLength(0);
    appendLog.append(scope, AGENT_WIRE_RECORD_KEY, new ConfigUpdate({
      modelAlias: 'stub',
      thinkingEffort: 'low',
    }).serialize());
    await appendLog.flush(scope, AGENT_WIRE_RECORD_KEY);
    const refreshed = await readCapabilities(sessionId, child.id);
    expect(refreshed.profile).toMatchObject({ model: 'stub', thinking_effort: 'low' });
    expect(wireReads()).toHaveLength(5);
    expect((await readCapabilities(sessionId, child.id)).profile).toEqual(refreshed.profile);
    expect(wireReads()).toHaveLength(5);
  });

  it('replays actual request evidence for a disposed agent and keeps legacy anchor evidence unknown', async () => {
    await writeStubConfig(home);
    await start();
    const sessionId = await createSession();
    const session = server!.core.accessor.get(ISessionManager).get(sessionId)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ agentId: 'agent-request-evidence', delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'explore', model: 'stub' } });
    const scope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', session.accessor.get(ISessionContext).workspaceId), sessionId), child.id);
    await lifecycle.remove(child.id);
    const log = server!.core.accessor.get(IAppendLogStore);
    const request = { kind: 'loop' as const, provider: 'stub', model: 'stub', modelAlias: 'stub', toolSelect: false, systemPromptHash: 'actual-anchor-hash', toolsHash: 'actual-tools-hash', messageCount: 1, turnStep: '0:1' };
    log.append(scope, AGENT_WIRE_RECORD_KEY, new LlmRequest({ ...request, systemPrompt: 'PRIVATE SYSTEM BODY', anchorApplied: true, anchorSteps: 2, anchorScope: 'turn', cognitionRevision: 7, bindingRevision: 'request-binding' }).serialize());
    await log.flush(scope, AGENT_WIRE_RECORD_KEY);
    const actual = await readCapabilities(sessionId, child.id);
    expect(actual.prompt?.request).toMatchObject({ system_prompt_hash: 'actual-anchor-hash', tools_hash: 'actual-tools-hash', anchor_applied: true, anchor_steps: 2, anchor_scope: 'turn', cognition_revision: 7, binding_revision: 'request-binding' });
    expect(JSON.stringify(actual.prompt)).not.toContain('PRIVATE SYSTEM BODY');
    log.append(scope, AGENT_WIRE_RECORD_KEY, new LlmRequest({ ...request, systemPromptHash: 'legacy-hash' }).serialize());
    await log.flush(scope, AGENT_WIRE_RECORD_KEY);
    const legacy = await readCapabilities(sessionId, child.id);
    expect(legacy.prompt?.request?.system_prompt_hash).toBe('legacy-hash');
    expect(legacy.prompt?.request?.anchor_applied).toBeUndefined();
    expect(legacy.prompt?.request?.anchor_scope).toBeUndefined();
  });

  it('projects configured tools, skills and dispatch policy for stopped and cold agents without restoring them', async () => {
    await writeStubConfig(home);
    await mkdir(join(home, 'skills', 'example-skill'), { recursive: true });
    await writeFile(join(home, 'skills', 'example-skill', 'SKILL.md'), '---\nname: example-skill\ndescription: Example skill\n---\nRead the task.');
    await start();
    const registration = server!.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'snapshot-policy-fixture', priority: 40,
      contribution: { profiles: [
        normalizeAgentProfile({ name: 'snapshot-owner', modelAlias: 'stub', tools: ['Read', 'Skill', 'AgentRun', 'mcp__*'],
          canSpawnSubagents: true, allowedSubagents: ['snapshot-leaf'], systemPrompt: () => '' }),
        normalizeAgentProfile({ name: 'snapshot-leaf', modelAlias: 'stub', tools: ['Read', 'Skill'],
          canSpawnSubagents: false, systemPrompt: () => '' }),
      ] },
    });
    try {
      const sessionId = await createSession();
      const manager = server!.core.accessor.get(ISessionManager);
      const session = manager.get(sessionId)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      for (const profile of ['snapshot-owner', 'snapshot-leaf']) {
        await lifecycle.create({ agentId: profile, delegator: { kind: 'agent', agentId: 'main' }, binding: { profile, model: 'stub' } });
        await lifecycle.remove(profile);
      }
      const scope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', session.accessor.get(ISessionContext).workspaceId), sessionId), 'snapshot-owner');
      const log = server!.core.accessor.get(IAppendLogStore);
      log.append(scope, AGENT_WIRE_RECORD_KEY, new McpToolsDiscovered({ serverName: 'example', hash: 'example-discovery',
        tools: [{ name: 'lookup', description: 'Look up an item', inputSchema: { type: 'object' } }], enabledNames: ['lookup'] }).serialize());
      await log.flush(scope, AGENT_WIRE_RECORD_KEY);
      const checkOwner = (data: AgentCapabilitiesResponse) => {
        expect(data).toMatchObject({ live: false, available: true, profile: { name: 'snapshot-owner', can_spawn_subagents: true } });
        expect(data.tools).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'Read', state: 'unknown', policy_allowed: true, unavailable_reason_code: 'snapshot_inventory_only' }),
          expect.objectContaining({ name: 'mcp__example__lookup', source: 'mcp', state: 'unknown', policy_allowed: true }),
        ]));
        expect(data.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'example-skill', state: 'unknown', unavailable_reason_code: 'snapshot_inventory_only' })]));
        expect(data.targets.find((target) => target.profile === 'snapshot-leaf')).toMatchObject({
          defaults_available: true, launch_unavailable_reason_code: 'snapshot_launch_unavailable',
        });
      };
      checkOwner(await readCapabilities(sessionId, 'snapshot-owner'));
      const leaf = await readCapabilities(sessionId, 'snapshot-leaf');
      expect(leaf.profile?.can_spawn_subagents).toBe(false);
      expect(leaf.tools?.find((tool) => tool.name === 'AgentRun')?.state).toBe('disabled');
      expect(leaf.targets.every((target) => target.launch_unavailable_reason_code !== 'snapshot_launch_unavailable')).toBe(true);
      const workspaceId = session.accessor.get(ISessionContext).workspaceId;
      await manager.close(sessionId);
      expect(manager.get(sessionId)).toBeUndefined();
      const resume = vi.spyOn(manager, 'resume');
      const workspaceManager = server!.core.accessor.get(IWorkspaceInstanceManager);
      await workspaceManager.close(workspaceId);
      await writeFile(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { example: { command: 'example-mcp-server' } } }));
      const acquire = vi.spyOn(workspaceManager, 'acquire');
      const connect = vi.spyOn(McpConnectionManager.prototype, 'connectAll');
      checkOwner(await readCapabilities(sessionId, 'snapshot-owner'));
      const main = await readCapabilities(sessionId, 'main');
      expect(main).toMatchObject({ live: false, available: true, profile: { name: 'agent' } });
      expect(main.tools?.some((tool) => tool.policy_allowed === true)).toBe(true);
      expect(main.skills?.some((skill) => skill.name === 'example-skill')).toBe(true);
      expect(main.targets.length).toBeGreaterThan(0);
      expect(resume).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(workspaceManager.get(workspaceId)).toBeUndefined();
      expect(manager.get(sessionId)).toBeUndefined();
    } finally { await registration.dispose(); }
  });

  it('reads cold metadata-only bindings and saved tool policy when no inline profile was recorded', async () => {
    await writeStubConfig(home);
    await start();
    const sessionId = await createSession();
    const manager = server!.core.accessor.get(ISessionManager);
    const session = manager.get(sessionId)!;
    const metadata = session.accessor.get(ISessionMetadata);
    await metadata.registerAgent('metadata-child', { type: 'sub', parentAgentId: 'main', model: 'stub', labels: { profileName: 'explore' } });
    await session.accessor.get(ISessionToolPolicy).setDisabledTools(['Read']);
    await manager.close(sessionId);
    const data = await readCapabilities(sessionId, 'metadata-child');
    expect(data).toMatchObject({ live: false, available: true, profile: { name: 'explore', model: 'stub', can_spawn_subagents: false } });
    expect(data.tools?.find((tool) => tool.name === 'Read')).toMatchObject({ state: 'disabled', policy_allowed: false });
    expect(data.tools?.some((tool) => tool.policy_allowed === true)).toBe(true);
    expect(data.skills).toBeDefined();
    expect(data.targets).toBeDefined();
    expect(manager.get(sessionId)).toBeUndefined();
  });

  it('projects branch metadata as main capabilities and preserves cold tool locks', async () => {
    await writeFile(join(home, 'config.toml'), [
      'default_model = "stub"',
      '[subagent]', 'allowed_tools = ["Read"]',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    await start();
    const sessionId = await createSession();
    const manager = server!.core.accessor.get(ISessionManager);
    const session = manager.get(sessionId)!;
    const metadata = session.accessor.get(ISessionMetadata);
    await metadata.registerAgent('branch-open', {
      type: 'sub', parentAgentId: 'main', model: 'stub',
      labels: { branch: 'true', toolsLocked: 'false' },
    });
    await metadata.registerAgent('branch-locked', {
      type: 'sub', parentAgentId: 'main', model: 'stub',
      labels: { branch: 'true', toolsLocked: 'true' },
    });
    await manager.close(sessionId);
    const open = await readCapabilities(sessionId, 'branch-open');
    const locked = await readCapabilities(sessionId, 'branch-locked');
    expect(open.tools?.find((tool) => tool.name === 'Bash')).toMatchObject({ state: 'unknown', policy_allowed: true });
    expect(open.tools?.find((tool) => tool.name === 'AgentRun')).toMatchObject({ state: 'unknown', policy_allowed: true });
    expect(open.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ launch_allowed: false, launch_unavailable_reason_code: 'snapshot_launch_unavailable' }),
    ]));
    expect(locked.tools?.find((tool) => tool.name === 'Read')).toMatchObject({ state: 'disabled', policy_allowed: false });
    expect(locked.tools?.find((tool) => tool.name === 'AgentRun')).toMatchObject({ state: 'disabled', policy_allowed: false });
    expect(locked.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ launch_allowed: false, launch_unavailable_reason_code: 'agent_run_inactive' }),
    ]));
    expect(manager.get(sessionId)).toBeUndefined();
  });

  it('applies saved session MCP overrides to stopped and cold capability reads', async () => {
    await writeStubConfig(home);
    await writeFile(
      join(home, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          example: { command: 'example-mcp-server' },
          standby: { command: 'standby-mcp-server', enabled: false },
        },
      }),
    );
    await start();
    const registration = server!.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'snapshot-mcp-override-fixture',
      priority: 40,
      contribution: {
        profiles: [
          normalizeAgentProfile({
            name: 'snapshot-mcp-owner',
            modelAlias: 'stub',
            tools: ['Read', 'mcp__*'],
            canSpawnSubagents: false,
            systemPrompt: () => '',
          }),
        ],
      },
    });
    try {
      const sessionId = await createSession();
      const manager = server!.core.accessor.get(ISessionManager);
      const session = manager.get(sessionId)!;
      const main = await ensureMainAgent(session);
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      await lifecycle.create({
        agentId: 'snapshot-mcp-owner',
        delegator: { kind: 'agent', agentId: 'main' },
        binding: { profile: 'snapshot-mcp-owner', model: 'stub' },
      });
      await lifecycle.remove('snapshot-mcp-owner');
      const workspaceId = session.accessor.get(ISessionContext).workspaceId;
      const scope = agentScopeOf(
        sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId),
        'snapshot-mcp-owner',
      );
      const log = server!.core.accessor.get(IAppendLogStore);
      log.append(
        scope,
        AGENT_WIRE_RECORD_KEY,
        new McpToolsDiscovered({
          serverName: 'example',
          hash: 'example-discovery',
          tools: [{ name: 'lookup', description: 'Look up an item', inputSchema: { type: 'object' } }],
          enabledNames: ['lookup'],
        }).serialize(),
      );
      log.append(
        scope,
        AGENT_WIRE_RECORD_KEY,
        new McpToolsDiscovered({
          serverName: 'standby',
          hash: 'standby-discovery',
          tools: [{ name: 'ping', description: 'Ping server', inputSchema: { type: 'object' } }],
          enabledNames: ['ping'],
        }).serialize(),
      );
      await log.flush(scope, AGENT_WIRE_RECORD_KEY);
      const mcp = main.accessor.get(IAgentMcpService);
      await mcp.setMcpSessionOverride({ locator: { source: 'global', name: 'example' }, override: 'off' });
      await mcp.setMcpSessionOverride({ locator: { source: 'global', name: 'standby' }, override: 'on' });

      const verify = (data: AgentCapabilitiesResponse) => {
        expect(data.tools?.find((tool) => tool.name === 'mcp__example__lookup')).toMatchObject({
          source: 'mcp',
          state: 'disabled',
          policy_allowed: false,
          unavailable_reason_code: 'tool_policy_disabled',
        });
        expect(data.tools?.find((tool) => tool.name === 'mcp__standby__ping')).toMatchObject({
          source: 'mcp',
          state: 'unknown',
          policy_allowed: true,
          unavailable_reason_code: 'snapshot_inventory_only',
        });
      };

      verify(await readCapabilities(sessionId, 'snapshot-mcp-owner'));
      await manager.close(sessionId);
      await server!.core.accessor.get(IWorkspaceInstanceManager).close(workspaceId);
      const connect = vi.spyOn(McpConnectionManager.prototype, 'connectAll');
      verify(await readCapabilities(sessionId, 'snapshot-mcp-owner'));
      expect(connect).not.toHaveBeenCalled();
      expect(manager.get(sessionId)).toBeUndefined();
    } finally {
      await registration.dispose();
    }
  });

  it('resolves cold capability workspace from indexed session summary without mutating workspace registrations', async () => {
    await writeStubConfig(home);
    const projectDir = join(home, 'unregistered-project');
    await mkdir(join(projectDir, '.agents', 'skills', 'project-local-skill'), { recursive: true });
    await writeFile(
      join(projectDir, '.agents', 'skills', 'project-local-skill', 'SKILL.md'),
      '---\nname: project-local-skill\ndescription: Project local skill\n---\nUse project skill.',
    );
    await start();
    const response = await authedFetch(server!, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: projectDir }, agent_config: { profile: 'agent', model: 'stub' } }),
    });
    const created = await response.json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const sessionId = created.data.id;
    const manager = server!.core.accessor.get(ISessionManager);
    const workspaceId = manager.get(sessionId)!.accessor.get(ISessionContext).workspaceId;
    await manager.close(sessionId);
    await server!.core.accessor.get(IWorkspaceInstanceManager).close(workspaceId);
    const workspacePersistence = server!.core.accessor.get(IWorkspacePersistence);
    await workspacePersistence.save({ workspaces: [], deletedIds: [] });
    const saveSpy = vi.spyOn(workspacePersistence, 'save');
    const getSpy = vi.spyOn(server!.core.accessor.get(IWorkspaceService), 'get');

    const data = await readCapabilities(sessionId, 'main');
    expect(data).toMatchObject({ live: false, available: true, profile: { name: 'agent', model: 'stub' } });
    expect(data.skills?.some((skill) => skill.name === 'project-local-skill')).toBe(true);
    expect(getSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect((await workspacePersistence.load())?.workspaces ?? []).toEqual([]);
    expect(manager.get(sessionId)).toBeUndefined();
  });

  it('serves large cold checkpoint context, turns, accounting and compactions without restoring main', async () => {
    await writeStubConfig(home);
    await start();
    const sessionId = await createSession();
    const manager = server!.core.accessor.get(ISessionManager);
    const session = manager.get(sessionId)!;
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    const workspaceId = session.accessor.get(ISessionContext).workspaceId;
    const scope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId), 'main');
    const log = server!.core.accessor.get(IAppendLogStore);
    log.append(scope, AGENT_WIRE_RECORD_KEY, { type: 'fixture.padding', text: 'x'.repeat((8 << 20) + 1), time: 1 });
    await log.flush(scope, AGENT_WIRE_RECORD_KEY);
    const dispatcher = main.accessor.get(IEventDispatcher);
    await dispatcher.dispatchDurably(new TurnPrompt({ input: [], origin: { kind: 'user' }, turnId: 6 }));
    await dispatcher.dispatchDurably(new TokenCountingRebased({ length: 1, tokens: 234, measured: true }));
    await dispatcher.dispatchDurably(new UsageRecord({ model: 'stub', usage: { inputOther: 100, output: 20, inputCacheRead: 50, inputCacheCreation: 10 }, usageScope: 'turn', turnId: 6, usageKnown: true }));
    await dispatcher.dispatchDurably(new FullCompactionComplete({}));
    expect(await dispatcher.saveReplayCheckpoint!()).toBe(true);
    await manager.close(sessionId);
    const resume = vi.spyOn(manager, 'resume');
    const browse = await assembleBrowseSnapshotSource(server!.core, { getCursor: async () => ({ seq: 0, epoch: 'cold-fixture' }) } as never, sessionId);
    expect(browse).toMatchObject({ context_tokens: 234, max_context_tokens: 1000,
      session: { usage: { context_tokens: 234, context_limit: 1000, turn_count: 7 } } });
    const sessionResponse = await authedFetch(server!, base, `/api/sessions/${sessionId}`);
    expect((await sessionResponse.json() as Envelope<unknown>).data).toMatchObject({ usage: { context_tokens: 234, context_limit: 1000, turn_count: 7 } });
    const importing = vi.spyOn(usageRuntime(server!.core).service, 'readAgentUsage');
    const pricing = { calculate: (_model: string, value: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }) =>
      value.inputOther * 0.001 + value.output * 0.002 + value.inputCacheRead * 0.0001 + value.inputCacheCreation * 0.001 } as IModelPricingService;
    for (const settle of [false, true]) {
      const priced = await readPersistedAgentPanelMetrics(server!.core, workspaceId, sessionId, pricing,
        { agentIds: ['main'], settle, complete: settle });
      expect(priced['main']).toMatchObject({ totalTokens: 180, costPartial: false });
      expect(priced['main']?.totalCostUsd).toBeCloseTo(0.155);
      const response = await authedFetch(server!, base, `/api/agents/capabilities?session_id=${sessionId}&agent_id=main&metrics_only=true&metrics_settle=${settle}`);
      expect((await response.json() as Envelope<AgentCapabilitiesResponse>).data.metrics?.['main']).toMatchObject({
        contextTokens: 234, contextLimit: 1000, compactionCount: 1,
        inputTokens: 160, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10,
        totalTokens: 180, usageComplete: true, usagePartial: false,
      });
    }
    expect(importing).not.toHaveBeenCalled();
    const compact = await authedFetch(server!, base, `/api/sessions/${sessionId}/agents/main/auto-compact?observe=true`);
    expect((await compact.json() as Envelope<unknown>).code).toBe(ErrorCode.SESSION_BUSY);
    expect(resume).not.toHaveBeenCalled();
    expect(manager.get(sessionId)).toBeUndefined();
  });

  it('uses the default main profile for metadata persona labels while missing child profiles remain unavailable', async () => {
    await writeStubConfig(home);
    await start();
    const sessionId = await createSession();
    const manager = server!.core.accessor.get(ISessionManager);
    const session = manager.get(sessionId)!;
    const workspaceId = session.accessor.get(ISessionContext).workspaceId;
    await session.accessor.get(ISessionMetadata).updateAgent('main', current => ({ ...current, displayName: 'example-persona', contextTokens: 321 }));
    await session.accessor.get(ISessionMetadata).registerAgent('missing-child', { type: 'sub', model: 'stub', labels: { profileName: 'missing-profile' } });
    await manager.close(sessionId);
    const scope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId), 'main');
    const log = server!.core.accessor.get(IAppendLogStore);
    log.append(scope, AGENT_WIRE_RECORD_KEY, { type: 'fixture.padding', text: 'x'.repeat((8 << 20) + 1), time: 1 });
    await log.flush(scope, AGENT_WIRE_RECORD_KEY);
    const data = await readCapabilities(sessionId, 'main');
    expect(data).toMatchObject({ live: false, available: true, profile: { name: 'agent' }, metrics: { main: { contextTokens: 321, contextLimit: 1000 } } });
    const child = await readCapabilities(sessionId, 'missing-child');
    expect(child.unavailable_reason_code).toBe('persisted_profile_unavailable');
    expect(manager.get(sessionId)).toBeUndefined();
  });

  it('keeps a cold external-client main opaque to native default model and context capabilities', async () => {
    await writeStubConfig(home);
    await start();
    const sessionId = await createSession();
    const manager = server!.core.accessor.get(ISessionManager);
    const session = manager.get(sessionId)!;
    const metadata = session.accessor.get(ISessionMetadata);
    await metadata.update({ executionPhase: metadata.snapshot().executionPhase,
      custom: { externalClient: { connectionId: 'fixture-connection', clientName: 'Fixture client', sessionRef: 'fixture-session', driver: 'external' } } });
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IEventDispatcher).dispatchDurably(new ProfileBind({ driver: 'external',
      profileName: 'agent', thinkingEffort: 'off', systemPrompt: '', disallowedTools: [] }));
    await manager.close(sessionId);
    const resume = vi.spyOn(manager, 'resume');
    const response = await authedFetch(server!, base, `/api/sessions/${sessionId}`);
    expect((await response.json() as Envelope<unknown>).data).toMatchObject({ agent_config: { model: '' }, usage: { context_limit: 0 } });
    const data = await readCapabilities(sessionId, 'main');
    expect(data.metrics?.['main']).toMatchObject({ contextLimit: null, compactionCount: null });
    expect(resume).not.toHaveBeenCalled();
    expect(manager.get(sessionId)).toBeUndefined();
  });

  async function start(): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function createSession(model = 'stub'): Promise<string> {
    const response = await authedFetch(server!, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model } }),
    });
    const body = await response.json() as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function readCapabilities(sessionId: string, agentId: string): Promise<AgentCapabilitiesResponse> {
    const response = await authedFetch(
      server!,
      base,
      `/api/agents/capabilities?session_id=${sessionId}&agent_id=${agentId}`,
    );
    const body = await response.json() as Envelope<unknown>;
    expect(body.code).toBe(0);
    return agentCapabilitiesResponseSchema.parse(body.data);
  }
});

function expectBoundOriginal(data: AgentCapabilitiesResponse, live: boolean): void {
  expect(data).toMatchObject({ live, owner: { profile: 'historical-helper' } });
  expect(data.profile).toMatchObject({
    name: 'historical-helper',
    definition_id: 'definition:historical-helper:original',
    description: 'Original helper definition',
    source: 'custom',
    source_file: '/fixture/original-helper.md',
    service_tier: 'default',
    tools: ['Read'],
    allowed_subagents: ['explore'],
    preferred_subagents: ['explore'],
  });
}

function agentNotifyCapability(
  data: AgentCapabilitiesResponse,
): NonNullable<AgentCapabilitiesResponse['tools']>[number] {
  const tool = data.tools?.find((candidate) => candidate.name === 'AgentNotify');
  expect(tool).toBeDefined();
  return tool!;
}

async function writeStubConfig(home: string): Promise<void> {
  await writeFile(join(home, 'config.toml'), [
    'default_model = "stub"',
    '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
    'api_key = "YOUR_API_KEY"',
    '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
  ].join('\n'));
}
