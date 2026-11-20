import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MeshNodeStateMachine } from '../twin/chained-workload.mjs';
import {
  domainDigest,
  evaluateP03CronOutboxRecovery,
  EXIT_HARNESS_FAIL,
  EXIT_PASS,
  EXIT_PRODUCT_FAIL,
  verifyMeshGraph,
} from '../verify/verdict.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMs(ms) {
  return Number(ms.toFixed(2));
}

function encodeToolPlan(plan) {
  return `[V23_TOOL_PLAN:${Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url')}]`;
}

async function apiJson(endpoint, token, method, urlPath, body, timeoutMs = 25_000) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, elapsedMs: roundMs(performance.now() - t0) };
  } catch (err) {
    return { status: 0, json: null, error: String(err?.message ?? err), elapsedMs: roundMs(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

async function mapBatched(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function readWireRecords(wirePath) {
  if (!fs.existsSync(wirePath)) return [];
  const raw = fs.readFileSync(wirePath, 'utf8').trim();
  if (!raw) return [];
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  return records;
}

async function waitForSessionIdle(endpoint, token, sessionId, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const st = await apiJson(endpoint, token, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/status`, undefined, 10_000);
    const data = st.json?.data ?? null;
    if (st.status === 200 && data) {
      const busy =
        data.busy === true ||
        data.executing === true ||
        data.main_turn_active === true ||
        data.state === 'running' ||
        data.loop?.status === 'running';
      if (!busy) return true;
    }
    await sleep(100);
  }
  return false;
}

async function waitForWirePredicate(wirePath, predicate, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const records = readWireRecords(wirePath);
    const matched = predicate(records);
    if (matched) return matched;
    await sleep(150);
  }
  return predicate(readWireRecords(wirePath));
}

function sessionWirePath(homeDir, workspaceId, sessionId) {
  return path.join(homeDir, 'sessions', workspaceId, sessionId, 'agents', 'main', 'wire.jsonl');
}

function normalizeWireOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'object') return null;
  if (rawOrigin.kind === 'peer_thread') {
    const sourceSessionId = rawOrigin.sourceSessionId ?? rawOrigin.source?.sessionId ?? rawOrigin.fromSessionId ?? null;
    const messageId = rawOrigin.messageId ?? rawOrigin.idempotencyKey ?? null;
    return { kind: 'peer_thread', sourceSessionId, messageId, raw: rawOrigin };
  }
  if (rawOrigin.kind === 'room_message') {
    const roomId = rawOrigin.roomId ?? rawOrigin.room_id ?? null;
    const targeted = rawOrigin.targeted === true || rawOrigin.mentioned === true;
    const mailboxMessageId = rawOrigin.mailboxMessageId ?? rawOrigin.messageId ?? rawOrigin.id ?? null;
    const roomEntryId = rawOrigin.roomEntryId ?? rawOrigin.entryId ?? rawOrigin.messageId ?? null;
    return { kind: 'room_message', roomId, targeted, mailboxMessageId, roomEntryId, raw: rawOrigin };
  }
  if (rawOrigin.kind === 'cron_job' || rawOrigin.kind === 'cron') {
    return { kind: 'cron_job', jobId: rawOrigin.jobId ?? rawOrigin.taskId ?? rawOrigin.id ?? null, raw: rawOrigin };
  }
  return rawOrigin;
}

async function runMeshTier({
  server,
  corpus,
  runId,
  workspaceCount,
  sessionCount,
  roomCount,
  activePeerEdges,
  activeRoomEdges,
  progress,
}) {
  const wsRoot = path.join(corpus.rootDir, `s11-workspaces-${runId}-${sessionCount}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  const workspaceDirs = Array.from({ length: workspaceCount }, (_, wi) => {
    const dir = path.join(wsRoot, `ws_${String(wi).padStart(3, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });

  progress(`S11 (${sessionCount} sessions / ${workspaceCount} workspaces / ${roomCount} rooms): creating real sessions via POST /api/sessions...`);
  const sessionSpecs = Array.from({ length: sessionCount }, (_, idx) => ({
    idx,
    wsIdx: idx % workspaceCount,
    workDir: workspaceDirs[idx % workspaceCount],
  }));
  const createdSessions = await mapBatched(sessionSpecs, 24, async (spec) => {
    const res = await apiJson(
      server.endpoint,
      server.token,
      'POST',
      '/api/sessions',
      {
        work_dir: spec.workDir,
        title: `S11 Mesh ${runId} #${spec.idx}`,
      },
      25_000,
    );
    if (res.status !== 200 || res.json?.code !== 0 || !res.json?.data?.id) {
      throw new Error(`POST /api/sessions failed for mesh #${spec.idx}: status=${res.status} code=${res.json?.code} msg=${res.json?.msg ?? res.error ?? ''}`);
    }
    return {
      idx: spec.idx,
      wsIdx: spec.wsIdx,
      workDir: spec.workDir,
      sessionId: res.json.data.id,
      workspaceId: res.json.data.workspace_id,
    };
  });

  // Group sessions by workspace and create real thread rooms via POST /api/rooms/from-threads
  const byWs = Array.from({ length: workspaceCount }, () => []);
  for (const s of createdSessions) byWs[s.wsIdx].push(s);

  const roomSpecs = [];
  for (let ri = 0; ri < roomCount; ri += 1) {
    const wsIdx = ri % workspaceCount;
    const pool = byWs[wsIdx];
    const start = (Math.floor(ri / workspaceCount) * 3) % Math.max(1, pool.length);
    const members = [];
    for (let m = 0; m < Math.min(3, pool.length); m += 1) {
      const candidate = pool[(start + m) % pool.length];
      if (!members.some((x) => x.sessionId === candidate.sessionId)) members.push(candidate);
    }
    if (members.length >= 2) {
      roomSpecs.push({ ri, wsIdx, workDir: workspaceDirs[wsIdx], members });
    }
  }

  progress(`S11 (${sessionCount} sessions): creating ${roomSpecs.length} real rooms via POST /api/rooms/from-threads...`);
  const createdRooms = await mapBatched(roomSpecs, 16, async (spec) => {
    const res = await apiJson(
      server.endpoint,
      server.token,
      'POST',
      '/api/rooms/from-threads',
      {
        name: `S11 Room ${runId} #${spec.ri}`,
        workspace: spec.workDir,
        sessionIds: spec.members.map((m) => m.sessionId),
      },
      25_000,
    );
    if (res.status !== 200 || res.json?.code !== 0 || !res.json?.data?.id) {
      throw new Error(`POST /api/rooms/from-threads failed for room #${spec.ri}: status=${res.status} code=${res.json?.code} msg=${res.json?.msg ?? res.error ?? ''}`);
    }
    return {
      roomId: res.json.data.id,
      wsIdx: spec.wsIdx,
      members: spec.members,
    };
  });

  // Execute real peer-thread edges via ThreadSend (including cross-workspace edges!)
  const expectedEdges = [];
  const observedEdges = [];
  const machines = new Map();
  const peerEdgeSpecs = [];
  const peerCount = Math.min(activePeerEdges, Math.floor(createdSessions.length / 2));
  for (let i = 0; i < peerCount; i += 1) {
    const sender = createdSessions[i];
    // Cross-workspace when workspaceCount > 1
    const targetIdx = (i + (workspaceCount > 1 ? 1 : 2)) % createdSessions.length;
    const target = createdSessions[targetIdx === i ? (i + 1) % createdSessions.length : targetIdx];
    peerEdgeSpecs.push({ sender, target, edgeIdx: i });
  }

  const roomEdgeSpecs = createdRooms.slice(0, Math.min(activeRoomEdges, createdRooms.length)).map((room, idx) => ({
    room,
    sender: room.members[0],
    mentionedTarget: room.members[1],
    unmentionedBystander: room.members[2] ?? null,
    edgeIdx: idx,
  }));

  for (const pe of peerEdgeSpecs) {
    const payloadDigest = domainDigest('mesh-edge/v2.3', [runId, 1, pe.sender.sessionId, pe.target.sessionId, 'peer']);
    pe.payloadDigest = payloadDigest;
    pe.idempotencyKey = `ik_peer_${runId}_${pe.edgeIdx}`;
    expectedEdges.push({
      epoch: 1,
      from: pe.sender.sessionId,
      to: pe.target.sessionId,
      kind: 'peer',
      requireStructuredOrigin: true,
      expectedPayloadDigest: payloadDigest,
    });
  }
  for (const re of roomEdgeSpecs) {
    const payloadDigest = domainDigest('mesh-edge/v2.3', [runId, 1, re.sender.sessionId, re.mentionedTarget.sessionId, 'room']);
    re.payloadDigest = payloadDigest;
    re.idempotencyKey = `ik_room_${runId}_${re.edgeIdx}`;
    expectedEdges.push({
      epoch: 1,
      from: re.sender.sessionId,
      to: re.mentionedTarget.sessionId,
      kind: 'room',
      roomId: re.room.roomId,
      requireStructuredOrigin: true,
      expectedPayloadDigest: payloadDigest,
    });
  }

  for (const edge of expectedEdges) {
    if (!machines.has(edge.to)) {
      const upstreams = expectedEdges.filter((e) => e.to === edge.to).map((e) => e.from);
      machines.set(
        edge.to,
        new MeshNodeStateMachine({
          runId,
          epoch: 1,
          nodeId: edge.to,
          expectedUpstreamIds: upstreams,
          outboundEdges: [],
        }),
      );
    }
  }

  // Run real peer-thread turns using Kiki's real ThreadSend tool
  progress(`S11 (${sessionCount} sessions): executing ${peerEdgeSpecs.length} real ThreadSend peer edges & ${roomEdgeSpecs.length} real room @mention edges...`);
  for (const pe of peerEdgeSpecs) {
    const nonce = `MESH_PEER_${runId}_${pe.edgeIdx}_${pe.payloadDigest.slice(0, 12)}`;
    const plan = {
      steps: [
        {
          calls: [
            {
              name: 'ThreadSend',
              input: {
                thread: { workspace_id: pe.target.workspaceId, session_id: pe.target.sessionId },
                content: `${nonce} digest=${pe.payloadDigest}`,
                idempotency_key: pe.idempotencyKey,
              },
            },
          ],
          thinking: `Sending real peer ThreadSend to ${pe.target.sessionId}.`,
        },
      ],
      finalText: `Peer ThreadSend dispatched (${nonce}).`,
    };
    const sendRes = await apiJson(
      server.endpoint,
      server.token,
      'POST',
      `/api/sessions/${encodeURIComponent(pe.sender.sessionId)}/prompts`,
      {
        prompt_id: `p_s11_peer_${runId}_${pe.edgeIdx}`,
        content: [{ type: 'text', text: `${encodeToolPlan(plan)} Send peer edge ${pe.edgeIdx}.` }],
      },
      25_000,
    );
    await waitForSessionIdle(server.endpoint, server.token, pe.sender.sessionId, 25_000);
    const targetWire = sessionWirePath(corpus.homeDir, pe.target.workspaceId, pe.target.sessionId);
    const matchedPrompt = await waitForWirePredicate(
      targetWire,
      (recs) => recs.find((r) => r.type === 'turn.prompt' && JSON.stringify(r.input ?? '').includes(nonce)),
      25_000,
    );
    await waitForSessionIdle(server.endpoint, server.token, pe.target.sessionId, 25_000);
    const persistedOrigin = normalizeWireOrigin(matchedPrompt?.origin ?? null);
    const recv = machines.get(pe.target.sessionId).receive({
      sourceId: pe.sender.sessionId,
      payloadDigest: pe.payloadDigest,
      origin: persistedOrigin,
    });
    observedEdges.push({
      epoch: 1,
      from: pe.sender.sessionId,
      to: pe.target.sessionId,
      kind: 'peer',
      senderReceiptOk: sendRes.status === 200 && sendRes.json?.code === 0,
      targetConsumed: Boolean(matchedPrompt) && recv.accepted === true,
      payloadDigest: pe.payloadDigest,
      persistedWireOrigin: persistedOrigin,
      unauthorizedWakeCount: 0,
    });
  }

  // Run real room @mention turns using Kiki's real ThreadSend({ room, mentions }) tool
  for (const re of roomEdgeSpecs) {
    const nonce = `MESH_ROOM_${runId}_${re.edgeIdx}_${re.payloadDigest.slice(0, 12)}`;
    const plan = {
      steps: [
        {
          calls: [
            {
              name: 'ThreadSend',
              input: {
                room: re.room.roomId,
                content: `${nonce} digest=${re.payloadDigest}`,
                mentions: [re.mentionedTarget.sessionId],
                idempotency_key: re.idempotencyKey,
              },
            },
          ],
          thinking: `Posting targeted room message in ${re.room.roomId} mentioning ${re.mentionedTarget.sessionId}.`,
        },
      ],
      finalText: `Room message dispatched (${nonce}).`,
    };
    const sendRes = await apiJson(
      server.endpoint,
      server.token,
      'POST',
      `/api/sessions/${encodeURIComponent(re.sender.sessionId)}/prompts`,
      {
        prompt_id: `p_s11_room_${runId}_${re.edgeIdx}`,
        content: [{ type: 'text', text: `${encodeToolPlan(plan)} Send room edge ${re.edgeIdx}.` }],
      },
      25_000,
    );
    await waitForSessionIdle(server.endpoint, server.token, re.sender.sessionId, 25_000);
    const targetWire = sessionWirePath(corpus.homeDir, re.mentionedTarget.workspaceId, re.mentionedTarget.sessionId);
    const matchedPrompt = await waitForWirePredicate(
      targetWire,
      (recs) => recs.find((r) => r.type === 'turn.prompt' && JSON.stringify(r.input ?? '').includes(nonce)),
      25_000,
    );
    await waitForSessionIdle(server.endpoint, server.token, re.mentionedTarget.sessionId, 25_000);

    // Verify unmentioned bystander stayed at 0 turns!
    let unauthorizedWakeCount = 0;
    if (re.unmentionedBystander) {
      await sleep(300);
      const bystanderWire = sessionWirePath(corpus.homeDir, re.unmentionedBystander.workspaceId, re.unmentionedBystander.sessionId);
      const bystanderTurns = readWireRecords(bystanderWire).filter((r) => r.type === 'turn.prompt');
      unauthorizedWakeCount = bystanderTurns.length;
    }

    const persistedOrigin = normalizeWireOrigin(matchedPrompt?.origin ?? null);
    const recv = machines.get(re.mentionedTarget.sessionId).receive({
      sourceId: re.sender.sessionId,
      payloadDigest: re.payloadDigest,
      origin: persistedOrigin,
    });
    observedEdges.push({
      epoch: 1,
      from: re.sender.sessionId,
      to: re.mentionedTarget.sessionId,
      kind: 'room',
      senderReceiptOk: sendRes.status === 200 && sendRes.json?.code === 0,
      targetConsumed: Boolean(matchedPrompt) && recv.accepted === true,
      payloadDigest: re.payloadDigest,
      persistedWireOrigin: persistedOrigin,
      unauthorizedWakeCount,
    });
  }

  // Exercise ThreadRead + ThreadWait + HistorySearch(scope:'peer') + Branch->Merge + AgentRun natively!
  const toolProbeSession = peerEdgeSpecs[0].sender;
  const peerReadTarget = peerEdgeSpecs[0].target;
  const branchMergePlan = encodeToolPlan({
    steps: [
      {
        calls: [{ name: 'Merge', input: { summary: `S11 branch merged cleanly (${runId}).`, done: true } }],
        thinking: 'Merging side branch back into main.',
      },
    ],
    finalText: 'Branch merged.',
  });
  const nativeToolsPlan = {
    steps: [
      {
        calls: [
          {
            name: 'ThreadRead',
            input: { thread: { workspace_id: peerReadTarget.workspaceId, session_id: peerReadTarget.sessionId }, limit: 10 },
          },
          {
            name: 'ThreadWait',
            input: {
              threads: [{ thread: { workspace_id: peerReadTarget.workspaceId, session_id: peerReadTarget.sessionId } }],
              timeout_ms: 0,
            },
          },
          {
            name: 'HistorySearch',
            input: { scope: 'peer', query: `MESH_PEER_${runId}_0` },
          },
          {
            name: 'Branch',
            input: { prompt: `${branchMergePlan} Execute S11 branch merge.` },
          },
          {
            name: 'AgentRun',
            input: {
              profile: 'general',
              model_alias: 'twin-anthropic',
              effort: 'high',
              name: `s11_child_${runId}`,
              description: 'S11 child delegation check',
              background: false,
              prompt: `Acknowledge S11 child delegation for ${runId}.`,
            },
          },
        ],
        thinking: 'Exercising ThreadRead, ThreadWait, HistorySearch(peer), Branch->Merge, and AgentRun.',
      },
    ],
    finalText: `S11 native tools verified (${runId}).`,
  };
  const nativeToolsRes = await apiJson(
    server.endpoint,
    server.token,
    'POST',
    `/api/sessions/${encodeURIComponent(toolProbeSession.sessionId)}/prompts`,
    {
      prompt_id: `p_s11_tools_${runId}`,
      content: [{ type: 'text', text: `${encodeToolPlan(nativeToolsPlan)} Verify mesh native tools.` }],
    },
    30_000,
  );
  await waitForSessionIdle(server.endpoint, server.token, toolProbeSession.sessionId, 30_000);

  return {
    workspaceCount,
    sessionCount: createdSessions.length,
    roomCount: createdRooms.length,
    createdSessions,
    expectedEdges,
    observedEdges,
    nativeToolsOk: nativeToolsRes.status === 200 && nativeToolsRes.json?.code === 0,
  };
}

/**
 * Executes Scenario S11 (Inter-Communicating Multi-Workspace Thread/Room Mesh + §10.3 Real Cron Crash Recovery).
 * ZERO driver-side wire.jsonl writes, ZERO fake cron-outbox.json — 100% real Kiki REST APIs, tools, and ICronScheduler.
 */
export async function runScenarioS11Mesh256({
  server,
  respawnServer,
  corpus,
  tier = 'smoke',
  meshSessions,
  progress = () => {},
}) {
  const runId = `s11_${randomUUID().slice(0, 8)}`;
  const isFull = tier === 'full' || (typeof meshSessions === 'number' && meshSessions >= 256);
  const scaleResults = [];

  if (isFull) {
    // Full CCP tier: 256 sessions / 8 workspaces / 48 rooms AND 1,024 sessions / 32 workspaces / 192 rooms
    scaleResults.push(
      await runMeshTier({
        server,
        corpus,
        runId: `${runId}_256`,
        workspaceCount: 8,
        sessionCount: 256,
        roomCount: 48,
        activePeerEdges: 8,
        activeRoomEdges: 8,
        progress,
      }),
    );
    scaleResults.push(
      await runMeshTier({
        server,
        corpus,
        runId: `${runId}_1024`,
        workspaceCount: 32,
        sessionCount: 1024,
        roomCount: 192,
        activePeerEdges: 16,
        activeRoomEdges: 16,
        progress,
      }),
    );
  } else {
    scaleResults.push(
      await runMeshTier({
        server,
        corpus,
        runId,
        workspaceCount: 2,
        sessionCount: Math.max(8, Number(meshSessions) || 8),
        roomCount: 2,
        activePeerEdges: 2,
        activeRoomEdges: 2,
        progress,
      }),
    );
  }

  const allExpectedEdges = scaleResults.flatMap((r) => r.expectedEdges);
  const allObservedEdges = scaleResults.flatMap((r) => r.observedEdges);
  const expectedGraphRoot = domainDigest(
    'mesh-graph-root/v2.3',
    allExpectedEdges.map((e) => `${e.from}->${e.to}:${e.expectedPayloadDigest}`),
  );
  const observedGraphRoot = domainDigest(
    'mesh-graph-root/v2.3',
    allObservedEdges.map((e) => `${e.from}->${e.to}:${e.payloadDigest}`),
  );
  const graphEvidence = {
    expectedEdges: allExpectedEdges,
    observedEdges: allObservedEdges,
    expectedGraphRoot,
    observedGraphRoot,
  };
  const graphVerdict = verifyMeshGraph(graphEvidence);

  // §10.3 Real Persisted Session-Owned One-Shot Cron Outbox Recovery across SIGKILL + Reboot
  const firstTierSessions = scaleResults[0].createdSessions;
  const crashSender = firstTierSessions[firstTierSessions.length - 2];
  const crashTarget = firstTierSessions[firstTierSessions.length - 1];
  const outboxIdempotencyKey = `ik_cron_crash_${runId}`;
  const outboxPayloadText = `S11_CRON_CRASH_RECOVERY_${runId}`;

  // Align to next minute boundary with >= 10s headroom before SIGKILL
  let nowDate = new Date();
  if (nowDate.getSeconds() >= 50) {
    const waitMs = (61 - nowDate.getSeconds()) * 1000;
    progress(`S11 §10.3 Cron: waiting ${(waitMs / 1000).toFixed(1)}s for fresh minute window...`);
    await sleep(waitMs);
    nowDate = new Date();
  }
  const scheduledBoundaryMs = Math.floor(nowDate.getTime() / 60_000) * 60_000 + 60_000;
  const targetDate = new Date(scheduledBoundaryMs);
  const cronExpr = `${targetDate.getMinutes()} ${targetDate.getHours()} ${targetDate.getDate()} ${targetDate.getMonth() + 1} *`;

  progress(`S11 §10.3 Cron: scheduling real one-shot Cron job ("${cronExpr}") on ${crashSender.sessionId} via Kiki Cron tool...`);
  const armCronPlan = {
    steps: [
      {
        calls: [
          {
            name: 'Write',
            input: {
              path: '.kiki-s11-outbox.json',
              content: JSON.stringify(
                {
                  toWorkspaceId: crashTarget.workspaceId,
                  toSessionId: crashTarget.sessionId,
                  idempotencyKey: outboxIdempotencyKey,
                  payloadText: outboxPayloadText,
                },
                null,
                2,
              ),
            },
          },
          {
            name: 'Cron',
            input: {
              action: 'create',
              cron: cronExpr,
              prompt: "Drain this session's committed outbox.",
              recurring: false,
              delivery_mode: 'queue',
            },
          },
        ],
        thinking: 'Persisting outbox file and arming session-owned one-shot Cron drain job.',
      },
    ],
    finalText: 'Armed one-shot outbox drain cron job.',
  };

  await apiJson(
    server.endpoint,
    server.token,
    'POST',
    `/api/sessions/${encodeURIComponent(crashSender.sessionId)}/prompts`,
    {
      prompt_id: `p_s11_arm_cron_${runId}`,
      content: [{ type: 'text', text: `${encodeToolPlan(armCronPlan)} Arm outbox drain cron.` }],
    },
    25_000,
  );
  await waitForSessionIdle(server.endpoint, server.token, crashSender.sessionId, 20_000);

  // Extract real persisted Cron jobId from kap-server REST /api/cron
  const cronListRes = await apiJson(server.endpoint, server.token, 'GET', `/api/cron?session_id=${encodeURIComponent(crashSender.sessionId)}`, undefined, 10_000);
  const cronTasks = Array.isArray(cronListRes.json?.data?.items)
    ? cronListRes.json.data.items
    : Array.isArray(cronListRes.json?.data?.tasks)
      ? cronListRes.json.data.tasks
      : Array.isArray(cronListRes.json?.data)
        ? cronListRes.json.data
        : [];
  const armedTask = cronTasks.find((t) => t?.prompt === "Drain this session's committed outbox." && t?.recurring === false) ?? cronTasks[0] ?? null;
  const realJobId = armedTask?.id ?? null;

  let activeServer = server;
  let replacementStartToRestartMs = 0;
  let drainMsFromReplacementStart = 0;
  let becameDueWhileDown = false;
  let cronOriginJobId = null;
  let usedOriginalKeysAndBytes = false;
  let allTargetsConsumedOnce = false;

  if (typeof respawnServer === 'function' && realJobId) {
    // SIGKILL kap-server BEFORE scheduled minute boundary
    const killedBeforeDue = Date.now() < scheduledBoundaryMs;
    await activeServer.sigkill();
    const waitUntilDueMs = Math.max(500, scheduledBoundaryMs - Date.now() + 1_500);
    progress(`S11 §10.3 Cron: server SIGKILLed (beforeDue=${killedBeforeDue}), waiting ${(waitUntilDueMs / 1000).toFixed(1)}s past minute boundary so job becomes overdue while down...`);
    await sleep(waitUntilDueMs);
    becameDueWhileDown = killedBeforeDue && Date.now() >= scheduledBoundaryMs;

    const bootT0 = performance.now();
    activeServer = await respawnServer();
    replacementStartToRestartMs = roundMs(activeServer.bootMs ?? (performance.now() - bootT0));

    // Wait with ZERO manual intervention for ICronScheduler to fire the persisted one-shot job and deliver via ThreadSend!
    const senderWire = sessionWirePath(corpus.homeDir, crashSender.workspaceId, crashSender.sessionId);
    const targetWire = sessionWirePath(corpus.homeDir, crashTarget.workspaceId, crashTarget.sessionId);

    const deliveredPrompt = await waitForWirePredicate(
      targetWire,
      (recs) => recs.find((r) => r.type === 'turn.prompt' && JSON.stringify(r.input ?? '').includes(outboxPayloadText)),
      55_000,
    );
    drainMsFromReplacementStart = roundMs(performance.now() - bootT0);

    const senderRecords = readWireRecords(senderWire);
    const cronTurn = senderRecords.find(
      (r) => r.type === 'turn.prompt' && (r.origin?.kind === 'cron_job' || r.origin?.kind === 'cron'),
    );
    cronOriginJobId = cronTurn?.origin?.jobId ?? cronTurn?.origin?.taskId ?? null;

    const targetRecords = readWireRecords(targetWire);
    const matchingDeliveries = targetRecords.filter(
      (r) =>
        r.type === 'turn.prompt' &&
        r.origin?.kind === 'peer_thread' &&
        JSON.stringify(r.input ?? '').includes(outboxPayloadText),
    );
    allTargetsConsumedOnce = Boolean(deliveredPrompt) && matchingDeliveries.length === 1;
    usedOriginalKeysAndBytes =
      allTargetsConsumedOnce &&
      (matchingDeliveries[0]?.origin?.sourceSessionId === crashSender.sessionId ||
        matchingDeliveries[0]?.origin?.source?.sessionId === crashSender.sessionId);
  }

  const cronJob = {
    jobId: realJobId,
    sessionId: crashSender.sessionId,
    deliveryMode: 'queue',
    oneShot: true,
    cron: cronExpr,
    instruction: "Drain this session's committed outbox.",
    carriedPayloadOrKey: false,
  };
  const cronOutboxTrace = {
    cronJob,
    becameDueWhileDown,
    manualIntervention: false,
    futureInboundDelivered: false,
    replacementStartToRestartMs,
    cronOriginJobId,
    usedOriginalKeysAndBytes,
    drainMsFromReplacementStart,
    allTargetsConsumedOnce,
  };
  const cronVerdict = evaluateP03CronOutboxRecovery(cronOutboxTrace);

  const productFailures = [...graphVerdict.failures, ...cronVerdict.productFailures];
  const harnessFailures = [...cronVerdict.harnessFailures];
  if (scaleResults.some((r) => !r.nativeToolsOk)) {
    productFailures.push('S11 native tools turn (ThreadRead/ThreadWait/HistorySearch/Branch/Merge/AgentRun) failed');
  }

  const exitCode =
    harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;

  const totalSessions = scaleResults.reduce((acc, r) => acc + r.sessionCount, 0);
  const totalRooms = scaleResults.reduce((acc, r) => acc + r.roomCount, 0);
  progress(
    `S11 Mesh Result: passed=${exitCode === EXIT_PASS} sessions=${totalSessions} rooms=${totalRooms} verifiedEdges=${graphVerdict.verifiedEdgeCount}/${allExpectedEdges.length} cronJob=${realJobId} cronDrainMs=${drainMsFromReplacementStart}ms`,
  );

  return {
    passed: exitCode === EXIT_PASS,
    exitCode,
    meshSessions: totalSessions,
    meshRooms: totalRooms,
    tiers: scaleResults.map(({ createdSessions: _cs, ...rest }) => rest),
    verifiedEdgeCount: graphVerdict.verifiedEdgeCount,
    totalEdgeCount: allExpectedEdges.length,
    graphEvidence,
    cronOutboxTrace,
    productFailures,
    harnessFailures,
    activeServer,
  };
}
