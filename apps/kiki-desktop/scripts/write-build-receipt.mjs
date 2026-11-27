import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertEvidenceRef,
  assertFullCommit,
  DESKTOP_EXE,
  RECEIPT_FILE_NAME,
} from '../../kiki-gui/scripts/desktop-receipt-contract.mjs';
import { assertWebBundleIntegrity } from '../../kiki-gui/scripts/web-bundle-integrity.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');

const UNPACKED_SERVER_ENTRY_REL = 'resources/app.asar.unpacked/dist/server/server-entry.mjs';
const UNPACKED_NATIVE_ADDONS_REL = 'resources/app.asar.unpacked/dist/server/native-addons.json';
const UNPACKED_WEB_DIR_REL = 'resources/app.asar.unpacked/dist/server/web';
const UNPACKED_APP_ASAR_REL = 'resources/app.asar';
const VALID_DISTRIBUTIONS = new Set(['github', 'local', 'custom']);

export function normalizeHttpsUpdaterFeedBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (trimmed === '' || /[\u0000-\u001F\u007F\s]/.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

function resolveReceiptDistributionMetadata(options = {}, env = process.env) {
  const rawDistribution = (
    options.distribution ??
    env['KIKI_DESKTOP_DISTRIBUTION'] ??
    ''
  ).trim();
  const rawUpdaterFeedBaseUrl = (
    options.updaterFeedBaseUrl ??
    env['KIKI_UPDATER_FEED_BASE_URL'] ??
    ''
  ).trim();

  if (rawDistribution === '') {
    if (rawUpdaterFeedBaseUrl !== '') {
      throw new Error(
        'KIKI_UPDATER_FEED_BASE_URL requires KIKI_DESKTOP_DISTRIBUTION=custom.',
      );
    }
    return {};
  }
  if (!VALID_DISTRIBUTIONS.has(rawDistribution)) {
    throw new Error(
      `Invalid KIKI_DESKTOP_DISTRIBUTION "${rawDistribution}". Expected one of: github, local, custom.`,
    );
  }
  if (rawDistribution === 'custom') {
    const normalizedFeedBaseUrl = normalizeHttpsUpdaterFeedBaseUrl(rawUpdaterFeedBaseUrl);
    if (normalizedFeedBaseUrl === null) {
      throw new Error(
        'KIKI_DESKTOP_DISTRIBUTION=custom requires a valid https:// KIKI_UPDATER_FEED_BASE_URL (without credentials, query, or hash).',
      );
    }
    return {
      distribution: 'custom',
      updaterFeedBaseUrl: normalizedFeedBaseUrl,
    };
  }
  return {
    distribution: rawDistribution,
  };
}

async function sha256File(filePath) {
  const st = statSync(filePath);
  if (!st.isFile() || st.size <= 0) {
    throw new Error(`Build artifact is missing or empty: ${filePath}`);
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
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

  const distributionMeta = resolveReceiptDistributionMetadata(options);

  const desktopInfo = await sha256File(resolve(candidateDir, DESKTOP_EXE));
  const appAsarInfo = await sha256File(resolve(candidateDir, UNPACKED_APP_ASAR_REL));
  const serverEntryInfo = await sha256File(resolve(candidateDir, UNPACKED_SERVER_ENTRY_REL));
  const nativeAddonsInfo = await sha256File(resolve(candidateDir, UNPACKED_NATIVE_ADDONS_REL));
  await assertWebBundleIntegrity(resolve(candidateDir, UNPACKED_WEB_DIR_REL));

  const receipt = {
    schemaVersion: 2,
    runtimeKind: 'electron-single-binary',
    sourceCommit,
    acceptanceRef,
    checkRef,
    ...distributionMeta,
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
      distribution: { type: 'string' },
      'updater-feed-base-url': { type: 'string' },
    },
  });
  const result = await writeElectronBuildReceipt({
    candidateDir: parsed.values['candidate-dir'],
    sourceCommit: parsed.values['source-commit'],
    acceptanceRef: parsed.values['acceptance-ref'],
    checkRef: parsed.values['check-ref'],
    distribution: parsed.values.distribution,
    updaterFeedBaseUrl: parsed.values['updater-feed-base-url'],
  });
  console.log(`[write-build-receipt] Wrote ${result.receiptPath} (releaseId=${result.releaseId})`);
}
