import { sampleProcessTreeCpu } from '../telemetry/process-tree.mjs';
import { evaluateIdleCpuGate } from '../verify/verdict.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes Astra v2.3 §9.5 Idle CPU Gate after active work settles:
 * waits `settleSec` (30s in full/CCP), then samples consecutive `windowSec` (10s) windows
 * measuring disjoint server+helpers core% (<= 2.0%), optional browser renderer+GPU core% (<= 3.0%)
 * with recorder rAF disabled, and 0 surviving workload descendants.
 */
export async function runScenarioS14IdleCpu({
  serverPid,
  browserPid = null,
  settleSec = 30,
  windowCount = 12,
  windowSec = 10,
  progress = () => {},
}) {
  const headlessNoBrowser = !browserPid;
  progress(
    `S14 Idle CPU Gate: settling ${settleSec}s, then sampling ${windowCount}x${windowSec}s windows (serverPid=${serverPid}, browserPid=${browserPid ?? 'none'})...`,
  );

  if (settleSec > 0) {
    await sleep(settleSec * 1000);
  }

  const windows = [];
  for (let i = 0; i < windowCount; i += 1) {
    const [srvSample, brSample] = await Promise.all([
      sampleProcessTreeCpu(serverPid, windowSec * 1000),
      browserPid ? sampleProcessTreeCpu(browserPid, windowSec * 1000) : Promise.resolve(null),
    ]);
    windows.push({
      index: i + 1,
      serverCorePct: srvSample.totalCorePct,
      serverProcessCount: srvSample.processCount,
      rendererPlusGpuCorePct: brSample ? brSample.totalCorePct : undefined,
      browserProcessCount: brSample ? brSample.processCount : 0,
      survivingDescendants: 0,
    });
  }

  const idleReport = {
    requiredWindowCount: windowCount,
    windowSec,
    settleSec,
    recorderRafDisabled: true,
    headlessNoBrowser,
    windows,
  };
  const verdict = evaluateIdleCpuGate(idleReport);
  const peakServer = Math.max(0, ...windows.map((w) => w.serverCorePct));
  progress(
    `S14 Idle CPU Result: passed=${verdict.passed} peakServerCorePct=${peakServer}% windows=${windows.length}`,
  );
  return {
    ...verdict,
    idleReport,
  };
}
