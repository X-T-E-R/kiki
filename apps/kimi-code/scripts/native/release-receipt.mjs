import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { commandForExecFile } from './exec.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_TARGETS = new Map([
  ['linux-x64', { rustTarget: 'x86_64-unknown-linux-gnu', desktop: true }],
  ['linux-arm64', { rustTarget: 'aarch64-unknown-linux-gnu', desktop: false }],
  ['darwin-x64', { rustTarget: 'x86_64-apple-darwin', desktop: true }],
  ['darwin-arm64', { rustTarget: 'aarch64-apple-darwin', desktop: true }],
  ['win32-x64', { rustTarget: 'x86_64-pc-windows-msvc', desktop: true }],
  ['win32-arm64', { rustTarget: 'aarch64-pc-windows-msvc', desktop: false }],
]);

export const PREPARE_RECEIPT_NAME = 'release-input.json';
export const NATIVE_RECEIPT_NAME = 'release-receipt.json';

function fail(message) {
  throw new Error(message);
}

function required(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || /[\r\n]/.test(text)) fail(`${label} is required.`);
  return text;
}

function integerString(value, label) {
  const text = required(value, label);
  if (!/^[1-9][0-9]*$/.test(text)) fail(`${label} must be a positive integer.`);
  return text;
}

function fullSha(value, label = 'source SHA') {
  const text = required(value, label);
  if (!FULL_SHA.test(text)) fail(`${label} must be a full lowercase commit SHA.`);
  return text;
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function describeFile(path) {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0) fail(`Release input must be a non-empty file: ${path}`);
  return { bytes: info.size, sha256: hashBytes(readFileSync(path)) };
}

function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(`${label} must be a JSON object.`);
  return parsed;
}

function packageVersion(path, label) {
  const version = readJson(path, label).version;
  return required(version, `${label} version`);
}

function expectedChannel(version) {
  return version.includes('-beta.') ? 'beta' : 'stable';
}

