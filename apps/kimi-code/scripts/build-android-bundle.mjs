import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { copyKikiDocs } from './local-docs.mjs';
import { resolvePnpmInvocation } from './native/01-bundle.mjs';
import { run } from './native/exec.mjs';
import { copySourceOwnedAdapterAssets } from './native/external-harness-assets.mjs';
import { copyHistoryImportAssets } from './native/history-assets.mjs';

const requireFromScript = createRequire(import.meta.url);
const tsdownCliPath = requireFromScript.resolve('tsdown/run');

const appRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(appRoot, '../..');
const outDir = resolve(appRoot, 'dist-android');
const archivePath = resolve(outDir, 'kiki-dist.tar.xz');

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const allowedOptionalExternals = new Set([
  '@napi-rs/keyring',
  '@kiki/auth-native',
  'node-pty',
  '@mariozechner/clipboard',
  'ajv-formats/dist/formats',
  'ajv/dist/runtime/validation_error',
  'bufferutil',
  'canvas',
  'chokidar',
  'cpu-features',
  'fast-json-stringify/lib/serializer',
  'fast-json-stringify/lib/validator',
  'utf-8-validate',
  'zlib-sync',
]);

const allowedOptionalRelativeRequires = new Set(['./crypto/build/Release/sshcrypto.node']);

function executableLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'));
}

export function verifySelfContainedBundle(bundlePath, { worker = false } = {}) {
  if (!existsSync(bundlePath)) return [`bundle does not exist: ${bundlePath}`];
  const text = readFileSync(bundlePath, 'utf-8');
  const errors = [];
  const allowedExternal = worker ? new Set() : allowedOptionalExternals;
  const allowedRelative = worker ? new Set() : allowedOptionalRelativeRequires;

  const checkSpecifier = (specifier, kind) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (!allowedRelative.has(specifier)) errors.push(`relative ${kind} remains: ${specifier}`);
      return;
    }
    if (!builtins.has(specifier) && !specifier.startsWith('node:') && !allowedExternal.has(specifier)) {
      errors.push(`external ${kind} remains: ${specifier}`);
    }
  };

  for (const line of executableLines(text)) {
    for (const match of line.matchAll(/(?<![.\w])require\(\s*["']([^"']+)["']\s*\)/g)) {
      checkSpecifier(match[1], 'require');
    }
    for (const match of line.matchAll(/(?<![.\w])import\(\s*["']([^"']+)["']\s*\)/g)) {
      checkSpecifier(match[1], 'dynamic import');
    }
    if (line.startsWith('import ')) {
      for (const match of line.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        checkSpecifier(match[1], 'import');
      }
      const sideEffect = line.match(/^import\s*["']([^"']+)["']/);
      if (sideEffect) checkSpecifier(sideEffect[1], 'import');
    }
  }
  return errors;
}

