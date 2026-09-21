import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  IAgentLifecycleService,
  IAgentProfileRegistry,
  IAgentProfileService,
  IAppendLogStore,
  ISessionAgentProfileCatalog,
  ISessionContext,
  ISessionManager,
  agentScopeOf,
  normalizeAgentProfile,
  sessionScopeOf,
  workspacePersistenceScope,
} from '@kiki/agent-core-v2';
import { ConfigUpdate } from '@kiki/agent-core-v2/agent/profile/profileOps';
import { agentCapabilitiesResponseSchema, type AgentCapabilitiesResponse } from '@kiki/protocol';
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
        subagentPolicy: 'advisory',
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
          subagentPolicy: 'strict',
          systemPrompt: () => 'Replacement prompt.',
        })] },
      });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.reload();
      expect(catalog.inspect('historical-helper')?.profile.definitionId)
        .toBe('definition:historical-helper:replacement');
      const live = await readCapabilities(sessionId, 'agent-definition-history');
      expectBoundOriginal(live, true);
      await lifecycle.remove('agent-definition-history');
      const snapshot = await readCapabilities(sessionId, 'agent-definition-history');
      expectBoundOriginal(snapshot, false);
    } finally {
      replacement?.dispose();
      original.dispose();
    }
  });

  it('preserves always-thinking effective effort after disposal', async () => {
    await writeFile(join(home, 'config.toml'), [
      'default_model = "always"',
      '[thinking]', 'effort = "low"',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"',
      '[models.always]', 'provider = "stub"', 'model = "always"', 'max_context_size = 1000',
      'capabilities = ["thinking", "always_thinking"]', 'support_efforts = ["low", "high"]',
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
    child.accessor.get(IAgentProfileService).setThinking('off');
    const live = await readCapabilities(sessionId, 'agent-always-thinking');
    expect(live.profile).toMatchObject({
      model: 'always', thinking_effort: 'low', effort_source: 'config',
    });
    await lifecycle.remove('agent-always-thinking');
    const snapshot = await readCapabilities(sessionId, 'agent-always-thinking');
    expect(snapshot).toMatchObject({ live: false, available: true });
    expect(snapshot.profile).toMatchObject({
      model: 'always', thinking_effort: 'low', effort_source: 'config',
    });
    expect(snapshot.profile?.thinking_effort_source).toBe(live.profile?.thinking_effort_source);
  });

  it('reuses a cached fold until the wire journal identity changes', async () => {
    await writeFile(join(home, 'config.toml'), [
      'default_model = "stub"',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
      'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]',
      '[models.stub-alt]', 'provider = "stub"', 'model = "stub-alt"', 'max_context_size = 1000',
      'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]',
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
    const read = vi.spyOn(appendLog, 'read');
    expect((await readCapabilities(sessionId, child.id)).profile).toMatchObject({ model: 'stub-alt' });
    expect(read).not.toHaveBeenCalled();
    const scope = agentScopeOf(
      sessionScopeOf(
        workspacePersistenceScope('sessions', session.accessor.get(ISessionContext).workspaceId),
        sessionId,
      ),
      child.id,
    );
    appendLog.append(scope, AGENT_WIRE_RECORD_KEY, new ConfigUpdate({
      modelAlias: 'stub',
      thinkingEffort: 'low',
    }).serialize());
    await appendLog.flush(scope, AGENT_WIRE_RECORD_KEY);
    const refreshed = await readCapabilities(sessionId, child.id);
    expect(refreshed.profile).toMatchObject({ model: 'stub', thinking_effort: 'low' });
    expect(read).toHaveBeenCalledTimes(1);
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
    subagent_policy: 'advisory',
  });
}

async function writeStubConfig(home: string): Promise<void> {
  await writeFile(join(home, 'config.toml'), [
    'default_model = "stub"',
    '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
    'api_key = "YOUR_API_KEY"',
    '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
  ].join('\n'));
}
