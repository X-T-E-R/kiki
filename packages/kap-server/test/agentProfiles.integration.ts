import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentProfileSourceDiagnosticCodes,
  IAgentProfileRegistry,
  ISessionManager,
  normalizeAgentProfile,
} from '@moonshot-ai/agent-core-v2';
import { listNamedAgentProfilesResponseSchema } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('GET /api/v1/agents', () => {
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
        'tools: [Read, Bash]',
        'disallowedTools: [Write]',
        'model_profiles:',
        '  - alias: provider/fast',
        '    when: Use for quick reviews',
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

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const create = await authedFetch(server, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { model: 'stub' } }),
    });
    const created = (await create.json()) as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const otherWorkspace = join(home as string, 'other-workspace');
    await mkdir(otherWorkspace, { recursive: true });
    const createOther = await authedFetch(server, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: otherWorkspace } }),
    });
    expect(((await createOther.json()) as Envelope<{ id: string }>).code).toBe(0);

    const response = await authedFetch(server, base, '/api/v1/agents');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    const data = listNamedAgentProfilesResponseSchema.parse(body.data);
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
      tools: ['Read', 'Bash'],
      disallowed_tools: ['Write'],
      model_profiles: [{
        alias: 'provider/fast',
        when: 'Use for quick reviews',
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

    const expandedResponse = await authedFetch(server, base, '/api/v1/agents?expand=1');
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

    const patchedResponse = await authedFetch(server, base, '/api/v1/agents/reviewer', {
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
      tools: ['Read'],
      disabled: false,
      routes: [{ id: 'reviewer.fast', model_alias: 'provider/route-updated' }],
    });
    expect(await readFile(profilePath, 'utf8')).toContain('description: "Reviews changes carefully"');
    expect(await readFile(routePath, 'utf8')).toContain('model_alias: "provider/route-updated"');

    const rawText = '---\nname: reviewer\ndescription: Raw REST update\n---\n\nRaw body.\n';
    const rawResponse = await authedFetch(server, base, '/api/v1/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: reviewer?.workspace_id,
        raw_text: rawText,
      }),
    });
    const raw = (await rawResponse.json()) as Envelope<{ description?: string }>;
    expect(raw.code).toBe(0);
    expect(raw.data.description).toBe('Raw REST update');
    expect(await readFile(profilePath, 'utf8')).toBe(rawText);

    const mixedResponse = await authedFetch(server, base, '/api/v1/agents/reviewer', {
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
    const create = await authedFetch(server, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    expect(((await create.json()) as Envelope<{ id: string }>).code).toBe(0);

    const response = await authedFetch(server, base, '/api/v1/agents');
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

    const response = await authedFetch(server, base, '/api/v1/agents');
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

  it('projects the override flag so clients can show which same-name profile wins', async () => {
    const agentsDir = join(home as string, 'agents');
    await mkdir(agentsDir, { recursive: true });
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
    await authedFetch(server, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });

    const listed = (await (await authedFetch(server, base, '/api/v1/agents')).json()) as Envelope<unknown>;
    const data = listNamedAgentProfilesResponseSchema.parse(listed.data);
    const builtinExplore = data.items.find((profile) => profile.name === 'explore' && profile.source === 'builtin');
    const userExplore = data.items.find((profile) => profile.name === 'explore' && profile.source === 'user');
    expect(builtinExplore?.override).toBeUndefined();
    expect(userExplore?.override).toBe(true);
    const userReviewer = data.items.find((profile) => profile.name === 'reviewer' && profile.source === 'user');
    expect(userReviewer?.override).toBeUndefined();
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
    await authedFetch(server, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const listed = (await (await authedFetch(server, base, '/api/v1/agents')).json()) as Envelope<unknown>;
    const data = listNamedAgentProfilesResponseSchema.parse(listed.data);
    const workspaceId = data.items.find((profile) => profile.name === 'reviewer')?.workspace_id;

    const response = await authedFetch(server, base, '/api/v1/agents/agent', {
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

    const response = await authedFetch(server, base, '/api/v1/agents/reviewer', {
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
});
