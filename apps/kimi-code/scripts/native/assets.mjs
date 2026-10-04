import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  KAP_MODEL_PRICES_ASSET,
  KAP_SEARCH_WORKER_ASSET,
  KAP_SQLITE_QUERY_WORKER_ASSET,
  MINIDB_TEXT_BUILD_WORKER_ASSET,
  PLUGIN_HOST_RUNNER_ASSET,
  NATIVE_ASSET_MANIFEST_VERSION,
  buildManifestKey,
  buildRuntimeAssetKey,
  kikiDocsAsset,
} from './manifest.mjs';
import { nativeDeps, resolveTargetDeps, SUPPORTED_TARGETS } from './native-deps.mjs';
import { collectBrowserDriverAssets } from './browser-assets.mjs';
import { collectHistoryImportAssets } from './history-assets.mjs';
import { copyKikiDocs } from '../local-docs.mjs';

export { NATIVE_ASSET_MANIFEST_VERSION };

// Re-export for any external consumer that still needs it. Internally we
// use resolveTargetDeps() exclusively — no more if/else against package names.
export const NATIVE_TARGETS = Object.freeze(
  Object.fromEntries(
    SUPPORTED_TARGETS.map((t) => {
      const deps = resolveTargetDeps(t);
      const clipboardTarget = deps.find((d) => d.id === 'clipboard-target')?.resolvedName;
      return [t, { clipboardPackage: clipboardTarget }];
    }),
  ),
);

const jsExtensions = ['.js', '.cjs', '.mjs', '.json', '.node'];
const runtimeEntryNames = ['index.js', 'index.cjs', 'index.mjs'];

function fail(message) {
  throw new Error(message);
}

function toPosixPath(path) {
  return path.split('\\').join('/');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function listFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files;
}

export async function collectKikiDocAssets({ appRoot, target }) {
  const targetDir = resolve(appRoot, 'dist-native', 'intermediates', 'native-assets', target, 'kiki-docs');
  await rm(targetDir, { recursive: true, force: true });
  const docs = await copyKikiDocs({ sourceDir: resolve(appRoot, '..', '..', 'docs'), targetDir });
  const runtimeFiles = [];
  /** @type {Record<string, string>} */
  const assets = {};
  for (const doc of docs) {
    const asset = kikiDocsAsset(doc.relativePath);
    const assetKey = buildRuntimeAssetKey(target, asset.key);
    runtimeFiles.push({ ...asset, assetKey, sha256: sha256(doc.bytes) });
    assets[assetKey] = doc.path;
  }
  return { runtimeFiles, assets };
}

