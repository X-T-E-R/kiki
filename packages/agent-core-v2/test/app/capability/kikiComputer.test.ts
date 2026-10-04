import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ZipFile } from 'yazl';
import { c as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKikiComputerEntry, computerMcpConfig } from '#/app/capability/entries/kikiComputer';
import { computerArtifact, type ComputerArtifact } from '#/app/capability/entries/computerArtifacts';
import type { CapabilityEntryContext } from '#/app/capability/entries/context';
import type { GlobalMcpServerConfig, McpManagedServer } from '#/app/mcpManagement/mcpManagement';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const files = { 'cua-driver.exe': 'fixture executable', LICENSE: 'fixture license', 'THIRD_PARTY_NOTICES.md': 'fixture notices' };

async function zipBytes(): Promise<Buffer> {
  const zip = new ZipFile();
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), `fixture/${name}`);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

function fixture(root: string, bytes: Buffer, servers: McpManagedServer[] = []) {
  const artifact: ComputerArtifact = {
    version: 'fixture', directory: 'fixture', executable: 'cua-driver.exe', url: 'https://github.com/trycua/cua/releases/download/fixture/test.zip',
    sha256: hash(bytes), metadataUrl: 'https://example.test/checksums', maxBytes: 100_000,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)])),
  };
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array(bytes))) as unknown as typeof fetch;
  const addServer = vi.fn(async (server: GlobalMcpServerConfig) => {
    const { name, ...config } = server;
    servers.push({ name, config, source: 'global', origin: 'fixture/mcp.json', mutable: true });
    return servers;
  });
  const ctx: CapabilityEntryContext = {
    platform: 'win32', arch: 'x64', kimiHomeDir: root, userHomeDir: root,
    plugins: undefined as never, hostProcess: undefined as never,
    computerArtifact: artifact, fetchImpl,
    computerMcp: { listServers: async () => servers, addServer },
  };
  return { ctx, artifact, servers, addServer, fetchImpl, entry: createKikiComputerEntry(ctx) };
}

describe('kiki-computer fixed MCP adoption', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'kiki-computer-test-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

  it.each(['win32', 'darwin', 'linux'] as const)('freezes both architectures and notices for %s', (platform) => {
    for (const arch of ['x64', 'arm64']) {
      const artifact = computerArtifact(platform, arch)!;
      expect(artifact.version).toBe('0.32.0');
      expect(artifact.url).toContain('cua-driver-rs-v0.32.0');
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.files['LICENSE']).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.files['THIRD_PARTY_NOTICES.md']).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.values(artifact.files).every((digest) => /^[a-f0-9]{64}$/.test(digest))).toBe(true);
    }
    expect(computerArtifact(platform, 'ia32')).toBeUndefined();
    expect(computerArtifact('freebsd', 'x64')).toBeUndefined();
  });

  it.each(['win32', 'darwin', 'linux'] as const)('generates an existing MCP configuration for %s', (platform) => {
    expect(computerMcpConfig(platform, '/absolute/cua-driver')).toEqual({
      name: 'kiki-computer', transport: 'stdio', command: '/absolute/cua-driver', executor: 'local',
      args: platform === 'darwin' ? ['mcp', '--direct'] : ['mcp'],
    });
  });

  it('installs only the verified package, registers MCP and reads the same configuration back', async () => {
    const { entry, servers, addServer, fetchImpl } = fixture(root, await zipBytes());
    expect((await entry.detect()).steps[0]?.state).toBe('missing');
    await entry.install(() => {});
    const binary = entry.plan!.destination;
    expect(await readFile(binary, 'utf8')).toBe(files['cua-driver.exe']);
    expect(servers[0]).toMatchObject({ name: 'kiki-computer', config: { command: binary, args: ['mcp'], executor: 'local' } });
    expect((await entry.detect()).steps).toMatchObject([
      { id: 'component', state: 'ok' }, { id: 'desktop-access', state: 'missing', optional: true },
    ]);
    expect(await entry.install(() => {})).toBe('existing-mcp-config-reused');
    expect(addServer).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uses the existing tar package extractor without running platform installation scripts', async () => {
    const { ctx, artifact } = fixture(root, await zipBytes());
    const source = path.join(root, 'tar-source', 'fixture');
    await mkdir(source, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(source, name), content);
    const stream = await createTar({ gzip: true, cwd: path.dirname(source) }, ['fixture']);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const entry = createKikiComputerEntry({ ...ctx, platform: 'linux', computerArtifact: { ...artifact, sha256: hash(bytes) },
      fetchImpl: vi.fn(async () => new Response(new Uint8Array(bytes))) as unknown as typeof fetch });
    await entry.install(() => {});
    expect((await entry.detect()).steps[0]?.state).toBe('ok');
  });

  it('preserves and reuses an existing plugin cua configuration without adding a duplicate', async () => {
    const servers: McpManagedServer[] = [{ name: 'plugin:cua', source: 'plugin', origin: 'fixture-plugin', mutable: false,
      config: { transport: 'stdio', command: '/user/cua-driver', args: ['mcp', '--socket', '/user/endpoint'], enabled: false } }];
    const { entry, addServer } = fixture(root, await zipBytes(), servers);
    await entry.install(() => {});
    expect(addServer).not.toHaveBeenCalled();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.config).toMatchObject({ enabled: false, args: ['mcp', '--socket', '/user/endpoint'] });
  });

  it('does not overwrite an unverified installed file or silently replace a conflicting MCP name', async () => {
    const { entry, fetchImpl, addServer } = fixture(root, await zipBytes());
    await mkdir(path.dirname(entry.plan!.destination), { recursive: true });
    await writeFile(entry.plan!.destination, 'user file');
    await expect(entry.install(() => {})).rejects.toThrow(/refusing download or overwrite/);
    expect(await readFile(entry.plan!.destination, 'utf8')).toBe('user file');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(addServer).not.toHaveBeenCalled();
  });

  it('rejects archive corruption before registering MCP', async () => {
    const { ctx, artifact, addServer } = fixture(root, await zipBytes());
    const entry = createKikiComputerEntry({ ...ctx, computerArtifact: { ...artifact, sha256: '0'.repeat(64) } });
    await expect(entry.install(() => {})).rejects.toThrow(/SHA-256/);
    expect(addServer).not.toHaveBeenCalled();
    expect((await entry.detect()).steps[0]?.state).toBe('missing');
  });

  it('detects a modified helper or notices instead of reporting the package verified', async () => {
    const { entry } = fixture(root, await zipBytes());
    await entry.install(() => {});
    await writeFile(path.join(path.dirname(entry.plan!.destination), 'THIRD_PARTY_NOTICES.md'), 'changed');
    expect((await entry.detect()).steps[0]?.state).toBe('missing');
    await expect(entry.install(() => {})).rejects.toThrow(/unverified/);
  });

  it('allows only pinned release asset redirect origins and verifies the final bytes', async () => {
    const bytes = await zipBytes();
    const { ctx } = fixture(root, bytes);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://github.com/')
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture.zip' } })
      : new Response(new Uint8Array(bytes))) as unknown as typeof fetch;
    await createKikiComputerEntry({ ...ctx, fetchImpl }).install(() => {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bad = createKikiComputerEntry({ ...ctx, kimiHomeDir: path.join(root, 'bad'),
      fetchImpl: vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://example.test/file' } })) as unknown as typeof fetch });
    await expect(bad.install(() => {})).rejects.toThrow(/approved GitHub/);
  });
});
