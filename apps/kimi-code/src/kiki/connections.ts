import { readFile } from 'node:fs/promises';
import { createKlient } from '@kiki/klient/http';
import { connectionAddInputSchema, connectionInviteInputSchema, connectionPairInputSchema, parsePairingUri, sshRemoteProfileSchema, sshConnectionRegisterInputSchema } from '@kiki/protocol';
import type { Command } from 'commander';
import { ensureServer } from './serve';
import { resolveKikiHome } from './home';

async function inputJson(path: string): Promise<unknown> {
  if (path !== '-') return JSON.parse(await readFile(path, 'utf8')) as unknown;
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 16384) throw new Error('Connection input exceeds 16 KiB.');
  }
  return JSON.parse(text) as unknown;
}

function compactFingerprint(value: string): string {
  return `${value.slice(0, 16)}…${value.slice(-8)}`;
}

export function registerConnectionsCommand(program: Command): void {
  const group = program.command('connections').description('Manage directed connections for this local Kiki home.').option('--home <dir>', 'Local source/provider home.');
  const run = async (command: Command, action: (connections: NonNullable<ReturnType<typeof createKlient>['rest']>['connections']) => Promise<unknown>) => {
    const homeDir = resolveKikiHome(command.optsWithGlobals()['home'] as string | undefined);
    const connection = await ensureServer({ homeDir });
    const client = createKlient({ endpoint: connection.url, token: connection.token });
    try { process.stdout.write(JSON.stringify(await action(client.rest!.connections), null, 2) + '\n'); }
    finally { await client.close(); }
  };
  group.command('status').description('Show source identity, inbound grants and outbound connection state.').action(async (_options, command: Command) => run(command, async (c) => ({ identity: (await c.handshake()).identity, inbound: await c.inbound(), outbound: await c.list() })));
  const inbound = group.command('inbound').description('Allow selected Kiki homes to connect here; off by default.');
  inbound.command('enable').description('Open the inbound gate; still requires an invitation for each source.').action(async (_options, command: Command) => run(command, (c) => c.setInbound(true)));
  inbound.command('disable').description('Close the gate and stop peer reads/streams; keep local work running.').action(async (_options, command: Command) => run(command, (c) => c.setInbound(false)));
  inbound.command('invite').requiredOption('--input <file>', 'JSON {source:{homeId,hostId,protocol:1},label}; - reads stdin.').description('Approve one source and print a short-lived, one-use invitation.').action(async (options: { input: string }, command: Command) => run(command, async (c) => c.invite(connectionInviteInputSchema.parse(await inputJson(options.input)))));
  inbound.command('revoke <grantId>').description('Revoke this source without affecting other grants.').action(async (grantId: string, _options, command: Command) => run(command, (c) => c.revoke(grantId)));
  group.command('add').requiredOption('--input <file>', 'Connection JSON including target identity, ownerToken and invitation; - reads stdin.').description('Verify a target and save its credentials only in this source backend.').action(async (options: { input: string }, command: Command) => run(command, async (c) => c.add(connectionAddInputSchema.parse(await inputJson(options.input)))));
  group.command('remove <connectionId>').description('Remove local credentials and leases; do not stop the remote Kiki.').action(async (id: string, _options, command: Command) => run(command, (c) => c.remove(id)));
  group.command('enable <connectionId>').description('Enable an existing outgoing connection.').action(async (id: string, _options, command: Command) => run(command, (c) => c.setEnabled(id, true)));
  group.command('disable <connectionId>').description('Stop this outgoing connection without revoking other connections.').action(async (id: string, _options, command: Command) => run(command, (c) => c.setEnabled(id, false)));
  group.command('retry <connectionId>').description('Verify credentials and identity again after a paused connection.').action(async (id: string, _options, command: Command) => run(command, (c) => c.retry(id)));
  const ssh = group.command('ssh').description('Inspect and explicitly provision an SSH-backed connection; do not install remote software.');
  ssh.command('plan').requiredOption('--input <file>', 'SSH profile JSON; - reads stdin.').description('Query an existing remote Kiki without starting it or opening inbound access.').action(async (options: { input: string }, command: Command) => run(command, async (c) => c.sshPlan(sshRemoteProfileSchema.parse(await inputJson(options.input)))));
  ssh.command('execute <planId>').option('--ensure', 'Start remote Kiki only if needed; it stays running until explicitly stopped.').description('Attach to the planned server, or confirm a persistent background start with --ensure.').action(async (id: string, options: { ensure?: boolean }, command: Command) => run(command, (c) => c.sshExecute(id, { ensure: options.ensure === true })));
  ssh.command('register').requiredOption('--input <file>', 'JSON {purpose,planId,label}; gui also requires enableInbound and may set backgroundSummary.').description('Register the ready plan for one purpose; GUI credentials stay in this backend, bridge policy is approved separately.').action(async (options: { input: string }, command: Command) => run(command, async (c) => c.sshRegister(sshConnectionRegisterInputSchema.parse(await inputJson(options.input)))));
  ssh.command('status').description('Show only this source backend’s SSH lease state.').action(async (_options, command: Command) => run(command, (c) => c.sshStatus()));
  program.command('pair [endpoint] [code]').description('Print a 10-minute pairing code, or connect to one with an address and that code.').option('--home <dir>', 'Local source/provider home.').option('--label <name>', 'Name for the connection on this Kiki.').action(async (endpoint: string | undefined, code: string | undefined, options: { label?: string; home?: string }, command: Command) => {
    const homeDir = resolveKikiHome((options.home ?? command.optsWithGlobals()['home']) as string | undefined);
    const connection = await ensureServer({ homeDir });
    const client = createKlient({ endpoint: connection.url, token: connection.token });
    try {
      const connections = client.rest!.connections;
      if (endpoint === undefined && code === undefined) {
        const created = await connections.createPairCode({});
        const minutes = Math.max(1, Math.round((created.expiresAt - Date.now()) / 60_000));
        const addresses = created.suggestedEndpoints.length > 0 ? created.suggestedEndpoints.join('\n') : '(no direct address found)';
        const fingerprintLine = created.tlsFingerprint === undefined ? '' : `TLS fingerprint: ${compactFingerprint(created.tlsFingerprint)}\n`;
        process.stdout.write(`Pairing code: ${created.code} (valid for ${minutes} minutes)\nAddress:\n${addresses}\n${fingerprintLine}`);
        return;
      }
      const parsedUri = endpoint !== undefined && code === undefined ? parsePairingUri(endpoint) : undefined;
      const targetEndpoint = parsedUri?.endpoint ?? endpoint;
      const targetCode = parsedUri?.code ?? code;
      if (targetEndpoint === undefined || targetCode === undefined) throw new Error('Usage: kiki pair <endpoint> <code>');
      const record = await connections.pair(connectionPairInputSchema.parse({ endpoint: targetEndpoint, code: targetCode, ...options.label === undefined ? {} : { label: options.label }, backgroundSummary: true, fingerprint: parsedUri?.fingerprint }));
      const tlsFingerprint = record.fingerprintToVerify ?? record.pinnedFingerprint;
      const fingerprintLine = tlsFingerprint === undefined
        ? ''
        : `\n${record.fingerprintToVerify === undefined ? 'Pinned TLS fingerprint' : 'TLS fingerprint to verify'}: ${compactFingerprint(tlsFingerprint)}`;
      process.stdout.write(`Connected to ${record.label} at ${record.endpoint}.${fingerprintLine}\n`);
    } finally { await client.close(); }
  });
}
