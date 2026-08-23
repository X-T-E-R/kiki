#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(GUI_ROOT, '..', '..');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const FILES = {
  package: resolve(GUI_ROOT, 'package.json'),
  tauri: resolve(GUI_ROOT, 'src-tauri', 'tauri.conf.json'),
  cargo: resolve(GUI_ROOT, 'src-tauri', 'Cargo.toml'),
  system: resolve(REPO_ROOT, 'system.yaml'),
};

function parseCargoVersion(text) {
  const match = text.match(/^version = "([^"]+)"$/m);
  if (match === null) throw new Error('Cargo.toml package version is missing');
  return match[1];
}

function parseSystemVersion(text) {
  const match = text.match(/^  version: (\S+)$/m);
  if (match === null) throw new Error('system.yaml version is missing');
  return match[1];
}

export function readDesktopVersions(files = FILES) {
  return {
    package: JSON.parse(readFileSync(files.package, 'utf8')).version,
    tauri: JSON.parse(readFileSync(files.tauri, 'utf8')).version,
    cargo: parseCargoVersion(readFileSync(files.cargo, 'utf8')),
    system: parseSystemVersion(readFileSync(files.system, 'utf8')),
  };
}

export function assertDesktopVersions(versions, tag = process.env['GITHUB_REF_NAME']) {
  const values = Object.values(versions);
  const version = values[0];
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`Invalid Kiki desktop version: ${String(version)}`);
  }
  const drift = Object.entries(versions).filter(([, value]) => value !== version);
  if (drift.length > 0) {
    throw new Error(`Kiki desktop version drift: ${Object.entries(versions).map(([name, value]) => `${name}=${value}`).join(', ')}`);
  }
  if (tag !== undefined && tag.startsWith('kiki-v') && tag !== `kiki-v${version}`) {
    throw new Error(`Release tag ${tag} does not match desktop version ${version}`);
  }
  return version;
}

export function setDesktopVersion(version, files = FILES) {
  if (!SEMVER.test(version)) throw new Error(`Invalid semantic version: ${version}`);

  for (const path of [files.package, files.tauri]) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    parsed.version = version;
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  const cargo = readFileSync(files.cargo, 'utf8').replace(
    /^version = "[^"]+"$/m,
    `version = "${version}"`,
  );
  writeFileSync(files.cargo, cargo);

  const system = readFileSync(files.system, 'utf8').replace(
    /^  version: \S+$/m,
    `  version: ${version}`,
  );
  writeFileSync(files.system, system);
}

function main() {
  const command = process.argv[2] ?? 'check';
  if (command === 'check') {
    process.stdout.write(`${assertDesktopVersions(readDesktopVersions())}\n`);
    return;
  }
  if (command === 'set') {
    const version = process.argv[3];
    if (version === undefined) throw new Error('Usage: desktop-version.mjs set <semver>');
    setDesktopVersion(version);
    process.stdout.write(`${assertDesktopVersions(readDesktopVersions())}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[kiki desktop version] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
