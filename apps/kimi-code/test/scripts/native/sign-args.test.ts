import { describe, expect, it } from 'vitest';

import {
  REQUIRED_SEA_ENTITLEMENTS,
  assertSeaEntitlements,
  buildCodesignArgs,
  macosSigningOptions,
} from '../../../scripts/native/04-sign.mjs';

describe('buildCodesignArgs', () => {
  it('returns ad-hoc args for identity "-"', () => {
    const args = buildCodesignArgs({
      identity: '-',
      executable: '/path/kimi',
      entitlementsPath: '/path/entitlements.plist',
      keychainPath: null,
    });
    expect(args).toEqual(['--sign', '-', '/path/kimi']);
  });

  it('returns hardened-runtime args for Developer ID identity', () => {
    const args = buildCodesignArgs({
      identity: 'Developer ID Application: Example Corp (ABCD1234)',
      executable: '/path/kimi',
      entitlementsPath: '/path/entitlements.plist',
      keychainPath: '/tmp/sign.keychain-db',
    });
    expect(args).toEqual([
      '--sign',
      'Developer ID Application: Example Corp (ABCD1234)',
      '--options',
      'runtime',
      '--entitlements',
      '/path/entitlements.plist',
      '--timestamp',
      '--keychain',
      '/tmp/sign.keychain-db',
      '--force',
      '/path/kimi',
    ]);
  });

  it('omits --keychain when keychainPath is null but uses Developer ID otherwise', () => {
    const args = buildCodesignArgs({
      identity: 'Developer ID Application: Example Corp (ABCD1234)',
      executable: '/path/kimi',
      entitlementsPath: '/path/entitlements.plist',
      keychainPath: null,
    });
    expect(args).toContain('--entitlements');
    expect(args).not.toContain('--keychain');
  });
});

describe('macosSigningOptions', () => {
  it('falls back to ad-hoc when signMacos is false or APPLE_SIGNING_IDENTITY is blank', () => {
    expect(macosSigningOptions(false, { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example' })).toEqual({
      identity: '-',
      keychainPath: null,
    });
    expect(macosSigningOptions(true, { APPLE_SIGNING_IDENTITY: '   ' })).toEqual({
      identity: '-',
      keychainPath: null,
    });
    expect(
      macosSigningOptions(true, {
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example Corp (TEAM123456)',
        APPLE_KEYCHAIN_PATH: '/tmp/sign.keychain-db',
      }),
    ).toEqual({
      identity: 'Developer ID Application: Example Corp (TEAM123456)',
      keychainPath: '/tmp/sign.keychain-db',
    });
  });
});

describe('assertSeaEntitlements', () => {
  it('accepts XML containing all required SEA Hardened Runtime entitlements', () => {
    const xml = `<plist version="1.0"><dict>${REQUIRED_SEA_ENTITLEMENTS.map(
      (key) => `<key>${key}</key><true/>`,
    ).join('')}</dict></plist>`;
    const parsed = assertSeaEntitlements(xml, 'kiki-server');
    for (const key of REQUIRED_SEA_ENTITLEMENTS) {
      expect(parsed.get(key)).toBe(true);
    }
  });

  it('throws when any required SEA JIT entitlement is missing or false', () => {
    const missing = `<plist version="1.0"><dict>
      <key>com.apple.security.cs.allow-jit</key><true/>
      <key>com.apple.security.cs.allow-unsigned-executable-memory</key><false/>
    </dict></plist>`;
    expect(() => assertSeaEntitlements(missing, 'kiki-server')).toThrow(
      /missing required Node\.js SEA Hardened Runtime entitlements/,
    );
  });
});
