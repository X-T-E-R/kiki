import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { collectAuthNativePackage } from '../../../apps/kimi-code/scripts/native/assets.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '../..');
const appRoot = resolve(repoRoot, 'apps/kimi-code');
const req = createRequire(join(appRoot, 'package.json'));
const scratch = resolve(repoRoot, '.tmp/auth-native-cli-proof');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'install-proof-'));
const env = {
  ...process.env, NODE_PATH: '', NODE_OPTIONS: '',
  KIKI_HOME: join(root, 'home'), KIKI_CACHE_DIR: join(root, 'cache'), KIKI_AUTH_NATIVE_SMOKE: '1',
  HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'home'), LOCALAPPDATA: join(root, 'home'),
  TMP: join(root, 'temp'), TEMP: join(root, 'temp'), TMPDIR: join(root, 'temp'), npm_config_cache: join(root, 'npm-cache'),
};
for (const path of [env.KIKI_HOME, env.KIKI_CACHE_DIR, env.TMP]) await mkdir(path, { recursive: true });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const copiedApp = join(root, 'apps/kimi-code');
await mkdir(join(copiedApp, 'scripts/npm'), { recursive: true });
for (const name of ['package.json', 'README.md', 'scripts/npm/stage.mjs', 'scripts/npm/desktop-postinstall.mjs']) await cp(join(appRoot, name), join(copiedApp, name));
await mkdir(join(root, 'apps/kiki-gui'), { recursive: true });
await cp(join(appRoot, '../kiki-gui/package.json'), join(root, 'apps/kiki-gui/package.json'));
run(process.execPath, [req.resolve('tsdown/run'), '--config', join(appRoot, 'tsdown.config.ts'), '--out-dir', join(copiedApp, 'dist')], appRoot);
const assets = await collectAuthNativePackage({ packageRoot, target: `${process.platform}-${process.arch}` });
for (const file of assets.packageManifest.files) {
  const name = file.relativePath.slice('node_modules/@kiki/auth-native/'.length);
  const destination = join(copiedApp, 'native/auth-native', name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(assets.assets[file.assetKey], destination);
}
run(process.execPath, [join(copiedApp, 'scripts/npm/stage.mjs')]);
const npm = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const packed = JSON.parse(run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], join(copiedApp, 'dist-npm/lite')));
const wsPackageRoot = dirname(req.resolve('ws/package.json'));
const wsPacked = JSON.parse(run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], wsPackageRoot));
const installation = join(root, 'installation');
run(process.execPath, [npm, 'install', '--prefix', installation, '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', join(root, wsPacked[0].filename), join(root, packed[0].filename)]);
const installed = join(installation, 'node_modules/kiki-agent-lite');
const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
if (manifest.dependencies?.['@kiki/auth-native']) throw new Error('npm payload unexpectedly depends on unpublished native package');
const output = run(process.execPath, [join(installed, 'dist/main.mjs'), '--version'], installation);
if (!output.includes('Auth native smoke passed:')) throw new Error(output);
await writeFile(join(root, 'result.txt'), output);
console.log(`Actual CLI staged npm pack/install: ${output.trim()}`);
console.log(`Proof artifacts: ${root}`);
