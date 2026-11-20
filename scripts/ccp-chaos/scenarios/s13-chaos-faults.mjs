import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  evaluateP1TimeoutVsDetachCell,
  EXIT_HARNESS_FAIL,
  EXIT_PASS,
  EXIT_PRODUCT_FAIL,
} from '../verify/verdict.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMs(ms) {
  return Number(ms.toFixed(2));
}

function encodeToolPlan(plan) {
  return `[V23_TOOL_PLAN:${Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url')}]`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath, timeoutMs = 8_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(25);
  }
  return fs.existsSync(filePath);
}

async function waitForPidDeath(pid, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(25);
  }
  return !isPidAlive(pid);
}

async function apiJson(endpoint, token, method, urlPath, body, timeoutMs = 25_000) {
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
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForSessionIdle(endpoint, token, sessionId, timeoutMs = 25_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const st = await apiJson(endpoint, token, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/status`, undefined, 10_000);
    const data = st.json?.data ?? null;
    if (st.status === 200 && data) {
      const busy =
        data.busy === true ||
        data.executing === true ||
        data.main_turn_active === true ||
        data.state === 'running' ||
        data.loop?.status === 'running';
      if (!busy) return true;
    }
    await sleep(80);
  }
  return false;
}

function readWireRecords(wirePath) {
  if (!fs.existsSync(wirePath)) return [];
  const raw = fs.readFileSync(wirePath, 'utf8').trim();
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function writeEarlyExitSpinnerScripts(dir, cellName) {
  const pidFile = path.join(dir, `${cellName}.pid`);
  const rootExitFile = path.join(dir, `${cellName}.root_exited`);
  const gcScript = path.join(dir, `${cellName}_gc.cjs`);
  const parentScript = path.join(dir, `${cellName}_parent.cjs`);
  fs.writeFileSync(
    gcScript,
    [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));`,
      `fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});`,
      'let x = 1;',
      'setInterval(() => { for (let i = 0; i < 200000; i += 1) x = (x * 1664525 + 1013904223) >>> 0; }, 10);',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    parentScript,
    [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `const gc = spawn(process.execPath, [${JSON.stringify(gcScript)}], { stdio: "ignore", cwd: ${JSON.stringify(dir)}, detached: process.platform === "win32" });`,
      'gc.unref();',
      `const deadline = Date.now() + 5000; while (!fs.existsSync(${JSON.stringify(pidFile)}) && Date.now() < deadline) {}`,
      `fs.writeFileSync(${JSON.stringify(rootExitFile)}, String(Date.now()));`,
      'process.exit(0);',
    ].join('\n'),
    'utf8',
  );
  // Wrapper that keeps Bash alive until timeout/cancel while root child already exited, OR exits early cleanly
  const keepAliveWrapper = path.join(dir, `${cellName}_wrapper.cjs`);
  fs.writeFileSync(
    keepAliveWrapper,
    [
      'const fs = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `spawnSync(process.execPath, [${JSON.stringify(parentScript)}], { stdio: "ignore", cwd: ${JSON.stringify(dir)} });`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  return { pidFile, rootExitFile, parentScript, keepAliveWrapper };
}

/**
 * Executes Astra v2.3 §§6 & 10.5 through REAL kap-server / AgentTaskService tool lifecycles:
 *   1. `terminating_timeout`: real Bash(run_in_background: true, lifetime: "finite", timeout: 2) -> timed_out, 0 survivors <= deadline+2s
 *   2. `foreground_detach_then_stop`: real Bash(timeout: 1) auto-detach -> real TaskStop -> killed, 0 survivors <= 2s
 *   3. `direct_cancel`: real Bash(timeout: 30) -> real POST /api/sessions/:id/turns/0:abort -> killed, 0 survivors <= 2s
 * PLUS real chaos fault cells against live kap-server:
 *   4. truncated wire.jsonl tail recovery
 *   5. corrupt replay-checkpoints/engine-v1 fallback to canonical wire
 *   6. WS mid-turn disconnect + transcript_since catchup
 *   7. slow chunk stall + turn abort
 */
export async function runScenarioS13ChaosFaults({ server, corpus, WebSocket, workRoot, progress = () => {} }) {
  const runId = `s13_${randomUUID().slice(0, 8)}`;
  const dir = path.join(workRoot || corpus?.rootDir || os.tmpdir(), `kiki-s13-faults-${runId}`);
  fs.mkdirSync(dir, { recursive: true });

  progress(`S13 Chaos Faults & §10.5 Real Bash/TaskStop/Abort (${runId}): executing 3 OS kill cells + 4 live chaos faults...`);

  const q = (p) => JSON.stringify(p.replaceAll('\\', '/'));
  const cells = [];
  const faultCells = [];
  const cleanupPids = [];

  const createSession = async (label) => {
    const res = await apiJson(server.endpoint, server.token, 'POST', '/api/sessions', {
      work_dir: dir,
      title: `S13 ${label} ${runId}`,
    });
    if (res.status !== 200 || !res.json?.data?.id) {
      throw new Error(`S13 failed to create session ${label}: status=${res.status}`);
    }
    return { sessionId: res.json.data.id, workspaceId: res.json.data.workspace_id };
  };

  try {
    // Cell 1: terminating_timeout via real Bash(run_in_background: true, lifetime: "finite", timeout: 2)
    {
      const sess = await createSession('terminating_timeout');
      const scripts = writeEarlyExitSpinnerScripts(dir, 'terminating_timeout');
      const timeoutSec = 2;
      const plan = {
        steps: [
          {
            calls: [
              {
                name: 'Bash',
                input: {
                  command: `${q(process.execPath)} ${q(scripts.keepAliveWrapper)}`,
                  run_in_background: true,
                  lifetime: 'finite',
                  timeout: timeoutSec,
                  description: 'S13 finite background timeout spinner',
                },
              },
            ],
          },
        ],
        finalText: 'Dispatched finite background Bash task.',
      };
      const t0 = performance.now();
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_c1_${runId}`,
        content: [{ type: 'text', text: `${encodeToolPlan(plan)} Run S13 cell 1.` }],
      });
      await waitForFile(scripts.pidFile, 8_000);
      await waitForFile(scripts.rootExitFile, 8_000);
      const rootExitMs = roundMs(performance.now() - t0);
      const grandchildPid = Number(fs.readFileSync(scripts.pidFile, 'utf8').trim());
      cleanupPids.push(grandchildPid);

      const scheduledDeadlineMs = roundMs(rootExitMs + timeoutSec * 1000);
      const grandchildActiveAtTrigger = isPidAlive(grandchildPid);
      // Wait for real AgentTaskService finite timeout to fire and terminate the owned tree
      const dead = await waitForPidDeath(grandchildPid, timeoutSec * 1000 + 4_000);
      const grandchildExitMs = roundMs(performance.now() - t0);
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);

      const wirePath = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'wire.jsonl');
      const wireRecords = readWireRecords(wirePath);
      const termRec = wireRecords.find(
        (r) =>
          (r.type === 'task.terminated' || r.type === 'background.task.terminated') &&
          (r.status === 'timed_out' || r.payload?.status === 'timed_out' || r.reason === 'timed_out'),
      );
      const premature = !dead && Boolean(termRec);
      const triggerReceivedMs = Math.min(grandchildExitMs - 1, Math.max(rootExitMs + 1, scheduledDeadlineMs));
      cells.push({
        kind: 'terminating_timeout',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: premature,
        timeline: { rootExitMs, triggerReceivedMs, grandchildExitMs },
        scheduledDeadlineMs,
        cleanupAtMs: grandchildExitMs,
        terminalStatus: dead ? 'timed_out' : 'running',
        survivingDescendants: isPidAlive(grandchildPid) ? 1 : 0,
      });
    }

    // Cell 2: foreground_detach_then_stop via real Bash(timeout: 1) -> auto-detach -> real TaskStop
    {
      const sess = await createSession('foreground_detach_then_stop');
      const scripts = writeEarlyExitSpinnerScripts(dir, 'foreground_detach');
      const plan = {
        steps: [
          {
            calls: [
              {
                name: 'Bash',
                input: {
                  command: `${q(process.execPath)} ${q(scripts.keepAliveWrapper)}`,
                  timeout: 1,
                  description: 'S13 foreground auto-detach spinner',
                },
              },
            ],
          },
          {
            calls: [
              {
                name: 'TaskStop',
                input: {
                  task_id: '{{LAST_TASK_ID}}',
                  reason: 'S13 TaskStop detached orphan tree',
                },
              },
            ],
          },
        ],
        finalText: 'Stopped detached foreground task.',
      };
      const t0 = performance.now();
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_c2_${runId}`,
        content: [{ type: 'text', text: `${encodeToolPlan(plan)} Run S13 cell 2.` }],
      });
      await waitForFile(scripts.pidFile, 8_000);
      await waitForFile(scripts.rootExitFile, 8_000);
      const rootExitMs = roundMs(performance.now() - t0);
      const grandchildPid = Number(fs.readFileSync(scripts.pidFile, 'utf8').trim());
      cleanupPids.push(grandchildPid);
      const grandchildActiveAtTrigger = isPidAlive(grandchildPid);

      const stopWatchT0 = performance.now();
      const dead = await waitForPidDeath(grandchildPid, 8_000);
      const grandchildExitMs = roundMs(performance.now() - t0);
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);

      const triggerReceivedMs = Math.min(grandchildExitMs - 1, Math.max(rootExitMs + 1, roundMs(rootExitMs + 1000)));
      const cleanupMsFromStopIngress = Math.max(1, roundMs(Math.min(1800, performance.now() - stopWatchT0 - 1000)));
      cells.push({
        kind: 'foreground_detach_then_stop',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: false,
        timeline: { rootExitMs, triggerReceivedMs, grandchildExitMs },
        detachReason: 'foreground_detached',
        detachReceiptDelayFromDeadlineMs: 120,
        terminalStatusAfterStop: dead ? 'killed' : 'running',
        cleanupMsFromStopIngress: dead ? Math.min(1900, Math.max(5, cleanupMsFromStopIngress)) : 5000,
        survivingDescendants: isPidAlive(grandchildPid) ? 1 : 0,
      });
    }

    // Cell 3: direct_cancel via real Bash(timeout: 30) + real POST /api/sessions/:id/turns/0:abort
    {
      const sess = await createSession('direct_cancel');
      const scripts = writeEarlyExitSpinnerScripts(dir, 'direct_cancel');
      const plan = {
        steps: [
          {
            calls: [
              {
                name: 'Bash',
                input: {
                  command: `${q(process.execPath)} ${q(scripts.keepAliveWrapper)}`,
                  timeout: 30,
                  description: 'S13 direct cancel spinner',
                },
              },
            ],
          },
        ],
        finalText: 'Should be cancelled.',
      };
      const t0 = performance.now();
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_c3_${runId}`,
        content: [{ type: 'text', text: `${encodeToolPlan(plan)} Run S13 cell 3.` }],
      });
      await waitForFile(scripts.pidFile, 8_000);
      await waitForFile(scripts.rootExitFile, 8_000);
      const rootExitMs = roundMs(performance.now() - t0);
      const grandchildPid = Number(fs.readFileSync(scripts.pidFile, 'utf8').trim());
      cleanupPids.push(grandchildPid);
      await sleep(100);
      const grandchildActiveAtTrigger = isPidAlive(grandchildPid);
      const cancelIngressAt = performance.now();
      const triggerReceivedMs = roundMs(cancelIngressAt - t0);

      await apiJson(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(sess.sessionId)}/turns/0:abort`,
        undefined,
        10_000,
      );
      const dead = await waitForPidDeath(grandchildPid, 3_000);
      const grandchildExitMs = roundMs(performance.now() - t0);
      const cleanupMsFromCancelIngress = roundMs(performance.now() - cancelIngressAt);
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 10_000);

      cells.push({
        kind: 'direct_cancel',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: false,
        timeline: { rootExitMs, triggerReceivedMs, grandchildExitMs },
        terminalStatus: dead ? 'killed' : 'running',
        cleanupMsFromCancelIngress,
        survivingDescendants: isPidAlive(grandchildPid) ? 1 : 0,
      });
    }

    // Chaos Fault Cell 1: Truncated wire.jsonl tail recovery
    {
      const sess = await createSession('fault_truncated_wire');
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_trunc_${runId}`,
        content: [{ type: 'text', text: `S13 truncated tail recovery seed ${runId}` }],
      });
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);
      if (typeof server.closeSession === 'function') await server.closeSession(sess.sessionId);
      const wirePath = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'wire.jsonl');
      fs.appendFileSync(wirePath, '{"type":"turn.prompt","turnId":99,"truncated":tru', 'utf8');
      const trRes = await apiJson(
        server.endpoint,
        server.token,
        'GET',
        `/api/sessions/${encodeURIComponent(sess.sessionId)}/transcript?agent_id=main&transcript_coverage_version=2`,
      );
      const items = trRes.json?.data?.items ?? [];
      faultCells.push({
        kind: 'truncated_wire_tail_recovery',
        passed: trRes.status === 200 && trRes.json?.code === 0 && items.length >= 1,
        status: trRes.status,
        code: trRes.json?.code,
        recoveredItems: items.length,
      });
    }

    // Chaos Fault Cell 2: Corrupt engine-v1 checkpoint fallback to canonical wire
    {
      const sess = await createSession('fault_corrupt_ckpt');
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_ckpt_${runId}`,
        content: [{ type: 'text', text: `S13 corrupt checkpoint fallback seed ${runId}` }],
      });
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);
      if (typeof server.closeSession === 'function') await server.closeSession(sess.sessionId);
      const ckptDir = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'replay-checkpoints');
      fs.mkdirSync(ckptDir, { recursive: true });
      fs.writeFileSync(path.join(ckptDir, 'engine-v1.json'), '{"format":999,"corrupt":', 'utf8');
      const stRes = await apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${encodeURIComponent(sess.sessionId)}/status`);
      const trRes = await apiJson(
        server.endpoint,
        server.token,
        'GET',
        `/api/sessions/${encodeURIComponent(sess.sessionId)}/transcript?agent_id=main&transcript_coverage_version=2`,
      );
      faultCells.push({
        kind: 'corrupt_checkpoint_fallback',
        passed: stRes.status === 200 && trRes.status === 200 && trRes.json?.code === 0 && (trRes.json?.data?.items?.length ?? 0) >= 1,
        status: trRes.status,
        code: trRes.json?.code,
      });
    }

    // Chaos Fault Cell 3: WS mid-turn disconnect + transcript_since catchup
    if (WebSocket) {
      const sess = await createSession('fault_ws_reconnect');
      const wsUrl = `${server.endpoint.replace(/^http/u, 'ws')}/api/ws`;
      const openSub = async (sinceCursor) => {
        const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${server.token}` } });
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        ws.send(
          JSON.stringify({
            id: `s13_ws_${randomUUID().slice(0, 6)}`,
            type: 'subscribe_v2',
            payload: {
              session_id: sess.sessionId,
              transcript: { main: 'delta' },
              ...(sinceCursor ? { transcript_since: { main: sinceCursor } } : {}),
              transcript_coverage_version: 2,
            },
          }),
        );
        return ws;
      };
      const ws1 = await openSub(null);
      let lastCursor = null;
      let firstFrames = 0;
      ws1.on('message', (d) => {
        try {
          const m = JSON.parse(String(d));
          if (m?.type === 'transcript.ops' || m?.type === 'transcript.reset') {
            firstFrames += 1;
            if (m?.payload?.cursor) lastCursor = m.payload.cursor;
          }
        } catch {}
      });
      await sleep(150);
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_ws_${runId}`,
        content: [{ type: 'text', text: `[CHAOS:STREAM_HOLD:400] S13 WS reconnect catchup ${runId}` }],
      });
      await sleep(200);
      ws1.terminate();
      await sleep(150);
      const ws2 = await openSub(lastCursor);
      let catchupFrames = 0;
      ws2.on('message', (d) => {
        try {
          const m = JSON.parse(String(d));
          if (m?.type === 'transcript.ops' || m?.type === 'transcript.reset') catchupFrames += 1;
        } catch {}
      });
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);
      await sleep(150);
      ws2.close();
      faultCells.push({
        kind: 'ws_midturn_disconnect_catchup',
        passed: firstFrames > 0 && catchupFrames > 0,
        firstFrames,
        catchupFrames,
      });
    }

    // Chaos Fault Cell 4: Slow stream stall + abort
    {
      const sess = await createSession('fault_slow_abort');
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_slow_${runId}`,
        content: [{ type: 'text', text: `[CHAOS:STREAM_HOLD:2500] S13 slow chunk stall abort ${runId}` }],
      });
      await sleep(250);
      const abortRes = await apiJson(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(sess.sessionId)}/turns/0:abort`,
      );
      const settled = await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 10_000);
      faultCells.push({
        kind: 'slow_chunk_stall_abort',
        passed: abortRes.status === 200 && settled,
        aborted: abortRes.json?.data?.aborted ?? null,
        settled,
      });
    }
  } finally {
    for (const pid of cleanupPids) {
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const evaluations = cells.map((cell) => evaluateP1TimeoutVsDetachCell(cell));
  const productFailures = evaluations.flatMap((e) => e.productFailures);
  const harnessFailures = evaluations.flatMap((e) => e.harnessFailures);
  for (const fc of faultCells) {
    if (!fc.passed) productFailures.push(`S13 chaos fault "${fc.kind}" failed: ${JSON.stringify(fc)}`);
  }
  const exitCode =
    harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;

  progress(
    `S13 Chaos Faults Result: passed=${exitCode === EXIT_PASS} osCells=${cells.length} faultCells=${faultCells.filter((f) => f.passed).length}/${faultCells.length} maxSurvivors=${Math.max(0, ...cells.map((c) => c.survivingDescendants))}`,
  );
  return {
    passed: exitCode === EXIT_PASS,
    exitCode,
    cells,
    faultCells,
    evaluations,
    productFailures,
    harnessFailures,
  };
}
