import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createKlient } from '@kiki/klient/http';
import { expect, it, vi } from 'vitest';

type Frame = { type: string; port?: number; token?: string; pid?: number; count?: number; requestCount?: number; live?: boolean; message?: string;
  prompt?: { phase: string; terminal?: { turnId?: number; state: string; result?: { type: string; steps: number } } }; history?: unknown[]; tasks?: Array<{ taskId: string; status: string; startedAt: number; result?: string }> };

async function boot(home: string, first: boolean) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), '--import',
    new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/execution-pause-server.ts', import.meta.url)), home, first ? 'first' : 'restart'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, KIKI_HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const frames: Frame[] = [];
  let output = '';
  child.stdout?.on('data', data => { output += String(data); });
  child.stderr?.on('data', data => { output += String(data); });
  child.on('message', message => frames.push(message as Frame));
  const wait = async (type: string): Promise<Frame> => vi.waitFor(() => {
    const error = frames.find(frame => frame.type === 'error');
    if (error !== undefined) throw new Error(error.message);
    const frame = frames.find(frame => frame.type === type);
    if (child.exitCode !== null && frame === undefined) throw new Error(`Fixture exited ${child.exitCode}: ${output}`);
    expect(frame, output).toBeDefined();
    return frame!;
  }, { timeout: 30_000, interval: 25 });
  const ready = await wait('ready');
  const base = `http://127.0.0.1:${ready.port}`;
  const client = createKlient({ endpoint: base, token: ready.token });
  const request = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const envelope = await response.json() as { code: number; data: T };
    expect(envelope.code, JSON.stringify(envelope)).toBe(0);
    return envelope.data;
  };
  return { child, client, wait, frames, ready, request, output: () => output };
}

async function cleanExit(server: Awaited<ReturnType<typeof boot>>): Promise<void> {
  await server.client.close();
  const exited = once(server.child, 'exit');
  server.child.send({ type: 'close' });
  await server.wait('closed');
  const [code, signal] = await exited;
  expect({ code, signal }, server.output()).toEqual({ code: 0, signal: null });
}

it('holds an execution across clean process exit and resumes its saved turn explicitly over HTTP', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-execution-pause-'));
  await writeFile(join(home, 'config.toml'), 'default_model = "stub"\n[search]\nenabled = false\n[cron]\nmanualTick = true\n');
  const owned: ChildProcess[] = [];
  let first: Awaited<ReturnType<typeof boot>> | undefined;
  let second: Awaited<ReturnType<typeof boot>> | undefined;
  const timing = { started: Date.now(), paused: 0, firstExit: 0, restarted: 0, resumed: 0 };
  try {
    first = await boot(home, true);
    owned.push(first.child);
    const session = await first.request<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { permission_mode: 'manual' } });
    first.child.send({ type: 'prepare', sessionId: session.id });
    await first.wait('prepared');
    await first.request(`/api/sessions/${session.id}/prompts`, { prompt_id: 'checkpoint-prompt', content: [{ type: 'text', text: 'work once' }] });
    await first.wait('model');
    const execution = first.client.session(session.id).execution;
    expect(await execution.pause({ operationId: 'pause-once' })).toMatchObject({ phase: 'pausing' });
    first.child.send({ type: 'release' });
    await vi.waitFor(async () => expect(await execution.read()).toMatchObject({ phase: 'paused', agents: [{ agentId: 'main', resumable: true }] }), { timeout: 10_000 });
    const paused = await execution.read();
    const turnId = paused.agents[0]!.turnId;
    timing.paused = Date.now();
    expect(first.frames.filter(frame => frame.type === 'model')).toHaveLength(1);
    await cleanExit(first);
    timing.firstExit = Date.now();
    second = await boot(home, false);
    owned.push(second.child);
    timing.restarted = Date.now();
    expect(second.ready.pid).not.toBe(first.ready.pid);
    const listing = await second.request<{ items: Array<{ id: string; execution_phase?: string }> }>('/api/sessions');
    expect(listing.items.find(item => item.id === session.id)).toMatchObject({ execution_phase: 'paused' });
    second.child.send({ type: 'inventory', sessionId: session.id });
    expect(await second.wait('inventory')).toMatchObject({ live: false });
    const restored = second.client.session(session.id).execution;
    expect(await restored.read()).toMatchObject({ phase: 'paused', pauseOperationId: 'pause-once' });
    expect(second.frames.filter(frame => frame.type === 'model')).toHaveLength(0);
    await expect(restored.resume({ operationId: 'stale', pauseOperationId: 'other' })).rejects.toThrow();
    await restored.resume({ operationId: 'resume-once', pauseOperationId: 'pause-once' });
    await second.wait('model');
    let sequence = 0;
    await vi.waitFor(async () => {
      second!.child.send({ type: 'inspect', sessionId: session.id, sequence: ++sequence });
      const snapshot = await second!.wait(`inspect-${sequence}`);
      expect(snapshot.prompt).toMatchObject({ phase: 'terminal', terminal: { turnId, state: 'completed', result: { type: 'completed', steps: 2 } } });
      const history = JSON.stringify(snapshot.history);
      expect(history.match(/work once/g)).toHaveLength(1);
      expect(history.match(/saved first step/g)).toHaveLength(1);
      expect(history.match(/resumed second step/g)).toHaveLength(1);
    }, { timeout: 10_000 });
    timing.resumed = Date.now();
    expect(await restored.resume({ operationId: 'resume-once', pauseOperationId: 'pause-once' })).toMatchObject({ phase: 'running' });
    expect(second.frames.filter(frame => frame.type === 'model')).toHaveLength(1);
    await cleanExit(second);
    process.stdout.write(`${JSON.stringify({ executionPauseProof: { sessionId: session.id, turnId, firstPid: first.ready.pid, secondPid: second.ready.pid, requestCounts: [1, 1], timing } })}\n`);
  } finally {
    await first?.client.close();
    await second?.client.close();
    for (const child of owned) if (child.exitCode === null) child.kill();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 90_000);

