import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, utils } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SshConnectionManager } from '@kiki/kaos/ssh-connection';
import type { ISshHostService } from '#/app/ssh/sshService';
import { FileEditService } from '#/app/edit/fileEditService';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import { WriteTool } from '#/agent/tools/os/write/writeTool';
import { EditTool } from '#/agent/tools/edit/editTool';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { GrepTool } from '#/agent/tools/os/grep/grepTool';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime, RuntimeLease } from '#/runtime/runtime';
import { SshRuntime } from '#/runtime/sshRuntime';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { SshHostFileSystem } from '#/os/backends/ssh/sshHostServices';
import { spawnWindowsSearch } from '#/os/backends/ssh/windowsSearch';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import type { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ToolExecution, ExecutableToolContext } from '#/tool/toolContract';
import { sshTestTools } from './stubs';

const openTools: ReturnType<typeof sshTestTools>[] = [];

const openServers: NetServer[] = [];
const openManagers: SshConnectionManager[] = [];
const tempHomes: string[] = [];

const attrs = (mode: number, size = 0) => ({ mode, size, uid: 1000, gid: 1000, atime: 0, mtime: 1 });

async function fixture(platform: 'posix' | 'win32' = 'posix', shell = 'powershell') {
  const response = { stdout: Buffer.from('hello from SSH\n'), stderr: Buffer.alloc(0), exitCode: 0, executePowerShell: false, suspendReads: false, lineCount: undefined as number | undefined, afterLineCount: undefined as (() => void) | undefined, onRead: undefined as (() => void) | undefined };
  const io = { bytes: 0, handles: 0, closes: 0, maxReadSize: Number.POSITIVE_INFINITY };
  const failures = new Set<string>();
  const remoteHome = platform === 'win32' ? 'C:/Users/tester' : '/home/tester';
  const commands: string[] = [];
  const home = await mkdtemp(join(tmpdir(), 'kiki-ssh-tools-'));
  tempHomes.push(home);
  vi.stubEnv('KIKI_HOME', home);
  const files = new Map<string, Buffer>();
  const directories = new Set([remoteHome, ...(platform === 'win32' ? ['E:/', 'E:/scratch'] : [])]);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'temporary-password') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec();
        const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(info.command);
        let command = encoded ? Buffer.from(encoded[1]!, 'base64').toString('utf16le') : info.command;
        expect(info.command.length).toBeLessThanOrEqual(8191);
        const scriptFile = /-File '([^']+)'/.exec(command);
        if (scriptFile) command = files.get(scriptFile[1]!)!.toString('utf8').replace(/^\uFEFF/, '');
        commands.push(command);
        if (response.executePowerShell && !command.includes('KIKI_SSH_WINDOWS')) {
          const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
          child.stdout.pipe(channel, { end: false });
          child.stderr.pipe(channel.stderr, { end: false });
          child.once('close', (code) => { channel.exit(code ?? 1); channel.end(); });
          child.stdin.end();
          return;
        }
        if (command.includes('function EmitFile')) {
          const encodedConfig = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(command)!;
          const config = JSON.parse(Buffer.from(encodedConfig[1]!, 'base64').toString('utf8')) as { paths: string[]; noIgnore: boolean; filters: { source: string; basename: boolean; exclude: boolean }[] };
          const encode = (text: string) => Buffer.from(text).toString('base64');
          for (const root of config.paths) {
            if (failures.has(root)) { channel.write(`e\t${encode(root)}\t${encode('readdir permission denied')}\n`); continue; }
            for (const [path, content] of files) {
              if (!path.startsWith(`${root}/`) && path !== root) continue;
              if (path.split('/').some((part) => ['.git', '.svn'].includes(part))) continue;
              const name = path.slice(path.lastIndexOf('/') + 1);
              if (!config.noIgnore && ['.gitignore', '.ignore', '.rgignore'].includes(name)) channel.write(`i\t${encode(path.slice(0, path.lastIndexOf('/')))}\t${encode(content.toString())}\n`);
            }
            for (const [path] of files) {
              if (!path.startsWith(`${root}/`) && path !== root) continue;
              if (path.split('/').some((part) => ['.git', '.svn'].includes(part))) continue;
              const included = config.filters.every((filter) => {
                const re = new RegExp(filter.source, 'i');
                const matched = re.test(filter.basename ? path.slice(path.lastIndexOf('/') + 1) : path.slice(root.length + 1)) || re.test(path);
                return filter.exclude ? !matched : matched;
              });
              if (included) channel.write(`f\t1000\t${encode(path)}\n`);
            }
          }
          channel.exit(0); channel.end(); return;
        }
        if (command.includes('$regex=')) {
          channel.write(response.stdout); channel.stderr.write(response.stderr);
          channel.exit(response.exitCode); channel.end(); return;
        }
        if (response.lineCount !== undefined && (command.includes('kiki-line-count') || command.includes('$count=[long]0'))) {
          channel.write(`${response.lineCount}\n`);
          response.afterLineCount?.();
          channel.exit(0); channel.end(); return;
        }
        if (command.includes('KIKI_SSH_WINDOWS')) channel.write(`KIKI_SSH_WINDOWS\nAMD64\n10.0.26100\npowershell.exe\n${shell || 'cmd'}\n936\nC:/Users/tester/Temp/\n`);
        else if (info.command.includes('KIKI_SSH_ENV')) channel.write('KIKI_SSH_ENV\nLinux\nx86_64\n6.8.0\n/bin/sh\n');
        else if (response.exitCode !== 0 || platform === 'win32') {
          channel.write(response.stdout);
          channel.stderr.write(response.stderr);
        }
        else if (info.command.includes('--files')) channel.write('./test.txt\n');
        else if (info.command.includes('rg ')) channel.write('/home/tester/test.txt\0');
        else channel.write(response.stdout);
        channel.exit(command.includes('KIKI_SSH_') ? 0 : response.exitCode);
        channel.end();
      });
      session.on('sftp', (acceptSftp) => {
        const channel = acceptSftp();
        let nextId = 0;
        const handles = new Map<number, string>();
        const handle = (request: number, path: string) => {
          const id = nextId++;
          handles.set(id, path);
          io.handles++;
          const buf = Buffer.alloc(4);
          buf.writeUInt32BE(id);
          channel.handle(request, buf);
        };
        const stat = (request: number, path: string) => {
          if (directories.has(path)) channel.attrs(request, attrs(0o040755));
          else if (files.has(path)) channel.attrs(request, attrs(0o100644, files.get(path)!.length));
          else channel.status(request, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
        };
        channel.on('REALPATH', (request, path) => {
          const native = path === '.' ? remoteHome : path;
          const target = platform === 'win32' ? `/${native}` : native;
          channel.name(request, [{ filename: target, longname: target, attrs: attrs(directories.has(native) ? 0o040755 : 0o100644) }]);
        });
        channel.on('STAT', stat);
        channel.on('LSTAT', stat);
        channel.on('OPEN', (request, path, flags) => {
          if ((flags & utils.sftp.OPEN_MODE.EXCL) !== 0 && files.has(path)) {
            channel.status(request, utils.sftp.STATUS_CODE.FAILURE);
            return;
          }
          if ((flags & utils.sftp.OPEN_MODE.TRUNC) !== 0 || !files.has(path)) files.set(path, Buffer.alloc(0));
          handle(request, path);
        });
        const delivered = new Set<number>();
        channel.on('OPENDIR', (request, path) => {
          if (failures.has(path)) return channel.status(request, utils.sftp.STATUS_CODE.PERMISSION_DENIED);
          handle(request, path);
        });
        channel.on('READDIR', (request, buffer) => {
          const id = buffer.readUInt32BE(0);
          const path = handles.get(id);
          if (path === undefined) return channel.status(request, utils.sftp.STATUS_CODE.FAILURE);
          if (delivered.has(id)) return channel.status(request, utils.sftp.STATUS_CODE.EOF);
          delivered.add(id);
          const children = [...files].filter(([name]) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes('/'));
          const dirs = [...directories].filter((name) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes('/'));
          if (children.length + dirs.length === 0) return channel.status(request, utils.sftp.STATUS_CODE.EOF);
          channel.name(request, [...children.map(([name, value]) => ({ filename: name.slice(path.length + 1), longname: name, attrs: attrs(0o100644, value.length) })),
            ...dirs.map((name) => ({ filename: name.slice(path.length + 1), longname: name, attrs: attrs(0o040755) }))]);
        });
        channel.on('WRITE', (request, buffer, offset, data) => {
          const path = handles.get(buffer.readUInt32BE(0));
          if (!path) return channel.status(request, utils.sftp.STATUS_CODE.FAILURE);
          const next = Buffer.alloc(Math.max(files.get(path)?.length ?? 0, offset + data.length));
          files.get(path)?.copy(next);
          data.copy(next, offset);
          files.set(path, next);
          channel.status(request, utils.sftp.STATUS_CODE.OK);
        });
        channel.on('READ', (request, buffer, offset, length) => {
          const path = handles.get(buffer.readUInt32BE(0));
          if (!path || !files.has(path)) return channel.status(request, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
          response.onRead?.();
          if (response.suspendReads) return;
          const chunk = files.get(path)!.subarray(offset, offset + Math.min(length, io.maxReadSize));
          if (chunk.length === 0) return channel.status(request, utils.sftp.STATUS_CODE.EOF);
          io.bytes += chunk.length;
          channel.data(request, chunk);
        });
        channel.on('CLOSE', (request, buffer) => {
          if (handles.delete(buffer.readUInt32BE(0))) { io.handles--; io.closes++; }
          channel.status(request, utils.sftp.STATUS_CODE.OK);
        });
        channel.on('MKDIR', (request, path) => {
          directories.add(path);
          channel.status(request, utils.sftp.STATUS_CODE.OK);
        });
        channel.on('REMOVE', (request, path) => {
          files.delete(path);
          channel.status(request, utils.sftp.STATUS_CODE.OK);
        });
      });
    }));
  });
  const listener = createServer({ noDelay: true }, (socket) => server.injectSocket(socket));
  openServers.push(listener);
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  const manager = new SshConnectionManager(async () => ({
    hostname: '127.0.0.1', port: address.port, username: 'tester', password: 'temporary-password',
    agent: 'none', knownHostsFiles: [join(home, 'known_hosts')], autoTrustFirstKey: true,
  }));
  openManagers.push(manager);
  const hosts = {
    status: (id: string, workspaceId?: string) => ({ ...manager.status(id), workspaceId }),
    connect: (id: string) => manager.get(id),
    onStatus: (listener: (status: { hostId: string; workspaceId: string; state: 'ready' | 'idle' | 'disconnected' | 'connecting' | 'failed'; generation: number }) => void) => manager.onStatus((status) => listener({ ...status, workspaceId: 'workspace' })),
  } as ISshHostService;
  const remote = new SshRuntime('workspace', { id: 'dev', name: 'dev', source: 'kiki' }, hosts);
  const localFs = new HostFileSystem();
  const local = {
    identity: { workspaceId: 'workspace', runtimeId: 'local', generation: 'local-1' },
    environment: { osKind: process.platform === 'win32' ? 'Windows' : 'Linux', osArch: process.arch, osVersion: 'test', shellName: 'bash', shellPath: 'bash', pathClass: process.platform === 'win32' ? 'win32' : 'posix', homeDir: home },
    path: await import('node:path'),
    workspace: { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots, supportsExternalPaths: true },
    status: 'ready', capabilities: new Set(['fs']), fs: localFs,
    onDidChangeStatus: () => ({ dispose: () => {} }), dispose: () => {},
  } as unknown as Runtime;
  const selected = (host?: string) => host === 'local' ? local : remote;
  const lease = (runtime: Runtime): RuntimeLease => ({ runtime, track: (resource) => resource, dispose: () => {} });
  const runtime = {
    inspect: () => local,
    acquire: () => lease(local),
    nativeSshEnabled: () => true,
    prepareFor: async (host?: string) => { const value = selected(host); if (value === remote) await remote.connect(); return value; },
    acquireFor: (host: string) => lease(selected(host)),
  } as IAgentRuntimeService;
  const workspace = { _serviceBrand: undefined, workDir: home, additionalDirs: [], resolve: (path: string) => path, isWithin: () => true } as ISessionWorkspaceContext;
  const catalog = { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog;
  const truncation = { isSpillFilePath: () => false } as unknown as IAgentToolResultTruncationService;
  const telemetry = { track2: () => undefined } as unknown as ITelemetryService;
  const tools = sshTestTools({ runtime, workspace, localFs, catalog, truncation, telemetry });
  openTools.push(tools);
  return { home, files, directories, failures, response, io, commands, manager, remote, localFs, runtime, workspace, catalog, truncation, telemetry, tools };
}

