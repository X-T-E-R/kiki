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
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  } catch (error) {
    return { status: 0, json: null, error: String(error?.message ?? error) };
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

export function resolveTerminatingTimeoutStatus({ taskRow, wireRecords, dead }) {
  const termRec = (wireRecords ?? []).find(
    (r) =>
      (r?.type === 'task.terminated' || r?.type === 'background.task.terminated') &&
      (!taskRow?.id || !r.info?.taskId || r.info.taskId === taskRow.id),
  ) ?? null;
  const wireTerminalStatus = termRec?.info?.status ?? termRec?.status ?? termRec?.payload?.status ?? null;
  const wireTerminalReason = termRec?.info?.stopReason ?? termRec?.reason ?? termRec?.payload?.reason ?? null;
  const taskApiTerminalReason = taskRow?.terminal_reason ?? taskRow?.terminalReason ?? null;
  const apiTimedOut =
    taskRow?.status === 'timed_out' ||
    (taskRow?.status === 'failed' && taskApiTerminalReason === 'timed_out');
  const wireTimedOut = wireTerminalStatus === 'timed_out' || wireTerminalReason === 'timed_out';
  const observedStatus =
    apiTimedOut || wireTimedOut
      ? 'timed_out'
      : (wireTerminalStatus ?? taskRow?.status ?? (dead ? 'unknown_dead' : 'running'));
  const premature =
    !dead && (wireTimedOut || apiTimedOut || taskRow?.status === 'completed' || wireTerminalStatus === 'completed');
  return {
    observedStatus,
    premature,
    wireTerminalStatus,
    taskApiTerminalReason,
  };
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

  progress(`S13 Chaos Faults & §10.5 Real Bash/TaskStop/Abort (${runId}): executing 3 OS kill cells + 8 live chaos faults...`);

  const q = (p) => JSON.stringify(p.replaceAll('\\', '/'));
  const cells = [];
  const faultCells = [];
  const cleanupPids = [];

  const readSessionTaskStatus = async (sessionId) => {
    const res = await apiJson(
      server.endpoint,
      server.token,
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/tasks?include_completed=true`,
      undefined,
      10_000,
    );
    const raw = res.json?.data?.tasks ?? res.json?.data?.items ?? (Array.isArray(res.json?.data) ? res.json.data : []);
    return Array.isArray(raw) ? raw : [];
  };

  const createdSessionIds = [];
  const createSession = async (label) => {
    const res = await apiJson(server.endpoint, server.token, 'POST', '/api/sessions', {
      metadata: { cwd: dir },
      title: `S13 ${label} ${runId}`,
    });
    if (res.status !== 200 || !res.json?.data?.id) {
      throw new Error(`S13 failed to create session ${label}: status=${res.status}`);
    }
    createdSessionIds.push(res.json.data.id);
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
      const wallT0 = Date.now();
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

      const grandchildActiveAtTrigger = isPidAlive(grandchildPid);
      // Wait for real AgentTaskService finite timeout to fire and terminate the owned tree
      const dead = await waitForPidDeath(grandchildPid, timeoutSec * 1000 + 4_000);
      const grandchildExitMs = roundMs(performance.now() - t0);
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);

      const wirePath = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'wire.jsonl');
      let wireRecords = readWireRecords(wirePath);
      let tasksAfter = await readSessionTaskStatus(sess.sessionId);
      const settleDeadline = performance.now() + 3_000;
      while (performance.now() < settleDeadline) {
        const hasWireTerm = wireRecords.some(
          (r) => r?.type === 'task.terminated' || r?.type === 'background.task.terminated',
        );
        const hasTaskRow = tasksAfter.some(
          (t) => (t?.kind === 'bash' || t?.kind === 'shell' || t?.kind === 'process') && t?.status !== 'running',
        );
        if (hasWireTerm && hasTaskRow) break;
        await sleep(50);
        wireRecords = readWireRecords(wirePath);
        tasksAfter = await readSessionTaskStatus(sess.sessionId);
      }
      const taskRow =
        tasksAfter.find(
          (t) => t?.kind === 'bash' || t?.kind === 'shell' || t?.kind === 'process' || t?.status === 'timed_out',
        ) ??
        tasksAfter[0] ??
        null;
      const { observedStatus, premature, wireTerminalStatus, taskApiTerminalReason } = resolveTerminatingTimeoutStatus({
        taskRow,
        wireRecords,
        dead,
      });
      const bashCallRec1 = wireRecords.find(
        (r) => (r?.type === 'tool.call' || r?.type === 'tool_call') && (r?.payload?.name === 'Bash' || r?.name === 'Bash'),
      );
      const wireTermRec1 = wireRecords.find(
        (r) => r?.type === 'task.terminated' || r?.type === 'background.task.terminated',
      );
      const taskStartEpoch1 =
        (typeof taskRow?.startedAt === 'number' ? taskRow.startedAt : null) ??
        (typeof bashCallRec1?.time === 'number' ? bashCallRec1.time : null);
      const scheduledDeadlineMs =
        taskStartEpoch1 !== null
          ? roundMs(taskStartEpoch1 - wallT0 + timeoutSec * 1000)
          : roundMs(rootExitMs + timeoutSec * 1000);
      const triggerReceivedMs =
        typeof wireTermRec1?.time === 'number'
          ? roundMs(wireTermRec1.time - wallT0)
          : typeof taskRow?.endedAt === 'number'
            ? roundMs(taskRow.endedAt - wallT0)
            : scheduledDeadlineMs;
      cells.push({
        kind: 'terminating_timeout',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: premature,
        timeline: { rootExitMs, triggerReceivedMs, grandchildExitMs },
        scheduledDeadlineMs,
        cleanupAtMs: grandchildExitMs,
        terminalStatus: observedStatus,
        taskApiStatus: taskRow?.status ?? null,
        taskApiTerminalReason,
        wireTerminalStatus,
        survivingDescendants: isPidAlive(grandchildPid) ? 1 : 0,
      });
    }

    // Cell 2: foreground_detach_then_stop via real Bash(timeout: 1) -> auto-detach -> real TaskStop
    {
      const sess = await createSession('foreground_detach_then_stop');
      const scripts = writeEarlyExitSpinnerScripts(dir, 'foreground_detach');
      const detachTimeoutSec = 1;
      const plan = {
        steps: [
          {
            calls: [
              {
                name: 'Bash',
                input: {
                  command: `${q(process.execPath)} ${q(scripts.keepAliveWrapper)}`,
                  timeout: detachTimeoutSec,
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
      const wallT0 = Date.now();
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

      const dead = await waitForPidDeath(grandchildPid, 8_000);
      const grandchildExitWallMs = Date.now();
      const grandchildExitMs = roundMs(performance.now() - t0);
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);

      const wirePath2 = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'wire.jsonl');
      const wireRecords2 = readWireRecords(wirePath2);
      const tasksAfter2 = await readSessionTaskStatus(sess.sessionId);
      const taskRow2 =
        tasksAfter2.find(
          (t) => t?.kind === 'bash' || t?.kind === 'shell' || t?.kind === 'process' || t?.status === 'killed' || t?.status === 'cancelled',
        ) ??
        tasksAfter2[0] ??
        null;

      const bashCallRec2 = wireRecords2.find(
        (r) => (r?.type === 'tool.call' || r?.type === 'tool_call') && (r?.payload?.name === 'Bash' || r?.name === 'Bash'),
      );
      const bashCallId2 = bashCallRec2?.payload?.id ?? bashCallRec2?.payload?.callId ?? bashCallRec2?.callId ?? null;
      const bashResultRec2 = wireRecords2.find(
        (r) =>
          (r?.type === 'tool.result' || r?.type === 'tool_result') &&
          (bashCallId2 ? (r?.payload?.toolCallId ?? r?.payload?.callId ?? r?.callId) === bashCallId2 : true),
      );
      const taskStopCallRec2 = wireRecords2.find(
        (r) => (r?.type === 'tool.call' || r?.type === 'tool_call') && (r?.payload?.name === 'TaskStop' || r?.name === 'TaskStop'),
      );

      const bashResultText2 = JSON.stringify(bashResultRec2?.payload ?? bashResultRec2 ?? '');
      const observedDetachReason = /foreground[_\s-]?detach|moved to background|detached to background|background task/iu.test(
        bashResultText2,
      )
        ? 'foreground_detached'
        : (taskRow2?.detachReason ?? null);
      const bashStartEpoch2 =
        (typeof taskRow2?.startedAt === 'number' ? taskRow2.startedAt : null) ??
        (typeof bashCallRec2?.time === 'number' ? bashCallRec2.time : null);
      const detachReceiptEpoch2 = typeof bashResultRec2?.time === 'number' ? bashResultRec2.time : null;
      const detachReceiptDelayFromDeadlineMs =
        bashStartEpoch2 !== null && detachReceiptEpoch2 !== null
          ? roundMs(detachReceiptEpoch2 - (bashStartEpoch2 + detachTimeoutSec * 1000))
          : null;
      const stopIngressEpoch2 = typeof taskStopCallRec2?.time === 'number' ? taskStopCallRec2.time : null;
      const triggerReceivedMs = stopIngressEpoch2 !== null ? roundMs(stopIngressEpoch2 - wallT0) : null;
      const cleanupMsFromStopIngress =
        dead && stopIngressEpoch2 !== null ? roundMs(Math.max(0, grandchildExitWallMs - stopIngressEpoch2)) : null;
      const prematureCompletion2 = Boolean(
        grandchildActiveAtTrigger &&
          observedDetachReason === null &&
          /exited|completed/iu.test(bashResultText2),
      );

      const observedStopStatus =
        taskRow2?.status === 'killed' || taskRow2?.status === 'cancelled'
          ? 'killed'
          : (taskRow2?.status ?? (dead ? 'killed' : 'running'));
      cells.push({
        kind: 'foreground_detach_then_stop',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: prematureCompletion2,
        timeline: { rootExitMs, triggerReceivedMs, grandchildExitMs },
        detachReason: observedDetachReason,
        detachReceiptDelayFromDeadlineMs,
        terminalStatusAfterStop: observedStopStatus,
        taskApiStatus: taskRow2?.status ?? null,
        cleanupMsFromStopIngress,
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

      const tasksAfter3 = await readSessionTaskStatus(sess.sessionId);
      const taskRow3 =
        tasksAfter3.find(
          (t) => t?.kind === 'bash' || t?.kind === 'shell' || t?.kind === 'process' || t?.status === 'killed' || t?.status === 'cancelled',
        ) ??
        tasksAfter3[0] ??
        null;
      const wirePath3 = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'wire.jsonl');
      const turnEnded3 = readWireRecords(wirePath3).find((r) => r.type === 'turn.ended');
      const observedCancelStatus =
        taskRow3?.status === 'killed' || taskRow3?.status === 'cancelled'
          ? 'killed'
          : turnEnded3 && (turnEnded3.reason === 'aborted' || turnEnded3.reason === 'cancelled' || turnEnded3.reason === 'interrupted') && dead
            ? 'killed'
            : (taskRow3?.status ?? (dead ? 'killed' : 'running'));
      cells.push({
        kind: 'direct_cancel',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: false,
        timeline: { rootExitMs, triggerReceivedMs, grandchildExitMs },
        terminalStatus: observedCancelStatus,
        taskApiStatus: taskRow3?.status ?? null,
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
        passed: trRes.status === 200 && trRes.json?.code === 0 && items.length > 0,
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

    // Chaos Fault Cell 5: Read-only wire write refusal & post-error server health recovery
    {
      const sess = await createSession('fault_readonly_wire');
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_ro_seed_${runId}`,
        content: [{ type: 'text', text: `S13 read-only write refusal seed ${runId}` }],
      });
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);
      if (typeof server.closeSession === 'function') await server.closeSession(sess.sessionId);
      const wirePath = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'wire.jsonl');
      let writeErrorHandled = false;
      try {
        if (fs.existsSync(wirePath)) fs.chmodSync(wirePath, 0o444);
        const roRes = await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
          prompt_id: `p_s13_ro_fail_${runId}`,
          content: [{ type: 'text', text: `S13 write into read-only wire ${runId}` }],
        }, 12_000);
        // Server must stay alive and respond cleanly (either error envelope or graceful rejection/recovery)
        const health = await apiJson(server.endpoint, server.token, 'GET', '/api/healthz', undefined, 5_000);
        writeErrorHandled = health.status === 200 && (roRes.status === 200 || roRes.status >= 400);
      } finally {
        if (fs.existsSync(wirePath)) {
          try {
            fs.chmodSync(wirePath, 0o644);
          } catch {}
        }
      }
      faultCells.push({
        kind: 'readonly_wire_write_error_recovery',
        passed: writeErrorHandled,
      });
    }

    // Chaos Fault Cell 6: Duplicate prompt_id idempotency under concurrent replay
    {
      const sess = await createSession('fault_dup_prompt_id');
      const dupPromptId = `p_s13_dup_${runId}`;
      const body = {
        prompt_id: dupPromptId,
        content: [{ type: 'text', text: `S13 duplicate prompt idempotency ${runId}` }],
      };
      const [r1, r2] = await Promise.all([
        apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, body),
        apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, body),
      ]);
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);
      const wirePath = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'wire.jsonl');
      const turnPrompts = readWireRecords(wirePath).filter((r) => r.type === 'turn.prompt');
      faultCells.push({
        kind: 'duplicate_prompt_idempotency',
        passed: r1.status === 200 && r2.status === 200 && turnPrompts.length === 1,
        turnPromptCount: turnPrompts.length,
        codes: [r1.json?.code ?? null, r2.json?.code ?? null],
      });
    }

    // Chaos Fault Cell 7: Invalid bearer auth strictly returns HTTP 401
    {
      const unauthRes = await apiJson(server.endpoint, `invalid-token-${runId}`, 'GET', '/api/sessions', undefined, 5_000);
      faultCells.push({
        kind: 'invalid_bearer_401',
        passed: unauthRes.status === 401,
        status: unauthRes.status,
      });
    }

    // Chaos Fault Cell 8: Oversized (>8 MiB) cold wire hooks?observe=true returns HTTP 200 with code=40901
    {
      const sess = await createSession('fault_oversized_hooks_40901');
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(sess.sessionId)}/prompts`, {
        prompt_id: `p_s13_hooks_${runId}`,
        content: [{ type: 'text', text: `S13 oversized hooks seed ${runId}` }],
      });
      await waitForSessionIdle(server.endpoint, server.token, sess.sessionId, 15_000);
      if (typeof server.closeSession === 'function') await server.closeSession(sess.sessionId);
      const wirePath = path.join(corpus.homeDir, 'sessions', sess.workspaceId, sess.sessionId, 'agents', 'main', 'wire.jsonl');
      const padLine = `${JSON.stringify({ type: 'note', body: 'h'.repeat(64 * 1024) })}\n`;
      fs.appendFileSync(wirePath, padLine.repeat(135), 'utf8');
      const hooksRes = await apiJson(
        server.endpoint,
        server.token,
        'GET',
        `/api/sessions/${encodeURIComponent(sess.sessionId)}/agents/main/hooks?observe=true`,
        undefined,
        10_000,
      );
      faultCells.push({
        kind: 'oversized_cold_hooks_observe_40901',
        passed: hooksRes.status === 200 && hooksRes.json?.code === 40901,
        status: hooksRes.status,
        code: hooksRes.json?.code ?? null,
      });
    }
  } finally {
    if (typeof server.closeSession === 'function') {
      await Promise.all(createdSessionIds.map((sid) => server.closeSession(sid).catch(() => undefined)));
    }
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
    osKillCells: cells,
    cells,
    chaosFaults: faultCells,
    faultCells,
    spawnedPids: [...cleanupPids],
    evaluations,
    productFailures,
    harnessFailures,
  };
}
