import { delegationProcedureTable } from '@kiki/klient/procedures';
import type { Command } from 'commander';
import { registerDelegationCommands } from './delegation';
import { registerHostAttachCommand } from './host-attach';
import { registerHostClaudeCommands } from './host-claude';
import { registerHostCodexCommands } from './host-codex';
import { registerSeatInstallCommand } from './install';
import { registerMcpCommand } from './mcp';
import { registerPromptFieldsCommand } from './prompt-fields';
import { registerPermissionCommand } from './permission';
import { registerSeatCommand } from './seat';
import { registerServeCommand } from './serve';

export function registerKikiCommands(program: Command): void {
  registerServeCommand(program);
  const seat = registerSeatCommand(program);
  registerSeatInstallCommand(seat);
  registerMcpCommand(program);
  registerHostAttachCommand(program);
  registerHostClaudeCommands(program);
  registerHostCodexCommands(program);
  registerPromptFieldsCommand(program);
  registerPermissionCommand(program);
  registerDelegationCommands(program, delegationProcedureTable);
}