function resolvePackageRootGeneric(requireFromApp, packageName, parentPackageName, parentRoot, appRoot, target) {
  try {
    return dirname(requireFromApp.resolve(`${packageName}/package.json`));
  } catch (rootError) {
    if (parentRoot !== null) {
      try {
        const requireFromParent = createRequire(join(parentRoot, 'package.json'));
        return dirname(requireFromParent.resolve(`${packageName}/package.json`));
      } catch {}
    }
    fail(
      [
        `Native asset package is not installed for target ${target}: ${packageName}`,
        parentPackageName ? `Searched via parent: ${parentPackageName}` : '',
        `Resolve root: ${appRoot}`,
        'Run pnpm install --frozen-lockfile before building native assets.',
        rootError instanceof Error ? rootError.message : String(rootError),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function resolveFileCandidate(path) {
  if (existsSync(path)) return path;
  for (const extension of jsExtensions) {
    const candidate = `${path}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const entryName of runtimeEntryNames) {
    const candidate = join(path, entryName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePackageEntry(packageRoot, packageJson) {
  const rawMain =
    typeof packageJson.main === 'string'
      ? packageJson.main
      : typeof packageJson.module === 'string'
        ? packageJson.module
        : 'index.js';
  return resolveFileCandidate(resolve(packageRoot, rawMain));
}

function relativeRuntimeSpecifiers(text) {
  const specifiers = new Set();
  for (const match of text.matchAll(/\brequire\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/(?<![.\w])import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    specifiers.add(match[1]);
  }
  return [...specifiers];
}

async function addRuntimeDependencyFiles(packageRoot, filePath, selected) {
  const extension = extname(filePath);
  if (!['.js', '.cjs', '.mjs'].includes(extension)) return;

  let text;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch {
    return;
  }

  for (const specifier of relativeRuntimeSpecifiers(text)) {
    const candidate = resolveFileCandidate(resolve(dirname(filePath), specifier));
    if (candidate === null) continue;
    if (candidate.endsWith('.node')) continue;
    const packageRelativePath = relative(packageRoot, candidate);
    if (
      packageRelativePath.startsWith('..') ||
      isAbsolute(packageRelativePath) ||
      packageRelativePath.length === 0
    ) {
      continue;
    }
    if (selected.has(candidate)) continue;
    selected.add(candidate);
    await addRuntimeDependencyFiles(packageRoot, candidate, selected);
  }
}

async function collectPackageFiles({
  packageName,
  packageRoot,
  includeNativeFiles,
  includeEntryJs = true,
  nativeFileRelatives = [],
}) {
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  const selected = new Set([packageJsonPath]);

  if (includeEntryJs) {
    const entry = resolvePackageEntry(packageRoot, packageJson);
    if (entry !== null) {
      selected.add(entry);
      await addRuntimeDependencyFiles(packageRoot, entry, selected);
    }
  }

  for (const nativeFileRelative of nativeFileRelatives) {
    const nativeFile = resolve(packageRoot, nativeFileRelative);
    if (!existsSync(nativeFile)) {
      fail(`Native package ${packageName} does not contain ${nativeFileRelative} at ${packageRoot}`);
    }
    selected.add(nativeFile);
  }

  if (includeNativeFiles) {
    const files = await listFiles(packageRoot);
    for (const file of files) {
      if (file.endsWith('.node')) {
        selected.add(file);
      }
    }
  }

  const sorted = [...selected].sort((a, b) => a.localeCompare(b));
  if (includeNativeFiles && !sorted.some((file) => file.endsWith('.node'))) {
    fail(`Native package ${packageName} does not contain a .node file at ${packageRoot}`);
  }
  return sorted;
}

export async function collectAuthNativePackage({ packageRoot, target }) {
  if (!SUPPORTED_TARGETS.includes(target)) fail(`Unsupported auth-native target: ${target}`);
  const files = await collectPackageFiles({
    packageName: '@kiki/auth-native', packageRoot, includeNativeFiles: false,
    nativeFileRelatives: [`prebuilds/${target}/auth-native.node`, 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/Apache-2.0.txt', 'licenses/upstream-mit.txt', 'licenses/rust-dependencies.json'],
  });
  files.push(...await listFiles(join(packageRoot, 'licenses/rust')));
  if (target === `${process.platform}-${process.arch}`) {
    const binding = createRequire(join(packageRoot, 'package.json'))(packageRoot);
    for (const name of ['ageEncrypt', 'ageDecrypt', 'tryAcquireGrokAuthLock', 'acquireGrokAuthLock', 'canonicalizeOriginalHome']) {
      if (typeof binding[name] !== 'function') fail(`auth-native binding is missing ${name}`);
    }
  }
  return packageManifestEntries({ packageName: '@kiki/auth-native', packageRoot, files: [...new Set(files)].sort(), target });
}

export async function collectNodePtyPackage({ packageRoot, target }) {
  if (!SUPPORTED_TARGETS.includes(target)) fail(`Unsupported node-pty target: ${target}`);
  const nativeDir = target === `${process.platform}-${process.arch}` &&
    existsSync(join(packageRoot, 'build/Release/pty.node'))
    ? 'build/Release'
    : `prebuilds/${target}`;
  const nativeNames = target.startsWith('win32-')
    ? ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe',
      'conpty/conpty.dll', 'conpty/OpenConsole.exe']
    : target.startsWith('darwin-') ? ['pty.node', 'spawn-helper'] : ['pty.node'];
  const files = await collectPackageFiles({
    packageName: 'node-pty', packageRoot, includeNativeFiles: false,
    nativeFileRelatives: nativeNames.map((name) => `${nativeDir}/${name}`),
  });
  // Workers and the console-list agent are addressed dynamically by upstream.
  // Preserve the complete runtime JS unit, not just literal require() edges.
  for (const file of await listFiles(join(packageRoot, 'lib'))) {
    if (file.endsWith('.js') && !file.endsWith('.test.js')) files.push(file);
  }
  for (const licensePath of target.startsWith('win32-') ? ['LICENSE', 'deps/winpty/LICENSE'] : ['LICENSE']) {
    const license = join(packageRoot, licensePath);
    if (!existsSync(license)) fail(`node-pty license is missing at ${license}`);
    files.push(license);
  }
  if (target === `${process.platform}-${process.arch}`) {
    const requireFromPackage = createRequire(join(packageRoot, 'package.json'));
    for (const name of nativeNames.filter((name) => name.endsWith('.node'))) {
      try {
        requireFromPackage(join(packageRoot, nativeDir, name));
      } catch (error) {
        fail(`node-pty ${target} binding ${name} cannot load in Node ${process.versions.node} (ABI ${process.versions.modules}): ${error}`);
      }
    }
  }
  return packageManifestEntries({
    packageName: 'node-pty', packageRoot,
    files: [...new Set(files)].sort((a, b) => a.localeCompare(b)), target,
    executableFiles: new Set(target.startsWith('darwin-') ? [join(packageRoot, nativeDir, 'spawn-helper')] : []),
  });
}

async function packageManifestEntries({ packageName, packageRoot, files, target, executableFiles = new Set() }) {
  const root = `node_modules/${packageName}`;
  const entries = [];
  const assets = {};

  for (const file of files) {
    const sourceBytes = await readFile(file);
    const packageRelativePath = toPosixPath(relative(packageRoot, file));
    const relativePath = `${root}/${packageRelativePath}`;
    const assetKey = `native/${target}/${relativePath}`;
    entries.push({
      assetKey,
      relativePath,
      sha256: sha256(sourceBytes),
      mode: executableFiles.has(file) ? 0o755 : undefined,
    });
    assets[assetKey] = file;
  }

  return {
    packageManifest: {
      name: packageName,
      root,
      files: entries,
    },
    assets,
  };
}

export const nativeAssetManifestKey = buildManifestKey;

export function nativeAssetSummary(manifest) {
  return [
    ...manifest.packages.map((pkg) => `${pkg.name}: ${pkg.files.length} files`),
    `runtime: ${manifest.runtimeFiles.length} files`,
  ];
}

export async function collectNativeAssets({ appRoot, target }) {
  const requireFromApp = createRequire(pathToFileURL(resolve(appRoot, 'package.json')));
  const targetDeps = resolveTargetDeps(target); // throws on unsupported target

  const manifestPackages = [];
  const assets = {};
  const packageRoots = new Map();
  function resolveDepRoot(dep) {
    if (packageRoots.has(dep.id)) return packageRoots.get(dep.id);
    const parent = dep.parent === null ? null : nativeDeps.find((item) => item.id === dep.parent);
    const parentRoot = parent === null || parent === undefined ? null : resolveDepRoot(parent);
    const root = resolvePackageRootGeneric(
      requireFromApp,
      dep.name(target),
      parent?.name(target) ?? null,
      parentRoot,
      appRoot,
      target,
    );
    packageRoots.set(dep.id, root);
    return root;
  }

  for (const dep of targetDeps) {
    const packageRoot = resolveDepRoot(dep);
    const result = dep.collect === 'node-pty'
      ? await collectNodePtyPackage({ packageRoot, target })
      : dep.collect === 'auth-native'
        ? await collectAuthNativePackage({ packageRoot, target })
        : await packageManifestEntries({
        packageName: dep.resolvedName, packageRoot, target,
        files: await collectPackageFiles({
          packageName: dep.resolvedName,
          packageRoot,
          includeNativeFiles: dep.collect === 'native-files',
          includeEntryJs: dep.collect !== 'native-file-only',
          nativeFileRelatives: dep.nativeFileRelatives,
        }),
      });
    manifestPackages.push(result.packageManifest);
    Object.assign(assets, result.assets);
  }

  const runtimeFiles = [];
  for (const [runtimeSource, asset] of [
    [
      resolve(appRoot, 'dist-native', 'intermediates', 'text-build-worker.mjs'),
      MINIDB_TEXT_BUILD_WORKER_ASSET,
    ],
    [
      resolve(appRoot, 'dist-native', 'intermediates', 'search-worker.mjs'),
      KAP_SEARCH_WORKER_ASSET,
    ],
    [
      resolve(appRoot, 'dist-native', 'intermediates', 'sqlite-query-worker.mjs'),
      KAP_SQLITE_QUERY_WORKER_ASSET,
    ],
    [
      resolve(appRoot, '..', '..', 'packages', 'agent-core-v2', 'src', 'app', 'plugin', 'hostRunner.mjs'),
      PLUGIN_HOST_RUNNER_ASSET,
    ],
    [
      resolve(
        appRoot,
        '..',
        '..',
        'packages',
        'kap-server',
        'vendor',
        'litellm',
        'model_prices_and_context_window.json',
      ),
      KAP_MODEL_PRICES_ASSET,
    ],
  ]) {
    const runtimeBytes = await readFile(runtimeSource);
    const runtimeAssetKey = buildRuntimeAssetKey(target, asset.key);
    runtimeFiles.push({
      key: asset.key,
      assetKey: runtimeAssetKey,
      relativePath: asset.relativePath,
      sha256: sha256(runtimeBytes),
      mode: asset.mode,
    });
    assets[runtimeAssetKey] = runtimeSource;
  }

  const docs = await collectKikiDocAssets({ appRoot, target });
  runtimeFiles.push(...docs.runtimeFiles);
  Object.assign(assets, docs.assets);

  const browser = await collectBrowserDriverAssets({ appRoot, target });
  runtimeFiles.push(...browser.runtimeFiles);
  Object.assign(assets, browser.assets);

  const history = await collectHistoryImportAssets({ appRoot, target });
  runtimeFiles.push(...history.runtimeFiles);
  Object.assign(assets, history.assets);

  const manifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target,
    packages: manifestPackages,
    runtimeFiles,
  };

  return {
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    assets,
  };
}
