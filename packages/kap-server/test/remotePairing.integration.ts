import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectionKlient, createKlient } from '@kiki/klient/http';
import { formatPairingUri, parsePairingUri } from '@kiki/protocol';
import { IConfigService, ISessionManager, IThreadCommunicationService, IThreadMailboxStore, IWorkspaceService } from '@kiki/agent-core-v2';
import { SEND_PEER_THREAD_MESSAGE, type IThreadPeerSendCapability } from '@kiki/agent-core-v2/app/threadCommunication/peerThreadCapability';
import { THREAD_COMMUNICATION_SECTION } from '@kiki/agent-core-v2/app/threadCommunication/configSection';
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
  it('pairs GUI and bridge over a real non-loopback endpoint, defers thread enablement until claim succeeds, and revokes only the paired bridge grant', async () => {
    const source = await boot(); const target = await boot();
    const sourceClient = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    const targetClient = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const sourceWorkDir = join(homes[0]!, 'workspace');
    const targetWorkDir = join(homes[1]!, 'workspace');
    const extraSourceWorkDir = join(homes[0]!, 'workspace-extra');
    await mkdir(extraSourceWorkDir, { recursive: true });
    try {
      await sourceClient.global.sessions.create({ sessionId: 'pair-source-extra', workDir: extraSourceWorkDir });
      await sourceClient.global.sessions.create({ sessionId: 'pair-source', workDir: sourceWorkDir });
      await targetClient.global.sessions.create({ sessionId: 'pair-target', workDir: targetWorkDir });
      await target.core.accessor.get(ISessionManager).close('pair-target');
      const sourceConfig = source.core.accessor.get(IConfigService);
      const targetConfig = target.core.accessor.get(IConfigService);
      expect(sourceConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      expect(targetConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      const created = await targetClient.rest!.connections.createPairCode({});
      expect(created.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
      expect(target.admission.status().enabled).toBe(true);
      expect(created.suggestedEndpoints.length).toBeGreaterThan(0);
      const nonLoopback = created.suggestedEndpoints[0]!;
      expect(['127.0.0.1', 'localhost', '::1', '[::1]']).not.toContain(new URL(nonLoopback).hostname);
      const pairUri = formatPairingUri({ endpoint: nonLoopback, code: created.code });
      expect(parsePairingUri(pairUri)).toEqual({ endpoint: nonLoopback, code: created.code });
      const unauthOwnerRoute = await fetch(`${nonLoopback}/api/remote-connections`);
      expect(unauthOwnerRoute.status).toBe(401);
      const nonLoopbackAnonHandshake = await fetch(`${nonLoopback}/api/remote-connections/handshake`, { headers: { accept: 'application/json' } });
      expect(nonLoopbackAnonHandshake.status).toBe(200);
      expect(nonLoopbackAnonHandshake.headers.get('cache-control')).toBe('no-store');
      const nonLoopbackAnonData = (await nonLoopbackAnonHandshake.json() as { data: { identity: { homeId: string; hostId: string; protocol: number }; targetLabel?: string; serverId: string; inboundEnabled: boolean } }).data;
      expect(nonLoopbackAnonData.identity).toEqual(target.admission.identity);
      expect(nonLoopbackAnonData.targetLabel).toBeUndefined();
      const nonLoopbackBadBearer = await fetch(`${nonLoopback}/api/remote-connections/handshake`, { headers: { accept: 'application/json', authorization: 'Bearer wrong-token' } });
      expect(nonLoopbackBadBearer.status).toBe(401);
      await expect(sourceClient.rest!.connections.pair({ endpoint: nonLoopback, code: 'BBBB-BBBB', backgroundSummary: true })).rejects.toThrow('invalid_pairing_code');
      expect(sourceConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      expect(targetConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      const record = await sourceClient.rest!.connections.pair({ endpoint: pairUri, code: created.code, backgroundSummary: true });
      expect(record.endpoint).toBe(nonLoopback);
      expect(record.purposes).toEqual(['gui', 'bridge']);
      expect(record.label.length).toBeGreaterThan(0);
      expect(sourceConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).toBe(true);
      expect(targetConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).toBe(true);
      const secret = await source.remoteConnections.secrets.read<{ ownerToken: string; grant: string; grantId: string }>({ connectionId: record.credentialRef, purpose: 'gui' });
      expect(secret.ownerToken).toBe(secret.grant);
      expect(secret.ownerToken).not.toBe(target.authTokenService.getToken());
      expect(secret.ownerToken).not.toBe(target.localOwnerToken);
      const peerOwnerAttempt = await fetch(`${nonLoopback}/api/remote-connections`, { headers: { authorization: `Bearer ${secret.ownerToken}`, 'x-kiki-connection-grant': secret.grant } });
      expect(peerOwnerAttempt.status).toBe(403);
      const peerShutdownAttempt = await fetch(`${nonLoopback}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${target.localOwnerToken}` } });
      expect(peerShutdownAttempt.status).toBe(403);
      const targetBridgesBefore = await targetClient.rest!.threadBridges.status();
      expect(targetBridgesBefore.inbound).toHaveLength(1);
      expect((await sourceClient.rest!.threadBridges.status()).outbound).toHaveLength(1);
      const mobileCreated = await targetClient.rest!.connections.createPairCode({});
      const mobileScanned = parsePairingUri(formatPairingUri({ endpoint: nonLoopback, code: mobileCreated.code }))!;
      const mobileClaimRes = await fetch(`${mobileScanned.endpoint}/api/remote-connections/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: mobileScanned.code, source: { homeId: '22222222-2222-4222-8222-222222222222', hostId: 'mobile-device', protocol: 1 }, sourceLabel: 'Mobile Phone', requestBridge: false }),
      });
      expect(mobileClaimRes.status).toBe(200);
      const mobileClaimed = (await mobileClaimRes.json() as { data: { peerToken: string; grantId: string; bridge?: unknown } }).data;
      expect(mobileClaimed.bridge).toBeUndefined();
      expect((await targetClient.rest!.threadBridges.status()).inbound).toHaveLength(1);
      const mobileMetaRes = await fetch(`${mobileScanned.endpoint}/api/meta`, { headers: { authorization: `Bearer ${mobileClaimed.peerToken}`, 'x-kiki-connection-grant': mobileClaimed.peerToken } });
      expect(mobileMetaRes.status).toBe(200);
      const sourceWorkspaces = await source.core.accessor.get(IWorkspaceService).list();
      const targetWorkspaces = await target.core.accessor.get(IWorkspaceService).list();
      const primarySourceWorkspace = sourceWorkspaces.find((ws) => ws.root === sourceWorkDir) ?? sourceWorkspaces[0]!;
      const extraSourceWorkspace = sourceWorkspaces.find((ws) => ws.root === extraSourceWorkDir) ?? sourceWorkspaces[1]!;
      const targetWorkspace = targetWorkspaces[0]!;
      const separateBridge = await targetClient.rest!.threadBridges.approve({
        source: source.admission.identity,
        target: target.admission.identity,
        sourceScope: { workspaceId: extraSourceWorkspace.id, sessionId: 'pair-source-extra' },
        targetScope: { workspaceId: targetWorkspace.id, sessionId: 'pair-target' },
        operations: ['read', 'send', 'wait'],
        expiresAt: Date.now() + 600_000,
        pendingLimit: 10,
        messagesPerMinute: 20,
        location: 'network',
        label: 'Same Identity Separate Grant',
      });
      await sourceClient.rest!.threadBridges.install({ connectionId: record.id, grant: separateBridge.grant, credential: separateBridge.credential });
      const sourceThreads = source.core.accessor.get(IThreadCommunicationService);
      const peerSend = sourceThreads as unknown as IThreadPeerSendCapability;
      const listed = await sourceThreads.listThreads({ caller: { workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' }, connectionId: record.id });
      const targetThread = listed.threads.find((item) => item.ref.sessionId === 'pair-target');
      expect(targetThread?.ref).toMatchObject({ hostId: target.admission.identity.hostId, workspaceId: targetWorkspace.id, sessionId: 'pair-target', connectionId: record.id });
      const sent = await peerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: source.admission.identity.hostId, workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' },
        target: targetThread!.ref,
        content: 'hello over non-loopback pair',
        idempotencyKey: 'pair-send-1',
      });
      expect(sent.delivery).toBe('delivered');
      const targetMailbox = target.core.accessor.get(IThreadMailboxStore);
      const mailboxBefore = await targetMailbox.readMessages({ group: 'session:pair-target', limit: 10 });
      expect(mailboxBefore.items).toHaveLength(1);
      expect(mailboxBefore.items[0]!.message.producer).toMatchObject({ kind: 'bridged_peer', sourceHomeId: source.admission.identity.homeId, bridgeId: targetBridgesBefore.inbound[0]!.id });
      const paired = createConnectionKlient({ endpoint: endpoint(source), token: source.localOwnerToken, connectionId: record.id });
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      const invitation = await targetClient.rest!.connections.invite({ source: source.admission.identity, label: 'Legacy' });
      const legacy = await sourceClient.rest!.connections.add({ label: 'Legacy', endpoint: nonLoopback, target: target.admission.identity, ownerToken: target.authTokenService.getToken(), invitation: invitation.invitation, backgroundSummary: false });
      const legacySecret = await source.remoteConnections.secrets.read<{ ownerToken: string }>({ connectionId: legacy.credentialRef, purpose: 'gui' });
      expect(legacySecret.ownerToken).toBe(target.authTokenService.getToken());
      const legacyView = createConnectionKlient({ endpoint: endpoint(source), token: source.localOwnerToken, connectionId: legacy.id });
      await rotateServerToken(homes[1]!);
      await expect(legacyView.rest!.meta()).rejects.toThrow();
      expect(source.remoteConnections.get(legacy.id).state).toBe('authentication_required');
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      await target.admission.setEnabled(false);
      await expect(paired.rest!.meta()).rejects.toThrow('inbound_disabled');
      await expect(sourceThreads.listThreads({ caller: { workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' }, connectionId: record.id })).rejects.toThrow('inbound_disabled');
      expect(source.remoteConnections.get(record.id)).toMatchObject({ state: 'offline', lastError: 'inbound_disabled' });
      await target.admission.setEnabled(true);
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      const recoveredList = await sourceThreads.listThreads({ caller: { workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' }, connectionId: record.id });
      expect(recoveredList.threads.some((item) => item.ref.sessionId === 'pair-target')).toBe(true);
      expect((await targetMailbox.readMessages({ group: 'session:pair-target', limit: 10 })).items).toHaveLength(1);
      await target.admission.revoke(secret.grantId);
      await expect(paired.rest!.meta()).rejects.toThrow('connection_not_approved');
      expect(source.remoteConnections.get(record.id).state).toBe('authentication_required');
      await expect(sourceThreads.listThreads({ caller: { workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' }, bridgeId: targetBridgesBefore.inbound[0]!.id, connectionId: record.id })).rejects.toThrow('bridge_revoked');
      const revokedSend = await peerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: source.admission.identity.hostId, workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' },
        target: targetThread!.ref,
        content: 'after pair revoke',
        idempotencyKey: 'pair-send-revoked',
      });
      expect(revokedSend.delivery).toBe('undeliverable');
      expect((await targetMailbox.readMessages({ group: 'session:pair-target', limit: 10 })).items).toHaveLength(1);
      const targetBridgesAfter = await targetClient.rest!.threadBridges.status();
      expect(targetBridgesAfter.inbound.find((g) => g.id === targetBridgesBefore.inbound[0]!.id)?.revoked).toBe(true);
      expect(targetBridgesAfter.inbound.find((g) => g.id === separateBridge.grant.id)?.revoked).toBe(false);
      const separateList = await sourceThreads.listThreads({ caller: { workspaceId: extraSourceWorkspace.id, sessionId: 'pair-source-extra' }, bridgeId: separateBridge.grant.id, connectionId: record.id });
      expect(separateList.threads.map((item) => item.ref.sessionId)).toEqual(['pair-target']);
      await paired.close(); await legacyView.close();
    } finally { await sourceClient.close(); await targetClient.close(); }
  }, 120_000);

  it('limits public claims, burns a code, and refuses pairing when authentication is bypassed', async () => {
    const target = await boot(); const stranger = { homeId: '11111111-1111-4111-8111-111111111111', hostId: 'stranger', protocol: 1 as const };
    const anonymousHandshake = await fetch(endpoint(target) + '/api/remote-connections/handshake', { headers: { accept: 'application/json' } });
    expect(anonymousHandshake.status).toBe(200);
    expect(anonymousHandshake.headers.get('cache-control')).toBe('no-store');
    const handshakeBody = await anonymousHandshake.json() as { code: number; data: { identity: { homeId: string; hostId: string; protocol: number }; targetLabel?: string; serverId: string; inboundEnabled: boolean } };
    expect(handshakeBody.code).toBe(0);
    expect(handshakeBody.data.identity).toEqual(target.admission.identity);
    expect(handshakeBody.data.targetLabel).toBeUndefined();
    const authHandshake = await fetch(endpoint(target) + '/api/remote-connections/handshake', { headers: { accept: 'application/json', authorization: `Bearer ${target.localOwnerToken}` } });
    expect(authHandshake.status).toBe(200);
    const authHandshakeBody = await authHandshake.json() as { code: number; data: { identity: { homeId: string; hostId: string; protocol: number }; targetLabel?: string; serverId: string; inboundEnabled: boolean } };
    expect(typeof authHandshakeBody.data.targetLabel).toBe('string');
    expect(authHandshakeBody.data.targetLabel!.length).toBeGreaterThan(0);
    const badBearerHandshake = await fetch(endpoint(target) + '/api/remote-connections/handshake', { headers: { accept: 'application/json', authorization: 'Bearer wrong-token' } });
    expect(badBearerHandshake.status).toBe(401);
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
