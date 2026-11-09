import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { createPrepareReceipt } from '../../../kimi-code/scripts/native/release-receipt.mjs';
import { androidVersion } from '../scripts/android-version.mjs';
import {
  INPUT_NAME, LAUNCHER_FILES, RECEIPT_NAME, certificateFingerprint, freezeAndroidInput,
  parseApkReports, requireSigningSecrets, selectAndroidArtifact, stageAndroidArtifact,
  verifyAndroidArtifact, verifyAndroidInput,
} from '../scripts/android-artifact.mjs';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const CERT = 'ab'.repeat(32);
const VERSION = androidVersion('1.2.3-beta.2');
const EXPECTED = {
  repository: 'example/kiki', sourceSha: SHA, runId: '84', producerAttempt: '1', candidateAttempt: '2',
  tag: 'kiki-v1.2.3-beta.2', version: '1.2.3-beta.2', channel: 'beta',
};
function reports(variant = 'release') {
  const icon = variant === 'debug' ? 'res/mipmap-anydpi-v26/ic_launcher.xml' : 'res/BW.xml';
  const shortcut = variant === 'debug' ? 'res/xml/shortcuts.xml' : 'res/Eq.xml';
  const xmlTrees = { [shortcut]: `N: android=http://schemas.android.com/apk/res/android
  E: shortcuts (line=2)
    E: shortcut (line=7)
      A: android:icon(0x01010002)=@0x7f0c0000
      A: android:enabled(0x0101000e)=(type 0x12)0xffffffff
      A: android:shortcutId(0x01010528)="change_server" (Raw: "change_server")
      A: android:shortcutShortLabel(0x01010529)=@0x7f0d0024
      E: intent (line=11)
        A: android:targetPackage(0x01010021)="ai.easyagent.kiki" (Raw: "ai.easyagent.kiki")
        A: android:action(0x0101002d)="ai.easyagent.kiki.CHANGE_SERVER" (Raw: "ai.easyagent.kiki.CHANGE_SERVER")
        A: android:targetClass(0x0101002f)="ai.easyagent.kiki.MainActivity" (Raw: "ai.easyagent.kiki.MainActivity")
` };
  return {
    badging: `package: name='ai.easyagent.kiki' versionCode='1002003' versionName='1.2.3-beta.2'\n` +
      `sdkVersion:'24'\ntargetSdkVersion:'36'\napplication: label='Kiki' icon='${icon}'\n` +
      `launchable-activity: name='ai.easyagent.kiki.MainActivity' label='Kiki' icon=''\n${variant === 'debug' ? 'application-debuggable\n' : ''}`,
    signing: `Signer #1 certificate DN: CN=Example release\nSigner #1 certificate SHA-256 digest: ${CERT}\n`,
    files: [...LAUNCHER_FILES, icon, 'res/fallback.png', shortcut].join('\n'),
    manifest: `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    E: application (line=23)
      A: android:icon(0x01010002)=@0x7f0c0000
      E: activity (line=33)
        A: android:name(0x01010003)="ai.easyagent.kiki.MainActivity" (Raw: "ai.easyagent.kiki.MainActivity")
        E: meta-data (line=47)
          A: android:name(0x01010003)="android.app.shortcuts" (Raw: "android.app.shortcuts")
          A: android:resource(0x01010025)=@0x7f100003
`,
    resources: `      config mdpi:
        resource 0x7f0c0000 ai.easyagent.kiki:mipmap/ic_launcher: t=0x03 d=0x00000100 (s=0x0008 r=0x00)
          (string8) "res/fallback.png"
      config anydpi-v26:
        resource 0x7f0c0000 ai.easyagent.kiki:mipmap/ic_launcher: t=0x03 d=0x00000101 (s=0x0008 r=0x00)
          (string8) "${icon}"
      config (default):
        resource 0x7f100003 ai.easyagent.kiki:xml/shortcuts: t=0x03 d=0x00000102 (s=0x0008 r=0x00)
          (string8) "${shortcut}"
        resource 0x7f0d0024 ai.easyagent.kiki:string/change_server: t=0x03 d=0x00000103 (s=0x0008 r=0x00)
          (string8) "Change server"
      config zh:
        resource 0x7f0d0024 ai.easyagent.kiki:string/change_server: t=0x03 d=0x00000104 (s=0x0008 r=0x00)
          (string16) "更换服务器"
`,
    xmlTrees, readXml: path => xmlTrees[path] ?? '',
  };
}
const inspect = (_, options) => parseApkReports(reports(options.variant), options);
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kiki-android-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['apps/kiki-gui/package.json', 'apps/kimi-code/package.json', 'apps/kiki-gui/src-tauri/tauri.conf.json']) {
    write(join(root, path), JSON.stringify({ version: VERSION.versionName }));
  }
  write(join(root, 'apps/kiki-gui/src-tauri/Cargo.toml'), `[package]\nversion = "${VERSION.versionName}"\n`);
  write(join(root, 'system.yaml'), `system:\n  version: ${VERSION.versionName}\n`);
  write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  write(join(root, 'apps/kiki-gui/mobile/package-lock.json'), '{"lockfileVersion":3}\n');
  const inputDir = join(root, 'input');
  const catalog = join(inputDir, 'built-in-catalog.json');
  write(catalog, '{"example":{}}\n');
  const keyPacket = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8, 1), Buffer.alloc(32, 2)]);
  const publicKey = Buffer.from(`untrusted comment: offline fixture\n${keyPacket.toString('base64')}\n`).toString('base64');
  const prepare = createPrepareReceipt({ root, catalogPath: catalog, ...EXPECTED,
    producerAttempt: '1', nodeVersion: process.versions.node, pnpmVersion: '10.33.0', updaterPublicKey: publicKey });
  write(join(inputDir, 'release-input.json'), JSON.stringify(prepare));
  const options = { root, inputDir, expected: EXPECTED, prepareArtifactId: '9001', certificateSha256: CERT };
  freezeAndroidInput(options);
  const apk = join(root, 'app-release.apk');
  write(apk, 'APK bytes fixture');
  return { ...options, apk, output: join(root, 'output'), variant: 'release', inspect };
}

