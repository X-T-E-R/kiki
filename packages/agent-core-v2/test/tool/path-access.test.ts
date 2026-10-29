import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { ShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IReadTool } from '#/agent/tools/os/read/read';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import { IGlobTool } from '#/agent/tools/os/glob/glob';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { IWriteTool } from '#/agent/tools/os/write/write';
import { WriteTool } from '#/agent/tools/os/write/writeTool';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { kikiDefinitionReadRoots } from '#/app/bootstrap/definitionReadRoots';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { toHostFsError } from '#/os/interface/hostFsErrors';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ToolExecution } from '#/tool/toolContract';
import { registerToolResultTruncationServices } from '../agent/toolResultTruncation/stubs';
import { stubBootstrap } from '../app/bootstrap/stubs';
import { stubWorkspaceContext } from '../session/workspaceContext/stub-workspace-context';
import {
  isSensitiveFile,
  resolveRealPathAccess,
  withDefinitionReadRoots,
  resolvePathAccess,
  resolvePathAccessPath,
  resolveRealPathAccessPath,
} from '#/tool/path-access';

describe('isSensitiveFile', () => {
  it('flags base .env files in any directory', () => {
    for (const path of ['.env', '/app/.env', 'project/.env']) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags .env.<environment> variants', () => {
    for (const path of ['.env.local', '.env.production', '/app/.env.staging']) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags cloud credential file locations', () => {
    for (const path of [
      '/home/user/.aws/credentials',
      '/home/user/.gcp/credentials',
      '.aws/credentials',
      '.gcp/credentials',
      'credentials',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('matches sensitive patterns case-insensitively on posix paths', () => {
    for (const path of [
      '.ENV',
      '/app/.Env.Local',
      '/home/user/.AWS/Credentials',
      '/home/user/.GCP/CREDENTIALS',
      '/home/user/.ssh/ID_RSA',
      '/home/user/.ssh/ID_ED25519.OLD',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('does not flag normal source / config files or env exemplars', () => {
    for (const path of [
      'app.py',
      'config.yml',
      'README.md',
      'package.json',
      'server.key.example',
      'id_rsa.pub',
      'credentials.json',
      '.envrc',
      'environment.py',
      '.env_example',
      '.env.example',
      '.ENV.EXAMPLE',
      '.env.sample',
      '.ENV.SAMPLE',
      '.env.template',
      '.ENV.TEMPLATE',
      '/app/.env.example',
      '/app/.ENV.EXAMPLE',
    ]) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });
});

describe('withDefinitionReadRoots', () => {
  const workspace = { workspaceDir: '/repo', additionalDirs: ['/extra'] };

  it('projects current definitions and inherited agents without admitting base docs or the whole home', () => {
    const roots = kikiDefinitionReadRoots({ homeDir: '/spaces/current', userAgentProfileHomeDir: '/profiles', baseHomeDir: '/spaces/base' });
    expect(roots).toContain('/spaces/current/docs');
    expect(roots).toContain('/profiles/agents');
    expect(roots).toContain('/spaces/base/agents');
    expect(roots).not.toContain('/spaces/base/docs');
    expect(roots).not.toContain('/spaces/current');
    expect(withDefinitionReadRoots(workspace, [], '/remote/user').definitionReadRoots).not.toContain('/remote/user/.kiki/docs');
  });

  it('keeps project write roots separate from registered user definitions and docs', () => {
    const configured = withDefinitionReadRoots(workspace, ['/other/skills'], '/home/user', ['/spaces/current/agents', '/spaces/current/skills', '/spaces/current/commands', '/spaces/current/docs', '/spaces/base/agents']);
    expect(configured.additionalDirs).toEqual(['/extra']);
    expect(configured.definitionReadRoots).toEqual(expect.arrayContaining([
      '/other/skills', '/home/user/.agents/skills', '/home/user/.agents/agents',
      '/spaces/current/agents', '/spaces/current/skills', '/spaces/current/commands',
      '/spaces/current/docs', '/spaces/base/agents',
    ]));
    expect(configured.definitionReadRoots).not.toContain('/home/user/.kiki');
    expect(configured.definitionReadRoots).not.toContain('/home/user/.kiki/docs');
    expect(configured.definitionReadRoots).not.toContain('/spaces/base/docs');
    expect(configured.definitionReadRoots).not.toContain('/spaces/current');
    expect(configured.definitionReadRoots).not.toContain('/spaces/base');
  });
});

describe('resolvePathAccess shell path bridge', () => {
  const WIN_ENV = {
    pathClass: 'win32' as const,
    homeDir: 'C:\\Users\\test',
    osKind: 'Windows',
    shellName: 'bash' as const,
    shellPath: 'C:\\kimi-test-nonexistent\\Git\\bin\\bash.exe',
  };

  it('routes win32 file-tool paths through the shell path bridge', () => {
    const result = resolvePathAccessPath('/c/workspace/file.txt', {
      env: WIN_ENV,
      workspace: { workspaceDir: 'C:\\workspace', additionalDirs: [] },
      operation: 'read',
    });
    expect(result).toBe('C:/workspace/file.txt');
  });

  it('reports the raw path, target, and recovery for relative external intent', () => {
    expect(() => resolvePathAccess('..\\outside.txt', 'C:/workspace', {
      workspaceDir: 'C:/workspace', additionalDirs: [],
    }, { operation: 'read', pathClass: 'win32' })).toThrow(/external target.*absolute path.*approval/);
  });

  it('passes root-relative POSIX paths through when cygpath is unavailable', () => {
    const result = resolvePathAccessPath('/tmp/scratch.txt', {
      env: WIN_ENV,
      workspace: { workspaceDir: 'C:\\workspace', additionalDirs: [] },
      operation: 'read',
    });
    expect(result).toBe('/tmp/scratch.txt');
  });

  it('does not reinterpret a POSIX root under non-bash shells as a Windows drive', () => {
    const result = resolvePathAccessPath('/a/project/file.txt', {
      env: { ...WIN_ENV, shellName: 'sh' as const },
      workspace: { workspaceDir: 'C:\\workspace', additionalDirs: [] },
      operation: 'read',
    });
    expect(result).toBe('/a/project/file.txt');
    expect(resolvePathAccessPath('/cygdrive/c/workspace/file.txt', {
      env: { ...WIN_ENV, shellName: 'sh' as const },
      workspace: { workspaceDir: 'C:\\workspace', additionalDirs: [] },
      operation: 'read',
    })).toBe('C:/workspace/file.txt');
  });

  it('normalizes through an explicitly injected shell path bridge', () => {
    const bridge: ShellPathBridge = {
      toShellPath: (p) => p,
      fromShellPath: (p) => (p.startsWith('/tmp/') ? `C:/Temp/${p.slice('/tmp/'.length)}` : p),
    };
    const result = resolvePathAccess(
      '/tmp/notes.txt',
      'C:\\workspace',
      { workspaceDir: 'C:\\workspace', additionalDirs: [] },
      {
        operation: 'read',
        pathClass: 'win32',
        shellPathBridge: bridge,
      },
    );
    expect(result).toEqual({ path: 'C:/Temp/notes.txt', outsideWorkspace: true });
  });
});

describe('resolveRealPathAccessPath', () => {
  let root: string;
  let workspaceDir: string;
  let outsideDir: string;
  let additionalDir: string;
  const fs = new HostFileSystem();
  let disposables: DisposableStore;
  const env = {
    pathClass: process.platform === 'win32' ? 'win32' as const : 'posix' as const,
    homeDir: tmpdir(),
    osKind: process.platform === 'win32' ? 'Windows' : 'Linux',
    shellName: 'bash' as const,
    shellPath: '/bin/bash',
  };

  beforeEach(async () => {
    disposables = new DisposableStore();
    root = await mkdtemp(join(tmpdir(), 'kiki-path-admission-'));
    workspaceDir = join(root, 'repo');
    outsideDir = join(root, 'outside');
    additionalDir = join(root, 'extra');
    await Promise.all([workspaceDir, outsideDir, additionalDir].map((dir) => mkdir(dir)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disposables.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function options(operation: 'read' | 'write' | 'search' = 'read') {
    return {
      env,
      workspace: { workspaceDir, additionalDirs: [additionalDir] },
      operation,
    };
  }

  function fileTools(additionalDirs: readonly string[]) {
    const backend = disposables.add(new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      { capabilities: ['fs', 'process'], pathClass: env.pathClass, environment: { ...env, homeDir: root } },
    ));
    Object.assign(backend, { fs, process: new HostProcessService() });
    const acquire = () => ({ runtime: backend, track: <T>(resource: T) => resource, dispose() {} });
    return createServices(disposables, {
      strict: true,
      base: [registerToolResultTruncationServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentRuntimeService, {
          inspect: () => backend,
          workspaceRoots: () => ({ workDir: workspaceDir, additionalDirs }),
          acquire,
          prepareFor: async () => backend,
          acquireFor: acquire,
        });
        reg.defineInstance(ISessionWorkspaceContext, stubWorkspaceContext(workspaceDir));
        reg.definePartialInstance(ISessionSkillCatalog, {
          catalog: new InMemorySkillCatalog(),
        });
        reg.defineInstance(IBootstrapService, stubBootstrap(root));
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        reg.define(IReadTool, ReadTool);
        reg.define(IGlobTool, GlobTool);
        reg.define(IWriteTool, WriteTool);
      },
    });
  }

  async function execute(execution: ToolExecution | Promise<ToolExecution>) {
    const resolved = await execution;
    if (resolved.isError === true) throw new Error(JSON.stringify(resolved.output));
    return resolved.execute({ turnId: 1, toolCallId: 'file-admission', signal: new AbortController().signal });
  }

  it('reads current-home docs through Read without granting writes or default-main docs access', async () => {
    const services = fileTools([]);
    const docs = join(root, 'docs');
    await mkdir(docs);
    const current = join(docs, 'guide.md');
    await writeFile(current, 'current Space docs');
    const read = await services.get(IReadTool).resolveExecution({ path: '../docs/guide.md' });
    if (read.isError === true) throw new Error(String(read.output));
    expect(read.accesses).toMatchObject([{ implicitExternal: false }]);
    expect(await execute(read)).toMatchObject({ output: expect.stringContaining('current Space docs') });
    const write = await services.get(IWriteTool).resolveExecution({ path: current, content: 'changed' });
    if (write.isError === true) throw new Error(String(write.output));
    expect(write.accesses).toMatchObject([{ kind: 'file', operation: 'write', path: current.replaceAll('\\', '/') }]);
    await expect(resolveRealPathAccess(current, { ...options('write'), workspace: withDefinitionReadRoots(options().workspace, [], root, kikiDefinitionReadRoots(services.get(IBootstrapService))) }, fs)).resolves.toMatchObject({ outsideWorkspace: true });
    expect(await readFile(current, 'utf8')).toBe('current Space docs');
    const defaultDocs = join(root, '.kiki', 'docs');
    await mkdir(defaultDocs, { recursive: true });
    const old = join(defaultDocs, 'guide.md');
    await writeFile(old, 'unselected main');
    await expect(services.get(IReadTool).resolveExecution({ path: '../.kiki/docs/guide.md' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(services.get(IWriteTool).resolveExecution({ path: '../docs/guide.md', content: 'changed' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('keeps native Read, Glob and Write usable with an uncreated additional root', async () => {
    const missingRoot = join(root, 'future', 'nested');
    const services = fileTools([additionalDir, missingRoot, join(root, 'another-future')]);
    const read = services.get(IReadTool);
    const glob = services.get(IGlobTool);
    const write = services.get(IWriteTool);
    const notes = join(workspaceDir, 'notes.txt');
    await writeFile(notes, 'inside workspace');

    for (const args of [{ path: 'notes.txt' }, { path: notes }, { path: notes, host: 'local' }]) {
      await expect(execute(read.resolveExecution(args))).resolves.toMatchObject({ output: expect.stringContaining('inside workspace') });
    }
    await expect(execute(glob.resolveExecution({ pattern: '*.txt', path: '.' })))
      .resolves.toMatchObject({ output: expect.stringContaining('notes.txt') });
    const localWrite = await execute(write.resolveExecution({ path: 'new.txt', content: 'written' }));
    expect(localWrite.isError).not.toBe(true);
    expect(await readFile(join(workspaceDir, 'new.txt'), 'utf8')).toBe('written');
    await expect(fs.stat(missingRoot)).rejects.toMatchObject({ code: 'os.fs.not_found' });

    const futureFile = join(missingRoot, 'deeper', 'created.txt');
    const futureWrite = await write.resolveExecution({ path: futureFile, content: 'future workspace' });
    if (futureWrite.isError === true) throw new Error(JSON.stringify(futureWrite.output));
    expect(futureWrite.accesses).toMatchObject([{ kind: 'file', operation: 'write', path: futureFile.replaceAll('\\', '/') }]);
    expect((await execute(futureWrite)).isError).not.toBe(true);
    expect(await readFile(futureFile, 'utf8')).toBe('future workspace');
  });

  it('rejects a future root replaced by an external link after Write admission', async () => {
    const missingRoot = join(root, 'future');
    const write = fileTools([missingRoot]).get(IWriteTool);
    const admitted = await write.resolveExecution({ path: join(missingRoot, 'notes.txt'), content: 'must not escape' });
    await symlink(outsideDir, missingRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(execute(admitted)).resolves.toMatchObject({ isError: true, output: expect.stringContaining('changed after path admission') });
    await expect(fs.stat(join(outsideDir, 'notes.txt'))).rejects.toMatchObject({ code: 'os.fs.not_found' });
  });

  it('resolves a missing additional root through its existing linked ancestor without admitting siblings', async () => {
    const linkedParent = join(root, 'linked-parent');
    await symlink(outsideDir, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    const missingRoot = join(linkedParent, 'future', 'nested');
    const workspace = { workspaceDir, additionalDirs: [missingRoot] };
    const expectedRoot = join(await realpath(outsideDir), 'future', 'nested');
    await expect(resolveRealPathAccess(join(missingRoot, 'new.txt'), { env, workspace, operation: 'write' }, fs))
      .resolves.toMatchObject({ path: join(expectedRoot, 'new.txt').replaceAll('\\', '/'), outsideWorkspace: false, implicitExternal: false });
    await expect(resolveRealPathAccess(join(linkedParent, 'sibling.txt'), { env, workspace, operation: 'write' }, fs))
      .resolves.toMatchObject({ outsideWorkspace: true });
    await expect(resolveRealPathAccess('../linked-parent/sibling.txt', { env, workspace, operation: 'write' }, fs))
      .rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('still requires the main workspace directory to exist', async () => {
    await writeFile(join(workspaceDir, 'notes.txt'), 'inside');
    await expect(resolveRealPathAccess(join(workspaceDir, 'notes.txt'), {
      ...options(), workspace: { workspaceDir: join(root, 'missing-main'), additionalDirs: [workspaceDir] },
    }, fs)).rejects.toMatchObject({ code: 'os.fs.not_found' });
  });

  it.each(['', '/nested'])('rejects dangling additional-root links%s rather than treating them as missing directories', async (suffix) => {
    const dangling = join(root, 'dangling');
    await symlink(join(outsideDir, 'missing'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(workspaceDir, 'notes.txt'), 'inside');
    await expect(resolveRealPathAccess('notes.txt', {
      ...options(), workspace: { workspaceDir, additionalDirs: [`${dangling}${suffix}`] },
    }, fs)).rejects.toMatchObject({ code: 'PATH_INVALID', message: expect.stringContaining('unresolved link target') });
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENOTDIR'])('preserves additional-root realpath errors (%s)', async (code) => {
    const missingRoot = join(root, 'future');
    const error = toHostFsError(Object.assign(new Error(code), { code }), { path: missingRoot, op: 'realpath' });
    const original = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(async (path) => {
      if (path === missingRoot) throw error;
      return original(path);
    });
    await expect(resolveRealPathAccess('.', {
      ...options(), workspace: { workspaceDir, additionalDirs: [missingRoot] },
    }, fs)).rejects.toBe(error);
  });

  it('preserves lstat permission errors while resolving a missing additional root', async () => {
    const missingRoot = join(root, 'future');
    const error = toHostFsError(Object.assign(new Error('EACCES'), { code: 'EACCES' }), { path: missingRoot, op: 'lstat' });
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (path === missingRoot) throw error;
      return original(path);
    });
    await expect(resolveRealPathAccess('.', {
      ...options(), workspace: { workspaceDir, additionalDirs: [missingRoot] },
    }, fs)).rejects.toBe(error);
  });

  it('classifies workspace links by their actual external target for approval', async () => {
    const externalFile = join(outsideDir, 'notes.txt');
    await writeFile(externalFile, 'outside');
    const linkDir = join(workspaceDir, 'escape');
    await symlink(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    for (const operation of ['read', 'write', 'search'] as const) {
      const pathOptions = options(operation);
      pathOptions.workspace.additionalDirs.push(join(root, 'future'));
      for (const candidate of ['escape/notes.txt', join(linkDir, 'notes.txt')]) {
        await expect(resolveRealPathAccess(candidate, pathOptions, fs))
          .resolves.toMatchObject({ path: (await realpath(externalFile)).replaceAll('\\', '/'), outsideWorkspace: true, implicitExternal: true });
      }
    }
    expect((await resolveRealPathAccess('escape/new/sub.txt', options('write'), fs)).implicitExternal).toBe(true);
    expect(await readFile(externalFile, 'utf8')).toBe('outside');
  });

  it('allows ordinary workspace files and trusted additional directories, including new files', async () => {
    await writeFile(join(workspaceDir, 'notes.txt'), 'inside');
    await writeFile(join(additionalDir, 'extra.txt'), 'extra');
    const admittedRead = await resolveRealPathAccessPath('notes.txt', options(), fs);
    expect(admittedRead).toBe((await realpath(join(workspaceDir, 'notes.txt'))).replaceAll('\\', '/'));
    expect(await fs.readText(admittedRead)).toBe('inside');
    const admittedWrite = await resolveRealPathAccessPath('new.txt', options('write'), fs);
    await fs.writeText(admittedWrite, 'written');
    expect(await readFile(join(workspaceDir, 'new.txt'), 'utf8')).toBe('written');
    expect(await resolveRealPathAccessPath(join(additionalDir, 'extra.txt'), options(), fs))
      .toBe((await realpath(join(additionalDir, 'extra.txt'))).replaceAll('\\', '/'));
  });

  it('admits linked skill definitions as reads and sends external writes to target approval', async () => {
    const skillRoot = join(root, '.agents', 'skills');
    const installed = join(skillRoot, 'example');
    const actual = join(outsideDir, 'example');
    await mkdir(skillRoot, { recursive: true });
    await mkdir(actual);
    await writeFile(join(actual, 'SKILL.md'), 'name: example');
    await symlink(actual, installed, process.platform === 'win32' ? 'junction' : 'dir');
    const workspace = withDefinitionReadRoots(options().workspace, [skillRoot], root);
    const requested = join(installed, 'SKILL.md');
    const admitted = await resolveRealPathAccess(requested, { env, workspace, operation: 'read' }, fs);
    expect(await fs.readText(admitted.path)).toBe('name: example');
    expect(admitted.implicitExternal).toBe(false);
    const write = await resolveRealPathAccess(requested, { env, workspace, operation: 'write' }, fs);
    expect(write.path).toBe(admitted.path);
    expect(write.outsideWorkspace).toBe(true);
    expect(write.implicitExternal).toBe(false);
  });

  it('resolves an innocuous alias to a sensitive target before permission evaluation', async () => {
    const sensitive = join(outsideDir, '.env');
    await writeFile(sensitive, 'SECRET=example');
    const aliasDir = join(workspaceDir, 'linked');
    await symlink(outsideDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
    const alias = join(aliasDir, '.env');
    const access = await resolveRealPathAccess(alias, options(), fs);
    expect(access.path).toBe((await realpath(sensitive)).replaceAll('\\', '/'));
    expect(isSensitiveFile(access.path)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('does not follow a dangling file symlink when creating a file', async () => {
    await symlink(join(outsideDir, 'new.txt'), join(workspaceDir, 'alias.txt'));
    await expect(resolveRealPathAccessPath('alias.txt', options('write'), fs))
      .rejects.toMatchObject({ code: 'PATH_INVALID' });
  });

  it.skipIf(process.platform !== 'win32')('recognizes Windows default-stream and 8.3 aliases after resolution', async () => {
    const keyPath = join(workspaceDir, 'id_rsa');
    const longPath = join(workspaceDir, 'id_ed25519');
    await writeFile(keyPath, 'private-key');
    await writeFile(longPath, 'private-key');
    const dirListing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', workspaceDir], { encoding: 'utf8' });
    const aliasName = dirListing.split(/\r?\n/)
      .find((line) => line.toLowerCase().endsWith('id_ed25519'))
      ?.match(/\b([A-Z0-9_~]+)\s+id_ed25519\s*$/i)?.[1];
    expect(aliasName).toBeDefined();
    const shortPath = join(workspaceDir, aliasName!);
    expect(basename(shortPath).toLowerCase()).not.toBe('id_ed25519');
    for (const operation of ['read', 'write'] as const) {
      for (const alias of [`${keyPath}::$DATA`, shortPath]) {
        expect(isSensitiveFile(await resolveRealPathAccessPath(alias, options(operation), fs))).toBe(true);
      }
    }
    expect(await readFile(`${keyPath}::$DATA`, 'utf8')).toBe('private-key');
    expect(await readFile(shortPath, 'utf8')).toBe('private-key');
  });
});
