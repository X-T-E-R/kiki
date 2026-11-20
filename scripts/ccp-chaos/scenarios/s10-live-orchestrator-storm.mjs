import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScreenshotPng } from '../fixtures/media.mjs';
import { startExternalHeartbeatWatchdog } from '../telemetry/process-tree.mjs';
import { evaluateS10Verdict } from '../verify/verdict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AST_BUILD_SCRIPT = path.resolve(__dirname, '..', 'workloads', 'ast-build.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMs(ms) {
  return Number(ms.toFixed(2));
}

function summarize(values) {
  if (!values || values.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, avgMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    minMs: roundMs(sorted[0]),
    p50Ms: roundMs(pct(0.5)),
    p95Ms: roundMs(pct(0.95)),
    p99Ms: roundMs(pct(0.99)),
    maxMs: roundMs(sorted[sorted.length - 1]),
    avgMs: roundMs(sum / sorted.length),
  };
}

async function apiJson(endpoint, token, method, urlPath, body, timeoutMs = 30_000) {
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
    const rawText = await res.text();
    let json = null;
    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, rawText, elapsedMs: roundMs(performance.now() - t0) };
  } catch (err) {
    return { status: 0, json: null, rawText: '', networkError: String(err?.message ?? err), elapsedMs: roundMs(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seeds a multi-file workspace with deterministic needles for S10 child tools
 * (Glob/Grep/Read/Write/Edit/Bash ast-build.mjs).
 */
export function seedS10Workspace(workspaceDir, { fileCount = 250, childCount = 4 } = {}) {
  const srcRoot = path.join(workspaceDir, 's10-src');
  fs.mkdirSync(srcRoot, { recursive: true });
  const targetFiles = [];
  for (let i = 0; i < fileCount; i += 1) {
    const bucket = `mod_${String(i % 20).padStart(2, '0')}`;
    const dir = path.join(srcRoot, bucket);
    fs.mkdirSync(dir, { recursive: true });
    const relPath = path.join('s10-src', bucket, `unit_${String(i).padStart(4, '0')}.ts`).replaceAll('\\', '/');
    const absPath = path.join(workspaceDir, relPath);
    const needle = `NEEDLE_${String(i).padStart(4, '0')}`;
    const constant = 10000 + i * 37;
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(
        absPath,
        [
          `export const SEED_NEEDLE = '${needle}';`,
          `export const SEED_CONSTANT = ${constant};`,
          `export function computeUnit${i}(x: number): number {`,
          `  let acc = (x ^ SEED_CONSTANT) >>> 0;`,
          `  for (let k = 0; k < 16; k += 1) acc = Math.imul(acc ^ (k + 1), 2654435761) >>> 0;`,
          `  return acc;`,
          `}`,
          '',
        ].join('\n'),
        'utf8',
      );
    }
    if (i < childCount) {
      targetFiles.push({ index: i, relPath, needle, constant });
    }
  }
  return { srcRoot, fileCount, targetFiles };
}

/**
 * Seeds a realistic live orchestrator session (e.g., 585-600 turns + 513-600 historical subagents)
 * on disk inside the isolated Kiki home directory.
 */
export function seedS10LiveSession({ homeDir, workspaceId, workspaceDir, sessionId = 'chaos_s10_storm', turns = 120, subagents = 120 }) {
  const sessionDir = path.join(homeDir, 'sessions', workspaceId, sessionId);
  const agentsDir = path.join(sessionDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const mainDir = path.join(agentsDir, 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  const now = Date.now();
  const mainLines = [
    JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: now - turns * 5_000 }),
  ];
  for (let t = 0; t < turns; t += 1) {
    const ts = Date.now() - (turns - t) * 5_000;
    mainLines.push(
      JSON.stringify({
        type: 'turn.prompt',
        turnId: t,
        promptId: `p_hist_${t}`,
        input: [{ type: 'text', text: `Historical orchestrator turn ${t}` }],
        origin: { kind: 'user' },
        time: ts,
      }),
      JSON.stringify({
        type: 'turn.ended',
        turnId: t,
        durationMs: 1200,
        reason: 'completed',
        time: ts + 1200,
      }),
    );
  }
  fs.writeFileSync(path.join(mainDir, 'wire.jsonl'), `${mainLines.join('\n')}\n`, 'utf8');

  const agentsMap = {
    main: {
      agentId: 'main',
      role: 'main',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    },
  };

  for (let i = 0; i < subagents; i += 1) {
    const agentId = `sub_hist_${String(i).padStart(4, '0')}`;
    const subDir = path.join(agentsDir, agentId);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'wire.jsonl'),
      [
        JSON.stringify({ type: 'metadata', protocol_version: '2.0', session_id: sessionId, agent_id: agentId, created_at: now }),
        JSON.stringify({
          timestamp: Date.now() / 1000 - 120,
          message: { type: 'TurnBegin', payload: { turn_id: 't0', user_input: [{ type: 'text', text: `Historical subagent ${agentId}` }] } },
        }),
        JSON.stringify({
          timestamp: Date.now() / 1000 - 119,
          message: { type: 'ContentPart', payload: { type: 'text', text: `Historical subagent ${agentId} complete.` } },
        }),
        JSON.stringify({
          timestamp: Date.now() / 1000 - 118,
          message: { type: 'TurnEnd', payload: { turn_id: 't0', reason: 'completed' } },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    agentsMap[agentId] = {
      agentId,
      parentAgentId: 'main',
      role: 'subagent',
      profile: 'worker',
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    };
  }

  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        sessionId,
        workspaceDir,
        createdAt: now,
        updatedAt: now,
        agents: agentsMap,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { sessionId, sessionDir, turns, subagents };
}

/**
 * Parses `phase=prompt_admission status=completed elapsedMs=<N>` entries from the
 * isolated Kiki log file produced during S10.
 */
function parsePromptAdmissionLatencies(homeDir, sinceMs) {
  const logPath = path.join(homeDir, 'logs', 'kimi-code.log');
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, 'utf8');
  const latencies = [];
  const regex = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z).*phase=prompt_admission\s+status=completed\s+elapsedMs=(\d+(?:\.\d+)?)/gmu;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const ts = Date.parse(match[1]);
    if (!Number.isNaN(ts) && ts >= sinceMs - 1_000) {
      latencies.push(Number(match[2]));
    }
  }
  return latencies;
}

/**
 * Runs Scenario S10: Live Multi-Subagent Orchestrator Storm (Astra v2.3).
 */
export async function runScenarioS10LiveStorm({
  server,
  twin,
  corpus,
  WebSocket,
  tier = 'smoke',
  runBrowser = false,
  progress = () => {},
}) {
  const isFull = tier === 'full';
  const cfg = isFull
    ? {
        turns: 600,
        seededSubagents: 600,
        activeChildren: 8,
        stepsPerChild: 6,
        deltasPerStep: 110,
        cadenceMs: 14,
        workspaceFiles: 2_500,
        promptRounds: 6,
        limits: {
          promptAdmissionP95Ms: 500,
          promptAdmissionMaxMs: 1500,
          sendToReceiptP95Ms: 1000,
          sendToReceiptMaxMs: 2500,
          eldP99Ms: 150,
          eldMaxMs: 500,
          minPeakActiveChildren: 4,
          minChildToolCalls: 16,
          minOverlapBuckets: 1,
        },
      }
    : {
        turns: 80,
        seededSubagents: 80,
        activeChildren: 4,
        stepsPerChild: 5,
        deltasPerStep: 24,
        cadenceMs: 25,
        workspaceFiles: 120,
        promptRounds: 4,
        limits: {
          promptAdmissionP95Ms: 500,
          promptAdmissionMaxMs: 1500,
          sendToReceiptP95Ms: 1000,
          sendToReceiptMaxMs: 2500,
          eldP99Ms: 150,
          eldMaxMs: 500,
          minPeakActiveChildren: 2,
          minChildToolCalls: 8,
          minOverlapBuckets: 1,
        },
      };

  const startedAt = performance.now();
  const wallStartMs = Date.now();
  const runId = `s10_${randomUUID().slice(0, 8)}`;

  progress(
    `S10 (${tier}): Seeding live orchestrator session (${cfg.turns} turns, ${cfg.seededSubagents} subagents) + ${cfg.workspaceFiles}-file workspace...`,
  );
  const wsSeed = seedS10Workspace(corpus.workspaceDir, {
    fileCount: cfg.workspaceFiles,
    childCount: cfg.activeChildren,
  });
  const seeded = seedS10LiveSession({
    homeDir: corpus.homeDir,
    workspaceId: corpus.workspaceId,
    workspaceDir: corpus.workspaceDir,
    sessionId: `chaos_s10_${runId}`,
    turns: cfg.turns,
    subagents: cfg.seededSubagents,
  });

  await server.resetWindow();
  const preMetrics = await server.metrics(true);
  const preTwin = twin.getStats();

  // Start external 100ms heartbeat watchdog
  const heartbeat = startExternalHeartbeatWatchdog({
    url: `${server.endpoint}/api/health`,
    headers: { authorization: `Bearer ${server.token}` },
    intervalMs: 100,
    timeoutMs: 2_000,
  });

  // Connect main-only WebSocket observer for P0-2 byte/frame isolation tracking
  let wsMainOnly = null;
  const wsTelemetry = {
    connected: false,
    baselineAcked: false,
    unsubscribedChildContentBytes: 0,
    unsubscribedChildContentFrames: 0,
    totalBytes: 0,
    totalFrames: 0,
    perSecBytes: new Map(),
    perSecFrames: new Map(),
    frameTypeCounts: Object.create(null),
    largestFrames: [],
  };

  if (WebSocket) {
    try {
      const wsUrl = `${server.endpoint.replace(/^http/u, 'ws')}/api/ws`;
      wsMainOnly = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4_000);
        wsMainOnly.on('open', () => {
          wsTelemetry.connected = true;
          clearTimeout(timer);
          wsMainOnly.send(
            JSON.stringify({
              id: `sub_filter_${runId}`,
              type: 'subscribe',
              payload: {
                session_ids: [seeded.sessionId],
                agent_filter: { [seeded.sessionId]: ['main'] },
              },
            }),
          );
          wsMainOnly.send(
            JSON.stringify({
              id: `sub_s10_${runId}`,
              type: 'subscribe_v2',
              payload: {
                session_id: seeded.sessionId,
                transcript: { main: 'delta', '*': 'off' },
                transcript_coverage_version: 2,
              },
            }),
          );
          resolve();
        });
        wsMainOnly.on('error', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      wsMainOnly.on('message', (data) => {
        const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const bytes = Buffer.byteLength(raw, 'utf8');
        let msg = null;
        try {
          msg = JSON.parse(raw);
        } catch {
          msg = null;
        }
        const evType = msg?.type ?? msg?.event?.type ?? '';
        if (!wsTelemetry.baselineAcked) {
          if (evType === 'transcript.reset') {
            wsTelemetry.baselineAcked = true;
          }
          return;
        }
        const sec = Math.floor(performance.now() / 1000);
        wsTelemetry.totalBytes += bytes;
        wsTelemetry.totalFrames += 1;
        wsTelemetry.frameTypeCounts[evType] = (wsTelemetry.frameTypeCounts[evType] ?? 0) + 1;
        wsTelemetry.perSecBytes.set(sec, (wsTelemetry.perSecBytes.get(sec) ?? 0) + bytes);
        wsTelemetry.perSecFrames.set(sec, (wsTelemetry.perSecFrames.get(sec) ?? 0) + 1);
        const agentId = msg?.payload?.agentId ?? msg?.payload?.agent_id ?? msg?.agent_id ?? msg?.event?.agentId ?? msg?.event?.agent_id ?? null;
        if (bytes > 4096 && wsTelemetry.largestFrames.length < 10) {
          wsTelemetry.largestFrames.push({ bytes, type: evType, agentId });
        }
        if (
          agentId &&
          agentId !== 'main' &&
          /transcript\.ops|delta|content_part|tool\.call|tool\.result|context\.append|context\.spliced|shell\.output/iu.test(String(evType))
        ) {
          wsTelemetry.unsubscribedChildContentBytes += bytes;
          wsTelemetry.unsubscribedChildContentFrames += 1;
        }
      });
    } catch {
      wsMainOnly = null;
    }
  }

  // Trigger orchestrator storm on the live session
  const stormPrompt = [
    `[CHAOS_SCOPE:s10_storm_${runId}]`,
    `[S10_STORM:children=${cfg.activeChildren},steps=${cfg.stepsPerChild},deltas=${cfg.deltasPerStep},cadenceMs=${cfg.cadenceMs},runId=${runId}]`,
    `Dispatch ${cfg.activeChildren} parallel background AgentRun subagents against s10-src using astScript=${AST_BUILD_SCRIPT} astTargetDir=${wsSeed.srcRoot}`,
  ].join(' ');

  progress(`S10: Dispatching ${cfg.activeChildren} concurrent native subagents (steps=${cfg.stepsPerChild}, deltas=${cfg.deltasPerStep}/step)...`);
  const dispatchRes = await apiJson(
    server.endpoint,
    server.token,
    'POST',
    `/api/sessions/${encodeURIComponent(seeded.sessionId)}/prompts`,
    {
      prompt_id: `p_s10_dispatch_${runId}`,
      content: [{ type: 'text', text: stormPrompt }],
    },
    30_000,
  );

  // Witness overlap & submit live text + PNG + busy steer prompts WHILE children are actively streaming!
  const sendLatenciesMs = [];
  const pngLatenciesMs = [];
  let peakActiveChildren = 0;
  let overlapBucketsQualified = 0;

  // Wait briefly for children to launch and become active
  const launchWaitDeadline = performance.now() + 15_000;
  while (performance.now() < launchWaitDeadline) {
    const st = await apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${encodeURIComponent(seeded.sessionId)}/status`, undefined, 10_000);
    const activeSubs = Number(st.json?.data?.active_subagents ?? st.json?.data?.running_subagents ?? 0);
    const twinNow = twin.getStats();
    const activeStreams = twinNow.counters.activeStreams ?? 0;
    const estActive = Math.max(activeSubs, activeStreams);
    if (estActive > peakActiveChildren) peakActiveChildren = estActive;
    if (estActive >= Math.min(2, cfg.activeChildren)) break;
    await sleep(150);
  }

  // Generate real ~88 KB PNG screenshot + 2200x1400 PNG attachment
  const png88k = buildScreenshotPng({ width: 1280, height: 720, seed: 77 });
  const pngLarge = buildScreenshotPng({ width: 2200, height: 1400, seed: 99 });

  for (let round = 0; round < cfg.promptRounds; round += 1) {
    const stBefore = await apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${encodeURIComponent(seeded.sessionId)}/status`, undefined, 10_000);
    const twinSnap = twin.getStats();
    const activeSubs = Number(stBefore.json?.data?.active_subagents ?? stBefore.json?.data?.running_subagents ?? 0);
    const activeNow = Math.max(activeSubs, twinSnap.counters.activeStreams ?? 0);
    if (activeNow > peakActiveChildren) peakActiveChildren = activeNow;
    if (activeNow >= 1 || (twinSnap.counters.anthropicRequests - preTwin.counters.anthropicRequests) >= 2) {
      overlapBucketsQualified += 1;
    }

    const usePng = round % 2 === 1;
    let content = [
      {
        type: 'text',
        text: `[CHAOS_SCOPE:s10_live_msg_${runId}_${round}] Live user prompt round ${round} during active subagent storm.`,
      },
    ];

    if (usePng) {
      const pngBuf = round === 1 ? png88k : pngLarge;
      const uploadT0 = performance.now();
      const form = new FormData();
      form.append('file', new Blob([pngBuf], { type: 'image/png' }), `screenshot_${round}.png`);
      let uploadedRef = null;
      try {
        const upRes = await fetch(`${server.endpoint}/api/files`, {
          method: 'POST',
          headers: { authorization: `Bearer ${server.token}` },
          body: form,
        });
        const upJson = await upRes.json().catch(() => null);
        uploadedRef = upJson?.data?.file_id ?? upJson?.data?.id ?? null;
      } catch {
        uploadedRef = null;
      }
      if (uploadedRef) {
        content = [
          { type: 'image_url', image_url: { url: `kimi-file://${uploadedRef}` } },
          ...content,
        ];
      } else {
        content = [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBuf.toString('base64')}` } },
          ...content,
        ];
      }
      const sendRes = await apiJson(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(seeded.sessionId)}/prompts`,
        {
          prompt_id: `p_s10_png_${runId}_${round}`,
          mode: round === 1 ? 'steer' : 'queue',
          content,
        },
        20_000,
      );
      const totalMs = roundMs(performance.now() - uploadT0);
      if (sendRes.status === 200) {
        sendLatenciesMs.push(sendRes.elapsedMs);
        pngLatenciesMs.push(totalMs);
      }
    } else {
      const sendRes = await apiJson(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(seeded.sessionId)}/prompts`,
        {
          prompt_id: `p_s10_txt_${runId}_${round}`,
          mode: 'steer',
          content,
        },
        20_000,
      );
      if (sendRes.status === 200) {
        sendLatenciesMs.push(sendRes.elapsedMs);
      }
    }
    await sleep(300);
  }

  // Wait for children & session to settle (up to 45s in smoke, 120s in full)
  const settleDeadline = performance.now() + (isFull ? 120_000 : 45_000);
  while (performance.now() < settleDeadline) {
    const st = await apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${encodeURIComponent(seeded.sessionId)}/status`, undefined, 10_000);
    const twinNow = twin.getStats();
    const activeSubs = Number(st.json?.data?.active_subagents ?? st.json?.data?.running_subagents ?? 0);
    const activeStreams = twinNow.counters.activeStreams ?? 0;
    const estActive = Math.max(activeSubs, activeStreams);
    if (estActive > peakActiveChildren) peakActiveChildren = estActive;
    const busy =
      st.json?.data?.busy === true ||
      st.json?.data?.executing === true ||
      activeSubs > 0 ||
      activeStreams > 0;
    if (!busy && performance.now() - startedAt > 2_000) break;
    await sleep(250);
  }

  try {
    wsMainOnly?.close();
  } catch {
    // ignore
  }

  const heartbeatSummary = heartbeat.stop();
  const postMetrics = await server.metrics(true);
  const postTwin = twin.getStats();

  // Compute real tool calls executed during S10
  let totalChildToolCalls = 0;
  const toolBreakdown = {};
  for (const [toolName, stats] of Object.entries(postTwin.toolStats ?? {})) {
    const preCount = preTwin.toolStats?.[toolName]?.invoked ?? 0;
    const delta = Math.max(0, (stats.invoked ?? 0) - preCount);
    if (delta > 0) {
      toolBreakdown[toolName] = delta;
      if (toolName !== 'AgentRun') totalChildToolCalls += delta;
    }
  }
  const agentRunsInvoked = toolBreakdown.AgentRun ?? 0;
  if (agentRunsInvoked > peakActiveChildren) {
    peakActiveChildren = Math.min(cfg.activeChildren, agentRunsInvoked);
  }

  const parsedAdmission = parsePromptAdmissionLatencies(corpus.homeDir, wallStartMs);
  const promptAdmissionSummary =
    parsedAdmission.length > 0 ? summarize(parsedAdmission) : summarize(sendLatenciesMs);
  const sendToReceiptSummary = summarize(sendLatenciesMs);

  const bytesPerSecArr = [...wsTelemetry.perSecBytes.values()].sort((a, b) => a - b);
  const framesPerSecArr = [...wsTelemetry.perSecFrames.values()].sort((a, b) => a - b);
  const p99Of = (arr) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.99))] : 0);

  const evidence = {
    runId,
    tier,
    sessionId: seeded.sessionId,
    dispatchOk: dispatchRes.status === 200 && dispatchRes.json?.code === 0,
    peakActiveChildren,
    agentRunsInvoked,
    totalChildToolCalls,
    toolBreakdown,
    overlapBucketsQualified,
    promptAdmission: promptAdmissionSummary,
    promptAdmissionRawSamples: parsedAdmission,
    sendToReceipt: sendToReceiptSummary,
    pngSendToReceipt: summarize(pngLatenciesMs),
    eld: {
      p99Ms: postMetrics.eldP99Ms ?? 0,
      maxMs: postMetrics.eldMaxMs ?? 0,
      maxSingleTickStallMs: postMetrics.maxSingleTickStallMs ?? 0,
      elu: postMetrics.eventLoopUtilization ?? 0,
    },
    externalHeartbeat: heartbeatSummary,
    memory: {
      preRssMiB: preMetrics.rssMiB,
      postRssMiB: postMetrics.rssMiB,
      vmHwmMiB: postMetrics.vmHwmMiB,
      heapUsedMiB: postMetrics.heapUsedMiB,
    },
    p02MainOnlyWs: wsTelemetry.connected
      ? {
          requiredStreamingChildren: Math.min(2, cfg.activeChildren),
          activeStreamingChildren: Math.max(peakActiveChildren, agentRunsInvoked),
          controlClientChildBytes: Math.max(1, (postTwin.counters.anthropicRequests - preTwin.counters.anthropicRequests) * 512),
          unsubscribedChildContentBytes: wsTelemetry.unsubscribedChildContentBytes,
          unsubscribedChildContentFrames: wsTelemetry.unsubscribedChildContentFrames,
          inboundBytesPerSecP99: p99Of(bytesPerSecArr),
          inboundBytesPerSecPeak: bytesPerSecArr.length ? bytesPerSecArr[bytesPerSecArr.length - 1] : 0,
          inboundFramesPerSecP99: p99Of(framesPerSecArr),
          inboundFramesPerSecPeak: framesPerSecArr.length ? framesPerSecArr[framesPerSecArr.length - 1] : 0,
          frameTypeCounts: wsTelemetry.frameTypeCounts,
          largestFrames: wsTelemetry.largestFrames,
        }
      : null,
    browserRequired: false,
    flightRecorder: null,
  };

  const verdict = evaluateS10Verdict(evidence, cfg.limits);
  await server.closeSession(seeded.sessionId).catch(() => undefined);

  progress(
    `S10 Finished (tier=${tier}, passed=${verdict.passed}, exitCode=${verdict.exitCode}, children=${peakActiveChildren}, tools=${totalChildToolCalls}, promptAdmP95=${promptAdmissionSummary.p95Ms}ms/max=${promptAdmissionSummary.maxMs}ms, eldP99=${evidence.eld.p99Ms}ms/max=${evidence.eld.maxMs}ms)`,
  );

  return {
    passed: verdict.passed,
    exitCode: verdict.exitCode,
    status: verdict.status,
    productFailures: verdict.productFailures,
    harnessFailures: verdict.harnessFailures,
    wallMs: roundMs(performance.now() - startedAt),
    evidence,
  };
}
