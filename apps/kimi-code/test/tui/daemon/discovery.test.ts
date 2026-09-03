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
  resolveDaemonHome,
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
  it('resolves KIKI_HOME before the ~/.kiki default', () => {
    expect(resolveDaemonHome({ KIKI_HOME: 'C:\\kiki-home' })).toBe('C:\\kiki-home');
    expect(resolveDaemonHome({ KIMI_CODE_HOME: 'C:\\kimi-home' })).toMatch(/[\\/]\.kiki$/u);
  });

  it('parses both registry shapes and falls heartbeat back to startedAt', () => {
    expect(parseDaemonInstance(instance({ heartbeat_at: undefined }))).toMatchObject({
      serverId: 'server-1',
      pid: 42,
      host: '127.0.0.1',
      port: 57580,
      startedAt: 10,
      heartbeatAt: 10,
    });
    expect(
      parseDaemonInstance(
        JSON.stringify({
          serverId: 'server-2',
          pid: 43,
          url: 'http://0.0.0.0:57581',
          startedAt: 30,
          heartbeatAt: 40,
          workspaces: ['C:\\Repo'],
        }),
      ),
    ).toEqual({
      serverId: 'server-2',
      pid: 43,
      host: '127.0.0.1',
      port: 57581,
      startedAt: 30,
      heartbeatAt: 40,
      workspaces: ['C:\\Repo'],
    });
    expect(
      parseDaemonInstance(
        JSON.stringify({
          serverId: 'remote',
          pid: 44,
          url: 'http://example.test:57582',
          startedAt: 30,
        }),
      ),
    ).toBeNull();
  });

  it('ranks normalized workspace ancestry, then heartbeat, then start time', () => {
    expect(
      rankDaemonInstances(
        [
          {
            serverId: 'fresh',
            pid: 1,
            host: '127.0.0.1',
            port: 1,
            startedAt: 50,
            heartbeatAt: 60,
            workspaces: [],
          },
          {
            serverId: 'workspace-old',
            pid: 2,
            host: '127.0.0.1',
            port: 2,
            startedAt: 10,
            heartbeatAt: 20,
            workspaces: ['c:/repo'],
          },
          {
            serverId: 'workspace-live',
            pid: 3,
            host: '127.0.0.1',
            port: 3,
            startedAt: 5,
            heartbeatAt: 30,
            workspaces: ['C:\\REPO\\'],
          },
        ],
        'C:\\repo\\packages\\client',
      ).map((item) => item.serverId),
    ).toEqual(['workspace-live', 'workspace-old', 'fresh']);
  });

  it('scans both registry directories and probes only normalized loopback URLs', async () => {
    const home = await daemonHome();
    await mkdir(join(home, 'instances'), { recursive: true });
    await writeFile(
      join(home, 'server', 'instances', 'stale.json'),
      JSON.stringify({
        serverId: 'stale',
        pid: 1,
        url: 'http://localhost:1',
        startedAt: 10,
        heartbeatAt: 10,
      }),
    );
    await writeFile(
      join(home, 'instances', 'legacy.json'),
      instance({ host: '0.0.0.0', port: 2, heartbeat_at: 20 }),
    );
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => ({
      ok: String(url).includes(':2/'),
    }) as Response);

    await expect(discoverDaemon(home, undefined, fetch as typeof globalThis.fetch)).resolves.toEqual({
      url: 'http://127.0.0.1:2',
      token: 'secret',
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:2/api/v1/meta',
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer secret' },
    });
  });

  it('spawns with the Kiki home contract and polls until the record is live', async () => {
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
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ KIKI_HOME: home }),
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});
