import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpsServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createServer as createNetServer, createConnection, type Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { evictPinnedAgent, peerFetch } from '../src/services/connections/peerTls';
import { loadPeerTlsIdentity, spkiFingerprint } from '../src/services/connections/tlsIdentity';
import { pairOutbound, PeerListeners, type PairingHooks } from '../src/services/connections/pairing';
import { formatPairingUri, matchConnectionOperation, parsePairingUri } from '@kiki/protocol';
import { registerRemoteConnectionRoutes } from '../src/routes/remoteConnections';
import { AdmissionError, ConnectionAdmission } from '../src/services/connections/admission';
import { ConnectionAudience, isPeerProcedureAllowed } from '../src/services/connections/audience';
import { RemoteConnectionManager, validateEndpoint } from '../src/services/connections/manager';
import { directEndpoints, PairingRateLimit } from '../src/services/connections/pairing';
import * as privateFiles from '../src/services/auth/privateFiles';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const identity = (hostId: string) => ({ homeId: randomUUID(), hostId, protocol: 1 as const });
const savedConnectedAt = async (home: string, grantId: string): Promise<number | undefined> => {
  const state = JSON.parse(await readFile(join(home, 'server', 'inbound-connections.json'), 'utf8')) as { grants: Array<{ id: string; lastConnectedAt?: number }> };
  return state.grants.find((grant) => grant.id === grantId)?.lastConnectedAt;
};
const settleAdmissionWrites = async (admission: ConnectionAdmission): Promise<void> => {
  await (admission as unknown as { tail: Promise<unknown> }).tail;
};

