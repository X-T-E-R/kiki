import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listLiveServerInstances } from '../src/instanceRegistry';
import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const EXTERNAL_DELEGATION_ENV_NAMES = [
  'KIKI_EXTERNAL_PRINCIPAL_ID',
  'KIKI_EXTERNAL_SESSION_ID',
  'KIKI_EXTERNAL_DELEGATION_TOKEN',
  'KIKI_EXTERNAL_WORKSPACE_PATH',
  'KIKI_EXTERNAL_MODEL_ALIAS',
  'KIKI_EXTERNAL_THINKING_EFFORT',
  'KIKI_EXTERNAL_PERMISSION_MODE',
  'KIKI_EXTERNAL_SESSION_TITLE',
] as const;

let home: string;
let workspace: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  for (const name of EXTERNAL_DELEGATION_ENV_NAMES) vi.stubEnv(name, undefined);
  home = await mkdtemp(join(tmpdir(), 'kiki-seat-home-'));
  workspace = await mkdtemp(join(tmpdir(), 'kiki-seat-workspace-'));
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await server?.close();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('external delegation seats', () => {
  it('creates, reuses, lists, authorizes, and revokes a runtime seat', async () => {
    const base = `http://127.0.0.1:${server!.port}`;
    const create = async () => {
      const response = await authedFetch(server!, base, '/api/v2/external-delegation/seats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, principal: 'cursor', mode: 'auto' }),
      });
      return response.json() as Promise<{ code: number; data: Record<string, unknown> }>;
    };

    const first = await create();
    const second = await create();
    expect(first.code).toBe(0);
    expect(second.data).toMatchObject({
      seatId: first.data['seatId'],
      sessionId: first.data['sessionId'],
      delegationToken: first.data['delegationToken'],
      workspace,
      mode: 'auto',
    });

    const listed = await authedFetch(server!, base, '/api/v2/external-delegation/seats');
    const listBody = await listed.json() as { code: number; data: Record<string, unknown>[] };
    expect(listBody.code).toBe(0);
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).not.toHaveProperty('delegationToken');

    const sessionId = String(first.data['sessionId']);
    const delegationToken = String(first.data['delegationToken']);
    const delegated = await authedFetch(
      server!,
      base,
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/external-delegation/list`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kiki-delegation-token': delegationToken,
        },
        body: '{}',
      },
    );
    expect(await delegated.json()).toMatchObject({
      code: 0,
      data: { version: 1, lifecycle: 'active' },
    });

    const live = await listLiveServerInstances(home);
    expect(live).toHaveLength(1);
    expect(live[0]?.workspaces).toContain(workspace);

    const seatId = String(first.data['seatId']);
    const revoked = await authedFetch(
      server!,
      base,
      `/api/v2/external-delegation/seats/${encodeURIComponent(seatId)}`,
      { method: 'DELETE' },
    );
    expect(await revoked.json()).toMatchObject({ code: 0, data: { seatId } });

    const rejected = await authedFetch(
      server!,
      base,
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/external-delegation/list`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kiki-delegation-token': delegationToken,
        },
        body: '{}',
      },
    );
    expect(await rejected.json()).toMatchObject({ code: 40001 });
  });
});
