import { createHash, randomUUID } from 'node:crypto';
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
      data: json?.data ?? null,
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
 * Independent full-file replay parity check for §10.1 Lane A (legacy pristine checkpointless wire).
 * Compares plan-marker presence AND tail turn IDs against server's /transcript + /transcript/plan responses.
 */
function verifyLegacyWireIndependently(wirePath, serverPlanData, serverTranscriptData) {
  const stat = fs.statSync(wirePath);
  const needle = Buffer.from('ExitPlanMode', 'utf8');
  const overlap = needle.length - 1;
  const chunkSize = 1024 * 1024;
  const buf = Buffer.allocUnsafe(chunkSize + overlap);
  const fd = fs.openSync(wirePath, 'r');
  let foundNeedle = false;
  let totalRead = 0;
  let tailText = '';
  try {
    let pos = 0;
    let carry = 0;
    while (pos < stat.size) {
      const toRead = Math.min(chunkSize, stat.size - pos);
      const bytesRead = fs.readSync(fd, buf, carry, toRead, pos);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
      const winLen = carry + bytesRead;
      if (buf.subarray(0, winLen).indexOf(needle) !== -1) {
        foundNeedle = true;
      }
      pos += bytesRead;
      if (overlap > 0 && winLen >= overlap) {
        buf.copy(buf, 0, winLen - overlap, winLen);
        carry = overlap;
      } else {
        carry = winLen;
      }
    }
    const tailLen = Math.min(256 * 1024, stat.size);
    const tailBuf = Buffer.allocUnsafe(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, Math.max(0, stat.size - tailLen));
    tailText = tailBuf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }

  const expectedTailTurnIds = [];
  for (const line of tailText.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.type === 'turn.prompt' || rec?.type === 'turn.ended') {
        const tid = `t${rec.turnId}`;
        if (!expectedTailTurnIds.includes(tid)) expectedTailTurnIds.push(tid);
      }
    } catch {}
  }

  const serverPlans = Array.isArray(serverPlanData?.plans) ? serverPlanData.plans : [];
  const planMatches = foundNeedle === (serverPlans.length > 0);
  const serverItems = Array.isArray(serverTranscriptData?.items) ? serverTranscriptData.items : [];
  const serverTurnIds = serverItems.filter((it) => it?.kind === 'turn').map((it) => it.turnId);
  const lastExpectedTurn = expectedTailTurnIds.at(-1) ?? null;
  const tailMatches =
    serverTurnIds.length > 0 &&
    (lastExpectedTurn === null || serverTurnIds.includes(lastExpectedTurn));
  const fullReplayMatches = planMatches && tailMatches;

  return {
    totalRead,
    foundNeedle,
    fullReplayMatches,
    fullReplayProof: {
      matches: fullReplayMatches,
      planMatches,
      tailMatches,
      turnCount: serverTurnIds.length,
      tailTurnIds: serverTurnIds.slice(-5),
      expectedLastTurnId: lastExpectedTurn,
    },
  };
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
            model: 'twin-anthropic',
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

function buildChildWorkspaceFanoutEndpoints(sessionId, childAgentId) {
  const sid = encodeURIComponent(sessionId);
  const cid = encodeURIComponent(childAgentId);
  return [
    `/api/sessions/${sid}/transcript?agent_id=${cid}&transcript_coverage_version=2`,
    `/api/agents/capabilities?session_id=${sid}&agent_id=${cid}&metrics_settle=true`,
    `/api/sessions/${sid}/agents/${cid}/model-switches`,
    `/api/sessions/${sid}/agents/${cid}/hooks?observe=true`,
    `/api/sessions/${sid}/agents/${cid}/auto-compact?observe=true`,
    `/api/sessions/${sid}/agents/${cid}/context-strategy?observe=true`,
    `/api/sessions/${sid}/status`,
    `/api/sessions/${sid}/transcript/plan?agent_id=${cid}`,
  ];
}

