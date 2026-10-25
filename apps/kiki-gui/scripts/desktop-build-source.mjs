/**
 * Checks and receipt shape for a local Kiki desktop build.
 * Setting KIKI_BUILD_SHA does not produce this receipt, an inherited sidecar or
 * target redirect cannot point it at another tree's bytes, and it is written only
 * when this build's SEA, its host stage, and the server artifact are the same bytes.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { parseRustHost, sidecarFileName } from './prepare-sidecar.mjs';

export const RECEIPT_FILE_NAME = 'desktop-build-receipt.json';
export const RECEIPT_SCHEMA_VERSION = 1;
export const DESKTOP_EXE = 'kiki-desktop.exe';
export const SERVER_EXE = 'kiki-server.exe';

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const FULL_HASH = /^[0-9a-f]{64}$/;
const READONLY_GIT = new Set(['rev-parse', 'symbolic-ref', 'status']);

export function assertFullCommit(value) {
  const commit = typeof value === 'string' ? value.trim() : '';
  if (!FULL_COMMIT.test(commit)) {
    throw new Error('sourceCommit must be the full 40-character commit selected for this build.');
  }
  return commit;
}

export function assertEvidenceRef(value, label) {
  const reference = typeof value === 'string' ? value.trim() : '';
  if (reference === '' || /[\r\n]/.test(reference)) {
    throw new Error(`${label} reference is required.`);
  }
  return reference;
}

export function assertReadonlyGitArgs(args) {
  if (!Array.isArray(args) || !READONLY_GIT.has(args[0])) {
    throw new Error(`Refusing to run git ${args?.[0] ?? ''}`);
  }
}

export function defaultCandidateRoot(buildTree) {
  return resolve(buildTree, 'apps', 'kiki-gui', 'src-tauri', 'target', 'release');
}

export function receiptPathFor(candidateRoot) {
  return join(candidateRoot, RECEIPT_FILE_NAME);
}

export function execGitReadonly(buildTree, args) {
  try {
    assertReadonlyGitArgs(args);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolveResult, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', '-C', buildTree, ...args],
      {
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.status !== 'number' && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        const code = error ? (typeof error.status === 'number' ? error.status : error.code) : 0;
        resolveResult({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

function gitStdout(result, command) {
  if (result.code !== 0) {
    throw new Error(`git ${command} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function readBuildTreeSnapshot(buildTree, git = execGitReadonly) {
  const head = gitStdout(await git(buildTree, ['rev-parse', 'HEAD']), 'rev-parse HEAD');
  const tree = gitStdout(await git(buildTree, ['rev-parse', 'HEAD^{tree}']), 'rev-parse HEAD^{tree}');
  if (!FULL_COMMIT.test(head) || !FULL_COMMIT.test(tree)) {
    throw new Error(`Build tree ${buildTree} did not resolve to a full commit and tree.`);
  }
  const symbolic = await git(buildTree, ['symbolic-ref', '-q', 'HEAD']);
  let detached;
  if (symbolic.code === 0) detached = false;
  else if (symbolic.code === 1) detached = true;
  else throw new Error(`git symbolic-ref failed (${symbolic.code}): ${symbolic.stderr.trim()}`);
  const status = await git(buildTree, ['status', '--porcelain']);
  if (status.code !== 0) {
    throw new Error(`git status failed (${status.code}): ${status.stderr.trim()}`);
  }
  return {
    head,
    tree,
    detached,
    porcelain: status.stdout.replace(/\r\n/g, '\n').trim(),
  };
}

export function assertBuildSnapshot(snapshot, sourceCommit) {
  if (snapshot.head !== sourceCommit) {
    throw new Error(`Build tree commit ${snapshot.head} does not match ${sourceCommit}.`);
  }
  if (!snapshot.detached) {
    throw new Error(`Build tree must be a detached checkout of ${sourceCommit}.`);
  }
  if (snapshot.porcelain !== '') {
    throw new Error(`Build tree is dirty: ${snapshot.porcelain}`);
  }
}

export function assertSameSnapshot(started, finished) {
  if (
    started.head !== finished.head
    || started.tree !== finished.tree
    || started.detached !== finished.detached
    || started.porcelain !== finished.porcelain
  ) {
    throw new Error('Build inputs changed before the receipt was written.');
  }
}

export function pnpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export function hostSeaTarget(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * This build tree's own SEA output for the host target. The bin directory is the
 * host `<platform>-<arch>` name that `apps/kimi-code/scripts/native/paths.mjs`
 * writes and prepare-sidecar.mjs's `RUST_TO_SEA_TARGET` resolves (win32-x64 here).
 */
export function nativeSeaOutputPath(buildTree, platform = process.platform, arch = process.arch) {
  const target = hostSeaTarget(platform, arch);
  const executable = platform === 'win32' ? 'kiki.exe' : 'kiki';
  return resolve(buildTree, 'apps', 'kimi-code', 'dist-native', 'bin', target, executable);
}

