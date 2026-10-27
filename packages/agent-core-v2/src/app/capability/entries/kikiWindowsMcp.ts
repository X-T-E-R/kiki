import { copyFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isWindowsMcpServeReady,
  WINDOWS_MCP_COMMIT,
  WINDOWS_MCP_COMPUTER_CONNECTION,
  WINDOWS_MCP_PYTHON,
  WINDOWS_MCP_VERSION,
  WINDOWS_MCP_WHEEL_BYTES,
  WINDOWS_MCP_WHEEL_SHA256,
  windowsMcpStdioConfig,
} from '#/mcpCore/computer';
import type { GlobalMcpServerConfig } from '#/app/mcpManagement/mcpManagement';
import type { McpServerStdioConfig } from '#/mcpCore/config-schema';

type WindowsMcpServerConfig = McpServerStdioConfig & { readonly name: string };

const LOCK_FILE = fileURLToPath(new URL('./windows-mcp-0.8.8.lock', import.meta.url));

export interface WindowsMcpEnvironmentPlan {
  readonly id: 'windows-mcp';
  readonly version: string;
  readonly commit: string;
  readonly python: string;
  readonly wheelSha256: string;
  readonly wheelBytes: number;
  readonly distribution: 'external-environment';
  readonly managedInstall: 'withheld-until-gpl-acceptance';
  readonly licenses: readonly { readonly name: string; readonly license: string }[];
  readonly closureLock: string;
  readonly note: string;
}

export function windowsMcpEnvironmentPlan(): WindowsMcpEnvironmentPlan {
  return {
    id: 'windows-mcp',
    version: WINDOWS_MCP_VERSION,
    commit: WINDOWS_MCP_COMMIT,
    python: WINDOWS_MCP_PYTHON,
    wheelSha256: WINDOWS_MCP_WHEEL_SHA256,
    wheelBytes: WINDOWS_MCP_WHEEL_BYTES,
    distribution: 'external-environment',
    managedInstall: 'withheld-until-gpl-acceptance',
    licenses: [
      { name: 'windows-mcp', license: 'MIT' },
      { name: 'fuzzywuzzy', license: 'GPL-2.0-only' },
      { name: 'python-Levenshtein', license: 'GPL-2.0-or-later' },
    ],
    closureLock: 'windows-mcp-0.8.8.lock',
    note: 'Exact Windows-MCP 0.8.8 stdio server in an external CPython 3.14 environment. The project license is MIT; the locked closure includes GPL packages and is not a pure-MIT Kiki builtin. Startup is the venv interpreter with --require-hashes already applied. It does not call windows-mcp install, auth, or a login service, and it does not run uvx.',
  };
}

export function windowsMcpConfigDocument(): string {
  return '[server]\ntransport = "stdio"\n';
}

export function assertWindowsMcpInterpreter(pythonExecutable: string): void {
  if (!isAbsoluteWindowsMcpPath(pythonExecutable)) throw new Error('Windows-MCP requires the absolute path of the environment interpreter');
  const base = path.win32.basename(pythonExecutable).toLowerCase();
  if (base === 'uv' || base === 'uv.exe' || base === 'uvx' || base === 'uvx.exe') {
    throw new Error('Windows-MCP must launch from the pinned interpreter, not uv or uvx');
  }
  if (base !== 'python.exe' && base !== 'python' && base !== 'python3.exe' && base !== 'python3') {
    throw new Error('Windows-MCP interpreter basename must be python');
  }
}

export function assertWindowsMcpVersion(version: string): void {
  if (version.trim() !== WINDOWS_MCP_VERSION) throw new Error(`Windows-MCP version must be ${WINDOWS_MCP_VERSION}`);
}

export function windowsMcpServerConfig(pythonExecutable: string, configPath: string): WindowsMcpServerConfig {
  assertWindowsMcpInterpreter(pythonExecutable);
  if (!isAbsoluteWindowsMcpPath(configPath)) throw new Error('Windows-MCP requires an absolute --config path');
  const config = { name: WINDOWS_MCP_COMPUTER_CONNECTION, ...windowsMcpStdioConfig(pythonExecutable, configPath) };
  if (!isWindowsMcpServeReady(config)) throw new Error('Windows-MCP launch contract was rejected');
  if (config.args?.includes('install') === true || config.args?.includes('auth') === true) {
    throw new Error('Windows-MCP install and auth are not part of the computer executor');
  }
  return config;
}