await test('Android derives the existing code mapping and exact versionName from the unified GUI version', () => {
  assert.deepEqual(androidVersion('0.5.1'), { versionName: '0.5.1', versionCode: 5001 });
  assert.deepEqual(VERSION, { versionName: '1.2.3-beta.2', versionCode: 1002003 });
  for (const version of ['1.2', '1.2.3-other', '1.1000.0', '1.0.1000', '2101.0.0', '0.0.0']) {
    assert.throws(() => androidVersion(version), /version|range/);
  }
});

await test('missing signing credentials and invalid fingerprints fail with precise public input names', () => {
  assert.throws(() => requireSigningSecrets({}), /KIKI_ANDROID_KEYSTORE_BASE64.*KIKI_ANDROID_STORE_PASSWORD.*KIKI_ANDROID_KEY_ALIAS.*KIKI_ANDROID_KEY_PASSWORD/);
  const env = { KIKI_ANDROID_KEYSTORE_BASE64: 'Zml4dHVyZQ==', KIKI_ANDROID_STORE_PASSWORD: 'fixture',
    KIKI_ANDROID_KEY_ALIAS: '1', KIKI_ANDROID_KEY_PASSWORD: 'fixture' };
  assert.equal(requireSigningSecrets(env).toString(), 'fixture');
  assert.throws(() => requireSigningSecrets({ ...env, KIKI_ANDROID_KEYSTORE_BASE64: 'not base64' }), /base64-encoded/);
  assert.equal(certificateFingerprint(CERT.toUpperCase().match(/../g).join(':')), CERT);
  assert.throws(() => certificateFingerprint(''), /KIKI_ANDROID_SIGNING_CERT_SHA256/);
});

