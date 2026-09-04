import { Command } from 'commander';

import { getVersion } from './cli/version';
import {
  KIKI_EXIT,
  loadDelegationProcedureTable,
  registerDelegationCommands,
} from './kiki/delegation';
import { registerDoctorCommand } from './kiki/doctor';
import { registerSeatInstallCommand } from './kiki/install';
import { registerMcpCommand } from './kiki/mcp';
import { registerSeatCommand } from './kiki/seat';
import { registerServeCommand } from './kiki/serve';

export async function createKikiProgram(version = getVersion()): Promise<Command> {
  const program = new Command().name('kiki').version(version);
  registerServeCommand(program);
  const seat = registerSeatCommand(program);
  registerSeatInstallCommand(seat);
  registerMcpCommand(program);
  registerDoctorCommand(program);
  registerDelegationCommands(program, await loadDelegationProcedureTable());
  return program;
}

export async function main(): Promise<void> {
  await (await createKikiProgram()).parseAsync(process.argv);
}

await main().catch((error: unknown) => {
  const exitCode = typeof error === 'object' && error !== null && 'exitCode' in error
    ? Number(error.exitCode)
    : KIKI_EXIT.failure;
  if (exitCode !== KIKI_EXIT.success) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = exitCode;
});
