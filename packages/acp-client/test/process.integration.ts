import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AcpClientErrorCode,
  AcpProcessClient,
  parseExecutorSessionRefEnvelope,
  type AcpTurnHandle,
  type HostProcessLike,
  type HostProcessOptionsLike,
  type HostProcessServiceLike,
  type NormalizedExecutorEvent,
} from '../src';
import { NodeHostProcessService } from './fixtures/node-process-service';

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-fake-agent.mjs', import.meta.url));
const cwd = process.cwd();
const clients: AcpProcessClient[] = [];

function createClient(
  scenario: string,
  options: {
    readonly startupTimeoutMs?: number;
    readonly cancelGraceMs?: number;
    readonly shutdownGraceMs?: number;
    readonly permissionOptionId?: string;
  } = {},
): { readonly client: AcpProcessClient; readonly processService: NodeHostProcessService } {
  const processService = new NodeHostProcessService();
  const client = new AcpProcessClient(
    processService,
    {
      id: 'test-acp',
      command: process.execPath,
      args: [FIXTURE, scenario],
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      cancelGraceMs: options.cancelGraceMs ?? 50,
      shutdownGraceMs: options.shutdownGraceMs ?? 50,
      stderrMaxBytes: 4_096,
    },
    {
      permissionHandler: async (_request, context) => ({
        outcome: 'selected',
        optionId: options.permissionOptionId ?? context.options[0]?.optionId,
      }),
    },
  );
  clients.push(client);
  return { client, processService };
}

class ForceEscalationProcessService implements HostProcessServiceLike {
  readonly base = new NodeHostProcessService();
  readonly taskkillArgs: string[][] = [];

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptionsLike = {},
  ): Promise<HostProcessLike> {
    if (command.toLowerCase() === 'taskkill') {
      this.taskkillArgs.push([...args]);
      if (!args.includes('/F')) {
        return this.base.spawn(process.execPath, ['-e', ''], options);
      }
    }
    return this.base.spawn(command, args, options);
  }
}

function priorSessionRef() {
  return parseExecutorSessionRefEnvelope({
    executorId: 'test-acp',
    version: 1,
    ref: { sessionId: 'fake-session-1' },
  });
}

async function collect(
  handle: AcpTurnHandle<NormalizedExecutorEvent>,
): Promise<NormalizedExecutorEvent[]> {
  const events: NormalizedExecutorEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown().catch(() => undefined)));
});

