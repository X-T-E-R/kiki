import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
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
    if (home !== undefined) await rm(home, { recursive: true, force: true });
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
