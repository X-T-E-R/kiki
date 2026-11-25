import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonSupervisor } from '../../../apps/kiki-desktop/src/main/daemonSupervisor';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

describe('Electron DaemonSupervisor <-> real in-process kap-server /api/desktop/* wire parity', () => {
  let home: string;
  let server: RunningServer;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-desktop-wire-'));
    await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
    const subSpace = join(home, 'spaces', 'work');
    await mkdir(subSpace, { recursive: true });
    await writeFile(
      join(subSpace, 'home.toml'),
      `id = "h-work"\nname = "Work space"\nbase_home = ${JSON.stringify(home)}\ncredentials_shared = true\n`,
    );
    await writeFile(
      join(home, 'homes.json'),
      JSON.stringify([{ id: 'h-work', name: 'Work space', path: subSpace }]),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: home,
      port: 0,
      logLevel: 'silent',
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('discovers the live server via real instance files and round-trips /api/desktop/spaces, /api/desktop/ssh/profiles, and /api/desktop/plugin-focus/{ack,remember} with zero HTTP mocking', async () => {
    const supervisor = new DaemonSupervisor({
      electronBinary: process.execPath,
      serverEntry: 'unused-when-attaching-to-live-daemon',
      homeDir: home,
    });

    const attached = await supervisor.attachIfRunning();
    expect(attached).not.toBeNull();
    expect(attached?.config.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(attached?.config.token).toBe(server.localOwnerToken);

    const spacesSnapshot = await supervisor.listSpacesAndStatuses('main');
    expect(spacesSnapshot.spaces.length).toBeGreaterThanOrEqual(2);
    const mainSummary = spacesSnapshot.spaces.find((entry) => entry.homeId === 'main');
    expect(mainSummary).toEqual({
      homeId: 'main',
      name: 'Main space',
      path: home,
      status: 'running',
      active: true,
      managed: false,
    });
    const workSummary = spacesSnapshot.spaces.find((entry) => entry.homeId === 'h-work');
    expect(workSummary).toEqual({
      homeId: 'h-work',
      name: 'Work space',
      path: join(home, 'spaces', 'work'),
      status: 'stopped',
      active: false,
    });
    const mainStatus = spacesSnapshot.statuses.find((entry) => entry.homeId === 'main');
    expect(mainStatus).toEqual({
      homeId: 'main',
      active: true,
      hot: true,
      pendingCount: 0,
      busyCount: 0,
    });
    const workStatus = spacesSnapshot.statuses.find((entry) => entry.homeId === 'h-work');
    expect(workStatus).toEqual({
      homeId: 'h-work',
      active: false,
      hot: false,
      pendingCount: 0,
      busyCount: 0,
    });

    expect(await supervisor.listSshProfiles()).toEqual([]);
    const saved = await supervisor.saveSshProfile({
      id: 'lab_box',
      label: 'Lab Box',
      target: { kind: 'host', hostname: 'lab.example.test', username: 'dev', port: 2222 },
      releaseChannel: 'stable',
      remotePort: 9443,
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: 'lab_box',
      label: 'Lab Box',
      target: { kind: 'host', hostname: 'lab.example.test', username: 'dev', port: 2222 },
      releaseChannel: 'stable',
      remotePort: 9443,
    });
    expect(await supervisor.listSshProfiles()).toHaveLength(1);
    expect(await supervisor.removeSshProfile('lab_box')).toEqual([]);

    expect(await supervisor.readPluginFocus('main')).toBeNull();
    await expect(supervisor.rememberPluginFocus('h-work', 42)).resolves.toBeUndefined();
    await expect(supervisor.ackPluginFocus('h-work', 42)).resolves.toBeUndefined();

    const lifecycle = await supervisor.readLifecycleState();
    expect(lifecycle).not.toBeNull();
    expect(lifecycle?.server_id).toBe(server.serverId);
    expect(lifecycle?.work_pending).toEqual([]);
  });
});
