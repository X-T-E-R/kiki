import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { ensureGuiStaticBuild } from '../../perf/browser-runner.mjs';
import { buildIsolatedPerfEnv, computeWorkDirKey } from '../../perf/sandbox-stager.mjs';
import { evaluateS16MobileVerdict } from '../verify/verdict.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const isCliMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
const MiB = 1024 * 1024;

function roundMs(val) {
  return Number(Number(val ?? 0).toFixed(2));
}

function roundMiB(bytes) {
  return Number((Number(bytes ?? 0) / MiB).toFixed(2));
}

function quantile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return roundMs(sorted[idx]);
}

function summarize(values) {
  if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].toSorted((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: roundMs(sorted[0]),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: roundMs(sorted.at(-1)),
    mean: roundMs(sum / sorted.length),
  };
}

function normalizeUrlPath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.pathname
      .replaceAll(/\/sessions\/[^/]+/gu, '/sessions/:id')
      .replaceAll(/\/agents\/(?!capabilities|references|shipped)[^/]+/gu, '/agents/:aid');
  } catch {
    return rawUrl;
  }
}

function summarizeCpuProfile(profile, topN = 15) {
  if (!profile || !Array.isArray(profile.nodes)) return { totalSamples: 0, topFunctions: [] };
  const byKey = new Map();
  let totalSamples = 0;
  for (const node of profile.nodes) {
    const hits = Number(node.hitCount ?? 0);
    if (hits <= 0) continue;
    totalSamples += hits;
    const cf = node.callFrame ?? {};
    const fn = cf.functionName || '(anonymous)';
    const url = cf.url ? cf.url.replace(/^https?:\/\/[^/]+/u, '') : '(native)';
    const key = `${fn} @ ${url}:${cf.lineNumber ?? 0}`;
    byKey.set(key, (byKey.get(key) ?? 0) + hits);
  }
  const topFunctions = [...byKey.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([frame, hits]) => ({
      frame,
      hits,
      sharePct: totalSamples > 0 ? Number(((hits / totalSamples) * 100).toFixed(2)) : 0,
    }));
  return { totalSamples, topFunctions };
}

function buildRichCjkMarkdownTurn(turnIdx, padBytes = 0) {
  const codeBlock = [
    '```typescript',
    `export async function reconcileSessionBatch_${turnIdx}(rows: readonly SessionRow[]): Promise<BatchVerdict> {`,
    `  const startedAt = performance.now();`,
    `  const results = rows.map((row, idx) => ({ id: row.id, rank: idx, digest: \`sha256:\${row.id}-\${idx}\` }));`,
    `  return { ok: results.length > 0, elapsedMs: performance.now() - startedAt, count: results.length };`,
    '}',
    '```',
  ].join('\n');
  const table = [
    '| 模块 | 状态 | 耗时(ms) | 备注 |',
    '| --- | --- | ---: | --- |',
    `| Transcript | ok | ${12 + (turnIdx % 40)} | 第 ${turnIdx} 轮 CJK 表格与代码块混合渲染校验 |`,
    `| AgentForest | warn | ${45 + (turnIdx % 90)} | 多级子代理树拓扑状态聚合 |`,
  ].join('\n');
  let body = [
    `### 第 ${turnIdx} 轮分析：移动端会话加载与多路工具回执`,
    '',
    `本次排查覆盖了 **500+ 子代理状态同步**、\`visualViewport.offsetTop\` 键盘偏移以及弱网下的大体积载荷解析。`,
    '',
    codeBlock,
    '',
    table,
  ].join('\n');
  if (padBytes > body.length) {
    const filler = `\n- [第 ${turnIdx} 轮追踪记录] 检查移动端渲染主线程阻塞、虚拟列表高度测量与图片附件元信息校验。\n`;
    body += filler.repeat(Math.ceil((padBytes - body.length) / filler.length)).slice(0, padBytes - body.length);
  }
  return body;
}

/**
 * Seeds a realistic mobile-stress corpus on disk for real kap-server execution:
 * - Primary heavy session with `subagentCount` (default 520) subagents + dirty CJK/Markdown/code/error/attachment turns
 * - 5 additional sessions for rapid mobile switching
 */
