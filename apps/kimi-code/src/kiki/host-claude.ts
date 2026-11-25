import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createSeatKlient, type SeatKlient } from '@kiki/klient/procedures';
import type { Command } from 'commander';

import { resolveKikiHome } from './home';
import { mcpPrincipal } from './mcp';
import { createSeatOnConnection } from './seat';
import { ensureServer } from './serve';

const DISPATCH_ID = /^dispatch_[A-Za-z0-9]+$/u;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export async function readClaudeNotifications(
  klient: Pick<SeatKlient, 'events'>,
  directory: string,
): Promise<string | undefined> {
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of entries.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!name.endsWith('.cursor')) continue;
    const dispatchId = name.slice(0, -'.cursor'.length);
    if (!DISPATCH_ID.test(dispatchId)) continue;
    const path = join(directory, name);
    let cursor = Number(await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '0';
      throw error;
    }));
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid Claude host event cursor.');
    for (;;) {
      const page = await klient.events({ dispatchId, cursor, limit: 100 });
      if (page.truncated_before_seq !== undefined && cursor < page.truncated_before_seq - 1) {
        cursor = page.truncated_before_seq - 1;
      }
      let terminal = false;
      for (const event of page.items) {
        cursor = event.seq;
        await writeFile(path, String(cursor));
        if (!('type' in event)) continue;
        if (event.type === 'agent_notify') {
          return `Kiki AgentNotify ${dispatchId} event ${cursor}: ${String(event.message ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 300)}. Read kiki_events for details.`;
        }
        if (TERMINAL.has(event.type)) {
          await rm(path, { force: true });
          terminal = true;
          break;
        }
      }
      if (terminal || page.nextCursor === undefined) break;
    }
  }
  return undefined;
}

const EMPTY_LOCK_GRACE_MS = 2_000;
const RECLAIM_STALE_MS = 10_000;

interface WatcherLockRecord {
  readonly pid: number;
  readonly token?: string;
  readonly createdAt?: number;
}

function parseWatcherLock(raw: string): WatcherLockRecord | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { pid?: unknown; token?: unknown; createdAt?: unknown };
      if (typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
        return {
          pid: parsed.pid,
          token: typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined,
          createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  const pid = Number(trimmed);
  if (Number.isSafeInteger(pid) && pid > 0) return { pid };
  return undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (probeError) {
    return (probeError as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function publishLockAtomically(directory: string, lockPath: string, payload: string): Promise<boolean> {
  const tmpPath = join(directory, `.watch.lock.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, payload, { flag: 'wx', encoding: 'utf8' });
    try {
      await link(tmpPath, lockPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') {
        try {
          await writeFile(lockPath, payload, { flag: 'wx', encoding: 'utf8' });
          return true;
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw fallbackError;
        }
      }
      throw error;
    }
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

async function reclaimDeadWatcherLock(directory: string, lockPath: string, expectedRaw: string): Promise<boolean> {
  const reclaimPath = join(directory, '.watch.lock.reclaim');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(reclaimPath, 'wx');
    await handle.writeFile(String(process.pid), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    const info = await stat(reclaimPath).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs > RECLAIM_STALE_MS) {
      await rm(reclaimPath, { force: true }).catch(() => {});
    }
    return false;
  }
  try {
    const currentRaw = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (currentRaw !== expectedRaw) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await handle.close().catch(() => {});
    await rm(reclaimPath, { force: true }).catch(() => {});
  }
}

export async function claimWatcher(directory: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, '.watch.lock');
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await publishLockAtomically(directory, lockPath, payload)) {
      return async () => {
        const currentRaw = await readFile(lockPath, 'utf8').catch(() => undefined);
        if (currentRaw === undefined) return;
        const parsed = parseWatcherLock(currentRaw);
        if (parsed?.token === token) {
          await rm(lockPath, { force: true }).catch(() => {});
        }
      };
    }
    const existingRaw = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (existingRaw === undefined) continue;
    const parsed = parseWatcherLock(existingRaw);
    if (parsed !== undefined) {
      if (isPidAlive(parsed.pid)) return undefined;
    } else {
      const info = await stat(lockPath).catch(() => undefined);
      if (info === undefined) continue;
      if (Date.now() - info.mtimeMs < EMPTY_LOCK_GRACE_MS) return undefined;
    }
    await reclaimDeadWatcherLock(directory, lockPath, existingRaw);
  }
  return undefined;
}

export function registerHostClaudeCommands(program: Command): void {
  program.command('host-claude-bind')
    .description('Register a dispatch event cursor for Claude host notifications.')
    .requiredOption('--workspace <dir>')
    .requiredOption('--dispatch <id>')
    .action(async (options: { workspace: string; dispatch: string }) => {
      if (!DISPATCH_ID.test(options.dispatch)) throw new Error('Invalid dispatch ID.');
      const workspace = await realpath(resolve(options.workspace));
      const directory = join(workspace, '.kiki', 'host-claude');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${options.dispatch}.cursor`), '0', { flag: 'wx' });
      process.stdout.write(`BOUND ${options.dispatch}\n`);
    });
  program.command('host-claude-rewake')
    .description('Wait for a Claude host notification from bound dispatches.')
    .requiredOption('--workspace <dir>')
    .option('--home <dir>')
    .option('--timeout-s <seconds>', '', (value: string) => Number(value), 36_000)
    .action(async (options: { workspace: string; home?: string; timeoutS: number }) => {
      if (!Number.isSafeInteger(options.timeoutS) || options.timeoutS < 1 || options.timeoutS > 36_000) {
        throw new Error('timeout-s must be an integer from 1 to 36000.');
      }
      const workspace = await realpath(resolve(options.workspace));
      const directory = join(workspace, '.kiki', 'host-claude');
      const release = await claimWatcher(directory);
      if (release === undefined) return;
      let klient: SeatKlient | undefined;
      const deadline = Date.now() + options.timeoutS * 1000;
      try {
        const connection = await ensureServer({ homeDir: resolveKikiHome(options.home), workspace });
        const seat = await createSeatOnConnection(connection, { workspace, principal: mcpPrincipal(workspace) });
        klient = createSeatKlient({ endpoint: connection.url, token: seat.delegationToken });
        while (Date.now() < deadline) {
          const message = await readClaudeNotifications(klient, directory);
          if (message !== undefined) {
            process.stderr.write(`${message}\n`);
            process.exitCode = 2;
            return;
          }
          await new Promise((done) => setTimeout(done, 1000));
        }
      } finally {
        await klient?.close();
        await release();
      }
    });
}
