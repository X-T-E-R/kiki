/**
 * kiki-gui mobile & visual geometry rigor gate.
 *
 * Exercises real headless Chromium CDP mobile emulation:
 * - Emulation.setDeviceMetricsOverride + Emulation.setTouchEmulationEnabled (pointer: coarse, hover: none)
 * - Emulation.setSafeAreaInsetsOverride (native CSS env(safe-area-inset-*))
 * - Portrait phone (393x852, top=59/bottom=34), Landscape phone (852x393 >767px, left/right=59/bottom=21),
 *   Android narrow (360x800, top=28/bottom=24), iPad portrait (820x1180 >767px, top=24/bottom=20)
 * - Soft keyboard open state (shrunk visualViewport + iOS WebKit visualViewport.offsetTop > 0)
 * - Real `app-shell` connection mode (`KikiApp/ios` UA + same-origin staged credential + multi-space fixture)
 * - Real Mobile Launcher (`apps/kiki-gui/mobile/launcher/index.html`) flows (long hostnames, offline probe, keyboard open)
 * - Geometry & Anti-Slop Invariants (WCAG 2.2 SC 2.5.8 / Apple HIG touch targets, blank-void detector,
 *   dead-link / duplicate-icon / t0 false-error detectors)
 *
 * Usage:
 *   node scripts/visual-proof-mobile-rigor.mjs                     # strict gate (exit 1 on any finding)
 *   node scripts/visual-proof-mobile-rigor.mjs --report-findings   # audit mode: emit structured JSON report of live bugs on HEAD
 *   node scripts/visual-proof-mobile-rigor.mjs --no-build          # reuse cached dist build
 *   node scripts/visual-proof-mobile-rigor.mjs --only=iphone-landscape-safe-area,app-shell-spaces-contract
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { buildCacheKey } from '../proof/runner.mjs';
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import {
  collectMobileDomSnapshot,
  evaluateContradictoryUiState,
  evaluateSafeAreaGeometry,
  evaluateSoftKeyboardGeometry,
  evaluateTouchTargets,
  evaluateUnintendedBlankVoids,
  MOBILE_DEVICE_PROFILES,
} from './lib/mobile-geometry-probes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_DIR = join(ROOT, 'mobile', 'launcher');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

export function parseMobileRigorArgs(argv) {
  const reportFindings = argv.includes('--report-findings');
  const strict = argv.includes('--strict') || !reportFindings;
  const noBuild = argv.includes('--no-build');
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',').filter(Boolean) : null;
  const outArg = argv.find((a) => a.startsWith('--out-dir='));
  const outDir = outArg
    ? resolve(outArg.slice('--out-dir='.length))
    : resolve(process.env.KIKI_MOBILE_RIGOR_OUT ?? join(ROOT, '.tmp', 'mobile-rigor', new Date().toISOString().replace(/[:.]/g, '-')));
  const reportJsonArg = argv.find((a) => a.startsWith('--out-json='));
  const reportJsonPath = reportJsonArg ? resolve(reportJsonArg.slice('--out-json='.length)) : join(outDir, 'mobile-rigor-report.json');
  return { reportFindings, strict, noBuild, only, outDir, reportJsonPath };
}

function ensureGuiBuild(distDir, noBuild) {
  const cacheKey = buildCacheKey(ROOT);
  const keyFile = join(distDir, '.kiki-build-key');
  const cached =
    cacheKey !== null
    && existsSync(join(distDir, 'index.html'))
    && existsSync(keyFile)
    && readFileSync(keyFile, 'utf8') === cacheKey;

  if ((noBuild && existsSync(join(distDir, 'index.html'))) || cached) {
    console.log(`[mobile-rigor] reusing build in ${distDir}`);
    return 0;
  }
  const t0 = Date.now();
  console.log(`[mobile-rigor] building GUI -> ${distDir}`);
  const res = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', distDir, '--emptyOutDir', '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', timeout: 180_000 },
  );
  if (res.status !== 0) throw new Error(`vite build failed with status ${res.status}`);
  if (cacheKey !== null) writeFileSync(keyFile, cacheKey);
  return Date.now() - t0;
}

/**
 * Serves the static production GUI build on a single origin AND proxies `/api/*`
 * and `/api/ws` upgrades to the fixture server. This matches the exact Capacitor
 * `app-shell` topology where the WebView loads the GUI directly from the paired
 * computer's origin and adopts `document.__kikiShellStagedCredential`.
 */
