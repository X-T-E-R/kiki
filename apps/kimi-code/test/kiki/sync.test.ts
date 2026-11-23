import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import type {
  BridgePolicy,
  ConnectionPairRequest,
  PairCodeCreateInput,
  PairCodeCreateOutput,
  RemoteConnection,
  SyncBundleImportReceipt,
  SyncFilesExportInput,
  SyncFilesImportInput,
  SyncPeerFilesPullInput,
  SyncPeerFilesPushInput,
  SyncPeerTransferInput,
} from '@kiki/protocol';
import { registerSyncCommand } from '../../src/kiki/sync';
import { registerConnectionsCommand } from '../../src/kiki/connections';
import { registerThreadBridgesCommand } from '../../src/kiki/thread-bridges';
import type { RemoteCommandRunner } from '../../src/kiki/remote-transport';

const STUB_SERVER = {
  url: 'http://127.0.0.1:41000',
  token: 'tok',
  homeDir: '/tmp/home',
  port: 41000,
  started: false,
  serverId: 'srv-1',
};

function createReceipt(overrides: Partial<SyncBundleImportReceipt> = {}): SyncBundleImportReceipt {
  return {
    configDomainsApplied: [],
    credentials: { appliedIds: [], skippedIds: [], conflictIds: [], revision: 'cred:0' },
    memoriesApplied: 3,
    memoriesSkipped: 1,
    skillsApplied: 2,
    skillsSkipped: 0,
    sessionsApplied: 1,
    sessionsSkipped: 0,
    ...overrides,
  };
}

