import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACP_REGISTRY_CACHE_KEY,
  ACP_REGISTRY_CACHE_SCOPE,
  AcpRegistryAgentSchema,
  AcpRegistryCatalog,
  decodeAcpRegistryIndex,
  decodeAcpRegistryIndexObject,
  normalizeRegistryCommandPath,
  packageCommandCandidates,
  resolveAcpRegistryDistribution,
  resolveAcpRegistryPlatformTarget,
  resolveAcpRegistryPlatformTargetCandidates,
  searchAcpRegistryAgents,
  validateArchiveEntries,
  type AcpRegistryAgent,
} from '#/app/agentExecutor/acpRegistryCatalog';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function agent(
  id: string,
  name = id,
  details: {
    readonly authors?: readonly string[];
    readonly description?: string;
    readonly distribution?: AcpRegistryAgent['distribution'];
  } = {},
): AcpRegistryAgent {
  return AcpRegistryAgentSchema.parse({
    id,
    name,
    version: '1.0.0',
    description: details.description ?? '',
    authors: details.authors,
    distribution: details.distribution ?? { npx: { package: `${id}@1.0.0` } },
  });
}

describe('ACP Registry catalog data contracts', () => {
  it('validates registry agents and discards malformed entries without losing a valid index', () => {
    const valid = {
      id: 'example-agent',
      name: 'Example Agent',
      version: '1.2.3',
      description: 'A registry test agent.',
      website: 'https://example.test/agent',
      distribution: {
        npx: { package: '@example/agent@1.2.3', args: ['--stdio'], env: { MODE: 'test' } },
      },
    };
    expect(AcpRegistryAgentSchema.parse(valid)).toMatchObject(valid);
    expect(AcpRegistryAgentSchema.safeParse({
      ...valid,
      website: 'http://example.test/agent',
    }).success).toBe(false);
    expect(AcpRegistryAgentSchema.safeParse({
      ...valid,
      distribution: { npx: { package: '@example/agent@latest' } },
    }).success).toBe(false);
    expect(decodeAcpRegistryIndexObject({ version: '1.0.0', agents: [valid, { ...valid, id: '../escape' }] }))
      .toMatchObject({ version: '1.0.0', discardedCount: 1, agents: [valid] });
    expect(() => decodeAcpRegistryIndex('{')).toThrow();
    expect(() => decodeAcpRegistryIndexObject({ version: 'bad version', agents: [] })).toThrow();
  });

  it('ranks exact identity, identity prefix, author, and description matches before applying the result limit', () => {
    const index = {
      version: '2026-11-12',
      agents: [
        agent('description-agent', 'Description Agent', { description: 'Runs a codex-compatible engine.' }),
        agent('codex-acp', 'Codex ACP'),
        agent('author-agent', 'Author Agent', { authors: ['Codex Labs'] }),
        agent('codex', 'Codex'),
        agent('my-codex', 'My Codex'),
      ],
    };

    expect(searchAcpRegistryAgents(index, { query: '  CODEX ', limit: 2 })).toMatchObject({
      version: '2026-11-12',
      total: 5,
      agents: [{ id: 'codex' }, { id: 'codex-acp' }],
    });
    expect(searchAcpRegistryAgents(index, { query: 'codex', limit: 20 }).agents.map(({ id }) => id))
      .toEqual(['codex', 'codex-acp', 'my-codex', 'author-agent', 'description-agent']);
  });

  it('falls back from a missing Windows ARM64 binary to the x64 archive', () => {
    const platformTarget = resolveAcpRegistryPlatformTarget('win32', 'arm64');
    expect(platformTarget).toBe('windows-aarch64');
    expect(resolveAcpRegistryPlatformTargetCandidates(platformTarget)).toEqual(['windows-aarch64', 'windows-x86_64']);
    const entry = {
      archive: 'https://example.test/agent.zip',
      cmd: 'bin/example-agent.exe',
      args: ['acp'],
    };
    const resolved = resolveAcpRegistryDistribution({
      agent: agent('example-agent', 'Example Agent', { distribution: { binary: { 'windows-x86_64': entry } } }),
      preference: 'auto',
      platformTarget,
    });
    expect(resolved).toMatchObject({ kind: 'binary', args: ['acp'], binaryTarget: entry });
    const both = resolveAcpRegistryDistribution({
      agent: agent('example-agent', 'Example Agent', { distribution: { binary: {
        'windows-aarch64': { ...entry, cmd: 'bin/arm64-agent.exe' },
        'windows-x86_64': entry,
      } } }),
      preference: 'binary',
      platformTarget,
    });
    expect(both?.binaryTarget?.cmd).toBe('bin/arm64-agent.exe');
    expect(resolveAcpRegistryPlatformTarget('freebsd', 'arm64')).toBeUndefined();
  });

  it('normalizes archive command paths and rejects absolute or traversing entries', () => {
    expect(normalizeRegistryCommandPath('  ./bin\\example-agent.exe  ')).toEqual(['bin', 'example-agent.exe']);
    expect(normalizeRegistryCommandPath('/usr/bin/example-agent')).toBeUndefined();
    expect(normalizeRegistryCommandPath('C:/tools/example-agent.exe')).toBeUndefined();
    expect(normalizeRegistryCommandPath('bin/../escape')).toBeUndefined();
    expect(normalizeRegistryCommandPath('../escape')).toBeUndefined();
    expect(validateArchiveEntries('./\nbin/example-agent\nlib/runtime.so')).toBe(true);
    expect(validateArchiveEntries('bin/example-agent\n../../outside')).toBe(false);
    expect(packageCommandCandidates({ id: 'example-agent-acp' }, '@example/agent-acp')).toEqual([
      'example-agent-acp', 'agent-acp', 'agent',
    ]);
  });
});

