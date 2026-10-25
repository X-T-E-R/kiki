import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveGlobalLogPath } from '@kiki/node-sdk';
import { createInstanceRegistry } from '@kiki/kap-server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/commands';
import { ensureServer } from '../../src/kiki/serve';

vi.mock('node:sea', () => ({ isSea: () => mocks.sea }));

const mocks = vi.hoisted(() => ({
  sea: false,
  unref: vi.fn(),
  spawn: vi.fn(),
  sleep: vi.fn(async () => {}),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: mocks.spawn,
}));
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: mocks.sleep,
}));

let root: string | undefined;
let denied = false;
const children: Array<EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; unref: typeof mocks.unref }> = [];
const originalArgv = process.argv;
const originalExecArgv = process.execArgv;

function stop(child: typeof children[number]): void {
  child.exitCode = 137;
  child.emit('exit', 137, null);
}

beforeEach(() => {
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const child = children.find((entry) => entry.pid === Math.abs(pid));
    if (child === undefined) return kill(pid, signal);
    if (signal === 0 && child.exitCode === null) return true;
    if (denied) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    if (pid < 0) { stop(child); return true; }
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  mocks.spawn.mockImplementation((exe: string, args: string[]) => {
    if (exe === 'taskkill') {
      const killer = new EventEmitter();
      queueMicrotask(() => {
        if (!denied) stop(children.find((entry) => String(entry.pid) === args.at(-1))!);
        killer.emit('close', denied ? 1 : 0);
      });
      return killer;
    }
    const child = Object.assign(new EventEmitter(), { pid: 800_001 + children.length, exitCode: null as number | null, signalCode: null as string | null, unref: mocks.unref });
    children.push(child);
    return child;
  });
});

afterEach(async () => {
  process.argv = originalArgv;
  process.execArgv = originalExecArgv;
  mocks.sea = false;
  denied = false;
  children.length = 0;
  vi.clearAllMocks();
  mocks.sleep.mockImplementation(async () => {});
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const scratch = resolve(import.meta.dirname, '../../../../.tmp/serve-recovery');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, 'serve-test-'));
  return join(root, 'custom home');
}

function daemonSpawns() { return mocks.spawn.mock.calls.filter(([exe]) => exe === process.execPath); }

it('reports the requested home and stops its pre-ready tree before releasing the lease at the startup deadline', async () => {
  const homeDir = await home();
  vi.stubEnv('KIKI_HOME', join(root!, 'other-home'));
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.sleep.mockImplementation(async () => {
    expect(await readFile(join(homeDir, 'server', 'ensure.lock'), 'utf8')).toBe(String(children[0]!.pid));
    now += 60_000;
  });
  const fetch = vi.fn(() => { throw new Error('Unexpected network request'); });
  vi.stubGlobal('fetch', fetch);

  await expect(ensureServer({ homeDir })).rejects.toThrow([
    'Kiki server did not become ready before the startup deadline.',
    `See log: ${resolveGlobalLogPath(homeDir)}`,
    `Check daemon status: kiki doctor --home "${homeDir}"`,
    `Validate configuration: kiki doctor agents --home "${homeDir}"`,
  ].join('\n'));
  expect(daemonSpawns()).toHaveLength(1);
  expect(daemonSpawns()[0]?.[1]).toEqual(expect.arrayContaining(['serve', '--home', homeDir]));
  expect(children[0]!.exitCode).toBe(137);
  expect(mocks.unref).not.toHaveBeenCalled();
  expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(250, undefined, { signal: expect.any(AbortSignal) });
  expect(fetch).not.toHaveBeenCalled();
  expect(await readdir(join(homeDir, 'server'))).toEqual([]);
});

