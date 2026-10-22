import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyUpdaterSignature } from './verify-updater-signature.mjs';

const requireFromScript = createRequire(import.meta.url);
const tauriCli = requireFromScript.resolve('@tauri-apps/cli/tauri.js');

function tauri(args, env = process.env) {
  return execFileSync(process.execPath, [tauriCli, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function generateKey(path, password) {
  tauri(['signer', 'generate', '--ci', '--password', password, '--write-keys', path]);
  return {
    privateKey: readFileSync(path, 'utf8'),
    publicKey: readFileSync(`${path}.pub`, 'utf8'),
  };
}

test('verifies an existing updater signature against exact installer bytes and expected public key', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-updater-signature-'));
  try {
    const installer = join(root, 'Kiki-setup.exe');
    const password = 'offline-fixture-password';
    writeFileSync(installer, 'exact offline installer fixture');
    const signingKey = generateKey(join(root, 'signing-key'), password);
    const otherKey = generateKey(join(root, 'other-key'), password);
    tauri(['signer', 'sign', installer], {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: signingKey.privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
    });
    const signature = `${installer}.sig`;

    assert.equal(verifyUpdaterSignature({ installerPath: installer, signaturePath: signature, publicKey: signingKey.publicKey }), true);

    writeFileSync(installer, 'different installer bytes');
    assert.throws(
      () => verifyUpdaterSignature({ installerPath: installer, signaturePath: signature, publicKey: signingKey.publicKey }),
      /does not match the installer bytes/,
    );
    writeFileSync(installer, 'exact offline installer fixture');
    assert.throws(
      () => verifyUpdaterSignature({ installerPath: installer, signaturePath: signature, publicKey: otherKey.publicKey }),
      /different key/,
    );
    writeFileSync(signature, 'not-a-production-signature\n');
    assert.throws(
      () => verifyUpdaterSignature({ installerPath: installer, signaturePath: signature, publicKey: signingKey.publicKey }),
      /valid base64|invalid minisign envelope/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
