import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const GUI_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function roundMs(val) {
  return Number(Number(val ?? 0).toFixed(2));
}

function roundMiB(bytes) {
  return Number((Number(bytes ?? 0) / (1024 * 1024)).toFixed(2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quantile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return roundMs(sorted[idx]);
}

function summarize(samples) {
  if (!samples.length) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...samples].toSorted((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: roundMs(sorted[0]),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: roundMs(sorted.at(-1)),
    mean: roundMs(sum / sorted.length),
  };
}

async function apiJsonRaw(endpoint, token, method, urlPath, body, timeoutMs = 45_000) {
  const t0 = performance.now();
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, elapsedMs: roundMs(performance.now() - t0), bytes, json, rawText: text.slice(0, 400) };
  } catch (err) {
    return {
      status: 0,
      elapsedMs: roundMs(performance.now() - t0),
      bytes: 0,
      json: null,
      rawText: String(err?.message ?? err).slice(0, 200),
      networkError: err?.name === 'AbortError' ? 'timeout' : String(err?.code ?? err?.message ?? 'fetch_error'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function withStepTimeout(label, timeoutMs, fn) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`S6 step "${label}" timed out after ${timeoutMs}ms`);
      err.code = 'STEP_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(fn).finally(() => clearTimeout(timer)),
    timeoutPromise,
  ]);
}

function normalizeRouteKey(urlString) {
  try {
    const u = new URL(urlString);
    return u.pathname
      .replace(/\/sessions\/[^/]+/u, '/sessions/:id')
      .replace(/\/session-view\/[^/]+/u, '/session-view/:id')
      .replace(/\/agents\/[^/]+/u, '/agents/:aid');
  } catch {
    return urlString;
  }
}

