import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertEvidenceRef,
  assertFullCommit,
  DESKTOP_EXE,
  RECEIPT_FILE_NAME,
} from '../../kiki-gui/scripts/desktop-receipt-contract.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');

const UNPACKED_SERVER_ENTRY_REL = 'resources/app.asar.unpacked/dist/server/server-entry.mjs';
const UNPACKED_NATIVE_ADDONS_REL = 'resources/app.asar.unpacked/dist/server/native-addons.json';
const UNPACKED_APP_ASAR_REL = 'resources/app.asar';

async function sha256File(filePath) {
  const st = statSync(filePath);
  if (!st.isFile() || st.size <= 0) {
    throw new Error(`Build artifact is missing or empty: ${filePath}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return {
    sha256: hash.digest('hex').toLowerCase(),
    bytes: st.size,
  };
}

function resolveGitHead() {
  return execFileSync('git', ['--no-optional-locks', '-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

export async function writeElectronBuildReceipt(options = {}) {
  const candidateDir = resolve(options.candidateDir ?? resolve(APP_DIR, 'out', 'win-unpacked'));
  if (!existsSync(candidateDir)) {
    throw new Error(`Unpacked Electron candidate directory does not exist: ${candidateDir}`);
  }
  const sourceCommit = assertFullCommit(options.sourceCommit ?? resolveGitHead());
  const acceptanceRef = assertEvidenceRef(
    options.acceptanceRef ?? 'apps/kiki-desktop/package.json#0.7.0',
    'acceptanceRef',
  );
  const checkRef = assertEvidenceRef(
    options.checkRef ?? 'pnpm --filter @kiki/desktop test && pnpm --filter @kiki/desktop smoke:node',
    'checkRef',
  );

  const desktopInfo = await sha256File(resolve(candidateDir, DESKTOP_EXE));
  const appAsarInfo = await sha256File(resolve(candidateDir, UNPACKED_APP_ASAR_REL));
  const serverEntryInfo = await sha256File(resolve(candidateDir, UNPACKED_SERVER_ENTRY_REL));
  const nativeAddonsInfo = await sha256File(resolve(candidateDir, UNPACKED_NATIVE_ADDONS_REL));

  const receipt = {
    schemaVersion: 2,
    runtimeKind: 'electron-single-binary',
    sourceCommit,
    acceptanceRef,
    checkRef,
    serverEntry: UNPACKED_SERVER_ENTRY_REL,
    nativeAddons: UNPACKED_NATIVE_ADDONS_REL,
    files: {
      [DESKTOP_EXE]: desktopInfo,
      [UNPACKED_APP_ASAR_REL]: appAsarInfo,
      'server-entry.mjs': serverEntryInfo,
      'native-addons.json': nativeAddonsInfo,
    },
  };

  const receiptPath = resolve(candidateDir, RECEIPT_FILE_NAME);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return {
    receiptPath,
    releaseId: `${desktopInfo.sha256.slice(0, 24)}-${serverEntryInfo.sha256.slice(0, 24)}`,
    receipt,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      'candidate-dir': { type: 'string' },
      'source-commit': { type: 'string' },
      'acceptance-ref': { type: 'string' },
      'check-ref': { type: 'string' },
    },
  });
  const result = await writeElectronBuildReceipt({
    candidateDir: parsed.values['candidate-dir'],
    sourceCommit: parsed.values['source-commit'],
    acceptanceRef: parsed.values['acceptance-ref'],
    checkRef: parsed.values['check-ref'],
  });
  console.log(`[write-build-receipt] Wrote ${result.receiptPath} (releaseId=${result.releaseId})`);
}
