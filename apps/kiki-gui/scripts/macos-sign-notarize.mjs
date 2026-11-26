#!/usr/bin/env node

import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import {
  REQUIRED_SEA_ENTITLEMENTS,
  assertSeaEntitlements,
} from '../../kimi-code/scripts/native/04-sign.mjs';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(SCRIPT_DIR, '..');
const KIKI_ROOT = resolve(GUI_ROOT, '..', '..');
export const DEFAULT_SEA_ENTITLEMENTS_PATH = resolve(
  KIKI_ROOT,
  'apps',
  'kimi-code',
  'scripts',
  'native',
  'entitlements.plist',
);
export const DEFAULT_APP_ENTITLEMENTS_PATH = resolve(
  KIKI_ROOT,
  'apps',
  'kiki-desktop',
  'build',
  'entitlements.mac.plist',
);

const NESTED_BINARY_EXTENSIONS = new Set(['.dylib', '.so', '.node']);

function trimNonEmpty(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function resolveSigningConfig(options = {}, env = process.env) {
  const explicitIdentity = trimNonEmpty(options.identity);
  const envIdentity = trimNonEmpty(env.APPLE_SIGNING_IDENTITY);
  const identity = explicitIdentity || envIdentity || '-';
  const explicitKeychain = trimNonEmpty(options.keychain);
  const envKeychain = trimNonEmpty(env.APPLE_KEYCHAIN_PATH);
  const keychainPath = explicitKeychain || envKeychain || null;
  const entitlementsPath = resolve(
    trimNonEmpty(options.entitlements) || DEFAULT_SEA_ENTITLEMENTS_PATH,
  );
  const appEntitlementsPath = resolve(
    trimNonEmpty(options.appEntitlements) || DEFAULT_APP_ENTITLEMENTS_PATH,
  );
  return {
    identity,
    adHoc: identity === '-',
    keychainPath,
    entitlementsPath,
    appEntitlementsPath,
  };
}

export function resolveNotarizationAuth(options = {}, env = process.env) {
  const keychainProfile =
    trimNonEmpty(options.keychainProfile) ||
    trimNonEmpty(env.APPLE_NOTARY_KEYCHAIN_PROFILE) ||
    trimNonEmpty(env.APPLE_KEYCHAIN_PROFILE);
  const keychainPath =
    trimNonEmpty(options.keychain) || trimNonEmpty(env.APPLE_KEYCHAIN_PATH) || null;
  if (keychainProfile !== '') {
    return {
      mode: 'keychain-profile',
      profile: keychainProfile,
      keychainPath,
    };
  }

  const keyId =
    trimNonEmpty(options.apiKey) ||
    trimNonEmpty(env.APPLE_API_KEY) ||
    trimNonEmpty(env.APPLE_NOTARIZATION_KEY_ID);
  const issuer =
    trimNonEmpty(options.apiIssuer) ||
    trimNonEmpty(env.APPLE_API_ISSUER) ||
    trimNonEmpty(env.APPLE_NOTARIZATION_ISSUER_ID);
  const keyPath =
    trimNonEmpty(options.apiKeyPath) || trimNonEmpty(env.APPLE_API_KEY_PATH);
  const keyP8Base64 =
    trimNonEmpty(env.APPLE_API_KEY_P8) || trimNonEmpty(env.APPLE_NOTARIZATION_KEY_P8);

  if (keyId !== '' && issuer !== '' && keyPath !== '') {
    return {
      mode: 'api-key-file',
      keyId,
      issuer,
      keyPath: resolve(keyPath),
    };
  }

  if (keyId !== '' && issuer !== '' && keyP8Base64 !== '') {
    return {
      mode: 'api-key-p8-base64',
      keyId,
      issuer,
      keyP8Base64,
    };
  }

  const partial =
    keyId !== '' || issuer !== '' || keyPath !== '' || keyP8Base64 !== '';
  if (partial) {
    throw new Error(
      'Incomplete App Store Connect API Key notarization config: provide APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_PATH (or APPLE_NOTARIZATION_KEY_ID, APPLE_NOTARIZATION_ISSUER_ID, and APPLE_NOTARIZATION_KEY_P8).',
    );
  }

  return null;
}

export function buildNotaryAuthArgs(auth, materializedKeyPath = null) {
  if (auth.mode === 'keychain-profile') {
    const args = ['--keychain-profile', auth.profile];
    if (auth.keychainPath) {
      args.push('--keychain', auth.keychainPath);
    }
    return args;
  }
  const keyPath = auth.mode === 'api-key-file' ? auth.keyPath : materializedKeyPath;
  if (!keyPath) {
    throw new Error('Materialized .p8 key path is required for API key notarization.');
  }
  return ['--key', keyPath, '--key-id', auth.keyId, '--issuer', auth.issuer];
}

export function buildSingleCodesignArgs({
  identity,
  targetPath,
  entitlementsPath = null,
  keychainPath = null,
  hardenedRuntime = true,
  timestamp = true,
}) {
  if (identity === '-') {
    const args = ['--force', '--sign', '-'];
    if (entitlementsPath) {
      args.push('--entitlements', entitlementsPath);
    }
    args.push(targetPath);
    return args;
  }
  const args = ['--force', '--sign', identity];
  if (hardenedRuntime) {
    args.push('--options', 'runtime');
  }
  if (entitlementsPath) {
    args.push('--entitlements', entitlementsPath);
  }
  if (timestamp) {
    args.push('--timestamp');
  }
  if (keychainPath) {
    args.push('--keychain', keychainPath);
  }
  args.push(targetPath);
  return args;
}

export function discoverNestedBinaries(appPath) {
  const contentsDir = join(appPath, 'Contents');
  if (!existsSync(contentsDir)) return [];
  const mainExe = join(contentsDir, 'MacOS', 'kiki-desktop');
  const sidecarExe = join(contentsDir, 'MacOS', 'kiki-server');
  const results = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (fullPath === mainExe || fullPath === sidecarExe) continue;
      const ext = extname(entry.name).toLowerCase();
      if (NESTED_BINARY_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  walk(contentsDir);
  results.sort();
  return results;
}

export function discoverNestedBundles(appPath) {
  const frameworksDir = join(appPath, 'Contents', 'Frameworks');
  if (!existsSync(frameworksDir)) return [];
  const helpers = [];
  const frameworks = [];
  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const fullPath = join(frameworksDir, entry.name);
    if (entry.name.endsWith('.app')) helpers.push(fullPath);
    else if (entry.name.endsWith('.framework')) frameworks.push(fullPath);
  }
  helpers.sort();
  frameworks.sort();
  return [...helpers, ...frameworks];
}

export function buildBundleCodesignPlan({
  appPath,
  identity,
  entitlementsPath,
  appEntitlementsPath = entitlementsPath,
  keychainPath = null,
  nestedBinaries = [],
  nestedBundles = [],
  includeSidecar = true,
}) {
  const sidecarPath = join(appPath, 'Contents', 'MacOS', 'kiki-server');
  const plan = [];

  for (const nested of nestedBinaries) {
    plan.push({
      label: `nested:${basename(nested)}`,
      targetPath: nested,
      args: buildSingleCodesignArgs({
        identity,
        targetPath: nested,
        entitlementsPath: null,
        keychainPath,
        hardenedRuntime: true,
        timestamp: true,
      }),
    });
  }

  for (const bundle of nestedBundles) {
    plan.push({
      label: `framework:${basename(bundle)}`,
      targetPath: bundle,
      args: buildSingleCodesignArgs({
        identity,
        targetPath: bundle,
        entitlementsPath: bundle.endsWith('.app') ? appEntitlementsPath : null,
        keychainPath,
        hardenedRuntime: true,
        timestamp: true,
      }),
    });
  }

  if (includeSidecar) {
    plan.push({
      label: 'sidecar:kiki-server',
      targetPath: sidecarPath,
      args: buildSingleCodesignArgs({
        identity,
        targetPath: sidecarPath,
        entitlementsPath,
        keychainPath,
        hardenedRuntime: true,
        timestamp: true,
      }),
    });
  }

  plan.push({
    label: 'bundle:Kiki.app',
    targetPath: appPath,
    args: buildSingleCodesignArgs({
      identity,
      targetPath: appPath,
      entitlementsPath: appEntitlementsPath,
      keychainPath,
      hardenedRuntime: true,
      timestamp: true,
    }),
  });

  return plan;
}

export function parseNotarySubmissionId(output) {
  if (typeof output !== 'string') return null;
  const match = /\bid:\s*([0-9a-fA-F-]{8,})\b/.exec(output);
  return match ? match[1] : null;
}

export function isNotaryAccepted(output) {
  return typeof output === 'string' && /\bstatus:\s*Accepted\b/.test(output);
}

async function runCommand(cmd, args, { capture = false } = {}) {
  if (capture) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      return {
        exitCode: typeof error?.code === 'number' ? error.code : 1,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
      };
    }
  }
  await execFileAsync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { exitCode: 0, stdout: '', stderr: '' };
}

