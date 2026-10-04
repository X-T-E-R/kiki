import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveGlobalLogPath } from '@kiki/node-sdk';
import { afterEach, expect, it, vi } from 'vitest';

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
const originalArgv = process.argv;
const originalExecArgv = process.execArgv;
afterEach(async () => {
  process.argv = originalArgv;
  process.execArgv = originalExecArgv;
  mocks.sea = false;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

it('reports the requested home log and executable doctor commands at the startup deadline without a real daemon', async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.tmp/cli-help-445');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, 'serve-test-'));
  const homeDir = join(root, 'custom home');
  vi.stubEnv('KIKI_HOME', join(root, 'other-home'));
  mocks.spawn.mockReturnValue({ unref: mocks.unref });
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(60_000);
  const fetch = vi.fn(() => { throw new Error('Unexpected network request'); });
  vi.stubGlobal('fetch', fetch);

  await expect(ensureServer({ homeDir })).rejects.toThrow([
    'Kiki server did not become ready before the startup deadline.',
    `See log: ${resolveGlobalLogPath(homeDir)}`,
    `Check daemon status: kiki doctor --home "${homeDir}"`,
    `Validate configuration: kiki doctor agents --home "${homeDir}"`,
  ].join('\n'));
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['serve', '--home', homeDir]));
  expect(mocks.unref).toHaveBeenCalledOnce();
  expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(250);
  expect(fetch).not.toHaveBeenCalled();
  expect(await readdir(join(homeDir, 'server'))).toEqual([]);
});

it.each([true, false])('routes detached startup to serve for SEA=%s without repeating the executable', async (sea) => {
  const scratch = resolve(import.meta.dirname, '../../../../.tmp/terminal-host-fixes');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, 'serve-entry-'));
  const homeDir = join(root, 'home');
  mocks.sea = sea;
  const script = join(root, 'main.mjs');
  process.argv = [process.execPath, sea ? process.execPath : script];
  process.execArgv = ['--import', 'example-loader'];
  mocks.spawn.mockReturnValue({ unref: mocks.unref });
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(60_000);
  await expect(ensureServer({ homeDir, port: 0 })).rejects.toThrow('startup deadline');
  const args = mocks.spawn.mock.calls[0]![1] as string[];
  expect(args).toEqual([
    ...(sea ? [] : ['--import', 'example-loader', script]),
    'serve', '--home', homeDir, '--idle-exit', '30m', '--json', '--port', '0',
  ]);
  const program = createProgram('test', () => { throw new Error('Unexpected main action'); }).exitOverride();
  const serve = program.commands.find((command) => command.name() === 'serve')!;
  const action = vi.fn();
  serve.action(action);
  await program.parseAsync([process.execPath, sea ? process.execPath : script, ...args.slice(sea ? 0 : 3)]);
  expect(action).toHaveBeenCalledOnce();
  expect(serve.opts()).toMatchObject({ home: homeDir, idleExit: '30m', json: true, port: 0 });
  expect(await readdir(join(homeDir, 'server'))).toEqual([]);
});
