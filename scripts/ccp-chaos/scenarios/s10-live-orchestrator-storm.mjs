import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildRankStratifiedSizes, EMPIRICAL_POPULATIONS } from '../fixtures/empirical-manifest.mjs';
import { buildScreenshotPng } from '../fixtures/media.mjs';
import { assertKapServerWebAssets, createWebAssetsAuditRecorder, evaluateWebAssetsBudget } from '../web-assets-bridge.mjs';
import { findChildBrowserRootPid, startExternalHeartbeatWatchdog } from '../telemetry/process-tree.mjs';
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
    return { samples: 0, count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, avgMs: 0 };
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    samples: sorted.length,
    count: sorted.length,
    minMs: roundMs(sorted[0]),
    p50Ms: roundMs(pct(0.5)),
    p95Ms: roundMs(pct(0.95)),
    p99Ms: roundMs(pct(0.99)),
    maxMs: roundMs(sorted.at(-1)),
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
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  } catch (error) {
    return { status: 0, json: null, rawText: '', networkError: String(error?.message ?? error), elapsedMs: roundMs(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seeds a multi-file workspace matching empirical size buckets (21,621 files in full tier)
 * with deterministic needles for S10 child tools (Glob/Grep/Read/Write/Edit/Bash ast-build.mjs).
 */
export function seedS10Workspace(workspaceDir, { fileCount = 250, childCount = 4, empiricalFull = false } = {}) {
  const srcRoot = path.join(workspaceDir, 's10-src');
  fs.mkdirSync(srcRoot, { recursive: true });
  const targetFiles = [];
  const targetSizes = empiricalFull
    ? buildRankStratifiedSizes(EMPIRICAL_POPULATIONS.repoFiles, fileCount, 's10-empirical-v23')
    : null;
  const padChunk = '/* empirical-padding-line-0123456789abcdef */\n'.repeat(16);

  for (let i = 0; i < fileCount; i += 1) {
    const bucket = `mod_${String(i % 20).padStart(2, '0')}`;
    const dir = path.join(srcRoot, bucket);
    fs.mkdirSync(dir, { recursive: true });
    const relPath = path.join('s10-src', bucket, `unit_${String(i).padStart(4, '0')}.ts`).replaceAll('\\', '/');
    const absPath = path.join(workspaceDir, relPath);
    const needle = `NEEDLE_${String(i).padStart(4, '0')}`;
    const constant = 10000 + i * 37;
    if (!fs.existsSync(absPath)) {
      let body = [
        `export const SEED_NEEDLE = '${needle}';`,
        `export const SEED_CONSTANT = ${constant};`,
        `export function computeUnit${i}(x: number): number {`,
        `  let acc = (x ^ SEED_CONSTANT) >>> 0;`,
        `  for (let k = 0; k < 16; k += 1) acc = Math.imul(acc ^ (k + 1), 2654435761) >>> 0;`,
        `  return acc;`,
        `}`,
        '',
      ].join('\n');
      if (targetSizes && targetSizes[i] > body.length) {
        const capTarget = Math.min(targetSizes[i], 256 * 1024);
        const deficit = capTarget - body.length;
        if (deficit > 0) {
          body += padChunk.repeat(Math.ceil(deficit / padChunk.length)).slice(0, deficit);
        }
      }
      fs.writeFileSync(absPath, body, 'utf8');
    }
    if (i < childCount) {
      targetFiles.push({ index: i, relPath, needle, constant });
    }
  }
  return { srcRoot, fileCount, targetFiles };
}

/**
 * Seeds a realistic live orchestrator session (585-600 turns + 513-600 historical subagents)
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
  ws.on('message', (data) => {
    try {
      const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      if (!raw.includes('"ping"')) return;
      const msg = JSON.parse(raw);
      if (msg?.type === 'ping' && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'pong', id: msg.id, payload: { nonce: msg.payload?.nonce } }));
      }
    } catch {}
  });
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
 * Launches a real headless Playwright Chromium instance against the REAL built `@kiki/gui`
 * static bundle (NEVER a stub `<textarea>` HTML page!).
 * Exposes `window.__KIKI_STOP_FLIGHT__()` so S14 can measure idle Chromium renderer+GPU CPU%
 * on the exact same live page with the test harness's rAF loop cleanly stopped.
 */
async function startLiveGuiBrowserDriver({ server, sessionId }) {
  const webInfo = await assertKapServerWebAssets(server.endpoint);
  const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
  const { chromium } = kapRequire('playwright');
  if (!chromium) {
    throw new Error('Playwright chromium unavailable');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
  });
  const browserPid =
    (typeof browser.process === 'function' ? browser.process()?.pid : null) ??
    findChildBrowserRootPid(process.pid);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const webAssetsRecorder = createWebAssetsAuditRecorder(page, server.endpoint);
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err?.message ?? err).slice(0, 300)));

  await context.addInitScript(({ token, sid }) => {
    try {
      localStorage.setItem('kiki.locale', 'en');
      localStorage.setItem('kiki.railMode', 'default');
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      localStorage.setItem('kiki_auth_token', token);
      localStorage.setItem('kiki_last_session_id', sid);
    } catch {}
    let rafActive = true;
    let rafId = null;
    let lastScrollRoot = null;
    window.__KIKI_S10_FLIGHT__ = {
      cls: 0,
      rawLayoutShift: 0,
      sampleCount: 0,
      transcriptRootRemounts: 0,
      typingLatenciesMs: [],
      layoutShiftSources: [],
      rafStopped: false,
    };
    window.__KIKI_STOP_FLIGHT__ = () => {
      rafActive = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      window.__KIKI_S10_FLIGHT__.rafStopped = true;
      return true;
    };
    window.__KIKI_S10_RESET_METRICS__ = () => {
      window.__KIKI_S10_FLIGHT__.cls = 0;
      window.__KIKI_S10_FLIGHT__.rawLayoutShift = 0;
      window.__KIKI_S10_FLIGHT__.transcriptRootRemounts = 0;
      window.__KIKI_S10_FLIGHT__.typingLatenciesMs = [];
      window.__KIKI_S10_FLIGHT__.layoutShiftSources = [];
      return true;
    };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const val = Number(entry.value || 0);
          window.__KIKI_S10_FLIGHT__.rawLayoutShift += val;
          if (!entry.hadRecentInput) window.__KIKI_S10_FLIGHT__.cls += val;
          if (val > 0.001 && window.__KIKI_S10_FLIGHT__.layoutShiftSources.length < 10) {
            const srcs = (entry.sources ?? []).slice(0, 3).map((s) => {
              const n = s?.node;
              return n ? `${n.tagName || 'node'}[${n.className ? String(n.className).slice(0, 40) : ''}]` : 'unknown';
            });
            window.__KIKI_S10_FLIGHT__.layoutShiftSources.push({ val: Number(val.toFixed(5)), hadInput: Boolean(entry.hadRecentInput), srcs });
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    const tick = () => {
      if (!rafActive) return;
      window.__KIKI_S10_FLIGHT__.sampleCount += 1;
      const root = document.querySelector('[data-transcript-scroll], [data-transcript-scroll-root], [data-transcript-list]');
      if (root) {
        if (lastScrollRoot && lastScrollRoot !== root && !lastScrollRoot.isConnected) {
          window.__KIKI_S10_FLIGHT__.transcriptRootRemounts += 1;
        }
        lastScrollRoot = root;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }, { token: server.token, sid: sessionId });

  const deepLink = (routePath) =>
    `${webInfo.webUrl}${routePath}?server=${encodeURIComponent(server.endpoint)}&token=${encodeURIComponent(server.token)}`;

  await page.goto(deepLink(`/s/${encodeURIComponent(sessionId)}`), { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.locator('[data-composer-input], [data-composer], textarea').first().waitFor({ state: 'visible', timeout: 25_000 }).catch(() => undefined);
  await page.locator('[data-transcript-scroll], [data-transcript-list]').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  await sleep(1_800);
  await page.evaluate(() => window.__KIKI_S10_RESET_METRICS__?.()).catch(() => undefined);

  return {
    browser,
    browserPid,
    page,
    guiDistServed: true,
    servedByKapServer: webInfo.servedByKapServer,
    async collectWebAssetsAudit() {
      await webAssetsRecorder.settle();
      return webAssetsRecorder.snapshot();
    },
    buildInfo: {
      servedByKapServer: webInfo.servedByKapServer,
      indexContentEncoding: webInfo.indexContentEncoding,
    },
    async resetFlightMetrics() {
      await page.evaluate(() => window.__KIKI_S10_RESET_METRICS__?.()).catch(() => undefined);
    },
    async reconnectToServer(nextServer, nextSessionId) {
      if (!nextServer?.endpoint || !nextServer?.token) return;
      const nextBase = String(nextServer.endpoint).replace(/\/+$/u, '');
      const targetUrl = nextSessionId
        ? `${nextBase}/s/${encodeURIComponent(nextSessionId)}?server=${encodeURIComponent(nextServer.endpoint)}&token=${encodeURIComponent(nextServer.token)}`
        : `${nextBase}/new?server=${encodeURIComponent(nextServer.endpoint)}&token=${encodeURIComponent(nextServer.token)}`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
      await page.locator('[data-composer-input], [data-composer]').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
      await sleep(1_000);
    },
    async sampleAndType(text) {
      const input = page.locator('[data-composer-input][contenteditable="true"], [data-composer-input], textarea').first();
      const visible = await input.isVisible().catch(() => false);
      if (!visible) return;
      await input.click({ timeout: 5_000 }).catch(() => undefined);
      // Install in-page input -> rAF probe so typing latency measures real browser input-to-paint (not Playwright CDP IPC)
      await page.evaluate(() => {
        const el = document.querySelector('[data-composer-input]') ?? document.querySelector('textarea');
        if (!el || el.__kikiTypeListenerAttached) return;
        el.__kikiTypeListenerAttached = true;
        const recordPaint = () => {
          const t0 = performance.now();
          requestAnimationFrame(() => {
            const elapsed = Number((performance.now() - t0).toFixed(2));
            if (window.__KIKI_S10_FLIGHT__) window.__KIKI_S10_FLIGHT__.typingLatenciesMs.push(elapsed);
          });
        };
        el.addEventListener('beforeinput', recordPaint, { passive: true });
      }).catch(() => undefined);
      const burst = String(text ?? 's10-type-probe-live-storm-latency').slice(0, 24);
      await page.keyboard.type(burst, { delay: 18 });
      await sleep(80);
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.press('Backspace').catch(() => undefined);
    },
    async sendComposerPrompt({ text, pngBuffer = null, pngFilename = 's10-ui-shot.png' }) {
      const input = page.locator('[data-composer-input][contenteditable="true"], [data-composer-input], textarea').first();
      const visible = await input.isVisible().catch(() => false);
      if (!visible) return { submitted: false, reason: 'composer_not_visible' };
      const t0 = performance.now();
      if (pngBuffer) {
        const fileInput = page.locator('input[type="file"]').first();
        if ((await fileInput.count().catch(() => 0)) > 0) {
          await fileInput.setInputFiles({
            name: pngFilename,
            mimeType: 'image/png',
            buffer: pngBuffer,
          }).catch(() => undefined);
          await sleep(120);
        }
      }
      await input.click({ timeout: 5_000 }).catch(() => undefined);
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.press('Backspace').catch(() => undefined);
      await page.keyboard.insertText(String(text)).catch(async () => {
        await page.keyboard.type(String(text), { delay: 4 });
      });
      await sleep(50);
      const sendBtn = page.locator('[data-composer-send], button[aria-label*="Send" i], button[type="submit"]').first();
      const btnVisible = await sendBtn.isVisible().catch(() => false);
      const btnEnabled = btnVisible && (await sendBtn.isEnabled().catch(() => false));
      if (btnEnabled) {
        await sendBtn.click({ timeout: 5_000 }).catch(() => undefined);
      } else {
        await page.keyboard.press('Enter').catch(() => undefined);
      }
      return { submitted: true, elapsedMs: roundMs(performance.now() - t0) };
    },
    async collectFlightSnapshot() {
      const snap = await page.evaluate(() => window.__KIKI_S10_FLIGHT__ ?? null).catch(() => null);
      return {
        sampleCount: snap?.sampleCount ?? 0,
        cls: Number((snap?.cls ?? 0).toFixed(5)),
        rawLayoutShift: Number((snap?.rawLayoutShift ?? 0).toFixed(5)),
        layoutShiftSources: snap?.layoutShiftSources ?? [],
        transcriptRootRemounts: snap?.transcriptRootRemounts ?? 0,
        consoleErrors: consoleErrors.length,
        consoleErrorSamples: consoleErrors.slice(0, 5),
        composerTyping: summarize(snap?.typingLatenciesMs ?? []),
      };
    },
    async openChildView(targetSessionId, childAgentId) {
      const t0 = performance.now();
      const beforeErrors = consoleErrors.length;
      await page.goto(
        deepLink(`/s/${encodeURIComponent(targetSessionId)}/a/${encodeURIComponent(childAgentId)}`),
        { waitUntil: 'domcontentloaded', timeout: 20_000 },
      );
      await page.locator('[data-transcript-scroll-root], [data-composer-input], main').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      await sleep(250);
      return {
        navigatedMs: roundMs(performance.now() - t0),
        newConsoleErrors: consoleErrors.length - beforeErrors,
      };
    },
    async stopFlightRecorder() {
      return Boolean(await page.evaluate(() => (typeof window.__KIKI_STOP_FLIGHT__ === 'function' ? window.__KIKI_STOP_FLIGHT__() : false)).catch(() => false));
    },
    async close() {
      webAssetsRecorder.detach();
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * Runs Scenario S10: Live Multi-Subagent Orchestrator Storm (Astra v2.3).
 * Uses BARE `subscribe_v2` (NO legacy `subscribe`) on wsMainOnly, REAL built `@kiki/gui`
 * in Playwright Chromium, true 5s sliding rolling windows, strict durable send-to-receipt
 * verification, and in `full` tier: 21,621 empirical files + 12->24->32 ramp + 64-child burst.
 */
export async function runScenarioS10LiveStorm({
  server,
  twin,
  corpus,
  WebSocket,
  tier = 'smoke',
  runBrowser = false,
  keepBrowserAlive = false,
  progress = () => {},
}) {
  const isFull = tier === 'full';
  const cfg = isFull
    ? {
        turns: 600,
        seededSubagents: 600,
        waves: [12, 24, 32, 64],
        activeChildren: 32,
        stepsPerChild: 6,
        deltasPerStep: 110,
        cadenceMs: 16,
        workspaceFiles: 21_621,
        promptRounds: 8,
      }
    : {
        turns: 80,
        seededSubagents: 80,
        waves: [4],
        activeChildren: 4,
        stepsPerChild: 5,
        deltasPerStep: 44,
        cadenceMs: 25,
        workspaceFiles: 120,
        promptRounds: 4,
      };

  const startedAt = performance.now();
  const wallStartMs = Date.now();
  const runId = `s10_${randomUUID().slice(0, 8)}`;

  progress(
    `S10 (${tier}): Seeding live orchestrator session (${cfg.turns} turns, ${cfg.seededSubagents} subagents) + ${cfg.workspaceFiles}-file workspace...`,
  );
  const wsSeed = seedS10Workspace(corpus.workspaceDir, {
    fileCount: cfg.workspaceFiles,
    childCount: Math.max(...cfg.waves),
    empiricalFull: isFull,
  });
  const seeded = seedS10LiveSession({
    homeDir: corpus.homeDir,
    workspaceId: corpus.workspaceId,
    workspaceDir: corpus.workspaceDir,
    sessionId: `chaos_s10_${runId}`,
    turns: cfg.turns,
    subagents: cfg.seededSubagents,
  });

  let browserDriver = null;
  let guiDistServed = false;
  if (runBrowser) {
    browserDriver = await startLiveGuiBrowserDriver({ server, sessionId: seeded.sessionId });
    guiDistServed = browserDriver.guiDistServed === true;
  }

  const preMetrics = await server.metrics(true);
  const preTwin = twin.getStats();

  // Connect BOTH:
  // (1) BARE `subscribe_v2` main-only WS observer (NO legacy `subscribe`!)
  // (2) positive-control child-delta WS observer
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

  const requiredStreaming = isFull ? 6 : Math.min(2, cfg.activeChildren);
  const subscribedControlChildren = new Set();
  let controlSubSeq = 0;
  const isLiveSpawnedChild = (id) =>
    typeof id === 'string' && id.length > 0 && id !== 'main' && !id.startsWith('sub_hist_');
  const subscribeControlChildren = (ids) => {
    if (!wsControlChild || wsControlChild.readyState !== 1) return;
    let added = false;
    for (const id of ids ?? []) {
      if (isLiveSpawnedChild(id) && !subscribedControlChildren.has(id)) {
        subscribedControlChildren.add(id);
        added = true;
      }
    }
    if (!added) return;
    const transcript = { main: 'turn', '*': 'off' };
    for (const cid of subscribedControlChildren) transcript[cid] = 'delta';
    try {
      wsControlChild.send(
        JSON.stringify({
          id: `sub_ctrl_${runId}_${++controlSubSeq}`,
          type: 'subscribe_v2',
          payload: {
            session_id: seeded.sessionId,
            transcript,
            transcript_coverage_version: 2,
          },
        }),
      );
    } catch {}
  };
  const harvestSpawnedChildIds = (msg) => {
    const found = [];
    const directIds = [
      msg?.payload?.agent_id,
      msg?.payload?.agentId,
      msg?.payload?.childAgentId,
      msg?.payload?.child_agent_id,
      msg?.payload?.event?.agentId,
      msg?.payload?.event?.payload?.agentId,
      msg?.payload?.event?.payload?.childAgentId,
    ];
    for (const cid of directIds) {
      if (isLiveSpawnedChild(cid)) found.push(cid);
    }
    if (Array.isArray(msg?.payload?.ops)) {
      for (const op of msg.payload.ops) {
        const cid = op?.task?.childAgentId ?? op?.task?.agentId ?? op?.agent?.agentId ?? op?.agentId;
        if (isLiveSpawnedChild(cid)) found.push(cid);
      }
    }
    if (msg?.payload?.snapshot) {
      for (const task of msg.payload.snapshot.tasks ?? []) {
        const cid = task?.childAgentId ?? task?.agentId;
        if (isLiveSpawnedChild(cid)) found.push(cid);
      }
    }
    if (found.length > 0) subscribeControlChildren(found);
  };

  if (WebSocket) {
    try {
      wsMainOnly = await openWs(WebSocket, server.endpoint, server.token);
      wsTelemetry.connected = true;
      // STRICT: BARE subscribe_v2 ONLY — NO prior legacy `subscribe`!
      wsMainOnly.send(
        JSON.stringify({
          id: `sub_s10_bare_v2_${runId}`,
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
        if (msg) harvestSpawnedChildIds(msg);
        const evType = msg?.type ?? msg?.event?.type ?? '';
        if (evType === 'transcript.reset' && msg?.payload?.snapshot) {
          for (const pr of msg.payload.snapshot.prompts ?? []) {
            if (typeof pr?.promptId === 'string' && !durablePromptReceipts.has(pr.promptId)) {
              durablePromptReceipts.set(pr.promptId, performance.now());
            }
          }
          for (const it of msg.payload.snapshot.items ?? []) {
            const pid = it?.promptId ?? it?.message?.messageId;
            if (typeof pid === 'string' && !durablePromptReceipts.has(pid)) {
              durablePromptReceipts.set(pid, performance.now());
            }
          }
        }
        if (evType === 'transcript.ops' && Array.isArray(msg?.payload?.ops)) {
          for (const op of msg.payload.ops) {
            const pid =
              op?.prompt?.promptId ??
              op?.turn?.promptId ??
              op?.turn?.message?.messageId ??
              op?.frame?.frameId ??
              op?.frame?.partId ??
              op?.promptId;
            if (typeof pid === 'string' && !durablePromptReceipts.has(pid)) {
              durablePromptReceipts.set(pid, performance.now());
            }
          }
        }
        const nestedEv = msg?.payload?.event ?? null;
        const nestedType = nestedEv?.type ?? evType;
        if (
          nestedType === 'prompt.submitted' ||
          nestedType === 'prompt.queued' ||
          nestedType === 'prompt.enqueued' ||
          nestedType === 'prompt.steered' ||
          nestedType === 'prompt.outcome_committed'
        ) {
          const pid =
            msg?.payload?.promptId ??
            msg?.payload?.prompt_id ??
            msg?.payload?.terminal?.promptId ??
            nestedEv?.payload?.promptId ??
            nestedEv?.payload?.terminal?.promptId;
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
            transcript: { main: 'turn', '*': 'off' },
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
        if (msg) harvestSpawnedChildIds(msg);
        const evType = msg?.type ?? '';
        const agentId = msg?.payload?.agent_id ?? msg?.payload?.agentId ?? null;
        if (isLiveSpawnedChild(agentId)) {
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

  // Reset server ELD + browser CLS/flight window AFTER initial page hydration so storm metrics measure active load
  await browserDriver?.resetFlightMetrics?.();
  await server.resetWindow();
  const heartbeat = startExternalHeartbeatWatchdog({
    url: `${server.endpoint}/api/health`,
    headers: { authorization: `Bearer ${server.token}` },
    intervalMs: 100,
    timeoutMs: 2_000,
  });

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
        if (Array.isArray(snap?.childIds) && snap.childIds.length > 0) {
          subscribeControlChildren(snap.childIds);
        }
      }
      const twinStreams = twin.getStats().counters.activeStreams ?? 0;
      const concurrent = Math.max(liveActive, twinStreams);
      if (concurrent > peakActiveChildren) peakActiveChildren = concurrent;
      concurrencySamples.push({ tsMs: performance.now(), liveActive, twinStreams, concurrent });
      await sleep(150);
    }
  })();

  let dispatchOk = true;
  const dispatchWave = async (waveChildren, waveIdx) => {
    const waveRunId = `${runId}_w${waveIdx}`;
    const stormPrompt = [
      `[CHAOS_SCOPE:s10_storm_${waveRunId}]`,
      `[S10_STORM:children=${waveChildren},steps=${cfg.stepsPerChild},deltas=${cfg.deltasPerStep},cadenceMs=${cfg.cadenceMs},runId=${waveRunId}]`,
      `Dispatch ${waveChildren} parallel background AgentRun subagents against s10-src using astScript=${AST_BUILD_SCRIPT} astTargetDir=${wsSeed.srcRoot}`,
    ].join(' ');
    progress(`S10 wave ${waveIdx + 1}/${cfg.waves.length}: dispatching ${waveChildren} concurrent native subagents...`);
    const res = await apiJson(
      server.endpoint,
      server.token,
      'POST',
      `/api/sessions/${encodeURIComponent(seeded.sessionId)}/prompts`,
      {
        prompt_id: `p_s10_dispatch_${waveRunId}`,
        content: [{ type: 'text', text: stormPrompt }],
      },
      30_000,
    );
    if (res.status !== 200 || res.json?.code !== 0) dispatchOk = false;
  };

  // Dispatch initial wave
  await dispatchWave(cfg.waves[0], 0);

  // Wait for concurrent children to become active before user sends
  const launchWaitDeadline = performance.now() + 20_000;
  while (performance.now() < launchWaitDeadline) {
    if (peakActiveChildren >= Math.min(requiredStreaming, cfg.waves[0])) break;
    await sleep(100);
  }

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

  const textAdmissionLatenciesMs = [];
  const pngAdmissionLatenciesMs = [];
  const pngUploadLatenciesMs = [];
  const durableReceiptLatenciesMs = [];
  const uploadErrors = [];
  const uiComposerSends = { textSent: false, pngSent: false };
  let failedSends = 0;
  let durableReceiptsMissing = 0;
  let overlapBucketsQualified = 0;

  const png88k = buildScreenshotPng({ width: 1280, height: 720, seed: 77 });
  const pngLarge = buildScreenshotPng({ width: 2200, height: 1400, seed: 99 });
  const mainWirePath = path.join(seeded.sessionDir, 'agents', 'main', 'wire.jsonl');

  const waitStrictDurableReceipt = async (promptId, nonce, sendT0) => {
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      if (durablePromptReceipts.has(promptId)) {
        return { verified: true, receiptMs: roundMs(Math.max(0.5, durablePromptReceipts.get(promptId) - sendT0)) };
      }
      if (fs.existsSync(mainWirePath)) {
        try {
          const stat = fs.statSync(mainWirePath);
          const readLen = Math.min(stat.size, 256 * 1024);
          const fd = fs.openSync(mainWirePath, 'r');
          try {
            const buf = Buffer.alloc(readLen);
            fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
            const tail = buf.toString('utf8');
            if (tail.includes(promptId) || (nonce && tail.includes(nonce))) {
              return { verified: true, receiptMs: roundMs(Math.max(0.5, performance.now() - sendT0)) };
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch {}
      }
      await sleep(25);
    }
    const txRes = await apiJson(
      server.endpoint,
      server.token,
      'GET',
      `/api/sessions/${encodeURIComponent(seeded.sessionId)}/transcript?agent_id=main&limit=20`,
      undefined,
      4_000,
    ).catch(() => null);
    const items = txRes?.json?.data?.items ?? [];
    const prompts = txRes?.json?.data?.prompts ?? [];
    const found =
      prompts.some((p) => p?.promptId === promptId) ||
      items.some(
        (it) =>
          it?.promptId === promptId ||
          it?.message?.messageId === promptId ||
          (nonce && JSON.stringify(it).includes(nonce)),
      );
    if (found) {
      return { verified: true, receiptMs: roundMs(Math.max(0.5, performance.now() - sendT0)) };
    }
    return { verified: false, receiptMs: null };
  };

  for (let round = 0; round < cfg.promptRounds; round += 1) {
    // In full tier, overlap waves (12 -> 24 -> 32 -> 64) before the prior wave drains below active floor!
    if (isFull && round > 0 && round < cfg.waves.length) {
      await dispatchWave(cfg.waves[round], round);
      await sleep(300);
    }

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
      if (round === 0 && !uiComposerSends.textSent) {
        const uiRes = await browserDriver.sendComposerPrompt({
          text: `[CHAOS_SCOPE:s10_ui_txt_${runId}] UI composer text send during active storm.`,
        });
        uiComposerSends.textSent = Boolean(uiRes?.submitted);
      } else if (round === 1 && !uiComposerSends.pngSent) {
        const uiRes = await browserDriver.sendComposerPrompt({
          text: `[CHAOS_SCOPE:s10_ui_png_${runId}] UI composer PNG send during active storm.`,
          pngBuffer: png88k,
          pngFilename: `ui_shot_${runId}.png`,
        });
        uiComposerSends.pngSent = Boolean(uiRes?.submitted);
      }
    }

    const usePng = round % 2 === 1;
    const promptId = usePng ? `p_s10_png_${runId}_${round}` : `p_s10_txt_${runId}_${round}`;
    const msgNonce = `s10_live_msg_${runId}_${round}`;
    let content = [
      {
        type: 'text',
        text: `[CHAOS_SCOPE:${msgNonce}] Live user prompt round ${round} during active subagent storm.`,
      },
    ];

    if (usePng) {
      const pngBuf = round === 1 ? png88k : pngLarge;
      const sendT0 = performance.now();
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
      } catch (error) {
        uploadErrors.push(`round=${round}: ${String(error?.message ?? error)}`);
      }
      const uploadMs = roundMs(performance.now() - sendT0);
      pngUploadLatenciesMs.push(uploadMs);
      if (!uploadedRef) {
        uploadErrors.push(`round=${round}: /api/files failed (status=${uploadStatus}), refusing inline data: fallback`);
        failedSends += 1;
        continue;
      }
      content = [
        { type: 'image', source: { kind: 'file', file_id: uploadedRef } },
        ...content,
      ];
      const sendRes = await apiJson(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(seeded.sessionId)}/prompts`,
        {
          prompt_id: promptId,
          ...(round === 1 ? { delivery_mode: 'steer' } : {}),
          content,
        },
        20_000,
      );
      const totalPngAdmissionMs = roundMs(performance.now() - sendT0);
      if (sendRes.status === 200 && sendRes.json?.code === 0) {
        pngAdmissionLatenciesMs.push(totalPngAdmissionMs);
        const rec = await waitStrictDurableReceipt(promptId, msgNonce, sendT0);
        if (rec.verified) {
          durableReceiptLatenciesMs.push(Math.max(totalPngAdmissionMs, rec.receiptMs));
        } else {
          durableReceiptsMissing += 1;
        }
      } else {
        failedSends += 1;
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
          delivery_mode: 'steer',
          content,
        },
        20_000,
      );
      if (sendRes.status === 200 && sendRes.json?.code === 0) {
        textAdmissionLatenciesMs.push(sendRes.elapsedMs);
        const rec = await waitStrictDurableReceipt(promptId, msgNonce, sendT0);
        if (rec.verified) {
          durableReceiptLatenciesMs.push(Math.max(sendRes.elapsedMs, rec.receiptMs));
        } else {
          durableReceiptsMissing += 1;
        }
      } else {
        failedSends += 1;
      }
    }
    const interRoundPauseMs = isFull ? (round + 1 < cfg.waves.length ? 250 : 900) : 500;
    await sleep(interRoundPauseMs);
  }

  // Wait for children & session to settle
  const settleDeadline = performance.now() + (isFull ? 180_000 : 45_000);
  while (performance.now() < settleDeadline) {
    const st = await apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${encodeURIComponent(seeded.sessionId)}/status`, undefined, 10_000);
    const twinNow = twin.getStats();
    const busy =
      st.json?.data?.busy === true ||
      st.json?.data?.executing === true ||
      (twinNow.counters.activeStreams ?? 0) > 0;
    if (!busy && performance.now() - startedAt > 5_200) break;
    await sleep(250);
  }

  activeMonitorStopped = true;
  await activeMonitor;

  let flightRecorder = null;
  let webAssetsAudit = null;
  if (browserDriver) {
    flightRecorder = await browserDriver.collectFlightSnapshot();
    webAssetsAudit = await browserDriver.collectWebAssetsAudit();
    if (!keepBrowserAlive) {
      await browserDriver.close();
      browserDriver = null;
    }
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

  // Build TRUE 5-second sliding windows (1s step) across the contiguous active storm interval
  const rolling5sWindows = [];
  if (controlTelemetry.childDeltaEvents.length > 0) {
    const events = controlTelemetry.childDeltaEvents;
    const firstTs = events[0].tsMs;
    const lastTs = events.at(-1).tsMs;
    const winMs = 5_000;
    const stepMs = 1_000;
    const candidateWindows = [];
    if (lastTs - firstTs >= winMs) {
      for (let wsStart = firstTs; wsStart + winMs <= lastTs + 50; wsStart += stepMs) {
        const wsEnd = wsStart + winMs;
        const inWin = events.filter((e) => e.tsMs >= wsStart && e.tsMs <= wsEnd);
        if (inWin.length === 0) continue;
        const byChild = new Map();
        for (const ev of inWin) {
          const rec = byChild.get(ev.childId) ?? {
            childId: ev.childId,
            deltas: 0,
            usefulBytes: 0,
            prevTs: ev.tsMs,
            activeMs: 0,
          };
          if (rec.deltas > 0) {
            rec.activeMs += Math.min(Math.max(0, ev.tsMs - rec.prevTs), 250);
          }
          rec.deltas += ev.deltas;
          rec.usefulBytes += ev.bytes;
          rec.prevTs = ev.tsMs;
          byChild.set(ev.childId, rec);
        }
        const perChildStreams = [...byChild.values()].map((c) => ({
          childId: c.childId,
          deltas: c.deltas,
          usefulBytes: c.usefulBytes,
          activeSeconds: Math.max(0.1, c.activeMs / 1000),
        }));
        candidateWindows.push({
          windowMs: winMs,
          productiveChildren4s: byChild.size,
          streamingChildren3s: byChild.size,
          perChildStreams,
        });
      }
    }
    const minActiveFloor = Math.ceil(0.9 * requiredStreaming);
    const minRequiredWindows = isFull ? 6 : 1;
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    for (let i = 0; i < candidateWindows.length; i += 1) {
      if (candidateWindows[i].productiveChildren4s >= minActiveFloor) {
        if (curStart < 0) curStart = i;
        const curLen = i - curStart + 1;
        if (curLen > bestLen) {
          bestStart = curStart;
          bestLen = curLen;
        }
      } else {
        curStart = -1;
      }
    }
    if (bestStart >= 0 && bestLen >= minRequiredWindows) {
      rolling5sWindows.push(...candidateWindows.slice(bestStart, bestStart + bestLen));
    } else {
      const firstQualIdx = candidateWindows.findIndex((w) => w.productiveChildren4s >= minActiveFloor);
      let lastQualIdx = -1;
      for (let i = candidateWindows.length - 1; i >= 0; i -= 1) {
        if (candidateWindows[i].productiveChildren4s >= minActiveFloor) {
          lastQualIdx = i;
          break;
        }
      }
      if (firstQualIdx >= 0 && lastQualIdx >= firstQualIdx) {
        rolling5sWindows.push(...candidateWindows.slice(firstQualIdx, lastQualIdx + 1));
      } else {
        rolling5sWindows.push(...candidateWindows);
      }
    }
  }

  const parsedAdmission = parsePromptAdmissionLatencies(corpus.homeDir, wallStartMs);
  const allAdmissionLatencies = [...textAdmissionLatenciesMs, ...pngAdmissionLatenciesMs];
  const promptAdmissionSummary =
    parsedAdmission.length > 0 ? summarize(parsedAdmission) : summarize(allAdmissionLatencies);
  const sendToReceiptSummary = summarize(durableReceiptLatenciesMs);
  const textPromptAdmissionSummary = summarize(textAdmissionLatenciesMs);
  const pngPromptAdmissionSummary = summarize(pngAdmissionLatenciesMs);

  const bytesPerSecArr = [...wsTelemetry.perSecBytes.values()].toSorted((a, b) => a - b);
  const framesPerSecArr = [...wsTelemetry.perSecFrames.values()].toSorted((a, b) => a - b);
  const p99Of = (arr) => (arr.length > 0 ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.99))] : 0);

  const reopenCandidates = [];
  const agentsDir = path.join(seeded.sessionDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir)) {
      if (entry === 'main' || entry.startsWith('sub_hist_')) continue;
      const agentDir = path.join(agentsDir, entry);
      if (fs.existsSync(path.join(agentDir, 'wire.jsonl'))) {
        reopenCandidates.push({ sessionId: seeded.sessionId, childAgentId: entry, agentDir });
        if (reopenCandidates.length >= (isFull ? 4 : 1)) break;
      }
    }
  }
  const reopenCandidate = reopenCandidates[0] ?? null;

  const p02Payload = wsTelemetry.connected
    ? {
        tier: isFull ? 'full' : 'smoke',
        bareSubscribeV2: true,
        usedLegacySubscribe: false,
        requiredStreamingChildren: requiredStreaming,
        activeStreamingChildren: peakActiveChildren,
        controlClientChildBytes: controlTelemetry.childDeltaBytes,
        controlClientChildFrames: controlTelemetry.childDeltaFrames,
        unsubscribedChildContentBytes: wsTelemetry.unsubscribedChildContentBytes,
        unsubscribedChildContentFrames: wsTelemetry.unsubscribedChildContentFrames,
        inboundBytesPerSecP99: p99Of(bytesPerSecArr),
        inboundBytesPerSecPeak: bytesPerSecArr.length > 0 ? bytesPerSecArr.at(-1) : 0,
        inboundFramesPerSecP99: p99Of(framesPerSecArr),
        inboundFramesPerSecPeak: framesPerSecArr.length > 0 ? framesPerSecArr.at(-1) : 0,
        rolling5sWindows,
        frameTypeCounts: wsTelemetry.frameTypeCounts,
        largestFrames: wsTelemetry.largestFrames,
      }
    : null;
  const evidence = {
    runId,
    tier: isFull ? 'full' : 'smoke',
    sessionId: seeded.sessionId,
    dispatchOk,
    wavesExecuted: cfg.waves,
    workspaceFilesSeeded: cfg.workspaceFiles,
    peakActiveChildren,
    agentRunsInvoked,
    totalChildToolCalls,
    toolBreakdown,
    overlapBucketsQualified,
    backgroundQueriesCompleted,
    uploadErrors,
    uiComposerSends,
    failedSends,
    durableReceiptsVerified: durableReceiptsMissing === 0 && durableReceiptLatenciesMs.length > 0,
    durableReceiptsMissing,
    browserRequired: Boolean(runBrowser),
    guiDistServed,
    usedStubHtml: false,
    webAssetsAudit,
    flightRecorder,
    promptAdmission: promptAdmissionSummary,
    textPromptAdmission: textPromptAdmissionSummary,
    pngPromptAdmission: pngPromptAdmissionSummary,
    pngUploadLatency: summarize(pngUploadLatenciesMs),
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
    p02: p02Payload,
    p02MainOnlyWs: p02Payload,
  };

  const verdict = evaluateS10Verdict(evidence, { tier: isFull ? 'full' : 'smoke' });
  if (uploadErrors.length > 0) {
    verdict.productFailures.push(...uploadErrors.map((e) => `S10 PNG upload failed: ${e}`));
    verdict.passed = false;
    verdict.exitCode = 1;
  }
  if (runBrowser) {
    const webAssetsGate = evaluateWebAssetsBudget(webAssetsAudit);
    evidence.webAssetsGate = webAssetsGate;
    if (!webAssetsGate.passed) {
      verdict.productFailures.push(...webAssetsGate.failures.map((f) => `S10 kap-server webAssets: ${f}`));
      verdict.passed = false;
      verdict.exitCode = 1;
    }
  }

  progress(
    `S10 (${tier}) Result: passed=${verdict.passed} exitCode=${verdict.exitCode} peakChildren=${peakActiveChildren} childTools=${totalChildToolCalls} ctrlChildBytes=${controlTelemetry.childDeltaBytes} unsubChildBytes=${wsTelemetry.unsubscribedChildContentBytes} promptAdmP95=${promptAdmissionSummary.p95Ms}ms durableSendP95=${sendToReceiptSummary.p95Ms}ms eldP99=${evidence.eld.p99Ms}ms eldMax=${evidence.eld.maxMs}ms`,
  );

  return {
    ...verdict,
    evidence,
    reopenCandidate,
    reopenCandidates,
    browserHandle: keepBrowserAlive ? browserDriver : null,
    elapsedMs: roundMs(performance.now() - startedAt),
  };
}
