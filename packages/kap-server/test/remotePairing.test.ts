import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpsServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createServer as createNetServer, createConnection, type Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { evictPinnedAgent, peerFetch } from '../src/services/connections/peerTls';
import { loadPeerTlsIdentity, spkiFingerprint } from '../src/services/connections/tlsIdentity';
import { pairOutbound, PeerListeners } from '../src/services/connections/pairing';
import { formatPairingUri, matchConnectionOperation, parsePairingUri } from '@kiki/protocol';
import { AdmissionError, ConnectionAdmission } from '../src/services/connections/admission';
import { ConnectionAudience, isPeerProcedureAllowed } from '../src/services/connections/audience';
import { RemoteConnectionManager, validateEndpoint } from '../src/services/connections/manager';
import { directEndpoints, PairingRateLimit } from '../src/services/connections/pairing';

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
    await expect(target.claimPair(live.code, source, 'Source')).rejects.toThrow('invalid_pairing_code');
    expect(target.matchBearer(claimed.peerToken)?.id).toBe(claimed.grantId);
  });

  it('refuses to issue a code when authentication is bypassed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-pair-danger-')); homes.push(home);
    const target = new ConnectionAdmission(home, identity('target'), 'dangerous_auth_bypass');
    await expect(target.createPairCode()).rejects.toMatchObject({ status: 403, reason: 'dangerous_auth_bypass' });
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
      const second = await pairOutbound(manager, { endpoint, code: (await admission.createPairCode()).code, backgroundSummary: false, requestBridge: false }, undefined);
      expect(second.id).toBe(first.id);
      expect(second.pinnedFingerprint).toBe(tls.tlsFingerprint);
      const lease = manager.lease(second.id);
      try { await manager.connect(second.id, lease.signal); expect(manager.get(second.id).state).toBe('online'); }
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
});
