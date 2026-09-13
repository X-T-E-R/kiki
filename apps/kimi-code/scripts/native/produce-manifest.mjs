/**
 * Aggregate per-platform zip archive `.sha256` files into a single
 * `manifest.json` written into the same input directory.
 *
 * Usage:
 *   node produce-manifest.mjs <input-dir> <release-tag>
 *
 * Input dir must contain files matching: kimi-code-<target>.zip.sha256
 * (produced by package.mjs across the 6 native-build matrix runners).
 *
 * Output:
 *   <input-dir>/manifest.json
 *
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const [, , inputDir, tag] = process.argv;
if (!inputDir || !tag) {
  console.error('Usage: produce-manifest.mjs <input-dir> <release-tag>');
  process.exit(1);
}

// Tag 格式 `@kiki/cli@x.y.z` 或 `vx.y.z` 或 `x.y.z`，都归一化到 x.y.z
const version = tag.replace(/^@kiki\/cli@/, '').replace(/^v/, '');

const entries = await readdir(inputDir);
const sumFiles = entries.filter((f) => /^kimi-code-[a-z0-9-]+\.zip\.sha256$/.test(f));

if (sumFiles.length === 0) {
  console.error(`No kimi-code-<target>.zip.sha256 files found in ${inputDir}`);
  process.exit(1);
}

const platforms = {};
for (const sumFile of sumFiles.sort()) {
  const text = await readFile(resolve(inputDir, sumFile), 'utf-8');
  const [checksum] = text.trim().split(/\s+/, 1);
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
    console.error(`Invalid checksum in ${sumFile}: ${checksum}`);
    process.exit(1);
  }
  const filename = basename(sumFile, '.sha256');
  // kimi-code-darwin-arm64.zip → darwin-arm64
  const target = filename.replace(/^kimi-code-/, '').replace(/\.zip$/, '');
  platforms[target] = { filename, checksum };
}

const manifest = { version, tag, platforms };
const manifestPath = resolve(inputDir, 'manifest.json');

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${manifestPath} (${Object.keys(platforms).length} platforms)`);
