import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ISessionExternalDelegationProvisionStore,
  ISessionManager,
  resumeSessionById,
} from '@moonshot-ai/agent-core-v2';

import { type RunningServer, startServer } from '../src/start';
import { externalDelegationAuthorityFromEnv } from '../src/mcp/externalDelegationAuthority';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

describe('external delegation REST facade', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let admittedSessionId: string;
  let otherSessionId: string;
  const priorFlag = process.env['KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP'];
  const priorPrincipal = process.env['KIKI_EXTERNAL_PRINCIPAL_ID'];
  const priorSession = process.env['KIKI_EXTERNAL_SESSION_ID'];
  const priorDelegationToken = process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'];

  beforeEach(async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP'] = 'true';
    delete process.env['KIKI_EXTERNAL_PRINCIPAL_ID'];
    delete process.env['KIKI_EXTERNAL_SESSION_ID'];
    delete process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'];
    home = await mkdtemp(join(tmpdir(), 'kiki-external-delegation-'));

    // Create the operator-selected Sessions before attaching the constrained
    // route. Restarting over the same home also proves the allowlist is server
    // composition rather than a caller-provided create-time value.
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    admittedSessionId = await createSession();
    otherSessionId = await createSession();
    await server.close();

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: {
        principalId: 'example-principal',
        sessionId: admittedSessionId,
        token: 'DEDICATED_SECRET',
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server?.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    restoreEnv('KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP', priorFlag);
    restoreEnv('KIKI_EXTERNAL_PRINCIPAL_ID', priorPrincipal);
    restoreEnv('KIKI_EXTERNAL_SESSION_ID', priorSession);
    restoreEnv('KIKI_EXTERNAL_DELEGATION_TOKEN', priorDelegationToken);
  });

  it('admits only the configured credential, principal source, and Session', async () => {
    const call = (sessionId: string, extraHeaders: Record<string, string> = {}) =>
      fetch(`${base}/api/v2/sessions/${sessionId}/external-delegation/list`, {
        method: 'POST',
        headers: authHeaders(server!, {
          'content-type': 'application/json',
          ...extraHeaders,
        }),
        body: '{}',
      });

    const genericCredential = await envelope(await call(admittedSessionId));
    expect(genericCredential.code).not.toBe(0);
    expect(JSON.stringify(genericCredential)).not.toContain('DEDICATED_SECRET');

    const wrongCredential = await envelope(
      await call(admittedSessionId, { 'x-kiki-delegation-token': 'WRONG_SECRET' }),
    );
    expect(wrongCredential.code).not.toBe(0);
    expect(JSON.stringify(wrongCredential)).not.toContain('WRONG_SECRET');

    const wrongSession = await envelope(
      await call(otherSessionId, { 'x-kiki-delegation-token': 'DEDICATED_SECRET' }),
    );
    expect(wrongSession.code).not.toBe(0);
    expect(wrongSession.msg).toMatch(/Session is not admitted/i);

    const spoofed = await envelope(
      await call(admittedSessionId, {
        'x-kiki-delegation-token': 'DEDICATED_SECRET',
        'x-kiki-principal-id': 'spoofed-principal',
      }),
    );
    expect(spoofed.code).not.toBe(0);
    expect(spoofed.msg).toMatch(/Caller-supplied principal/i);

    const configured = await envelope(
      await call(admittedSessionId, { 'x-kiki-delegation-token': 'DEDICATED_SECRET' }),
    );
    expect(configured.code).toBe(0);
    expect(configured.data).toMatchObject({
      version: 1,
      delegationId: expect.stringMatching(/^delegation_/),
      dispatchables: expect.arrayContaining([{ kind: 'main' }]),
    });

    const dispatched = await envelope(
      await fetch(
        `${base}/api/v2/sessions/${admittedSessionId}/external-delegation/dispatch`,
        {
          method: 'POST',
          headers: authHeaders(server!, {
            'content-type': 'application/json',
            'x-kiki-delegation-token': 'DEDICATED_SECRET',
          }),
          body: JSON.stringify({ target: 'main', message: 'verify structured provision' }),
        },
      ),
    );
    expect(dispatched.msg).not.toMatch(/dedicated external session/i);
  });

  async function createSession(): Promise<string> {
    const response = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server!, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    return ((await response.json()) as { data: { id: string } }).data.id;
  }
});

