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

function listAllProcessesWithCmdlineChecked() {
  if (process.platform === 'linux') {
    const rows = [];
    let entries = [];
    try {
      entries = fs.readdirSync('/proc');
    } catch (error) {
      return { ok: false, rows: [], error: String(error?.message ?? error) };
    }
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      const st = readLinuxProcStat(pid);
      if (!st) continue;
      let cmdline = '';
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/gu, ' ').trim();
      } catch {}
      rows.push({ pid, ppid: st.ppid, name: '', cmdline });
    }
    return { ok: true, rows, error: null };
  }

  if (process.platform === 'win32') {
    try {
      const ps = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();
      if (!out) return { ok: false, rows: [], error: 'Win32_Process returned empty output' };
      const parsed = JSON.parse(out);
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((r) => ({
        pid: Number(r.ProcessId),
        ppid: Number(r.ParentProcessId),
        name: String(r.Name ?? ''),
        cmdline: String(r.CommandLine ?? ''),
      }));
      return { ok: true, rows, error: null };
    } catch (error) {
      return { ok: false, rows: [], error: String(error?.message ?? error) };
    }
  }
  return { ok: false, rows: [], error: `Unsupported platform ${process.platform}` };
}

function listAllProcessesWithCmdline() {
  return listAllProcessesWithCmdlineChecked().rows;
}

export function listDescendantProcesses(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const rows = listAllProcessesWithCmdline();
  const byParent = new Map();
  for (const r of rows) {
    const arr = byParent.get(r.ppid) ?? [];
    arr.push(r);
    byParent.set(r.ppid, arr);
  }
  const descendants = [];
  const queue = [...(byParent.get(rootPid) ?? [])];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    descendants.push(cur);
    for (const next of byParent.get(cur.pid) ?? []) queue.push(next);
  }
  return descendants;
}

export function listDescendantPids(rootPid) {
  return listDescendantProcesses(rootPid).map((p) => p.pid);
}

export function findChildBrowserRootPid(parentPid = process.pid) {
  const descendants = listDescendantProcesses(parentPid);
  // Find the top-level Chromium browser process (no --type= flag) spawned under parentPid
  const browserMain = descendants.find((p) => {
    const cmd = p.cmdline.toLowerCase();
    return (
      (cmd.includes('chrom') || cmd.includes('headless_shell')) &&
      !cmd.includes('--type=')
    );
  });
  return browserMain?.pid ?? null;
}

export function listChromiumRendererAndGpuPids(browserRootPid) {
  if (!Number.isInteger(browserRootPid) || browserRootPid <= 0) return [];
  const descendants = listDescendantProcesses(browserRootPid);
  return descendants
    .filter((p) => /--type=(?:renderer|gpu-process)\b/u.test(p.cmdline))
    .map((p) => p.pid);
}

export function isKnownInternalKikiHelper(cmdline) {
  const cmd = String(cmdline ?? '').toLowerCase();
  if (cmd.includes('__search-indexer') || cmd.includes('sqlite-indexer') || cmd.includes('esbuild')) {
    return true;
  }
  // Source/dev mode SQLite search indexer child spawned by SqliteSearchHost (packages/kap-server/src/search/sqlite/host.ts)
  if (/packages[/\\]kap-server[/\\]src[/\\]search[/\\]sqlite[/\\]indexerdev\.ts\b/u.test(cmd)) {
    return true;
  }
  return false;
}

export function listSurvivingWorkloadDescendantsChecked(serverRootPid) {
  if (!Number.isInteger(serverRootPid) || serverRootPid <= 0) {
    return { ok: false, survivors: [], error: 'Invalid serverRootPid' };
  }
  const scan = listAllProcessesWithCmdlineChecked();
  if (!scan.ok) {
    return { ok: false, survivors: [], error: scan.error };
  }
  const byParent = new Map();
  for (const r of scan.rows) {
    const arr = byParent.get(r.ppid) ?? [];
    arr.push(r);
    byParent.set(r.ppid, arr);
  }
  const descendants = [];
  const queue = [...(byParent.get(serverRootPid) ?? [])];
  const seen = new Set([serverRootPid]);
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    descendants.push(cur);
    for (const next of byParent.get(cur.pid) ?? []) queue.push(next);
  }
  const internalPids = new Set([serverRootPid]);
  for (const p of descendants) {
    if (isKnownInternalKikiHelper(p.cmdline)) internalPids.add(p.pid);
  }
  const survivors = descendants.filter((p) => {
    if (internalPids.has(p.pid)) return false;
    if (process.platform === 'win32') {
      const nameLower = String(p.name ?? '').toLowerCase();
      const cmdLower = String(p.cmdline ?? '').toLowerCase();
      if (
        internalPids.has(p.ppid) &&
        (nameLower === 'conhost.exe' || /\\system32\\conhost\.exe\b/u.test(cmdLower))
      ) {
        return false;
      }
      if (cmdLower === '' && (nameLower === 'conhost.exe' || nameLower === 'openconsole.exe')) {
        return false;
      }
    }
    return true;
  });
  return { ok: true, survivors, error: null };
}

export function listSurvivingWorkloadDescendants(serverRootPid) {
  return listSurvivingWorkloadDescendantsChecked(serverRootPid).survivors;
}

