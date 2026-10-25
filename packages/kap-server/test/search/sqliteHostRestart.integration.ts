import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { SqliteSearchHost } from '../../src/search/sqlite/host';

const hosts: SqliteSearchHost[] = [];
const children: ChildProcess[] = [];
const homes: string[] = [];
const indexerRoot = new URL('../../src/search/sqlite/', import.meta.url);

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-sqlite-restart-'));
  homes.push(home);
  return home;
}

function spawnIndexer(database: string, hardMb: number): ChildProcess {
  const child = spawn(process.execPath, [
    '--max-old-space-size=256', '--experimental-transform-types', '--import', 'tsx',
    '--import', new URL('register-dev-hooks.mjs', indexerRoot).href,
    fileURLToPath(new URL('indexerDev.ts', indexerRoot)), database,
  ], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256',
      KIKI_SEARCH_INDEXER_HARD_MB: String(hardMb), KIKI_SEARCH_INDEXER_SOFT_MB: '32',
      KIKI_SEARCH_INDEX_SUBAGENTS: '0' },
  });
  children.push(child);
  return child;
}

function waitExit(child: ChildProcess, limitMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('indexer did not exit')); }, limitMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function walBytes(database: string): Promise<number> {
  try { return (await stat(`${database}-wal`)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}

it('runs the scheduled indexer restart when the timer fires before retryAt', async () => {
  const home = await tempHome();
  const script = join(home, 'exit86.mjs');
  await writeFile(script, 'process.exit(86);\n');
  let armed: { run: () => void; timer: NodeJS.Timeout; delay: number } | undefined;
  const host = new SqliteSearchHost({
    database: join(home, 'index.sqlite'), backoffMs: [5_000], memoryBackoffMs: [5_000], indexerEntry: script,
    scheduleRestart: (run, delay) => {
      const timer = setTimeout(() => {}, 60_000);
      armed = { run, timer, delay };
      return timer;
    },
  });
  hosts.push(host);
  await host.open();
  const deadline = Date.now() + 10_000;
  while (armed === undefined || host.snapshot().indexerPid !== undefined) {
    if (Date.now() > deadline) throw new Error('restart was not armed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(armed.delay).toBe(5_000);
  expect(host.snapshot().retryAfterMs).toBeGreaterThan(1_000);
  clearTimeout(armed.timer);
  armed.run();
  expect(host.snapshot().retryAfterMs).toBeUndefined();
  expect(host.snapshot().indexerPid).toBeGreaterThan(0);
});

it('exits a booting indexer when close arrives before the database is opened', async () => {
  const home = await tempHome();
  const database = join(home, 'missing', 'index.sqlite');
  const started = Date.now();
  const child = spawnIndexer(database, 768);
  child.once('spawn', () => { child.send({ type: 'close' }); });
  await expect(waitExit(child, 8_000)).resolves.toBe(0);
  expect(Date.now() - started).toBeLessThan(5_000);
  await expect(stat(join(home, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('closes the index after open when the memory budget exits', async () => {
  const home = await tempHome();
  const database = join(home, 'index.sqlite');
  const child = spawnIndexer(database, 64);
  const kinds: string[] = [];
  let stderr = '';
  child.on('message', (message: { type?: string }) => { if (message?.type) kinds.push(message.type); });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  await expect(waitExit(child, 15_000)).resolves.toBe(86);
  expect(kinds).toContain('ready');
  expect(stderr).toContain('memory_budget');
  expect(await walBytes(database)).toBe(0);
  await expect(stat(database)).resolves.toMatchObject({ size: expect.any(Number) });
});
