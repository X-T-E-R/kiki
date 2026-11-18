import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { installTimelineMonitor } from '../../apps/kiki-gui/scripts/timeline-integrity.mjs';
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

        let phaseApiRequests = 0;
        page.on('request', (req) => {
          if (req.url().startsWith(endpoint)) {
            phaseApiRequests += 1;
          }
        });

        const deepLink = (routePath) =>
          `${webUrl}${routePath}?server=${encodeURIComponent(endpoint)}&token=${encodeURIComponent(token)}`;

        phaseApiRequests = 0;
        eld.beginWindow();
        const openStarted = performance.now();
        await page.goto(deepLink(`/s/${sample.sandboxId}`), {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        await page.waitForSelector('[data-session-sidebar]', { timeout: 45_000 });
        await page
          .waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 30_000 })
          .catch(() => undefined);
        const coldOpenMs = roundMs(performance.now() - openStarted);
        const coldOpenLongTasks = await page.evaluate(() => window.__kikiPerfProbe?.drain?.() ?? null);
        const coldOpenEld = eld.endWindow();
        const coldOpenHttpRequests = phaseApiRequests;

        phaseApiRequests = 0;
        eld.beginWindow();
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
        const layoutIntegrity = await page.evaluate(() => {
          const violations = window.__kikiTimeline?.scan?.() ?? [];
          return { violationCount: violations.length };
        });
        const scrollEld = eld.endWindow();
        const scrollHttpRequests = phaseApiRequests;

        let subagentSwitch = null;
        if (sample.maxChildAgentId) {
          phaseApiRequests = 0;
          eld.beginWindow();
          await page.evaluate(() => window.__kikiPerfProbe?.reset?.());
          const subId = sample.maxChildAgentId;
          const switchStarted = performance.now();
          await page.evaluate(
            ({ sid, aid }) => {
              const search = window.location.search;
              window.history.pushState({}, '', `/s/${sid}/agent/${encodeURIComponent(aid)}${search}`);
              window.dispatchEvent(new PopStateEvent('popstate'));
            },
            { sid: sample.sandboxId, aid: subId },
          );
          await page
            .waitForSelector(`[data-agent-workspace-target="${subId}"]`, { timeout: 20_000 })
            .catch(() => undefined);
          await page
            .waitForSelector(`[data-agent-workspace-target="${subId}"] [data-transcript-virtual-item]`, {
              timeout: 15_000,
            })
            .catch(() => undefined);
          const switchMs = roundMs(performance.now() - switchStarted);
          const switchLongTasks = await page.evaluate(() => window.__kikiPerfProbe?.drain?.() ?? null);
          const switchEld = eld.endWindow();
          subagentSwitch = {
            switchMs,
            httpRequests: phaseApiRequests,
            ...switchLongTasks,
            ...switchEld,
          };
        }

        results.push({
          label: sample.label,
          stratum: sample.stratum,
          coldOpen: {
            ttfcMs: coldOpenMs,
            httpRequests: coldOpenHttpRequests,
            ...coldOpenLongTasks,
            ...coldOpenEld,
          },
          scrollOlder: {
            scrollWindowMs,
            scrolledSteps,
            httpRequests: scrollHttpRequests,
            layoutViolations: layoutIntegrity.violationCount,
            ...scrollLongTasks,
            ...scrollEld,
          },
          subagentSwitch,
        });
      } finally {
        await context.close().catch(() => undefined);
      }
    }

    return {
      guiBuild: { reusedCache: buildInfo.reusedCache, buildMs: buildInfo.buildMs },
      sampleResults: results,
      aggregates: {
        coldOpenTtfcMs: quantiles(results.map((r) => r.coldOpen.ttfcMs)),
        scrollMaxLongTaskMs: quantiles(results.map((r) => r.scrollOlder.maxLongTaskMs ?? 0)),
        subagentSwitchMs: quantiles(
          results.filter((r) => r.subagentSwitch !== null).map((r) => r.subagentSwitch.switchMs),
        ),
        totalLayoutViolations: results.reduce((acc, r) => acc + (r.scrollOlder.layoutViolations ?? 0), 0),
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
