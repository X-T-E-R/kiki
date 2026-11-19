import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const mobileRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(mobileRoot, '../../..');
const mode = process.argv[2] ?? 'build';

if (mode === '--typecheck') {
  const tscBin = join(repoRoot, 'node_modules/typescript/bin/tsc');
  if (!existsSync(tscBin)) {
    throw new Error(`Missing TypeScript compiler at ${tscBin}; run pnpm install at repo root.`);
  }
  execFileSync(process.execPath, [tscBin, '-p', join(mobileRoot, 'tsconfig.json'), '--noEmit'], {
    cwd: mobileRoot,
    stdio: 'inherit',
  });
  process.exit(0);
}

const tsdownBin = join(repoRoot, 'node_modules/tsdown/dist/run.mjs');
if (!existsSync(tsdownBin)) {
  throw new Error(`Missing tsdown at ${tsdownBin}; run pnpm install at repo root.`);
}

execFileSync(
  process.execPath,
  [tsdownBin, '--config', join(mobileRoot, 'tsdown.config.ts')],
  {
    cwd: mobileRoot,
    stdio: 'inherit',
  },
);
