import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));

export function register(api) {
  api.registerHarnessQuotaSource(manifest['x-kiki'].harnessQuotaSources[0], {
    async read({ kikiHome }) {
      const file = join(kikiHome, 'quota-reads.txt');
      const previous = await readFile(file, 'utf8').catch(() => '0');
      await writeFile(file, String(Number(previous) + 1));
      return { readings: [
        { accountId: 'work', unit: 'percent', remaining: 80, readAt: '2026-11-07T03:00:00.000Z' },
        { accountId: 'personal', unit: 'percent', remaining: 20, readAt: '2026-11-07T03:00:00.000Z' },
        { accountId: 'other', unit: 'percent', remaining: 50, readAt: '2026-11-07T03:00:00.000Z' },
      ] };
    },
  });
}