export async function verifySidecarEntitlements(appPath, execRunner = runCommand) {
  const macosDir = join(appPath, 'Contents', 'MacOS');
  const candidates = [
    join(macosDir, 'kiki-server'),
    join(macosDir, 'Kiki'),
    join(macosDir, 'kiki-desktop'),
  ];
  const targetBinary = candidates.find((candidate) => existsSync(candidate));
  if (!targetBinary) {
    throw new Error(`Bundled macOS executable missing under ${macosDir}`);
  }
  const result = await execRunner(
    'codesign',
    ['-d', '--entitlements', ':-', targetBinary],
    { capture: true },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to read entitlements from ${targetBinary}: ${result.stderr || result.stdout}`,
    );
  }
  assertSeaEntitlements(result.stdout, targetBinary);
  return {
    sidecarPath: targetBinary,
    verifiedEntitlements: [...REQUIRED_SEA_ENTITLEMENTS],
  };
}

export function rebuildDmgFromApp(appPath, dmgPath, volumeName = 'Kiki') {
  const staging = mkdtempSync(join(tmpdir(), 'kiki-dmg-stage-'));
  try {
    const stagedApp = join(staging, basename(appPath));
    cpSync(appPath, stagedApp, { recursive: true, verbatimSymlinks: true });
    symlinkSync('/Applications', join(staging, 'Applications'));
    rmSync(dmgPath, { force: true });
    execFileSync(
      'hdiutil',
      [
        'create',
        '-volname',
        volumeName,
        '-srcfolder',
        staging,
        '-ov',
        '-format',
        'UDZO',
        dmgPath,
      ],
      { stdio: 'inherit' },
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function notarizeArtifact({
  artifactPath,
  auth,
  timeout = '15m',
  execRunner = runCommand,
}) {
  let tempDir = null;
  let materializedKeyPath = null;
  let submitPath = artifactPath;

  try {
    if (auth.mode === 'api-key-p8-base64') {
      tempDir = mkdtempSync(join(tmpdir(), 'kiki-notary-'));
      chmodSync(tempDir, 0o700);
      materializedKeyPath = join(tempDir, 'AuthKey.p8');
      const decoded = Buffer.from(auth.keyP8Base64, 'base64');
      if (decoded.length === 0) {
        throw new Error('Decoded APPLE_NOTARIZATION_KEY_P8 is empty.');
      }
      writeFileSync(materializedKeyPath, decoded, { mode: 0o600 });
      chmodSync(materializedKeyPath, 0o600);
    }

    if (statSync(artifactPath).isDirectory()) {
      tempDir ??= mkdtempSync(join(tmpdir(), 'kiki-notary-'));
      submitPath = join(tempDir, `${basename(artifactPath)}.notarize.zip`);
      await execRunner('ditto', ['-c', '-k', '--norsrc', '--keepParent', artifactPath, submitPath]);
    }

    const authArgs = buildNotaryAuthArgs(auth, materializedKeyPath);
    const submitRes = await execRunner(
      'xcrun',
      ['notarytool', 'submit', submitPath, ...authArgs, '--wait', '--timeout', timeout],
      { capture: true },
    );
    const combined = `${submitRes.stdout}\n${submitRes.stderr}`;
    process.stdout.write(combined);

    if (submitRes.exitCode !== 0 || !isNotaryAccepted(combined)) {
      const submissionId = parseNotarySubmissionId(combined);
      if (submissionId) {
        const logRes = await execRunner(
          'xcrun',
          ['notarytool', 'log', submissionId, ...authArgs],
          { capture: true },
        );
        process.stderr.write(logRes.stdout || logRes.stderr);
      }
      throw new Error(
        `Apple notarization failed for ${artifactPath} (exit=${submitRes.exitCode}).`,
      );
    }
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function verifyMacosBundle({
  appPath,
  dmgPath = null,
  requireGatekeeper = false,
  execRunner = runCommand,
}) {
  const verifyRes = await execRunner(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { capture: true },
  );
  if (verifyRes.exitCode !== 0) {
    throw new Error(
      `codesign --verify --deep --strict failed for ${appPath}: ${verifyRes.stderr || verifyRes.stdout}`,
    );
  }
  const entitlementCheck = await verifySidecarEntitlements(appPath, execRunner);

  if (requireGatekeeper) {
    const appSpctl = await execRunner('spctl', ['-a', '-vvv', '-t', 'exec', appPath], {
      capture: true,
    });
    if (appSpctl.exitCode !== 0) {
      throw new Error(
        `Gatekeeper check (spctl -t exec) failed for ${appPath}: ${appSpctl.stderr || appSpctl.stdout}`,
      );
    }
    if (dmgPath) {
      const dmgSpctl = await execRunner(
        'spctl',
        ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmgPath],
        { capture: true },
      );
      if (dmgSpctl.exitCode !== 0) {
        throw new Error(
          `Gatekeeper check (spctl -t open) failed for ${dmgPath}: ${dmgSpctl.stderr || dmgSpctl.stdout}`,
        );
      }
    }
  }

  return entitlementCheck;
}

export async function signAndNotarizeMacosDesktop(options = {}, env = process.env) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS signing and notarization can only run on macOS (darwin).');
  }

  const appPath = resolve(options.app);
  if (!existsSync(appPath)) {
    throw new Error(`App bundle not found: ${appPath}`);
  }
  const dmgPath = options.dmg ? resolve(options.dmg) : null;
  const verifyOnly = options.verifyOnly === true;

  if (verifyOnly) {
    const check = await verifyMacosBundle({
      appPath,
      dmgPath,
      requireGatekeeper: options.requireGatekeeper === true,
    });
    console.log(
      `[macos-sign] Verified ${appPath} and sidecar SEA entitlements (${check.verifiedEntitlements.join(', ')})`,
    );
    return { mode: 'verify-only', appPath, dmgPath, notarized: false, ...check };
  }

  const signing = resolveSigningConfig(options, env);
  const nestedBinaries = discoverNestedBinaries(appPath);
  const nestedBundles = discoverNestedBundles(appPath);
  const includeSidecar = existsSync(join(appPath, 'Contents', 'MacOS', 'kiki-server'));
  const plan = buildBundleCodesignPlan({
    appPath,
    identity: signing.identity,
    entitlementsPath: signing.entitlementsPath,
    appEntitlementsPath: signing.appEntitlementsPath,
    keychainPath: signing.keychainPath,
    nestedBinaries,
    nestedBundles,
    includeSidecar,
  });

  console.log(
    `[macos-sign] Signing ${appPath} with identity="${signing.identity}" (${signing.adHoc ? 'ad-hoc fallback' : 'Developer ID Hardened Runtime'})`,
  );
  for (const step of plan) {
    console.log(`[macos-sign] codesign ${step.label}`);
    await runCommand('codesign', step.args);
  }

  const preNotaryCheck = await verifyMacosBundle({
    appPath,
    dmgPath: null,
    requireGatekeeper: false,
  });
  console.log(
    `[macos-sign] Verified bundle signature and sidecar SEA entitlements: ${preNotaryCheck.verifiedEntitlements.join(', ')}`,
  );

  if (dmgPath) {
    console.log(`[macos-sign] Rebuilding DMG from signed app: ${dmgPath}`);
    rebuildDmgFromApp(appPath, dmgPath);
    if (!signing.adHoc) {
      const dmgSignArgs = buildSingleCodesignArgs({
        identity: signing.identity,
        targetPath: dmgPath,
        entitlementsPath: null,
        keychainPath: signing.keychainPath,
        hardenedRuntime: false,
        timestamp: true,
      });
      console.log(`[macos-sign] Signing DMG: ${dmgPath}`);
      await runCommand('codesign', dmgSignArgs);
    }
  }

  let notarized = false;
  if (options.notarize === true) {
    if (signing.adHoc) {
      if (options.requireNotarize === true) {
        throw new Error(
          'Notarization requested (--require-notarize), but no Developer ID Application signing identity was provided.',
        );
      }
      console.log('[macos-sign] Skipping notarization in ad-hoc mode (no APPLE_SIGNING_IDENTITY).');
    } else {
      const auth = resolveNotarizationAuth(options, env);
      if (auth === null) {
        if (options.requireNotarize === true) {
          throw new Error(
            'Notarization requested (--require-notarize), but no App Store Connect API Key or --keychain-profile was configured.',
          );
        }
        console.log(
          '[macos-sign] Skipping notarization: no App Store Connect API Key or keychain profile configured.',
        );
      } else {
        const artifactPath = dmgPath ?? appPath;
        console.log(
          `[macos-sign] Submitting ${artifactPath} for Apple notarization (mode=${auth.mode})...`,
        );
        await notarizeArtifact({
          artifactPath,
          auth,
          timeout: options.timeout ?? '15m',
        });

        console.log(`[macos-sign] Stapling ticket to ${appPath}`);
        await runCommand('xcrun', ['stapler', 'staple', appPath]);
        await runCommand('xcrun', ['stapler', 'validate', appPath]);

        if (dmgPath) {
          console.log(`[macos-sign] Stapling ticket to ${dmgPath}`);
          await runCommand('xcrun', ['stapler', 'staple', dmgPath]);
          await runCommand('xcrun', ['stapler', 'validate', dmgPath]);
        }

        await verifyMacosBundle({
          appPath,
          dmgPath,
          requireGatekeeper: true,
        });
        notarized = true;
        console.log('[macos-sign] Notarization, stapling, and Gatekeeper checks passed.');
      }
    }
  }

  return {
    mode: signing.adHoc ? 'ad-hoc' : 'developer-id',
    identity: signing.identity,
    appPath,
    dmgPath,
    notarized,
    ...preNotaryCheck,
  };
}

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      dmg: { type: 'string' },
      identity: { type: 'string' },
      keychain: { type: 'string' },
      entitlements: { type: 'string' },
      'app-entitlements': { type: 'string' },
      'keychain-profile': { type: 'string' },
      'api-key': { type: 'string' },
      'api-issuer': { type: 'string' },
      'api-key-path': { type: 'string' },
      timeout: { type: 'string', default: '15m' },
      notarize: { type: 'boolean', default: false },
      'require-notarize': { type: 'boolean', default: false },
      'verify-only': { type: 'boolean', default: false },
      'require-gatekeeper': { type: 'boolean', default: false },
    },
  });
  return {
    app: values.app,
    dmg: values.dmg,
    identity: values.identity,
    keychain: values.keychain,
    entitlements: values.entitlements,
    appEntitlements: values['app-entitlements'],
    keychainProfile: values['keychain-profile'],
    apiKey: values['api-key'],
    apiIssuer: values['api-issuer'],
    apiKeyPath: values['api-key-path'],
    timeout: values.timeout,
    notarize: values.notarize || values['require-notarize'],
    requireNotarize: values['require-notarize'],
    verifyOnly: values['verify-only'],
    requireGatekeeper: values['require-gatekeeper'],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (!cli.app) {
      throw new Error('Missing required argument: --app <path/to/Kiki.app>');
    }
    await signAndNotarizeMacosDesktop(cli);
  } catch (error) {
    process.stderr.write(
      `[macos-sign] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
