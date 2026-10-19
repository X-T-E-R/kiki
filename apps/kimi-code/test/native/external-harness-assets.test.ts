import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { NATIVE_ASSET_MANIFEST_VERSION, getSourceOwnedAdapterRoot, type NativeAssetManifest, type NativeAssetSource } from '#/native/native-assets';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const sourceDir = join(repoRoot, 'scripts/external-harness');
const production = ['agy-cli-acp.mjs', 'agy-hook-registration.mjs', 'agy-permission-hook.mjs', 'agy-mcp-plugin.mjs'] as const;

describe('source-owned adapter packaging', () => {
  it('ships the production adapter scripts through the SEA manifest, npm dist and extraction', async () => {
    const { collectSourceOwnedAdapterAssets, copySourceOwnedAdapterAssets } = await import('../../scripts/native/external-harness-assets.mjs');
    const { stageNpmDistributions } = await import('../../scripts/npm/stage.mjs');
    const root = mkdtempSync(join(tmpdir(), 'source-owned-package-'));
    try {
      const collected = await collectSourceOwnedAdapterAssets({ appRoot: join(repoRoot, 'apps/kimi-code'), repoRoot, target: 'win32-x64' });
      expect(collected.runtimeFiles.map((file: { key: string }) => file.key)).toEqual(production.map((name) => `external-harness/${name}`));
      for (const file of collected.runtimeFiles as Array<{ key: string; sha256: string; relativePath: string }>) {
        const name = file.key.slice('external-harness/'.length);
        const bytes = readFileSync(join(sourceDir, name));
        expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(file.relativePath).toBe(`runtime/external-harness/${name}`);
        const assets = collected.assets as Record<string, string>;
        expect(readFileSync(assets[`native/win32-x64/runtime/${file.key}`]!).equals(bytes)).toBe(true);
      }
      expect(JSON.stringify(collected.runtimeFiles)).not.toContain('fixture-cli');
      expect(JSON.stringify(collected.runtimeFiles)).not.toContain('agy-cli-audit-acp');
      expect(JSON.stringify(collected.runtimeFiles)).not.toContain('audit/');

      const appRoot = join(root, 'kimi-code');
      await copySourceOwnedAdapterAssets({ repoRoot, outDir: join(appRoot, 'dist') });
      await mkdir(join(appRoot, 'scripts', 'npm'), { recursive: true });
      await cp(join(repoRoot, 'apps/kimi-code/scripts/npm/desktop-postinstall.mjs'), join(appRoot, 'scripts/npm/desktop-postinstall.mjs'));
      await mkdir(join(appRoot, 'native'), { recursive: true });
      await writeFile(join(appRoot, 'native', '.keep'), '');
      await writeFile(join(appRoot, 'README.md'), 'readme\n');
      await writeFile(join(appRoot, 'package.json'), JSON.stringify({
        version: '0.4.1', license: 'MIT', homepage: 'https://example.test', repository: 'example',
        dependencies: { ws: '1.0.0' }, optionalDependencies: {},
      }));
      await mkdir(join(root, 'kiki-gui'), { recursive: true });
      await writeFile(join(root, 'kiki-gui', 'package.json'), JSON.stringify({ version: '0.4.1' }));
      await stageNpmDistributions(appRoot);
      for (const kind of ['lite', 'full']) {
        for (const name of production) {
          const packaged = await readFile(join(appRoot, 'dist-npm', kind, 'dist', 'external-harness', name));
          expect(Buffer.compare(packaged, readFileSync(join(sourceDir, name)))).toBe(0);
        }
        await expect(readFile(join(appRoot, 'dist-npm', kind, 'dist', 'external-harness', 'fixture-cli.mjs'))).rejects.toThrow();
        await expect(readFile(join(appRoot, 'dist-npm', kind, 'dist', 'external-harness', 'agy-cli-audit-acp.mjs'))).rejects.toThrow();
      }

      const manifest: NativeAssetManifest = {
        version: NATIVE_ASSET_MANIFEST_VERSION, target: 'win32-x64', packages: [], runtimeFiles: collected.runtimeFiles,
      };
      const payload = new Map(Object.entries(collected.assets).map(([key, file]) => [key, readFileSync(file as string)]));
      const source: NativeAssetSource = { getAssetKeys: () => [...payload.keys()], getRawAsset: (key) => payload.get(key)! };
      const extracted = getSourceOwnedAdapterRoot({ source, manifest, cacheBase: join(root, 'cache'), version: 'fixture' });
      expect(extracted).not.toBeNull();
      for (const name of production) {
        expect(readFileSync(join(extracted!, name)).equals(readFileSync(join(sourceDir, name)))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
