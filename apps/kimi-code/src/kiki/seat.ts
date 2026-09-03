import { resolve } from 'node:path';

import type { Command } from 'commander';

import { getDataDir } from '../utils/paths';
import { ensureServer, type ServerConnection } from './serve';

export type SeatMode = 'manual' | 'auto' | 'yolo';

export interface SeatConnection {
  readonly seatId: string;
  readonly sessionId: string;
  readonly delegationToken: string;
  readonly principal: string;
  readonly workspace: string;
  readonly mode: SeatMode;
  readonly model?: string;
  readonly thinking?: string;
}

interface SeatCreateOptions {
  readonly workspace: string;
  readonly principal: string;
  readonly mode: SeatMode;
  readonly model?: string;
  readonly thinking?: string;
  readonly json?: boolean;
}

export function registerSeatCommand(program: Command): void {
  const seat = program.command('seat');
  seat
    .command('create')
    .requiredOption('--workspace <dir>')
    .requiredOption('--principal <name>')
    .option('--mode <mode>', '', parseMode, 'manual')
    .option('--model <alias>')
    .option('--thinking <effort>')
    .option('--json')
    .action(async (options: SeatCreateOptions) => {
      const result = await createSeat(options);
      process.stdout.write(`${JSON.stringify(result, null, options.json === true ? 0 : 2)}\n`);
    });

  seat
    .command('list')
    .option('--json')
    .action(async (options: { readonly json?: boolean }) => {
      const connection = await ensureServer({ homeDir: getDataDir() });
      const seats = await daemonRequest<readonly Omit<SeatConnection, 'delegationToken'>[]>(
        connection,
        'GET',
        '/api/v2/external-delegation/seats',
      );
      process.stdout.write(`${JSON.stringify(seats, null, options.json === true ? 0 : 2)}\n`);
    });

  seat
    .command('revoke <seatId>')
    .option('--json')
    .action(async (seatId: string, options: { readonly json?: boolean }) => {
      const connection = await ensureServer({ homeDir: getDataDir() });
      const revoked = await daemonRequest<Omit<SeatConnection, 'delegationToken'>>(
        connection,
        'DELETE',
        `/api/v2/external-delegation/seats/${encodeURIComponent(seatId)}`,
      );
      process.stdout.write(`${JSON.stringify(revoked, null, options.json === true ? 0 : 2)}\n`);
    });
}

export async function createSeat(input: {
  readonly workspace: string;
  readonly principal: string;
  readonly mode?: SeatMode;
  readonly model?: string;
  readonly thinking?: string;
}): Promise<SeatConnection> {
  const workspace = resolve(input.workspace);
  const connection = await ensureServer({ homeDir: getDataDir(), workspace });
  return daemonRequest<SeatConnection>(
    connection,
    'POST',
    '/api/v2/external-delegation/seats',
    {
      workspace,
      principal: input.principal,
      mode: input.mode,
      model: input.model,
      thinking: input.thinking,
    },
  );
}

export async function daemonRequest<T>(
  connection: ServerConnection,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${connection.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${connection.token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json() as {
    readonly code: number;
    readonly msg: string;
    readonly data: T;
  };
  if (!response.ok || envelope.code !== 0) throw new Error(envelope.msg);
  return envelope.data;
}

function parseMode(value: string): SeatMode {
  if (value === 'manual' || value === 'auto' || value === 'yolo') return value;
  throw new Error('Invalid permission mode.');
}