describe('ACP Registry durable catalog cache', () => {
  it('writes and reloads cache data through the real atomic document store file backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-registry-cache-'));
    roots.push(root);
    const rawIndex = {
      version: '2026-11-12',
      agents: [agent('example-agent', 'Example Agent', { description: 'A cached registry agent.' })],
    };
    const writer: IAtomicDocumentStore = new JsonAtomicDocumentStore(new FileStorageService(root));
    let onlineRequests = 0;
    const onlineFetch: typeof fetch = async () => {
      onlineRequests += 1;
      return new Response(JSON.stringify(rawIndex), { status: 200 });
    };
    const online = new AcpRegistryCatalog({
      registryUrl: 'https://registry.example.test/index.json',
      cacheStore: writer,
      fetchImpl: onlineFetch,
      now: () => 1_000,
    });

    await expect(online.fetchIndex()).resolves.toMatchObject({ version: '2026-11-12', discardedCount: 0 });
    expect(onlineRequests).toBe(1);
    const cachePath = new FileStorageService(root).pathFor(ACP_REGISTRY_CACHE_SCOPE, ACP_REGISTRY_CACHE_KEY);
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toMatchObject({ version: '2026-11-12', agents: [{ id: 'example-agent' }] });

    const reader: IAtomicDocumentStore = new JsonAtomicDocumentStore(new FileStorageService(root));
    let offlineRequests = 0;
    const offlineFetch: typeof fetch = async () => {
      offlineRequests += 1;
      throw new Error('offline');
    };
    const offline = new AcpRegistryCatalog({
      registryUrl: 'https://registry.example.test/index.json',
      cacheStore: reader,
      fetchImpl: offlineFetch,
      now: () => 2_000,
    });

    await expect(offline.search({ query: 'cached' })).resolves.toMatchObject({
      version: '2026-11-12',
      total: 1,
      agents: [{ id: 'example-agent' }],
    });
    expect(offlineRequests).toBe(1);
  });
});
