import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { run } from './exec.mjs';

const requireFromScript = createRequire(import.meta.url);
const tsdownCliPath = requireFromScript.resolve('tsdown/run');
const checkBundlePath = resolve(import.meta.dirname, 'check-bundle.mjs');
const copyWebAssetsPath = resolve(import.meta.dirname, '..', 'copy-web-assets.mjs');

export function resolvePnpmInvocation(
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  fileExists = existsSync,
) {
  const cliPath = env.npm_execpath?.trim();
  if (cliPath) return { command: nodePath, args: [cliPath] };
  const corepackPnpmPath = resolve(dirname(nodePath), 'node_modules', 'corepack', 'dist', 'pnpm.js');
  if (fileExists(corepackPnpmPath)) {
    return { command: nodePath, args: [corepackPnpmPath] };
  }
  return { command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] };
}

export async function runBundleStep() {
  const pnpm = resolvePnpmInvocation();
  await run(pnpm.command, [...pnpm.args, '-C', '../kiki-gui', 'build']);
  await run(process.execPath, [copyWebAssetsPath]);
  await run(process.execPath, [tsdownCliPath, '--config', 'tsdown.native.config.ts']);
  // Bundle the off-main-thread workers (the minidb text-build worker and
  // the kap-server global-search worker) into self-contained ESM files so
  // they can ride the SEA blob as assets (02-sea-blob.mjs) and be spawned
  // from disk at runtime — bundled binaries otherwise lack the worker
  // entries and heavy index work degrades to inline main-thread cores.
  // Runs after the main bundle with clean:false so all verified files remain.
  await run(process.execPath, [tsdownCliPath, '--config', 'tsdown.worker.config.ts']);
  await run(process.execPath, [checkBundlePath]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBundleStep();
}
