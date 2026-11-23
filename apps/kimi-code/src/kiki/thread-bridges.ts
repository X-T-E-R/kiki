import { readFile } from 'node:fs/promises';
import { createKlient } from '@kiki/klient/http';
import { bridgePolicySchema, bridgeInstallSchema, bridgeTargetInputSchema, localBridgePolicySchema } from '@kiki/protocol';
import type { Command } from 'commander';
import { ensureServer } from './serve';
import { resolveKikiHome } from './home';

async function inputJson(path: string): Promise<unknown> {
  let text = '';
  if (path !== '-') text = await readFile(path, 'utf8');
  else for await (const chunk of process.stdin) { text += String(chunk); if (Buffer.byteLength(text) > 16384) throw new Error('Bridge input exceeds 16 KiB.'); }
  if (Buffer.byteLength(text) > 16384) throw new Error('Bridge input exceeds 16 KiB.');
  return JSON.parse(text) as unknown;
}
export interface ThreadBridgesCommandDependencies {
  readonly ensureServer?: typeof ensureServer;
  readonly createKlient?: typeof createKlient;
  readonly stdout?: { write(chunk: string): unknown };
}

export function registerThreadBridgesCommand(
  program: Command,
  dependencies: ThreadBridgesCommandDependencies = {},
): void {
  const group = program.command('bridges').description('Manage directed thread bridges for the executing home; separate from GUI connections.').option('--home <dir>', 'Local source/provider home.');
  const run = async (command: Command, action: (bridges: NonNullable<ReturnType<typeof createKlient>['rest']>['threadBridges']) => Promise<unknown>) => {
    const homeDir = resolveKikiHome(command.optsWithGlobals()['home'] as string | undefined);
    const connection = await (dependencies.ensureServer ?? ensureServer)({ homeDir });
    const client = (dependencies.createKlient ?? createKlient)({ endpoint: connection.url, token: connection.token });
    const stdout = dependencies.stdout ?? process.stdout;
    try { stdout.write(JSON.stringify(await action(client.rest!.threadBridges), null, 2) + '\n'); }
    finally { await client.close(); }
  };
  group.command('status').action(async (_options, command: Command) => run(command, (b) => b.status()));
  group.command('target').requiredOption('--input <file>', 'JSON {label,endpoint,target}; - reads stdin.').description('Register a fixed target without obtaining GUI access.').action(async (options: { input: string }, command: Command) => run(command, async (b) => b.registerTarget(bridgeTargetInputSchema.parse(await inputJson(options.input)))));
  group.command('approve')
    .requiredOption('--input <file>', 'Bridge policy JSON; concrete source/target threads by default.')
    .option('--allow-yolo', 'Set permissionCeiling to yolo on the approved bridge grant.')
    .description('Provider owner approves a one-way scope and prints its dedicated credential once; protect this output. Omitting sessionId explicitly authorizes future threads in that workspace.')
    .action(async (options: { input: string; allowYolo?: boolean }, command: Command) => run(command, async (b) => {
      const raw = await inputJson(options.input);
      const policy = bridgePolicySchema.parse(
        options.allowYolo === true && raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...raw, permissionCeiling: 'yolo' }
          : raw,
      );
      return b.approve(policy);
    }));
  group.command('install').requiredOption('--input <file>', 'JSON {connectionId,grant,credential}; use protected file or stdin, never a command-line token.').description('Source owner installs a dedicated grant and credential into the source backend.').action(async (options: { input: string }, command: Command) => run(command, async (b) => b.install(bridgeInstallSchema.parse(await inputJson(options.input)))));
  group.command('local').requiredOption('--input <file>', 'JSON {spaceId,sourceScope,targetScope,operations,expiresAt,label,...limits}.').description('Explicitly approve and provision a registered local space; its daemon must be running and inbound enabled. Daemon startup is separate from model wake.').action(async (options: { input: string }, command: Command) => run(command, async (b) => b.provisionLocal(localBridgePolicySchema.parse(await inputJson(options.input)))));
  for (const direction of ['inbound', 'outbound'] as const) {
    const commands = group.command(direction);
    commands.command('enable <bridgeId>').action(async (id: string, _options, command: Command) => run(command, (b) => b.setEnabled(direction, id, true)));
    commands.command('disable <bridgeId>').action(async (id: string, _options, command: Command) => run(command, (b) => b.setEnabled(direction, id, false)));
    commands.command('revoke <bridgeId>').action(async (id: string, _options, command: Command) => run(command, (b) => b.revoke(direction, id)));
  }
  group.command('receipts').option('--cursor <cursor>', 'Opaque receipt continuation.').option('--limit <n>', 'Page size 1-100.', '50').action(async (options: { cursor?: string; limit: string }, command: Command) => run(command, (b) => b.receipts({ cursor: options.cursor, limit: Number(options.limit) })));
  group.command('retry').description('Retry durable pending records using their original key and source sequence.').action(async (_options, command: Command) => run(command, (b) => b.retry()));
}
