#!/usr/bin/env node
/* eslint-disable no-console -- CLI verification script. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

export const REQUIRED_ELECTRON_FUSES = Object.freeze({
  [FuseV1Options.RunAsNode]: FuseState.ENABLE,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
});

export function verifyFuseConfig(
  fuseWire,
  options = { packaged: false },
) {
  const failures = [];
  if (fuseWire[FuseV1Options.RunAsNode] !== FuseState.ENABLE) {
    failures.push(
      'Fuse RunAsNode MUST be enabled so Kiki can spawn detached kiki-server via ELECTRON_RUN_AS_NODE=1.',
    );
  }
  if (fuseWire[FuseV1Options.GrantFileProtocolExtraPrivileges] !== FuseState.DISABLE) {
    failures.push(
      'Fuse GrantFileProtocolExtraPrivileges MUST be disabled (main GUI runs over loopback HTTP, never file://).',
    );
  }
  if (options.packaged && fuseWire[FuseV1Options.OnlyLoadAppFromAsar] !== FuseState.ENABLE) {
    failures.push('Packaged Electron builds MUST enable OnlyLoadAppFromAsar.');
  }
  return { ok: failures.length === 0, failures };
}

export async function verifyElectronBinaryFuses(binaryPath, options = { packaged: false }) {
  if (!existsSync(binaryPath)) {
    throw new Error(`Electron binary does not exist: ${binaryPath}`);
  }
  const fuseWire = await getCurrentFuseWire(binaryPath);
  const verdict = verifyFuseConfig(fuseWire, options);
  return { binaryPath, fuseWire, ...verdict };
}

async function main() {
  const args = process.argv.slice(2);
  const packaged = args.includes('--packaged');
  const binaryArg = args.find((arg) => !arg.startsWith('--'));
  if (!binaryArg) {
    console.log(
      'verify-fuses: policy check OK (RunAsNode=ENABLE, GrantFileProtocolExtraPrivileges=DISABLE). Pass <electron-binary-path> [--packaged] to inspect a built binary.',
    );
    return;
  }
  const result = await verifyElectronBinaryFuses(resolve(binaryArg), { packaged });
  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(`verify-fuses FAILED: ${failure}`);
    }
    process.exit(1);
  }
  console.log(`verify-fuses OK: ${result.binaryPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
