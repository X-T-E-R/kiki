import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listNamedAgentProfilesResponseSchema } from '../src/protocol/rest-agentProfile';
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
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it('projects file-backed profiles with source paths and route model pins', async () => {
    const agentsDir = join(home as string, 'agents');
    const routeDir = join(agentsDir, '.routes', 'reviewer');
    await mkdir(routeDir, { recursive: true });
    const profilePath = join(agentsDir, 'reviewer.md');
    const routePath = join(routeDir, 'fast.md');
    await writeFile(
      join(home as string, 'config.toml'),
      '[experimental]\n"agent-profile-routes" = true\n',
      'utf-8',
    );
    await writeFile(
      profilePath,
      [
        '---',
        'name: reviewer',
        'description: Reviews changes',
        'model_alias: provider/pinned',
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
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const created = (await create.json()) as Envelope<{ id: string }>;
    expect(created.code).toBe(0);

    const response = await authedFetch(server, base, '/api/v1/agents');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    const data = listNamedAgentProfilesResponseSchema.parse(body.data);
    const reviewer = data.items.find((profile) => profile.name === 'reviewer' && profile.source === 'user');
    expect(reviewer).toEqual({
      name: 'reviewer',
      description: 'Reviews changes',
      source: 'user',
      workspace_id: expect.any(String),
      source_file: profilePath.replaceAll('\\', '/'),
      pinned_model_alias: 'provider/pinned',
      routes: [{
        id: 'reviewer.fast',
        description: 'Fast review route',
        model_alias: 'provider/route',
        source_file: routePath.replaceAll('\\', '/'),
      }],
    });
    expect(data.items.some((profile) => profile.source === 'builtin')).toBe(true);

    const patchedResponse = await authedFetch(server, base, '/api/v1/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: reviewer?.workspace_id,
        description: 'Reviews changes carefully',
        pinned_model_alias: 'provider/updated',
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
      source: 'user',
      workspace_id: reviewer?.workspace_id,
      pinned_model_alias: 'provider/updated',
      routes: [{ id: 'reviewer.fast', model_alias: 'provider/route-updated' }],
    });
    expect(await readFile(profilePath, 'utf8')).toContain('description: "Reviews changes carefully"');
    expect(await readFile(routePath, 'utf8')).toContain('model_alias: "provider/route-updated"');
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
        tools: ['Read'],
      }),
    });
    const body = (await response.json()) as Envelope<null> & {
      details?: Array<{ path: string; message: string }>;
    };
    expect(body.code).toBe(40001);
    expect(body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/tools|^$/) }),
    ]));
  });
});
