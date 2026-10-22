#!/usr/bin/env node
/**
 * Stage Kiki's existing Node SEA for Tauri's target-suffixed externalBin contract.
 *
 * Adapted from codeg's `src-tauri/scripts/prepare-sidecars.mjs` at
 * fa230248d285c3f4fa541a737fc93f209820512e (Apache-2.0). Kiki differs by
 * consuming a prebuilt SEA instead of building a Rust sidecar here.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifySidecarReceipt } from '../../kimi-code/scripts/native/release-receipt.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(SCRIPT_DIR, '..');
const KIKI_ROOT = resolve(GUI_ROOT, '..', '..');
const BINARIES_DIR = resolve(GUI_ROOT, 'src-tauri', 'binaries');
const KIMI_PACKAGE_JSON = resolve(KIKI_ROOT, 'apps', 'kimi-code', 'package.json');
const SIDECAR_NAME = 'kiki-server';
const SIDECAR_MANIFEST_VERSION = 2;
const RELEASE_SIDECAR_MODE = 'verified-prebuilt';

const RUST_TO_SEA_TARGET = new Map([
  ['x86_64-pc-windows-msvc', 'win32-x64'],
  ['aarch64-pc-windows-msvc', 'win32-arm64'],
  ['x86_64-apple-darwin', 'darwin-x64'],
  ['aarch64-apple-darwin', 'darwin-arm64'],
  ['x86_64-unknown-linux-gnu', 'linux-x64'],
  ['aarch64-unknown-linux-gnu', 'linux-arm64'],
]);

export function parseTargetArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--target') {
      const target = argv[index + 1];
      if (target === undefined || target.startsWith('-')) {
        throw new Error('--target requires a Rust target triple');
      }
      return target;
    }
    if (value.startsWith('--target=')) {
      const target = value.slice('--target='.length);
      if (target === '') throw new Error('--target requires a Rust target triple');
      return target;
    }
  }
  return undefined;
}
export function parseRustHost(output) {
  const hostLine = output.split(/\r?\n/).find((line) => line.startsWith('host:'));
  const target = hostLine?.slice('host:'.length).trim();
  if (target === undefined || target === '') {
    throw new Error('rustc -vV did not report a host target');
  }
  return target;
}

export function sidecarFileName(target) {
  return `${SIDECAR_NAME}-${target}${target.includes('windows') ? '.exe' : ''}`;
}

export function sidecarManifestFileName(target) {
  return `${sidecarFileName(target)}.manifest.json`;
}

export function defaultSeaSource(target) {
  const seaTarget = RUST_TO_SEA_TARGET.get(target);
  if (seaTarget === undefined) {
    throw new Error(
      `No Kiki SEA target mapping exists for ${target}. Set KIKI_SIDECAR_SOURCE to the matching prebuilt executable.`,
    );
  }
  const executable = target.includes('windows') ? 'kiki.exe' : 'kiki';
  return resolve(KIKI_ROOT, 'apps', 'kimi-code', 'dist-native', 'bin', seaTarget, executable);
}

export function prebuiltReceiptRequired(env = process.env) {
  const mode = env['KIKI_SIDECAR_RELEASE_MODE'];
  if (mode === undefined) return false;
  if (mode !== RELEASE_SIDECAR_MODE) {
    throw new Error(`KIKI_SIDECAR_RELEASE_MODE must be ${RELEASE_SIDECAR_MODE}.`);
  }
  return true;
}

export function readKimiServerVersion(packageJsonPath = KIMI_PACKAGE_JSON) {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error(`Kiki package version is missing from ${packageJsonPath}`);
  }
  return parsed.version;
}

export function createSidecarManifest(
  sidecarPath,
  target,
  serverVersion,
  buildId,
  buildChannel = 'dev',
  releaseSource,
) {
  const bytes = statSync(sidecarPath).size;
  const sha256 = createHash('sha256').update(readFileSync(sidecarPath)).digest('hex');
  return {
    schemaVersion: SIDECAR_MANIFEST_VERSION,
    target,
    bytes,
    sha256,
    serverVersion,
    buildId: buildId?.trim() || sha256,
    buildChannel,
    releaseSource,
  };
}

function resolveHostTarget() {
  try {
    return parseRustHost(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }));
  } catch (error) {
    throw new Error(
      `Cannot determine the host target via rustc -vV: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function stageSidecar({
  argv = process.argv.slice(2),
  env = process.env,
  binariesDir = BINARIES_DIR,
  packageJsonPath = KIMI_PACKAGE_JSON,
} = {}) {
  const target = parseTargetArg(argv) ?? env['TAURI_TARGET_TRIPLE'] ?? resolveHostTarget();
  const source = resolve(env['KIKI_SIDECAR_SOURCE'] ?? defaultSeaSource(target));
  const destination = resolve(binariesDir, sidecarFileName(target));
  const manifestPath = resolve(binariesDir, sidecarManifestFileName(target));

  if (!existsSync(source)) {
    throw new Error(
      [
        `Kiki SEA sidecar not found for ${target}: ${source}`,
        'Build it with `pnpm --filter @kiki/cli run build:native:sea`,',
        'or set KIKI_SIDECAR_SOURCE to an existing target-compatible SEA executable.',
      ].join(' '),
    );
  }
  const sourceStat = statSync(source);
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error(`Kiki SEA sidecar source must be a non-empty file: ${source}`);
  }
  const expectedExtension = target.includes('windows') ? '.exe' : '';
  if (expectedExtension !== '' && extname(source).toLowerCase() !== expectedExtension) {
    throw new Error(`Windows target ${target} requires an .exe sidecar source: ${source}`);
  }

  let releaseSource;
  if (prebuiltReceiptRequired(env)) {
    const receiptPath = env['KIKI_SIDECAR_RECEIPT'];
    const prepareReceiptPath = env['KIKI_RELEASE_INPUT_RECEIPT'];
    const catalogPath = env['KIKI_BUILT_IN_CATALOG_FILE'];
    if (receiptPath === undefined || prepareReceiptPath === undefined || catalogPath === undefined) {
      throw new Error('Verified release sidecar mode requires its native receipt, release input receipt, and catalog.');
    }
    const receipt = verifySidecarReceipt({
      receiptPath: resolve(receiptPath),
      sourcePath: source,
      rustTarget: target,
      prepareReceiptPath: resolve(prepareReceiptPath),
      catalogPath: resolve(catalogPath),
      expected: {
        repository: env['KIKI_RELEASE_REPOSITORY'],
        sourceSha: env['KIKI_BUILD_SHA'],
        tag: env['KIKI_RELEASE_TAG'],
        version: env['KIKI_VERSION'],
        channel: env['KIKI_UPDATE_CHANNEL'],
        runId: env['KIKI_RELEASE_RUN_ID'],
        producerAttempt: env['KIKI_RELEASE_PREPARE_ATTEMPT'],
        candidateAttempt: env['KIKI_RELEASE_CANDIDATE_ATTEMPT'],
        prepareArtifactId: env['KIKI_RELEASE_PREPARE_ARTIFACT_ID'],
      },
    });
    releaseSource = {
      sourceSha: receipt.sourceSha,
      prepareIdentity: receipt.prepare.identity,
      prepareArtifactId: receipt.prepare.artifactId,
      producerAttempt: receipt.workflow.producerAttempt,
    };
  }

  mkdirSync(binariesDir, { recursive: true });
  copyFileSync(source, destination);
  if (!target.includes('windows')) chmodSync(destination, 0o755);

  const serverVersion = readKimiServerVersion(packageJsonPath);
  const manifest = createSidecarManifest(
    destination,
    target,
    serverVersion,
    env['KIKI_BUILD_SHA'],
    env['KIKI_UPDATE_CHANNEL']?.trim() || 'dev',
    releaseSource,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { target, source, destination, manifestPath, ...manifest };
}

function main() {
  try {
    const result = stageSidecar();
    process.stdout.write(
      `[kiki desktop] staged ${result.bytes} bytes for ${result.target}: ${result.destination}\n`,
    );
  } catch (error) {
    process.stderr.write(`[kiki desktop] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
