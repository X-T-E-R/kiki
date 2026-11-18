import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SCRUBBED_ENV_KEYS = [
  'KIKI_DESKTOP_BUNDLED',
  'KIKI_RUNTIME_MANAGED',
  'KIKI_SQLITE_QUERY_WORKER_PATH',
  'KIKI_SQLITE_INDEXER_PATH',
  'KIKI_HISTORY_NAVIGATION_WORKER_ENTRY',
  'KIKI_SQLITE_INDEXER_SEA',
  'KIKI_USAGE_PARSER_WORKER_PATH',
  'KIKI_USAGE_READ_MODEL_WORKER_PATH',
  'KIKI_HOME',
  'KIMI_CODE_HOME',
  'NODE_OPTIONS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

function buildScrubbedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('KIKI_EXPERIMENTAL_')) {
      delete env[key];
    }
  }
  env.GH_HOST = '127.0.0.1:1';
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  env.NO_PROXY = '*';
  return { ...env, ...extra };
}

if (process.env.KIKI_PERF_HOME_TSX_READY !== '1') {
  const loaderUrl = pathToFileURL(path.join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href;
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=8192',
      '--import',
      'tsx/esm',
      '--import',
      loaderUrl,
      __filename,
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO_ROOT,
      env: buildScrubbedEnv({ KIKI_PERF_HOME_TSX_READY: '1' }),
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  process.exit(child.status ?? 1);
}

const { enableIndependentWorkerHeaps } = await import(
  '../packages/agent-core-v2/src/_base/node/workerHeapPolicy.ts'
);
enableIndependentWorkerHeaps();

const [
  { startServer },
  { ILogService, ISessionIndex, ISessionManager, ISessionSubagentService },
  { ErrorCode },
  { startMockSseProvider },
  { stageFullKikiHome },
  { EventLoopMonitor, assertZeroPii, formatSampleLabel, roundMs, summarizeSamples },
  { openTranscriptObserver, parseServerPhaseLogs },
] = await Promise.all([
  import('../packages/kap-server/src/start.ts'),
  import('../packages/agent-core-v2/src/index.ts'),
  import('../packages/kap-server/src/protocol/error-codes.ts'),
  import('./perf-home/mock-sse.mjs'),
  import('./perf-home/stage-home.mjs'),
  import('./perf-home/stats.mjs'),
  import('./perf-home/ws-observer.mjs'),
]);

function parseCliArgs(argv) {
  let outPath = null;
  let warmIters = 10;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      outPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--warm-iters' && argv[i + 1]) {
      warmIters = Math.max(3, Number(argv[i + 1]) || 10);
      i += 1;
    }
  }
  return { outPath, warmIters };
}

