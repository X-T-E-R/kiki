import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validatePluginNodeEntry } from '#/cli/sub/plugin-run-node';

describe('plugin node entry boundary', () => {
  it('runs plugin entries and only the pinned host runner outside the plugin root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-plugin-node-'));
    try {
      const plugin = join(root, 'plugin');
      const outside = join(root, 'outside.mjs');
      const runner = join(root, 'hostRunner.mjs');
      const entry = join(plugin, 'entry.mjs');
      mkdirSync(plugin);
      for (const file of [entry, outside, runner]) writeFileSync(file, 'export {};\n');
      expect(await validatePluginNodeEntry(entry, ['argument'], plugin, null))
        .toEqual({ entryReal: entry, argsReal: ['argument'] });
      await expect(validatePluginNodeEntry(outside, [], plugin, runner)).rejects.toThrow('inside KIKI_PLUGIN_ROOT');
      await expect(validatePluginNodeEntry(runner, [outside], plugin, runner)).rejects.toThrow('inside KIKI_PLUGIN_ROOT');
      await expect(validatePluginNodeEntry(runner, [entry, 'extra'], plugin, runner)).rejects.toThrow('inside KIKI_PLUGIN_ROOT');
      expect(await validatePluginNodeEntry(runner, [entry], plugin, runner))
        .toEqual({ entryReal: runner, argsReal: [entry] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