export async function registerInstalledWindowsMcp(
  mcp: {
    listServers(): Promise<readonly { readonly name: string; readonly config: { readonly transport?: string; readonly command?: string; readonly args?: readonly string[] } }[]>;
    addServer(server: GlobalMcpServerConfig): Promise<unknown>;
  },
  platform: NodeJS.Platform,
  pythonExecutable: string,
  configPath: string,
  version: string,
): Promise<'mcp-configured' | 'existing-mcp-config-reused'> {
  if (platform !== 'win32') throw new Error('Windows-MCP registration is only available on Windows');
  assertWindowsMcpVersion(version);
  const server = windowsMcpServerConfig(pythonExecutable, configPath);
  const servers = await mcp.listServers();
  const sameName = servers.find((item) => item.name === WINDOWS_MCP_COMPUTER_CONNECTION);
  if (sameName !== undefined) {
    const existing = windowsMcpConfiguredLaunch(sameName.config);
    const next = windowsMcpConfiguredLaunch(server);
    if (existing !== undefined && next !== undefined && existing.command === next.command && existing.args.join('\0') === next.args.join('\0')) {
      return 'existing-mcp-config-reused';
    }
    throw new Error('MCP name kiki-windows-mcp is already configured for another command; existing configuration was preserved');
  }
  await mcp.addServer(server);
  return 'mcp-configured';
}

export function windowsMcpConfiguredLaunch(config: { readonly transport?: string; readonly command?: string; readonly args?: readonly string[] }): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (config.transport !== 'stdio' || typeof config.command !== 'string' || config.command.length === 0) return undefined;
  return { command: config.command, args: config.args ?? [] };
}

async function assertRegularFile(file: string, label: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${label} does not exist`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
}

export async function registerInstalledWindowsMcpEnvironment(
  mcp: Parameters<typeof registerInstalledWindowsMcp>[0],
  platform: NodeJS.Platform,
  pythonExecutable: string,
  configPath: string,
  version: string,
): Promise<'mcp-configured' | 'existing-mcp-config-reused'> {
  assertWindowsMcpInterpreter(pythonExecutable);
  if (!isAbsoluteWindowsMcpPath(configPath)) throw new Error('Windows-MCP requires an absolute --config path');
  await assertRegularFile(pythonExecutable, 'Windows-MCP interpreter');
  await assertRegularFile(configPath, 'Windows-MCP config');
  return registerInstalledWindowsMcp(mcp, platform, pythonExecutable, configPath, version);
}

export function windowsMcpManagedInstallCommands(targetDir: string, pythonExecutable: string): readonly (readonly string[])[] {
  assertWindowsMcpInterpreter(pythonExecutable);
  const venv = windowsMcpJoin(targetDir, 'venv');
  const lock = windowsMcpJoin(targetDir, 'windows-mcp-0.8.8.lock');
  return [
    ['uv', 'venv', '--python', pythonExecutable, venv],
    ['uv', 'pip', 'sync', '--python', windowsMcpJoin(venv, 'Scripts', 'python.exe'), '--require-hashes', lock],
  ];
}

export async function prepareWindowsMcpManagedLayout(targetDir: string): Promise<{ readonly configPath: string; readonly lockPath: string }> {
  await mkdir(targetDir, { recursive: true });
  const configPath = path.join(targetDir, 'config.toml');
  const lockPath = path.join(targetDir, 'windows-mcp-0.8.8.lock');
  await writeFile(configPath, windowsMcpConfigDocument(), { flag: 'wx' });
  await copyFile(LOCK_FILE, lockPath);
  return { configPath, lockPath };
}

function isAbsoluteWindowsMcpPath(value: string): boolean {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function windowsMcpJoin(targetDir: string, ...parts: string[]): string {
  return path.win32.isAbsolute(targetDir) ? path.win32.join(targetDir, ...parts) : path.join(targetDir, ...parts);
}