export function localBuildSteps(buildTree, sourceCommit, baseEnv) {
  const env = { ...baseEnv, KIKI_BUILD_SHA: sourceCommit };
  delete env.KIKI_DESKTOP_BUNDLED;
  // Inherited redirects would let these steps read or write artifacts that this tree
  // did not produce: prepare-sidecar prefers KIKI_SIDECAR_SOURCE over its own SEA
  // lookup, CARGO_TARGET_DIR moves the exes this receipt hashes outside the candidate
  // root, and KIKI_BUILD_TARGET/TAURI_TARGET_TRIPLE pick another platform's names.
  // `build:native:sea`, the auth-native build, and the tauri sidecar all read
  // KIKI_BUILD_TARGET, so pin it to the host instead of leaving it inherited.
  delete env.TAURI_TARGET_TRIPLE;
  delete env.CARGO_TARGET_DIR;
  env.KIKI_BUILD_TARGET = hostSeaTarget();
  env.KIKI_SIDECAR_SOURCE = nativeSeaOutputPath(buildTree);
  const command = pnpmCommand();
  const specs = [
    ['sea', ['--filter', '@kiki/cli', 'run', 'build:native:sea']],
    ['sidecar', ['--filter', '@kiki/gui', 'run', 'desktop:prepare']],
    ['desktop-artifacts', ['--filter', '@kiki/gui', 'run', 'desktop:build:artifacts']],
  ];
  return specs.map(([id, args]) => ({
    id,
    command,
    args,
    cwd: buildTree,
    env: { ...env },
  }));
}

function readArtifact(path) {
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`Build artifact is missing: ${path}`);
    throw error;
  }
  if (!info.isFile() || info.size <= 0) throw new Error(`Build artifact is missing: ${path}`);
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (!FULL_HASH.test(sha256)) throw new Error(`Build artifact hash is invalid: ${path}`);
  return { sha256, bytes: info.size };
}

export function createBuildReceipt({ sourceCommit, acceptanceRef, checkRef, desktop, server }) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    sourceCommit: assertFullCommit(sourceCommit),
    acceptanceRef: assertEvidenceRef(acceptanceRef, 'acceptance'),
    checkRef: assertEvidenceRef(checkRef, 'check'),
    files: {
      [DESKTOP_EXE]: desktop,
      [SERVER_EXE]: server,
    },
  };
}

/**
 * Replace `path` with the finished receipt in one step. `renameSync` is
 * `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows and `rename(2)` elsewhere,
 * so a failed replace leaves the previous receipt in place; deleting it first
 * would lose an already successful receipt.
 */
export function writeReceiptAtomic(path, receipt) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * The host-named file `desktop:prepare` stages from this build's SEA, per
 * prepare-sidecar.mjs: target from rustc when no --target or TAURI_TARGET_TRIPLE
 * applies, name from the Tauri externalBin suffix.
 */
function stagedSidecarPath(buildTree) {
  let target;
  try {
    target = parseRustHost(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot resolve the host target for the staged sidecar check: ${reason}`);
  }
  return join(buildTree, 'apps', 'kiki-gui', 'src-tauri', 'binaries', sidecarFileName(target));
}

export function stageServerArtifact(buildTree, candidateRoot) {
  const seaPath = nativeSeaOutputPath(buildTree);
  const stagedPath = stagedSidecarPath(buildTree);
  const sea = readArtifact(seaPath);
  const staged = readArtifact(stagedPath);
  if (sea.sha256 !== staged.sha256) {
    throw new Error(`Staged sidecar ${stagedPath} is not the SEA output ${seaPath}; no receipt written.`);
  }
  readArtifact(join(candidateRoot, DESKTOP_EXE));
  copyFileSync(stagedPath, join(candidateRoot, SERVER_EXE));
}

/**
 * A receipt may only describe bytes this build produced, so this tree's SEA output,
 * the host stage of that SEA, and the server artifact must be the same content. A
 * mismatch means a step did not produce this tree's output and no receipt is written.
 */
export function createReceiptForCandidate({
  buildTree,
  candidateRoot,
  sourceCommit,
  acceptanceRef,
  checkRef,
}) {
  const seaPath = nativeSeaOutputPath(buildTree);
  const sea = readArtifact(seaPath);
  const stagedPath = stagedSidecarPath(buildTree);
  const staged = readArtifact(stagedPath);
  const serverPath = join(candidateRoot, SERVER_EXE);
  const server = readArtifact(serverPath);
  if (sea.sha256 !== staged.sha256) {
    throw new Error(
      `Staged sidecar ${stagedPath} is not the SEA output ${seaPath}; no receipt written.`,
    );
  }
  if (staged.sha256 !== server.sha256) {
    throw new Error(
      `Server artifact ${serverPath} is not the staged sidecar ${stagedPath}; no receipt written.`,
    );
  }
  return createBuildReceipt({
    sourceCommit,
    acceptanceRef,
    checkRef,
    desktop: readArtifact(join(candidateRoot, DESKTOP_EXE)),
    server,
  });
}
