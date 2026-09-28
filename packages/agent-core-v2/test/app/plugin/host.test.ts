import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PluginHost } from '#/app/plugin/host';
import { parseManifest } from '#/app/plugin/manifest';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/plugin-host');

function readyHost(): Promise<PluginHost> {
  return parseManifest(fixture).then((manifest) => {
    expect(manifest.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    return new PluginHost('fixture-tool', join(fixture, 'entry.mjs'), manifest.manifest!.kiki!.tools!);
  });
}

describe('plugin host lifecycle', () => {
  it('starts only on execute, forwards progress, and stops immediately', async () => {
    const host = await readyHost();
    const progress: unknown[] = [];
    try {
      expect(host.running).toBe(false);
      await expect(host.execute('fixture_echo', { value: 'hello' }, new AbortController().signal, (update) => progress.push(update)))
        .resolves.toEqual({ output: 'hello' });
      expect(progress).toContainEqual({ kind: 'progress', percent: 50, text: 'Halfway' });
      expect(host.running).toBe(true);
    } finally { host.stop(); }
    expect(host.running).toBe(false);
    await expect(host.execute('fixture_echo', {}, new AbortController().signal)).rejects.toThrow('unloaded');
  });

  it('isolates a crashing child and lets another plugin keep running', async () => {
    const first = await readyHost();
    const second = await readyHost();
    try {
      await expect(first.execute('fixture_echo', { crash: true }, new AbortController().signal)).rejects.toThrow('exited');
      await expect(second.execute('fixture_echo', { value: 'alive' }, new AbortController().signal)).resolves.toEqual({ output: 'alive' });
    } finally { first.stop(); second.stop(); }
  });

  it('passes only the execution scope and accepts bounded image parts', async () => {
    const host = await readyHost();
    try {
      const result = await host.execute('fixture_echo', { context: true }, new AbortController().signal, undefined,
        { token: 'plugin-only' }, { workspaceRoot: fixture, approvedPaths: [fixture], imageIn: true });
      expect(JSON.parse(String(result.output))).toEqual({ workspaceRoot: fixture, approvedPaths: [fixture], imageIn: true, settings: { token: 'plugin-only' } });
      await expect(host.execute('fixture_echo', { image: true }, new AbortController().signal)).resolves.toMatchObject({ output: [
        { type: 'text', text: 'preview' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=' } },
      ] });
      await expect(host.execute('fixture_echo', { invalidImage: true }, new AbortController().signal)).rejects.toThrow('invalid tool result');
    } finally { host.stop(); }
  });

  it('delivers cancel to the child', async () => {
    const host = await readyHost();
    const abort = new AbortController();
    try {
      const execution = host.execute('fixture_echo', { wait: true }, abort.signal);
      setTimeout(() => abort.abort(), 100);
      await expect(execution).rejects.toThrow('cancelled');
    } finally { host.stop(); }
  });
});
