import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScreenshotPng } from '../fixtures/media.mjs';
import { startExternalHeartbeatWatchdog } from '../telemetry/process-tree.mjs';
import { evaluateS10Verdict } from '../verify/verdict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
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

async function openWs(WebSocket, endpoint, token) {
  const wsUrl = `${endpoint.replace(/^http/u, 'ws')}/api/ws`;
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), 5_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return ws;
}

/**
 * Launches a real headless Playwright Chromium instance pointed at the live server
 * while S10 children are streaming to witness FlightRecorder (CLS, rawLayoutShift,
 * transcriptRootRemounts, consoleErrors, composer typing latency).
 */
async function startLiveBrowserFlightRecorder({ server, sessionId }) {
  try {
    const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
    const { chromium } = kapRequire('playwright');
    if (!chromium) return null;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.addInitScript(({ token, sid }) => {
      try {
        localStorage.setItem('kiki_auth_token', token);
        localStorage.setItem('kiki_last_session_id', sid);
      } catch {}
      window.__KIKI_S10_FLIGHT__ = {
        cls: 0,
        rawLayoutShift: 0,
        sampleCount: 0,
        transcriptRootRemounts: 0,
        typingLatenciesMs: [],
      };
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const val = Number(entry.value || 0);
            window.__KIKI_S10_FLIGHT__.rawLayoutShift += val;
            if (!entry.hadRecentInput) window.__KIKI_S10_FLIGHT__.cls += val;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
      const tick = () => {
        window.__KIKI_S10_FLIGHT__.sampleCount += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { token: server.token, sid: sessionId });

    const guiDistDir = path.join(REPO_ROOT, 'apps', 'kiki-gui', 'dist');
    const hasGuiDist = fs.existsSync(path.join(guiDistDir, 'index.html'));
    const mimeByExt = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.json': 'application/json; charset=utf-8',
      '.woff2': 'font/woff2',
    };
    const staticServer = createHttpServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      if (urlPath === '/__kiki/local-server') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (!hasGuiDist) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><div id="transcript-root"></div><textarea id="composer"></textarea></body></html>');
        return;
      }
      let file = path.normalize(path.join(guiDistDir, urlPath));
      if (!file.startsWith(guiDistDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(guiDistDir, 'index.html');
      }
      res.writeHead(200, { 'content-type': mimeByExt[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
    const webUrl = `http://127.0.0.1:${staticServer.address().port}`;
    const targetUrl = `${webUrl}/s/${encodeURIComponent(sessionId)}?server=${encodeURIComponent(server.endpoint)}&token=${encodeURIComponent(server.token)}`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(400);

    return {
      browser,
      page,
      async sampleAndType(text) {
        await page.evaluate(async (sample) => {
          const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
          if (!input || !('value' in input)) return;
          input.focus();
          const burst = sample.slice(0, 12);
          let acc = '';
          for (const ch of burst) {
            const t0 = performance.now();
            acc += ch;
            input.value = acc;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((r) => requestAnimationFrame(() => r()));
            const dt = Number((performance.now() - t0).toFixed(2));
            if (window.__KIKI_S10_FLIGHT__) window.__KIKI_S10_FLIGHT__.typingLatenciesMs.push(dt);
          }
        }, text).catch(() => undefined);
      },
      async closeAndCollect() {
        const snap = await page
          .evaluate(() => window.__KIKI_S10_FLIGHT__ ?? null)
          .catch(() => null);
        await browser.close().catch(() => undefined);
        await new Promise((resolve) => staticServer.close(() => resolve()));
        return {
          sampleCount: snap?.sampleCount ?? 0,
          cls: Number((snap?.cls ?? 0).toFixed(5)),
          rawLayoutShift: Number((snap?.rawLayoutShift ?? 0).toFixed(5)),
          transcriptRootRemounts: snap?.transcriptRootRemounts ?? 0,
          consoleErrors: consoleErrors.length,
          consoleErrorSamples: consoleErrors.slice(0, 5),
          composerTyping: summarize(snap?.typingLatenciesMs ?? []),
        };
      },
    };
  } catch {
    return null;
  }
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
        activeChildren: 12,
        stepsPerChild: 6,
        deltasPerStep: 110,
        cadenceMs: 14,
        workspaceFiles: 2_500,
        promptRounds: 6,
        limits: {
          promptAdmissionTextP95Ms: 250,
          promptAdmissionTextP99Ms: 750,
          promptAdmissionPngP95Ms: 500,
          promptAdmissionPngP99Ms: 1500,
          promptAdmissionP95Ms: 500,
          promptAdmissionMaxMs: 1500,
          sendToReceiptP95Ms: 750,
          sendToReceiptMaxMs: 2000,
          eldP99Ms: 50,
          eldMaxMs: 250,
          minPeakActiveChildren: 4,
          minChildToolCalls: 24,
          minOverlapBuckets: 1,
        },
      }
    : {
        turns: 80,
        seededSubagents: 80,
        activeChildren: 4,
        stepsPerChild: 5,
        deltasPerStep: 36,
        cadenceMs: 20,
        workspaceFiles: 120,
        promptRounds: 4,
        limits: {
          promptAdmissionTextP95Ms: 250,
          promptAdmissionTextP99Ms: 750,
          promptAdmissionPngP95Ms: 500,
          promptAdmissionPngP99Ms: 1500,
          promptAdmissionP95Ms: 500,
          promptAdmissionMaxMs: 1500,
          sendToReceiptP95Ms: 750,
          sendToReceiptMaxMs: 2000,
          eldP99Ms: 50,
          eldMaxMs: 250,
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

  const preMetrics = await server.metrics(true);
  const preTwin = twin.getStats();

  // Connect BOTH (1) main-only WS observer and (2) positive-control child-delta WS observer
  let wsMainOnly = null;
  let wsControlChild = null;
  const durablePromptReceipts = new Map();
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
  const controlTelemetry = {
    connected: false,
    childDeltaBytes: 0,
    childDeltaFrames: 0,
    childActivityBySec: new Map(),
    childDeltaEvents: [],
    completedChildIds: new Set(),
  };

  if (WebSocket) {
    try {
      wsMainOnly = await openWs(WebSocket, server.endpoint, server.token);
      wsTelemetry.connected = true;
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
        // Track durable prompt receipts for send-to-receipt attribution
        if (evType === 'transcript.ops' && Array.isArray(msg?.payload?.ops)) {
          for (const op of msg.payload.ops) {
            const pid = op?.prompt?.promptId ?? op?.turn?.promptId;
            if (typeof pid === 'string' && !durablePromptReceipts.has(pid)) {
              durablePromptReceipts.set(pid, performance.now());
            }
          }
        }
        if (evType === 'prompt.submitted' || evType === 'prompt.queued' || evType === 'prompt.enqueued') {
          const pid = msg?.payload?.promptId ?? msg?.payload?.prompt_id;
          if (typeof pid === 'string' && !durablePromptReceipts.has(pid)) {
            durablePromptReceipts.set(pid, performance.now());
          }
        }

        if (!wsTelemetry.baselineAcked) {
          if (evType === 'transcript.reset') wsTelemetry.baselineAcked = true;
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

      wsControlChild = await openWs(WebSocket, server.endpoint, server.token);
      controlTelemetry.connected = true;
      wsControlChild.send(
        JSON.stringify({
          id: `sub_ctrl_${runId}`,
          type: 'subscribe_v2',
          payload: {
            session_id: seeded.sessionId,
            transcript: { '*': 'delta' },
            transcript_coverage_version: 2,
          },
        }),
      );
      wsControlChild.on('message', (data) => {
        const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const bytes = Buffer.byteLength(raw, 'utf8');
        let msg = null;
        try {
          msg = JSON.parse(raw);
        } catch {
          msg = null;
        }
        const evType = msg?.type ?? '';
        const agentId = msg?.payload?.agent_id ?? msg?.payload?.agentId ?? null;
        if (agentId && agentId !== 'main') {
          const nowMs = performance.now();
          if (evType === 'transcript.ops') {
            const opCount = Array.isArray(msg?.payload?.ops) ? msg.payload.ops.length : 1;
            controlTelemetry.childDeltaBytes += bytes;
            controlTelemetry.childDeltaFrames += opCount;
            controlTelemetry.childDeltaEvents.push({ tsMs: nowMs, childId: agentId, deltas: opCount, bytes });
            const sec = Math.floor(nowMs / 1000);
            if (!controlTelemetry.childActivityBySec.has(sec)) controlTelemetry.childActivityBySec.set(sec, new Set());
            controlTelemetry.childActivityBySec.get(sec).add(agentId);
            if (Array.isArray(msg?.payload?.ops) && msg.payload.ops.some((op) => op?.op === 'turn.end')) {
              controlTelemetry.completedChildIds.add(agentId);
            }
          } else if (evType === 'subagent.completed') {
            controlTelemetry.completedChildIds.add(agentId);
          }
        }
      });
    } catch {
      wsMainOnly = null;
      wsControlChild = null;
    }
  }

  let browserDriver = null;
  if (runBrowser) {
    browserDriver = await startLiveBrowserFlightRecorder({ server, sessionId: seeded.sessionId });
  }

  await server.resetWindow();
  const heartbeat = startExternalHeartbeatWatchdog({
    url: `${server.endpoint}/api/health`,
    headers: { authorization: `Bearer ${server.token}` },
    intervalMs: 100,
    timeoutMs: 2_000,
  });

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

  // Sample true concurrent active native children inside kap-server PID every 250ms
  let peakActiveChildren = 0;
  let activeMonitorStopped = false;
  const concurrencySamples = [];
  const activeMonitor = (async () => {
    while (!activeMonitorStopped) {
      let liveActive = 0;
      if (typeof server.inspectLiveAgents === 'function') {
        const snap = await server.inspectLiveAgents(seeded.sessionId).catch(() => null);
        liveActive = Number(snap?.activeChildCount ?? 0);
      }
      const twinStreams = twin.getStats().counters.activeStreams ?? 0;
      const concurrent = Math.max(liveActive, twinStreams);
      if (concurrent > peakActiveChildren) peakActiveChildren = concurrent;
      concurrencySamples.push({ tsMs: performance.now(), liveActive, twinStreams, concurrent });
      await sleep(250);
    }
  })();

  // Wait briefly for real concurrent children to become active before starting user sends
  const launchWaitDeadline = performance.now() + 15_000;
  while (performance.now() < launchWaitDeadline) {
    if (peakActiveChildren >= Math.min(2, cfg.activeChildren)) break;
    await sleep(120);
  }

  // Run concurrent background search + usage planes while user sends overlap active children
  let backgroundQueriesCompleted = 0;
  const runBgProbe = async (idx) => {
    const [sRes, uRes] = await Promise.all([
      apiJson(
        server.endpoint,
        server.token,
        'POST',
        '/api/search',
        { query: `Historical orchestrator turn ${idx}`, limit: 10 },
        8_000,
      ),
      apiJson(
        server.endpoint,
        server.token,
        'GET',
        `/api/usage/sessions/${encodeURIComponent(seeded.sessionId)}/accounting`,
        undefined,
        8_000,
      ),
    ]);
    if (sRes.status === 200 || uRes.status === 200) backgroundQueriesCompleted += 1;
  };

  const textSendLatenciesMs = [];
  const pngSendLatenciesMs = [];
  const allSendLatenciesMs = [];
  const uploadErrors = [];
  let overlapBucketsQualified = 0;

  const png88k = buildScreenshotPng({ width: 1280, height: 720, seed: 77 });
  const pngLarge = buildScreenshotPng({ width: 2200, height: 1400, seed: 99 });

  const waitDurableReceipt = async (promptId, sendT0, fallbackElapsedMs) => {
    const deadline = performance.now() + 2_000;
    while (performance.now() < deadline) {
      if (durablePromptReceipts.has(promptId)) {
        return roundMs(Math.max(fallbackElapsedMs, durablePromptReceipts.get(promptId) - sendT0));
      }
      await sleep(15);
    }
    return fallbackElapsedMs;
  };

  for (let round = 0; round < cfg.promptRounds; round += 1) {
    const twinSnap = twin.getStats();
    let liveActive = 0;
    if (typeof server.inspectLiveAgents === 'function') {
      const snap = await server.inspectLiveAgents(seeded.sessionId).catch(() => null);
      liveActive = Number(snap?.activeChildCount ?? 0);
    }
    const activeNow = Math.max(liveActive, twinSnap.counters.activeStreams ?? 0);
    if (activeNow > peakActiveChildren) peakActiveChildren = activeNow;
    if (activeNow >= 1) overlapBucketsQualified += 1;

    void runBgProbe(round);
    if (browserDriver) {
      await browserDriver.sampleAndType(`Live overlap round ${round} (${runId})`);
    }

    const usePng = round % 2 === 1;
    const promptId = usePng ? `p_s10_png_${runId}_${round}` : `p_s10_txt_${runId}_${round}`;
    let content = [
      {
        type: 'text',
        text: `[CHAOS_SCOPE:s10_live_msg_${runId}_${round}] Live user prompt round ${round} during active subagent storm.`,
      },
    ];

    if (usePng) {
      const pngBuf = round === 1 ? png88k : pngLarge;
      const form = new FormData();
      form.append('file', new Blob([pngBuf], { type: 'image/png' }), `screenshot_${round}.png`);
      let uploadedRef = null;
      let uploadStatus = 0;
      try {
        const upRes = await fetch(`${server.endpoint}/api/files`, {
          method: 'POST',
          headers: { authorization: `Bearer ${server.token}` },
          body: form,
        });
        uploadStatus = upRes.status;
        const upJson = await upRes.json().catch(() => null);
        uploadedRef = upJson?.data?.file_id ?? upJson?.data?.id ?? null;
      } catch (err) {
        uploadErrors.push(`round=${round}: ${String(err?.message ?? err)}`);
      }
      if (!uploadedRef) {
        uploadErrors.push(`round=${round}: /api/files failed (status=${uploadStatus}), refusing inline data: fallback`);
        continue;
      }
      content = [
        { type: 'image', source: { kind: 'file', file_id: uploadedRef } },
        ...content,
      ];
      const sendT0 = performance.now();
      const sendRes = await apiJson(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(seeded.sessionId)}/prompts`,
        {
          prompt_id: promptId,
          mode: round === 1 ? 'steer' : 'queue',
          content,
        },
        20_000,
      );
      if (sendRes.status === 200 && sendRes.json?.code === 0) {
        const receiptMs = await waitDurableReceipt(promptId, sendT0, sendRes.elapsedMs);
        pngSendLatenciesMs.push(receiptMs);
        allSendLatenciesMs.push(receiptMs);
      } else {
        uploadErrors.push(`round=${round}: PNG prompt rejected status=${sendRes.status} code=${sendRes.json?.code} msg=${sendRes.json?.msg ?? ''}`);
      }
    } else {
      const sendT0 = performance.now();
      const sendRes = await apiJson(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(seeded.sessionId)}/prompts`,
        {
          prompt_id: promptId,
          mode: 'steer',
          content,
        },
        20_000,
      );
      if (sendRes.status === 200 && sendRes.json?.code === 0) {
        const receiptMs = await waitDurableReceipt(promptId, sendT0, sendRes.elapsedMs);
        textSendLatenciesMs.push(receiptMs);
        allSendLatenciesMs.push(receiptMs);
      }
    }
    await sleep(250);
  }

  // Wait for children & session to settle
  const settleDeadline = performance.now() + (isFull ? 120_000 : 45_000);
  while (performance.now() < settleDeadline) {
    const st = await apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${encodeURIComponent(seeded.sessionId)}/status`, undefined, 10_000);
    const twinNow = twin.getStats();
    const busy =
      st.json?.data?.busy === true ||
      st.json?.data?.executing === true ||
      (twinNow.counters.activeStreams ?? 0) > 0;
    if (!busy && performance.now() - startedAt > 2_000) break;
    await sleep(250);
  }

  activeMonitorStopped = true;
  await activeMonitor;

  let flightRecorder = null;
  if (browserDriver) {
    flightRecorder = await browserDriver.closeAndCollect();
  }

  try {
    wsMainOnly?.close();
    wsControlChild?.close();
  } catch {}

  const heartbeatSummary = heartbeat.stop();
  const postMetrics = await server.metrics(true);
  const postTwin = twin.getStats();

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

  // Build rolling 5s producer windows from REAL observed child delta events
  const rolling5sWindows = [];
  if (controlTelemetry.childDeltaEvents.length > 0) {
    const firstTs = controlTelemetry.childDeltaEvents[0].tsMs;
    const lastTs = controlTelemetry.childDeltaEvents[controlTelemetry.childDeltaEvents.length - 1].tsMs;
    const spanMs = Math.max(1_000, lastTs - firstTs);
    const winMs = Math.min(5_000, spanMs);
    for (let wsStart = firstTs; wsStart <= lastTs; wsStart += winMs) {
      const wsEnd = wsStart + winMs;
      const inWin = controlTelemetry.childDeltaEvents.filter((e) => e.tsMs >= wsStart && e.tsMs <= wsEnd);
      if (inWin.length === 0) continue;
      const byChild = new Map();
      for (const ev of inWin) {
        const rec = byChild.get(ev.childId) ?? { childId: ev.childId, deltas: 0, usefulBytes: 0, first: ev.tsMs, last: ev.tsMs };
        rec.deltas += ev.deltas;
        rec.usefulBytes += ev.bytes;
        rec.last = Math.max(rec.last, ev.tsMs);
        byChild.set(ev.childId, rec);
      }
      const perChildStreams = [...byChild.values()].map((c) => ({
        childId: c.childId,
        deltas: c.deltas,
        usefulBytes: c.usefulBytes,
        activeSeconds: Math.max(0.1, (c.last - c.first) / 1000),
      }));
      rolling5sWindows.push({
        productiveChildren4s: byChild.size,
        streamingChildren3s: byChild.size,
        perChildStreams,
      });
    }
  }

  const parsedAdmission = parsePromptAdmissionLatencies(corpus.homeDir, wallStartMs);
  const promptAdmissionSummary =
    parsedAdmission.length > 0 ? summarize(parsedAdmission) : summarize(allSendLatenciesMs);
  const sendToReceiptSummary = summarize(allSendLatenciesMs);
  const textPromptAdmissionSummary = textSendLatenciesMs.length > 0 ? summarize(textSendLatenciesMs) : null;
  const pngPromptAdmissionSummary = pngSendLatenciesMs.length > 0 ? summarize(pngSendLatenciesMs) : null;

  const bytesPerSecArr = [...wsTelemetry.perSecBytes.values()].sort((a, b) => a - b);
  const framesPerSecArr = [...wsTelemetry.perSecFrames.values()].sort((a, b) => a - b);
  const p99Of = (arr) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.99))] : 0);

  // Locate first completed real child directory for P0-1 Lane B reopen verification
  let reopenCandidate = null;
  const agentsDir = path.join(seeded.sessionDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir)) {
      if (entry === 'main' || entry.startsWith('sub_hist_')) continue;
      const agentDir = path.join(agentsDir, entry);
      if (fs.existsSync(path.join(agentDir, 'wire.jsonl'))) {
        reopenCandidate = { sessionId: seeded.sessionId, childAgentId: entry, agentDir };
        break;
      }
    }
  }

  const requiredStreaming = Math.min(2, cfg.activeChildren);
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
    backgroundQueriesCompleted,
    uploadErrors,
    browserRequired: Boolean(runBrowser),
    flightRecorder,
    promptAdmission: promptAdmissionSummary,
    textPromptAdmission: textPromptAdmissionSummary,
    pngPromptAdmission: pngPromptAdmissionSummary,
    promptAdmissionRawSamples: parsedAdmission,
    sendToReceipt: sendToReceiptSummary,
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
          requiredStreamingChildren: requiredStreaming,
          activeStreamingChildren: peakActiveChildren,
          controlClientChildBytes: controlTelemetry.childDeltaBytes,
          controlClientChildFrames: controlTelemetry.childDeltaFrames,
          unsubscribedChildContentBytes: wsTelemetry.unsubscribedChildContentBytes,
          unsubscribedChildContentFrames: wsTelemetry.unsubscribedChildContentFrames,
          inboundBytesPerSecP99: p99Of(bytesPerSecArr),
          inboundBytesPerSecPeak: bytesPerSecArr.length ? bytesPerSecArr[bytesPerSecArr.length - 1] : 0,
          inboundFramesPerSecP99: p99Of(framesPerSecArr),
          inboundFramesPerSecPeak: framesPerSecArr.length ? framesPerSecArr[framesPerSecArr.length - 1] : 0,
          rolling5sWindows,
          minRollingWindows: 1,
          frameTypeCounts: wsTelemetry.frameTypeCounts,
          largestFrames: wsTelemetry.largestFrames,
        }
      : null,
  };

  const verdict = evaluateS10Verdict(evidence, cfg.limits);
  if (uploadErrors.length > 0) {
    verdict.productFailures.push(...uploadErrors.map((e) => `S10 PNG upload failed: ${e}`));
    verdict.passed = false;
    verdict.exitCode = 1;
  }

  progress(
    `S10 (${tier}) Result: passed=${verdict.passed} exitCode=${verdict.exitCode} peakChildren=${peakActiveChildren} childTools=${totalChildToolCalls} ctrlChildBytes=${controlTelemetry.childDeltaBytes} promptAdmP95=${promptAdmissionSummary.p95Ms}ms eldP99=${evidence.eld.p99Ms}ms eldMax=${evidence.eld.maxMs}ms`,
  );

  return {
    ...verdict,
    limits: cfg.limits,
    evidence,
    reopenCandidate,
    elapsedMs: roundMs(performance.now() - startedAt),
  };
}