await test('real-tool report contract checks inherited launcher icon, signature, package, versions, SDK and resources', () => {
  assert.equal(parseApkReports(reports(), { variant: 'release', version: VERSION, certificateSha256: CERT }).certificateSha256, CERT);
  assert.equal(parseApkReports(reports('debug'), { variant: 'debug', version: VERSION }).debuggable, true);
  const mutations = [
    [r => { r.badging = r.badging.replace('ai.easyagent.kiki', 'example.bad'); }, /application ID/],
    [r => { r.badging = r.badging.replace("versionName='1.2.3-beta.2'", "versionName='1.2.4'"); }, /versionName/],
    [r => { r.badging = r.badging.replace("versionCode='1002003'", "versionCode='1'"); }, /versionCode/],
    [r => { r.badging += 'application-debuggable\n'; }, /debuggable/],
    [r => { r.badging = r.badging.replace("targetSdkVersion:'36'", "targetSdkVersion:'35'"); }, /SDK/],
    [r => { r.badging = r.badging.replace('MainActivity', 'MissingActivity'); }, /launcher/],
    [r => { r.files = r.files.replace('assets/public/launcher.js', ''); }, /launcher resource/],
    [r => { r.signing = r.signing.replace(CERT, 'cd'.repeat(32)); }, /release certificate/],
    [r => { r.signing = r.signing.replace('Example release', 'Android Debug'); }, /Debug certificates/],
    [r => { r.signing = ''; }, /exactly one/],
  ];
  for (const [mutate, error] of mutations) {
    const r = reports();
    mutate(r);
    assert.throws(() => parseApkReports(r, { variant: 'release', version: VERSION, certificateSha256: CERT }), error);
  }
});

await test('compiled launcher references accept optimized release paths and reject missing or broken shortcut resources', () => {
  const options = { variant: 'release', version: VERSION, certificateSha256: CERT };
  const crlf = reports();
  crlf.manifest = crlf.manifest.replaceAll('\n', '\r\n');
  crlf.resources = crlf.resources.replaceAll('\n', '\r\n');
  crlf.xmlTrees['res/Eq.xml'] = crlf.xmlTrees['res/Eq.xml'].replaceAll('\n', '\r\n');
  assert.equal(parseApkReports(crlf, options).applicationId, 'ai.easyagent.kiki');
  const mutations = [
    [r => { r.manifest = r.manifest.replaceAll('android.app.shortcuts', 'example.missing'); }, /shortcut metadata/],
    [r => { r.manifest = r.manifest.replace('E: activity ', 'E: provider '); }, /shortcut metadata/],
    [r => { r.manifest = r.manifest.replace('@0x7f100003', '@0x7f100002'); }, /shortcut resource/],
    [r => { r.resources = r.resources.replace('resource 0x7f100003', 'resource 0x7f100002'); }, /shortcut resource/],
    [r => { r.files = r.files.replace('res/Eq.xml', 'res/xml/shortcuts.xml'); }, /resource is missing: res\/Eq.xml/],
    [r => { r.files = r.files.replace('res/fallback.png', ''); }, /resource is missing: res\/fallback.png/],
    [r => { r.xmlTrees['res/Eq.xml'] = ''; }, /change_server launcher shortcut is missing/],
    [r => { r.xmlTrees['res/Eq.xml'] = r.xmlTrees['res/Eq.xml'].replaceAll('change_server', 'missing'); }, /change_server/],
    [r => { r.xmlTrees['res/Eq.xml'] = r.xmlTrees['res/Eq.xml'].replace('0xffffffff', '0x0'); }, /shortcut enabled/],
    [r => { r.xmlTrees['res/Eq.xml'] = r.xmlTrees['res/Eq.xml'].replace('@0x7f0c0000', '@0x7f0c0001'); }, /shortcut icon/],
    [r => { r.xmlTrees['res/Eq.xml'] = r.xmlTrees['res/Eq.xml'].replace('@0x7f0d0024', '@0x7f0c0000'); }, /shortcut label resource/],
    [r => { r.resources = r.resources.replace('"Change server"', '""'); }, /shortcut label resource/],
    [r => { r.xmlTrees['res/Eq.xml'] = r.xmlTrees['res/Eq.xml'].replaceAll('CHANGE_SERVER', 'MISSING'); }, /shortcut action/],
    [r => { r.xmlTrees['res/Eq.xml'] = r.xmlTrees['res/Eq.xml'].replace('targetPackage(0x01010021)="ai.easyagent.kiki"', 'targetPackage(0x01010021)="example.other"'); }, /shortcut targetPackage/],
    [r => { r.xmlTrees['res/Eq.xml'] = r.xmlTrees['res/Eq.xml'].replaceAll('MainActivity', 'MissingActivity'); }, /shortcut targetClass/],
    [r => { r.xmlTrees['res/Eq.xml'] = r.xmlTrees['res/Eq.xml'].replace('E: intent ', 'E: extra '); }, /shortcut intent count/],
  ];
  for (const [mutate, error] of mutations) {
    const r = reports();
    mutate(r);
    assert.throws(() => parseApkReports(r, options), error);
  }
});

