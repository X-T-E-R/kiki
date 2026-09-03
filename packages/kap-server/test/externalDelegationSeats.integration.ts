import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAtomicDocumentStore,
  ISessionContext,
  ISessionExternalDelegationProvisionStore,
  resumeSessionById,
} from '@moonshot-ai/agent-core-v2';
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

async function createSeat() {
  const base = `http://127.0.0.1:${server!.port}`;
  const response = await authedFetch(server!, base, '/api/v2/external-delegation/seats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, principal: 'cursor', mode: 'auto' }),
  });
  return response.json() as Promise<{ code: number; data: Record<string, unknown> }>;
}

async function invokeSeat(sessionId: string, delegationToken: string) {
  const base = `http://127.0.0.1:${server!.port}`;
  const response = await authedFetch(
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
  return response.json() as Promise<{ code: number; data: unknown }>;
}

async function provisionAddress(sessionId: string) {
  const session = await resumeSessionById(server!.core.accessor, sessionId);
  const context = session!.accessor.get(ISessionContext);
  return {
    documents: server!.core.accessor.get(IAtomicDocumentStore),
    scope: `external-delegation-provisions/${context.workspaceId}`,
    key: sessionId,
    store: session!.accessor.get(ISessionExternalDelegationProvisionStore),
  };
}

describe('external delegation seats', () => {
  it('creates, reuses, lists, authorizes, and revokes a runtime seat', async () => {
    const base = `http://127.0.0.1:${server!.port}`;
    const first = await createSeat();
    const second = await createSeat();
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
    const catalog = await readFile(
      join(home, 'server', 'external-delegation-seats.json'),
      'utf8',
    );
    expect(catalog).not.toContain(delegationToken);
    expect(await invokeSeat(sessionId, delegationToken)).toMatchObject({
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

    expect(await invokeSeat(sessionId, delegationToken)).toMatchObject({ code: 40001 });
  });

  it.each([
    ['unknown version', { version: 3, ownership: 'dedicated', principalId: 'cursor', delegationToken: 'secret' }],
    ['unknown ownership', { version: 2, ownership: 'attached', principalId: 'cursor', delegationToken: 'secret' }],
  ])('rejects a seat with %s provision', async (_name, malformed) => {
    const created = await createSeat();
    const sessionId = String(created.data['sessionId']);
    const delegationToken = String(created.data['delegationToken']);
    const address = await provisionAddress(sessionId);
    await address.documents.set(address.scope, address.key, malformed);
    expect(await invokeSeat(sessionId, delegationToken)).toMatchObject({ code: 40001 });
  });

  it('rejects a seat with missing provision', async () => {
    const created = await createSeat();
    const sessionId = String(created.data['sessionId']);
    const delegationToken = String(created.data['delegationToken']);
    const address = await provisionAddress(sessionId);
    await address.store.revoke();
    expect(await invokeSeat(sessionId, delegationToken)).toMatchObject({ code: 40001 });
  });
});
