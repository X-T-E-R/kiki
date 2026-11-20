import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CasStagingStore } from '#/app/mesh/casStaging';
import { applyGitWipDelta, exportGitWipDelta } from '#/app/mesh/gitDeltaSync';
import { HumanControllingError, HumanTakeoverManager } from '#/app/mesh/humanTakeover';
import { evaluateMeshApproval } from '#/app/mesh/meshApproval';
import {
  MESH_CONTEXT_MAX_BYTES,
  MeshLeaseStore,
  MeshStateCoalescer,
  renderMeshContext,
  type MeshStateTransition,
} from '#/app/mesh/meshLeaseStore';
import { LoopbackPortTunnelManager } from '#/app/mesh/portTunnelManager';
import { WorkspaceCopyManager } from '#/app/mesh/workspaceCopy';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { ISessionApprovalService } from '#/session/approval/approval';

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
      GIT_AUTHOR_NAME: 'Mesh Test',
      GIT_AUTHOR_EMAIL: 'mesh@example.test',
      GIT_COMMITTER_NAME: 'Mesh Test',
      GIT_COMMITTER_EMAIL: 'mesh@example.test',
    },
  }).trim();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('multi-machine mesh foundation', () => {
  it('persists session leases, enforces <= 2 KiB <mesh-context>, and burst-coalesces state transitions', async () => {
    const homeDir = makeTempDir('kiki-mesh-lease-');
    const storage = new FileStorageService(homeDir, 0o700, 0o600, true);
    const store = new MeshLeaseStore(storage);

    const unpinnedProjection = await store.projectContext('sess-unpinned');
    expect(unpinnedProjection.contextBlock).toBeNull();
    expect(unpinnedProjection.byteLength).toBe(0);

    await store.pinNode('sess-1', {
      nodeId: 'node-build-01',
      label: 'Linux Builder',
      trustTier: 'trusted_personal',
      capabilities: ['execute', 'read', 'send', 'cow_workspace', 'file_sync', 'port_tunnel', 'takeover'],
      state: 'online',
      platform: 'linux',
      createdBySession: true,
    });

    for (let i = 0; i < 45; i += 1) {
      await store.pinSeat('sess-1', {
        seatId: `seat-${String(i).padStart(2, '0')}`,
        nodeId: 'node-build-01',
        label: `Worker Seat ${i}`,
        state: i === 0 ? 'blocked' : 'running',
        summary: `Executing long-running build pipeline batch #${i} with detailed telemetry`,
        createdBySession: true,
      });
    }

    const reloadedStore = new MeshLeaseStore(storage);
    const projection = await reloadedStore.projectContext('sess-1');
    expect(projection.contextBlock).not.toBeNull();
    expect(projection.byteLength).toBeLessThanOrEqual(MESH_CONTEXT_MAX_BYTES);
    expect(Buffer.byteLength(projection.contextBlock!, 'utf8')).toBeLessThanOrEqual(2048);
    expect(projection.contextBlock).toContain('<mesh-context session="sess-1"');
    expect(projection.contextBlock).toContain('... (+');
    expect(projection.contextBlock).toContain('</mesh-context>');
    expect(renderMeshContext(projection.lease)).toBe(projection.contextBlock);

    const batches: (readonly MeshStateTransition[])[] = [];
    const coalescer = new MeshStateCoalescer((batch) => batches.push(batch), 40);
    try {
      coalescer.push({
        sessionId: 'sess-1',
        resourceKind: 'seat',
        resourceId: 'seat-00',
        previousState: 'idle',
        nextState: 'running',
        at: 1000,
      });
      coalescer.push({
        sessionId: 'sess-1',
        resourceKind: 'seat',
        resourceId: 'seat-00',
        previousState: 'running',
        nextState: 'blocked',
        at: 1010,
      });
      coalescer.push({
        sessionId: 'sess-1',
        resourceKind: 'seat',
        resourceId: 'seat-01',
        previousState: 'idle',
        nextState: 'running',
        at: 1005,
      });
      coalescer.push({
        sessionId: 'sess-1',
        resourceKind: 'seat',
        resourceId: 'seat-01',
        previousState: 'running',
        nextState: 'idle',
        at: 1015,
      });

      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
      expect(batches[0]?.[0]?.resourceId).toBe('seat-00');
      expect(batches[0]?.[0]?.previousState).toBe('idle');
      expect(batches[0]?.[0]?.nextState).toBe('blocked');
    } finally {
      coalescer.dispose();
    }
  });

  it('supports COW workspaceCopy status/diff/snapshot/apply (with yolo auto-approve and 409 takeover guard)', async () => {
    const sandbox = makeTempDir('kiki-mesh-cow-');
    const repoDir = join(sandbox, 'repo');
    const cowBaseDir = join(sandbox, 'cow-store');
    mkdirSync(repoDir, { recursive: true });

    runGit(repoDir, ['init']);
    writeFileSync(join(repoDir, 'app.ts'), 'export const version = 1;\n', 'utf8');
    writeFileSync(join(repoDir, 'legacy.ts'), 'export const legacy = true;\n', 'utf8');
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'init']);

    const manager = new WorkspaceCopyManager(cowBaseDir);
    const takeover = new HumanTakeoverManager();

    const copy = await manager.createCopy({ sourceRoot: repoDir, nodeId: 'peer-1' });
    expect(copy.copyId).toBeTruthy();

    writeFileSync(join(copy.copyPath, 'app.ts'), 'export const version = 2;\n', 'utf8');
    writeFileSync(join(copy.copyPath, 'added.ts'), 'export const added = true;\n', 'utf8');
    rmSync(join(copy.copyPath, 'legacy.ts'));

    expect(readFileSync(join(repoDir, 'app.ts'), 'utf8')).toBe('export const version = 1;\n');

    const status = await manager.status(copy.copyId);
    expect(status.dirty).toBe(true);
    expect(status.modified).toEqual(['app.ts']);
    expect(status.added).toEqual(['added.ts']);
    expect(status.deleted).toEqual(['legacy.ts']);

    const diff = await manager.diff(copy.copyId);
    expect(diff).toContain('version = 2');
    expect(diff).toContain('added.ts');

    const snap = await manager.snapshot(copy.copyId, 'pre-apply');
    expect(snap.label).toBe('pre-apply');
    expect(snap.digest).toMatch(/^[0-9a-f]{64}$/);

    takeover.acquire('peer-1', 'human', 60_000, 'user editing');
    await expect(
      manager.apply(copy.copyId, {
        permissionMode: 'yolo',
        takeoverManager: takeover,
        targetId: 'peer-1',
      }),
    ).rejects.toBeInstanceOf(HumanControllingError);

    takeover.release('peer-1', 'human');
    const applied = await manager.apply(copy.copyId, {
      permissionMode: 'yolo',
      takeoverManager: takeover,
      targetId: 'peer-1',
    });
    expect(applied.approvalVia).toBe('yolo_auto_approve');
    expect(applied.appliedFiles.toSorted()).toEqual(['added.ts', 'app.ts']);
    expect(applied.deletedFiles).toEqual(['legacy.ts']);

    expect(readFileSync(join(repoDir, 'app.ts'), 'utf8')).toBe('export const version = 2;\n');
    expect(readFileSync(join(repoDir, 'added.ts'), 'utf8')).toBe('export const added = true;\n');
    expect(() => readFileSync(join(repoDir, 'legacy.ts'), 'utf8')).toThrow();

    expect(await manager.removeCopy(copy.copyId)).toBe(true);
  }, 30_000);

  it('transfers uncommitted WIP via lightweight git delta bundle without copying node_modules or target', async () => {
    const sandbox = makeTempDir('kiki-mesh-delta-');
    const sourceRepo = join(sandbox, 'source');
    const targetRepo = join(sandbox, 'target');
    const targetWorktree = join(sandbox, 'target-wip-wt');
    const bundlePath = join(sandbox, 'wip.bundle');

    mkdirSync(sourceRepo, { recursive: true });
    runGit(sourceRepo, ['init']);
    writeFileSync(join(sourceRepo, 'main.ts'), 'export const count = 1;\n', 'utf8');
    runGit(sourceRepo, ['add', 'main.ts']);
    runGit(sourceRepo, ['commit', '-m', 'base']);

    runGit(sandbox, ['clone', sourceRepo, targetRepo]);

    writeFileSync(join(sourceRepo, 'main.ts'), 'export const count = 42;\n', 'utf8');
    writeFileSync(join(sourceRepo, 'wip-note.txt'), 'untracked wip file\n', 'utf8');
    mkdirSync(join(sourceRepo, 'node_modules', 'heavy-pkg'), { recursive: true });
    writeFileSync(join(sourceRepo, 'node_modules', 'heavy-pkg', 'big.bin'), '0'.repeat(1024), 'utf8');
    mkdirSync(join(sourceRepo, 'target', 'debug'), { recursive: true });
    writeFileSync(join(sourceRepo, 'target', 'debug', 'artifact.bin'), '1'.repeat(1024), 'utf8');

    const headBefore = runGit(sourceRepo, ['rev-parse', 'HEAD']);
    const exported = await exportGitWipDelta(sourceRepo, bundlePath, 'wip-test-1');
    expect(runGit(sourceRepo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(exported.refName).toBe('refs/kiki/wip/wip-test-1');
    expect(exported.includedDirtyFiles).toEqual(['main.ts', 'wip-note.txt']);

    const applied = await applyGitWipDelta(targetRepo, bundlePath, 'wip-test-1', targetWorktree);
    expect(applied.commit).toBe(exported.wipCommit);
    expect(readFileSync(join(targetWorktree, 'main.ts'), 'utf8')).toBe('export const count = 42;\n');
    expect(readFileSync(join(targetWorktree, 'wip-note.txt'), 'utf8')).toBe('untracked wip file\n');
    expect(() => readFileSync(join(targetWorktree, 'node_modules', 'heavy-pkg', 'big.bin'))).toThrow();
    expect(() => readFileSync(join(targetWorktree, 'target', 'debug', 'artifact.bin'))).toThrow();
  }, 30_000);

  it('deduplicates concurrent CAS transfers via transfer-*.lock and prunes stale locks older than 1h', async () => {
    const casRoot = makeTempDir('kiki-mesh-cas-');
    let now = 10_000_000;
    const store = new CasStagingStore(casRoot, 3_600_000, () => now);
    const payload = Buffer.from('deterministic-mesh-script-payload');

    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let unblockFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });

    const firstPromise = store.stageBytes(payload, {
      beforeWriteHook: async () => {
        releaseFirst();
        await gate;
      },
    });
    await firstEntered;

    const secondPromise = store.stageBytes(payload, { pollIntervalMs: 10, waitTimeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    unblockFirst();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.waitedForInFlight).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect((await store.readBlob(first.sha256))?.toString('utf8')).toBe(payload.toString('utf8'));

    const staleHash = 'a'.repeat(64);
    mkdirSync(store.locksDir, { recursive: true });
    writeFileSync(
      store.lockPath(staleHash),
      JSON.stringify({ sha256: staleHash, pid: 999999, createdAt: now - 3_700_000 }),
      'utf8',
    );
    const pruned = await store.pruneStaleLocks();
    expect(pruned).toEqual([`transfer-${staleHash}.lock`]);
  });

  it('opens loopback TCP tunnels with readiness probe and idempotently reuses healthy active tunnels', async () => {
    const echoServer = createServer((socket) => {
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', () => resolve()));
    const echoAddr = echoServer.address();
    if (echoAddr === null || typeof echoAddr === 'string') throw new Error('expected tcp address');

    const tunnels = new LoopbackPortTunnelManager();
    try {
      const first = await tunnels.ensureTunnel({
        nodeId: 'node-alpha',
        remoteHost: '127.0.0.1',
        remotePort: echoAddr.port,
      });
      expect(first.reused).toBe(false);
      expect(first.tunnel.healthy).toBe(true);
      expect(first.tunnel.localHost).toBe('127.0.0.1');
      expect(first.tunnel.localPort).toBeGreaterThan(0);

      const second = await tunnels.ensureTunnel({
        nodeId: 'node-alpha',
        remoteHost: '127.0.0.1',
        remotePort: echoAddr.port,
      });
      expect(second.reused).toBe(true);
      expect(second.tunnel.tunnelId).toBe(first.tunnel.tunnelId);
      expect(second.tunnel.localPort).toBe(first.tunnel.localPort);

      const echoed = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ host: '127.0.0.1', port: first.tunnel.localPort });
        client.once('error', reject);
        client.once('connect', () => client.write('ping-mesh-tunnel'));
        client.once('data', (chunk) => {
          const text = chunk.toString('utf8');
          client.end();
          resolve(text);
        });
      });
      expect(echoed).toBe('ping-mesh-tunnel');
    } finally {
      await tunnels.closeAll();
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  });

  it('auto-approves mesh operations straight through in yolo mode and routes non-yolo/login through ISessionApprovalService', async () => {
    const requestSpy = vi.fn<ISessionApprovalService['request']>().mockResolvedValue({
      decision: 'approved',
    });
    const approvalService = { request: requestSpy };

    for (const op of ['remote_command', 'out_of_workspace', 'cow_apply', 'file_sync', 'port_tunnel'] as const) {
      const result = await evaluateMeshApproval({
        operation: op,
        permissionMode: 'yolo',
        action: `run ${op}`,
        targetLabel: 'peer-1',
        approvalService,
      });
      expect(result.decision).toBe('approved');
      expect(result.via).toBe('yolo_auto_approve');
    }
    expect(requestSpy).not.toHaveBeenCalled();

    const loginResult = await evaluateMeshApproval({
      operation: 'interactive_login',
      permissionMode: 'yolo',
      action: 'sign in to remote account',
      targetLabel: 'peer-1',
      approvalService,
    });
    expect(loginResult.decision).toBe('approved');
    expect(loginResult.via).toBe('session_approval_service');
    expect(requestSpy).toHaveBeenCalledTimes(1);

    const manualResult = await evaluateMeshApproval({
      operation: 'remote_command',
      permissionMode: 'manual',
      action: 'npm test',
      targetLabel: 'peer-1',
      approvalService,
    });
    expect(manualResult.decision).toBe('approved');
    expect(manualResult.via).toBe('session_approval_service');
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('enforces 409 human_controlling takeover lease semantics with override and expiry', () => {
    let now = 500_000;
    const takeover = new HumanTakeoverManager(() => now);

    const lease = takeover.acquire('desktop-main', 'human', 10_000, 'user typing');
    expect(lease.holder).toBe('human');
    expect(lease.expiresAt).toBe(510_000);

    try {
      takeover.assertWritable('desktop-main');
      expect.unreachable('expected HumanControllingError');
    } catch (error) {
      expect(error).toBeInstanceOf(HumanControllingError);
      const conflict = (error as HumanControllingError).toConflictPayload();
      expect((error as HumanControllingError).status).toBe(409);
      expect(conflict).toEqual({
        error: 'human_controlling',
        targetId: 'desktop-main',
        holder: 'human',
        epoch: 1,
        expiresAt: 510_000,
      });
    }

    expect(() => takeover.assertWritable('desktop-main', { overrideHumanLease: true })).not.toThrow();

    now = 510_001;
    expect(takeover.inspect('desktop-main')).toBeUndefined();
    expect(() => takeover.assertWritable('desktop-main')).not.toThrow();
  });

  it('keeps MeshLeaseStore epochs strictly monotonic across last-unpin and expiry and enforces expectedEpoch on pin', async () => {
    let now = 1_000_000;
    const store = new MeshLeaseStore(undefined, () => now);
    const lease1 = await store.pinNode('sess-mono', {
      nodeId: 'peer-1',
      label: 'Peer 1',
      trustTier: 'trusted_personal',
      capabilities: ['read', 'send', 'execute'],
      state: 'online',
      platform: 'linux',
      createdBySession: true,
    });
    expect(lease1.epoch).toBe(1);

    await store.unpin('sess-mono', 'node', 'peer-1', 1);
    const afterUnpin = await store.getLease('sess-mono');
    expect(afterUnpin.epoch).toBe(2);

    await expect(
      store.pinNode(
        'sess-mono',
        {
          nodeId: 'peer-2',
          label: 'Peer 2',
          trustTier: 'trusted_personal',
          capabilities: ['read', 'send'],
          state: 'online',
          platform: 'linux',
          createdBySession: true,
        },
        0,
      ),
    ).rejects.toThrow(/stale_epoch|Stale epoch|epoch/i);

    const lease3 = await store.pinNode(
      'sess-mono',
      {
        nodeId: 'peer-2',
        label: 'Peer 2',
        trustTier: 'trusted_personal',
        capabilities: ['read', 'send'],
        state: 'online',
        platform: 'linux',
        createdBySession: true,
      },
      2,
    );
    expect(lease3.epoch).toBe(3);

    now += 3_600_001;
    const expired = await store.getLease('sess-mono');
    expect(expired.nodes).toEqual([]);
    expect(expired.epoch).toBe(3);

    const afterExpiryPin = await store.pinNode(
      'sess-mono',
      {
        nodeId: 'peer-3',
        label: 'Peer 3',
        trustTier: 'trusted_personal',
        capabilities: ['read', 'send'],
        state: 'online',
        platform: 'linux',
        createdBySession: true,
      },
      3,
    );
    expect(afterExpiryPin.epoch).toBe(4);
  });
});
