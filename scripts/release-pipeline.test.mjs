import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { seaRuntimeOptions } from '../apps/kimi-code/scripts/native/02-sea-blob.mjs';
import { macosSigningOptions } from '../apps/kimi-code/scripts/native/04-sign.mjs';
import { NODE_RUNTIME_RANGE, nodeRuntimeAccepted, nodeRuntimeRejection } from '../apps/kimi-code/scripts/native/node-runtime.mjs';
import { NPM_DISTRIBUTIONS, stageNpmDistributions } from '../apps/kimi-code/scripts/npm/stage.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');

void test('public CLI and desktop sidecar builds use the release SEA policy independently of signing', async () => {
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
  assert.doesNotMatch(desktop, /^  desktop-bundle:/m);
  assert.match(desktop, /build-desktop: true/);
  assert.match(desktop, /uses: \.\/\.github\/workflows\/_native-build\.yml/);
  const build = await read('apps/kimi-code/scripts/native/build.mjs');
  assert.match(build, /runSignStep\(macosSigningOptions\(values\['sign-macos'\]\)\)/);
});

void test('desktop release freezes one catalog and keeps native to desktop ordering per target', async () => {
  const release = await read('.github/workflows/kiki-desktop-release.yml');
  const native = await read('.github/workflows/_native-build.yml');

  assert.equal((release.match(/update-catalog\.mjs/g) ?? []).length, 1);
  assert.match(release, /^  prepare:/m);
  const prepare = release.slice(release.indexOf('  prepare:'), release.indexOf('  cli-native:'));
  assert.match(prepare, /- name: Checkout release commit[\s\S]*?ref: \$\{\{ github\.sha \}\}/);
  assert.match(release, /artifact-id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
  assert.match(release, /prepare-artifact-id: \$\{\{ needs\.prepare\.outputs\.artifact-id \}\}/);
  assert.match(release, /select-artifacts/);
  assert.match(release, /artifact-ids: \$\{\{ steps\.target-artifacts\.outputs\.artifact-ids \}\}/);
  assert.match(release, /verify-candidates/);
  assert.doesNotMatch(release, /pattern: kiki-agent-|pattern: kiki-desktop-/);

  const build = native.indexOf('- name: Build native executable');
  const smoke = native.indexOf('- name: Smoke test native executable');
  const receipt = native.indexOf('- name: Write native source receipt');
  const desktop = native.indexOf('- name: Build and stage desktop bundles');
  const upload = native.indexOf('- name: Upload immutable target candidate');
  assert.ok(build >= 0 && build < smoke && smoke < receipt && receipt < desktop && desktop < upload);
  assert.match(native, /kiki-release-target-\$\{\{ github\.run_id \}\}-\$\{\{ matrix\.target \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(native, /if: inputs\.prepare-artifact-id == ''[\s\S]*name: \$\{\{ inputs\.upload-artifact-prefix \}\}-\$\{\{ matrix\.target \}\}/);
  assert.match(native, /if: inputs\.build-desktop && matrix\.desktop-name != ''/);
  assert.doesNotMatch(native, /vars\.KIKI_UPDATER_PUBLIC_KEY/);
  assert.match(native, /verify-prepare[\s\S]*?--github-env "\$GITHUB_ENV"/);
  assert.match(native, /--updater-public-key "\$\{KIKI_EMBEDDED_UPDATER_PUBLIC_KEY:-\}"/);
  assert.doesNotMatch(release, /needs:[\s\S]{0,80}desktop-bundle/);

  const publish = release.slice(release.indexOf('  publish:'));
  assert.match(publish, /^  publish:[\s\S]*?    environment: release/m);
  assert.match(publish, /gh api --paginate --slurp/);
  assert.doesNotMatch(publish, /update-catalog\.mjs/);
  assert.match(publish, /test -f "\$KIKI_BUILT_IN_CATALOG_FILE"/);
  assert.match(publish, /npm-publication-action/);
  assert.match(publish, /Existing release asset differs/);
  assert.match(publish, /refusing to mutate public assets/);
  const verifyCandidates = publish.indexOf('verify-candidates');
  const signatureStep = publish.indexOf('- name: Sign updater with production key');
  const publishValidated = publish.indexOf('- name: Publish validated release');
  assert.ok(verifyCandidates >= 0 && signatureStep >= 0 && publishValidated >= 0);
  assert.ok(verifyCandidates < signatureStep && verifyCandidates < publishValidated);
  assert.match(publish.slice(verifyCandidates, signatureStep), /--github-env "\$GITHUB_ENV"/);
  const signature = publish.slice(signatureStep, publish.indexOf('- name: Create versioned release metadata', signatureStep));
  assert.doesNotMatch(signature, /vars\.KIKI_UPDATER_PUBLIC_KEY/);
  const signatureVerify = publish.indexOf('verify-updater-signature.mjs');
  const manifest = publish.indexOf('desktop-release-manifest.mjs');
  assert.ok(signatureVerify >= 0 && signatureVerify < manifest);
  assert.match(publish, /--public-key "\$KIKI_UPDATER_PUBLIC_KEY"/);
  assert.match(publish, /stage-npm/);
});

void test('every Pages artifact contains feeds before upload and deployment', async () => {
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

void test('npm stages preserve public distribution names and synchronized workspace version', async (t) => {
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
    assert.equal(staged.engines.node, NODE_RUNTIME_RANGE);
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

void test('local and release Node gates accept patched lines and reject affected 26.x', async () => {
  const accepted = ['24.22.1', '24.23.0', '26.12.1', '26.13.4', '27.0.0', 'v24.22.1'];
  const rejected = [
    '24.22.0', '24.21.0', '24.19.0', '24.15.0', '24.14.1',
    '26.12.0', '26.11.0', '26.0.0', '25.0.0', '25.9.1',
    '22.23.4', '23.11.0', '24.22.1-rc.1', '26.12.1-rc.0', '27.0.0-rc.1',
  ];
  for (const version of accepted) {
    assert.equal(nodeRuntimeAccepted(version), true, version);
    assert.equal(nodeRuntimeRejection(version), null, version);
  }
  for (const version of rejected) {
    assert.equal(nodeRuntimeAccepted(version), false, version);
    assert.match(nodeRuntimeRejection(version) ?? '', new RegExp(`current ${version.replaceAll('.', '\\.')}`));
  }

  const build = await read('apps/kimi-code/scripts/native/build.mjs');
  const check = build.indexOf('nodeRuntimeRejection(process.versions.node)');
  const bundle = build.indexOf('await runBundleStep()');
  assert.ok(check >= 0 && bundle >= 0 && check < bundle);
  assert.match(build, /default: 'local'/);
  assert.equal(await read('.nvmrc'), '24.22.1\n');
  assert.equal(NODE_RUNTIME_RANGE, '>=24.22.1 <25 || >=26.12.1');

  const manifests = [
    'package.json',
    'apps/kimi-code/package.json',
    'packages/auth-native/package.json',
    'packages/pi-tui/package.json',
  ];
  for (const manifest of manifests) {
    assert.equal(JSON.parse(await read(manifest)).engines.node, NODE_RUNTIME_RANGE, manifest);
  }

  const flake = await read('flake.nix');
  assert.match(flake, /minNodeVersion = "24\.22\.1"/);
  assert.match(flake, /node-v24\.22\.1\.tar\.xz/);
  assert.match(flake, /sha256-T1N5eWKAza6wwvNY\/QS2oWzE\+336g7WoyRqdljtDUjE=/);
  assert.match(flake, /packaged\.overrideAttrs/);
  assert.match(flake, /pkgs\.nodejs_24/);
  assert.match(flake, /configureFlags = lib\.filter/);
  assert.match(flake, /flag != "--shared-libuv"/);
  assert.match(flake, /lib\.strings\.hasPrefix "--shared-libuv-libpath="/);
  assert.match(flake, /flag != "--shared-sqlite"/);
  assert.match(flake, /lib\.strings\.hasPrefix "--shared-sqlite-libpath="/);
  assert.match(flake, /input != pkgs\.libuv/);
  assert.match(flake, /input != pkgs\.sqlite/);
  assert.match(flake, /lib\.getDev pkgs\.sqlite/);
  assert.match(flake, /postInstall = lib\.replaceStrings/);

  const nixWorkflow = await read('.github/workflows/nix-build.yml');
  assert.match(nixWorkflow, /nix_path: nixpkgs=channel:nixos-unstable/);
  assert.doesNotMatch(nixWorkflow, /nix-path:/);
});

void test('Nix cache keys and stages preserve the verified Node boundary', async () => {
  const flake = await read('flake.nix');
  const workflow = await read('.github/workflows/nix-build.yml');
  const actionCommit = '7df957e333c1e5da7721f60227dbba6d06080569';

  assert.match(flake, /ci-nodejs = nodejs;/);
  assert.match(flake, /pnpm --filter=@kiki\/plugin-sdk run build/);
  assert.match(workflow, /pull_request:\r?\n\s+branches:\r?\n\s+- main\r?\n\s+- kiki/);
  assert.match(workflow, /push:\r?\n\s+branches:\r?\n\s+- main\r?\n\s+- kiki/);
  assert.match(workflow, /NIX_STORE_COMPAT_EPOCH: 1/);
  assert.match(workflow, /DRV_PATH="\$\(nix eval --raw "\.#packages\.\$\{SYSTEM\}\.ci-nodejs\.drvPath"\)"/);
  assert.match(workflow, /DRV_IDENTITY="\$\(basename "\$DRV_PATH"\)"/);
  assert.match(workflow, /CACHE_KEY="nix-node-v1-\$\{SYSTEM\}-\$\{NIX_STORE_COMPAT_EPOCH\}-\$\{DRV_IDENTITY\}"/);

  const restore = workflow.indexOf(`nix-community/cache-nix-action/restore@${actionCommit}`);
  const nodeBuild = workflow.indexOf("nix build '.#ci-nodejs^*' --print-build-logs");
  const saveStep = workflow.indexOf('- name: Save verified Node store cache');
  const save = workflow.indexOf(`nix-community/cache-nix-action/save@${actionCommit}`);
  const appBuild = workflow.indexOf('nix build .#kiki --print-build-logs');
  assert.ok(restore >= 0 && restore < nodeBuild && nodeBuild < saveStep && saveStep < save && save < appBuild);

  const restoreBlock = workflow.slice(restore, nodeBuild);
  assert.match(restoreBlock, /primary-key: \$\{\{ steps\.node\.outputs\.cache-key \}\}/);
  assert.match(restoreBlock, /save: false/);
  assert.doesNotMatch(restoreBlock, /restore-prefixes/);
  assert.doesNotMatch(restoreBlock, /paths:/);
  assert.match(workflow, /cold_node_cache/);
  assert.match(workflow, /Reject an unsafe cache restore/);
  assert.match(workflow, /partially restored store/);

  const verifiedNodeBlock = workflow.slice(nodeBuild, save);
  assert.match(verifiedNodeBlock, /nix-store --query --outputs/);
  assert.match(verifiedNodeBlock, /--add-root/);
  assert.match(verifiedNodeBlock, /nix path-info --json --recursive/);
  assert.match(verifiedNodeBlock, /store bytes before save/);
  assert.doesNotMatch(verifiedNodeBlock, /--no-check|doCheck\s*=\s*false/);

  const saveBlock = workflow.slice(saveStep, appBuild);
  assert.match(saveBlock, /steps\.restore-node-cache\.outputs\.hit-primary-key != 'true'/);
  assert.match(saveBlock, /env\.TRUSTED_CACHE_WRITE == 'true'/);
  assert.match(saveBlock, /continue-on-error: true/);
  assert.match(saveBlock, /gc-max-store-size-linux: 3G/);
  assert.match(saveBlock, /store bytes after save GC/);
  assert.match(saveBlock, /reported cache bytes/);
  assert.doesNotMatch(saveBlock, /restore-prefixes|purge: true|pnpmDeps|\/home\//);
  assert.match(workflow, /github\.event_name == 'push'.*github\.event\.repository\.default_branch/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'.*inputs\.trusted_cache_write/);
  assert.match(workflow, /\.\/result\/bin\/kiki --version/);

  const cacheKey = ({ system, epoch, drvPath }) =>
    `nix-node-v1-${system}-${epoch}-${drvPath.split('/').at(-1)}`;
  const baseline = cacheKey({
    system: 'x86_64-linux', epoch: 1, drvPath: '/nix/store/aaaaaaaa-nodejs-24.22.1.drv',
  });
  assert.equal(
    baseline,
    cacheKey({ system: 'x86_64-linux', epoch: 1, drvPath: '/nix/store/aaaaaaaa-nodejs-24.22.1.drv' }),
  );
  assert.notEqual(
    baseline,
    cacheKey({ system: 'x86_64-linux', epoch: 1, drvPath: '/nix/store/bbbbbbbb-nodejs-24.22.1.drv' }),
  );
  assert.notEqual(
    baseline,
    cacheKey({ system: 'aarch64-linux', epoch: 1, drvPath: '/nix/store/aaaaaaaa-nodejs-24.22.1.drv' }),
  );
  assert.notEqual(
    baseline,
    cacheKey({ system: 'x86_64-linux', epoch: 2, drvPath: '/nix/store/aaaaaaaa-nodejs-24.22.1.drv' }),
  );
});

void test('Nix prepares the host PTY offline before collecting native assets', async () => {
  const flake = await read('flake.nix');
  const buildInputs = flake.slice(flake.indexOf('nativeBuildInputs = ['), flake.indexOf('dontStrip = true;'));
  assert.match(buildInputs, /pkgs\.python3/);
  assert.match(flake, /export npm_config_nodedir=\$\{nodejs\}/);
  assert.match(flake, /export npm_config_python=\$\{pkgs\.python3\}\/bin\/python3/);
  assert.match(flake, /export npm_config_build_from_source=true/);
  assert.ok(flake.includes('printf \'["node-pty"]\\n\' > "$TMPDIR/kiki-native-build-allowlist.json"'));
  const rebuild = flake.indexOf('pnpm --config.onlyBuiltDependenciesFile="$TMPDIR/kiki-native-build-allowlist.json" --filter @kiki/agent-core-v2 rebuild node-pty');
  const load = flake.indexOf('pnpm --filter @kiki/agent-core-v2 exec node -e \'require("node-pty")\'');
  const sdk = flake.indexOf('pnpm --filter=@kiki/plugin-sdk run build');
  const sea = flake.indexOf('pnpm --filter=@kiki/cli run build:native:sea');
  assert.ok(rebuild >= 0 && rebuild < load && load < sdk && sdk < sea);
});

void test('Nix application build failure cannot be hidden by a stale successful result', async (t) => {
  const workflow = await read('.github/workflows/nix-build.yml');
  const buildStep = workflow.indexOf('      - name: Build\n');
  const runBody = workflow.indexOf('        run: |\n', buildStep) + '        run: |\n'.length;
  const nextStep = workflow.indexOf('\n      - name:', runBody);
  assert.ok(buildStep >= 0 && runBody > buildStep && nextStep > runBody);
  const buildScript = workflow.slice(runBody, nextStep).split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');

  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/nix-build-shell-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, 'fake-bin');
  const resultBin = join(scratch, 'result/bin');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(resultBin, { recursive: true });
  const fakeNix = join(fakeBin, 'nix');
  const staleKiki = join(resultBin, 'kiki');
  await writeFile(fakeNix, '#!/usr/bin/env bash\nprintf "fake nix\\n"\nexit "$FAKE_NIX_EXIT"\n');
  await writeFile(staleKiki, '#!/usr/bin/env bash\nprintf "smoke\\n" >> "$PWD/smoke-marker"\n');
  await chmod(fakeNix, 0o755);
  await chmod(staleKiki, 0o755);

  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' : 'bash';
  const harness = `export PATH="$PWD/fake-bin:$PATH"\nexport GITHUB_OUTPUT="$PWD/github-output"\n${buildScript}`;
  const execute = async (nixExit) => {
    await rm(join(scratch, 'github-output'), { force: true });
    await rm(join(scratch, 'smoke-marker'), { force: true });
    const result = spawnSync(bash, ['-c', harness], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, FAKE_NIX_EXIT: String(nixExit) },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return readFile(join(scratch, 'github-output'), 'utf8');
  };

  assert.match(await execute(1), /^BUILD_FAILED=true$/m);
  await assert.rejects(readFile(join(scratch, 'smoke-marker')), /ENOENT/);
  assert.match(await execute(0), /^BUILD_FAILED=false$/m);
  assert.equal(await readFile(join(scratch, 'smoke-marker'), 'utf8'), 'smoke\n');
});

void test('release upload reuses exact draft assets and refuses unsafe public mutations', async (t) => {
  const workflow = await read('.github/workflows/kiki-desktop-release.yml');
  const uploadStep = workflow.indexOf('      - name: Upload draft assets without replacement');
  const runMarker = '        run: |\n';
  const runStart = workflow.indexOf(runMarker, uploadStep);
  const nextStep = workflow.indexOf('\n      - name:', runStart);
  assert.ok(uploadStep >= 0 && runStart > uploadStep && nextStep > runStart);
  const uploadScript = workflow.slice(runStart + runMarker.length, nextStep).split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');

  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/release-upload-shell-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, 'fake-bin');
  const candidate = join(scratch, 'release-candidate');
  const notices = join(scratch, 'apps/kiki-gui');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(candidate, { recursive: true });
  await mkdir(notices, { recursive: true });

  const installer = 'Kiki-1.2.3-setup.exe';
  const localAssets = {
    [installer]: 'installer bytes\n',
    [`${installer}.sig`]: 'signature bytes\n',
    [`${installer}.sha256`]: 'checksum bytes\n',
    'latest.json': '{"version":"1.2.3"}\n',
    'THIRD_PARTY_NOTICES.md': 'third-party notices\n',
  };
  for (const [name, contents] of Object.entries(localAssets)) {
    const destination = name === 'THIRD_PARTY_NOTICES.md' ? join(notices, name) : join(candidate, name);
    await writeFile(destination, contents);
  }

  const fakeGh = join(fakeBin, 'gh');
  await writeFile(fakeGh, String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != release ]]; then
  echo "unexpected gh command: $*" >&2
  exit 2
fi
case "$2" in
  view)
    if [[ "$*" == *"--json assets"* ]]; then
      shopt -s nullglob
      for path in "$FAKE_GH_REMOTE"/*; do
        if [[ -f "$path" ]]; then basename "$path"; fi
      done | sort
      exit 0
    fi
    if [[ "$*" == *"--json isDraft"* ]]; then
      printf '%s\n' "$FAKE_GH_DRAFT"
      exit 0
    fi
    echo "unexpected gh release view arguments: $*" >&2
    exit 2
    ;;
  download)
    shift 2
    shift
    pattern=''
    directory=''
    while (($#)); do
      case "$1" in
        --pattern)
          pattern="$2"
          shift 2
          ;;
        --dir)
          directory="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    printf '%s\n' "$pattern" >> "$FAKE_GH_DOWNLOAD_LOG"
    mkdir -p "$directory"
    cp "$FAKE_GH_REMOTE/$pattern" "$directory/$pattern"
    ;;
  upload)
    shift 2
    shift
    asset="$1"
    printf '%s\n' "$(basename "$asset")" >> "$FAKE_GH_UPLOAD_LOG"
    ;;
  *)
    echo "unexpected gh release subcommand: $*" >&2
    exit 2
    ;;
esac
`);
  await chmod(fakeGh, 0o755);

  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' : 'bash';
  const harness = `export PATH="$PWD/fake-bin:$PATH"\n${uploadScript}`;
  const tag = 'kiki-v1.2.3';
  const lines = (contents) => contents.trim() === '' ? [] : contents.trim().split(/\r?\n/);
  const execute = async ({ label, draft, remoteAssets }) => {
    const remote = join(scratch, `remote-${label}`);
    const runnerTemp = join(scratch, `runner-temp-${label}`);
    const uploadLog = join(scratch, `uploads-${label}`);
    const downloadLog = join(scratch, `downloads-${label}`);
    await mkdir(remote, { recursive: true });
    await mkdir(runnerTemp, { recursive: true });
    for (const [name, contents] of Object.entries(remoteAssets)) {
      await writeFile(join(remote, name), contents);
    }
    await writeFile(uploadLog, '');
    await writeFile(downloadLog, '');
    const result = spawnSync(bash, ['-c', harness], {
      cwd: scratch,
      encoding: 'utf8',
      env: {
        ...process.env,
        KIKI_TAG: tag,
        RUNNER_TEMP: runnerTemp,
        FAKE_GH_REMOTE: remote,
        FAKE_GH_DRAFT: draft,
        FAKE_GH_UPLOAD_LOG: uploadLog,
        FAKE_GH_DOWNLOAD_LOG: downloadLog,
      },
    });
    return {
      result,
      uploads: lines(await readFile(uploadLog, 'utf8')),
      downloads: lines(await readFile(downloadLog, 'utf8')),
      output: `${result.stdout}\n${result.stderr}`,
    };
  };

  const draftReuse = await execute({
    label: 'draft-reuse', draft: 'true', remoteAssets: { ...localAssets },
  });
  assert.equal(draftReuse.result.status, 0, draftReuse.output);
  assert.deepEqual(draftReuse.downloads, Object.keys(localAssets));
  assert.deepEqual(draftReuse.uploads, []);

  const draftMissingAssets = { ...localAssets };
  delete draftMissingAssets['latest.json'];
  const draftMissing = await execute({
    label: 'draft-missing', draft: 'true', remoteAssets: draftMissingAssets,
  });
  assert.equal(draftMissing.result.status, 0, draftMissing.output);
  assert.deepEqual(draftMissing.downloads, [installer, `${installer}.sig`, `${installer}.sha256`, 'THIRD_PARTY_NOTICES.md']);
  assert.deepEqual(draftMissing.uploads, ['latest.json']);

  const differentAssets = { ...localAssets, [`${installer}.sig`]: 'different signature bytes\n' };
  const different = await execute({
    label: 'draft-different', draft: 'true', remoteAssets: differentAssets,
  });
  assert.notEqual(different.result.status, 0, different.output);
  assert.match(different.output, /Existing release asset differs: Kiki-1\.2\.3-setup\.exe\.sig/);
  assert.deepEqual(different.downloads, [installer, `${installer}.sig`]);
  assert.deepEqual(different.uploads, []);

  const publicMissingAssets = { ...localAssets };
  delete publicMissingAssets[installer];
  const publicMissing = await execute({
    label: 'public-missing', draft: 'false', remoteAssets: publicMissingAssets,
  });
  assert.notEqual(publicMissing.result.status, 0, publicMissing.output);
  assert.match(publicMissing.output, /Published release is missing asset; refusing to mutate public assets/);
  assert.deepEqual(publicMissing.downloads, []);
  assert.deepEqual(publicMissing.uploads, []);
});

function extractBashStep(workflow, stepName) {
  const stepMarker = `      - name: ${stepName}`;
  const stepStart = workflow.indexOf(stepMarker);
  assert.ok(stepStart >= 0, `Missing workflow step: ${stepName}`);
  const runMarker = '        run: |\n';
  const runStart = workflow.indexOf(runMarker, stepStart);
  const nextStep = workflow.indexOf('\n      - name:', runStart + runMarker.length);
  assert.ok(runStart > stepStart, `Missing run body: ${stepName}`);
  const end = nextStep >= 0 ? nextStep : workflow.length;
  return workflow.slice(runStart + runMarker.length, end).split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

function shellQuote(path) {
  const normalized = path.replaceAll('\\', '/');
  return `'${normalized.replaceAll("'", "'\\''")}'`;
}

function withAbsoluteReceiptSource(script) {
  const source = join(root, 'apps/kimi-code/scripts/native/release-receipt.mjs');
  const invocation = /node (?:\.\/)?apps\/kimi-code\/scripts\/native\/release-receipt\.mjs/g;
  assert.ok(invocation.test(script), 'release step must invoke the receipt script');
  return script.replace(invocation, `node ${shellQuote(source)}`);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectProcess);
    child.once('close', (status, signal) => resolveProcess({ status, signal, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
}

void test('release artifact selection executes real gh pagination and aggregates one artifact response', async (t) => {
  const workflow = await read('.github/workflows/kiki-desktop-release.yml');
  const sourceScript = extractBashStep(workflow, 'Select one target artifact per platform');
  const endpointPattern = /gh api --paginate --slurp\s+(['"])([^'"]+)\1/;
  const endpointMatch = sourceScript.match(endpointPattern);
  assert.ok(endpointMatch, 'target selection must use gh api --paginate --slurp');
  assert.doesNotMatch(sourceScript, /gh api --paginate --slurp[^\n]*--jq/);

  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/release-gh-pagination-test-'));
  let server;
  t.after(async () => {
    if (server !== undefined) await closeServer(server);
    await rm(scratch, { recursive: true, force: true });
  });
  const runnerTemp = join(scratch, 'runner-temp');
  const ghConfig = join(scratch, 'gh-config');
  const githubOutput = join(scratch, 'github-output');
  await mkdir(runnerTemp, { recursive: true });
  await mkdir(ghConfig, { recursive: true });
  await writeFile(githubOutput, '');

  const gh = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const ghVersionEnv = {
    ...process.env,
    GH_CONFIG_DIR: ghConfig,
    GH_TOKEN: 'offline-fake-token',
    GITHUB_TOKEN: 'offline-fake-token',
    GH_PROMPT_DISABLED: '1',
    NO_PROXY: '*',
    no_proxy: '*',
  };
  for (const key of ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO']) delete ghVersionEnv[key];
  const ghVersion = await runProcess(gh, ['--version'], { cwd: scratch, env: ghVersionEnv });
  assert.equal(ghVersion.status, 0, `${ghVersion.stdout}\n${ghVersion.stderr}`);
  assert.match(ghVersion.stdout, /^gh version \d+\.\d+\.\d+/);

  const runId = '4242';
  const firstPage = [
    { id: 101, name: `kiki-release-target-${runId}-linux-x64-2`, expired: false },
    { id: 102, name: `kiki-release-target-${runId}-linux-arm64-2`, expired: false },
    { id: 103, name: `kiki-release-target-${runId}-darwin-x64-2`, expired: false },
    { id: 104, name: `kiki-release-target-${runId}-darwin-arm64-2`, expired: false },
  ];
  const secondPage = [
    { id: 205, name: `kiki-release-target-${runId}-win32-x64-2`, expired: false },
    { id: 206, name: `kiki-release-target-${runId}-win32-arm64-2`, expired: false },
    { id: 307, name: `kiki-release-target-${runId}-linux-x64-3`, expired: false },
  ];
  const requests = [];
  server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const parsed = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const page = parsed.searchParams.get('page');
    response.setHeader('content-type', 'application/json');
    if (page === null || page === '1') {
      const next = `http://127.0.0.1:${server.address().port}${parsed.pathname}?page=2`;
      response.setHeader('link', `<${next}>; rel="next"`);
      response.end(JSON.stringify({ artifacts: firstPage }));
      return;
    }
    if (page === '2') {
      response.end(JSON.stringify({ artifacts: secondPage }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'unexpected page' }));
  });
  await listen(server);
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/repos/example/kiki/actions/runs/${runId}/artifacts?per_page=100`;
  const endpointScript = sourceScript.replace(endpointMatch[0], endpointMatch[0].replace(endpointMatch[2], endpoint));
  const script = withAbsoluteReceiptSource(endpointScript);
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' : 'bash';
  const ghEnv = {
    ...process.env,
    GH_CONFIG_DIR: ghConfig,
    GH_TOKEN: 'offline-fake-token',
    GITHUB_TOKEN: 'offline-fake-token',
    GH_PROMPT_DISABLED: '1',
    NO_PROXY: '*',
    no_proxy: '*',
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: githubOutput,
    GITHUB_REPOSITORY: 'example/kiki',
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '3',
  };
  for (const key of ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO']) delete ghEnv[key];
  const result = await runProcess(bash, ['-c', script], { cwd: scratch, env: ghEnv });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(requests.length, 2, `expected two paginated requests, got ${JSON.stringify(requests)}`);
  assert.match(requests[0], /per_page=100/);
  assert.match(requests[1], /page=2/);

  const api = JSON.parse(await readFile(join(runnerTemp, 'target-artifacts.json'), 'utf8'));
  assert.deepEqual(Object.keys(api), ['artifacts']);
  assert.deepEqual(api, { artifacts: [...firstPage, ...secondPage] });
  assert.equal(
    await readFile(githubOutput, 'utf8'),
    'artifact-ids=307,102,103,104,205,206\n',
  );
});

void test('publish npm step preserves query results and delegates publication decisions offline', async (t) => {
  const workflow = await read('.github/workflows/kiki-desktop-release.yml');
  const sourceScript = extractBashStep(workflow, 'Publish npm CLI/TUI and desktop distributions');
  assert.match(sourceScript, /npm-publication-action/);
  for (const option of ['--query-json', '--query-stderr', '--query-status', '--expected-integrity', '--package']) {
    assert.ok(sourceScript.includes(option), `Missing ${option} in npm publication action`);
  }
  const script = withAbsoluteReceiptSource(sourceScript);
  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/release-npm-publication-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, 'fake-bin');
  const npmRoot = join(scratch, 'apps/kimi-code/dist-npm');
  await mkdir(fakeBin, { recursive: true });
  for (const [kind, name] of [['lite', 'kiki-agent-lite'], ['full', 'kiki-agent']]) {
    const packageRoot = join(npmRoot, kind);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  }
  const fakeNpm = join(fakeBin, 'npm');
  await writeFile(fakeNpm, String.raw`#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pack)
    case "$2" in
      */lite|*\\lite) printf '[{"integrity":"%s"}]\n' "$FAKE_NPM_PACK_LITE" ;;
      */full|*\\full) printf '[{"integrity":"%s"}]\n' "$FAKE_NPM_PACK_FULL" ;;
      *) echo "unexpected npm pack path: $2" >&2; exit 2 ;;
    esac
    ;;
  view)
    case "$2" in
      kiki-agent-lite@*) status="$FAKE_NPM_VIEW_LITE_STATUS"; stdout="$FAKE_NPM_VIEW_LITE_STDOUT"; stderr="$FAKE_NPM_VIEW_LITE_STDERR" ;;
      kiki-agent@*) status="$FAKE_NPM_VIEW_FULL_STATUS"; stdout="$FAKE_NPM_VIEW_FULL_STDOUT"; stderr="$FAKE_NPM_VIEW_FULL_STDERR" ;;
      *) echo "unexpected npm view package: $2" >&2; exit 2 ;;
    esac
    printf '%s\n' "$stdout"
    if [[ -n "$stderr" ]]; then printf '%s\n' "$stderr" >&2; fi
    exit "$status"
    ;;
  publish)
    printf '%s\n' "$2" >> "$FAKE_NPM_PUBLISH_MARKER"
    ;;
  *)
    echo "unexpected npm command: $*" >&2
    exit 2
    ;;
