import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { updaterPublicKeyIdentity, verifyUpdaterSignature } from './verify-updater-signature.mjs';

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
    const signed = readFileSync(signature, 'utf8');
    const envelope = Buffer.from(signed, 'base64').toString('utf8');
    writeFileSync(signature, Buffer.from(envelope.replace('\ntrusted comment: ', '\ntrusted comment: changed ')).toString('base64'));
    assert.throws(
      () => verifyUpdaterSignature({ installerPath: installer, signaturePath: signature, publicKey: signingKey.publicKey }),
      /trusted comment is invalid/,
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


test('release recovery verifies old signatures with the frozen build key and no private key', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-updater-recovery-'));
  try {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const workflow = readFileSync(join(repoRoot, '.github/workflows/kiki-desktop-release.yml'), 'utf8');
    const start = workflow.indexOf('      - name: Sign updater with production key');
    const marker = '        run: |\n';
    const body = workflow.indexOf(marker, start) + marker.length;
    const end = workflow.indexOf('\n      - name:', body);
    assert.ok(start >= 0 && body > start && end > body);
    const verifier = join(repoRoot, 'apps/kiki-gui/scripts/verify-updater-signature.mjs').replaceAll('\\', '/');
    const script = workflow.slice(body, end).split('\n')
      .map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n')
      .replace('node apps/kiki-gui/scripts/verify-updater-signature.mjs', `node '${verifier.replaceAll("'", "'\\''")}'`);
    const fakeBin = join(root, 'fake-bin');
    const candidate = join(root, 'release-candidate');
    const remote = join(root, 'remote');
    const runnerTemp = join(root, 'runner-temp');
    for (const directory of [fakeBin, candidate, remote, runnerTemp]) mkdirSync(directory);
    const name = 'Kiki-setup.exe';
    const installer = join(candidate, name);
    const bytes = 'exact installer built with updater key A';
    writeFileSync(installer, bytes);
    writeFileSync(join(remote, name), bytes);
    const password = 'offline-fixture-password';
    const keyA = generateKey(join(root, 'key-a'), password);
    const keyB = generateKey(join(root, 'key-b'), password);
    assert.notEqual(updaterPublicKeyIdentity(keyA.publicKey), updaterPublicKeyIdentity(keyB.publicKey));
    const envelopeA = Buffer.from(keyA.publicKey, 'base64').toString('utf8');
    assert.equal(updaterPublicKeyIdentity(envelopeA.replace('untrusted comment: ', 'untrusted comment: changed ')), updaterPublicKeyIdentity(keyA.publicKey));
    const signatures = [];
    for (const key of [keyA, keyB]) {
      tauri(['signer', 'sign', installer], {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: key.privateKey,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
      });
      signatures.push(readFileSync(`${installer}.sig`, 'utf8'));
    }
    rmSync(join(root, 'key-a'));
    rmSync(join(root, 'key-b'));
    const fakeGh = join(fakeBin, 'gh');
    writeFileSync(fakeGh, String.raw`#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  view)
    if [[ "$*" == *"--json isDraft"* ]]; then
      printf 'true\n'
    else
      printf 'Kiki-setup.exe\n'
      if [ -f "$FAKE_REMOTE/Kiki-setup.exe.sig" ]; then printf 'Kiki-setup.exe.sig\n'; fi
    fi
    ;;
  download)
    while (($#)); do
      case "$1" in
        --pattern) pattern="$2"; shift 2 ;;
        --dir) directory="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    cp "$FAKE_REMOTE/$pattern" "$directory/$pattern"
    ;;
  *) echo 'Unexpected release mutation' >&2; exit 2 ;;
esac
`);
    const fakePnpm = join(fakeBin, 'pnpm');
    const markerPath = join(root, 'private-key-use');
    writeFileSync(fakePnpm, '#!/usr/bin/env bash\nprintf called > "$FAKE_PRIVATE_KEY_MARKER"\nshift 4\nexec "$FAKE_NODE" "$FAKE_TAURI_CLI" "$@"\n');
    chmodSync(fakeGh, 0o755);
    chmodSync(fakePnpm, 0o755);
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' : 'bash';
    const execute = (signature) => {
      const signaturePath = join(remote, `${name}.sig`);
      if (signature === undefined) rmSync(signaturePath);
      else writeFileSync(signaturePath, signature);
      return spawnSync(bash, ['-e', '-o', 'pipefail', '-c', `export PATH="$PWD/fake-bin:$PATH"\n${script}`], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env, RUNNER_TEMP: runnerTemp, KIKI_TAG: 'kiki-v1.2.3',
          KIKI_UPDATER_PUBLIC_KEY: keyA.publicKey.trim(), FAKE_REMOTE: remote, FAKE_PRIVATE_KEY_MARKER: markerPath,
          FAKE_NODE: process.execPath, FAKE_TAURI_CLI: tauriCli,
          TAURI_SIGNING_PRIVATE_KEY: signature === undefined ? keyB.privateKey : '',
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signature === undefined ? password : '',
        },
      });
    };
    const sameKey = execute(signatures[0]);
    assert.equal(sameKey.status, 0, `${sameKey.stdout}\n${sameKey.stderr}`);
    assert.match(sameKey.stdout, /Updater signature verified/);
    assert.throws(() => readFileSync(markerPath), /ENOENT/);
    const differentKey = execute(signatures[1]);
    assert.notEqual(differentKey.status, 0, `${differentKey.stdout}\n${differentKey.stderr}`);
    assert.match(differentKey.stderr, /different key/);
    assert.throws(() => readFileSync(markerPath), /ENOENT/);
    const newWrongKey = execute();
    assert.notEqual(newWrongKey.status, 0, `${newWrongKey.stdout}\n${newWrongKey.stderr}`);
    assert.match(newWrongKey.stderr, /different key/);
    assert.equal(readFileSync(markerPath, 'utf8'), 'called');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
