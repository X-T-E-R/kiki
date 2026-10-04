import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '@kiki/kap-server';
import { createKlient } from '@kiki/klient/http';
import { registerKikiCommands } from '../../src/kiki/register';

it('registers and runs bridge owner management through the real CLI and daemon without GUI authority', async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'bridge-cli-')); const servers: RunningServer[] = [];
  const clients: ReturnType<typeof createKlient>[] = [];
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const run = async (...args: string[]) => {
    output.mockClear(); const program = new Command(); registerKikiCommands(program);
    expect(program.commands.filter((command) => command.name() === 'bridges')).toHaveLength(1);
    await program.parseAsync(['node', 'kiki', 'bridges', ...args]);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as unknown;
  };
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    for (const name of ['source', 'target']) {
      const home = join(root, name); await mkdir(home);
      await writeFile(join(home, 'config.toml'), '[thread_communication]\nenabled = true\n[search]\nenabled = false\n');
      const server = await startServer({ homeDir: home, port: 0, logLevel: 'silent', hostIdentity: { productName: 'test-host', version: '0.0.0-test', platform: 'test_platform' } }); servers.push(server);
      clients.push(createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken }));
    }
    const [source, target] = servers; const [a, b] = clients;
    const sourceWorkspace = await vi.waitFor(() => a!.global.workspaces.createOrTouch({ root: workspace }), { timeout: 10000 });
    const targetWorkspace = await vi.waitFor(() => b!.global.workspaces.createOrTouch({ root: workspace }), { timeout: 10000 });
    expect(await run('--home', join(root, 'source'), 'status')).toMatchObject({ inboundEnabled: false, outbound: [] });
    await b!.rest!.connections.setInbound(true);
    const policyPath = join(root, 'policy.json');
    await writeFile(policyPath, JSON.stringify({ source: source!.admission.identity, target: target!.admission.identity,
      sourceScope: { workspaceId: sourceWorkspace.id }, targetScope: { workspaceId: targetWorkspace.id },
      operations: ['send'], expiresAt: Date.now() + 3600000, label: 'CLI fixture', location: 'network' }));
    const approved = await run('--home', join(root, 'target'), 'approve', '--input', policyPath) as { grant: { id: string }; credential: string };
    expect(approved.credential).toHaveLength(43);
    const targetPath = join(root, 'target.json'); await writeFile(targetPath, JSON.stringify({ label: 'CLI fixture', endpoint: `http://127.0.0.1:${target!.port}`, target: target!.admission.identity }));
    const descriptor = await run('--home', join(root, 'source'), 'target', '--input', targetPath) as { id: string; purposes: string[] };
    expect(descriptor.purposes).toEqual(['bridge']);
    const installPath = join(root, 'install.json'); await writeFile(installPath, JSON.stringify({ connectionId: descriptor.id, ...approved }));
    expect(await run('--home', join(root, 'source'), 'install', '--input', installPath)).toMatchObject({ enabled: true, grant: { id: approved.grant.id } });
    const status = await run('--home', join(root, 'source'), 'outbound', 'disable', approved.grant.id);
    expect(status).toMatchObject({ outbound: [{ enabled: false }] }); expect(JSON.stringify(status)).not.toContain(approved.credential);
    expect(await run('--home', join(root, 'source'), 'receipts', '--limit', '1')).toEqual({ items: [] });
    expect(await run('--home', join(root, 'target'), 'inbound', 'revoke', approved.grant.id)).toMatchObject({ inbound: [{ revoked: true, enabled: false }] });
  } finally {
    output.mockRestore(); for (const client of clients) await client.close();
    for (const server of servers.reverse()) await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 60000);
