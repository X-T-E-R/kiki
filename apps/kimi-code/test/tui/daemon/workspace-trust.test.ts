import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalWorkspaceRoot,
  gatedMcpServers,
  isWorkspaceTrusted,
  trustWorkspace,
  workspaceTrustKey,
} from '#/tui/daemon/workspace-trust';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('daemon workspace trust', () => {
  it('uses the engine-compatible canonical key for Windows workspace roots', () => {
    const canonical = canonicalWorkspaceRoot('C:\\Repo\\Project\\');
    expect(canonical).toBe('c:/repo/project');
    expect(workspaceTrustKey(canonical)).toMatch(/^wd_project_[0-9a-f]{12}$/u);
  });

  it('persists trust under the daemon home before startup', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tui-trust-'));
    tempDirs.push(homeDir);

    await expect(isWorkspaceTrusted(homeDir, 'C:\\Repo\\Project')).resolves.toBe(false);
    await trustWorkspace(homeDir, 'C:\\Repo\\Project');
    await expect(isWorkspaceTrusted(homeDir, 'c:/repo/project/')).resolves.toBe(true);
  });

  it('computes the project-only gated MCP list for the trust prompt', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tui-trust-mcp-'));
    const workDir = await mkdtemp(join(tmpdir(), 'tui-trust-work-'));
    tempDirs.push(homeDir, workDir);
    await mkdir(join(workDir, '.git'), { recursive: true });
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'root-server': {
            command: 'root-cmd',
            args: ['--safe'],
            cwd: '/tmp/root',
            env: { SECRET: 'hidden' },
          },
          'disabled-server': { command: 'nope', enabled: false },
        },
      }),
      'utf8',
    );
    await mkdir(join(workDir, '.kiki'), { recursive: true });
    await writeFile(
      join(workDir, '.kiki', 'mcp.json'),
      JSON.stringify({ mcpServers: { 'nested-server': { command: 'nested-cmd' } } }),
      'utf8',
    );

    const servers = await gatedMcpServers(homeDir, workDir);

    expect(servers).toEqual([
      { name: 'nested-server', transport: 'stdio', command: 'nested-cmd' },
      {
        name: 'root-server',
        transport: 'stdio',
        command: 'root-cmd',
        args: ['--safe'],
        cwd: resolve('/tmp/root').replaceAll('\\', '/'),
      },
    ]);
  });

  it('subtracts user-level entries and omits env from the gated list', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tui-trust-mcp-'));
    const workDir = await mkdtemp(join(tmpdir(), 'tui-trust-work-'));
    tempDirs.push(homeDir, workDir);
    await mkdir(join(workDir, '.git'), { recursive: true });
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'shared-server': { command: 'shared-cmd', env: { TOKEN: 'secret' } },
          'http-server': { transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
        },
      }),
      'utf8',
    );
    await writeFile(
      join(homeDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'shared-server': { command: 'user-cmd' } } }),
      'utf8',
    );

    const servers = await gatedMcpServers(homeDir, workDir);

    // The user-level entry is not gated; the project override with the same
    // name is a distinct config and stays listed, envs stripped.
    expect(servers).toEqual([
      {
        name: 'http-server',
        transport: 'http',
        url: 'https://example.test/mcp',
      },
      {
        name: 'shared-server',
        transport: 'stdio',
        command: 'shared-cmd',
        cwd: resolve(workDir).replaceAll('\\', '/'),
      },
    ]);
  });

  it('degrades the gated list to empty when the project file is invalid', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tui-trust-mcp-'));
    const workDir = await mkdtemp(join(tmpdir(), 'tui-trust-work-'));
    tempDirs.push(homeDir, workDir);
    await mkdir(join(workDir, '.git'), { recursive: true });
    await writeFile(join(workDir, '.mcp.json'), '{not json', 'utf8');

    await expect(gatedMcpServers(homeDir, workDir)).resolves.toEqual([]);
  });
});
