import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseLocalBuildArgs, runLocalDesktopBuild, runPnpmStep } from './desktop-build-local.mjs';
import {
  assertReadonlyGitArgs,
  createBuildReceipt,
  createReceiptForCandidate,
  defaultCandidateRoot,
  execGitReadonly,
  pnpmCommand,
  receiptPathFor,
  writeReceiptAtomic,
} from './desktop-build-source.mjs';
import {
  createSidecarManifest,
  parseRustHost,
  parseTargetArg,
  sidecarFileName,
} from './prepare-sidecar.mjs';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const tempBase = join(repoRoot, '.tmp', 'desktop-build-source-tests');
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const ACCEPTANCE = 'tasks/task-0027-kiki/prd.md';
const CHECK = 'fixture://desktop-checks';
const OUTER_TARGET_TRIPLE = 'aarch64-pc-windows-msvc';

mkdirSync(tempBase, { recursive: true });

function makeTemp() {
  return mkdtempSync(join(tempBase, 'case-'));
}

function layout(root) {
  const buildTree = join(root, 'build');
  const candidate = defaultCandidateRoot(buildTree);
  mkdirSync(candidate, { recursive: true });
  return { buildTree, candidate };
}

function fakeGit({
  headForRead = () => COMMIT,
  tree = TREE,
  attached = false,
  porcelainForRead = () => '',
} = {}) {
  const calls = [];
  let headReads = 0;
  let statusReads = 0;
  const git = async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      headReads += 1;
      return { code: 0, stdout: `${headForRead(headReads)}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
      return { code: 0, stdout: `${tree}\n`, stderr: '' };
    }
    if (args[0] === 'symbolic-ref') {
      return attached
        ? { code: 0, stdout: 'refs/heads/kiki\n', stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'status') {
      statusReads += 1;
      return { code: 0, stdout: porcelainForRead(statusReads), stderr: '' };
    }
    return { code: 99, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { git, calls };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hostSeaTarget() {
  return `${process.platform}-${process.arch}`;
}

function seaExecutableName() {
  return process.platform === 'win32' ? 'kiki.exe' : 'kiki';
}

function treeSeaPath(buildTree, target = hostSeaTarget()) {
  return join(buildTree, 'apps', 'kimi-code', 'dist-native', 'bin', target, seaExecutableName());
}

function hostTarget() {
  return parseRustHost(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }));
}

function replaceTemporaryFiles(directory) {
  return readdirSync(directory).filter((name) => name.endsWith('.tmp'));
}

/**
 * Node 24.15 shim staged beside the workspace; the native SEA build rejects older
 * Node, and COREPACK_ENABLE_NETWORK=0 keeps the probe offline.
 */
const pnpmProbeShimRoot = process.env.KIKI_NODE_SHIM_ROOT
  ?? resolve(repoRoot, '..', '..', '.tmp', 'node2415');

function pnpmProbeEnv() {
  const nodeDirectory = join(pnpmProbeShimRoot, 'node-v24.15.0-win-x64');
  if (!existsSync(join(nodeDirectory, 'node.exe'))) return undefined;
  const path = [nodeDirectory, join(pnpmProbeShimRoot, 'shims'), process.env.PATH]
    .filter(Boolean)
    .join(';');
  return { ...process.env, PATH: path, COREPACK_ENABLE_NETWORK: '0' };
}

const pnpmProbe = process.platform === 'win32' ? pnpmProbeEnv() : undefined;
const pnpmProbeSkip = process.platform !== 'win32'
  ? 'the runner spawns the Windows pnpm.cmd'
  : pnpmProbe === undefined
    ? `no Node 24.15 shim under ${pnpmProbeShimRoot}`
    : false;
const replaceFailureSkip = process.platform === 'win32'
  ? false
  : 'a read-only destination blocks the replace on Windows only';

test('writes a receipt only after sea, sidecar, and desktop artifacts', async () => {
  const root = makeTemp();
  try {
    const { buildTree, candidate } = layout(root);
    const { git, calls } = fakeGit();
    const steps = [];
    const seaPath = treeSeaPath(buildTree);
    const binaries = join(buildTree, 'apps', 'kiki-gui', 'src-tauri', 'binaries');
    const result = await runLocalDesktopBuild({
      buildTree,
      sourceCommit: COMMIT,
      acceptanceRef: ACCEPTANCE,
      checkRef: CHECK,
      env: {
        KIKI_BUILD_SHA: OTHER,
        KIKI_DESKTOP_BUNDLED: '1',
        KIKI_SIDECAR_SOURCE: join(root, 'outer', 'sea', 'kiki.exe'),
        KIKI_BUILD_TARGET: 'linux-x64',
        TAURI_TARGET_TRIPLE: OUTER_TARGET_TRIPLE,
        CARGO_TARGET_DIR: join(root, 'outer', 'cargo-target'),
        PATH: 'C:\\Windows',
      },
      git,
      runner: async (step) => {
        steps.push(step);
        if (step.id === 'sea') {
          mkdirSync(dirname(seaPath), { recursive: true });
          writeFileSync(seaPath, 'sea-bytes');
          return;
        }
        if (step.id === 'sidecar') {
          mkdirSync(binaries, { recursive: true });
          copyFileSync(seaPath, join(binaries, sidecarFileName(hostTarget())));
          return;
        }
        writeFileSync(join(candidate, 'kiki-desktop.exe'), 'desktop-bytes');
        copyFileSync(seaPath, join(candidate, 'kiki-server.exe'));
      },
    });
    assert.deepEqual(steps.map((step) => step.id), ['sea', 'sidecar', 'desktop-artifacts']);
    assert.deepEqual(steps.map((step) => step.args), [
      ['--filter', '@kiki/cli', 'run', 'build:native:sea'],
      ['--filter', '@kiki/gui', 'run', 'desktop:prepare'],
      ['--filter', '@kiki/gui', 'run', 'desktop:build:artifacts'],
    ]);
    for (const step of steps) {
      assert.equal(step.cwd, buildTree);
      assert.equal(step.env.KIKI_BUILD_SHA, COMMIT);
      assert.equal(Object.hasOwn(step.env, 'KIKI_DESKTOP_BUNDLED'), false);
      assert.equal(Object.hasOwn(step.env, 'TAURI_TARGET_TRIPLE'), false);
      assert.equal(Object.hasOwn(step.env, 'CARGO_TARGET_DIR'), false);
      assert.equal(step.env.KIKI_BUILD_TARGET, hostSeaTarget());
      assert.equal(step.env.KIKI_SIDECAR_SOURCE, treeSeaPath(buildTree));
    }
    assert.ok(calls.every((call) => call.cwd === buildTree));
    assert.deepEqual(calls.filter((call) => call.args[0] === 'status').length, 2);
    const desktopPath = join(candidate, 'kiki-desktop.exe');
    const serverPath = join(candidate, 'kiki-server.exe');
    assert.deepEqual(result.receipt, {
      schemaVersion: 1,
      sourceCommit: COMMIT,
      acceptanceRef: ACCEPTANCE,
      checkRef: CHECK,
      files: {
        'kiki-desktop.exe': { sha256: sha256(desktopPath), bytes: statSync(desktopPath).size },
        'kiki-server.exe': { sha256: sha256(serverPath), bytes: statSync(serverPath).size },
      },
    });
    assert.equal(result.path, receiptPathFor(candidate));
    assert.deepEqual(JSON.parse(readFileSync(result.path, 'utf8')), result.receipt);
    assert.equal(Object.hasOwn(result.receipt, 'buildId'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a missing build tree before git or commands run', async () => {
  const root = makeTemp();
  try {
    const missing = join(root, 'missing-tree');
    let called = false;
    await assert.rejects(
      () => runLocalDesktopBuild({
        buildTree: missing,
        sourceCommit: COMMIT,
        acceptanceRef: ACCEPTANCE,
        checkRef: CHECK,
        git: async () => { throw new Error('git should not run'); },
        runner: async () => { called = true; },
      }),
      /Build tree does not exist/,
    );
    assert.equal(called, false);
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not run commands when the build tree is dirty, attached, or on another commit', async () => {
  const cases = [
    { git: fakeGit({ porcelainForRead: () => ' M README.md' }).git, pattern: /dirty/ },
    { git: fakeGit({ attached: true }).git, pattern: /detached/ },
    { git: fakeGit({ headForRead: () => OTHER }).git, pattern: /does not match/ },
  ];
  for (const entry of cases) {
    const root = makeTemp();
    try {
      const { buildTree, candidate } = layout(root);
      let called = false;
      await assert.rejects(
        () => runLocalDesktopBuild({
          buildTree,
          sourceCommit: COMMIT,
          acceptanceRef: ACCEPTANCE,
          checkRef: CHECK,
          git: entry.git,
          runner: async () => { called = true; },
        }),
        entry.pattern,
      );
      assert.equal(called, false);
      assert.equal(existsSync(receiptPathFor(candidate)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('leaves no receipt when a build step fails', async () => {
  const root = makeTemp();
  try {
    const { buildTree, candidate } = layout(root);
    const ids = [];
    await assert.rejects(
      () => runLocalDesktopBuild({
        buildTree,
        sourceCommit: COMMIT,
        acceptanceRef: ACCEPTANCE,
        checkRef: CHECK,
        git: fakeGit().git,
        runner: async (step) => {
          ids.push(step.id);
          if (step.id === 'sidecar') throw new Error('sidecar failed');
        },
      }),
      /sidecar failed/,
    );
    assert.deepEqual(ids, ['sea', 'sidecar']);
    assert.equal(existsSync(receiptPathFor(candidate)), false);
    assert.equal(existsSync(buildTree), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('leaves no new receipt when inputs change during the build', async () => {
  const root = makeTemp();
  try {
    const { buildTree, candidate } = layout(root);
    const receiptPath = receiptPathFor(candidate);
    writeFileSync(join(candidate, 'kiki-desktop.exe'), 'old-desktop');
    writeFileSync(join(candidate, 'kiki-server.exe'), 'old-server');
    writeFileSync(receiptPath, '{"schemaVersion":1,"planted":true}\n');
    await assert.rejects(
      () => runLocalDesktopBuild({
        buildTree,
        sourceCommit: COMMIT,
        acceptanceRef: ACCEPTANCE,
        checkRef: CHECK,
        git: fakeGit({
          porcelainForRead: (read) => (read === 1 ? '' : ' M apps/kiki-gui/src/App.tsx'),
        }).git,
        runner: async (step) => {
          if (step.id === 'desktop-artifacts') {
            writeFileSync(join(candidate, 'kiki-desktop.exe'), 'new-desktop');
          }
        },
      }),
      /Build inputs changed/,
    );
    assert.equal(readFileSync(receiptPath, 'utf8'), '{"schemaVersion":1,"planted":true}\n');
    await assert.rejects(
      () => runLocalDesktopBuild({
        buildTree,
        sourceCommit: COMMIT,
        acceptanceRef: ACCEPTANCE,
        checkRef: CHECK,
        git: fakeGit({ headForRead: (read) => (read === 1 ? COMMIT : OTHER) }).git,
        runner: async () => {},
      }),
      /Build inputs changed/,
    );
    assert.equal(readFileSync(receiptPath, 'utf8'), '{"schemaVersion":1,"planted":true}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not write a receipt when the artifact commands produce no exes', async () => {
  const root = makeTemp();
  try {
    const { buildTree, candidate } = layout(root);
    const seaPath = treeSeaPath(buildTree);
    const binaries = join(buildTree, 'apps', 'kiki-gui', 'src-tauri', 'binaries');
    await assert.rejects(
      () => runLocalDesktopBuild({
        buildTree,
        sourceCommit: COMMIT,
        acceptanceRef: ACCEPTANCE,
        checkRef: CHECK,
        git: fakeGit().git,
        runner: async (step) => {
          if (step.id === 'sea') {
            mkdirSync(dirname(seaPath), { recursive: true });
            writeFileSync(seaPath, 'sea-bytes');
          }
          if (step.id === 'sidecar') {
            mkdirSync(binaries, { recursive: true });
            copyFileSync(seaPath, join(binaries, sidecarFileName(hostTarget())));
          }
        },
      }),
      /Build artifact is missing/,
    );
    assert.equal(existsSync(receiptPathFor(candidate)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli accepts the build inputs and rejects stamp or retarget arguments', () => {
  assert.deepEqual(
    parseLocalBuildArgs([
      '--build-tree', 'D:\\tree',
      '--source-commit', COMMIT,
      '--acceptance-ref', ACCEPTANCE,
      '--check-ref', CHECK,
    ]),
    {
      buildTree: 'D:\\tree',
      sourceCommit: COMMIT,
      acceptanceRef: ACCEPTANCE,
      checkRef: CHECK,
    },
  );
  assert.throws(
    () => parseLocalBuildArgs([
      '--build-tree', 'D:\\tree',
      '--source-commit', COMMIT,
      '--acceptance-ref', ACCEPTANCE,
      '--check-ref', CHECK,
      '--stamp', 'old-exe',
    ]),
    /Unknown argument: --stamp/,
  );
  assert.throws(() => parseLocalBuildArgs(['--candidate-root', 'D:\\old']), /Unknown argument: --candidate-root/);
  assert.throws(() => parseLocalBuildArgs(['--build-tree', 'D:\\tree']), /--source-commit is required/);
});

test('readonly git allowlist rejects write commands before execution', async () => {
  assert.throws(() => assertReadonlyGitArgs(['add', 'file']), /Refusing to run git add/);
  assert.doesNotThrow(() => assertReadonlyGitArgs(['rev-parse', 'HEAD']));
  await assert.rejects(
    () => execGitReadonly(repoRoot, ['clean', '-fd']),
    /Refusing to run git clean/,
  );
});

test('readonly git rev-parse reads this worktree', async () => {
  const head = await execGitReadonly(repoRoot, ['rev-parse', 'HEAD']);
  const tree = await execGitReadonly(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  const symbolic = await execGitReadonly(repoRoot, ['symbolic-ref', '-q', 'HEAD']);
  assert.equal(head.code, 0);
  assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
  assert.equal(tree.code, 0);
  assert.match(tree.stdout.trim(), /^[0-9a-f]{40}$/);
  assert.ok(symbolic.code === 0 || symbolic.code === 1);
  if (symbolic.code === 0) assert.match(symbolic.stdout, /^refs\/heads\//);
});

/**
 * Runs the three build steps with a runner that mirrors how each consumer reads the
 * environment it is handed: build:native:sea writes this tree's SEA, desktop:prepare
 * resolves target and source as prepare-sidecar.mjs does (its default source for the
 * host target is this tree's own SEA), and tauri writes the exes into the candidate
 * root unless CARGO_TARGET_DIR moves them.
 */
async function runMirroredBuild({ buildTree, env, corrupt } = {}) {
  const seaBytes = 'this-build-sea-bytes';
  const seaPath = treeSeaPath(buildTree);
  const binaries = join(buildTree, 'apps', 'kiki-gui', 'src-tauri', 'binaries');
  const releaseDir = join(buildTree, 'apps', 'kiki-gui', 'src-tauri', 'target', 'release');
  const steps = [];
  let stagedSidecar;
  let manifest;
  const result = await runLocalDesktopBuild({
    buildTree,
    sourceCommit: COMMIT,
    acceptanceRef: ACCEPTANCE,
    checkRef: CHECK,
    env,
    git: fakeGit().git,
    runner: async (step) => {
      steps.push(step);
      if (step.id === 'sea') {
        if (corrupt === 'sea') return;
        const output = treeSeaPath(buildTree, step.env.KIKI_BUILD_TARGET ?? hostSeaTarget());
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, seaBytes);
        return;
      }
      if (step.id === 'sidecar') {
        const target = parseTargetArg([]) ?? step.env.TAURI_TARGET_TRIPLE ?? hostTarget();
        stagedSidecar = join(binaries, sidecarFileName(target));
        mkdirSync(binaries, { recursive: true });
        if (corrupt === 'sidecar' || corrupt === 'sea') {
          writeFileSync(stagedSidecar, 'foreign-sidecar-bytes');
        } else {
          copyFileSync(step.env.KIKI_SIDECAR_SOURCE ?? seaPath, stagedSidecar);
        }
        manifest = createSidecarManifest(
          stagedSidecar,
          target,
          '0.0.0-fixture',
          step.env.KIKI_BUILD_SHA,
        );
        return;
      }
      const targetDir = step.env.CARGO_TARGET_DIR ? resolve(step.env.CARGO_TARGET_DIR) : releaseDir;
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'kiki-desktop.exe'), 'desktop-bytes');
      const sidecarOutputDir = step.env.CARGO_BUILD_BUILD_DIR
        ? join(step.env.CARGO_BUILD_BUILD_DIR, 'release')
        : targetDir;
      mkdirSync(sidecarOutputDir, { recursive: true });
      copyFileSync(stagedSidecar, join(sidecarOutputDir, 'kiki-server.exe'));
    },
  });
  return { result, steps, seaBytes, seaPath, binaries, releaseDir, stagedSidecar, manifest };
}

function layoutOuterTree(root) {
  const outerSea = join(root, 'outer', 'sea', 'kiki.exe');
  const outerTarget = join(root, 'outer', 'cargo-target');
  mkdirSync(dirname(outerSea), { recursive: true });
  mkdirSync(outerTarget, { recursive: true });
  writeFileSync(outerSea, 'outer-tree-sea-bytes');
  return { outerSea, outerTarget };
}

test('an inherited KIKI_SIDECAR_SOURCE cannot stamp another tree into the receipt', async () => {
  const root = makeTemp();
  try {
    const { buildTree, candidate } = layout(root);
    const { outerSea } = layoutOuterTree(root);
    const { result, steps, seaPath, binaries, manifest } = await runMirroredBuild({
      buildTree,
      env: { KIKI_SIDECAR_SOURCE: outerSea, KIKI_BUILD_SHA: OTHER },
    });

    assert.deepEqual(
      steps.map((step) => step.env.KIKI_SIDECAR_SOURCE),
      [seaPath, seaPath, seaPath],
    );
    const server = result.receipt.files['kiki-server.exe'];
    assert.equal(server.sha256, sha256(seaPath));
    assert.equal(server.bytes, statSync(seaPath).size);
    assert.notEqual(server.sha256, sha256(outerSea));
    assert.equal(manifest.sha256, server.sha256);
    assert.equal(manifest.buildId, COMMIT);
    assert.equal(existsSync(join(binaries, sidecarFileName(hostTarget()))), true);
    assert.equal(result.path, receiptPathFor(candidate));
    assert.deepEqual(JSON.parse(readFileSync(result.path, 'utf8')), result.receipt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inherited target redirects cannot move the build out of this tree', async () => {
  const root = makeTemp();
  try {
    const { buildTree, candidate } = layout(root);
    const { outerTarget } = layoutOuterTree(root);
    const { result, steps, seaPath, releaseDir, binaries, manifest } = await runMirroredBuild({
      buildTree,
      env: {
        TAURI_TARGET_TRIPLE: OUTER_TARGET_TRIPLE,
        CARGO_TARGET_DIR: outerTarget,
        KIKI_BUILD_SHA: OTHER,
      },
    });

    assert.deepEqual(steps.map((step) => step.id), ['sea', 'sidecar', 'desktop-artifacts']);
    assert.equal(existsSync(join(binaries, sidecarFileName(OUTER_TARGET_TRIPLE))), false);
    assert.deepEqual(readdirSync(outerTarget), []);
    assert.equal(manifest.target, hostTarget());
    assert.deepEqual(result.receipt.files, {
      'kiki-desktop.exe': {
        sha256: sha256(join(releaseDir, 'kiki-desktop.exe')),
        bytes: statSync(join(releaseDir, 'kiki-desktop.exe')).size,
      },
      'kiki-server.exe': { sha256: sha256(seaPath), bytes: statSync(seaPath).size },
    });
    assert.equal(result.path, receiptPathFor(candidate));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an inherited KIKI_BUILD_TARGET cannot move this build SEA output', async () => {
  const root = makeTemp();
  try {
    const { buildTree, candidate } = layout(root);
    const foreign = treeSeaPath(buildTree, 'linux-x64');
    const { result, steps, seaPath } = await runMirroredBuild({
      buildTree,
      env: { KIKI_BUILD_TARGET: 'linux-x64', KIKI_BUILD_SHA: OTHER },
    });

    assert.deepEqual(steps.map((step) => step.env.KIKI_BUILD_TARGET), [
      hostSeaTarget(),
      hostSeaTarget(),
      hostSeaTarget(),
    ]);
    assert.equal(existsSync(foreign), false);
    assert.deepEqual(result.receipt.files['kiki-server.exe'], {
      sha256: sha256(seaPath),
      bytes: statSync(seaPath).size,
    });
    assert.equal(result.path, receiptPathFor(candidate));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes no receipt when a step does not produce this build bytes', async () => {
  const mismatches = [
    ['sea', /Build artifact is missing/],
    ['sidecar', /Staged sidecar .* is not the SEA output/],
  ];
  for (const [corrupt, pattern] of mismatches) {
    const root = makeTemp();
    try {
      const { buildTree, candidate } = layout(root);
      const receiptPath = receiptPathFor(candidate);
      const planted = '{"schemaVersion":1,"planted":true}\n';
      writeFileSync(receiptPath, planted);
      await assert.rejects(() => runMirroredBuild({ buildTree, env: {}, corrupt }), pattern);
      assert.equal(readFileSync(receiptPath, 'utf8'), planted);
      assert.deepEqual(replaceTemporaryFiles(candidate), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('assembles the server beside the desktop when Cargo separates intermediate outputs', async () => {
  const root = makeTemp();
  try {
    const { buildTree, candidate } = layout(root);
    const buildDirectory = join(root, 'cargo-intermediates');
    writeFileSync(join(candidate, 'kiki-server.exe'), 'previous-build-server');
    const { result, seaPath } = await runMirroredBuild({
      buildTree,
      env: { CARGO_BUILD_BUILD_DIR: buildDirectory },
    });
    assert.equal(readFileSync(join(buildDirectory, 'release', 'kiki-server.exe'), 'utf8'), 'this-build-sea-bytes');
    assert.equal(sha256(join(candidate, 'kiki-server.exe')), sha256(seaPath));
    assert.equal(result.receipt.files['kiki-server.exe'].sha256, sha256(seaPath));
    writeFileSync(join(candidate, 'kiki-server.exe'), 'foreign-server-bytes');
    assert.throws(() => createReceiptForCandidate({
      buildTree,
      candidateRoot: candidate,
      sourceCommit: COMMIT,
      acceptanceRef: ACCEPTANCE,
      checkRef: CHECK,
    }), /Server artifact .* is not the staged sidecar/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('replaces the previous receipt in one platform replace', () => {
  const root = makeTemp();
  try {
    const { candidate } = layout(root);
    const path = receiptPathFor(candidate);
    const planted = '{"schemaVersion":1,"planted":true}\n';
    writeFileSync(path, planted);
    const receipt = createBuildReceipt({
      sourceCommit: COMMIT,
      acceptanceRef: ACCEPTANCE,
      checkRef: CHECK,
      desktop: { sha256: TREE, bytes: 1 },
      server: { sha256: OTHER, bytes: 2 },
    });
    writeReceiptAtomic(path, receipt);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), receipt);
    assert.notEqual(readFileSync(path, 'utf8'), planted);
    assert.deepEqual(replaceTemporaryFiles(candidate), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'keeps the previous receipt when the platform replace fails',
  { skip: replaceFailureSkip },
  () => {
    const root = makeTemp();
    try {
      const { candidate } = layout(root);
      const path = receiptPathFor(candidate);
      const planted = '{"schemaVersion":1,"planted":true}\n';
      writeFileSync(path, planted);
      chmodSync(path, 0o444);
      const receipt = createBuildReceipt({
        sourceCommit: COMMIT,
        acceptanceRef: ACCEPTANCE,
        checkRef: CHECK,
        desktop: { sha256: TREE, bytes: 1 },
        server: { sha256: OTHER, bytes: 2 },
      });
      assert.throws(
        () => writeReceiptAtomic(path, receipt),
        (error) => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code),
      );
      assert.equal(readFileSync(path, 'utf8'), planted);
      assert.deepEqual(replaceTemporaryFiles(candidate), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'the real Windows pnpm runner launches pnpm.cmd and reports a version',
  { skip: pnpmProbeSkip },
  async () => {
    const version = await runPnpmStep(
      {
        id: 'pnpm-version-probe',
        command: pnpmCommand(),
        args: ['--version'],
        cwd: repoRoot,
        env: pnpmProbe,
      },
      { capture: true },
    );
    assert.match(version, /^\d+\.\d+\.\d+/);
  },
);
