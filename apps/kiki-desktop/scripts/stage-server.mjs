#!/usr/bin/env node
/* eslint-disable no-console -- Build staging script for Electron server bundle and native addons. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { rebuild } from '@electron/rebuild';
import { build } from 'tsdown';
import { rawTextPlugin } from '../../../build/raw-text-plugin.mjs';
import { buildWindowsProcessHelper } from '../../../packages/agent-core-v2/scripts/build-windows-process-helper.mjs';
import {
  SOURCE_OWNED_ADAPTER_FILES,
} from '../../../scripts/external-harness/production-manifest.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from '../../kimi-code/scripts/built-in-catalog.mjs';
import { stageWindowsToolchain } from '../../kiki-gui/scripts/stage-windows-toolchain.mjs';
import { stageWebBundle } from '../../kiki-gui/scripts/web-bundle-integrity.mjs';
import { copyKikiDocs } from '../../kimi-code/scripts/local-docs.mjs';
import { resolvePnpmInvocation } from '../../kimi-code/scripts/native/01-bundle.mjs';
import { collectAuthNativePackage } from '../../kimi-code/scripts/native/assets.mjs';
import { checkBundle } from '../../kimi-code/scripts/native/check-bundle.mjs';
import { copySourceOwnedAdapterAssets } from '../../kimi-code/scripts/native/external-harness-assets.mjs';
import { copyHistoryImportAssets } from '../../kimi-code/scripts/native/history-assets.mjs';
import {
  CPU_WORKER_ASSET,
  KAP_HISTORY_NAVIGATION_WORKER_ASSET,
  KAP_MODEL_PRICES_ASSET,
  KAP_SQLITE_QUERY_WORKER_ASSET,
  KAP_USAGE_PARSER_WORKER_ASSET,
  MAILBOX_WORKER_ASSET,
  MEMORY_WORKER_ASSET,
  NATIVE_ASSET_MANIFEST_VERSION,
  PLUGIN_HOST_RUNNER_ASSET,
  PLUGIN_ISOLATION_WORKER_ASSET,
  QUERY_STORE_WORKER_ASSET,
  USAGE_READ_MODEL_WORKER_ASSET,
  WINDOWS_PROCESS_HELPER_ASSET,
  buildRuntimeAssetKey,
} from '../../kimi-code/scripts/native/manifest.mjs';
import { nativeDeps, resolveTargetDeps } from '../../kimi-code/scripts/native/native-deps.mjs';

const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '../..');
const kimiCodeRoot = resolve(repoRoot, 'apps/kimi-code');
const guiRoot = resolve(repoRoot, 'apps/kiki-gui');
const serverOutDir = resolve(desktopRoot, 'dist/server');

const requireFromDesktop = createRequire(pathToFileURL(resolve(desktopRoot, 'package.json')));
const requireFromKimiCode = createRequire(pathToFileURL(resolve(kimiCodeRoot, 'package.json')));

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const optionalNativeDependencies = new Set([
  '@napi-rs/keyring',
  '@kiki/auth-native',
  'node-pty',
  '@mariozechner/clipboard',
  'cpu-features',
  'zlib-sync',
]);

function shouldAlwaysBundle(id) {
  if (builtins.has(id) || id.startsWith('node:')) return false;
  if (optionalNativeDependencies.has(id)) return false;
  return true;
}

const cjsCompatBanner = [
  "import { createRequire as __kikiCreateRequire } from 'node:module';",
  "import { fileURLToPath as __kikiFileURLToPath } from 'node:url';",
  "import { dirname as __kikiDirname } from 'node:path';",
  'const require = __kikiCreateRequire(import.meta.url);',
  'const __filename = __kikiFileURLToPath(import.meta.url);',
  'const __dirname = __kikiDirname(__filename);',
].join('\n');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toPosixPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}`);
  }
}

function resolveGitCommit() {
  if (process.env['KIKI_COMMIT']) return process.env['KIKI_COMMIT'];
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function resolveFullGitSha() {
  const fromEnv = process.env['VITE_BUILD_SHA']?.trim() || process.env['KIKI_BUILD_SHA']?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

async function listFilesRecursive(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted((a, b) => a.localeCompare(b));
}

function resolveFileCandidate(filePath) {
  if (existsSync(filePath)) return filePath;
  for (const ext of ['.js', '.cjs', '.mjs', '.json', '.node']) {
    if (existsSync(`${filePath}${ext}`)) return `${filePath}${ext}`;
  }
  for (const entryName of ['index.js', 'index.cjs', 'index.mjs']) {
    const candidate = join(filePath, entryName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function collectJsAndNativePackageFiles(packageRoot, { includeNativeFiles, includeEntryJs = true, nativeFileRelatives = [] }) {
  const packageJsonPath = join(packageRoot, 'package.json');
  const pkgJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const selected = new Set([packageJsonPath]);

  async function walkRelativeJs(filePath) {
    const ext = extname(filePath);
    if (!['.js', '.cjs', '.mjs'].includes(ext)) return;
    const text = await readFile(filePath, 'utf8').catch(() => '');
    const specifiers = new Set([
      ...[...text.matchAll(/\brequire\(\s*["'](\.[^"']+)["']\s*\)/g)].map((m) => m[1]),
      ...[...text.matchAll(/(?<![.\w])import\(\s*["'](\.[^"']+)["']\s*\)/g)].map((m) => m[1]),
      ...[...text.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((m) => m[1]),
    ]);
    for (const spec of specifiers) {
      const candidate = resolveFileCandidate(resolve(dirname(filePath), spec));
      if (!candidate || candidate.endsWith('.node')) continue;
      const rel = relative(packageRoot, candidate);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || selected.has(candidate)) continue;
      selected.add(candidate);
      await walkRelativeJs(candidate);
    }
  }

  if (includeEntryJs) {
    const rawMain =
      typeof pkgJson.main === 'string'
        ? pkgJson.main
        : typeof pkgJson.module === 'string'
          ? pkgJson.module
          : 'index.js';
    const entry = resolveFileCandidate(resolve(packageRoot, rawMain));
    if (entry) {
      selected.add(entry);
      await walkRelativeJs(entry);
    }
  }

  for (const rel of nativeFileRelatives) {
    const full = resolve(packageRoot, rel);
    if (!existsSync(full)) {
      throw new Error(`Missing expected native file ${rel} in ${packageRoot}`);
    }
    selected.add(full);
  }

  if (includeNativeFiles) {
    for (const file of await listFilesRecursive(packageRoot)) {
      if (file.endsWith('.node')) selected.add(file);
    }
  }

  return [...selected].sort((a, b) => a.localeCompare(b));
}

async function rebuildNodePtyForElectron({ sourceNodePtyRoot, target, electronVersion, arch }) {
  const nodePtyPkg = JSON.parse(await readFile(join(sourceNodePtyRoot, 'package.json'), 'utf8'));
  const cacheDir = resolve(
    repoRoot,
    '.tmp',
    'electron-rebuild-cache',
    `node-pty-${nodePtyPkg.version}-electron-${electronVersion}-${target}`,
  );
  const nativeNames = target.startsWith('win32-')
    ? [
        'pty.node',
        'conpty.node',
        'conpty_console_list.node',
        'winpty.dll',
        'winpty-agent.exe',
        'conpty/conpty.dll',
        'conpty/OpenConsole.exe',
      ]
    : target.startsWith('darwin-')
      ? ['pty.node', 'spawn-helper']
      : ['pty.node'];

  const cachedReady = nativeNames.every((name) => existsSync(join(cacheDir, 'build/Release', name)));
  if (!cachedReady) {
    const workRoot = resolve(repoRoot, '.tmp', `kiki-node-pty-rebuild-${process.pid}-${Date.now()}`);
    const stagedNodePty = join(workRoot, 'node_modules', 'node-pty');
    const reqFromNodePty = createRequire(join(sourceNodePtyRoot, 'package.json'));
    const nodeAddonApiRoot = dirname(reqFromNodePty.resolve('node-addon-api/package.json'));
    await mkdir(dirname(stagedNodePty), { recursive: true });
    await writeFile(
      join(workRoot, 'package.json'),
      JSON.stringify({ name: 'kiki-pty-rebuild', private: true, dependencies: { 'node-pty': nodePtyPkg.version } }),
    );
    await cp(nodeAddonApiRoot, join(workRoot, 'node_modules', 'node-addon-api'), { recursive: true });
    await cp(sourceNodePtyRoot, stagedNodePty, { recursive: true });

    try {
      if (process.platform === 'win32') {
        for (const gypRel of ['binding.gyp', 'deps/winpty/src/winpty.gyp']) {
          const gypPath = join(stagedNodePty, gypRel);
          if (existsSync(gypPath)) {
            const raw = await readFile(gypPath, 'utf8');
            await writeFile(gypPath, raw.replaceAll("'SpectreMitigation': 'Spectre'", "'SpectreMitigation': 'false'"));
          }
        }
      }

      console.log(`[stage-server] Rebuilding node-pty@${nodePtyPkg.version} for Electron ${electronVersion} (${target})...`);
      await rebuild({
        buildPath: workRoot,
        electronVersion,
        arch,
        onlyModules: ['node-pty'],
        force: true,
      });

      if (target.startsWith('win32-')) {
        const prebuiltConptyDir = join(sourceNodePtyRoot, 'prebuilds', target, 'conpty');
        const destConptyDir = join(stagedNodePty, 'build', 'Release', 'conpty');
        await mkdir(destConptyDir, { recursive: true });
        for (const helperName of ['conpty.dll', 'OpenConsole.exe']) {
          await cp(join(prebuiltConptyDir, helperName), join(destConptyDir, helperName));
        }
      }

      await rm(cacheDir, { recursive: true, force: true });
      await mkdir(join(cacheDir, 'build', 'Release'), { recursive: true });
      await cp(join(stagedNodePty, 'package.json'), join(cacheDir, 'package.json'));
      await cp(join(stagedNodePty, 'lib'), join(cacheDir, 'lib'), { recursive: true });
      await cp(join(stagedNodePty, 'LICENSE'), join(cacheDir, 'LICENSE'));
      if (target.startsWith('win32-')) {
        await mkdir(join(cacheDir, 'deps', 'winpty'), { recursive: true });
        await cp(join(stagedNodePty, 'deps', 'winpty', 'LICENSE'), join(cacheDir, 'deps', 'winpty', 'LICENSE'));
      }
      for (const name of nativeNames) {
        const srcFile = join(stagedNodePty, 'build', 'Release', name);
        const dstFile = join(cacheDir, 'build', 'Release', name);
        await mkdir(dirname(dstFile), { recursive: true });
        await cp(srcFile, dstFile);
      }
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const unixTerminalJs = join(cacheDir, 'lib', 'unixTerminal.js');
  if (existsSync(unixTerminalJs)) {
    const rawUnixTerminal = await readFile(unixTerminalJs, 'utf8');
    const patchedUnixTerminal = rawUnixTerminal
      .replaceAll(
        "helperPath.replace('app.asar', 'app.asar.unpacked')",
        "helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked')",
      )
      .replaceAll(
        "helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked')",
        "helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked')",
      );
    if (patchedUnixTerminal !== rawUnixTerminal) {
      await writeFile(unixTerminalJs, patchedUnixTerminal, 'utf8');
    }
  }

  const files = [
    join(cacheDir, 'package.json'),
    join(cacheDir, 'LICENSE'),
    ...(target.startsWith('win32-') ? [join(cacheDir, 'deps', 'winpty', 'LICENSE')] : []),
    ...(await listFilesRecursive(join(cacheDir, 'lib'))).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')),
    ...nativeNames.map((name) => join(cacheDir, 'build', 'Release', name)),
  ];
  return { root: cacheDir, files: [...new Set(files)].sort((a, b) => a.localeCompare(b)) };
}

export async function stageDesktopServer({ skipGuiBuild = false, env = process.env } = {}) {
  const target = env['KIKI_BUILD_TARGET'] ?? `${process.platform}-${process.arch}`;
  const arch = target.split('-')[1] ?? process.arch;
  const pnpm = resolvePnpmInvocation();

  const electronPkgPath = requireFromDesktop.resolve('electron/package.json');
  const electronVersion = JSON.parse(readFileSync(electronPkgPath, 'utf8')).version;
  const electronBinaryPath = requireFromDesktop('electron');
  const kimiPkg = JSON.parse(readFileSync(join(kimiCodeRoot, 'package.json'), 'utf8'));
  const desktopPkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));
  const commit = resolveGitCommit();
  const buildSha = env['VITE_BUILD_SHA']?.trim() || env['KIKI_BUILD_SHA']?.trim() || resolveFullGitSha();
  const appVersion = env['VITE_APP_VERSION']?.trim() || String(desktopPkg.version || kimiPkg.version);
  const channel = env['KIKI_CHANNEL'] ?? 'desktop';

  const authPrebuild = resolve(repoRoot, 'packages/auth-native/prebuilds', target, 'auth-native.node');
  if (!existsSync(authPrebuild)) {
    console.log(`[stage-server] Building @kiki/auth-native for ${target}...`);
    runChecked(pnpm.command, [...pnpm.args, '--filter', '@kiki/auth-native', 'build'], {
      cwd: repoRoot,
      env,
    });
  }

  const guiDistIndex = resolve(guiRoot, 'dist/index.html');
  if (!skipGuiBuild || !existsSync(guiDistIndex)) {
    console.log(
      `[stage-server] Building @kiki/gui static web bundle (version=${appVersion}, sha=${buildSha.slice(0, 12)})...`,
    );
    runChecked(pnpm.command, [...pnpm.args, '--filter', '@kiki/gui', 'build'], {
      cwd: repoRoot,
      env: {
        ...env,
        VITE_APP_VERSION: appVersion,
        VITE_BUILD_SHA: buildSha,
        KIKI_BUILD_SHA: buildSha,
      },
    });
  }

  await rm(serverOutDir, { recursive: true, force: true });
  await mkdir(serverOutDir, { recursive: true });

  console.log('[stage-server] Bundling server-entry.mjs, sqlite-indexer.mjs, and 9 worker entries...');
  const bundleSpecs = [
    { name: 'server-entry', entry: resolve(kimiCodeRoot, 'src/native-entry.ts'), worker: false },
    { name: 'sqlite-indexer', entry: resolve(repoRoot, 'packages/kap-server/src/search/sqlite/indexerDev.ts'), worker: false },
    { name: 'sqlite-query-worker', entry: resolve(repoRoot, 'packages/kap-server/src/search/sqlite/queryEntry.ts'), worker: true },
    { name: 'history-navigation-worker', entry: resolve(repoRoot, 'packages/kap-server/src/services/history/worker/entry.ts'), worker: true },
    { name: 'usage-parser-worker', entry: resolve(repoRoot, 'packages/kap-server/src/usage/worker/entry.ts'), worker: true },
    { name: 'query-store-worker', entry: resolve(repoRoot, 'packages/agent-core-v2/src/persistence/backends/sqlite/entry.ts'), worker: true },
    { name: 'usage-read-model-worker', entry: resolve(repoRoot, 'packages/agent-core-v2/src/persistence/backends/sqlite/usageEntry.ts'), worker: true },
    { name: 'mailbox-worker', entry: resolve(repoRoot, 'packages/agent-core-v2/src/persistence/backends/sqliteMailbox/entry.ts'), worker: true },
    { name: 'memory-worker', entry: resolve(repoRoot, 'packages/agent-core-v2/src/persistence/backends/sqliteMemory/entry.ts'), worker: true },
    { name: 'cpu-worker', entry: resolve(repoRoot, 'packages/agent-core-v2/src/app/cpuWorker/entry.ts'), worker: true },
    { name: 'plugin-isolation-worker', entry: resolve(repoRoot, 'packages/agent-core-v2/src/app/cordisRuntime/isolationWorkerEntry.ts'), worker: true },
  ];

  for (const spec of bundleSpecs) {
    await build({
      config: false,
      name: spec.name,
      cwd: kimiCodeRoot,
      entry: { [spec.name]: spec.entry },
      format: ['esm'],
      outDir: serverOutDir,
      clean: false,
      dts: false,
      hash: false,
      platform: 'node',
      target: 'node24',
      sourcemap: false,
      minify: false,
      silent: true,
      banner: { js: cjsCompatBanner },
      plugins: [rawTextPlugin()],
      alias: {
        '@': resolve(kimiCodeRoot, 'src'),
      },
      define: {
        [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
        __KIKI_VERSION__: JSON.stringify(desktopPkg.version || kimiPkg.version),
        __KIKI_CHANNEL__: JSON.stringify(channel),
        __KIKI_COMMIT__: JSON.stringify(commit),
        __KIKI_BUILD_TARGET__: JSON.stringify(target),
        __KIKI_NATIVE_BUNDLE__: 'true',
      },
      deps: {
        alwaysBundle: spec.worker
          ? (id) => !builtins.has(id) && !id.startsWith('node:')
          : shouldAlwaysBundle,
        neverBundle: spec.worker ? [] : [...optionalNativeDependencies],
        onlyBundle: false,
      },
      outputOptions: {
        codeSplitting: false,
        entryFileNames: '[name].mjs',
      },
    });
  }

  for (const spec of bundleSpecs) {
    const bundlePath = join(serverOutDir, `${spec.name}.mjs`);
    const errors = checkBundle(bundlePath, { worker: spec.worker });
    if (errors.length > 0) {
      throw new Error(`Bundle check failed for ${bundlePath}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    }
  }

  console.log('[stage-server] Copying web bundle, product docs, pricing catalog, hostRunner, builtin & external-harness...');
  const webIntegrity = await stageWebBundle({
    sourceDistDir: resolve(guiRoot, 'dist'),
    targetWebDir: join(serverOutDir, 'web'),
    minFileCount: 100,
  });
  console.log(
    `[stage-server] Verified staged web bundle (${webIntegrity.fileCount} files, ${webIntegrity.referencedAssets.length} entry assets) -> ${webIntegrity.webDir}`,
  );
  await copyKikiDocs({ sourceDir: resolve(repoRoot, 'docs'), targetDir: join(serverOutDir, 'docs') });
  await cp(
    resolve(repoRoot, 'packages/agent-core-v2/src/app/plugin/hostRunner.mjs'),
    join(serverOutDir, 'hostRunner.mjs'),
  );
  await cp(
    resolve(repoRoot, 'packages/kap-server/vendor/litellm/model_prices_and_context_window.json'),
    join(serverOutDir, 'model_prices_and_context_window.json'),
  );
  await copyHistoryImportAssets({ appRoot: kimiCodeRoot, outDir: serverOutDir });
  await copySourceOwnedAdapterAssets({ repoRoot, outDir: serverOutDir });

  if (target.startsWith('win32-')) {
    await buildWindowsProcessHelper({
      target,
      outputDir: join(serverOutDir, 'native'),
      prebuiltPath: process.env['KIKI_WINDOWS_PROCESS_HELPER_ARTIFACT'],
    });
    const toolchainDir = resolve(desktopRoot, 'dist/toolchain');
    if (process.env['KIKI_SKIP_WINDOWS_TOOLCHAIN'] === '1') {
      await mkdir(toolchainDir, { recursive: true });
    } else {
      const rustWindowsTarget =
        arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const toolchain = await stageWindowsToolchain({
        target: rustWindowsTarget,
        outputDir: toolchainDir,
      });
      if (!toolchain.skipped) {
        const mb = (toolchain.bytes / (1024 * 1024)).toFixed(1);
        const mode = toolchain.reused ? 'reused cached' : 'staged';
        console.log(
          `[stage-server] ${mode} Windows toolchain (${toolchain.files} files, ${mb} MiB) -> ${toolchain.outputDir}`,
        );
      }
    }
  }

  await writeFile(
    join(serverOutDir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@kiki/desktop-server',
        version: desktopPkg.version,
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );

  console.log('[stage-server] Staging native addons under dist/server/native/node_modules...');
  const nativeModulesDir = join(serverOutDir, 'native', 'node_modules');
  await mkdir(nativeModulesDir, { recursive: true });
  await writeFile(join(nativeModulesDir, '.kimi-native-entry.cjs'), 'module.exports = require;\n');

  const targetDeps = resolveTargetDeps(target);
  const resolvedRoots = new Map();
  function resolveDepRoot(dep) {
    if (resolvedRoots.has(dep.id)) return resolvedRoots.get(dep.id);
    const parent = dep.parent === null ? null : nativeDeps.find((item) => item.id === dep.parent);
    const parentRoot = parent ? resolveDepRoot(parent) : null;
    let root;
    try {
      root = dirname(requireFromKimiCode.resolve(`${dep.name(target)}/package.json`));
    } catch (err) {
      if (!parentRoot) throw err;
      const reqFromParent = createRequire(join(parentRoot, 'package.json'));
      root = dirname(reqFromParent.resolve(`${dep.name(target)}/package.json`));
    }
    resolvedRoots.set(dep.id, root);
    return root;
  }

  const manifestPackages = [];
  for (const dep of targetDeps) {
    const sourceRoot = resolveDepRoot(dep);
    const pkgName = dep.resolvedName;
    const stagedPkgRelRoot = `native/node_modules/${pkgName}`;
    const stagedPkgAbsRoot = join(serverOutDir, stagedPkgRelRoot);

    let sourceBase = sourceRoot;
    let sourceFiles;
    if (dep.collect === 'node-pty') {
      const rebuilt = await rebuildNodePtyForElectron({
        sourceNodePtyRoot: sourceRoot,
        target,
        electronVersion,
        arch,
      });
      sourceBase = rebuilt.root;
      sourceFiles = rebuilt.files;
    } else if (dep.collect === 'auth-native') {
      const collected = await collectAuthNativePackage({ packageRoot: sourceRoot, target });
      sourceFiles = Object.values(collected.assets);
    } else {
      sourceFiles = await collectJsAndNativePackageFiles(sourceRoot, {
        includeNativeFiles: dep.collect === 'native-files',
        includeEntryJs: dep.collect !== 'native-file-only',
        nativeFileRelatives: dep.nativeFileRelatives,
      });
    }

    const entries = [];
    for (const srcFile of sourceFiles) {
      const pkgRel = toPosixPath(relative(sourceBase, srcFile));
      const destRel = `${stagedPkgRelRoot}/${pkgRel}`;
      const destAbs = join(serverOutDir, destRel);
      await mkdir(dirname(destAbs), { recursive: true });
      await cp(srcFile, destAbs);
      const bytes = await readFile(destAbs);
      entries.push({
        assetKey: `native/${target}/${destRel}`,
        relativePath: destRel,
        sha256: sha256(bytes),
        ...(srcFile.endsWith('spawn-helper') ? { mode: 0o755 } : {}),
      });
    }

    manifestPackages.push({
      name: pkgName,
      root: stagedPkgRelRoot,
      files: entries,
    });

    if (pkgName === '@kiki/pi-tui') {
      const piTuiNativeDir = join(serverOutDir, stagedPkgRelRoot, 'native');
      if (existsSync(piTuiNativeDir)) {
        for (const prebuildFile of await listFilesRecursive(piTuiNativeDir)) {
          const relNative = toPosixPath(relative(piTuiNativeDir, prebuildFile));
          const directDest = join(serverOutDir, 'native', relNative);
          await mkdir(dirname(directDest), { recursive: true });
          await cp(prebuildFile, directDest);
        }
      }
    }
  }

  const runtimeFilePairs = [
    [KAP_SQLITE_QUERY_WORKER_ASSET.key, 'sqlite-query-worker.mjs', 0o644],
    [KAP_HISTORY_NAVIGATION_WORKER_ASSET.key, 'history-navigation-worker.mjs', 0o644],
    [KAP_USAGE_PARSER_WORKER_ASSET.key, 'usage-parser-worker.mjs', 0o644],
    [QUERY_STORE_WORKER_ASSET.key, 'query-store-worker.mjs', 0o644],
    [USAGE_READ_MODEL_WORKER_ASSET.key, 'usage-read-model-worker.mjs', 0o644],
    [MAILBOX_WORKER_ASSET.key, 'mailbox-worker.mjs', 0o644],
    [MEMORY_WORKER_ASSET.key, 'memory-worker.mjs', 0o644],
    [CPU_WORKER_ASSET.key, 'cpu-worker.mjs', 0o644],
    [PLUGIN_ISOLATION_WORKER_ASSET.key, 'plugin-isolation-worker.mjs', 0o644],
    [PLUGIN_HOST_RUNNER_ASSET.key, 'hostRunner.mjs', 0o644],
    [KAP_MODEL_PRICES_ASSET.key, 'model_prices_and_context_window.json', 0o644],
  ];

  for (const builtinFile of await listFilesRecursive(join(serverOutDir, 'builtin'))) {
    const rel = toPosixPath(relative(join(serverOutDir, 'builtin'), builtinFile));
    runtimeFilePairs.push([`history-import/${rel}`, `builtin/${rel}`, 0o644]);
  }
  for (const adapterFile of SOURCE_OWNED_ADAPTER_FILES) {
    runtimeFilePairs.push([`external-harness/${adapterFile}`, `external-harness/${adapterFile}`, 0o644]);
  }
  if (target.startsWith('win32-')) {
    runtimeFilePairs.push([WINDOWS_PROCESS_HELPER_ASSET.key, 'native/windows-process-helper.exe', 0o755]);
  }

  const runtimeFiles = [];
  for (const [key, relPath, mode] of runtimeFilePairs) {
    const absPath = join(serverOutDir, relPath);
    const bytes = await readFile(absPath);
    runtimeFiles.push({
      key,
      assetKey: buildRuntimeAssetKey(target, key),
      relativePath: relPath,
      sha256: sha256(bytes),
      mode,
    });
  }

  const manifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target,
    packages: manifestPackages,
    runtimeFiles,
  };
  await writeFile(join(serverOutDir, 'native-addons.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (target === `${process.platform}-${process.arch}` && existsSync(electronBinaryPath)) {
    console.log(`[stage-server] Verifying ABI compatibility under Electron ${electronVersion} ELECTRON_RUN_AS_NODE=1...`);
    const probeScript = [
      "import { createRequire } from 'node:module';",
      "import { join } from 'node:path';",
      `const req = createRequire(${JSON.stringify(join(nativeModulesDir, '.kimi-native-entry.cjs'))});`,
      "const auth = req('@kiki/auth-native');",
      "if (typeof auth.ageEncrypt !== 'function') throw new Error('auth-native failed');",
      "const keyring = req('@napi-rs/keyring');",
      "if (typeof keyring.AsyncEntry !== 'function') throw new Error('keyring failed');",
      "const clip = req('@mariozechner/clipboard');",
      "if (!clip) throw new Error('clipboard failed');",
      "const pty = req('node-pty');",
      "if (typeof pty.spawn !== 'function') throw new Error('node-pty failed');",
      ...(process.platform === 'win32'
        ? [
            `req(${JSON.stringify(join(nativeModulesDir, 'node-pty/build/Release/conpty.node'))});`,
            `req(${JSON.stringify(join(nativeModulesDir, 'node-pty/build/Release/pty.node'))});`,
          ]
        : []),
      "console.log('ABI_OK:' + process.versions.modules);",
    ].join('\n');

    const probe = spawnSync(electronBinaryPath, ['--input-type=module', '-e', probeScript], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    });
    if (probe.status !== 0 || !probe.stdout.includes('ABI_OK:')) {
      throw new Error(
        `Electron ABI verification failed (status=${probe.status}):\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
      );
    }
    console.log(`[stage-server] ${probe.stdout.trim()} (${manifestPackages.length} packages, ${runtimeFiles.length} runtime files)`);
  }

  const serverStat = await stat(join(serverOutDir, 'server-entry.mjs'));
  console.log(`[stage-server] Complete: ${join(serverOutDir, 'server-entry.mjs')} (${(serverStat.size / 1024 / 1024).toFixed(2)} MiB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      'skip-gui-build': { type: 'boolean', default: false },
    },
  });
  await stageDesktopServer({ skipGuiBuild: Boolean(values['skip-gui-build']) });
}
