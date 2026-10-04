import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  getTextBuildWorkerRuntimeState,
  resetTextBuildWorkerRuntime,
} from '@kiki/minidb/worker-runtime';

import {
  getEmbeddedNativeAssetManifest,
  getMinidbTextBuildWorkerFile,
  getNativeCacheBase,
  getNativePackageRoot,
  getPluginHostRunnerFile,
  NATIVE_ASSET_MANIFEST_VERSION,
  type NativeAssetManifest,
  type NativeAssetSource,
} from '#/native/native-assets';
import { installMinidbTextBuildWorker } from '#/native/minidb-worker';
import { loadNativePackage } from '#/native/native-require';
import { installKikiDocs, resolveKikiDocsSourceDir } from '#/native/product-docs';
import { Marked } from '@kiki/pi-tui';
import { copyKikiDocs, localizeKikiDoc } from '../../scripts/local-docs.mjs';
import { collectKikiDocAssets } from '../../scripts/native/assets.mjs';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeManifest(files: Record<string, string>, workerContent?: string): {
  manifest: NativeAssetManifest;
  source: NativeAssetSource;
} {
  const assetEntries = Object.entries(files).map(([relativePath, content]) => {
    const assetKey = `native/test-target/${relativePath}`;
    return {
      assetKey,
      relativePath,
      sha256: sha256(content),
    };
  });
  const manifestKey = 'native/test-target/manifest.json';
  const workerAssetKey = 'native/test-target/runtime/minidb-text-build-worker';
  const manifest: NativeAssetManifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target: 'test-target',
    packages: [
      {
        name: 'fake-native',
        root: 'node_modules/fake-native',
        files: assetEntries,
      },
    ],
    runtimeFiles:
      workerContent === undefined
        ? []
        : [
            {
              key: 'minidb-text-build-worker',
              assetKey: workerAssetKey,
              relativePath: 'runtime/minidb/text-build-worker.mjs',
              sha256: sha256(workerContent),
              mode: 0o644,
            },
          ],
  };
  const assets = new Map<string, Buffer>([
    [manifestKey, Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(files).map(([relativePath, content]) => [
      `native/test-target/${relativePath}`,
      Buffer.from(content),
    ] as const),
    ...(workerContent === undefined
      ? []
      : [[workerAssetKey, Buffer.from(workerContent)] as const]),
  ]);
  return {
    manifest,
    source: {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        const asset = assets.get(assetKey);
        if (asset === undefined) throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    },
  };
}

function sourceForManifest(manifest: unknown): NativeAssetSource {
  const key = 'native/test-target/manifest.json';
  return {
    getAssetKeys: () => [key],
    getRawAsset: (assetKey) => {
      if (assetKey !== key) throw new Error(`missing test asset: ${assetKey}`);
      return Buffer.from(JSON.stringify(manifest));
    },
  };
}

function fakeDocsSource(files: Record<string, string>): {
  manifest: NativeAssetManifest;
  source: NativeAssetSource;
} {
  const manifestKey = 'native/test-target/manifest.json';
  const runtimeFiles = Object.entries(files).map(([relativePath, content]) => {
    const key = `kiki-docs/${relativePath}`;
    return {
      key,
      assetKey: `native/test-target/runtime/${key}`,
      relativePath: `runtime/kiki-docs/${relativePath}`,
      sha256: sha256(content),
      mode: 0o644,
    };
  });
  const manifest: NativeAssetManifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target: 'test-target',
    packages: [],
    runtimeFiles,
  };
  const assets = new Map<string, Buffer>([
    [manifestKey, Buffer.from(JSON.stringify(manifest))],
    ...runtimeFiles.map((file) => [file.assetKey, Buffer.from(files[file.key.slice('kiki-docs/'.length)]!)] as const),
  ]);
  return {
    manifest,
    source: {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        const asset = assets.get(assetKey);
        if (asset === undefined) throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    },
  };
}

function writeDocsTree(root: string, english: string, chinese: string): void {
  mkdirSync(join(root, 'en'), { recursive: true });
  mkdirSync(join(root, 'zh'), { recursive: true });
  writeFileSync(join(root, 'en', 'index.md'), english);
  writeFileSync(join(root, 'zh', 'index.md'), chinese);
}

afterEach(() => {
  resetTextBuildWorkerRuntime();
});

