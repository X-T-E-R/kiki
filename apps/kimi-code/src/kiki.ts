import { Command } from 'commander';

import { getVersion } from './cli/version';

export function createKikiProgram(version = getVersion()): Command {
  return new Command().name('kiki').version(version);
}

export async function main(): Promise<void> {
  await createKikiProgram().parseAsync(process.argv);
}

await main();