describe('direct endpoints', () => {
  it('accepts LAN and Tailscale http and still requires https on the public internet', () => {
    expect(validateEndpoint('http://192.168.1.40:5523')).toBe('http://192.168.1.40:5523');
    expect(validateEndpoint('http://100.88.1.2:5523')).toBe('http://100.88.1.2:5523');
    expect(validateEndpoint('http://box.local:5523')).toBe('http://box.local:5523');
    expect(validateEndpoint('https://b.example.test')).toBe('https://b.example.test');
    expect(() => validateEndpoint('http://b.example.test')).toThrow('connection_requires_tls');
    expect(() => validateEndpoint('https://b.example.test/api')).toThrow('invalid_connection_endpoint');
  });

  it('does not fabricate LAN or Tailscale URLs from a loopback bind', () => {
    const fakeInterfaces = {
      eth0: [{ address: '192.168.1.40', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.1.40/24' }],
      tailscale0: [{ address: '100.88.1.2', netmask: '255.192.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:02', internal: false, cidr: '100.88.1.2/10' }],
    };
    expect(directEndpoints({ host: '127.0.0.1', port: 58627 }, [], fakeInterfaces)).toEqual([]);
    expect(directEndpoints({ host: '127.0.0.1', port: 58627 }, ['http://192.168.1.40:58627'], fakeInterfaces)).toEqual(['http://192.168.1.40:58627']);
    expect(directEndpoints({ host: '0.0.0.0', port: 58627 }, [], fakeInterfaces)).toEqual(['http://192.168.1.40:58627', 'http://100.88.1.2:58627']);
    expect(directEndpoints({ host: '192.168.1.40', port: 58627 }, [], fakeInterfaces)).toEqual(['http://192.168.1.40:58627']);
  });

  it('filters out Clash TUN, APIPA, loopback, and WSL/Hyper-V/Docker virtual switches while ranking LAN and Tailscale ahead of 172.16/12', () => {
    const windowsInterfaces = {
      'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.22.96.1', netmask: '255.255.240.0', family: 'IPv4' as const, mac: '00:15:5d:00:00:01', internal: false, cidr: '172.22.96.1/20' }],
      'vEthernet (Default Switch)': [{ address: '172.25.224.1', netmask: '255.255.240.0', family: 'IPv4' as const, mac: '00:15:5d:00:00:02', internal: false, cidr: '172.25.224.1/20' }],
      Meta: [{ address: '198.18.0.1', netmask: '255.255.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '198.18.0.1/16' }],
      docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4' as const, mac: '02:42:ac:11:00:01', internal: false, cidr: '172.17.0.1/16' }],
      'Ethernet 3': [{ address: '169.254.12.34', netmask: '255.255.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:03', internal: false, cidr: '169.254.12.34/16' }],
      Tailscale: [{ address: '100.64.0.10', netmask: '255.255.255.255', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '100.64.0.10/32' }],
      'Corp LAN': [{ address: '172.20.10.5', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:04', internal: false, cidr: '172.20.10.5/24' }],
      '以太网 2': [{ address: '192.168.10.20', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '02:00:00:00:00:01', internal: false, cidr: '192.168.10.20/24' }],
    };
    expect(directEndpoints({ host: '0.0.0.0', port: 58627 }, ['http://198.18.0.1:58627', 'http://169.254.1.2:58627', 'https://box.example.test'], windowsInterfaces)).toEqual([
      'http://192.168.10.20:58627',
      'http://100.64.0.10:58627',
      'http://172.20.10.5:58627',
      'https://box.example.test',
    ]);

    const macInterfaces = {
      utun3: [{ address: '198.18.0.1', netmask: '255.255.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '198.18.0.1/16' }],
      utun4: [{ address: '100.64.0.42', netmask: '255.255.255.255', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '100.64.0.42/32' }],
      utun5: [{ address: '172.19.0.1', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '172.19.0.1/24' }],
      bridge0: [{ address: '192.168.64.1', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:05', internal: false, cidr: '192.168.64.1/24' }],
      en0: [{ address: '192.168.10.30', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:06', internal: false, cidr: '192.168.10.30/24' }],
    };
    expect(directEndpoints({ host: '0.0.0.0', port: 58627 }, [], macInterfaces)).toEqual([
      'http://192.168.10.30:58627',
      'http://100.64.0.42:58627',
      'http://172.19.0.1:58627',
    ]);

    const tunnelRankInterfaces = {
      utun0: [{ address: '10.8.0.2', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '10.8.0.2/24' }],
      wg0: [{ address: '192.168.250.2', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.250.2/24' }],
      Tailscale: [{ address: '100.64.0.10', netmask: '255.255.255.255', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '100.64.0.10/32' }],
      en0: [{ address: '192.168.10.40', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:07', internal: false, cidr: '192.168.10.40/24' }],
    };
    expect(directEndpoints({ host: '0.0.0.0', port: 58627 }, [], tunnelRankInterfaces)).toEqual([
      'http://192.168.10.40:58627',
      'http://100.64.0.10:58627',
      'http://10.8.0.2:58627',
      'http://192.168.250.2:58627',
    ]);
    const loopbackExtras = [
      'http://10.8.0.2:58627',
      'http://192.168.250.2:58627',
      'http://100.64.0.10:58627',
      'http://192.168.10.40:58627',
    ];
    expect(directEndpoints({ host: '127.0.0.1', port: 58627 }, loopbackExtras, tunnelRankInterfaces)).toEqual([
      'http://192.168.10.40:58627',
      'http://100.64.0.10:58627',
      'http://10.8.0.2:58627',
      'http://192.168.250.2:58627',
    ]);
  });

  it('formats and parses short-lived kiki://pair URIs without long-lived tokens', () => {
    const uri = formatPairingUri({ endpoint: 'http://192.168.1.40:58627', code: 'k9f2 7x4m' });
    expect(uri).toBe('kiki://pair?endpoint=http%3A%2F%2F192.168.1.40%3A58627&code=K9F2-7X4M');
    expect(parsePairingUri(uri)).toEqual({ endpoint: 'http://192.168.1.40:58627', code: 'K9F2-7X4M' });
    expect(parsePairingUri('kiki:///pair?endpoint=https%3A%2F%2Fb.example.test&code=K9F2-7X4M')).toEqual({ endpoint: 'https://b.example.test', code: 'K9F2-7X4M' });
    expect(parsePairingUri('kiki://pair?endpoint=&code=K9F2-7X4M')).toBeUndefined();
    expect(parsePairingUri('kiki://pair?endpoint=http%3A%2F%2F192.168.1.40%3A58627&code=1111-1111')).toBeUndefined();
  });
});

describe('pairing codes', () => {
  it('keeps one live code, burns it after five misses, and rejects an expired or self claim', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-pair-code-')); homes.push(home);
    const target = new ConnectionAdmission(home, identity('target'));
    const source = identity('source');
    const first = await target.createPairCode({ expiresInMs: 60_000 });
    const second = await target.createPairCode();
    await expect(target.claimPair(first.code, source, 'Source')).rejects.toThrow('invalid_pairing_code');
    for (let attempt = 0; attempt < 5; attempt += 1) await expect(target.claimPair('BBBB-BBBB', source, 'Source')).rejects.toThrow('invalid_pairing_code');
    await expect(target.claimPair(second.code, source, 'Source')).rejects.toThrow('invalid_pairing_code');
    const expiring = await target.createPairCode({ expiresInMs: 20 });
    await new Promise((done) => setTimeout(done, 40));
    await expect(target.claimPair(expiring.code, source, 'Source')).rejects.toThrow('invalid_pairing_code');
    const live = await target.createPairCode();
    await expect(target.claimPair(live.code, target.identity, 'Self')).rejects.toMatchObject({ status: 409, reason: 'identity_changed' });
    const claimed = await target.claimPair(live.code, source, 'Source');
    expect(claimed.peerToken).toHaveLength(43);
    expect(claimed.allowBridge).toBe(true);
    expect(claimed.bridgeOperations).toEqual(['read', 'send', 'wait']);
    await expect(target.claimPair(live.code, source, 'Source')).rejects.toThrow('invalid_pairing_code');
    expect(target.matchBearer(claimed.peerToken)?.id).toBe(claimed.grantId);
  });

  it('defaults pair codes to least-privilege operations, defaults owner approvals to all six operations, and preserves explicit subsets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-pair-ops-')); homes.push(home);
    const target = new ConnectionAdmission(home, identity('target'));
    const sourceA = identity('source-a');
    const sourceB = identity('source-b');
    const defaultCode = await target.createPairCode();
    expect(defaultCode.bridgeOperations).toEqual(['read', 'send', 'wait']);
    const claimedDefault = await target.claimPair(defaultCode.code, sourceA, 'Source A');
    expect(claimedDefault.bridgeOperations).toEqual(['read', 'send', 'wait']);

    const subsetCode = await target.createPairCode({ bridgeOperations: ['read', 'send', 'tools'] });
    expect(subsetCode.bridgeOperations).toEqual(['read', 'send', 'tools']);
    const claimedSubset = await target.claimPair(subsetCode.code, sourceB, 'Source B', true, ['read', 'tools', 'wake']);
    expect(claimedSubset.bridgeOperations).toEqual(['read', 'tools']);

    const approvedDefault = await target.approvePeer(identity('source-c'), 'Source C');
    expect(approvedDefault.bridgeOperations).toEqual(['read', 'send', 'wait', 'wake', 'create', 'tools']);
    const approvedSubset = await target.approvePeer(identity('source-d'), 'Source D', true, ['read', 'wait']);
    expect(approvedSubset.bridgeOperations).toEqual(['read', 'wait']);
  });

  it('refuses to issue a code when authentication is bypassed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-pair-danger-')); homes.push(home);
    const target = new ConnectionAdmission(home, identity('target'), 'dangerous_auth_bypass');
    await expect(target.createPairCode()).rejects.toMatchObject({ status: 403, reason: 'dangerous_auth_bypass' });
  });
});

describe('pairing workspace limits', () => {
  it('caps larger outbound claims before the real claim route', async () => {
    const sourceHome = await mkdtemp(join(tmpdir(), 'kiki-pair-workspace-source-')); homes.push(sourceHome);
    const targetHome = await mkdtemp(join(tmpdir(), 'kiki-pair-workspace-target-')); homes.push(targetHome);
    const sourceIdentity = identity('source');
    const targetIdentity = identity('target');
    const sourceManager = new RemoteConnectionManager(sourceHome, sourceIdentity);
    const targetManager = new RemoteConnectionManager(targetHome, targetIdentity);
    const targetAdmission = new ConnectionAdmission(targetHome, targetIdentity);
    const received: string[][] = [];
    const hooks: PairingHooks = {
      workspaces: async () => [],
      issueBridges: async (input) => { received.push([...input.sourceWorkspaces]); return []; },
      installBridge: async () => {},
      revokeBridge: async () => {},
      enableThreads: async () => {},
      endpoints: async () => [],
    };
    const app = Fastify({ forceCloseConnections: true });
    registerRemoteConnectionRoutes(app, targetAdmission, targetManager, randomUUID(), () => 'owner-token', undefined, { current: hooks });
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const allWorkspaces = Array.from({ length: 1_050 }, (_, index) => `recent-${index}`);
      const code = await targetAdmission.createPairCode();
      await pairOutbound(sourceManager, { endpoint, code: code.code, backgroundSummary: false, requestBridge: true }, { ...hooks, workspaces: async () => allWorkspaces });
      expect(received[0]).toEqual(allWorkspaces);
      expect(received[0]).toHaveLength(1_050);
    } finally {
      await app.close();
      await sourceManager.close();
      await targetManager.close();
      await targetAdmission.close();
    }
  });

  it('accepts 120 source workspaces through the real pair claim route', async () => {
    const targetHome = await mkdtemp(join(tmpdir(), 'kiki-pair-workspace-route-')); homes.push(targetHome);
    const targetIdentity = identity('target');
    const targetAdmission = new ConnectionAdmission(targetHome, targetIdentity);
    const targetManager = new RemoteConnectionManager(targetHome, targetIdentity);
    const app = Fastify({ forceCloseConnections: true });
    registerRemoteConnectionRoutes(app, targetAdmission, targetManager, randomUUID(), () => 'owner-token');
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const code = await targetAdmission.createPairCode({ allowBridge: false });
      const response = await fetch(`${endpoint}/api/remote-connections/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.code, source: identity('source'), sourceLabel: 'Source', requestBridge: false, sourceWorkspaces: Array.from({ length: 120 }, (_, index) => `workspace-${index}`) }),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { code: number }).code).toBe(0);
    } finally {
      await app.close();
      await targetManager.close();
      await targetAdmission.close();
    }
  });
});

describe('inbound connection activity', () => {
  it('persists authenticated activity at five-minute intervals and flushes recent activity on close', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-admission-activity-')); homes.push(home);
    let now = 1_700_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const targetIdentity = identity('target');
    const admission = new ConnectionAdmission(home, targetIdentity);
    let restored: ConnectionAdmission | undefined;
    let restarted: ConnectionAdmission | undefined;
    try {
      await admission.ready();
      const approval = await admission.approvePeer(identity('source'), 'Source');
      const nonce = 'a'.repeat(32);
      const key = createHash('sha256').update(approval.peerToken).digest('hex');
      const proof = createHmac('sha256', key).update(`kiki-handshake-req-v1:${nonce}`).digest('hex');
      expect(admission.inspectHandshakeProof({ grantId: approval.grantId, nonce, proof })).toMatchObject({ status: 'approved' });
      expect(await savedConnectedAt(home, approval.grantId)).toBeUndefined();

      const audience = new ConnectionAudience(admission, 'owner-token', async () => false, () => 'space');
      await audience.authorizeSocket(approval.peerToken, { url: '/api/klient/events', headers: {} } as IncomingMessage);
      await settleAdmissionWrites(admission);
      expect(await savedConnectedAt(home, approval.grantId)).toBe(now);

      const firstSavedAt = now;
      now += 2 * 60 * 1000;
      expect(admission.matchBearer('not-a-bearer')).toBeUndefined();
      expect(() => admission.authorize('not-a-bearer')).toThrow('connection_not_approved');
      expect(admission.status().grants.find((grant) => grant.id === approval.grantId)?.lastConnectedAt).toBe(firstSavedAt);
      now += 2 * 60 * 1000;
      expect(admission.matchBearer(approval.peerToken)).toMatchObject({ id: approval.grantId });
      await settleAdmissionWrites(admission);
      expect(await savedConnectedAt(home, approval.grantId)).toBe(firstSavedAt);

      now += 60 * 1000;
      expect(admission.authorize(approval.peerToken)).toMatchObject({ id: approval.grantId });
      await settleAdmissionWrites(admission);
      expect(await savedConnectedAt(home, approval.grantId)).toBe(now);
      await admission.close();

      now += 60 * 1000;
      restored = new ConnectionAdmission(home, targetIdentity);
      await restored.ready();
      expect(restored.authorize(approval.peerToken)).toMatchObject({ id: approval.grantId, lastConnectedAt: now });
      await settleAdmissionWrites(restored);
      const lastThrottledSave = now - 60 * 1000;
      expect(await savedConnectedAt(home, approval.grantId)).toBe(lastThrottledSave);
      await restored.close();
      expect(await savedConnectedAt(home, approval.grantId)).toBe(now);

      const lastCloseSave = now;
      now += 60 * 1000;
      restarted = new ConnectionAdmission(home, targetIdentity);
      await restarted.ready();
      expect(restarted.matchBearer(approval.peerToken)).toMatchObject({ id: approval.grantId });
      await settleAdmissionWrites(restarted);
      expect(await savedConnectedAt(home, approval.grantId)).toBe(lastCloseSave);
      now += 4 * 60 * 1000;
      expect(restarted.matchBearer(approval.peerToken)).toMatchObject({ id: approval.grantId });
      await settleAdmissionWrites(restarted);
      expect(await savedConnectedAt(home, approval.grantId)).toBe(now);
      await restarted.close();
    } finally {
      clock.mockRestore();
      await admission.close();
      await restored?.close();
      await restarted?.close();
    }
  });
});

describe('pairing rate limit', () => {
  it('allows five attempts a minute and rejects the sixth', () => {
    const limit = new PairingRateLimit();
    for (let attempt = 0; attempt < 5; attempt += 1) expect(limit.allow('10.0.0.8', 1_000)).toBe(true);
    expect(limit.allow('10.0.0.8', 1_000)).toBe(false);
    expect(limit.allow('10.0.0.9', 1_000)).toBe(true);
    expect(limit.allow('10.0.0.8', 61_000)).toBe(true);
  });
});


describe('pairing rotation and zero-token preflight', () => {
  it('revokes every previous approved grant, closes its leases, and preserves the new choice', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-pair-rotate-')); homes.push(home);
    const admission = new ConnectionAdmission(home, identity('target')); const source = identity('source');
    const first = await admission.claimPair((await admission.createPairCode()).code, source, 'Source');
    let closed = false; admission.attach(first.grantId, () => { closed = true; });
    const second = await admission.claimPair((await admission.createPairCode({ allowBridge: false })).code, source, 'Source');
    expect(closed).toBe(true);
    expect(() => admission.matchBearer(first.peerToken)).toThrow('connection_not_approved');
    expect(admission.status().grants.filter((grant) => grant.status === 'approved')).toHaveLength(1);
    expect(second.allowBridge).toBe(false);
  });

  it.each([false, true])('sends no token to a rogue saved endpoint (spoof identity: %s)', async (spoof) => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-rogue-')); homes.push(home);
    const target = identity('target'); const headers: Record<string, unknown>[] = [];
    const rogue = createServer((req, res) => { headers.push(req.headers); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data: { identity: spoof ? target : identity('stranger'), serverId: 'rogue', inboundEnabled: true } })); });
    rogue.listen(0, '127.0.0.1'); await once(rogue, 'listening');
    const address = rogue.address(); if (address === null || typeof address === 'string') throw new Error('No rogue address');
    const manager = new RemoteConnectionManager(home, identity('source')); const id = randomUUID();
    await manager.storePeer({ id, credentialRef: id, label: 'Saved', endpoint: `http://127.0.0.1:${address.port}`, target, enabled: true, purposes: ['gui'], backgroundSummary: true, state: 'online', activeLeases: 0 }, { ownerToken: 'owner-secret', grant: 'grant-secret', grantId: randomUUID(), revision: 1 });
    try {
      await expect(manager.add({ label: 'Invitation', endpoint: `http://127.0.0.1:${address.port}`, target, ownerToken: 'owner-secret', invitation: randomUUID(), backgroundSummary: false })).rejects.toMatchObject({ reason: 'identity_changed' });
      await manager.pollSummaries();
      expect(manager.get(id).state).toBe('identity_changed');
      expect(headers.length).toBeGreaterThan(0);
      for (const seen of headers) { expect(seen['authorization']).toBeUndefined(); expect(seen['x-kiki-connection-grant']).toBeUndefined(); }
    } finally { await manager.close(); rogue.closeAllConnections(); await new Promise<void>((resolve) => rogue.close(() => resolve())); }
  });
  it('retries a transient transport failure on the same long-lived lease', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-transport-retry-')); homes.push(home);
    const target = identity('target'); let calls = 0;
    const manager = new RemoteConnectionManager(home, identity('source'), undefined, async () => {
      calls += 1;
      if (calls === 1) throw new Error('tunnel exited');
      return { endpoint: 'http://127.0.0.1:9', target };
    });
    const id = randomUUID();
    await manager.storePeer({ id, credentialRef: id, label: 'Local', endpoint: 'space://local', transport: { kind: 'local_space', localSpaceId: 'space' }, target, enabled: true, purposes: ['gui'], backgroundSummary: true, state: 'online', activeLeases: 0 }, { ownerToken: 'owner', grant: 'grant', grantId: randomUUID(), revision: 1 });
    const lease = manager.lease(id);
    try {
      await expect(manager.acquireTransport(id, lease.signal)).rejects.toThrow('tunnel exited');
      await expect(manager.acquireTransport(id, lease.signal)).resolves.toMatchObject({ endpoint: 'http://127.0.0.1:9' });
      expect(calls).toBe(2);
    } finally { lease.release(); await manager.close(); }
  });
});


describe('TLS identity and pinning', () => {
  it('pins a manually entered HTTPS peer on pairing and re-verifies the same certificate', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-manual-https-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const admission = new ConnectionAdmission(join(home, 'target'), identity('target'));
    const manager = new RemoteConnectionManager(join(home, 'source'), identity('source'));
    const peer = createHttpsServer(tls, (req, res) => {
      void (async () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/remote-connections/pair/claim') {
          let body = ''; for await (const part of req) body += part;
          const input = JSON.parse(body);
          const claim = await admission.claimPair(input.code, input.source, input.sourceLabel);
          res.end(JSON.stringify({ code: 0, data: { target: claim.target, targetLabel: 'Target', peerToken: claim.peerToken, grantId: claim.grantId, revision: claim.revision } }));
        } else {
          const proof = admission.inspectHandshakeProof({ nonce: String(req.headers['x-kiki-handshake-nonce']), proof: String(req.headers['x-kiki-handshake-proof']), grantId: String(req.headers['x-kiki-handshake-grant']) });
          if (proof !== undefined) { res.setHeader('x-kiki-handshake-status', proof.status); res.setHeader('x-kiki-handshake-proof', proof.proof); }
          res.end(JSON.stringify({ code: 0, data: { identity: admission.identity, serverId: 'peer', inboundEnabled: true } }));
        }
      })().catch((error) => res.destroy(error));
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    const address = peer.address(); if (address === null || typeof address === 'string') throw new Error('No peer address');
    const endpoint = `https://127.0.0.1:${address.port}`;
    try {
      const first = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: false, requestBridge: false }, undefined);
      expect(first.pinnedFingerprint).toBe(tls.tlsFingerprint);
      expect(first.fingerprintToVerify).toBe(tls.tlsFingerprint);
      const verified = await manager.verifyFingerprint(first.id);
      expect(verified.pinnedFingerprint).toBe(tls.tlsFingerprint);
      expect(verified.fingerprintToVerify).toBeUndefined();
      expect(manager.get(first.id).fingerprintToVerify).toBeUndefined();
      const second = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: false, requestBridge: false }, undefined);
      expect(second.id).toBe(first.id);
      expect(second.pinnedFingerprint).toBe(tls.tlsFingerprint);
      expect(second.fingerprintToVerify).toBeUndefined();
      const lease = manager.lease(second.id);
      try { await manager.connect(second.id, lease.signal); expect(manager.get(second.id).state).toBe('online'); expect(manager.get(second.id).rttMs).toBeGreaterThanOrEqual(1); }
      finally { lease.release(); }
    } finally { await manager.close(); await admission.close(); peer.closeAllConnections(); await new Promise<void>((resolve) => peer.close(() => resolve())); }
  });

  it('clears header deadlines for each concurrent peer socket independently', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-peer-deadlines-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const app = { server: createServer((_req, reply) => reply.end('ok')) } as unknown as FastifyInstance;
    const listeners = new PeerListeners(app, 0, new WeakSet(), true, tls);
    const listen = (listeners as unknown as { listen(host: string, port: number): Promise<{ url: string; close(): Promise<void> }> }).listen.bind(listeners);
    const peer = await listen('127.0.0.1', 0);
    const sockets: Socket[] = [];
    const nativeTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => nativeTimeout(callback, milliseconds === 15000 ? 150 : milliseconds, ...args)) as typeof setTimeout);
    try {
      const port = Number(new URL(peer.url).port);
      for (let index = 0; index < 2; index++) {
        const socket = createConnection({ host: '127.0.0.1', port }); sockets.push(socket); await once(socket, 'connect'); socket.write('G');
      }
      await new Promise<void>((resolve) => nativeTimeout(resolve, 20));
      for (const socket of sockets.toReversed()) {
        const response = once(socket, 'data'); socket.write('ET / HTTP/1.1\r\nHost: example.test\r\nConnection: keep-alive\r\n\r\n'); await response;
      }
      await new Promise<void>((resolve) => nativeTimeout(resolve, 180));
      expect(sockets.every(socket => !socket.destroyed)).toBe(true);
    } finally { timer.mockRestore(); for (const socket of sockets) socket.destroy(); await peer.close(); }
  });
  it('persists a valid self-signed P256 certificate with canonical SPKI fingerprint', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-peer-tls-')); homes.push(home);
    const first = await loadPeerTlsIdentity(home); const restored = await loadPeerTlsIdentity(home);
    expect(restored).toEqual(first);
    const cert = new X509Certificate(first.cert);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(first.tlsFingerprint).toBe(spkiFingerprint(cert.publicKey));
    expect(first.tlsFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a wrong certificate before sending either a pair code or saved tokens, even when the peer spoofs identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-cert-rogue-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home); const target = identity('target'); const requests: string[] = [];
    const rogue = createHttpsServer(tls, (req, res) => { requests.push(req.url!); res.end(JSON.stringify({ code: 0, data: { identity: target, serverId: 'rogue', inboundEnabled: true } })); });
    rogue.listen(0, '127.0.0.1'); await once(rogue, 'listening');
    const address = rogue.address(); if (address === null || typeof address === 'string') throw new Error('No rogue address');
    const endpoint = `https://127.0.0.1:${address.port}`; const manager = new RemoteConnectionManager(home, identity('source')); const id = randomUUID();
    const pinnedFingerprint = '0'.repeat(64);
    try {
      await expect(pairOutbound(manager, { endpoint, fingerprint: pinnedFingerprint, code: 'K9F2-7X4M', backgroundSummary: false, requestBridge: false }, undefined)).rejects.toMatchObject({ reason: 'identity_changed' });
      await manager.storePeer({ id, credentialRef: id, label: 'Saved', endpoint, pinnedFingerprint, target, enabled: true, purposes: ['gui'], backgroundSummary: false, state: 'online', activeLeases: 0 }, { ownerToken: 'owner-secret', grant: 'grant-secret', grantId: randomUUID(), revision: 1 });
      await expect(pairOutbound(manager, { endpoint: endpoint.replace(/^https:/, 'http:'), code: 'K9F2-7X4M', backgroundSummary: false, requestBridge: false }, undefined)).rejects.toMatchObject({ reason: 'identity_changed' });
      const lease = manager.lease(id);
      try { await expect(manager.forward(id, { operation: 'meta' }, lease.signal)).rejects.toMatchObject({ reason: 'identity_changed' }); }
      finally { lease.release(); }
      expect(manager.get(id).state).toBe('identity_changed');
      expect(requests).toEqual([]);
    } finally { await manager.close(); rogue.closeAllConnections(); await new Promise<void>((resolve) => rogue.close(() => resolve())); }
  });

  it('refuses an HTTP endpoint for a pinned record without opening a connection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-no-downgrade-')); homes.push(home);
    const manager = new RemoteConnectionManager(home, identity('source')); const id = randomUUID();
    await manager.storePeer({ id, credentialRef: id, label: 'Saved', endpoint: 'http://127.0.0.1:1', pinnedFingerprint: '0'.repeat(64), target: identity('target'), enabled: true, purposes: ['gui'], backgroundSummary: false, state: 'online', activeLeases: 0 }, { ownerToken: 'owner-secret', grant: 'grant-secret', grantId: randomUUID(), revision: 1 });
    const lease = manager.lease(id);
    try { await expect(manager.forward(id, { operation: 'meta' }, lease.signal)).rejects.toMatchObject({ reason: 'connection_requires_tls' }); }
    finally { lease.release(); await manager.close(); }
  });
});