export function sampleProcessHandleCount(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      return fs.readdirSync(`/proc/${pid}/fd`).length;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    try {
      const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").HandleCount`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 6_000,
      }).trim();
      const n = Number.parseInt(out, 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }
  return null;
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
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { totalCorePct: null, processCount: 0, elapsedSec: 0 };
  }
  const pidsBefore = [rootPid, ...listDescendantPids(rootPid)];
  const prev = samplePidCpuTicks(pidsBefore);
  const t0 = performance.now();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const elapsedSec = Math.max(0.05, (performance.now() - t0) / 1000);
  const pidsAfter = [...new Set([rootPid, ...listDescendantPids(rootPid), ...pidsBefore])];
  const next = samplePidCpuTicks(pidsAfter);
  if (prev.size === 0 || next.size === 0) {
    return { totalCorePct: null, processCount: 0, elapsedSec: Number(elapsedSec.toFixed(2)) };
  }
  return {
    totalCorePct: computeCorePctDelta(prev, next, elapsedSec),
    processCount: next.size,
    elapsedSec: Number(elapsedSec.toFixed(2)),
  };
}

export async function sampleDisjointIdleWindow({
  serverPid,
  browserPid = null,
  trackedWorkloadPids = [],
  windowMs = 10_000,
}) {
  const serverPidsBefore = Number.isInteger(serverPid) && serverPid > 0
    ? [serverPid, ...listDescendantPids(serverPid)]
    : [];
  const browserPidsBefore = Number.isInteger(browserPid) && browserPid > 0
    ? listChromiumRendererAndGpuPids(browserPid)
    : [];
  const prevServer = serverPidsBefore.length > 0 ? samplePidCpuTicks(serverPidsBefore) : new Map();
  const prevBrowser = browserPidsBefore.length > 0 ? samplePidCpuTicks(browserPidsBefore) : new Map();
  const t0 = performance.now();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const elapsedSec = Math.max(0.05, (performance.now() - t0) / 1000);

  const serverDescendantsAfter = Number.isInteger(serverPid) && serverPid > 0
    ? listDescendantProcesses(serverPid)
    : [];
  const serverCmdlineByPid = new Map(serverDescendantsAfter.map((p) => [p.pid, p.cmdline]));
  const serverPidsAfter = Number.isInteger(serverPid) && serverPid > 0
    ? [...new Set([serverPid, ...serverDescendantsAfter.map((p) => p.pid), ...serverPidsBefore])]
    : [];
  const browserPidsAfter = Number.isInteger(browserPid) && browserPid > 0
    ? [...new Set([...listChromiumRendererAndGpuPids(browserPid), ...browserPidsBefore])]
    : [];
  const nextServer = serverPidsAfter.length > 0 ? samplePidCpuTicks(serverPidsAfter) : new Map();
  const nextBrowser = browserPidsAfter.length > 0 ? samplePidCpuTicks(browserPidsAfter) : new Map();
  const serverProcessCpuDetails = [];
  for (const [pid, next] of nextServer.entries()) {
    const prev = prevServer.get(pid);
    if (!prev) continue;
    if (prev.startTime && next.startTime && prev.startTime !== next.startTime) continue;
    const deltaTicks = Math.max(0, next.ticks - prev.ticks);
    const corePct = Number((((deltaTicks / (next.hz || 100)) / elapsedSec) * 100).toFixed(2));
    const cmdline = pid === serverPid ? 'kap-server-root' : (serverCmdlineByPid.get(pid) ?? '');
    serverProcessCpuDetails.push({
      pid,
      isRoot: pid === serverPid,
      internalHelper: pid !== serverPid && isKnownInternalKikiHelper(cmdline),
      corePct,
      cmdline: cmdline.slice(0, 240),
    });
  }
  const survivingWorkload = serverDescendantsAfter.filter((p) => !isKnownInternalKikiHelper(p.cmdline));
  const seenSurvivorPids = new Set(survivingWorkload.map((p) => p.pid));
  for (const pid of trackedWorkloadPids ?? []) {
    if (!Number.isInteger(pid) || pid <= 0 || seenSurvivorPids.has(pid)) continue;
    try {
      process.kill(pid, 0);
      seenSurvivorPids.add(pid);
      survivingWorkload.push({ pid, ppid: 1, cmdline: 'reparented-tracked-workload' });
    } catch {}
  }

  return {
    elapsedSec: Number(elapsedSec.toFixed(2)),
    serverCorePct: prevServer.size > 0 && nextServer.size > 0
      ? computeCorePctDelta(prevServer, nextServer, elapsedSec)
      : null,
    processCount: nextServer.size,
    serverProcessCpuDetails,
    rendererPlusGpuCorePct: browserPid !== null && browserPid !== undefined
      ? (prevBrowser.size > 0 && nextBrowser.size > 0
          ? computeCorePctDelta(prevBrowser, nextBrowser, elapsedSec)
          : null)
      : null,
    rendererProcessCount: nextBrowser.size,
    survivingDescendants: survivingWorkload.length,
    survivingDescendantDetails: survivingWorkload.map((p) => ({ pid: p.pid, cmdline: p.cmdline.slice(0, 512) })),
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
      if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
    }
  };
  timer = setTimeout(() => { void tick(); }, intervalMs);

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
