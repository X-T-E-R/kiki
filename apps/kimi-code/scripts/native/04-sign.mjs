import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { run } from './exec.mjs';
import { nativeBinPath, targetTriple } from './paths.mjs';

const ENTITLEMENTS_PATH = resolve(import.meta.dirname, 'entitlements.plist');

export const REQUIRED_SEA_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.disable-library-validation',
];

export function parseEntitlementsXml(xml) {
  const result = new Map();
  if (typeof xml !== 'string' || xml.trim() === '') return result;
  const pairPattern = /<key>\s*([^<]+?)\s*<\/key>\s*<(true|false)\s*\/>/g;
  for (const match of xml.matchAll(pairPattern)) {
    result.set(match[1].trim(), match[2] === 'true');
  }
  return result;
}

export function assertSeaEntitlements(xml, label = 'executable') {
  const parsed = parseEntitlementsXml(xml);
  const missing = REQUIRED_SEA_ENTITLEMENTS.filter((key) => parsed.get(key) !== true);
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing required Node.js SEA Hardened Runtime entitlements: ${missing.join(', ')}`,
    );
  }
  return parsed;
}

export function macosSigningOptions(signMacos, env = process.env) {
  const rawIdentity = env.APPLE_SIGNING_IDENTITY?.trim() ?? '';
  const rawKeychain = env.APPLE_KEYCHAIN_PATH?.trim() ?? '';
  return {
    identity: signMacos && rawIdentity !== '' ? rawIdentity : '-',
    keychainPath: signMacos && rawKeychain !== '' ? rawKeychain : null,
  };
}

export function buildCodesignArgs({ identity, executable, entitlementsPath, keychainPath }) {
  if (identity === '-') {
    return ['--sign', '-', executable];
  }
  const args = [
    '--sign',
    identity,
    '--options',
    'runtime',
    '--entitlements',
    entitlementsPath,
    '--timestamp',
  ];
  if (keychainPath) {
    args.push('--keychain', keychainPath);
  }
  args.push('--force', executable);
  return args;
}

async function sha256(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function writeChecksum(executable) {
  const digest = await sha256(executable);
  await writeFile(`${executable}.sha256`, `${digest}  ${basename(executable)}\n`);
}

export async function runSignStep({ identity = '-', keychainPath = null } = {}) {
  const target = targetTriple();
  const executable = nativeBinPath(target);

  if (process.platform === 'darwin') {
    const args = buildCodesignArgs({
      identity,
      executable,
      entitlementsPath: ENTITLEMENTS_PATH,
      keychainPath,
    });
    await run('codesign', args);
  }

  await writeChecksum(executable);
  console.log(`Signed and hashed: ${executable}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? '-';
  const keychainPath = process.env.APPLE_KEYCHAIN_PATH ?? null;
  await runSignStep({ identity, keychainPath });
}