export function seedS16MobileHeavyCorpus({
  homeDir,
  workspaceDir,
  workspaceId = null,
  subagentCount = 520,
  primaryTurns = 100,
  targetWireBytes = 24 * MiB,
  switchSessionCount = 5,
}) {
  const startedAt = performance.now();
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const wsId = workspaceId ?? computeWorkDirKey(workspaceDir);
  const now = Date.now();
  const baseTime = now - 3_600_000;
  const nowIso = new Date(now).toISOString();

  // Ensure workspaces.json registers workspaceId so kap-server's ISessionIndex discovers every seeded session.
  const wsJsonPath = path.join(homeDir, 'workspaces.json');
  let wsDoc = { version: 1, workspaces: {}, deleted_workspace_ids: [] };
  if (fs.existsSync(wsJsonPath)) {
    try {
      wsDoc = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
      wsDoc.workspaces = wsDoc.workspaces ?? {};
      wsDoc.deleted_workspace_ids = wsDoc.deleted_workspace_ids ?? [];
    } catch {}
  }
  if (!wsDoc.workspaces[wsId]) {
    wsDoc.workspaces[wsId] = {
      root: workspaceDir,
      name: 'S16 Mobile Stress Workspace',
      created_at: nowIso,
      last_opened_at: nowIso,
    };
    fs.writeFileSync(wsJsonPath, `${JSON.stringify(wsDoc, null, 2)}\n`, 'utf8');
  }

  const writeSession = ({ sessionId, title, turns, subagents, targetBytes }) => {
    const sessionDir = path.join(homeDir, 'sessions', wsId, sessionId);
    const mainDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(mainDir, { recursive: true });

    const lines = [JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: baseTime })];
    const perTurnPad = targetBytes > 0 ? Math.max(0, Math.floor((targetBytes * 0.85) / Math.max(1, turns))) : 0;

    for (let t = 0; t < turns; t += 1) {
      const ts = baseTime + t * 5_000;
      const isErrorTurn = t > 0 && t % 17 === 0;
      const hasAttachment = t % 11 === 0;
      const userParts = [
        { type: 'text', text: `[第 ${t} 轮] 请分析移动端会话 ${title} 在弱网 40ms RTT 与 4x CPU 节流下的渲染耗时与请求瀑布。` },
      ];
      if (hasAttachment) {
        userParts.push({
          type: 'text',
          text: `[attachment: mobile-trace-${t}.json | size=${16384 + t * 128}B | mime=application/json]`,
        });
      }
      lines.push(
        JSON.stringify({
          type: 'turn.prompt',
          turnId: t,
          promptId: `p_${sessionId}_${t}`,
          input: userParts,
          origin: { kind: 'user' },
          time: ts,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'step.started',
          turnId: t,
          stepId: `t${t}.1`,
          time: ts + 10,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'tool.call',
          turnId: t,
          stepId: `t${t}.1`,
          toolCallId: `tc_${sessionId}_${t}`,
          name: t % 2 === 0 ? 'Grep' : 'Bash',
          arguments: JSON.stringify({ pattern: `mobile_bottleneck_${t}`, path: 'apps/kiki-gui/src' }),
          time: ts + 25,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'tool.result',
          turnId: t,
          stepId: `t${t}.1`,
          toolCallId: `tc_${sessionId}_${t}`,
          isError: isErrorTurn,
          output: isErrorTurn
            ? `Error: ETIMEDOUT reading chunk ${t} (simulated dirty error record with CJK 诊断上下文)`
            : `matched 12 lines in apps/kiki-gui/src/components/Transcript.tsx (${t})`,
          time: ts + 90,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'text.delta',
          turnId: t,
          stepId: `t${t}.1`,
          text: buildRichCjkMarkdownTurn(t, perTurnPad),
          time: ts + 140,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'turn.ended',
          turnId: t,
          durationMs: 420,
          reason: isErrorTurn ? 'error' : 'completed',
          ...(isErrorTurn ? { error: `Simulated transient upstream error at turn ${t}` } : {}),
          time: ts + 420,
        }),
      );
    }

    const wirePath = path.join(mainDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, `${lines.join('\n')}\n`, 'utf8');

    const agentsMap = {
      main: {
        agentId: 'main',
        role: 'main',
        status: 'idle',
        createdAt: baseTime,
        updatedAt: now - 1_000,
      },
    };
    const subWireSample = `${[
      JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: baseTime }),
      JSON.stringify({
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'p_sub_0',
        input: [{ type: 'text', text: 'Inspect mobile bottleneck slice.' }],
        origin: { kind: 'user' },
        time: baseTime + 100,
      }),
      JSON.stringify({
        type: 'turn.ended',
        turnId: 0,
        durationMs: 80,
        reason: 'completed',
        time: baseTime + 180,
      }),
    ].join('\n')}\n`;

    for (let s = 1; s <= subagents; s += 1) {
      const aid = `sub_${String(s).padStart(4, '0')}`;
      const parent = s <= 12 ? 'main' : `sub_${String(((s - 1) % 12) + 1).padStart(4, '0')}`;
      const status = s % 19 === 0 ? 'failed' : s % 13 === 0 ? 'cancelled' : 'completed';
      agentsMap[aid] = {
        agentId: aid,
        parentAgentId: parent,
        role: 'subagent',
        profile: s % 3 === 0 ? 'reviewer' : s % 2 === 0 ? 'explore' : 'implementer',
        model: 'twin-anthropic',
        status,
        title: `Subagent #${s} · 移动端性能探针`,
        createdAt: baseTime + s * 100,
        updatedAt: baseTime + s * 100 + 2_000,
      };
      const subDir = path.join(sessionDir, 'agents', aid);
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'wire.jsonl'), subWireSample, 'utf8');
    }

    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      `${JSON.stringify(
        {
          version: 1,
          sessionId,
          title,
          workspaceDir,
          createdAt: baseTime,
          updatedAt: now - (subagents > 50 ? 500 : 10_000),
          agents: agentsMap,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    return {
      sessionId,
      title,
      wireBytes: fs.statSync(wirePath).size,
      subagentCount: subagents,
      turns,
    };
  };

  const primarySession = writeSession({
    sessionId: 'chaos_s16_heavy_main',
    title: 'S16 Mobile Heavy (520 subagents + CJK/Code)',
    turns: primaryTurns,
    subagents: subagentCount,
    targetBytes: targetWireBytes,
  });

  const switchSessions = [];
  for (let i = 1; i <= switchSessionCount; i += 1) {
    switchSessions.push(
      writeSession({
        sessionId: `chaos_s16_switch_${i}`,
        title: `S16 Mobile Switch #${i}`,
        turns: 24,
        subagents: 18,
        targetBytes: 512 * 1024,
      }),
    );
  }

  return {
    workspaceId: wsId,
    primarySession,
    switchSessions,
    seedElapsedMs: roundMs(performance.now() - startedAt),
  };
}