async function runBackendProtocolS6({ server, target, createKlient, WebSocket, stepTimeoutMs, progress }) {
  const sessionId = target.sessionId;
  const inspectSubagentId = target.deepestInspectTargetId ?? 'subagent_10000';
  const coldNeedleA = target.coldHistoricalNeedleIds?.[0] ?? 'subagent_00042';
  const coldNeedleB = target.coldHistoricalNeedleIds?.[1] ?? 'subagent_05000';
  const backend = {
    sessionId,
    subagentCount: target.subagentCount,
    stateJsonMiB: target.stateJsonMiB,
    coldRestSnapshot: null,
    coldBrowseSnapshotAndDrain: null,
    coldSubagentSearchApi: null,
    coldWsSubscribe: null,
    coldSubagentDrillIn: null,
    agentListToolTurn: null,
    error: null,
  };

  progress(`S6 Backend [1/5]: Cold GET /api/sessions/${sessionId}/snapshot?mode=transcript...`);
  await server.resetWindow();
  const restPre = await server.metrics(false);
  const restRes = await apiJsonRaw(
    server.endpoint,
    server.token,
    'GET',
    `/api/sessions/${encodeURIComponent(sessionId)}/snapshot?mode=transcript`,
    undefined,
    stepTimeoutMs,
  );
  const restPost = await server.metrics(false);
  const restData = restRes.json?.data ?? null;
  backend.coldRestSnapshot = {
    httpStatus: restRes.status,
    code: restRes.json?.code ?? null,
    latencyMs: restRes.elapsedMs,
    payloadBytes: restRes.bytes,
    subagentsReturned: Array.isArray(restData?.subagents) ? restData.subagents.length : 0,
    agentCounts: restData?.agent_counts ?? null,
    contentRefsCount: Array.isArray(restData?.contentRefs) ? restData.contentRefs.length : 0,
    vmRssBeforeMiB: restPre.rssMiB,
    vmRssAfterMiB: restPost.rssMiB,
    vmRssDeltaMiB: Number((restPost.rssMiB - restPre.rssMiB).toFixed(2)),
    eldP99Ms: restPost.eldP99Ms,
    eldMaxMs: restPost.eldMaxMs,
    maxSingleTickStallMs: restPost.maxSingleTickStallMs,
    networkError: restRes.networkError ?? null,
  };

  progress(`S6 Backend [2/5]: Cold Klient browse snapshot + full ContentRef segment drain for 10k subagents...`);
  await server.resetWindow();
  await server.startHeapSampling();
  const drainPre = await server.metrics(true);
  const drainT0 = performance.now();

  const browseRes = await apiJsonRaw(
    server.endpoint,
    server.token,
    'GET',
    `/api/klient/session-view/${encodeURIComponent(sessionId)}/snapshot`,
    undefined,
    stepTimeoutMs,
  );
  const browseData = browseRes.json?.data ?? null;
  const initialSubagents = Array.isArray(browseData?.subagents) ? browseData.subagents.length : 0;
  const contentRefs = Array.isArray(browseData?.contentRefs) ? browseData.contentRefs : [];
  let nextRef = contentRefs.find((r) => Array.isArray(r?.path) && r.path.length === 1 && r.path[0] === 'subagents') ?? null;

  let segmentCallCount = 0;
  let totalHydratedSubagents = initialSubagents;
  let totalSegmentBytes = browseRes.bytes;
  const segmentLatenciesMs = [];
  const segmentErrors = [];
  let drainTimedOut = false;
  const drainDeadline = performance.now() + Math.max(stepTimeoutMs, 60_000);
  const maxSegments = 500;

  while (nextRef && segmentCallCount < maxSegments) {
    if (performance.now() >= drainDeadline) {
      drainTimedOut = true;
      break;
    }
    const remainingMs = Math.max(2_000, Math.min(stepTimeoutMs, Math.floor(drainDeadline - performance.now())));
    const segRes = await apiJsonRaw(
      server.endpoint,
      server.token,
      'POST',
      `/api/klient/session-view/${encodeURIComponent(sessionId)}/transcript/content`,
      { agentId: 'main', ref: nextRef },
      remainingMs,
    );
    segmentCallCount += 1;
    segmentLatenciesMs.push(segRes.elapsedMs);
    totalSegmentBytes += segRes.bytes;
    if (segRes.status !== 200 || segRes.json?.code !== 0) {
      segmentErrors.push({
        callIndex: segmentCallCount,
        status: segRes.status,
        code: segRes.json?.code ?? segRes.networkError ?? 'error',
        msg: segRes.json?.msg ?? segRes.rawText,
      });
      if (segRes.networkError === 'timeout') drainTimedOut = true;
      break;
    }
    const segData = segRes.json.data;
    if (Array.isArray(segData?.value)) {
      totalHydratedSubagents += segData.value.length;
    }
    nextRef = segData?.next ?? null;
  }

  const totalHydrationWallMs = roundMs(performance.now() - drainT0);
  const heapSnap = await server.stopHeapSampling();
  const gcAfterDrain = await server.gc();

  backend.coldBrowseSnapshotAndDrain = {
    initialSnapshotMs: browseRes.elapsedMs,
    initialSnapshotBytes: browseRes.bytes,
    initialSubagents,
    agentCounts: browseData?.agent_counts ?? null,
    segmentCallCount,
    totalHydratedSubagents,
    fullyDrained: nextRef === null && segmentErrors.length === 0 && !drainTimedOut,
    timedOut: drainTimedOut,
    totalSegmentBytes,
    totalSegmentMiB: roundMiB(totalSegmentBytes),
    totalHydrationWallMs,
    segmentLatencyMs: summarize(segmentLatenciesMs),
    errors: segmentErrors.slice(0, 10),
    eventLoop: {
      eldP99Ms: heapSnap.metrics.eldP99Ms,
      eldMaxMs: heapSnap.metrics.eldMaxMs,
      maxSingleTickStallMs: heapSnap.metrics.maxSingleTickStallMs,
      eventLoopUtilization: heapSnap.metrics.eventLoopUtilization,
    },
    memoryMiB: {
      vmRssBefore: drainPre.rssMiB,
      vmRssAfter: heapSnap.metrics.rssMiB,
      vmRssDelta: Number((heapSnap.metrics.rssMiB - drainPre.rssMiB).toFixed(2)),
      vmHwm: heapSnap.metrics.vmHwmMiB,
      heapUsedAfter: heapSnap.metrics.heapUsedMiB,
      postGcRss: gcAfterDrain.metrics.rssMiB,
      postGcHeapUsed: gcAfterDrain.metrics.heapUsedMiB,
    },
    topHeapRetainers: heapSnap.topRetainers.slice(0, 10),
  };

  progress(`S6 Backend [3/5]: On-demand subagent search API (GET /api/sessions/${sessionId}/subagents?q=...&limit=50)...`);
  const searchProbes = [
    { label: 'cold_needle_00042', q: coldNeedleA, expectId: coldNeedleA },
    { label: 'cold_needle_05000', q: coldNeedleB, expectId: coldNeedleB },
    { label: 'cold_label_query', q: 'Cold Archive Needle', expectId: coldNeedleA },
    { label: 'newest_tail_query', q: inspectSubagentId, expectId: inspectSubagentId },
  ];
  const searchResults = [];
  for (const probe of searchProbes) {
    const res = await apiJsonRaw(
      server.endpoint,
      server.token,
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents?q=${encodeURIComponent(probe.q)}&limit=50`,
      undefined,
      stepTimeoutMs,
    );
    const data = res.json?.data ?? null;
    const items = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.subagents)
        ? data.subagents
        : Array.isArray(data)
          ? data
          : [];
    const matchedIds = items.map((it) => it?.agent_id ?? it?.id).filter(Boolean);
    searchResults.push({
      label: probe.label,
      query: probe.q,
      httpStatus: res.status,
      code: res.json?.code ?? null,
      latencyMs: res.elapsedMs,
      returnedCount: items.length,
      totalMatches: data?.total ?? data?.total_matches ?? null,
      foundExpectedId: matchedIds.includes(probe.expectId),
      sampleIds: matchedIds.slice(0, 5),
      networkError: res.networkError ?? null,
    });
  }
  backend.coldSubagentSearchApi = {
    endpointSupported: searchResults.some((r) => r.httpStatus === 200 && r.code === 0),
    allColdNeedlesFound: searchResults.every((r) => r.foundExpectedId),
    maxLatencyMs: roundMs(Math.max(0, ...searchResults.map((r) => r.latencyMs))),
    probes: searchResults,
  };

  progress(`S6 Backend [4/5]: Cold WS view.subscribe TTFC & ready on ${sessionId}...`);
  await server.resetWindow();
  const klient = createKlient({ endpoint: server.endpoint, token: server.token, WebSocket, timeoutMs: stepTimeoutMs });
  try {
    const wsT0 = performance.now();
    let mainResetMs = null;
    let snapshotSignalMs = null;
    let readyMs = null;
    let wsTimedOut = false;
    let wsError = null;
    let sub = null;

    const view = klient.session(sessionId).view;
    try {
      await withStepTimeout('ws_view_subscribe', stepTimeoutMs, () => new Promise((resolve, reject) => {
        sub = view.subscribe(
          { sessionCursor: { seq: 0 }, transcriptGrades: { '*': 'turn', main: 'delta' }, bootstrap: true },
          (signal) => {
            if (signal.type === 'transcript' && signal.event.agent_id === 'main' && signal.event.type === 'transcript.reset') {
              if (mainResetMs === null) mainResetMs = roundMs(performance.now() - wsT0);
              if (readyMs !== null) resolve();
            } else if (signal.type === 'snapshot') {
              if (snapshotSignalMs === null) snapshotSignalMs = roundMs(performance.now() - wsT0);
            } else if (signal.type === 'ready') {
              if (readyMs === null) readyMs = roundMs(performance.now() - wsT0);
              if (mainResetMs !== null) resolve();
            } else if (signal.type === 'protocolError') {
              reject(new Error(`S6 WS protocolError: ${signal.detail ?? 'unknown'}`));
            }
          },
        );
      }));
    } catch (err) {
      wsTimedOut = err?.code === 'STEP_TIMEOUT';
      wsError = String(err?.message ?? err).slice(0, 300);
    } finally {
      sub?.close?.();
    }
    const wsPost = await server.metrics(false);
    backend.coldWsSubscribe = {
      ttfcMs: mainResetMs,
      snapshotSignalMs,
      readyMs,
      totalMs: roundMs(performance.now() - wsT0),
      timedOut: wsTimedOut,
      error: wsError,
      eldP99Ms: wsPost.eldP99Ms,
      maxSingleTickStallMs: wsPost.maxSingleTickStallMs,
    };

    progress(`S6 Backend [5/5]: Cold drill-in transcript fetch on ${inspectSubagentId} & ${coldNeedleA}...`);
    const drillT0 = performance.now();
    let drillPage = null;
    let drillError = null;
    let drillTimedOut = false;
    try {
      drillPage = await withStepTimeout('subagent_10000_transcript_page', stepTimeoutMs, () =>
        view.transcript.page({ agentId: inspectSubagentId, pageSize: 20 }),
      );
    } catch (err) {
      drillTimedOut = err?.code === 'STEP_TIMEOUT';
      drillError = String(err?.message ?? err).slice(0, 300);
    }
    const drillMs = roundMs(performance.now() - drillT0);
    const drillSerialized = drillPage ? JSON.stringify(drillPage) : '';
    const verifiedUniqueBody = drillSerialized.includes(`UNIQUE_SUBAGENT_RECEIPT:${inspectSubagentId}`);

    const coldDrillT0 = performance.now();
    let coldDrillPage = null;
    try {
      coldDrillPage = await withStepTimeout('subagent_00042_transcript_page', stepTimeoutMs, () =>
        view.transcript.page({ agentId: coldNeedleA, pageSize: 20 }),
      );
    } catch {}
    const coldDrillMs = roundMs(performance.now() - coldDrillT0);
    const coldDrillVerified = coldDrillPage
      ? JSON.stringify(coldDrillPage).includes(`UNIQUE_SUBAGENT_RECEIPT:${coldNeedleA}`)
      : false;

    const restTranscriptRes = await apiJsonRaw(
      server.endpoint,
      server.token,
      'GET',
      `/api/klient/session-view/${encodeURIComponent(sessionId)}/transcript?agent_id=${encodeURIComponent(inspectSubagentId)}&page_size=20&transcript_coverage_version=2`,
      undefined,
      stepTimeoutMs,
    );

    backend.coldSubagentDrillIn = {
      agentId: inspectSubagentId,
      klientPageMs: drillMs,
      itemsReturned: Array.isArray(drillPage?.items) ? drillPage.items.length : 0,
      verifiedUniqueBody,
      timedOut: drillTimedOut,
      error: drillError,
      coldHistoricalNeedleAgentId: coldNeedleA,
      coldHistoricalNeedlePageMs: coldDrillMs,
      coldHistoricalNeedleVerified: coldDrillVerified,
      httpTranscriptReadMs: restTranscriptRes.elapsedMs,
      httpTranscriptStatus: restTranscriptRes.status,
      httpTranscriptCode: restTranscriptRes.json?.code ?? null,
    };
  } finally {
    await klient.close().catch(() => undefined);
    await server.closeSession(sessionId).catch(() => undefined);
  }

  return backend;
}

async function runAgentListToolProbe({ server, twin, target, stepTimeoutMs, progress }) {
  const sessionId = target.sessionId;
  progress(`S6 Backend [6/6]: Live AgentList(include_finished=true) tool turn on ${sessionId}...`);
  if (!twin) {
    return { skipped: true, reason: 'twin server not supplied' };
  }
  const twinBefore = twin.getStats();
  const t0 = performance.now();
  const promptId = `p_s6_agentlist_${Date.now()}`;
  const submitRes = await apiJsonRaw(
    server.endpoint,
    server.token,
    'POST',
    `/api/sessions/${encodeURIComponent(sessionId)}/prompts`,
    {
      prompt_id: promptId,
      content: [
        {
          type: 'text',
          text: `[CHAOS_SCOPE:s6_agent_list_10k] [TOOLS:AGENT_LIST_10K] Call AgentList(include_finished=true) on the 10,000-subagent session and summarize.`,
        },
      ],
    },
    Math.max(stepTimeoutMs, 60_000),
  );
  const submitMs = submitRes.elapsedMs;
  if (submitRes.status !== 200 || submitRes.json?.code !== 0) {
    return {
      ok: false,
      stage: 'submit',
      submitMs,
      httpStatus: submitRes.status,
      code: submitRes.json?.code ?? submitRes.networkError ?? 'http_error',
      msg: submitRes.json?.msg ?? submitRes.rawText,
      turnWallMs: roundMs(performance.now() - t0),
    };
  }

  const deadline = performance.now() + Math.max(stepTimeoutMs, 60_000);
  let settled = false;
  let lastTurnReason = null;
  let pollCount = 0;
  while (performance.now() < deadline) {
    pollCount += 1;
    const st = await apiJsonRaw(
      server.endpoint,
      server.token,
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/status`,
      undefined,
      15_000,
    );
    const data = st.json?.data ?? null;
    if (st.status === 200 && data) {
      const busy =
        data.busy === true ||
        data.executing === true ||
        data.main_turn_active === true ||
        data.state === 'running' ||
        data.loop?.status === 'running';
      const twinNow = twin.getStats();
      const sawLlmCall = twinNow.counters.totalRequests > twinBefore.counters.totalRequests;
      if (!busy && (sawLlmCall || pollCount >= 8)) {
        settled = true;
        lastTurnReason = data.last_turn_reason ?? data.lastTurnReason ?? 'completed';
        break;
      }
    }
    await sleep(80);
  }

  const turnWallMs = roundMs(performance.now() - t0);
  const twinAfter = twin.getStats();
  const agentListStats = twinAfter?.toolStats?.AgentList ?? null;
  const resultBytes = agentListStats?.lastResultBytes ?? null;
  const subagentMentionCount = agentListStats?.lastSubagentMentionCount ?? null;
  const parsedEntryCount = agentListStats?.lastParsedEntryCount ?? null;
  const effectiveEntryCount = parsedEntryCount ?? subagentMentionCount;

  await server.closeSession(sessionId).catch(() => undefined);

  return {
    ok: settled && agentListStats !== null && (agentListStats.resultsOk ?? 0) >= 1,
    settled,
    timedOut: !settled,
    lastTurnReason,
    submitMs,
    turnWallMs,
    twinRequestsDelta: twinAfter.counters.totalRequests - twinBefore.counters.totalRequests,
    twinContractViolationsDelta: twinAfter.counters.contractViolations - twinBefore.counters.contractViolations,
    twinViolationsTail: twinAfter.violations?.slice(-3) ?? [],
    toolResultBytes: resultBytes,
    toolResultKiB: resultBytes === null ? null : Number((resultBytes / 1024).toFixed(2)),
    toolResultLineCount: agentListStats?.lastResultLineCount ?? null,
    parsedEntryCount,
    subagentMentionCount,
    hasOmissionNotice: agentListStats?.lastHasOmissionNotice ?? false,
    boundedUnder16KiB: resultBytes !== null && resultBytes <= 16 * 1024,
    boundedUnder50Rows: effectiveEntryCount !== null && effectiveEntryCount <= 50,
    previewHead: agentListStats?.lastResultHead ?? null,
    previewTail: agentListStats?.lastResultTail ?? null,
  };
}

