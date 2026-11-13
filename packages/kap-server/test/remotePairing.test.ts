import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpsServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createServer as createNetServer, type Socket } from 'node:net';
import { peerFetch } from '../src/services/connections/peerTls';
import { loadPeerTlsIdentity, spkiFingerprint } from '../src/services/connections/tlsIdentity';
import { pairOutbound } from '../src/services/connections/pairing';
import { formatPairingUri, parsePairingUri } from '@kiki/protocol';
import { ConnectionAdmission } from '../src/services/connections/admission';
import { RemoteConnectionManager, validateEndpoint } from '../src/services/connections/manager';
import { directEndpoints, PairingRateLimit } from '../src/services/connections/pairing';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const identity = (hostId: string) => ({ homeId: randomUUID(), hostId, protocol: 1 as const });

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
