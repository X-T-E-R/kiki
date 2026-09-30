import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { SqliteSearchHost } from '../src/search/sqlite/host';
import type { SqliteSessionInput } from '../src/search/sqlite/index';

const [mode, source, output, duration = '86400', interval = '10'] = process.argv.slice(2);
if (!['harness', 'desktop'].includes(mode ?? '') || !source || !output) {
  throw new Error('usage: search-s5-soak.mts harness <sessions-snapshot> <output-dir> [seconds=86400] [sample-seconds=10]\n       search-s5-soak.mts desktop <backend-pid> <output-dir> [seconds=86400] [sample-seconds=10] (KIKI_S5_URL + KIKI_S5_TOKEN env)');
}
const seconds = Number(duration), sampleSeconds = Number(interval);
if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(sampleSeconds) || sampleSeconds <= 0) throw new Error('invalid duration');
const out = resolve(output);
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
const run = promisify(execFile);
async function osRss(pid: number): Promise<number> {
  if (process.platform !== 'win32') throw new Error('desktop OS RSS sampler currently requires Windows');
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], { windowsHide: true, timeout: 5000 });
  const rss = Number(stdout.trim());
  if (!Number.isFinite(rss) || rss <= 0) throw new Error('invalid OS RSS');
  return rss;
}
const samples: Array<{ seconds: number; mainRss: number; indexerRss?: number; walBytes?: number }> = [];
let wholeRunMainPeak = 0, wholeRunIndexerPeak = 0, wholeRunWalPeak = 0;
function metrics(field: 'mainRss' | 'indexerRss') {
  const points = samples.filter((s) => s[field] !== undefined);
  if (points.length < 2) return { samples: points.length, slopeMiBPerHour: null };
  const meanX = points.reduce((n, s) => n + s.seconds, 0) / points.length;
  const meanY = points.reduce((n, s) => n + s[field]!, 0) / points.length;
  const slope = points.reduce((n, s) => n + (s.seconds - meanX) * (s[field]! - meanY), 0) /
    points.reduce((n, s) => n + (s.seconds - meanX) ** 2, 0);
  const values = points.map((s) => s[field]!).toSorted((a, b) => a - b);
  return { samples: points.length, peakMiB: values.at(-1)! / 1048576,
    p95MiB: values.at(Math.ceil(values.length * 0.95) - 1)! / 1048576, slopeMiBPerHour: slope * 3600 / 1048576 };
}
let host: SqliteSearchHost | undefined;
let baselineRss = 0;
let coldBuildSeconds: number | undefined;
let queryErrors = 0, memoryBudgetSamples = 0, sampleErrors = 0;
const latencies: number[] = [];
const began = Date.now();
const database = join(out, 'index.sqlite');
try {
  if (mode === 'harness') {
    const sessions: SqliteSessionInput[] = [];
    for (const workspace of await readdir(source, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      for (const entry of await readdir(join(source, workspace.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(source, workspace.name, entry.name);
        sessions.push({ id: entry.name, workspaceId: workspace.name, dir, updatedAt: Math.floor((await stat(dir)).mtimeMs) });
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    baselineRss = process.memoryUsage().rss;
    host = new SqliteSearchHost({ database });
    await host.open();
    host.sync(sessions);
  } else {
    if (!process.env['KIKI_S5_URL']) throw new Error('KIKI_S5_URL must point to a loopback debug-enabled backend');
    const url = new URL(process.env['KIKI_S5_URL']);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('loopback URL required');
    baselineRss = await osRss(Number(source));
  }
  let next = Date.now();
  while ((Date.now() - began) / 1000 < seconds) {
    try {
      let snapshot;
      let mainRss;
      if (host) {
        snapshot = host.snapshot();
        mainRss = process.memoryUsage().rss;
        if (snapshot.state === 'ready' && coldBuildSeconds === undefined) coldBuildSeconds = (Date.now() - began) / 1000;
        const queryStart = performance.now();
        try { await host.search({ query: 'session', mode: 'terms', op: 'AND', sort: 'score', pageSize: 20 }); }
        catch { queryErrors++; }
        latencies.push(performance.now() - queryStart);
      } else {
        const response = await fetch(new URL('/api/debug/globalSearch/status', process.env['KIKI_S5_URL']), {
          headers: { Authorization: `Bearer ${process.env['KIKI_S5_TOKEN'] ?? ''}` }, signal: AbortSignal.timeout(10_000),
        });
        const body = await response.json() as { code: number; data: { indexer?: ReturnType<SqliteSearchHost['snapshot']> } };
        if (!response.ok || body.code !== 0 || !body.data.indexer) throw new Error('debug status unavailable');
        snapshot = body.data.indexer;
        mainRss = await osRss(Number(source));
      }
      const indexerRss = snapshot.indexerPid ? await osRss(snapshot.indexerPid) : undefined;
      if (snapshot.reason === 'memory_budget') memoryBudgetSamples++;
      const sample = { seconds: (Date.now() - began) / 1000, mainRss, indexerRss, walBytes: snapshot.indexerStatus?.walBytes };
      wholeRunMainPeak = Math.max(wholeRunMainPeak, mainRss);
      wholeRunIndexerPeak = Math.max(wholeRunIndexerPeak, indexerRss ?? 0);
      wholeRunWalPeak = Math.max(wholeRunWalPeak, sample.walBytes ?? 0, snapshot.indexerStatus?.peakWalBytes ?? 0);
      if (mode === 'desktop' || coldBuildSeconds !== undefined) samples.push(sample);
      await appendFile(join(out, 'samples.jsonl'), JSON.stringify({ ...sample, snapshot }) + '\n');
    } catch (error) {
      sampleErrors++;
      await appendFile(join(out, 'samples.jsonl'), JSON.stringify({ seconds: (Date.now() - began) / 1000, error: error instanceof Error ? error.message : String(error) }) + '\n');
    }
    next += sampleSeconds * 1000;
    await delay(Math.max(0, Math.min(next - Date.now(), seconds * 1000 - (Date.now() - began))));
  }
} finally {
  const final = host?.snapshot();
  await host?.close();
  let quickCheck: unknown;
  if (host) {
    const db = new DatabaseSync(database, { readOnly: true });
    quickCheck = db.prepare('PRAGMA quick_check').get();
    db.close();
  }
  latencies.sort((a, b) => a - b);
  const report = { mode, platform: process.platform, node: process.version, actualSeconds: (Date.now() - began) / 1000,
    requestedSeconds: seconds, sampleSeconds, baselineMiB: baselineRss / 1048576, coldBuildSeconds,
    slopeWindow: mode === 'harness' ? 'post-ready only' : 'entire observation (start after cold build)',
    main: metrics('mainRss'), indexer: metrics('indexerRss'), peakWalBytes: wholeRunWalPeak,
    wholeRunMainPeakMiB: wholeRunMainPeak / 1048576, wholeRunIndexerPeakMiB: wholeRunIndexerPeak / 1048576,
    queryCount: latencies.length, queryP95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1], queryErrors,
    memoryBudgetSamples, sampleErrors, final, quickCheck,
    warmObservationSeconds: host && coldBuildSeconds === undefined ? 0 : (Date.now() - began) / 1000 - (coldBuildSeconds ?? 0),
    full24h: seconds >= 86400 && (host ? coldBuildSeconds !== undefined && seconds - coldBuildSeconds >= 86400 : true) && (Date.now() - began) >= 86400_000 };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