await test('release APK receipt binds the frozen prepare, npm lock, source and exact producer attempt', t => {
  const options = fixture(t);
  const receipt = stageAndroidArtifact(options);
  assert.equal(receipt.prepare.artifactId, '9001');
  assert.equal(receipt.tag, EXPECTED.tag);
  const verify = { ...options, directory: options.output };
  assert.deepEqual(verifyAndroidArtifact(verify), receipt);
  for (const [key, value, error] of [
    ['sourceSha', 'a'.repeat(40), /sourceSha/], ['runId', '85', /workflow/], ['candidateAttempt', '3', /workflow/],
  ]) assert.throws(() => verifyAndroidArtifact({ ...verify, expected: { ...EXPECTED, [key]: value } }), error);
  assert.throws(() => verifyAndroidArtifact({ ...verify, prepareArtifactId: '9002' }), /prepare/);
  write(join(options.output, `${receipt.apk.name}.sha256`), `${'0'.repeat(64)}  ${receipt.apk.name}\n`);
  assert.throws(() => verifyAndroidArtifact(verify), /checksum/);
});

await test('tampered APK and wrong version/source/lock are rejected before publication', t => {
  const options = fixture(t);
  const receipt = stageAndroidArtifact(options);
  write(join(options.output, receipt.apk.name), 'APK changed');
  assert.throws(() => verifyAndroidArtifact({ ...options, directory: options.output }), /APK (bytes|SHA-256)/);
  write(join(options.root, 'apps/kiki-gui/mobile/package-lock.json'), '{}\n');
  assert.throws(() => verifyAndroidInput(options), /frozen Android input/);
});

await test('release cannot stage without the prepare input or with a mismatched GUI version', t => {
  const options = fixture(t);
  rmSync(join(options.inputDir, INPUT_NAME));
  assert.throws(() => stageAndroidArtifact(options), /ENOENT/);
  assert.equal(existsSync(options.output), false);
  freezeAndroidInput(options);
  write(join(options.root, 'apps/kiki-gui/package.json'), '{"version":"1.2.4"}');
  assert.throws(() => stageAndroidArtifact(options), /release version/);
  assert.equal(existsSync(options.output), false);
});

await test('debug and signed checks are distinct artifacts and never product release inputs', t => {
  const options = fixture(t);
  const debug = stageAndroidArtifact({ ...options, variant: 'debug' });
  assert.equal(debug.tag, null);
  assert.equal(debug.prepare, null);
  assert.throws(() => verifyAndroidArtifact({ ...options, directory: options.output }), /variant/);
  const checkDir = join(options.root, 'signing-check');
  const check = stageAndroidArtifact({ ...options, variant: 'release-check', output: checkDir });
  assert.equal(check.debuggable, false);
  assert.equal(check.certificateSha256, CERT);
  assert.equal(check.tag, null);
  verifyAndroidArtifact({ ...options, variant: 'release-check', directory: checkDir });
  assert.throws(() => verifyAndroidArtifact({ ...options, directory: checkDir }), /variant/);
  assert.throws(() => stageAndroidArtifact({ ...options, variant: 'release-check', certificateSha256: 'cd'.repeat(32), output: join(options.root, 'bad-check') }), /release certificate/);
});

await test('reruns reuse the latest available Android candidate only within the same run', () => {
  const artifact = (id, attempt) => ({ id, name: `kiki-release-android-84-${attempt}`, expired: false });
  const select = artifacts => selectAndroidArtifact({ artifacts, runId: '84', currentAttempt: '3' });
  assert.deepEqual(select([artifact(100, 1), artifact(200, 2), { ...artifact(300, 3), name: 'kiki-release-android-83-3' }]), { id: 200, attempt: 2 });
  assert.throws(() => select([]), /Missing/);
  assert.throws(() => select([artifact(100, 1), artifact(101, 1)]), /Duplicate/);
  assert.throws(() => select([artifact(100, 4)]), /future/);
  assert.throws(() => select([{ ...artifact(100, 1), expired: true }]), /unavailable/);
});

