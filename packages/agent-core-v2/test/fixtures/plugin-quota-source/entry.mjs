import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));

async function gatedRead(signal, kikiHome, countName, label, readings) {
  const started = join(kikiHome, `${label}-started.txt`);
  const previousStarted = await readFile(started, 'utf8').catch(() => '0');
  await writeFile(started, String(Number(previousStarted) + 1));
  const hold = join(kikiHome, 'quota-hold');
  while (true) {
    try {
      await readFile(hold);
    } catch {
      break;
    }
    if (signal?.aborted) {
      await writeFile(join(kikiHome, `${label}-cancelled.txt`), '1');
      const error = new Error('Harness quota read cancelled');
      error.name = 'AbortError';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const file = join(kikiHome, countName);
  const previous = await readFile(file, 'utf8').catch(() => '0');
  await writeFile(file, String(Number(previous) + 1));
  return { readings };
}

export function register(api) {
  api.registerHarnessQuotaSource(manifest['x-kiki'].harnessQuotaSources[0], {
    async read({ signal, kikiHome }) {
      return gatedRead(signal, kikiHome, 'quota-reads.txt', 'example', [
        { accountId: 'exhausted', unit: 'percent', remaining: 0, readAt: '2026-11-07T03:00:00.000Z' },
        { accountId: 'work', unit: 'percent', remaining: 80, readAt: '2026-11-07T03:00:00.000Z' },
        { accountId: 'personal', unit: 'percent', remaining: 20, readAt: '2026-11-07T03:00:00.000Z' },
        { accountId: 'other', unit: 'percent', remaining: 50, readAt: '2026-11-07T03:00:00.000Z' },
      ]);
    },
  });
  api.registerHarnessQuotaSource(manifest['x-kiki'].harnessQuotaSources[1], {
    async read({ signal, kikiHome }) {
      return gatedRead(signal, kikiHome, 'quota-grok-reads.txt', 'grok', [
        { accountId: 'exhausted', unit: 'credits', remaining: 0, readAt: '2026-11-07T03:00:00.000Z' },
        { accountId: 'other', unit: 'credits', remaining: 45, readAt: '2026-11-07T03:00:00.000Z' },
        { accountId: 'grok-b@example.test', unit: 'credits', remaining: 90, readAt: '2026-11-07T03:00:00.000Z' },
        { accountId: 'grok-a@example.test', unit: 'credits', remaining: 30, readAt: '2026-11-07T03:00:00.000Z' },
      ]);
    },
  });
}
