import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
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
  for (const name of entries.sort()) {
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

async function claimWatcher(directory: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, '.watch.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8').catch(() => '0'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); return undefined; }
        catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') return undefined;
        }
      }
      await rm(path, { force: true });
    }
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
