import { sampleDisjointIdleWindow } from '../telemetry/process-tree.mjs';
import { evaluateIdleCpuGate, FROZEN_V23_THRESHOLDS } from '../verify/verdict.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes Astra v2.3 §9.5 Idle CPU Gate on the SAME live kap-server + live Chromium page
 * after active work settles:
 *   1. Stops ONLY the test harness's in-page rAF flight recorder (`window.__KIKI_STOP_FLIGHT__()`).
 *   2. Waits `settleSec` (30s in full/CCP).
 *   3. Samples consecutive `windowSec` windows measuring disjoint:
 *      - server+helpers Core% (<= 2.0%)
 *      - Chromium `--type=renderer` + `--type=gpu-process` Core% (<= 3.0%)
 *      - real OS surviving workload descendants (=== 0, never hardcoded)
 */
export async function runScenarioS14IdleCpu({
  serverPid,
  browserHandle = null,
  trackedWorkloadPids = [],
  t0LastTerminalReceiptAt = null,
  tier = 'smoke',
  settleSec,
  windowCount,
  windowSec,
  progress = () => {},
}) {
  const isFull = tier === 'full';
  const t0Ts = typeof t0LastTerminalReceiptAt === 'number' && t0LastTerminalReceiptAt > 0
    ? t0LastTerminalReceiptAt
    : Date.now();
  const effectiveSettleSec = settleSec ?? (isFull ? 30 : 25);
  const effectiveWindowCount = Math.max(
    isFull ? FROZEN_V23_THRESHOLDS.s14.minWindowsFull : FROZEN_V23_THRESHOLDS.s14.minWindowsSmoke,
    windowCount ?? (isFull ? 12 : 3),
  );
  const effectiveWindowSec = windowSec ?? (isFull ? 10 : 10);

  let recorderRafDisabled = false;
  let browserPid = null;
  if (browserHandle) {
    if (typeof browserHandle.stopFlightRecorder === 'function') {
      recorderRafDisabled = await browserHandle.stopFlightRecorder().catch(() => false);
    }
    browserPid = browserHandle.browserPid ?? null;
  } else if (!isFull) {
    // No browser attached in headless-only smoke run: no rAF loop exists
    recorderRafDisabled = true;
  }

  const browserEnabled = Boolean(browserHandle && browserPid);
  const headlessNoBrowser = !browserEnabled;

  progress(
    `S14 Idle CPU Gate (${tier}): rAFDisabled=${recorderRafDisabled} settling ${effectiveSettleSec}s from T0, sampling ${effectiveWindowCount}x${effectiveWindowSec}s (serverPid=${serverPid}, browserPid=${browserPid ?? 'none'}, trackedPids=${trackedWorkloadPids.length})...`,
  );

  const alreadyElapsedMs = Math.max(0, Date.now() - t0Ts);
  const remainingSettleMs = Math.max(0, effectiveSettleSec * 1000 - alreadyElapsedMs);
  if (remainingSettleMs > 0) {
    await sleep(remainingSettleMs);
  }

  const windows = [];
  for (let i = 0; i < effectiveWindowCount; i += 1) {
    const sample = await sampleDisjointIdleWindow({
      serverPid,
      browserPid: browserEnabled ? browserPid : null,
      trackedWorkloadPids,
      windowMs: effectiveWindowSec * 1000,
    });
    windows.push({
      index: i + 1,
      elapsedSec: sample.elapsedSec,
      elapsedSinceT0Sec: Number(((Date.now() - t0Ts) / 1000).toFixed(2)),
      serverCorePct: sample.serverCorePct,
      processCount: sample.processCount,
      rendererPlusGpuCorePct: browserEnabled ? sample.rendererPlusGpuCorePct : undefined,
      rendererProcessCount: browserEnabled ? sample.rendererProcessCount : 0,
      survivingDescendants: sample.survivingDescendants,
      survivingDescendantDetails: sample.survivingDescendantDetails,
    });
  }

  const idleReport = {
    tier: isFull ? 'full' : 'smoke',
    t0LastTerminalReceiptAt: t0Ts,
    trackedWorkloadPidCount: trackedWorkloadPids.length,
    requiredWindowCount: effectiveWindowCount,
    windowSec: effectiveWindowSec,
    settleSec: effectiveSettleSec,
    recorderRafDisabled,
    browserEnabled,
    headlessNoBrowser,
    windows,
  };
  const verdict = evaluateIdleCpuGate(idleReport, isFull ? 'full' : 'smoke');
  const peakServer = Math.max(0, ...windows.map((w) => (typeof w.serverCorePct === 'number' ? w.serverCorePct : 0)));
  const peakRenderer = Math.max(
    0,
    ...windows.map((w) => (typeof w.rendererPlusGpuCorePct === 'number' ? w.rendererPlusGpuCorePct : 0)),
  );
  progress(
    `S14 Idle CPU Result: passed=${verdict.passed} peakServerCorePct=${peakServer}% peakRendererCorePct=${peakRenderer}% maxSurvivors=${Math.max(0, ...windows.map((w) => w.survivingDescendants))}`,
  );
  return {
    ...verdict,
    idleReport,
  };
}
