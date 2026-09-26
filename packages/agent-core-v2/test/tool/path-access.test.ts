import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
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

  it('keeps project write roots separate from registered user definitions and docs', () => {
    const configured = withDefinitionReadRoots(workspace, ['/other/skills'], '/home/user');
    expect(configured.additionalDirs).toEqual(['/extra']);
    expect(configured.definitionReadRoots).toEqual(expect.arrayContaining([
      '/other/skills', '/home/user/.agents/skills', '/home/user/.agents/agents',
      '/home/user/.kiki/agents', '/home/user/.kiki/skills', '/home/user/.kiki/commands',
      '/home/user/.kiki/docs',
    ]));
    expect(configured.definitionReadRoots).not.toContain('/home/user/.kiki');
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
  const env = {
    pathClass: process.platform === 'win32' ? 'win32' as const : 'posix' as const,
    homeDir: tmpdir(),
    osKind: process.platform === 'win32' ? 'Windows' : 'Linux',
    shellName: 'bash' as const,
    shellPath: '/bin/bash',
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kiki-path-admission-'));
    workspaceDir = join(root, 'repo');
    outsideDir = join(root, 'outside');
    additionalDir = join(root, 'extra');
    await Promise.all([workspaceDir, outsideDir, additionalDir].map((dir) => mkdir(dir)));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function options(operation: 'read' | 'write' = 'read') {
    return {
      env,
      workspace: { workspaceDir, additionalDirs: [additionalDir] },
      operation,
    };
  }

  it('classifies workspace links by their actual external target for approval', async () => {
    const externalFile = join(outsideDir, 'notes.txt');
    await writeFile(externalFile, 'outside');
    const linkDir = join(workspaceDir, 'escape');
    await symlink(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    for (const operation of ['read', 'write'] as const) {
      for (const candidate of ['escape/notes.txt', join(linkDir, 'notes.txt')]) {
        await expect(resolveRealPathAccess(candidate, options(operation), fs))
          .resolves.toMatchObject({ path: (await realpath(externalFile)).replaceAll('\\', '/'), implicitExternal: true });
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
