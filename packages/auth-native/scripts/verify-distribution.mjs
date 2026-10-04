import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { collectAuthNativePackage, nativeAssetManifestKey } from '../../../apps/kimi-code/scripts/native/assets.mjs';
import { NATIVE_ASSET_MANIFEST_VERSION } from '../../../apps/kimi-code/scripts/native/manifest.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '../..');
const appRoot = resolve(repoRoot, 'apps/kimi-code');
const req = createRequire(join(appRoot, 'package.json'));
const scratch = resolve(repoRoot, '.tmp/auth-native-distribution');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'proof-'));
const target = `${process.platform}-${process.arch}`;
const env = {
  ...process.env,
  NODE_PATH: '', NODE_OPTIONS: '',
  KIKI_HOME: join(root, 'home'), KIKI_CACHE_DIR: join(root, 'cache'),
  HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'home'), LOCALAPPDATA: join(root, 'home'),
  TMP: join(root, 'temp'), TEMP: join(root, 'temp'), TMPDIR: join(root, 'temp'),
  npm_config_cache: join(root, 'npm-cache'),
};
for (const path of [env.KIKI_HOME, env.KIKI_CACHE_DIR, env.TMP]) await mkdir(path, { recursive: true });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const tsdownCli = req.resolve('tsdown/run');
const entry = resolve(packageRoot, 'tests/distribution-entry.ts');
const config = join(root, 'fixture.config.mjs');
const configSource = (format, outDir) => `export default { entry: [${JSON.stringify(entry)}], format: [${JSON.stringify(format)}], outDir: ${JSON.stringify(outDir)}, clean: false, dts: false, platform: 'node', target: 'node24', fixedExtension: true, deps: { neverBundle: ['@kiki/auth-native'], alwaysBundle: id => id === 'pathe', onlyBundle: false }, alias: {'#/cli/build-info': ${JSON.stringify(join(appRoot, 'src/cli/build-info.ts'))}}, outputOptions: {codeSplitting:false, entryFileNames:${JSON.stringify(format === 'cjs' ? 'main.cjs' : 'main.mjs')}}, banner: ${format === 'cjs' ? JSON.stringify({ js: 'var require = require("node:module").createRequire(process.execPath);' }) : '{}'} };\n`;

const assets = await collectAuthNativePackage({ packageRoot, target });
const npmRoot = join(root, 'npm-package');
await mkdir(npmRoot, { recursive: true });
await writeFile(config, configSource('esm', join(npmRoot, 'dist')));
run(process.execPath, [tsdownCli, '--config', config], appRoot);
for (const file of assets.packageManifest.files) {
  const name = file.relativePath.slice('node_modules/@kiki/auth-native/'.length);
  const destination = join(npmRoot, 'native/auth-native', name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(assets.assets[file.assetKey], destination);
}
await writeFile(join(npmRoot, 'package.json'), `${JSON.stringify({ name: 'auth-distribution-fixture', version: '0.0.0', type: 'module', files: ['dist', 'native'], bin: { 'auth-fixture': 'dist/main.mjs' } }, null, 2)}\n`);
const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], npmRoot));
const tarball = join(root, packed[0].filename);
const installRoot = join(root, 'installation');
run(process.execPath, [npmCli, 'install', '--prefix', installRoot, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
const installed = join(installRoot, 'node_modules/auth-distribution-fixture');
const npmOutput = run(process.execPath, [join(installed, 'dist/main.mjs')], installed);
if (!npmOutput.includes('AUTH_DISTRIBUTION_OK')) throw new Error(npmOutput);
console.log(`Isolated npm pack/install: ${npmOutput.trim()}`);

const seaRoot = join(root, 'sea');
await mkdir(seaRoot);
await writeFile(config, configSource('cjs', seaRoot));
run(process.execPath, [tsdownCli, '--config', config], appRoot);
const manifest = { version: NATIVE_ASSET_MANIFEST_VERSION, target, packages: [assets.packageManifest], runtimeFiles: [] };
const manifestPath = join(seaRoot, 'manifest.json');
await writeFile(manifestPath, JSON.stringify(manifest));
const seaConfig = join(seaRoot, 'sea.json');
const blob = join(seaRoot, 'auth.blob');
await writeFile(seaConfig, JSON.stringify({ main: join(seaRoot, 'main.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false,
  assets: { [nativeAssetManifestKey(target)]: manifestPath, ...assets.assets } }));
run(process.execPath, ['--experimental-sea-config', seaConfig]);
const executable = join(seaRoot, process.platform === 'win32' ? 'auth-fixture.exe' : 'auth-fixture');
await cp(process.execPath, executable);
const { inject } = req('postject');
await inject(executable, 'NODE_SEA_BLOB', await readFile(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
const seaOutput = run(executable, [], seaRoot);
if (!seaOutput.includes('AUTH_DISTRIBUTION_OK')) throw new Error(seaOutput);
console.log(`Isolated SEA: ${seaOutput.trim()}`);
console.log(`Proof artifacts: ${root}`);
