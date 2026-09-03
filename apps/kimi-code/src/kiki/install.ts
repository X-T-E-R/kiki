import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { Command } from 'commander';

import { getDataDir } from '../utils/paths';
import { mcpPrincipal } from './mcp';
import { createSeatOnConnection } from './seat';
import { ensureServer } from './serve';

export type InstallClient = 'cursor' | 'claude' | 'codex' | 'generic';

interface McpCommandConfig {
  readonly command: 'kiki';
  readonly args: readonly ['mcp', '--workspace', string];
}

export function registerSeatInstallCommand(seat: Command): void {
  seat
    .command('install')
    .requiredOption('--client <client>', '', parseClient)
    .requiredOption('--workspace <dir>')
    .option('--transport <transport>', '', parseTransport, 'stdio')
    .action(async (options: {
      readonly client: InstallClient;
      readonly workspace: string;
      readonly transport: 'stdio';
    }) => {
      const workspace = resolve(options.workspace);
      const connection = await ensureServer({ homeDir: getDataDir(), workspace });
      await createSeatOnConnection(connection, {
        workspace,
        principal: mcpPrincipal(workspace),
      });
      const config = mcpCommandConfig(workspace);
      if (options.client === 'cursor') {
        await upsertMcpServer(join(homedir(), '.cursor', 'mcp.json'), config);
        return;
      }
      if (options.client === 'claude') {
        await upsertMcpServer(join(workspace, '.mcp.json'), config);
        return;
      }
      if (options.client === 'codex') {
        process.stdout.write(codexConfigSnippet(config));
        return;
      }
      process.stdout.write(`${JSON.stringify({ mcpServers: { kiki: config } }, null, 2)}\n`);
    });
}

export function mcpCommandConfig(workspace: string): McpCommandConfig {
  return { command: 'kiki', args: ['mcp', '--workspace', workspace] };
}

export async function upsertMcpServer(
  filePath: string,
  server: McpCommandConfig,
): Promise<string | undefined> {
  let root: Record<string, unknown> = {};
  let backupPath: string | undefined;
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('MCP configuration root must be an object.');
    root = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const rawServers = root['mcpServers'];
  if (rawServers !== undefined && !isRecord(rawServers)) {
    throw new Error('mcpServers must be an object.');
  }
  const existing = rawServers ?? {};
  if (Object.prototype.hasOwnProperty.call(existing, 'kiki')) {
    backupPath = `${filePath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(filePath, backupPath);
  }
  const next = { ...root, mcpServers: { ...existing, kiki: server } };
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmpPath, filePath);
  return backupPath;
}

function codexConfigSnippet(config: McpCommandConfig): string {
  return [
    '[mcp_servers.kiki]',
    `command = ${JSON.stringify(config.command)}`,
    `args = [${config.args.map((value) => JSON.stringify(value)).join(', ')}]`,
    '',
  ].join('\n');
}

function parseClient(value: string): InstallClient {
  if (value === 'cursor' || value === 'claude' || value === 'codex' || value === 'generic') {
    return value;
  }
  throw new Error('Invalid client.');
}

function parseTransport(value: string): 'stdio' {
  if (value === 'stdio') return value;
  throw new Error('Invalid transport.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
