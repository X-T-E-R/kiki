import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
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
  attachBrowserRuntimeGuards,
  runAppRoutesWalk,
  verifyAddMenuSecondaryScrollable,
  verifyColdContextMeter,
  verifyComposerFooterDrain,
  verifyRightRailMergedBranchesFolded,
  verifyScrollUpNoSnapBack,
} from './browser-invariants.mjs';
import { EventLoopWindowMonitor, quantiles, roundMs } from './metrics.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GUI_ROOT = path.join(REPO_ROOT, 'apps', 'kiki-gui');

const kapRequire = createRequire(new URL('../../packages/kap-server/package.json', import.meta.url));
const { chromium } = kapRequire('playwright');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

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

function startStaticGuiServer(distDir) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (urlPath === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = path.normalize(path.join(distDir, urlPath));
    if (!file.startsWith(distDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(distDir, 'index.html');
    }
    const stream = fs.createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      stream.pipe(res);
    });
    stream.once('error', () => {
      if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
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

export async function runBrowserSuite({ endpoint, token, samples, maxPerStratum = 1 }) {
  const buildInfo = ensureGuiStaticBuild();
  const staticServer = await startStaticGuiServer(buildInfo.distDir);
  const webUrl = `http://127.0.0.1:${staticServer.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  const eld = new EventLoopWindowMonitor(20);
  const targets = selectBrowserRepresentatives(samples, maxPerStratum);
  const results = [];
  let routesWalk = null;
  let routesWalkGuards = null;

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
        await context.close().catch(() => undefined);
      }
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

    return {
      guiBuild: { reusedCache: buildInfo.reusedCache, buildMs: buildInfo.buildMs },
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
        capabilitiesToggleFailures,
        footerDrainFailures,
        hiddenUserTurns,
        transcriptMountFailures,
      },
    };
  } finally {
    eld.dispose();
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => {
      staticServer.close(() => resolve());
    });
  }
}
