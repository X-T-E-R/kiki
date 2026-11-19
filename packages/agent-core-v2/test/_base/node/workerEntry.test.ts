import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveWorkerEntry } from '#/_base/node/workerEntry';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveWorkerEntry', () => {
  it('prefers configuredEntry, then dev entry, then bundled filename, and errors when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'worker-entry-test-'));
    dirs.push(dir);
    const hostUrl = pathToFileURL(join(dir, 'host.mjs')).href;
    const configured = join(dir, 'override.mjs');
    const devPath = join(dir, 'entry.ts');
    const bundledPath = join(dir, 'query-store-worker.mjs');

    expect(fileURLToPath(resolveWorkerEntry(hostUrl, './entry.ts', 'query-store-worker.mjs', {
      configuredEntry: configured,
    }))).toBe(configured);

    expect(() => resolveWorkerEntry(hostUrl, './entry.ts', 'query-store-worker.mjs', {
      unavailableMessage: 'Custom worker missing',
    })).toThrow('Custom worker missing');

    await writeFile(bundledPath, '');
    expect(fileURLToPath(resolveWorkerEntry(hostUrl, './entry.ts', 'query-store-worker.mjs'))).toBe(bundledPath);

    await writeFile(devPath, '');
    expect(fileURLToPath(resolveWorkerEntry(hostUrl, './entry.ts', 'query-store-worker.mjs'))).toBe(devPath);
  });
});