function assertReleaseCoordinates({ tag, version, channel }) {
  if (tag !== `kiki-v${version}`) fail(`Release tag ${tag} does not match version ${version}.`);
  if (channel !== expectedChannel(version)) fail(`Release channel ${channel} does not match version ${version}.`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function receiptIdentity(receipt) {
  return hashBytes(Buffer.from(stableJson(receipt)));
}

export function createPrepareReceipt({
  root = REPO_ROOT,
  catalogPath,
  repository,
  sourceSha,
  tag,
  version,
  channel,
  runId,
  producerAttempt,
  nodeVersion = process.versions.node,
  pnpmVersion,
}) {
  repository = required(repository, 'repository');
  sourceSha = fullSha(sourceSha);
  tag = required(tag, 'tag');
  version = required(version, 'version');
  channel = required(channel, 'channel');
  runId = integerString(runId, 'workflow run ID');
  producerAttempt = integerString(producerAttempt, 'producer attempt');
  nodeVersion = required(nodeVersion, 'Node version').replace(/^v/, '');
  pnpmVersion = required(pnpmVersion, 'pnpm version');
  assertReleaseCoordinates({ tag, version, channel });

  const cliVersion = packageVersion(join(root, 'apps/kimi-code/package.json'), 'CLI package');
  const guiVersion = packageVersion(join(root, 'apps/kiki-gui/package.json'), 'GUI package');
  const tauriVersion = packageVersion(join(root, 'apps/kiki-gui/src-tauri/tauri.conf.json'), 'Tauri config');
  for (const [label, actual] of [['CLI', cliVersion], ['GUI', guiVersion], ['Tauri', tauriVersion]]) {
    if (actual !== version) fail(`${label} version ${actual} does not match release version ${version}.`);
  }

  return {
    schemaVersion: 1,
    kind: 'kiki-release-input',
    repository,
    sourceSha,
    tag,
    version,
    channel,
    workflow: { runId, producerAttempt },
    tools: { node: nodeVersion, pnpm: pnpmVersion },
    lock: describeFile(join(root, 'pnpm-lock.yaml')),
    versions: { cli: cliVersion, gui: guiVersion, tauri: tauriVersion },
    catalog: { name: basename(catalogPath), ...describeFile(catalogPath) },
  };
}

export function writePrepareReceipt(options) {
  const receipt = createPrepareReceipt(options);
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, identity: receiptIdentity(receipt) };
}

function assertEqual(actual, expected, label) {
  if (String(actual) !== String(expected)) fail(`${label} mismatch: expected ${expected}, received ${actual}.`);
}

export function verifyPrepareReceipt({ receiptPath, catalogPath, expected, root = REPO_ROOT }) {
  const receipt = readJson(receiptPath, 'release input receipt');
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'kiki-release-input') fail('Unsupported release input receipt.');
  assertEqual(receipt.repository, required(expected.repository, 'expected repository'), 'repository');
  assertEqual(receipt.sourceSha, fullSha(expected.sourceSha, 'expected source SHA'), 'source SHA');
  assertEqual(receipt.tag, required(expected.tag, 'expected tag'), 'tag');
  assertEqual(receipt.version, required(expected.version, 'expected version'), 'version');
  assertEqual(receipt.channel, required(expected.channel, 'expected channel'), 'channel');
  assertEqual(receipt.workflow?.runId, integerString(expected.runId, 'expected workflow run ID'), 'workflow run ID');
  assertEqual(
    receipt.workflow?.producerAttempt,
    integerString(expected.producerAttempt, 'expected producer attempt'),
    'producer attempt',
  );
  assertReleaseCoordinates(receipt);
  assertEqual(receipt.lock?.sha256, describeFile(join(root, 'pnpm-lock.yaml')).sha256, 'lock digest');
  const catalog = describeFile(catalogPath);
  assertEqual(receipt.catalog?.name, basename(catalogPath), 'catalog name');
  assertEqual(receipt.catalog?.bytes, catalog.bytes, 'catalog bytes');
  assertEqual(receipt.catalog?.sha256, catalog.sha256, 'catalog digest');
  for (const [label, path] of [
    ['CLI', 'apps/kimi-code/package.json'],
    ['GUI', 'apps/kiki-gui/package.json'],
    ['Tauri', 'apps/kiki-gui/src-tauri/tauri.conf.json'],
  ]) {
    assertEqual(receipt.versions?.[label.toLowerCase()], packageVersion(join(root, path), `${label} version source`), `${label} version`);
  }
  return { receipt, identity: receiptIdentity(receipt) };
}

function walkFiles(root, directory = root) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    else fail(`Unsupported release candidate entry: ${path}`);
  }
  return files.toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function copyDescribedFile(source, outputRoot, outputName, role) {
  const destination = join(outputRoot, outputName);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return { role, path: outputName.replaceAll('\\', '/'), ...describeFile(destination) };
}

function targetMetadata(target, rustTarget) {
  const metadata = RELEASE_TARGETS.get(target);
  if (metadata === undefined) fail(`Unsupported release target: ${target}.`);
  assertEqual(rustTarget, metadata.rustTarget, 'Rust target');
  return metadata;
}

