import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createKlient } from '@kiki/klient/http';
import { expect, it, vi } from 'vitest';

type TaskFrame = { taskId: string; agentId?: string; status: string; startedAt: number; model?: string; thinkingEffort?: string; result?: string };
type Frame = { type: string; phase?: string; elapsedMs?: number; port?: number; token?: string; pid?: number; count?: number; requestCount?: number; live?: boolean; message?: string; childId?: string;
  prompt?: { phase: string; terminal?: { turnId?: number; state: string; result?: { type: string; steps: number } } }; history?: unknown[];
  tasks?: TaskFrame[]; task?: TaskFrame };

async function waitForFrame(child: ChildProcess, frames: readonly Frame[], type: string): Promise<Frame> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remove = () => {};
  try {
    return await new Promise<Frame>((resolve, reject) => {
      const phases = ['imports', 'server.start'];
      let nextPhase = 0;
      const arm = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => { reject(new Error(`Fixture IPC stalled waiting for ${type} (phase: ${phases[nextPhase - 1] ?? 'launch'})`)); }, 30_000);
      };
      const message = (frame: Frame) => {
        if (frame.type === 'error') { reject(new Error(frame.message)); return; }
        if (type === 'ready' && frame.type === 'phase' && frame.phase === phases[nextPhase]) { nextPhase++; arm(); }
        if (frame.type === type && (type !== 'ready' || nextPhase === phases.length)) resolve(frame);
      };
      const exit = () => { reject(new Error(`Fixture exited ${child.exitCode} / ${child.signalCode} before ${type}`)); };
      const error = (reason: Error) => { reject(reason); };
      child.on('message', message);
      child.once('exit', exit);
      child.once('error', error);
      remove = () => { child.off('message', message); child.off('exit', exit); child.off('error', error); };
      arm();
      for (const frame of frames) message(frame);
      if (child.exitCode !== null || child.signalCode !== null) exit();
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    remove();
  }
}

async function retireFixtureChild(child: ChildProcess): Promise<string> {
  if (child.pid === undefined) return 'not-started';
  if (child.exitCode !== null || child.signalCode !== null) return 'already-exited';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remove = () => {};
  try {
    return await new Promise<string>((resolve) => {
      let settled = false;
      const finish = (status: string) => { if (!settled) { settled = true; resolve(status); } };
      const exit = () => { finish('exited'); };
      const onError = (error: Error) => { finish(`cleanup-error:${error.message}`); };
      child.once('exit', exit); child.once('error', onError);
      remove = () => { child.off('exit', exit); child.off('error', onError); };
      timer = setTimeout(() => { finish(`cleanup-pending:pid=${child.pid}`); }, 2000);
      try { if (!child.kill()) finish(`signal-not-delivered:pid=${child.pid}`); }
      catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
    });
  } finally { if (timer !== undefined) clearTimeout(timer); remove(); }
}

async function readyFixtureChild(child: ChildProcess, wait: () => Promise<Frame>): Promise<Frame> {
  try {
    const ready = await wait();
    expect(ready.pid).toBe(child.pid);
    return ready;
  } catch (error) {
    const cleanup = await retireFixtureChild(child);
    if (error instanceof Error) { error.message += `\nFixture cleanup: ${cleanup}`; throw error; }
    throw new Error(`Fixture boot failed; cleanup: ${cleanup}`, { cause: error });
  }
}

it('keeps ordered boot progress separate from the thirty-second per-phase stall bound', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const child = new ChildProcess();
  const frames: Frame[] = [];
  child.on('message', frame => frames.push(frame as Frame));
  const waiting = waitForFrame(child, frames, 'ready');
  const outcome = waiting.then(value => value, error => error as unknown);
  try {
    child.emit('message', { type: 'phase', phase: 'imports' });
    await vi.advanceTimersByTimeAsync(20_000);
    child.emit('message', { type: 'phase', phase: 'server.start' });
    await vi.advanceTimersByTimeAsync(20_000);
    child.emit('message', { type: 'ready', pid: 123 });
    expect(await outcome).toMatchObject({ type: 'ready', pid: 123 });
  } finally { vi.useRealTimers(); }
});

