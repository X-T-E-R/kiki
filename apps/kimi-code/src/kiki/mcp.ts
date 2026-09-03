import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { platform } from 'node:os';
import { normalize, resolve } from 'node:path';

import { runKikiMcpStdio } from '@moonshot-ai/kap-server';
import type { Command } from 'commander';

import { resolveKikiHome } from './home';
import { createSeatOnConnection } from './seat';
import { ensureServer } from './serve';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .requiredOption('--workspace <dir>')
    .option('--home <dir>')
    .action(async (options: { readonly workspace: string; readonly home?: string }) => {
      const workspace = normalize(await realpath(resolve(options.workspace)));
      const connection = await ensureServer({ homeDir: resolveKikiHome(options.home), workspace });
      const seat = await createSeatOnConnection(connection, {
        workspace,
        principal: mcpPrincipal(workspace),
      });
      await runKikiMcpStdio({
        endpoint: connection.url,
        token: connection.token,
        delegationToken: seat.delegationToken,
        sessionId: seat.sessionId,
        workspacePath: seat.workspace,
      });
    });
}

export function mcpPrincipal(workspace: string): string {
  const canonical = platform() === 'win32'
    ? normalize(workspace).toLocaleLowerCase('en-US')
    : normalize(workspace);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `mcp:${key}`;
}
