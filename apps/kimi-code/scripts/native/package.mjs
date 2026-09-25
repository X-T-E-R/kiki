import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { nativeArtifactsDir, nativeBinPath, targetTriple } from './paths.mjs';

const target = targetTriple();
const sourceBinary = nativeBinPath(target);
const artifactsDir = nativeArtifactsDir();

// GitHub Release assets are flat; keep the target in each executable's name.
const artifactName = `kiki-${target}${process.platform === 'win32' ? '.exe' : ''}`;
const artifactPath = resolve(artifactsDir, artifactName);
const checksumPath = `${artifactPath}.sha256`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function sha256(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

let sourceStat;
try {
  sourceStat = await stat(sourceBinary);
} catch {
  fail(`Native executable not found at ${sourceBinary}. Run build:native:sea first.`);
}
if (!sourceStat.isFile() || sourceStat.size === 0) fail(`Native executable is empty or not a file: ${sourceBinary}`);

await mkdir(artifactsDir, { recursive: true });
await copyFile(sourceBinary, artifactPath);
if (process.platform !== 'win32') await chmod(artifactPath, 0o755);

const digest = await sha256(artifactPath);
await writeFile(checksumPath, `${digest}  ${basename(artifactPath)}\n`);

console.log(`Wrote native artifact: ${artifactPath}`);
console.log(`Wrote artifact checksum: ${checksumPath}`);