async function executeColdChildFanout({ server, WebSocket, sessionId, childAgentId, wirePath }) {
  const targetPathSuffix = path.join(sessionId, 'agents', childAgentId, 'wire.jsonl');
  let preOpenedWs = null;
  if (WebSocket) {
    try {
      const wsUrl = `${server.endpoint.replace(/^http/u, 'ws')}/api/ws`;
      preOpenedWs = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${server.token}` } });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4_000);
        preOpenedWs.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        preOpenedWs.once('error', () => {
          clearTimeout(timer);
          preOpenedWs = null;
          resolve();
        });
      });
    } catch {
      preOpenedWs = null;
    }
  }

  await server.resetWindow();
  if (typeof server.beginIoTrace === 'function') {
    await server.beginIoTrace(targetPathSuffix);
  }
  const t0 = performance.now();
  const endpoints = buildChildWorkspaceFanoutEndpoints(sessionId, childAgentId);

  let wsFirstResetMs = null;
  let wsLiveResetMs = null;
  let wsResetCount = 0;
  let wsFirstResetCursor = null;
  let wsResetItemsCount = 0;
  const wsPromise = preOpenedWs
    ? new Promise((resolve) => {
        const ws = preOpenedWs;
        let settleTimer = null;
        const finish = () => {
          clearTimeout(timer);
          if (settleTimer) clearTimeout(settleTimer);
          try {
            ws.close();
          } catch {}
          resolve();
        };
        const timer = setTimeout(finish, 10_000);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
            if (msg?.type === 'transcript.reset' && msg?.payload?.agent_id === childAgentId) {
              const nowMs = roundMs(performance.now() - t0);
              const cursor = msg?.payload?.cursor ?? null;
              const itemsCount = Array.isArray(msg?.payload?.snapshot?.items) ? msg.payload.snapshot.items.length : 0;
              wsResetCount += 1;
              if (wsFirstResetMs === null) {
                wsFirstResetMs = nowMs;
                wsFirstResetCursor = cursor;
              }
              wsResetItemsCount = Math.max(wsResetItemsCount, itemsCount);
              const isColdPlaceholder =
                typeof cursor === 'string' && cursor.startsWith('cold:') && itemsCount === 0;
              if (!isColdPlaceholder) {
                wsLiveResetMs = nowMs;
                finish();
              } else if (!settleTimer) {
                // Keep socket open briefly to observe any follow-up authoritative live reset
                settleTimer = setTimeout(() => {
                  wsLiveResetMs = wsLiveResetMs ?? wsFirstResetMs;
                  finish();
                }, 400);
              }
            }
          } catch {}
        });
        ws.on('error', finish);
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
      })
    : Promise.resolve();

  const [httpResults] = await Promise.all([
    Promise.all(endpoints.map((ep) => fetchEndpoint(server.endpoint, server.token, ep))),
    wsPromise,
  ]);
  const fanoutWallMs = roundMs(performance.now() - t0);
  const ioTrace = typeof server.endIoTrace === 'function' ? await server.endIoTrace() : null;
  const postMetrics = await server.metrics(true);

  const transcriptRes = httpResults.find((r) => r.path.includes('/transcript?'));
  const planRes = httpResults.find((r) => r.path.includes('/transcript/plan'));
  const httpTranscriptMs = transcriptRes?.elapsedMs ?? null;
  const firstPaintMs =
    typeof httpTranscriptMs === 'number' && typeof wsFirstResetMs === 'number'
      ? Math.max(httpTranscriptMs, wsFirstResetMs)
      : (httpTranscriptMs ?? wsFirstResetMs ?? fanoutWallMs);
  const controlBarSettleMs = Math.max(...httpResults.map((r) => r.elapsedMs));
  const sanitizedResponses = httpResults.map(({ data: _data, ...rest }) => rest);

  return {
    httpTranscriptMs,
    wsFirstResetMs,
    wsLiveResetMs: wsLiveResetMs ?? wsFirstResetMs,
    wsResetCount,
    wsFirstResetCursor,
    firstPaintMs,
    controlBarSettleMs,
    wsResetItemsCount,
    fanoutWallMs,
    responses: sanitizedResponses,
    transcriptData: transcriptRes?.data ?? null,
    planData: planRes?.data ?? null,
    ioTrace,
    postMetrics,
    wireSize: fs.existsSync(wirePath) ? fs.statSync(wirePath).size : 0,
  };
}

/**
 * Verifies a production-published `replay-checkpoints/engine-v1` document
 * independently against its on-disk `wire.jsonl` (Astra v2.3 §10.1 Lane B).
 */
function verifyProductionCheckpointProof(agentDir) {
  const wirePath = path.join(agentDir, 'wire.jsonl');
  const ckptCandidates = [
    path.join(agentDir, 'replay-checkpoints', 'engine-v1.json'),
    path.join(agentDir, 'replay-checkpoints', 'engine-v1'),
  ];
  const ckptPath = ckptCandidates.find((p) => fs.existsSync(p));
  if (!fs.existsSync(wirePath) || !ckptPath) {
    return { exists: false, proof: null };
  }
  const wireStat = fs.statSync(wirePath);
  const ckptRaw = fs.readFileSync(ckptPath);
  const checkpointHash = createHash('sha256').update(ckptRaw).digest('hex');
  const ckpt = JSON.parse(ckptRaw.toString('utf8'));
  const wireMeta = ckpt?.wire ?? {};
  const coveredByteOffset = Number(wireMeta.size ?? wireMeta.byteLength ?? wireMeta.offset ?? 0);
  const headLen = Math.min(64 * 1024, wireStat.size);
  const tailLen = Math.min(4096, coveredByteOffset);
  const fd = fs.openSync(wirePath, 'r');
  let headSha256 = '';
  let tailSha256 = '';
  let prefixSha256 = '';
  try {
    const headBuf = Buffer.alloc(headLen);
    if (headLen > 0) fs.readSync(fd, headBuf, 0, headLen, 0);
    headSha256 = createHash('sha256').update(headBuf).digest('hex');
    const tailBuf = Buffer.alloc(tailLen);
    if (tailLen > 0) fs.readSync(fd, tailBuf, 0, tailLen, Math.max(0, coveredByteOffset - tailLen));
    tailSha256 = createHash('sha256').update(tailBuf).digest('hex');
    if (wireMeta.prefixSha256 && coveredByteOffset > 0 && coveredByteOffset <= wireStat.size) {
      const prefixBuf = Buffer.alloc(coveredByteOffset);
      fs.readSync(fd, prefixBuf, 0, coveredByteOffset, 0);
      prefixSha256 = createHash('sha256').update(prefixBuf).digest('hex');
    }
  } finally {
    fs.closeSync(fd);
  }
  const genPath = path.join(agentDir, 'wire.jsonl.generation');
  const diskGeneration = fs.existsSync(genPath) ? fs.readFileSync(genPath, 'utf8').trim() : null;
  const storeGeneration = wireMeta.storeGeneration ?? diskGeneration ?? null;
  const generationMatches = !wireMeta.storeGeneration || !diskGeneration || wireMeta.storeGeneration === diskGeneration;
  const headMatches = !wireMeta.headHash || headSha256.startsWith(String(wireMeta.headHash));
  const boundaryMatches = !wireMeta.boundarySha256 || wireMeta.boundarySha256 === tailSha256;
  const prefixMatches = !wireMeta.prefixSha256 || wireMeta.prefixSha256 === prefixSha256;
  const offsetValid = coveredByteOffset > 0 && coveredByteOffset <= wireStat.size;
  return {
    exists: true,
    proof: {
      sourceIdentity: `${wireStat.dev}:${wireStat.ino}`,
      storeGeneration,
      diskGeneration,
      generation: storeGeneration,
      checkpointHash,
      coveredByteOffset,
      headSha256,
      boundarySha256: wireMeta.boundarySha256 ?? tailSha256,
      tailSha256,
      formatVersion: ckpt?.format ?? null,
      verified: Boolean(storeGeneration && checkpointHash && generationMatches && headMatches && boundaryMatches && prefixMatches && offsetValid),
    },
  };
}

/**
 * Runs the P0-1 Cold Child 8-endpoint (including capabilities?metrics_settle=true)
 * + subscribe_v2 fan-out probe against a real kap-server (Astra v2.3 §§9.1, 10.1).
 * Runs `[82.65 MiB]` in smoke and `[20, 60, 82.65, 100 MiB]` in full, plus Lane B reopen
 * and real Playwright GUI child view navigation when `browserHandle` is available.
 */
export async function runP01ColdChildFanoutProbe({
  server,
  corpus,
  WebSocket,
  tier = 'smoke',
  targetBytes = null,
  targetSizesBytes = null,
  stepCount = 200,
  reopenSession = null,
  browserHandle = null,
  progress = () => {},
}) {
  const sizes = Array.isArray(targetSizesBytes) && targetSizesBytes.length > 0
    ? targetSizesBytes
    : typeof targetBytes === 'number' && targetBytes > 0
      ? [targetBytes]
      : tier === 'full'
        ? [...P01_COLD_CHILD_SIZES_BYTES]
        : [P01_COLD_CHILD_SIZES_BYTES[2]];

  const trials = [];
  const productFailures = [];
  const harnessFailures = [];

  for (let si = 0; si < sizes.length; si += 1) {
    const sizeEntry = sizes[si];
    const sizeBytes = typeof sizeEntry === 'object' && sizeEntry !== null ? Number(sizeEntry.targetBytes) : Number(sizeEntry);
    const entryStepCount =
      typeof sizeEntry === 'object' && sizeEntry !== null && Number.isFinite(sizeEntry.stepCount)
        ? Number(sizeEntry.stepCount)
        : stepCount;
    const sessionId = `chaos_p01_${si}_${randomUUID().slice(0, 8)}`;
    const childAgentId = 'sub_cold_p01';
    const seeded = seedColdCheckpointlessChildSession({
      homeDir: corpus.homeDir,
      workspaceId: corpus.workspaceId,
      workspaceDir: corpus.workspaceDir,
      sessionId,
      childAgentId,
      targetBytes: sizeBytes,
      stepCount: entryStepCount,
    });

    progress(
      `P0-1 Legacy Cold Child Probe [${si + 1}/${sizes.length}]: session=${sessionId} child=${childAgentId} wire=${(seeded.wireMeta.bytesWritten / (1024 * 1024)).toFixed(2)} MiB (checkpoints=[], steps=${entryStepCount})`,
    );

    const fanout = await executeColdChildFanout({
      server,
      WebSocket,
      sessionId,
      childAgentId,
      wirePath: seeded.wirePath,
    });
    const independent = verifyLegacyWireIndependently(seeded.wirePath, fanout.planData, fanout.transcriptData);
    const measuredWireReadBytes = fanout.ioTrace?.wireReadBytes ?? 0;
    const measuredParseBytes = fanout.ioTrace?.jsonParseInputBytes ?? 0;
    // STRICT: pure server product ioTrace throughput ONLY — never substitute driver scan speed!
    const measuredScanBytesPerSec =
      fanout.ioTrace && fanout.ioTrace.wireReadBytes > 0 && fanout.ioTrace.wireScanMs > 0
        ? Math.round((fanout.ioTrace.wireReadBytes / fanout.ioTrace.wireScanMs) * 1000)
        : null;

    let browserGuiCheck = null;
    if (browserHandle?.openChildView && si === sizes.length - 1) {
      browserGuiCheck = await browserHandle.openChildView(sessionId, childAgentId);
    }

    const legacyTrial = {
      lane: 'legacy',
      sessionId,
      childAgentId,
      wireBytes: seeded.wireMeta.bytesWritten,
      checkpoints: [],
      preexistingSummaryOrSidecar: false,
      wasColdBeforeOpen: true,
      httpTranscriptMs: fanout.httpTranscriptMs,
      wsFirstResetMs: fanout.wsFirstResetMs,
      wsLiveResetMs: fanout.wsLiveResetMs,
      wsResetCount: fanout.wsResetCount,
      firstPaintMs: fanout.firstPaintMs,
      controlBarSettleMs: fanout.controlBarSettleMs,
      wsResetItemsCount: fanout.wsResetItemsCount,
      fanoutWallMs: fanout.fanoutWallMs,
      responses: fanout.responses,
      rawPassCount: fanout.ioTrace?.rawPassCount ?? 1,
      ioTraceSource: fanout.ioTrace ? 'server_product_trace' : 'missing',
      driverSimulatedScan: false,
      ioOpens: fanout.ioTrace?.opens ?? [],
      aggregateWireReadBytes: measuredWireReadBytes,
      aggregateParseInputBytes: measuredParseBytes,
      legacyScanBytesPerSec: measuredScanBytesPerSec,
      fullReplayMatches: independent.fullReplayMatches,
      fullReplayProof: independent.fullReplayProof,
      browserGuiCheck,
      eldP99Ms: fanout.postMetrics.eldP99Ms,
      eldMaxMs: fanout.postMetrics.eldMaxMs,
    };

    const legacyVerdict = evaluateP01ColdChildGate(legacyTrial);
    trials.push(legacyTrial);
    productFailures.push(...legacyVerdict.productFailures);
    harnessFailures.push(...legacyVerdict.harnessFailures);

    progress(
      `P0-1 Legacy [${(seeded.wireMeta.bytesWritten / (1024 * 1024)).toFixed(2)} MiB]: passed=${legacyVerdict.passed} httpTranscript=${fanout.httpTranscriptMs}ms wsReset=${fanout.wsFirstResetMs}ms controlBar=${fanout.controlBarSettleMs}ms wireRead=${(measuredWireReadBytes / (1024 * 1024)).toFixed(2)}MiB jsonParse=${(measuredParseBytes / 1024).toFixed(1)}KiB scanGBs=${measuredScanBytesPerSec ? (measuredScanBytesPerSec / 1e9).toFixed(2) : 'null'} eldMax=${fanout.postMetrics.eldMaxMs}ms`,
    );
  }

  const reopenTargets = Array.isArray(reopenSession)
    ? reopenSession.filter((r) => r && r.sessionId && r.childAgentId && r.agentDir)
    : reopenSession && reopenSession.sessionId && reopenSession.childAgentId && reopenSession.agentDir
      ? [reopenSession]
      : [];

  for (const target of reopenTargets) {
    if (typeof server.closeSession === 'function') {
      await server.closeSession(target.sessionId);
    }
    const ckptCheck = verifyProductionCheckpointProof(target.agentDir);
    const reopenFanout = await executeColdChildFanout({
      server,
      WebSocket,
      sessionId: target.sessionId,
      childAgentId: target.childAgentId,
      wirePath: path.join(target.agentDir, 'wire.jsonl'),
    });
    const reopenTrial = {
      lane: 'reopen',
      sessionId: target.sessionId,
      childAgentId: target.childAgentId,
      wireBytes: reopenFanout.wireSize,
      wasColdBeforeOpen: true,
      productionCheckpointPublished: ckptCheck.exists,
      fixtureBuiltCheckpoint: false,
      firstReaderBuiltCheckpoint: false,
      httpTranscriptMs: reopenFanout.httpTranscriptMs,
      wsFirstResetMs: reopenFanout.wsFirstResetMs,
      wsLiveResetMs: reopenFanout.wsLiveResetMs,
      wsResetCount: reopenFanout.wsResetCount,
      firstPaintMs: reopenFanout.firstPaintMs,
      controlBarSettleMs: reopenFanout.controlBarSettleMs,
      wsResetItemsCount: reopenFanout.wsResetItemsCount,
      fanoutWallMs: reopenFanout.fanoutWallMs,
      responses: reopenFanout.responses,
      ioTraceSource: reopenFanout.ioTrace ? 'server_product_trace' : 'missing',
      driverSimulatedScan: false,
      aggregateWireReadBytes: reopenFanout.ioTrace?.wireReadBytes ?? 0,
      aggregateParseInputBytes: reopenFanout.ioTrace?.jsonParseInputBytes ?? 0,
      summaryProof: ckptCheck.proof,
      eldP99Ms: reopenFanout.postMetrics.eldP99Ms,
      eldMaxMs: reopenFanout.postMetrics.eldMaxMs,
    };
    const reopenVerdict = evaluateP01ColdChildGate(reopenTrial);
    trials.push(reopenTrial);
    productFailures.push(...reopenVerdict.productFailures);
    harnessFailures.push(...reopenVerdict.harnessFailures);

    progress(
      `P0-1 Reopen [${target.childAgentId}]: passed=${reopenVerdict.passed} httpTranscript=${reopenFanout.httpTranscriptMs}ms wsReset=${reopenFanout.wsFirstResetMs}ms wsLiveReset=${reopenFanout.wsLiveResetMs}ms ckptPublished=${ckptCheck.exists} wireRead=${((reopenFanout.ioTrace?.wireReadBytes ?? 0) / 1024).toFixed(1)}KiB`,
    );
  }

  const passed = productFailures.length === 0 && harnessFailures.length === 0;
  return {
    passed,
    exitCode: harnessFailures.length > 0 ? 2 : productFailures.length > 0 ? 1 : 0,
    productFailures,
    harnessFailures,
    trial: trials[0] ?? null,
    trials,
  };
}
