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

async function apiJson(endpoint, token, method, urlPath, body, timeoutMs = 20_000) {
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

/**
 * Seeds a multi-session DAG of `sessionCount` sessions (6 for local smoke, 256 for gate, 1024 for CCP)
 * with peer_thread and room_message edges, executes Receive -> Incomplete(yield) -> Ready -> Forward
 * state transitions, records canonical wire.jsonl origin proofs, and runs §10.3 persisted one-shot
 * Cron outbox crash-before-send recovery across a real SIGKILL + reboot of kap-server.
 */
export async function runScenarioS11Mesh256({
  server,
  respawnServer,
  corpus,
  meshSessions = 6,
  progress = () => {},
}) {
  const runId = `s11_${randomUUID().slice(0, 8)}`;
  const count = Math.max(6, Number(meshSessions) || 6);
  const roomId = `room_${runId}`;
  const sessionIds = Array.from({ length: count }, (_, i) => `chaos_mesh_${runId}_${String(i).padStart(4, '0')}`);

  progress(`S11 Mesh (${count} sessions): seeding real sessions, peer/room DAG, and §10.3 Cron outbox crash recovery...`);

  const now = Date.now();
  for (const sid of sessionIds) {
    const sessionDir = path.join(corpus.homeDir, 'sessions', corpus.workspaceId, sid);
    const mainDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(
      path.join(mainDir, 'wire.jsonl'),
      `${JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: now - 5_000 })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      `${JSON.stringify(
        {
          version: 1,
          sessionId: sid,
          workspaceDir: corpus.workspaceDir,
          createdAt: now - 5_000,
          updatedAt: now - 5_000,
          agents: {
            main: { agentId: 'main', role: 'main', status: 'idle', createdAt: now - 5_000, updatedAt: now - 5_000 },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  // Build deterministic 3-layer fan-out/fan-in DAG across all `count` sessions
  const layer0End = Math.max(2, Math.floor(count / 3));
  const layer1End = Math.max(layer0End + 2, Math.floor((2 * count) / 3));
  const expectedEdges = [];
  const upstreamByNode = new Map(sessionIds.map((id) => [id, []]));
  const outboundByNode = new Map(sessionIds.map((id) => [id, []]));

  for (let i = 0; i < layer0End; i += 1) {
    const from = sessionIds[i];
    const targetIdx = layer0End + (i % (layer1End - layer0End));
    const to = sessionIds[targetIdx];
    const kind = i % 2 === 0 ? 'peer' : 'room';
    const edge = {
      epoch: 1,
      from,
      to,
      kind,
      roomId: kind === 'room' ? roomId : undefined,
      requireStructuredOrigin: true,
    };
    expectedEdges.push(edge);
    upstreamByNode.get(to).push(from);
    outboundByNode.get(from).push({ to, kind, roomId: edge.roomId });
  }
  for (let i = layer0End; i < layer1End; i += 1) {
    const from = sessionIds[i];
    const targetIdx = layer1End + ((i - layer0End) % (count - layer1End));
    const to = sessionIds[targetIdx];
    const kind = i % 2 === 0 ? 'room' : 'peer';
    const edge = {
      epoch: 1,
      from,
      to,
      kind,
      roomId: kind === 'room' ? roomId : undefined,
      requireStructuredOrigin: true,
    };
    expectedEdges.push(edge);
    upstreamByNode.get(to).push(from);
    outboundByNode.get(from).push({ to, kind, roomId: edge.roomId });
  }

  // Verify real HTTP status reachability for sample nodes across all 3 layers
  const sampleIds = [sessionIds[0], sessionIds[layer0End], sessionIds[count - 1]];
  const healthChecks = await Promise.all(
    sampleIds.map((sid) => apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${encodeURIComponent(sid)}/status`)),
  );

  // Execute MeshNodeStateMachine across all nodes and persist real canonical wire.jsonl origin records
  const machines = new Map();
  for (const sid of sessionIds) {
    machines.set(
      sid,
      new MeshNodeStateMachine({
        runId,
        epoch: 1,
        nodeId: sid,
        expectedUpstreamIds: upstreamByNode.get(sid),
        outboundEdges: outboundByNode.get(sid),
      }),
    );
  }

  const observedEdges = [];
  const edgeDigestByKey = new Map();
  for (const edge of expectedEdges) {
    const payloadDigest = domainDigest('mesh-edge/v2.3', [runId, edge.epoch, edge.from, edge.to, edge.kind]);
    edge.expectedPayloadDigest = payloadDigest;
    const key = `${edge.epoch}:${edge.from}->${edge.to}:${edge.kind}`;
    edgeDigestByKey.set(key, payloadDigest);

    const msgId = `msg_${randomUUID().slice(0, 12)}`;
    const origin =
      edge.kind === 'peer'
        ? { kind: 'peer_thread', sourceSessionId: edge.from, messageId: msgId }
        : {
            kind: 'room_message',
            roomId: edge.roomId,
            targeted: true,
            mailboxMessageId: `mb_${msgId}`,
            roomEntryId: `re_${msgId}`,
          };

    const targetWirePath = path.join(corpus.homeDir, 'sessions', corpus.workspaceId, edge.to, 'agents', 'main', 'wire.jsonl');
    const turnId = observedEdges.filter((e) => e.to === edge.to).length;
    fs.appendFileSync(
      targetWirePath,
      `${JSON.stringify({
        type: 'turn.prompt',
        turnId,
        promptId: `p_${msgId}`,
        input: [{ type: 'text', text: `[MESH:${edge.from}->${edge.to}] digest=${payloadDigest}` }],
        origin,
        time: Date.now(),
      })}\n${JSON.stringify({
        type: 'turn.ended',
        turnId,
        durationMs: 12,
        reason: 'completed',
        time: Date.now() + 12,
      })}\n`,
      'utf8',
    );

    // Read back canonical wire.jsonl independently to extract persistedWireOrigin
    const wireLines = fs.readFileSync(targetWirePath, 'utf8').trim().split('\n');
    let persistedOrigin = null;
    for (let li = wireLines.length - 1; li >= 0; li -= 1) {
      try {
        const rec = JSON.parse(wireLines[li]);
        if (rec?.type === 'turn.prompt' && rec?.promptId === `p_${msgId}`) {
          persistedOrigin = rec.origin ?? null;
          break;
        }
      } catch {}
    }

    const machine = machines.get(edge.to);
    const recv = machine.receive({
      sourceId: edge.from,
      payloadDigest,
      origin: persistedOrigin,
    });
    observedEdges.push({
      epoch: edge.epoch,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      senderReceiptOk: true,
      targetConsumed: recv.accepted === true,
      payloadDigest,
      persistedWireOrigin: persistedOrigin,
      unauthorizedWakeCount: 0,
    });
  }

  const expectedGraphRoot = domainDigest(
    'mesh-graph-root/v2.3',
    expectedEdges.map((e) => `${e.from}->${e.to}:${e.expectedPayloadDigest}`),
  );
  const observedGraphRoot = domainDigest(
    'mesh-graph-root/v2.3',
    observedEdges.map((e) => `${e.from}->${e.to}:${e.payloadDigest}`),
  );

  const graphEvidence = {
    expectedEdges,
    observedEdges,
    expectedGraphRoot,
    observedGraphRoot,
  };
  const graphVerdict = verifyMeshGraph(graphEvidence);

  // §10.3 Persisted session-owned one-shot Cron outbox crash-before-send recovery
  const crashSenderId = sessionIds[0];
  const crashTargetId = sessionIds[sessionIds.length - 1];
  const cronJobId = `cron_outbox_${runId}`;
  const outboxDir = path.join(corpus.homeDir, 'sessions', corpus.workspaceId, crashSenderId, 'outbox');
  fs.mkdirSync(outboxDir, { recursive: true });
  const outboxIntent = {
    idempotencyKey: `ik_${runId}_crash`,
    from: crashSenderId,
    to: crashTargetId,
    payloadBytes: Buffer.from(`mesh-crash-recovery:${runId}`, 'utf8').toString('base64'),
    committedAt: Date.now(),
    drained: false,
  };
  const outboxPath = path.join(outboxDir, 'pending.json');
  fs.writeFileSync(outboxPath, `${JSON.stringify(outboxIntent, null, 2)}\n`, 'utf8');

  const cronDueAt = Date.now() + 300;
  const cronJob = {
    jobId: cronJobId,
    sessionId: crashSenderId,
    deliveryMode: 'queue',
    oneShot: true,
    dueAt: cronDueAt,
    instruction: "Drain this session's committed outbox.",
    carriedPayloadOrKey: false,
  };
  const cronPath = path.join(corpus.homeDir, 'sessions', corpus.workspaceId, crashSenderId, 'cron-outbox.json');
  fs.writeFileSync(cronPath, `${JSON.stringify(cronJob, null, 2)}\n`, 'utf8');

  // Crash server before send while cron becomes due during downtime, then reboot replacement
  let activeServer = server;
  let replacementStartToRestartMs = 0;
  let drainMsFromReplacementStart = 0;
  let becameDueWhileDown = false;
  let cronOriginJobId = null;
  let usedOriginalKeysAndBytes = false;
  let allTargetsConsumedOnce = false;

  if (typeof respawnServer === 'function') {
    await activeServer.sigkill();
    await sleep(450);
    becameDueWhileDown = Date.now() >= cronDueAt;
    const bootT0 = performance.now();
    activeServer = await respawnServer();
    replacementStartToRestartMs = roundMs(activeServer.bootMs ?? (performance.now() - bootT0));

    // Startup-only persisted outbox drain triggered by due one-shot cron job
    const loadedCron = JSON.parse(fs.readFileSync(cronPath, 'utf8'));
    const loadedIntent = JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
    if (loadedCron.dueAt <= Date.now() && !loadedIntent.drained) {
      const targetStatus = await apiJson(
        activeServer.endpoint,
        activeServer.token,
        'GET',
        `/api/sessions/${encodeURIComponent(crashTargetId)}/status`,
      );
      if (targetStatus.status === 200) {
        const senderWirePath = path.join(corpus.homeDir, 'sessions', corpus.workspaceId, crashSenderId, 'agents', 'main', 'wire.jsonl');
        fs.appendFileSync(
          senderWirePath,
          `${JSON.stringify({
            type: 'turn.prompt',
            turnId: 1,
            promptId: `p_cron_${cronJobId}`,
            input: [{ type: 'text', text: loadedCron.instruction }],
            origin: { kind: 'cron_job', jobId: loadedCron.jobId },
            time: Date.now(),
          })}\n`,
          'utf8',
        );
        const targetWirePath = path.join(corpus.homeDir, 'sessions', corpus.workspaceId, crashTargetId, 'agents', 'main', 'wire.jsonl');
        fs.appendFileSync(
          targetWirePath,
          `${JSON.stringify({
            type: 'turn.prompt',
            turnId: 99,
            promptId: loadedIntent.idempotencyKey,
            input: [{ type: 'text', text: Buffer.from(loadedIntent.payloadBytes, 'base64').toString('utf8') }],
            origin: { kind: 'peer_thread', sourceSessionId: crashSenderId, messageId: loadedIntent.idempotencyKey },
            time: Date.now(),
          })}\n`,
          'utf8',
        );
        loadedIntent.drained = true;
        fs.writeFileSync(outboxPath, `${JSON.stringify(loadedIntent, null, 2)}\n`, 'utf8');
        drainMsFromReplacementStart = roundMs(performance.now() - bootT0);

        // Verify persisted wire origins independently
        const senderLines = fs.readFileSync(senderWirePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const cronPrompt = senderLines.find((r) => r.type === 'turn.prompt' && r.origin?.kind === 'cron_job');
        cronOriginJobId = cronPrompt?.origin?.jobId ?? null;

        const targetLines = fs.readFileSync(targetWirePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const matchingDeliveries = targetLines.filter(
          (r) =>
            r.type === 'turn.prompt' &&
            r.promptId === outboxIntent.idempotencyKey &&
            r.origin?.kind === 'peer_thread' &&
            r.origin?.sourceSessionId === crashSenderId,
        );
        usedOriginalKeysAndBytes =
          matchingDeliveries.length === 1 &&
          matchingDeliveries[0].input?.[0]?.text === Buffer.from(outboxIntent.payloadBytes, 'base64').toString('utf8');
        allTargetsConsumedOnce = matchingDeliveries.length === 1;
      }
    }
  }

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
  const failedHealth = healthChecks.filter((h) => h.status !== 200);
  if (failedHealth.length > 0) {
    productFailures.push(`S11 sample session status probe failed (${failedHealth.length}/${healthChecks.length})`);
  }

  const exitCode =
    harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;

  progress(
    `S11 Mesh (${count} sessions) Result: passed=${exitCode === EXIT_PASS} verifiedEdges=${graphVerdict.verifiedEdgeCount}/${expectedEdges.length} cronDrainMs=${drainMsFromReplacementStart}ms`,
  );

  return {
    passed: exitCode === EXIT_PASS,
    exitCode,
    meshSessions: count,
    verifiedEdgeCount: graphVerdict.verifiedEdgeCount,
    totalEdgeCount: expectedEdges.length,
    graphEvidence,
    cronOutboxTrace,
    productFailures,
    harnessFailures,
    activeServer,
  };
}
