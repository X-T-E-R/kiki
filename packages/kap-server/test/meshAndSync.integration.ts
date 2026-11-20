import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureMainAgent,
  IAgentContextInjectorService,
  IAgentContextMemoryService,
  IAgentPermissionModeService,
  IMemoryScopes,
  IMemoryStore,
  ISessionApprovalService,
  ISessionInteractionService,
  ISessionManager,
  MESH_CONTEXT_INJECTION_VARIANT,
} from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/http';

import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const tempDirs: string[] = [];
const runningServers: RunningServer[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
    stdio: 'pipe',
  });
}

function writeServerConfig(
  homeDir: string,
  extraToml = '',
  localToml?: string,
): void {
  writeFileSync(
    join(homeDir, 'config.toml'),
    [
      'default_model = "stub"',
      '[search]',
      'enabled = false',
      '[cron]',
      'manualTick = true',
      '[providers.stub]',
      'type = "openai"',
      'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"',
      '[models.stub]',
      'provider = "stub"',
      'model = "stub"',
      'max_context_size = 1000',
      extraToml,
    ].join('\n'),
    'utf8',
  );
  if (localToml !== undefined) {
    writeFileSync(join(homeDir, 'config.local.toml'), localToml, 'utf8');
  }
}

async function bootServer(
  homeDir: string,
  extra: Partial<Parameters<typeof startServer>[0]> = {},
): Promise<RunningServer> {
  const server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir,
    logLevel: 'silent',
    ...extra,
  });
  runningServers.push(server);
  return server;
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop()!;
    await server.close().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  }
});

