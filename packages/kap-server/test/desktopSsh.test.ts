import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopSshProfile } from '@kiki/protocol';
import { DesktopSshProfileError, DesktopSshProfileStore, defaultDesktopSshProfilePath } from '../src/services/desktopSsh/profileStore';
import { DesktopSshTunnelError, DesktopSshTunnelManager, verifyRemoteServerIdentity } from '../src/services/desktopSsh/tunnelManager';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';
import { startServer, type RunningServer } from '../src/start';

function fixtureProfile(patch: Partial<DesktopSshProfile> = {}): DesktopSshProfile {
  return {
    id: 'host-1',
    label: 'Example host',
    target: { kind: 'alias', alias: 'example' },
    releaseChannel: 'stable',
    remotePort: 58627,
    serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed',
    ...patch,
  };
}

describe('DesktopSshProfileStore', () => {
  it('round-trips profiles atomically without ever persisting tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-desktop-ssh-profiles-'));
    try {
      const store = new DesktopSshProfileStore({ filePath: defaultDesktopSshProfilePath(root) });
      const profile = fixtureProfile({ identityFile: '/home/user/.ssh/id_ed25519' });
      expect(await store.save(profile)).toEqual([profile]);
      expect(await store.list()).toEqual([profile]);
      const raw = await readFile(join(root, 'remote-connections.json'), 'utf8');
      expect(raw.includes('token')).toBe(false);
      expect(JSON.parse(raw)).toEqual([profile]);
      const updated = { ...profile, label: 'Renamed' };
      expect(await store.save(updated)).toEqual([updated]);
      expect(await store.remove('host-1')).toEqual([]);
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('rejects invalid profile content and duplicate ids without corrupting the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-desktop-ssh-invalid-'));
    try {
      const store = new DesktopSshProfileStore({ filePath: defaultDesktopSshProfilePath(root) });
      await writeFile(join(root, 'remote-connections.json'), 'not json');
      await expect(store.list()).rejects.toBeInstanceOf(DesktopSshProfileError);
      await writeFile(join(root, 'remote-connections.json'), JSON.stringify([fixtureProfile(), fixtureProfile()]));
      await expect(store.list()).rejects.toThrow('Duplicate SSH profile IDs');
      const evil = fixtureProfile({ target: { kind: 'alias', alias: '-oProxyCommand=evil' } });
      await expect(store.save(evil)).rejects.toThrow();
      const legacy = {
        ...fixtureProfile(),
        identityFile: null,
        remotePort: null,
        serverHomeId: null,
        target: { kind: 'host', hostname: 'example.com', username: null, port: null },
      };
      await writeFile(join(root, 'remote-connections.json'), JSON.stringify([legacy]));
      const normalized = await store.list();
      expect(normalized).toHaveLength(1);
      expect(normalized[0]!.identityFile).toBeUndefined();
      expect(normalized[0]!.remotePort).toBeUndefined();
      expect(normalized[0]!.serverHomeId).toBeUndefined();
      expect(normalized[0]!.target).toEqual({ kind: 'host', hostname: 'example.com' });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

describe('DesktopSshTunnelManager verification', () => {
  const token = 'a'.repeat(43);
  const probeMetaForTest = (fetchImpl: typeof fetch, probeToken: string, home: string, channel: 'stable' | 'beta') =>
    verifyRemoteServerIdentity('http://127.0.0.1:1', probeToken, home, channel, fetchImpl, 500);

  it('rejects missing manual inputs before launching ssh', async () => {
    const manager = new DesktopSshTunnelManager();
    await expect(manager.connect(fixtureProfile({ remotePort: undefined }), token, 'home-a', false))
      .rejects.toThrow(/port/i);
    await expect(manager.connect(fixtureProfile({ serverHomeId: undefined }), token, 'home-a', false))
      .rejects.toThrow(/home/i);
    await manager.shutdown();
  });

  it('rejects mismatched home identity, wrong channel, and bypassed auth in metadata verification', async () => {
    const meta = (body: object) => new Response(JSON.stringify({ code: 0, data: body }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const homeId = '46aca369-50e8-4fd3-9c45-606d084450ed';
    const wrongHome: typeof fetch = async () => meta({
      server_home_id: '00000000-0000-4000-8000-000000000000',
      server_id: 'server-one', server_version: '0.7.0', dangerous_bypass_auth: false,
    });
    await expect(probeMetaForTest(wrongHome, token, homeId, 'stable')).rejects.toThrow(/does not match/);
    const wrongChannel: typeof fetch = async () => meta({
      server_home_id: homeId,
      server_id: 'server-one', server_version: '0.7.0', dangerous_bypass_auth: false, build_channel: 'beta',
    });
    await expect(probeMetaForTest(wrongChannel, token, homeId, 'stable')).rejects.toThrow(/release channel is beta/);
    const bypassed: typeof fetch = async () => meta({
      server_home_id: homeId,
      server_id: 'server-one', server_version: '0.7.0', dangerous_bypass_auth: true,
    });
    await expect(probeMetaForTest(bypassed, token, homeId, 'stable')).rejects.toThrow(/invalid|missing/i);
    const valid: typeof fetch = async () => meta({
      server_home_id: homeId,
      server_id: 'server-one', server_version: '0.7.0', dangerous_bypass_auth: false, build_channel: 'stable',
    });
    await expect(probeMetaForTest(valid, token, homeId, 'stable')).resolves.toMatchObject({ server_id: 'server-one' });
  });

  it('rejects auth failures and oversized or invalid metadata', async () => {
    const unauthorized: typeof fetch = async () => new Response('no', { status: 401 });
    await expect(probeMetaForTest(unauthorized, token, 'x', 'stable')).rejects.toThrow(/bearer token/);
    const broken: typeof fetch = async () => new Response('not json', { status: 200 });
    await expect(probeMetaForTest(broken, token, 'x', 'stable')).rejects.toThrow(/invalid/i);
  });

  it('enforces lease scope on resume and commit, and disconnect is exact', () => {
    const manager = new DesktopSshTunnelManager();
    expect(() => manager.resume('host-1', 'missing', 'home-a')).toThrow(/expired/);
    expect(manager.isRunning('host-1', 'missing')).toBe(false);
    expect(manager.disconnect('host-1', 'missing')).toBe(false);
  });

  it('drives the staged-active lease lifecycle with a fake ssh process', async () => {
    const homeId = '46aca369-50e8-4fd3-9c45-606d084450ed';
    const tunnels: { endpoint: string; signal: AbortSignal; close(): Promise<void>; aborted: AbortController }[] = [];
    let nextPort = 41000;
    const fakeProcess = {
      async forward(): Promise<{ endpoint: string; signal: AbortSignal; close(): Promise<void> }> {
        const aborted = new AbortController();
        const tunnel = {
          endpoint: `http://127.0.0.1:${nextPort++}`,
          signal: aborted.signal,
          aborted,
          async close() { aborted.abort(); },
        };
        tunnels.push(tunnel);
        return tunnel;
      },
      async close() { for (const tunnel of tunnels) await tunnel.close(); },
    };
    const validMeta: typeof fetch = async () => new Response(JSON.stringify({ code: 0, data: {
      server_home_id: homeId, server_id: 'server-one', server_version: '0.7.0',
      dangerous_bypass_auth: false, build_channel: 'stable',
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const manager = new DesktopSshTunnelManager({ process: fakeProcess as never, fetch: validMeta });
    try {
      const profile = fixtureProfile();
      const stagedConnection = await manager.connect(profile, token, 'home-a', true);
      expect(tunnels).toHaveLength(1);
      expect(manager.isRunning('host-1', stagedConnection.tunnelId)).toBe(true);
      const resumed = manager.resume('host-1', stagedConnection.tunnelId, 'home-a');
      expect(resumed.profile.id).toBe('host-1');
      expect(() => manager.resume('host-1', stagedConnection.tunnelId, 'home-other')).toThrow(/expired/);
      manager.commit('host-1', stagedConnection.tunnelId, 'home-a');
      expect(manager.isRunning('host-1', stagedConnection.tunnelId)).toBe(true);
      const replacement = await manager.connect(profile, token, 'home-a', false);
      expect(replacement.tunnelId).not.toBe(stagedConnection.tunnelId);
      expect(manager.isRunning('host-1', stagedConnection.tunnelId)).toBe(false);
      expect(manager.isRunning('host-1', replacement.tunnelId)).toBe(true);
      expect(tunnels[0]!.aborted.signal.aborted).toBe(true);
      expect(manager.disconnect('host-1', replacement.tunnelId)).toBe(true);
      expect(manager.isRunning('host-1', replacement.tunnelId)).toBe(false);
      const final = await manager.connect(profile, token, 'home-a', false);
      expect(manager.isRunning('host-1', final.tunnelId)).toBe(true);
      await manager.shutdown();
      expect(manager.isRunning('host-1', final.tunnelId)).toBe(false);
      await expect(manager.connect(profile, token, 'home-a', false)).rejects.toThrow(/stopping|closed/i);
    } finally {
      await manager.shutdown();
    }
  });

  it('removes a lease automatically when the tunnel child exits', async () => {
    const homeId = '46aca369-50e8-4fd3-9c45-606d084450ed';
    const controllers: AbortController[] = [];
    const fakeProcess = {
      async forward(): Promise<{ endpoint: string; signal: AbortSignal; close(): Promise<void> }> {
        const controller = new AbortController();
        controllers.push(controller);
        return { endpoint: 'http://127.0.0.1:1', signal: controller.signal, async close() { controller.abort(); } };
      },
      async close() {},
    };
    const validMeta: typeof fetch = async () => new Response(JSON.stringify({ code: 0, data: {
      server_home_id: homeId, server_id: 'server-one', server_version: '0.7.0',
      dangerous_bypass_auth: false, build_channel: 'stable',
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const manager = new DesktopSshTunnelManager({ process: fakeProcess as never, fetch: validMeta });
    try {
      const connection = await manager.connect(fixtureProfile(), token, 'home-a', false);
      expect(manager.isRunning('host-1', connection.tunnelId)).toBe(true);
      controllers[0]!.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(manager.isRunning('host-1', connection.tunnelId)).toBe(false);
      expect(() => manager.resume('host-1', connection.tunnelId, 'home-a')).toThrow(/expired/);
    } finally {
      await manager.shutdown();
    }
  });
});

describe('desktop ssh REST routes', () => {
  it('serves profile CRUD over the authenticated envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-desktop-ssh-routes-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, logLevel: 'silent' });
      const base = `http://127.0.0.1:${server.port}`;
      const listResponse = await authedFetch(server, base, '/api/desktop/ssh/profiles');
      const listed = await listResponse.json() as { code: number; data: { profiles: unknown[] } };
      expect(listed.code).toBe(0);
      expect(listed.data.profiles).toEqual([]);
      const profile = fixtureProfile();
      const putResponse = await authedFetch(server, base, '/api/desktop/ssh/profiles', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile }),
      });
      const put = await putResponse.json() as { code: number; data: { profiles: DesktopSshProfile[] } };
      expect(put.code).toBe(0);
      expect(put.data.profiles).toEqual([profile]);
      const raw = await readFile(join(root, 'remote-connections.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual([profile]);
      const invalidResponse = await authedFetch(server, base, '/api/desktop/ssh/profiles', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: { ...profile, id: 'bad id with spaces' } }),
      });
      expect((await invalidResponse.json() as { code: number }).code).not.toBe(0);
      const deleteResponse = await authedFetch(server, base, '/api/desktop/ssh/profiles/host-1', { method: 'DELETE' });
      expect((await deleteResponse.json() as { code: number }).code).toBe(0);
      const tunnelState = await authedFetch(server, base, '/api/desktop/ssh/tunnels/host-1/1');
      expect(((await tunnelState.json()) as { data: { running: boolean } }).data.running).toBe(false);
      const disconnect = await authedFetch(server, base, '/api/desktop/ssh/tunnels/host-1/1', { method: 'DELETE' });
      expect(((await disconnect.json()) as { data: { disconnected: boolean } }).data.disconnected).toBe(true);
      const connectUnknown = await authedFetch(server, base, '/api/desktop/ssh/connect', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'host-1', token: 'a'.repeat(43) }),
      });
      expect((await connectUnknown.json() as { code: number }).code).not.toBe(0);
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);

  it('never writes the bearer token into the profile file on connect failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-desktop-ssh-token-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, logLevel: 'silent' });
      const base = `http://127.0.0.1:${server.port}`;
      const token = 'b'.repeat(43);
      const profile = fixtureProfile();
      await authedFetch(server, base, '/api/desktop/ssh/profiles', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile }),
      });
      await authedFetch(server, base, '/api/desktop/ssh/connect', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'host-1', token }),
      });
      const raw = await readFile(join(root, 'remote-connections.json'), 'utf8');
      expect(raw.includes(token)).toBe(false);
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);
});