describe('native assets', () => {
  it('uses KIKI_CACHE_DIR as the native cache base when present', () => {
    expect(
      getNativeCacheBase({
        env: { KIKI_CACHE_DIR: '/tmp/kimi-cache' },
        homeDir: '/home/kimi',
        platform: 'linux',
      }),
    ).toBe('/tmp/kimi-cache');
  });

  it('extracts package assets and repairs corrupted cache files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-assets-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{"main":"index.js"}',
        'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
      });

      const packageRoot = getNativePackageRoot('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      expect(packageRoot).toBe(join(dir, 'native', 'test', 'test-target', sha256(JSON.stringify(manifest)), 'node_modules', 'fake-native'));
      expect(readFileSync(join(packageRoot ?? '', 'index.js'), 'utf-8')).toContain("value: 'ok'");

      writeFileSync(join(packageRoot ?? '', 'index.js'), 'broken');
      const repairedRoot = getNativePackageRoot('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      expect(repairedRoot).toBe(packageRoot);
      expect(readFileSync(join(repairedRoot ?? '', 'index.js'), 'utf-8')).toContain("value: 'ok'");
      expect(existsSync(join(dir, 'native', 'test', 'test-target'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it.skipIf(process.platform === 'win32')('preserves executable helper mode under umask and repairs a hash-valid cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-mode-'));
    const oldUmask = process.umask(0o077);
    try {
      const base = fakeManifest({
        'node_modules/fake-native/spawn-helper': '#!/bin/sh\nexit 0\n',
      });
      const manifest: NativeAssetManifest = {
        ...base.manifest,
        packages: base.manifest.packages.map((pkg) => ({
          ...pkg, files: pkg.files.map((file) => ({ ...file, mode: 0o755 })),
        })),
      };
      const options = { manifest, source: base.source, cacheBase: dir, version: 'test' };
      const root = getNativePackageRoot('fake-native', options)!;
      const helper = join(root, 'spawn-helper');
      expect(statSync(helper).mode & 0o777).toBe(0o755);
      chmodSync(helper, 0o644);
      expect(getNativePackageRoot('fake-native', options)).toBe(root);
      expect(statSync(helper).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(oldUmask);
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('loads a package from extracted native assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-require-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{"main":"index.js"}',
        'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
      });

      const pkg = loadNativePackage<{ value: string }>('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      expect(pkg).toEqual({ value: 'ok' });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('extracts, reuses, and repairs the runtime worker in the unified cache tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-worker-'));
    try {
      const worker = 'export const worker = true;\n';
      const { manifest, source } = fakeManifest(
        { 'node_modules/fake-native/package.json': '{"main":"index.js"}' },
        worker,
      );
      const options = { cacheBase: dir, manifest, source, version: 'test' };
      const first = getMinidbTextBuildWorkerFile(options);
      const packageRoot = getNativePackageRoot('fake-native', options);
      expect(first).toBe(
        join(
          dir,
          'native',
          'test',
          'test-target',
          sha256(JSON.stringify(manifest)),
          'runtime',
          'minidb',
          'text-build-worker.mjs',
        ),
      );
      expect(packageRoot?.startsWith(join(dir, 'native', 'test', 'test-target'))).toBe(true);
      expect(getMinidbTextBuildWorkerFile(options)).toBe(first);

      writeFileSync(first!, 'corrupt');
      expect(getMinidbTextBuildWorkerFile(options)).toBe(first);
      expect(readFileSync(first!, 'utf-8')).toBe(worker);

      const installed = installMinidbTextBuildWorker(options);
      expect(installed).toMatchObject({ status: 'installed', assetSha256: sha256(worker) });
      expect(getTextBuildWorkerRuntimeState()).toMatchObject({
        configured: true,
        entry: { kind: 'packaged', path: first },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('extracts the plugin host runner from the checked native asset manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-plugin-runner-'));
    try {
      const runner = 'export const runner = true;\n';
      const base = fakeManifest({});
      const assetKey = 'native/test-target/runtime/plugin-host-runner';
      const manifest: NativeAssetManifest = {
        ...base.manifest,
        runtimeFiles: [{ key: 'plugin-host-runner', assetKey,
          relativePath: 'runtime/plugin/hostRunner.mjs', sha256: sha256(runner), mode: 0o644 }],
      };
      const source: NativeAssetSource = {
        getAssetKeys: () => [...base.source.getAssetKeys(), assetKey],
        getRawAsset: (key) => key === assetKey ? Buffer.from(runner) : base.source.getRawAsset(key),
      };
      const options = { cacheBase: dir, manifest, source, version: 'test' };
      const file = getPluginHostRunnerFile(options);
      expect(file).toBe(join(dir, 'native', 'test', 'test-target', sha256(JSON.stringify(manifest)), 'runtime', 'plugin', 'hostRunner.mjs'));
      expect(readFileSync(file!, 'utf8')).toBe(runner);
      writeFileSync(file!, 'corrupt');
      expect(getPluginHostRunnerFile(options)).toBe(file);
      expect(readFileSync(file!, 'utf8')).toBe(runner);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('reports missing and corrupt runtime worker assets without configuring MiniDb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-worker-fail-'));
    try {
      const missing = fakeManifest({});
      expect(
        installMinidbTextBuildWorker({
          cacheBase: dir,
          manifest: missing.manifest,
          source: missing.source,
          version: 'test',
        }),
      ).toEqual({ status: 'asset-missing' });

      const corrupt = fakeManifest({}, 'worker');
      const corruptSource: NativeAssetSource = {
        getAssetKeys: () => corrupt.source.getAssetKeys(),
        getRawAsset: (key) =>
          key.endsWith('/runtime/minidb-text-build-worker')
            ? Buffer.from('wrong')
            : corrupt.source.getRawAsset(key),
      };
      expect(
        installMinidbTextBuildWorker({
          cacheBase: dir,
          manifest: corrupt.manifest,
          source: corruptSource,
          version: 'test',
        }),
      ).toMatchObject({ status: 'failed', errorCode: 'Error' });
      expect(getTextBuildWorkerRuntimeState()).toEqual({ configured: false });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('rejects unsupported or structurally incomplete native manifest versions', () => {
    const valid = fakeManifest({}, 'worker').manifest;
    const cases: Array<{ manifest: unknown; error: RegExp }> = [
      { manifest: { ...valid, version: 1 }, error: /Unsupported native asset manifest version: 1/ },
      {
        manifest: { version: NATIVE_ASSET_MANIFEST_VERSION, target: 'test-target', runtimeFiles: [] },
        error: /packages must be an array/,
      },
      {
        manifest: { version: NATIVE_ASSET_MANIFEST_VERSION, target: 'test-target', packages: [] },
        error: /runtimeFiles must be an array/,
      },
      { manifest: { ...valid, packages: {} }, error: /packages must be an array/ },
      { manifest: { ...valid, runtimeFiles: {} }, error: /runtimeFiles must be an array/ },
    ];

    for (const item of cases) {
      expect(() =>
        getEmbeddedNativeAssetManifest(sourceForManifest(item.manifest), 'test-target'),
      ).toThrow(item.error);
    }
  });

  it('rejects unsafe paths, invalid file metadata, and duplicate manifest keys', () => {
    const valid = fakeManifest({}, 'worker').manifest;
    const worker = valid.runtimeFiles[0]!;
    const invalidRuntimeFiles: Array<{ file: Record<string, unknown>; error: RegExp }> = [
      { file: { ...worker, relativePath: '/tmp/worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, relativePath: '../worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, relativePath: 'runtime\\..\\worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, sha256: 'not-a-sha' }, error: /64 lowercase hex/ },
      { file: { ...worker, mode: 0o1000 }, error: /mode must be an integer/ },
      { file: { ...worker, assetKey: 42 }, error: /assetKey must be a non-empty string/ },
    ];
    for (const item of invalidRuntimeFiles) {
      expect(() =>
        getEmbeddedNativeAssetManifest(
          sourceForManifest({ ...valid, runtimeFiles: [item.file] }),
          'test-target',
        ),
      ).toThrow(item.error);
    }

    const validPackage = valid.packages[0]!;
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{ ...validPackage, root: '../node_modules/fake-native' }],
        }),
        'test-target',
      ),
    ).toThrow(/safe relative path/);
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{ ...validPackage, files: {} }],
        }),
        'test-target',
      ),
    ).toThrow(/files must be an array/);

    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          runtimeFiles: [
            worker,
            { ...worker, assetKey: 'native/test-target/runtime/other', relativePath: 'runtime/other.mjs' },
          ],
        }),
        'test-target',
      ),
    ).toThrow(/duplicate runtime key/);

    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          runtimeFiles: [
            worker,
            {
              ...worker,
              key: 'other',
              relativePath: 'runtime/other.mjs',
            },
          ],
        }),
        'test-target',
      ),
    ).toThrow(/duplicate assetKey/);
  });

  it('materializes SEA docs by content hash and backs up user edits before refresh', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiki-sea-docs-'));
    try {
      const initial = fakeDocsSource({
        'en/index.md': '# English v1\n',
        'zh/index.md': '# 中文 v1\n',
      });
      expect(installKikiDocs({ ...initial, kikiHome: home })).toMatchObject({
        status: 'installed',
        source: 'sea',
        fileCount: 2,
        writtenFiles: 3,
        backedUpFiles: 0,
      });

      const chinesePath = join(home, 'docs', 'zh', 'index.md');
      const fixedTime = new Date('2024-01-02T03:04:05.000Z');
      utimesSync(chinesePath, fixedTime, fixedTime);
      expect(installKikiDocs({ ...initial, kikiHome: home })).toMatchObject({
        status: 'installed',
        writtenFiles: 0,
        backedUpFiles: 0,
      });
      expect(statSync(chinesePath).mtimeMs).toBe(fixedTime.getTime());

      const englishPath = join(home, 'docs', 'en', 'index.md');
      writeFileSync(englishPath, '# user edit\n');
      const updated = fakeDocsSource({
        'en/index.md': '# English v2\n',
        'zh/index.md': '# 中文 v1\n',
      });
      expect(installKikiDocs({ ...updated, kikiHome: home })).toMatchObject({
        status: 'installed',
        writtenFiles: 2,
        backedUpFiles: 1,
      });
      expect(readFileSync(englishPath, 'utf-8')).toBe('# English v2\n');
      expect(readFileSync(`${englishPath}.bak`, 'utf-8')).toBe('# user edit\n');
      expect(statSync(chinesePath).mtimeMs).toBe(fixedTime.getTime());
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('resolves and materializes npm package docs from dist', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-package-docs-'));
    const packageRoot = join(root, 'package');
    const docsRoot = join(packageRoot, 'dist', 'docs');
    const home = join(root, 'home');
    try {
      writeDocsTree(docsRoot, '# Package English\n', '# Package 中文\n');
      expect(resolveKikiDocsSourceDir(packageRoot, join(packageRoot, 'dist'))).toEqual({
        path: docsRoot,
        source: 'package',
      });
      expect(
        installKikiDocs({
          source: null,
          packageRoot,
          runtimeDir: join(packageRoot, 'dist'),
          kikiHome: home,
        }),
      ).toMatchObject({ status: 'installed', source: 'package', fileCount: 2 });
      expect(readFileSync(join(home, 'docs', 'en', 'index.md'), 'utf-8')).toBe(
        '# Package English\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('prefers repository docs over stale dist docs when running from source', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-workspace-docs-'));
    const packageRoot = join(root, 'apps', 'kimi-code');
    const workspaceDocsRoot = join(root, 'docs');
    const staleDocsRoot = join(packageRoot, 'dist', 'docs');
    const runtimeDir = join(packageRoot, 'src', 'native');
    const home = join(root, 'home');
    try {
      writeDocsTree(workspaceDocsRoot, '# Workspace English\n', '# Workspace 中文\n');
      writeDocsTree(staleDocsRoot, '# Stale English\n', '# Stale 中文\n');
      expect(resolveKikiDocsSourceDir(packageRoot, runtimeDir)).toEqual({
        path: workspaceDocsRoot,
        source: 'workspace',
      });
      expect(
        installKikiDocs({ source: null, packageRoot, runtimeDir, kikiHome: home }),
      ).toMatchObject({ status: 'installed', source: 'workspace', fileCount: 2 });
      expect(readFileSync(join(home, 'docs', 'en', 'index.md'), 'utf-8')).toBe(
        '# Workspace English\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});


describe('managed browser SEA resource packaging and extraction', () => {
  it.skipIf(process.env['KIKI_BROWSER_TEST_DRIVER'] === undefined)('extracts the fixed derivative and its notices into an isolated cache, and rejects a corrupted payload', async () => {
    const { collectBrowserDriverAssets } = await import('../../scripts/native/browser-assets.mjs');
    const { getBrowserDriverFile } = await import('#/native/native-assets');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    mkdirSync(resolve('.tmp'), { recursive: true });
    const root = mkdtempSync(resolve('.tmp', 'browser-assets-'));
    const appRoot = fileURLToPath(new URL('../../', import.meta.url));
    try {
      const collected = await collectBrowserDriverAssets({ appRoot, target: 'win32-x64', artifactDirectory: dirname(process.env['KIKI_BROWSER_TEST_DRIVER']!) });
      expect(collected.runtimeFiles).toHaveLength(5);
      const manifest: NativeAssetManifest = { version: NATIVE_ASSET_MANIFEST_VERSION, target: 'win32-x64', packages: [], runtimeFiles: collected.runtimeFiles };
      const bytes = new Map(Object.entries(collected.assets).map(([key, source]) => [key, readFileSync(source)]));
      const source: NativeAssetSource = { getAssetKeys: () => [...bytes.keys()], getRawAsset: (key) => bytes.get(key)! };
      const options = { source, manifest, cacheBase: root, version: 'fixture', platform: 'win32' as const };
      const binary = getBrowserDriverFile(options)!;
      expect(binary.startsWith(root)).toBe(true);
      expect(sha256(readFileSync(binary))).toBe('1a333ab6c97f06a8da7c30a3829bbd4d98888e7c8145954ac2142c0205e78417');
      expect(readFileSync(join(dirname(binary), 'NOTICE'), 'utf8')).toContain('kiki-no-replay-r1');
      expect(readFileSync(join(dirname(binary), 'LICENSE'), 'utf8')).toContain('Apache License');
      expect(JSON.parse(readFileSync(join(dirname(binary), 'build.json'), 'utf8'))).toMatchObject({ version: '0.38.2', marker: 'kiki-no-replay-r1' });
      expect(getBrowserDriverFile(options)).toBe(binary);
      const binaryKey = collected.runtimeFiles.find((file) => file.key === 'browser-driver')!.assetKey;
      bytes.set(binaryKey, Buffer.from('unpatched or corrupt executable'));
      expect(() => getBrowserDriverFile(options)).toThrow('checksum mismatch');
      await expect(collectBrowserDriverAssets({ appRoot, target: 'win32-x64', artifactDirectory: root })).rejects.toThrow('Stage the fixed derivative');
      expect(await collectBrowserDriverAssets({ appRoot, target: 'linux-x64', artifactDirectory: root })).toEqual({ runtimeFiles: [], assets: {} });
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
});


describe('built-in history rule resources', () => {
  it('copies and extracts the same complete rule tree and loads all six sources without installing a plugin', async () => {
    const { collectHistoryImportAssets, copyHistoryImportAssets } = await import('../../scripts/native/history-assets.mjs');
    const { getHistoryImportEntryFile } = await import('#/native/native-assets');
    const { fileURLToPath } = await import('node:url');
    const { resolve } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const appRoot = fileURLToPath(new URL('../../', import.meta.url));
    const scratch = resolve(appRoot, '../../.tmp'); mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, 'history-assets-'));
    const load = (entry: string) => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'import {pathToFileURL} from "node:url"; const {register}=await import(pathToFileURL(process.argv[1])); const ids=[]; register({registerSessionSource(d,a){if(!["discover","probe","parse"].every(k=>typeof a[k]==="function"))throw Error("missing action");ids.push(d.id)}});console.log(JSON.stringify(ids))', entry], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual(['claude-code', 'codex', 'pi', 'grok', 'opencode', 'custom']);
    };
    try {
      await copyHistoryImportAssets({ appRoot, outDir: join(root, 'dist') });
      load(join(root, 'dist/builtin/entry.mjs'));
      const collected = await collectHistoryImportAssets({ appRoot, target: 'fixture' });
      expect(collected.runtimeFiles.some((file: { key: string }) => file.key.endsWith('THIRD_PARTY_NOTICES.md'))).toBe(true);
      const manifest: NativeAssetManifest = { version: NATIVE_ASSET_MANIFEST_VERSION, target: 'fixture', packages: [], runtimeFiles: collected.runtimeFiles };
      const bytes = new Map(Object.entries(collected.assets).map(([key, file]) => [key, readFileSync(file as string)]));
      const source: NativeAssetSource = { getAssetKeys: () => [...bytes.keys()], getRawAsset: (key) => bytes.get(key)! };
      const entry = getHistoryImportEntryFile({ source, manifest, cacheBase: join(root, 'cache'), version: 'fixture' });
      expect(entry).not.toBeNull(); load(entry!);
      expect(readFileSync(join(entry!, '../examples/custom-json.mjs'), 'utf8')).toContain('export async function parse');
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
});


describe('text-only bundled documentation', () => {
  const code = [
    '```md',
    '![Code example](../media/shot.png)',
    '<img src="../media/shot.png" alt="HTML example">',
    '```',
  ].join('\r\n');
  const illustrated = (locale: string) => [
    `# ${locale === 'zh' ? '图文指南' : 'Illustrated guide'}`,
    '',
    '[Ordinary link](./other.md#details)',
    '',
    '![Screen](../media/shot.png "Screenshot")',
    '',
    '![Reference][screen]',
    '',
    '[![Linked screen](../media/shot.png)](https://example.com/details)',
    '',
    '<figure>',
    '<picture>',
    '<source srcset="../media/shot.webp 2x">',
    '<img',
    ' src="../media/shot.png" srcset="../media/shot.png 2x" alt="HTML screen" width="600">',
    '</picture>',
    '<figcaption>Caption retained.</figcaption>',
    '</figure>',
    '',
    code,
    '',
    '`![Inline example](../media/shot.png)`',
    '',
    '    ![Indented example](../media/shot.png)',
    '',
    '- Nested example:',
    '',
    '  ```md',
    '  ![Nested](../media/shot.png)',
    '  ```',
    '',
    '  ![Nested](../media/shot.png)',
    '',
    '> ![Quoted](../media/shot.png)',
    '',
    '| Example | Image |',
    '| --- | --- |',
    '| `a\\|b` | ![Table](../media/shot.png) |',
    '',
    '[screen]: ../media/shot.png',
    '',
  ].join('\r\n');

  it('keeps prose, captions, links and literal code while removing rendered image forms', () => {
    for (const locale of ['en', 'zh']) {
      const source = illustrated(locale);
      const result = localizeKikiDoc(source, `${locale}/guides/illustrated.md`);
      expect(result).toContain(`[Ordinary link](./other.md#details)\r\n`);
      expect(result).toContain('Screen\r\n\r\nReference\r\n');
      expect(result).toContain('[Linked screen](https://example.com/details)');
      expect(result).toContain('HTML screen\r\n');
      expect(result).toContain('<figcaption>Caption retained.</figcaption>\r\n');
      expect(result).toContain(code);
      expect(result).toContain('`![Inline example](../media/shot.png)`');
      expect(result).toContain('    ![Indented example](../media/shot.png)');
      expect(result).toContain('  ```md\r\n  ![Nested](../media/shot.png)\r\n  ```\r\n\r\n  Nested');
      expect(result).toContain('> Quoted');
      expect(result).toContain('| `a\\|b` | Table |');
      const rendered = new Marked().parse(result) as string;
      expect(rendered).not.toMatch(/<(?:img|picture|source)\b/i);
      expect(result.match(/https:\/\/x-t-e-r\.github\.io\/kiki\//g)).toHaveLength(1);
      expect(result).toContain(`https://x-t-e-r.github.io/kiki/${locale}/guides/illustrated.html`);
      expect(localizeKikiDoc(result, `${locale}/guides/illustrated.md`)).toBe(result);
    }
    const codeOnly = `# No illustrations\r\n\r\n${code}\r\n`;
    expect(localizeKikiDoc(codeOnly, 'en/index.md')).toBe(codeOnly);
    expect(localizeKikiDoc('![alt](a.png)\n', 'en/index.md')).toBe(
      'alt\n\n[Online version with images](https://x-t-e-r.github.io/kiki/en/)\n',
    );
  });

  it('prepares matching SEA/npm/workspace text and hashes without modifying sources, and preserves edits on upgrade', async () => {
    const scratch = resolve(import.meta.dirname, '../../../../.tmp');
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, 'local-docs-'));
    const appRoot = join(root, 'apps', 'kimi-code');
    const sourceDir = join(root, 'docs');
    const packageDir = join(appRoot, 'dist', 'docs');
    const originals: Record<string, string> = {
      'en/index.md': '# English\n',
      'zh/index.md': '# 中文\n',
      'en/guides/illustrated.md': illustrated('en'),
      'zh/guides/illustrated.md': illustrated('zh'),
    };
    const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    try {
      for (const [path, text] of Object.entries(originals)) {
        mkdirSync(join(sourceDir, path, '..'), { recursive: true });
        writeFileSync(join(sourceDir, path), text);
      }
      mkdirSync(join(sourceDir, 'en', 'media'), { recursive: true });
      writeFileSync(join(sourceDir, 'en', 'media', 'shot.png'), picture);
      const collected = await collectKikiDocAssets({ appRoot, target: 'fixture' });
      const copied = await copyKikiDocs({ sourceDir, targetDir: packageDir });
      expect(collected.runtimeFiles).toHaveLength(4);
      expect(copied).toHaveLength(4);
      expect(Object.keys(collected.assets).every((key) => key.endsWith('.md'))).toBe(true);
      expect(existsSync(join(packageDir, 'en', 'media', 'shot.png'))).toBe(false);
      const manifest: NativeAssetManifest = {
        version: NATIVE_ASSET_MANIFEST_VERSION, target: 'fixture', packages: [],
        runtimeFiles: collected.runtimeFiles,
      };
      const payload = new Map(Object.entries(collected.assets).map(([key, path]) => [key, readFileSync(path)]));
      const source: NativeAssetSource = {
        getAssetKeys: () => [...payload.keys()],
        getRawAsset: (key) => payload.get(key)!,
      };
      const home = join(root, 'sea-home');
      const old = fakeDocsSource(originals);
      expect(installKikiDocs({ ...old, kikiHome: home })).toMatchObject({ status: 'installed', backedUpFiles: 0 });
      const editedPath = join(home, 'docs', 'en', 'guides', 'illustrated.md');
      writeFileSync(editedPath, '# User notes\n');
      writeFileSync(`${editedPath}.bak`, '# Previous backup\n');
      const installed = installKikiDocs({ source, manifest, kikiHome: home });
      expect(installed).toMatchObject({ status: 'installed', fileCount: 4, backedUpFiles: 1 });
      expect(readFileSync(`${editedPath}.bak`, 'utf8')).toBe('# Previous backup\n');
      expect(readFileSync(`${editedPath}.bak.1`, 'utf8')).toBe('# User notes\n');
      expect(existsSync(join(home, 'docs', 'zh', 'guides', 'illustrated.md.bak'))).toBe(false);
      expect(installKikiDocs({ source, manifest, kikiHome: home })).toMatchObject({ writtenFiles: 0, backedUpFiles: 0 });
      const npmHome = join(root, 'npm-home');
      const workspaceHome = join(root, 'workspace-home');
      const npmInstalled = installKikiDocs({ source: null, packageRoot: appRoot, runtimeDir: join(appRoot, 'dist'), kikiHome: npmHome });
      const workspaceInstalled = installKikiDocs({ source: null, docsSourceDir: sourceDir, kikiHome: workspaceHome });
      expect(npmInstalled).toMatchObject({ status: 'installed', source: 'package', contentSha256: installed.status === 'installed' ? installed.contentSha256 : '' });
      expect(workspaceInstalled).toMatchObject({ status: 'installed', source: 'workspace', contentSha256: installed.status === 'installed' ? installed.contentSha256 : '' });
      const installedManifest = JSON.parse(readFileSync(join(home, 'docs', '.kiki-docs-manifest.json'), 'utf8'));
      for (const file of collected.runtimeFiles) {
        const path = file.key.slice('kiki-docs/'.length);
        const bytes = payload.get(file.assetKey)!;
        expect(collected.assets[file.assetKey]).toContain(join('dist-native', 'intermediates', 'native-assets', 'fixture', 'kiki-docs'));
        expect(sha256(bytes)).toBe(file.sha256);
        expect(installedManifest.files[path]).toBe(file.sha256);
        expect(readFileSync(join(packageDir, path))).toEqual(bytes);
        for (const installedHome of [home, npmHome, workspaceHome]) {
          expect(readFileSync(join(installedHome, 'docs', path))).toEqual(bytes);
        }
        expect(readFileSync(join(sourceDir, path), 'utf8')).toBe(originals[path]);
      }
      expect(readFileSync(join(sourceDir, 'en', 'media', 'shot.png'))).toEqual(picture);
      payload.set(manifest.runtimeFiles[0]!.assetKey, Buffer.from('corrupt'));
      expect(installKikiDocs({ source, manifest, kikiHome: join(root, 'corrupt-home') })).toMatchObject({ status: 'failed' });
      expect(existsSync(join(root, 'corrupt-home', 'docs'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
