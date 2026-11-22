import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { startServer, type StartedServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const servers: StartedServer[] = [];
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

function serverEndpoint(server: StartedServer): string {
  return `http://127.0.0.1:${server.port}`;
}

async function bootServer(homeDir: string, osHomeDir: string): Promise<StartedServer> {
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(osHomeDir, { recursive: true });
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    homeDir,
    osHomeDir,
    logLevel: 'silent',
    hostIdentity: TEST_HOST_IDENTITY,
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
});
