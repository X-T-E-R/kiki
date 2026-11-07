import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionAdmission } from '../src/services/connections/admission';
import { validateEndpoint } from '../src/services/connections/manager';
import { PairingRateLimit } from '../src/services/connections/pairing';

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
