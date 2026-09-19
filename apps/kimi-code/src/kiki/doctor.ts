import { stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';

import { serverTokenPath } from '@kiki/kap-server';
import type { Command } from 'commander';

import { handleDoctor, type DoctorDeps, type DoctorOptions } from '#/cli/sub/doctor';
import { resolveKikiHome } from './home';
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

export interface DoctorCommandDeps {
  readonly cwd?: () => string;
  readonly doctorReport?: (homeDir: string) => Promise<DoctorReport>;
  readonly handleDoctor?: (deps: Partial<DoctorDeps>, options: DoctorOptions) => Promise<number>;
  readonly doctorDeps?: Partial<DoctorDeps>;
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly exit?: (code: number) => void;
}

export function registerDoctorCommand(
  program: Command,
  deps?: Partial<DoctorCommandDeps>,
): Command {
  const doctorCommand = program
    .command('doctor')
    .description('Show daemon status or validate agent profiles.')
    .option('--home <dir>', 'Kiki home directory.')
    .option('--json', 'Print daemon report as JSON.')
    .option('--agents', 'Validate agent profiles and configuration.')
    .action(async (options: { readonly home?: string; readonly json?: boolean; readonly agents?: boolean }) => {
      if (options.agents === true) {
        await runDoctorAgents(options.home, deps);
        return;
      }
      const report = await (deps?.doctorReport ?? doctor)(resolveKikiHome(options.home));
      (deps?.stdout ?? process.stdout).write(`${JSON.stringify(report, null, 2)}\n`);
    });

  doctorCommand
    .command('agents')
    .description('Validate agent profiles and configuration.')
    .option('--home <dir>', 'Kiki home directory.')
    .action(async (options: { readonly home?: string }, cmd: Command) => {
      const parentOpts = cmd.parent?.opts<{ readonly home?: string }>();
      const home = options.home ?? parentOpts?.home;
      await runDoctorAgents(home, deps);
    });

  return doctorCommand;
}

async function runDoctorAgents(
  home: string | undefined,
  deps?: Partial<DoctorCommandDeps>,
): Promise<number> {
  const homeDir = resolveKikiHome(home);
  const doctorDeps: Partial<DoctorDeps> = {
    cwd: deps?.cwd ?? (() => process.cwd()),
    defaultConfigPath: () => join(homeDir, 'config.toml'),
    defaultTuiConfigPath: () => join(homeDir, 'tui.toml'),
    kimiHomeDir: () => homeDir,
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    exit: (code: number) => {
      if (deps?.exit) {
        deps.exit(code);
      } else {
        process.exitCode = code;
      }
      throw new Error(`Doctor exit ${String(code)}`);
    },
    ...deps?.doctorDeps,
  };
  const runner = deps?.handleDoctor ?? (handleDoctor as (d: Partial<DoctorDeps>, o: DoctorOptions) => Promise<number>);
  try {
    const code = await runner(doctorDeps, {});
    if (code !== 0) {
      if (deps?.exit) {
        deps.exit(code);
      } else {
        process.exitCode = code;
      }
    }
    return code;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Doctor exit ')) {
      const parsedCode = Number(error.message.slice('Doctor exit '.length));
      return Number.isNaN(parsedCode) ? 1 : parsedCode;
    }
    throw error;
  }
}

export async function doctor(homeDir = resolveKikiHome()): Promise<DoctorReport> {
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
        '/api/external-delegation/seats',
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
