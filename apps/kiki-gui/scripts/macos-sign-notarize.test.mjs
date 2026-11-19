import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildBundleCodesignPlan,
  buildNotaryAuthArgs,
  buildSingleCodesignArgs,
  discoverNestedBinaries,
  isNotaryAccepted,
  parseNotarySubmissionId,
  resolveNotarizationAuth,
  resolveSigningConfig,
  verifySidecarEntitlements,
} from './macos-sign-notarize.mjs';

const VALID_SEA_ENTITLEMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-executable-page-protection</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>`;

test('resolveSigningConfig falls back cleanly to ad-hoc when identity is omitted or blank', () => {
  const empty = resolveSigningConfig({}, {});
  assert.equal(empty.identity, '-');
  assert.equal(empty.adHoc, true);
  assert.equal(empty.keychainPath, null);

  const blank = resolveSigningConfig({}, { APPLE_SIGNING_IDENTITY: '   ' });
  assert.equal(blank.identity, '-');
  assert.equal(blank.adHoc, true);

  const devId = resolveSigningConfig(
    {},
    {
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example Corp (TEAM123456)',
      APPLE_KEYCHAIN_PATH: '/tmp/signing.keychain-db',
    },
  );
  assert.equal(devId.identity, 'Developer ID Application: Example Corp (TEAM123456)');
  assert.equal(devId.adHoc, false);
  assert.equal(devId.keychainPath, '/tmp/signing.keychain-db');
});

test('resolveNotarizationAuth supports dual-mode: keychain profile and App Store Connect API key', () => {
  assert.equal(resolveNotarizationAuth({}, {}), null);

  const profileAuth = resolveNotarizationAuth(
    { keychainProfile: 'kiki-notary' },
    { APPLE_KEYCHAIN_PATH: '/tmp/sign.keychain-db' },
  );
  assert.deepEqual(profileAuth, {
    mode: 'keychain-profile',
    profile: 'kiki-notary',
    keychainPath: '/tmp/sign.keychain-db',
  });
  assert.deepEqual(buildNotaryAuthArgs(profileAuth), [
    '--keychain-profile',
    'kiki-notary',
    '--keychain',
    '/tmp/sign.keychain-db',
  ]);

  const apiFileAuth = resolveNotarizationAuth(
    {},
    {
      APPLE_API_KEY: 'KEY1234567',
      APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000001',
      APPLE_API_KEY_PATH: '/tmp/AuthKey_KEY1234567.p8',
    },
  );
  assert.equal(apiFileAuth.mode, 'api-key-file');
  assert.deepEqual(buildNotaryAuthArgs(apiFileAuth), [
    '--key',
    apiFileAuth.keyPath,
    '--key-id',
    'KEY1234567',
    '--issuer',
    '00000000-0000-0000-0000-000000000001',
  ]);

  const apiBase64Auth = resolveNotarizationAuth(
    {},
    {
      APPLE_NOTARIZATION_KEY_ID: 'KEY9999999',
      APPLE_NOTARIZATION_ISSUER_ID: '00000000-0000-0000-0000-000000000002',
      APPLE_NOTARIZATION_KEY_P8: 'ZmFrZS1wOA==',
    },
  );
  assert.equal(apiBase64Auth.mode, 'api-key-p8-base64');
  assert.deepEqual(buildNotaryAuthArgs(apiBase64Auth, '/tmp/materialized.p8'), [
    '--key',
    '/tmp/materialized.p8',
    '--key-id',
    'KEY9999999',
    '--issuer',
    '00000000-0000-0000-0000-000000000002',
  ]);

  assert.throws(
    () => resolveNotarizationAuth({}, { APPLE_API_KEY: 'KEY_ONLY' }),
    /Incomplete App Store Connect API Key/,
  );
});

test('buildBundleCodesignPlan signs inside-out without --deep and preserves SEA entitlements on kiki-server', () => {
  const plan = buildBundleCodesignPlan({
    appPath: '/build/Kiki.app',
    identity: 'Developer ID Application: Example Corp (TEAM123456)',
    entitlementsPath: '/repo/apps/kimi-code/scripts/native/entitlements.plist',
    appEntitlementsPath: '/repo/apps/kiki-gui/src-tauri/entitlements.plist',
    keychainPath: '/tmp/sign.keychain-db',
    nestedBinaries: ['/build/Kiki.app/Contents/Resources/libfoo.dylib'],
  });

  assert.equal(plan.length, 3);
  assert.equal(plan[0].label, 'nested:libfoo.dylib');
  assert.equal(plan[1].label, 'sidecar:kiki-server');
  assert.equal(plan[2].label, 'bundle:Kiki.app');

  for (const step of plan) {
    assert.ok(!step.args.includes('--deep'), `${step.label} must never pass --deep`);
    assert.ok(step.args.includes('--options'));
    assert.ok(step.args.includes('runtime'));
    assert.ok(step.args.includes('--timestamp'));
  }

  assert.ok(plan[1].args.includes('--entitlements'));
  assert.ok(plan[1].args.includes('/repo/apps/kimi-code/scripts/native/entitlements.plist'));
  assert.ok(plan[2].args.includes('/repo/apps/kiki-gui/src-tauri/entitlements.plist'));
});

test('buildSingleCodesignArgs retains entitlements in ad-hoc mode for local SEA execution', () => {
  const args = buildSingleCodesignArgs({
    identity: '-',
    targetPath: '/build/Kiki.app/Contents/MacOS/kiki-server',
    entitlementsPath: '/repo/entitlements.plist',
  });
  assert.deepEqual(args, [
    '--force',
    '--sign',
    '-',
    '--entitlements',
    '/repo/entitlements.plist',
    '/build/Kiki.app/Contents/MacOS/kiki-server',
  ]);
});

test('verifySidecarEntitlements enforces required SEA JIT entitlements on bundled kiki-server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-macos-sign-test-'));
  try {
    const appPath = join(root, 'Kiki.app');
    const macosDir = join(appPath, 'Contents', 'MacOS');
    const resourcesDir = join(appPath, 'Contents', 'Resources');
    mkdirSync(macosDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });
    writeFileSync(join(macosDir, 'kiki-desktop'), 'desktop');
    writeFileSync(join(macosDir, 'kiki-server'), 'server');
    writeFileSync(join(resourcesDir, 'helper.node'), 'addon');

    assert.deepEqual(discoverNestedBinaries(appPath), [join(resourcesDir, 'helper.node')]);

    const passed = await verifySidecarEntitlements(appPath, async (cmd, args) => {
      assert.equal(cmd, 'codesign');
      assert.deepEqual(args, ['-d', '--entitlements', ':-', join(macosDir, 'kiki-server')]);
      return { exitCode: 0, stdout: VALID_SEA_ENTITLEMENTS_XML, stderr: '' };
    });
    assert.equal(passed.verifiedEntitlements.length, 4);

    await assert.rejects(
      () =>
        verifySidecarEntitlements(appPath, async () => ({
          exitCode: 0,
          stdout: '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
          stderr: '',
        })),
      /missing required Node\.js SEA Hardened Runtime entitlements/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('notarytool output helpers extract submission ID and acceptance status', () => {
  const accepted = 'Conducting pre-submission checks...\n  id: 12345678-1234-1234-1234-1234567890ab\n  status: Accepted\n';
  assert.equal(parseNotarySubmissionId(accepted), '12345678-1234-1234-1234-1234567890ab');
  assert.equal(isNotaryAccepted(accepted), true);

  const rejected = '  id: abcdefab-1234-1234-1234-1234567890ab\n  status: Invalid\n';
  assert.equal(parseNotarySubmissionId(rejected), 'abcdefab-1234-1234-1234-1234567890ab');
  assert.equal(isNotaryAccepted(rejected), false);
});
