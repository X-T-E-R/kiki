import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setPriority, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteSearchHost } from '../../src/search/sqlite/host';

const hosts: SqliteSearchHost[] = [];
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('SqliteSearchHost IPC disconnect handling', () => {
  it('handles IPC channel close before process exit with a single onExit and no spawn-error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-sqlite-ipc-'));
    homes.push(home);
    const script = join(home, 'disconnect-then-exit.mjs');
    await writeFile(
      script,
      [
        "process.send?.({ type: 'ready', writer: true });",
        "process.on('message', (msg) => {",
        "  if (msg?.type === 'sync') {",
        '    process.disconnect?.();',
        '    setTimeout(() => process.exit(1), 150);',
        '  }',
        '});',
      ].join('\n'),
    );

    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...args: unknown[]) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return origWrite(chunk, ...(args as []));
    }) as typeof process.stderr.write);

    let restartCount = 0;
    const timers: NodeJS.Timeout[] = [];
    const host = new SqliteSearchHost({
      database: join(home, 'index.sqlite'),
      indexerEntry: script,
      heartbeatMs: 15,
      backoffMs: [5_000],
      scheduleRestart: () => {
        restartCount++;
        const timer = setTimeout(() => {}, 60_000);
        timers.push(timer);
        return timer;
      },
    });
    hosts.push(host);

    await host.open();
    const child = host['child']!;
    try { if (child.pid) setPriority(child.pid, 0); } catch {}
    await expect.poll(() => host['ready'], { timeout: 10_000 }).toBe(true);

    const closedErr = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
    child.emit('error', closedErr);

    expect(host['child']).toBe(child);
    expect(restartCount).toBe(0);

    host.sync([{ id: 'trigger', dir: home, workspaceId: 'w1', updatedAt: 1 }]);
    await expect.poll(() => child.connected, { timeout: 5_000 }).toBe(false);
    expect(() => host.sync([{ id: 'after-disconnect', dir: home, workspaceId: 'w1', updatedAt: 2 }])).not.toThrow();

    await expect.poll(() => restartCount, { timeout: 5_000 }).toBe(1);
    for (const timer of timers) clearTimeout(timer);

    const joined = stderrLines.join('');
    expect(joined).not.toContain('search indexer spawn:');
    expect(joined).not.toContain('signal=spawn-error');
    expect(joined).toContain('search indexer exited code=1 signal=null');
    expect(host['failures']).toBe(1);
  });
});
