import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMemoryStore,
  ISessionIndex,
  ISessionManager,
  IThreadCommunicationService,
  IThreadMailboxStore,
  IWorkspaceService,
  SEND_PEER_THREAD_MESSAGE,
  resolveProjectIdentity,
  type IThreadPeerSendCapability,
} from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/http';
import { CcpTunnelConnector, type CcpTunnelProcess, type CcpTunnelRunner } from '../src/services/ccpTunnel/connector';
import { startServer, type RunningServer, type StartServerOptions } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const servers: RunningServer[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Kiki Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Kiki Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  });
}

function serverEndpoint(server: RunningServer): string {
  return `http://127.0.0.1:${server.port}`;
}

async function bootServer(
  homeDir: string,
  osHomeDir: string,
  extra?: Partial<StartServerOptions>,
): Promise<RunningServer> {
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(osHomeDir, { recursive: true });
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    homeDir,
    osHomeDir,
    logLevel: 'silent',
    hostIdentity: TEST_HOST_IDENTITY,
    ...extra,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await server.close().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  }
});

describe('CCP loopback interconnect, bridge-only pairing, and full-fidelity sync', () => {
  it('pairs via loopbackEndpoint with includeGui=false, serves bidirectional thread bridges, rejects GUI broker calls, and pulls all memory scopes, ~/.agents/skills (including git-backed >256KiB), and complete sessions with immediate ISessionIndex visibility', async () => {
    const sandbox = makeTempDir('kiki-ccp-sync-');
    const homeA = join(sandbox, 'home-a');
    const osHomeA = join(sandbox, 'os-home-a');
    const workA = join(sandbox, 'work-a');
    const homeB = join(sandbox, 'home-b');
    const osHomeB = join(sandbox, 'os-home-b');
    const workB = join(sandbox, 'work-b');
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });

    const agentsSkillsB = join(osHomeB, '.agents', 'skills');
    const plainSkillDir = join(agentsSkillsB, 'colab-plain-skill');
    mkdirSync(plainSkillDir, { recursive: true });
    writeFileSync(
      join(plainSkillDir, 'SKILL.md'),
      '---\nname: colab-plain-skill\ndescription: Plain skill in ~/.agents/skills\n---\nPlain skill instructions.\n',
      'utf8',
    );
    const largePayload = Buffer.alloc(320 * 1024, 0x41);
    writeFileSync(join(plainSkillDir, 'large-reference.txt'), largePayload);

    const gitSkillsRoot = join(workB, '.agents', 'skills');
    const gitSkillDir = join(gitSkillsRoot, 'colab-git-skill');
    mkdirSync(gitSkillDir, { recursive: true });
    writeFileSync(
      join(gitSkillDir, 'SKILL.md'),
      '---\nname: colab-git-skill\ndescription: Git-backed skill\n---\nGit skill instructions.\n',
      'utf8',
    );
    writeFileSync(join(gitSkillDir, 'helper.py'), 'print("ok")\n', 'utf8');
    runGit(workB, ['init']);
    runGit(workB, ['add', '.']);
    runGit(workB, ['commit', '-m', 'init git skill']);

    const serverA = await bootServer(homeA, osHomeA);
    const serverB = await bootServer(homeB, osHomeB);
    const clientA = createKlient({ endpoint: serverEndpoint(serverA), token: serverA.localOwnerToken });
    const clientB = createKlient({ endpoint: serverEndpoint(serverB), token: serverB.localOwnerToken });

    try {
      await clientA.global.sessions.create({ sessionId: 'local-main', workDir: workA });
      await clientB.global.sessions.create({ sessionId: 'colab-main', workDir: workB });
      await serverA.core.accessor.get(ISessionManager).close('local-main');
      await serverB.core.accessor.get(ISessionManager).close('colab-main');

      const pairCode = await clientB.rest!.connections.createPairCode({ trustTier: 'trusted_personal' });
      expect(pairCode.loopbackEndpoint).toBeDefined();
      expect(pairCode.loopbackEndpoint).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
      expect(pairCode.suggestedEndpoints).not.toContain(pairCode.loopbackEndpoint);
      expect(pairCode.tlsFingerprint).toBeDefined();

      const paired = await clientA.rest!.connections.pair({
        endpoint: pairCode.loopbackEndpoint!,
        code: pairCode.code,
        label: 'colab-runtime',
        includeGui: false,
        fingerprint: pairCode.tlsFingerprint,
      });
      expect(paired.purposes).toEqual(['bridge']);
      expect(paired.purposes).not.toContain('gui');
      expect(paired.backgroundSummary).toBe(false);
      expect(paired.state).toBe('online');

      const brokerCall = await fetch(`${serverEndpoint(serverA)}/api/remote-connections/${encodeURIComponent(paired.id)}/call`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${serverA.localOwnerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operation: 'meta' }),
      });
      expect(brokerCall.status).toBe(403);
      const brokerJson = (await brokerCall.json()) as { msg?: string };
      expect(brokerJson.msg).toBe('gui_connection_required');

      const waitForReverseBridge = async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const status = await clientB.rest!.threadBridges.status();
          const reverse = status.outbound.find(
            (link) => link.grant.target.homeId === serverA.admission.identity.homeId && link.enabled && !link.grant.revoked,
          );
          if (reverse !== undefined) return reverse;
          if (Date.now() >= deadline) throw new Error(`Timed out waiting for reverse bridge: ${JSON.stringify(status)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const reverseLink = await waitForReverseBridge();

      const workspaceA = (await serverA.core.accessor.get(IWorkspaceService).list())[0]!;
      const workspaceB = (await serverB.core.accessor.get(IWorkspaceService).list())[0]!;
      const threadsA = serverA.core.accessor.get(IThreadCommunicationService);
      const threadsB = serverB.core.accessor.get(IThreadCommunicationService);
      const peerSendA = threadsA as unknown as IThreadPeerSendCapability;
      const peerSendB = threadsB as unknown as IThreadPeerSendCapability;

      const waitLocalListedFromB = async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          try {
            const listed = await threadsB.listThreads({
              caller: { workspaceId: workspaceB.id, sessionId: 'colab-main' },
              bridgeId: reverseLink.grant.id,
            });
            if (listed.threads.some((t) => t.ref.sessionId === 'local-main')) return listed;
          } catch {}
          if (Date.now() >= deadline) throw new Error('Timed out waiting for reverse WS bridge listThreads');
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const listedLocalFromB = await waitLocalListedFromB();
      const localThreadRef = listedLocalFromB.threads.find((t) => t.ref.sessionId === 'local-main')!.ref;
      const bToA = await peerSendB[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: serverB.admission.identity.hostId, workspaceId: workspaceB.id, sessionId: 'colab-main' },
        target: localThreadRef,
        content: 'Hello from bridge-only Colab over loopback TLS',
        idempotencyKey: 'colab-to-local-1',
      });
      expect(bToA.delivery).toBe('pending');
      const inboxA = await serverA.core.accessor.get(IThreadMailboxStore).readMessages({ group: 'session:local-main', limit: 10 });
      expect(inboxA.items.some((item) => item.message.content === 'Hello from bridge-only Colab over loopback TLS')).toBe(true);

      const listedColabFromA = await threadsA.listThreads({
        caller: { workspaceId: workspaceA.id, sessionId: 'local-main' },
        connectionId: paired.id,
      });
      const colabThreadRef = listedColabFromA.threads.find((t) => t.ref.sessionId === 'colab-main')!.ref;
      const aToB = await peerSendA[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: serverA.admission.identity.hostId, workspaceId: workspaceA.id, sessionId: 'local-main' },
        target: colabThreadRef,
        content: 'Dispatching GPU job to Colab',
        idempotencyKey: 'local-to-colab-1',
      });
      expect(aToB.delivery).toBe('pending');
      const inboxB = await serverB.core.accessor.get(IThreadMailboxStore).readMessages({ group: 'session:colab-main', limit: 10 });
      expect(inboxB.items.some((item) => item.message.content === 'Dispatching GPU job to Colab')).toBe(true);

      const identityA = await resolveProjectIdentity(workA);
      const identityB = await clientB.rest!.sync.resolveProjectIdentity({ cwd: workB, bind: true });
      const memB = serverB.core.accessor.get(IMemoryStore);
      const validityUntil = '2027-01-01T00:00:00.000Z';
      await memB.put({
        action: 'create',
        scope: { kind: 'global' },
        type: 'user',
        title: 'Global User Preference',
        body: 'Prefer deterministic tests.',
        basis: { kind: 'human', note: 'User preference', refs: ['session-1/t1'] },
        validity: { check: 'Recheck quarterly', until: validityUntil },
        applicability: 'portable',
        reason: 'test',
        source: { writer: 'user' },
      });
      await memB.put({
        action: 'create',
        scope: { kind: 'persona', personaId: 'nia' },
        type: 'feedback',
        title: 'Persona Voice Note',
        body: 'Keep responses crisp.',
        basis: { kind: 'observed', note: 'Observed tone' },
        applicability: 'portable',
        reason: 'test',
        source: { writer: 'user' },
      });
      await memB.put({
        action: 'create',
        scope: { kind: 'workspace', workspaceId: identityB.projectId },
        type: 'project',
        title: 'Workspace Training Note',
        body: 'Use bf16 on A100.',
        basis: { kind: 'derived', note: 'Benchmark result' },
        applicability: 'portable',
        reason: 'test',
        source: { writer: 'user' },
      });
      await memB.put({
        action: 'create',
        scope: { kind: 'persona_workspace', workspaceId: identityB.projectId, personaId: 'nia' },
        type: 'reference',
        title: 'Persona Workspace Note',
        body: 'Checkpoint path convention.',
        applicability: 'portable',
        reason: 'test',
        source: { writer: 'user' },
      });
      await memB.put({
        action: 'create',
        scope: { kind: 'global' },
        type: 'reference',
        title: 'Machine Local Ephemeral Path',
        body: 'Only valid on Colab container.',
        applicability: 'machine-local',
        reason: 'test',
        source: { writer: 'user' },
      });

      const colabSessionSummary = await serverB.core.accessor.get(ISessionIndex).get('colab-main');
      expect(colabSessionSummary).toBeDefined();
      const colabSessionRoot = join(homeB, 'sessions', colabSessionSummary!.workspaceId, 'colab-main');
      mkdirSync(join(colabSessionRoot, 'attachments'), { recursive: true });
      mkdirSync(join(colabSessionRoot, 'media'), { recursive: true });
      mkdirSync(join(colabSessionRoot, 'media-originals'), { recursive: true });
      mkdirSync(join(colabSessionRoot, 'agent-outcomes'), { recursive: true });
      mkdirSync(join(colabSessionRoot, 'agents', 'main', 'blobs'), { recursive: true });
      mkdirSync(join(colabSessionRoot, 'agents', 'main', 'tasks'), { recursive: true });
      writeFileSync(join(colabSessionRoot, 'attachments', 'metrics.txt'), 'loss=0.123\n', 'utf8');
      writeFileSync(join(colabSessionRoot, 'media', 'plot.bin'), Buffer.from([1, 2, 3, 4, 5]));
      writeFileSync(join(colabSessionRoot, 'media-originals', 'raw.bin'), Buffer.from([9, 8, 7]));
      writeFileSync(join(colabSessionRoot, 'agent-outcomes', 'final.json'), '{"ok":true}', 'utf8');
      writeFileSync(join(colabSessionRoot, 'agents', 'main', 'blobs', 'tool-blob.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      writeFileSync(join(colabSessionRoot, 'agents', 'main', 'tasks', 'task-1.json'), '{"status":"done"}', 'utf8');

      const pullReceipt = await clientA.rest!.sync.pullFromPeer(paired.id, {
        includeConfig: false,
        includeCredentials: false,
        includeMemories: true,
        includeSkills: true,
        includeGitSkills: true,
        sessions: { mode: 'ids', sessionIds: ['colab-main'] },
        workDir: workB,
        targetWorkDir: workA,
      });

      expect(pullReceipt.memoriesApplied).toBe(4);
      expect(pullReceipt.skillsApplied).toBeGreaterThanOrEqual(4);
      expect(pullReceipt.sessionsApplied).toBe(1);
      expect(pullReceipt.sessionsSkipped).toBe(0);

      const memA = serverA.core.accessor.get(IMemoryStore);
      const globalA = await memA.list({ kind: 'global' });
      expect(globalA.map((m) => m.title)).toEqual(['Global User Preference']);
      expect(globalA[0]?.basis).toEqual({ kind: 'human', note: 'User preference', refs: ['session-1/t1'] });
      expect(globalA[0]?.validity).toEqual({ check: 'Recheck quarterly', until: validityUntil });

      const personaA = await memA.list({ kind: 'persona', personaId: 'nia' });
      expect(personaA.map((m) => m.title)).toEqual(['Persona Voice Note']);
      expect(personaA[0]?.basis).toEqual({ kind: 'observed', note: 'Observed tone' });

      const wsA = await memA.list({ kind: 'workspace', workspaceId: identityA.projectId });
      expect(wsA.map((m) => m.title)).toEqual(['Workspace Training Note']);
      expect(wsA[0]?.basis).toEqual({ kind: 'derived', note: 'Benchmark result' });

      const personaWsA = await memA.list({ kind: 'persona_workspace', workspaceId: identityA.projectId, personaId: 'nia' });
      expect(personaWsA.map((m) => m.title)).toEqual(['Persona Workspace Note']);

      expect(readFileSync(join(homeA, 'skills', 'colab-plain-skill', 'SKILL.md'), 'utf8')).toContain('Plain skill instructions.');
      expect(readFileSync(join(homeA, 'skills', 'colab-plain-skill', 'large-reference.txt'))).toEqual(largePayload);
      expect(readFileSync(join(homeA, 'skills', 'colab-git-skill', 'SKILL.md'), 'utf8')).toContain('Git skill instructions.');
      expect(readFileSync(join(homeA, 'skills', 'colab-git-skill', 'helper.py'), 'utf8')).toBe('print("ok")\n');

      const indexA = serverA.core.accessor.get(ISessionIndex);
      const pulledSession = await indexA.get('colab-main');
      expect(pulledSession).toBeDefined();
      expect(pulledSession?.workspaceId).toBe(identityA.workDirKey);
      expect(pulledSession?.cwd).toBe(workA);
      const recentA = await indexA.listRecent({ limit: 10 });
      expect(recentA.items.some((item) => item.id === 'colab-main')).toBe(true);

      const pulledRootA = join(homeA, 'sessions', identityA.workDirKey, 'colab-main');
      expect(readFileSync(join(pulledRootA, 'attachments', 'metrics.txt'), 'utf8')).toBe('loss=0.123\n');
      expect(readFileSync(join(pulledRootA, 'media', 'plot.bin'))).toEqual(Buffer.from([1, 2, 3, 4, 5]));
      expect(readFileSync(join(pulledRootA, 'media-originals', 'raw.bin'))).toEqual(Buffer.from([9, 8, 7]));
      expect(readFileSync(join(pulledRootA, 'agent-outcomes', 'final.json'), 'utf8')).toBe('{"ok":true}');
      expect(readFileSync(join(pulledRootA, 'agents', 'main', 'blobs', 'tool-blob.bin'))).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      expect(readFileSync(join(pulledRootA, 'agents', 'main', 'tasks', 'task-1.json'), 'utf8')).toBe('{"status":"done"}');

      await expect(fetch(pairCode.loopbackEndpoint!.replace(/^https:/, 'http:') + '/api/remote-connections/handshake')).rejects.toThrow();

      const freshTargetDir = join(sandbox, 'fresh-unregistered-target');
      mkdirSync(freshTargetDir, { recursive: true });
      const freshIdentity = await resolveProjectIdentity(freshTargetDir);
      const freshPull = await clientA.rest!.sync.pullFromPeer(paired.id, {
        includeConfig: false,
        includeCredentials: false,
        includeMemories: true,
        includeSkills: false,
        sessions: { mode: 'ids', sessionIds: ['colab-main'] },
        targetWorkDir: freshTargetDir,
      });
      expect(freshPull.memoriesApplied).toBeGreaterThanOrEqual(2);
      expect(freshPull.sessionsApplied).toBe(0);
      expect(freshPull.sessionsSkipped).toBe(1);
      const freshWsMemories = await memA.list({ kind: 'workspace', workspaceId: freshIdentity.projectId });
      expect(freshWsMemories.map((m) => m.title)).toEqual(['Workspace Training Note']);

      const globalB = (await memB.list({ kind: 'global' })).find((m) => m.title === 'Global User Preference')!;
      await memB.put({
        action: 'update',
        scope: { kind: 'global' },
        id: globalB.id,
        expectedRevision: globalB.revision,
        type: 'reference',
        title: globalB.title,
        body: globalB.body,
        basis: globalB.basis,
        validity: null,
        applicability: 'portable',
        reason: 'change type and clear validity',
        source: { writer: 'user' },
      });
      const updatePull = await clientA.rest!.sync.pullFromPeer(paired.id, {
        includeConfig: false,
        includeCredentials: false,
        includeMemories: true,
        includeSkills: false,
        memoryScopes: ['global'],
      });
      expect(updatePull.memoriesApplied).toBe(1);
      const updatedGlobalA = (await memA.list({ kind: 'global' })).find((m) => m.title === 'Global User Preference')!;
      expect(updatedGlobalA.type).toBe('reference');
      expect(updatedGlobalA.validity).toBeUndefined();

      const rejectedImport = await clientA.rest!.sync.importBundle({
        format: 'kiki.sync-bundle.v1',
        exportedAt: new Date().toISOString(),
        sessions: [
          {
            sessionId: 'rogue-session',
            relativePath: 'state.json',
            contentBase64: Buffer.from(JSON.stringify({ workspaceId: identityA.workDirKey })).toString('base64'),
          },
          {
            sessionId: 'rogue-session',
            relativePath: 'rogue.lock',
            contentBase64: Buffer.from('nope').toString('base64'),
          },
        ],
      });
      expect(rejectedImport.sessionsApplied).toBe(0);
      expect(rejectedImport.sessionsSkipped).toBe(1);
    } finally {
      await clientA.close();
      await clientB.close();
    }
  }, 60_000);

  it('transfers artifact directories and single files between trusted file_sync peers while enforcing capability and path safety gates', async () => {
    const sandbox = makeTempDir('kiki-file-sync-');
    const homeA = join(sandbox, 'home-a');
    const osHomeA = join(sandbox, 'os-home-a');
    const homeB = join(sandbox, 'home-b');
    const osHomeB = join(sandbox, 'os-home-b');
    const serverA = await bootServer(homeA, osHomeA);
    const serverB = await bootServer(homeB, osHomeB);
    const clientA = createKlient({ endpoint: serverEndpoint(serverA), token: serverA.localOwnerToken });
    const clientB = createKlient({ endpoint: serverEndpoint(serverB), token: serverB.localOwnerToken });

    try {
      const restrictedCode = await clientB.rest!.connections.createPairCode({ trustTier: 'restricted_peer' });
      const restrictedConn = await clientA.rest!.connections.pair({
        endpoint: restrictedCode.loopbackEndpoint!,
        code: restrictedCode.code,
        label: 'restricted-b',
        includeGui: false,
        backgroundSummary: false,
      });

      const remoteArtifactDir = join(sandbox, 'remote-build', 'MyPlugin.vst3');
      mkdirSync(join(remoteArtifactDir, 'Contents', 'x86_64-linux'), { recursive: true });
      writeFileSync(join(remoteArtifactDir, 'Contents', 'x86_64-linux', 'MyPlugin.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]));
      writeFileSync(join(remoteArtifactDir, 'Contents', 'moduleinfo.json'), '{"name":"MyPlugin"}\n');
      const remoteSingleFile = join(sandbox, 'remote-build', 'MyPlugin.clap');
      writeFileSync(remoteSingleFile, Buffer.from([0xca, 0xfe, 0xba, 0xbe]));

      await expect(
        clientA.rest!.sync.pullFilesFromPeer(restrictedConn.id, {
          remotePath: remoteArtifactDir,
          localPath: join(sandbox, 'denied-pull'),
        }),
      ).rejects.toThrow();

      const noFileSyncCode = await clientB.rest!.connections.createPairCode({
        trustTier: 'trusted_personal',
        meshCapabilities: ['read', 'send'],
      });
      const noFileSyncConn = await clientA.rest!.connections.pair({
        endpoint: noFileSyncCode.loopbackEndpoint!,
        code: noFileSyncCode.code,
        label: 'trusted-no-filesync',
        includeGui: false,
        backgroundSummary: false,
      });
      await expect(
        clientA.rest!.sync.pullFilesFromPeer(noFileSyncConn.id, {
          remotePath: remoteArtifactDir,
          localPath: join(sandbox, 'denied-pull-2'),
        }),
      ).rejects.toThrow();

      const trustedCode = await clientB.rest!.connections.createPairCode({ trustTier: 'trusted_personal' });
      const trustedConn = await clientA.rest!.connections.pair({
        endpoint: trustedCode.loopbackEndpoint!,
        code: trustedCode.code,
        label: 'trusted-b',
        includeGui: false,
        backgroundSummary: false,
      });

      const pulledDir = join(sandbox, 'local-artifacts', 'MyPlugin.vst3');
      const pullDirReceipt = await clientA.rest!.sync.pullFilesFromPeer(trustedConn.id, {
        remotePath: remoteArtifactDir,
        localPath: pulledDir,
      });
      expect(pullDirReceipt.kind).toBe('directory');
      expect(pullDirReceipt.fileCount).toBe(2);
      expect(readFileSync(join(pulledDir, 'Contents', 'x86_64-linux', 'MyPlugin.so'))).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]));
      expect(readFileSync(join(pulledDir, 'Contents', 'moduleinfo.json'), 'utf8')).toBe('{"name":"MyPlugin"}\n');

      const pulledFile = join(sandbox, 'local-artifacts', 'MyPlugin.clap');
      const pullFileReceipt = await clientA.rest!.sync.pullFilesFromPeer(trustedConn.id, {
        remotePath: remoteSingleFile,
        localPath: pulledFile,
      });
      expect(pullFileReceipt.kind).toBe('file');
      expect(pullFileReceipt.fileCount).toBe(1);
      expect(readFileSync(pulledFile)).toEqual(Buffer.from([0xca, 0xfe, 0xba, 0xbe]));

      const pushedRemoteDir = join(sandbox, 'remote-pushed', 'MyPlugin.vst3');
      const pushDirReceipt = await clientA.rest!.sync.pushFilesToPeer(trustedConn.id, {
        localPath: pulledDir,
        remotePath: pushedRemoteDir,
      });
      expect(pushDirReceipt.kind).toBe('directory');
      expect(pushDirReceipt.fileCount).toBe(2);
      expect(readFileSync(join(pushedRemoteDir, 'Contents', 'x86_64-linux', 'MyPlugin.so'))).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]));

      mkdirSync(join(osHomeB, '.ssh'), { recursive: true });
      writeFileSync(join(osHomeB, '.ssh', 'id_ed25519'), 'PRIVATE\n');
      mkdirSync(join(osHomeB, '.gnupg'), { recursive: true });
      writeFileSync(join(osHomeB, '.gnupg', 'secring.gpg'), 'GPG\n');
      mkdirSync(join(homeB, 'credentials'), { recursive: true });
      writeFileSync(join(homeB, 'credentials', 'device-x25519.key'), 'AGE-SECRET\n');

      for (const secretPath of [
        join(osHomeB, '.ssh', 'id_ed25519'),
        join(osHomeB, '.gnupg', 'secring.gpg'),
        join(homeB, 'credentials', 'device-x25519.key'),
        join(homeB, 'server', 'server.local-owner'),
      ]) {
        await expect(
          clientA.rest!.sync.pullFilesFromPeer(trustedConn.id, {
            remotePath: secretPath,
            localPath: join(sandbox, 'should-not-exist'),
          }),
        ).rejects.toThrow();
      }

      const symlinkDir = join(sandbox, 'remote-symlink-dir');
      mkdirSync(symlinkDir, { recursive: true });
      let symlinkCreated = false;
      try {
        symlinkSync(remoteSingleFile, join(symlinkDir, 'escape.clap'));
        symlinkCreated = true;
      } catch {
        symlinkCreated = false;
      }
      if (symlinkCreated) {
        await expect(
          clientA.rest!.sync.pullFilesFromPeer(trustedConn.id, {
            remotePath: symlinkDir,
            localPath: join(sandbox, 'symlink-pull'),
          }),
        ).rejects.toThrow();
      }

      const header = Buffer.alloc(512, 0);
      Buffer.from('../escape.txt').copy(header, 0);
      Buffer.from('0000644\0').copy(header, 100);
      Buffer.from('0000000\0').copy(header, 108);
      Buffer.from('0000000\0').copy(header, 116);
      Buffer.from('00000000004\0').copy(header, 124);
      Buffer.from('00000000000\0').copy(header, 136);
      header.fill(0x20, 148, 156);
      header[156] = 0x30;
      let checksum = 0;
      for (const byte of header) checksum += byte;
      Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
      const bodyBlock = Buffer.alloc(512, 0);
      Buffer.from('evil').copy(bodyBlock, 0);
      const craftedTarGz = gzipSync(Buffer.concat([header, bodyBlock, Buffer.alloc(1024, 0)]));
      await expect(
        clientA.rest!.sync.importFiles({
          destinationPath: join(sandbox, 'crafted-dest'),
          kind: 'directory',
          archiveBase64: craftedTarGz.toString('base64'),
        }),
      ).rejects.toThrow();
      expect(existsSync(join(sandbox, 'escape.txt'))).toBe(false);
    } finally {
      await clientA.close();
      await clientB.close();
    }
  }, 60_000);

  it('pairs ccp:<runtimeId> without a manual code and auto-reconnects with a fresh ccp ssh prepare after tunnel 255 exit', async () => {
    const sandbox = makeTempDir('kiki-ccp-tunnel-');
    const homeA = join(sandbox, 'home-a');
    const osHomeA = join(sandbox, 'os-home-a');
    const homeB = join(sandbox, 'home-b');
    const osHomeB = join(sandbox, 'os-home-b');
    const workA = join(sandbox, 'work-a');
    const workB = join(sandbox, 'work-b');
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });

    const serverB = await bootServer(homeB, osHomeB);
    const clientB = createKlient({ endpoint: serverEndpoint(serverB), token: serverB.localOwnerToken });
    const preparedSessions: string[] = [];
    const openedTunnels: Array<{
      readonly sessionId: string;
      readonly localPort: number;
      readonly remoteTlsPort: number;
      readonly forceDrop255: () => Promise<void>;
    }> = [];
    const activeProxies = new Map<NetServer, Set<Socket>>();

    const runner: CcpTunnelRunner = {
      async prepare(runtimeId: string) {
        expect(runtimeId).toBe('rt-build-1');
        const sessionId = `ssh_session${preparedSessions.length + 1}`;
        preparedSessions.push(sessionId);
        return sessionId;
      },
      async exec(_sessionId: string, script: string) {
        if (script.includes('kiki pair')) {
          const trusted = script.includes('--trusted');
          const created = await clientB.rest!.connections.createPairCode({
            trustTier: trusted ? 'trusted_personal' : 'restricted_peer',
          });
          return JSON.stringify(created);
        }
        throw new Error(`Unexpected remote exec script: ${script}`);
      },
      async openTunnel(sessionId: string, localPort: number, remoteTlsPort: number): Promise<CcpTunnelProcess> {
        const controller = new AbortController();
        const sockets = new Set<Socket>();
        const proxy = createServer((inbound) => {
          if (controller.signal.aborted) {
            inbound.destroy();
            return;
          }
          const upstream = createConnection({ host: '127.0.0.1', port: remoteTlsPort });
          sockets.add(inbound);
          sockets.add(upstream);
          const cleanup = () => {
            sockets.delete(inbound);
            sockets.delete(upstream);
          };
          inbound.on('close', cleanup);
          upstream.on('close', cleanup);
          inbound.on('error', () => upstream.destroy());
          upstream.on('error', () => inbound.destroy());
          inbound.pipe(upstream);
          upstream.pipe(inbound);
        });
        proxy.listen(localPort, '127.0.0.1');
        await once(proxy, 'listening');
        activeProxies.set(proxy, sockets);

        const shutdown = async () => {
          if (!controller.signal.aborted) {
            controller.abort(new Error('ccp ssh connect exited with code 255'));
          }
          for (const socket of [...sockets]) socket.destroy();
          sockets.clear();
          if (activeProxies.delete(proxy)) {
            proxy.unref();
            await new Promise<void>((resolve) => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
              };
              const timer = setTimeout(done, 250);
              proxy.close(done);
            });
          }
        };

        openedTunnels.push({
          sessionId,
          localPort,
          remoteTlsPort,
          forceDrop255: shutdown,
        });

        return {
          endpoint: `https://127.0.0.1:${localPort}`,
          signal: controller.signal,
          close: shutdown,
        };
      },
      async close() {
        for (const [proxy, sockets] of [...activeProxies.entries()]) {
          for (const socket of [...sockets]) socket.destroy();
          sockets.clear();
          activeProxies.delete(proxy);
          await new Promise<void>((resolve) => { proxy.close(() => { resolve(); }); });
        }
      },
    };

    const serverA = await bootServer(homeA, osHomeA, {
      ccpTunnelConnector: new CcpTunnelConnector(runner),
    });
    const clientA = createKlient({ endpoint: serverEndpoint(serverA), token: serverA.localOwnerToken });

    try {
      await clientA.global.sessions.create({ sessionId: 'local-main', workDir: workA });
      await clientB.global.sessions.create({ sessionId: 'colab-main', workDir: workB });
      await serverA.core.accessor.get(ISessionManager).close('local-main');
      await serverB.core.accessor.get(ISessionManager).close('colab-main');

      const paired = await clientA.rest!.connections.pair({
        endpoint: 'ccp:rt-build-1',
        includeGui: false,
        trusted: true,
        backgroundSummary: false,
      });
      expect(paired.transport).toMatchObject({ kind: 'ccp_tunnel', runtimeId: 'rt-build-1' });
      expect(paired.pinnedFingerprint).toBeDefined();
      expect(paired.purposes).toEqual(['bridge']);
      expect(preparedSessions).toEqual(['ssh_session1']);
      expect(openedTunnels).toHaveLength(1);

      const workspaceA = (await serverA.core.accessor.get(IWorkspaceService).list())[0]!;
      const threadsA = serverA.core.accessor.get(IThreadCommunicationService);
      const firstList = await threadsA.listThreads({
        caller: { workspaceId: workspaceA.id, sessionId: 'local-main' },
        connectionId: paired.id,
      });
      expect(firstList.threads.some((item) => item.ref.sessionId === 'colab-main')).toBe(true);

      await openedTunnels[0]!.forceDrop255();

      const secondList = await threadsA.listThreads({
        caller: { workspaceId: workspaceA.id, sessionId: 'local-main' },
        connectionId: paired.id,
      });
      expect(secondList.threads.some((item) => item.ref.sessionId === 'colab-main')).toBe(true);
      expect(preparedSessions).toEqual(['ssh_session1', 'ssh_session2']);
      expect(openedTunnels).toHaveLength(2);
      expect(openedTunnels[1]!.sessionId).toBe('ssh_session2');
    } finally {
      await clientA.close();
      await clientB.close();
    }
  }, 60_000);
});
