import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeFile } from 'node:fs/promises';

import {
  prepareWindowsMcpManagedLayout,
  registerInstalledWindowsMcp,
  registerInstalledWindowsMcpEnvironment,
  windowsMcpConfiguredLaunch,
  windowsMcpEnvironmentPlan,
  windowsMcpManagedInstallCommands,
  windowsMcpServerConfig,
} from '#/app/capability/entries/kikiWindowsMcp';
import type { GlobalMcpServerConfig } from '#/app/mcpManagement/mcpManagement';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Windows-MCP registration', () => {
  it('records an external exact 0.8.8 environment without replacing CUA or scheduling install', async () => {
    const plan = windowsMcpEnvironmentPlan();
    expect(plan).toMatchObject({
      version: '0.8.8',
      distribution: 'external-environment',
      managedInstall: 'withheld-until-gpl-acceptance',
    });
    expect(plan.licenses.map((item) => item.license)).toEqual(['MIT', 'GPL-2.0-only', 'GPL-2.0-or-later']);
    const python = 'C:\\Env\\python.exe';
    const configPath = 'C:\\Kiki\\windows-mcp\\config.toml';
    const added: GlobalMcpServerConfig[] = [];
    const listed = [{ name: 'kiki-computer', config: { transport: 'stdio' as const, command: 'C:\\cua\\cua-driver.exe', args: ['mcp'] } }];
    await expect(registerInstalledWindowsMcp({
      listServers: async () => listed,
      addServer: async (server) => { added.push(server); },
    }, 'win32', python, configPath, '0.8.8')).resolves.toBe('mcp-configured');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: 'kiki-windows-mcp',
      command: python,
      executor: 'local',
      env: { ANONYMIZED_TELEMETRY: 'false', WINDOWS_MCP_WATCHDOG: 'false' },
    });
    const launch = added[0] === undefined ? undefined : windowsMcpConfiguredLaunch(added[0]);
    expect(launch?.command).toBe(python);
    expect(launch?.args.includes('install')).toBe(false);
    expect(launch?.args.includes('auth')).toBe(false);
    expect(launch?.args.slice(0, 3)).toEqual(['-m', 'windows_mcp', 'serve']);
    expect(listed[0]?.config.command).toBe('C:\\cua\\cua-driver.exe');
    await expect(registerInstalledWindowsMcp({
      listServers: async () => [{ name: 'kiki-windows-mcp', config: { transport: 'stdio', command: 'C:\\Other\\python.exe', args: ['-m', 'other'] } }],
      addServer: async () => { throw new Error('must not replace'); },
    }, 'win32', python, configPath, '0.8.8')).rejects.toThrow('existing configuration was preserved');
    expect(() => windowsMcpServerConfig('uvx', configPath)).toThrow('absolute path');
    expect(() => windowsMcpServerConfig('C:\\Tools\\uvx.exe', configPath)).toThrow('uv or uvx');
    expect(windowsMcpManagedInstallCommands('C:\\Kiki\\windows-mcp', python)).toEqual([
      ['uv', 'venv', '--python', python, 'C:\\Kiki\\windows-mcp\\venv'],
      ['uv', 'pip', 'sync', '--python', 'C:\\Kiki\\windows-mcp\\venv\\Scripts\\python.exe', '--require-hashes', 'C:\\Kiki\\windows-mcp\\windows-mcp-0.8.8.lock'],
    ]);
    const root = await mkdtemp(path.join(tmpdir(), 'windows-mcp-layout-'));
    roots.push(root);
    const layout = await prepareWindowsMcpManagedLayout(root);
    expect(await readFile(layout.configPath, 'utf8')).toBe('[server]\ntransport = "stdio"\n');
    expect(await readFile(layout.lockPath, 'utf8')).toContain('windows-mcp==0.8.8');
    expect(await readFile(layout.lockPath, 'utf8')).toContain('597ef720e1902ba76510a4d2b946949f8a48f281dd210c183de5ded60ea3b873');
  });

  it('registers only an existing interpreter and config file and does not launch the server', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'windows-mcp-env-'));
    roots.push(root);
    const python = path.join(root, 'python.exe');
    const configPath = path.join(root, 'config.toml');
    await writeFile(python, '');
    await writeFile(configPath, '[server]\ntransport = "stdio"\n');
    const added: GlobalMcpServerConfig[] = [];
    await expect(registerInstalledWindowsMcpEnvironment({
      listServers: async () => [],
      addServer: async (server) => { added.push(server); },
    }, 'win32', python, configPath, '0.8.8')).resolves.toBe('mcp-configured');
    expect(windowsMcpConfiguredLaunch(added[0] ?? {})?.command).toBe(python);
    await expect(registerInstalledWindowsMcpEnvironment({
      listServers: async () => [],
      addServer: async () => { throw new Error('must not add'); },
    }, 'win32', path.join(root, 'missing', 'python.exe'), configPath, '0.8.8')).rejects.toThrow('does not exist');
    expect(added).toHaveLength(1);
  });
});
