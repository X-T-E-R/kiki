import { delegationProcedureTable } from '@kiki/klient/procedures';
import type { Command } from 'commander';
import { registerDelegationCommands } from './delegation';
import { registerSeatInstallCommand } from './install';
import { registerMcpCommand } from './mcp';
import { registerPromptFieldsCommand } from './prompt-fields';
import { registerSeatCommand } from './seat';
import { registerServeCommand } from './serve';

export function registerKikiCommands(program: Command): void {
  registerServeCommand(program);
  const seat = registerSeatCommand(program);
  registerSeatInstallCommand(seat);
  registerMcpCommand(program);
  registerPromptFieldsCommand(program);
  registerDelegationCommands(program, delegationProcedureTable);
}