function startSameOriginProxyServer(staticDir, fixturePort) {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    if (pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/__control')) {
      const proxyReq = httpRequest(
        {
          hostname: '127.0.0.1',
          port: fixturePort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${fixturePort}` },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 502, msg: err.message }));
      });
      req.pipe(proxyReq);
      return;
    }

    let file = normalize(join(staticDir, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(staticDir + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(staticDir, 'index.html');
    }
    const stream = createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      stream.pipe(res);
    });
    stream.once('error', () => {
      if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const upstream = netConnect(fixturePort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const val = req.rawHeaders[i + 1];
        lines.push(`${key}: ${key.toLowerCase() === 'host' ? `127.0.0.1:${fixturePort}` : val}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

function startStaticDirectoryServer(dir) {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(reqUrl.pathname);
    let file = normalize(join(dir, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(dir, 'index.html');
    }
    const stream = createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      stream.pipe(res);
    });
    stream.once('error', () => {
      if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

async function applyMobileCdpEmulation(page, profile) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: profile.deviceScaleFactor,
    mobile: profile.isMobile,
    screenWidth: profile.width,
    screenHeight: profile.height,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: profile.hasTouch,
    maxTouchPoints: 5,
  });
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: {
      top: profile.safeArea.top,
      bottom: profile.safeArea.bottom,
      left: profile.safeArea.left,
      right: profile.safeArea.right,
    },
  });
  return cdp;
}

async function createMobilePage(browser, profile, { locale = 'en', theme = 'light', appShellToken = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    userAgent: profile.userAgent,
    reducedMotion: 'reduce',
  });

  await context.addInitScript(({ loc, thm, token }) => {
    try {
      localStorage.setItem('kiki.locale', loc);
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: thm }));
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      if (token) {
        // Real Capacitor app-shell same-origin staged credential contract (`apps/kiki-gui/src/lib/appShell.ts`).
        Object.defineProperty(document, '__kikiShellStagedCredential', {
          configurable: true,
          enumerable: false,
          value: { origin: window.location.origin, token },
        });
      }
    } catch { /* ignore */ }
  }, { loc: locale, thm: theme, token: appShellToken });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const cdp = await applyMobileCdpEmulation(page, profile);
  return { context, page, cdp, pageErrors };
}

async function captureShot(page, outDir, name) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(
      (a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity,
    );
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  }).catch(() => undefined);
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path });
  return `${name}.png`;
}

async function openFixtureSession(page, origin, sessionId, { useDeepLink = true } = {}) {
  const target = useDeepLink
    ? `${origin}/s/${sessionId}?server=${encodeURIComponent(origin)}&token=${FIXTURE_TOKEN}`
    : `${origin}/s/${sessionId}`;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('[data-session-sidebar]', { timeout: 25_000 });
  await page.waitForSelector('[data-composer-card]', { timeout: 25_000 });
  await page.waitForTimeout(450);
}

