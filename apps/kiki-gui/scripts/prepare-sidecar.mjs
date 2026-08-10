#!/usr/bin/env node
/**
 * Stage Kiki's existing Node SEA for Tauri's target-suffixed externalBin contract.
 *
 * Adapted from codeg's `src-tauri/scripts/prepare-sidecars.mjs` at
 * fa230248d285c3f4fa541a737fc93f209820512e (Apache-2.0). Kiki differs by
 * consuming a prebuilt SEA instead of building a Rust sidecar here.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(SCRIPT_DIR, '..');
const KIKI_ROOT = resolve(GUI_ROOT, '..', '..');
const BINARIES_DIR = resolve(GUI_ROOT, 'src-tauri', 'binaries');
const SIDECAR_NAME = 'kiki-server';

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

export function defaultSeaSource(target) {
  const seaTarget = RUST_TO_SEA_TARGET.get(target);
  if (seaTarget === undefined) {
    throw new Error(
      `No Kiki SEA target mapping exists for ${target}. Set KIKI_SIDECAR_SOURCE to the matching prebuilt executable.`,
    );
  }
  const executable = target.includes('windows') ? 'kimi.exe' : 'kimi';
  return resolve(KIKI_ROOT, 'apps', 'kimi-code', 'dist-native', 'bin', seaTarget, executable);
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

export function stageSidecar({ argv = process.argv.slice(2), env = process.env } = {}) {
  const target = parseTargetArg(argv) ?? env['TAURI_TARGET_TRIPLE'] ?? resolveHostTarget();
  const source = resolve(env['KIKI_SIDECAR_SOURCE'] ?? defaultSeaSource(target));
  const destination = resolve(BINARIES_DIR, sidecarFileName(target));

  if (!existsSync(source)) {
    throw new Error(
      [
        `Kiki SEA sidecar not found for ${target}: ${source}`,
        'Build it with `pnpm --filter @moonshot-ai/kimi-code run build:native:sea`,',
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

  mkdirSync(BINARIES_DIR, { recursive: true });
  copyFileSync(source, destination);
  if (!target.includes('windows')) chmodSync(destination, 0o755);

  return { target, source, destination, bytes: sourceStat.size };
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