describe('kiki sync CLI', () => {
  it('pulls memories and skills by default without config or credentials and preserves cross-OS paths', async () => {
    const pullCalls: Array<{ peerId: string; input: SyncPeerTransferInput }> = [];
    const stdout: string[] = [];
    const close = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    registerSyncCommand(program, {
      ensureServer: async () => STUB_SERVER,
      createKlient: (() => ({
        rest: {
          sync: {
            pullFromPeer: async (peerId: string, input: SyncPeerTransferInput) => {
              pullCalls.push({ peerId, input });
              return createReceipt();
            },
            pushToPeer: async () => createReceipt(),
          },
        },
        close,
      })) as unknown as typeof import('@kiki/klient/http').createKlient,
      stdout: { write: (chunk: string) => stdout.push(chunk) },
    });

    await program.parseAsync([
      'node',
      'kiki',
      'sync',
      'pull',
      'colab-a100',
      '--include-git-skills',
      '--sessions',
      'recent:5',
      '--work-dir',
      '/content/project',
      '--target-work-dir',
      'C:\\work\\project',
      '--memory-scopes',
      'global,workspace',
      '--json',
    ]);

    expect(pullCalls).toHaveLength(1);
    expect(pullCalls[0]).toEqual({
      peerId: 'colab-a100',
      input: {
        includeMemories: true,
        includeSkills: true,
        includeGitSkills: true,
        includeConfig: false,
        includeCredentials: false,
        sessions: { mode: 'recent', count: 5 },
        workDir: '/content/project',
        targetWorkDir: 'C:\\work\\project',
        memoryScopes: ['global', 'workspace'],
      },
    });
    expect(JSON.parse(stdout.join(''))).toEqual(createReceipt());
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('supports push with --no-memories, --no-skills, --config, --credentials, and comma-separated session IDs', async () => {
    const pushCalls: Array<{ peerId: string; input: SyncPeerTransferInput }> = [];
    const stdout: string[] = [];
    const program = new Command().exitOverride();
    registerSyncCommand(program, {
      ensureServer: async () => STUB_SERVER,
      createKlient: (() => ({
        rest: {
          sync: {
            pullFromPeer: async () => createReceipt(),
            pushToPeer: async (peerId: string, input: SyncPeerTransferInput) => {
              pushCalls.push({ peerId, input });
              return createReceipt({ configDomainsApplied: ['thinking'], sessionsApplied: 2 });
            },
          },
        },
        close: async () => undefined,
      })) as unknown as typeof import('@kiki/klient/http').createKlient,
      stdout: { write: (chunk: string) => stdout.push(chunk) },
    });

    await program.parseAsync([
      'node',
      'kiki',
      'sync',
      'push',
      'peer-2',
      '--no-memories',
      '--no-skills',
      '--config',
      '--credentials',
      '--sessions',
      'sess-a,sess-b',
    ]);

    expect(pushCalls[0]?.input).toEqual({
      includeMemories: false,
      includeSkills: false,
      includeConfig: true,
      includeCredentials: true,
      sessions: { mode: 'ids', sessionIds: ['sess-a', 'sess-b'] },
    });
    const text = stdout.join('');
    expect(text).toContain('Sync push (peer-2) complete:');
    expect(text).toContain('Sessions: 2 applied, 0 skipped');
    expect(text).toContain('Config domains: thinking');
  });
});

describe('kiki pair CLI enhancements', () => {
  it('supports --trusted and --json and prints loopbackEndpoint in human output', async () => {
    const createCalls: PairCodeCreateInput[] = [];
    const pairCalls: ConnectionPairRequest[] = [];
    const stdout: string[] = [];
    const sampleCode: PairCodeCreateOutput = {
      code: 'ABCD-EFGH',
      expiresAt: Date.now() + 600_000,
      target: { homeId: 'home-b', hostId: 'host-b', protocol: 1 },
      tlsFingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      suggestedEndpoints: ['https://192.168.1.20:54321'],
      loopbackEndpoint: 'https://127.0.0.1:59123',
      bridgeOperations: ['read', 'send', 'wait'],
      trustTier: 'trusted_personal',
    };
    const sampleRecord: RemoteConnection = {
      id: 'conn-1',
      label: 'colab',
      endpoint: 'https://127.0.0.1:59123',
      target: { homeId: 'home-b', hostId: 'host-b', protocol: 1 },
      credentialRef: 'cred-1',
      enabled: true,
      backgroundSummary: false,
      state: 'online',
      purposes: ['bridge'],
      activeLeases: 0,
      pinnedFingerprint: sampleCode.tlsFingerprint,
      trustTier: 'trusted_personal',
    };
    const deps = {
      ensureServer: async () => STUB_SERVER,
      createKlient: (() => ({
        rest: {
          connections: {
            createPairCode: async (input: PairCodeCreateInput) => {
              createCalls.push(input);
              return sampleCode;
            },
            pair: async (input: ConnectionPairRequest) => {
              pairCalls.push(input);
              return sampleRecord;
            },
          },
        },
        close: async () => undefined,
      })) as unknown as typeof import('@kiki/klient/http').createKlient,
      stdout: { write: (chunk: string) => stdout.push(chunk) },
    };

    const p1 = new Command().exitOverride();
    registerConnectionsCommand(p1, deps);
    await p1.parseAsync(['node', 'kiki', 'pair', '--trusted']);
    expect(createCalls[0]).toEqual({ trustTier: 'trusted_personal' });
    expect(stdout.join('')).toContain('Loopback peer (for SSH -L): https://127.0.0.1:59123');

    stdout.length = 0;
    const p2 = new Command().exitOverride();
    registerConnectionsCommand(p2, deps);
    await p2.parseAsync(['node', 'kiki', 'pair', '--trusted', '--json']);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      code: 'ABCD-EFGH',
      loopbackEndpoint: 'https://127.0.0.1:59123',
      trustTier: 'trusted_personal',
    });

    stdout.length = 0;
    const p3 = new Command().exitOverride();
    registerConnectionsCommand(p3, deps);
    await p3.parseAsync(['node', 'kiki', 'pair', 'https://127.0.0.1:59123', 'ABCD-EFGH', '--bridge-only', '--label', 'colab', '--json']);
    expect(pairCalls[0]).toMatchObject({
      endpoint: 'https://127.0.0.1:59123',
      code: 'ABCD-EFGH',
      label: 'colab',
      includeGui: false,
      backgroundSummary: false,
    });
    expect(JSON.parse(stdout.join(''))).toMatchObject({ id: 'conn-1', purposes: ['bridge'] });

    stdout.length = 0;
    const p4 = new Command().exitOverride();
    registerConnectionsCommand(p4, deps);
    await p4.parseAsync(['node', 'kiki', 'pair', 'ccp:rt-build-1', '--bridge-only', '--trusted', '--json']);
    expect(pairCalls[1]).toMatchObject({
      endpoint: 'ccp:rt-build-1',
      includeGui: false,
      trusted: true,
      backgroundSummary: false,
    });
    expect(pairCalls[1]?.code).toBeUndefined();
  });
});

