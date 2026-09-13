import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchNbSearchWorker, runNbSearchWorkerCommand } from '../src/nb-search-worker';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(code: string) {
  const base = resolve('../../.tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'nb-worker-startup-')); dirs.push(root);
  const entry = join(root, 'entry.mjs'); await writeFile(entry, code);
  return { root, host: { executable: process.execPath, entryArgs: [entry], startupTimeoutMs: 1000 } };
}
const id = '11111111-1111-4111-8111-111111111111';

describe('hosted nb-search worker launch', () => {
  it('requires worker readiness rather than OS spawn', async () => {
    const f = await fixture("if (process.argv[2] !== '--internal-nb-search-worker' || process.argv[3] !== '11111111-1111-4111-8111-111111111111') process.exit(2); process.send('nb-search-worker-ready-v1', () => process.disconnect());");
    await expect(launchNbSearchWorker(f.host, {}, id, f.root)).resolves.toBeUndefined();
  });
  it('rejects worker bootstrap exceptions before readiness', async () => {
    const f = await fixture("throw new Error('fixture boot failure');");
    await expect(launchNbSearchWorker(f.host, {}, id, f.root)).rejects.toThrow('before readiness');
  });
  it('rejects a worker that never acknowledges and terminates its own child', async () => {
    const f = await fixture('setInterval(() => {}, 1000);');
    await expect(launchNbSearchWorker({ ...f.host, startupTimeoutMs: 100 }, {}, id, f.root)).rejects.toThrow('timed out');
  });
  it('does not dispatch ordinary commands or accept an arbitrary script argument', async () => {
    expect(await runNbSearchWorkerCommand(['serve'])).toBe(false);
    await expect(runNbSearchWorkerCommand(['--internal-nb-search-worker', 'script.mjs', resolve('../../.tmp')])).rejects.toThrow('Invalid');
  });
});