esac
`);
  await chmod(fakeNpm, 0o755);

  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' : 'bash';
  const harness = `export PATH="$PWD/fake-bin:$PATH"\n${script}\n`;
  const litePackage = 'apps/kimi-code/dist-npm/lite';
  const fullPackage = 'apps/kimi-code/dist-npm/full';
  const liteIntegrity = 'sha512-lite-integrity';
  const fullIntegrity = 'sha512-full-integrity';
  const execute = async ({ label, lite, full }) => {
    const runnerTemp = join(scratch, `runner-temp-${label}`);
    const marker = join(scratch, `publish-${label}.marker`);
    await mkdir(runnerTemp, { recursive: true });
    await writeFile(marker, '');
    const result = await runProcess(bash, ['-c', harness], {
      cwd: scratch,
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: 'offline-npm-token',
        KIKI_VERSION: '1.2.3',
        RUNNER_TEMP: runnerTemp,
        FAKE_NPM_PACK_LITE: liteIntegrity,
        FAKE_NPM_PACK_FULL: fullIntegrity,
        FAKE_NPM_VIEW_LITE_STATUS: String(lite.status),
        FAKE_NPM_VIEW_LITE_STDOUT: lite.stdout,
        FAKE_NPM_VIEW_LITE_STDERR: lite.stderr,
        FAKE_NPM_VIEW_FULL_STATUS: String(full.status),
        FAKE_NPM_VIEW_FULL_STDOUT: full.stdout,
        FAKE_NPM_VIEW_FULL_STDERR: full.stderr,
        FAKE_NPM_PUBLISH_MARKER: marker,
      },
    });
    const contents = await readFile(marker, 'utf8');
    return {
      result,
      published: contents.trim() === '' ? [] : contents.trim().split(/\r?\n/),
      output: `${result.stdout}\n${result.stderr}`,
    };
  };

  const firstPublish = await execute({
    label: 'first-publish',
    lite: { status: 1, stdout: '{"error":{"code":"E404","summary":"Not found"}}', stderr: '' },
    full: { status: 1, stdout: '{"error":{"code":"E404","summary":"Not found"}}', stderr: '' },
  });
  assert.equal(firstPublish.result.status, 0, firstPublish.output);
  assert.deepEqual(firstPublish.published, [litePackage, fullPackage]);

  const same = await execute({
    label: 'same-reuse',
    lite: { status: 0, stdout: JSON.stringify(liteIntegrity), stderr: '' },
    full: { status: 0, stdout: JSON.stringify(fullIntegrity), stderr: '' },
  });
  assert.equal(same.result.status, 0, same.output);
  assert.deepEqual(same.published, []);

  const emptyResponse = await execute({
    label: 'empty-response-reject',
    lite: { status: 0, stdout: '{}', stderr: '' },
    full: { status: 0, stdout: JSON.stringify(fullIntegrity), stderr: '' },
  });
  assert.notEqual(emptyResponse.result.status, 0, emptyResponse.output);
  assert.deepEqual(emptyResponse.published, []);
  assert.match(emptyResponse.output, /valid integrity/);

  const different = await execute({
    label: 'different-reject',
    lite: { status: 0, stdout: JSON.stringify('sha512-different'), stderr: '' },
    full: { status: 0, stdout: JSON.stringify(fullIntegrity), stderr: '' },
  });
  assert.notEqual(different.result.status, 0, different.output);
  assert.deepEqual(different.published, []);
  assert.match(different.output, /Published npm package differs: kiki-agent-lite/);

  const unauthorized = await execute({
    label: 'e401-reject',
    lite: { status: 1, stdout: '{"error":{"code":"E401","summary":"Unauthorized"}}', stderr: 'E401 credentials invalid' },
    full: { status: 1, stdout: '{"error":{"code":"E401","summary":"Unauthorized"}}', stderr: 'E401 credentials invalid' },
  });
  assert.notEqual(unauthorized.result.status, 0, unauthorized.output);
  assert.deepEqual(unauthorized.published, []);
  assert.match(unauthorized.output, /E401 credentials invalid/);

  const network = await execute({
    label: 'network-reject',
    lite: { status: 1, stdout: '{"error":{"code":"EAI_AGAIN","summary":"Temporary failure"}}', stderr: 'registry network unavailable' },
    full: { status: 1, stdout: '{"error":{"code":"EAI_AGAIN","summary":"Temporary failure"}}', stderr: 'registry network unavailable' },
  });
  assert.notEqual(network.result.status, 0, network.output);
  assert.deepEqual(network.published, []);
  assert.match(network.output, /registry network unavailable/);

  const invalidResponse = await execute({
    label: 'invalid-response-reject',
    lite: { status: 1, stdout: 'not-json', stderr: 'registry response was not JSON' },
    full: { status: 1, stdout: JSON.stringify(fullIntegrity), stderr: '' },
  });
  assert.notEqual(invalidResponse.result.status, 0, invalidResponse.output);
  assert.deepEqual(invalidResponse.published, []);
  assert.match(invalidResponse.output, /registry response was not JSON/);
});
