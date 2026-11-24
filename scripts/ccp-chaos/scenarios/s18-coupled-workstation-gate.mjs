import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  collectTimelineIntegrity,
  drainTimeline,
  installTimelineMonitor,
  labelTimeline,
} from '../../../apps/kiki-gui/scripts/timeline-integrity.mjs';
import { ensureGuiStaticBuild } from '../../perf/browser-runner.mjs';
import { wheelAcrossUnloadedOlderPages } from '../../perf/trusted-scroll.mjs';
import { buildChaosConfigToml, qualifyGiantWireFixture } from '../corpus-generator.mjs';
import { evaluateS18CoupledWorkstationVerdict } from '../verify/verdict.mjs';
import { assertKapServerWebAssets } from '../web-assets-bridge.mjs';
import {
  auditCenterBarsOverflowAndControls,
  exerciseTallSystemReminderExpandCollapse,
  openFourColumnDesktopLayout,
  resizeCenterColumnToWidth,
  selectRunModeOnMain,
  verifyCssRootZoomAndViewport,
} from './s18-layout-probe.mjs';
import { runComposerSendAndSubagentSyncProbe } from './s18-composer-subagent-probe.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MiB = 1024 * 1024;
const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
const { chromium } = kapRequire('playwright');

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function roundMs(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function encodeToolPlan(plan) {
  return `[V23_TOOL_PLAN:${Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url')}]`;
}

async function apiJson(endpoint, token, method, urlPath, body, timeoutMs = 25_000) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      status: res.status,
      json,
      text,
      elapsedMs: roundMs(performance.now() - started),
    };
  } catch (error) {
    return {
      status: 0,
      json: null,
      text: '',
      error: String(error?.message ?? error),
      elapsedMs: roundMs(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForSessionIdle(endpoint, token, sessionId, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const res = await apiJson(endpoint, token, 'GET', `/api/sessions/${sessionId}`, undefined, 5_000);
    const data = res.json?.data;
    if (res.status === 200 && data && data.busy === false) {
      return { idle: true, lastTurnReason: data.last_turn_reason ?? data.lastTurnReason ?? null };
    }
    await sleep(60);
  }
  return { idle: false, lastTurnReason: 'timeout' };
}

async function submitAndWaitTurn(endpoint, token, sessionId, text, { agentId, profile, timeoutMs = 30_000 } = {}) {
  const res = await apiJson(
    endpoint,
    token,
    'POST',
    `/api/sessions/${sessionId}/prompts`,
    {
      content: [{ type: 'text', text }],
      ...(agentId ? { agent_id: agentId } : {}),
      ...(profile ? { profile } : {}),
    },
    timeoutMs,
  );
  if (res.status !== 200 || res.json?.code !== 0) {
    return { ok: false, status: res.status, error: res.json?.msg ?? res.error ?? res.text.slice(0, 240) };
  }
  const idle = await waitForSessionIdle(endpoint, token, sessionId, timeoutMs);
  return { ok: idle.idle, lastTurnReason: idle.lastTurnReason, elapsedMs: res.elapsedMs };
}

export function resolveS18Config(mode = 'coupled-release') {
  const isSmoke = mode === 'smoke';
  return Object.freeze({
    mode: isSmoke ? 'smoke' : 'coupled-release',
    releaseEligible: !isSmoke,
    fixture: Object.freeze({
      minWireBytes: isSmoke ? 12 * MiB : 256 * MiB,
      minDistinctTurns: isSmoke ? 150 : 300,
    }),
    residency: Object.freeze({
      materializedSessions: 24,
      maxLiveSessions: 16,
      maxConcurrentRestores: 4,
      idleTtlMs: 2_000,
      minIdleMs: 500,
      sweepIntervalMs: 1_000,
    }),
    liveStream: Object.freeze({
      tickCadenceMs: 100,
      minCommittedTicks: 10,
      minWsOpsFrames: 4,
    }),
    layout: Object.freeze({
      viewportWidth: 1680,
      viewportHeight: 900,
      deviceScaleFactor: 2,
      cssZoom: 1.25,
      centerWidthsPx: Object.freeze([480, 360]),
      requiredRunMode: 'plan',
    }),
    pagination: Object.freeze({
      requiredPages: 3,
      pageBudgetMs: 500,
      wheelDeltaY: -1200,
    }),
    foregroundService: Object.freeze({
      trials: 2,
      admissionBudgetMs: 500,
    }),
    composerSendAndSubagentSync: Object.freeze({
      composerClearOrEchoP95Ms: 100,
      promptHttpAckP95Ms: 500,
      subagentStatusSyncP95Ms: 500,
    }),
    eld: Object.freeze({
      rawMaxBudgetMs: 100,
      cooldownMs: 160,
    }),
  });
}

function seedHomeACanaryProfile(homeDir) {
  const agentsDir = path.join(homeDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const canaryPath = path.join(agentsDir, 'canary-home-a.md');
  fs.writeFileSync(
    canaryPath,
    [
      '---',
      'name: canary_home_a',
      'description: Public canary profile owned exclusively by Home A.',
      '---',
      '',
      'You are the Home A public canary profile. Marker: HOME_A_CANARY_PROFILE_ONLY.',
      '',
    ].join('\n'),
    'utf8',
  );
  return { name: 'canary_home_a', path: canaryPath };
}

function seedHomeBProfiles(homeBDir) {
  const agentsDir = path.join(homeBDir, 'agents');
  const privateDir = path.join(agentsDir, '_private');
  fs.mkdirSync(privateDir, { recursive: true });

  const privateWorkerPath = path.join(privateDir, 'worker.md');
  fs.writeFileSync(
    privateWorkerPath,
    [
      '---',
      'name: private_worker',
      'description: Private worker scoped strictly to Home B owner.',
      'private: true',
      'can_spawn_subagents: false',
      'model_alias: twin-anthropic',
      'thinking_effort: high',
      '---',
      '',
      'You are the Home B private child worker. Exclusive marker: HOME_B_PRIVATE_MARKER_ONLY.',
      '',
    ].join('\n'),
    'utf8',
  );

  const ownerPath = path.join(agentsDir, 'b-owner.md');
  fs.writeFileSync(
    ownerPath,
    [
      '---',
      'name: b_owner',
      'description: Public Home B owner referencing scoped ./_private/worker.md child.',
      'model_alias: twin-anthropic',
      'thinking_effort: high',
      'allowed_subagents:',
      '  - name: private_worker',
      '    source: ./_private/worker.md',
      '---',
      '',
      'You are the Home B public owner profile. Dispatch private_worker when asked.',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    ownerName: 'b_owner',
    ownerPath,
    privateName: 'private_worker',
    privatePath: privateWorkerPath,
    privateMarker: 'HOME_B_PRIVATE_MARKER_ONLY',
  };
}

async function listPublicAgentNames(endpoint, token) {
  const res = await apiJson(endpoint, token, 'GET', '/api/agents?unscoped=true', undefined, 10_000);
  if (res.status !== 200 || res.json?.code !== 0) {
    return { ok: false, names: [], error: res.json?.msg ?? res.error ?? `HTTP ${res.status}` };
  }
  const raw = res.json?.data;
  const items = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.profiles)
        ? raw.profiles
        : Array.isArray(raw?.agents)
          ? raw.agents
          : [];
  const names = items.map((item) => item?.name).filter((n) => typeof n === 'string');
  return { ok: true, names };
}

/**
 * Scenario S18: Coupled Workstation Release Stress Gate.
 * Implements all 7 coupled invariants under one controller, one signed-off run,
 * and two isolated real homes with zero fake-green shortcuts.
 */
export async function runScenarioS18CoupledWorkstationGate({
  server,
  spawnServer,
  twin,
  corpus,
  workRoot,
  mode = 'coupled-release',
  webAssetsDir = null,
  progress = () => {},
}) {
  const cfg = resolveS18Config(mode);
  const runId = `s18_${cfg.mode}_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const startedAt = performance.now();
  const receiptDir = path.join(workRoot, 's18-receipt-bundle');
  const screenshotsDir = path.join(receiptDir, 'screenshots');
  fs.rmSync(receiptDir, { recursive: true, force: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const resolvedWebAssetsDir = webAssetsDir ?? ensureGuiStaticBuild().distDir;
  await assertKapServerWebAssets(server.endpoint);
  const deepLinkFor = (srv, routePath) => {
    const sep = routePath.includes('?') ? '&' : '?';
    return `${srv.endpoint}${routePath}${sep}server=${encodeURIComponent(srv.endpoint)}&token=${encodeURIComponent(srv.token)}`;
  };

  // Seed Home A public canary profile BEFORE reading catalogs
  const homeACanary = seedHomeACanaryProfile(corpus.homeDir);

  const report = {
    runId,
    mode: cfg.mode,
    releaseEligible: cfg.releaseEligible,
    verdictClass: cfg.mode,
    platform: process.platform,
    candidate: {
      homeAEndpoint: server.endpoint,
      homeAPid: server.pid,
      homeAId: server.identity?.homeId ?? null,
      webAssetsDir: resolvedWebAssetsDir,
    },
    fixture: null,
    residency: null,
    simultaneity: null,
    layoutAndTimeline: null,
    pagination: null,
    foregroundService: null,
    serverAEld: null,
    heartbeatWatchdog: null,
    isolatedHomeB: null,
    screenshots: [],
    receiptBundleDir: receiptDir,
    elapsedMs: null,
    fatalError: null,
  };

  let browser = null;
  let serverB = null;
  let stopTickProducer = false;
  let tickTimer = null;
  let tickLoop = null;
  let stopHeartbeat = false;
  let heartbeatPromise = null;
  let stopBgContention = false;
  let bgContentionPromise = null;

  try {
    // =========================================================================
    // 1. QUALIFY THE FIXTURE ON DISK (NOT TRUSTING GENERATOR COUNTERS)
    // =========================================================================
    progress(
      `S18 [1/7] (${cfg.mode}): Qualifying staged giant wire on disk (>=${Math.round(cfg.fixture.minWireBytes / MiB)} MiB, >=${cfg.fixture.minDistinctTurns} distinct turns)...`,
    );
    const qualified = qualifyGiantWireFixture(corpus.giantMainWirePath, {
      minBytes: cfg.fixture.minWireBytes,
      minDistinctTurns: cfg.fixture.minDistinctTurns,
    });
    const manifestOutPath = path.join(receiptDir, 'fixture-manifest.json');
    fs.writeFileSync(
      manifestOutPath,
      `${JSON.stringify({
        wirePath: qualified.wirePath,
        actualBytes: qualified.actualBytes,
        distinctTurnCount: qualified.distinctTurnCount,
        duplicateTurnIds: qualified.duplicateTurnIds,
        tallReminderCount: qualified.tallReminderCount,
        turnCount: qualified.turns.length,
        oldestTurnsSample: qualified.turns.slice(0, 10),
        newestTurnsSample: qualified.turns.slice(-10),
      }, null, 2)}\n`,
      'utf8',
    );
    report.fixture = {
      ok: qualified.ok,
      wirePath: qualified.wirePath,
      manifestPath: manifestOutPath,
      actualBytes: qualified.actualBytes,
      minRequiredBytes: cfg.fixture.minWireBytes,
      distinctTurnCount: qualified.distinctTurnCount,
      minRequiredTurns: cfg.fixture.minDistinctTurns,
      duplicateTurnCount: qualified.duplicateTurnIds.length,
      tallReminderCount: qualified.tallReminderCount,
      nonemptyTailSlot: qualified.nonemptyTailSlot,
      failures: qualified.failures,
    };

    // =========================================================================
    // 2. RESIDENCY & BACKGROUND RESTORE CONTENTION (24 MATERIALIZED SESSIONS)
    // =========================================================================
    progress(
      `S18 [2/7]: Materializing ${cfg.residency.materializedSessions} nonempty sessions on Home A (max_live=${cfg.residency.maxLiveSessions}, max_restores=${cfg.residency.maxConcurrentRestores}) & witnessing automatic eviction...`,
    );
    const materializedIds = [];
    for (let i = 0; i < cfg.residency.materializedSessions; i += 1) {
      const created = await apiJson(server.endpoint, server.token, 'POST', '/api/sessions', {
        title: `S18 Residency Session #${String(i + 1).padStart(2, '0')} (${runId})`,
        metadata: { cwd: corpus.workspaceDir },
      });
      if (created.status !== 200 || created.json?.code !== 0 || !created.json?.data?.id) {
        throw new Error(`Failed creating residency session #${i + 1}: ${JSON.stringify(created)}`);
      }
      materializedIds.push(created.json.data.id);
    }

    // Materialize nonempty wire & agent state on every one of the 24 sessions in bounded batches
    let materializedOkCount = 0;
    for (let start = 0; start < materializedIds.length; start += 6) {
      const batch = materializedIds.slice(start, start + 6);
      const batchResults = await Promise.all(
        batch.map((sid, idx) =>
          submitAndWaitTurn(
            server.endpoint,
            server.token,
            sid,
            `[CHAOS_SCOPE:s18_mat_${runId}_${start + idx}] Materialize nonempty session ${sid} turn 1.`,
            { timeoutMs: 25_000 },
          ),
        ),
      );
      materializedOkCount += batchResults.filter((r) => r.ok).length;
    }
    if (materializedOkCount < materializedIds.length) {
      throw new Error(`S18 residency materialization incomplete: ${materializedOkCount}/${materializedIds.length} turns completed`);
    }

    const peakMetrics = await server.metrics(false);
    let postSweepMetrics = peakMetrics;
    for (let poll = 0; poll < 24; poll += 1) {
      await sleep(350);
      postSweepMetrics = await server.metrics(false);
      const liveNow = postSweepMetrics.liveSessionCount ?? Infinity;
      const evSuccess = postSweepMetrics.residencyReport?.evictionSuccesses ?? 0;
      if (evSuccess > 0 && liveNow <= cfg.residency.maxLiveSessions) {
        break;
      }
    }

    const liveSet = new Set(postSweepMetrics.liveSessionIds ?? []);
    const evictedIds = materializedIds.filter((sid) => !liveSet.has(sid));
    const foregroundTargets = evictedIds.slice(0, cfg.foregroundService.trials);
    const backgroundTargets = evictedIds.slice(cfg.foregroundService.trials);
    // Keep one resident driver session for ThreadRead calls against evicted background targets
    const threadReadDriverSid = materializedIds.find((sid) => liveSet.has(sid)) ?? materializedIds.at(-1);

    // Seed real Cron tasks on evicted background targets so real Cron fires restore them
    const seededCronTasks = [];
    for (const bgSid of backgroundTargets.slice(0, 6)) {
      const cronRes = await apiJson(server.endpoint, server.token, 'POST', '/api/cron', {
        session_id: bgSid,
        cron: '*/5 * * * *',
        prompt: `[CHAOS_SCOPE:s18_cron_${runId}_${bgSid}] Background cron restore check for ${bgSid}.`,
        recurring: true,
        paused: false,
      });
      if (cronRes.status === 200 && cronRes.json?.code === 0 && cronRes.json?.data?.task?.id) {
        seededCronTasks.push({ taskId: cronRes.json.data.task.id, sessionId: bgSid });
      }
    }

    report.residency = {
      materializedCount: materializedIds.length,
      effectiveMaxLiveSessions: postSweepMetrics.restoreQueueSnapshot?.maxLiveSessions ?? null,
      effectiveMaxConcurrentRestores: postSweepMetrics.restoreQueueSnapshot?.maxConcurrentRestores ?? null,
      peakLiveSessions: peakMetrics.liveSessionCount,
      postEvictLiveSessions: postSweepMetrics.liveSessionCount,
      evictionAttempts: postSweepMetrics.residencyReport?.evictionAttempts ?? 0,
      evictionSuccesses: postSweepMetrics.residencyReport?.evictionSuccesses ?? 0,
      evictedSessionCount: evictedIds.length,
      evictedForegroundTargets: foregroundTargets,
      backgroundContentionTargetCount: backgroundTargets.length,
      seededCronTaskCount: seededCronTasks.length,
      backgroundRestoreWitness: {
        cronFiresTriggered: 0,
        cronFiresSucceeded: 0,
        threadReadsTriggered: 0,
        threadReadsSucceeded: 0,
        maxObservedActiveRestores: 0,
        maxObservedQueuedRestores: 0,
        witnessedActiveAndWaiting: false,
        samples: [],
      },
    };

    // =========================================================================
    // 3. START LIVE 100ms WRITER ON 256 MiB MAIN + EXTERNAL HEALTH WATCHDOG
    // =========================================================================
    progress('S18 [3/7]: Launching Playwright (1360x860 zh-CN, CSS zoom 1.25) on cold giant session & starting 100ms live producer clock...');

    // Start external HTTP /api/healthz watchdog for Home A
    const watchdog = {
      samples: 0,
      failures: 0,
      maxLatencyMs: 0,
      failureDetails: [],
    };
    heartbeatPromise = (async () => {
      while (!stopHeartbeat) {
        const h = await apiJson(server.endpoint, server.token, 'GET', '/api/healthz', undefined, 3_000);
        watchdog.samples += 1;
        if (h.status === 200 && (h.json?.ok === true || h.json?.code === 0 || h.json?.data?.ok === true)) {
          if (h.elapsedMs > watchdog.maxLatencyMs) watchdog.maxLatencyMs = h.elapsedMs;
        } else {
          watchdog.failures += 1;
          if (watchdog.failureDetails.length < 10) {
            watchdog.failureDetails.push({ status: h.status, elapsedMs: h.elapsedMs, error: h.error ?? null });
          }
        }
        await sleep(250);
      }
    })();

    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const context = await browser.newContext({
      viewport: { width: cfg.layout.viewportWidth, height: cfg.layout.viewportHeight },
      deviceScaleFactor: cfg.layout.deviceScaleFactor,
      locale: 'zh-CN',
      reducedMotion: 'no-preference',
    });

    await context.addInitScript((zoomPct) => {
      try {
        localStorage.setItem('kiki.locale', 'zh');
        localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
        const prev = JSON.parse(localStorage.getItem('kiki.settings') || '{}');
        localStorage.setItem('kiki.settings', JSON.stringify({ ...prev, uiZoom: zoomPct }));
      } catch {}
    }, Math.round(cfg.layout.cssZoom * 100));

    const page = await context.newPage();
    await installTimelineMonitor(page);

    const pageErrors = [];
    const wsOpsFrames = [];
    page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err).slice(0, 300)));
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        if (typeof frame.payload !== 'string') return;
        if (!frame.payload.includes('transcript.ops')) return;
        if (!frame.payload.includes(corpus.giantSessionId)) return;
        wsOpsFrames.push({
          atMs: performance.now(),
          bytes: frame.payload.length,
          matchesGiant: true,
        });
      });
    });

    // Open cold giant main session in browser
    await page.goto(deepLinkFor(server, `/s/${corpus.giantSessionId}`), {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 30_000 });
    await sleep(300);

    // Wait for product settings sync to apply CSS root zoom 1.25 (never fake-inject style.zoom!)
    let zoomCheck = await verifyCssRootZoomAndViewport(page, cfg.layout.cssZoom);
    const zoomDeadline = performance.now() + 3_000;
    while (!zoomCheck.ok && performance.now() < zoomDeadline) {
      await sleep(100);
      zoomCheck = await verifyCssRootZoomAndViewport(page, cfg.layout.cssZoom);
    }
    zoomCheck = { ...zoomCheck, productApplied: zoomCheck.ok };

    // Select Plan mode & open all 4 desktop columns (Sidebar + Center + Preview + Rail)
    // BEFORE starting the 10 Hz live stream so clicking a file in Right Rail `动态` isn't
    // raced by 100ms list prepends; all 4 columns stay open simultaneously throughout streaming!
    const runModeResult = await selectRunModeOnMain(page, cfg.layout.requiredRunMode);
    const fourColOpen = await openFourColumnDesktopLayout(page);

    // Reset Home A ELD histogram right before the live coupled scored epoch begins!
    await server.resetWindow();
    const initialWireBytes = fs.statSync(corpus.giantMainWirePath).size;

    // Start independent 100ms producer clock driving real twin live tick loop on giant main session
    const tickLoopId = `coupled_${runId}`;
    tickLoop = twin.createTickLoop(tickLoopId);
    let offeredTickSeq = 0;
    const wireGrowthSamples = [{ label: 'pre-stream', atMs: performance.now(), bytes: initialWireBytes }];

    // Launch the live tick loop turn on the displayed giant main session (do NOT await completion yet)
    const liveLoopTurnPromise = apiJson(
      server.endpoint,
      server.token,
      'POST',
      `/api/sessions/${corpus.giantSessionId}/prompts`,
      {
        content: [
          {
            type: 'text',
            text: `[CHAOS_SCOPE:s18_live_main_${runId}] [COUPLED_TICK_LOOP:id=${tickLoopId},maxSteps=900] Continuous 100ms live workstation stream.`,
          },
        ],
      },
      120_000,
    );

    tickTimer = setInterval(() => {
      if (stopTickProducer) return;
      offeredTickSeq += 1;
      tickLoop.offerTick(offeredTickSeq);
    }, cfg.liveStream.tickCadenceMs);

    // Wait until wire.jsonl actually grows AND browser WS receives live transcript.ops
    const preStreamDeadline = performance.now() + 12_000;
    while (performance.now() < preStreamDeadline) {
      const curBytes = fs.statSync(corpus.giantMainWirePath).size;
      const loopStats = tickLoop.getStats();
      if (curBytes > initialWireBytes && loopStats.consumedCount >= 2 && wsOpsFrames.length >= 2) {
        break;
      }
      await sleep(80);
    }
    const afterStartWireBytes = fs.statSync(corpus.giantMainWirePath).size;
    const wsOpsBeforeInteractions = wsOpsFrames.length;
    wireGrowthSamples.push({ label: 'stream-active', atMs: performance.now(), bytes: afterStartWireBytes });

    // =========================================================================
    // 4. SIMULTANEOUS 4-COLUMN + 1.25 ZOOM + BAR OVERFLOW + TALL REMINDER + 3 WHEEL PAGES
    // =========================================================================
    progress('S18 [4/7]: Auditing 4-column desktop @ 1.25 zoom (480px & 360px), tall reminder expand/collapse, & 3 unloaded upward wheel pages under active 100ms stream...');

    // Re-check 4-column open if Preview tab wasn't yet available prior to stream ticks
    const fourColLive = fourColOpen.ok ? fourColOpen : await openFourColumnDesktopLayout(page);

    // Drain timeline monitor and exercise tall <system-reminder> expand/collapse FIRST while
    // the 100ms live stream is active and tail Turn 169's tall reminder is still near the bottom!
    await drainTimeline(page);
    await labelTimeline(page, 's18:live-reminder-burst');
    const reminderResult = await exerciseTallSystemReminderExpandCollapse(page, { holdExpandedMs: 500 });
    await sleep(300);
    const liveTimelineIntegrity = await collectTimelineIntegrity(page, { frames: 4, timeoutMs: 2_000 });
    if (liveTimelineIntegrity.failures.length > 0) {
      const failShot = path.join(screenshotsDir, 'timeline-overlap-first-offending.png');
      await page.screenshot({ path: failShot, fullPage: false }).catch(() => undefined);
      report.screenshots.push(failShot);
    }

    const widthAudits = [];
    for (const targetWidthPx of cfg.layout.centerWidthsPx) {
      const resized = await resizeCenterColumnToWidth(page, targetWidthPx);
      await sleep(180);
      const barAudit = await auditCenterBarsOverflowAndControls(page, {
        expectedRunMode: cfg.layout.requiredRunMode,
      });
      const shotPath = path.join(screenshotsDir, `4col-center-${targetWidthPx}px.png`);
      await page.screenshot({ path: shotPath, fullPage: false }).catch(() => undefined);
      report.screenshots.push(shotPath);
      widthAudits.push({
        targetLayoutWidthPx: targetWidthPx,
        cssMinWidthPx: resized.cssMinWidthPx,
        achievedLayoutWidthPx: resized.achievedLayoutWidthPx,
        achievedScaledWidthPx: resized.achievedScaledWidthPx,
        viewportWidthPx: resized.viewportWidthPx,
        fourColumnsOk: resized.fourColumns.ok,
        fourColumnsFailures: resized.fourColumns.failures,
        barAudit,
        screenshotPath: shotPath,
      });
    }

    wireGrowthSamples.push({
      label: 'before-wheel-pagination',
      atMs: performance.now(),
      bytes: fs.statSync(corpus.giantMainWirePath).size,
    });
    const wsOpsBeforePagination = wsOpsFrames.length;

    // 3 successive unloaded older pages via real trusted page.mouse.wheel(0, -1200)
    await labelTimeline(page, 's18:live-wheel-pagination');
    const paginationResult = await wheelAcrossUnloadedOlderPages(page, {
      requiredPages: cfg.pagination.requiredPages,
      pageBudgetMs: cfg.pagination.pageBudgetMs,
      deltaY: cfg.pagination.wheelDeltaY,
    });
    const postWheelTimeline = await collectTimelineIntegrity(page, { frames: 4, timeoutMs: 2_000 });
    if (!paginationResult.ok) {
      const wheelShot = path.join(screenshotsDir, 'pagination-failure.png');
      await page.screenshot({ path: wheelShot, fullPage: false }).catch(() => undefined);
      report.screenshots.push(wheelShot);
    }

    wireGrowthSamples.push({
      label: 'after-wheel-pagination',
      atMs: performance.now(),
      bytes: fs.statSync(corpus.giantMainWirePath).size,
    });
    const wsOpsAfterPagination = wsOpsFrames.length;

    report.layoutAndTimeline = {
      zoomCheck,
      fourColumnsInitial: fourColLive,
      runModeResult,
      widthAudits,
      reminderExpandCollapse: reminderResult,
      liveTimelineIntegrity,
      postWheelTimeline,
      pageErrors,
    };
    report.pagination = paginationResult;

    // =========================================================================
    // 5. FOREGROUND INTERACTIVE PROMPT SERVICE UNDER EVICTION & RESTORE PRESSURE
    // =========================================================================
    progress(
      `S18 [5/7]: Driving background Cron + ThreadRead restore contention while submitting ${cfg.foregroundService.trials} real GUI foreground prompts into verified evicted sessions...`,
    );

    const witness = report.residency.backgroundRestoreWitness;
    // Start continuous background restore contention (Cron fires + ThreadRead tool storm + evicted reads)
    bgContentionPromise = (async () => {
      let round = 0;
      while (!stopBgContention) {
        round += 1;
        const burstOps = [];
        // Trigger real Cron task fires against evicted background targets
        for (const ct of seededCronTasks) {
          witness.cronFiresTriggered += 1;
          burstOps.push(
            apiJson(
              server.endpoint,
              server.token,
              'POST',
              `/api/cron/${encodeURIComponent(ct.taskId)}:run?session_id=${encodeURIComponent(ct.sessionId)}`,
              {},
              15_000,
            ).then((r) => {
              if (r.status === 200 && r.json?.code === 0) witness.cronFiresSucceeded += 1;
            }),
          );
        }
        // Also drive real ThreadRead calls from the resident driver session targeting evicted sessions
        const targetBg = backgroundTargets[round % Math.max(1, backgroundTargets.length)];
        if (targetBg && threadReadDriverSid) {
          witness.threadReadsTriggered += 1;
          const trPlan = encodeToolPlan({
            steps: [
              {
                calls: [{ name: 'ThreadRead', input: { thread: { session_id: targetBg } } }],
              },
            ],
            finalText: `S18_THREAD_READ_OK_${targetBg}`,
          });
          burstOps.push(
            apiJson(
              server.endpoint,
              server.token,
              'POST',
              `/api/sessions/${threadReadDriverSid}/prompts`,
              {
                content: [{ type: 'text', text: `[CHAOS_SCOPE:s18_tr_${runId}_${round}] ${trPlan}` }],
              },
              20_000,
            ).then((r) => {
              if (r.status === 200 && r.json?.code === 0) witness.threadReadsSucceeded += 1;
            }),
          );
        }
        // Sample restore queue while burst is in flight!
        const sampler = (async () => {
          for (let s = 0; s < 12 && !stopBgContention; s += 1) {
            const m = await server.metrics(false).catch(() => null);
            const active = m?.restoreQueueSnapshot?.activeRestores ?? 0;
            const queued = m?.restoreQueueSnapshot?.queuedRestores ?? 0;
            const pending = m?.residencyReport?.pendingRestores ?? 0;
            if (active > witness.maxObservedActiveRestores) witness.maxObservedActiveRestores = active;
            if (queued > witness.maxObservedQueuedRestores) witness.maxObservedQueuedRestores = queued;
            if (active > 0 && (queued > 0 || pending > 0)) {
              witness.witnessedActiveAndWaiting = true;
            }
            if (witness.samples.length < 60 && (active > 0 || queued > 0 || pending > 0)) {
              witness.samples.push({ atMs: roundMs(performance.now() - startedAt), active, queued, pending });
            }
            await sleep(25);
          }
        })();
        await Promise.allSettled([...burstOps, sampler]);
        await sleep(40);
      }
    })();

    // Give background restore burst a brief head start so restore slots are actively contended
    await sleep(220);

    const foregroundTrials = [];
    for (let t = 0; t < foregroundTargets.length; t += 1) {
      const targetSid = foregroundTargets[t];
      const page2 = await context.newPage();
      let durableReceiptMs = null;
      let durablePromptId = null;
      let durableQueuePos = null;
      const fgNonce = `S18_FG_NONCE_${t + 1}_${randomUUID().slice(0, 8)}`;

      page2.on('response', async (res) => {
        if (res.request().method() !== 'POST') return;
        if (!res.url().includes(`/api/sessions/${targetSid}/prompts`)) return;
        const body = await res.json().catch(() => null);
        if (body?.data?.prompt_id || body?.data?.id) {
          durablePromptId = body.data.prompt_id ?? body.data.id;
        }
        if (body?.data?.restore_progress?.queue_position !== undefined) {
          durableQueuePos = body.data.restore_progress.queue_position;
        }
      });

      try {
        await page2.goto(deepLinkFor(server, `/s/${targetSid}`), {
          waitUntil: 'domcontentloaded',
          timeout: 25_000,
        });
        const input = page2.locator('[data-composer-input]').first();
        await input.waitFor({ state: 'visible', timeout: 15_000 });
        await sleep(120);

        // Verify eviction & restore contention RIGHT BEFORE submit (proving cold open did not eagerly restore!)
        const preSubmitMetrics = await server.metrics(false);
        const verifiedEvictedBeforeSubmit = !(preSubmitMetrics.liveSessionIds ?? []).includes(targetSid);
        const restoreContentionAtSubmit = {
          activeRestores: preSubmitMetrics.restoreQueueSnapshot?.activeRestores ?? 0,
          queuedRestores: preSubmitMetrics.restoreQueueSnapshot?.queuedRestores ?? 0,
          pendingRestores: preSubmitMetrics.residencyReport?.pendingRestores ?? 0,
        };
        const assistantCountBefore = await page2.evaluate(
          () => document.querySelectorAll('[data-transcript-scroll] [data-block-id^="agent-frame-"], [data-transcript-scroll] [data-block-id^="assistant-"]').length,
        );

        await input.click({ timeout: 5_000 });
        await page2.keyboard.insertText(`[CHAOS_SCOPE:s18_fg_${runId}_${t}] ${fgNonce} Foreground interactive admission check.`);
        await sleep(40);

        const traceLenBefore = twin.getRequestTrace().length;
        const submitT0 = performance.now();
        const promptRespPromise = page2
          .waitForResponse(
            (r) => r.request().method() === 'POST' && r.url().includes(`/api/sessions/${targetSid}/prompts`),
            { timeout: 15_000 },
          )
          .then((r) => {
            durableReceiptMs = roundMs(performance.now() - submitT0);
            return r.status();
          })
          .catch(() => null);

        await page2.keyboard.press('Enter');

        // Poll twin requestTrace for ACTUAL interactive execution admission (NOT durable 200 queued receipt!)
        let admissionEntry = null;
        const admissionDeadline = submitT0 + 15_000;
        while (performance.now() < admissionDeadline) {
          const trace = twin.getRequestTrace();
          for (let idx = traceLenBefore; idx < trace.length; idx += 1) {
            if (trace[idx].latestUserText.includes(fgNonce) || trace[idx].latestTurnText.includes(fgNonce)) {
              admissionEntry = trace[idx];
              break;
            }
          }
          if (admissionEntry) break;
          await sleep(15);
        }
        await promptRespPromise;
        const interactiveAdmissionMs = admissionEntry
          ? roundMs(admissionEntry.receivedAtMonotonicMs - submitT0)
          : null;

        // Wait for FRESH displayed output for THIS prompt (not the prior materialization reply!)
        let firstOutputMs = null;
        let freshOutputVerified = false;
        const outDeadline = submitT0 + 15_000;
        while (performance.now() < outDeadline) {
          const freshState = await page2.evaluate(
            ({ nonce, prevAssistantCount }) => {
              const scroller = document.querySelector('[data-transcript-scroll]');
              if (!scroller) return { hasNonce: false, hasNewReply: false };
              const text = scroller.textContent ?? '';
              const hasNonce = text.includes(nonce);
              const curAssistantCount = scroller.querySelectorAll('[data-block-id^="agent-frame-"], [data-block-id^="assistant-"]').length;
              return { hasNonce, hasNewReply: hasNonce && curAssistantCount > prevAssistantCount };
            },
            { nonce: fgNonce, prevAssistantCount: assistantCountBefore },
          );
          if (freshState.hasNewReply) {
            firstOutputMs = roundMs(performance.now() - submitT0);
            freshOutputVerified = true;
            break;
          }
          await sleep(40);
        }

        foregroundTrials.push({
          trial: t + 1,
          sessionId: targetSid,
          nonce: fgNonce,
          verifiedEvictedBeforeSubmit,
          restoreContentionAtSubmit,
          durablePromptId,
          durableReceiptMs,
          durableQueuePos,
          interactiveAdmissionMs,
          firstOutputMs,
          freshOutputVerified,
          budgetMs: cfg.foregroundService.admissionBudgetMs,
          ok:
            verifiedEvictedBeforeSubmit &&
            Boolean(durablePromptId) &&
            freshOutputVerified &&
            interactiveAdmissionMs !== null &&
            interactiveAdmissionMs < cfg.foregroundService.admissionBudgetMs &&
            firstOutputMs !== null,
        });
      } finally {
        await page2.close().catch(() => undefined);
      }
    }

    report.foregroundService = {
      trialsAttempted: foregroundTrials.length,
      trialsPassed: foregroundTrials.filter((tr) => tr.ok).length,
      admissionBudgetMs: cfg.foregroundService.admissionBudgetMs,
      trials: foregroundTrials,
    };

    // Stop background contention and live 100ms writer cleanly
    stopBgContention = true;
    await bgContentionPromise;
    stopTickProducer = true;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    tickLoop.stop();
    await liveLoopTurnPromise.catch(() => undefined);
    await waitForSessionIdle(server.endpoint, server.token, corpus.giantSessionId, 15_000);

    const finalWireBytes = fs.statSync(corpus.giantMainWirePath).size;
    wireGrowthSamples.push({ label: 'post-stream', atMs: performance.now(), bytes: finalWireBytes });
    const tickStats = tickLoop.getStats();

    // Compute max inter-tick gap across consumed ticks
    let maxTickGapMs = 0;
    for (let i = 1; i < tickStats.consumedTicks.length; i += 1) {
      const gap = tickStats.consumedTicks[i].consumedAtMs - tickStats.consumedTicks[i - 1].consumedAtMs;
      if (gap > maxTickGapMs) maxTickGapMs = gap;
    }

    report.simultaneity = {
      tickCadenceMs: cfg.liveStream.tickCadenceMs,
      ticksOffered: offeredTickSeq,
      ticksCommitted: tickStats.consumedCount,
      missedOffers: tickStats.missedOffers,
      maxInterTickGapMs: roundMs(maxTickGapMs),
      wireInitialBytes: initialWireBytes,
      wireFinalBytes: finalWireBytes,
      wireGrowthBytes: finalWireBytes - initialWireBytes,
      wireGrowthSamples,
      wsOpsFramesTotal: wsOpsFrames.length,
      wsOpsBeforeInteractions,
      wsOpsDuringPagination: wsOpsAfterPagination - wsOpsBeforePagination,
      grewBeforeInteractions: afterStartWireBytes > initialWireBytes,
      grewDuringInteractions: finalWireBytes > afterStartWireBytes,
    };

    // =========================================================================
    // 5b. HIGH-CONTENTION <Composer /> ENTER SEND LATENCY & SUBAGENT STATUS SYNC
    //     (4x concurrent large-wire ThreadRead + 7 concurrent subagents + file-index churn)
    // =========================================================================
    report.composerSendAndSubagentSync = await runComposerSendAndSubagentSyncProbe({
      server,
      twin,
      context,
      corpus,
      runId,
      mode,
      budgets: cfg.composerSendAndSubagentSync,
      progress,
    });

    // Cooldown long enough for the last overdue ELD tick before sampling Home A raw 10ms ELD!
    await sleep(cfg.eld.cooldownMs);
    const postEpochMetrics = await server.metrics(false);
    stopHeartbeat = true;
    await heartbeatPromise;

    report.serverAEld = {
      pid: server.pid,
      samples: postEpochMetrics.eldSamples ?? 0,
      p99Ms: postEpochMetrics.eldP99Ms ?? null,
      maxMs: postEpochMetrics.eldMaxMs ?? null,
      rawMaxMs: postEpochMetrics.eldRawMaxMs ?? null,
      rawMaxBudgetMs: cfg.eld.rawMaxBudgetMs,
      unhandledRejections: postEpochMetrics.unhandledRejections ?? 0,
      uncaughtExceptions: postEpochMetrics.uncaughtExceptions ?? 0,
    };
    report.heartbeatWatchdog = {
      ...watchdog,
      maxLatencyMs: roundMs(watchdog.maxLatencyMs),
      ok: watchdog.samples >= 5 && watchdog.failures === 0,
    };

    // =========================================================================
    // 6. SECONDARY ISOLATED --home SPACE B (inherit.agents=false + ./_private/worker.md)
    //    + RUNNING CHILD SEND-NOW (N) vs AGENT_IDLE QUEUE (Q) + A->B->A SWITCH
    // =========================================================================
    progress(
      'S18 [6/7]: Booting isolated Home B (inherit.agents=false + ./_private/worker.md), proving profile isolation, running child Send-Now vs agent_idle Queue, & A->B->A identity switch...',
    );

    const homeBRoot = path.join(workRoot, 's18-home-b');
    const homeBDir = path.join(homeBRoot, 'home');
    const homeBOsDir = path.join(homeBRoot, 'os-home');
    fs.rmSync(homeBRoot, { recursive: true, force: true });

    const createHomeBRes = await apiJson(server.endpoint, server.token, 'POST', '/api/homes', {
      path: homeBDir,
      name: 'Coupled Isolated Home B',
      inherit: { credentials: 'isolated', agents: false },
    });
    if (createHomeBRes.status !== 200 || createHomeBRes.json?.code !== 0) {
      throw new Error(`POST /api/homes for Home B failed: ${JSON.stringify(createHomeBRes)}`);
    }
    const homeBRecordId = createHomeBRes.json.data.id;

    // Configure Home B to talk to our Contract Twin and seed public owner + ./_private/worker.md
    fs.writeFileSync(
      path.join(homeBDir, 'config.toml'),
      buildChaosConfigToml({
        anthropicBaseUrl: twin.httpBaseUrl,
        openaiBaseUrl: twin.httpV1BaseUrl,
        enableSearch: false,
      }),
      'utf8',
    );
    const homeBProfiles = seedHomeBProfiles(homeBDir);

    // Reset twin requestTrace before Phase 6 so Phase 5b high-volume storm traffic cannot crowd out Home B traces
    if (typeof twin.resetRequestTrace === 'function') {
      twin.resetRequestTrace();
    }
    serverB = await spawnServer({
      homeDir: homeBDir,
      osHomeDir: homeBOsDir,
      maxOldSpaceMb: 1024,
      webAssetsDir: resolvedWebAssetsDir,
    });
    await serverB.resetWindow();

    // External /api/healthz watchdog covering Home B throughout Phase 6
    let stopHeartbeatB = false;
    const watchdogB = { samples: 0, failures: 0, maxLatencyMs: 0, failureDetails: [] };
    const heartbeatBPromise = (async () => {
      while (!stopHeartbeatB) {
        const h = await apiJson(serverB.endpoint, serverB.token, 'GET', '/api/healthz', undefined, 3_000);
        watchdogB.samples += 1;
        if (h.status === 200 && (h.json?.ok === true || h.json?.code === 0 || h.json?.data?.ok === true)) {
          if (h.elapsedMs > watchdogB.maxLatencyMs) watchdogB.maxLatencyMs = h.elapsedMs;
        } else {
          watchdogB.failures += 1;
          if (watchdogB.failureDetails.length < 10) {
            watchdogB.failureDetails.push({ status: h.status, elapsedMs: h.elapsedMs, error: h.error ?? null });
          }
        }
        await sleep(250);
      }
    })();

    // Positive & negative profile discovery verification
    const [catalogA, catalogB] = await Promise.all([
      listPublicAgentNames(server.endpoint, server.token),
      listPublicAgentNames(serverB.endpoint, serverB.token),
    ]);
    const homeAHasCanary = catalogA.names.includes(homeACanary.name);
    const homeBLeakedCanary = catalogB.names.includes(homeACanary.name);
    const homeBGloballyListedPrivate = catalogB.names.includes(homeBProfiles.privateName);
    const homeBHasPublicOwner = catalogB.names.includes(homeBProfiles.ownerName);

    // Create a workspace & session in Home B bound to b_owner
    const homeBWs = path.join(homeBRoot, 'workspace');
    fs.mkdirSync(homeBWs, { recursive: true });
    fs.writeFileSync(path.join(homeBWs, 'README.md'), '# Home B Isolated Workspace\n', 'utf8');

    const bSessionRes = await apiJson(serverB.endpoint, serverB.token, 'POST', '/api/sessions', {
      title: `S18 Home B Private Child Session (${runId})`,
      metadata: { cwd: homeBWs },
    });
    if (bSessionRes.status !== 200 || bSessionRes.json?.code !== 0 || !bSessionRes.json?.data?.id) {
      throw new Error(`Failed creating Home B session: ${JSON.stringify(bSessionRes)}`);
    }
    const bSessionId = bSessionRes.json.data.id;

    // Prepare twin barrier so the private child pauses mid-turn while running!
    const childBarrierId = `s18_child_step_${runId}`;
    const childBarrier = twin.prepareBarrier(childBarrierId);
    const traceIdxBeforeChild = twin.getRequestTrace().length;

    const childInnerPlan = encodeToolPlan({
      steps: [
        {
          calls: [{ name: 'Read', input: { path: 'README.md', line_offset: 1, n_lines: 3 } }],
          thinking: 'Private child step 0 establishing live busy transcript state.',
        },
        {
          barrierId: childBarrierId,
          calls: [{ name: 'Read', input: { path: 'README.md', line_offset: 1, n_lines: 5 } }],
          thinking: 'Private child step 1 pausing on step-boundary barrier while busy.',
        },
      ],
      finalText: 'HOME_B_PRIVATE_CHILD_TURN1_DONE',
    });

    const ownerPlan = encodeToolPlan({
      steps: [
        {
          calls: [
            {
              name: 'AgentRun',
              input: {
                profile: homeBProfiles.privateName,
                name: 'b_priv_child',
                description: 'Home B scoped private worker',
                background: true,
                prompt: `[CHAOS_SCOPE:s18_b_child_${runId}] ${childInnerPlan}`,
              },
            },
          ],
          thinking: 'Home B owner dispatching scoped ./_private/worker.md child.',
        },
      ],
      finalText: 'HOME_B_OWNER_DISPATCHED_PRIVATE_CHILD',
    });

    // Submit owner prompt in Home B with profile=b_owner
    const ownerSubmitRes = await apiJson(
      serverB.endpoint,
      serverB.token,
      'POST',
      `/api/sessions/${bSessionId}/prompts`,
      {
        profile: homeBProfiles.ownerName,
        content: [{ type: 'text', text: `[CHAOS_SCOPE:s18_b_owner_${runId}] ${ownerPlan}` }],
      },
      25_000,
    );

    const arrivedCount = await childBarrier.waitForArrivals(1, 20_000);
    const childArrivedAtBarrier = arrivedCount >= 1;

    // Inspect Home B live agents to discover exact child agent ID
    const liveAgentsB = await serverB.inspectLiveAgents(bSessionId);
    const childAgentId = liveAgentsB.childIds?.[0] ?? null;

    // Verify private child's system prompt carried HOME_B_PRIVATE_MARKER_ONLY
    const traceAfterChildLaunch = twin.getRequestTrace().slice(traceIdxBeforeChild);
    const privateChildLaunchedWithMarker = traceAfterChildLaunch.some((entry) =>
      entry.systemPromptSnippet.includes(homeBProfiles.privateMarker),
    );

    const steerNonceN = `STEER_NONCE_N_${randomUUID().slice(0, 8)}`;
    const queueNonceQ = `QUEUE_NONCE_Q_${randomUUID().slice(0, 8)}`;

    let steerSendModeUsed = null;
    let queueSendModeUsed = null;
    let liveDomRowsN = 0;
    let liveDomRowsQ = 0;
    let reopenDomRowsN = 0;
    let reopenDomRowsQ = 0;
    let steerConsumedInTurn1Count = 0;
    let steerLeakedToTurn2Count = 0;
    let queueLeakedToTurn1Count = 0;
    let queueConsumedInTurn2Count = 0;
    const switchChecks = [];

    if (childArrivedAtBarrier && childAgentId) {
      const pageB = await context.newPage();
      try {
        await pageB.goto(deepLinkFor(serverB, `/s/${bSessionId}/agent/${encodeURIComponent(childAgentId)}`), {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        const childInput = pageB
          .locator(`[data-composer-input][data-composer-agent="${childAgentId}"][contenteditable="true"], [data-composer-input][contenteditable="true"]`)
          .first();
        await childInput.waitFor({ state: 'visible', timeout: 15_000 });
        // Wait until the running child's live busy state has hydrated into the composer
        await pageB
          .waitForFunction(
            () =>
              Boolean(
                document.querySelector('[data-header-working]') ||
                  document.querySelector('button[aria-label*="停止"], button[aria-label*="Stop"], button[title*="停止"], button[title*="Stop"]'),
              ),
            null,
            { timeout: 10_000 },
          )
          .catch(() => undefined);

        const sendChildWithTiming = async (text, timingAttr) => {
          await childInput.click({ timeout: 5_000 });
          await pageB.keyboard.insertText(text);
          await sleep(120);
          await pageB.locator('[data-send-ready]').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
          const caret = pageB.locator('[data-send-timing-caret]').first();
          try {
            await caret.waitFor({ state: 'visible', timeout: 10_000 });
            await caret.click({ timeout: 5_000 });
          } catch (error) {
            const diag = await pageB.evaluate(() => ({
              url: window.location.pathname,
              hasSendReady: Boolean(document.querySelector('[data-send-ready]')),
              hasTimingRoot: Boolean(document.querySelector('[data-send-timing-root]')),
              hasHeaderWorking: Boolean(document.querySelector('[data-header-working]')),
              composerAgent: document.querySelector('[data-composer-input]')?.dataset.composerAgent ?? null,
              contentEditable: document.querySelector('[data-composer-input]')?.getAttribute('contenteditable') ?? null,
            }));
            throw new Error(
              `caret_missing:${JSON.stringify(diag)}:${String(error?.message ?? error).slice(0, 80)}`,
              { cause: error },
            );
          }
          await sleep(150);
          const menuItem = pageB.locator(`[data-send-timing-menu] [data-send-timing="${timingAttr}"]`).first();
          await menuItem.waitFor({ state: 'visible', timeout: 5_000 });
          await menuItem.click({ timeout: 5_000 });
          await sleep(220);
          return timingAttr;
        };

        // 1. Steer nonce N via Send now (NO fallback to Enter!)
        steerSendModeUsed = await sendChildWithTiming(
          `[CHAOS_SCOPE:s18_steer_${runId}] ${steerNonceN} Live child Send-now steer.`,
          'now',
        ).catch((error) => `error:${String(error?.message ?? error).slice(0, 260)}`);

        // 2. Explicitly queue nonce Q for agent_idle
        queueSendModeUsed = await sendChildWithTiming(
          `[CHAOS_SCOPE:s18_queue_${runId}] ${queueNonceQ} Live child agent_idle queue.`,
          'agent_idle',
        ).catch((error) => `error:${String(error?.message ?? error).slice(0, 260)}`);

        const traceIdxBeforeRelease = twin.getRequestTrace().length;
        // Release the child's step-boundary barrier!
        childBarrier.release();

        // Wait for Home B session (both Turn 1 with steer N and Turn 2 with queued Q) to settle idle
        await waitForSessionIdle(serverB.endpoint, serverB.token, bSessionId, 30_000);
        await sleep(400);

        // Inspect twin requestTrace scoped strictly to the private child to prove Turn 1 vs Turn 2 exact single consumption!
        const postReleaseTrace = twin
          .getRequestTrace()
          .slice(traceIdxBeforeRelease)
          .filter((entry) => entry.systemPromptSnippet.includes(homeBProfiles.privateMarker));
        for (const entry of postReleaseTrace) {
          const text = entry.latestUserText;
          const isSameRunningTurnStep = entry.hasToolResults === true || entry.turnToolRound > 0;
          if (text.includes(steerNonceN)) {
            if (isSameRunningTurnStep) steerConsumedInTurn1Count += 1;
            else steerLeakedToTurn2Count += 1;
          }
          if (text.includes(queueNonceQ)) {
            if (isSameRunningTurnStep) queueLeakedToTurn1Count += 1;
            else queueConsumedInTurn2Count += 1;
          }
        }

        const countLogicalUserRows = async (p, targetAid, nonce) =>
          p.evaluate(
            ({ aid, needle }) => {
              const host =
                document.querySelector(`[data-agent-workspace-target="${aid}"]`) ??
                document.querySelector('[data-transcript-scroll]');
              if (!host) return 0;
              const userBlocks = [...host.querySelectorAll('[data-block-id^="user-"]')];
              return userBlocks.filter((el) => (el.textContent ?? '').includes(needle)).length;
            },
            { aid: targetAid, needle: nonce },
          );

        liveDomRowsN = await countLogicalUserRows(pageB, childAgentId, steerNonceN);
        liveDomRowsQ = await countLogicalUserRows(pageB, childAgentId, queueNonceQ);

        // Navigate away to main & reopen child view to verify zero duplicate rows after reopen!
        await pageB.goto(deepLinkFor(serverB, `/s/${bSessionId}`), {
          waitUntil: 'domcontentloaded',
          timeout: 25_000,
        });
        await sleep(250);
        await pageB.goto(deepLinkFor(serverB, `/s/${bSessionId}/agent/${encodeURIComponent(childAgentId)}`), {
          waitUntil: 'domcontentloaded',
          timeout: 25_000,
        });
        await pageB.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 15_000 });
        await sleep(250);
        reopenDomRowsN = await countLogicalUserRows(pageB, childAgentId, steerNonceN);
        reopenDomRowsQ = await countLogicalUserRows(pageB, childAgentId, queueNonceQ);
      } finally {
        childBarrier.release();
        await pageB.close().catch(() => undefined);
      }
    } else {
      childBarrier.release();
    }

    // Verify A -> B -> A space switch via real GUI SpaceScopeControl / SpaceSwitchSheet (no page.goto between A->B->A)
    let pairedHomeBRecordId = null;
    const enableInboundB = await apiJson(serverB.endpoint, serverB.token, 'PUT', '/api/remote-connections/inbound', {
      enabled: true,
    }, 10_000);
    const pairCodeRes = enableInboundB.status === 200
      ? await apiJson(serverB.endpoint, serverB.token, 'POST', '/api/remote-connections/inbound/pair-code', {
          label: 'S18 Home B',
          allowBridge: true,
        }, 10_000)
      : null;
    const pairIssued = pairCodeRes?.status === 200 && pairCodeRes.json?.code === 0 ? pairCodeRes.json.data : null;
    if (pairIssued?.code) {
      const claimEndpoint = pairIssued.suggestedEndpoints?.[0] ?? serverB.endpoint;
      const pairRes = await apiJson(server.endpoint, server.token, 'POST', '/api/remote-connections/pair', {
        endpoint: claimEndpoint,
        code: pairIssued.code,
        fingerprint: pairIssued.tlsFingerprint,
        label: 'Coupled Isolated Home B',
        backgroundSummary: false,
        requestBridge: true,
      }, 15_000);
      if (pairRes.status === 200 && pairRes.json?.code === 0 && pairRes.json?.data?.id) {
        pairedHomeBRecordId = pairRes.json.data.id;
      }
    }

    const switchPage = await context.newPage();
    try {
      // Load Home A once; all subsequent A -> B -> A transitions are driven via GUI SpaceScopeControl + SpaceSwitchSheet + Sidebar clicks.
      await switchPage.goto(deepLinkFor(server, `/s/${corpus.giantSessionId}`), {
        waitUntil: 'domcontentloaded',
        timeout: 25_000,
      });
      await switchPage.waitForSelector('[data-session-sidebar]', { timeout: 15_000 });
      await switchPage.waitForSelector('[data-space-switcher]', { timeout: 15_000 });
      await switchPage.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 20_000 });

      const initialState = await switchPage.evaluate((sid) => {
        const pathNow = window.location.pathname;
        const transcriptText = document.querySelector('[data-transcript-scroll]')?.textContent ?? '';
        return {
          path: pathNow,
          matchesSession: pathNow.includes(`/s/${sid}`) && !pathNow.includes('/p/'),
          hasHomeAContent: transcriptText.includes('TURN_MARKER_'),
          hasHomeBContent: transcriptText.includes('HOME_B_OWNER_DISPATCHED_PRIVATE_CHILD'),
        };
      }, corpus.giantSessionId);
      switchChecks.push({
        step: 'A_initial',
        ok: Boolean(initialState.matchesSession && initialState.hasHomeAContent && !initialState.hasHomeBContent),
        expectedHomeId: server.identity?.homeId ?? null,
        sessionId: corpus.giantSessionId,
        path: initialState.path,
        drivenViaGui: true,
      });

      // Step 2: Switch to paired Home B via real SpaceScopeControl -> SpaceSwitchSheet -> remote item -> Home B conversation row.
      if (pairedHomeBRecordId) {
        await switchPage.locator('[data-space-switcher]').click();
        await switchPage.waitForSelector('[data-space-switcher-menu]', { timeout: 10_000 });
        const remoteItem = switchPage.locator(`[data-space-remote-item="${pairedHomeBRecordId}"]`);
        await remoteItem.waitFor({ state: 'visible', timeout: 15_000 });
        await remoteItem.click();
        await switchPage.waitForFunction(
          (recId) => document.querySelector('[data-space-switcher]')?.getAttribute('data-space-scope') === `remote:${recId}`,
          pairedHomeBRecordId,
          { timeout: 10_000 },
        );
        const homeBSessionRow = switchPage.locator(`[data-session-row="${bSessionId}"]`).first();
        await homeBSessionRow.waitFor({ state: 'visible', timeout: 15_000 });
        await homeBSessionRow.click();
        await switchPage.waitForFunction(
          ({ recId, sid }) =>
            window.location.pathname.includes(`/p/${recId}/s/${sid}`) &&
            (document.querySelector('[data-transcript-scroll]')?.textContent ?? '').includes('HOME_B_OWNER_DISPATCHED_PRIVATE_CHILD'),
          { recId: pairedHomeBRecordId, sid: bSessionId },
          { timeout: 20_000 },
        );
        const homeBState = await switchPage.evaluate(({ recId, sid }) => {
          const pathNow = window.location.pathname;
          const scopeNow = document.querySelector('[data-space-switcher]')?.getAttribute('data-space-scope') ?? null;
          const transcriptText = document.querySelector('[data-transcript-scroll]')?.textContent ?? '';
          return {
            path: pathNow,
            scope: scopeNow,
            matchesSession: pathNow.includes(`/p/${recId}/s/${sid}`),
            hasHomeBContent: transcriptText.includes('HOME_B_OWNER_DISPATCHED_PRIVATE_CHILD'),
            hasHomeAContent: transcriptText.includes('TURN_MARKER_'),
          };
        }, { recId: pairedHomeBRecordId, sid: bSessionId });
        switchChecks.push({
          step: 'B_isolated',
          ok: Boolean(
            homeBState.scope === `remote:${pairedHomeBRecordId}` &&
            homeBState.matchesSession &&
            homeBState.hasHomeBContent &&
            !homeBState.hasHomeAContent,
          ),
          expectedHomeId: serverB.identity?.homeId ?? null,
          pairedConnectionId: pairedHomeBRecordId,
          sessionId: bSessionId,
          path: homeBState.path,
          scope: homeBState.scope,
          drivenViaGui: true,
        });

        // Step 3: Switch back to Home A via SpaceScopeControl -> SpaceSwitchSheet -> [data-space-computer-local] -> Home A conversation row.
        await switchPage.locator('[data-space-switcher]').click();
        await switchPage.waitForSelector('[data-space-switcher-menu]', { timeout: 10_000 });
        const localBtn = switchPage.locator('[data-space-computer-local]');
        await localBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await localBtn.click();
        await switchPage.waitForFunction(
          () => (document.querySelector('[data-space-switcher]')?.getAttribute('data-space-scope') ?? '').startsWith('local:'),
          null,
          { timeout: 10_000 },
        );
        const homeASessionRow = switchPage.locator(`[data-session-row="${corpus.giantSessionId}"]`).first();
        await homeASessionRow.waitFor({ state: 'visible', timeout: 15_000 });
        await homeASessionRow.click();
        await switchPage.waitForFunction(
          (sid) =>
            window.location.pathname.includes(`/s/${sid}`) &&
            !window.location.pathname.includes('/p/') &&
            (document.querySelector('[data-transcript-scroll]')?.textContent ?? '').includes('TURN_MARKER_'),
          corpus.giantSessionId,
          { timeout: 20_000 },
        );
        const returnAState = await switchPage.evaluate((sid) => {
          const pathNow = window.location.pathname;
          const scopeNow = document.querySelector('[data-space-switcher]')?.getAttribute('data-space-scope') ?? null;
          const transcriptText = document.querySelector('[data-transcript-scroll]')?.textContent ?? '';
          return {
            path: pathNow,
            scope: scopeNow,
            matchesSession: pathNow.includes(`/s/${sid}`) && !pathNow.includes('/p/'),
            hasHomeAContent: transcriptText.includes('TURN_MARKER_'),
            hasHomeBContent: transcriptText.includes('HOME_B_OWNER_DISPATCHED_PRIVATE_CHILD'),
          };
        }, corpus.giantSessionId);
        switchChecks.push({
          step: 'A_return',
          ok: Boolean(
            (returnAState.scope ?? '').startsWith('local:') &&
            returnAState.matchesSession &&
            returnAState.hasHomeAContent &&
            !returnAState.hasHomeBContent,
          ),
          expectedHomeId: server.identity?.homeId ?? null,
          sessionId: corpus.giantSessionId,
          path: returnAState.path,
          scope: returnAState.scope,
          drivenViaGui: true,
        });
      } else {
        switchChecks.push(
          { step: 'B_isolated', ok: false, error: 'Failed to pair Home B for GUI space switch', drivenViaGui: true },
          { step: 'A_return', ok: false, error: 'Skipped due to Home B pairing failure', drivenViaGui: true },
        );
      }
    } finally {
      await switchPage.close().catch(() => undefined);
    }

    await sleep(cfg.eld.cooldownMs);
    stopHeartbeatB = true;
    await heartbeatBPromise;
    const serverBMetrics = await serverB.metrics(false);

    report.isolatedHomeB = {
      homeBRecordId,
      homeBId: serverB.identity?.homeId ?? null,
      homeBPid: serverB.pid,
      distinctHomeIds: Boolean(
        server.identity?.homeId &&
          serverB.identity?.homeId &&
          server.identity.homeId !== serverB.identity.homeId,
      ),
      homeBHeartbeatWatchdog: {
        ...watchdogB,
        maxLatencyMs: roundMs(watchdogB.maxLatencyMs),
        ok: watchdogB.samples >= 3 && watchdogB.failures === 0,
      },
      profileIsolation: {
        homeAHasCanary,
        homeBLeakedCanary,
        homeBGloballyListedPrivate,
        homeBHasPublicOwner,
        privateChildLaunchedWithMarker,
        ok:
          homeAHasCanary &&
          !homeBLeakedCanary &&
          !homeBGloballyListedPrivate &&
          homeBHasPublicOwner &&
          privateChildLaunchedWithMarker,
      },
      childSteerVsQueue: {
        ownerSubmitOk: ownerSubmitRes.status === 200 && ownerSubmitRes.json?.code === 0,
        ownerSubmitError:
          ownerSubmitRes.status === 200 && ownerSubmitRes.json?.code === 0
            ? null
            : (ownerSubmitRes.json?.msg ?? ownerSubmitRes.error ?? `HTTP ${ownerSubmitRes.status}`),
        childArrivedAtBarrier,
        childAgentId,
        steerNonceN,
        queueNonceQ,
        steerSendModeUsed,
        queueSendModeUsed,
        steerConsumedInTurn1Count,
        steerLeakedToTurn2Count,
        queueLeakedToTurn1Count,
        queueConsumedInTurn2Count,
        liveDomRowsN,
        liveDomRowsQ,
        reopenDomRowsN,
        reopenDomRowsQ,
        ok:
          childArrivedAtBarrier &&
          steerSendModeUsed === 'now' &&
          queueSendModeUsed === 'agent_idle' &&
          steerConsumedInTurn1Count === 1 &&
          steerLeakedToTurn2Count === 0 &&
          queueLeakedToTurn1Count === 0 &&
          queueConsumedInTurn2Count === 1 &&
          liveDomRowsN === 1 &&
          liveDomRowsQ === 1 &&
          reopenDomRowsN === 1 &&
          reopenDomRowsQ === 1,
      },
      homeSwitchABA: {
        pairedConnectionId: pairedHomeBRecordId,
        drivenViaGuiSpaceSwitcher: switchChecks.length === 3 && switchChecks.every((c) => c.drivenViaGui === true),
        checks: switchChecks,
        ok: switchChecks.length === 3 && switchChecks.every((c) => c.ok && c.drivenViaGui === true),
      },
      serverBEld: {
        pid: serverB.pid,
        samples: serverBMetrics.eldSamples ?? 0,
        p99Ms: serverBMetrics.eldP99Ms ?? null,
        maxMs: serverBMetrics.eldMaxMs ?? null,
        rawMaxMs: serverBMetrics.eldRawMaxMs ?? null,
        rawMaxBudgetMs: cfg.eld.rawMaxBudgetMs,
        unhandledRejections: serverBMetrics.unhandledRejections ?? 0,
        uncaughtExceptions: serverBMetrics.uncaughtExceptions ?? 0,
      },
    };

    await context.close().catch(() => undefined);
  } catch (error) {
    report.fatalError = String(error?.stack ?? error).slice(0, 1200);
  } finally {
    stopBgContention = true;
    stopTickProducer = true;
    stopHeartbeat = true;
    if (tickTimer) clearInterval(tickTimer);
    tickLoop?.stop();
    await Promise.allSettled([bgContentionPromise, heartbeatPromise]);
    if (browser) await browser.close().catch(() => undefined);
    if (serverB) await serverB.shutdown().catch(() => undefined);
  }

  report.elapsedMs = roundMs(performance.now() - startedAt);
  const verdict = evaluateS18CoupledWorkstationVerdict(report, cfg);
  const finalResult = {
    ...report,
    ...verdict,
  };
  fs.writeFileSync(path.join(receiptDir, 's18-receipt.json'), `${JSON.stringify(finalResult, null, 2)}\n`, 'utf8');
  progress(
    `S18 Coupled Workstation Gate (${cfg.mode}) Result: passed=${verdict.passed} releaseEligible=${cfg.releaseEligible} exitCode=${verdict.exitCode} productFails=${verdict.productFailures.length} harnessFails=${verdict.harnessFailures.length} wall=${report.elapsedMs}ms`,
  );
  return finalResult;
}
