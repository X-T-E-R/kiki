#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'X-T-E-R/kiki';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments, received: ${argv.join(' ')}`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`);
  return value;
}

export function assertReleaseVersion(version, tag = `kiki-v${version}`) {
  if (!SEMVER.test(version)) throw new Error(`Invalid semantic version: ${version}`);
  if (tag !== `kiki-v${version}`) {
    throw new Error(`Release tag must be kiki-v<semver>; expected kiki-v${version}, received ${tag}`);
  }
}

export function createReleaseManifest({ version, tag, installerName, signature, pubDate, notes = '' }) {
  assertReleaseVersion(version, tag);
  if (basename(installerName) !== installerName || !installerName.toLowerCase().endsWith('.exe')) {
    throw new Error(`Installer must be an .exe file name without a path: ${installerName}`);
  }
  const normalizedSignature = signature.trim();
  if (normalizedSignature === '') throw new Error('Updater signature is empty');
  const timestamp = new Date(pubDate);
  if (Number.isNaN(timestamp.valueOf())) throw new Error(`Invalid publication date: ${pubDate}`);

  return {
    version,
    notes,
    pub_date: timestamp.toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: normalizedSignature,
        url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(installerName)}`,
      },
    },
  };
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeReleaseFiles({ installerPath, signaturePath, manifestPath, checksumPath, version, tag, pubDate, notes }) {
  const installer = resolve(installerPath);
  const signature = resolve(signaturePath);
  if (!statSync(installer).isFile() || statSync(installer).size === 0) {
    throw new Error(`Installer must be a non-empty file: ${installer}`);
  }
  const installerName = basename(installer);
  const manifest = createReleaseManifest({
    version,
    tag,
    installerName,
    signature: readFileSync(signature, 'utf8'),
    pubDate,
    notes,
  });
  const checksum = `${sha256File(installer)}  ${installerName}\n`;

  mkdirSync(dirname(resolve(manifestPath)), { recursive: true });
  mkdirSync(dirname(resolve(checksumPath)), { recursive: true });
  writeFileSync(resolve(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(checksumPath), checksum);
  return { manifest, checksum };
}

function main() {
  const values = parseArgs(process.argv.slice(2));
  writeReleaseFiles({
    installerPath: required(values, 'installer'),
    signaturePath: required(values, 'signature'),
    manifestPath: required(values, 'output'),
    checksumPath: required(values, 'sha256-output'),
    version: required(values, 'version'),
    tag: required(values, 'tag'),
    pubDate: required(values, 'pub-date'),
    notes: values.get('notes') ?? '',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[kiki release manifest] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