/**
 * S16: Real Mobile Extreme Heavy-Session Load & Lag Root-Cause Gate.
 *
 * Serves GUI strictly from kap-server's real `webAssetsDir` (zero fake static server),
 * applies CDP 4x CPU throttling + 40ms RTT / 15 Mbps down / 5 Mbps up mobile network,
 * 393x852 touch viewport with `reducedMotion: 'no-preference'` and `app-shell` mode,
 * and measures exact TTFM, TBT, Max LongTask, HTTP/RPC waterfall, JS bundle compression,
 * V8 CPU profile hotspots, rapid 5-session switching, and touch-scroll P95 frame time.
 */
export async function runScenarioS16MobileHeavySession({
  server,
  corpus,
  tier = 'smoke',
  targetWireBytes = null,
  subagentCount = null,
  preseeded = null,
  progress = () => {},
}) {
  const startedAt = performance.now();
  const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
  const { chromium } = kapRequire('playwright');

  const resolvedWireBytes = targetWireBytes ?? (tier === 'full' ? 100 * MiB : 24 * MiB);
  const resolvedSubagents = subagentCount ?? (tier === 'full' ? 600 : 520);
  const resolvedTurns = tier === 'full' ? 160 : 96;

  let seeded = preseeded;
  if (!seeded) {
    progress(
      `S16 Mobile Heavy Session: seeding heavy corpus (wireTarget=${roundMiB(resolvedWireBytes)}MiB, subagents=${resolvedSubagents}, turns=${resolvedTurns})...`,
    );
    seeded = seedS16MobileHeavyCorpus({
      homeDir: corpus.homeDir,
      workspaceDir: corpus.workspaceDir,
      workspaceId: corpus.workspaceId,
      subagentCount: resolvedSubagents,
      primaryTurns: resolvedTurns,
      targetWireBytes: resolvedWireBytes,
      switchSessionCount: 5,
    });
  }

  // Verify kap-server itself serves the real production GUI `webAssets` route (F2: zero fake static servers!)
  const rootAssetRes = await fetch(`${server.endpoint}/`);
  const rootAssetHtml = await rootAssetRes.text();
  const servedByKapServer = rootAssetRes.status === 200 && rootAssetHtml.toLowerCase().includes('<!doctype html');
  if (!servedByKapServer) {
    throw new Error(
      `S16 harness violation: kap-server at ${server.endpoint} is not serving webAssetsDir (status=${rootAssetRes.status}). Start kap-server with webAssetsDir instead of a toy static server.`,
    );
  }

  let browser = null;
  const pageErrors = [];
  const consoleErrors = [];
  const networkRecords = [];
  let activePhase = 'cold-boot';
  let phaseStartMs = performance.now();

  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KikiApp/ios',
      reducedMotion: 'no-preference',
    });

    await context.addInitScript(({ token }) => {
      try {
        localStorage.setItem('kiki.locale', 'en');
        localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
        Object.defineProperty(document, '__kikiShellStagedCredential', {
          configurable: true,
          enumerable: false,
          value: { origin: window.location.origin, token },
        });
      } catch {}

      const state = { longTasks: [], rafDeltas: [], rafActive: false, prevRaf: 0 };
      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.longTasks.push({
              name: entry.name,
              startTime: Number(entry.startTime.toFixed(2)),
              duration: Number(entry.duration.toFixed(2)),
            });
          }
        });
        obs.observe({ type: 'longtask', buffered: true });
      } catch {}

      const rafLoop = (ts) => {
        if (state.rafActive) {
          if (state.prevRaf > 0) state.rafDeltas.push(Number((ts - state.prevRaf).toFixed(2)));
          state.prevRaf = ts;
        }
        requestAnimationFrame(rafLoop);
      };
      requestAnimationFrame(rafLoop);

      window.__s16Probe = {
        resetLongTasks() {
          state.longTasks = [];
        },
        drainLongTasks() {
          const durations = state.longTasks.map((t) => t.duration);
          const out = {
            count: durations.length,
            totalBlockingTimeMs: Number(durations.reduce((a, d) => a + Math.max(0, d - 50), 0).toFixed(2)),
            maxLongTaskMs: durations.length > 0 ? Number(Math.max(...durations).toFixed(2)) : 0,
            tasks: state.longTasks.slice(0, 30),
          };
          state.longTasks = [];
          return out;
        },
        startRaf() {
          state.rafDeltas = [];
          state.prevRaf = 0;
          state.rafActive = true;
        },
        stopRaf() {
          state.rafActive = false;
          const out = [...state.rafDeltas];
          state.rafDeltas = [];
          return out;
        },
      };
    }, { token: server.token });

    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 393,
      screenHeight: 852,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34, left: 0, right: 0 } });
    // Real mobile single-core CPU throttling (4x) + Mobile Wi-Fi / Tailscale network (40ms RTT, 15 Mbps down, 5 Mbps up)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 40,
      downloadThroughput: Math.round((15 * 1024 * 1024) / 8),
      uploadThroughput: Math.round((5 * 1024 * 1024) / 8),
    });

    const inflightByReqId = new Map();
    cdp.on('Network.requestWillBeSent', (ev) => {
      inflightByReqId.set(ev.requestId, {
        phase: activePhase,
        url: ev.request.url,
        path: normalizeUrlPath(ev.request.url),
        method: ev.request.method,
        resourceType: ev.type ?? 'Other',
        startMs: performance.now(),
        phaseOffsetMs: roundMs(performance.now() - phaseStartMs),
        status: 0,
        contentEncoding: 'identity',
        mimeType: '',
        encodedBytes: 0,
        decodedBytes: 0,
      });
    });
    cdp.on('Network.responseReceived', (ev) => {
      const rec = inflightByReqId.get(ev.requestId);
      if (!rec) return;
      rec.status = ev.response.status;
      rec.mimeType = ev.response.mimeType ?? '';
      const hdrs = ev.response.headers ?? {};
      const encKey = Object.keys(hdrs).find((k) => k.toLowerCase() === 'content-encoding');
      rec.contentEncoding = encKey ? String(hdrs[encKey]) : 'identity';
      const clKey = Object.keys(hdrs).find((k) => k.toLowerCase() === 'content-length');
      if (clKey) rec.decodedBytes = Number(hdrs[clKey]) || 0;
    });
    cdp.on('Network.loadingFinished', (ev) => {
      const rec = inflightByReqId.get(ev.requestId);
      if (!rec) return;
      inflightByReqId.delete(ev.requestId);
      rec.encodedBytes = Number(ev.encodedDataLength ?? 0);
      rec.durationMs = roundMs(performance.now() - rec.startMs);
      networkRecords.push(rec);
    });
    cdp.on('Network.loadingFailed', (ev) => {
      const rec = inflightByReqId.get(ev.requestId);
      if (!rec) return;
      inflightByReqId.delete(ev.requestId);
      rec.failed = true;
      rec.errorText = ev.errorText;
      rec.durationMs = roundMs(performance.now() - rec.startMs);
      networkRecords.push(rec);
    });

    const readCdpPerfMetrics = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
      return {
        scriptDurationMs: roundMs((map.ScriptDuration ?? 0) * 1000),
        layoutDurationMs: roundMs((map.LayoutDuration ?? 0) * 1000),
        recalcStyleDurationMs: roundMs((map.RecalcStyleDuration ?? 0) * 1000),
        taskDurationMs: roundMs((map.TaskDuration ?? 0) * 1000),
        jsHeapUsedMiB: roundMiB(map.JSHeapUsedSize ?? 0),
        jsHeapTotalMiB: roundMiB(map.JSHeapTotalSize ?? 0),
        nodes: map.Nodes ?? 0,
      };
    };

    // --- Phase 1: Cold App Boot directly from kap-server webAssets (app-shell same-origin) ---
    activePhase = 'cold-boot';
    phaseStartMs = performance.now();
    progress('S16 [1/4]: Cold booting GUI from kap-server webAssets under 4x CPU + 40ms/15Mbps mobile emulation...');
    const bootT0 = performance.now();
    await page.goto(`${server.endpoint}/new`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('[data-session-sidebar]', { timeout: 60_000 });
    const coldBootToShellMs = roundMs(performance.now() - bootT0);
    await page.waitForTimeout(300);
    const bootLongTasks = await page.evaluate(() => window.__s16Probe.drainLongTasks());
    const bootPerf = await readCdpPerfMetrics();

    const jsAssets = networkRecords.filter((r) => r.phase === 'cold-boot' && (r.path.endsWith('.js') || r.mimeType.includes('javascript')));
    const cssAssets = networkRecords.filter((r) => r.phase === 'cold-boot' && (r.path.endsWith('.css') || r.mimeType.includes('css')));
    const jsTotalEncodedBytes = jsAssets.reduce((a, r) => a + r.encodedBytes, 0);
    const jsTotalDecodedBytes = jsAssets.reduce((a, r) => a + Math.max(r.decodedBytes, r.encodedBytes), 0);
    const compressedJsCount = jsAssets.filter((r) => r.contentEncoding === 'gzip' || r.contentEncoding === 'br' || r.contentEncoding === 'zstd').length;
    const webAssetsAudit = {
      servedByKapServer: true,
      jsChunkCount: jsAssets.length,
      cssChunkCount: cssAssets.length,
      jsTotalEncodedBytes,
      jsTotalEncodedMiB: roundMiB(jsTotalEncodedBytes),
      jsTotalDecodedMiB: roundMiB(jsTotalDecodedBytes),
      compressedJsChunkCount: compressedJsCount,
      compressionRatioPct:
        jsTotalDecodedBytes > 0 ? Number(((1 - jsTotalEncodedBytes / jsTotalDecodedBytes) * 100).toFixed(1)) : 0,
      topLargestAssets: [...jsAssets, ...cssAssets]
        .toSorted((a, b) => b.encodedBytes - a.encodedBytes)
        .slice(0, 6)
        .map((r) => ({
          path: r.path,
          encodedKiB: Number((r.encodedBytes / 1024).toFixed(1)),
          contentEncoding: r.contentEncoding,
          durationMs: r.durationMs,
        })),
    };

    // --- Phase 2: Open Heavy Session (520 subagents + dirty CJK/code wire) with V8 CPU Profiler ---
    progress('S16 [2/4]: Clicking heavy session (520 subagents) and profiling TTFM, TBT, waterfall, and V8 hotspots...');
    const menuBtn = page.locator('button[aria-controls="app-sidebar"], [data-sidebar-menu]').first();
    await menuBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await menuBtn.click();
    await page.waitForSelector('aside.app-sidebar.open', { timeout: 15_000 });
    const heavyRow = page.locator(`[data-session-row="${seeded.primarySession.sessionId}"]`).first();
    await heavyRow.waitFor({ state: 'visible', timeout: 20_000 });

    await page.evaluate(() => window.__s16Probe.resetLongTasks());
    const preOpenPerf = await readCdpPerfMetrics();
    activePhase = 'heavy-open';
    phaseStartMs = performance.now();

    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 2000 });
    await cdp.send('Profiler.start');

    const openT0 = performance.now();
    await heavyRow.click();
    await page.waitForSelector('[data-transcript-scroll] [data-block-id], [data-transcript-scroll] [data-transcript-virtual-item]', {
      timeout: 60_000,
    });
    const firstMessagePaintMs = roundMs(performance.now() - openT0);
    // Wait briefly for follow-up hydration/rail queries to settle so we capture the full blocking tail
    await page.waitForTimeout(800);
    const { profile: cpuProfile } = await cdp.send('Profiler.stop');
    await cdp.send('Profiler.disable');

    const postOpenPerf = await readCdpPerfMetrics();
    const openLongTasks = await page.evaluate(() => window.__s16Probe.drainLongTasks());
    const openErrorToasts = await page.evaluate(() =>
      [...document.querySelectorAll('[data-toast="error"]')].map((n) => (n.textContent || '').trim().slice(0, 120)),
    );

    const heavyReqs = networkRecords.filter((r) => r.phase === 'heavy-open' && r.path.startsWith('/api/'));
    const heavyTransferBytes = heavyReqs.reduce((a, r) => a + r.encodedBytes, 0);
    const heavyOpenSummary = {
      sessionId: seeded.primarySession.sessionId,
      wireBytes: seeded.primarySession.wireBytes,
      wireMiB: roundMiB(seeded.primarySession.wireBytes),
      subagentCount: seeded.primarySession.subagentCount,
      firstMessagePaintMs,
      totalBlockingTimeMs: openLongTasks.totalBlockingTimeMs,
      maxLongTaskMs: openLongTasks.maxLongTaskMs,
      longTaskCount: openLongTasks.count,
      httpRpcRequestCount: heavyReqs.length,
      httpRpcTransferBytes: heavyTransferBytes,
      httpRpcTransferKiB: Number((heavyTransferBytes / 1024).toFixed(1)),
      scriptDeltaMs: roundMs(postOpenPerf.scriptDurationMs - preOpenPerf.scriptDurationMs),
      layoutDeltaMs: roundMs(postOpenPerf.layoutDurationMs - preOpenPerf.layoutDurationMs),
      recalcStyleDeltaMs: roundMs(postOpenPerf.recalcStyleDurationMs - preOpenPerf.recalcStyleDurationMs),
      jsHeapUsedMiB: postOpenPerf.jsHeapUsedMiB,
      domNodes: postOpenPerf.nodes,
      errorToastsOnOpen: openErrorToasts,
      topSlowestRpc: [...heavyReqs]
        .toSorted((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
        .slice(0, 10)
        .map((r) => ({
          method: r.method,
          path: r.path,
          status: r.status,
          startOffsetMs: r.phaseOffsetMs,
          durationMs: r.durationMs,
          encodedKiB: Number((r.encodedBytes / 1024).toFixed(1)),
        })),
      topLargestRpc: [...heavyReqs]
        .toSorted((a, b) => b.encodedBytes - a.encodedBytes)
        .slice(0, 6)
        .map((r) => ({
          method: r.method,
          path: r.path,
          encodedKiB: Number((r.encodedBytes / 1024).toFixed(1)),
          durationMs: r.durationMs,
        })),
      cpuProfileHotspots: summarizeCpuProfile(cpuProfile, 12),
    };

    // --- Phase 3: Touch Scroll Jank on Heavy Session (reducedMotion: no-preference) ---
    progress('S16 [3/4]: Measuring mobile touch-scroll frame times (P95 rAF delta) under 4x CPU throttle...');
    activePhase = 'touch-scroll';
    phaseStartMs = performance.now();
    await page.evaluate(() => {
      window.__s16Probe.resetLongTasks();
      window.__s16Probe.startRaf();
    });
    await page.evaluate(async () => {
      const scroller = document.querySelector('[data-transcript-scroll]');
      if (!scroller) return;
      for (let step = 0; step < 18; step += 1) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - 260);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 45));
      }
      for (let step = 0; step < 10; step += 1) {
        scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + 320);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 45));
      }
    });
    const rafDeltas = await page.evaluate(() => window.__s16Probe.stopRaf());
    const scrollLongTasks = await page.evaluate(() => window.__s16Probe.drainLongTasks());
    const scrollStats = summarize(rafDeltas);
    const touchScrollSummary = {
      frameCount: scrollStats.count,
      frameP50Ms: scrollStats.p50,
      frameP95Ms: scrollStats.p95,
      frameMaxMs: scrollStats.max,
      jankFramesOver50Ms: rafDeltas.filter((d) => d > 50).length,
      totalBlockingTimeMs: scrollLongTasks.totalBlockingTimeMs,
      maxLongTaskMs: scrollLongTasks.maxLongTaskMs,
    };

    // --- Phase 4: Rapid 5-Session Mobile Switching ---
    progress('S16 [4/4]: Running rapid 5-session touch switching...');
    activePhase = 'rapid-switch';
    const switchSamples = [];
    for (const sw of seeded.switchSessions) {
      const btn = page.locator('button[aria-controls="app-sidebar"], [data-sidebar-menu]').first();
      await btn.waitFor({ state: 'visible', timeout: 10_000 });
      await btn.click();
      await page.waitForSelector('aside.app-sidebar.open', { timeout: 10_000 });
      const row = page.locator(`[data-session-row="${sw.sessionId}"]`).first();
      await row.waitFor({ state: 'visible', timeout: 10_000 });

      await page.evaluate(() => window.__s16Probe.resetLongTasks());
      phaseStartMs = performance.now();
      const swT0 = performance.now();
      await row.click();
      await page.waitForURL(new RegExp(`/s/${sw.sessionId}`), { timeout: 20_000 });
      await page.waitForSelector('[data-transcript-scroll] [data-block-id], [data-transcript-scroll] [data-transcript-virtual-item]', {
        timeout: 25_000,
      });
      const swMs = roundMs(performance.now() - swT0);
      const swLt = await page.evaluate(() => window.__s16Probe.drainLongTasks());
      const swPerf = await readCdpPerfMetrics();
      const stickyUnread = await page.evaluate(
        (sid) => document.querySelector(`[data-session-row="${sid}"]`).dataset.sessionRowState === 'unread',
        sw.sessionId,
      );
      switchSamples.push({
        sessionId: sw.sessionId,
        firstMessagePaintMs: swMs,
        totalBlockingTimeMs: swLt.totalBlockingTimeMs,
        maxLongTaskMs: swLt.maxLongTaskMs,
        jsHeapUsedMiB: swPerf.jsHeapUsedMiB,
        stickyUnreadAfterView: stickyUnread,
      });
    }

    const switchLatencySummary = summarize(switchSamples.map((s) => s.firstMessagePaintMs));
    const report = {
      tier,
      emulation: {
        viewport: { width: 393, height: 852, dpr: 3 },
        cpuThrottlingRate: 4,
        network: { latencyMs: 40, downloadMbps: 15, uploadMbps: 5 },
        connectionMode: 'app-shell',
        reducedMotion: 'no-preference',
      },
      seedElapsedMs: seeded.seedElapsedMs,
      coldBoot: {
        coldBootToShellMs,
        totalBlockingTimeMs: bootLongTasks.totalBlockingTimeMs,
        maxLongTaskMs: bootLongTasks.maxLongTaskMs,
        scriptDurationMs: bootPerf.scriptDurationMs,
        jsHeapUsedMiB: bootPerf.jsHeapUsedMiB,
      },
      webAssetsAudit,
      heavyOpen: heavyOpenSummary,
      touchScroll: touchScrollSummary,
      rapidSwitch: {
        count: switchSamples.length,
        latencyMs: switchLatencySummary,
        maxLongTaskMs: Math.max(0, ...switchSamples.map((s) => s.maxLongTaskMs)),
        stickyUnreadCount: switchSamples.filter((s) => s.stickyUnreadAfterView).length,
        samples: switchSamples,
      },
      pageErrors,
      consoleErrorCount: consoleErrors.length,
      consoleErrorSamples: consoleErrors.slice(0, 10),
      wallMs: roundMs(performance.now() - startedAt),
    };

    const verdict = evaluateS16MobileVerdict(report);
    progress(
      `S16 Done: passed=${verdict.passed} boot=${coldBootToShellMs}ms jsWire=${webAssetsAudit.jsTotalEncodedMiB}MiB(enc=${webAssetsAudit.compressedJsChunkCount}/${webAssetsAudit.jsChunkCount}) heavyTTFM=${firstMessagePaintMs}ms TBT=${openLongTasks.totalBlockingTimeMs}ms maxLT=${openLongTasks.maxLongTaskMs}ms rpcCount=${heavyReqs.length} rpcKiB=${heavyOpenSummary.httpRpcTransferKiB} scrollP95=${touchScrollSummary.frameP95Ms}ms`,
    );
    return {
      ...report,
      passed: verdict.passed,
      exitCode: verdict.exitCode,
      productFailures: verdict.productFailures,
      harnessFailures: verdict.harnessFailures,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

// Standalone CLI entry point: boots real kap-server with real `webAssetsDir` and runs S16 directly.
if (isCliMain && process.env.KIKI_S16_TSX_READY !== '1') {
  const rootRequire = createRequire(path.join(REPO_ROOT, 'package.json'));
  const tsxImportUrl = pathToFileURL(rootRequire.resolve('tsx/esm')).href;
  const rawLoaderUrl = pathToFileURL(path.join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href;
  const child = spawnSync(
    process.execPath,
    ['--import', rawLoaderUrl, '--import', tsxImportUrl, import.meta.filename, ...process.argv.slice(2)],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, KIKI_S16_TSX_READY: '1' },
    },
  );
  process.exit(child.status ?? 1);
}

