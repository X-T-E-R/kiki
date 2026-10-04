import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { MediaCatalog } from '@kiki/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPluginMarketplaceCdn } from '../../scripts/build-plugin-marketplace-cdn.mjs';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

describe('buildPluginMarketplaceCdn', () => {
  it('packages WebBridge without publishing other unlisted official directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-plugin-cdn-build-'));
    tempRoots.push(root);
    const pluginsRoot = join(root, 'plugins');
    const outDir = join(root, 'out');

    await writePlugin(pluginsRoot, 'listed-plugin');
    await writePlugin(pluginsRoot, 'kimi-webbridge');
    await writePlugin(pluginsRoot, 'not-listed');
    await writeFile(
      join(pluginsRoot, 'marketplace.json'),
      JSON.stringify({
        version: '1',
        plugins: [{ id: 'listed-plugin', source: './official/listed-plugin' }],
      }),
      'utf8',
    );

    await buildPluginMarketplaceCdn({ pluginsRoot, outDir });

    await expect(access(join(outDir, 'official/listed-plugin.zip'))).resolves.toBeUndefined();
    await expect(access(join(outDir, 'official/kimi-webbridge.zip'))).resolves.toBeUndefined();
    await expect(access(join(outDir, 'official/not-listed.zip'))).rejects.toThrow();
    const marketplace = JSON.parse(await readFile(join(outDir, 'marketplace.json'), 'utf8'));
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].id).toBe('listed-plugin');
  });

  it('publishes the media entry and ten independent provider archives from the official catalog', async () => {
    const { pluginsRoot, outDir, entries } = await mediaFixture();
    await buildPluginMarketplaceCdn({ pluginsRoot, outDir });
    const marketplace = JSON.parse(await readFile(join(outDir, 'marketplace.json'), 'utf8'));
    expect(marketplace.plugins).toEqual(entries.map((entry) => ({ ...entry, source: `${entry.source}.zip` })));
    for (const entry of entries) {
      await expect(access(join(outDir, 'official', `${entry.id}.zip`))).resolves.toBeUndefined();
      const manifest = JSON.parse(await readFile(join(pluginsRoot, 'official', entry.id, 'kimi.plugin.json'), 'utf8'));
      expect(entry.version).toBe(manifest.version);
      expect(entry.displayName).toBe(manifest.interface.displayName);
      expect(entry.tier).toBe('official');
    }
    await expect(access(join(outDir, 'official/media-runtime.zip'))).rejects.toThrow();
  });

  it('keeps prebuilt ZIP and remote sources independent of the source distribution check', async () => {
    const { pluginsRoot, outDir } = await mediaFixture();
    await buildPluginMarketplaceCdn({ pluginsRoot, outDir });
    const prebuiltRoot = join(pluginsRoot, 'prebuilt');
    await writePlugin(prebuiltRoot, 'kimi-webbridge');
    await cp(join(outDir, 'official/kiki-media-openai.zip'), join(prebuiltRoot, 'official/kiki-media-openai.zip'));
    const entries = [
      { id: 'kiki-media-openai', source: './official/kiki-media-openai.zip', version: '0.1.0' },
      { id: 'remote-media', source: 'https://example.test/media.zip' },
    ];
    await writeFile(join(prebuiltRoot, 'marketplace.json'), JSON.stringify({ version: '1', plugins: entries }));
    const repackedDir = join(outDir, 'repacked');
    await buildPluginMarketplaceCdn({ pluginsRoot: prebuiltRoot, outDir: repackedDir });
    expect(JSON.parse(await readFile(join(repackedDir, 'marketplace.json'), 'utf8')).plugins).toEqual(entries);
    expect(await readFile(join(repackedDir, 'official/kiki-media-openai.zip'))).toEqual(
      await readFile(join(outDir, 'official/kiki-media-openai.zip')),
    );
  });

  it('rejects generated media drift before replacing an existing output', async () => {
    const { pluginsRoot, outDir } = await mediaFixture();
    await mkdir(outDir);
    await writeFile(join(outDir, '.kimi-plugin-marketplace-build.json'), '{}');
    await writeFile(join(outDir, 'previous-artifact'), 'keep');
    await writeFile(join(pluginsRoot, 'official/kiki-media-openai/runtime.mjs'), 'drift');
    await expect(buildPluginMarketplaceCdn({ pluginsRoot, outDir })).rejects.toThrow('Generated package drift');
    expect(await readFile(join(outDir, 'previous-artifact'), 'utf8')).toBe('keep');
    await expect(access(join(outDir, 'official/kiki-media.zip'))).rejects.toThrow();
  });
});

async function mediaFixture() {
  const root = await mkdtemp(join(tmpdir(), 'kimi-media-cdn-build-'));
  tempRoots.push(root);
  const pluginsRoot = join(root, 'plugins');
  const outDir = join(root, 'out');
  const sourceRoot = resolve(import.meta.dirname, '../../../../plugins');
  const catalog: Pick<MediaCatalog, 'plugins'> = JSON.parse(await readFile(join(sourceRoot, 'marketplace.json'), 'utf8'));
  const vendors = ['openai', 'google', 'ark', 'xai', 'minimax', 'stepfun', 'novita', 'agnes', 'newapi', 'comfyui'];
  const ids = ['kiki-media', ...vendors.map((vendor) => `kiki-media-${vendor}`)];
  const entries = catalog.plugins.filter((entry) => ids.includes(entry.id));
  expect(entries.map((entry) => entry.id)).toEqual(ids);
  for (const id of [...ids, 'media-runtime']) {
    await cp(join(sourceRoot, 'official', id), join(pluginsRoot, 'official', id), { recursive: true });
  }
  await writePlugin(pluginsRoot, 'kimi-webbridge');
  await writeFile(join(pluginsRoot, 'marketplace.json'), JSON.stringify({ version: '1', plugins: entries }));
  return { pluginsRoot, outDir, entries };
}

async function writePlugin(pluginsRoot: string, id: string): Promise<void> {
  const pluginDir = join(pluginsRoot, 'official', id);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, 'kimi.plugin.json'),
    JSON.stringify({ name: id, version: '1.0.0' }),
    'utf8',
  );
}
