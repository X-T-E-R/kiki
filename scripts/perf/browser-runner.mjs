import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  collectTimelineIntegrity,
  inspectTranscriptVisibility,
  installTimelineMonitor,
  labelTimeline,
} from '../../apps/kiki-gui/scripts/timeline-integrity.mjs';
import {
  assertKapServerWebAssets,
  createWebAssetsAuditRecorder,
  evaluateWebAssetsBudget,
} from '../ccp-chaos/web-assets-bridge.mjs';
import {
  attachBrowserRuntimeGuards,
  runAppRoutesWalk,
  verifyAddMenuSecondaryScrollable,
  verifyColdContextMeter,
  verifyComposerFooterDrain,
  verifyPersonaSubagentSingleRowNoErrorPileup,
  verifyRightRailMergedBranchesFolded,
  verifyScrollUpNoSnapBack,
  verifyViewedSessionClearsUnreadDot,
  verifyZeroFalseTopScrollErrorToast,
} from './browser-invariants.mjs';
import { EventLoopWindowMonitor, quantiles, roundMs } from './metrics.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GUI_ROOT = path.join(REPO_ROOT, 'apps', 'kiki-gui');

const kapRequire = createRequire(new URL('../../packages/kap-server/package.json', import.meta.url));
const { chromium } = kapRequire('playwright');

export const FROZEN_MOBILE_PERF_BUDGETS = Object.freeze({
  coldOpenFirstMessageMs: 2_500,
  coldOpenMaxLongTaskMs: 1_000,
  touchScrollMaxLongTaskMs: 250,
  touchScrollFrameP95Ms: 40,
});

function computeGuiProductionBundleKey() {
  const hash = createHash('sha1');
  const roots = [
    path.join(GUI_ROOT, 'src'),
    path.join(GUI_ROOT, 'index.html'),
    path.join(GUI_ROOT, 'vite.config.ts'),
    path.join(GUI_ROOT, 'package.json'),
    ...['agent-profiles', 'klient', 'protocol', 'session-core', 'transcript'].map((pkg) =>
      path.join(REPO_ROOT, 'packages', pkg, 'src'),
    ),
  ];
  const walk = (target) => {
    let info;
    try {
      info = fs.statSync(target);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const child of fs.readdirSync(target).toSorted()) {
        walk(path.join(target, child));
      }
      return;
    }
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(target)) return;
    hash.update(`\n${path.relative(REPO_ROOT, target)}:${info.size}:${info.mtimeMs}`);
  };
  for (const root of roots) walk(root);
  return hash.digest('hex');
}

export function ensureGuiStaticBuild(cacheBaseDir = path.join(REPO_ROOT, '.tmp', 'perf-gui-dist')) {
  const started = performance.now();
  const distDir = path.join(cacheBaseDir, 'dist');
  const keyFile = path.join(cacheBaseDir, 'cache-key.txt');
  const expectedKey = computeGuiProductionBundleKey();
  const existingKey = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : null;
  if (expectedKey && existingKey === expectedKey && fs.existsSync(path.join(distDir, 'index.html'))) {
    return { distDir, reusedCache: true, buildMs: roundMs(performance.now() - started) };
  }
  fs.mkdirSync(cacheBaseDir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      path.join(GUI_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      'build',
      '--outDir',
      distDir,
      '--emptyOutDir',
      '--logLevel',
      'warn',
    ],
    { cwd: GUI_ROOT, stdio: 'inherit', timeout: 180_000 },
  );
  if (result.status !== 0) {
    throw new Error(`apps/kiki-gui vite build failed with status ${result.status}`);
  }
  if (expectedKey) {
    fs.writeFileSync(keyFile, expectedKey, 'utf8');
  }
  return { distDir, reusedCache: false, buildMs: roundMs(performance.now() - started) };
}


