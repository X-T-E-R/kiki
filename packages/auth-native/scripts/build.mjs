import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '../..');
if (process.env.KIKI_AUTH_NATIVE_ARTIFACT_ROOT) {
  const { mergeAuthNativeLanes } = await import('./lane-assets.mjs');
  await mergeAuthNativeLanes({
    artifactRoot: resolve(process.env.KIKI_AUTH_NATIVE_ARTIFACT_ROOT),
    destination: resolve(repoRoot, '.tmp/auth-native-build/verified-lanes'),
  });
  console.log('Verified all six existing auth-native lane artifacts; no host Rust rebuild needed for npm assembly');
  process.exit(0);
}
const target = process.env.KIKI_BUILD_TARGET ?? `${process.platform}-${process.arch}`;
const triples = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
if (!Object.hasOwn(triples, target)) throw new Error(`Unsupported auth-native build target: ${target}`);
if (target !== `${process.platform}-${process.arch}`) {
  throw new Error(`Build auth-native ${target} on its matching host lane; current host is ${process.platform}-${process.arch}`);
}
const scratch = resolve(repoRoot, '.tmp/auth-native-build');
const cargoTarget = process.env.CARGO_TARGET_DIR
  ? resolve(packageRoot, process.env.CARGO_TARGET_DIR)
  : resolve(scratch, 'target');
const env = {
  ...process.env,
  CARGO_HOME: process.env.CARGO_HOME
    ? resolve(packageRoot, process.env.CARGO_HOME)
    : resolve(scratch, 'cargo-home'),
  CARGO_TARGET_DIR: cargoTarget,
};
mkdirSync(env.CARGO_HOME, { recursive: true });
const result = spawnSync('cargo', ['build', '--release', '--locked', '--target', triples[target]], {
  cwd: packageRoot, env, stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const library = target.startsWith('win32-') ? 'kiki_auth_native.dll'
  : target.startsWith('darwin-') ? 'libkiki_auth_native.dylib' : 'libkiki_auth_native.so';
const destination = resolve(packageRoot, 'prebuilds', target);
mkdirSync(destination, { recursive: true });
copyFileSync(resolve(cargoTarget, triples[target], 'release', library), resolve(destination, 'auth-native.node'));
const metadataRun = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', triples[target]], {
  cwd: packageRoot, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
if (metadataRun.error) throw metadataRun.error;
if (metadataRun.status !== 0) throw new Error(`Cargo license metadata failed: ${metadataRun.stderr}`);
const metadata = JSON.parse(metadataRun.stdout);
const notices = [];
for (const pkg of metadata.packages.filter((pkg) => pkg.source !== null)) {
  const crateRoot = dirname(pkg.manifest_path);
  const licenseFiles = readdirSync(crateRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE|UNLICENSE)([.-]|$)/i.test(entry.name))
    .map((entry) => entry.name);
  if (pkg.license_file && !licenseFiles.includes(pkg.license_file)) licenseFiles.push(pkg.license_file);
  const noticeRoot = resolve(packageRoot, 'licenses/rust', `${pkg.name}-${pkg.version}`);
  mkdirSync(noticeRoot, { recursive: true });
  for (const name of licenseFiles) {
    const destinationFile = resolve(noticeRoot, name);
    mkdirSync(dirname(destinationFile), { recursive: true });
    copyFileSync(resolve(crateRoot, name), destinationFile);
  }
  notices.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, files: licenseFiles });
}
writeFileSync(resolve(packageRoot, 'licenses/rust-dependencies.json'), `${JSON.stringify(notices, null, 2)}\n`);
console.log(`Built auth-native N-API 8 binding: ${target}; collected ${notices.length} dependency notices`);
