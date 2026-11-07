import { describe, expect, it } from 'vitest';
import { isDirectConnectionHost, normalizePairingCode } from '../rest/connections';

describe('pairing code', () => {
  it('folds case and an optional hyphen into XXXX-XXXX', () => {
    expect(normalizePairingCode('k9f2-7x4m')).toBe('K9F2-7X4M');
    expect(normalizePairingCode('  k9f27x4m ')).toBe('K9F2-7X4M');
    expect(normalizePairingCode('K9F2-7X4')).toBeUndefined();
    expect(normalizePairingCode('K9F2-7X4I')).toBeUndefined();
  });

  it('treats loopback, LAN, link-local and Tailscale names as direct', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '10.1.2.3', '192.168.1.40', '172.16.0.1', '100.64.1.8', '169.254.1.1', 'fe80::1', 'box.local', 'host.tailnet.ts.net']) {
      expect(isDirectConnectionHost(host), host).toBe(true);
    }
    expect(isDirectConnectionHost('b.example.test')).toBe(false);
    expect(isDirectConnectionHost('1.2.3.4')).toBe(false);
    expect(isDirectConnectionHost('100.63.1.1')).toBe(false);
  });
});
