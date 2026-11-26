#!/usr/bin/env node
/* eslint-disable no-console -- Unpacked Electron packaging driver with local electronDist and fuse/receipt verification. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build as buildElectron, DIR_TARGET, Platform } from 'electron-builder';
import { build as buildTsdown } from 'tsdown';
import { stageDesktopServer } from './stage-server.mjs';
import { writeElectronBuildReceipt } from './write-build-receipt.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, '..');
process.chdir(desktopRoot);
const requireFromDesktop = createRequire(pathToFileURL(join(desktopRoot, 'package.json')));
const desktopPkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));
const desktopVersion = String(desktopPkg.version ?? '').trim();
if (!desktopVersion) {
  throw new Error('apps/kiki-desktop/package.json is missing a valid version');
}
const buildSha =
  process.env['VITE_BUILD_SHA']?.trim() ||
  process.env['KIKI_BUILD_SHA']?.trim() ||
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: desktopRoot, encoding: 'utf8' }).trim();

process.env['VITE_APP_VERSION'] = desktopVersion;
process.env['VITE_BUILD_SHA'] = buildSha;
process.env['KIKI_BUILD_SHA'] = buildSha;

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    'skip-gui-build': { type: 'boolean', default: false },
    'skip-stage-server': { type: 'boolean', default: false },
  },
});

if (!values['skip-stage-server']) {
  await stageDesktopServer({
    skipGuiBuild: Boolean(values['skip-gui-build']),
    env: {
      ...process.env,
      VITE_APP_VERSION: desktopVersion,
      VITE_BUILD_SHA: buildSha,
      KIKI_BUILD_SHA: buildSha,
    },
  });
}

console.log('[package-dir] Building Electron main and preload bundles...');
await buildTsdown({
  cwd: desktopRoot,
  config: resolve(desktopRoot, 'tsdown.config.ts'),
});

const electronPkgJson = requireFromDesktop.resolve('electron/package.json');
const electronDist = join(dirname(electronPkgJson), 'dist');
if (!existsSync(electronDist)) {
  throw new Error(`Installed Electron dist directory not found: ${electronDist}`);
}

process.env['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false';

console.log(`[package-dir] Packaging unpacked Electron app from local electronDist=${electronDist}...`);
const targets = Platform.current().createTarget(DIR_TARGET);
try {
  await buildElectron({
    projectDir: desktopRoot,
    targets,
    publish: 'never',
    config: {
      electronDist,
    },
  });
} catch (error) {
  const msg = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  if (process.platform === 'win32' && /symbolic link|winCodeSign/i.test(msg)) {
    console.warn('[package-dir] winCodeSign symlink privilege unavailable; retrying with win.signAndEditExecutable=false...');
    await buildElectron({
      projectDir: desktopRoot,
      targets,
      publish: 'never',
      config: {
        electronDist,
        win: {
          signAndEditExecutable: false,
        },
      },
    });
  } else {
    throw error;
  }
}

if (process.platform === 'win32') {
  const unpackedDir = join(desktopRoot, 'out', 'win-unpacked');
  const unpackedExe = join(unpackedDir, 'kiki-desktop.exe');
  execFileSync(process.execPath, [join(scriptDir, 'verify-fuses.mjs'), unpackedExe, '--packaged'], {
    cwd: desktopRoot,
    stdio: 'inherit',
  });
  const receiptResult = await writeElectronBuildReceipt({ candidateDir: unpackedDir });
  console.log(`[package-dir] Verified unpacked release: ${unpackedExe} (releaseId=${receiptResult.releaseId})`);
}
