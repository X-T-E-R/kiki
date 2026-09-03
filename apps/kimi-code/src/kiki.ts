import { Command } from 'commander';

import { getVersion } from './cli/version';
import { registerDoctorCommand } from './kiki/doctor';
import { registerSeatInstallCommand } from './kiki/install';
import { registerMcpCommand } from './kiki/mcp';
import { registerSeatCommand } from './kiki/seat';
import { registerServeCommand } from './kiki/serve';

export function createKikiProgram(version = getVersion()): Command {
  const program = new Command().name('kiki').version(version);
  registerServeCommand(program);
  const seat = registerSeatCommand(program);
  registerSeatInstallCommand(seat);
  registerMcpCommand(program);
  registerDoctorCommand(program);
  return program;
}

export async function main(): Promise<void> {
  await createKikiProgram().parseAsync(process.argv);
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
