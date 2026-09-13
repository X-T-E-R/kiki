import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('native fs.watch error guard subpath', () => {
  it('loads only the shared installer instead of the SDK main graph', async () => {
    const source = await readFile(
      new URL('../src/native-fs-watch-error-guard.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toBe(
      "import '@kiki/agent-core-v2/_base/utils/nativeFsWatchErrorGuard';\n",
    );

    await import('@kiki/node-sdk/native-fs-watch-error-guard');
    const { isNativeFsWatchErrorGuardInstalled } = await import(
      '@kiki/agent-core-v2/_base/utils/nativeFsWatchErrorGuard'
    );
    expect(isNativeFsWatchErrorGuardInstalled()).toBe(true);
  });
});
