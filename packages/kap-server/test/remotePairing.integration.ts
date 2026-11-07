import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectionKlient, createKlient } from '@kiki/klient/http';
import { startServer, type RunningServer } from '../src/start';
import { rotateServerToken } from '../src/services/auth/persistentToken';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const servers: RunningServer[] = []; const homes: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0).toReversed()) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
async function boot(disableAuth = false): Promise<RunningServer> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-pair-')); homes.push(home);
  await mkdir(join(home, 'workspace'), { recursive: true });
  const server = await startServer({ homeDir: home, port: 0, hostIdentity: TEST_HOST_IDENTITY, logLevel: 'silent', disableAuth });
  servers.push(server); return server;
}
const endpoint = (server: RunningServer) => `http://127.0.0.1:${server.port}`;
async function claim(server: RunningServer, body: unknown, token?: string) {
  return fetch(endpoint(server) + '/api/remote-connections/pair/claim', {
    method: 'POST', headers: { 'content-type': 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } }, body: JSON.stringify(body),
  });
}

describe('short-code pairing on two real servers', () => {
  it('pairs GUI and bridge together, keeps an old connection on the server token, and heals inbound without replaying', async () => {
    const source = await boot(); const target = await boot();
    const sourceClient = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    const targetClient = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const workspace = join(homes[0]!, 'workspace');
    try {
      await sourceClient.rest!.config.patch({ thread_communication: { enabled: true } });
      await targetClient.rest!.config.patch({ thread_communication: { enabled: true } });
      await sourceClient.global.sessions.create({ sessionId: 'pair-source', workDir: workspace });
      await targetClient.global.sessions.create({ sessionId: 'pair-target', workDir: join(homes[1]!, 'workspace') });
      const created = await targetClient.rest!.connections.createPairCode({});
      expect(created.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
      expect(target.admission.status().enabled).toBe(true);
      const record = await sourceClient.rest!.connections.pair({ endpoint: endpoint(target), code: created.code, backgroundSummary: true });
      expect(record.purposes).toEqual(['gui', 'bridge']);
      expect(record.label.length).toBeGreaterThan(0);
      const secret = await source.remoteConnections.secrets.read<{ ownerToken: string; grant: string; grantId: string }>({ connectionId: record.credentialRef, purpose: 'gui' });
      expect(secret.ownerToken).toBe(secret.grant);
      expect(secret.ownerToken).not.toBe(target.authTokenService.getToken());
      expect((await targetClient.rest!.threadBridges.status()).inbound).toHaveLength(1);
      expect((await sourceClient.rest!.threadBridges.status()).outbound).toHaveLength(1);
      const paired = createConnectionKlient({ endpoint: endpoint(source), token: source.localOwnerToken, connectionId: record.id });
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      const invitation = await targetClient.rest!.connections.invite({ source: source.admission.identity, label: 'Legacy' });
      const legacy = await sourceClient.rest!.connections.add({ label: 'Legacy', endpoint: endpoint(target), target: target.admission.identity, ownerToken: target.authTokenService.getToken(), invitation: invitation.invitation, backgroundSummary: false });
      const legacySecret = await source.remoteConnections.secrets.read<{ ownerToken: string }>({ connectionId: legacy.credentialRef, purpose: 'gui' });
      expect(legacySecret.ownerToken).toBe(target.authTokenService.getToken());
      const legacyView = createConnectionKlient({ endpoint: endpoint(source), token: source.localOwnerToken, connectionId: legacy.id });
      await rotateServerToken(homes[1]!);
      await expect(legacyView.rest!.meta()).rejects.toThrow();
      expect(source.remoteConnections.get(legacy.id).state).toBe('authentication_required');
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      await target.admission.setEnabled(false);
      await expect(paired.rest!.meta()).rejects.toThrow('inbound_disabled');
      expect(source.remoteConnections.get(record.id)).toMatchObject({ state: 'offline', lastError: 'inbound_disabled' });
      await target.admission.setEnabled(true);
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      await target.admission.revoke(secret.grantId);
      await expect(paired.rest!.meta()).rejects.toThrow('connection_not_approved');
      expect(source.remoteConnections.get(record.id).state).toBe('authentication_required');
      await paired.close(); await legacyView.close();
    } finally { await sourceClient.close(); await targetClient.close(); }
  }, 120_000);

  it('limits public claims, burns a code, and refuses pairing when authentication is bypassed', async () => {
    const target = await boot(); const stranger = { homeId: '11111111-1111-4111-8111-111111111111', hostId: 'stranger', protocol: 1 as const };
    const created = await target.admission.createPairCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await claim(target, { code: 'BBBB-BBBB', source: stranger, sourceLabel: 'Stranger' });
      expect(response.status).toBe(401);
      expect((await response.json() as { msg: string }).msg).toBe('invalid_pairing_code');
    }
    const limited = await claim(target, { code: created.code, source: stranger, sourceLabel: 'Stranger' });
    expect(limited.status).toBe(429);
    expect((await limited.json() as { msg: string }).msg).toBe('pairing_rate_limited');
    const dangerous = await boot(true);
    const refused = await fetch(endpoint(dangerous) + '/api/remote-connections/inbound/pair-code', { method: 'POST', headers: { authorization: `Bearer ${dangerous.localOwnerToken}`, 'content-type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(403);
    expect((await refused.json() as { msg: string }).msg).toBe('dangerous_auth_bypass');
    const open = await claim(dangerous, { code: 'K9F2-7X4M', source: stranger, sourceLabel: 'Stranger' });
    expect(open.status).toBe(403);
  }, 120_000);
});

function runCli(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const require = createRequire(import.meta.url);
  const cli = fileURLToPath(new URL('../../../apps/kimi-code/src/main.ts', import.meta.url));
  const loader = new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--import', loader, cli, ...args], {
      env: { ...process.env, KIKI_HOME: home, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../apps/kimi-code/tsconfig.dev.json', import.meta.url)) },
      cwd: home,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('kiki pair', () => {
  it('prints a code and connects another home with the same contract', async () => {
    const target = await boot(); const source = await boot();
    const issued = await runCli(homes[0]!, ['pair', '--home', homes[0]!]);
    expect(issued.code, issued.stderr).toBe(0);
    const code = /Pairing code: ([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4})/.exec(issued.stdout)?.[1];
    expect(code, issued.stdout).toBeTruthy();
    const connected = await runCli(homes[1]!, ['pair', endpoint(target), code!, '--home', homes[1]!]);
    expect(connected.code, connected.stderr + connected.stdout).toBe(0);
    expect(connected.stdout).toMatch(/^Connected to .+ at http:\/\/127\.0\.0\.1:\d+\.\r?\n$/);
    expect(source.remoteConnections.list().some((record) => record.endpoint === endpoint(target))).toBe(true);
    expect(target.admission.status().grants.some((grant) => grant.status === 'approved')).toBe(true);
  }, 180_000);
});
