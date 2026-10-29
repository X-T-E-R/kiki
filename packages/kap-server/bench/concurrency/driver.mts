import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import type { Klient } from '@kiki/klient';
import { createKlient } from '@kiki/klient/http';

const { values: args } = parseArgs({
  options: {
    sessions: { type: 'string', default: '10' },
    clients: { type: 'string', default: '3' },
    duration: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '15' },
    ttft: { type: 'string', default: '400' },
    tps: { type: 'string', default: '120' },
    steps: { type: 'string', default: '6' },
    'subagent-every': { type: 'string', default: '3' },
    root: { type: 'string' },
    label: { type: 'string', default: 'run' },
    'no-profile': { type: 'boolean', default: false },
    search: { type: 'boolean', default: false },
  },
});

const N = Number(args.sessions);
const C = Number(args.clients);
const durationMs = Number(args.duration) * 1000;
const warmupMs = Number(args.warmup) * 1000;
const repoRoot = resolve(import.meta.dirname, '../../../..');
const runDir = resolve(args.root ?? join(repoRoot, '.tmp/perf-concurrency'), `${args.label}-n${N}`);
const home = join(runDir, 'home');
const out = join(runDir, 'out');
const workspaceCount = Math.max(1, Math.min(N, 10));
const workspaces = Array.from({ length: workspaceCount }, (_, i) => join(runDir, 'ws', `w${i}`));
const here = import.meta.dirname;
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group === undefined) groups.set(name, [item]);
    else group.push(item);
  }
  return groups;
}
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const META_READ_INTERVAL_MS = 250;
const now = () => performance.timeOrigin + performance.now();

async function prepare(): Promise<void> {
  await rm(runDir, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [index, root] of workspaces.entries()) {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'notes'), { recursive: true });
    for (let m = 0; m < 20; m += 1) {
      const body = Array.from({ length: 120 }, (_, line) => line % 10 === 0 ? `export function f${m}_${line}(value: number) { return value + ${line}; }` : `const value${line} = ${line * m}; // workspace ${index}`).join('\n');
      await writeFile(join(root, 'src', `module${m}.ts`), body);
    }
  }
  for (let s = 0; s < N; s += 1) await writeFile(join(workspaces[s % workspaceCount]!, 'notes', `S${s}.md`), 'state value-0\n');
}

function waitMessage<T>(child: ChildProcess, type: string): Promise<T> {
  return new Promise((done, fail) => {
    const onMessage = (message: { type: string }) => { if (message.type === type) { child.off('message', onMessage); done(message as T); } };
    child.on('message', onMessage);
    child.once('exit', (code) => fail(new Error(`child exited ${String(code)} before ${type}`)));
  });
}

function configToml(port: number): string {
  return [
    'default_model = "stub"',
    'default_permission_mode = "yolo"',
    '',
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${String(port)}"`,
    'api_key = "stub"',
    '',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 1000000',
    'capabilities = ["thinking"]',
    'support_efforts = ["low", "high"]',
    'default_effort = "high"',
    '',
    '[search]',
    `enabled = ${args.search ? 'true' : 'false'}`,
    '',
    '[cron]',
    'manualTick = true',
    '',
    '[subagent]',
    'default_model = "stub"',
    '',
  ].join('\n');
}

type Sample = { route: string; ms: number; ok: boolean; error?: string; at: number };
const samples: Sample[] = [];
const turns: { session: string; ms: number; state: string; at: number }[] = [];
const errors: { where: string; error: string; at: number }[] = [];
const ws = { frames: 0, bytes: 0, maxGapMs: 0, byType: new Map<string, number>(), lagMs: [] as number[] };
let stopping = false;

async function timed<T>(route: string, run: () => Promise<T>): Promise<T | undefined> {
  const started = now();
  try {
    const value = await run();
    samples.push({ route, ms: now() - started, ok: true, at: started });
    return value;
  } catch (error) {
    samples.push({ route, ms: now() - started, ok: false, error: String(error).slice(0, 300), at: started });
    return undefined;
  }
}

function makeClient(port: number, token: string, onFrame?: (bytes: number, type: string) => void): Klient {
  const NativeWebSocket = globalThis.WebSocket;
  class CountingWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : '';
        let type = 'binary';
        const match = /"type":"([^"]+)"/.exec(data.slice(0, 200));
        if (match) type = match[1]!;
        onFrame?.(data.length, type);
      });
    }
  }
  return createKlient({ endpoint: `http://127.0.0.1:${String(port)}`, token, WebSocket: CountingWebSocket as typeof WebSocket, timeoutMs: 120_000, validate: false });
}

