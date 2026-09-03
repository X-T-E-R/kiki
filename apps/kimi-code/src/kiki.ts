import { Command } from 'commander';

import { getVersion } from './cli/version';
import { registerSeatCommand } from './kiki/seat';
import { registerServeCommand } from './kiki/serve';

export function createKikiProgram(version = getVersion()): Command {
  const program = new Command().name('kiki').version(version);
  registerServeCommand(program);
  registerSeatCommand(program);
  return program;
}

export async function main(): Promise<void> {
  await createKikiProgram().parseAsync(process.argv);
}

await main();
