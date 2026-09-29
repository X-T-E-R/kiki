import { spawn } from 'node:child_process';
import { open, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { createSeatKlient, type SeatKlient } from '@kiki/klient/procedures';
import type { Command } from 'commander';

import { resolveKikiHome } from './home';
import { mcpPrincipal } from './mcp';
import { createSeatOnConnection } from './seat';
import { ensureServer } from './serve';

const DISPATCH_ID = /^dispatch_[A-Za-z0-9]+$/u;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

interface CodexBinding {
  readonly thread: string;
  readonly codex: string;
}

export function codexBindingPath(home: string, workspace: string, dispatch: string): string {
  if (!DISPATCH_ID.test(dispatch)) throw new Error('Invalid dispatch ID.');
  const workspaceKey = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  return join(home, 'host-codex', workspaceKey, `${dispatch}.json`);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const file = await open(lock, 'wx');
      try { return await action(); }
      finally { await file.close(); await rm(lock, { force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > 120_000) await rm(lock, { force: true });
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error('Codex binding is busy; rerun delivery.');
}

export async function deliverCodexEvents(options: {
  readonly workspace: string;
  readonly dispatch: string;
  readonly home?: string;
  readonly queue?: (command: string, thread: string, message: string) => Promise<void>;
  readonly klient?: Pick<SeatKlient, 'events' | 'close'>;
}): Promise<number> {
  const workspace = await realpath(resolve(options.workspace));
  const path = codexBindingPath(resolveKikiHome(options.home), workspace, options.dispatch);
  const binding = JSON.parse(await readFile(path, 'utf8')) as CodexBinding;
  if (!binding.thread || !binding.codex) throw new Error('Codex thread binding is incomplete.');
  return withLock(path, async () => {
    const cursorPath = `${path}.cursor`;
    let cursor = Number(await readFile(cursorPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '0';
      throw error;
    }));
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid Codex cursor.');
    const klient = options.klient ?? await (async () => {
      const connection = await ensureServer({ homeDir: resolveKikiHome(options.home), workspace });
      const seat = await createSeatOnConnection(connection, { workspace, principal: mcpPrincipal(workspace) });
      return createSeatKlient({ endpoint: connection.url, token: seat.delegationToken });
    })();
    let delivered = 0;
    try {
      for (;;) {
        const page = await klient.events({ dispatchId: options.dispatch, cursor, limit: 100 });
        if (page.truncated_before_seq !== undefined && cursor < page.truncated_before_seq - 1) {
          throw new Error('Codex event cursor is stale; inspect kiki_status and kiki_events before resetting it.');
        }
        for (const event of page.items) {
          if ('type' in event && (event.type === 'agent_notify' || TERMINAL.has(event.type))) {
            const message = `Kiki ${event.type} for ${options.dispatch} (event ${event.seq}). ${String(event.message ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 300)} Read kiki_events and kiki_status for details.`;
            await (options.queue ?? queueCodex)(binding.codex, binding.thread, message);
            delivered++;
          }
          cursor = event.seq;
          await writeFile(cursorPath, String(cursor));
        }
        if (page.nextCursor === undefined) return delivered;
      }
    } finally {
      await klient.close();
    }
  });
}

async function queueCodex(command: string, thread: string, message: string): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(command, ['queue', '--thread', thread, '--message', message], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    let failure = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { failure = (failure + chunk).slice(-1000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? done() : reject(new Error(`codex queue failed (${code}): ${failure}`)));
  });
}

export function registerHostCodexCommands(program: Command): void {
  program.command('host-codex-bind')
    .requiredOption('--workspace <dir>')
    .requiredOption('--dispatch <id>')
    .requiredOption('--thread <id>')
    .option('--codex <executable>', '', 'codex')
    .option('--home <dir>')
    .action(async (input: { workspace: string; dispatch: string; thread: string; codex: string; home?: string }) => {
      const workspace = await realpath(resolve(input.workspace));
      const path = codexBindingPath(resolveKikiHome(input.home), workspace, input.dispatch);
      if (!/^[a-zA-Z0-9_-]{8,128}$/u.test(input.thread)) throw new Error('Invalid Codex thread ID.');
      await mkdir(dirname(path), { recursive: true });
      await withLock(path, async () => {
        await atomicJson(path, { thread: input.thread, codex: input.codex } satisfies CodexBinding);
      });
      await deliverCodexEvents({ workspace, dispatch: input.dispatch, home: input.home });
      process.stdout.write(`BOUND ${input.dispatch} ${input.thread}\n`);
    });
  program.command('host-codex-queue')
    .option('--workspace <dir>')
    .option('--dispatch <id>')
    .option('--home <dir>')
    .action(async (input: { workspace?: string; dispatch?: string; home?: string }) => {
      const text = await new Promise<string>((done, reject) => {
        let value = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => {
          value += chunk;
          if (value.length > 65_536) reject(new Error('Hook payload too large.'));
        });
        process.stdin.once('end', () => done(value));
        process.stdin.once('error', reject);
      });
      const hook = text.length === 0 ? {} : JSON.parse(text) as { cwd?: string; dispatch_id?: string };
      const workspace = input.workspace ?? hook.cwd;
      const dispatch = input.dispatch ?? hook.dispatch_id;
      if (!workspace || !dispatch) throw new Error('Missing Codex workspace or dispatch ID.');
      try {
        const delivered = await deliverCodexEvents({ workspace, dispatch, home: input.home });
        process.stdout.write(`QUEUED ${dispatch} ${delivered}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
}
