import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertDesktopVersions, readDesktopVersions, setDesktopVersion } from './desktop-version.mjs';

test('accepts one canonical desktop version and matching release tag', () => {
  const versions = {
    package: '0.7.0-beta.1',
    cli: '0.7.0-beta.1',
    desktop: '0.7.0-beta.1',
    system: '0.7.0-beta.1',
  };
  assert.equal(assertDesktopVersions(versions, 'kiki-v0.7.0-beta.1'), '0.7.0-beta.1');
  assert.throws(
    () => assertDesktopVersions({ ...versions, desktop: '0.7.0' }),
    /version drift/,
  );
});

test('setDesktopVersion synchronizes GUI, CLI, Electron desktop, and system.yaml for stable and beta versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiki-desktop-version-'));
  try {
    const files = {
      package: join(dir, 'gui.json'),
      cli: join(dir, 'cli.json'),
      desktop: join(dir, 'desktop.json'),
      system: join(dir, 'system.yaml'),
    };
    writeFileSync(files.package, '{"name":"@kiki/gui","version":"0.6.2"}\n');
    writeFileSync(files.cli, '{"name":"@kiki/cli","version":"0.7.0"}\n');
    writeFileSync(files.desktop, '{"name":"@kiki/desktop","version":"0.7.0"}\n');
    writeFileSync(files.system, 'system:\n  version: 0.6.2\n');

    setDesktopVersion('0.7.0-beta.1', files);
    assert.equal(assertDesktopVersions(readDesktopVersions(files), 'kiki-v0.7.0-beta.1'), '0.7.0-beta.1');
    assert.equal(JSON.parse(readFileSync(files.package, 'utf8')).version, '0.7.0-beta.1');
    assert.equal(JSON.parse(readFileSync(files.cli, 'utf8')).version, '0.7.0-beta.1');
    assert.equal(JSON.parse(readFileSync(files.desktop, 'utf8')).version, '0.7.0-beta.1');
    assert.match(readFileSync(files.system, 'utf8'), /^  version: 0\.7\.0-beta\.1$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
