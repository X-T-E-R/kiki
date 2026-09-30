import { describe, expect, it, vi } from 'vitest';

import { resolveWindowsNodeShim, wrapWindowsNodeShims } from '#/app/agentExecutor/windowsNodeShim';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';

const norm = (path: string) => path.replaceAll('\\', '/').toLowerCase();
const shim = '@ECHO off\r\nSETLOCAL\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js" %*\r\n';
const bootstrap = {
  platform: 'win32',
  getEnv: (name: string) => name === 'PATH' ? 'C:\\Node;C:\\npm' : name === 'PATHEXT' ? '.EXE;.CMD' : undefined,
} as IBootstrapService;
const fs = {
  stat: async (path: string) => {
    if (['c:/node/node.exe', 'c:/npm/claude-agent-acp.cmd', 'c:/npm/codex.exe'].includes(norm(path))) {
      return { isFile: true, isDirectory: false, size: 256 };
    }
    throw new Error('not found');
  },
  readText: async (path: string) => {
    if (norm(path) === 'c:/npm/claude-agent-acp.cmd') return shim;
    throw new Error('not found');
  },
} as IHostFileSystem;

describe('Windows external executable resolution', () => {
  it('launches an npm cmd shim through node with every argument intact and no shell', async () => {
    const prompt = 'first line\n中文与 & | %PATH%';
    const spawn = vi.fn(async () => ({ pid: 1 }));
    const wrapped = wrapWindowsNodeShims({ spawn } as unknown as IHostProcessService, fs, () => bootstrap);
    await wrapped.spawn('claude-agent-acp', ['--prompt', prompt], { shell: false });
    expect(spawn).toHaveBeenCalledWith('C:/Node/node.EXE', [
      'C:\\npm\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js', '--prompt', prompt,
    ], { shell: false });
  });

  it('launches the standard npm.cmd variable-based entry through Node', async () => {
    const npmShim = [
      '@ECHO OFF',
      'SETLOCAL',
      'SET "NODE_EXE=%~dp0\\node.exe"',
      'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
      '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
    ].join('\r\n');
    const npmFs = {
      ...fs,
      stat: async (path: string) => {
        if (norm(path) === 'c:/npm/npm.cmd') return { isFile: true, isDirectory: false, size: 256 };
        return fs.stat(path);
      },
      readText: async (path: string) => norm(path) === 'c:/npm/npm.cmd' ? npmShim : fs.readText(path),
    } as IHostFileSystem;
    expect(await resolveWindowsNodeShim('npm', ['pack', 'some&url'], npmFs, bootstrap)).toEqual({
      command: 'C:/Node/node.EXE',
      args: ['C:\\npm\\node_modules\\npm\\bin\\npm-cli.js', 'pack', 'some&url'],
    });
  });

  it('keeps executables direct, leaves other platforms unchanged and rejects opaque cmd scripts', async () => {
    expect(await resolveWindowsNodeShim('codex.exe', ['run'], fs, bootstrap)).toEqual({
      command: 'C:/npm/codex.exe', args: ['run'],
    });
    expect(await resolveWindowsNodeShim('claude-agent-acp.cmd', ['a\nb'], fs, {
      ...bootstrap, platform: 'linux',
    })).toEqual({ command: 'claude-agent-acp.cmd', args: ['a\nb'] });
    await expect(resolveWindowsNodeShim('C:/npm/untrusted.cmd', [], {
      ...fs, readText: async () => '@echo off\r\nwhoami %*',
    } as IHostFileSystem, bootstrap)).rejects.toThrow(/not a supported Node launcher/);
  });
});
