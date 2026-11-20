import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Disjoint PID/TID CPU & process-tree telemetry sampler (Astra v2.3 §§5, 9.5, 10.5).
 *
 * Samples:
 * - Disjoint server + helpers vs renderer + GPU vs harness CPU% (`CorePct`, 100% = 1 full core).
 * - External 100ms HTTP heartbeat watchdog for event-loop stalls.
 * - `[T0+30s, T0+150s)` idle CPU windows with surviving descendant detection.
 */

function readLinuxProcStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/u);
    const utime = Number(fields[11] ?? 0);
    const stime = Number(fields[12] ?? 0);
    const startTime = Number(fields[19] ?? 0);
    const ppid = Number(fields[1] ?? 0);
    return { pid, ppid, ticks: utime + stime, startTime };
  } catch {
    return null;
  }
}

export function listDescendantPids(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  if (process.platform === 'linux') {
    const childrenByParent = new Map();
    let entries = [];
    try {
      entries = fs.readdirSync('/proc');
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      const st = readLinuxProcStat(pid);
      if (!st) continue;
      const list = childrenByParent.get(st.ppid) ?? [];
      list.push(pid);
      childrenByParent.set(st.ppid, list);
    }
    const descendants = [];
    const queue = [...(childrenByParent.get(rootPid) ?? [])];
    const seen = new Set([rootPid]);
    while (queue.length > 0) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      descendants.push(cur);
      for (const next of childrenByParent.get(cur) ?? []) queue.push(next);
    }
    return descendants;
  }

  if (process.platform === 'win32') {
    try {
      const ps = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 8_000,
      }).trim();
      if (!out) return [];
      const rows = JSON.parse(out);
      const list = Array.isArray(rows) ? rows : [rows];
      const byParent = new Map();
      for (const r of list) {
        const arr = byParent.get(r.ParentProcessId) ?? [];
        arr.push(r.ProcessId);
        byParent.set(r.ParentProcessId, arr);
      }
      const descendants = [];
      const queue = [...(byParent.get(rootPid) ?? [])];
      const seen = new Set([rootPid]);
      while (queue.length > 0) {
        const cur = queue.shift();
        if (seen.has(cur)) continue;
        seen.add(cur);
        descendants.push(cur);
        for (const next of byParent.get(cur) ?? []) queue.push(next);
      }
      return descendants;
    } catch {
      return [];
    }
  }
  return [];
}

export function samplePidCpuTicks(pids) {
  const out = new Map();
  if (process.platform === 'linux') {
    for (const pid of pids) {
      const st = readLinuxProcStat(pid);
      if (st) out.set(pid, { ticks: st.ticks, startTime: st.startTime, hz: 100 });
    }
    return out;
  }
  if (process.platform === 'win32' && pids.length > 0) {
    try {
      const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ');
      const ps = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,UserModeTime,KernelModeTime | ConvertTo-Json -Compress`;
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 8_000,
      }).trim();
      if (!raw) return out;
      const rows = JSON.parse(raw);
      for (const r of Array.isArray(rows) ? rows : [rows]) {
        const total100ns = Number(r.UserModeTime ?? 0) + Number(r.KernelModeTime ?? 0);
        out.set(r.ProcessId, { ticks: total100ns, startTime: 0, hz: 10_000_000 });
      }
    } catch {
      // ignore transient sampling error
    }
  }
  return out;
}

export function computeCorePctDelta(prevMap, nextMap, elapsedSec) {
  if (elapsedSec <= 0) return 0;
  let totalCpuSec = 0;
  for (const [pid, next] of nextMap.entries()) {
    const prev = prevMap.get(pid);
    if (!prev) continue;
    if (prev.startTime && next.startTime && prev.startTime !== next.startTime) continue;
    const deltaTicks = Math.max(0, next.ticks - prev.ticks);
    totalCpuSec += deltaTicks / (next.hz || 100);
  }
  return Number(((totalCpuSec / elapsedSec) * 100).toFixed(2));
}

export async function sampleProcessTreeCpu(rootPid, windowMs = 10_000) {
  const pidsBefore = [rootPid, ...listDescendantPids(rootPid)];
  const prev = samplePidCpuTicks(pidsBefore);
  const t0 = performance.now();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const elapsedSec = Math.max(0.05, (performance.now() - t0) / 1000);
  const pidsAfter = [...new Set([rootPid, ...listDescendantPids(rootPid), ...pidsBefore])];
  const next = samplePidCpuTicks(pidsAfter);
  return {
    totalCorePct: computeCorePctDelta(prev, next, elapsedSec),
    processCount: next.size,
    elapsedSec: Number(elapsedSec.toFixed(2)),
  };
}

/**
 * Starts an external 100ms HTTP heartbeat probe to detect real main-thread stalls
 * independently of in-process timers.
 */
export function startExternalHeartbeatWatchdog({ url, headers = {}, intervalMs = 100, timeoutMs = 2_000 }) {
  let stopped = false;
  const latenciesMs = [];
  let timeouts = 0;
  let maxLatencyMs = 0;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    const t0 = performance.now();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: ac.signal });
      await res.arrayBuffer().catch(() => undefined);
      const ms = Number((performance.now() - t0).toFixed(2));
      latenciesMs.push(ms);
      if (ms > maxLatencyMs) maxLatencyMs = ms;
    } catch {
      timeouts += 1;
      latenciesMs.push(timeoutMs);
      if (timeoutMs > maxLatencyMs) maxLatencyMs = timeoutMs;
    } finally {
      clearTimeout(t);
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const sorted = [...latenciesMs].sort((a, b) => a - b);
      const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
      return {
        samples: sorted.length,
        timeouts,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        p99Ms: pct(0.99),
        maxMs: maxLatencyMs,
      };
    },
  };
}