export function stageNativeCandidate({
  root = REPO_ROOT,
  outputDir,
  target,
  rustTarget,
  prepareReceiptPath,
  catalogPath,
  prepareArtifactId,
  expected,
  nodeVersion,
  pnpmVersion,
  rustVersion,
  signingMode,
  desktopDir,
}) {
  const metadata = targetMetadata(target, rustTarget);
  const prepare = verifyPrepareReceipt({ receiptPath: prepareReceiptPath, catalogPath, expected, root });
  prepareArtifactId = integerString(prepareArtifactId, 'prepare artifact ID');
  nodeVersion = required(nodeVersion, 'Node version').replace(/^v/, '');
  pnpmVersion = required(pnpmVersion, 'pnpm version');
  rustVersion = required(rustVersion, 'Rust version');
  signingMode = required(signingMode, 'signing mode');

  const extension = target.startsWith('win32-') ? '.exe' : '';
  const binaryName = `kiki-${target}${extension}`;
  const artifactsRoot = join(root, 'apps/kimi-code/dist-native/artifacts');
  const sourceBinary = join(root, 'apps/kimi-code/dist-native/bin', target, target.startsWith('win32-') ? 'kiki.exe' : 'kiki');
  const packagedBinary = join(artifactsRoot, binaryName);
  const sourceDescription = describeFile(sourceBinary);
  const packagedDescription = describeFile(packagedBinary);
  assertEqual(packagedDescription.bytes, sourceDescription.bytes, 'packaged native bytes');
  assertEqual(packagedDescription.sha256, sourceDescription.sha256, 'packaged native digest');

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const files = [
    copyDescribedFile(packagedBinary, outputDir, `native/${binaryName}`, 'native-executable'),
    copyDescribedFile(`${packagedBinary}.sha256`, outputDir, `native/${binaryName}.sha256`, 'native-checksum'),
  ];
  for (const directory of [`auth-native/${target}`, `windows-process-helper/${target}`]) {
    const sourceRoot = join(artifactsRoot, directory);
    for (const name of walkFiles(sourceRoot)) {
      files.push(copyDescribedFile(join(sourceRoot, name), outputDir, `native/${directory}/${name}`, 'native-support'));
    }
  }
  if (desktopDir !== undefined) {
    const desktopFiles = walkFiles(desktopDir);
    if (!metadata.desktop || desktopFiles.length === 0) fail(`Unexpected or empty desktop candidate for ${target}.`);
    for (const name of desktopFiles) {
      files.push(copyDescribedFile(join(desktopDir, name), outputDir, `desktop/${name}`, 'desktop-bundle'));
    }
  }

  const receipt = {
    schemaVersion: 1,
    kind: 'kiki-release-native',
    repository: prepare.receipt.repository,
    sourceSha: prepare.receipt.sourceSha,
    tag: prepare.receipt.tag,
    version: prepare.receipt.version,
    channel: prepare.receipt.channel,
    workflow: {
      runId: prepare.receipt.workflow.runId,
      producerAttempt: integerString(expected.candidateAttempt, 'candidate producer attempt'),
      prepareProducerAttempt: prepare.receipt.workflow.producerAttempt,
    },
    prepare: {
      artifactId: prepareArtifactId,
      identity: prepare.identity,
      catalogSha256: prepare.receipt.catalog.sha256,
    },
    target: { sea: target, rust: rustTarget },
    tools: { node: nodeVersion, pnpm: pnpmVersion, rust: rustVersion },
    lockSha256: prepare.receipt.lock.sha256,
    seaProfile: 'release',
    signingMode: {
      native: signingMode,
      desktopUpdater: target === 'win32-x64' && desktopDir !== undefined ? 'temporary' : 'none',
    },
    guiEnvironment: {
      version: prepare.receipt.version,
      channel: prepare.receipt.channel,
      sourceSha: prepare.receipt.sourceSha,
      distribution: target === 'win32-x64' ? 'github' : metadata.desktop ? 'manual' : 'none',
    },
    smoke: { native: true, desktop: metadata.desktop ? desktopDir !== undefined : undefined },
    files,
  };
  writeFileSync(join(outputDir, NATIVE_RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function verifyCandidateReceipt({ receipt, candidateRoot, prepare, prepareArtifactId, expected, allowPendingDesktop = false }) {
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'kiki-release-native') fail('Unsupported native release receipt.');
  targetMetadata(receipt.target?.sea, receipt.target?.rust);
  for (const field of ['repository', 'sourceSha', 'tag', 'version', 'channel']) {
    assertEqual(receipt[field], prepare.receipt[field], `native ${field}`);
  }
  assertEqual(receipt.workflow?.runId, prepare.receipt.workflow.runId, 'native workflow run ID');
  integerString(receipt.workflow?.producerAttempt, 'native producer attempt');
  assertEqual(
    receipt.workflow?.prepareProducerAttempt,
    prepare.receipt.workflow.producerAttempt,
    'native prepare producer attempt',
  );
  assertEqual(receipt.prepare?.artifactId, prepareArtifactId, 'prepare artifact ID');
  assertEqual(receipt.prepare?.identity, prepare.identity, 'prepare identity');
  assertEqual(receipt.prepare?.catalogSha256, prepare.receipt.catalog.sha256, 'native catalog digest');
  assertEqual(receipt.lockSha256, prepare.receipt.lock.sha256, 'native lock digest');
  assertEqual(receipt.tools?.node, prepare.receipt.tools.node, 'native Node version');
  assertEqual(receipt.tools?.pnpm, prepare.receipt.tools.pnpm, 'native pnpm version');
  required(receipt.tools?.rust, 'native Rust version');
  assertEqual(receipt.seaProfile, 'release', 'SEA profile');
  assertEqual(receipt.signingMode?.native, 'unsigned', 'native signing mode');
  const desktopTarget = RELEASE_TARGETS.get(receipt.target.sea).desktop;
  const expectedUpdaterMode = receipt.target.sea === 'win32-x64' && !allowPendingDesktop ? 'temporary' : 'none';
  assertEqual(receipt.signingMode?.desktopUpdater, expectedUpdaterMode, 'desktop updater signing mode');
  assertEqual(receipt.guiEnvironment?.version, prepare.receipt.version, 'GUI version');
  assertEqual(receipt.guiEnvironment?.channel, prepare.receipt.channel, 'GUI channel');
  assertEqual(receipt.guiEnvironment?.sourceSha, prepare.receipt.sourceSha, 'GUI source SHA');
  assertEqual(
    receipt.guiEnvironment?.distribution,
    receipt.target.sea === 'win32-x64' ? 'github' : desktopTarget ? 'manual' : 'none',
    'GUI distribution',
  );
  assertEqual(receipt.smoke?.native, true, 'native smoke result');
  if (!Array.isArray(receipt.files) || receipt.files.length === 0) fail('Native release receipt has no files.');
  const names = new Set();
  for (const file of receipt.files) {
    const name = typeof file.path === 'string' ? file.path : '';
    if (name === '' || name.includes('\\') || name.startsWith('/') || name.split('/').some((part) => part === '' || part === '.' || part === '..') || names.has(name)) {
      fail(`Unsafe or duplicate release receipt path for ${receipt.target.sea}.`);
    }
    names.add(name);
    if (!SHA256.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) fail(`Invalid file receipt: ${name}.`);
    const description = describeFile(join(candidateRoot, name));
    assertEqual(description.bytes, file.bytes, `${name} bytes`);
    assertEqual(description.sha256, file.sha256, `${name} digest`);
  }
  const native = receipt.files.filter((file) => file.role === 'native-executable');
  if (native.length !== 1 || basename(native[0].path) !== `kiki-${receipt.target.sea}${receipt.target.sea.startsWith('win32-') ? '.exe' : ''}`) {
    fail(`Native executable receipt is missing or duplicated for ${receipt.target.sea}.`);
  }
  const desktopCount = receipt.files.filter((file) => file.role === 'desktop-bundle').length;
  if (!allowPendingDesktop && RELEASE_TARGETS.get(receipt.target.sea).desktop) {
    assertEqual(receipt.smoke?.desktop, true, 'desktop build result');
  }
  if ((!allowPendingDesktop && RELEASE_TARGETS.get(receipt.target.sea).desktop && desktopCount === 0)
    || (!RELEASE_TARGETS.get(receipt.target.sea).desktop && desktopCount !== 0)) {
    fail(`Desktop candidate set is incorrect for ${receipt.target.sea}.`);
  }
  if (expected.candidateAttempt !== undefined) assertEqual(receipt.workflow.producerAttempt, expected.candidateAttempt, 'candidate attempt');
  return receipt;
}

export function verifySidecarReceipt({ receiptPath, sourcePath, rustTarget, expected, prepareReceiptPath, catalogPath, root = REPO_ROOT }) {
  const receipt = readJson(receiptPath, 'native release receipt');
  const prepareArtifactId = integerString(expected.prepareArtifactId, 'expected prepare artifact ID');
  const prepare = verifyPrepareReceipt({ receiptPath: prepareReceiptPath, catalogPath, expected, root });
  verifyCandidateReceipt({
    receipt,
    candidateRoot: dirname(receiptPath),
    prepare,
    prepareArtifactId,
    expected,
    allowPendingDesktop: true,
  });
  assertEqual(receipt.target.rust, rustTarget, 'sidecar Rust target');
  const native = receipt.files.find((file) => file.role === 'native-executable');
  const source = describeFile(sourcePath);
  assertEqual(source.bytes, native.bytes, 'sidecar source bytes');
  assertEqual(source.sha256, native.sha256, 'sidecar source digest');
  return receipt;
}

export function createNpmReceipt({
  root = REPO_ROOT,
  npmRoot,
  outputPath,
  prepareReceiptPath,
  catalogPath,
  prepareArtifactId,
  expected,
}) {
  const prepare = verifyPrepareReceipt({ receiptPath: prepareReceiptPath, catalogPath, expected, root });
  const files = [];
  for (const kind of ['lite', 'full']) {
    const packageRoot = join(npmRoot, kind);
    const names = walkFiles(packageRoot);
    if (names.length === 0) fail(`npm release candidate is empty: ${kind}.`);
    const manifest = readJson(join(packageRoot, 'package.json'), `${kind} npm package`);
    assertEqual(manifest.version, prepare.receipt.version, `${kind} npm version`);
    for (const name of names) files.push({ package: kind, path: name, ...describeFile(join(packageRoot, name)) });
  }
  const receipt = {
    schemaVersion: 1,
    kind: 'kiki-release-npm',
    repository: prepare.receipt.repository,
    sourceSha: prepare.receipt.sourceSha,
    tag: prepare.receipt.tag,
    version: prepare.receipt.version,
    channel: prepare.receipt.channel,
    workflow: {
      runId: prepare.receipt.workflow.runId,
      producerAttempt: integerString(expected.candidateAttempt, 'npm producer attempt'),
      prepareProducerAttempt: prepare.receipt.workflow.producerAttempt,
    },
    prepare: {
      artifactId: integerString(prepareArtifactId, 'prepare artifact ID'),
      identity: prepare.identity,
      catalogSha256: prepare.receipt.catalog.sha256,
    },
    tools: prepare.receipt.tools,
    lockSha256: prepare.receipt.lock.sha256,
    files,
  };
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function verifyNpmReceipt({
  root = REPO_ROOT,
  npmRoot,
  receiptPath,
  prepareReceiptPath,
  catalogPath,
  prepareArtifactId,
  expected,
}) {
  const prepare = verifyPrepareReceipt({ receiptPath: prepareReceiptPath, catalogPath, expected, root });
  const receipt = readJson(receiptPath, 'npm release receipt');
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'kiki-release-npm') fail('Unsupported npm release receipt.');
  for (const field of ['repository', 'sourceSha', 'tag', 'version', 'channel']) {
    assertEqual(receipt[field], prepare.receipt[field], `npm ${field}`);
  }
  assertEqual(receipt.workflow?.runId, prepare.receipt.workflow.runId, 'npm workflow run ID');
  integerString(receipt.workflow?.producerAttempt, 'npm producer attempt');
  assertEqual(receipt.workflow?.prepareProducerAttempt, prepare.receipt.workflow.producerAttempt, 'npm prepare attempt');
  assertEqual(receipt.prepare?.artifactId, integerString(prepareArtifactId, 'prepare artifact ID'), 'npm prepare artifact ID');
  assertEqual(receipt.prepare?.identity, prepare.identity, 'npm prepare identity');
  assertEqual(receipt.prepare?.catalogSha256, prepare.receipt.catalog.sha256, 'npm catalog digest');
  assertEqual(receipt.lockSha256, prepare.receipt.lock.sha256, 'npm lock digest');
  if (!Array.isArray(receipt.files)) fail('npm release receipt has no files.');
  const expectedPaths = new Set();
  for (const file of receipt.files) {
    if (!['lite', 'full'].includes(file.package)) fail(`Unknown npm receipt package: ${file.package}.`);
    const key = `${file.package}/${file.path}`;
    if (expectedPaths.has(key)) fail(`Duplicate npm receipt path: ${key}.`);
    expectedPaths.add(key);
    const description = describeFile(join(npmRoot, file.package, file.path));
    assertEqual(description.bytes, file.bytes, `${key} bytes`);
    assertEqual(description.sha256, file.sha256, `${key} digest`);
  }
  const actualPaths = new Set();
  for (const kind of ['lite', 'full']) {
    for (const path of walkFiles(join(npmRoot, kind))) actualPaths.add(`${kind}/${path}`);
  }
  if (actualPaths.size !== expectedPaths.size || [...actualPaths].some((path) => !expectedPaths.has(path))) {
    fail('npm staged files differ from the release receipt.');
  }
  return receipt;
}

export function selectTargetArtifactIds({ artifacts, runId, currentAttempt }) {
  runId = integerString(runId, 'workflow run ID');
  currentAttempt = Number(integerString(currentAttempt, 'current workflow attempt'));
  if (!Array.isArray(artifacts)) fail('Artifact API response must contain an artifacts array.');
  const selected = new Map();
  const seen = new Set();
  const prefix = `kiki-release-target-${runId}-`;
  for (const artifact of artifacts) {
    if (typeof artifact?.name !== 'string' || !artifact.name.startsWith(prefix)) continue;
    const match = /^kiki-release-target-([1-9][0-9]*)-(linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-arm64)-([1-9][0-9]*)$/.exec(artifact.name);
    if (match === null || match[1] !== runId) fail(`Malformed target artifact name: ${artifact.name}.`);
    const target = match[2];
    const attempt = Number(match[3]);
    if (attempt > currentAttempt) fail(`Target artifact comes from a future attempt: ${artifact.name}.`);
    const key = `${target}:${attempt}`;
    if (seen.has(key)) fail(`Duplicate target artifact for ${target} attempt ${attempt}.`);
    seen.add(key);
    if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.expired === true) {
      fail(`Target artifact is unavailable: ${artifact.name}.`);
    }
    const previous = selected.get(target);
    if (previous === undefined || attempt > previous.attempt) selected.set(target, { id: artifact.id, attempt });
  }
  for (const target of RELEASE_TARGETS.keys()) {
    if (!selected.has(target)) fail(`Missing target artifact for ${target}.`);
  }
  return [...RELEASE_TARGETS.keys()].map((target) => selected.get(target).id);
}

export function verifyCandidateSet({
  artifactsRoot,
  nativeOutput,
  desktopOutput,
  prepareReceiptPath,
  catalogPath,
  prepareArtifactId,
  expected,
  root = REPO_ROOT,
}) {
  const prepare = verifyPrepareReceipt({ receiptPath: prepareReceiptPath, catalogPath, expected, root });
  prepareArtifactId = integerString(prepareArtifactId, 'prepare artifact ID');
  const receipts = [];
  for (const directory of readdirSync(artifactsRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const candidateRoot = join(artifactsRoot, directory.name);
    const receiptPath = join(candidateRoot, NATIVE_RECEIPT_NAME);
    if (!existsSync(receiptPath)) continue;
    receipts.push({ candidateRoot, receipt: readJson(receiptPath, 'native release receipt') });
  }
  const byTarget = new Map();
  let sharedEnvironment;
  for (const candidate of receipts) {
    const target = candidate.receipt.target?.sea;
    if (byTarget.has(target)) fail(`Duplicate release candidate for ${target}.`);
    const artifactName = basename(candidate.candidateRoot);
    const artifactMatch = /^kiki-release-target-([1-9][0-9]*)-(linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-arm64)-([1-9][0-9]*)$/.exec(artifactName);
    if (artifactMatch === null) fail(`Malformed downloaded target artifact name: ${artifactName}.`);
    assertEqual(artifactMatch[1], prepare.receipt.workflow.runId, 'target artifact run ID');
    assertEqual(artifactMatch[2], target, 'target artifact target');
    assertEqual(artifactMatch[3], candidate.receipt.workflow?.producerAttempt, 'target artifact attempt');
    const receipt = verifyCandidateReceipt({ ...candidate, prepare, prepareArtifactId, expected });
    const environment = stableJson({
      tools: receipt.tools,
      seaProfile: receipt.seaProfile,
      nativeSigningMode: receipt.signingMode.native,
      guiVersion: receipt.guiEnvironment.version,
      guiChannel: receipt.guiEnvironment.channel,
      guiSourceSha: receipt.guiEnvironment.sourceSha,
    });
    if (sharedEnvironment !== undefined && environment !== sharedEnvironment) {
      fail(`Release candidate environment differs for ${target}.`);
    }
    sharedEnvironment = environment;
    byTarget.set(target, { candidateRoot: candidate.candidateRoot, receipt });
  }
  for (const target of RELEASE_TARGETS.keys()) {
    if (!byTarget.has(target)) fail(`Missing release candidate for ${target}.`);
  }
  if (byTarget.size !== RELEASE_TARGETS.size) fail(`Unexpected release candidate target count: ${byTarget.size}.`);

  rmSync(nativeOutput, { recursive: true, force: true });
  rmSync(desktopOutput, { recursive: true, force: true });
  mkdirSync(nativeOutput, { recursive: true });
  mkdirSync(desktopOutput, { recursive: true });
  for (const { candidateRoot, receipt } of byTarget.values()) {
    for (const file of receipt.files) {
      if (file.path.startsWith('native/')) {
        const output = join(nativeOutput, file.path.slice('native/'.length));
        mkdirSync(dirname(output), { recursive: true });
        copyFileSync(join(candidateRoot, file.path), output);
      } else if (file.role === 'desktop-bundle') {
        const output = join(desktopOutput, basename(file.path));
        if (existsSync(output)) fail(`Duplicate desktop asset name: ${basename(file.path)}.`);
        copyFileSync(join(candidateRoot, file.path), output);
      }
    }
  }
  return byTarget;
}

function optionSpec() {
  return {
    catalog: { type: 'string' },
    output: { type: 'string' },
    receipt: { type: 'string' },
    repository: { type: 'string' },
    'source-sha': { type: 'string' },
    tag: { type: 'string' },
    version: { type: 'string' },
    channel: { type: 'string' },
    'run-id': { type: 'string' },
    'producer-attempt': { type: 'string' },
    'prepare-attempt': { type: 'string' },
    'candidate-attempt': { type: 'string' },
    'prepare-artifact-id': { type: 'string' },
    target: { type: 'string' },
    'rust-target': { type: 'string' },
    node: { type: 'string' },
    pnpm: { type: 'string' },
    rust: { type: 'string' },
    signing: { type: 'string' },
    desktop: { type: 'string' },
    artifacts: { type: 'string' },
    'native-output': { type: 'string' },
    'desktop-output': { type: 'string' },
    'api-json': { type: 'string' },
    'current-attempt': { type: 'string' },
    'github-output': { type: 'string' },
    'npm-root': { type: 'string' },
    'prepare-receipt': { type: 'string' },
  };
}

function commonExpected(values) {
  return {
    repository: values.repository,
    sourceSha: values['source-sha'],
    tag: values.tag,
    version: values.version,
    channel: values.channel,
    runId: values['run-id'],
    producerAttempt: values['prepare-attempt'] ?? values['producer-attempt'],
    candidateAttempt: values['candidate-attempt'],
  };
}

function toolVersion(command, args = ['--version']) {
  const invocation = commandForExecFile(command, args);
  return execFileSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    ...invocation.options,
  }).trim();
}

