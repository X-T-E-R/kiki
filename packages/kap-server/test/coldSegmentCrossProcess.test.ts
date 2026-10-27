import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTestAppendLogStore } from '../../agent-core-v2/test/persistence/interface/stubs';
import { isSessionLockActive } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileLock';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { agentScopeOf, sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import {
  discardPersistedSession,
  persistedSessionLockScope,
  sealPersistedSession,
  type PersistedSessionMaintenance,
} from '../../node-sdk/src/retained-session';
import { describe, expect, it } from 'vitest';

const WORKSPACE_ID = 'wd_ws';
const SESSION_ID = 'session_offline_read';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const childPath = join(dirname(fileURLToPath(import.meta.url)), 'coldSegmentCrossProcess.child.mts');
const loaderPath = './build/register-raw-text-loader.mjs';

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

const journal = Buffer.from([
  line({ type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'NEEDLE_COLD' }], time: 1000 }),
  line({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 3000 }),
].join(''));

interface LaidOut {
  scratch: string;
  home: string;
  wirePath: string;
  manifestPath: string;
  segmentDir: string;
  input: PersistedSessionMaintenance;
}

interface PinnedReader {
  child: ChildProcess;
  log(): string;
  signal(): Promise<void>;
  result(): Promise<{ history: string; exported: string }>;
  stop(): Promise<void>;
}

async function laydown(): Promise<LaidOut> {
  const scratch = await mkdtemp(join(tmpdir(), 'cold-xproc-'));
  const home = join(scratch, 'home');
  const sessionDir = join(home, 'sessions', WORKSPACE_ID, SESSION_ID);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await writeFile(wirePath, journal);
  await writeFile(join(scratch, 'wire-path.txt'), wirePath);
  await sealPersistedSession({ homeDir: home, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, sessionDir });
  return {
    scratch,
    home,
    wirePath,
    manifestPath: `${wirePath}.segments.json`,
    segmentDir: `${wirePath}.segments`,
    input: { homeDir: home, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, sessionDir },
  };
}

async function readerPid(scratch: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(scratch, 'ready'), 'utf8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || parsed.pid === process.pid) return undefined;
    return parsed.pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function pin(laid: LaidOut): PinnedReader {
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.resolve('tsx/cli')),
    '--import',
    loaderPath,
    childPath,
    laid.scratch,
  ], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  return {
    child,
    log: () => output,
    async signal() {
      await writeFile(join(laid.scratch, 'go'), '1');
    },
    async result() {
      const deadline = Date.now() + 20_000;
      const resultPath = join(laid.scratch, 'result');
      while (Date.now() < deadline) {
        try {
          return JSON.parse(await readFile(resultPath, 'utf8')) as { history: string; exported: string };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
          if (child.exitCode !== null && code === 'ENOENT') break;
          await sleep(20);
        }
      }
      throw new Error(`reader result missing exit=${String(child.exitCode)} ${output}`);
    },
    async stop() {
      const pid = await readerPid(laid.scratch);
      if (pid !== undefined) killPid(pid);
      if (child.exitCode === null) child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        if (child.exitCode !== null) {
          clearTimeout(timer);
          resolve();
          return;
        }
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function waitReady(laid: LaidOut, reader: PinnedReader): Promise<void> {
  const readyPath = join(laid.scratch, 'ready');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await stat(readyPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (reader.child.exitCode !== null) break;
      await sleep(20);
    }
  }
  const marks = await Promise.all(['boot', 'history-loaded', 'export-loaded', 'ready'].map(async (name) => {
    try {
      await stat(join(laid.scratch, name));
      return `${name}:yes`;
    } catch {
      return `${name}:no`;
    }
  }));
  throw new Error(`reader did not pin ${marks.join(',')} ${reader.log()}`);
}

async function manifestGone(path: string): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    await sleep(15);
  }
  return false;
}

