import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { platform } from 'node:os';
import { normalize, resolve } from 'node:path';

import { createExternalClientStdioBridge, kikiMcpConfigFromEnv, runExternalClientStdioBridge, runKikiMcpStdio } from '@kiki/kap-server';
import type { Command } from 'commander';

import { resolveKikiHome } from './home';
import { mcpModeError } from './mcpMode';
import { createSeatOnConnection, daemonRequest } from './seat';
import { ensureServer } from './serve';

export interface McpCommandDependencies {
  readonly ensureServer?: typeof ensureServer;
  readonly daemonRequest?: typeof daemonRequest;
  readonly createExternalClientStdioBridge?: typeof createExternalClientStdioBridge;
  readonly runKikiMcpStdio?: typeof runKikiMcpStdio;
  readonly kikiMcpConfigFromEnv?: typeof kikiMcpConfigFromEnv;
  readonly createSeatOnConnection?: typeof createSeatOnConnection;
}

export function registerMcpCommand(program: Command, dependencies: McpCommandDependencies = {}): void {
  const ensureServerImpl = dependencies.ensureServer ?? ensureServer;
  const daemonRequestImpl = dependencies.daemonRequest ?? daemonRequest;
  const createExternalClientStdioBridgeImpl = dependencies.createExternalClientStdioBridge ?? createExternalClientStdioBridge;
  const runKikiMcpStdioImpl = dependencies.runKikiMcpStdio ?? runKikiMcpStdio;
  const kikiMcpConfigFromEnvImpl = dependencies.kikiMcpConfigFromEnv ?? kikiMcpConfigFromEnv;
  const createSeatOnConnectionImpl = dependencies.createSeatOnConnection ?? createSeatOnConnection;
  program
    .command('mcp')
    .description('Run a Kiki MCP server over stdio.')
    .option('--workspace <dir>', 'Workspace for the delegation MCP mode.')
    .option('--home <dir>')
    .option('--attached', 'Use an existing host-provisioned delegation binding')
    .option('--client <id>', 'Use an external-client connection through the local owner channel.')
    .option('--tools', 'Expose the external-client native tool catalog over stdio.')
    .action(async (options: { readonly workspace?: string; readonly home?: string; readonly attached?: boolean; readonly client?: string; readonly tools?: boolean }) => {
      const modeError = mcpModeError(options);
      if (modeError !== undefined) throw new Error(modeError);
      if (options.client !== undefined) {
        const connection = await ensureServerImpl({ homeDir: resolveKikiHome(options.home) });
        const bridge = {
          connectionId: options.client,
          resolveCredential: (connectionId: string) => daemonRequestImpl<ExternalClientLocalCredential>(
            connection,
            'POST',
            `/api/external-clients/${encodeURIComponent(connectionId)}/credential`,
            {},
          ),
        };
        if (dependencies.createExternalClientStdioBridge !== undefined) {
          await createExternalClientStdioBridgeImpl(bridge);
          return;
        }
        await finishMcpStdio(() => runExternalClientStdioBridge(bridge));
        return;
      }
      if (options.attached === true) {
        await finishMcpStdio(
          () => runKikiMcpStdioImpl(kikiMcpConfigFromEnvImpl(process.env)),
          dependencies.runKikiMcpStdio === undefined,
        );
        return;
      }
      if (options.workspace === undefined) throw new Error('--workspace is required for delegation MCP mode.');
      const workspace = normalize(await realpath(resolve(options.workspace)));
      const connection = await ensureServerImpl({ homeDir: resolveKikiHome(options.home), workspace });
      const seat = await createSeatOnConnectionImpl(connection, {
        workspace,
        principal: mcpPrincipal(workspace),
      });
      await finishMcpStdio(
        () => runKikiMcpStdioImpl({
          endpoint: connection.url,
          delegationToken: seat.delegationToken,
          sessionId: seat.sessionId,
          workspacePath: seat.workspace,
        }),
        dependencies.runKikiMcpStdio === undefined,
      );
    });
}

async function finishMcpStdio(run: () => Promise<void>, exitProcess = true): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!exitProcess) throw error;
    const code = process.exitCode;
    if (typeof code !== 'number' || code <= 0) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    process.exit(code);
  }
  if (exitProcess) process.exit(0);
}

type ExternalClientLocalCredential = {
  readonly mcpUrl: string;
  readonly token: string;
};

export function mcpPrincipal(workspace: string): string {
  const canonical = platform() === 'win32'
    ? normalize(workspace).toLocaleLowerCase('en-US')
    : normalize(workspace);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `mcp:${key}`;
}
