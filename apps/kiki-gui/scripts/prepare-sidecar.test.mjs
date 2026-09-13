import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSidecarManifest,
  defaultSeaSource,
  parseRustHost,
  parseTargetArg,
  sidecarFileName,
  sidecarManifestFileName,
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

test('manifest pins the staged bytes, sha256, target, and server version', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-sidecar-manifest-'));
  try {
    const sidecar = join(root, 'kiki-server');
    writeFileSync(sidecar, 'known-sidecar-bytes');
    assert.deepEqual(createSidecarManifest(sidecar, 'test-target', '9.8.7'), {
      schemaVersion: 1,
      target: 'test-target',
      bytes: 19,
      sha256: '29025d693dd94cf370051062a2d686f6b42d509aadb4de56d4b8f40f15a707cd',
      serverVersion: '9.8.7',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
