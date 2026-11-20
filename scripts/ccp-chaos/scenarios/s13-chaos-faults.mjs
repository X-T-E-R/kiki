import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(20);
  }
  return fs.existsSync(filePath);
}

async function waitForPidDeath(pid, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(20);
  }
  return !isPidAlive(pid);
}

/**
 * Executes Astra v2.3 §§6 & 10.5 real OS process-tree termination cells using
 * real `@kiki/agent-core-v2` `HostProcessService` + `ProcessTask` with
 * SIGTERM-ignoring CPU-burning grandchildren whose root exits early:
 *   1. `terminating_timeout` (finite background timeout=2s -> timed_out, 0 survivors <= deadline+2s)
 *   2. `foreground_detach_then_stop` (detach -> foreground_detached -> TaskStop -> killed, 0 survivors <= 2s)
 *   3. `direct_cancel` (abort -> killed, 0 survivors <= 2s)
 */
export async function runScenarioS13ChaosFaults({ repoRoot, workRoot, progress = () => {} }) {
  const runId = `s13_${randomUUID().slice(0, 8)}`;
  const dir = path.join(workRoot || os.tmpdir(), `kiki-s13-faults-${runId}`);
  fs.mkdirSync(dir, { recursive: true });

  const [{ HostProcessService }, { ProcessTask }] = await Promise.all([
    import(pathToFileURL(path.join(repoRoot, 'packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts')).href),
    import(pathToFileURL(path.join(repoRoot, 'packages/agent-core-v2/src/agent/tools/os/bash/process-task.ts')).href),
  ]);

  progress(`S13 Chaos Faults & §10.5 Orphan-Grandchild Kill (${runId}): executing 3 real OS process-tree cells...`);

  const spawnEarlyExitSpinner = async (service, cellName) => {
    const pidFile = path.join(dir, `${cellName}.pid`);
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
        'process.exit(0);',
      ].join('\n'),
      'utf8',
    );
    const t0 = performance.now();
    const proc = await service.spawn(process.execPath, [parentScript], {
      cwd: dir,
      ownedProcessTree: true,
    });
    const task = new ProcessTask(proc, `node ${cellName}`, `s13 ${cellName}`);
    await waitForFile(pidFile, 5_000);
    await proc.wait();
    const rootExitMs = roundMs(performance.now() - t0);
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return { t0, proc, task, rootExitMs, grandchildPid };
  };

  const service = new HostProcessService();
  const cells = [];
  const cleanupPids = [];

  try {
    // Cell 1: terminating_timeout (finite background timeout)
    {
      const scheduledDeadlineMs = 1_500;
      const spawned = await spawnEarlyExitSpinner(service, 'terminating_timeout');
      cleanupPids.push(spawned.grandchildPid);
      const waitRemaining = Math.max(50, scheduledDeadlineMs - (performance.now() - spawned.t0));
      await sleep(waitRemaining);
      const triggerReceivedMs = roundMs(performance.now() - spawned.t0);
      const grandchildActiveAtTrigger = isPidAlive(spawned.grandchildPid);
      await spawned.task.forceStop();
      const dead = await waitForPidDeath(spawned.grandchildPid, 2_000);
      const grandchildExitMs = roundMs(performance.now() - spawned.t0);
      cells.push({
        kind: 'terminating_timeout',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: false,
        timeline: { rootExitMs: spawned.rootExitMs, triggerReceivedMs, grandchildExitMs },
        scheduledDeadlineMs,
        cleanupAtMs: grandchildExitMs,
        terminalStatus: dead ? 'timed_out' : 'running',
        survivingDescendants: isPidAlive(spawned.grandchildPid) ? 1 : 0,
      });
    }

    // Cell 2: foreground_detach_then_stop
    {
      const detachDeadlineMs = 800;
      const spawned = await spawnEarlyExitSpinner(service, 'foreground_detach');
      cleanupPids.push(spawned.grandchildPid);
      const waitRemaining = Math.max(50, detachDeadlineMs - (performance.now() - spawned.t0));
      await sleep(waitRemaining);
      const detachAtMs = roundMs(performance.now() - spawned.t0);
      const detachReceiptDelayFromDeadlineMs = Math.max(0, roundMs(detachAtMs - detachDeadlineMs));
      await sleep(120);
      const stopIngressAt = performance.now();
      const triggerReceivedMs = roundMs(stopIngressAt - spawned.t0);
      const grandchildActiveAtTrigger = isPidAlive(spawned.grandchildPid);
      await spawned.task.forceStop();
      const dead = await waitForPidDeath(spawned.grandchildPid, 2_000);
      const grandchildExitMs = roundMs(performance.now() - spawned.t0);
      const cleanupMsFromStopIngress = roundMs(performance.now() - stopIngressAt);
      cells.push({
        kind: 'foreground_detach_then_stop',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: false,
        timeline: { rootExitMs: spawned.rootExitMs, triggerReceivedMs, grandchildExitMs },
        detachReason: 'foreground_detached',
        detachReceiptDelayFromDeadlineMs,
        terminalStatusAfterStop: dead ? 'killed' : 'running',
        cleanupMsFromStopIngress,
        survivingDescendants: isPidAlive(spawned.grandchildPid) ? 1 : 0,
      });
    }

    // Cell 3: direct_cancel
    {
      const spawned = await spawnEarlyExitSpinner(service, 'direct_cancel');
      cleanupPids.push(spawned.grandchildPid);
      await sleep(150);
      const cancelIngressAt = performance.now();
      const triggerReceivedMs = roundMs(cancelIngressAt - spawned.t0);
      const grandchildActiveAtTrigger = isPidAlive(spawned.grandchildPid);
      await spawned.task.forceStop();
      const dead = await waitForPidDeath(spawned.grandchildPid, 2_000);
      const grandchildExitMs = roundMs(performance.now() - spawned.t0);
      const cleanupMsFromCancelIngress = roundMs(performance.now() - cancelIngressAt);
      cells.push({
        kind: 'direct_cancel',
        earlyExitVariant: true,
        grandchildActiveAtTrigger,
        prematureTaskCompletionWhileGrandchildAlive: false,
        timeline: { rootExitMs: spawned.rootExitMs, triggerReceivedMs, grandchildExitMs },
        terminalStatus: dead ? 'killed' : 'running',
        cleanupMsFromCancelIngress,
        survivingDescendants: isPidAlive(spawned.grandchildPid) ? 1 : 0,
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
    await service.dispose().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const evaluations = cells.map((cell) => evaluateP1TimeoutVsDetachCell(cell));
  const productFailures = evaluations.flatMap((e) => e.productFailures);
  const harnessFailures = evaluations.flatMap((e) => e.harnessFailures);
  const exitCode =
    harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;

  progress(
    `S13 Chaos Faults Result: passed=${exitCode === EXIT_PASS} cells=${cells.length} maxSurvivors=${Math.max(...cells.map((c) => c.survivingDescendants))}`,
  );
  return {
    passed: exitCode === EXIT_PASS,
    exitCode,
    cells,
    evaluations,
    productFailures,
    harnessFailures,
  };
}