async function runFrontendChromiumCdpS6({ server, target, stepTimeoutMs, progress }) {
  const sessionId = target.sessionId;
  const familyTargetId = target.familyPopoverTargetId ?? 'subagent_00001';
  const coldNeedleA = target.coldHistoricalNeedleIds?.[0] ?? 'subagent_00042';
  const coldNeedleB = target.coldHistoricalNeedleIds?.[1] ?? 'subagent_05000';
  const lightSessionId = target.lightSessionId ?? 'chaos_bg_0001';

  const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
  const { chromium } = kapRequire('playwright');
  const { ensureGuiStaticBuild } = await import('../perf/browser-runner.mjs');

  const frontend = {
    guiBuildMs: 0,
    pageErrors: [],
    consoleErrors: [],
    step1_coldOpen: null,
    step2_inspectorRoster: null,
    step3_agentFamilyPopover: null,
    step4_cockpitMode: null,
    step5_switchAwayReclamation: null,
    error: null,
  };

  let staticServer = null;
  let browser = null;

  try {
    const build = ensureGuiStaticBuild(path.join(REPO_ROOT, '.tmp', 'chaos-gui-dist'));
    frontend.guiBuildMs = build.buildMs;
    progress(`S6 Frontend: GUI static build ready (reusedCache=${build.reusedCache}, buildMs=${build.buildMs}ms)`);

    staticServer = createHttpServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      if (urlPath === '/__kiki/local-server') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      let file = path.normalize(path.join(build.distDir, urlPath));
      if (!file.startsWith(build.distDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(build.distDir, 'index.html');
      }
      const stream = fs.createReadStream(file);
      stream.once('open', () => {
        res.writeHead(200, { 'content-type': GUI_MIME[path.extname(file)] ?? 'application/octet-stream' });
        stream.pipe(res);
      });
      stream.once('error', () => {
        if (!res.headersSent) res.writeHead(404);
        res.end('not found');
      });
    });
    await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
    const webUrl = `http://127.0.0.1:${staticServer.address().port}`;
    const deepLink = (routePath) =>
      `${webUrl}${routePath}?server=${encodeURIComponent(server.endpoint)}&token=${encodeURIComponent(server.token)}`;

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('kiki.locale', 'en');
        localStorage.setItem('kiki.railMode', 'default');
        localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      } catch {}
      const state = { longTasks: [], rafGaps: [] };
      window.__s6Probe = {
        reset() {
          state.longTasks = [];
          state.rafGaps = [];
        },
        drain() {
          const durations = state.longTasks.map((t) => t.duration);
          const out = {
            longTaskCount: durations.length,
            maxLongTaskMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : 0,
            totalBlockingTimeMs: Number(durations.reduce((a, d) => a + Math.max(0, d - 50), 0).toFixed(2)),
            maxRafGapMs: state.rafGaps.length ? Number(Math.max(...state.rafGaps).toFixed(2)) : 0,
          };
          state.longTasks = [];
          state.rafGaps = [];
          return out;
        },
      };
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) state.longTasks.push({ duration: e.duration });
        });
        obs.observe({ type: 'longtask', buffered: true });
      } catch {}
      let prev = performance.now();
      const tick = (now) => {
        const gap = now - prev;
        prev = now;
        if (gap > 32) state.rafGaps.push(gap);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const page = await context.newPage();
    page.on('pageerror', (err) => {
      if (frontend.pageErrors.length < 30) frontend.pageErrors.push(String(err?.message ?? err).slice(0, 300));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' && frontend.consoleErrors.length < 30) {
        frontend.consoleErrors.push(msg.text().slice(0, 300));
      }
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const readCdpMetrics = async () => {
      try {
        const { metrics } = await withStepTimeout('cdp_metrics', 10_000, () => cdp.send('Performance.getMetrics'));
        const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
        return {
          jsHeapUsedMiB: roundMiB(map.JSHeapUsedSize ?? 0),
          jsHeapTotalMiB: roundMiB(map.JSHeapTotalSize ?? 0),
          domNodes: map.Nodes ?? 0,
          jsEventListeners: map.JSEventListeners ?? 0,
          layoutCount: map.LayoutCount ?? 0,
          recalcStyleCount: map.RecalcStyleCount ?? 0,
        };
      } catch (err) {
        return { error: String(err?.message ?? err).slice(0, 200) };
      }
    };

    const apiPrefix = server.endpoint;
    const allApiRequests = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith(apiPrefix)) {
        allApiRequests.push({
          ts: performance.now(),
          method: req.method(),
          route: normalizeRouteKey(url),
        });
      }
    });
    const summarizeApiRequestsSince = (sinceTs, untilTs = performance.now()) => {
      const subset = allApiRequests.filter((r) => r.ts >= sinceTs && r.ts <= untilTs);
      const byRoute = Object.create(null);
      for (const r of subset) {
        const k = `${r.method} ${r.route}`;
        byRoute[k] = (byRoute[k] ?? 0) + 1;
      }
      return { total: subset.length, byRoute };
    };

    // ------------------------------------------------------------------
    // Step 1: Cold Session Open (10,000 subagents)
    // ------------------------------------------------------------------
    progress(`S6 Frontend [1/5]: Cold Session Open on /s/${sessionId}...`);
    const openT0 = performance.now();
    const step1 = {
      coldOpenFirstTurnMs: null,
      httpRequestsFirst5s: null,
      httpRequestsAtSettle: null,
      cdp: null,
      longTasks: null,
      stuckPreparingDetected: false,
      timedOut: false,
      error: null,
    };
    try {
      await withStepTimeout('frontend_cold_open', stepTimeoutMs, async () => {
        await page.goto(deepLink(`/s/${sessionId}`), { waitUntil: 'domcontentloaded', timeout: stepTimeoutMs });
        await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: stepTimeoutMs });
        step1.coldOpenFirstTurnMs = roundMs(performance.now() - openT0);
      });
      const elapsedSoFar = performance.now() - openT0;
      if (elapsedSoFar < 5_000) {
        await sleep(5_000 - elapsedSoFar);
      }
      step1.httpRequestsFirst5s = summarizeApiRequestsSince(openT0, openT0 + 5_000);
      // Allow hydration to make visible progress (up to an additional 5s) before measuring roster
      await sleep(1_500);
      step1.httpRequestsAtSettle = summarizeApiRequestsSince(openT0);
      step1.longTasks = await page.evaluate(() => window.__s6Probe?.drain?.() ?? null).catch(() => null);
      const bodyText = await page.evaluate(() => document.body.innerText ?? '').catch(() => '');
      step1.stuckPreparingDetected = /History is preparing/iu.test(bodyText);
      step1.cdp = await readCdpMetrics();
    } catch (err) {
      step1.timedOut = err?.code === 'STEP_TIMEOUT';
      step1.error = String(err?.message ?? err).slice(0, 400);
      step1.httpRequestsFirst5s = summarizeApiRequestsSince(openT0, openT0 + 5_000);
      step1.httpRequestsAtSettle = summarizeApiRequestsSince(openT0);
      step1.cdp = await readCdpMetrics();
    }
    frontend.step1_coldOpen = step1;

    // ------------------------------------------------------------------
    // Step 2: Right Inspector 10,000-Subagent Roster (Expand, Scroll, Search)
    // ------------------------------------------------------------------
    progress('S6 Frontend [2/5]: Right Inspector 10,000-Subagent Roster (expand Completed, scroll 5 viewports, search "subagent_0999")...');
    const step2 = {
      rosterVisible: false,
      rosterDoneButtonTextBefore: null,
      expandCompletedMs: null,
      renderedRosterRowsAfterExpand: null,
      cdpAfterExpand: null,
      expandLongTasks: null,
      scrollWallMs: null,
      scrollLongTasks: null,
      renderedRosterRowsAfterScroll: null,
      cdpAfterScroll: null,
      searchFilterMs: null,
      searchMatchedRowsVisible: null,
      searchLongTasks: null,
      cdpAfterSearch: null,
      timedOut: false,
      error: null,
    };
    try {
      await withStepTimeout('frontend_inspector_roster', stepTimeoutMs, async () => {
        const rosterPresent = await page.locator('[data-agent-roster]').isVisible().catch(() => false);
        if (!rosterPresent) {
          const railToggle = page.locator('[data-rail-toggle]').first();
          if (await railToggle.isVisible().catch(() => false)) {
            await railToggle.click({ timeout: 5_000 });
          }
          await page.waitForSelector('[data-agent-roster]', { timeout: 15_000 });
        }
        step2.rosterVisible = true;

        // Wait briefly for done-group or roster rows to appear
        const doneBtn = page.locator('[data-roster-done-group]').first();
        await doneBtn.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
        const doneVisible = await doneBtn.isVisible().catch(() => false);
        if (doneVisible) {
          step2.rosterDoneButtonTextBefore = (await doneBtn.innerText().catch(() => '')).trim();
          await page.evaluate(() => window.__s6Probe?.reset?.());
          const expT0 = performance.now();
          await doneBtn.click({ timeout: 10_000 });
          await page.waitForFunction(
            () => {
              const btn = document.querySelector('[data-roster-done-group]');
              return btn?.getAttribute('aria-expanded') === 'true';
            },
            { timeout: 20_000 },
          );
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          step2.expandCompletedMs = roundMs(performance.now() - expT0);
          step2.expandLongTasks = await page.evaluate(() => window.__s6Probe?.drain?.() ?? null);
        }

        step2.renderedRosterRowsAfterExpand = await page.evaluate(
          () => document.querySelectorAll('[data-agent-roster] [data-rail-item]').length,
        );
        step2.cdpAfterExpand = await readCdpMetrics();

        // Scroll 5 viewports down inside [data-subagent-scroll]
        await page.evaluate(() => window.__s6Probe?.reset?.());
        const scrollT0 = performance.now();
        await page.evaluate(async () => {
          const scroller = document.querySelector('[data-subagent-scroll]');
          if (!scroller) return;
          const step = Math.max(360, scroller.clientHeight || 480);
          for (let i = 1; i <= 5; i += 1) {
            scroller.scrollTop = Math.min(scroller.scrollHeight, i * step);
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
          }
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));
        });
        step2.scrollWallMs = roundMs(performance.now() - scrollT0);
        step2.scrollLongTasks = await page.evaluate(() => window.__s6Probe?.drain?.() ?? null);
        step2.renderedRosterRowsAfterScroll = await page.evaluate(
          () => document.querySelectorAll('[data-agent-roster] [data-rail-item]').length,
        );
        step2.cdpAfterScroll = await readCdpMetrics();

        // Search for cold historical needles (older than newest 200!) and open one
        const searchInput = page.locator('[data-roster-search]').first();
        if (await searchInput.isVisible().catch(() => false)) {
          await page.evaluate(() => window.__s6Probe?.reset?.());
          const searchT0 = performance.now();
          await searchInput.fill(coldNeedleA, { timeout: 10_000 });
          await page.waitForFunction(
            (needle) => {
              const items = document.querySelectorAll('[data-agent-roster] [data-agent-id]');
              if (items.length === 0) return Boolean(document.querySelector('[data-roster-empty]'));
              return Array.from(items).some((el) => (el.getAttribute('data-agent-id') ?? '') === needle);
            },
            coldNeedleA,
            { timeout: 10_000 },
          ).catch(() => undefined);
          await sleep(250);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
          step2.searchFilterMs = roundMs(performance.now() - searchT0);
          step2.coldNeedleQuery = coldNeedleA;
          step2.searchMatchedRowsVisible = await page.evaluate(
            () => document.querySelectorAll('[data-agent-roster] [data-agent-id]').length,
          );
          step2.foundColdNeedleA = await page.evaluate(
            (needle) => Boolean(document.querySelector(`[data-agent-roster] [data-agent-id="${needle}"]`)),
            coldNeedleA,
          );
          step2.searchLongTasks = await page.evaluate(() => window.__s6Probe?.drain?.() ?? null);
          step2.cdpAfterSearch = await readCdpMetrics();

          // If found, click to verify preview/detail opens cleanly
          if (step2.foundColdNeedleA) {
            const clickT0 = performance.now();
            await page.locator(`[data-agent-roster] [data-agent-id="${coldNeedleA}"]`).first().click({ timeout: 8_000 }).catch(() => undefined);
            await sleep(300);
            step2.coldNeedleOpenMs = roundMs(performance.now() - clickT0);
          }

          // Also probe second cold needle (subagent_05000)
          const searchB0 = performance.now();
          await searchInput.fill(coldNeedleB, { timeout: 10_000 });
          await page.waitForFunction(
            (needle) => Boolean(document.querySelector(`[data-agent-roster] [data-agent-id="${needle}"]`)),
            coldNeedleB,
            { timeout: 6_000 },
          ).catch(() => undefined);
          step2.coldNeedleBQuery = coldNeedleB;
          step2.coldNeedleBSearchMs = roundMs(performance.now() - searchB0);
          step2.foundColdNeedleB = await page.evaluate(
            (needle) => Boolean(document.querySelector(`[data-agent-roster] [data-agent-id="${needle}"]`)),
            coldNeedleB,
          );
          await searchInput.fill('').catch(() => undefined);
        }
      });
    } catch (err) {
      step2.timedOut = err?.code === 'STEP_TIMEOUT';
      step2.error = String(err?.message ?? err).slice(0, 400);
      step2.cdpAfterExpand = step2.cdpAfterExpand ?? (await readCdpMetrics());
    }
    frontend.step2_inspectorRoster = step2;

    // ------------------------------------------------------------------
    // Step 3: Header AgentFamilyPopover (10,000 children/siblings)
    // ------------------------------------------------------------------
    progress(`S6 Frontend [3/5]: Header AgentFamilyPopover on /s/${sessionId}/agent/${familyTargetId}...`);
    const step3 = {
      targetAgentId: familyTargetId,
      triggerFound: false,
      popoverOpenMs: null,
      popoverMountedItemsOnOpen: null,
      cdpAfterOpen: null,
      openLongTasks: null,
      filterQuery: 'subagent_09',
      filterMs: null,
      popoverMountedItemsAfterFilter: null,
      cdpAfterFilter: null,
      filterLongTasks: null,
      timedOut: false,
      error: null,
    };
    try {
      await withStepTimeout('frontend_agent_family_popover', stepTimeoutMs, async () => {
        await page.evaluate(
          ({ sid, aid }) => {
            const search = window.location.search;
            window.history.pushState({}, '', `/s/${sid}/agent/${encodeURIComponent(aid)}${search}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
          },
          { sid: sessionId, aid: familyTargetId },
        );
        const trigger = page.locator('[data-agent-family-trigger], [data-workspace-header] h1 button').first();
        await trigger.waitFor({ state: 'visible', timeout: 15_000 });
        step3.triggerFound = true;

        await page.evaluate(() => window.__s6Probe?.reset?.());
        const popT0 = performance.now();
        await trigger.click({ timeout: 10_000 });
        await page.waitForSelector('[data-family-item]', { timeout: 20_000 });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        step3.popoverOpenMs = roundMs(performance.now() - popT0);
        step3.popoverMountedItemsOnOpen = await page.evaluate(
          () => document.querySelectorAll('[data-family-item]').length,
        );
        step3.openLongTasks = await page.evaluate(() => window.__s6Probe?.drain?.() ?? null);
        step3.cdpAfterOpen = await readCdpMetrics();

        // Also test filtering inside AgentFamilyPopover (both cold needle lookup AND broad match DOM bound!)
        const popSearch = page.locator('[role="dialog"] input[type="search"], [data-agent-family-popover] input[type="search"], input[type="search"]').last();
        if (await popSearch.isVisible().catch(() => false)) {
          await page.evaluate(() => window.__s6Probe?.reset?.());
          const fT0 = performance.now();
          await popSearch.fill(coldNeedleA, { timeout: 10_000 });
          await page.waitForFunction(
            (needle) => Boolean(document.querySelector(`[data-family-item][data-agent-id="${needle}"]`)),
            coldNeedleA,
            { timeout: 6_000 },
          ).catch(() => undefined);
          step3.coldNeedleQuery = coldNeedleA;
          step3.coldNeedleSearchMs = roundMs(performance.now() - fT0);
          step3.foundColdNeedleInPopover = await page.evaluate(
            (needle) => Boolean(document.querySelector(`[data-family-item][data-agent-id="${needle}"]`)),
            coldNeedleA,
          );

          await page.evaluate(() => window.__s6Probe?.reset?.());
          const fBroad0 = performance.now();
          await popSearch.fill(step3.filterQuery, { timeout: 10_000 });
          await sleep(250);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          step3.filterMs = roundMs(performance.now() - fBroad0);
          step3.popoverMountedItemsAfterFilter = await page.evaluate(
            () => document.querySelectorAll('[data-family-item]').length,
          );
          step3.filterLongTasks = await page.evaluate(() => window.__s6Probe?.drain?.() ?? null);
          step3.cdpAfterFilter = await readCdpMetrics();
        }

        await page.keyboard.press('Escape').catch(() => undefined);
        await page.evaluate(
          ({ sid }) => {
            const search = window.location.search;
            window.history.pushState({}, '', `/s/${sid}${search}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
          },
          { sid: sessionId },
        );
        await sleep(300);
      });
    } catch (err) {
      step3.timedOut = err?.code === 'STEP_TIMEOUT';
      step3.error = String(err?.message ?? err).slice(0, 400);
      step3.cdpAfterOpen = step3.cdpAfterOpen ?? (await readCdpMetrics());
    }
    frontend.step3_agentFamilyPopover = step3;

    // ------------------------------------------------------------------
    // Step 4: Cockpit 驾驶舱 ([data-rail-mode="cockpit"])
    // ------------------------------------------------------------------
    progress('S6 Frontend [4/5]: Switching right rail to Cockpit ([data-rail-mode="cockpit"])...');
    const step4 = {
      cockpitButtonFound: false,
      cockpitSwitchMs: null,
      httpRequestsDuringCockpit: null,
      cdpAfterCockpit: null,
      longTasks: null,
      timedOut: false,
      error: null,
    };
    const cockpitReqStart = performance.now();
    try {
      await withStepTimeout('frontend_cockpit_mode', stepTimeoutMs, async () => {
        const cockpitBtn = page.locator('[data-rail-mode="cockpit"]').first();
        if (!(await cockpitBtn.isVisible().catch(() => false))) {
          const railToggle = page.locator('[data-rail-toggle]').first();
          if (await railToggle.isVisible().catch(() => false)) {
            await railToggle.click({ timeout: 5_000 });
          }
          await cockpitBtn.waitFor({ state: 'visible', timeout: 10_000 });
        }
        step4.cockpitButtonFound = true;
        await page.evaluate(() => window.__s6Probe?.reset?.());
        const cT0 = performance.now();
        await cockpitBtn.click({ timeout: 10_000 });
        await page.waitForFunction(
          () => document.querySelector('[data-rail-mode="cockpit"]')?.getAttribute('aria-checked') === 'true',
          { timeout: 25_000 },
        );
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        step4.cockpitSwitchMs = roundMs(performance.now() - cT0);
        await sleep(1_000);
        step4.longTasks = await page.evaluate(() => window.__s6Probe?.drain?.() ?? null);
        step4.cdpAfterCockpit = await readCdpMetrics();
        step4.httpRequestsDuringCockpit = summarizeApiRequestsSince(cockpitReqStart);

        const defaultBtn = page.locator('[data-rail-mode="default"]').first();
        if (await defaultBtn.isVisible().catch(() => false)) {
          await defaultBtn.click({ timeout: 5_000 }).catch(() => undefined);
          await sleep(250);
        }
      });
    } catch (err) {
      step4.timedOut = err?.code === 'STEP_TIMEOUT';
      step4.error = String(err?.message ?? err).slice(0, 400);
      step4.cdpAfterCockpit = await readCdpMetrics();
      step4.httpRequestsDuringCockpit = summarizeApiRequestsSince(cockpitReqStart);
    }
    frontend.step4_cockpitMode = step4;

    // ------------------------------------------------------------------
    // Step 5: Switch-Away Reclamation (1-turn light session + GC)
    // ------------------------------------------------------------------
    progress(`S6 Frontend [5/5]: Switch-away reclamation to /s/${lightSessionId} + HeapProfiler.collectGarbage...`);
    const step5 = {
      lightSessionId,
      beforeSwitchAway: null,
      afterSwitchAwayGc: null,
      deltas: null,
      timedOut: false,
      error: null,
    };
    try {
      await withStepTimeout('frontend_switch_away_gc', stepTimeoutMs, async () => {
        step5.beforeSwitchAway = await readCdpMetrics();
        await page.goto(deepLink(`/s/${lightSessionId}`), { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 20_000 }).catch(() => undefined);
        await sleep(600);
        await cdp.send('HeapProfiler.enable').catch(() => undefined);
        await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
        await sleep(250);
        await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
        await sleep(250);
        step5.afterSwitchAwayGc = await readCdpMetrics();
        if (
          typeof step5.beforeSwitchAway?.jsHeapUsedMiB === 'number' &&
          typeof step5.afterSwitchAwayGc?.jsHeapUsedMiB === 'number'
        ) {
          step5.deltas = {
            jsHeapDropMiB: Number((step5.beforeSwitchAway.jsHeapUsedMiB - step5.afterSwitchAwayGc.jsHeapUsedMiB).toFixed(2)),
            domNodesDrop: step5.beforeSwitchAway.domNodes - step5.afterSwitchAwayGc.domNodes,
            jsEventListenersDrop: step5.beforeSwitchAway.jsEventListeners - step5.afterSwitchAwayGc.jsEventListeners,
          };
        }
      });
    } catch (err) {
      step5.timedOut = err?.code === 'STEP_TIMEOUT';
      step5.error = String(err?.message ?? err).slice(0, 400);
    }
    frontend.step5_switchAwayReclamation = step5;
  } catch (err) {
    frontend.error = String(err?.stack ?? err).slice(0, 600);
  } finally {
    await browser?.close().catch(() => undefined);
    if (staticServer) await new Promise((resolve) => staticServer.close(() => resolve()));
  }

  return frontend;
}