if (isCliMain && process.env.KIKI_S16_TSX_READY === '1') {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out-json');
  const outJsonPath = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
  const reportOnly = args.includes('--report-findings');
  const tier = args.includes('--tier=full') ? 'full' : 'smoke';
  const wireMbArg = args.find((a) => a.startsWith('--wire-mb='));
  const targetWireBytes = wireMbArg ? Number(wireMbArg.slice('--wire-mb='.length)) * MiB : null;
  const subArg = args.find((a) => a.startsWith('--subagents='));
  const subagentCount = subArg ? Number(subArg.slice('--subagents='.length)) : null;

  const tmpRoot = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp', 's16-mobile-'));
  const homeDir = path.join(tmpRoot, 'home');
  const osHomeDir = path.join(tmpRoot, 'os-home');
  const workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(osHomeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const envPatch = buildIsolatedPerfEnv({ homeDir, osHomeDir });
  Object.assign(process.env, envPatch);

  const wsId = computeWorkDirKey(workspaceDir);
  const resolvedWireBytes = targetWireBytes ?? (tier === 'full' ? 100 * MiB : 24 * MiB);
  const resolvedSubagents = subagentCount ?? (tier === 'full' ? 600 : 520);
  const resolvedTurns = tier === 'full' ? 160 : 96;
  console.log(`[s16] Pre-seeding heavy corpus before kap-server boot (wireTarget=${roundMiB(resolvedWireBytes)}MiB, subagents=${resolvedSubagents}, turns=${resolvedTurns})...`);
  const preseeded = seedS16MobileHeavyCorpus({
    homeDir,
    workspaceDir,
    workspaceId: wsId,
    subagentCount: resolvedSubagents,
    primaryTurns: resolvedTurns,
    targetWireBytes: resolvedWireBytes,
    switchSessionCount: 5,
  });

  const guiBuild = ensureGuiStaticBuild(path.join(REPO_ROOT, '.tmp', 'chaos-gui-dist'));
  const { startServer } = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'kap-server', 'src', 'start.ts')).href);
  const server = await startServer({
    hostIdentity: { productName: 'kiki-s16-mobile-bench', version: '0.0.0-s16', platform: process.platform },
    host: '127.0.0.1',
    port: 0,
    homeDir,
    webAssetsDir: guiBuild.distDir,
    logLevel: 'silent',
    runtimeManaged: false,
  });

  try {
    const res = await runScenarioS16MobileHeavySession({
      server: { endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken },
      corpus: { homeDir, workspaceDir, workspaceId: wsId },
      tier,
      targetWireBytes,
      subagentCount,
      preseeded,
      progress: (msg) => console.log(`[s16] ${msg}`),
    });
    if (outJsonPath) {
      fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
      fs.writeFileSync(outJsonPath, `${JSON.stringify(res, null, 2)}\n`, 'utf8');
      console.log(`[s16] report written -> ${outJsonPath}`);
    } else {
      console.log(JSON.stringify(res, null, 2));
    }
    if (res.harnessFailures?.length > 0) process.exit(2);
    if (!reportOnly && !res.passed) process.exit(res.exitCode || 1);
  } finally {
    await server.close().catch(() => undefined);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