const SCENARIOS = [
  {
    id: 'iphone-portrait-session',
    profileId: 'iphone-16-portrait',
    fixture: 'rail-scale',
    async run({ browser, distDir, outDir }) {
      const profile = MOBILE_DEVICE_PROFILES[this.profileId];
      const fixture = await startFixtureServer({ port: 0, scenario: this.fixture });
      const proxy = await startSameOriginProxyServer(distDir, fixture.http.address().port);
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      const { context, page, pageErrors } = await createMobilePage(browser, profile, { appShellToken: FIXTURE_TOKEN });
      try {
        await openFixtureSession(page, origin, 'session_fixture_rail_fleet', { useDeepLink: false });
        const snap = await page.evaluate(collectMobileDomSnapshot);
        const shots = [await captureShot(page, outDir, 'iphone-portrait-session')];

        // Open sidebar drawer to inspect drawer geometry & blank voids
        const menuBtn = page.locator('[data-sidebar-menu]').first();
        if (await menuBtn.isVisible()) {
          await menuBtn.click();
          await page.waitForTimeout(300);
          shots.push(await captureShot(page, outDir, 'iphone-portrait-sidebar-open'));
        }
        const drawerSnap = await page.evaluate(collectMobileDomSnapshot);

        const findings = [
          ...evaluateSafeAreaGeometry({ ...snap, safeArea: profile.safeArea, requireHeader: true, requireComposer: true }),
          ...evaluateTouchTargets(snap.controls, { coarsePointer: snap.media.coarsePointer }),
          ...evaluateUnintendedBlankVoids([...snap.blankVoidBlocks, ...drawerSnap.blankVoidBlocks]),
          ...evaluateContradictoryUiState({ toasts: snap.toasts, atT0Top: true, hasRedLoadError: snap.toasts.some((t) => t.tone === 'error') }),
        ];
        return { profile: profile.standard, pageErrors, shots, findings, metrics: { headerRect: snap.headerRect, composerRect: snap.composerRect, horizontalOverflowPx: snap.horizontalOverflowPx, rootCssVars: snap.rootCssVars } };
      } finally {
        await context.close().catch(() => undefined);
        await new Promise((r) => proxy.close(r));
        await fixture.stop().catch(() => undefined);
      }
    },
  },
  {
    id: 'iphone-landscape-safe-area',
    profileId: 'iphone-16-landscape',
    fixture: 'basic-stream',
    async run({ browser, distDir, outDir }) {
      const profile = MOBILE_DEVICE_PROFILES[this.profileId];
      const fixture = await startFixtureServer({ port: 0, scenario: this.fixture });
      const proxy = await startSameOriginProxyServer(distDir, fixture.http.address().port);
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      const { context, page, pageErrors } = await createMobilePage(browser, profile, { appShellToken: FIXTURE_TOKEN });
      try {
        await openFixtureSession(page, origin, 'session_fixture_basic', { useDeepLink: false });
        const snap = await page.evaluate(collectMobileDomSnapshot);
        const shots = [await captureShot(page, outDir, 'iphone-landscape-safe-area')];
        const findings = [
          ...evaluateSafeAreaGeometry({ ...snap, safeArea: profile.safeArea, requireHeader: true, requireComposer: true }),
          ...evaluateTouchTargets(snap.controls, { coarsePointer: snap.media.coarsePointer }),
          ...evaluateUnintendedBlankVoids(snap.blankVoidBlocks),
        ];
        return { profile: profile.standard, pageErrors, shots, findings, metrics: { headerRect: snap.headerRect, composerRect: snap.composerRect, stagePadding: snap.stagePadding, horizontalOverflowPx: snap.horizontalOverflowPx } };
      } finally {
        await context.close().catch(() => undefined);
        await new Promise((r) => proxy.close(r));
        await fixture.stop().catch(() => undefined);
      }
    },
  },
  {
    id: 'ipad-portrait-safe-area',
    profileId: 'ipad-portrait',
    fixture: 'basic-stream',
    async run({ browser, distDir, outDir }) {
      const profile = MOBILE_DEVICE_PROFILES[this.profileId];
      const fixture = await startFixtureServer({ port: 0, scenario: this.fixture });
      const proxy = await startSameOriginProxyServer(distDir, fixture.http.address().port);
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      const { context, page, pageErrors } = await createMobilePage(browser, profile, { appShellToken: FIXTURE_TOKEN });
      try {
        await openFixtureSession(page, origin, 'session_fixture_basic', { useDeepLink: false });
        const snap = await page.evaluate(collectMobileDomSnapshot);
        const shots = [await captureShot(page, outDir, 'ipad-portrait-safe-area')];
        const findings = [
          ...evaluateSafeAreaGeometry({ ...snap, safeArea: profile.safeArea, requireHeader: true, requireComposer: true }),
          ...evaluateTouchTargets(snap.controls, { coarsePointer: snap.media.coarsePointer }),
          ...evaluateUnintendedBlankVoids(snap.blankVoidBlocks),
        ];
        return { profile: profile.standard, pageErrors, shots, findings, metrics: { headerRect: snap.headerRect, composerRect: snap.composerRect, stagePadding: snap.stagePadding } };
      } finally {
        await context.close().catch(() => undefined);
        await new Promise((r) => proxy.close(r));
        await fixture.stop().catch(() => undefined);
      }
    },
  },
  {
    id: 'android-narrow-360',
    profileId: 'android-narrow',
    fixture: 'basic-stream',
    async run({ browser, distDir, outDir }) {
      const profile = MOBILE_DEVICE_PROFILES[this.profileId];
      const fixture = await startFixtureServer({ port: 0, scenario: this.fixture });
      const proxy = await startSameOriginProxyServer(distDir, fixture.http.address().port);
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      const { context, page, pageErrors } = await createMobilePage(browser, profile, { appShellToken: FIXTURE_TOKEN });
      try {
        await openFixtureSession(page, origin, 'session_fixture_basic', { useDeepLink: false });
        const snap = await page.evaluate(collectMobileDomSnapshot);
        const shots = [await captureShot(page, outDir, 'android-narrow-360')];
        const findings = [
          ...evaluateSafeAreaGeometry({ ...snap, safeArea: profile.safeArea, requireHeader: true, requireComposer: true }),
          ...evaluateTouchTargets(snap.controls, { coarsePointer: snap.media.coarsePointer }),
          ...evaluateUnintendedBlankVoids(snap.blankVoidBlocks),
        ];
        return { profile: profile.standard, pageErrors, shots, findings, metrics: { headerRect: snap.headerRect, composerRect: snap.composerRect, horizontalOverflowPx: snap.horizontalOverflowPx } };
      } finally {
        await context.close().catch(() => undefined);
        await new Promise((r) => proxy.close(r));
        await fixture.stop().catch(() => undefined);
      }
    },
  },
  {
    id: 'ios-soft-keyboard-offset',
    profileId: 'iphone-16-portrait',
    fixture: 'basic-stream',
    async run({ browser, distDir, outDir }) {
      const profile = MOBILE_DEVICE_PROFILES[this.profileId];
      const fixture = await startFixtureServer({ port: 0, scenario: this.fixture });
      const proxy = await startSameOriginProxyServer(distDir, fixture.http.address().port);
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      const { context, page, pageErrors } = await createMobilePage(browser, profile, { appShellToken: FIXTURE_TOKEN });
      try {
        await openFixtureSession(page, origin, 'session_fixture_basic', { useDeepLink: false });
        const composerInput = page.locator('[data-composer-input]').first();
        await composerInput.click();
        await page.waitForTimeout(150);

        // Emulate iOS WKWebView/Safari soft keyboard opening:
        // layout viewport stays 852px tall, visualViewport shrinks to 480px AND WebKit
        // shifts visualViewport.offsetTop to +180px (the exact bug documented in Apple Dev Forums #800125).
        await page.evaluate(() => {
          const vv = window.visualViewport;
          if (!vv) return;
          const proto = Object.getPrototypeOf(vv);
          Object.defineProperty(vv, 'height', { configurable: true, get: () => 480 });
          Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 180 });
          if (proto) {
            vv.dispatchEvent(new Event('resize'));
            vv.dispatchEvent(new Event('scroll'));
          }
        });
        await page.waitForTimeout(300);

        const snap = await page.evaluate(collectMobileDomSnapshot);
        const shots = [await captureShot(page, outDir, 'ios-soft-keyboard-offset')];
        const findings = evaluateSoftKeyboardGeometry({
          headerRect: snap.headerRect,
          composerRect: snap.composerRect,
          visualViewport: snap.visualViewport,
          safeArea: profile.safeArea,
          rootVisualHeightVar: snap.rootCssVars.visualHeight,
          rootOffsetTopVar: snap.rootCssVars.offsetTop,
        });
        return {
          profile: profile.standard,
          pageErrors,
          shots,
          findings,
          metrics: {
            visualViewport: snap.visualViewport,
            headerRect: snap.headerRect,
            composerRect: snap.composerRect,
            rootCssVars: snap.rootCssVars,
          },
        };
      } finally {
        await context.close().catch(() => undefined);
        await new Promise((r) => proxy.close(r));
        await fixture.stop().catch(() => undefined);
      }
    },
  },
  {
    id: 'app-shell-spaces-contract',
    profileId: 'iphone-16-portrait',
    fixture: 'spaces',
    async run({ browser, distDir, outDir }) {
      const profile = MOBILE_DEVICE_PROFILES[this.profileId];
      const fixture = await startFixtureServer({ port: 0, scenario: this.fixture });
      const proxy = await startSameOriginProxyServer(distDir, fixture.http.address().port);
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      const { context, page, pageErrors } = await createMobilePage(browser, profile, { appShellToken: FIXTURE_TOKEN });
      try {
        // Navigate without ?server= deep link so ConnectionProvider adopts the real `app-shell` credential!
        await page.goto(`${origin}/s/session_space_one`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForSelector('[data-session-sidebar]', { timeout: 25_000 });
        await page.waitForTimeout(450);

        // Open sidebar drawer on phone, then open SpaceSwitcher
        const menuBtn = page.locator('[data-sidebar-menu], button[aria-label="Open menu"], button[aria-label="打开菜单"]').first();
        await menuBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await menuBtn.click();
        await page.waitForSelector('aside.app-sidebar.open', { timeout: 10_000 });
        await page.waitForTimeout(250);
        const switcher = page.locator('[data-space-switcher], [data-space-remote]').first();
        await switcher.waitFor({ state: 'visible', timeout: 10_000 });
        await switcher.click();
        await page.waitForSelector('[data-space-switcher-menu]', { timeout: 10_000 });
        await page.waitForTimeout(450);

        const snap = await page.evaluate(collectMobileDomSnapshot);
        const shots = [await captureShot(page, outDir, 'app-shell-spaces-sheet')];

        // Inspect both registered spaces from fixtures/spaces.scenario.mjs and drive a real space switch.
        const spaceCheck = await page.evaluate(() => {
          const menu = document.querySelector('[data-space-switcher-menu]');
          const items = menu ? [...menu.querySelectorAll('[data-space-item], button[role="menuitem"], button')] : [];
          const labels = items.map((el) => (el.textContent ?? '').trim()).filter(Boolean);
          return {
            hasAcme: labels.some((t) => t.includes('ACME confidential')),
            hasThesis: labels.some((t) => t.includes('Thesis writing')),
            labels: labels.slice(0, 12),
          };
        });

        let spaceSwitchAttempted = false;
        let spaceSwitchSucceeded = false;
        const targetSpaceBtn = page.locator('[data-space-switcher-menu] button', { hasText: 'ACME confidential' }).first();
        if (await targetSpaceBtn.isVisible().catch(() => false)) {
          spaceSwitchAttempted = true;
          await targetSpaceBtn.click();
          await page.waitForTimeout(350);
          spaceSwitchSucceeded = await page
            .evaluate(() => {
              const switcherText = (document.querySelector('[data-space-switcher], [data-space-remote]')?.textContent ?? '').trim();
              const menuClosed = document.querySelector('[data-space-switcher-menu]') === null;
              return menuClosed && switcherText.includes('ACME confidential');
            })
            .catch(() => false);
        }

        const findings = [
          ...evaluateContradictoryUiState({
            connectionSource: 'app-shell',
            hasLocalDaemon: false,
            spaceSwitcherOpen: snap.spaceSwitcherOpen,
            hasBackToLocal: snap.hasBackToLocal,
            spaceItemCount: snap.spaceItemCount,
            expectedMinSpaces: 2,
            toasts: snap.toasts,
          }),
          ...(!spaceCheck.hasAcme || !spaceCheck.hasThesis
            ? [{
                ruleId: 'APP_SHELL_MISSING_REGISTERED_SPACES',
                severity: 'error',
                standard: 'app-shell SpaceSwitcher must expose both registered fixture spaces (ACME confidential & Thesis writing)',
                actual: spaceCheck,
                expected: { hasAcme: true, hasThesis: true },
              }]
            : []),
          ...(!spaceSwitchSucceeded
            ? [{
                ruleId: 'APP_SHELL_SPACE_SWITCH_FAILED',
                severity: 'error',
                standard: 'Clicking a registered space in app-shell SpaceSwitcher must switch active space cleanly',
                actual: { spaceSwitchAttempted, spaceSwitchSucceeded, spaceItemCount: snap.spaceItemCount },
                expected: { spaceSwitchAttempted: true, spaceSwitchSucceeded: true },
              }]
            : []),
          ...evaluateTouchTargets(snap.controls, { coarsePointer: snap.media.coarsePointer }),
          ...evaluateUnintendedBlankVoids(snap.blankVoidBlocks),
        ];
        return {
          profile: profile.standard,
          pageErrors,
          shots,
          findings,
          metrics: {
            spaceSwitcherOpen: snap.spaceSwitcherOpen,
            spaceItemCount: snap.spaceItemCount,
            hasBackToLocal: snap.hasBackToLocal,
            spaceCheck,
            spaceSwitchAttempted,
            spaceSwitchSucceeded,
          },
        };
      } finally {
        await context.close().catch(() => undefined);
        await new Promise((r) => proxy.close(r));
        await fixture.stop().catch(() => undefined);
      }
    },
  },
  {
    id: 'extreme-dirty-transcript-mobile',
    profileId: 'iphone-16-portrait',
    fixture: 'extreme-dirty-transcript',
    async run({ browser, distDir, outDir }) {
      const profile = MOBILE_DEVICE_PROFILES[this.profileId];
      const fixture = await startFixtureServer({ port: 0, scenario: this.fixture });
      const proxy = await startSameOriginProxyServer(distDir, fixture.http.address().port);
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      const { context, page, pageErrors } = await createMobilePage(browser, profile, { appShellToken: FIXTURE_TOKEN });
      try {
        await openFixtureSession(page, origin, 'session_fixture_extreme_dirty', { useDeepLink: false });
        await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 20_000 });
        await page.waitForTimeout(300);
        const snap = await page.evaluate(collectMobileDomSnapshot);
        const shots = [await captureShot(page, outDir, 'extreme-dirty-transcript-mobile')];
        const renderedCount = await page.locator('[data-transcript-scroll] [data-transcript-virtual-item]').count();
        const findings = [
          ...evaluateSafeAreaGeometry({ ...snap, safeArea: profile.safeArea, requireHeader: true, requireComposer: true }),
          ...evaluateTouchTargets(snap.controls, { coarsePointer: snap.media.coarsePointer }),
          ...evaluateUnintendedBlankVoids(snap.blankVoidBlocks),
          ...evaluateContradictoryUiState({
            toasts: snap.toasts,
            atT0Top: true,
            hasRedLoadError: snap.toasts.some((t) => t.tone === 'error'),
          }),
          ...(renderedCount === 0
            ? [{
                ruleId: 'DIRTY_TRANSCRIPT_EMPTY',
                severity: 'error',
                standard: 'Extreme 220-turn CJK/code/error/attachment transcript must mount visible virtualized items on mobile',
                actual: { renderedCount },
                expected: { minRenderedItems: 1 },
              }]
            : []),
        ];
        return {
          profile: profile.standard,
          pageErrors,
          shots,
          findings,
          metrics: {
            renderedCount,
            horizontalOverflowPx: snap.horizontalOverflowPx,
            headerRect: snap.headerRect,
            composerRect: snap.composerRect,
          },
        };
      } finally {
        await context.close().catch(() => undefined);
        await new Promise((r) => proxy.close(r));
        await fixture.stop().catch(() => undefined);
      }
    },
  },
  {
    id: 'mobile-launcher-flows',
    profileId: 'iphone-16-portrait',
    fixture: null,
    async run({ browser, outDir }) {
      const profile = MOBILE_DEVICE_PROFILES[this.profileId];
      const server = await startStaticDirectoryServer(LAUNCHER_DIR);
      const origin = `http://127.0.0.1:${server.address().port}`;
      const { context, page, pageErrors } = await createMobilePage(browser, profile);
      try {
        // Seed multi-machine paired computers using the real `STORE_SERVERS_KEY = 'kiki.shell.servers'` schema (`apps/kiki-gui/mobile/src/target.ts`).
        await page.addInitScript(() => {
          const originA = 'http://studio-workstation.example.test:5494';
          const originALan = 'http://198.51.100.142:5494';
          const originB = 'https://laptop-remote-gateway-very-long-subdomain.example.test:8443';
          const seeded = [
            {
              id: 'srv-workstation-01',
              label: 'Studio GPU Dev Workstation',
              origin: originA,
              origins: [originA, originALan],
              verifiedOrigins: [originA, originALan],
              paired: true,
              targetHomeId: 'home-studio-ws',
              updatedAt: Date.now() - 120_000,
            },
            {
              id: 'srv-macbook-02',
              label: 'MacBook Air M4 Office',
              origin: originB,
              origins: [originB],
              verifiedOrigins: [originB],
              paired: true,
              targetHomeId: 'home-macbook-m4',
              updatedAt: Date.now() - 3_600_000,
            },
          ];
          localStorage.setItem('kiki.shell.servers', JSON.stringify(seeded));
          localStorage.setItem('kiki.shell.origin', originA);
        });

        await page.goto(`${origin}/index.html#change`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForSelector('#view-computers:not([hidden])', { timeout: 10_000 });
        await page.waitForSelector('#recent-list .saved-card', { timeout: 10_000 });
        await page.waitForTimeout(250);

        const shots = [];
        const allFindings = [];

        // 1. Computers tab (default initial view when paired servers exist)
        const savedCardCount = await page.locator('#recent-list .saved-card').count();
        if (savedCardCount < 2) {
          allFindings.push({
            ruleId: 'LAUNCHER_PAIRED_COMPUTERS_MISSING',
            severity: 'error',
            standard: 'Mobile launcher Computers tab must render seeded paired servers',
            actual: { savedCardCount },
            expected: { minSavedCardCount: 2 },
          });
        }
        const compSnap = await page.evaluate(collectMobileDomSnapshot);
        shots.push(await captureShot(page, outDir, 'launcher-computers-portrait'));
        allFindings.push(
          ...evaluateSafeAreaGeometry({ ...compSnap, safeArea: profile.safeArea }),
          ...evaluateTouchTargets(compSnap.controls, { coarsePointer: compSnap.media.coarsePointer }),
        );

        // 2. Connect view + manual entry + keyboard-open state + long URL
        await page.locator('button.tab[data-tab="connect"]').click();
        await page.waitForSelector('#view-connect:not([hidden])', { timeout: 5_000 });
        await page.waitForTimeout(200);
        const connectSnap = await page.evaluate(collectMobileDomSnapshot);
        shots.push(await captureShot(page, outDir, 'launcher-connect-portrait'));
        allFindings.push(
          ...evaluateSafeAreaGeometry({ ...connectSnap, safeArea: profile.safeArea }),
          ...evaluateTouchTargets(connectSnap.controls, { coarsePointer: connectSnap.media.coarsePointer }),
        );

        const manualToggle = page.locator('#manual-toggle');
        if (await manualToggle.isVisible()) {
          await manualToggle.click();
          await page.waitForSelector('#connect:not([hidden])', { timeout: 5_000 });
        }
        await page.locator('#server').fill('http://unreachable-tailnet-host.example.test:5494');
        await page.evaluate(() => { document.body.classList.add('keyboard-open'); });
        await page.waitForTimeout(200);
        const kbSnap = await page.evaluate(collectMobileDomSnapshot);
        shots.push(await captureShot(page, outDir, 'launcher-connect-keyboard'));
        allFindings.push(...evaluateSafeAreaGeometry({ ...kbSnap, safeArea: profile.safeArea }));
        await page.evaluate(() => { document.body.classList.remove('keyboard-open'); });

        // 3. Network tab offline probe
        await page.locator('button.tab[data-tab="network"]').click();
        await page.waitForSelector('#view-network:not([hidden])', { timeout: 5_000 });
        await page.locator('#probe-address').fill('http://127.0.0.1:1');
        await page.locator('#test-server').click();
        await page.waitForTimeout(700);
        const netSnap = await page.evaluate(collectMobileDomSnapshot);
        shots.push(await captureShot(page, outDir, 'launcher-network-offline'));
        allFindings.push(
          ...evaluateSafeAreaGeometry({ ...netSnap, safeArea: profile.safeArea }),
          ...evaluateTouchTargets(netSnap.controls, { coarsePointer: netSnap.media.coarsePointer }),
        );

        return {
          profile: profile.standard,
          pageErrors,
          shots,
          findings: allFindings,
          metrics: {
            connectOverflowPx: connectSnap.horizontalOverflowPx,
            computersOverflowPx: compSnap.horizontalOverflowPx,
            networkOverflowPx: netSnap.horizontalOverflowPx,
          },
        };
      } finally {
        await context.close().catch(() => undefined);
        await new Promise((r) => server.close(r));
      }
    },
  },
];

