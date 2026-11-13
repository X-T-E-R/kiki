import { describe, expect, it } from 'vitest';
import { connectionHandshakeSchema, connectionPairInputSchema, formatPairingUri, isDirectConnectionHost, normalizePairingCode, pairCodeCreateOutputSchema, parsePairingUri, remoteConnectionSchema } from '../rest/connections';

describe('pairing code', () => {
  it('folds case and an optional hyphen into XXXX-XXXX', () => {
    expect(normalizePairingCode('k9f2-7x4m')).toBe('K9F2-7X4M');
    expect(normalizePairingCode('  k9f27x4m ')).toBe('K9F2-7X4M');
    expect(normalizePairingCode('K9F2-7X4')).toBeUndefined();
    expect(normalizePairingCode('K9F2-7X4I')).toBeUndefined();
  });

  it('round-trips pairing URIs with optional fingerprints while preserving the legacy parsed shape', () => {
    const endpoint = 'http://192.168.1.40:58627';
    const legacyUri = formatPairingUri({ endpoint, code: 'k9f27x4m' });
    expect(legacyUri).toBe('kiki://pair?endpoint=http%3A%2F%2F192.168.1.40%3A58627&code=K9F2-7X4M');
    expect(parsePairingUri(legacyUri)).toEqual({ endpoint, code: 'K9F2-7X4M' });

    const fingerprint = '0123456789abcdef'.repeat(4);
    const uri = formatPairingUri({ endpoint, code: 'k9f27x4m', fingerprint });
    expect(uri).toBe(`${legacyUri}&fp=${fingerprint}`);
    expect(parsePairingUri(uri)).toEqual({ endpoint, code: 'K9F2-7X4M', fingerprint });
    expect(() => formatPairingUri({ endpoint, code: 'k9f27x4m', fingerprint: 'A'.repeat(64) })).toThrow();
    expect(parsePairingUri(`${legacyUri}&fp=${'A'.repeat(64)}`)).toBeUndefined();
    expect(parsePairingUri('kiki:///pair?endpoint=https%3A%2F%2Fb.example.test&code=K9F2-7X4M')).toEqual({ endpoint: 'https://b.example.test', code: 'K9F2-7X4M' });
    expect(parsePairingUri('kiki://pair?endpoint=http%3A%2F%2F192.168.1.40%3A58627&code=invalid')).toBeUndefined();
    expect(parsePairingUri('https://b.example.test/pair')).toBeUndefined();
  });

  it('treats loopback, LAN, link-local and Tailscale names as direct', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '10.1.2.3', '192.168.1.40', '172.16.0.1', '100.64.1.8', '169.254.1.1', 'fe80::1', 'box.local', 'host.tailnet.ts.net']) {
      expect(isDirectConnectionHost(host), host).toBe(true);
    }
    expect(isDirectConnectionHost('b.example.test')).toBe(false);
    expect(isDirectConnectionHost('1.2.3.4')).toBe(false);
    expect(isDirectConnectionHost('100.63.1.1')).toBe(false);
  });

  it('validates connectionPairInputSchema with optional requestBridge and rejects unknown keys', () => {
    const base = { endpoint: 'http://127.0.0.1:58627', code: 'K9F2-7X4M' };
    expect(connectionPairInputSchema.parse(base)).toEqual({
      ...base,
      backgroundSummary: true,
    });
    expect(connectionPairInputSchema.parse({ ...base, requestBridge: false })).toEqual({
      ...base,
      backgroundSummary: true,
      requestBridge: false,
    });
    expect(connectionPairInputSchema.parse({ ...base, requestBridge: true })).toEqual({
      ...base,
      backgroundSummary: true,
      requestBridge: true,
    });
    const fingerprint = '0123456789abcdef'.repeat(4);
    expect(connectionPairInputSchema.parse({ ...base, fingerprint })).toEqual({ ...base, backgroundSummary: true, fingerprint });
    expect(() => connectionPairInputSchema.parse({ ...base, fingerprint: 'A'.repeat(64) })).toThrow();
    expect(() => connectionPairInputSchema.parse({ ...base, unknownKey: 'value' })).toThrow();
  });

  it('validates optional TLS fingerprints on pair-code, handshake, and remote-connection contracts', () => {
    const fingerprint = '0123456789abcdef'.repeat(4);
    const identity = { homeId: '11111111-1111-4111-8111-111111111111', hostId: 'pair-host', protocol: 1 as const };
    const pairCode = {
      code: 'K9F2-7X4M', expiresAt: 1_800_000_000_000, target: identity, suggestedEndpoints: ['https://pair.example.test'],
    };
    expect(pairCodeCreateOutputSchema.parse(pairCode)).toEqual(pairCode);
    expect(pairCodeCreateOutputSchema.parse({ ...pairCode, tlsFingerprint: fingerprint })).toEqual({ ...pairCode, tlsFingerprint: fingerprint });
    expect(() => pairCodeCreateOutputSchema.parse({ ...pairCode, tlsFingerprint: 'A'.repeat(64) })).toThrow();

    const handshake = { identity, serverId: 'server-1', inboundEnabled: true };
    expect(connectionHandshakeSchema.parse(handshake)).toEqual(handshake);
    expect(connectionHandshakeSchema.parse({ ...handshake, tlsFingerprint: fingerprint })).toEqual({ ...handshake, tlsFingerprint: fingerprint });
    expect(() => connectionHandshakeSchema.parse({ ...handshake, tlsFingerprint: 'a'.repeat(63) })).toThrow();

    const remote = {
      id: '22222222-2222-4222-8222-222222222222', label: 'Pair host', endpoint: 'https://pair.example.test', target: identity,
      credentialRef: 'credential-1', enabled: true, backgroundSummary: false, purposes: ['gui'] as const, state: 'online' as const, activeLeases: 0,
    };
    expect(remoteConnectionSchema.parse(remote)).toEqual(remote);
    expect(remoteConnectionSchema.parse({ ...remote, pinnedFingerprint: fingerprint, fingerprintToVerify: fingerprint })).toEqual({ ...remote, pinnedFingerprint: fingerprint, fingerprintToVerify: fingerprint });
    expect(() => remoteConnectionSchema.parse({ ...remote, fingerprintToVerify: 'A'.repeat(64) })).toThrow();
  });
});
