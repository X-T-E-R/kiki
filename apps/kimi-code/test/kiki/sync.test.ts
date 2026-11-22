import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionPairRequest, PairCodeCreateInput, PairCodeCreateOutput, RemoteConnection, SyncBundleImportReceipt, SyncPeerTransferInput } from '@kiki/protocol';
import { registerSyncCommand } from '../../src/kiki/sync';
import { registerConnectionsCommand } from '../../src/kiki/connections';

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
      ensureServer: async () => ({ url: 'http://127.0.0.1:41000', token: 'tok', homeDir: '/tmp/home', port: 41000, started: false }),
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
      ensureServer: async () => ({ url: 'http://127.0.0.1:41000', token: 'tok', homeDir: '/tmp/home', port: 41000, started: false }),
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
      enabled: true,
      backgroundSummary: false,
      state: 'online',
      purposes: ['bridge'],
      pinnedFingerprint: sampleCode.tlsFingerprint,
      trustTier: 'trusted_personal',
    };
    const deps = {
      ensureServer: async () => ({ url: 'http://127.0.0.1:41000', token: 'tok', homeDir: '/tmp/home', port: 41000, started: false }),
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
  });
});