async function main() {
  const opts = parseMobileRigorArgs(process.argv.slice(2));
  mkdirSync(opts.outDir, { recursive: true });
  const distDir = resolve(process.env.KIKI_PROOF_DIST_DIR?.trim() || join(ROOT, '.tmp', 'visual-proof', 'dist'));
  const selected = opts.only ? SCENARIOS.filter((s) => opts.only.includes(s.id)) : SCENARIOS;
  if (selected.length === 0) throw new Error(`No scenarios matched --only=${opts.only?.join(',')}`);

  const needsGuiBuild = selected.some((s) => s.fixture !== null);
  const buildMs = needsGuiBuild ? ensureGuiBuild(distDir, opts.noBuild) : 0;

  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const startedAt = Date.now();
  const results = [];
  try {
    for (const scenario of selected) {
      const t0 = Date.now();
      try {
        const res = await scenario.run({ browser, distDir, outDir: opts.outDir });
        const errors = res.findings.filter((f) => f.severity === 'error');
        const warnings = res.findings.filter((f) => f.severity === 'warning');
        results.push({
          id: scenario.id,
          profile: res.profile,
          ms: Date.now() - t0,
          ok: res.pageErrors.length === 0 && errors.length === 0,
          pageErrors: res.pageErrors,
          errorCount: errors.length,
          warningCount: warnings.length,
          findings: res.findings,
          shots: res.shots,
          metrics: res.metrics,
        });
        console.log(
          `[mobile-rigor] ${errors.length === 0 && res.pageErrors.length === 0 ? 'PASS' : 'FIND'} `
          + `${scenario.id} (${Date.now() - t0}ms) errors=${errors.length} warnings=${warnings.length} shots=${res.shots.length}`,
        );
      } catch (err) {
        results.push({
          id: scenario.id,
          ms: Date.now() - t0,
          ok: false,
          harnessError: err instanceof Error ? err.message : String(err),
          errorCount: 1,
          warningCount: 0,
          findings: [],
          shots: [],
        });
        console.error(`[mobile-rigor] HARNESS_FAIL ${scenario.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const harnessFailures = results.filter((r) => Boolean(r.harnessError) || (r.pageErrors?.length ?? 0) > 0);
  const allFindings = results.flatMap((r) => r.findings.map((f) => ({ scenario: r.id, ...f })));
  const errorFindings = allFindings.filter((f) => f.severity === 'error');
  const warningFindings = allFindings.filter((f) => f.severity === 'warning');

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: opts.reportFindings ? 'report-findings' : 'strict',
    outputDir: opts.outDir,
    buildMs,
    totalMs: Date.now() - startedAt,
    scenariosRun: results.length,
    harnessFailureCount: harnessFailures.length,
    errorFindingCount: errorFindings.length,
    warningFindingCount: warningFindings.length,
    findingsByRule: allFindings.reduce((acc, f) => {
      acc[f.ruleId] = (acc[f.ruleId] ?? 0) + 1;
      return acc;
    }, {}),
    results,
  };

  writeFileSync(opts.reportJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`[mobile-rigor] report written -> ${opts.reportJsonPath}`);
  console.log(
    `[mobile-rigor] summary: scenarios=${summary.scenariosRun} harnessFailures=${summary.harnessFailureCount} `
    + `errors=${summary.errorFindingCount} warnings=${summary.warningFindingCount}`,
  );

  if (harnessFailures.length > 0) process.exit(2);
  if (opts.strict && errorFindings.length > 0) process.exit(1);
}

const isCli = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isCli) {
  main().catch((err) => {
    console.error('[mobile-rigor] fatal:', err);
    process.exit(2);
  });
}