describe('kiki sync files and bridges approve CLI', () => {
  it('supports kiki sync files pull/push for paired peers and ccp:<runtimeId> targets with secret path guards', async () => {
    const peerPulls: Array<{ peerId: string; input: SyncPeerFilesPullInput }> = [];
    const peerPushes: Array<{ peerId: string; input: SyncPeerFilesPushInput }> = [];
    const importedFiles: SyncFilesImportInput[] = [];
    const exportedFiles: SyncFilesExportInput[] = [];
    const remoteInvocations: Array<{ command: string; args: readonly string[] }> = [];
    const stdout: string[] = [];

    const runRemote: RemoteCommandRunner = async (command, args, _inputFile, outputFile) => {
      remoteInvocations.push({ command, args });
      if (args[0] === 'ssh' && args[1] === 'prepare') {
        return JSON.stringify({ id: 'ssh_abc123' });
      }
      if (outputFile !== undefined) {
        const framed = Buffer.concat([Buffer.from('KIKI-DIR\n'), Buffer.from('fake-gzip-bytes')]);
        await writeFile(outputFile, framed);
      }
      return '';
    };

    const makeProgram = () => {
      const program = new Command().exitOverride();
      registerSyncCommand(program, {
        ensureServer: async () => STUB_SERVER,
        runRemote,
        createKlient: (() => ({
          rest: {
            sync: {
              pullFilesFromPeer: async (peerId: string, input: SyncPeerFilesPullInput) => {
                peerPulls.push({ peerId, input });
                return { kind: 'directory' as const, destinationPath: input.localPath, fileCount: 2, totalBytes: 512, files: ['a.so', 'b.json'] };
              },
              pushFilesToPeer: async (peerId: string, input: SyncPeerFilesPushInput) => {
                peerPushes.push({ peerId, input });
                return { kind: 'file' as const, destinationPath: input.remotePath, fileCount: 1, totalBytes: 64, files: ['plugin.clap'] };
              },
              importFiles: async (input: SyncFilesImportInput) => {
                importedFiles.push(input);
                return { kind: input.kind, destinationPath: input.destinationPath, fileCount: 3, totalBytes: 1024, files: ['Contents/Info.plist'] };
              },
              exportFiles: async (input: SyncFilesExportInput) => {
                exportedFiles.push(input);
                return { kind: 'directory' as const, rootName: 'dist', fileCount: 2, totalBytes: 256, archiveBase64: Buffer.from('tar-gz-data').toString('base64') };
              },
            },
          },
          close: async () => undefined,
        })) as unknown as typeof import('@kiki/klient/http').createKlient,
        stdout: { write: (chunk: string) => stdout.push(chunk) },
      });
      return program;
    };

    await makeProgram().parseAsync(['node', 'kiki', 'sync', 'files', 'pull', 'peer-gpu', '/content/MyPlugin.vst3', '/tmp/MyPlugin.vst3', '--json']);
    expect(peerPulls).toHaveLength(1);
    expect(peerPulls[0]?.peerId).toBe('peer-gpu');
    expect(peerPulls[0]?.input.remotePath).toBe('/content/MyPlugin.vst3');
    expect(JSON.parse(stdout.join(''))).toMatchObject({ kind: 'directory', fileCount: 2 });

    stdout.length = 0;
    await makeProgram().parseAsync(['node', 'kiki', 'sync', 'files', 'push', 'peer-gpu', '/tmp/plugin.clap', '/content/plugin.clap', '--json']);
    expect(peerPushes).toHaveLength(1);
    expect(peerPushes[0]?.input.remotePath).toBe('/content/plugin.clap');

    stdout.length = 0;
    await makeProgram().parseAsync(['node', 'kiki', 'sync', 'files', 'pull', 'ccp:rt-build-1', '/content/build/MyPlugin.vst3', '/tmp/out/MyPlugin.vst3', '--json']);
    expect(importedFiles).toHaveLength(1);
    expect(importedFiles[0]?.kind).toBe('directory');
    expect(Buffer.from(importedFiles[0]!.archiveBase64, 'base64').toString('utf8')).toBe('fake-gzip-bytes');

    stdout.length = 0;
    await makeProgram().parseAsync(['node', 'kiki', 'sync', 'files', 'push', 'ccp:rt-build-1', '/tmp/dist', '/content/dist', '--json']);
    expect(exportedFiles).toHaveLength(1);
    expect(remoteInvocations.some((entry) => entry.command === 'ccp' && entry.args[1] === 'connect')).toBe(true);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ kind: 'directory', destinationPath: '/content/dist', fileCount: 2 });

    await expect(
      makeProgram().parseAsync(['node', 'kiki', 'sync', 'files', 'pull', 'ccp:rt-build-1', '~/.ssh/id_ed25519', '/tmp/stolen']),
    ).rejects.toThrow('forbidden secret location');
  });

  it('passes permissionCeiling yolo on kiki bridges approve --allow-yolo', async () => {
    const approvedPolicies: BridgePolicy[] = [];
    const stdout: string[] = [];
    const program = new Command().exitOverride();
    registerThreadBridgesCommand(program, {
      ensureServer: async () => STUB_SERVER,
      createKlient: (() => ({
        rest: {
          connections: {
            inbound: async () => ({
              identity: { homeId: 'home-target', hostId: 'host-target', protocol: 1 },
            }),
          },
          threadBridges: {
            approve: async (policy: BridgePolicy) => {
              approvedPolicies.push(policy);
              return {
                grant: {
                  ...policy,
                  id: 'grant-1',
                  revision: 1,
                  enabled: true,
                  createdAt: Date.now(),
                },
                credential: 'cred-secret',
              };
            },
          },
        },
        close: async () => undefined,
      })) as unknown as typeof import('@kiki/klient/http').createKlient,
      stdout: { write: (chunk: string) => stdout.push(chunk) },
    });

    const scratch = await mkdtemp(join(tmpdir(), 'kiki-bridge-approve-'));
    const policyFile = join(scratch, 'policy.json');
    await writeFile(
      policyFile,
      JSON.stringify({
        source: { homeId: '11111111-1111-4111-8111-111111111111', hostId: 'host-a', protocol: 1 },
        target: { homeId: '22222222-2222-4222-8222-222222222222', hostId: 'host-target', protocol: 1 },
        sourceScope: { workspaceId: '*' },
        targetScope: { workspaceId: '*' },
        operations: ['read', 'send', 'wait', 'wake', 'create'],
        expiresAt: Date.now() + 60_000,
        pendingLimit: 20,
        messagesPerMinute: 60,
        location: 'network',
        label: 'trusted-cli-bridge',
      }),
    );
    try {
      await program.parseAsync([
        'node',
        'kiki',
        'bridges',
        'approve',
        '--input',
        policyFile,
        '--allow-yolo',
      ]);
      expect(approvedPolicies).toHaveLength(1);
      expect(approvedPolicies[0]?.permissionCeiling).toBe('yolo');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
