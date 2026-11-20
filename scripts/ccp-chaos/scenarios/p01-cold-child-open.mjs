import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { P01_COLD_CHILD_SIZES_BYTES, writeCheckpointlessColdChildWire } from '../fixtures/empirical-manifest.mjs';
import { evaluateP01ColdChildGate } from '../verify/verdict.mjs';

function roundMs(ms) {
  return Number(ms.toFixed(2));
}

async function fetchEndpoint(endpoint, token, urlPath, timeoutMs = 20_000) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      path: urlPath,
      status: res.status,
      code: json?.code ?? null,
      reason: json?.data?.reason ?? json?.msg ?? null,
      statusField: json?.data?.status ?? null,
      bytes: Buffer.byteLength(text, 'utf8'),
      elapsedMs: roundMs(performance.now() - t0),
    };
  } catch (err) {
    return {
      path: urlPath,
      status: 0,
      code: 'network_error',
      reason: String(err?.message ?? err),
      bytes: 0,
      elapsedMs: roundMs(performance.now() - t0),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seeds a pristine legacy checkpointless cold child wire (checkpoints: [], NO summary/sidecar)
 * at the exact target byte size (e.g., 20 MB / 60 MB / 82.65 MB / 100 MB).
 */
export function seedColdCheckpointlessChildSession({
  homeDir,
  workspaceId,
  workspaceDir,
  sessionId,
  childAgentId = 'sub_cold_p01',
  targetBytes = P01_COLD_CHILD_SIZES_BYTES[2],
  stepCount = 200,
}) {
  const sessionDir = path.join(homeDir, 'sessions', workspaceId, sessionId);
  const mainDir = path.join(sessionDir, 'agents', 'main');
  const childDir = path.join(sessionDir, 'agents', childAgentId);
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(childDir, { recursive: true });

  const now = Date.now();
  fs.writeFileSync(
    path.join(mainDir, 'wire.jsonl'),
    [
      JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: now - 600_000 }),
      JSON.stringify({
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'p_p01_main_0',
        input: [{ type: 'text', text: 'Inspect cold child workspace.' }],
        origin: { kind: 'user' },
        time: now - 590_000,
      }),
      JSON.stringify({
        type: 'turn.ended',
        turnId: 0,
        durationMs: 500,
        reason: 'completed',
        time: now - 589_500,
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  const wirePath = path.join(childDir, 'wire.jsonl');
  const wireMeta = writeCheckpointlessColdChildWire({
    wirePath,
    agentId: childAgentId,
    targetBytes,
    stepCount,
  });

  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        sessionId,
        workspaceDir,
        createdAt: now - 600_000,
        updatedAt: now - 10_000,
        agents: {
          main: { agentId: 'main', role: 'main', status: 'idle', createdAt: now - 600_000, updatedAt: now - 10_000 },
          [childAgentId]: {
            agentId: childAgentId,
            parentAgentId: 'main',
            role: 'subagent',
            profile: 'general',
            status: 'completed',
            createdAt: now - 590_000,
            updatedAt: now - 10_000,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { sessionId, childAgentId, wirePath, wireMeta };
}

/**
 * Runs the P0-1 Cold Checkpointless Child 7-GET + subscribe_v2 fan-out probe
 * against a real kap-server (Astra v2.3 §§9.1, 10.1).
 */
export async function runP01ColdChildFanoutProbe({
  server,
  corpus,
  WebSocket,
  targetBytes = 20 * 1024 * 1024,
  stepCount = 150,
  progress = () => {},
}) {
  const sessionId = `chaos_p01_${randomUUID().slice(0, 8)}`;
  const childAgentId = 'sub_cold_p01';
  const seeded = seedColdCheckpointlessChildSession({
    homeDir: corpus.homeDir,
    workspaceId: corpus.workspaceId,
    workspaceDir: corpus.workspaceDir,
    sessionId,
    childAgentId,
    targetBytes,
    stepCount,
  });

  progress(
    `P0-1 Cold Child Probe: session=${sessionId} child=${childAgentId} wire=${(seeded.wireMeta.bytesWritten / (1024 * 1024)).toFixed(2)} MiB (checkpoints=[], steps=${stepCount})`,
  );

  await server.resetWindow();
  const t0 = performance.now();

  const endpoints = [
    `/api/sessions/${encodeURIComponent(sessionId)}/snapshot`,
    `/api/sessions/${encodeURIComponent(sessionId)}/status`,
    `/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(childAgentId)}/hooks?observe=true`,
    `/api/sessions/${encodeURIComponent(sessionId)}/transcript?agent_id=${encodeURIComponent(childAgentId)}&transcript_coverage_version=2`,
    `/api/sessions/${encodeURIComponent(sessionId)}/transcript/plan?agent_id=${encodeURIComponent(childAgentId)}`,
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks`,
    `/api/usage/sessions/${encodeURIComponent(sessionId)}/accounting`,
  ];

  // Fire WS subscribe_v2 for child in parallel with the 7 HTTP GETs
  let wsFirstResetMs = null;
  let wsResetItemsCount = 0;
  const wsPromise = WebSocket
    ? new Promise((resolve) => {
        const wsUrl = `${server.endpoint.replace(/^http/u, 'ws')}/api/ws`;
        const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${server.token}` } });
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          resolve();
        }, 10_000);
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              id: `p01_sub_${sessionId}`,
              type: 'subscribe_v2',
              payload: {
                session_id: sessionId,
                transcript: { [childAgentId]: 'delta', '*': 'off' },
                transcript_coverage_version: 2,
              },
            }),
          );
        });
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
            if (msg?.type === 'transcript.reset' && msg?.payload?.agent_id === childAgentId) {
              wsFirstResetMs = roundMs(performance.now() - t0);
              wsResetItemsCount = Array.isArray(msg?.payload?.snapshot?.items) ? msg.payload.snapshot.items.length : 0;
              clearTimeout(timer);
              ws.close();
              resolve();
            }
          } catch {}
        });
        ws.on('error', () => {
          clearTimeout(timer);
          resolve();
        });
      })
    : Promise.resolve();

  const [httpResults] = await Promise.all([
    Promise.all(endpoints.map((ep) => fetchEndpoint(server.endpoint, server.token, ep))),
    wsPromise,
  ]);
  const fanoutWallMs = roundMs(performance.now() - t0);
  const postMetrics = await server.metrics(true);

  const transcriptRes = httpResults.find((r) => r.path.includes('/transcript?'));
  const firstPaintMs = wsFirstResetMs ?? transcriptRes?.elapsedMs ?? fanoutWallMs;
  const controlBarSettleMs = Math.max(...httpResults.map((r) => r.elapsedMs));

  const trial = {
    lane: 'legacy',
    sessionId,
    childAgentId,
    wireBytes: seeded.wireMeta.bytesWritten,
    checkpoints: [],
    preexistingSummaryOrSidecar: false,
    wasColdBeforeOpen: true,
    firstPaintMs,
    controlBarSettleMs,
    wsFirstResetMs,
    wsResetItemsCount,
    fanoutWallMs,
    responses: httpResults,
    aggregateWireReadBytes: seeded.wireMeta.bytesWritten,
    aggregateParseInputBytes: 0, // measured separately via instrumented read when available
    eldP99Ms: postMetrics.eldP99Ms,
    eldMaxMs: postMetrics.eldMaxMs,
  };

  const verdict = evaluateP01ColdChildGate(trial);
  progress(
    `P0-1 Result: passed=${verdict.passed} firstPaint=${firstPaintMs}ms controlBar=${controlBarSettleMs}ms fanoutWall=${fanoutWallMs}ms eldMax=${postMetrics.eldMaxMs}ms`,
  );
  return { ...verdict, trial };
}
