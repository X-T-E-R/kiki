import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const r = (value) => Math.round(value);
const d = (x) => x === undefined ? '-' : `${r(x.p50)}/${r(x.p99)}/${r(x.max)} (n=${String(x.n)})`;
for (const runDir of process.argv.slice(2)) {
  const s = JSON.parse(readFileSync(join(runDir, 'out', 'summary.json'), 'utf8'));
  const el = s.server.eventLoop;
  const cpu = s.server.cpuMs;
  const lines = [
    `## ${s.label} N=${String(s.sessions)} clients=${String(s.clients)} window=${String(r(s.durationMs / 1000))}s`,
    `event loop p50/p99/max: ${r(el.p50)}/${r(el.p99)}/${r(el.max)} ms; ELU ${(s.server.eventLoopUtilization * 100).toFixed(1)}%; CPU ${(cpu.user / 1000).toFixed(1)}+${(cpu.system / 1000).toFixed(1)} s (${((cpu.user + cpu.system) / s.durationMs).toFixed(2)} cores)`,
    ...(s.server.mainThreadCpuMs ? [`main thread CPU ${((s.server.mainThreadCpuMs.user + s.server.mainThreadCpuMs.system) / 1000).toFixed(1)} s (${((s.server.mainThreadCpuMs.user + s.server.mainThreadCpuMs.system) / s.durationMs).toFixed(2)} cores)`] : []),
    `rss ${r(s.server.rssStart / 2 ** 20)}→${r(s.server.memoryEnd.rss / 2 ** 20)} MiB; heap ${r(s.server.heapStart / 2 ** 20)}→${r(s.server.memoryEnd.heapUsed / 2 ** 20)} MiB; GC total ${r(s.server.gcTotalMs)} ms, pause p99/max ${d(s.server.gcPauseMs)}`,
    `stub requests ${String(s.stub.requestsInWindow)} (${(s.stub.requestsInWindow / (s.durationMs / 1000)).toFixed(1)}/s), max concurrent ${String(s.stub.maxConcurrentRequests)}`,
    `step gap p50/p99/max ${d(s.stepGapMs)}; kiki overhead ${d(s.stepOverheadMs)}; subagent gap ${d(s.subagentStepGapMs)}`,
    `turns ${String(s.turns.completed)}/${String(s.turns.total)}, duration ${d(s.turns.durationMs)}`,
    `tools: ${Object.entries(s.toolCallMs).map(([k, v]) => `${k} ${r(v.p50)}/${r(v.p99)}`).join(', ')}`,
    `slow tool phases ≥1s: ${String(s.slowToolPhases.count)} ${JSON.stringify(Object.fromEntries(Object.entries(s.slowToolPhases.byPhase).map(([k, v]) => [k, `${String(v.n)}×p50 ${r(v.p50)}`])))}`,
    `ws ${String(s.ws.frames)} frames (${r(s.ws.framesPerSec)}/s), ${r(s.ws.bytes / 2 ** 20)} MiB`,
    'http p50/p99/max:',
    ...Object.entries(s.http).map(([k, v]) => `  ${k}: ${r(v.p50)}/${r(v.p99)}/${r(v.max)} n=${String(v.n)} err=${String(v.errors)}${v.firstError ? ` ${v.firstError.slice(0, 120)}` : ''}`),
    `errors ${String(s.errorCount)} ${s.errors.slice(0, 2).map((e) => e.error.slice(0, 160)).join(' | ')}`,
  ];
  console.log(lines.join('\n'));
}
