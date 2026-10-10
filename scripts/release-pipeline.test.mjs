import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { seaRuntimeOptions } from '../apps/kimi-code/scripts/native/02-sea-blob.mjs';
import { macosSigningOptions } from '../apps/kimi-code/scripts/native/04-sign.mjs';
import { NPM_DISTRIBUTIONS, stageNpmDistributions } from '../apps/kimi-code/scripts/npm/stage.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');

test('public CLI and desktop sidecar builds use the release SEA policy independently of signing', async () => {
  assert.deepEqual(seaRuntimeOptions('release'), { execArgv: [], execArgvExtension: 'env' });
  assert.deepEqual(seaRuntimeOptions('local'), {
    execArgv: ['--max-old-space-size=8192'], execArgvExtension: 'cli',
  });
  const env = { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example', APPLE_KEYCHAIN_PATH: '/example/keychain' };
  assert.deepEqual(macosSigningOptions(false, env), { identity: '-', keychainPath: null });
  assert.deepEqual(macosSigningOptions(true, env), {
    identity: env.APPLE_SIGNING_IDENTITY, keychainPath: env.APPLE_KEYCHAIN_PATH,
  });
  assert.deepEqual(macosSigningOptions(true, {}), { identity: '-', keychainPath: null });

  const native = await read('.github/workflows/_native-build.yml');
  assert.ok(!native.includes('run build:native:sea'));
  assert.match(native, /run build:native:release --sign-macos/);
  assert.match(native, /run build:native:release\r?\n/);
  const desktop = await read('.github/workflows/kiki-desktop-release.yml');
  assert.ok(!desktop.includes('run build:native:sea'));
  assert.match(desktop, /run build:native:release\r?\n/);
  const build = await read('apps/kimi-code/scripts/native/build.mjs');
  assert.match(build, /runSignStep\(macosSigningOptions\(values\['sign-macos'\]\)\)/);
});

test('every Pages artifact contains feeds before upload and deployment', async () => {
  const workflows = join(root, '.github/workflows');
  let deployments = 0;
  for (const name of await readdir(workflows)) {
    const source = await readFile(join(workflows, name), 'utf8');
    if (!source.includes('actions/deploy-pages@')) continue;
    deployments += 1;
    const docs = source.indexOf('docs run build');
    const feeds = source.indexOf('desktop-release-feed.mjs --repository X-T-E-R/kiki --output-dir docs/.vitepress/dist/updater');
    const upload = source.indexOf('actions/upload-pages-artifact@');
    const deploy = source.indexOf('actions/deploy-pages@');
    assert.ok(docs >= 0 && docs < feeds && feeds < upload && upload < deploy, name);
    assert.ok(!source.slice(feeds, upload).includes('continue-on-error: true'), name);
  }
  assert.equal(deployments, 2);
  const feed = await read('.github/workflows/kiki-desktop-feed.yml');
  assert.ok(!feed.includes('Deploy Docs to GitHub Pages'));
  assert.match(feed, /- Kiki Desktop Release/);
});

test('npm stages preserve public distribution names and synchronized workspace version', async (t) => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/release-stage-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const app = join(scratch, 'apps/kimi-code');
  const gui = join(scratch, 'apps/kiki-gui');
  await mkdir(join(app, 'dist'), { recursive: true });
  await mkdir(join(app, 'native'), { recursive: true });
  await mkdir(join(app, 'scripts/npm'), { recursive: true });
  await mkdir(gui, { recursive: true });
  const source = {
    name: '@kiki/cli', version: '1.2.3-beta.1', license: 'MIT',
    dependencies: { ws: '^8.0.0' }, optionalDependencies: { 'node-pty': '^1.0.0' },
  };
  await writeFile(join(app, 'package.json'), JSON.stringify(source));
  await writeFile(join(gui, 'package.json'), JSON.stringify({ version: source.version }));
  await writeFile(join(app, 'README.md'), 'Example CLI');
  await writeFile(join(app, 'dist/main.mjs'), 'export {};');
  await writeFile(join(app, 'native/example.json'), '{}');
  await writeFile(join(app, 'scripts/npm/desktop-postinstall.mjs'), 'export {};');
  await stageNpmDistributions(app);
  assert.deepEqual(NPM_DISTRIBUTIONS, [['lite', 'kiki-agent-lite'], ['full', 'kiki-agent']]);
  for (const [kind, name] of NPM_DISTRIBUTIONS) {
    const staged = JSON.parse(await readFile(join(app, 'dist-npm', kind, 'package.json'), 'utf8'));
    assert.equal(staged.name, name);
    assert.equal(staged.version, source.version);
    assert.equal(staged.publishConfig.registry, 'https://registry.npmjs.org/');
    assert.equal(staged.scripts?.postinstall, kind === 'full' ? 'node scripts/desktop-postinstall.mjs' : undefined);
    assert.equal(await readFile(join(app, 'dist-npm', kind, 'dist/main.mjs'), 'utf8'), 'export {};');
  }
  await writeFile(join(gui, 'package.json'), JSON.stringify({ version: '1.2.4' }));
  await assert.rejects(stageNpmDistributions(app), /must use the same release version/);
  assert.equal(JSON.parse(await readFile(join(app, 'dist-npm/lite/package.json'), 'utf8')).version, source.version);

  const setup = await read('.github/KIKI_DESKTOP_RELEASE.md');
  for (const [, name] of NPM_DISTRIBUTIONS) assert.ok(setup.includes(`\`${name}\``));
  assert.ok(!setup.includes('kiki-cli-lite'));
  assert.match(setup, /separate workspace-package channel using `changeset publish`/);
});
