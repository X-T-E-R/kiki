import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IWireService,
  getLiveSessionById,
  type ContextMessage,
} from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders, authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  data: T;
  request_id: string;
}

interface SessionContract {
  id: string;
  workspace_id: string;
  busy: boolean;
  main_turn_active: boolean;
  pending_interaction: 'none' | 'approval' | 'question';
  metadata: { cwd: string };
}

interface TranscriptFrameContract {
  kind: string;
  text?: string;
  state?: string;
}

interface TranscriptTurnContract {
  kind: 'turn';
  state: string;
  prompt?: string;
  steps: { frames: TranscriptFrameContract[] }[];
}

interface TranscriptContract {
  session_id: string;
  agent_id: string;
  items: (TranscriptTurnContract | { kind: string })[];
  has_more: boolean;
  prompts: { status: string }[];
  pending_interactions: string[];
}

describe('kap-server cold start', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  async function boot(): Promise<RunningServer> {
    const runningServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
    });
    server = runningServer;
    base = `http://127.0.0.1:${runningServer.port}`;
    return runningServer;
  }

  async function getJson<T>(
    runningServer: RunningServer,
    path: string,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const response = await authedFetch(runningServer, base, path);
    return { status: response.status, body: (await response.json()) as Envelope<T> };
  }

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  it('boots from an empty home and cold-recovers the first persisted session', async () => {
    home = await mkdtemp(join(tmpdir(), 'kap-server-cold-start-'));
    const initialServer = await boot();

    const healthResponse = await fetch(`${base}/api/healthz`);
    const health = (await healthResponse.json()) as Envelope<{ ok: boolean }>;
    expect(healthResponse.status).toBe(200);
    expect(health).toMatchObject({ code: 0, data: { ok: true } });
    expect(health.request_id).toEqual(expect.any(String));

    const unauthorizedMeta = await fetch(`${base}/api/meta`);
    expect(unauthorizedMeta.status).toBe(401);

    const metaResponse = await authedFetch(initialServer, base, '/api/meta');
    const meta = (await metaResponse.json()) as Envelope<{ server_id: string }>;
    expect(metaResponse.status).toBe(200);
    expect(meta.code).toBe(0);
    expect(meta.data.server_id).toEqual(expect.any(String));

    const authResponse = await authedFetch(initialServer, base, '/api/auth');
    const auth = (await authResponse.json()) as Envelope<{ ready: boolean; providers_count: number }>;
    expect(authResponse.status).toBe(200);
    expect(auth.code).toBe(0);
    expect(auth.data.ready).toEqual(expect.any(Boolean));
    expect(auth.data.providers_count).toBeGreaterThanOrEqual(0);

    const createResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(initialServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const created = (await createResponse.json()) as Envelope<SessionContract>;
    expect(createResponse.status).toBe(200);
    expect(created.code).toBe(0);
    expect(created.data).toMatchObject({
      id: expect.any(String),
      workspace_id: expect.any(String),
      busy: false,
      main_turn_active: false,
      pending_interaction: 'none',
      metadata: { cwd: home },
    });

    const sessionId = created.data.id;
    const firstRead = await getJson<SessionContract>(
      initialServer,
      `/api/sessions/${sessionId}`,
    );
    expect(firstRead.status).toBe(200);
    expect(firstRead.body).toMatchObject({
      code: 0,
      data: {
        id: sessionId,
        busy: false,
        main_turn_active: false,
        pending_interaction: 'none',
      },
    });

    const liveSession = getLiveSessionById(initialServer.core.accessor, sessionId);
    if (liveSession === undefined) throw new Error(`session ${sessionId} not found`);
    const lifecycle = liveSession.accessor.get(IAgentLifecycleService);
    const mainAgent = lifecycle.get('main') ?? await lifecycle.create({ agentId: 'main' });
    const messages: ContextMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'persisted cold-start prompt' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'persisted cold-start reply' }],
        toolCalls: [],
      },
    ];
    mainAgent.accessor.get(IAgentContextMemoryService).append(...messages);
    await mainAgent.accessor.get(IWireService).flush();

    await initialServer.close();
    server = undefined;
    const recoveredServer = await boot();

    const recoveredSession = await getJson<SessionContract>(
      recoveredServer,
      `/api/sessions/${sessionId}`,
    );
    expect(recoveredSession.status).toBe(200);
    expect(recoveredSession.body).toMatchObject({
      code: 0,
      data: {
        id: sessionId,
        busy: false,
        main_turn_active: false,
        pending_interaction: 'none',
        metadata: { cwd: home },
      },
    });

    const recoveredTranscript = await getJson<TranscriptContract>(
      recoveredServer,
      `/api/sessions/${sessionId}/transcript?agent_id=main`,
    );
    expect(recoveredTranscript.status).toBe(200);
    expect(recoveredTranscript.body.code).toBe(0);
    expect(recoveredTranscript.body.data).toMatchObject({
      session_id: sessionId,
      agent_id: 'main',
      has_more: false,
      pending_interactions: [],
    });

    const turns = recoveredTranscript.body.data.items.filter(
      (item): item is TranscriptTurnContract => item.kind === 'turn',
    );
    expect(turns).toHaveLength(1);
    expect(turns.every((turn) => turn.state === 'completed')).toBe(true);
    expect(turns[0]?.prompt).toBe('persisted cold-start prompt');
    expect(
      turns.flatMap((turn) => turn.steps.flatMap((step) => step.frames)).map((frame) => frame.text),
    ).toContain('persisted cold-start reply');
    expect(
      turns.some((turn) =>
        turn.steps.some((step) => step.frames.some((frame) => frame.state === 'running')),
      ),
    ).toBe(false);
    expect(recoveredTranscript.body.data.prompts.some((prompt) => prompt.status === 'running')).toBe(
      false,
    );
  });
});
