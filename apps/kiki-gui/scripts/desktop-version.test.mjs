import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertDesktopVersions, readDesktopVersions, setDesktopVersion } from './desktop-version.mjs';

test('accepts one canonical desktop version and matching release tag', () => {
  const versions = {
    package: '0.1.0-beta.1',
    tauri: '0.1.0-beta.1',
    cargo: '0.1.0-beta.1',
    system: '0.1.0-beta.1',
  };
  assert.equal(assertDesktopVersions(versions, 'kiki-v0.1.0-beta.1'), '0.1.0-beta.1');
  assert.throws(
    () => assertDesktopVersions({ ...versions, cargo: '0.1.0' }),
    /version drift/,
  );
});

test('setDesktopVersion synchronizes package, CLI, Tauri, Cargo, Cargo.lock, and system.yaml for beta versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiki-desktop-version-'));
  try {
    const files = {
      package: join(dir, 'gui.json'),
      cli: join(dir, 'cli.json'),
      tauri: join(dir, 'tauri.conf.json'),
      cargo: join(dir, 'Cargo.toml'),
      cargoLock: join(dir, 'Cargo.lock'),
      system: join(dir, 'system.yaml'),
    };
    writeFileSync(files.package, '{"version":"0.5.1"}\n');
    writeFileSync(files.cli, '{"version":"0.5.1"}\n');
    writeFileSync(files.tauri, '{"version":"0.5.1"}\n');
    writeFileSync(files.cargo, '[package]\nname = "kiki-desktop"\nversion = "0.5.1"\n');
    writeFileSync(files.cargoLock, '[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "kiki-desktop"\nversion = "0.5.1"\n');
    writeFileSync(files.system, 'system:\n  version: 0.5.1\n');

    setDesktopVersion('0.6.0-beta.1', files);
    assert.equal(assertDesktopVersions(readDesktopVersions(files), 'kiki-v0.6.0-beta.1'), '0.6.0-beta.1');
    const lock = readFileSync(files.cargoLock, 'utf8');
    assert.match(lock, /name = "kiki-desktop"\r?\nversion = "0\.6\.0-beta\.1"/);
    assert.match(lock, /name = "other"\r?\nversion = "1\.0\.0"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