describe('external delegation Session bootstrap', () => {
  let root: string | undefined;
  const servers: RunningServer[] = [];
  const priorFlag = process.env['KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP'];

  beforeEach(async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP'] = 'true';
    root = await mkdtemp(join(tmpdir(), 'kiki-external-bootstrap-'));
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    restoreEnv('KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP', priorFlag);
  });

  it('creates one exact bound Session and reuses its authority after restart', async () => {
    const home = join(root!, 'home');
    const workspace = join(root!, 'workspace');
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await writeStubConfig(home);
    const externalDelegation = authority('session_workspace_a', workspace);

    let server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation,
    });
    let base = `http://127.0.0.1:${server.port}`;
    const session = await getEnvelope<{ metadata: { cwd: string } }>(
      server,
      `${base}/api/v1/sessions/session_workspace_a`,
    );
    expect(session.code).toBe(0);
    expect(session.data.metadata.cwd).toBe(workspace);
    const status = await getEnvelope<{ model?: string; thinking_level: string }>(
      server,
      `${base}/api/v1/sessions/session_workspace_a/status`,
    );
    expect(status.data).toMatchObject({ model: 'stub', thinking_level: 'high' });
    const first = await listRoot(server, base, 'session_workspace_a');
    expect(first.code).toBe(0);
    expect(first.data.delegationId).toMatch(/^delegation_/);
    expect(first.data.dispatchables).toEqual(expect.arrayContaining([{ kind: 'main' }]));
    const dispatched = await dispatchMain(server, base, 'session_workspace_a');
    expect(dispatched).toMatchObject({ code: 0, data: { target: 'main' } });
    await server.close();

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation,
    });
    servers.push(server);
    base = `http://127.0.0.1:${server.port}`;
    const second = await listRoot(server, base, 'session_workspace_a');
    expect(second.code).toBe(0);
    expect(second.data.delegationId).toBe(first.data.delegationId);
    expect(second.data.dispatchables).toEqual(expect.arrayContaining([{ kind: 'main' }]));
  });

  it('applies an operator-updated model binding to an existing delegated Session', async () => {
    const home = join(root!, 'home-model-update');
    const workspace = join(root!, 'workspace-model-update');
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await writeStubConfig(home);
    const sessionId = 'session_model_update';

    const initial = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: authority(sessionId, workspace),
    });
    await initial.close();

    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: authority(sessionId, workspace, 'stub-alt', 'low'),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const status = await getEnvelope<{ model?: string; thinking_level: string }>(
      server,
      `${base}/api/v1/sessions/${sessionId}/status`,
    );
    expect(status.data).toMatchObject({ model: 'stub-alt', thinking_level: 'low' });
    expect((await listRoot(server, base, sessionId)).code).toBe(0);
  });

  it('starts without the delegation edge when a persisted Session workspace drifts', async () => {
    const home = join(root!, 'home');
    const workspaceA = join(root!, 'workspace-a');
    const workspaceB = join(root!, 'workspace-b');
    await Promise.all([mkdir(home), mkdir(workspaceA), mkdir(workspaceB)]);
    await writeStubConfig(home);
    const initial = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: authority('session_workspace_a', workspaceA),
    });
    await initial.close();

    const logs: string[] = [];
    const logger = pino({ level: 'warn' }, new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    }));
    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logger,
      externalDelegation: authority('session_workspace_a', workspaceB),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/api/v1/healthz`)).status).toBe(200);
    const edge = await listRoot(server, base, 'session_workspace_a');
    expect(edge.code).not.toBe(0);
    const warning = logs
      .map((line) => JSON.parse(line) as { level: number; msg: string; err?: string })
      .find((record) => record.msg ===
        'external delegation Session bootstrap failed; starting without the external delegation edge');
    expect(warning).toMatchObject({
      level: 40,
      err: expect.stringMatching(/workspace binding does not match/i),
    });
  });

  it('initializes different workspace authorities concurrently without cross-admission', async () => {
    const homes = [join(root!, 'home-a'), join(root!, 'home-b')];
    const workspaces = [join(root!, 'workspace-a'), join(root!, 'workspace-b')];
    await Promise.all([...homes, ...workspaces].map((path) => mkdir(path)));
    await Promise.all(homes.map((home) => writeStubConfig(home)));
    const [serverA, serverB] = await Promise.all([
      startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: homes[0],
        logLevel: 'silent',
        externalDelegation: authority('session_workspace_0', workspaces[0]!),
      }),
      startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: homes[1],
        logLevel: 'silent',
        externalDelegation: authority('session_workspace_1', workspaces[1]!),
      }),
    ]);
    servers.push(serverA, serverB);
    const roots = await Promise.all([
      listRoot(serverA, `http://127.0.0.1:${serverA.port}`, 'session_workspace_0'),
      listRoot(serverB, `http://127.0.0.1:${serverB.port}`, 'session_workspace_1'),
    ]);
    expect(roots.every((item) => item.code === 0)).toBe(true);

    const crossed = await listRoot(
      serverA,
      `http://127.0.0.1:${serverA.port}`,
      'session_workspace_1',
      'session_workspace_0',
    );
    expect(crossed.code).not.toBe(0);
    expect(crossed.msg).toMatch(/Session is not admitted/i);
  });

  it('ignores profile metadata attempts to overwrite or delete operator ownership', async () => {
    const home = join(root!, 'home');
    const workspace = join(root!, 'workspace');
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await writeStubConfig(home);
    const sessionId = 'session_profile_attack';
    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: authority(sessionId, workspace),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    for (const value of [
      { version: 1, ownership: 'attached' },
      null,
    ]) {
      const response = await fetch(`${base}/api/v1/sessions/${sessionId}/profile`, {
        method: 'POST',
        headers: authHeaders(server, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          metadata: { externalDelegationProvision: value },
        }),
      });
      const patched = await envelope(response);
      expect(patched.code).toBe(0);
      expect(JSON.stringify(patched.data)).toContain('externalDelegationProvision');
      const root = await listRoot(server, base, sessionId);
      expect(root.data.dispatchables).toEqual(expect.arrayContaining([{ kind: 'main' }]));
    }
  });

  it('does not copy operator ownership into a regular fork', async () => {
    const home = join(root!, 'home');
    const workspace = join(root!, 'workspace');
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await writeStubConfig(home);
    const sourceId = 'session_fork_source';
    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: authority(sourceId, workspace),
    });
    servers.push(server);
    const source = await resumeSessionById(server.core.accessor, sourceId);
    if (source === undefined) throw new Error('source session unavailable');
    const fork = await server.core.accessor.get(ISessionManager).fork({ sourceSessionId: sourceId });

    await expect(
      fork.accessor.get(ISessionExternalDelegationProvisionStore).read(),
    ).resolves.toBeUndefined();
  });

  it('explicit attached ownership clears a prior dedicated provision across restart', async () => {
    const home = join(root!, 'home');
    const workspace = join(root!, 'workspace');
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await writeStubConfig(home);
    const sessionId = 'session_ownership_clear';
    let server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: authority(sessionId, workspace),
    });
    await server.close();

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: {
        principalId: `principal-${sessionId}`,
        sessionId,
        token: `token-${sessionId}`,
        sessionOwnership: 'attached',
      },
    });
    await server.close();

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: {
        principalId: `principal-${sessionId}`,
        sessionId,
        token: `token-${sessionId}`,
        sessionOwnership: 'attached',
      },
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const profile = await fetch(`${base}/api/v1/sessions/${sessionId}/profile`, {
      method: 'POST',
      headers: authHeaders(server, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        metadata: {
          externalDelegationProvision: { version: 1, ownership: 'dedicated' },
        },
      }),
    });
    expect((await envelope(profile)).code).toBe(0);
    const listed = await listRoot(server, base, sessionId);
    expect(listed.code).toBe(0);
    expect(listed.data.dispatchables ?? []).not.toEqual(expect.arrayContaining([{ kind: 'main' }]));
    const rejected = await dispatchMain(server, base, sessionId);
    expect(rejected.code).not.toBe(0);
    expect(rejected.msg).toMatch(/dedicated external session/i);
  });

  it('classifies environment authorities by Session provisioning', () => {
    expect(externalDelegationAuthorityFromEnv({
      KIKI_EXTERNAL_PRINCIPAL_ID: 'principal',
      KIKI_EXTERNAL_SESSION_ID: 'session_attached',
      KIKI_EXTERNAL_DELEGATION_TOKEN: 'token',
    })).toMatchObject({ sessionOwnership: 'attached', sessionBootstrap: undefined });
    expect(externalDelegationAuthorityFromEnv({
      KIKI_EXTERNAL_PRINCIPAL_ID: 'principal',
      KIKI_EXTERNAL_SESSION_ID: 'session_dedicated',
      KIKI_EXTERNAL_DELEGATION_TOKEN: 'token',
      KIKI_EXTERNAL_WORKSPACE_PATH: 'C:\\workspace',
      KIKI_EXTERNAL_MODEL_ALIAS: 'model',
      KIKI_EXTERNAL_THINKING_EFFORT: 'high',
    })).toMatchObject({ sessionOwnership: 'dedicated' });
  });

  it('fails closed on partial environment authority', () => {
    expect(externalDelegationAuthorityFromEnv({})).toBeUndefined();
    expect(() =>
      externalDelegationAuthorityFromEnv({ KIKI_EXTERNAL_SESSION_ID: 'session_partial' }),
    ).toThrow(/incomplete/i);
    expect(() =>
      externalDelegationAuthorityFromEnv({
        KIKI_EXTERNAL_PRINCIPAL_ID: 'principal',
        KIKI_EXTERNAL_SESSION_ID: 'caller-selected',
        KIKI_EXTERNAL_DELEGATION_TOKEN: 'token',
      }),
    ).toThrow(/Session id is invalid/i);
  });
});