it('retains a native child task identity through restart and delivers its completion once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-execution-pause-child-'));
  await writeFile(join(home, 'config.toml'), 'default_model = "stub"\n[search]\nenabled = false\n[cron]\nmanualTick = true\n');
  let first: Awaited<ReturnType<typeof boot>> | undefined;
  let second: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    first = await boot(home, true);
    const session = await first.request<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { permission_mode: 'manual' } });
    first.child.send({ type: 'child', sessionId: session.id });
    const startedAt = (await first.wait('child-started')).tasks![0]!.startedAt;
    expect(startedAt).toBeGreaterThan(0);
    await first.wait('model');
    await first.client.session(session.id).execution.pause({ operationId: 'pause-child' });
    first.child.send({ type: 'release' });
    await vi.waitFor(async () => expect(await first!.client.session(session.id).execution.read()).toMatchObject({ phase: 'paused',
      agents: expect.arrayContaining([expect.objectContaining({ agentId: 'paused-child', resumable: true })]) }));
    await cleanExit(first);
    second = await boot(home, false);
    const handle = second.client.session(session.id);
    const events: string[] = [];
    const subscription = handle.events.on('execution.changed', state => events.push(state.phase));
    await subscription.ready;
    expect(await handle.execution.read()).toMatchObject({ phase: 'paused' });
    second.child.send({ type: 'inventory', sessionId: session.id });
    expect(await second.wait('inventory')).toMatchObject({ live: false });
    await handle.execution.resume({ operationId: 'resume-child', pauseOperationId: 'pause-child' });
    let sequence = 0;
    await vi.waitFor(async () => {
      second!.child.send({ type: 'inspect', sessionId: session.id, sequence: ++sequence });
      const snapshot = await second!.wait(`inspect-${sequence}`);
      expect(snapshot.tasks).toMatchObject([{ taskId: 'agent-checkpoint-child', status: 'completed', startedAt }]);
      const receipts = snapshot.history!.filter(message => (message as { origin?: { kind?: string; taskId?: string } }).origin?.taskId === 'agent-checkpoint-child');
      expect(receipts).toHaveLength(1);
      expect(second!.frames.filter(frame => frame.type === 'model')).toHaveLength(2);
    }, { timeout: 10_000 });
    expect(events).toContain('running');
    subscription.dispose();
    expect(first.frames.filter(frame => frame.type === 'model')).toHaveLength(1);
    expect(second.frames.filter(frame => frame.type === 'model')).toHaveLength(2);
    await cleanExit(second);
    process.stdout.write(`${JSON.stringify({ executionPauseChildProof: { sessionId: session.id, taskId: 'agent-checkpoint-child',
      firstPid: first.ready.pid, secondPid: second.ready.pid, requestCounts: [1, 2] } })}\n`);
  } finally {
    await first?.client.close(); await second?.client.close();
    for (const server of [first, second]) if (server !== undefined && server.child.exitCode === null) server.child.kill();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 90_000);