function installLongTaskProbe() {
  const state = {
    longTasks: [],
    rafGaps: [],
  };
  window.__kikiPerfProbe = {
    reset() {
      state.longTasks = [];
      state.rafGaps = [];
    },
    drain() {
      const durations = state.longTasks.map((t) => t.duration);
      const maxLongTaskMs = durations.length > 0 ? Math.max(...durations) : 0;
      const totalBlockingTimeMs = durations.reduce((acc, d) => acc + Math.max(0, d - 50), 0);
      const maxRafGapMs = state.rafGaps.length > 0 ? Math.max(...state.rafGaps) : 0;
      const snapshot = {
        longTaskCount: durations.length,
        maxLongTaskMs: Number(maxLongTaskMs.toFixed(2)),
        totalBlockingTimeMs: Number(totalBlockingTimeMs.toFixed(2)),
        maxRafGapMs: Number(maxRafGapMs.toFixed(2)),
      };
      state.longTasks = [];
      state.rafGaps = [];
      return snapshot;
    },
  };
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // LongTask API unsupported in environment.
  }
  let prevFrame = performance.now();
  const trackRaf = (now) => {
    const gap = now - prevFrame;
    prevFrame = now;
    if (gap > 32) state.rafGaps.push(gap);
    requestAnimationFrame(trackRaf);
  };
  requestAnimationFrame(trackRaf);
}

function selectBrowserRepresentatives(samples, maxPerStratum = 1) {
  const byStratum = new Map();
  const picked = [];
  for (const sample of samples) {
    const seen = byStratum.get(sample.stratum) ?? 0;
    if (seen >= maxPerStratum) continue;
    byStratum.set(sample.stratum, seen + 1);
    picked.push(sample);
  }
  return picked;
}

async function runMobileThrottledLeg({ browser, endpoint, deepLink, sample }) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'no-preference',
  });
  let webAssetsRecorder = null;
  try {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('kiki.locale', 'en');
        localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      } catch {}
    });
    await context.addInitScript(installLongTaskProbe);

    const page = await context.newPage();
    webAssetsRecorder = createWebAssetsAuditRecorder(page, endpoint);
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err).slice(0, 300)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 40,
      downloadThroughput: Math.floor((15 * 1024 * 1024) / 8),
      uploadThroughput: Math.floor((5 * 1024 * 1024) / 8),
    });

    const openT0 = performance.now();
    await page.goto(deepLink(`/s/${sample.sandboxId}`), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(
      () => {
        const items = document.querySelectorAll('[data-transcript-scroll] [data-transcript-virtual-item]');
        for (const el of items) {
          if ((el.textContent ?? '').trim().length > 0) return true;
        }
        return false;
      },
      null,
      { timeout: 30_000 },
    );
    const firstMessageVisibleMs = roundMs(performance.now() - openT0);
    const coldOpenLongTasks = await page.evaluate(() => window.__kikiPerfProbe?.drain?.() ?? null);

    await page.evaluate(() => window.__kikiPerfProbe?.reset?.());
    const frameDeltas = await page.evaluate(async () => {
      const scroller = document.querySelector('[data-transcript-scroll]');
      const deltas = [];
      let prev = performance.now();
      let active = true;
      const rafLoop = (now) => {
        deltas.push(now - prev);
        prev = now;
        if (active) requestAnimationFrame(rafLoop);
      };
      requestAnimationFrame(rafLoop);
      if (scroller) {
        for (let step = 0; step < 6; step += 1) {
          scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.floor(scroller.clientHeight * 0.7));
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 90));
        }
      }
      await new Promise((r) => setTimeout(r, 150));
      active = false;
      return deltas.slice(1);
    });
    const touchScrollLongTasks = await page.evaluate(() => window.__kikiPerfProbe?.drain?.() ?? null);
    const scrollFrames = quantiles(frameDeltas);

    await webAssetsRecorder.settle();
    const webAssetsAudit = webAssetsRecorder.snapshot();
    webAssetsRecorder.detach();
    webAssetsRecorder = null;
    const webAssetsGate = evaluateWebAssetsBudget(webAssetsAudit);

    const B = FROZEN_MOBILE_PERF_BUDGETS;
    const failures = [];
    if (!webAssetsGate.passed) failures.push(...webAssetsGate.failures.map((f) => `webAssets: ${f}`));
    if (pageErrors.length > 0) failures.push(`mobile pageErrors=${pageErrors.length}`);
    if (consoleErrors.length > 0) failures.push(`mobile consoleErrors=${consoleErrors.length}`);
    if (firstMessageVisibleMs >= B.coldOpenFirstMessageMs) {
      failures.push(`mobile firstMessageVisibleMs=${firstMessageVisibleMs} >= ${B.coldOpenFirstMessageMs}`);
    }
    if ((coldOpenLongTasks?.maxLongTaskMs ?? Infinity) >= B.coldOpenMaxLongTaskMs) {
      failures.push(`mobile coldOpen maxLongTaskMs=${coldOpenLongTasks?.maxLongTaskMs} >= ${B.coldOpenMaxLongTaskMs}`);
    }
    if ((touchScrollLongTasks?.maxLongTaskMs ?? Infinity) >= B.touchScrollMaxLongTaskMs) {
      failures.push(`mobile touchScroll maxLongTaskMs=${touchScrollLongTasks?.maxLongTaskMs} >= ${B.touchScrollMaxLongTaskMs}`);
    }
    if (scrollFrames.count > 0 && scrollFrames.p95 >= B.touchScrollFrameP95Ms) {
      failures.push(`mobile touchScroll frameP95Ms=${scrollFrames.p95} >= ${B.touchScrollFrameP95Ms}`);
    }

    return {
      sampleLabel: sample.label,
      stratum: sample.stratum,
      emulation: {
        viewport: { width: 390, height: 844, dpr: 3, isMobile: true, hasTouch: true },
        cpuThrottlingRate: 4,
        network: { latencyMs: 40, downloadMbps: 15, uploadMbps: 5 },
        reducedMotion: 'no-preference',
      },
      firstMessageVisibleMs,
      coldOpenLongTasks,
      touchScrollLongTasks,
      touchScrollFramesMs: scrollFrames,
      pageErrors,
      consoleErrors,
      webAssetsAudit,
      webAssetsGate,
      passed: failures.length === 0,
      failures,
    };
  } finally {
    webAssetsRecorder?.detach();
    await context.close().catch(() => undefined);
  }
}