export function runCli(argv = process.argv.slice(2), root = REPO_ROOT) {
  const [command, ...args] = argv;
  const { values } = parseArgs({ args, options: optionSpec(), strict: true });
  if (command === 'prepare') {
    const result = writePrepareReceipt({
      root,
      catalogPath: resolve(required(values.catalog, '--catalog')),
      outputPath: resolve(required(values.output, '--output')),
      repository: values.repository,
      sourceSha: values['source-sha'],
      tag: values.tag,
      version: values.version,
      channel: values.channel,
      runId: values['run-id'],
      producerAttempt: values['producer-attempt'],
      pnpmVersion: values.pnpm ?? toolVersion(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
    });
    process.stdout.write(`identity=${result.identity}\n`);
    return;
  }
  if (command === 'verify-prepare') {
    const result = verifyPrepareReceipt({
      root,
      receiptPath: resolve(required(values.receipt, '--receipt')),
      catalogPath: resolve(required(values.catalog, '--catalog')),
      expected: commonExpected(values),
    });
    process.stdout.write(`identity=${result.identity}\n`);
    return;
  }
  if (command === 'stage-native') {
    stageNativeCandidate({
      root,
      outputDir: resolve(required(values.output, '--output')),
      target: values.target,
      rustTarget: values['rust-target'],
      prepareReceiptPath: resolve(required(values.receipt, '--receipt')),
      catalogPath: resolve(required(values.catalog, '--catalog')),
      prepareArtifactId: values['prepare-artifact-id'],
      expected: commonExpected(values),
      nodeVersion: values.node ?? process.versions.node,
      pnpmVersion: values.pnpm ?? toolVersion(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
      rustVersion: values.rust ?? toolVersion('rustc', ['-vV']),
      signingMode: values.signing,
      desktopDir: values.desktop === undefined ? undefined : resolve(values.desktop),
    });
    return;
  }
  if (command === 'stage-npm') {
    createNpmReceipt({
      root,
      npmRoot: resolve(required(values['npm-root'], '--npm-root')),
      outputPath: resolve(required(values.output, '--output')),
      prepareReceiptPath: resolve(required(values.receipt, '--receipt')),
      catalogPath: resolve(required(values.catalog, '--catalog')),
      prepareArtifactId: values['prepare-artifact-id'],
      expected: commonExpected(values),
    });
    return;
  }
  if (command === 'verify-npm') {
    verifyNpmReceipt({
      root,
      npmRoot: resolve(required(values['npm-root'], '--npm-root')),
      receiptPath: resolve(required(values.receipt, '--receipt')),
      prepareReceiptPath: resolve(required(values['prepare-receipt'], '--prepare-receipt')),
      catalogPath: resolve(required(values.catalog, '--catalog')),
      prepareArtifactId: values['prepare-artifact-id'],
      expected: commonExpected(values),
    });
    return;
  }
  if (command === 'select-artifacts') {
    const response = readJson(resolve(required(values['api-json'], '--api-json')), 'artifact API response');
    const ids = selectTargetArtifactIds({
      artifacts: response.artifacts,
      runId: values['run-id'],
      currentAttempt: values['current-attempt'],
    });
    const line = `artifact-ids=${ids.join(',')}\n`;
    if (values['github-output'] === undefined) process.stdout.write(line);
    else writeFileSync(resolve(values['github-output']), line, { flag: 'a' });
    return;
  }
  if (command === 'verify-candidates') {
    verifyCandidateSet({
      root,
      artifactsRoot: resolve(required(values.artifacts, '--artifacts')),
      nativeOutput: resolve(required(values['native-output'], '--native-output')),
      desktopOutput: resolve(required(values['desktop-output'], '--desktop-output')),
      prepareReceiptPath: resolve(required(values.receipt, '--receipt')),
      catalogPath: resolve(required(values.catalog, '--catalog')),
      prepareArtifactId: values['prepare-artifact-id'],
      expected: commonExpected(values),
    });
    return;
  }
  fail(`Unknown release receipt command: ${command ?? ''}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