describe('kap-server mesh, sync, and two-server integration', () => {
  it('enforces restricted_peer default, two-server remote execution, stale epoch 409, SSRF-safe tunneling, and full X25519 sync push without leaking secrets', async () => {
    const sandbox = makeTempDir('kiki-mesh-two-srv-');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const workA = join(sandbox, 'repo-a');
    const workB = join(sandbox, 'repo-b');
    const skillsA = join(homeA, 'skills');
    mkdirSync(homeA, { recursive: true });
    mkdirSync(homeB, { recursive: true });
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    mkdirSync(join(skillsA, 'portable-skill'), { recursive: true });
    mkdirSync(join(skillsA, '_private-skill'), { recursive: true });
    mkdirSync(join(skillsA, 'draft-wip'), { recursive: true });
    mkdirSync(join(skillsA, 'nosync-skill'), { recursive: true });

    writeFileSync(join(skillsA, 'portable-skill', 'SKILL.md'), '---\nname: portable-skill\ndescription: Syncs\n---\nPortable body\n', 'utf8');
    writeFileSync(join(skillsA, '_private-skill', 'SKILL.md'), '---\nname: _private-skill\ndescription: Private\n---\nPrivate\n', 'utf8');
    writeFileSync(join(skillsA, 'draft-wip', 'SKILL.md'), '---\nname: draft-wip\ndescription: Draft\n---\nDraft\n', 'utf8');
    writeFileSync(join(skillsA, 'nosync-skill', 'SKILL.md'), '---\nname: nosync-skill\nsync: false\n---\nNo sync\n', 'utf8');

    runGit(workA, ['init']);
    writeFileSync(join(workA, 'hello.txt'), 'v1\n', 'utf8');
    runGit(workA, ['add', 'hello.txt']);
    runGit(workA, ['commit', '-m', 'init']);
    runGit(workA, ['remote', 'add', 'origin', 'https://user:secret-token@github.com/example-org/two-srv.git']);

    writeServerConfig(
      homeA,
      [
        '',
        '[thinking]',
        'effort = "medium"',
        '',
        '[providers.cloud]',
        'type = "openai"',
        'base_url = "https://api.example.test/v1"',
        'credential_id = "shared_team"',
        '[providers.cloud.custom_headers]',
        'Authorization = "Bearer sk-must-not-export"',
        'X-Client-Name = "kiki-portable"',
        '',
        '[credentials.shared_team]',
        'kind = "api_key"',
        'sync_policy = "synced"',
        'api_key = "sk-synced-secret-value"',
        'updated_at = "2026-11-20T10:00:00.000Z"',
        'revision = "rev-sync-1"',
      ].join('\n'),
      [
        '[thinking]',
        'effort = "high"',
        '',
        '[branch]',
        'usage_preference = "proactive"',
        '',
        '[credentials.machine_secret]',
        'kind = "api_key"',
        'sync_policy = "machine"',
        'api_key = "sk-local-machine-only-value"',
      ].join('\n'),
    );

    writeServerConfig(
      homeB,
      [
        '',
        '[thinking]',
        'effort = "low"',
      ].join('\n'),
      [
        '[thinking]',
        'effort = "xhigh"',
        '',
        '[credentials.pinned_local_b]',
        'kind = "api_key"',
        'sync_policy = "machine"',
        'api_key = "sk-server-b-pinned-local"',
      ].join('\n'),
    );

    const serverA = await bootServer(homeA);
    const serverB = await bootServer(homeB);
    const baseA = `http://127.0.0.1:${serverA.port}`;
    const baseB = `http://127.0.0.1:${serverB.port}`;
    const clientA = createKlient({ endpoint: baseA, token: serverA.localOwnerToken });
    const clientB = createKlient({ endpoint: baseB, token: serverB.localOwnerToken });

    const echoServer = createServer((socket) => { socket.pipe(socket); });
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', () => resolve()));
    const echoAddr = echoServer.address();
    if (echoAddr === null || typeof echoAddr === 'string') throw new Error('expected tcp address');

    try {
      const cfgA = await authedFetch(serverA, baseA, '/api/config');
      expect(cfgA.status).toBe(200);
      const cfgJson = (await cfgA.json()) as {
        code: number;
        data: {
          branch?: { usagePreferenceSource?: string };
          providers?: Record<string, { credential_id?: string; has_api_key?: boolean }>;
        };
      };
      expect(cfgJson.code).toBe(0);
      expect(cfgJson.data.branch?.usagePreferenceSource).toBe('local');
      expect(cfgJson.data.providers?.['cloud']?.credential_id).toBe('shared_team');
      expect(cfgJson.data.providers?.['cloud']?.has_api_key).toBe(true);

      const portableA = await clientA.rest!.sync.exportPortableConfig();
      const portableJson = JSON.stringify(portableA);
      expect(portableJson).not.toContain('sk-must-not-export');
      expect(portableJson).not.toContain('sk-synced-secret-value');
      expect(portableJson).not.toContain('sk-local-machine-only-value');
      expect(portableJson).toContain('kiki-portable');

      const skillPlansA = await clientA.rest!.sync.planSkillsSync(workA);
      expect(JSON.stringify(skillPlansA)).not.toContain('secret-token');

      const emptyMergeReceipt = await clientB.rest!.sync.mergeCredentials({ envelopes: [] });
      expect(emptyMergeReceipt.appliedIds).toEqual([]);
      expect(JSON.stringify(emptyMergeReceipt)).not.toContain('sk-server-b-pinned-local');
      expect((emptyMergeReceipt as unknown as Record<string, unknown>)['merged']).toBeUndefined();

      const defaultPairCode = await clientB.rest!.connections.createPairCode({ allowBridge: false });
      expect(defaultPairCode.trustTier).toBe('restricted_peer');
      expect(defaultPairCode.meshCapabilities).toEqual(['read', 'send']);

      const restrictedPeer = await clientA.rest!.connections.pair({
        endpoint: baseB,
        code: defaultPairCode.code,
        label: 'Server B Restricted',
        backgroundSummary: false,
        requestBridge: false,
      });
      expect(restrictedPeer.trustTier).toBe('restricted_peer');
      expect(restrictedPeer.meshCapabilities).toEqual(['read', 'send']);
      expect(restrictedPeer.x25519Recipient).toMatch(/^age1[a-z0-9]+$/);

      const deniedExecRes = await authedFetch(serverA, baseA, `/api/mesh/targets/${encodeURIComponent(restrictedPeer.id)}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'remote_command', action: 'uname -a', permissionMode: 'yolo' }),
      });
      expect(deniedExecRes.status).toBe(403);
      expect(((await deniedExecRes.json()) as { msg: string }).msg).toBe('mesh_capability_denied');

      const restrictedLease = serverA.remoteConnections.lease(restrictedPeer.id);
      try {
        const directPromptAttempt = await serverA.remoteConnections.forward(
          restrictedPeer.id,
          { operation: 'prompt', params: { sessionId: 'any-session' }, body: { content: 'hi' } },
          restrictedLease.signal,
        );
        expect(directPromptAttempt.status).toBe(403);
        const directSyncAttempt = await serverA.remoteConnections.forward(
          restrictedPeer.id,
          { operation: 'syncBundleImport', body: { format: 'kiki.sync-bundle.v1', exportedAt: new Date().toISOString() } },
          restrictedLease.signal,
        );
        expect(directSyncAttempt.status).toBe(403);
      } finally {
        restrictedLease.release();
      }

      const inboundBeforeUpgrade = await clientB.rest!.connections.inbound();
      const activeGrant = inboundBeforeUpgrade.grants.find((g) => g.status === 'approved');
      expect(activeGrant).toBeDefined();
      const upgradedGrant = await clientB.rest!.connections.setGrantTrust(activeGrant!.id, {
        trustTier: 'trusted_personal',
      });
      expect(upgradedGrant.trustTier).toBe('trusted_personal');
      expect(upgradedGrant.meshCapabilities).toContain('execute');

      const trustedPairCode = await clientB.rest!.connections.createPairCode({
        allowBridge: false,
        trustTier: 'trusted_personal',
      });
      const trustedPeer = await clientA.rest!.connections.pair({
        endpoint: baseB,
        code: trustedPairCode.code,
        label: 'Server B Trusted',
        backgroundSummary: false,
        requestBridge: false,
      });
      expect(trustedPeer.trustTier).toBe('trusted_personal');
      expect(trustedPeer.meshCapabilities).toContain('execute');

      const createSessRes = await authedFetch(serverA, baseA, '/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: workA }, agent_config: { profile: 'agent', model: 'stub' } }),
      });
      const sessionIdA = ((await createSessRes.json()) as { data: { id: string } }).data.id;
      const liveSessionA = serverA.core.accessor.get(ISessionManager).get(sessionIdA)!;
      const mainAgentA = await ensureMainAgent(liveSessionA);
      mainAgentA.accessor.get(IAgentPermissionModeService).setMode('yolo');

      const remoteExec = await clientA.rest!.mesh.dispatchTargetAction(trustedPeer.id, {
        operation: 'remote_command',
        action: 'echo hello-from-peer',
        sessionId: sessionIdA,
      });
      expect(remoteExec['accepted']).toBe(true);
      expect((remoteExec['approval'] as { via: string }).via).toBe('yolo_auto_approve');
      expect(remoteExec['forwardedResult']).toMatchObject({
        executed: true,
        hostId: serverB.admission.identity.hostId,
        operation: 'remote_command',
        action: 'echo hello-from-peer',
      });

      const resolvedQuestion = await clientA.rest!.mesh.resolveQuestion(trustedPeer.id, {
        questionId: 'q-1',
        answer: 'Use strict mode',
        sessionId: sessionIdA,
      });
      expect(resolvedQuestion['accepted']).toBe(true);
      expect((resolvedQuestion['forwardedResult'] as { operation: string }).operation).toBe('remote_question');

      const humanLeaseB = await clientB.rest!.mesh.acquireTakeover('local', {
        holder: 'human',
        ttlMs: 60_000,
        reason: 'Operator typing',
      });
      expect(humanLeaseB.epoch).toBe(1);

      const orchOverwriteRes = await authedFetch(serverB, baseB, '/api/mesh/takeover/local/acquire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ holder: 'orchestrator', ttlMs: 30_000 }),
      });
      expect(orchOverwriteRes.status).toBe(409);
      expect(((await orchOverwriteRes.json()) as { msg: string }).msg).toBe('human_controlling');

      const remoteBlockedRes = await authedFetch(serverA, baseA, `/api/mesh/targets/${encodeURIComponent(trustedPeer.id)}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'remote_command', action: 'blocked', sessionId: sessionIdA }),
      });
      expect(remoteBlockedRes.status).toBe(409);
      expect(((await remoteBlockedRes.json()) as { msg: string }).msg).toBe('human_controlling');

      await clientB.rest!.mesh.releaseTakeover('local', { holder: 'human', expectedEpoch: humanLeaseB.epoch });

      const staleEpochRes = await authedFetch(serverA, baseA, `/api/mesh/targets/${encodeURIComponent(trustedPeer.id)}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'remote_command',
          action: 'stale-write',
          sessionId: sessionIdA,
          expectedEpoch: 999,
        }),
      });
      expect(staleEpochRes.status).toBe(409);
      expect(((await staleEpochRes.json()) as { msg: string }).msg).toBe('stale_epoch');

      const ssrfTunnelRes = await authedFetch(serverA, baseA, '/api/mesh/tunnels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodeId: trustedPeer.id,
          remoteHost: '169.254.169.254',
          remotePort: echoAddr.port,
          sessionId: sessionIdA,
        }),
      });
      expect(ssrfTunnelRes.status).toBe(403);

      const tunnelOpened = await clientA.rest!.mesh.openTunnel({
        nodeId: trustedPeer.id,
        remoteHost: '127.0.0.1',
        remotePort: echoAddr.port,
        sessionId: sessionIdA,
      });
      expect(tunnelOpened.tunnel.healthy).toBe(true);

      const echoed = await new Promise<string>((resolveEcho, rejectEcho) => {
        const sock = createConnection({ host: '127.0.0.1', port: tunnelOpened.tunnel.localPort }, () => {
          sock.write('two-server-tunnel-ok');
        });
        sock.once('data', (chunk) => {
          sock.end();
          resolveEcho(chunk.toString('utf8'));
        });
        sock.once('error', rejectEcho);
      });
      expect(echoed).toBe('two-server-tunnel-ok');

      const resolvedIdentityA = await clientA.rest!.sync.resolveProjectIdentity({ cwd: workA, bind: true });
      const memStoreA = serverA.core.accessor.get(IMemoryStore);
      await memStoreA.put({
        action: 'create',
        scope: { kind: 'workspace', workspaceId: resolvedIdentityA.projectId },
        type: 'project',
        title: 'Portable Project Rule',
        body: 'Shared across Server A and Server B.',
        reason: 'Sync test',
        source: { writer: 'user' },
        applicability: 'portable',
      });
      await memStoreA.put({
        action: 'create',
        scope: { kind: 'workspace', workspaceId: resolvedIdentityA.projectId },
        type: 'reference',
        title: 'Machine Local GPU Note',
        body: 'Must stay on Server A only.',
        reason: 'Host local',
        source: { writer: 'user' },
        applicability: 'machine-local',
      });

      const pushReceipt = await clientA.rest!.sync.pushToPeer(trustedPeer.id, {
        projectIds: [resolvedIdentityA.projectId],
        workDir: workA,
      });
      expect(pushReceipt.credentials.appliedIds).toContain('shared_team');
      expect(pushReceipt.memoriesApplied).toBe(1);
      expect(pushReceipt.skillsApplied).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(pushReceipt)).not.toContain('sk-synced-secret-value');

      const serverBConfigFile = readFileSync(join(homeB, 'config.toml'), 'utf8');
      const serverBLocalFile = readFileSync(join(homeB, 'config.local.toml'), 'utf8');
      expect(serverBConfigFile).toContain('shared_team');
      expect(serverBConfigFile).not.toContain('pinned_local_b');
      expect(serverBLocalFile).toContain('effort = "xhigh"');
      expect(serverBLocalFile).toContain('pinned_local_b');

      const memStoreB = serverB.core.accessor.get(IMemoryStore);
      const syncedMemoriesB = await memStoreB.list({ kind: 'workspace', workspaceId: resolvedIdentityA.projectId });
      expect(syncedMemoriesB.map((m) => m.title)).toEqual(['Portable Project Rule']);

      expect(readFileSync(join(homeB, 'skills', 'portable-skill', 'SKILL.md'), 'utf8')).toContain('Portable body');
      expect(() => readFileSync(join(homeB, 'skills', '_private-skill', 'SKILL.md'), 'utf8')).toThrow();
      expect(() => readFileSync(join(homeB, 'skills', 'draft-wip', 'SKILL.md'), 'utf8')).toThrow();
      expect(() => readFileSync(join(homeB, 'skills', 'nosync-skill', 'SKILL.md'), 'utf8')).toThrow();

      const cowCopy = await clientA.rest!.mesh.createWorkspaceCopy({
        sourceRoot: workA,
        nodeId: 'local',
        sessionId: sessionIdA,
      });
      const copyId = cowCopy['copyId'] as string;
      const copyPath = cowCopy['copyPath'] as string;
      writeFileSync(join(copyPath, 'hello.txt'), 'from-copy\n', 'utf8');
      writeFileSync(join(workA, 'hello.txt'), 'concurrent-owner-edit\n', 'utf8');

      const conflictApplyRes = await authedFetch(serverA, baseA, `/api/mesh/workspace-copies/${encodeURIComponent(copyId)}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdA, targetId: 'local' }),
      });
      expect(conflictApplyRes.status).toBe(409);
      expect(((await conflictApplyRes.json()) as { msg: string }).msg).toBe('source_modified');
    } finally {
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  }, 90_000);

  it('requires real human approval for interactive_login even in yolo, blocks caller permissionMode escalation, injects and clears <mesh-context>, and enforces auth under disableAuth', async () => {
    const sandbox = makeTempDir('kiki-mesh-yolo-gate-');
    const homeDir = join(sandbox, 'home');
    const workDir = join(sandbox, 'work');
    const disableAuthHome = join(sandbox, 'home-noauth');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(disableAuthHome, { recursive: true });
    writeServerConfig(homeDir);
    writeServerConfig(disableAuthHome);

    const server = await bootServer(homeDir);
    const base = `http://127.0.0.1:${server.port}`;

    const createRes = await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: workDir }, agent_config: { profile: 'agent', model: 'stub' } }),
    });
    const sessionId = ((await createRes.json()) as { data: { id: string } }).data.id;
    const session = server.core.accessor.get(ISessionManager).get(sessionId)!;
    const main = await ensureMainAgent(session);
    const permMode = main.accessor.get(IAgentPermissionModeService);
    const interaction = session.accessor.get(ISessionInteractionService);
    const approvalService = session.accessor.get(ISessionApprovalService);
    const consumerId = 'mesh-test-consumer';
    interaction.acquireConsumer(consumerId);

    try {
      permMode.setMode('yolo');

      const loginPromise = authedFetch(server, base, '/api/mesh/targets/local/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'interactive_login',
          action: 'Authenticate remote OAuth seat',
          sessionId,
        }),
      });

      let pendingId: string | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const pending = interaction.listPending('approval');
        if (pending.length > 0) {
          pendingId = pending[0]!.id;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(pendingId).toBeDefined();
      approvalService.decide(pendingId!, { decision: 'approved' });

      const loginRes = await loginPromise;
      expect(loginRes.status).toBe(200);
      const loginJson = (await loginRes.json()) as { data: { approval: { via: string; decision: string } } };
      expect(loginJson.data.approval.via).toBe('session_approval_service');
      expect(loginJson.data.approval.decision).toBe('approved');

      permMode.setMode('manual');
      const escalationPromise = authedFetch(server, base, '/api/mesh/targets/local/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'remote_command',
          action: 'attempt-escalation',
          sessionId,
          permissionMode: 'yolo',
        }),
      });

      let escalationId: string | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const pending = interaction.listPending('approval');
        if (pending.length > 0) {
          escalationId = pending[0]!.id;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(escalationId).toBeDefined();
      approvalService.decide(escalationId!, { decision: 'rejected', feedback: 'Manual mode enforced' });

      const escalationRes = await escalationPromise;
      expect(escalationRes.status).toBe(403);

      const injector = main.accessor.get(IAgentContextInjectorService);
      const contextMemory = main.accessor.get(IAgentContextMemoryService);
      await injector.reconcileAtSafeBoundary(MESH_CONTEXT_INJECTION_VARIANT);
      expect(JSON.stringify(contextMemory.get())).not.toContain('<mesh-context');

      const pinRes = await authedFetch(server, base, `/api/mesh/sessions/${encodeURIComponent(sessionId)}/leases/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'node',
          node: {
            nodeId: 'peer-studio',
            label: 'Studio Node',
            trustTier: 'trusted_personal',
            capabilities: ['execute', 'read', 'send'],
            state: 'online',
            platform: 'darwin',
            createdBySession: true,
          },
        }),
      });
      expect(pinRes.status).toBe(200);

      await injector.reconcileAtSafeBoundary(MESH_CONTEXT_INJECTION_VARIANT);
      const afterPin = contextMemory.get();
      expect(JSON.stringify(afterPin)).toContain(`<mesh-context session=\\"${sessionId}\\"`);
      const countAfterPin = afterPin.length;

      await authedFetch(server, base, `/api/mesh/sessions/${encodeURIComponent(sessionId)}/leases/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlMs: 120_000 }),
      });
      await injector.reconcileAtSafeBoundary(MESH_CONTEXT_INJECTION_VARIANT);
      expect(contextMemory.get().length).toBe(countAfterPin);

      await authedFetch(server, base, `/api/mesh/sessions/${encodeURIComponent(sessionId)}/leases/unpin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'node', id: 'peer-studio' }),
      });
      await injector.reconcileAtSafeBoundary(MESH_CONTEXT_INJECTION_VARIANT);
      expect(JSON.stringify(contextMemory.get())).toContain(`state=\\"cleared\\"`);

      const noAuthServer = await bootServer(disableAuthHome, { disableAuth: true });
      const noAuthBase = `http://127.0.0.1:${noAuthServer.port}`;
      const unauthSync = await fetch(`${noAuthBase}/api/sync/device-key`);
      expect(unauthSync.status).toBe(401);
      const unauthMesh = await fetch(`${noAuthBase}/api/mesh/tunnels`);
      expect(unauthMesh.status).toBe(401);

      const compatCode = await server.admission.createPairCode({ allowBridge: false });
      const legacyClaimRes = await fetch(`${base}/api/remote-connections/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: compatCode.code,
          source: { homeId: '11111111-1111-4111-8111-111111111111', hostId: 'legacy-client', protocol: 1 },
          sourceLabel: 'Legacy Client',
          requestBridge: false,
        }),
      });
      expect(legacyClaimRes.status).toBe(200);
      const legacyClaimData = ((await legacyClaimRes.json()) as { data: Record<string, unknown> }).data;
      expect(legacyClaimData['trustTier']).toBeUndefined();
      expect(legacyClaimData['meshCapabilities']).toBeUndefined();
      expect(legacyClaimData['x25519Recipient']).toBeUndefined();

      expect(server.core.accessor.get(IMemoryScopes)).toBeDefined();
    } finally {
      interaction.releaseConsumer(consumerId);
    }
  }, 60_000);
});
