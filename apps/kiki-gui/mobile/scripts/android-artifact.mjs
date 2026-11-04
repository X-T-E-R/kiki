import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { describeFile, verifyPrepareReceipt } from '../../../kimi-code/scripts/native/release-receipt.mjs';
import { readAndroidVersion } from './android-version.mjs';

const ROOT = resolve(import.meta.dirname, '../../../..');
export const BUILD_TOOLS = '36.1.0';
export const INPUT_NAME = 'android-release-input.json';
export const RECEIPT_NAME = 'android-receipt.json';
export const LAUNCHER_FILES = [
  'assets/public/index.html', 'assets/public/launcher.js', 'assets/public/launcher.css',
  'assets/public/target.js', 'assets/public/fonts/newsreader-latin-opsz-normal.woff2',
  'assets/capacitor.config.json', 'res/xml/shortcuts.xml',
];

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
}

function positive(value, label) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  return String(value);
}

export function certificateFingerprint(value) {
  const fingerprint = String(value ?? '').replaceAll(/[:\s]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('KIKI_ANDROID_SIGNING_CERT_SHA256 must be the persistent release certificate SHA-256 fingerprint');
  }
  return fingerprint;
}

export function requireSigningSecrets(env) {
  const names = ['KIKI_ANDROID_KEYSTORE_BASE64', 'KIKI_ANDROID_STORE_PASSWORD', 'KIKI_ANDROID_KEY_ALIAS', 'KIKI_ANDROID_KEY_PASSWORD'];
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Persistent Android release signing secrets are required: ${missing.join(', ')}`);
  const base64 = env.KIKI_ANDROID_KEYSTORE_BASE64.replaceAll(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) || base64 === '') {
    throw new Error('KIKI_ANDROID_KEYSTORE_BASE64 must contain a base64-encoded persistent keystore');
  }
  return Buffer.from(base64, 'base64');
}

function releaseInput({ inputDir, expected, root = ROOT }) {
  const prepare = verifyPrepareReceipt({
    receiptPath: join(inputDir, 'release-input.json'), catalogPath: join(inputDir, 'built-in-catalog.json'), expected, root,
  });
  return {
    schemaVersion: 1,
    kind: 'kiki-android-release-input',
    repository: prepare.receipt.repository,
    sourceSha: prepare.receipt.sourceSha,
    tag: prepare.receipt.tag,
    version: prepare.receipt.version,
    prepare: { identity: prepare.identity },
    packageLock: describeFile(join(root, 'apps/kiki-gui/mobile/package-lock.json')),
  };
}

export function freezeAndroidInput(options) {
  const input = releaseInput(options);
  input.certificateSha256 = certificateFingerprint(options.certificateSha256);
  writeFileSync(join(options.inputDir, INPUT_NAME), `${JSON.stringify(input, null, 2)}\n`);
  return input;
}

export function verifyAndroidInput(options) {
  const actual = JSON.parse(readFileSync(join(options.inputDir, INPUT_NAME), 'utf8'));
  const expected = releaseInput(options);
  expected.certificateSha256 = certificateFingerprint(actual.certificateSha256);
  equal(JSON.stringify(actual), JSON.stringify(expected), 'frozen Android input');
  return { ...actual, prepare: { ...actual.prepare, artifactId: positive(options.prepareArtifactId, 'prepare artifact ID') } };
}

export function parseApkReports({ badging, signing, files }, { variant, version, certificateSha256 }) {
  if (!['debug', 'release', 'release-check'].includes(variant)) throw new Error(`Unknown Android variant: ${variant}`);
  const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(badging);
  if (pkg === null) throw new Error('APK package metadata is missing');
  equal(pkg[1], 'ai.easyagent.kiki', 'APK application ID');
  equal(pkg[2], String(version.versionCode), 'APK versionCode');
  equal(pkg[3], version.versionName, 'APK versionName');
  equal(/^application-debuggable\s*$/m.test(badging), variant === 'debug', 'APK debuggable');
  if (!/^sdkVersion:'24'$/m.test(badging) || !/^targetSdkVersion:'36'$/m.test(badging)) {
    throw new Error('APK must target SDK 36 and support Android API 24+');
  }
  const icon = /^application: label='Kiki' icon='([^']+)'/m.exec(badging)?.[1];
  if (!/^launchable-activity: name='ai\.easyagent\.kiki\.MainActivity'/m.test(badging) || !icon) {
    throw new Error('APK launcher activity or icon is missing');
  }
  const entries = new Set(files.trim().split(/\r?\n/));
  for (const file of [...LAUNCHER_FILES, icon]) {
    if (!entries.has(file)) throw new Error(`APK launcher resource is missing: ${file}`);
  }
  const certificates = [...signing.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f:]+)$/gim)];
  if (certificates.length !== 1) throw new Error('APK must have exactly one verified signing certificate');
  const certificate = certificateFingerprint(certificates[0][1]);
  if (variant !== 'debug') {
    equal(certificate, certificateFingerprint(certificateSha256), 'APK release certificate');
    if (/^Signer #\d+ certificate DN: .*CN=Android Debug/im.test(signing)) {
      throw new Error('Android Debug certificates cannot sign product releases');
    }
  }
  return { applicationId: pkg[1], ...version, debuggable: variant === 'debug', certificateSha256: certificate };
}

export function inspectApk(apk, options) {
  const sdk = process.env.ANDROID_HOME;
  if (!sdk) throw new Error('ANDROID_HOME is required to verify the APK');
  const tools = join(sdk, 'build-tools', BUILD_TOOLS);
  const aapt = join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  return parseApkReports({
    badging: run(aapt, ['dump', 'badging', apk]),
    signing: run(java, ['-jar', join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk]),
    files: run(aapt, ['list', apk]),
  }, options);
}

function coordinates(expected) {
  if (!/^[0-9a-f]{40}$/.test(expected.sourceSha ?? '')) throw new Error('A full source SHA is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(expected.repository ?? '')) throw new Error('A repository owner/name is required');
  return {
    repository: expected.repository, sourceSha: expected.sourceSha,
    workflow: { runId: positive(expected.runId, 'workflow run ID'), producerAttempt: positive(expected.candidateAttempt, 'candidate attempt') },
  };
}

export function stageAndroidArtifact({ apk, output, variant, expected, inputDir, prepareArtifactId, certificateSha256, root = ROOT, inspect = inspectApk }) {
  const version = readAndroidVersion(root);
  const input = variant === 'release' ? verifyAndroidInput({ inputDir, expected, prepareArtifactId, root }) : undefined;
  const metadata = inspect(apk, { variant, version, certificateSha256: input?.certificateSha256 ?? certificateSha256 });
  const receipt = {
    schemaVersion: 1, kind: 'kiki-android-apk', variant,
    ...coordinates(expected), versionSource: 'apps/kiki-gui/package.json', ...metadata,
    tag: input?.tag ?? null, prepare: input?.prepare ?? null,
    packageLock: describeFile(join(root, 'apps/kiki-gui/mobile/package-lock.json')),
    tools: { node: process.versions.node, buildTools: BUILD_TOOLS },
    apk: { name: `Kiki_${version.versionName}_android-${variant}.apk`, ...describeFile(apk) },
  };
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length > 0) throw new Error('Android artifact output must be empty');
  copyFileSync(apk, join(output, receipt.apk.name));
  writeFileSync(join(output, `${receipt.apk.name}.sha256`), `${receipt.apk.sha256}  ${receipt.apk.name}\n`);
  writeFileSync(join(output, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function verifyAndroidArtifact({ directory, variant, expected, inputDir, prepareArtifactId, certificateSha256, root = ROOT, inspect = inspectApk }) {
  const receipt = JSON.parse(readFileSync(join(directory, RECEIPT_NAME), 'utf8'));
  equal(receipt.schemaVersion, 1, 'Android receipt schema');
  equal(receipt.kind, 'kiki-android-apk', 'Android receipt kind');
  equal(receipt.variant, variant, 'Android variant');
  const context = coordinates(expected);
  for (const key of ['repository', 'sourceSha']) equal(receipt[key], context[key], key);
  equal(JSON.stringify(receipt.workflow), JSON.stringify(context.workflow), 'Android workflow');
  const version = readAndroidVersion(root);
  const name = `Kiki_${version.versionName}_android-${variant}.apk`;
  equal(receipt.apk?.name, name, 'Android APK name');
  equal(receipt.versionSource, 'apps/kiki-gui/package.json', 'Android version source');
  equal(JSON.stringify(receipt.packageLock), JSON.stringify(describeFile(join(root, 'apps/kiki-gui/mobile/package-lock.json'))), 'mobile package lock');
  const input = variant === 'release' ? verifyAndroidInput({ inputDir, expected, prepareArtifactId, root }) : undefined;
  equal(receipt.tag, input?.tag ?? null, 'Android tag');
  equal(JSON.stringify(receipt.prepare), JSON.stringify(input?.prepare ?? null), 'Android prepare');
  const apk = join(directory, name);
  const actual = inspect(apk, { variant, version, certificateSha256: input?.certificateSha256 ?? certificateSha256 });
  for (const [key, value] of Object.entries(actual)) equal(receipt[key], value, `Android ${key}`);
  const description = describeFile(apk);
  equal(receipt.apk.bytes, description.bytes, 'Android APK bytes');
  equal(receipt.apk.sha256, description.sha256, 'Android APK SHA-256');
  equal(readFileSync(`${apk}.sha256`, 'utf8'), `${description.sha256}  ${name}\n`, 'Android checksum file');
  equal(readdirSync(directory).toSorted().join(','), [name, `${name}.sha256`, RECEIPT_NAME].toSorted().join(','), 'Android artifact files');
  return receipt;
}

export function selectAndroidArtifact({ artifacts, runId, currentAttempt }) {
  runId = positive(runId, 'workflow run ID');
  currentAttempt = Number(positive(currentAttempt, 'current attempt'));
  let selected;
  const seen = new Set();
  for (const artifact of artifacts) {
    if (!artifact.name?.startsWith(`kiki-release-android-${runId}-`)) continue;
    const match = /^kiki-release-android-([1-9]\d*)-([1-9]\d*)$/.exec(artifact.name);
    if (!match) throw new Error(`Malformed Android artifact name: ${artifact.name}`);
    const attempt = Number(match[2]);
    if (attempt > currentAttempt) throw new Error('Android artifact is from a future attempt');
    if (seen.has(attempt)) throw new Error(`Duplicate Android artifact for attempt ${attempt}`);
    seen.add(attempt);
    if (artifact.expired || !Number.isSafeInteger(artifact.id) || artifact.id < 1) throw new Error(`Android artifact is unavailable: ${artifact.name}`);
    if (!selected || attempt > selected.attempt) selected = { id: artifact.id, attempt };
  }
  if (!selected) throw new Error('Missing Android release artifact');
  return selected;
}

export function runCli(argv, env = process.env) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    apk: { type: 'string' }, output: { type: 'string' }, directory: { type: 'string' }, variant: { type: 'string' },
    'input-dir': { type: 'string' }, 'api-json': { type: 'string' },
  } });
  const expected = {
    repository: env.GITHUB_REPOSITORY, sourceSha: env.KIKI_SOURCE_SHA, runId: env.GITHUB_RUN_ID,
    candidateAttempt: env.KIKI_ANDROID_PRODUCER_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT,
    producerAttempt: env.KIKI_PREPARE_ATTEMPT, tag: env.KIKI_TAG, version: env.KIKI_VERSION, channel: env.KIKI_CHANNEL,
  };
  const common = { expected, inputDir: values['input-dir'], prepareArtifactId: env.KIKI_PREPARE_ARTIFACT_ID,
    certificateSha256: env.KIKI_ANDROID_SIGNING_CERT_SHA256 };
  if (positionals[0] === 'freeze') {
    freezeAndroidInput(common);
  } else if (positionals[0] === 'signing') {
    if (values.variant === 'release-check') certificateFingerprint(common.certificateSha256);
    else verifyAndroidInput(common);
    const bytes = requireSigningSecrets(env);
    const path = join(env.RUNNER_TEMP, 'kiki-android-release.keystore');
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(env.GITHUB_ENV, `KIKI_ANDROID_KEYSTORE_FILE=${path}\n`, { flag: 'a' });
  } else if (positionals[0] === 'stage') {
    equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), expected.sourceSha, 'checked-out Android source');
    stageAndroidArtifact({ ...common, apk: values.apk, output: values.output, variant: values.variant });
  } else if (positionals[0] === 'verify') {
    verifyAndroidArtifact({ ...common, directory: values.directory, variant: values.variant });
  } else if (positionals[0] === 'select') {
    const selected = selectAndroidArtifact({ artifacts: JSON.parse(readFileSync(values['api-json'], 'utf8')).artifacts,
      runId: env.GITHUB_RUN_ID, currentAttempt: env.GITHUB_RUN_ATTEMPT });
    writeFileSync(env.GITHUB_OUTPUT, `artifact-id=${selected.id}\nproducer-attempt=${selected.attempt}\n`, { flag: 'a' });
  } else {
    throw new Error('Usage: android-artifact.mjs freeze|signing|stage|verify|select [options]');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { runCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`[kiki Android] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
