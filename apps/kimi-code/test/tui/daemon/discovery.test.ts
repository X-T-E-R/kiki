import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discoverDaemon,
  ensureDaemon,
  parseDaemonInstance,
  rankDaemonInstances,
} from '#/tui/daemon/discovery';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function daemonHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'tui-daemon-'));
  tempDirs.push(home);
  await mkdir(join(home, 'server', 'instances'), { recursive: true });
  await writeFile(join(home, 'server.token'), 'secret\n');
  return home;
}

function instance(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    server_id: 'server-1',
    pid: 42,
    host: '127.0.0.1',
    port: 57580,
    started_at: 10,
    heartbeat_at: 20,
    ...overrides,
  });
}

describe('daemon discovery', () => {
  it('parses registry records and rejects malformed boundaries', () => {
    expect(parseDaemonInstance(instance())).toMatchObject({
      serverId: 'server-1',
      host: '127.0.0.1',
      port: 57580,
      startedAt: 10,
      heartbeatAt: 20,
    });
    expect(parseDaemonInstance(instance({ heartbeat_at: '20' }))).toBeNull();
    expect(parseDaemonInstance('{')).toBeNull();
  });

  it('ranks workspace matches before fresher unrelated instances', () => {
    expect(
      rankDaemonInstances(
        [
          { serverId: 'fresh', host: '127.0.0.1', port: 2, startedAt: 20, heartbeatAt: 30 },
          {
            serverId: 'workspace',
            host: '127.0.0.1',
            port: 1,
            startedAt: 10,
            heartbeatAt: 10,
            workspaces: ['C:\\repo'],
          },
        ],
        'C:\\repo',
      ).map((item) => item.serverId),
    ).toEqual(['workspace', 'fresh']);
  });

  it('skips stale instances and returns the first authenticated live daemon', async () => {
    const home = await daemonHome();
    await writeFile(join(home, 'server', 'instances', 'a.json'), instance({ port: 1, heartbeat_at: 30 }));
    await writeFile(join(home, 'server', 'instances', 'b.json'), instance({ port: 2, heartbeat_at: 20 }));
    const fetch = vi.fn(async (url: string | URL) => ({ ok: String(url).includes(':2/') }) as Response);

    await expect(discoverDaemon(home, undefined, fetch as typeof globalThis.fetch)).resolves.toEqual({
      url: 'http://127.0.0.1:2',
      token: 'secret',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer secret' },
    });
  });

  it('spawns the resolved executable and polls until its registry record is live', async () => {
    const home = await daemonHome();
    const child = Object.assign(new EventEmitter(), { exitCode: null, unref: vi.fn() });
    const spawn = vi.fn(() => child);
    const fetch = vi.fn(async () => ({ ok: true }) as Response);
    let sleeps = 0;

    const connection = await ensureDaemon({
      homeDir: home,
      workspacePath: 'C:\\repo',
      commandPath: 'C:\\bin\\kimi.exe',
      spawn: spawn as never,
      fetch: fetch as typeof globalThis.fetch,
      sleep: async () => {
        sleeps += 1;
        await writeFile(
          join(home, 'server', 'instances', 'spawned.json'),
          instance({ workspaces: ['C:\\repo'] }),
        );
      },
      timeoutMs: 1_000,
    });

    expect(connection.url).toBe('http://127.0.0.1:57580');
    expect(sleeps).toBe(1);
    expect(spawn).toHaveBeenCalledWith(
      'C:\\bin\\kimi.exe',
      ['web', '--no-open', '--port', '0', '--log-level', 'warn'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});
