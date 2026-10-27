import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { stageSidecar } from '../../../kiki-gui/scripts/prepare-sidecar.mjs';
import {
  NATIVE_RECEIPT_NAME,
  createNpmReceipt,
  createPrepareReceipt,
  receiptIdentity,
  runCli,
  selectTargetArtifactIds,
  stageNativeCandidate,
  verifyCandidateSet,
  verifyNpmReceipt,
  verifyPrepareReceipt,
} from './release-receipt.mjs';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const TARGETS = [
  ['linux-x64', 'x86_64-unknown-linux-gnu', 'kiki-linux-x64'],
  ['linux-arm64', 'aarch64-unknown-linux-gnu', 'kiki-linux-arm64'],
  ['darwin-x64', 'x86_64-apple-darwin', 'kiki-darwin-x64'],
  ['darwin-arm64', 'aarch64-apple-darwin', 'kiki-darwin-arm64'],
  ['win32-x64', 'x86_64-pc-windows-msvc', 'kiki-win32-x64.exe'],
  ['win32-arm64', 'aarch64-pc-windows-msvc', 'kiki-win32-arm64.exe'],
];
const DESKTOP = new Map([
  ['linux-x64', ['Kiki.AppImage', 'kiki.deb']],
  ['darwin-x64', ['Kiki_x64.dmg']],
  ['darwin-arm64', ['Kiki_aarch64.dmg']],
  ['win32-x64', ['Kiki-setup.exe']],
]);

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kiki-release-receipt-'));
  write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: test\n');
  write(join(root, 'apps/kimi-code/package.json'), JSON.stringify({ version: '1.2.3' }));
  write(join(root, 'apps/kiki-gui/package.json'), JSON.stringify({ version: '1.2.3' }));
  write(join(root, 'apps/kiki-gui/src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.2.3' }));
  write(join(root, 'apps/kiki-gui/src-tauri/Cargo.toml'), '[package]\nversion = "1.2.3"\n');
  write(join(root, 'system.yaml'), 'system:\n  version: 1.2.3\n');
  const catalog = join(root, 'input/built-in-catalog.json');
  write(catalog, '{"example":{"models":{}}}');
  const preparePath = join(root, 'input/release-input.json');
  const prepare = createPrepareReceipt({
    root,
    catalogPath: catalog,
    repository: 'example/kiki',
    sourceSha: SHA,
    tag: 'kiki-v1.2.3',
    version: '1.2.3',
    channel: 'stable',
    runId: '77',
    producerAttempt: '1',
    nodeVersion: '24.22.1',
    pnpmVersion: '10.33.0',
  });
  write(preparePath, `${JSON.stringify(prepare)}\n`);
  return { root, catalog, preparePath, prepare };
}

function expected(candidateAttempt) {
  return {
    repository: 'example/kiki', sourceSha: SHA, tag: 'kiki-v1.2.3', version: '1.2.3',
    channel: 'stable', runId: '77', producerAttempt: '1', candidateAttempt,
  };
}

function stageAll(state, attempt = '2') {
  const artifacts = join(state.root, 'artifacts');
  for (const [target, rustTarget, binary] of TARGETS) {
    const extension = target.startsWith('win32-') ? '.exe' : '';
    write(join(state.root, 'apps/kimi-code/dist-native/bin', target, `kiki${extension}`), `native-${target}`);
    write(join(state.root, 'apps/kimi-code/dist-native/artifacts', binary), `native-${target}`);
    write(join(state.root, 'apps/kimi-code/dist-native/artifacts', `${binary}.sha256`), `${'0'.repeat(64)}  ${binary}\n`);
    let desktopDir;
    if (DESKTOP.has(target)) {
      desktopDir = join(state.root, 'desktop', target);
      for (const name of DESKTOP.get(target)) write(join(desktopDir, name), `desktop-${target}-${name}`);
    }
    stageNativeCandidate({
      root: state.root,
      outputDir: join(artifacts, `kiki-release-target-77-${target}-${attempt}`),
      target,
      rustTarget,
      prepareReceiptPath: state.preparePath,
      catalogPath: state.catalog,
      prepareArtifactId: '9001',
      expected: expected(attempt),
      nodeVersion: '24.22.1',
      pnpmVersion: '10.33.0',
      rustVersion: 'rustc 1.91.0',
      signingMode: 'unsigned',
      desktopDir,
    });
  }
  return artifacts;
}