it.each([0, 1, 2])('keeps the thirty-second stall bound at boot stage %i despite unrelated frames', async (stage) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const child = new ChildProcess();
  const waiting = waitForFrame(child, [], 'ready');
  const outcome = waiting.then(value => value, error => error as unknown);
  try {
    if (stage > 0) child.emit('message', { type: 'phase', phase: 'imports' });
    if (stage > 1) child.emit('message', { type: 'phase', phase: 'server.start' });
    await vi.advanceTimersByTimeAsync(20_000);
    child.emit('message', { type: 'phase', phase: stage === 1 ? 'imports' : 'server.start' });
    child.emit('message', { type: 'model' });
    child.emit('message', { type: 'heartbeat' });
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`ready (phase: ${['launch', 'imports', 'server.start'][stage]})`);
    expect(child.listenerCount('message')).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('keeps ordinary frame waits at thirty seconds and propagates exits and spawn errors', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const child = new ChildProcess();
    const waiting = waitForFrame(child, [], 'model').catch(error => error as unknown);
    await vi.advanceTimersByTimeAsync(20_000);
    child.emit('message', { type: 'phase', phase: 'imports' });
    child.emit('message', { type: 'phase', phase: 'server.start' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await waiting as Error).message).toContain('waiting for model');
    const exited = waitForFrame(child, [], 'prepared').catch(error => error as unknown);
    child.emit('exit', 1, null);
    expect((await exited as Error).message).toContain('before prepared');
    const reason = new Error('spawn failed');
    const failed = waitForFrame(child, [], 'closed').catch(error => error as unknown);
    child.emit('error', reason);
    expect(await failed).toBe(reason);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('bounds owned child retirement without hiding unstarted, exited or unconfirmed processes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    expect(await retireFixtureChild(child)).toBe('not-started');
    expect(kill).not.toHaveBeenCalled();
    Object.defineProperty(child, 'pid', { value: 123, configurable: true });
    Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
    expect(await retireFixtureChild(child)).toBe('already-exited');
    expect(kill).not.toHaveBeenCalled();
    Object.defineProperty(child, 'exitCode', { value: null, configurable: true });
    const pending = retireFixtureChild(child);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe('cleanup-pending:pid=123');
    kill.mockImplementationOnce(() => { child.emit('exit', 0, null); return true; });
    expect(await retireFixtureChild(child)).toBe('exited');
    kill.mockReturnValueOnce(false);
    expect(await retireFixtureChild(child)).toBe('signal-not-delivered:pid=123');
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  } finally { kill.mockRestore(); vi.useRealTimers(); }
});

it('preserves the boot error and retires only its spawned child when readiness or PID validation fails', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const reason = new Error('spawn failed without an exit');
    await expect(readyFixtureChild(child, () => Promise.reject(reason))).rejects.toBe(reason);
    expect(reason.message).toContain('not-started');
    expect(kill).not.toHaveBeenCalled();
    Object.defineProperty(child, 'pid', { value: 123, configurable: true });
    const pending = readyFixtureChild(child, () => Promise.resolve({ type: 'ready', pid: 456 })).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).message).toContain('Fixture cleanup: cleanup-pending:pid=123');
    expect(kill).toHaveBeenCalledOnce();
    kill.mockImplementationOnce(() => { throw new Error('kill failed'); });
    const failure = new Error('ready failed');
    await expect(readyFixtureChild(child, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(failure.message).toContain('cleanup-error:kill failed');
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  } finally { kill.mockRestore(); vi.useRealTimers(); }
});