describe('ACP process state machine', () => {
  it('runs the spawnable full-flow matrix with stderr separated from stdout', async () => {
    const { client } = createClient('full-flow');
    const controller = new AbortController();
    const handle = await client.startTurn({
      prompt: 'go',
      signal: controller.signal,
      session: {
        cwd,
        configOptions: [
          { configId: 'model', value: 'model-b' },
          { configId: 'thought', value: 'high' },
        ],
      },
    });
    const eventsPromise = collect(handle);
    const result = await handle.completion;
    const events = await eventsPromise;

    expect(result.response.stopReason).toBe('end_turn');
    expect(result.session.mode).toBe('new');
    expect(client.status()).toMatchObject({ state: 'ready', sessionId: 'fake-session-1' });
    expect(events.map((event) => event.type)).toEqual([
      'message.delta',
      'thought.delta',
      'tool.call',
      'tool.update',
      'tool.update',
      'plan.update',
      'usage',
      'unknown',
    ]);
    expect(result.stderrTail).toContain('PERMISSION=');
    expect(events.some((event) => JSON.stringify(event).includes('PERMISSION='))).toBe(false);
  });

  it('times out initialize within the configured startup deadline', async () => {
    const { client, processService } = createClient('hang-initialize', {
      startupTimeoutMs: 100,
    });
    await expect(client.openSession({ cwd })).rejects.toMatchObject({
      code: AcpClientErrorCode.StartupTimeout,
    });
    expect(processService.spawns.filter((spawn) => spawn.command === process.execPath)).toHaveLength(1);
    expect(client.status().state).toBe('broken');
  });

  it('times out a host spawn that never resolves', async () => {
    const processService: HostProcessServiceLike = {
      spawn: () => new Promise<HostProcessLike>(() => {}),
    };
    const client = new AcpProcessClient(processService, {
      id: 'spawn-timeout',
      command: 'never-spawns',
      startupTimeoutMs: 30,
    });
    clients.push(client);
    await expect(client.openSession({ cwd })).rejects.toMatchObject({
      code: AcpClientErrorCode.StartupTimeout,
    });
  });

  it('rebuilds once when the process crashes before a prompt is sent', async () => {
    const { client, processService } = createClient('crash-before-prompt');
    await expect(client.openSession({ cwd })).rejects.toMatchObject({
      code: AcpClientErrorCode.SessionOpenFailed,
    });
    expect(processService.spawns.filter((spawn) => spawn.command === process.execPath)).toHaveLength(2);
  });

  it('uses resume, falls back resume → load, and quarantines load replay updates', async () => {
    const resumed = createClient('default').client;
    const resumeResult = await resumed.openSession({ cwd, sessionRef: priorSessionRef() });
    expect(resumeResult.mode).toBe('resume');

    const loaded = createClient('load-replay').client;
    const loadResult = await loaded.openSession({ cwd, sessionRef: priorSessionRef() });
    expect(loadResult.mode).toBe('load');
    expect(loadResult.loadReplayObserved).toBe(true);
    expect(loadResult.quarantinedUpdateCount).toBe(1);

    const controller = new AbortController();
    const handle = await loaded.startTurn({
      prompt: 'live',
      signal: controller.signal,
      session: { cwd, sessionRef: priorSessionRef() },
    });
    const eventsPromise = collect(handle);
    await handle.completion;
    const events = await eventsPromise;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('historical replay');
  });

  it('falls back resume → load → new for method-not-found', async () => {
    const { client } = createClient('resume-load-method-not-found');
    const result = await client.openSession({ cwd, sessionRef: priorSessionRef() });
    expect(result.mode).toBe('new');
  });

  it('marks idle exit cold and lazily respawns on the next explicit run', async () => {
    const { client, processService } = createClient('idle-exit');
    await client.openSession({ cwd });
    await waitFor(() => client.status().state === 'cold', 4_000);
    await expect(client.openSession({ cwd })).resolves.toMatchObject({ mode: 'new' });
    expect(processService.spawns.filter((spawn) => spawn.command === process.execPath)).toHaveLength(2);
  });

  it('fails an active crash as executor.disconnected and never replays the prompt', async () => {
    const { client, processService } = createClient('crash-after-prompt');
    const controller = new AbortController();
    const handle = await client.startTurn({
      prompt: 'do not replay',
      signal: controller.signal,
      session: { cwd },
    });
    await expect(handle.completion).rejects.toMatchObject({
      code: AcpClientErrorCode.Disconnected,
    });
    expect(processService.spawns.filter((spawn) => spawn.command === process.execPath)).toHaveLength(1);
    expect(client.status().state).toBe('broken');
  });

  it('closes the connection and fails the active turn on malformed NDJSON', async () => {
    const { client } = createClient('malformed-ndjson');
    const controller = new AbortController();
    const handle = await client.startTurn({
      prompt: 'malformed',
      signal: controller.signal,
      session: { cwd },
    });
    await expect(handle.completion).rejects.toMatchObject({
      code: AcpClientErrorCode.ProtocolError,
    });
    expect(client.status().state).toBe('broken');
  });

  it('sends session/cancel plus request cancellation and keeps a cooperative agent ready', async () => {
    const { client } = createClient('hang-prompt', { cancelGraceMs: 200 });
    const controller = new AbortController();
    const handle = await client.startTurn({
      prompt: 'cancel me',
      signal: controller.signal,
      session: { cwd },
    });
    controller.abort(new Error('stop'));
    await expect(handle.completion).resolves.toMatchObject({
      response: { stopReason: 'cancelled' },
    });
    expect(client.status().state).toBe('ready');
  });

  it('escalates uncooperative cancellation through TERM and KILL', async () => {
    const { client } = createClient('hang-cancel', {
      cancelGraceMs: 20,
      shutdownGraceMs: 20,
    });
    const controller = new AbortController();
    const handle = await client.startTurn({
      prompt: 'hang',
      signal: controller.signal,
      session: { cwd },
    });
    controller.abort(new Error('stop'));
    await expect(handle.completion).rejects.toMatchObject({
      code: AcpClientErrorCode.Disconnected,
    });
    expect(client.status().state).toBe('broken');
  });

  it('returns cancelled when the permission handler selects an unknown option', async () => {
    const { client } = createClient('full-flow', { permissionOptionId: 'unknown' });
    const controller = new AbortController();
    const handle = await client.startTurn({
      prompt: 'permission',
      signal: controller.signal,
      session: { cwd },
    });
    const result = await handle.completion;
    expect(result.stderrTail).toContain('"outcome":"cancelled"');
  });

  it('kills the real Windows process tree after TERM and KILL escalation', async () => {
    if (process.platform !== 'win32') return;
    const processService = new ForceEscalationProcessService();
    const client = new AcpProcessClient(processService, {
      id: 'test-acp',
      command: process.execPath,
      args: [FIXTURE, 'spawn-grandchild'],
      startupTimeoutMs: 2_000,
      cancelGraceMs: 20,
      shutdownGraceMs: 20,
    });
    clients.push(client);
    const controller = new AbortController();
    const handle = await client.startTurn({
      prompt: 'spawn child',
      signal: controller.signal,
      session: { cwd },
    });
    await waitFor(() => /GRANDCHILD_PID=\d+/.test(client.stderrTail()));
    const pid = Number(/GRANDCHILD_PID=(\d+)/.exec(client.stderrTail())?.[1]);
    controller.abort(new Error('stop tree'));
    await expect(handle.completion).rejects.toMatchObject({
      code: AcpClientErrorCode.Disconnected,
    });
    await waitFor(() => client.status().pid === undefined, 5_000);
    expect(processService.taskkillArgs).toHaveLength(2);
    expect(processService.taskkillArgs[0]).not.toContain('/F');
    expect(processService.taskkillArgs[1]).toContain('/F');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const listed = await execFileAsync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH']);
    expect(listed.stdout).not.toContain(`"${String(pid)}"`);
  }, 10_000);
});
