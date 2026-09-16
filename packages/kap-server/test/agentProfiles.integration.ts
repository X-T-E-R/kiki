import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentProfileSourceDiagnosticCodes,
  IAgentLifecycleService,
  IAgentProfileRegistry,
  IConfigService,
  ISessionAgentProfileCatalog,
  ISessionContext,
  ISessionManager,
  ISubagentTool,
  IWorkspaceInstanceManager,
  normalizeAgentProfile,
  type AgentProfileCatalogSnapshot,
  type AgentProfileRegistration,
} from '@kiki/agent-core-v2';
import { IAgentPlanService } from '@kiki/agent-core-v2/features/plan/plan';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { evaluateDispatchAdmission } from '@kiki/agent-core-v2/session/dispatch/launchPolicy';
import { IAgentProfileService, IAgentExecutorRegistry, IAgentUsageService, ISessionInteractionService } from '@kiki/agent-core-v2';
import { ErrorCode, listNamedAgentProfilesResponseSchema, agentCapabilitiesResponseSchema } from '@kiki/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningServer, startServer } from '../src/start';
import { registerAgentProfilesRoute } from '../src/routes/agentProfiles';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { panelSkills } from '../src/routes/agentPanelCapabilities';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('GET /api/agents', () => {
  it('projects skill origins and invocation restrictions without returning skill bodies', () => {
    const shared = { name: 'example', description: 'Example skill', path: '/fixture/skills/example', dir: '/fixture/skills', content: 'PRIVATE SKILL BODY' };
    const skills = panelSkills([
      { ...shared, source: 'project', metadata: { disableModelInvocation: true } },
      { ...shared, name: 'global-example', source: 'user', metadata: {} },
    ], true);
    expect(skills).toMatchObject([
      { scope: 'workspace', source: 'project', state: 'disabled', disable_model_invocation: true },
      { scope: 'global', source: 'user', state: 'enabled' },
    ]);
    expect(JSON.stringify(skills)).not.toContain('PRIVATE SKILL BODY');
    expect(panelSkills([{ ...shared, source: 'builtin', metadata: { argumentHint: 'arg1' } }], false)[0]).toMatchObject({
      state: 'disabled',
      argument_hint: 'arg1',
    });
  });

  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-agent-profiles-'));
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it.each(['Custom legacy prompt.', '---\ndescription: Custom default\nsubagents: [explore]\n---\nCustom upgraded prompt.'])('keeps SYSTEM main profiles available when subagent discovery is disabled: %s', async (text) => {
    await writeFile(join(home!, 'SYSTEM.md'), text);
    await writeFile(join(home!, 'config.toml'), [
      'disabled_named_profiles = ["agent"]', 'disabled_builtin_profiles = ["agent"]',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const query = `cwd=${encodeURIComponent(home!)}`;
    const response = await authedFetch(server, base, `/api/agents?${query}&effective=true`);
    const body = await response.json() as Envelope<unknown>;
    expect(body.code).toBe(0);
    const profile = listNamedAgentProfilesResponseSchema.parse(body.data).items.find((item) => item.name === 'agent');
    expect(profile).toMatchObject({ main: true, disabled: false, source: 'user', source_file: join(home!, 'SYSTEM.md').replaceAll('\\', '/') });
    const capabilities = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
    const capabilityBody = await capabilities.json() as Envelope<unknown>;
    expect(capabilityBody.code).toBe(0);
    const data = agentCapabilitiesResponseSchema.parse(capabilityBody.data);
    expect(data.available).toBe(true);
    expect(data.targets.some((target) => target.profile === 'explore')).toBe(true);
    expect(data.targets.some((target) => target.profile === 'agent')).toBe(false);
    const createdResponse = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } }),
    });
    const created = await createdResponse.json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const lifecycle = server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(IAgentLifecycleService);
    expect(lifecycle.get('main')!.accessor.get(IAgentProfileService).data().systemPrompt).toContain(text.split('\n').at(-1));
    expect(lifecycle.list()).toHaveLength(1);
  });

  it('writes the winning SYSTEM source rather than a same-name user file and refreshes draft capabilities', async () => {
    const systemPath = join(home!, 'SYSTEM.md');
    const agentPath = join(home!, 'agents', 'agent.md');
    await mkdir(join(home!, 'agents'), { recursive: true });
    const shadowText = '---\nname: agent\ndescription: Shadow default\noverride: true\n---\nShadow prompt.';
    await writeFile(agentPath, shadowText);
    await writeFile(systemPath, 'Legacy main prompt.');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const query = `cwd=${encodeURIComponent(home!)}`;
    const listed = await authedFetch(server, base, `/api/agents?${query}&effective=true`);
    const initial = listNamedAgentProfilesResponseSchema.parse((await listed.json() as Envelope<unknown>).data).items.find((item) => item.name === 'agent')!;
    const patch = async (fields: Record<string, unknown>) => {
      const response = await authedFetch(server!, base, '/api/agents/agent', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: initial.workspace_id, scope: 'user', ...fields }),
      });
      return await response.json() as Envelope<unknown>;
    };
    const updated = await patch({ description: 'Edited default' });
    expect(updated.code).toBe(0);
    expect(updated.data).toMatchObject({ main: true, source_file: systemPath.replaceAll('\\', '/'), description: 'Edited default' });
    expect(await readFile(agentPath, 'utf8')).toBe(shadowText);
    expect(await readFile(systemPath, 'utf8')).toContain('Legacy main prompt.');
    const raw = await patch({ raw_text: '---\ndescription: Restricted default\ndisallowedTools: [AgentRun]\n---\nRestricted main prompt.' });
    expect(raw.code).toBe(0);
    const capabilities = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
    const capabilityBody = await capabilities.json() as Envelope<unknown>;
    expect(capabilityBody.code).toBe(0);
    expect(agentCapabilitiesResponseSchema.parse(capabilityBody.data)).toMatchObject({ available: false, targets: expect.arrayContaining([expect.objectContaining({ launch_allowed: false })]) });
    const locator = await patch({ source_file: agentPath.replaceAll('\\', '/'), description: 'Edited shadow' });
    expect(locator.code).toBe(0);
    expect(await readFile(agentPath, 'utf8')).toContain('Edited shadow');
    expect(await readFile(systemPath, 'utf8')).toContain('Restricted main prompt.');
    expect((await patch({ source_file: join(home!, 'unregistered.md'), description: 'Do not create' })).code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
    const legacy = await patch({ raw_text: 'Edited legacy prompt.\r\n' });
    expect(legacy.code).toBe(0);
    expect(legacy.data).toMatchObject({ main: true, source_file: systemPath.replaceAll('\\', '/') });
    expect(await readFile(systemPath)).toEqual(Buffer.from('Edited legacy prompt.\r\n'));
  });

  it.each(['---\ntools: [Read\n---\nBroken.', '---\ntools: [Read]\nBroken.', '---\n- Read\n---\nBroken.'])('R1 rejects malformed SYSTEM management writes without changing restrictions: %s', async (rawText) => {
    const path = join(home!, 'SYSTEM.md');
    const original = '---\r\ndescription: Restricted default\r\ntools: [Read]\r\nsubagents: []\r\n---\r\nRestricted prompt.\r\n';
    await writeFile(path, original);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const read = async () => {
      const response = await authedFetch(server!, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
      return listNamedAgentProfilesResponseSchema.parse((await response.json() as Envelope<unknown>).data).items.find((item) => item.name === 'agent')!;
    };
    const before = await read();
    expect(before).toMatchObject({ source: 'user', tools: ['Read'], subagents: [] });
    const response = await authedFetch(server, base, '/api/agents/agent', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: before.workspace_id, scope: 'user', source_file: before.source_file, raw_text: rawText }),
    });
    expect((await response.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(path)).toEqual(Buffer.from(original));
    expect(await read()).toEqual(before);
  });

  it.each([undefined, false, true])('R2 validates inherited main before an external executor write: main=%s', async (main) => {
    const path = join(home!, 'agents', 'agent.md');
    await mkdir(join(home!, 'agents'), { recursive: true });
    const original = '---\nname: agent\ndescription: Restricted override\noverride: true\ntools: [Read]\nsubagents: []\n---\nRestricted prompt.';
    await writeFile(path, original);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.core.accessor.get(IAgentExecutorRegistry).get('grok-acp')).toBeDefined();
    const read = async () => {
      const response = await authedFetch(server!, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
      return listNamedAgentProfilesResponseSchema.parse((await response.json() as Envelope<unknown>).data).items.find((item) => item.name === 'agent')!;
    };
    const before = await read();
    expect(before).toMatchObject({ main: true, source: 'user', tools: ['Read'], subagents: [] });
    const rawText = original.replace('override: true', `override: true\nexecutor: grok-acp${main === undefined ? '' : `\nmain: ${main}`}`);
    const response = await authedFetch(server, base, '/api/agents/agent', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: before.workspace_id, scope: 'user', source_file: before.source_file, raw_text: rawText }),
    });
    const result = await response.json() as Envelope<unknown>;
    if (main === false) {
      expect(result.code).toBe(0);
      expect(await readFile(path, 'utf8')).toBe(rawText);
      expect(await read()).toMatchObject({ main: false, source: 'user', executor: 'grok-acp', tools: ['Read'], subagents: [] });
    } else {
      expect(result.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(await readFile(path)).toEqual(Buffer.from(original));
      expect(await read()).toEqual(before);
    }
  });

  it('projects caller leases and frozen live targets without launching children or exposing private configuration', async () => {
    await writeFile(join(home!, 'config.toml'), [
      'disabled_named_profiles = ["disabled-helper"]',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"',
      'max_context_size = 1000', '[experimental]', '"agent-profile-routes" = true',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const registry = server.core.accessor.get(IAgentProfileRegistry);
    const helper = (name: string, modelAlias?: string) => normalizeAgentProfile({
      name, definitionId: `definition:${name}`, modelAlias, systemPrompt: () => 'PRIVATE_PROMPT',
    });
    const scoped = helper('private-helper');
    const lead = normalizeAgentProfile({
      name: 'lead', definitionId: 'definition:lead', main: true, tools: ['AgentRun'],
      subagents: ['leased-helper', 'unbound-helper', 'disabled-helper', 'blocked-helper', 'private-helper', 'missing-helper'],
      subagentLeases: {
        'leased-helper': { name: 'leased-helper', modelAlias: 'stub', thinkingEffort: 'off', allowedModels: ['stub'] },
        'blocked-helper': { name: 'blocked-helper', allowedModels: [] },
        'private-helper': { name: 'private-helper', source: './_private/helper.md', modelAlias: 'stub' },
        'missing-helper': { name: 'missing-helper', source: './_private/missing.md' },
      },
      systemPrompt: () => 'Coordinate work.',
    });
    const registration = registry.register({ sourceId: 'example', priority: 50, contribution: {
      profiles: [lead, helper('leased-helper'), helper('unbound-helper'), helper('disabled-helper'), helper('blocked-helper'), helper('hidden-helper')],
      routes: ['stub', 'denied'].map((modelAlias) => ({
        id: `leased-helper.${modelAlias}`, profile: 'leased-helper', description: 'Route example',
        promptMode: 'inherit' as const, prompt: '', modelAlias, thinkingEffort: 'off',
        overriddenFields: ['modelAlias', 'thinkingEffort'], path: `/example/${modelAlias}.md`,
      })),
      scopedBindings: new Map([[lead.definitionId!, new Map([
        ['private-helper', { parentDefinitionId: lead.definitionId!, alias: 'private-helper', source: './_private/helper.md', lease: { name: 'private-helper', source: './_private/helper.md', modelAlias: 'stub' }, status: 'ready' as const, profile: scoped, sourceDefinitionId: scoped.definitionId }],
        ['missing-helper', { parentDefinitionId: lead.definitionId!, alias: 'missing-helper', source: './_private/missing.md', lease: { name: 'missing-helper', source: './_private/missing.md' }, status: 'unavailable' as const }],
      ])]]),
    } });
    try {
      const create = await authedFetch(server, base, '/api/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'lead', model: 'stub' } }),
      });
      const created = await create.json() as Envelope<{ id: string }>;
      expect(created.code).toBe(0);
      const lifecycle = server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(IAgentLifecycleService);
      const tool = lifecycle.get('main')!.accessor.get(ISubagentTool);
      const description = tool.description;
      const response = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
      const body = await response.json() as Envelope<{ targets: Array<{ profile: string; route?: string; defaults_available: boolean; model_alias?: string; model_source?: string; thinking_effort?: string; unavailable_reason?: string }> }>;
      expect(body.code).toBe(0);
      expect(body.data.targets.map((target) => target.route ?? target.profile).toSorted()).toEqual(['leased-helper', 'leased-helper.stub', 'private-helper', 'unbound-helper']);
      expect(body.data.targets.find((target) => target.route === 'leased-helper.stub')).toMatchObject({ defaults_available: true, model_alias: 'stub', model_source: 'route', thinking_effort: 'off' });
      expect(body.data.targets.find((target) => target.profile === 'leased-helper')).toMatchObject({ defaults_available: true, model_alias: 'stub', model_source: 'caller-lease', thinking_effort: 'off' });
      expect(body.data.targets.find((target) => target.profile === 'private-helper')).toMatchObject({ defaults_available: true, model_alias: 'stub' });
      expect(body.data.targets.find((target) => target.profile === 'unbound-helper')).toMatchObject({ defaults_available: false, unavailable_reason: expect.stringContaining('No default model') });
      for (const target of body.data.targets) expect(description).toContain(target.profile);
      expect(JSON.stringify(body.data)).not.toMatch(/PRIVATE_PROMPT|_private|sourceDefinitionId|YOUR_API_KEY|hidden-helper/);
      expect(lifecycle.list()).toHaveLength(1);
      registration.dispose();
      const after = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
      expect((await after.json() as Envelope<unknown>).data).toEqual(body.data);
      expect(tool.description).toBe(description);
    } finally {
      registration.dispose();
    }
  });

  it('projects live launch admission from the pure dispatch policy without changing defaults or draft previews', async () => {
    await writeFile(join(home!, 'config.toml'), [
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const runningServer = server;
    base = `http://127.0.0.1:${server.port}`;
    const registration = server.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'admission-example', priority: 50, contribution: {
      profiles: [
        normalizeAgentProfile({ name: 'lead', main: true, tools: ['AgentRun'], subagents: ['native-helper', 'external-helper'], systemPrompt: () => '' }),
        ...['native', 'external'].map((executor) => normalizeAgentProfile({
          name: `${executor}-helper`, executor, modelAlias: 'stub', systemPrompt: () => '',
        })),
      ],
    } });
    try {
      const create = await authedFetch(server, base, '/api/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'lead', model: 'stub' } }),
      });
      const created = await create.json() as Envelope<{ id: string }>;
      expect(created.code).toBe(0);
      const session = server.core.accessor.get(ISessionManager).get(created.data.id)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const agent = lifecycle.get('main')!;
      const dispatch = session.accessor.get(ISessionDispatchService);
      const read = async (query = `session_id=${created.data.id}&agent_id=main`) => {
        const response = await authedFetch(runningServer, base, `/api/agents/capabilities?${query}`);
        const body = await response.json() as Envelope<unknown>;
        expect(body.code).toBe(0);
        return agentCapabilitiesResponseSchema.parse(body.data);
      };
      const before = await read();
      expect(before.targets.every((target) => target.launch_allowed === true)).toBe(true);
      const interactions = session.accessor.get(ISessionInteractionService);
      const pending = interactions.enqueue({ kind: 'approval', origin: { agentId: 'main' }, payload: { toolName: 'AgentRun' } });
      expect((await read()).tools?.find((tool) => tool.name === 'AgentRun')?.state).toBe('approval-required');
      interactions.respond(pending.id, { decision: 'cancelled' });
      const usage = agent.accessor.get(IAgentUsageService);
      usage.record('unpriced-fixture-model', { inputOther: 10, inputCacheRead: 3, inputCacheCreation: 2, output: 5 }, undefined, { usageKnown: true });
      expect((await read()).metrics?.['main']).toMatchObject({ inputTokens: 15, totalTokens: 20, totalCostUsd: null });
      usage.record('unpriced-fixture-model', { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0 }, undefined, { usageKnown: false });
      const plan = agent.accessor.get(IAgentPlanService);
      await plan.enter();
      const launch = vi.spyOn(dispatch, 'launch');
      const registerReader = vi.spyOn(dispatch, 'registerPlanStateReader');
      const executable = vi.spyOn(server.core.accessor.get(IAgentExecutorRegistry), 'resolveExecutable');
      const policy = dispatch.readLaunchPolicy(agent.id);
      expect(policy.planActive).toBe(true);
      const planned = await read();
      for (const target of planned.targets) {
        const expected = evaluateDispatchAdmission(policy, 'spawn', target.executor);
        expect(target.launch_allowed).toBe(expected.allowed);
        expect(target.launch_unavailable_reason).toBe(expected.reason);
        expect(target.execution_restriction).toBe(expected.executionRestriction);
        expect(target.defaults_available).toBe(before.targets.find((item) => item.profile === target.profile)?.defaults_available);
      }
      expect(planned.targets.find((target) => target.executor === 'native')).toMatchObject({
        launch_allowed: true, defaults_available: true, execution_restriction: 'research-readonly',
      });
      expect(planned.targets.find((target) => target.executor === 'external')).toMatchObject({ launch_allowed: false });
      const draft = await read(`cwd=${encodeURIComponent(home!)}&profile=lead`);
      expect(draft.context).toBe('draft');
      expect(draft.targets).toHaveLength(2);
      expect(draft.targets.every((target) => target.launch_allowed === undefined && target.execution_restriction === undefined)).toBe(true);
      const profile = agent.accessor.get(IAgentProfileService);
      const data = profile.data();
      vi.spyOn(profile, 'data').mockReturnValue({ ...data, executionRestriction: 'research-readonly' });
      const readonly = await read();
      expect(readonly).toMatchObject({ available: false, targets: expect.arrayContaining([expect.objectContaining({ launch_allowed: false })]),
        unavailable_reason: evaluateDispatchAdmission(dispatch.readLaunchPolicy(agent.id), 'spawn').reason });
      expect(readonly.tools?.find((tool) => tool.name === 'AgentRun')).toMatchObject({ state: 'disabled' });
      expect(readonly.profile).toMatchObject({ name: 'lead', execution_restriction: 'research-readonly' });
      expect(readonly.metrics?.['main']).toMatchObject({
        inputTokens: 15, outputTokens: 5, totalTokens: 20, totalCostUsd: null,
        contextTokens: expect.any(Number), contextLimit: expect.any(Number), compactionCount: expect.any(Number),
        usagePartial: true, costPartial: true, usageSource: 'persisted',
      });
      expect(launch).not.toHaveBeenCalled();
      expect(registerReader).not.toHaveBeenCalled();
      expect(executable).not.toHaveBeenCalled();
      expect(lifecycle.list()).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      registration.dispose();
    }
  });

  it('projects file-backed profiles with source paths and route model pins', async () => {
    const agentsDir = join(home as string, 'agents');
    const routeDir = join(agentsDir, '.routes', 'reviewer');
    await mkdir(routeDir, { recursive: true });
    const profilePath = join(agentsDir, 'reviewer.md');
    const routePath = join(routeDir, 'fast.md');
    await writeFile(
      join(home as string, 'config.toml'),
      [
        'disabled_builtin_profiles = ["explore", "agent"]',
        'disabled_named_profiles = ["reviewer"]',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
        '[experimental]',
        '"agent-profile-routes" = true',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      profilePath,
      [
        '---',
        'name: reviewer',
        'description: Reviews changes',
        'whenToUse: Review important changes',
        'main: true',
        'model_alias: provider/pinned',
        'thinking_effort: high',
        'service_tier: priority',
        'context_budget: 4096',
        'max_completion_tokens: 512',
        'request_params:',
        '  temperature: 0.4',
        'tools: [Read, Bash]',
        'disallowedTools: [Write]',
        'model_profiles:',
        '  - alias: provider/fast',
        '    when: Use for quick reviews',
        '    context_budget: 2048',
        '    max_completion_tokens: 256',
        '    service_tier: flex',
        '    request_params:',
        '      temperature: 0.2',
        '    thinking_effort: low',
        '    allowed_efforts: [low, medium]',
        'spawn_constraints:',
        '  allowed_models: [provider/pinned]',
        '  deny_models: [provider/blocked]',
        '  allowed_efforts: [high]',
        '  disallowed_tools: [Write]',
        'subagents:',
        '  - explore',
        '  - name: reviewer-helper',
        '    description: Assists reviews',
        '    model_alias: provider/fast',
        '    thinking_effort: low',
        '    allowed_models: [provider/fast]',
        '    tools: ["*"]',
        '    subagents: ["*"]',
        '    delegation_notice: off',
        '    service_tier: flex',
        '    request_params:',
        '      temperature: 0.2',
        '    model_profiles:',
        '      - alias: provider/fast',
        '        when: Use for review assistance',
        '        context_budget: 1024',
        '        max_completion_tokens: 128',
        '        service_tier: flex',
        '        request_params:',
        '          temperature: 0.1',
        '---',
        '',
        'Review the change.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      routePath,
      [
        '---',
        'id: reviewer.fast',
        'profile: reviewer',
        'description: Fast review route',
        'prompt_mode: prepend',
        'model_alias: provider/route',
        '---',
        '',
        'Prioritize speed.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(agentsDir, 'm3-worker.md'),
      '---\nname: m3-worker\ndescription: Private worker\nprivate: true\n---\n\nPrivate worker prompt.\n',
      'utf-8',
    );

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const create = await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { model: 'stub' } }),
    });
    const created = (await create.json()) as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const otherWorkspace = join(home as string, 'other-workspace');
    await mkdir(otherWorkspace, { recursive: true });
    const createOther = await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: otherWorkspace } }),
    });
    expect(((await createOther.json()) as Envelope<{ id: string }>).code).toBe(0);

    const response = await authedFetch(server, base, '/api/agents');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    const data = listNamedAgentProfilesResponseSchema.parse(body.data);
    expect(data.items.some((profile) => profile.name === 'm3-worker')).toBe(false);
    const reviewer = data.items.find((profile) => profile.name === 'reviewer' && profile.source === 'user');
    expect(reviewer).toEqual({
      name: 'reviewer',
      description: 'Reviews changes',
      when_to_use: 'Review important changes',
      source: 'user',
      workspace_id: expect.any(String),
      workspace_ids: [expect.any(String), expect.any(String)],
      source_file: profilePath.replaceAll('\\', '/'),
      main: true,
      executor: 'native',
      executor_protocol: 'native',
      pinned_model_alias: 'provider/pinned',
      thinking_effort: 'high',
      service_tier: 'priority',
      request_params: { temperature: 0.4 },
      context_budget: 4096,
      max_completion_tokens: 512,
      tools: ['Read', 'Bash'],
      disallowed_tools: ['Write'],
      model_profiles: [{
        alias: 'provider/fast',
        when: 'Use for quick reviews',
        context_budget: 2048,
        max_completion_tokens: 256,
        service_tier: 'flex',
        request_params: { temperature: 0.2 },
        thinking_effort: 'low',
        allowed_efforts: ['low', 'medium'],
      }],
      spawn_constraints: {
        allowed_models: ['provider/pinned'],
        deny_models: ['provider/blocked'],
        allowed_efforts: ['high'],
        disallowed_tools: ['Write'],
      },
      subagents: [
        'explore',
        {
          name: 'reviewer-helper',
          description: 'Assists reviews',
          model_alias: 'provider/fast',
          thinking_effort: 'low',
          allowed_models: ['provider/fast'],
          tools: null,
          subagents: null,
          delegation_notice: 'off',
          service_tier: 'flex',
          request_params: { temperature: 0.2 },
          model_profiles: [{
            alias: 'provider/fast',
            when: 'Use for review assistance',
            context_budget: 1024,
            max_completion_tokens: 128,
            service_tier: 'flex',
            request_params: { temperature: 0.1 },
          }],
        },
      ],
      disabled: true,
      routes: [{
        id: 'reviewer.fast',
        description: 'Fast review route',
        model_alias: 'provider/route',
        source_file: routePath.replaceAll('\\', '/'),
      }],
    });
    expect(data.items.filter((profile) =>
      profile.name === 'reviewer' && profile.source_file === profilePath.replaceAll('\\', '/')
    )).toHaveLength(1);
    expect(data.items.find((profile) => profile.name === 'explore' && profile.source === 'builtin')?.disabled).toBe(true);
    expect(data.items.find((profile) => profile.name === 'agent' && profile.source === 'builtin')?.disabled).toBe(true);

    const expandedResponse = await authedFetch(server, base, '/api/agents?expand=1');
    expect(expandedResponse.status).toBe(200);
    const expandedBody = (await expandedResponse.json()) as Envelope<unknown>;
    expect(expandedBody.code).toBe(0);
    const expanded = listNamedAgentProfilesResponseSchema.parse(expandedBody.data);
    const expandedReviewers = expanded.items.filter((profile) =>
      profile.name === 'reviewer'
      && profile.source === 'user'
      && profile.source_file === profilePath.replaceAll('\\', '/')
    );
    expect(expandedReviewers).toHaveLength(2);
    expect(expandedReviewers.every((profile) => profile.workspace_ids === undefined)).toBe(true);
    expect(new Set(expandedReviewers.map((profile) => profile.workspace_id)).size).toBe(2);
    expect(expandedReviewers.every((profile) => profile.disabled)).toBe(true);

    const patchedResponse = await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: reviewer?.workspace_id,
        description: 'Reviews changes carefully',
        when_to_use: 'Use for final review',
        pinned_model_alias: 'provider/updated',
        thinking_effort: 'medium',
        service_tier: 'flex',
        tools: ['Read'],
        disallowed_tools: null,
        routes: [{ id: 'reviewer.fast', model_alias: 'provider/route-updated' }],
      }),
    });
    const patched = (await patchedResponse.json()) as Envelope<{
      description?: string;
      pinned_model_alias?: string;
      routes: Array<{ id: string; model_alias?: string }>;
    }>;
    expect(patched.code).toBe(0);
    expect(patched.data).toMatchObject({
      name: 'reviewer',
      description: 'Reviews changes carefully',
      when_to_use: 'Use for final review',
      source: 'user',
      workspace_id: reviewer?.workspace_id,
      pinned_model_alias: 'provider/updated',
      thinking_effort: 'medium',
      service_tier: 'flex',
      request_params: { temperature: 0.4 },
      context_budget: 4096,
      max_completion_tokens: 512,
      model_profiles: [{
        alias: 'provider/fast',
        when: 'Use for quick reviews',
        context_budget: 2048,
        max_completion_tokens: 256,
        service_tier: 'flex',
        request_params: { temperature: 0.2 },
        thinking_effort: 'low',
        allowed_efforts: ['low', 'medium'],
      }],
      tools: ['Read'],
      disabled: true,
      routes: [{ id: 'reviewer.fast', model_alias: 'provider/route-updated' }],
    });
    expect(await readFile(profilePath, 'utf8')).toContain('description: "Reviews changes carefully"');
    expect(await readFile(routePath, 'utf8')).toContain('model_alias: "provider/route-updated"');

    const rawText = [
      '---',
      'name: reviewer',
      'description: Raw REST update',
      'context_budget: 3072',
      'max_completion_tokens: 384',
      'service_tier: default',
      'request_params:',
      '  top_p: 0.8',
      'model_profiles:',
      '  - alias: provider/fast',
      '    context_budget: 1024',
      '    max_completion_tokens: 128',
      '    service_tier: flex',
      '    request_params:',
      '      temperature: 0.1',
      '    thinking_effort: low',
      '---',
      '',
      'Raw body.',
      '',
    ].join('\n');
    const rawResponse = await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: reviewer?.workspace_id,
        raw_text: rawText,
      }),
    });
    const raw = (await rawResponse.json()) as Envelope<{
      description?: string;
      context_budget?: number;
      max_completion_tokens?: number;
      service_tier?: string;
      request_params?: Record<string, string | number | boolean>;
      model_profiles?: Array<{
        alias: string;
        when?: string;
        context_budget?: number;
        max_completion_tokens?: number;
        service_tier?: string;
        request_params?: Record<string, string | number | boolean>;
      }>;
    }>;
    expect(raw.code).toBe(0);
    expect(raw.data).toMatchObject({
      description: 'Raw REST update',
      context_budget: 3072,
      max_completion_tokens: 384,
      service_tier: 'default',
      request_params: { top_p: 0.8 },
      model_profiles: [{
        alias: 'provider/fast',
        context_budget: 1024,
        max_completion_tokens: 128,
        service_tier: 'flex',
        request_params: { temperature: 0.1 },
        thinking_effort: 'low',
      }],
    });
    expect(await readFile(profilePath, 'utf8')).toBe(rawText);
    const rereadResponse = await authedFetch(server, base, '/api/agents');
    const rereadBody = (await rereadResponse.json()) as Envelope<unknown>;
    const reread = listNamedAgentProfilesResponseSchema.parse(rereadBody.data);
    const rereadReviewer = reread.items.find((profile) => profile.name === 'reviewer' && profile.source === 'user');
    expect(rereadReviewer).toMatchObject({
      context_budget: 3072,
      max_completion_tokens: 384,
      service_tier: 'default',
      request_params: { top_p: 0.8 },
      model_profiles: [{
        alias: 'provider/fast',
        context_budget: 1024,
        max_completion_tokens: 128,
        service_tier: 'flex',
        request_params: { temperature: 0.1 },
      }],
    });
    expect(rereadReviewer?.model_profiles?.[0]).not.toHaveProperty('when');

    const mixedResponse = await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: reviewer?.workspace_id,
        raw_text: rawText,
        description: 'mixed',
      }),
    });
    expect(((await mixedResponse.json()) as Envelope<null>).code).toBe(40001);
  });

  it('loads and isolates workspace profiles for scoped requests without live sessions', async () => {
    const workspaceA = join(home as string, 'workspace-a');
    const workspaceB = join(home as string, 'workspace-b');
    const agentsA = join(workspaceA, '.kiki', 'agents');
    const agentsB = join(workspaceB, '.kiki', 'agents');
    await mkdir(agentsA, { recursive: true });
    await mkdir(agentsB, { recursive: true });
    await mkdir(join(workspaceA, '.git'));
    await mkdir(join(workspaceB, '.git'));
    await writeFile(
      join(agentsA, 'workspace-choice.md'),
      '---\nname: workspace-choice\ndescription: Workspace A choice\nmain: true\n---\n\nUse workspace A.\n',
      'utf-8',
    );
    await writeFile(
      join(agentsB, 'workspace-choice.md'),
      '---\nname: workspace-choice\ndescription: Workspace B helper\nmain: false\n---\n\nUse workspace B.\n',
      'utf-8',
    );

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const runningServer = server;
    const registerWorkspace = async (root: string): Promise<string> => {
      const response = await authedFetch(runningServer, base, '/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      });
      const body = (await response.json()) as Envelope<{ id: string }>;
      expect(body.code).toBe(0);
      return body.data.id;
    };
    const workspaceAId = await registerWorkspace(workspaceA);
    const workspaceBId = await registerWorkspace(workspaceB);
    expect(server.core.accessor.get(ISessionManager).list()).toHaveLength(0);

    const listScoped = async (workspaceId: string) => {
      const response = await authedFetch(
        runningServer,
        base,
        `/api/agents?workspace_id=${encodeURIComponent(workspaceId)}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Envelope<unknown>;
      expect(body.code).toBe(0);
      return listNamedAgentProfilesResponseSchema.parse(body.data);
    };

    const scopedA = await listScoped(workspaceAId);
    expect(scopedA.complete).toBe(true);
    expect(scopedA.items.find((profile) =>
      profile.name === 'workspace-choice' && profile.source === 'workspace'
    )).toMatchObject({
      description: 'Workspace A choice',
      workspace_id: workspaceAId,
      main: true,
    });
    expect(scopedA.items.some((profile) => profile.description === 'Workspace B helper')).toBe(false);

    const scopedB = await listScoped(workspaceBId);
    expect(scopedB.items.find((profile) =>
      profile.name === 'workspace-choice' && profile.source === 'workspace'
    )).toMatchObject({
      description: 'Workspace B helper',
      workspace_id: workspaceBId,
      main: false,
    });
    expect(scopedB.items.some((profile) => profile.description === 'Workspace A choice')).toBe(false);

    for (const query of [
      `workspace_id=${encodeURIComponent(workspaceAId)}`,
      `cwd=${encodeURIComponent(workspaceA)}`,
    ]) {
      const response = await authedFetch(runningServer, base, `/api/agents?effective=true&${query}`);
      const body = await response.json() as Envelope<unknown>;
      expect(body.code).toBe(0);
      expect(listNamedAgentProfilesResponseSchema.parse(body.data).items.filter((item) => item.name === 'workspace-choice'))
        .toMatchObject([{ main: true, description: 'Workspace A choice', disabled: false }]);
      const capabilities = await authedFetch(runningServer, base,
        `/api/agents/capabilities?${query}&profile=workspace-choice`);
      const capabilityBody = await capabilities.json() as Envelope<{ context: string; owner: { profile: string }; targets: unknown[] }>;
      expect(capabilityBody.code).toBe(0);
      expect(capabilityBody.data).toMatchObject({ context: 'draft', owner: { profile: 'workspace-choice' } });
    }

    const scopedAAgain = await listScoped(workspaceAId);
    expect(scopedAAgain.items.find((profile) =>
      profile.name === 'workspace-choice' && profile.source === 'workspace'
    )?.main).toBe(true);
    expect(server.core.accessor.get(ISessionManager).list()).toHaveLength(0);
    const instances = server.core.accessor.get(IWorkspaceInstanceManager);
    expect(instances.referenceCount(workspaceAId)).toBe(0);
    expect(instances.referenceCount(workspaceBId)).toBe(0);

    const missingResponse = await authedFetch(
      runningServer,
      base,
      '/api/agents?workspace_id=wd_missing',
    );
    const missing = (await missingResponse.json()) as Envelope<null>;
    expect(missing.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
  });

  it('projects scoped source leases without exposing private definitions or absolute paths', async () => {
    const agentsDir = join(home as string, 'agents');
    const privateDir = join(agentsDir, '_private', 'research');
    await mkdir(privateDir, { recursive: true });
    const parentPath = join(agentsDir, 'research-lead.md');
    const childPath = join(privateDir, 'writer.md');
    await writeFile(
      parentPath,
      [
        '---',
        'name: research-lead',
        'description: Coordinates research',
        'subagents:',
        '  - name: research-writer',
        '    source: ./_private/research/writer.md',
        '    description: Writes research summaries',
        '  - name: missing-writer',
        '    source: ./_private/research/missing.md',
        '---',
        '',
        'Coordinate research.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      childPath,
      [
        '---',
        'name: private-research-writer',
        'description: Internal research writer',
        '---',
        '',
        'Write the research summary.',
        '',
      ].join('\n'),
      'utf-8',
    );

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const create = await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    expect(((await create.json()) as Envelope<{ id: string }>).code).toBe(0);

    const response = await authedFetch(server, base, '/api/agents');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    const data = listNamedAgentProfilesResponseSchema.parse(body.data);
    const parent = data.items.find((profile) =>
      profile.name === 'research-lead' && profile.source === 'user'
    );
    expect(parent?.subagents).toEqual([
      {
        name: 'research-writer',
        source: './_private/research/writer.md',
        scope: 'private',
        status: 'ready',
        description: 'Writes research summaries',
      },
      {
        name: 'missing-writer',
        source: './_private/research/missing.md',
        scope: 'private',
        status: 'unavailable',
        diagnostic: 'Source profile is unavailable',
      },
    ]);
    expect(data.items.some((profile) => profile.name === 'private-research-writer')).toBe(false);
    const projectedLeases = JSON.stringify(parent?.subagents);
    expect(projectedLeases).not.toContain(childPath.replaceAll('\\', '/'));
    expect(projectedLeases).not.toContain((home as string).replaceAll('\\', '/'));
    expect(projectedLeases).not.toContain('sourceDefinitionId');
  });

  it('projects scoped source status from a loaded workspace without a live session', async () => {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const parentDefinitionId = 'definition:offline-lead';
    const readyLease = { name: 'offline-writer', source: './_private/writer.md' } as const;
    const unavailableLease = { name: 'missing-writer', source: './_private/missing.md' } as const;
    const profile = normalizeAgentProfile({
      name: 'offline-lead',
      definitionId: parentDefinitionId,
      subagents: [readyLease.name, unavailableLease.name],
      subagentLeases: {
        [readyLease.name]: readyLease,
        [unavailableLease.name]: unavailableLease,
      },
      systemPrompt: () => 'Coordinate offline research.',
    });
    const registration = server.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'workspace',
      priority: 30,
      workspaceKey: 'wd_offline',
      contribution: {
        profiles: [profile],
        scopedBindings: new Map([
          [parentDefinitionId, new Map([
            [readyLease.name, {
              parentDefinitionId,
              alias: readyLease.name,
              source: readyLease.source,
              lease: readyLease,
              status: 'ready' as const,
              sourceDefinitionId: 'C:/Users/private/_private/writer.md',
            }],
            [unavailableLease.name, {
              parentDefinitionId,
              alias: unavailableLease.name,
              source: unavailableLease.source,
              lease: unavailableLease,
              status: 'unavailable' as const,
              diagnostic: {
                code: AgentProfileSourceDiagnosticCodes.UNAVAILABLE,
                severity: 'error' as const,
                message: 'Scoped source C:/Users/private/_private/missing.md is unavailable',
                path: 'C:/Users/private/_private/missing.md',
              },
            }],
          ])],
        ]),
      },
    });
    expect(server.core.accessor.get(ISessionManager).list()).toHaveLength(0);

    const response = await authedFetch(server, base, '/api/agents');
    registration.dispose();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const data = listNamedAgentProfilesResponseSchema.parse(body.data);
    const parent = data.items.find((item) =>
      item.name === 'offline-lead' && item.source === 'workspace'
    );
    expect(parent?.subagents).toEqual([
      {
        name: 'offline-writer',
        source: './_private/writer.md',
        scope: 'private',
        status: 'ready',
      },
      {
        name: 'missing-writer',
        source: './_private/missing.md',
        scope: 'private',
        status: 'unavailable',
        diagnostic: 'Source profile is unavailable',
      },
    ]);
    const projectedLeases = JSON.stringify(parent?.subagents);
    expect(projectedLeases).not.toContain('C:/Users/private');
    expect(projectedLeases).not.toContain('sourceDefinitionId');
  });

  it('keeps private profiles out of every listing while still resolving them by name and lease', async () => {
    await writeFile(join(home!, 'config.toml'), [
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"',
      'max_context_size = 1000', '[experimental]', '"agent-profile-routes" = true',
    ].join('\n'));
    const agentsDir = join(home as string, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'm3-worker.md'),
      '---\nname: m3-worker\ndescription: Private worker\nprivate: true\n---\n\nPrivate worker prompt.\n',
      'utf-8',
    );
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const registry = server.core.accessor.get(IAgentProfileRegistry);
    const helper = normalizeAgentProfile({
      name: 'helper', definitionId: 'definition:helper', private: true, modelAlias: 'stub',
      systemPrompt: () => 'PRIVATE_HELPER_PROMPT',
    });
    const lead = normalizeAgentProfile({
      name: 'agent', definitionId: 'definition:private-main', main: true, private: true, override: true,
      tools: ['AgentRun'], subagents: ['helper'],
      subagentLeases: { helper: { name: 'helper', source: './_private/helper.md', modelAlias: 'stub' } },
      systemPrompt: () => 'PRIVATE_MAIN_PROMPT',
    });
    const registration = registry.register({ sourceId: 'example', priority: 50, contribution: {
      profiles: [lead, helper],
      scopedBindings: new Map([[lead.definitionId!, new Map([
        ['helper', { parentDefinitionId: lead.definitionId!, alias: 'helper', source: './_private/helper.md', lease: { name: 'helper', source: './_private/helper.md', modelAlias: 'stub' }, status: 'ready' as const, profile: helper, sourceDefinitionId: helper.definitionId }],
      ])]]),
    } });
    try {
      const create = await authedFetch(server, base, '/api/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } }),
      });
      expect(((await create.json()) as Envelope<{ id: string }>).code).toBe(0);
      const query = `cwd=${encodeURIComponent(home as string)}`;

      const plain = listNamedAgentProfilesResponseSchema.parse(
        ((await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>).data,
      );
      expect(plain.items.some((profile) => profile.source === 'example')).toBe(false);
      expect(plain.items.some((profile) => profile.name === 'm3-worker' || profile.name === 'helper')).toBe(false);
      expect(plain.items.some((profile) => profile.name === 'explore' && profile.source === 'builtin')).toBe(true);

      const expanded = listNamedAgentProfilesResponseSchema.parse(
        ((await (await authedFetch(server, base, `/api/agents?${query}&expand=true`)).json()) as Envelope<unknown>).data,
      );
      expect(expanded.items.some((profile) => profile.source === 'example')).toBe(false);
      expect(expanded.items.some((profile) => profile.name === 'helper')).toBe(false);

      const effective = listNamedAgentProfilesResponseSchema.parse(
        ((await (await authedFetch(server, base, `/api/agents?${query}&effective=true`)).json()) as Envelope<unknown>).data,
      );
      const effectiveLead = effective.items.find((profile) => profile.name === 'agent' && profile.source === 'example');
      expect(effectiveLead?.subagents).toEqual([
        expect.objectContaining({ name: 'helper', source: './_private/helper.md', scope: 'private', status: 'ready' }),
      ]);

      const capabilities = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
      const caps = (await capabilities.json()) as Envelope<{ targets: Array<{ profile: string }> }>;
      expect(caps.code).toBe(0);
      expect(caps.data.targets.map((target) => target.profile)).toContain('helper');
    } finally {
      registration.dispose();
    }
  });

  it('projects the override flag so clients can show which same-name profile wins', async () => {
    const agentsDir = join(home as string, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'agent.md'), '---\nname: agent\ndescription: File main override\noverride: true\ntools: [Read]\n---\nCustom file main.');
    await writeFile(
      join(agentsDir, 'explore.md'),
      [
        '---',
        'name: explore',
        'description: User-scoped exploration profile',
        'override: true',
        '---',
        '',
        'Explore carefully.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      [
        '---',
        'name: reviewer',
        'description: User reviewer without override',
        '---',
        '',
        'Review carefully.',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });

    const listed = (await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>;
    const data = listNamedAgentProfilesResponseSchema.parse(listed.data);
    const builtinExplore = data.items.find((profile) => profile.name === 'explore' && profile.source === 'builtin');
    const userExplore = data.items.find((profile) => profile.name === 'explore' && profile.source === 'user');
    expect(builtinExplore?.override).toBeUndefined();
    expect(userExplore?.override).toBe(true);
    const userReviewer = data.items.find((profile) => profile.name === 'reviewer' && profile.source === 'user');
    expect(userReviewer?.override).toBeUndefined();
    expect(data.items.find((profile) => profile.name === 'agent' && profile.source === 'user')).toMatchObject({ main: true, tools: ['Read'] });
    const query = `cwd=${encodeURIComponent(home!)}`;
    const effectiveResponse = await authedFetch(server, base, `/api/agents?${query}&effective=true`);
    const effective = listNamedAgentProfilesResponseSchema.parse((await effectiveResponse.json() as Envelope<unknown>).data);
    expect(effective.items.filter((profile) => profile.name === 'agent')).toMatchObject([{ main: true, source: 'user', tools: ['Read'] }]);
    const capabilities = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
    expect((await capabilities.json() as Envelope<unknown>).data).toMatchObject({ available: false, targets: expect.arrayContaining([expect.objectContaining({ launch_allowed: false })]) });
  });

  it('rejects writes to builtin profiles with a read-only business code', async () => {
    const agentsDir = join(home as string, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: reviewer\n---\n\nReview.\n',
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const listed = (await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>;
    const data = listNamedAgentProfilesResponseSchema.parse(listed.data);
    const workspaceId = data.items.find((profile) => profile.name === 'reviewer')?.workspace_id;

    const response = await authedFetch(server, base, '/api/agents/agent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: workspaceId,
        description: 'cannot edit builtin',
      }),
    });
    const body = (await response.json()) as Envelope<null>;
    expect(body.code).toBe(40934);
    expect(body.msg).toContain('read-only');
  });

  it('returns field details when the PATCH body requests non-editable fields', async () => {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const response = await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: 'wd_test',
        subagents: ['explore'],
      }),
    });
    const body = (await response.json()) as Envelope<null> & {
      details?: Array<{ path: string; message: string }>;
    };
    expect(body.code).toBe(40001);
    expect(body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/subagents|^$/) }),
    ]));
  });

  it('restores persisted main and completed child usage with partial provenance after restart', async () => {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const response = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const created = await response.json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const session = server.core.accessor.get(ISessionManager).get(created.data.id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const main = lifecycle.get('main') ?? await lifecycle.create({ agentId: 'main' });
    main.accessor.get(IAgentUsageService).record('priced-fixture', {
      inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0,
    }, undefined, { usageKnown: true });
    main.accessor.get(IAgentUsageService).record('priced-fixture', {
      inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
    }, undefined, { usageKnown: false });
    const child = await lifecycle.create({ agentId: 'agent-7' });
    child.accessor.get(IAgentUsageService).record('priced-fixture', {
      inputOther: 20, output: 10, inputCacheRead: 5, inputCacheCreation: 0,
    }, undefined, { usageKnown: true });
    await lifecycle.remove('agent-7');
    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const restored = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
    const data = agentCapabilitiesResponseSchema.parse((await restored.json() as Envelope<unknown>).data);
    expect(data.metrics?.['main']).toMatchObject({ totalTokens: 15, inputTokens: 10, outputTokens: 5, usagePartial: true, costPartial: true, usageSource: 'persisted' });
    expect(data.metrics?.['agent-7']).toMatchObject({ totalTokens: 35, inputTokens: 25, outputTokens: 10, usagePartial: false, usageSource: 'persisted' });
  });
});

describe('GET /agents named resolution', () => {
  it('resolves a profile hidden from the catalog public view through its resolvable view', async () => {
    const helper = normalizeAgentProfile({
      name: 'hidden-helper', definitionId: 'definition:hidden-helper', systemPrompt: () => '',
    });
    const lead = normalizeAgentProfile({
      name: 'hidden-lead', definitionId: 'definition:hidden-lead',
      subagents: ['hidden-helper'],
      subagentLeases: { 'hidden-helper': { name: 'hidden-helper', source: './_private/helper.md' } },
      systemPrompt: () => '',
    });
    const exposed = normalizeAgentProfile({ name: 'exposed', definitionId: 'definition:exposed', systemPrompt: () => '' });
    const snapshot = {
      publicProfiles: new Map([[exposed.name, exposed]]),
      resolvableProfiles: new Map([
        [exposed.name, exposed], [lead.name, lead], [helper.name, helper],
      ]),
      routes: new Map(),
      scopedBindings: new Map([[lead.definitionId!, new Map([
        ['hidden-helper', { parentDefinitionId: lead.definitionId!, alias: 'hidden-helper', source: './_private/helper.md', lease: { name: 'hidden-helper', source: './_private/helper.md' }, status: 'ready' as const, profile: helper, sourceDefinitionId: helper.definitionId }],
      ])]]),
      sourceDefinitions: new Map([[helper.definitionId!, helper]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    } as unknown as AgentProfileCatalogSnapshot;
    const catalog = {
      ready: Promise.resolve(),
      get: (name: string) => snapshot.publicProfiles.get(name),
      snapshot: () => snapshot,
    } as unknown as ISessionAgentProfileCatalog;
    const session = {
      accessor: {
        get: (token: unknown) => token === ISessionContext ? { workspaceId: 'wd_named' } : catalog,
      },
    };
    const registration: AgentProfileRegistration = {
      sourceId: 'user', priority: 50, contribution: { profiles: [lead, exposed] },
    };
    const handlers = new Map<string, (req: unknown, reply: { send(payload: unknown): unknown }) => unknown>();
    const app = {
      get: (path: string, _options: unknown, handler: never) => { handlers.set(path, handler); },
      patch: () => {},
    };
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentProfileRegistry) return { entries: () => [registration] };
          if (token === IAgentExecutorRegistry) return { get: () => undefined };
          if (token === IConfigService) return { ready: Promise.resolve(), get: () => undefined };
          if (token === ISessionManager) return { list: () => [session] };
          throw new Error('unexpected token');
        },
      },
    };

    registerAgentProfilesRoute(
      app as unknown as Parameters<typeof registerAgentProfilesRoute>[0],
      core as unknown as Parameters<typeof registerAgentProfilesRoute>[1],
    );
    let sent: unknown;
    await handlers.get('/agents')!(
      { id: 'req', query: {} },
      { send: (payload) => { sent = payload; } },
    );

    const body = sent as { code: number; data: { items: Array<{ name: string; subagents?: unknown }> } };
    expect(body.code).toBe(0);
    expect(body.data.items.map((item) => item.name).toSorted()).toEqual(['exposed', 'hidden-lead']);
    expect(body.data.items.find((item) => item.name === 'hidden-lead')?.subagents).toEqual([
      expect.objectContaining({ name: 'hidden-helper', scope: 'private', status: 'ready' }),
    ]);
  });
});