async function runSession(klient: Klient, index: number, deadline: number): Promise<void> {
  const tag = `S${String(index)}`;
  let turn = 0;
  while (!stopping && now() < deadline) {
    turn += 1;
    const started = now();
    try {
      const result = await klient.session(sessionIds[index]!).agent('main').prompt(
        { input: [{ type: 'text', text: `[perf ${tag}] Turn ${String(turn)}: inspect the workspace, update notes and report.` }] },
        { waitFor: 'terminal' },
      );
      turns.push({ session: tag, ms: now() - started, state: result.state, at: started });
      if (result.state !== 'completed') {
        errors.push({ where: `turn ${tag}`, error: JSON.stringify(result).slice(0, 400), at: now() });
        await delay(1000);
      }
    } catch (error) {
      errors.push({ where: `turn ${tag}`, error: String(error).slice(0, 400), at: now() });
      await delay(1000);
    }
  }
}

const sessionIds: string[] = [];

async function guiClient(port: number, token: string, clientIndex: number, deadline: number): Promise<void> {
  const viewed = new Set<string>();
  const klient = makeClient(port, token, (bytes, type) => {
    ws.frames += 1; ws.bytes += bytes; ws.byType.set(type, (ws.byType.get(type) ?? 0) + 1);
  });
  const metaInFlight = new Set<string>();
  const metaDirty = new Set<string>();
  const metaLastStart = new Map<string, number>();
  const metaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const metaRead = (sessionId: string) => {
    metaInFlight.add(sessionId);
    metaDirty.delete(sessionId);
    metaLastStart.set(sessionId, now());
    void timed('GET session (meta event)', () => klient.session(sessionId).commands.read()).finally(() => {
      metaInFlight.delete(sessionId);
      if (!stopping && metaDirty.has(sessionId)) metaSchedule(sessionId);
    });
  };
  const metaSchedule = (sessionId: string) => {
    if (metaInFlight.has(sessionId) || metaTimers.has(sessionId)) return;
    const wait = (metaLastStart.get(sessionId) ?? -Infinity) + META_READ_INTERVAL_MS - now();
    if (wait <= 0) {
      metaRead(sessionId);
      return;
    }
    metaTimers.set(sessionId, setTimeout(() => {
      metaTimers.delete(sessionId);
      if (!stopping && metaDirty.has(sessionId)) metaRead(sessionId);
    }, wait));
  };
  klient.events.on('session.metaUpdated', (event: { sessionId: string }) => {
    metaDirty.add(event.sessionId);
    metaSchedule(event.sessionId);
  });
  const focus = sessionIds.filter((_, i) => i % C === clientIndex).slice(0, 3);
  const subscriptions: { close(): void }[] = [];
  for (const sessionId of focus) {
    viewed.add(sessionId);
    const opened = now();
    await new Promise<void>((done) => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; samples.push({ route: 'WS view ready', ms: now() - opened, ok: true, at: opened }); done(); } };
      const view = klient.session(sessionId).view;
      const handle = view.bootstrap!({ transcriptGrades: { '*': 'off', main: 'delta' } }, (signal) => { if (signal.type === 'ready') finish(); });
      subscriptions.push(handle);
      setTimeout(() => { if (!finished) { finished = true; samples.push({ route: 'WS view ready', ms: now() - opened, ok: false, error: 'timeout', at: opened }); done(); } }, 30_000);
    });
    await timed('GET transcript page', () => klient.session(sessionId).view.transcript.page({ agentId: 'main', pageSize: 20 }));
  }
  let tick = 0;
  while (!stopping && now() < deadline) {
    tick += 1;
    const focused = focus[tick % Math.max(1, focus.length)];
    const work: Promise<unknown>[] = [];
    if (tick % 15 === 0) work.push(timed('GET sessions list', () => klient.rest!.sessions.list({ page_size: 50 })));
    if (focused !== undefined) {
      if (tick % 15 === 5) work.push(timed('GET session', () => klient.session(focused).commands.read()));
      if (tick % 15 === 3) work.push(timed('agent panel metrics', () => klient.global.agentPanel.read({ session_id: focused, agent_id: 'main', metrics_only: true })));
      if (tick % 10 === 7) work.push(timed('GET prompts (activity)', () => klient.rest!.sessions.listPrompts(focused)));
      if (tick % 10 === 8) work.push(timed('GET tasks (activity)', () => klient.rest!.sessions.listTasks(focused, { status: 'running' })));
      if (tick % 20 === 11) {
        work.push(timed('GET transcript older page', async () => {
          const first = await klient.session(focused).view.transcript.page({ agentId: 'main', pageSize: 20 });
          const oldest = first.items.find((item) => item.kind === 'turn') as { turnId?: string } | undefined;
          if (oldest?.turnId === undefined) return first;
          return klient.session(focused).view.transcript.page({ agentId: 'main', beforeTurn: oldest.turnId, pageSize: 20 });
        }));
      }
      if (tick % 30 === 17) work.push(timed('GET view snapshot', () => klient.session(focused).view.snapshot()));
    }
    await Promise.all(work);
    await delay(1000);
  }
  for (const handle of subscriptions) handle.close();
  await klient.close();
}

