import { writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { join } from 'node:path';

import { ILogService, ISessionManager, ITelemetryService } from '@kiki/agent-core-v2';

import { startServer } from '../../src/start';

const home = process.env['PERF_HOME']!;
const out = process.env['PERF_OUT']!;
const profile = process.env['PERF_PROFILE'] === '1';

const toolPhases: { tool: string; phase: string; ms: number }[] = [];
const slowPhases: { tool: string; phase: string; ms: number }[] = [];
const toolCalls: { id: string; tool: string; ms: number; outcome: string }[] = [];
const gcPauses: number[] = [];

const server = await startServer({
  hostIdentity: { productName: 'perf-host', version: '0.0.0-perf', platform: 'perf' },
  host: '127.0.0.1',
  port: 0,
  homeDir: home,
  logLevel: 'warn',
  userSkillDir: join(home, 'skills'),
  userAgentProfileHomeDir: home,
  env: { ...process.env, KIKI_HOME: home, KIMI_CODE_HOME: home },
});

const log = server.core.accessor.get(ILogService) as unknown as { warn: (message: string, data?: Record<string, unknown>) => void };
const originalWarn = log.warn.bind(log);
log.warn = (message, data) => {
  if (message === 'slow tool phase' && data !== undefined) slowPhases.push({ tool: String(data['tool_name']), phase: String(data['phase']), ms: Number(data['duration_ms']) });
  originalWarn(message, data);
};
server.core.accessor.get(ITelemetryService).addAppender({
  track(event, properties) {
    if (event === 'tool_call' && properties !== undefined) toolCalls.push({ id: String(properties['tool_call_id']), tool: String(properties['tool_name']), ms: Number(properties['duration_ms']), outcome: String(properties['outcome']) });
  },
});

new PerformanceObserver((list) => { for (const entry of list.getEntries()) gcPauses.push(entry.duration); }).observe({ entryTypes: ['gc'] });

const histogram = monitorEventLoopDelay({ resolution: 10 });
const windows: { at: number; p50: number; p99: number; max: number; elu: number; rss: number; heap: number }[] = [];
let windowHistogram = monitorEventLoopDelay({ resolution: 10 });
let eluStart = performance.eventLoopUtilization();
let cpuStart = process.cpuUsage();
let threadCpuStart = process.threadCpuUsage();
let measuring = false;
let measureStartedAt = 0;
let windowTimer: ReturnType<typeof setInterval> | undefined;
const inspector = new Session();
const post = (method: string, params?: object) => new Promise<any>((resolve, reject) => inspector.post(method, params, (error, value) => error ? reject(error) : resolve(value)));

async function begin(): Promise<void> {
  toolPhases.length = 0; slowPhases.length = 0; toolCalls.length = 0; gcPauses.length = 0; windows.length = 0;
  histogram.reset(); histogram.enable();
  windowHistogram.enable();
  eluStart = performance.eventLoopUtilization();
  cpuStart = process.cpuUsage();
  threadCpuStart = process.threadCpuUsage();
  measureStartedAt = performance.now();
  measuring = true;
  windowTimer = setInterval(() => {
    const elu = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    windows.push({ at: performance.now() - measureStartedAt, p50: windowHistogram.percentile(50) / 1e6, p99: windowHistogram.percentile(99) / 1e6, max: windowHistogram.max / 1e6, elu: performance.eventLoopUtilization(elu, windowStartElu).utilization, rss: memory.rss, heap: memory.heapUsed });
    windowStartElu = elu;
    windowHistogram.reset();
  }, 1000);
  let windowStartElu = eluStart;
  if (profile) {
    inspector.connect();
    const maps: { url: string; map: string }[] = [];
    inspector.on('Debugger.scriptParsed', (message) => {
      const script = message.params as { url: string; sourceMapURL?: string };
      if (script.url.includes('/packages/') && !script.url.includes('node_modules') && script.sourceMapURL) maps.push({ url: script.url, map: script.sourceMapURL });
    });
    await post('Debugger.enable');
    await post('Debugger.disable');
    await writeFile(join(out, 'source-maps.json'), JSON.stringify(maps));
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
  }
}

async function end(): Promise<unknown> {
  measuring = false;
  if (windowTimer !== undefined) clearInterval(windowTimer);
  histogram.disable(); windowHistogram.disable();
  const elapsedMs = performance.now() - measureStartedAt;
  const cpu = process.cpuUsage(cpuStart);
  const threadCpu = process.threadCpuUsage(threadCpuStart);
  const elu = performance.eventLoopUtilization(performance.eventLoopUtilization(), eluStart);
  if (profile) {
    const { profile: cpuProfile } = await post('Profiler.stop');
    await writeFile(join(out, 'server.cpuprofile'), JSON.stringify(cpuProfile));
    inspector.disconnect();
  }
  const memory = process.memoryUsage();
  return {
    elapsedMs,
    cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
    mainThreadCpuMs: { user: threadCpu.user / 1000, system: threadCpu.system / 1000 },
    eventLoopUtilization: elu.utilization,
    eventLoop: { count: histogram.count, p50: histogram.percentile(50) / 1e6, p90: histogram.percentile(90) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 },
    memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external },
    residency: server.core.accessor.get(ISessionManager).residencyReport?.(),
    windows, toolPhases, slowPhases, toolCalls, gcPauses,
  };
}

void measuring;
process.on('message', (message: { type: string }) => {
  if (message.type === 'begin') void begin().then(() => process.send!({ type: 'begun' }));
  if (message.type === 'end') void end().then((stats) => process.send!({ type: 'stats', stats }));
  if (message.type === 'memory') process.send!({ type: 'memory', memory: process.memoryUsage() });
  if (message.type === 'close') void server.close().then(() => process.exit(0));
});
process.send!({ type: 'ready', port: server.port, token: server.localOwnerToken });