export async function runScenarioS6TenKSubagents({
  server,
  twin,
  target,
  createKlient,
  WebSocket,
  runBrowser = true,
  stepTimeoutMs = 45_000,
  progress = (msg) => process.stderr.write(`[ccp-chaos] ${msg}\n`),
}) {
  const startedAt = performance.now();
  progress(
    `S6: 10,000-Subagent Extreme Scale + Playwright CDP Virtualization Benchmark (session=${target.sessionId}, subagents=${target.subagentCount}, state.json=${target.stateJsonMiB} MiB)...`,
  );

  const backend = await runBackendProtocolS6({
    server,
    target,
    createKlient,
    WebSocket,
    stepTimeoutMs,
    progress,
  });

  const frontend = runBrowser
    ? await runFrontendChromiumCdpS6({
        server,
        target,
        stepTimeoutMs,
        progress,
      })
    : null;

  backend.agentListToolTurn = await runAgentListToolProbe({
    server,
    twin,
    target,
    stepTimeoutMs,
    progress,
  });

  const backendPassed = Boolean(
    backend.coldBrowseSnapshotAndDrain?.fullyDrained &&
      (backend.coldBrowseSnapshotAndDrain?.segmentCallCount ?? 999) === 0 &&
      (backend.coldBrowseSnapshotAndDrain?.initialSubagents ?? 999) <= 200 &&
      (backend.coldBrowseSnapshotAndDrain?.agentCounts?.total ?? 0) === target.subagentCount &&
      backend.coldSubagentSearchApi?.endpointSupported &&
      backend.coldSubagentSearchApi?.allColdNeedlesFound &&
      backend.coldSubagentSearchApi.maxLatencyMs < 150 &&
      !backend.coldWsSubscribe?.timedOut &&
      backend.coldWsSubscribe?.ttfcMs !== null &&
      backend.coldWsSubscribe.ttfcMs < 2000 &&
      backend.coldSubagentDrillIn?.verifiedUniqueBody &&
      backend.coldSubagentDrillIn.klientPageMs < 2000 &&
      backend.agentListToolTurn?.ok &&
      backend.agentListToolTurn?.boundedUnder16KiB &&
      backend.agentListToolTurn?.boundedUnder50Rows,
  );

  const frontendPassed = !runBrowser
    ? true
    : Boolean(
        frontend &&
          !frontend.error &&
          frontend.pageErrors.length === 0 &&
          !frontend.step1_coldOpen?.timedOut &&
          !frontend.step1_coldOpen?.stuckPreparingDetected &&
          frontend.step1_coldOpen?.coldOpenFirstTurnMs !== null &&
          frontend.step1_coldOpen.coldOpenFirstTurnMs < 3000 &&
          (frontend.step1_coldOpen?.httpRequestsFirst5s?.total ?? 999) < 30 &&
          !frontend.step2_inspectorRoster?.timedOut &&
          frontend.step2_inspectorRoster?.foundColdNeedleA &&
          (frontend.step2_inspectorRoster?.renderedRosterRowsAfterExpand ?? 99999) <= 250 &&
          (frontend.step2_inspectorRoster?.cdpAfterExpand?.domNodes ?? 999999) < 25_000 &&
          !frontend.step3_agentFamilyPopover?.timedOut &&
          frontend.step3_agentFamilyPopover?.foundColdNeedleInPopover &&
          (frontend.step3_agentFamilyPopover?.popoverMountedItemsAfterFilter ?? 0) <= 200 &&
          !frontend.step4_cockpitMode?.timedOut &&
          !frontend.step5_switchAwayReclamation?.timedOut,
      );

  return {
    passed: backendPassed && frontendPassed,
    backendPassed,
    frontendPassed,
    stepTimeoutMs,
    wallMs: roundMs(performance.now() - startedAt),
    corpusSummary: {
      sessionId: target.sessionId,
      subagentCount: target.subagentCount,
      stateJsonMiB: target.stateJsonMiB,
      exceeds16MiBColdMetaCap: target.exceeds16MiBColdMetaCap,
      hierarchy: target.hierarchy,
      statuses: target.statuses,
      coldHistoricalNeedleIds: target.coldHistoricalNeedleIds,
    },
    backend,
    frontend,
  };
}
