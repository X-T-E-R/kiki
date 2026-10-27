import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  createSidecarManifest,
  defaultSeaSource,
  parseRustHost,
  parseTargetArg,
  prebuiltReceiptRequired,
  sidecarFileName,
  sidecarManifestFileName,
  stageSidecar,
} from './prepare-sidecar.mjs';

test('parses both Tauri target argument forms', () => {
  assert.equal(parseTargetArg(['--target', 'aarch64-pc-windows-msvc']), 'aarch64-pc-windows-msvc');
  assert.equal(parseTargetArg(['--target=x86_64-pc-windows-msvc']), 'x86_64-pc-windows-msvc');
  assert.equal(parseTargetArg([]), undefined);
  assert.throws(() => parseTargetArg(['--target']), /requires a Rust target triple/);
});
test('extracts rustc host target', () => {
  assert.equal(
    parseRustHost('rustc 1.96.1\nbinary: rustc\nhost: x86_64-pc-windows-msvc\n'),
    'x86_64-pc-windows-msvc',
  );
  assert.throws(() => parseRustHost('rustc 1.96.1\n'), /did not report/);
});

test('uses Tauri externalBin target suffixes', () => {
  assert.equal(sidecarFileName('x86_64-pc-windows-msvc'), 'kiki-server-x86_64-pc-windows-msvc.exe');
  assert.equal(sidecarFileName('aarch64-apple-darwin'), 'kiki-server-aarch64-apple-darwin');
});

test('maps supported Rust targets to the Kiki SEA layout', () => {
  assert.match(defaultSeaSource('x86_64-pc-windows-msvc'), /win32-x64[\\/]kiki\.exe$/);
  assert.match(defaultSeaSource('aarch64-apple-darwin'), /darwin-arm64[\\/]kiki$/);
  assert.throws(() => defaultSeaSource('wasm32-unknown-unknown'), /KIKI_SIDECAR_SOURCE/);
});

test('keeps legacy explicit sources receipt-free and requires receipts only in verified release mode', () => {
  assert.equal(prebuiltReceiptRequired({ KIKI_SIDECAR_SOURCE: 'C:/legacy/kiki.exe' }), false);
  assert.equal(prebuiltReceiptRequired({ KIKI_SIDECAR_RECEIPT: 'legacy-receipt.json' }), false);
  assert.equal(prebuiltReceiptRequired({ KIKI_SIDECAR_RELEASE_MODE: 'verified-prebuilt' }), true);
  assert.throws(
    () => prebuiltReceiptRequired({ KIKI_SIDECAR_RELEASE_MODE: 'unknown' }),
    /must be verified-prebuilt/,
  );
});

test('legacy explicit KIKI_SIDECAR_SOURCE stages without release receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-sidecar-legacy-source-'));
  try {
    const source = join(root, 'legacy-kiki.exe');
    const packageJson = join(root, 'package.json');
    const binaries = join(root, 'binaries');
    writeFileSync(source, 'legacy-sidecar');
    writeFileSync(packageJson, JSON.stringify({ version: '1.2.3' }));
    const result = stageSidecar({
      argv: ['--target', 'x86_64-pc-windows-msvc'],
      env: { KIKI_SIDECAR_SOURCE: source },
      binariesDir: binaries,
      packageJsonPath: packageJson,
    });
    assert.equal(readFileSync(result.destination, 'utf8'), 'legacy-sidecar');
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.releaseSource, undefined);
    assert.throws(
      () => stageSidecar({
        argv: ['--target', 'x86_64-pc-windows-msvc'],
        env: { KIKI_SIDECAR_SOURCE: source, KIKI_SIDECAR_RELEASE_MODE: 'verified-prebuilt' },
        binariesDir: binaries,
        packageJsonPath: packageJson,
      }),
      /requires its native receipt/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes target-specific manifest names beside the sidecar', () => {
  assert.equal(
    sidecarManifestFileName('x86_64-pc-windows-msvc'),
    'kiki-server-x86_64-pc-windows-msvc.exe.manifest.json',
  );
  assert.equal(
    sidecarManifestFileName('aarch64-apple-darwin'),
    'kiki-server-aarch64-apple-darwin.manifest.json',
  );
});

test('manifest schema matches the actual Rust build consumer', () => {
  const buildRs = readFileSync(resolve(import.meta.dirname, '../src-tauri/build.rs'), 'utf8');
  const accepted = Number(/const SIDECAR_MANIFEST_VERSION: u32 = (\d+);/.exec(buildRs)?.[1]);
  const root = mkdtempSync(join(tmpdir(), 'kiki-sidecar-schema-'));
  try {
    const sidecar = join(root, 'kiki-server');
    writeFileSync(sidecar, 'schema-contract');
    assert.equal(createSidecarManifest(sidecar, 'test-target', '1.2.3').schemaVersion, accepted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest pins the staged bytes, target, version, and desktop build identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-sidecar-manifest-'));
  try {
    const sidecar = join(root, 'kiki-server');
    writeFileSync(sidecar, 'known-sidecar-bytes');
    assert.deepEqual(createSidecarManifest(sidecar, 'test-target', '9.8.7', 'build-42', 'beta'), {
      schemaVersion: 2,
      target: 'test-target',
      bytes: 19,
      sha256: '29025d693dd94cf370051062a2d686f6b42d509aadb4de56d4b8f40f15a707cd',
      serverVersion: '9.8.7',
      buildId: 'build-42',
      buildChannel: 'beta',
      releaseSource: undefined,
    });
    assert.equal(
      createSidecarManifest(sidecar, 'test-target', '9.8.7').buildId,
      '29025d693dd94cf370051062a2d686f6b42d509aadb4de56d4b8f40f15a707cd',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
