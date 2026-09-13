import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  ISessionDispatchService,
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
}

interface TranscriptContract {
  agent_id: string;
  items: { kind: string; prompt?: string; steps?: { frames: { text?: string }[] }[] }[];
}

describe('released subagent scopes', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  it('stay listed, keep their transcript readable, and rematerialize on resume', async () => {
    home = await mkdtemp(join(tmpdir(), 'kap-server-subagent-release-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const sessionId = ((await created.json()) as Envelope<{ id: string }>).data.id;

    const session = getLiveSessionById(server.core.accessor, sessionId);
    if (session === undefined) throw new Error('session not live');
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    lifecycle.get('main') ?? (await lifecycle.create({ agentId: 'main' }));
    const child = await lifecycle.create({
      agentId: 'agent-1',
      delegator: { kind: 'agent', agentId: 'main' },
    });
    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'child prompt' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'child reply' }], toolCalls: [] },
    ];
    child.accessor.get(IAgentContextMemoryService).append(...messages);
    await child.accessor.get(IWireService).flush();

    const readTranscript = async (): Promise<TranscriptContract> => {
      const response = await authedFetch(
        server!,
        base,
        `/api/sessions/${sessionId}/transcript?agent_id=agent-1`,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as Envelope<TranscriptContract>).data;
    };
    const expectChildHistory = (transcript: TranscriptContract): void => {
      expect(transcript.agent_id).toBe('agent-1');
      const turns = transcript.items.filter((item) => item.kind === 'turn');
      expect(turns).toHaveLength(1);
      expect(turns[0]?.prompt).toBe('child prompt');
      expect(
        turns.flatMap((turn) => turn.steps?.flatMap((step) => step.frames.map((frame) => frame.text)) ?? []),
      ).toContain('child reply');
    };
    expectChildHistory(await readTranscript());

    await lifecycle.remove('agent-1');
    expect(lifecycle.get('agent-1')).toBeUndefined();
    expect(lifecycle.list().map((handle) => handle.id)).toEqual(['main']);

    expectChildHistory(await readTranscript());

    const dispatch = session.accessor.get(ISessionDispatchService);
    const resolved = await dispatch.resolveOwnedChild({ kind: 'agent', agentId: 'main' }, 'agent-1');
    expect(resolved.agentId).toBe('agent-1');
    expect(lifecycle.get('agent-1')).toBe(resolved.agent);
    const restored = resolved.agent.accessor.get(IAgentContextMemoryService).get();
    expect(restored.map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});
