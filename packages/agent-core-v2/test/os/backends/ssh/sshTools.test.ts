import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import type { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ToolExecution, ExecutableToolContext } from '#/tool/toolContract';

const openServers: Server[] = [];
const openManagers: SshConnectionManager[] = [];
const tempHomes: string[] = [];

const attrs = (mode: number, size = 0) => ({ mode, size, uid: 1000, gid: 1000, atime: 0, mtime: 1 });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'kiki-ssh-tools-'));
  tempHomes.push(home);
  vi.stubEnv('KIKI_HOME', home);
  const files = new Map<string, Buffer>();
  const directories = new Set(['/home/tester']);
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
        if (info.command.includes('KIKI_SSH_ENV')) channel.write('KIKI_SSH_ENV\nLinux\nx86_64\n6.8.0\n/bin/sh\n');
        else if (info.command.includes('--files')) channel.write('./test.txt\n');
        else if (info.command.includes('rg ')) channel.write('/home/tester/test.txt\0');
        else channel.write('hello from SSH\n');
        channel.exit(0);
        channel.end();
      });
      session.on('sftp', (acceptSftp) => {
        const channel = acceptSftp();
        let nextId = 0;
        const handles = new Map<number, string>();
        const handle = (request: number, path: string) => {
          const id = nextId++;
          handles.set(id, path);
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
          const target = path === '.' ? '/home/tester' : path;
          channel.name(request, [{ filename: target, longname: target, attrs: attrs(directories.has(target) ? 0o040755 : 0o100644) }]);
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
        channel.on('OPENDIR', (request, path) => handle(request, path));
        channel.on('READDIR', (request, buffer) => {
          const id = buffer.readUInt32BE(0);
          const path = handles.get(id);
          if (path === undefined) return channel.status(request, utils.sftp.STATUS_CODE.FAILURE);
          if (delivered.has(id)) return channel.status(request, utils.sftp.STATUS_CODE.EOF);
          delivered.add(id);
          const children = [...files].filter(([name]) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes('/'));
          if (children.length === 0) return channel.status(request, utils.sftp.STATUS_CODE.EOF);
          channel.name(request, children.map(([name, value]) => ({ filename: name.slice(path.length + 1), longname: name, attrs: attrs(0o100644, value.length) })));
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
          const chunk = files.get(path)!.subarray(offset, offset + length);
          if (!chunk.length) return channel.status(request, utils.sftp.STATUS_CODE.EOF);
          channel.data(request, chunk);
        });
        channel.on('CLOSE', (request, buffer) => {
          handles.delete(buffer.readUInt32BE(0));
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
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
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
  return { home, files, manager, remote, localFs, runtime, workspace, catalog, truncation, telemetry };
}

async function execute(execution: ToolExecution) {
  if (!('execute' in execution)) return execution;
  const ctx = { turnId: 1, toolCallId: 'call', signal: new AbortController().signal } as ExecutableToolContext;
  return execution.execute(ctx);
}

afterEach(async () => {
  await Promise.all(openManagers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe('SSH tools over a real ssh2 transport', () => {
  it('keeps seven actual tool schemas byte-identical across SSH reconnects', async () => {
    const f = await fixture();
    const tools = [
      new BashTool(f.runtime, undefined as never, f.workspace, undefined as never, undefined as never, undefined as never, undefined as never),
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
    const glob = new GlobTool(f.runtime, f.workspace, f.telemetry);
    const grep = new GrepTool(f.runtime, f.workspace, f.telemetry);
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
