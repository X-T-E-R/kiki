import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultSeaSource,
  parseRustHost,
  parseTargetArg,
  sidecarFileName,
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

test('maps supported Rust targets to the existing SEA layout', () => {
  assert.match(defaultSeaSource('x86_64-pc-windows-msvc'), /win32-x64[\\/]kimi\.exe$/);
  assert.match(defaultSeaSource('aarch64-apple-darwin'), /darwin-arm64[\\/]kimi$/);
  assert.throws(() => defaultSeaSource('wasm32-unknown-unknown'), /KIKI_SIDECAR_SOURCE/);
});