describe('outbound credential generations', () => {
  it('preserves the stable record and settings, closes old leases, and ignores a stale in-flight summary failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-epoch-')); homes.push(home);
    const manager = new RemoteConnectionManager(home, identity('source')); const id = randomUUID(); const target = identity('target');
    const record = { id, credentialRef: id, label: 'My custom label', endpoint: 'http://127.0.0.1:5523', target, enabled: true, purposes: ['gui' as const], backgroundSummary: true, state: 'online' as const, activeLeases: 0 };
    const old = { ownerToken: 'old-secret', grant: 'old-secret', grantId: randomUUID(), revision: 1 };
    await manager.storePeer(record, old);
    let reject!: (error: Error) => void;
    const request = new Promise<Response>((_resolve, rejectRequest) => { reject = rejectRequest; });
    const forward = vi.spyOn(manager, 'forward').mockReturnValueOnce(request);
    const polling = manager.pollSummaries();
    await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce());
    const epoch = manager.credentialEpoch(id); const lease = manager.lease(id);
    const credential = { ownerToken: 'new-secret', grant: 'new-secret', grantId: randomUUID(), revision: 1 };
    const nextId = randomUUID();
    const saved = await manager.storePeer({ ...record, id: nextId, credentialRef: nextId, label: 'Default target label', backgroundSummary: false }, credential);
    expect(saved).toMatchObject({ id, label: 'My custom label', backgroundSummary: true, enabled: true, state: 'online' });
    expect(lease.signal.aborted).toBe(true);
    expect(manager.credentialEpoch(id)).toBeGreaterThan(epoch);
    reject(new Error('old request failed'));
    await polling;
    manager.failed(id, new Error('late event failure'), epoch);
    expect(manager.get(id).state).toBe('online');
    expect(manager.get(id).lastError).toBeUndefined();
    expect(manager.list()).toHaveLength(1);
    expect(await manager.secrets.read({ connectionId: id, purpose: 'gui' })).toEqual(credential);
    forward.mockRestore(); await manager.close();
  });

  it('keeps the existing record and secret when a replacement cannot be stored', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-store-rollback-')); homes.push(home);
    const manager = new RemoteConnectionManager(home, identity('source')); const id = randomUUID(); const target = identity('target');
    const record = { id, credentialRef: id, label: 'Keep me', endpoint: 'http://127.0.0.1:5523', target, enabled: true, purposes: ['gui' as const], backgroundSummary: false, state: 'online' as const, activeLeases: 0 };
    const old = { ownerToken: 'old-secret', grant: 'old-secret', grantId: randomUUID(), revision: 1 };
    await manager.storePeer(record, old);
    const write = vi.spyOn(manager.secrets, 'write').mockRejectedValueOnce(new Error('disk full'));
    await expect(manager.storePeer({ ...record, id: randomUUID(), endpoint: 'http://127.0.0.1:5524' }, { ...old, grantId: randomUUID() })).rejects.toThrow('disk full');
    expect(manager.list()).toEqual([record]);
    expect(await manager.secrets.read({ connectionId: id, purpose: 'gui' })).toEqual(old);
    write.mockRestore(); await manager.close();
  });
});