it.each([true, false])('routes owned startup to serve for SEA=%s without recursively ensuring', async (sea) => {
  const homeDir = await home();
  mocks.sea = sea;
  const script = join(root!, 'main.mjs');
  process.argv = [process.execPath, sea ? process.execPath : script];
  process.execArgv = ['--import', 'example-loader'];
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.sleep.mockImplementation(async () => { now += 60_000; });
  await expect(ensureServer({ homeDir, port: 0 })).rejects.toThrow('startup deadline');
  const args = daemonSpawns()[0]![1] as string[];
  expect(args).toEqual([
    ...(sea ? [] : ['--import', 'example-loader', script]),
    'serve', '--home', homeDir, '--idle-exit', '30m', '--json', '--port', '0',
  ]);
  expect(args).not.toContain('--ensure');
  const program = createProgram('test', () => { throw new Error('Unexpected main action'); }).exitOverride();
  const serve = program.commands.find((command) => command.name() === 'serve')!;
  const action = vi.fn();
  serve.action(action);
  await program.parseAsync([process.execPath, sea ? process.execPath : script, ...args.slice(sea ? 0 : 3)]);
  expect(action).toHaveBeenCalledOnce();
  expect(serve.opts()).toMatchObject({ home: homeDir, idleExit: '30m', json: true, port: 0 });
  expect(await readdir(join(homeDir, 'server'))).toEqual([]);
});

it('waits for a live unreachable registered instance to drain before spawning', async () => {
  const homeDir = await home();
  const registration = await createInstanceRegistry({ instancesDir: join(homeDir, 'server', 'instances') }).register({ pid: process.pid, host: '127.0.0.1', port: 1, startedAt: Date.now() });
  let now = 0;
  let released = false;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.sleep.mockImplementation(async () => {
    if (!released) {
      expect(daemonSpawns()).toHaveLength(0);
      await registration.release();
      released = true;
    } else { now = 60_000; }
  });
  try {
    await expect(ensureServer({ homeDir })).rejects.toThrow('startup deadline');
    expect(released).toBe(true);
    expect(daemonSpawns()).toHaveLength(1);
    expect(mocks.sleep).toHaveBeenCalledTimes(2);
  } finally { await registration.release(); }
});

it('never stops or duplicates an unreachable live registry peer', async () => {
  const homeDir = await home();
  const registration = await createInstanceRegistry({ instancesDir: join(homeDir, 'server', 'instances') }).register({ pid: process.pid, host: '127.0.0.1', port: 1, startedAt: Date.now() });
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.sleep.mockImplementation(async () => { now = 60_000; });
  try {
    await expect(ensureServer({ homeDir })).rejects.toThrow('no second service was started');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(250, undefined, { signal: expect.any(AbortSignal) });
    expect(await readdir(join(homeDir, 'server', 'instances'))).toEqual([`${registration.serverId}.json`]);
  } finally { await registration.release(); }
});

it('cancels and stops only its retained pre-registration child', async () => {
  const homeDir = await home();
  const controller = new AbortController();
  mocks.sleep.mockImplementation(async () => {
    expect(await readFile(join(homeDir, 'server', 'ensure.lock'), 'utf8')).toBe(String(children[0]!.pid));
    controller.abort(new Error('fixture cancellation'));
    throw controller.signal.reason;
  });
  await expect(ensureServer({ homeDir, signal: controller.signal })).rejects.toThrow('fixture cancellation');
  expect(daemonSpawns()).toHaveLength(1);
  expect(children[0]!.exitCode).toBe(137);
  expect(mocks.unref).not.toHaveBeenCalled();
  expect(await readdir(join(homeDir, 'server'))).toEqual([]);
});

it('retains the child PID lease rather than authorizing another launch when cleanup fails', async () => {
  const homeDir = await home();
  denied = true;
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.sleep.mockImplementation(async () => { now += 60_000; });
  await expect(ensureServer({ homeDir })).rejects.toThrow('PID lease was retained');
  expect(daemonSpawns()).toHaveLength(1);
  expect(await readFile(join(homeDir, 'server', 'ensure.lock'), 'utf8')).toBe(String(children[0]!.pid));
  await expect(ensureServer({ homeDir })).rejects.toThrow('lifecycle lock was not removed');
  expect(daemonSpawns()).toHaveLength(1);
});

it('protects a live child PID lease even with no instance record and allows cancellation without killing that peer', async () => {
  const homeDir = await home();
  await mkdir(join(homeDir, 'server'), { recursive: true });
  await writeFile(join(homeDir, 'server', 'ensure.lock'), String(process.pid));
  const controller = new AbortController();
  mocks.sleep.mockImplementation(async () => { controller.abort(new Error('stop waiting')); throw controller.signal.reason; });
  await expect(ensureServer({ homeDir, signal: controller.signal })).rejects.toThrow('stop waiting');
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(await readFile(join(homeDir, 'server', 'ensure.lock'), 'utf8')).toBe(String(process.pid));
});
