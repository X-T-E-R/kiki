import { describe, expect, it } from 'vitest';
import {
  classifyRelayInput,
  connectionHandshakeSchema,
  connectionPairInputSchema,
  extractRelayTargetFingerprint,
  formatPairingUri,
  formatRelayShareUri,
  generateRelayDeployGuide,
  isDirectConnectionHost,
  isValidRelaySubscriptionUrl,
  normalizePairingCode,
  normalizeRelayBaseUrl,
  normalizeRelayEndpoint,
  pairCodeCreateOutputSchema,
  parsePairingUri,
  parseRelayShareUri,
  readConnectInput,
  readScanPayload,
  relaySubscriptionCreateInputSchema,
  remoteConnectionSchema,
} from '../index';

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

  it('validates connectionPairInputSchema with optional requestBridge, includeGui, and rejects unknown keys', () => {
    const base = { endpoint: 'http://127.0.0.1:58627', code: 'K9F2-7X4M' };
    expect(connectionPairInputSchema.parse(base)).toEqual({
      ...base,
      backgroundSummary: true,
    });
    expect(connectionPairInputSchema.parse({ ...base, includeGui: false })).toEqual({
      ...base,
      includeGui: false,
      backgroundSummary: false,
    });
    expect(connectionPairInputSchema.parse({ ...base, includeGui: false, backgroundSummary: true })).toEqual({
      ...base,
      includeGui: false,
      backgroundSummary: false,
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

  it('validates optional TLS fingerprints and loopbackEndpoint on pair-code, handshake, and remote-connection contracts', () => {
    const fingerprint = '0123456789abcdef'.repeat(4);
    const identity = { homeId: '11111111-1111-4111-8111-111111111111', hostId: 'pair-host', protocol: 1 as const };
    const pairCode = {
      code: 'K9F2-7X4M', expiresAt: 1_800_000_000_000, target: identity, suggestedEndpoints: ['https://pair.example.test'],
    };
    expect(pairCodeCreateOutputSchema.parse(pairCode)).toEqual(pairCode);
    expect(pairCodeCreateOutputSchema.parse({ ...pairCode, loopbackEndpoint: 'https://127.0.0.1:54321' })).toEqual({ ...pairCode, loopbackEndpoint: 'https://127.0.0.1:54321' });
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

  it('preserves multi-endpoint & relay= candidates in kiki://pair and parses kiki-relay:// share URIs', () => {
    const fp = '0123456789abcdef'.repeat(4);
    const r1 = `wss://relay-a.example.com/kiki-relay/v1/stream?target=${fp}&rt=p.1800000000.${'a'.repeat(64)}`;
    const r2 = `wss://relay-b.example.com/v1/stream?target=${fp}&rt=p.1800000000.${'b'.repeat(64)}`;
    const multiUri = formatPairingUri({
      endpoint: 'https://192.168.1.40:58627',
      endpoints: ['https://192.168.1.40:58627', 'https://100.90.10.2:58627'],
      relayEndpoints: [r1, r2],
      code: 'k9f27x4m',
      fingerprint: fp,
    });
    const parsed = parsePairingUri(multiUri);
    expect(parsed).toEqual({
      endpoint: 'https://192.168.1.40:58627',
      endpoints: ['https://192.168.1.40:58627', 'https://100.90.10.2:58627'],
      relayEndpoints: [r1, r2],
      code: 'K9F2-7X4M',
      fingerprint: fp,
    });
    expect(() =>
      formatPairingUri({
        endpoint: 'https://192.168.1.40:58627',
        relayEndpoints: [r1],
        code: 'k9f27x4m',
      }),
    ).toThrow(/fingerprint/i);
    expect(normalizeRelayEndpoint('ws://relay.example.com/v1/stream')).toBeUndefined();
    expect(normalizeRelayEndpoint('ws://127.0.0.1:18787/v1/stream?target=' + fp)).toBe(
      `ws://127.0.0.1:18787/v1/stream?target=${fp}`,
    );
    expect(extractRelayTargetFingerprint(r1)).toBe(fp);

    const scanned = readScanPayload(multiUri);
    expect(scanned).toEqual({
      ok: true,
      kind: 'pair',
      origin: 'https://192.168.1.40:58627',
      endpoint: 'https://192.168.1.40:58627',
      endpoints: ['https://192.168.1.40:58627', 'https://100.90.10.2:58627'],
      relayEndpoints: [r1, r2],
      code: 'K9F2-7X4M',
      entry: 'https://192.168.1.40:58627/',
      fingerprint: fp,
    });

    const manualRelay = readConnectInput(r1, 'k9f27x4m');
    expect(manualRelay).toEqual({
      ok: true,
      kind: 'pair',
      origin: 'https://relay-a.example.com',
      endpoint: r1,
      relayEndpoints: [r1],
      code: 'K9F2-7X4M',
      entry: 'https://relay-a.example.com/',
      fingerprint: fp,
    });

    const shareUri = formatRelayShareUri({
      url: 'wss://relay.example.com:443/kiki-relay',
      label: 'HK Edge',
      token: 'secret-host-token',
      role: 'backup-only',
    });
    expect(shareUri).toBe(
      'kiki-relay://relay.example.com/kiki-relay?name=HK+Edge&token=secret-host-token&role=backup-only',
    );
    expect(parseRelayShareUri(shareUri)).toEqual({
      url: 'wss://relay.example.com/kiki-relay',
      label: 'HK Edge',
      token: 'secret-host-token',
      role: 'backup-only',
      insecure: false,
    });
    expect(parseRelayShareUri('kiki-relay://relay.example.com/kiki-relay?insecure=1&token=leak')).toBeUndefined();
    expect(parseRelayShareUri('kiki-relay://127.0.0.1:9440/kiki-relay?insecure=1&token=local-tok')?.url).toBe(
      'ws://127.0.0.1:9440/kiki-relay',
    );
    expect(normalizeRelayBaseUrl('ws://relay.example.com/kiki-relay')).toBeUndefined();
    expect(normalizeRelayBaseUrl('https://relay.example.com/kiki-relay/v1/pool')).toBe(
      'wss://relay.example.com/kiki-relay',
    );
    expect(classifyRelayInput(shareUri).kind).toBe('share-uri');
    expect(classifyRelayInput('https://team.example.com/relays.json')).toEqual({
      kind: 'subscription-url',
      url: 'https://team.example.com/relays.json',
    });
    expect(classifyRelayInput('http://team.example.com/relays.json').kind).toBe('invalid');
    expect(isValidRelaySubscriptionUrl('https://team.example.com/relays.json')).toBe(true);
    expect(isValidRelaySubscriptionUrl('http://team.example.com/relays.json')).toBe(false);
    expect(isValidRelaySubscriptionUrl('http://127.0.0.1:19440/relays.json')).toBe(true);
    expect(relaySubscriptionCreateInputSchema.safeParse({ url: 'http://team.example.com/relays.json' }).success).toBe(false);
    expect(relaySubscriptionCreateInputSchema.safeParse({ url: 'https://team.example.com/relays.json' }).success).toBe(true);
    const guide = generateRelayDeployGuide({ publicHost: 'relay.example.com', proxyTarget: 'nginx' });
    expect(guide.port).toBe(9440);
    expect(guide.proxySnippet).toContain('proxy_http_version 1.1;');
    expect(guide.proxySnippet).toContain('proxy_read_timeout 3600s;');
    expect(guide.npxCommand).toContain('node server/kiki-relay-server.mjs');
    expect(guide.npxCommand).toContain('RELAY_SECRET=');
    expect(guide.npxCommand).toContain('RELAY_HOST_TOKEN=');
    expect(guide.dockerCommand).toContain('docker build -f server/Dockerfile');
    expect(guide.dockerCommand).toContain('RELAY_SECRET=');
    expect(guide.dockerComposeYaml).toContain('RELAY_SECRET: "${RELAY_SECRET:?Set RELAY_SECRET}"');
    expect(guide.dockerCommand).not.toContain('ghcr.io');
    expect(guide.npxCommand).not.toContain('@kiki/relay-server');
  });
});