await test('Android SDK setup overrides retired tools defaults and retains the required platform and build-tools', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  for (const [name, setupCount] of [['kiki-android-ci.yml', 1], ['kiki-android-signing-check.yml', 1], ['kiki-desktop-release.yml', 2]]) {
    const workflow = readFileSync(join(root, '.github/workflows', name), 'utf8');
    const setups = [...workflow.matchAll(/^      - uses: android-actions\/setup-android@v3\r?\n((?: {8,}[^\r\n]*\r?\n)*)/gm)];
    assert.equal(setups.length, setupCount, `${name}: check every Android initialization step`);
    for (const setup of setups) {
      assert.match(setup[1], /^        with:\r?\n/, `${name}: override setup-android's retired tools default`);
      assert.match(setup[1], /^          packages: platform-tools\r?$/m, `${name}: install only the supported platform-tools bootstrap package`);
    }
    assert.match(workflow, /run: sdkmanager 'platforms;android-36' 'build-tools;36\.1\.0'/, `${name}: retain the APK build SDK`);
  }
});

await test('workflows keep unsigned CI, protected manual signing and immutable tag publication separate', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const ci = readFileSync(join(root, '.github/workflows/kiki-android-ci.yml'), 'utf8');
  const check = readFileSync(join(root, '.github/workflows/kiki-android-signing-check.yml'), 'utf8');
  const release = readFileSync(join(root, '.github/workflows/kiki-desktop-release.yml'), 'utf8');
  assert.match(ci, /pull_request:/);
  assert.match(ci, /branches: \['\*\*'\]/);
  assert.doesNotMatch(ci, /secrets\.|environment: release/);
  assert.match(ci, /--variant debug/);
  assert.match(check, /workflow_dispatch:/);
  assert.doesNotMatch(check, /gh release|contents: write|tags:/);
  assert.match(check, /environment: release/);
  assert.match(check, /--variant release-check/);
  assert.match(check, /if: always\(\)/);
  assert.match(release, /ref: \$\{\{ needs.prepare.outputs.source-sha \}\}/);
  assert.match(release, /android-artifact.mjs freeze/);
  assert.match(release, /- cli-native\n      - android/);
  assert.match(release, /artifact-ids: \$\{\{ steps.target-artifacts.outputs.artifact-id \}\}/);
  assert.match(release, /KIKI_ANDROID_PRODUCER_ATTEMPT:/);
  assert.equal((release.match(/cli-native\/kiki-darwin-\* android-candidate\/\*/g) ?? []).length, 2);
  assert.match(release, /Published release is missing asset; refusing to mutate public assets/);
  assert.doesNotMatch(release, /gh release upload[^\n]*--clobber/);
  const gradle = readFileSync(join(root, 'apps/kiki-gui/mobile/android/app/build.gradle'), 'utf8');
  assert.match(gradle, /storeType 'PKCS12'/);
  assert.match(gradle, /keyAlias releaseSigning.KIKI_ANDROID_KEY_ALIAS/);
  assert.match(gradle, /signingConfig signingConfigs.release/);
  const mobilePkg = JSON.parse(readFileSync(join(root, 'apps/kiki-gui/mobile/package.json'), 'utf8'));
  const mobileLock = JSON.parse(readFileSync(join(root, 'apps/kiki-gui/mobile/package-lock.json'), 'utf8'));
  assert.equal(mobilePkg.version, undefined);
  assert.equal(typeof mobilePkg.devDependencies?.playwright, 'string');
  assert.equal(mobileLock.packages?.['']?.devDependencies?.playwright, mobilePkg.devDependencies.playwright);
  assert.equal(mobileLock.packages?.['node_modules/playwright']?.version, mobilePkg.devDependencies.playwright);
  const targetTest = readFileSync(join(root, 'apps/kiki-gui/mobile/test/target.test.mjs'), 'utf8');
  assert.doesNotMatch(targetTest, /\.\.\/\.\.\/node_modules\//);
  assert.match(targetTest, /from 'playwright'/);
  for (const [name, workflow] of [['kiki-android-ci.yml', ci], ['kiki-android-signing-check.yml', check], ['kiki-desktop-release.yml', release]]) {
    assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/, `${name}: clean mobile npm ci`);
    assert.match(workflow, /\.\/node_modules\/\.bin\/playwright install chromium/, `${name}: install Chromium for mobile tests`);
  }
  assert.ok(RECEIPT_NAME.endsWith('.json'));
});
