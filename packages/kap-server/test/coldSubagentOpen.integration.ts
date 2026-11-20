import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ISessionMetadata, getLiveSessionById } from '@kiki/agent-core-v2';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import { startServer } from '../src/start';
import { authHeaders, bearerToken } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

async function writeSingleTurnSubagentWire(wirePath: string, steps: number, payloadBytesPerStep: number): Promise<number> {
  const chunk = 'A'.repeat(payloadBytesPerStep);
  const stream = createWriteStream(wirePath, { encoding: 'utf8' });
  const writeLine = async (record: Record<string, unknown>): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`;
    if (!stream.write(line)) {
      await new Promise<void>((resolve) => { stream.once('drain', resolve); });
    }
  };
  await writeLine({ type: 'metadata', protocol_version: '1.1', time: 1_000 });
  await writeLine({ type: 'profile.bind', modelAlias: 'example/model', thinkingEffort: 'high', profileName: 'implementer', time: 1_010 });
  await writeLine({
    type: 'turn.prompt',
    turnId: 0,
    promptId: 'prompt-sub-0',
    origin: { kind: 'user' },
    input: [{ type: 'text', text: 'Investigate and implement the entire backend optimization cleanly.' }],
    time: 1_020,
  });
  for (let step = 1; step <= steps; step += 1) {
    const stepId = `step-${step}`;
    const toolCallId = `call-${step}`;
    const t = 2_000 + step * 100;
    await writeLine({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: 0, step, uuid: stepId },
      time: t,
    });
    await writeLine({
      type: 'context.append_loop_event',
      event: { type: 'tool.call', turnId: 0, stepUuid: stepId, uuid: `tc-${step}`, toolCallId, name: 'Read', input: { path: `src/file-${step}.ts` } },
      time: t + 10,
    });
    await writeLine({
      type: 'context.append_loop_event',
      event: { type: 'tool.result', turnId: 0, stepUuid: stepId, uuid: `tr-${step}`, toolCallId, name: 'Read', output: chunk, isError: false },
      time: t + 20,
    });
    await writeLine({
      type: 'context.append_message',
      message: { id: `msg-tool-${step}`, role: 'tool', toolCallId, content: [{ type: 'text', text: chunk }] },
      time: t + 25,
    });
    await writeLine({
      type: 'context.append_loop_event',
      event: { type: 'step.end', turnId: 0, step, uuid: stepId, finishReason: 'tool_use' },
      time: t + 30,
    });
  }
  await writeLine({ type: 'token_counting.measured', tokens: 48_120, time: 90_000 });
  await writeLine({ type: 'turn.ended', turnId: 0, reason: 'completed', time: 91_000 });
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
  return (await stat(wirePath)).size;
}

async function seedColdSubagentHome(prefix: string, subagentId: string, steps: number, payloadBytesPerStep: number) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(home, 'workspace');
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(home, 'config.toml'),
    [
      '[search]',
      'enabled = false',
      '[cron]',
      'manualTick = true',
      '[providers.example]',
      'type = "openai"',
      'base_url = "https://api.example.test/v1"',
      'api_key = "test-key"',
      '[models."example/model"]',
      'provider = "example"',
      'model = "example-model"',
      'max_context_size = 200000',
      '',
    ].join('\n'),
  );

  const bootstrap = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
  });
  let sessionId = '';
  let workspaceId = '';
  try {
    const createdRes = await fetch(`http://127.0.0.1:${bootstrap.port}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(bootstrap, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
    });
    const created = await createdRes.json() as { code: number; data: { id: string; workspace_id: string } };
    expect(created.code).toBe(0);
    sessionId = created.data.id;
    workspaceId = created.data.workspace_id;
    const live = getLiveSessionById(bootstrap.core.accessor, sessionId)!;
    const current = await live.accessor.get(ISessionMetadata).read();
    await live.accessor.get(ISessionMetadata).update({
      agents: {
        ...(current.agents ?? {}),
        [subagentId]: {
          type: 'sub',
          parentAgentId: 'main',
          status: 'completed',
          model: 'example/model',
          executor: 'native',
          contextTokens: 48_120,
        },
      },
    });
  } finally {
    await bootstrap.close();
  }

  const sessionDir = join(home, 'sessions', workspaceId, sessionId);
  const subDir = join(sessionDir, 'agents', subagentId);
  await mkdir(subDir, { recursive: true });
  const wireBytes = await writeSingleTurnSubagentWire(join(subDir, 'wire.jsonl'), steps, payloadBytesPerStep);
  return { home, cwd, workspaceId, sessionId, wireBytes };
}

