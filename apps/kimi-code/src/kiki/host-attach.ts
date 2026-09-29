import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isSea } from 'node:sea';
import { resolve } from 'node:path';

import { createSeatKlient, type SeatKlient } from '@kiki/klient/procedures';
import type { Command } from 'commander';

import { resolveKikiHome } from './home';
import { mcpPrincipal } from './mcp';
import { createSeatOnConnection } from './seat';
import { ensureServer } from './serve';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 400);
}

export async function watchDispatchEvents(
  klient: Pick<SeatKlient, 'events' | 'result'>,
  dispatchId: string,
  cursor: number,
  emit: (line: string) => void,
  pause: () => Promise<void> = () => new Promise((done) => setTimeout(done, 1000)),
): Promise<number> {
  for (;;) {
    const page = await klient.events({ dispatchId, cursor, limit: 100 });
    if (page.truncated_before_seq !== undefined && cursor < page.truncated_before_seq - 1) {
      emit(`GAP ${dispatchId} ${page.truncated_before_seq}`);
      cursor = page.truncated_before_seq - 1;
    }
    for (const event of page.items) {
      cursor = event.seq;
      if (!('type' in event)) continue;
      if (event.type === 'agent_notify') emit(`NOTIFY ${dispatchId} ${cursor} ${oneLine(event.message ?? '')}`);
      if (TERMINAL.has(event.type)) {
        const page = await klient.result({ dispatchId, limit: 4096 });
        emit(`DONE ${dispatchId} ${cursor} ${event.type} ${oneLine(page.text)}`);
        return event.type === 'completed' ? 0 : 1;
      }
    }
    if (page.nextCursor !== undefined) continue;
    await pause();
  }
}

export function registerHostAttachCommand(program: Command): void {
  program.command('host-attach')
    .option('--prompt-file <file>')
    .option('--workspace <dir>')
    .option('--dispatch <id>')
    .option('--cursor <seq>', '', (value: string) => Number(value), 0)
    .option('--home <dir>')
    .action(async (options: {
      readonly promptFile?: string;
      readonly workspace?: string;
      readonly dispatch?: string;
      readonly cursor: number;
      readonly home?: string;
    }) => {
      if (options.promptFile !== undefined && (options.workspace !== undefined || options.dispatch !== undefined)) {
        throw new Error('Use either --prompt-file or --workspace with --dispatch.');
      }
      if (options.promptFile !== undefined) {
        const file = await realpath(resolve(options.promptFile));
        process.stdout.write(`ATTACH print ${process.pid}\n`);
        process.exitCode = await attachPrint(file, (line) => process.stdout.write(`${line}\n`));
        return;
      }
      if (options.workspace === undefined || options.dispatch === undefined || !Number.isSafeInteger(options.cursor) || options.cursor < 0) {
        throw new Error('A workspace, dispatch ID, and nonnegative integer cursor are required.');
      }
      const workspace = await realpath(resolve(options.workspace));
      process.stdout.write(`ATTACH ${options.dispatch} ${options.cursor}\n`);
      const connection = await ensureServer({ homeDir: resolveKikiHome(options.home), workspace });
      const seat = await createSeatOnConnection(connection, { workspace, principal: mcpPrincipal(workspace) });
      const klient = createSeatKlient({ endpoint: connection.url, token: seat.delegationToken });
      try {
        process.exitCode = await watchDispatchEvents(klient, options.dispatch, options.cursor, (line) => process.stdout.write(`${line}\n`));
      } finally {
        await klient.close();
      }
    });
}

async function attachPrint(promptFile: string, emit: (line: string) => void): Promise<number> {
  const args = isSea()
    ? ['--prompt-file', promptFile, '--output-format', 'stream-json', '--permission-mode', 'manual']
    : [...process.execArgv, process.argv[1]!, '--prompt-file', promptFile, '--output-format', 'stream-json', '--permission-mode', 'manual'];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let pending = '';
  let summary = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const frame = JSON.parse(line) as { role?: string; content?: unknown };
        if (frame.role === 'assistant' && typeof frame.content === 'string') summary = oneLine(frame.content);
      } catch {
        continue;
      }
    }
  });
  const code = await new Promise<number>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => done(status ?? (signal === null ? 1 : 128)));
  });
  emit(`DONE print ${code === 0 ? 'completed' : 'failed'} ${summary}`);
  return code;
}