function authority(
  sessionId: string,
  workspacePath: string,
  modelAlias = 'stub',
  thinkingEffort = 'high',
) {
  return {
    principalId: `principal-${sessionId}`,
    sessionId,
    token: `token-${sessionId}`,
    sessionBootstrap: {
      workspacePath,
      modelAlias,
      thinkingEffort,
      title: `Codex ${sessionId}`,
    },
  };
}

async function listRoot(
  server: RunningServer,
  base: string,
  sessionId: string,
  credentialSessionId = sessionId,
) {
  const response = await fetch(
    `${base}/api/v2/sessions/${sessionId}/external-delegation/list`,
    {
      method: 'POST',
      headers: authHeaders(server, {
        'content-type': 'application/json',
        'x-kiki-delegation-token': `token-${credentialSessionId}`,
      }),
      body: '{}',
    },
  );
  return response.json() as Promise<{
    code: number;
    msg: string;
    data: { delegationId?: string; dispatchables?: Array<{ kind: string }> };
  }>;
}

async function dispatchMain(server: RunningServer, base: string, sessionId: string) {
  const response = await fetch(
    `${base}/api/v2/sessions/${sessionId}/external-delegation/dispatch`,
    {
      method: 'POST',
      headers: authHeaders(server, {
        'content-type': 'application/json',
        'x-kiki-delegation-token': `token-${sessionId}`,
      }),
      body: JSON.stringify({ target: 'main', message: 'verify structured provision' }),
    },
  );
  return response.json() as Promise<{
    code: number;
    msg: string;
    data: { target?: string };
  }>;
}

async function getEnvelope<T>(server: RunningServer, url: string) {
  const response = await fetch(url, { headers: authHeaders(server) });
  return response.json() as Promise<{ code: number; msg: string; data: T }>;
}

async function writeStubConfig(home: string): Promise<void> {
  await writeFile(
    join(home, 'config.toml'),
    [
      'default_model = "stub"',
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
      '[models.stub-alt]',
      'provider = "stub"',
      'model = "stub-alt"',
      'max_context_size = 1000',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function envelope(response: Response): Promise<{
  code: number;
  msg: string;
  data: { version?: number; delegationId?: string; dispatchables?: Array<{ kind: string }> };
}> {
  return response.json() as Promise<{
    code: number;
    msg: string;
    data: { version?: number; delegationId?: string; dispatchables?: Array<{ kind: string }> };
  }>;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