function lagProbe(deadline: number): Promise<void> {
  return (async () => {
    while (!stopping && now() < deadline) {
      const started = now();
      await delay(100);
      ws.lagMs.push(now() - started - 100);
    }
  })();
}

const pct = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};
const dist = (values: number[]) => ({ n: values.length, p50: pct(values, 0.5), p90: pct(values, 0.9), p99: pct(values, 0.99), max: values.length === 0 ? 0 : Math.max(...values) });

type StubRecord = { session?: string; sub?: string; turn?: number; step?: number; requestAt: number; firstByteAt?: number; responseAt: number; tools?: { id: string; name: string }[]; error?: string };

async function main(): Promise<void> {
  await prepare();
  const stub = fork(join(here, 'stub.mjs'), [], {
    env: { ...process.env, PERF_STUB_CONFIG: JSON.stringify({ workspaces, ttftMs: Number(args.ttft), tokensPerSec: Number(args.tps), stepsPerTurn: Number(args.steps), subagentEvery: Number(args['subagent-every']) }) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const stubReady = await waitMessage<{ port: number }>(stub, 'ready');
  await writeFile(join(home, 'config.toml'), configToml(stubReady.port));
  const repo = repoRoot;
  const helper = join(repo, 'packages/agent-core-v2/dist/windows-process-helper.exe');
  const server = fork(join(here, 'server.mts'), [], {
    cwd: resolve(here, '../..'),
    execArgv: ['--max-old-space-size=8192', '--import', 'tsx', '--import', pathToFileURL(join(repo, 'build/register-raw-text-loader.mjs')).href],
    env: { ...process.env, PERF_HOME: home, PERF_OUT: out, PERF_PROFILE: args['no-profile'] ? '0' : '1', KIKI_HOME: home, KIMI_CODE_HOME: home, TSX_TSCONFIG_PATH: join(repo, 'apps/kimi-code/tsconfig.dev.json'), KIKI_WINDOWS_PROCESS_HELPER: existsSync(helper) ? helper : process.env['KIKI_WINDOWS_PROCESS_HELPER'] },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const ready = await waitMessage<{ port: number; token: string }>(server, 'ready');
  console.log(`server ready on ${String(ready.port)}; creating ${String(N)} sessions`);
  const admin = makeClient(ready.port, ready.token);
  for (let s = 0; s < N; s += 1) {
    const session = await admin.rest!.sessions.create({ title: `perf S${String(s)}`, metadata: { cwd: workspaces[s % workspaceCount]! } as never });
    sessionIds.push(session.id);
  }
  const runStart = now();
  const deadline = runStart + warmupMs + durationMs;
  const workers = sessionIds.map((_, index) => runSession(makeClient(ready.port, ready.token), index, deadline));
  const guis = Array.from({ length: C }, (_, index) => guiClient(ready.port, ready.token, index, deadline));
  await delay(warmupMs);
  const measureStart = now();
  samples.length = 0; turns.length = 0; ws.frames = 0; ws.bytes = 0; ws.byType.clear(); ws.lagMs.length = 0;
  const errorBase = errors.length;
  const rssStart = (await (async () => { server.send({ type: 'memory' }); return (await waitMessage<{ memory: NodeJS.MemoryUsage }>(server, 'memory')).memory; })());
  server.send({ type: 'begin' });
  await waitMessage(server, 'begun');
  const lag = lagProbe(deadline);
  await delay(Math.max(0, deadline - now()));
  server.send({ type: 'end' });
  const { stats } = await waitMessage<{ stats: Record<string, unknown> }>(server, 'stats');
  const measureEnd = now();
  stopping = true;
  stub.send({ type: 'stop-tools' });
  await Promise.race([Promise.all([...workers, ...guis, lag]), delay(90_000)]);
  stub.send({ type: 'collect' });
  const collected = await waitMessage<{ records: StubRecord[]; maxActive: number; clock: number }>(stub, 'records');
  const abs = (t: number) => collected.clock + t;
  const inWindow = collected.records.filter((r) => abs(r.requestAt) >= measureStart && abs(r.requestAt) <= measureEnd);
  const byAgent = new Map<string, StubRecord[]>();
  for (const record of collected.records) {
    if (record.session === undefined) continue;
    const key = `${record.session}/${record.sub ?? 'main'}`;
    byAgent.set(key, [...(byAgent.get(key) ?? []), record]);
  }
  const gaps: number[] = [];
  const subagentGaps: number[] = [];
  const overheads: number[] = [];
  const overheadByKind = new Map<string, number[]>();
  const toolMsById = new Map((stats['toolCalls'] as { id: string; ms: number }[]).map((call) => [call.id, call.ms]));
  for (const records of byAgent.values()) {
    records.sort((a, b) => a.requestAt - b.requestAt);
    for (let i = 1; i < records.length; i += 1) {
      const previous = records[i - 1]!; const current = records[i]!;
      if ((previous.tools?.length ?? 0) === 0 || previous.turn !== current.turn) continue;
      if (abs(current.requestAt) < measureStart || abs(current.requestAt) > measureEnd) continue;
      const gap = current.requestAt - previous.responseAt;
      if (previous.tools!.some((tool) => tool.name === 'AgentRun')) { subagentGaps.push(gap); continue; }
      gaps.push(gap);
      const toolMs = previous.tools!.map((tool) => toolMsById.get(tool.id));
      if (toolMs.every((ms) => ms !== undefined)) {
        const overhead = gap - Math.max(...(toolMs as number[]));
        overheads.push(overhead);
        const kind = previous.tools!.map((tool) => tool.name).join('+');
        overheadByKind.set(kind, [...(overheadByKind.get(kind) ?? []), overhead]);
      }
    }
  }
  const routes = new Map<string, Sample[]>();
  for (const sample of samples) routes.set(sample.route, [...(routes.get(sample.route) ?? []), sample]);
  const toolPhases = (stats['slowPhases'] as { tool: string; phase: string; ms: number }[]);
  const toolCalls = (stats['toolCalls'] as { tool: string; ms: number; outcome: string }[]);
  const byTool = new Map<string, number[]>();
  for (const call of toolCalls) byTool.set(call.tool, [...(byTool.get(call.tool) ?? []), call.ms]);
  const summary = {
    label: args.label, sessions: N, clients: C, durationMs: measureEnd - measureStart, warmupMs,
    stub: { ttftMs: Number(args.ttft), tokensPerSec: Number(args.tps), stepsPerTurn: Number(args.steps), requestsInWindow: inWindow.length, maxConcurrentRequests: collected.maxActive, errors: collected.records.filter((r) => r.error !== undefined).length },
    server: { eventLoop: stats['eventLoop'], mainThreadCpuMs: stats['mainThreadCpuMs'], eventLoopUtilization: stats['eventLoopUtilization'], cpuMs: stats['cpuMs'], memoryEnd: stats['memory'], rssStart: rssStart.rss, heapStart: rssStart.heapUsed, gcPauseMs: dist(stats['gcPauses'] as number[]), gcTotalMs: (stats['gcPauses'] as number[]).reduce((a, b) => a + b, 0) },
    stepGapMs: dist(gaps), stepOverheadMs: dist(overheads), stepOverheadByBatch: Object.fromEntries([...overheadByKind].map(([kind, values]) => [kind, dist(values)])), subagentStepGapMs: dist(subagentGaps),
    turns: { completed: turns.filter((t) => t.state === 'completed').length, total: turns.length, durationMs: dist(turns.map((t) => t.ms)) },
    toolCallMs: Object.fromEntries([...byTool].map(([tool, values]) => [tool, dist(values)])),
    toolOutcomes: Object.fromEntries([...groupBy(toolCalls, (c) => `${c.tool}:${c.outcome}`)].map(([key, values]) => [key, values.length])),
    subagentRequests: collected.records.filter((r) => r.sub !== undefined).length,
    slowToolPhases: { count: toolPhases.length, byPhase: Object.fromEntries([...groupBy(toolPhases, (p) => `${p.tool}:${p.phase}`)].map(([key, values]) => [key, dist(values.map((v) => v.ms))])) },
    http: Object.fromEntries([...routes].map(([route, values]) => [route, { ...dist(values.map((v) => v.ms)), errors: values.filter((v) => !v.ok).length, firstError: values.find((v) => !v.ok)?.error }])),
    ws: { frames: ws.frames, bytes: ws.bytes, framesPerSec: ws.frames / ((measureEnd - measureStart) / 1000), byType: Object.fromEntries(ws.byType) },
    driverLagMs: dist(ws.lagMs),
    errors: errors.slice(errorBase).slice(0, 50), errorCount: errors.length - errorBase,
    windows: stats['windows'],
  };
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  const { windows: _windows, ...brief } = summary;
  console.log(JSON.stringify({ ...brief, errors: summary.errors.slice(0, 3) }, null, 2));
  await admin.close();
  server.send({ type: 'close' });
  await Promise.race([new Promise((done) => server.once('exit', done)), delay(30_000)]);
  if (server.exitCode === null) server.kill();
  stub.send({ type: 'exit' });
  await Promise.race([new Promise((done) => stub.once('exit', done)), delay(5_000)]);
  if (stub.exitCode === null) stub.kill();
}

await main();
process.exit(0);