async function deflateNames(directory: string): Promise<string[]> {
  try {
    const names = await readdir(directory, { recursive: true });
    return names.map((name) => String(name)).filter((name) => name.endsWith('.deflate'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function sealId(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { sealId?: unknown };
  if (typeof parsed.sealId !== 'string') throw new Error('manifest has no sealId');
  return parsed.sealId;
}

async function sealChanged(path: string, previous: string, pending: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (pending()) return false;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { sealId?: unknown };
      if (typeof parsed.sealId === 'string' && parsed.sealId !== previous) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await sleep(15);
  }
  return false;
}

describe('sealed journal readers in another process', () => {
  it('returns the original bytes when discard runs while another process is reading', async () => {
    const laid = await laydown();
    const reader = pin(laid);
    let pending: Promise<number> = Promise.resolve(0);
    try {
      await waitReady(laid, reader);
      expect(await isSessionLockActive(laid.home, persistedSessionLockScope(WORKSPACE_ID, SESSION_ID))).toBe(false);
      let lockNames: string[] = [];
      try {
        lockNames = await readdir(join(laid.home, 'session-locks'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      expect(lockNames).toEqual([]);
      let settled = false;
      pending = discardPersistedSession(laid.input).then((count) => {
        settled = true;
        return count;
      });
      expect(await manifestGone(laid.manifestPath)).toBe(true);
      expect(settled).toBe(false);
      expect((await deflateNames(laid.segmentDir)).length).toBeGreaterThan(0);
      await reader.signal();
      expect(await reader.result()).toEqual({ history: 'original', exported: 'original' });
      expect(await pending).toBe(1);
      expect(await deflateNames(laid.segmentDir)).toEqual([]);
      expect(await readFile(laid.wirePath)).toEqual(journal);
    } finally {
      await reader.stop();
      await Promise.race([pending.then(() => undefined, () => undefined), sleep(10_000)]);
      await rm(laid.scratch, { recursive: true, force: true });
    }
  }, 90_000);

  it('removes sealed segments after the reader process is killed', async () => {
    const laid = await laydown();
    const reader = pin(laid);
    let pending: Promise<number> = Promise.resolve(0);
    try {
      await waitReady(laid, reader);
      let settled = false;
      pending = discardPersistedSession(laid.input).then((count) => {
        settled = true;
        return count;
      });
      expect(await manifestGone(laid.manifestPath)).toBe(true);
      expect(settled).toBe(false);
      expect((await deflateNames(laid.segmentDir)).length).toBeGreaterThan(0);
      const pid = await readerPid(laid.scratch);
      if (pid === undefined) throw new Error('reader pid missing');
      killPid(pid);
      const outcome = await Promise.race([
        pending.then(() => 'done' as const),
        sleep(15_000).then(() => 'blocked' as const),
      ]);
      expect(outcome).toBe('done');
      expect(await deflateNames(laid.segmentDir)).toEqual([]);
      expect(await readFile(laid.wirePath)).toEqual(journal);
    } finally {
      await reader.stop();
      await Promise.race([pending.then(() => undefined, () => undefined), sleep(10_000)]);
      await rm(laid.scratch, { recursive: true, force: true });
    }
  }, 90_000);

  it('returns the original bytes when rewrite waits for another process', async () => {
    const laid = await laydown();
    const reader = pin(laid);
    const storage = new FileStorageService(laid.home);
    const log = createTestAppendLogStore(storage);
    const rewritten = Buffer.from([
      line({ type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'REWRITTEN' }], time: 1000 }),
      line({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 4000 }),
    ].join(''));
    let pending: Promise<void> = Promise.resolve();
    try {
      await waitReady(laid, reader);
      let settled = false;
      const wideScope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', WORKSPACE_ID), SESSION_ID), 'main');
      pending = log.rewrite(wideScope, 'wire.jsonl', [
        { type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'REWRITTEN' }], time: 1000 },
        { type: 'turn.ended', turnId: 1, reason: 'completed', time: 4000 },
      ]).then(() => {
        settled = true;
      });
      expect(await manifestGone(laid.manifestPath)).toBe(true);
      expect(settled).toBe(false);
      expect(await readFile(laid.wirePath)).toEqual(journal);
      expect((await deflateNames(laid.segmentDir)).length).toBeGreaterThan(0);
      await reader.signal();
      expect(await reader.result()).toEqual({ history: 'original', exported: 'original' });
      await pending;
      expect(await readFile(laid.wirePath)).toEqual(rewritten);
    } finally {
      await reader.stop();
      await Promise.race([pending.then(() => undefined, () => undefined), sleep(10_000)]);
      await log.dispose();
      await storage.close();
      await rm(laid.scratch, { recursive: true, force: true });
    }
  }, 90_000);

  it('returns the original bytes when reseal waits for another process', async () => {
    const laid = await laydown();
    const reader = pin(laid);
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await waitReady(laid, reader);
      const previous = await sealId(laid.manifestPath);
      const previousSegments = await deflateNames(laid.segmentDir);
      expect(previousSegments.length).toBeGreaterThan(0);
      let settled = false;
      pending = sealPersistedSession(laid.input).then((results) => {
        settled = true;
        return results;
      });
      expect(await sealChanged(laid.manifestPath, previous, () => settled)).toBe(true);
      expect(settled).toBe(false);
      const during = await deflateNames(laid.segmentDir);
      for (const name of previousSegments) expect(during).toContain(name);
      await reader.signal();
      expect(await reader.result()).toEqual({ history: 'original', exported: 'original' });
      await pending;
      expect(await readFile(laid.wirePath)).toEqual(journal);
      expect(await sealId(laid.manifestPath)).not.toBe(previous);
      const after = await deflateNames(laid.segmentDir);
      for (const name of previousSegments) expect(after).not.toContain(name);
      expect(after.length).toBeGreaterThan(0);
    } finally {
      await reader.stop();
      await Promise.race([pending.then(() => undefined, () => undefined), sleep(10_000)]);
      await rm(laid.scratch, { recursive: true, force: true });
    }
  }, 90_000);
});