async function collectFiles(root) {
  const entries = [];
  async function walk(dir) {
    const items = (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const fullPath = join(dir, item.name);
      if (fullPath === archivePath) continue;
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const rel = relative(root, fullPath).replaceAll('\\', '/');
        if (rel === 'manifest.json' || rel === 'kiki-dist.tar.xz') continue;
        const bytes = await readFile(fullPath);
        entries.push({
          path: rel,
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  await walk(root);
  return entries;
}

function createUstarHeader({ name, size, mode = 0o644, mtime = 0, typeflag = '0' }) {
  const normalized = name.replaceAll('\\', '/').replace(/^\.\//, '');
  let prefix = '';
  let filename = normalized;
  if (Buffer.byteLength(filename, 'utf8') > 100) {
    const slash = filename.lastIndexOf('/');
    if (slash <= 0) throw new Error(`Tar entry name exceeds 100 bytes without directory prefix: ${normalized}`);
    prefix = filename.slice(0, slash);
    filename = filename.slice(slash + 1);
    if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(filename, 'utf8') > 100) {
      throw new Error(`Tar entry path exceeds USTAR limits: ${normalized}`);
    }
  }

  const header = Buffer.alloc(512, 0);
  header.write(filename, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write(`${Math.floor(mtime).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix.length > 0) header.write(prefix, 345, 155, 'utf8');

  let checksum = 0;
  for (let i = 0; i < 512; i += 1) checksum += header[i];
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

async function writeTarFile(rootDir, tarOutPath, relPaths) {
  const chunks = [];
  const dirs = new Set();
  for (const rel of relPaths) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(`${parts.slice(0, i).join('/')}/`);
    }
  }
  for (const dir of [...dirs].toSorted()) {
    chunks.push(createUstarHeader({ name: dir, size: 0, mode: 0o755, typeflag: '5' }));
  }
  for (const rel of relPaths) {
    const fullPath = resolve(rootDir, rel);
    const bytes = await readFile(fullPath);
    const mode = rel.endsWith('.mjs') ? 0o755 : 0o644;
    chunks.push(createUstarHeader({ name: rel, size: bytes.byteLength, mode, typeflag: '0' }));
    chunks.push(bytes);
    const remainder = bytes.byteLength % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  await writeFile(tarOutPath, Buffer.concat(chunks));
}

export async function buildAndroidBundle() {
  const pnpm = resolvePnpmInvocation();
  const skipGui = process.env.KIKI_ANDROID_SKIP_GUI_BUILD === '1';
  const guiDist = resolve(appRoot, '..', 'kiki-gui', 'dist');
  if (!skipGui || !existsSync(resolve(guiDist, 'index.html'))) {
    await run(pnpm.command, [...pnpm.args, '-C', '../kiki-gui', 'build']);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await run(process.execPath, [tsdownCliPath, '--config', 'tsdown.android.config.ts']);

  await cp(guiDist, resolve(outDir, 'web'), { recursive: true });
  await cp(
    resolve(repoRoot, 'packages/agent-core-v2/src/app/plugin/hostRunner.mjs'),
    resolve(outDir, 'hostRunner.mjs'),
  );
  await cp(
    resolve(repoRoot, 'packages/kap-server/vendor/litellm/model_prices_and_context_window.json'),
    resolve(outDir, 'model_prices_and_context_window.json'),
  );
  await copyHistoryImportAssets({ appRoot, outDir });
  await copySourceOwnedAdapterAssets({ repoRoot, outDir });
  await copyKikiDocs({
    sourceDir: resolve(repoRoot, 'docs'),
    targetDir: resolve(outDir, 'docs'),
  });

  const workerNames = [
    'text-build-worker.mjs',
    'sqlite-indexer.mjs',
    'sqlite-query-worker.mjs',
    'usage-parser-worker.mjs',
    'query-store-worker.mjs',
    'usage-read-model-worker.mjs',
    'mailbox-worker.mjs',
    'memory-worker.mjs',
    'cpu-worker.mjs',
  ];

  const bundlesToCheck = [
    { path: resolve(outDir, 'entry.mjs'), worker: false },
    ...workerNames.map((name) => ({ path: resolve(outDir, name), worker: true })),
  ];

  let checkFailed = false;
  for (const item of bundlesToCheck) {
    const errors = verifySelfContainedBundle(item.path, { worker: item.worker });
    if (errors.length === 0) continue;
    checkFailed = true;
    console.error(`Android JS bundle verification failed for ${item.path}:`);
    for (const err of errors) console.error(`  - ${err}`);
  }
  if (checkFailed) {
    throw new Error('Android bundle contains unbundled external or relative imports');
  }

  const pkg = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'));
  const files = await collectFiles(outDir);
  const contentDigest = createHash('sha256');
  for (const entry of files) {
    contentDigest.update(`${entry.path}:${entry.sha256}\n`);
  }
  const bundleSha256 = contentDigest.digest('hex');

  const manifest = {
    schemaVersion: 1,
    version: pkg.version,
    entry: 'entry.mjs',
    webDir: 'web',
    workers: workerNames,
    sha256: bundleSha256,
    fileCount: files.length,
    files,
  };
  const manifestPath = resolve(outDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const tarTempPath = resolve(outDir, 'kiki-dist.tar');
  const archiveEntries = [...files.map((item) => item.path), 'manifest.json'].toSorted();
  await writeTarFile(outDir, tarTempPath, archiveEntries);
  await rm(archivePath, { force: true });
  await run('xz', ['-T0', '-6', '-z', tarTempPath]);

  const archiveStat = await stat(archivePath);
  const archiveSha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  console.log(
    `[build-android-bundle] Built ${archivePath} (${(archiveStat.size / (1024 * 1024)).toFixed(2)} MiB, sha256=${archiveSha256}, files=${archiveEntries.length})`,
  );
  return { outDir, archivePath, archiveSha256, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildAndroidBundle();
}
