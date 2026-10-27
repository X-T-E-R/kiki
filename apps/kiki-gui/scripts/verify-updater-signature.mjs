#!/usr/bin/env node

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function fail(message) {
  throw new Error(message);
}

function decodeBase64(value, label) {
  const text = value.trim();
  if (text === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) fail(`${label} is not valid base64.`);
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length === 0) fail(`${label} is empty.`);
  return bytes;
}

function decodeEnvelope(value, expectedLines, label) {
  const text = value.trim();
  const decoded = text.includes('\n') ? text : decodeBase64(text, label).toString('utf8').trim();
  const lines = decoded.split(/\r?\n/);
  if (lines.length !== expectedLines || !lines[0].startsWith('untrusted comment: ')) {
    fail(`${label} has an invalid minisign envelope.`);
  }
  return lines;
}

function parsePublicKey(value) {
  const lines = decodeEnvelope(value, 2, 'updater public key');
  const packet = decodeBase64(lines[1], 'updater public key packet');
  if (packet.length !== 42 || packet[0] !== 0x45 || ![0x64, 0x44].includes(packet[1])) {
    fail('Updater public key packet is unsupported.');
  }
  return {
    identity: createHash('sha256').update(packet).digest('hex'),
    keyId: packet.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, packet.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

function parseSignature(value) {
  const lines = decodeEnvelope(value, 4, 'updater signature');
  if (!lines[2].startsWith('trusted comment: ')) fail('Updater signature trusted comment is invalid.');
  const packet = decodeBase64(lines[1], 'updater signature packet');
  const globalSignature = decodeBase64(lines[3], 'updater global signature');
  if (packet.length !== 74 || globalSignature.length !== 64 || packet[0] !== 0x45 || packet[1] !== 0x44) {
    fail('Updater signature must use the supported prehashed minisign format.');
  }
  return {
    keyId: packet.subarray(2, 10),
    signature: packet.subarray(10),
    trustedComment: lines[2].slice('trusted comment: '.length),
    globalSignature,
  };
}

export function updaterPublicKeyIdentity(publicKey) {
  return parsePublicKey(publicKey).identity;
}

export function verifyUpdaterSignature({ installerPath, signaturePath, publicKey }) {
  const key = parsePublicKey(publicKey);
  const signature = parseSignature(readFileSync(signaturePath, 'utf8'));
  if (!key.keyId.equals(signature.keyId)) fail('Updater signature was produced by a different key.');

  const installerDigest = createHash('blake2b512').update(readFileSync(installerPath)).digest();
  if (!verify(null, installerDigest, key.key, signature.signature)) {
    fail('Updater signature does not match the installer bytes.');
  }
  const globalPayload = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, 'utf8'),
  ]);
  if (!verify(null, globalPayload, key.key, signature.globalSignature)) {
    fail('Updater signature trusted comment is invalid.');
  }
  return true;
}

function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      installer: { type: 'string' },
      signature: { type: 'string' },
      'public-key': { type: 'string' },
    },
    strict: true,
  });
  for (const name of ['installer', 'signature', 'public-key']) {
    if (values[name] === undefined || values[name].trim() === '') fail(`--${name} is required.`);
  }
  verifyUpdaterSignature({
    installerPath: values.installer,
    signaturePath: values.signature,
    publicKey: values['public-key'],
  });
  process.stdout.write('Updater signature verified.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[kiki updater signature] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