async function boot(home: string, first: boolean) {
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import',
    new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/execution-pause-bootstrap.mjs', import.meta.url)), home, first ? 'first' : 'restart'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, KIKI_HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const frames: Frame[] = [];
  let output = '';
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  child.stdout?.on('data', data => { output += String(data); });
  child.stderr?.on('data', data => { output += String(data); });
  child.on('message', message => frames.push({ ...message as Frame, elapsedMs: Date.now() - started }));
  const detail = (type: string) => JSON.stringify({ expected: type, first, pid: child.pid,
    elapsedMs: Date.now() - started, exitCode: child.exitCode, signalCode: child.signalCode, connected: child.connected,
    frames: frames.map(({ type, phase, elapsedMs }) => ({ type, phase, elapsedMs })), output });
  const wait = async (type: string): Promise<Frame> => {
    try {
      if (spawnError !== undefined) throw spawnError;
      return await waitForFrame(child, frames, type);
    } catch (error) { throw new Error(`Fixture IPC wait failed: ${detail(type)}`, { cause: error }); }
  };
  const ready = await readyFixtureChild(child, () => wait('ready'));
  process.stdout.write(`${JSON.stringify({ executionPauseBoot: { first, pid: child.pid, frames: frames.map(({ type, phase, elapsedMs }) => ({ type, phase, elapsedMs })) } })}\n`);
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
  const controller = new AbortController();
  const exited = once(server.child, 'exit', { signal: controller.signal });
  void exited.catch(() => undefined);
  const timer = setTimeout(() => { controller.abort(new Error('Fixture did not exit after close')); }, 30_000);
  try {
    server.child.send({ type: 'close' });
    await server.wait('closed');
    const [code, signal] = await exited;
    expect({ code, signal }, server.output()).toEqual({ code: 0, signal: null });
  } finally { clearTimeout(timer); controller.abort(); }
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

it.each(['background', 'TaskWait', 'AgentRun'] as const)('retains a native child task identity through restart and delivers its completion once (%s)', async (mode) => {
  const observer = mode !== 'background';
  const home = await mkdtemp(join(tmpdir(), 'kiki-execution-pause-child-'));
  await writeFile(join(home, 'config.toml'), 'default_model = "stub"\n[search]\nenabled = false\n[cron]\nmanualTick = true\n');
  let first: Awaited<ReturnType<typeof boot>> | undefined;
  let second: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    first = await boot(home, true);
    const session = await first.request<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { permission_mode: 'manual' } });
    first.child.send({ type: mode === 'AgentRun' ? 'foreground' : 'child', sessionId: session.id });
    const started = await first.wait(mode === 'AgentRun' ? 'waiting' : 'child-started');
    const { taskId, startedAt } = started.tasks![0]!;
    const childId = mode === 'AgentRun' ? started.childId! : 'paused-child';
    expect(startedAt).toBeGreaterThan(0);
    await first.wait('model');
    if (observer) {
      if (mode === 'TaskWait') {
        first.child.send({ type: 'observe', sessionId: session.id });
        await first.wait('waiting');
      }
      const execution = first.client.session(session.id).execution;
      await execution.pause({ operationId: 'pause-withdrawn' });
      expect(await execution.cancelPause({ operationId: 'cancel-withdrawn', pauseOperationId: 'pause-withdrawn' })).toMatchObject({ phase: 'running' });
      expect(await execution.cancelPause({ operationId: 'cancel-withdrawn', pauseOperationId: 'pause-withdrawn' })).toMatchObject({ phase: 'running' });
      expect(first.frames.filter(frame => frame.type === 'model')).toHaveLength(2);
    }
    await first.client.session(session.id).execution.pause({ operationId: 'pause-child' });
    first.child.send({ type: 'release' });
    await vi.waitFor(async () => expect(await first!.client.session(session.id).execution.read()).toMatchObject({ phase: 'paused',
      agents: expect.arrayContaining([expect.objectContaining({ agentId: childId, resumable: true }),
        ...(observer ? [expect.objectContaining({ agentId: 'main', resumable: true })] : [])]) }));
    const lifecycle = await first.request<{ server_id: string; work_pending: string[] }>('/api/desktop-lifecycle');
    expect(lifecycle.work_pending).toEqual([]);
    await first.request('/api/desktop-lifecycle', { action: 'prepare-update', server_id: lifecycle.server_id, consent: true, interrupt_work: false });
    await expect(first.client.session(session.id).execution.resume({ operationId: 'blocked-by-prepare', pauseOperationId: 'pause-child' })).rejects.toThrow();
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
      second!.child.send({ type: 'inspect', sessionId: session.id, sequence: ++sequence, taskId });
      const snapshot = await second!.wait(`inspect-${sequence}`);
      expect(snapshot.task).toMatchObject({ taskId, agentId: childId, status: 'completed', startedAt, model: 'stub', thinkingEffort: 'high' });
      const notifications = snapshot.history!.filter(message => (message as { origin?: { taskId?: string } }).origin?.taskId === taskId);
      if (observer) {
        const receipts = snapshot.history!.filter(message => (message as { role?: string; toolCallId?: string }).role === 'tool' &&
          (message as { toolCallId?: string }).toolCallId === 'observer-call');
        expect(receipts).toHaveLength(1);
        expect(JSON.stringify(receipts[0])).toContain('completed');
        if (mode === 'AgentRun') expect(JSON.stringify(receipts[0])).toContain(taskId);
        expect(snapshot.prompt).toMatchObject({ phase: 'terminal', terminal: { state: 'completed' } });
        expect(notifications).toHaveLength(0);
      } else expect(notifications).toHaveLength(1);
      expect(second!.frames.filter(frame => frame.type === 'model')).toHaveLength(2);
    }, { timeout: 10_000 });
    expect(events).toContain('running');
    subscription.dispose();
    expect(first.frames.filter(frame => frame.type === 'model')).toHaveLength(observer ? 2 : 1);
    expect(second.frames.filter(frame => frame.type === 'model')).toHaveLength(2);
    await cleanExit(second);
    process.stdout.write(`${JSON.stringify({ executionPauseChildProof: { sessionId: session.id, taskId, childId, mode,
      firstPid: first.ready.pid, secondPid: second.ready.pid, requestCounts: [observer ? 2 : 1, 2] } })}\n`);
  } finally {
    await first?.client.close(); await second?.client.close();
    for (const server of [first, second]) if (server !== undefined && server.child.exitCode === null) server.child.kill();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 90_000);