export async function runBrowserSuite({ endpoint, token, samples, maxPerStratum = 1, buildInfo = null }) {
  const webInfo = await assertKapServerWebAssets(endpoint);
  const webUrl = webInfo.webUrl;
  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  const eld = new EventLoopWindowMonitor(20);
  const targets = selectBrowserRepresentatives(samples, maxPerStratum);
  const results = [];
  let routesWalk = null;
  let routesWalkGuards = null;
  let mobileLeg = null;
  let desktopWebAssetsAudit = null;

  const deepLink = (routePath) => {
    const sep = routePath.includes('?') ? '&' : '?';
    return `${webUrl}${routePath}${sep}server=${encodeURIComponent(endpoint)}&token=${encodeURIComponent(token)}`;
  };

  try {
    for (const sample of targets) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'reduce',
      });
      let sampleAssetsRecorder = null;
      try {
        await context.addInitScript(() => {
          try {
            localStorage.setItem('kiki.locale', 'en');
            localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
          } catch {
            // Storage unavailable.
          }
        });
        await context.addInitScript(installLongTaskProbe);

        const page = await context.newPage();
        sampleAssetsRecorder = desktopWebAssetsAudit === null ? createWebAssetsAuditRecorder(page, endpoint) : null;
        await installTimelineMonitor(page);
        const guards = attachBrowserRuntimeGuards(page, { endpoint, rpcSlowBudgetMs: 1_500 });

        let phaseApiRequests = 0;
        page.on('request', (req) => {
          if (req.url().startsWith(endpoint)) {
            phaseApiRequests += 1;
          }
        });

        phaseApiRequests = 0;
        eld.beginWindow();
        guards.setPhase('cold-open', { coldOpen: true });
        const openStarted = performance.now();
        await page.goto(deepLink(`/s/${sample.sandboxId}`), {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        await page.waitForSelector('[data-session-sidebar], main > section[role="alert"] pre', { timeout: 45_000 });
        let transcriptMounted = true;
        if (sample.mainWireBytes > 0) {
          const mounted = await page
            .waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item], main > section[role="alert"] pre', {
              timeout: 30_000,
            })
            .then(() => page.evaluate(() => document.querySelector('[data-transcript-scroll] [data-transcript-virtual-item]') !== null))
            .catch(() => false);
          transcriptMounted = mounted;
        }
        const coldOpenMs = roundMs(performance.now() - openStarted);
        const coldOpenLongTasks = await page.evaluate(() => window.__kikiPerfProbe?.drain?.() ?? null);
        const coldOpenEld = eld.endWindow();
        const coldOpenHttpRequests = phaseApiRequests;

        await guards.assertNoErrorBoundary('cold-open');
        const footerDrain = await verifyComposerFooterDrain(page, { timeoutMs: 3_500 });
        guards.setPhase('cold-invariants', { coldOpen: false });

        const coldVisibility = await inspectTranscriptVisibility(page, 'main');
        const contextMeter = await verifyColdContextMeter(page);
        const addMenuScroll = await verifyAddMenuSecondaryScrollable(page);
        const mergedBranchesFolded = await verifyRightRailMergedBranchesFolded(page);
        const viewedSessionUnread = await verifyViewedSessionClearsUnreadDot(page, sample.sandboxId);
        const personaSingleRow = await verifyPersonaSubagentSingleRowNoErrorPileup(page);
        const zeroFalseTopToast = await verifyZeroFalseTopScrollErrorToast(page);
        const scrollUpNoSnapBack = await verifyScrollUpNoSnapBack(page);
        await guards.assertNoErrorBoundary('context-meter');

        phaseApiRequests = 0;
        eld.beginWindow();
        guards.setPhase('scroll-older', { coldOpen: false });
        await labelTimeline(page, `${sample.label}:scroll`);
        await page.evaluate(() => window.__kikiPerfProbe?.reset?.());
        const scrollStarted = performance.now();
        const scrolledSteps = await page.evaluate(async () => {
          const scroller = document.querySelector('[data-transcript-scroll]');
          if (!scroller) return 0;
          let steps = 0;
          for (const ratio of [0.6, 0.3, 0.08, 0]) {
            scroller.scrollTop = Math.floor(scroller.scrollHeight * ratio);
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            steps += 1;
            await new Promise((r) => {
              setTimeout(r, 140);
            });
          }
          await new Promise((r) => {
            setTimeout(r, 350);
          });
          return steps;
        });
        const scrollWindowMs = roundMs(performance.now() - scrollStarted);
        const scrollLongTasks = await page.evaluate(() => window.__kikiPerfProbe?.drain?.() ?? null);
        const timelineCheck = await collectTimelineIntegrity(page);
        const scrollVisibility = await inspectTranscriptVisibility(page, 'main');
        await guards.assertNoErrorBoundary('scroll-older');
        const scrollEld = eld.endWindow();
        const scrollHttpRequests = phaseApiRequests;

        const switchToAgent = async (aid, wireBytes, phaseLabel) => {
          phaseApiRequests = 0;
          eld.beginWindow();
          guards.setPhase(phaseLabel, { coldOpen: false });
          await page.evaluate(() => window.__kikiPerfProbe?.reset?.());
          const switchStarted = performance.now();
          await page.evaluate(
            ({ sid, targetId }) => {
              const search = window.location.search;
              window.history.pushState({}, '', `/s/${sid}/agent/${encodeURIComponent(targetId)}${search}`);
              window.dispatchEvent(new PopStateEvent('popstate'));
            },
            { sid: sample.sandboxId, targetId: aid },
          );
          const targetMounted = await page
            .waitForSelector(`[data-agent-workspace-target="${aid}"], main > section[role="alert"] pre`, {
              timeout: 20_000,
            })
            .then(() => page.evaluate((targetId) => document.querySelector(`[data-agent-workspace-target="${targetId}"]`) !== null, aid))
            .catch(() => false);
          let itemsMounted = true;
          if (targetMounted && wireBytes > 0) {
            itemsMounted = await page
              .waitForSelector(
                `[data-agent-workspace-target="${aid}"] [data-transcript-virtual-item], main > section[role="alert"] pre`,
                { timeout: 15_000 },
              )
              .then(() =>
                page.evaluate(
                  (targetId) =>
                    document.querySelector(`[data-agent-workspace-target="${targetId}"] [data-transcript-virtual-item]`) !== null,
                  aid,
                ),
              )
              .catch(() => false);
          }
          const switchMs = roundMs(performance.now() - switchStarted);
          const switchLongTasks = await page.evaluate(() => window.__kikiPerfProbe?.drain?.() ?? null);
          await guards.assertNoErrorBoundary(phaseLabel);
          const switchEld = eld.endWindow();
          return {
            switchMs,
            targetMounted,
            itemsMounted,
            httpRequests: phaseApiRequests,
            ...switchLongTasks,
            ...switchEld,
          };
        };

        let subagentSwitch = null;
        if (sample.maxChildAgentId) {
          subagentSwitch = await switchToAgent(sample.maxChildAgentId, sample.maxChildWireBytes, 'subagent-open');
        }

        let branchSwitch = null;
        if (sample.branchAgentId && sample.branchAgentId !== sample.maxChildAgentId) {
          branchSwitch = await switchToAgent(sample.branchAgentId, sample.branchWireBytes ?? 0, 'branch-open');
        }

        const guardSnapshot = guards.snapshot();
        const combinedHiddenUserTurns = [
          ...new Set([
            ...(coldVisibility.hiddenUserTurns ?? []),
            ...(scrollVisibility.hiddenUserTurns ?? []),
          ]),
        ];

        results.push({
          label: sample.label,
          stratum: sample.stratum,
          coldOpen: {
            ttfcMs: coldOpenMs,
            transcriptMounted,
            httpRequests: coldOpenHttpRequests,
            maxColdRpcMs: guardSnapshot.maxColdRpcMs,
            ...coldOpenLongTasks,
            ...coldOpenEld,
          },
          scrollOlder: {
            scrollWindowMs,
            scrolledSteps,
            httpRequests: scrollHttpRequests,
            layoutViolations: timelineCheck.failures.length,
            layoutFailureSamples: timelineCheck.failures.slice(0, 4),
            timelineFrames: timelineCheck.frames,
            ...scrollLongTasks,
            ...scrollEld,
          },
          subagentSwitch,
          branchSwitch,
          invariants: {
            contextMeter,
            addMenuScroll,
            mergedBranchesFolded,
            viewedSessionUnread,
            personaSingleRow,
            zeroFalseTopToast,
            scrollUpNoSnapBack,
            footerDrain,
            coldVisibility,
            scrollVisibility,
            hiddenUserTurnCount: combinedHiddenUserTurns.length,
            pageErrors: guardSnapshot.pageErrors,
            reactConsoleErrors: guardSnapshot.reactConsoleErrors,
            failedApiResponses: guardSnapshot.failedApiResponses,
            slowApiResponses: guardSnapshot.slowApiResponses,
          },
        });
      } finally {
        if (sampleAssetsRecorder) {
          await sampleAssetsRecorder.settle();
          desktopWebAssetsAudit = sampleAssetsRecorder.snapshot();
          sampleAssetsRecorder.detach();
        }
        await context.close().catch(() => undefined);
      }
    }

    // Mobile throttled leg (F7: 390x844 isMobile+hasTouch, 4x CPU, 40ms RTT, reducedMotion: no-preference)
    const heaviestMobileTarget =
      [...targets].toSorted((a, b) => (b.mainWireBytes ?? 0) - (a.mainWireBytes ?? 0))[0] ?? targets[0] ?? null;
    if (heaviestMobileTarget) {
      mobileLeg = await runMobileThrottledLeg({ browser, endpoint, deepLink, sample: heaviestMobileTarget });
    }

    // Once-per-run multi-route walk across Settings / Usage / Capabilities
    const walkContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    let capabilitiesToggle = null;
    try {
      await walkContext.addInitScript(() => {
        try {
          localStorage.setItem('kiki.locale', 'en');
          localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
        } catch {
          // Storage unavailable.
        }
      });
      const walkPage = await walkContext.newPage();
      const walkGuards = attachBrowserRuntimeGuards(walkPage, { endpoint, rpcSlowBudgetMs: 1_500 });
      const walkResult = await runAppRoutesWalk(walkPage, { deepLink, guards: walkGuards });
      routesWalk = walkResult.visited;
      capabilitiesToggle = walkResult.capabilitiesToggle;
      routesWalkGuards = walkGuards.snapshot();
    } finally {
      await walkContext.close().catch(() => undefined);
    }

    const totalPageErrors =
      results.reduce((acc, r) => acc + (r.invariants?.pageErrors?.length ?? 0), 0) +
      (routesWalkGuards?.pageErrors?.length ?? 0);
    const totalReactErrors =
      results.reduce((acc, r) => acc + (r.invariants?.reactConsoleErrors?.length ?? 0), 0) +
      (routesWalkGuards?.reactConsoleErrors?.length ?? 0);
    const totalFailedApiResponses =
      results.reduce((acc, r) => acc + (r.invariants?.failedApiResponses?.length ?? 0), 0) +
      (routesWalkGuards?.failedApiResponses?.length ?? 0);
    const totalSlowColdApiResponses = results.reduce(
      (acc, r) => acc + (r.invariants?.slowApiResponses?.length ?? 0),
      0,
    );
    const maxColdRpcMs = roundMs(Math.max(0, ...results.map((r) => r.coldOpen.maxColdRpcMs ?? 0)));
    const contextMeterFailures = results.filter(
      (r) => r.invariants?.contextMeter?.applicable && !r.invariants.contextMeter.ok,
    ).length;
    const addMenuScrollFailures = results.filter(
      (r) => r.invariants?.addMenuScroll?.applicable && !r.invariants.addMenuScroll.ok,
    ).length;
    const mergedBranchesFoldedFailures = results.filter(
      (r) => r.invariants?.mergedBranchesFolded?.applicable && !r.invariants.mergedBranchesFolded.ok,
    ).length;
    const scrollUpSnapBackFailures = results.filter(
      (r) => r.invariants?.scrollUpNoSnapBack?.applicable && !r.invariants.scrollUpNoSnapBack.ok,
    ).length;
    const viewedSessionUnreadFailures = results.filter(
      (r) => r.invariants?.viewedSessionUnread?.applicable && !r.invariants.viewedSessionUnread.ok,
    ).length;
    const personaSingleRowFailures = results.filter(
      (r) => r.invariants?.personaSingleRow?.applicable && !r.invariants.personaSingleRow.ok,
    ).length;
    const falseTopToastFailures = results.filter(
      (r) => r.invariants?.zeroFalseTopToast?.applicable && !r.invariants.zeroFalseTopToast.ok,
    ).length;
    const capabilitiesToggleFailures = capabilitiesToggle?.applicable && !capabilitiesToggle.ok ? 1 : 0;
    const footerDrainFailures = results.filter((r) => r.invariants?.footerDrain && !r.invariants.footerDrain.ok).length;
    const hiddenUserTurns = results.reduce((acc, r) => acc + (r.invariants?.hiddenUserTurnCount ?? 0), 0);
    const transcriptMountFailures = results.reduce((acc, r) => {
      let failed = 0;
      if (r.coldOpen.transcriptMounted === false) failed += 1;
      if (r.subagentSwitch && (!r.subagentSwitch.targetMounted || !r.subagentSwitch.itemsMounted)) failed += 1;
      if (r.branchSwitch && (!r.branchSwitch.targetMounted || !r.branchSwitch.itemsMounted)) failed += 1;
      return acc + failed;
    }, 0);

    const desktopWebAssetsGate = evaluateWebAssetsBudget(desktopWebAssetsAudit);
    return {
      guiBuild: {
        servedByKapServer: true,
        reusedCache: buildInfo?.reusedCache ?? null,
        buildMs: buildInfo?.buildMs ?? 0,
      },
      webAssetsAudit: desktopWebAssetsAudit,
      webAssetsGate: desktopWebAssetsGate,
      mobileLeg,
      sampleResults: results,
      routesWalk: {
        visited: routesWalk,
        capabilitiesToggle,
        pageErrors: routesWalkGuards?.pageErrors ?? [],
        reactConsoleErrors: routesWalkGuards?.reactConsoleErrors ?? [],
        failedApiResponses: routesWalkGuards?.failedApiResponses ?? [],
      },
      aggregates: {
        coldOpenTtfcMs: quantiles(results.map((r) => r.coldOpen.ttfcMs)),
        scrollMaxLongTaskMs: quantiles(results.map((r) => r.scrollOlder.maxLongTaskMs ?? 0)),
        subagentSwitchMs: quantiles(
          results.filter((r) => r.subagentSwitch !== null).map((r) => r.subagentSwitch.switchMs),
        ),
        totalLayoutViolations: results.reduce((acc, r) => acc + (r.scrollOlder.layoutViolations ?? 0), 0),
        totalPageErrors,
        totalReactErrors,
        totalFailedApiResponses,
        totalSlowColdApiResponses,
        maxColdRpcMs,
        contextMeterFailures,
        addMenuScrollFailures,
        mergedBranchesFoldedFailures,
        scrollUpSnapBackFailures,
        viewedSessionUnreadFailures,
        personaSingleRowFailures,
        falseTopToastFailures,
        capabilitiesToggleFailures,
        footerDrainFailures,
        hiddenUserTurns,
        transcriptMountFailures,
        webAssetsGatePassed: desktopWebAssetsGate.passed,
        mobileLegPassed: mobileLeg ? mobileLeg.passed : true,
        mobileFirstMessageVisibleMs: mobileLeg?.firstMessageVisibleMs ?? null,
        mobileColdOpenMaxLongTaskMs: mobileLeg?.coldOpenLongTasks?.maxLongTaskMs ?? null,
        mobileTouchScrollFrameP95Ms: mobileLeg?.touchScrollFramesMs?.p95 ?? null,
      },
    };
  } finally {
    eld.dispose();
    await browser.close().catch(() => undefined);
  }
}