async function runBenchmark() {
  const { outPath, warmIters } = parseCliArgs(process.argv.slice(2));
  const progress = (msg) => process.stderr.write(`[perf-home] ${msg}\n`);
  const mockSse = await startMockSseProvider();
  const stageStarted = performance.now();
  const staged = await stageFullKikiHome({ mockBaseUrl: mockSse.baseUrl });
  const stagingMs = roundMs(performance.now() - stageStarted);
  progress(`staged ${staged.inventory.sessionsStaged} sessions across ${staged.inventory.workspacesRegistered} workspaces in ${stagingMs}ms`);

  const elMonitor = new EventLoopMonitor();
  let server;
  let wsObserver;
  let sourceMutations = -1;

  const report = {
    timestamp: new Date().toISOString(),
    stagingMs,
    inventory: staged.inventory,
    sampledTargets: {
      openFanout: staged.samples.openFanout.map((s, idx) => formatSampleLabel(idx + 1, s)),
      warmSend: staged.samples.warmSend ? formatSampleLabel(1, staged.samples.warmSend) : null,
      coldDurableSend: staged.samples.coldDurableSend
        ? formatSampleLabel(2, staged.samples.coldDurableSend)
        : null,
      coldSyncSend: staged.samples.coldSyncSend ? formatSampleLabel(3, staged.samples.coldSyncSend) : null,
    },
    homeSuite: {},
    sessionOpenSuite: {},
    promptSendSuite: {},
    serverPhases: {},
    safety: {
      mockSseRequests: 0,
      zeroAccidentalMaterialization: false,
      sourceMutations: -1,
    },
  };

  try {
    const serverEnv = buildScrubbedEnv({ KIKI_HOME: staged.stagedHome });
    elMonitor.resetWindow();
    const bootT0 = performance.now();
    server = await startServer({
      hostIdentity: {
        productName: 'kiki-perf-bench',
        version: '0.0.0-bench',
        platform: process.platform,
      },
      host: '127.0.0.1',
      port: 0,
      homeDir: staged.stagedHome,
      env: serverEnv,
      runtimeManaged: false,
      logLevel: 'silent',
    });
    server.core.accessor.get(ILogService).setLevel('debug');

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const authHeaders = {
      authorization: `Bearer ${server.localOwnerToken}`,
    };

    async function apiCall(method, urlPath, body, allowedCodes = [0]) {
      const t0 = performance.now();
      const headers = body === undefined ? authHeaders : { ...authHeaders, 'content-type': 'application/json' };
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      const elapsedMs = roundMs(performance.now() - t0);
      if (res.status !== 200 || !allowedCodes.includes(json.code)) {
        throw new Error(
          `${method} ${urlPath.split('?')[0].replace(/session_[A-Za-z0-9-]+/g, ':id')} failed: status=${res.status} code=${json.code} msg=${String(json.msg ?? '').slice(0, 80)}`,
        );
      }
      return { elapsedMs, body: json };
    }

    async function benchEndpoint(method, urlPath, body, iterations = warmIters, allowedCodes = [0]) {
      const cold = await apiCall(method, urlPath, body, allowedCodes);
      const warmSamples = [];
      for (let i = 0; i < iterations; i += 1) {
        const res = await apiCall(method, urlPath, body, allowedCodes);
        warmSamples.push(res.elapsedMs);
      }
      return {
        coldMs: cold.elapsedMs,
        warm: summarizeSamples(warmSamples),
      };
    }

    const healthz = await apiCall('GET', '/api/healthz');
    const coldBootToHealthzMs = roundMs(performance.now() - bootT0);

    const sessionsDuringPreparePromise = apiCall('GET', '/api/sessions?page_size=50', undefined, [
      0,
      ErrorCode.SESSION_INDEX_BUILDING,
    ]);
    const indexPrepareT0 = performance.now();
    const indexStatus = await server.core.accessor.get(ISessionIndex).prepare();
    const sessionIndexPrepareMs = roundMs(performance.now() - indexPrepareT0);
    const sessionsDuringPrepare = await sessionsDuringPreparePromise;

    report.homeSuite.startup = {
      coldBootToHealthzMs,
      healthzHttpMs: healthz.elapsedMs,
      sessionIndexPrepareMs,
      sessionIndexState: indexStatus.state,
      firstListDuringPrepareMs: sessionsDuringPrepare.elapsedMs,
      eventLoop: elMonitor.snapshot(),
    };

    elMonitor.resetWindow();
    report.homeSuite['GET /api/sessions?page_size=50'] = await benchEndpoint(
      'GET',
      '/api/sessions?page_size=50',
    );
    const burstT0 = performance.now();
    const burstResults = await Promise.all(
      Array.from({ length: 8 }, () => apiCall('GET', '/api/sessions?page_size=50')),
    );
    report.homeSuite['GET /api/sessions?page_size=50 (burst x8)'] = {
      wallMs: roundMs(performance.now() - burstT0),
      perRequest: summarizeSamples(burstResults.map((r) => r.elapsedMs)),
    };

    report.homeSuite['GET /api/sessions/query?page_size=50'] = await benchEndpoint(
      'GET',
      '/api/sessions/query?page_size=50',
    );
    report.homeSuite['GET /api/sessions/query?page_size=50&include=git'] = await benchEndpoint(
      'GET',
      '/api/sessions/query?page_size=50&include=git',
    );
    report.homeSuite['GET /api/personas/session-heads'] = await benchEndpoint(
      'GET',
      '/api/personas/session-heads?per_persona_limit=5',
    );
    report.homeSuite['GET /api/personas'] = await benchEndpoint('GET', '/api/personas');
    report.homeSuite['GET /api/workspaces'] = await benchEndpoint('GET', '/api/workspaces');
    report.homeSuite['GET /api/workspaces?view=catalog'] = await benchEndpoint(
      'GET',
      '/api/workspaces?view=catalog',
    );
    report.homeSuite['GET /api/models'] = await benchEndpoint('GET', '/api/models');
    if (staged.sampleWorkspaceId) {
      report.homeSuite['GET /api/agents/capabilities (workspace)'] = await benchEndpoint(
        'GET',
        `/api/agents/capabilities?workspace_id=${encodeURIComponent(staged.sampleWorkspaceId)}&profile=agent`,
      );
    }
    report.homeSuite['GET /api/mcp/servers'] = await benchEndpoint('GET', '/api/mcp/servers');
    report.homeSuite['GET /api/usage/realtime'] = await benchEndpoint('GET', '/api/usage/realtime');
    report.homeSuite['GET /api/usage/provider-quotas'] = await benchEndpoint(
      'GET',
      '/api/usage/provider-quotas',
    );
    report.homeSuite['GET /api/harness-quota'] = await benchEndpoint('GET', '/api/harness-quota');
    report.homeSuite['GET /api/usage (history summary)'] = await benchEndpoint(
      'GET',
      '/api/usage?range=all&granularity=day',
      undefined,
      6,
    );
    const giantAccountingTarget = staged.samples.openFanout[0];
    if (giantAccountingTarget) {
      report.homeSuite['GET /api/usage/sessions/:id/accounting (giant)'] = await benchEndpoint(
        'GET',
        `/api/usage/sessions/${encodeURIComponent(giantAccountingTarget.sessionId)}/accounting`,
        undefined,
        6,
      );
    }
    report.homeSuite['POST /api/search'] = await benchEndpoint(
      'POST',
      '/api/search',
      { query: 'function', page_size: 20 },
      8,
    );
    if (staged.defaultRepoCwd) {
      const createdArchiveProbe = await apiCall('POST', '/api/sessions', {
        title: 'Archive bench probe',
        metadata: { cwd: staged.defaultRepoCwd },
      });
      const probeSid = createdArchiveProbe.body.data.id;
      staged.forbiddenPiiTokens.add(probeSid);
      await server.core.accessor.get(ISessionManager).close(probeSid).catch(() => {});
      const archiveCold = await apiCall(
        'POST',
        `/api/sessions/${encodeURIComponent(probeSid)}:archive`,
        { include_attached: true },
      );
      await apiCall('POST', `/api/sessions/${encodeURIComponent(probeSid)}:restore`, {
        include_attached: true,
      });
      const archiveWarmSamples = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await apiCall(
          'POST',
          `/api/sessions/${encodeURIComponent(probeSid)}:archive`,
          { include_attached: true },
        );
        archiveWarmSamples.push(res.elapsedMs);
        await apiCall('POST', `/api/sessions/${encodeURIComponent(probeSid)}:restore`, {
          include_attached: true,
        });
      }
      await apiCall('POST', `/api/sessions/${encodeURIComponent(probeSid)}:archive`, {
        include_attached: true,
      });
      report.homeSuite['POST /api/sessions/:id:archive (family)'] = {
        coldMs: archiveCold.elapsedMs,
        warm: summarizeSamples(archiveWarmSamples),
      };
    }
    report.homeSuite.eventLoop = elMonitor.snapshot();
    progress(`suite 1 (home/global APIs) finished; indexPrepare=${sessionIndexPrepareMs}ms`);

    elMonitor.resetWindow();
    const sessionManager = server.core.accessor.get(ISessionManager);
    const coldFanoutWallSamples = [];
    const coldRouteSamples = {
      session: [],
      status: [],
      skills: [],
      tasks: [],
      goal: [],
      warnings: [],
      hooksObserve: [],
    };
    let allStayedCold = true;

    for (const sample of staged.samples.openFanout) {
      const sid = encodeURIComponent(sample.sessionId);
      assert.equal(sessionManager.get(sample.sessionId), undefined, 'Expected cold session before open fan-out');
      const fanoutT0 = performance.now();
      const [rSession, rStatus, rSkills, rTasks, rGoal, rWarnings, rHooks] = await Promise.all([
        apiCall('GET', `/api/sessions/${sid}`),
        apiCall('GET', `/api/sessions/${sid}/status`),
        apiCall('GET', `/api/sessions/${sid}/skills`),
        apiCall('GET', `/api/sessions/${sid}/tasks`),
        apiCall('GET', `/api/sessions/${sid}/goal`),
        apiCall('GET', `/api/sessions/${sid}/warnings`),
        apiCall('GET', `/api/sessions/${sid}/agents/main/hooks?observe=true`, undefined, [
          0,
          ErrorCode.SESSION_BUSY,
        ]),
      ]);
      coldFanoutWallSamples.push(roundMs(performance.now() - fanoutT0));
      coldRouteSamples.session.push(rSession.elapsedMs);
      coldRouteSamples.status.push(rStatus.elapsedMs);
      coldRouteSamples.skills.push(rSkills.elapsedMs);
      coldRouteSamples.tasks.push(rTasks.elapsedMs);
      coldRouteSamples.goal.push(rGoal.elapsedMs);
      coldRouteSamples.warnings.push(rWarnings.elapsedMs);
      coldRouteSamples.hooksObserve.push(rHooks.elapsedMs);

      if (sessionManager.get(sample.sessionId) !== undefined) {
        allStayedCold = false;
      }
    }

    const warmFanoutWallSamples = [];
    const primaryOpenSample = staged.samples.openFanout[0];
    if (primaryOpenSample) {
      const sid = encodeURIComponent(primaryOpenSample.sessionId);
      for (let i = 0; i < warmIters; i += 1) {
        const fanoutT0 = performance.now();
        await Promise.all([
          apiCall('GET', `/api/sessions/${sid}`),
          apiCall('GET', `/api/sessions/${sid}/status`),
          apiCall('GET', `/api/sessions/${sid}/skills`),
          apiCall('GET', `/api/sessions/${sid}/tasks`),
          apiCall('GET', `/api/sessions/${sid}/goal`),
          apiCall('GET', `/api/sessions/${sid}/warnings`),
          apiCall('GET', `/api/sessions/${sid}/agents/main/hooks?observe=true`, undefined, [
            0,
            ErrorCode.SESSION_BUSY,
          ]),
        ]);
        warmFanoutWallSamples.push(roundMs(performance.now() - fanoutT0));
        if (sessionManager.get(primaryOpenSample.sessionId) !== undefined) {
          allStayedCold = false;
        }
      }
    }

    report.safety.zeroAccidentalMaterialization = allStayedCold;
    assert.equal(allStayedCold, true, 'Read-only session-open routes materialized a cold session!');
    report.sessionOpenSuite = {
      coldBurstAcrossGiantSamples: summarizeSamples(coldFanoutWallSamples),
      warmBurstRepeat: summarizeSamples(warmFanoutWallSamples),
      coldByRoute: Object.fromEntries(
        Object.entries(coldRouteSamples).map(([k, arr]) => [k, summarizeSamples(arr)]),
      ),
      zeroAccidentalMaterialization: allStayedCold,
      eventLoop: elMonitor.snapshot(),
    };
    progress(`suite 2 (session-open 7-route fan-out) finished; cold p50=${report.sessionOpenSuite.coldBurstAcrossGiantSamples.p50Ms}ms`);

    elMonitor.resetWindow();
    wsObserver = await openTranscriptObserver(server.port, server.localOwnerToken);

    const newSessionCreateSamples = [];
    const newSessionReceiptSamples = [];
    const newSessionFirstDeltaSamples = [];
    const newSessionPromptIds = [];

    for (let i = 0; i < 5; i += 1) {
      const created = await apiCall('POST', '/api/sessions', {
        metadata: { cwd: staged.defaultRepoCwd },
        agent_config: { permission_mode: 'manual' },
      });
      newSessionCreateSamples.push(created.elapsedMs);
      const newSid = created.body.data.id;
      staged.forbiddenPiiTokens.add(newSid);
      await wsObserver.subscribeSession(newSid);

      const promptId = `bench-new-${i}-${randomUUID().slice(0, 8)}`;
      newSessionPromptIds.push(promptId);
      const sendT0 = performance.now();
      const watcher = wsObserver.watchPromptTurn(newSid, sendT0);
      const submitted = await apiCall('POST', `/api/sessions/${encodeURIComponent(newSid)}/prompts`, {
        prompt_id: promptId,
        content: [{ type: 'text', text: `Bench new session prompt ${i}` }],
      });
      newSessionReceiptSamples.push(submitted.elapsedMs);
      const firstDeltaMs = await watcher.waitFirstDelta();
      newSessionFirstDeltaSamples.push(firstDeltaMs);
      await watcher.waitTurnSettled();
    }

    report.promptSendSuite.newSessionFirstSend = {
      createSession: summarizeSamples(newSessionCreateSamples),
      httpReceipt: summarizeSamples(newSessionReceiptSamples),
      firstDelta: summarizeSamples(newSessionFirstDeltaSamples),
    };

    const attachEventsOnCreate = (targetSid) => {
      const sub = sessionManager.onDidCreateSession((ev) => {
        if (ev.sessionId !== targetSid) return;
        sub.dispose();
        void wsObserver?.subscribeEvents(targetSid).catch(() => {});
      });
      return sub;
    };

    const warmTarget = staged.samples.warmSend;
    const warmSyncPromptIds = [];
    const warmReceiptModePromptIds = [];
    const steerPromptIds = [];
    if (warmTarget) {
      const warmSid = warmTarget.sessionId;
      const warmSidEnc = encodeURIComponent(warmSid);
      progress(`warming mega session ${formatSampleLabel(1, warmTarget)}...`);

      const warmupSub = attachEventsOnCreate(warmSid);
      const warmupPromptId = `bench-warmup-${randomUUID().slice(0, 8)}`;
      const warmupT0 = performance.now();
      const warmupWatch = wsObserver.watchPromptTurn(warmSid, warmupT0);
      const warmupRes = await apiCall('POST', `/api/sessions/${warmSidEnc}/prompts`, {
        prompt_id: warmupPromptId,
        content: [{ type: 'text', text: 'Warmup turn.' }],
      });
      warmupSub.dispose();
      await wsObserver.subscribeEvents(warmSid);
      await warmupWatch.waitTurnSettled(60000).catch(() => {});
      progress(`warmup turn settled (cold HTTP=${warmupRes.elapsedMs}ms); running warm sync + receipt + steer loops...`);

      const warmReceiptSamples = [];
      const warmFirstDeltaSamples = [];
      for (let i = 0; i < 6; i += 1) {
        const promptId = `bench-warm-sync-${i}-${randomUUID().slice(0, 8)}`;
        warmSyncPromptIds.push(promptId);
        const sendT0 = performance.now();
        const watcher = wsObserver.watchPromptTurn(warmSid, sendT0);
        const res = await apiCall('POST', `/api/sessions/${warmSidEnc}/prompts`, {
          prompt_id: promptId,
          content: [{ type: 'text', text: `Warm large session message ${i}` }],
        });
        warmReceiptSamples.push(res.elapsedMs);
        const firstDeltaMs = await watcher.waitFirstDelta();
        warmFirstDeltaSamples.push(firstDeltaMs);
        await watcher.waitTurnSettled();
      }

      const fastReceiptModeSamples = [];
      const fastReceiptFirstDeltaSamples = [];
      for (let i = 0; i < 5; i += 1) {
        const promptId = `bench-warm-rcpt-${i}-${randomUUID().slice(0, 8)}`;
        warmReceiptModePromptIds.push(promptId);
        const sendT0 = performance.now();
        const watcher = wsObserver.watchPromptTurn(warmSid, sendT0);
        const res = await apiCall('POST', `/api/sessions/${warmSidEnc}/prompts?receipt=true`, {
          prompt_id: promptId,
          content: [{ type: 'text', text: `Warm receipt mode message ${i}` }],
        });
        fastReceiptModeSamples.push(res.elapsedMs);
        const firstDeltaMs = await watcher.waitFirstDelta();
        fastReceiptFirstDeltaSamples.push(firstDeltaMs);
        await watcher.waitTurnSettled();
      }

      const steerHttpSamples = [];
      for (let i = 0; i < 5; i += 1) {
        const gateId = `steer-gate-${i}-${randomUUID().slice(0, 6)}`;
        const gate = mockSse.prepareHoldGate(gateId);
        const bgPromptId = `bench-bg-${i}-${randomUUID().slice(0, 8)}`;
        const bgT0 = performance.now();
        const bgWatch = wsObserver.watchPromptTurn(warmSid, bgT0);
        const bgSubmitPromise = apiCall('POST', `/api/sessions/${warmSidEnc}/prompts?receipt=true`, {
          prompt_id: bgPromptId,
          content: [{ type: 'text', text: `Hold turn [PERF_HOLD_STREAM:${gateId}]` }],
        });
        await bgSubmitPromise;
        await gate.streamStarted;

        const steerPromptId = `bench-steer-${i}-${randomUUID().slice(0, 8)}`;
        steerPromptIds.push(steerPromptId);
        const steerRes = await apiCall('POST', `/api/sessions/${warmSidEnc}/prompts`, {
          prompt_id: steerPromptId,
          delivery_mode: 'steer',
          content: [{ type: 'text', text: `Steer immediate message ${i}` }],
        });
        steerHttpSamples.push(steerRes.elapsedMs);

        gate.release();
        await bgWatch.waitTurnSettled();
      }

      report.promptSendSuite.warmLargeSessionSend = {
        initialColdWarmupMs: warmupRes.elapsedMs,
        syncDefault: {
          httpReceipt: summarizeSamples(warmReceiptSamples),
          firstDelta: summarizeSamples(warmFirstDeltaSamples),
        },
        receiptMode: {
          httpReceipt: summarizeSamples(fastReceiptModeSamples),
          firstDelta: summarizeSamples(fastReceiptFirstDeltaSamples),
        },
      };
      report.promptSendSuite.busySteerSend = {
        httpReceipt: summarizeSamples(steerHttpSamples),
      };
      progress(`warm mega + steer finished; detaching WS & closing warm mega session to test fresh engine-v1 checkpoint cold reopen`);

      await wsObserver.unsubscribeSession(warmSid);
      const liveWarmHandle = sessionManager.get(warmSid);
      if (liveWarmHandle) {
        await liveWarmHandle.accessor.get(ISessionSubagentService).stopReceiptDiscovery().catch(() => {});
      }
      try {
        await sessionManager.close(warmSid);
      } catch (closeErr) {
        progress(`note: warmSid close deferred (${closeErr instanceof Error ? closeErr.message.slice(0, 60) : 'busy'})`);
      }
      if (sessionManager.get(warmSid) === undefined) {
        const ckptSub = attachEventsOnCreate(warmSid);
        const ckptPromptId = `bench-cold-ckpt-${randomUUID().slice(0, 8)}`;
        const ckptT0 = performance.now();
        const ckptWatcher = wsObserver.watchPromptTurn(warmSid, ckptT0);
        const ckptRes = await apiCall('POST', `/api/sessions/${warmSidEnc}/prompts`, {
          prompt_id: ckptPromptId,
          content: [{ type: 'text', text: 'Cold checkpointed mega-session message.' }],
        });
        ckptSub.dispose();
        await wsObserver.subscribeEvents(warmSid);
        const ckptFirstDeltaMs = await ckptWatcher.waitFirstDelta(30000).catch(() => ckptRes.elapsedMs);
        await ckptWatcher.waitTurnSettled(30000).catch(() => {});
        await wsObserver.unsubscribeSession(warmSid);
        report.promptSendSuite.coldCheckpointedMegaSyncSend = {
          httpReceiptMs: ckptRes.elapsedMs,
          firstDeltaMs: ckptFirstDeltaMs,
        };
        progress(`cold checkpointed mega sync send finished: httpReceipt=${ckptRes.elapsedMs}ms firstDelta=${ckptFirstDeltaMs}ms`);
      }
    }

    const coldDurableTarget = staged.samples.coldDurableSend;
    let coldDurablePromptId = null;
    if (coldDurableTarget && sessionManager.get(coldDurableTarget.sessionId) === undefined) {
      const sid = coldDurableTarget.sessionId;
      const sidEnc = encodeURIComponent(sid);
      coldDurablePromptId = `bench-cold-durable-${randomUUID().slice(0, 8)}`;
      const t0 = performance.now();
      const submitRes = await apiCall('POST', `/api/sessions/${sidEnc}/prompts`, {
        prompt_id: coldDurablePromptId,
        admission: 'durable',
        content: [{ type: 'text', text: 'Cold mega-session durable admission message.' }],
      });
      const durableReceiptMs = submitRes.elapsedMs;

      let admittedState = submitRes.body.data.admission;
      const pollDeadline = performance.now() + 75_000;
      while ((admittedState === 'restoring' || admittedState === 'waiting_switch') && performance.now() < pollDeadline) {
        await new Promise((r) => setTimeout(r, 40));
        const poll = await apiCall(
          'GET',
          `/api/sessions/${sidEnc}/prompts/${encodeURIComponent(coldDurablePromptId)}?admission=durable`,
        );
        admittedState = poll.body.data.admission;
      }
      const backgroundAdmittedMs = roundMs(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 150));

      report.promptSendSuite.coldMegaSessionDurableSend = {
        httpReceiptMs: durableReceiptMs,
        backgroundRestoreAndAdmitMs: backgroundAdmittedMs,
        finalAdmissionState: admittedState,
      };
      progress(`cold durable mega send finished: receipt=${durableReceiptMs}ms bg=${backgroundAdmittedMs}ms (${admittedState})`);
    }

    const coldSyncTarget = staged.samples.coldSyncSend;
    let coldSyncPromptId = null;
    if (coldSyncTarget && sessionManager.get(coldSyncTarget.sessionId) === undefined) {
      const sid = coldSyncTarget.sessionId;
      const sidEnc = encodeURIComponent(sid);
      const coldSub = attachEventsOnCreate(sid);
      coldSyncPromptId = `bench-cold-sync-${randomUUID().slice(0, 8)}`;
      const sendT0 = performance.now();
      const watcher = wsObserver.watchPromptTurn(sid, sendT0);
      const syncRes = await apiCall('POST', `/api/sessions/${sidEnc}/prompts`, {
        prompt_id: coldSyncPromptId,
        content: [{ type: 'text', text: 'Cold mega-session synchronous message.' }],
      });
      coldSub.dispose();
      await wsObserver.subscribeEvents(sid);
      const firstDeltaMs = await watcher.waitFirstDelta(30000).catch(() => syncRes.elapsedMs);
      await watcher.waitTurnSettled(30000).catch(() => {});
      await wsObserver.unsubscribeSession(sid);

      report.promptSendSuite.coldMegaSessionSyncSend = {
        httpReceiptMs: syncRes.elapsedMs,
        firstDeltaMs,
      };
      progress(`cold sync mega send finished: httpReceipt=${syncRes.elapsedMs}ms firstDelta=${firstDeltaMs}ms`);
    }

    for (const activeHandle of sessionManager.list()) {
      await activeHandle.accessor.get(ISessionSubagentService).stopReceiptDiscovery().catch(() => {});
    }

    report.promptSendSuite.eventLoop = elMonitor.snapshot();
    progress(`closing server...`);

    wsObserver.close();
    wsObserver = undefined;
    await server.close();
    server = undefined;
    progress(`server closed cleanly; parsing phase logs...`);

    const parsedLogs = parseServerPhaseLogs(staged.stagedHome);
    const summarizePromptPhases = (promptIds) => {
      const agg = new Map();
      for (const id of promptIds) {
        const entry = parsedLogs.byPromptId.get(id);
        if (!entry) continue;
        for (const [k, v] of Object.entries(entry)) {
          if (!agg.has(k)) agg.set(k, []);
          agg.get(k).push(v);
        }
      }
      return Object.fromEntries([...agg.entries()].map(([k, arr]) => [k, summarizeSamples(arr)]));
    };

    report.serverPhases = {
      newSessionPrompts: summarizePromptPhases(newSessionPromptIds),
      warmLargeSyncPrompts: summarizePromptPhases(warmSyncPromptIds),
      warmLargeReceiptModePrompts: summarizePromptPhases(warmReceiptModePromptIds),
      steerPrompts: summarizePromptPhases(steerPromptIds),
      coldDurableSessionPhases: coldDurableTarget
        ? (parsedLogs.bySessionId.get(coldDurableTarget.sessionId) ?? []).map(({ name, elapsedMs }) => ({
            phase: name,
            elapsedMs,
          }))
        : [],
      coldSyncSessionPhases: coldSyncTarget
        ? (parsedLogs.bySessionId.get(coldSyncTarget.sessionId) ?? []).map(({ name, elapsedMs }) => ({
            phase: name,
            elapsedMs,
          }))
        : [],
      coldSyncPromptSubphases: coldSyncPromptId ? parsedLogs.byPromptId.get(coldSyncPromptId) ?? {} : {},
    };
  } finally {
    elMonitor.close();
    try {
      wsObserver?.close();
    } catch {}
    if (server !== undefined) {
      try {
        await server.close();
      } catch {}
    }
    report.safety.mockSseRequests = mockSse.getRequestCount();
    await mockSse.close();
    sourceMutations = staged.teardown();
    report.safety.sourceMutations = sourceMutations;
  }

  assert.equal(sourceMutations, 0, `CRITICAL: sourceMutations=${sourceMutations} (expected 0)!`);

  const jsonText = JSON.stringify(report, null, 2);
  assertZeroPii(jsonText, staged.forbiddenPiiTokens);

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${jsonText}\n`, 'utf8');
  }

  printSummary(report, staged.forbiddenPiiTokens);
}

function printSummary(report, forbiddenTokens) {
  const lines = [];
  const inv = report.inventory;
  lines.push(
    `=== Kiki Full-Home API & Prompt-Send Perf ===`,
    `Corpus: home[sessions=${inv.sessionsStaged}, skipped=${inv.sessionsSkipped}, workspaces=${inv.workspacesRegistered}, gitRepos=${inv.tempGitRepos}, personas=${inv.personasStaged}, profiles=${inv.userProfilesStaged}, >=300MB=${inv.sessionsOver300MB}, maxState=${inv.maxStateKB}KB, maxAgents=${inv.maxAgents}] (staged in ${report.stagingMs}ms)`,
    `Targets: warm=${report.sampledTargets.warmSend} | coldDurable=${report.sampledTargets.coldDurableSend} | coldSync=${report.sampledTargets.coldSyncSend}`,
    ``,
    `--- 1. Startup & Global Home APIs ---`,
    `  Cold boot -> /api/healthz: ${report.homeSuite.startup.coldBootToHealthzMs}ms | ISessionIndex.prepare: ${report.homeSuite.startup.sessionIndexPrepareMs}ms (${report.homeSuite.startup.sessionIndexState}) | 1st /sessions during prepare: ${report.homeSuite.startup.firstListDuringPrepareMs}ms`,
  );

  for (const [name, val] of Object.entries(report.homeSuite)) {
    if (name === 'startup' || name === 'eventLoop') continue;
    if ('coldMs' in val) {
      lines.push(
        `  ${name.padEnd(46)} cold=${String(val.coldMs).padStart(7)}ms | warm p50=${String(val.warm.p50Ms).padStart(6)}ms p95=${String(val.warm.p95Ms).padStart(6)}ms max=${String(val.warm.maxMs).padStart(6)}ms`,
      );
    } else if ('wallMs' in val) {
      lines.push(
        `  ${name.padEnd(46)} wall=${String(val.wallMs).padStart(7)}ms | req  p50=${String(val.perRequest.p50Ms).padStart(6)}ms p95=${String(val.perRequest.p95Ms).padStart(6)}ms`,
      );
    }
  }
  lines.push(
    `  Home Suite EventLoop: p50=${report.homeSuite.eventLoop.p50Ms}ms p99=${report.homeSuite.eventLoop.p99Ms}ms max=${report.homeSuite.eventLoop.maxMs}ms elu=${report.homeSuite.eventLoop.elu}`,
    ``,
    `--- 2. Session-Open Auxiliary Fan-Out (7 routes parallel) ---`,
    `  Cold giant-session burst (x${report.sessionOpenSuite.coldBurstAcrossGiantSamples.count}): p50=${report.sessionOpenSuite.coldBurstAcrossGiantSamples.p50Ms}ms p95=${report.sessionOpenSuite.coldBurstAcrossGiantSamples.p95Ms}ms max=${report.sessionOpenSuite.coldBurstAcrossGiantSamples.maxMs}ms`,
    `  Warm giant-session burst (x${report.sessionOpenSuite.warmBurstRepeat.count}): p50=${report.sessionOpenSuite.warmBurstRepeat.p50Ms}ms p95=${report.sessionOpenSuite.warmBurstRepeat.p95Ms}ms max=${report.sessionOpenSuite.warmBurstRepeat.maxMs}ms`,
  );
  for (const [route, stat] of Object.entries(report.sessionOpenSuite.coldByRoute)) {
    lines.push(`    cold ${route.padEnd(14)} p50=${String(stat.p50Ms).padStart(6)}ms p95=${String(stat.p95Ms).padStart(6)}ms max=${String(stat.maxMs).padStart(6)}ms`);
  }
  lines.push(
    `  zeroAccidentalMaterialization=${report.sessionOpenSuite.zeroAccidentalMaterialization} | EventLoop max=${report.sessionOpenSuite.eventLoop.maxMs}ms`,
    ``,
    `--- 3. Prompt Sending Speed (Loopback Mock SSE, 0 External Calls) ---`,
  );
  const ps = report.promptSendSuite;
  if (ps.newSessionFirstSend) {
    lines.push(
      `  New session 1st send:   POST /sessions p50=${ps.newSessionFirstSend.createSession.p50Ms}ms | HTTP receipt p50=${ps.newSessionFirstSend.httpReceipt.p50Ms}ms p95=${ps.newSessionFirstSend.httpReceipt.p95Ms}ms | 1st delta p50=${ps.newSessionFirstSend.firstDelta.p50Ms}ms`,
    );
  }
  if (ps.warmLargeSessionSend) {
    lines.push(
      `  Warm mega sync send:    HTTP receipt p50=${ps.warmLargeSessionSend.syncDefault.httpReceipt.p50Ms}ms p95=${ps.warmLargeSessionSend.syncDefault.httpReceipt.p95Ms}ms | 1st delta p50=${ps.warmLargeSessionSend.syncDefault.firstDelta.p50Ms}ms p95=${ps.warmLargeSessionSend.syncDefault.firstDelta.p95Ms}ms`,
      `  Warm mega ?receipt=true: HTTP receipt p50=${ps.warmLargeSessionSend.receiptMode.httpReceipt.p50Ms}ms p95=${ps.warmLargeSessionSend.receiptMode.httpReceipt.p95Ms}ms | 1st delta p50=${ps.warmLargeSessionSend.receiptMode.firstDelta.p50Ms}ms p95=${ps.warmLargeSessionSend.receiptMode.firstDelta.p95Ms}ms`,
    );
  }
  if (ps.busySteerSend) {
    lines.push(
      `  Busy steer (Send now):  HTTP receipt p50=${ps.busySteerSend.httpReceipt.p50Ms}ms p95=${ps.busySteerSend.httpReceipt.p95Ms}ms max=${ps.busySteerSend.httpReceipt.maxMs}ms`,
    );
  }
  if (ps.coldCheckpointedMegaSyncSend) {
    lines.push(
      `  Cold mega (ckpt) send:  HTTP receipt=${ps.coldCheckpointedMegaSyncSend.httpReceiptMs}ms | 1st delta=${ps.coldCheckpointedMegaSyncSend.firstDeltaMs}ms`,
    );
  }
  if (ps.coldMegaSessionDurableSend) {
    lines.push(
      `  Cold mega durable send: HTTP receipt=${ps.coldMegaSessionDurableSend.httpReceiptMs}ms | bg restore+admit=${ps.coldMegaSessionDurableSend.backgroundRestoreAndAdmitMs}ms (${ps.coldMegaSessionDurableSend.finalAdmissionState})`,
    );
  }
  if (ps.coldMegaSessionSyncSend) {
    lines.push(
      `  Cold mega sync send:    HTTP receipt=${ps.coldMegaSessionSyncSend.httpReceiptMs}ms | 1st delta=${ps.coldMegaSessionSyncSend.firstDeltaMs}ms`,
    );
  }
  lines.push(
    `  Prompt Suite EventLoop: p50=${ps.eventLoop.p50Ms}ms p99=${ps.eventLoop.p99Ms}ms max=${ps.eventLoop.maxMs}ms elu=${ps.eventLoop.elu}`,
    ``,
    `--- 4. Server Internal Phase Breakdown ---`,
    `  Warm mega sync phases:  ${JSON.stringify(Object.fromEntries(Object.entries(report.serverPhases.warmLargeSyncPrompts).map(([k, v]) => [k, `${v.p50Ms}ms(p95:${v.p95Ms}ms)`])))}`,
    `  New session phases:     ${JSON.stringify(Object.fromEntries(Object.entries(report.serverPhases.newSessionPrompts).map(([k, v]) => [k, `${v.p50Ms}ms(p95:${v.p95Ms}ms)`])))}`,
    `  Cold sync restore:      ${JSON.stringify(report.serverPhases.coldSyncSessionPhases)}`,
    `  Cold sync subphases:    ${JSON.stringify(report.serverPhases.coldSyncPromptSubphases)}`,
    ``,
    `Safety: sourceMutations=${report.safety.sourceMutations} | mockSseRequests=${report.safety.mockSseRequests} | zeroAccidentalMaterialization=${report.safety.zeroAccidentalMaterialization}`,
  );

  const output = `${lines.join('\n')}\n`;
  assertZeroPii(output, forbiddenTokens);
  process.stdout.write(output);
}

await runBenchmark();
