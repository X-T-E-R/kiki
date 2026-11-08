import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('foreground serve exit', () => {
  it.each([false, true])('exits with a retained timer after explicit update (explicit heap: %s)', async (explicitHeap) => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-serve-exit-'));
    const home = join(root, 'home');
    const hold = join(root, 'hold.mjs');
    const repo = resolve(import.meta.dirname, '../../../..');
    await writeFile(hold, `const write = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  if (String(chunk).includes('"serverId"')) {
    setInterval(() => {}, 1_000_000);
    process.stdout.write = write;
  }
  return write.call(this, chunk, ...args);
};
`);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      '--import', './build/register-raw-text-loader.mjs',
      '--import', pathToFileURL(hold).href,
      'apps/kimi-code/src/main.ts',
      'serve', '--home', home, '--port', '0', '--idle-exit', '0ms', '--json',
    ], {
      cwd: repo,
      env: {
        ...process.env,
        KIKI_HOME: home,
        KIKI_DESKTOP_BUNDLED: '1',
        KIKI_LOG_LEVEL: 'silent',
        NODE_OPTIONS: explicitHeap ? '--max-old-space-size=8192' : '',
        KIKI_INJECTED_HEAP_OPTION: explicitHeap ? '--max-old-space-size=8192' : '',
        TSX_TSCONFIG_PATH: 'apps/kimi-code/tsconfig.dev.json',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const line = await new Promise<string>((resolveLine, reject) => {
        const timer = setTimeout(() => reject(new Error(`serve did not become ready\nstdout=${stdout}\nstderr=${stderr}`)), 60_000);
        child.stdout.on('data', () => {
          const ready = stdout.split(/\r?\n/u).find((entry) => entry.includes('"serverId"'));
          if (ready === undefined) return;
          clearTimeout(timer);
          resolveLine(ready);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`serve exited ${code} before ready\n${stderr}`));
        });
      });
      const published = JSON.parse(line) as { url?: string; serverId?: string };
      expect(published.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(published.serverId).toEqual(expect.any(String));
      const token = (await readFile(join(home, 'server.local-owner'), 'utf8')).trim();
      const response = await fetch(`${published.url}/api/desktop-lifecycle`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'update', server_id: published.serverId, consent: true, interrupt_work: false }),
      });
      const body = await response.json() as { code: number; msg?: string };
      expect(body.code, body.msg).toBe(0);
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
        const timer = setTimeout(() => {
          void (async () => {
            let runtime = '';
            try { runtime = await readFile(join(home, 'logs', 'server-runtime.log'), 'utf8'); } catch (error) { runtime = String(error); }
            child.kill();
            reject(new Error(`serve did not exit after explicit update\n${stderr}\n${runtime}`));
          })();
        }, 45_000);
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          resolveExit({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
      });
      expect(exit).toEqual({ code: 0, signal: null });
      const record = JSON.parse(await readFile(join(home, 'server', 'explicit-exit.json'), 'utf8')) as { schemaVersion: number; serverId: string; pid: number; startedAt: number; action: string };
      expect(record).toMatchObject({ schemaVersion: 1, serverId: published.serverId, pid: expect.any(Number), startedAt: expect.any(Number), action: 'update' });
      if (explicitHeap) expect(record.pid).toBe(child.pid);
      const events = (await readFile(join(home, 'logs', 'server-runtime.log'), 'utf8')).trim().split(/\r?\n/u).map((entry) => JSON.parse(entry) as { event: string; activeResources?: string[]; code?: number });
      const closed = events.find((event) => event.event === 'closed');
      expect(closed?.activeResources).toContain('Timeout');
      expect(events.at(-1)).toMatchObject({ event: 'exit', code: 0 });
    } finally {
      if (child.exitCode === null) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, 150_000);
});
