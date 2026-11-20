import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bootstrap,
  IConfigRegistry,
  IConfigService,
  IFileSystemStorageService,
  IMemoryScopes,
  loadNativeAgeX25519Cipher,
  logSeed,
  resolveLoggingConfig,
  sealCredentialEntry,
} from '@kiki/agent-core-v2';
import { CONNECTION_PROTOCOL } from '@kiki/protocol';

import { registerMeshRoutes } from '../src/routes/mesh';
import { registerRemoteConnectionRoutes } from '../src/routes/remoteConnections';
import { registerSyncRoutes } from '../src/routes/sync';
import { ConnectionAdmission } from '../src/services/connections/admission';
import { RemoteConnectionManager } from '../src/services/connections/manager';
import { MeshService } from '../src/services/mesh/meshService';
import { SyncService } from '../src/services/sync/syncService';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Server Test',
      GIT_AUTHOR_EMAIL: 'server@example.test',
      GIT_COMMITTER_NAME: 'Server Test',
      GIT_COMMITTER_EMAIL: 'server@example.test',
    },
  }).trim();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('kap-server mesh, sync, and trusted personal pairing routes', () => {
  it('handles mesh leases, COW workspace copies, loopback tunnels, 409 human_controlling, yolo dispatch, sync envelopes, and pairing trust tiers', async () => {
    const sandbox = makeTempDir('kiki-kap-mesh-');
    const homeDir = join(sandbox, 'home');
    const repoDir = join(sandbox, 'repo');
    const skillsDir = join(homeDir, 'skills');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(skillsDir, 'demo-skill'), { recursive: true });

    writeFileSync(
      join(homeDir, 'config.toml'),
      [
        'default_model = "portable-model"',
        '',
        '[thinking]',
        'effort = "medium"',
        '',
        '[credentials.shared_team]',
        'kind = "api_key"',
        'sync_policy = "synced"',
        'api_key = "sk-server-synced-key"',
        'updated_at = "2026-11-20T09:00:00.000Z"',
        'revision = "rev-s1"',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(homeDir, 'config.local.toml'), '[thinking]\neffort = "high"\n', 'utf8');
    writeFileSync(
      join(skillsDir, 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo\n---\nBody.\n',
      'utf8',
    );

    runGit(repoDir, ['init']);
    writeFileSync(join(repoDir, 'hello.txt'), 'hello v1\n', 'utf8');
    runGit(repoDir, ['add', 'hello.txt']);
    runGit(repoDir, ['commit', '-m', 'init']);
    runGit(repoDir, ['remote', 'add', 'origin', 'https://github.com/example-org/kap-mesh.git']);

    const { app: core, memoryReady } = bootstrap(
      {
        homeDir,
        osHomeDir: homeDir,
        cwd: repoDir,
        clientIdentity: { productName: 'kap-test', version: '0.0.1', platform: 'kap_test' },
      },
      logSeed(resolveLoggingConfig({ homeDir, env: {} })),
    );
    await core.accessor.get(IConfigService).ready;

    const echoServer = createServer((socket) => {
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', () => resolve()));
    const echoAddr = echoServer.address();
    if (echoAddr === null || typeof echoAddr === 'string') throw new Error('expected tcp address');

    const fastify = Fastify();
    const identity = { homeId: randomUUID(), hostId: 'host-primary', protocol: CONNECTION_PROTOCOL } as const;
    const admission = new ConnectionAdmission(homeDir, identity);
    await admission.ready();
    const manager = new RemoteConnectionManager(homeDir, identity);
    await manager.ready();

    const syncService = new SyncService({
      homeDir,
      osHomeDir: homeDir,
      configService: core.accessor.get(IConfigService),
      configRegistry: core.accessor.get(IConfigRegistry),
      memoryScopes: core.accessor.get(IMemoryScopes),
    });
    const deviceKey = await syncService.ensureDeviceKeypair();

    const meshService = new MeshService({
      homeDir,
      storage: core.accessor.get(IFileSystemStorageService),
    });

    registerMeshRoutes(fastify, meshService);
    registerSyncRoutes(fastify, syncService);
    registerRemoteConnectionRoutes(
      fastify,
      admission,
      manager,
      'srv-1',
      () => 'owner-token-1',
      undefined,
      {},
      undefined,
      () => undefined,
      undefined,
      () => syncService.peekDeviceRecipient(),
    );
    await fastify.ready();

    try {
      const handshakeRes = await fastify.inject({
        method: 'GET',
        url: '/api/remote-connections/handshake',
      });
      expect(handshakeRes.statusCode).toBe(200);
      expect(handshakeRes.json().data.x25519Recipient).toBe(deviceKey.recipient);

      const defaultPairRes = await fastify.inject({
        method: 'POST',
        url: '/api/remote-connections/inbound/pair-code',
        payload: {},
      });
      expect(defaultPairRes.statusCode).toBe(200);
      expect(defaultPairRes.json().data.trustTier).toBe('trusted_personal');
      expect(defaultPairRes.json().data.meshCapabilities).toContain('execute');

      const restrictedPairRes = await fastify.inject({
        method: 'POST',
        url: '/api/remote-connections/inbound/pair-code',
        payload: { trustTier: 'restricted_peer' },
      });
      expect(restrictedPairRes.statusCode).toBe(200);
      expect(restrictedPairRes.json().data.trustTier).toBe('restricted_peer');
      expect(restrictedPairRes.json().data.meshCapabilities).toEqual(['read', 'send']);

      const pinRes = await fastify.inject({
        method: 'POST',
        url: '/api/mesh/sessions/sess-mesh/leases/pin',
        payload: {
          kind: 'node',
          node: {
            nodeId: 'peer-mac',
            label: 'Workstation B',
            trustTier: 'trusted_personal',
            capabilities: ['execute', 'read', 'send'],
            state: 'online',
            platform: 'darwin',
            createdBySession: true,
          },
        },
      });
      expect(pinRes.statusCode).toBe(200);
      expect(pinRes.json().data.contextBlock).toContain('<mesh-context session="sess-mesh"');
      expect(pinRes.json().data.byteLength).toBeLessThanOrEqual(2048);

      const tunnelRes1 = await fastify.inject({
        method: 'POST',
        url: '/api/mesh/tunnels',
        payload: {
          nodeId: 'peer-mac',
          remoteHost: '127.0.0.1',
          remotePort: echoAddr.port,
          sessionId: 'sess-mesh',
          permissionMode: 'yolo',
        },
      });
      expect(tunnelRes1.statusCode).toBe(200);
      expect(tunnelRes1.json().data.reused).toBe(false);
      const tunnelId = tunnelRes1.json().data.tunnel.tunnelId as string;

      const tunnelRes2 = await fastify.inject({
        method: 'POST',
        url: '/api/mesh/tunnels',
        payload: {
          nodeId: 'peer-mac',
          remoteHost: '127.0.0.1',
          remotePort: echoAddr.port,
          sessionId: 'sess-mesh',
          permissionMode: 'yolo',
        },
      });
      expect(tunnelRes2.statusCode).toBe(200);
      expect(tunnelRes2.json().data.reused).toBe(true);
      expect(tunnelRes2.json().data.tunnel.tunnelId).toBe(tunnelId);

      const acquireRes = await fastify.inject({
        method: 'POST',
        url: '/api/mesh/takeover/peer-mac/acquire',
        payload: { holder: 'human', ttlMs: 60_000, reason: 'human typing' },
      });
      expect(acquireRes.statusCode).toBe(200);
      expect(acquireRes.json().data.holder).toBe('human');

      const blockedDispatch = await fastify.inject({
        method: 'POST',
        url: '/api/mesh/targets/peer-mac/dispatch',
        payload: {
          operation: 'remote_command',
          action: 'echo hi',
          permissionMode: 'yolo',
        },
      });
      expect(blockedDispatch.statusCode).toBe(409);
      expect(blockedDispatch.json().msg).toBe('human_controlling');
      expect(blockedDispatch.json().data.error).toBe('human_controlling');

      const overrideDispatch = await fastify.inject({
        method: 'POST',
        url: '/api/mesh/targets/peer-mac/dispatch',
        payload: {
          operation: 'remote_command',
          action: 'echo hi',
          permissionMode: 'yolo',
          overrideHumanLease: true,
        },
      });
      expect(overrideDispatch.statusCode).toBe(200);
      expect(overrideDispatch.json().data.approval.via).toBe('yolo_auto_approve');

      const releaseRes = await fastify.inject({
        method: 'POST',
        url: '/api/mesh/takeover/peer-mac/release',
        payload: { holder: 'human' },
      });
      expect(releaseRes.statusCode).toBe(200);
      expect(releaseRes.json().data.released).toBe(true);

      const copyCreate = await fastify.inject({
        method: 'POST',
        url: '/api/mesh/workspace-copies',
        payload: { sourceRoot: repoDir, nodeId: 'peer-mac', sessionId: 'sess-mesh' },
      });
      expect(copyCreate.statusCode).toBe(200);
      const copyId = copyCreate.json().data.copyId as string;
      const copyPath = copyCreate.json().data.copyPath as string;
      writeFileSync(join(copyPath, 'hello.txt'), 'hello v2\n', 'utf8');

      const copyStatus = await fastify.inject({
        method: 'GET',
        url: `/api/mesh/workspace-copies/${copyId}/status`,
      });
      expect(copyStatus.statusCode).toBe(200);
      expect(copyStatus.json().data.modified).toEqual(['hello.txt']);

      const copyApply = await fastify.inject({
        method: 'POST',
        url: `/api/mesh/workspace-copies/${copyId}/apply`,
        payload: { permissionMode: 'yolo', targetId: 'peer-mac' },
      });
      expect(copyApply.statusCode).toBe(200);
      expect(readFileSync(join(repoDir, 'hello.txt'), 'utf8')).toBe('hello v2\n');

      const peerCipher = loadNativeAgeX25519Cipher();
      const peerKey = peerCipher.generateX25519Keypair();

      const sealRes = await fastify.inject({
        method: 'POST',
        url: '/api/sync/credentials/seal',
        payload: { recipients: [deviceKey.recipient, peerKey.recipient] },
      });
      expect(sealRes.statusCode).toBe(200);
      expect(sealRes.json().data.envelopes).toHaveLength(1);

      const incomingEnvelope = sealCredentialEntry(
        'shared_team',
        {
          kind: 'api_key',
          syncPolicy: 'synced',
          apiKey: 'sk-server-synced-key-v2',
          updatedAt: '2026-11-20T12:00:00.000Z',
          revision: 'rev-s2',
        },
        [deviceKey.recipient],
        peerCipher,
      );
      const mergeRes = await fastify.inject({
        method: 'POST',
        url: '/api/sync/credentials/merge',
        payload: { envelopes: [incomingEnvelope] },
      });
      expect(mergeRes.statusCode).toBe(200);
      expect(mergeRes.json().data.applied).toEqual(['shared_team']);

      const projRes = await fastify.inject({
        method: 'POST',
        url: '/api/sync/project-identity/resolve',
        payload: { cwd: repoDir, bind: true },
      });
      expect(projRes.statusCode).toBe(200);
      expect(projRes.json().data.source).toBe('git');
      expect(projRes.json().data.projectId).toMatch(/^prj_kap-mesh_[0-9a-f]{12}$/);

      const portableRes = await fastify.inject({
        method: 'GET',
        url: '/api/sync/config/portable',
      });
      expect(portableRes.statusCode).toBe(200);
      expect(portableRes.json().data.thinking.effort).toBe('medium');
      expect(portableRes.json().data.credentials).toBeUndefined();

      const skillsPlanRes = await fastify.inject({
        method: 'GET',
        url: `/api/sync/skills/plan?work_dir=${encodeURIComponent(repoDir)}`,
      });
      expect(skillsPlanRes.statusCode).toBe(200);
      expect(skillsPlanRes.json().data.length).toBeGreaterThanOrEqual(1);
    } finally {
      await meshService.close();
      await fastify.close();
      await memoryReady.catch(() => undefined);
      await core.dispose();
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  }, 30_000);
});