async function subscribeV2Reset(
  port: number,
  token: string,
  sessionId: string,
  agentId: string,
): Promise<{ ackCode: number; resetAgentId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    let ackCode: number | undefined;
    let resetAgentId: string | undefined;
    const done = () => {
      if (ackCode !== undefined && resetAgentId !== undefined) {
        ws.close();
        resolve({ ackCode, resetAgentId });
      }
    };
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for subscribe_v2 ack/reset (ack=${String(ackCode)}, reset=${String(resetAgentId)})`));
    }, 10_000);
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'client_hello', id: 'hello-1', payload: { subscriptions: [] } }));
      ws.send(JSON.stringify({
        type: 'subscribe_v2',
        id: 'sub-1',
        payload: {
          session_id: sessionId,
          transcript: { [agentId]: 'delta' },
          transcript_coverage_version: 2,
        },
      }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type?: string; id?: string; code?: number; payload?: Record<string, unknown> };
      if (msg.type === 'ack' && msg.id === 'sub-1') {
        ackCode = Number(msg.code ?? msg.payload?.['code'] ?? -1);
        done();
      } else if (msg.type === 'transcript.reset' && msg.payload?.['agent_id'] === agentId) {
        resetAgentId = String(msg.payload['agent_id']);
        done();
      }
      if (ackCode !== undefined && resetAgentId !== undefined) clearTimeout(timer);
    });
  });
}

describe('cold subagent workspace open performance and semantics', () => {
  it('opens a 90+ MB checkpointless single-turn cold subagent with REST transcript <300ms, WS subscribe_v2 <300ms, and control endpoints <500ms', async () => {
    const subagentId = 'agent-299';
    const { home, sessionId, wireBytes } = await seedColdSubagentHome('kiki-cold-subagent-90mb-', subagentId, 460, 100 * 1024);
    expect(wireBytes).toBeGreaterThan(88 * 1024 * 1024);

    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = authHeaders(server);
    try {
      await fetch(`${base}/api/sessions`, { headers });
      await subscribeV2Reset(server.port, bearerToken(server), sessionId, 'main');
      await fetch(`${base}/api/agents/capabilities?session_id=${sessionId}&agent_id=main`, { headers });

      const fetchJson = async (name: string, url: string) => {
        const started = performance.now();
        const res = await fetch(url, { headers });
        const body = await res.json() as { code: number; msg?: string; data?: Record<string, unknown> };
        return { name, status: res.status, code: body.code, msg: body.msg, data: body.data, elapsedMs: performance.now() - started };
      };

      const t0 = performance.now();
      const [wsRes, transcriptRes, capRes, switchRes, hooksRes, autoCompactRes, ctxStrategyRes] = await Promise.all([
        (async () => {
          const started = performance.now();
          const result = await subscribeV2Reset(server.port, bearerToken(server), sessionId, subagentId);
          return { name: 'ws_subscribe_v2', ...result, elapsedMs: performance.now() - started };
        })(),
        fetchJson('transcript', `${base}/api/sessions/${sessionId}/transcript?agent_id=${subagentId}&transcript_coverage_version=2`),
        fetchJson('capabilities', `${base}/api/agents/capabilities?session_id=${sessionId}&agent_id=${subagentId}`),
        fetchJson('model_switches', `${base}/api/sessions/${sessionId}/agents/${subagentId}/model-switches`),
        fetchJson('hooks', `${base}/api/sessions/${sessionId}/agents/${subagentId}/hooks?observe=true`),
        fetchJson('auto_compact', `${base}/api/sessions/${sessionId}/agents/${subagentId}/auto-compact?observe=true`),
        fetchJson('context_strategy', `${base}/api/sessions/${sessionId}/agents/${subagentId}/context-strategy?observe=true`),
      ]);
      const totalWallMs = performance.now() - t0;

      console.log(JSON.stringify({
        coldSubagent64MbBenchmark: {
          wireMiB: Number((wireBytes / (1024 * 1024)).toFixed(2)),
          totalWallMs: Number(totalWallMs.toFixed(1)),
          endpoints: {
            ws_subscribe_v2: Number(wsRes.elapsedMs.toFixed(1)),
            transcript: { code: transcriptRes.code, ms: Number(transcriptRes.elapsedMs.toFixed(1)) },
            capabilities: { code: capRes.code, ms: Number(capRes.elapsedMs.toFixed(1)) },
            model_switches: { code: switchRes.code, ms: Number(switchRes.elapsedMs.toFixed(1)) },
            hooks: { code: hooksRes.code, ms: Number(hooksRes.elapsedMs.toFixed(1)) },
            auto_compact: { code: autoCompactRes.code, msg: autoCompactRes.msg, ms: Number(autoCompactRes.elapsedMs.toFixed(1)) },
            context_strategy: { code: ctxStrategyRes.code, ms: Number(ctxStrategyRes.elapsedMs.toFixed(1)) },
          },
        },
      }));

      expect(wsRes.ackCode).toBe(0);
      expect(wsRes.resetAgentId).toBe(subagentId);
      expect(transcriptRes.code).toBe(0);
      expect(capRes.code).toBe(0);
      expect(switchRes.code).toBe(0);
      expect(hooksRes.code).not.toBe(50001);
      expect(autoCompactRes.code).toBe(0);
      expect(ctxStrategyRes.code).toBe(0);
      expect(transcriptRes.elapsedMs).toBeLessThan(300);
      expect(wsRes.elapsedMs).toBeLessThan(300);
      expect(capRes.elapsedMs).toBeLessThan(500);
      expect(switchRes.elapsedMs).toBeLessThan(500);
      expect(hooksRes.elapsedMs).toBeLessThan(500);
      expect(autoCompactRes.elapsedMs).toBeLessThan(500);
      expect(ctxStrategyRes.elapsedMs).toBeLessThan(500);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60_000);

  it('opens a 5 MB checkpointless cold subagent including hooks?observe=true under 1000 ms', async () => {
    const subagentId = 'agent-251';
    const { home, sessionId, wireBytes } = await seedColdSubagentHome('kiki-cold-subagent-5mb-', subagentId, 60, 40 * 1024);
    expect(wireBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(wireBytes).toBeLessThan(8 * 1024 * 1024);

    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = authHeaders(server);
    try {
      await fetch(`${base}/api/sessions`, { headers });
      await subscribeV2Reset(server.port, bearerToken(server), sessionId, 'main');
      await fetch(`${base}/api/agents/capabilities?session_id=${sessionId}&agent_id=main`, { headers });

      const fetchTimed = async (url: string) => {
        const s = performance.now();
        const body = await fetch(url, { headers }).then((r) => r.json() as Promise<{ code: number; msg?: string }>);
        return { ...body, ms: Number((performance.now() - s).toFixed(1)) };
      };
      const t0 = performance.now();
      const [hooksRes, capRes, switchRes, transcriptRes] = await Promise.all([
        fetchTimed(`${base}/api/sessions/${sessionId}/agents/${subagentId}/hooks?observe=true`),
        fetchTimed(`${base}/api/agents/capabilities?session_id=${sessionId}&agent_id=${subagentId}`),
        fetchTimed(`${base}/api/sessions/${sessionId}/agents/${subagentId}/model-switches`),
        fetchTimed(`${base}/api/sessions/${sessionId}/transcript?agent_id=${subagentId}&transcript_coverage_version=2`),
      ]);
      const elapsedMs = performance.now() - t0;
      console.log(JSON.stringify({
        coldSubagent5MbBenchmark: {
          wireMiB: Number((wireBytes / (1024 * 1024)).toFixed(2)),
          elapsedMs: Number(elapsedMs.toFixed(1)),
          hooks: { code: hooksRes.code, ms: hooksRes.ms },
          capabilities: { code: capRes.code, ms: capRes.ms },
          model_switches: { code: switchRes.code, ms: switchRes.ms },
          transcript: { code: transcriptRes.code, ms: transcriptRes.ms },
        },
      }));
      expect(hooksRes.code).toBe(0);
      expect(capRes.code).toBe(0);
      expect(switchRes.code).toBe(0);
      expect(transcriptRes.code).toBe(0);
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60_000);
});