async function execute(execution: ToolExecution) {
  if (!('execute' in execution)) return execution;
  const ctx = { turnId: 1, toolCallId: 'call', signal: new AbortController().signal } as ExecutableToolContext;
  return execution.execute(ctx);
}

afterEach(async () => {
  await Promise.all(openTools.splice(0).map((tools) => tools.dispose()));
  await Promise.all(openManagers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe('SSH tools over a real ssh2 transport', () => {
  it('streams a small forward window without downloading a large file and closes on break', async () => {
    const f = await fixture();
    const path = '/home/tester/large.txt';
    f.files.set(path, Buffer.from('数据记录\r\n'.repeat(200000)));
    await f.remote.connect();
    const lines: string[] = [];
    for await (const line of f.remote.fs.readLineRange(path, { startLine: 2, maxLines: 35 })) lines.push(line);
    expect(lines).toEqual(Array.from({ length: 35 }, () => '数据记录\r\n'));
    expect(f.io.bytes).toBeLessThan(256 * 1024);
    await vi.waitFor(() => { expect(f.io.handles).toBe(0); });
    const before = f.io.closes;
    for await (const line of f.remote.fs.readLines(path)) { expect(line).toBe('数据记录\r\n'); break; }
    await vi.waitFor(() => { expect(f.io.handles).toBe(0); });
    expect(f.io.closes).toBeGreaterThan(before);
  });

  it.each(['a\r\n数据😀\r\n尾部', 'a\n数据😀\n', '\uFEFFfirst\n\uFEFFsecond\n', ''])('keeps UTF-8, BOM, CRLF and EOF semantics across byte fragments: %j', async (content) => {
    const f = await fixture();
    const path = '/home/tester/fragments.txt';
    f.files.set(path, Buffer.from(content));
    f.io.maxReadSize = 2;
    await f.remote.connect();
    const lines: string[] = [];
    for await (const line of f.remote.fs.readLineRange(path, { startLine: 2, maxLines: 2 })) lines.push(line);
    const expected = content.replace(/^\uFEFF/, '').match(/[^\n]*\n|[^\n]+$/g) ?? [];
    expect(lines).toEqual(expected.slice(1, 3));
  });

  it('validates only the selected UTF-8 window rather than skipped or unread bytes', async () => {
    const f = await fixture();
    const path = '/home/tester/window.txt';
    f.files.set(path, Buffer.from([0xff, 10, 111, 107, 10, 0xff]));
    await f.remote.connect();
    const lines: string[] = [];
    for await (const line of f.remote.fs.readLineRange(path, { startLine: 2, maxLines: 1 })) lines.push(line);
    expect(lines).toEqual(['ok\n']);
  });

  it.each(['strict', 'replace', 'ignore'] as const)('incrementally decodes UTF-16 and UTF-8 replacement characters with errors=%s', async (errors) => {
    const f = await fixture();
    await f.remote.connect();
    f.io.maxReadSize = 2;
    const path = '/home/tester/encoding.txt';
    f.files.set(path, Buffer.from('\uFEFFfirst\n数据😀\r\n尾', 'utf16le'));
    const utf16: string[] = [];
    for await (const line of f.remote.fs.readLineRange(path, { startLine: 2, maxLines: 1, encoding: 'utf16le', errors })) utf16.push(line);
    expect(utf16).toEqual(['数据😀\r\n']);
    f.files.set(path, Buffer.from([97, 10, 0xe4, 0xb8, 0xad, 0xff, 0xef, 0xbf, 0xbd, 10]));
    const collect = async () => { const lines: string[] = []; for await (const line of f.remote.fs.readLineRange(path, { startLine: 2, maxLines: 1, errors })) lines.push(line); return lines; };
    if (errors === 'strict') await expect(collect()).rejects.toThrow();
    else expect(await collect()).toEqual([errors === 'ignore' ? '中�\n' : '中��\n']);
  });

  it.each(['a\nb\n', 'a\nb', '', '\n', '\n\n', 'a', '\uFEFF'])('preserves the last-line and total-line tail semantics: %j', async (content) => {
    const f = await fixture();
    const path = '/home/tester/tail-ending.txt';
    f.files.set(path, Buffer.from(content));
    f.response.lineCount = content.split('\n').length - 1;
    await f.remote.connect();
    const range = await f.remote.fs.readTailRange(path, { tailLines: 1 });
    const lines: string[] = [];
    for await (const line of range.lines) lines.push(line);
    const expected = content.replace(/^\uFEFF/, '').match(/[^\n]*\n|[^\n]+$/g) ?? [];
    expect(range.totalLines).toBe(expected.length);
    expect(range.startLine).toBe(Math.max(1, expected.length));
    expect(lines).toEqual(expected.slice(-1));
  });

  it('aborts a stalled SFTP read and releases its handle without closing the shared connection', async () => {
    const f = await fixture();
    const path = '/home/tester/stalled.txt';
    f.files.set(path, Buffer.from('first\nsecond\n'));
    await f.remote.connect();
    f.response.suspendReads = true;
    let resolveObserved!: () => void;
    const observed = new Promise<void>((resolve) => { resolveObserved = resolve; });
    f.response.onRead = () => { resolveObserved(); };
    const controller = new AbortController();
    const lines = f.remote.fs.readLines(path, { signal: controller.signal });
    const next = lines.next();
    await observed;
    controller.abort(new Error('fixture abort'));
    await expect(next).rejects.toThrow('fixture abort');
    await vi.waitFor(() => { expect(f.io.handles).toBe(0); });
    f.response.suspendReads = false;
    expect(await f.remote.fs.readText(path)).toBe('first\nsecond\n');
  });

  it.each([true, false])('reads a negative-offset tail with absolute lines, using remote count=%s', async (remoteCount) => {
    const f = await fixture();
    const path = '/home/tester/tail.txt';
    f.files.set(path, Buffer.from('line\r\n'.repeat(200000) + 'last'));
    f.response.lineCount = remoteCount ? 200000 : undefined;
    const result = await execute(await f.tools.read.resolveExecution({ host: 'dev', path, line_offset: -3, n_lines: 2 }));
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('199999\tline');
    expect(result.output).toContain('200000\tline');
    expect(result.note).toContain('Total lines in file: 200001.');
    if (remoteCount) expect(f.io.bytes).toBeLessThan(256 * 1024);
    await vi.waitFor(() => { expect(f.io.handles).toBe(0); });
  });

  it.skipIf(process.platform !== 'win32')('honors bounded traversal depth in the actual Windows search script', async () => {
    const f = await fixture('win32');
    await f.remote.connect();
    await mkdir(join(f.home, 'nested'));
    await writeFile(join(f.home, 'root.txt'), 'root');
    await writeFile(join(f.home, 'nested', 'child.txt'), 'child');
    f.response.executePowerShell = true;
    const ssh = (await f.manager.get('dev')).withCwd(f.home);
    const process = spawnWindowsSearch(ssh, ['--files', '--max-depth', '1', '--glob', '*.txt', f.home]);
    const output = await text(process.stdout);
    expect(await process.wait()).toBe(0);
    expect(output).toContain('root.txt');
    expect(output).not.toContain('child.txt');
  });

  it.skipIf(process.platform !== 'win32')('counts a Windows tail with the actual streaming PowerShell script and a quoted path', async () => {
    const f = await fixture('win32');
    await f.remote.connect();
    const path = join(f.home, "tail 'example'.txt").replaceAll('\\', '/');
    const data = Buffer.from('line\r\n'.repeat(200000) + 'last');
    await writeFile(path, data);
    f.files.set(path, data);
    f.response.executePowerShell = true;
    const fs = new SshHostFileSystem(async () => (await f.manager.get('dev')).withCwd(f.home));
    const range = await fs.readTailRange(path, { tailLines: 2 });
    const lines: string[] = [];
    for await (const line of range.lines) lines.push(line);
    expect(range.startLine).toBe(200000);
    expect(range.totalLines).toBe(200001);
    expect(lines).toEqual(['line\r\n', 'last']);
    expect(f.io.bytes).toBeLessThan(128 * 1024);
    expect(f.commands.at(-1)).toContain('$count=[long]0');
  });

  it('rejects a file changed between remote counting and the tail window', async () => {
    const f = await fixture();
    const path = '/home/tester/change.txt';
    f.files.set(path, Buffer.from('one\ntwo\n'));
    f.response.lineCount = 2;
    f.response.afterLineCount = () => { f.files.set(path, Buffer.from('one\ntwo\nthree\n')); };
    const result = await execute(await f.tools.read.resolveExecution({ host: 'dev', path, line_offset: -1 }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('changed while locating');
  });

  it.each(['E:/scratch', 'E:\\scratch'])('runs Bash as PowerShell with cwd %s and marks the result platform and shell', async (cwd) => {
    const f = await fixture('win32');
    const command = "Get-ChildItem -LiteralPath 'E:\\scratch' | ForEach-Object { $_.FullName }; '中文' > $null";
    const result = await execute(await f.tools.bash.resolveExecution({ host: 'dev', cwd, command }));
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('platform: Windows\nshell: powershell');
    expect(f.commands.at(-1)).toContain("Set-Location -LiteralPath 'E:/scratch'");
    expect(f.commands.at(-1)).toContain(command);
    expect(f.commands.at(-1)).not.toContain('/e/');
    expect(f.commands.at(-1)).not.toContain('bash');
    expect(f.tools.bash.description).toContain('PowerShell syntax');
    f.remote.dispose();
  });

  it.skipIf(process.platform !== 'win32')('preserves formatted objects, pipeline text and stderr through Bash with either cwd separator', async () => {
    const f = await fixture('win32');
    await f.remote.connect();
    f.response.executePowerShell = true;
    await writeFile(join(f.home, 'example.txt'), 'example');
    const command = 'Get-Location; Get-ChildItem -Name | Select-Object -First 5; Write-Warning "example-warning"';
    for (const cwd of [f.home, f.home.replaceAll('\\', '/')]) {
      const result = await execute(await f.tools.bash.resolveExecution({ host: 'dev', cwd, command }));
      expect(result.isError).not.toBe(true);
      expect(result.output).toContain(f.home);
      expect(result.output).toContain('example.txt');
      expect(result.output).toContain('example-warning');
      expect(result.output).not.toContain('CLIXML');
      expect(result.output).not.toContain('<Objs');
    }
    const failed = await execute(await f.tools.bash.resolveExecution({ host: 'dev', cwd: f.home,
      command: 'Get-Location; "tail"; [Console]::Error.WriteLine("example-stderr"); exit 7' }));
    expect(failed.isError).toBe(true);
    expect(failed.output).toContain(f.home);
    expect(failed.output).toContain('tail');
    expect(failed.output).toContain('example-stderr');
    expect(failed.output).toContain('7');
    f.remote.dispose();
  });

  it('searches Windows trees in one PowerShell traversal with braces, ignores, pagination and explicit failures', async () => {
    const f = await fixture('win32');
    f.directories.add('E:/scratch/sub'); f.directories.add('E:/scratch/.git');
    for (const path of ['a.md', 'b.stl', 'hidden.md', '.env', '.git/private.md', 'sub/c.md']) f.files.set(`E:/scratch/${path}`, Buffer.from('word\n'));
    f.files.set('E:/scratch/.gitignore', Buffer.from('hidden.md\n'));
    const result = await execute(await f.tools.glob.resolveExecution({ host: 'dev', path: 'E:/scratch', pattern: '**/*.{md,stl}', head_limit: 2 }));
    expect(result.output).toContain('E:/scratch/a.md'); expect(result.output).toContain('E:/scratch/b.stl');
    expect(result.output).toContain('offset=2'); expect(result.output).not.toContain('hidden.md'); expect(result.output).not.toContain('private.md');
    const all = await execute(await f.tools.glob.resolveExecution({ host: 'dev', path: 'E:/scratch', pattern: '*.md', include_ignored: true, head_limit: 0 }));
    expect(all.output).toContain('hidden.md'); expect(all.output).toContain('sub/c.md'); expect(all.output).not.toContain('private.md');
    f.failures.add('E:/scratch');
    const failed = await execute(await f.tools.glob.resolveExecution({ host: 'dev', path: 'E:/scratch', pattern: '*' }));
    expect(failed.isError).toBe(true); expect(failed.output).toContain('readdir'); expect(failed.output).not.toContain('No matches found');
    f.remote.dispose();
  });

  it.skipIf(process.platform !== 'win32').each([1, 2, undefined])('honors traversal depth %s in the actual Windows search script', async (maxDepth) => {
    const f = await fixture('win32');
    await f.remote.connect();
    await mkdir(join(f.home, 'nested', 'deeper'), { recursive: true });
    const paths = [join(f.home, 'root.txt'), join(f.home, 'nested', 'child.txt'), join(f.home, 'nested', 'deeper', 'grandchild.txt')];
    for (const path of paths) await writeFile(path, 'example');
    f.response.executePowerShell = true;
    const ssh = (await f.manager.get('dev')).withCwd(f.home);
    const args = ['--files', '--glob', '*.txt'];
    if (maxDepth !== undefined) args.push('--max-depth', String(maxDepth));
    args.push(f.home);
    const search = spawnWindowsSearch(ssh, args);
    const [output, diagnostics, exitCode] = await Promise.all([text(search.stdout), text(search.stderr), search.wait()]);
    expect(diagnostics).toBe('');
    expect(exitCode).toBe(0);
    expect(output.trim().split('\n').toSorted()).toEqual(paths.slice(0, maxDepth).map((path) => path.replaceAll('\\', '/')).toSorted());
  });

  it('preserves long Windows Grep patterns through TEMP scripts and propagates failures', async () => {
    const f = await fixture('win32');
    f.files.set('E:/scratch/a.md', Buffer.from('word\n'));
    f.response.stdout = Buffer.from('E:/scratch/a.md\0' + '1:word\n');
    const pattern = String.raw`word|世界|\$_|\\path|`.repeat(600);
    const result = await execute(await f.tools.grep.resolveExecution({ host: 'dev', path: 'E:/scratch', pattern, output_mode: 'content' }));
    expect(result.isError).not.toBe(true); expect(result.output).toContain('E:/scratch/a.md:1:word');
    const script = f.commands.at(-1)!;
    expect(script).toContain('foreach ($path in $c.paths)');
    const config = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)!;
    expect(JSON.parse(Buffer.from(config[1]!, 'base64').toString('utf8'))).toMatchObject({ pattern });
    expect([...f.files.keys()].filter((path) => /kiki-ssh-.*\.ps1$/.test(path))).toEqual([]);
    f.response.stdout = Buffer.alloc(0); f.response.stderr = Buffer.from('script failed\n'); f.response.exitCode = 1;
    const failed = await execute(await f.tools.grep.resolveExecution({ host: 'dev', path: 'E:/scratch', pattern: 'word' }));
    expect(failed.isError).toBe(true); expect(failed.output).toContain('script failed'); expect(failed.output).not.toContain('No matches');
    f.remote.dispose();
  });

  it('uploads long scripts to TEMP and removes them after a nonzero exit', async () => {
    const f = await fixture('win32');
    const ssh = await f.remote.connect();
    f.response.exitCode = 7;
    const script = "$value='世界 $_ \\path';\n".repeat(400);
    const process = await ssh.execPowerShell(script);
    process.stdin.end();
    process.stdout.resume(); process.stderr.resume();
    expect(await process.wait()).toBe(7);
    expect(f.commands.at(-1)).toContain(script);
    await process.dispose();
    expect([...f.files.keys()].filter((path) => /kiki-ssh-.*\.ps1$/.test(path))).toEqual([]);
    f.remote.dispose();
  });

  it.each(['powershell', 'cmd'])('detects Windows %s and chooses native PowerShell without Git Bash', async (shell) => {
    const f = await fixture('win32', shell);
    await f.remote.connect();
    expect(f.remote.environment.shellName).toBe('powershell');
    expect(f.remote.environment.shellPath).toBe('powershell.exe');
    expect((await f.remote.connect()).osEnv).toMatchObject({ defaultShellName: shell });
    expect(f.commands).toHaveLength(1);
    f.remote.dispose();
  });

  it('decodes GBK output, strips progress CLIXML, preserves errors and nonzero status', async () => {
    const f = await fixture('win32');
    await f.remote.connect();
    f.response.stdout = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
    f.response.stderr = Buffer.from('#< CLIXML\r\n<Objs><Obj S="progress"><MS>noise</MS></Obj><S S="Error">错误_x000D__x000A_</S></Objs>');
    f.response.exitCode = 7;
    const proc = await f.remote.process.spawn('powershell.exe', ['-c', 'Get-ChildItem $_.FullName']);
    const [stdout, stderr] = await Promise.all([text(proc.stdout), text(proc.stderr)]);
    expect(stdout).toBe('中文\n');
    expect(stderr).toBe('错误\r\n');
    expect(await proc.wait()).toBe(7);
    expect(f.commands.at(-1)).toContain("$ProgressPreference='SilentlyContinue'");
    expect(f.commands.at(-1)).toContain('[Console]::OutputEncoding');
    expect(f.commands.at(-1)).toContain('$OutputEncoding');
    await proc.dispose();
    f.remote.dispose();
  });

  it('propagates SFTP traversal failures instead of reporting no glob matches', async () => {
    const f = await fixture('win32');
    const ssh = await f.remote.connect();
    f.failures.add('E:/scratch');
    await expect((async () => { for await (const _path of ssh.glob('E:/scratch', '**/*')) { } })()).rejects.toThrow('readdir');
    f.remote.dispose();
  });

  it('does not mistake a Linux remote command failure with exit 1 for no search matches', async () => {
    const f = await fixture();
    f.response.stdout = Buffer.alloc(0);
    f.response.stderr = Buffer.from('remote command not supported\n');
    f.response.exitCode = 1;
    const { glob, grep } = f.tools;
    for (const result of [await execute(await glob.resolveExecution({ host: 'dev', pattern: '*' })),
      await execute(await grep.resolveExecution({ host: 'dev', pattern: 'word' }))]) {
      expect(result.isError).toBe(true);
      expect(result.output).toContain('remote command not supported');
      expect(result.output).not.toContain('No matches');
    }
    f.remote.dispose();
  });

  it('reads Windows drive paths and roundtrips exact scratch bytes through Write and Edit', async () => {
    const f = await fixture('win32');
    const read = new ReadTool(f.runtime, f.workspace, f.catalog, f.truncation);
    const write = new WriteTool(f.runtime, f.workspace);
    const edit = new EditTool(new FileEditService(f.localFs), f.runtime, f.workspace);
    const original = 'E:/work/attempts/run-01/task.log.err';
    f.files.set(original, Buffer.from('remote diagnostic\r\n'));
    const result = await execute(await read.resolveExecution({ host: 'dev', path: original, n_lines: 60 }));
    expect(result.output).toContain('remote diagnostic');
    expect(f.remote.environment.pathClass).toBe('win32');
    expect(f.remote.environment.homeDir).toBe('C:/Users/tester');
    expect(f.commands).toHaveLength(1);
    expect((await f.remote.connect()).activeProcesses).toBe(0);
    const path = 'E:/scratch/roundtrip.txt';
    expect((await execute(await write.resolveExecution({ host: 'dev', path, content: 'alpha 世界\r\n' }))).isError).not.toBe(true);
    expect((await execute(await read.resolveExecution({ host: 'dev', path }))).output).toContain('alpha 世界');
    expect((await execute(await edit.resolveExecution({ host: 'dev', path, old_string: 'alpha', new_string: 'beta' }))).isError).not.toBe(true);
    expect(f.files.get(path)).toEqual(Buffer.from('beta 世界\r\n'));
    expect((await execute(await read.resolveExecution({ path: 'ssh://dev/E:/scratch/roundtrip.txt' }))).output).toContain('beta 世界');
    const proc = await f.remote.process.spawn('C:/Program Files/Git/bin/bash.exe', ['-c', "printf 'hello'"], { cwd: 'E:/scratch', env: { EXAMPLE: "a'b $x" } });
    await proc.wait();
    expect(f.commands.at(-1)).toContain("Set-Location -LiteralPath 'E:/scratch'");
    expect(f.commands.at(-1)).toContain("$env:EXAMPLE='a''b $x'");
    expect(f.commands.at(-1)).toContain("& 'C:/Program Files/Git/bin/bash.exe' '-c'");
    await proc.dispose();
    f.remote.dispose();
  });

  it('keeps seven actual tool schemas byte-identical across SSH reconnects', async () => {
    const f = await fixture();
    const tools = [
      new BashTool(f.runtime, undefined as never, f.workspace, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never),
      new ReadTool(f.runtime, f.workspace, f.catalog, f.truncation),
      new WriteTool(f.runtime, f.workspace),
      new EditTool(new FileEditService(f.localFs), f.runtime, f.workspace),
      new GlobTool(f.runtime, f.workspace, f.telemetry),
      new GrepTool(f.runtime, f.workspace, f.telemetry),
      new ReadMediaFileTool(f.runtime, { workspaceDir: f.home, additionalDirs: [] }, { image_in: true } as never),
    ];
    const schemas = () => JSON.stringify(tools.map((tool) => ({ name: tool.name, parameters: tool.parameters })));
    const initial = Buffer.from(schemas());
    for (const tool of tools) {
      expect((tool.parameters['properties'] as Record<string, unknown>)['host']).toBeDefined();
      expect(tool.parameters).toBe(tool.parameters);
    }
    await f.remote.connect();
    expect(Buffer.from(schemas()).equals(initial)).toBe(true);
    await f.manager.disconnect('dev');
    expect(Buffer.from(schemas()).equals(initial)).toBe(true);
    await f.remote.connect();
    expect(Buffer.from(schemas()).equals(initial)).toBe(true);
    f.remote.dispose();
  });

  it('routes Read/Write/Edit, local override, Bash process, Glob and Grep over one verified connection', async () => {
    const f = await fixture();
    const read = new ReadTool(f.runtime, f.workspace, f.catalog, f.truncation);
    const write = new WriteTool(f.runtime, f.workspace);
    const edit = new EditTool(new FileEditService(f.localFs), f.runtime, f.workspace);
    const { glob, grep } = f.tools;
    expect((await execute(await write.resolveExecution({ host: 'dev', path: '/home/tester/test.txt', content: 'alpha\n' }))).output).toContain('host: dev');
    expect((await execute(await read.resolveExecution({ path: 'ssh://dev/home/tester/test.txt' }))).output).toContain('1\talpha');
    expect((await execute(await edit.resolveExecution({ host: 'dev', path: '/home/tester/test.txt', old_string: 'alpha', new_string: 'beta' }))).output).toContain('host: dev');
    expect(filesText(f.files.get('/home/tester/test.txt'))).toBe('beta\n');
    expect((await execute(await glob.resolveExecution({ host: 'dev', pattern: '*.txt' }))).output).toContain('/home/tester/test.txt');
    expect((await execute(await grep.resolveExecution({ host: 'dev', pattern: 'beta' }))).output).toContain('/home/tester/test.txt');
    const outside = [
      await read.resolveExecution({ host: 'dev', path: '/etc/passwd' }),
      await write.resolveExecution({ host: 'dev', path: '/etc/new-file', content: 'blocked' }),
      await edit.resolveExecution({ host: 'dev', path: '/etc/passwd', old_string: 'a', new_string: 'b' }),
      await glob.resolveExecution({ host: 'dev', path: '/etc', pattern: '*' }),
      await grep.resolveExecution({ host: 'dev', path: '/etc', pattern: 'root' }),
    ];
    for (const execution of outside) {
      expect('execute' in execution && execution.accesses?.some((access) =>
        access.kind === 'file' && access.implicitExternal === true)).toBe(true);
    }
    const inside = await read.resolveExecution({ host: 'dev', path: '/home/tester/test.txt' });
    expect('execute' in inside && inside.accesses?.some((access) =>
      access.kind === 'file' && access.implicitExternal === true)).toBe(false);
    const proc = await f.remote.process.spawn('/bin/sh', ['-c', 'echo hello']);
    const chunks: Buffer[] = [];
    for await (const chunk of proc.stdout) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe('hello from SSH\n');
    expect(await proc.wait()).toBe(0);
    await writeFile(join(f.home, 'local.txt'), 'local only\n');
    const local = await execute(await read.resolveExecution({ host: 'local', path: join(f.home, 'local.txt') }));
    expect(local.output).toContain('local only');
    expect(local.output).not.toContain('host: dev');
    expect(await f.remote.fs.readBytes('/home/tester/test.txt', 4, 0)).toEqual(Buffer.from('beta'));
    expect(await f.remote.fs.createExclusive('/home/tester/test.txt', Buffer.from('no'))).toBe(false);
    expect((await f.remote.fs.readdir('/home/tester')).map((entry) => entry.name)).toContain('test.txt');
    await f.manager.disconnect('dev');
    expect((await execute(await read.resolveExecution({ host: 'dev', path: '/home/tester/test.txt' }))).output).toContain('beta');
    expect(f.manager.status('dev').generation).toBe(2);
    await f.remote.fs.remove('/home/tester/test.txt');
    expect(f.files.has('/home/tester/test.txt')).toBe(false);
    f.remote.dispose();
  });
});

function filesText(buffer: Buffer | undefined): string {
  return buffer?.toString() ?? '';
}

async function text(stream: import('node:stream').Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