it('cancels a pinned TLS socket while its peer stalls before secureConnect', async () => {
  const sockets = new Set<Socket>();
  const stalled = createNetServer((socket) => { sockets.add(socket); socket.on('data', () => {}); socket.once('close', () => sockets.delete(socket)); });
  stalled.listen(0, '127.0.0.1'); await once(stalled, 'listening');
  const address = stalled.address(); if (address === null || typeof address === 'string') throw new Error('No stalled address');
  const controller = new AbortController();
  const pending = peerFetch(`https://127.0.0.1:${address.port}`, { headers: { authorization: 'Bearer never-send-this' }, signal: controller.signal }, '0'.repeat(64));
  try {
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    controller.abort(new Error('cancel stalled TLS'));
    await expect(pending).rejects.toThrow('cancel stalled TLS');
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => stalled.close(() => resolve())); }
});

describe('paired peer surface parity and host boundaries', () => {
  it('admits safe peer GUI reads/session controls while keeping host-only mutations and surfaces denied', () => {
    expect(matchConnectionOperation('GET', '/gui/shortcuts')?.operation).toBe('guiShortcuts');
    expect(matchConnectionOperation('GET', '/sessions/session-1/optional-capabilities')?.operation).toBe('optionalCapabilities');
    expect(matchConnectionOperation('POST', '/sessions/session-1/optional-capabilities')?.operation).toBe('optionalCapabilitiesSet');
    expect(matchConnectionOperation('GET', '/sessions/session-1/agents/main/context-strategy')?.operation).toBe('contextStrategy');
    expect(matchConnectionOperation('GET', '/plugins/gui-slots')?.operation).toBe('pluginGuiSlots');
    expect(matchConnectionOperation('GET', '/output-layer/configuration')?.operation).toBe('outputLayerConfiguration');
    expect(matchConnectionOperation('POST', '/output-layer/stream')?.operation).toBe('outputLayerStream');

    for (const method of ['read', 'pause', 'resume', 'cancelPause']) {
      expect(isPeerProcedureAllowed({ service: 'sessionExecutionControl', method })).toBe(true);
    }

    expect(matchConnectionOperation('PUT', '/gui/shortcuts')).toBeUndefined();
    expect(matchConnectionOperation('POST', '/gui/shortcuts/reset')).toBeUndefined();
    expect(matchConnectionOperation('PATCH', '/sessions/session-1/agents/main/context-strategy')?.operation).toBe('contextStrategyUpdate');
    expect(matchConnectionOperation('PUT', '/output-layer/configuration')).toBeUndefined();
    expect(matchConnectionOperation('GET', '/quotas/harness')).toBeUndefined();
    expect(matchConnectionOperation('GET', '/ssh/hosts')).toBeUndefined();
    expect(matchConnectionOperation('GET', '/im/sessions')).toBeUndefined();
    expect(matchConnectionOperation('POST', '/workspaces:inspect')).toBeUndefined();
    expect(matchConnectionOperation('GET', '/external-clients')).toBeUndefined();
    expect(matchConnectionOperation('POST', '/leases')).toBeUndefined();
  });

  it('reuses a pooled pinned TLS socket across forwarded calls and survives a single transient socket reset without flipping offline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-tls-pool-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const admission = new ConnectionAdmission(join(home, 'target'), identity('target'));
    const manager = new RemoteConnectionManager(join(home, 'source'), identity('source'));
    let tlsSockets = 0;
    let handshakes = 0;
    let dropNextMeta = false;
    const peer = createHttpsServer(tls, (req, res) => {
      void (async () => {
        if (req.url === '/api/remote-connections/pair/claim') {
          let body = ''; for await (const part of req) body += part;
          const input = JSON.parse(body);
          const claim = await admission.claimPair(input.code, input.source, input.sourceLabel);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { target: claim.target, targetLabel: 'Target', peerToken: claim.peerToken, grantId: claim.grantId, revision: claim.revision } }));
          return;
        }
        if (req.url === '/api/remote-connections/handshake') {
          handshakes += 1;
          const proof = admission.inspectHandshakeProof({ nonce: String(req.headers['x-kiki-handshake-nonce']), proof: String(req.headers['x-kiki-handshake-proof']), grantId: String(req.headers['x-kiki-handshake-grant']) });
          if (proof !== undefined) { res.setHeader('x-kiki-handshake-status', proof.status); res.setHeader('x-kiki-handshake-proof', proof.proof); }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { identity: admission.identity, serverId: 'peer', inboundEnabled: true } }));
          return;
        }
        if (dropNextMeta && req.url === '/api/meta') {
          dropNextMeta = false;
          req.socket.destroy();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: { server_home_id: admission.identity.homeId } }));
      })().catch((error) => res.destroy(error));
    });
    peer.on('secureConnection', () => { tlsSockets += 1; });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    const address = peer.address(); if (address === null || typeof address === 'string') throw new Error('No peer address');
    const endpoint = `https://127.0.0.1:${address.port}`;
    try {
      const paired = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: false, requestBridge: false }, undefined);
      tlsSockets = 0; handshakes = 0;
      const lease = manager.lease(paired.id);
      try {
        for (let i = 0; i < 4; i += 1) {
          const response = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
          expect(response.status).toBe(200);
          await response.json();
        }
        expect(tlsSockets).toBe(1);
        expect(handshakes).toBe(1);
        dropNextMeta = true;
        const recovered = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
        expect(recovered.status).toBe(200);
        await recovered.json();
        expect(manager.get(paired.id).state).toBe('online');
      } finally { lease.release(); }
    } finally { await manager.close(); await admission.close(); peer.closeAllConnections(); await new Promise<void>((resolve) => peer.close(() => resolve())); }
  });

  it('isolates concurrent pooled TLS handshakes on per-request abort and cleans up pending handshakes on eviction', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-tls-concurrent-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const fingerprint = spkiFingerprint(new X509Certificate(tls.cert).publicKey);
    let closeResponseSocket = false;
    let holdResponses = false;
    const heldResponses: Array<() => void> = [];
    const tlsServer = createHttpsServer(tls, (_req, res) => {
      const send = () => {
        if (closeResponseSocket) res.setHeader('connection', 'close');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      };
      if (holdResponses) heldResponses.push(send);
      else send();
    });
    tlsServer.listen(0, '127.0.0.1'); await once(tlsServer, 'listening');
    const tlsAddress = tlsServer.address(); if (tlsAddress === null || typeof tlsAddress === 'string') throw new Error('No TLS address');

    const accepted: Array<{ socket: Socket; closed: boolean; releaseToTls: () => void }> = [];
    const gate = createNetServer((inbound) => {
      const buffered: Buffer[] = [];
      let bridged = false;
      const onData = (chunk: Buffer) => { buffered.push(chunk); };
      inbound.on('data', onData);
      const entry = {
        socket: inbound,
        closed: false,
        releaseToTls: () => {
          if (bridged || entry.closed) return;
          bridged = true;
          inbound.off('data', onData);
          const upstream = createConnection({ host: '127.0.0.1', port: tlsAddress.port }, () => {
            for (const chunk of buffered.splice(0)) upstream.write(chunk);
            inbound.pipe(upstream);
            upstream.pipe(inbound);
          });
          upstream.on('error', () => inbound.destroy());
          inbound.on('error', () => upstream.destroy());
        },
      };
      inbound.once('close', () => { entry.closed = true; });
      accepted.push(entry);
    });
    gate.listen(0, '127.0.0.1'); await once(gate, 'listening');
    const gateAddress = gate.address(); if (gateAddress === null || typeof gateAddress === 'string') throw new Error('No gate address');
    const endpoint = `https://127.0.0.1:${gateAddress.port}/api/meta`;

    try {
      const pending1 = peerFetch(endpoint, {}, fingerprint);
      await vi.waitFor(() => expect(accepted.length).toBe(1));

      const controller2 = new AbortController();
      const pending2 = peerFetch(endpoint, { signal: controller2.signal }, fingerprint);
      await vi.waitFor(() => expect(accepted.length).toBe(2));

      controller2.abort(new Error('cancel second handshake only'));
      await expect(pending2).rejects.toThrow('cancel second handshake only');
      await vi.waitFor(() => expect(accepted[1]?.closed).toBe(true));
      expect(accepted[0]?.closed).toBe(false);

      accepted[0]!.releaseToTls();
      const response1 = await pending1;
      expect(response1.status).toBe(200);
      expect(await response1.json()).toEqual({ ok: true });

      evictPinnedAgent(endpoint, fingerprint);
      const pending3 = peerFetch(endpoint, {}, fingerprint);
      const pending3Failure = expect(pending3).rejects.toThrow('TLS connection pool closed');
      await vi.waitFor(() => expect(accepted.length).toBe(3));
      evictPinnedAgent(endpoint, fingerprint);
      await vi.waitFor(() => expect(accepted[2]?.closed).toBe(true));
      await pending3Failure;

      closeResponseSocket = true;
      holdResponses = true;
      const startIndex = accepted.length;
      const controllers = Array.from({ length: 16 }, () => new AbortController());
      const activeBatch = controllers.map((c) => peerFetch(endpoint, { signal: c.signal }, fingerprint));
      for (const p of activeBatch) void p.catch(() => undefined);
      await vi.waitFor(() => expect(accepted.length - startIndex).toBe(16));
      for (let idx = startIndex; idx < startIndex + 16; idx += 1) {
        accepted[idx]!.releaseToTls();
      }
      await vi.waitFor(() => expect(heldResponses.length).toBe(16));

      const controller17 = new AbortController();
      const queued17 = peerFetch(endpoint, { signal: controller17.signal }, fingerprint);
      void queued17.catch(() => undefined);
      expect(accepted.length - startIndex).toBe(16);

      heldResponses.shift()!();
      const firstBatchRes = await activeBatch[0]!;
      expect(firstBatchRes.status).toBe(200);
      await firstBatchRes.json();
      controllers[0]!.abort(new AdmissionError(409, 'connection_released'));

      await vi.waitFor(() => expect(accepted.length - startIndex).toBe(17));
      holdResponses = false;
      while (heldResponses.length > 0) heldResponses.shift()!();
      accepted[startIndex + 16]!.releaseToTls();

      const restResponses = await Promise.all([...activeBatch.slice(1), queued17]);
      for (const res of restResponses) {
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      }
    } finally {
      evictPinnedAgent(endpoint, fingerprint);
      for (const entry of accepted) entry.socket.destroy();
      await new Promise<void>((resolve) => gate.close(() => resolve()));
      tlsServer.closeAllConnections();
      await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    }
  });

  it('counts at most one transport strike per failed forward or summary poll cycle when handshake cache expires', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-single-strike-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const admission = new ConnectionAdmission(join(home, 'target'), identity('target'));
    const manager = new RemoteConnectionManager(join(home, 'source'), identity('source'));
    let dropAll = false;
    const peer = createHttpsServer(tls, (req, res) => {
      if (dropAll) {
        req.socket.destroy();
        return;
      }
      void (async () => {
        if (req.url === '/api/remote-connections/pair/claim') {
          let body = ''; for await (const part of req) body += part;
          const input = JSON.parse(body);
          const claim = await admission.claimPair(input.code, input.source, input.sourceLabel);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { target: claim.target, targetLabel: 'Target', peerToken: claim.peerToken, grantId: claim.grantId, revision: claim.revision } }));
          return;
        }
        if (req.url === '/api/remote-connections/handshake') {
          const proof = admission.inspectHandshakeProof({ nonce: String(req.headers['x-kiki-handshake-nonce']), proof: String(req.headers['x-kiki-handshake-proof']), grantId: String(req.headers['x-kiki-handshake-grant']) });
          if (proof !== undefined) { res.setHeader('x-kiki-handshake-status', proof.status); res.setHeader('x-kiki-handshake-proof', proof.proof); }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { identity: admission.identity, serverId: 'peer', inboundEnabled: true } }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: { online: true, busy_sessions: 0, needs_you_sessions: 0, revision: 'rev-1', as_of: Date.now() } }));
      })().catch((error) => res.destroy(error));
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    const address = peer.address(); if (address === null || typeof address === 'string') throw new Error('No peer address');
    const endpoint = `https://127.0.0.1:${address.port}`;
    try {
      const paired = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: true, requestBridge: false }, undefined);
      const lease = manager.lease(paired.id);
      try {
        const okRes = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
        expect(okRes.status).toBe(200);
        await okRes.json();

        const baseNow = Date.now();
        let clockOffset = 65_000;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => baseNow + clockOffset);
        try {
          const cancelled = new AbortController();
          cancelled.abort(new Error('caller cancelled'));
          await expect(manager.forward(paired.id, { operation: 'meta' }, cancelled.signal)).rejects.toThrow('caller cancelled');
          expect(manager.get(paired.id).state).toBe('online');

          dropAll = true;
          await manager.pollSummaries();
          expect(manager.get(paired.id).state).toBe('online');

          dropAll = false;
          clockOffset += 10_000;
          await manager.pollSummaries();
          expect(manager.get(paired.id).state).toBe('online');
          expect(manager.get(paired.id).summary?.stale).toBe(false);
        } finally {
          nowSpy.mockRestore();
        }
      } finally { lease.release(); }
    } finally { await manager.close(); await admission.close(); peer.closeAllConnections(); await new Promise<void>((resolve) => peer.close(() => resolve())); }
  });

  it('does not replay non-idempotent POST requests on disconnect unless idempotentRetry is enabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-no-post-replay-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const fingerprint = spkiFingerprint(new X509Certificate(tls.cert).publicKey);
    const admission = new ConnectionAdmission(join(home, 'target'), identity('target'));
    const manager = new RemoteConnectionManager(join(home, 'source'), identity('source'));
    let sessionCreateHits = 0;
    let directPostHits = 0;
    let optInPostHits = 0;
    let dropNextSessionCreate = false;
    let dropNextDirectPost = false;
    let dropFirstOptInPost = false;
    const peer = createHttpsServer(tls, (req, res) => {
      void (async () => {
        if (req.url === '/api/remote-connections/pair/claim') {
          let body = ''; for await (const part of req) body += part;
          const input = JSON.parse(body);
          const claim = await admission.claimPair(input.code, input.source, input.sourceLabel);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { target: claim.target, targetLabel: 'Target', peerToken: claim.peerToken, grantId: claim.grantId, revision: claim.revision } }));
          return;
        }
        if (req.url === '/api/remote-connections/handshake') {
          const proof = admission.inspectHandshakeProof({ nonce: String(req.headers['x-kiki-handshake-nonce']), proof: String(req.headers['x-kiki-handshake-proof']), grantId: String(req.headers['x-kiki-handshake-grant']) });
          if (proof !== undefined) { res.setHeader('x-kiki-handshake-status', proof.status); res.setHeader('x-kiki-handshake-proof', proof.proof); }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { identity: admission.identity, serverId: 'peer', inboundEnabled: true } }));
          return;
        }
        if (req.method === 'POST' && req.url === '/api/sessions') {
          sessionCreateHits += 1;
          if (dropNextSessionCreate) {
            dropNextSessionCreate = false;
            req.socket.destroy();
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { id: 'created-session' } }));
          return;
        }
        if (req.method === 'POST' && req.url === '/api/direct-post') {
          directPostHits += 1;
          if (dropNextDirectPost) {
            dropNextDirectPost = false;
            req.socket.destroy();
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'POST' && req.url === '/api/opt-in-post') {
          optInPostHits += 1;
          if (dropFirstOptInPost) {
            dropFirstOptInPost = false;
            req.socket.destroy();
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: { server_home_id: admission.identity.homeId } }));
      })().catch((error) => res.destroy(error));
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    const address = peer.address(); if (address === null || typeof address === 'string') throw new Error('No peer address');
    const endpoint = `https://127.0.0.1:${address.port}`;
    try {
      const paired = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: false, requestBridge: false }, undefined);
      const lease = manager.lease(paired.id);
      try {
        const warmup = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
        expect(warmup.status).toBe(200);
        await warmup.json();

        dropNextSessionCreate = true;
        await expect(manager.forward(paired.id, { operation: 'sessionCreate', body: { work_dir: '/tmp/work' } }, lease.signal)).rejects.toThrow();
        expect(sessionCreateHits).toBe(1);

        sessionCreateHits = 0;
        dropNextSessionCreate = true;
        const optInForward = await manager.forward(
          paired.id,
          { operation: 'sessionCreate', body: { work_dir: '/tmp/work' } },
          lease.signal,
          undefined,
          undefined,
          { idempotentRetry: true },
        );
        expect(optInForward.status).toBe(200);
        expect(sessionCreateHits).toBe(2);

        const directWarmup = await peerFetch(`${endpoint}/api/meta`, {}, fingerprint);
        expect(directWarmup.status).toBe(200);
        await directWarmup.json();

        dropNextDirectPost = true;
        await expect(peerFetch(`${endpoint}/api/direct-post`, { method: 'POST', body: JSON.stringify({ x: 1 }) }, fingerprint)).rejects.toThrow();
        expect(directPostHits).toBe(1);

        const secondWarmup = await peerFetch(`${endpoint}/api/meta`, {}, fingerprint);
        expect(secondWarmup.status).toBe(200);
        await secondWarmup.json();

        dropFirstOptInPost = true;
        const retriedDirect = await peerFetch(
          `${endpoint}/api/opt-in-post`,
          { method: 'POST', body: JSON.stringify({ x: 1 }), idempotentRetry: true },
          fingerprint,
        );
        expect(retriedDirect.status).toBe(200);
        expect(optInPostHits).toBe(2);
      } finally { lease.release(); }
    } finally {
      evictPinnedAgent(endpoint, fingerprint);
      await manager.close();
      await admission.close();
      peer.closeAllConnections();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  });

  it('generates RFC 5280 validity without T and repairs legacy malformed peer-tls.json in place while preserving tlsFingerprint', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-tls-rfc5280-')); homes.push(home);
    const fresh = await loadPeerTlsIdentity(home);
    const freshCert = new X509Certificate(fresh.cert);
    expect(freshCert.verify(freshCert.publicKey)).toBe(true);
    expect(Number.isFinite(Date.parse(freshCert.validFrom))).toBe(true);
    expect(Number.isFinite(Date.parse(freshCert.validTo))).toBe(true);
    const spanDays = (Date.parse(freshCert.validTo) - Date.parse(freshCert.validFrom)) / 86400000;
    expect(spanDays).toBeGreaterThan(700);
    expect(spanDays).toBeLessThanOrEqual(825);
    expect(freshCert.raw.toString('latin1')).not.toMatch(/\d{8}T\d{6}Z/);

    const legacyHome = await mkdtemp(join(tmpdir(), 'kiki-tls-legacy-')); homes.push(legacyHome);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const expectedFp = spkiFingerprint(publicKey);
    const der = (tag: number, ...parts: Buffer[]): Buffer => {
      const body = Buffer.concat(parts);
      const length = body.length < 128 ? Buffer.from([body.length]) : (() => {
        const bytes: number[] = []; let n = body.length;
        while (n > 0) { bytes.unshift(n & 255); n >>>= 8; }
        return Buffer.from([0x80 | bytes.length, ...bytes]);
      })();
      return Buffer.concat([Buffer.from([tag]), length, body]);
    };
    const seq = (...parts: Buffer[]) => der(0x30, ...parts);
    const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
    const badTime = (date: Date) => der(0x18, Buffer.from(date.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')));
    const alg = seq(oid('2a8648ce3d040302'));
    const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('Kiki Peer')))));
    const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 1;
    const now = Date.now();
    const tbs = seq(
      der(0xa0, der(0x02, Buffer.from([2]))),
      der(0x02, serial),
      alg,
      name,
      seq(badTime(new Date(now - 86400000)), badTime(new Date(now + 20 * 366 * 86400000))),
      name,
      publicKey.export({ type: 'spki', format: 'der' }),
    );
    const legacyCertDer = seq(tbs, alg, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
    const legacyCertPem = `-----BEGIN CERTIFICATE-----\n${legacyCertDer.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(legacyCertDer.toString('latin1')).toMatch(/\d{8}T\d{6}Z/);

    await mkdir(join(legacyHome, 'server'), { recursive: true });
    const tlsPath = join(legacyHome, 'server', 'peer-tls.json');
    await writeFile(tlsPath, JSON.stringify({ key: keyPem, cert: legacyCertPem }), { encoding: 'utf8', mode: 0o600 });

    const repaired = await loadPeerTlsIdentity(legacyHome);
    expect(repaired.tlsFingerprint).toBe(expectedFp);
    expect(repaired.key).toBe(keyPem);
    expect(repaired.cert).not.toBe(legacyCertPem);
    const repairedCert = new X509Certificate(repaired.cert);
    expect(repairedCert.verify(repairedCert.publicKey)).toBe(true);
    expect(repairedCert.raw.toString('latin1')).not.toMatch(/\d{8}T\d{6}Z/);
    expect(Number.isFinite(Date.parse(repairedCert.validFrom))).toBe(true);
    expect(Number.isFinite(Date.parse(repairedCert.validTo))).toBe(true);

    const persisted = JSON.parse(await readFile(tlsPath, 'utf8')) as { key: string; cert: string };
    expect(persisted.key).toBe(keyPem);
    expect(persisted.cert).toBe(repaired.cert);
    const reloaded = await loadPeerTlsIdentity(legacyHome);
    expect(reloaded.cert).toBe(repaired.cert);
    expect(reloaded.tlsFingerprint).toBe(expectedFp);
  });

  it('avoids 5s outbound-connections.json rewrites during steady-state summary polls and refreshes verified handshakes on active traffic', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-steady-latency-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const admission = new ConnectionAdmission(join(home, 'target'), identity('target'));
    const manager = new RemoteConnectionManager(join(home, 'source'), identity('source'));
    let handshakeHits = 0;
    let revoked = false;
    const peer = createHttpsServer(tls, (req, res) => {
      void (async () => {
        if (req.url === '/api/remote-connections/pair/claim') {
          let body = ''; for await (const part of req) body += part;
          const input = JSON.parse(body);
          const claim = await admission.claimPair(input.code, input.source, input.sourceLabel);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { target: claim.target, targetLabel: 'Target', peerToken: claim.peerToken, grantId: claim.grantId, revision: claim.revision } }));
          return;
        }
        if (req.url === '/api/remote-connections/handshake') {
          handshakeHits += 1;
          const proof = admission.inspectHandshakeProof({ nonce: String(req.headers['x-kiki-handshake-nonce']), proof: String(req.headers['x-kiki-handshake-proof']), grantId: String(req.headers['x-kiki-handshake-grant']) });
          if (proof !== undefined) { res.setHeader('x-kiki-handshake-status', proof.status); res.setHeader('x-kiki-handshake-proof', proof.proof); }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { identity: admission.identity, serverId: 'peer', inboundEnabled: true } }));
          return;
        }
        if (revoked) {
          res.statusCode = 401;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 40101, msg: 'connection_not_approved' }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: { online: true, busy_sessions: 0, needs_you_sessions: 0, revision: 'rev-1', as_of: Date.now() } }));
      })().catch((error) => res.destroy(error));
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    const address = peer.address(); if (address === null || typeof address === 'string') throw new Error('No peer address');
    const endpoint = `https://127.0.0.1:${address.port}`;
    const outboundPath = join(home, 'source', 'server', 'outbound-connections.json');
    const writeSpy = vi.spyOn(privateFiles, 'writePrivateFile');
    try {
      const paired = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: true, requestBridge: false }, undefined);
      const lease = manager.lease(paired.id);
      const baseNow = Date.now();
      let offset = 0;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => baseNow + offset);
      try {
        const first = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
        expect(first.status).toBe(200);
        await first.json();
        const handshakesAfterWarmup = handshakeHits;

        const outboundWritesBefore = () => writeSpy.mock.calls.filter(([filePath]) => filePath === outboundPath).length;
        const writesStart = outboundWritesBefore();

        offset = 5_000;
        await manager.pollSummaries();
        offset = 10_000;
        await manager.pollSummaries();
        offset = 45_000;
        await manager.pollSummaries();
        offset = 85_000;
        const activeCall = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
        expect(activeCall.status).toBe(200);
        await activeCall.json();

        expect(outboundWritesBefore()).toBe(writesStart);
        expect(handshakeHits).toBe(handshakesAfterWarmup);
        expect(manager.get(paired.id).summary?.stale).toBe(false);

        offset = 5 * 60_000 + 1_000;
        await manager.pollSummaries();
        expect(outboundWritesBefore()).toBe(writesStart + 1);
        expect(handshakeHits).toBe(handshakesAfterWarmup + 1);

        const afterIdleReprove = handshakeHits;
        for (let step = 1; step <= 20; step += 1) {
          offset += 45_000;
          const callRes = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
          expect(callRes.status).toBe(200);
          await callRes.json();
        }
        expect(handshakeHits).toBe(afterIdleReprove + 1);

        const grants = admission.status().grants;
        await admission.revoke(grants[0]!.id);
        revoked = true;
        await expect(manager.forward(paired.id, { operation: 'meta' }, lease.signal)).rejects.toMatchObject({ status: 401, reason: 'connection_not_approved' });
        expect(manager.get(paired.id).state).toBe('authentication_required');
      } finally {
        nowSpy.mockRestore();
        lease.release();
      }
    } finally {
      writeSpy.mockRestore();
      await manager.close();
      await admission.close();
      peer.closeAllConnections();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  });

  it('invalidates the sliding handshake proof on the first non-retried transport failure while keeping online state until three strikes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-first-strike-inval-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const admission = new ConnectionAdmission(join(home, 'target'), identity('target'));
    const manager = new RemoteConnectionManager(join(home, 'source'), identity('source'));
    let handshakeHits = 0;
    let dropNextPost = false;
    let holdHealthHandshake = false;
    let releaseHealthHandshake!: () => void;
    const healthHandshakeGate = new Promise<void>((resolve) => { releaseHealthHandshake = resolve; });
    const peer = createHttpsServer(tls, (req, res) => {
      void (async () => {
        if (req.url === '/api/remote-connections/pair/claim') {
          let body = ''; for await (const part of req) body += part;
          const input = JSON.parse(body);
          const claim = await admission.claimPair(input.code, input.source, input.sourceLabel);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { target: claim.target, targetLabel: 'Target', peerToken: claim.peerToken, grantId: claim.grantId, revision: claim.revision } }));
          return;
        }
        if (req.url === '/api/remote-connections/handshake') {
          handshakeHits += 1;
          if (holdHealthHandshake) {
            holdHealthHandshake = false;
            await healthHandshakeGate;
          }
          const proof = admission.inspectHandshakeProof({ nonce: String(req.headers['x-kiki-handshake-nonce']), proof: String(req.headers['x-kiki-handshake-proof']), grantId: String(req.headers['x-kiki-handshake-grant']) });
          if (proof !== undefined) { res.setHeader('x-kiki-handshake-status', proof.status); res.setHeader('x-kiki-handshake-proof', proof.proof); }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { identity: admission.identity, serverId: 'peer', inboundEnabled: true } }));
          return;
        }
        if (req.method === 'POST' && dropNextPost) {
          dropNextPost = false;
          req.socket.destroy();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: { ok: true } }));
      })().catch((error) => res.destroy(error));
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    const address = peer.address(); if (address === null || typeof address === 'string') throw new Error('No peer address');
    const endpoint = `https://127.0.0.1:${address.port}`;
    try {
      const paired = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: false, requestBridge: false }, undefined);
      const lease = manager.lease(paired.id);
      try {
        const warmup = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
        expect(warmup.status).toBe(200);
        await warmup.json();
        const handshakesBeforeDrop = handshakeHits;

        dropNextPost = true;
        holdHealthHandshake = true;
        await expect(manager.forward(paired.id, { operation: 'sessionCreate', body: { work_dir: '/tmp/work' } }, lease.signal)).rejects.toThrow();
        expect(manager.get(paired.id).state).toBe('online');

        const afterStrike = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
        expect(afterStrike.status).toBe(200);
        await afterStrike.json();
        expect(handshakeHits).toBeGreaterThanOrEqual(handshakesBeforeDrop + 2);
      } finally {
        releaseHealthHandshake();
        lease.release();
      }
    } finally {
      releaseHealthHandshake();
      await manager.close();
      await admission.close();
      peer.closeAllConnections();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  });

  it('prevents a stale health probe from restoring online state or cached proof after a newer 403 inbound_disabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-stale-probe-fence-')); homes.push(home);
    const tls = await loadPeerTlsIdentity(home);
    const admission = new ConnectionAdmission(join(home, 'target'), identity('target'));
    const manager = new RemoteConnectionManager(join(home, 'source'), identity('source'));
    let handshakeHits = 0;
    let dropNextPost = false;
    let inboundDisabled = false;
    let holdNextHandshake = false;
    let signalProbeArrived!: () => void;
    const probeArrived = new Promise<void>((resolve) => { signalProbeArrived = resolve; });
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const peer = createHttpsServer(tls, (req, res) => {
      void (async () => {
        if (req.url === '/api/remote-connections/pair/claim') {
          let body = ''; for await (const part of req) body += part;
          const input = JSON.parse(body);
          const claim = await admission.claimPair(input.code, input.source, input.sourceLabel);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { target: claim.target, targetLabel: 'Target', peerToken: claim.peerToken, grantId: claim.grantId, revision: claim.revision } }));
          return;
        }
        if (req.url === '/api/remote-connections/handshake') {
          handshakeHits += 1;
          const proof = admission.inspectHandshakeProof({ nonce: String(req.headers['x-kiki-handshake-nonce']), proof: String(req.headers['x-kiki-handshake-proof']), grantId: String(req.headers['x-kiki-handshake-grant']) });
          if (holdNextHandshake) {
            holdNextHandshake = false;
            signalProbeArrived();
            await probeGate;
          }
          if (proof !== undefined) { res.setHeader('x-kiki-handshake-status', proof.status); res.setHeader('x-kiki-handshake-proof', proof.proof); }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 0, data: { identity: admission.identity, serverId: 'peer', inboundEnabled: !inboundDisabled || proof?.status === 'approved' } }));
          return;
        }
        if (inboundDisabled) {
          res.statusCode = 403;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 40301, msg: 'inbound_disabled' }));
          return;
        }
        if (req.method === 'POST' && dropNextPost) {
          dropNextPost = false;
          req.socket.destroy();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: { ok: true } }));
      })().catch((error) => res.destroy(error));
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    const address = peer.address(); if (address === null || typeof address === 'string') throw new Error('No peer address');
    const endpoint = `https://127.0.0.1:${address.port}`;
    try {
      const paired = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: false, requestBridge: false }, undefined);
      const lease = manager.lease(paired.id);
      try {
        const warmup = await manager.forward(paired.id, { operation: 'meta' }, lease.signal);
        expect(warmup.status).toBe(200);
        await warmup.json();

        dropNextPost = true;
        holdNextHandshake = true;
        await expect(manager.forward(paired.id, { operation: 'sessionCreate', body: { work_dir: '/tmp/work' } }, lease.signal)).rejects.toThrow();
        await probeArrived;

        inboundDisabled = true;
        await admission.setEnabled(false);
        await expect(manager.forward(paired.id, { operation: 'meta' }, lease.signal)).rejects.toThrow('inbound_disabled');
        expect(manager.get(paired.id).state).toBe('offline');

        releaseProbe();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(manager.get(paired.id).state).toBe('offline');

        const handshakesBeforeRecheck = handshakeHits;
        await expect(manager.forward(paired.id, { operation: 'meta' }, lease.signal)).rejects.toThrow('inbound_disabled');
        expect(handshakeHits).toBeGreaterThan(handshakesBeforeRecheck);
      } finally {
        releaseProbe();
        lease.release();
      }
    } finally {
      releaseProbe();
      await manager.close();
      await admission.close();
      peer.closeAllConnections();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  });
});