test('prepare identity binds catalog, source, environment, profile inputs, and producer attempt', () => {
  const state = fixture();
  try {
    const verified = verifyPrepareReceipt({
      receiptPath: state.preparePath,
      catalogPath: state.catalog,
      expected: expected('2'),
      root: state.root,
    });
    assert.equal(verified.identity, receiptIdentity(state.prepare));

    write(state.catalog, '{"changed":true}');
    assert.throws(
      () => verifyPrepareReceipt({ receiptPath: state.preparePath, catalogPath: state.catalog, expected: expected('2'), root: state.root }),
      /catalog (bytes|digest) mismatch/,
    );
    write(state.catalog, '{"example":{"models":{}}}');
    assert.throws(
      () => verifyPrepareReceipt({
        receiptPath: state.preparePath,
        catalogPath: state.catalog,
        expected: { ...expected('2'), sourceSha: 'abcdef1234567890abcdef1234567890abcdef12' },
        root: state.root,
      }),
      /source SHA mismatch/,
    );
    assert.throws(
      () => verifyPrepareReceipt({
        receiptPath: state.preparePath,
        catalogPath: state.catalog,
        expected: { ...expected('2'), producerAttempt: '2' },
        root: state.root,
      }),
      /producer attempt mismatch/,
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('prepare and verification bind all five current version authorities', () => {
  for (const [path, changed] of [
    ['apps/kiki-gui/src-tauri/Cargo.toml', '[package]\nversion = "1.2.4"\n'],
    ['system.yaml', 'system:\n  version: 1.2.4\n'],
  ]) {
    const state = fixture();
    try {
      assert.deepEqual(state.prepare.versions, { cli: '1.2.3', gui: '1.2.3', tauri: '1.2.3', cargo: '1.2.3', system: '1.2.3' });
      write(join(state.root, path), changed);
      assert.throws(() => verifyPrepareReceipt({ receiptPath: state.preparePath, catalogPath: state.catalog, expected: expected(), root: state.root }), /release version mismatch/);
      assert.throws(() => createPrepareReceipt({ root: state.root, catalogPath: state.catalog, ...expected(), pnpmVersion: '10.33.0' }), /does not match release version/);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  }
});

test('Windows CLI samples pnpm.cmd through the native command wrapper when --pnpm is omitted', { skip: process.platform !== 'win32' }, () => {
  const state = fixture();
  const previousPath = process.env.PATH;
  try {
    const fakeBin = join(state.root, 'fake-bin');
    write(join(fakeBin, 'pnpm.cmd'), '@echo off\r\necho 10.33.0\r\n');
    process.env.PATH = `${fakeBin};${previousPath}`;
    write(join(state.root, 'apps/kimi-code/dist-native/bin/win32-x64/kiki.exe'), 'native-win32-x64');
    write(join(state.root, 'apps/kimi-code/dist-native/artifacts/kiki-win32-x64.exe'), 'native-win32-x64');
    write(join(state.root, 'apps/kimi-code/dist-native/artifacts/kiki-win32-x64.exe.sha256'), 'fixture-checksum\n');
    const output = join(state.root, 'candidate');
    runCli([
      'stage-native', '--output', output, '--receipt', state.preparePath, '--catalog', state.catalog,
      '--prepare-artifact-id', '9001', '--repository', 'example/kiki', '--source-sha', SHA,
      '--tag', 'kiki-v1.2.3', '--version', '1.2.3', '--channel', 'stable', '--run-id', '77',
      '--prepare-attempt', '1', '--candidate-attempt', '2', '--target', 'win32-x64',
      '--rust-target', 'x86_64-pc-windows-msvc', '--rust', 'rustc fixture', '--signing', 'unsigned',
    ], state.root);
    const receipt = JSON.parse(readFileSync(join(output, NATIVE_RECEIPT_NAME), 'utf8'));
    assert.equal(receipt.tools.pnpm, '10.33.0');
  } finally {
    process.env.PATH = previousPath;
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('npm receipt binds both staged distributions to the immutable prepare identity', () => {
  const state = fixture();
  try {
    const npmRoot = join(state.root, 'npm');
    for (const kind of ['lite', 'full']) {
      write(join(npmRoot, kind, 'package.json'), JSON.stringify({ name: `kiki-${kind}`, version: '1.2.3' }));
      write(join(npmRoot, kind, 'dist/main.mjs'), `export const kind = '${kind}';\n`);
    }
    const outputPath = join(npmRoot, 'release-receipt.json');
    const receipt = createNpmReceipt({
      root: state.root,
      npmRoot,
      outputPath,
      prepareReceiptPath: state.preparePath,
      catalogPath: state.catalog,
      prepareArtifactId: '9001',
      expected: expected('2'),
    });
    assert.equal(receipt.prepare.identity, receiptIdentity(state.prepare));
    assert.equal(receipt.files.length, 4);
    assert.deepEqual(new Set(receipt.files.map((file) => file.package)), new Set(['lite', 'full']));
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), receipt);
    verifyNpmReceipt({
      root: state.root, npmRoot, receiptPath: outputPath, prepareReceiptPath: state.preparePath,
      catalogPath: state.catalog, prepareArtifactId: '9001', expected: expected(),
    });
    write(join(npmRoot, 'full/package.json'), JSON.stringify({ name: 'kiki-full', version: '1.2.4' }));
    assert.throws(
      () => verifyNpmReceipt({
        root: state.root, npmRoot, receiptPath: outputPath, prepareReceiptPath: state.preparePath,
        catalogPath: state.catalog, prepareArtifactId: '9001', expected: expected(),
      }),
      /digest mismatch|bytes mismatch/,
    );
    assert.throws(
      () => createNpmReceipt({
        root: state.root, npmRoot, outputPath, prepareReceiptPath: state.preparePath,
        catalogPath: state.catalog, prepareArtifactId: '9001', expected: expected('2'),
      }),
      /full npm version mismatch/,
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('artifact selection resumes with each target latest successful attempt without mixing duplicates', () => {
  const artifacts = TARGETS.map(([target], index) => ({
    id: index + 1,
    name: `kiki-release-target-77-${target}-1`,
    expired: false,
  }));
  artifacts.push({ id: 99, name: 'kiki-release-target-77-linux-x64-2', expired: false });
  assert.deepEqual(selectTargetArtifactIds({ artifacts, runId: '77', currentAttempt: '2' }), [99, 2, 3, 4, 5, 6]);
  assert.throws(
    () => selectTargetArtifactIds({ artifacts: artifacts.slice(0, 5), runId: '77', currentAttempt: '2' }),
    /Missing target artifact/,
  );
  assert.throws(
    () => selectTargetArtifactIds({ artifacts: [...artifacts, { ...artifacts[0], id: 100 }], runId: '77', currentAttempt: '2' }),
    /Duplicate target artifact/,
  );
  assert.throws(
    () => selectTargetArtifactIds({ artifacts: [...artifacts, { id: 101, name: 'kiki-release-target-77-linux-x64-3' }], runId: '77', currentAttempt: '2' }),
    /future attempt/,
  );
});

test('desktop staging consumes the verified native bytes and rejects a changed source or target', () => {
  const state = fixture();
  try {
    stageAll(state);
    const source = join(state.root, 'apps/kimi-code/dist-native/bin/win32-x64/kiki.exe');
    const candidate = join(state.root, 'sidecar-candidate');
    stageNativeCandidate({
      root: state.root, outputDir: candidate, target: 'win32-x64', rustTarget: 'x86_64-pc-windows-msvc',
      prepareReceiptPath: state.preparePath, catalogPath: state.catalog, prepareArtifactId: '9001',
      expected: expected('2'), nodeVersion: '24.22.1', pnpmVersion: '10.33.0', rustVersion: 'rustc fixture', signingMode: 'unsigned',
    });
    const env = {
      KIKI_SIDECAR_SOURCE: source, KIKI_SIDECAR_RELEASE_MODE: 'verified-prebuilt',
      KIKI_SIDECAR_RECEIPT: join(candidate, NATIVE_RECEIPT_NAME), KIKI_RELEASE_INPUT_RECEIPT: state.preparePath,
      KIKI_BUILT_IN_CATALOG_FILE: state.catalog, KIKI_RELEASE_REPOSITORY: 'example/kiki', KIKI_BUILD_SHA: SHA,
      KIKI_RELEASE_TAG: 'kiki-v1.2.3', KIKI_VERSION: '1.2.3', KIKI_UPDATE_CHANNEL: 'stable',
      KIKI_RELEASE_RUN_ID: '77', KIKI_RELEASE_PREPARE_ATTEMPT: '1', KIKI_RELEASE_CANDIDATE_ATTEMPT: '2',
      KIKI_RELEASE_PREPARE_ARTIFACT_ID: '9001',
    };
    const stage = (target = 'x86_64-pc-windows-msvc') => stageSidecar({
      argv: ['--target', target], env, binariesDir: join(state.root, 'binaries'),
      packageJsonPath: join(state.root, 'apps/kimi-code/package.json'), root: state.root,
    });
    const staged = stage();
    assert.equal(readFileSync(staged.destination, 'utf8'), 'native-win32-x64');
    assert.deepEqual(staged.releaseSource, { sourceSha: SHA, prepareIdentity: receiptIdentity(state.prepare), prepareArtifactId: '9001', producerAttempt: '2' });
    assert.throws(() => stage('aarch64-pc-windows-msvc'), /sidecar Rust target mismatch/);
    write(source, 'changed-native-bytes');
    assert.throws(() => stage(), /sidecar source (bytes|digest) mismatch/);
    assert.equal(readFileSync(staged.destination, 'utf8'), 'native-win32-x64');
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('candidate assembly accepts exactly six receipts sharing one prepare identity', () => {
  const state = fixture();
  try {
    const artifacts = stageAll(state);
    const nativeOutput = join(state.root, 'assembled/native');
    const desktopOutput = join(state.root, 'assembled/desktop');
    const candidates = verifyCandidateSet({
      artifactsRoot: artifacts,
      nativeOutput,
      desktopOutput,
      prepareReceiptPath: state.preparePath,
      catalogPath: state.catalog,
      prepareArtifactId: '9001',
      expected: expected(),
      root: state.root,
    });
    assert.equal(candidates.size, 6);
    assert.equal(readFileSync(join(nativeOutput, 'kiki-linux-x64'), 'utf8'), 'native-linux-x64');
    assert.equal(readFileSync(join(desktopOutput, 'Kiki-setup.exe'), 'utf8'), 'desktop-win32-x64-Kiki-setup.exe');
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('candidate assembly rejects missing, duplicate, wrong-attempt, source, and byte receipts', () => {
  for (const mutation of ['missing', 'duplicate', 'attempt', 'source', 'environment', 'bytes']) {
    const state = fixture();
    try {
      const artifacts = stageAll(state);
      const linux = join(artifacts, 'kiki-release-target-77-linux-x64-2');
      if (mutation === 'missing') rmSync(join(artifacts, 'kiki-release-target-77-linux-arm64-2'), { recursive: true });
      if (mutation === 'duplicate') {
        const duplicate = join(artifacts, 'kiki-release-target-77-linux-x64-1');
        mkdirSync(duplicate, { recursive: true });
        const receipt = JSON.parse(readFileSync(join(linux, NATIVE_RECEIPT_NAME), 'utf8'));
        receipt.workflow.producerAttempt = '1';
        write(join(duplicate, NATIVE_RECEIPT_NAME), `${JSON.stringify(receipt)}\n`);
        for (const file of receipt.files) write(join(duplicate, file.path), readFileSync(join(linux, file.path)));
      }
      if (mutation === 'attempt' || mutation === 'source' || mutation === 'environment') {
        const path = join(linux, NATIVE_RECEIPT_NAME);
        const receipt = JSON.parse(readFileSync(path, 'utf8'));
        if (mutation === 'attempt') receipt.workflow.prepareProducerAttempt = '9';
        else if (mutation === 'source') receipt.sourceSha = 'abcdef1234567890abcdef1234567890abcdef12';
        else receipt.tools.rust = 'rustc 9.9.9';
        write(path, `${JSON.stringify(receipt)}\n`);
      }
      if (mutation === 'bytes') write(join(linux, 'native/kiki-linux-x64'), 'tampered');

      assert.throws(
        () => verifyCandidateSet({
          artifactsRoot: artifacts,
          nativeOutput: join(state.root, 'assembled/native'),
          desktopOutput: join(state.root, 'assembled/desktop'),
          prepareReceiptPath: state.preparePath,
          catalogPath: state.catalog,
          prepareArtifactId: '9001',
          expected: expected(),
          root: state.root,
        }),
        mutation === 'missing' ? /Missing release candidate/
          : mutation === 'duplicate' ? /Duplicate release candidate/
            : mutation === 'attempt' ? /prepare producer attempt mismatch/
              : mutation === 'source' ? /native sourceSha mismatch/
                : mutation === 'environment' ? /environment differs/
                  : /bytes mismatch|digest mismatch/,
      );
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  }
});
