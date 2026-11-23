/**
 * Checks and receipt shape for a local Kiki desktop build.
 * Setting KIKI_BUILD_SHA does not produce this receipt, an inherited sidecar or
 * target redirect cannot point it at another tree's bytes, and it is written only
 * when this build's SEA, its host stage, and the server artifact are the same bytes.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';

import {
  assertEvidenceRef,
  assertFullCommit,
  DESKTOP_EXE,
  FULL_COMMIT_RE as FULL_COMMIT,
  FULL_HASH_RE as FULL_HASH,
  RECEIPT_FILE_NAME,
  RECEIPT_SCHEMA_VERSION,
  SERVER_EXE,
} from './desktop-receipt-contract.mjs';
import { parseRustHost, sidecarFileName } from './prepare-sidecar.mjs';

export {
  assertEvidenceRef,
  assertFullCommit,
  DESKTOP_EXE,
  RECEIPT_FILE_NAME,
  RECEIPT_SCHEMA_VERSION,
  SERVER_EXE,
};

const READONLY_GIT = new Set(['rev-parse', 'symbolic-ref', 'status']);

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

export function resolveSharedCargoTargetDir(buildTree, baseEnv = process.env) {
  const configured = typeof baseEnv?.CARGO_TARGET_DIR === 'string'
    ? baseEnv.CARGO_TARGET_DIR.trim()
    : '';
  if (configured.length > 0) return resolve(configured);
  const tree = resolve(buildTree);
  try {
    if (!statSync(join(tree, '.git')).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const parent = dirname(tree);
  if (parent === tree) return undefined;
  try {
    accessSync(parent, fsConstants.W_OK);
  } catch {
    return undefined;
  }
  return join(parent, '.cargo-target');
}

export function localBuildSteps(buildTree, sourceCommit, baseEnv) {
  const env = { ...baseEnv, KIKI_BUILD_SHA: sourceCommit };
  delete env.KIKI_DESKTOP_BUNDLED;
  // Inherited redirects would let these steps read or write artifacts that this tree
  // did not produce: prepare-sidecar prefers KIKI_SIDECAR_SOURCE over its own SEA
  // lookup, and KIKI_BUILD_TARGET/TAURI_TARGET_TRIPLE pick another platform's names.
  // `build:native:sea`, the auth-native build, and the tauri sidecar all read
  // KIKI_BUILD_TARGET, so pin it to the host instead of leaving it inherited.
  // Shared CARGO_TARGET_DIR is supported for incremental builds across worktrees;
  // stageDesktopArtifact copies the produced desktop binary back into the canonical
  // candidate root before receipt generation.
  delete env.TAURI_TARGET_TRIPLE;
  const cargoTargetDir = resolveSharedCargoTargetDir(buildTree, baseEnv);
  if (cargoTargetDir !== undefined) {
    env.CARGO_TARGET_DIR = cargoTargetDir;
  } else {
    delete env.CARGO_TARGET_DIR;
  }
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

export function isSharedCargoTargetDir(buildTree, cargoTargetDir) {
  if (cargoTargetDir === undefined) return false;
  const canonicalTargetDir = resolve(buildTree, 'apps', 'kiki-gui', 'src-tauri', 'target');
  return resolve(cargoTargetDir) !== canonicalTargetDir;
}

function tryListenExclusive(endpoint) {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer();
    server.unref();
    const onError = (error) => {
      server.removeListener('listening', onListening);
      try {
        server.close();
      } catch {}
      if (error?.code === 'EADDRINUSE') {
        resolveListen(null);
        return;
      }
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolveListen(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function isUnixSocketAlive(socketPath) {
  return new Promise((resolveAlive) => {
    const client = createConnection(socketPath);
    client.once('connect', () => {
      client.destroy();
      resolveAlive(true);
    });
    client.once('error', (error) => {
      client.destroy();
      resolveAlive(error?.code !== 'ECONNREFUSED' && error?.code !== 'ENOENT');
    });
  });
}

/**
 * Serialize builds that share an external `CARGO_TARGET_DIR` from the Cargo
 * desktop build through staging `kiki-desktop.exe` into the caller's private
 * candidate directory using an OS-kernel-owned IPC endpoint (Windows named pipe
 * / POSIX domain socket). The kernel releases the Windows named pipe immediately
 * if a holder crashes, avoiding stale-lockfile TOCTOU races.
 */
export async function withSharedCargoTargetLock(
  buildTree,
  cargoTargetDir,
  action,
  { pollIntervalMs = 50, timeoutMs = 15 * 60 * 1000 } = {},
) {
  if (!isSharedCargoTargetDir(buildTree, cargoTargetDir)) {
    return action();
  }
  const resolvedTargetDir = resolve(cargoTargetDir);
  mkdirSync(resolvedTargetDir, { recursive: true });
  const targetHash = createHash('sha256')
    .update(process.platform === 'win32' ? resolvedTargetDir.toLowerCase() : resolvedTargetDir)
    .digest('hex')
    .slice(0, 32);
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\kiki-cargo-target-${targetHash}`
    : join(resolvedTargetDir, `.kiki-desktop-build-${targetHash}.sock`);
  const deadline = Date.now() + timeoutMs;

  let lockServer = null;
  for (;;) {
    lockServer = await tryListenExclusive(endpoint);
    if (lockServer !== null) break;
    if (process.platform !== 'win32' && !(await isUnixSocketAlive(endpoint))) {
      try {
        const stale = `${endpoint}.stale-${randomBytes(6).toString('hex')}`;
        renameSync(endpoint, stale);
        rmSync(stale, { force: true });
      } catch {}
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for shared Cargo target lock (${resolvedTargetDir}).`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollIntervalMs));
  }

  try {
    return await action();
  } finally {
    await new Promise((resolveClose) => {
      try {
        lockServer.close(() => resolveClose());
      } catch {
        resolveClose();
      }
    });
    if (process.platform !== 'win32') {
      try {
        rmSync(endpoint, { force: true });
      } catch {}
    }
  }
}

export function stageDesktopArtifact(buildTree, candidateRoot, cargoTargetDir) {
  if (!isSharedCargoTargetDir(buildTree, cargoTargetDir)) return;
  const resolvedTargetDir = resolve(cargoTargetDir);
  const sourceDesktopPath = join(resolvedTargetDir, 'release', DESKTOP_EXE);
  const sourceDesktop = readArtifact(sourceDesktopPath);
  mkdirSync(candidateRoot, { recursive: true });
  const destinationPath = join(candidateRoot, DESKTOP_EXE);
  const tempPath = join(candidateRoot, `.${DESKTOP_EXE}.${randomBytes(8).toString('hex')}.tmp`);
  copyFileSync(sourceDesktopPath, tempPath);
  try {
    const copied = readArtifact(tempPath);
    if (copied.sha256 !== sourceDesktop.sha256 || copied.bytes !== sourceDesktop.bytes) {
      throw new Error(
        `Staged desktop binary ${destinationPath} does not match Cargo output ${sourceDesktopPath}; no receipt written.`,
      );
    }
    renameSync(tempPath, destinationPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
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
