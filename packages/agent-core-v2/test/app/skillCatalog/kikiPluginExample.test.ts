import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PluginHost } from '#/app/plugin/host';
import { parseManifest } from '#/app/plugin/manifest';
import PLUGIN_REFERENCE from '../../../src/app/skillCatalog/builtin/kiki-plugin/references/authoring.md?raw';

function blocks(language: string): readonly string[] {
  return [...PLUGIN_REFERENCE.matchAll(new RegExp('```' + language + '\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]!);
}

describe('kiki-plugin bundled example', () => {
  let root: string;

  beforeAll(async () => {
    const [manifest, definitions, tile, entry] = blocks('json').concat(blocks('js'));
    root = await mkdtemp(path.join(tmpdir(), 'kiki-plugin-example-'));
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'kimi.plugin.json'), manifest!);
    await writeFile(path.join(root, 'lib', 'definitions.mjs'), definitions!);
    await writeFile(path.join(root, 'lib', 'tile.mjs'), tile!);
    await writeFile(path.join(root, 'entry.mjs'), entry!);
  });

  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('parses with the real manifest parser and keeps the entry definition in sync', async () => {
    const parsed = await parseManifest(root);
    expect(parsed.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const tools = parsed.manifest!.kiki!.tools!;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ schemaVersion: 1, name: 'tile_draw' });
    const { tileDraw } = await import(path.join(root, 'lib', 'definitions.mjs'));
    expect(JSON.stringify(tools[0])).toBe(JSON.stringify({ ...tileDraw, disclosure: 'deferred' }));
  });

  it('returns text and a host-accepted image from one tool output', async () => {
    const parsed = await parseManifest(root);
    const host = new PluginHost('kiki-tile', path.join(root, 'entry.mjs'), parsed.manifest!.kiki!.tools!);
    try {
      const result = await host.execute('tile_draw', { seed: 3, size: 32 }, new AbortController().signal);
      expect(result.isError).not.toBe(true);
      const output = result.output as readonly { type: string; text?: string; imageUrl?: { url: string } }[];
      expect(output[0]).toEqual({ type: 'text', text: 'Tile seed 3 at 32x32, 114 bytes.' });
      expect(output[1]!.type).toBe('image_url');
      expect(output[1]!.imageUrl!.url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
      const png = Buffer.from(output[1]!.imageUrl!.url.split(',')[1]!, 'base64');
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } finally { host.stop(); }
  });

  it('rejects a drifted tool definition', async () => {
    const drifted = path.join(root, 'drifted');
    await mkdir(path.join(drifted, 'lib'), { recursive: true });
    const manifest = JSON.parse(blocks('json')[0]!) as { 'x-kiki': { tools: { description: string }[] } };
    manifest['x-kiki'].tools[0]!.description = 'A different description.';
    await writeFile(path.join(drifted, 'kimi.plugin.json'), JSON.stringify(manifest));
    await writeFile(path.join(drifted, 'lib', 'definitions.mjs'), blocks('js')[0]!);
    await writeFile(path.join(drifted, 'lib', 'tile.mjs'), blocks('js')[1]!);
    await writeFile(path.join(drifted, 'entry.mjs'), blocks('js')[2]!);
    const parsed = await parseManifest(drifted);
    const host = new PluginHost('kiki-tile', path.join(drifted, 'entry.mjs'), parsed.manifest!.kiki!.tools!);
    try {
      await expect(host.execute('tile_draw', { seed: 1 }, new AbortController().signal)).rejects.toThrow('changed tool definition');
    } finally { host.stop(); }
  });
});
