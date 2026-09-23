import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import {
  DEFAULT_WORKSPACE_ACCESS_POLICY,
  extendWorkspaceWithSkillRoots,
  isSensitiveFile,
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

describe('extendWorkspaceWithSkillRoots', () => {
  const workspace = { workspaceDir: '/repo', additionalDirs: ['/extra'] };

  it('returns the workspace unchanged when there are no skill roots', () => {
    expect(extendWorkspaceWithSkillRoots(workspace, [])).toBe(workspace);
  });

  it('appends roots outside the workspace and existing additional dirs', () => {
    expect(extendWorkspaceWithSkillRoots(workspace, ['/home/user/.kiki/skills'])).toEqual({
      workspaceDir: '/repo',
      additionalDirs: ['/extra', '/home/user/.kiki/skills'],
    });
  });

  it('skips roots already inside the workspace dir or an additional dir', () => {
    expect(
      extendWorkspaceWithSkillRoots(workspace, ['/repo/.agents/skills', '/extra/skills']),
    ).toBe(workspace);
  });

  it('dedupes roots that repeat or nest inside a just-added root', () => {
    expect(
      extendWorkspaceWithSkillRoots(workspace, ['/skills', '/skills', '/skills/sub']),
    ).toEqual({ workspaceDir: '/repo', additionalDirs: ['/extra', '/skills'] });
  });

  it('compares case-insensitively on win32 path class', () => {
    expect(
      extendWorkspaceWithSkillRoots(
        { workspaceDir: 'C:/repo', additionalDirs: [] },
        ['c:/Repo/skills'],
        'win32',
      ).additionalDirs,
    ).toEqual([]);
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
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
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

  it('rejects symlinked file and directory escapes before read, edit, or write approval', async () => {
    const externalFile = join(outsideDir, 'notes.txt');
    await writeFile(externalFile, 'outside');
    const linkDir = join(workspaceDir, 'escape');
    await symlink(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    for (const operation of ['read', 'write'] as const) {
      for (const candidate of ['escape/notes.txt', join(linkDir, 'notes.txt')]) {
        await expect(resolveRealPathAccessPath(candidate, options(operation), fs))
          .rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
      }
    }
    await expect(resolveRealPathAccessPath('escape/new/sub.txt', options('write'), fs))
      .rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
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

  it.skipIf(process.platform === 'win32')('does not follow a dangling file symlink when creating a file', async () => {
    await symlink(join(outsideDir, 'new.txt'), join(workspaceDir, 'alias.txt'));
    await expect(resolveRealPathAccessPath('alias.txt', options('write'), fs))
      .rejects.toMatchObject({ code: 'PATH_INVALID' });
  });

  it.skipIf(process.platform !== 'win32')('rejects Windows default-stream and 8.3 aliases of sensitive names', async () => {
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
        await expect(resolveRealPathAccessPath(alias, options(operation), fs))
          .rejects.toMatchObject({ code: 'PATH_SENSITIVE' });
      }
    }
    expect(await readFile(`${keyPath}::$DATA`, 'utf8')).toBe('private-key');
    expect(await readFile(shortPath, 'utf8')).toBe('private-key');
  });
});
