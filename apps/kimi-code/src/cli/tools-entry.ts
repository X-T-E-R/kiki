import { Command } from 'commander';

import { CLI_COMMAND_NAME } from '#/constant/identity';
import { getVersion } from './package-version';
import { registerToolsCommand } from './sub/tools';

export async function runToolsCommand(argv: readonly string[]): Promise<void> {
  const program = new Command(CLI_COMMAND_NAME)
    .version(getVersion(), '-V, --version')
    .enablePositionalOptions()
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', 'Show help.');
  registerToolsCommand(program);
  await program.parseAsync([...argv]);
}
