import { stat } from 'node:fs/promises';
import { platform } from 'node:os';

import { serverTokenPath } from '@moonshot-ai/kap-server';
import type { Command } from 'commander';

import { getDataDir } from '../utils/paths';
import { daemonRequest, type SeatConnection } from './seat';
import { findReachableServer } from './serve';

interface DoctorReport {
  readonly daemon: {
    readonly reachable: boolean;
    readonly url?: string;
    readonly serverId?: string;
  };
  readonly token: {
    readonly path: string;
    readonly exists: boolean;
    readonly secure: boolean;
    readonly mode?: string;
  };
  readonly seats: readonly {
    readonly seatId: string;
    readonly principal: string;
    readonly workspace: string;
    readonly mode: string;
  }[];
}

export function registerDoctorCommand(program: Command): void {
  program.command('doctor').option('--json').action(async () => {
    process.stdout.write(`${JSON.stringify(await doctor(), null, 2)}\n`);
  });
}

export async function doctor(homeDir = getDataDir()): Promise<DoctorReport> {
  const tokenPath = serverTokenPath(homeDir);
  let tokenExists = false;
  let tokenSecure = false;
  let tokenMode: string | undefined;
  try {
    const info = await stat(tokenPath);
    tokenExists = true;
    tokenMode = (info.mode & 0o777).toString(8).padStart(3, '0');
    tokenSecure = platform() === 'win32' || (info.mode & 0o077) === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const connection = tokenExists && tokenSecure
    ? await findReachableServer(homeDir)
    : undefined;
  const seats = connection === undefined
    ? []
    : await daemonRequest<readonly Omit<SeatConnection, 'delegationToken'>[]>(
        connection,
        'GET',
        '/api/v2/external-delegation/seats',
      );
  return {
    daemon: {
      reachable: connection !== undefined,
      url: connection?.url,
      serverId: connection?.serverId,
    },
    token: {
      path: tokenPath,
      exists: tokenExists,
      secure: tokenSecure,
      mode: tokenMode,
    },
    seats: seats.map((seat) => ({
      seatId: seat.seatId,
      principal: seat.principal,
      workspace: seat.workspace,
      mode: seat.mode,
    })),
  };
}
