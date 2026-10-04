import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '../..');
const scratch = resolve(repoRoot, '.tmp/auth-native-build');

await test('Nix-style ancestor vendor config survives explicit empty Cargo home/target; build and notices stay offline', () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'nix-env-proof-'));
  const vendor = join(root, 'cargo-vendor-dir');
  const preparedEnv = {
    ...process.env,
    CARGO_HOME: join(scratch, 'cargo-home'),
    CARGO_TARGET_DIR: join(scratch, 'target'),
    CARGO_NET_OFFLINE: 'true',
  };
  execFileSync('cargo', ['vendor', '--offline', '--locked', vendor], {
    cwd: packageRoot, env: preparedEnv, stdio: 'pipe', timeout: 120_000,
  });
  const lockChecksums = [...readFileSync(join(packageRoot, 'Cargo.lock'), 'utf8').matchAll(/checksum = "([a-f0-9]{64})"/g)].map((match) => match[1]).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const vendorChecksums = readdirSync(vendor).map((name) => JSON.parse(readFileSync(join(vendor, name, '.cargo-checksum.json'), 'utf8')).package).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  assert.deepEqual(vendorChecksums, lockChecksums, 'vendor must contain precisely the checksum-pinned lockfile dependency set');
  const copiedRepo = join(root, 'source');
  const copiedPackage = join(copiedRepo, 'packages/auth-native');
  mkdirSync(copiedPackage, { recursive: true });
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'src', 'scripts/build.mjs']) {
    const destination = join(copiedPackage, name);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    cpSync(join(packageRoot, name), destination, { recursive: true });
  }
  mkdirSync(join(root, '.cargo'));
  writeFileSync(join(root, '.cargo/config.toml'), '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "cargo-vendor-dir"\n');
  const externalHome = join(root, 'empty-cargo-home');
  const externalTarget = join(root, 'explicit-cargo-target');
  mkdirSync(externalHome);
  const env = {
    ...process.env,
    KIKI_AUTH_NATIVE_ARTIFACT_ROOT: '',
    KIKI_BUILD_TARGET: `${process.platform}-${process.arch}`,
    CARGO_HOME: externalHome,
    CARGO_TARGET_DIR: externalTarget,
    CARGO_NET_OFFLINE: 'true',
  };
  const lockBefore = readFileSync(join(copiedPackage, 'Cargo.lock'));
  const output = execFileSync(process.execPath, [join(copiedPackage, 'scripts/build.mjs')], {
    cwd: copiedRepo, env, encoding: 'utf8', stdio: 'pipe', timeout: 300_000,
  });
  assert.match(output, /Built auth-native N-API 8 binding/);
  assert.ok(existsSync(join(copiedPackage, 'prebuilds', `${process.platform}-${process.arch}`, 'auth-native.node')));
  assert.ok(existsSync(externalTarget));
  assert.equal(existsSync(join(copiedRepo, '.tmp/auth-native-build')), false, 'provided Cargo paths must not be replaced by local defaults');
  for (const cache of ['index', 'cache', 'src']) {
    assert.equal(existsSync(join(externalHome, 'registry', cache)), false, 'vendored build must not populate a registry dependency cache');
  }
  assert.deepEqual(readFileSync(join(copiedPackage, 'Cargo.lock')), lockBefore);
  const notices = JSON.parse(readFileSync(join(copiedPackage, 'licenses/rust-dependencies.json'), 'utf8'));
  assert.ok(notices.some((pkg) => pkg.name === 'age' && pkg.version === '0.11.1'));
  assert.ok(notices.some((pkg) => pkg.name === 'fs2' && pkg.files.length > 0));
  assert.ok(readdirSync(join(copiedPackage, 'licenses/rust/fs2-0.4.3')).length > 0);
  process.stdout.write(`Offline vendor/env build and metadata/notices passed: ${notices.length} dependencies; proof ${root}\n`);
});
