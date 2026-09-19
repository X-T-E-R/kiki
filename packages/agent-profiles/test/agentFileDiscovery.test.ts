import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverAgentFiles } from '#/agentFileDiscovery';
import type { AgentFileRoot } from '#/agentFileTypes';
import type { HostFs } from '#/hostFs';

import { HostFsError, nodeHostFs as hostFs, OsFsErrors } from './nodeHostFs';

function agentMd(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} agent\n---\n\n${name} prompt\n`;
}

describe('discoverAgentFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-discovery-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function fileRoot(path: string, source: AgentFileRoot['source'] = 'project'): AgentFileRoot {
    return { path, source };
  }

  it('discovers top-level and nested .md files recursively', async () => {
    await writeFile(join(root, 'solo.md'), agentMd('solo'));
    await mkdir(join(root, 'team'), { recursive: true });
    await writeFile(join(root, 'team/reviewer.md'), agentMd('reviewer'));

    const result = await discoverAgentFiles(hostFs, [fileRoot(root)]);

    expect(result.agents.map((a) => a.name)).toEqual(['reviewer', 'solo']);
    expect(result.skipped).toEqual([]);
    expect(result.scannedRoots).toEqual([root]);
  });

  it('skips dot-prefixed entries and node_modules', async () => {
    await mkdir(join(root, '.hidden'), { recursive: true });
    await writeFile(join(root, '.hidden/ghost.md'), agentMd('ghost'));
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules/pkg/dep.md'), agentMd('dep'));
    await writeFile(join(root, '.dotfile.md'), agentMd('dotfile'));
    await writeFile(join(root, 'solo.md'), agentMd('solo'));

    const result = await discoverAgentFiles(hostFs, [fileRoot(root)]);

    expect(result.agents.map((a) => a.name)).toEqual(['solo']);
  });

  it('skips invalid files with reasons and keeps valid ones', async () => {
    await writeFile(join(root, 'good.md'), agentMd('good'));
    await writeFile(join(root, 'bad.md'), 'not an agent file');

    const warnings: string[] = [];
    const result = await discoverAgentFiles(hostFs, [fileRoot(root)], (message) =>
      warnings.push(message),
    );

    expect(result.agents.map((a) => a.name)).toEqual(['good']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path.endsWith('bad.md')).toBe(true);
    expect(result.skipped[0]?.reason).toContain('Missing frontmatter');
    expect(warnings).toHaveLength(1);
  });

  it('resolves name collisions first-wins in root order', async () => {
    const other = await mkdtemp(join(tmpdir(), 'agent-discovery-other-'));
    try {
      await writeFile(join(root, 'reviewer.md'), agentMd('reviewer'));
      await writeFile(
        join(other, 'reviewer.md'),
        '---\nname: reviewer\ndescription: other reviewer\n---\n\nother prompt\n',
      );

      const result = await discoverAgentFiles(hostFs, [
        fileRoot(root, 'user'),
        fileRoot(other, 'project'),
      ]);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]?.description).toBe('reviewer agent');
      expect(result.agents[0]?.source).toBe('user');
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('scans managed subdirectories after ordinary files in every user root', async () => {
    const brand = join(root, 'brand');
    const generic = join(root, 'generic');
    await mkdir(join(brand, 'builtin'), { recursive: true });
    await mkdir(generic, { recursive: true });
    await writeFile(join(brand, 'builtin', 'aaa.md'), agentMd('general'));
    await writeFile(join(brand, 'builtin', 'bbb.md'), agentMd('explore'));
    await writeFile(join(brand, 'zzz.md'), agentMd('general'));
    await writeFile(join(generic, 'zzz.md'), agentMd('explore'));
    const warnings: string[] = [];
    const result = await discoverAgentFiles(hostFs, [
      { ...fileRoot(brand, 'user'), lowPrioritySubdirectories: ['builtin'] },
      fileRoot(generic, 'user'),
    ], (message) => warnings.push(message));

    expect(result.agents.find((agent) => agent.name === 'general')?.path).toBe(join(brand, 'zzz.md'));
    expect(result.agents.find((agent) => agent.name === 'explore')?.path).toBe(join(generic, 'zzz.md'));
    expect(result.skipped).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(join(brand, 'builtin', 'aaa.md'));
    expect(warnings[0]).toContain(join(brand, 'zzz.md'));
    expect(warnings[1]).toContain(join(brand, 'builtin', 'bbb.md'));
    expect(warnings[1]).toContain(join(generic, 'zzz.md'));
  });

  it('ignores non-markdown files', async () => {
    await writeFile(join(root, 'notes.txt'), agentMd('notes'));

    const result = await discoverAgentFiles(hostFs, [fileRoot(root)]);

    expect(result.agents).toEqual([]);
  });

  it('rejects when a directory cannot be scanned so callers can keep stale contributions', async () => {
    const failingFs = {
      readdir: async () => {
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_UNAVAILABLE,
          'readdir failed: filesystem resource unavailable',
        );
      },
    } as unknown as HostFs;

    await expect(discoverAgentFiles(failingFs, [fileRoot(root)])).rejects.toMatchObject({
      code: OsFsErrors.codes.OS_FS_UNAVAILABLE,
    });
  });

  it('rejects when a file cannot be read during a filesystem outage', async () => {
    await writeFile(join(root, 'agent.md'), agentMd('agent'));
    const failingFs = {
      _serviceBrand: undefined,
      readdir: hostFs.readdir.bind(hostFs),
      stat: hostFs.stat.bind(hostFs),
      realpath: hostFs.realpath.bind(hostFs),
      readFile: async () => {
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_UNAVAILABLE,
          'read failed: filesystem resource unavailable',
        );
      },
    } as unknown as HostFs;

    await expect(discoverAgentFiles(failingFs, [fileRoot(root)])).rejects.toMatchObject({
      code: OsFsErrors.codes.OS_FS_UNAVAILABLE,
    });
  });

  it('treats a directory that disappears during scanning as absent', async () => {
    const disappearingFs = {
      readdir: async () => {
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_NOT_FOUND,
          'readdir failed: path does not exist',
        );
      },
    } as unknown as HostFs;

    const result = await discoverAgentFiles(disappearingFs, [fileRoot(root)]);

    expect(result.agents).toEqual([]);
  });

  it('skips an unreadable subdirectory with a warning and keeps scanning the rest', async () => {
    const locked = join(root, 'locked');
    const fakeFs = {
      realpath: async (p: string) => p,
      stat: async (p: string) =>
        p === locked ? { isDirectory: true, isFile: false } : { isDirectory: false, isFile: true },
      readdir: async (p: string) => {
        if (p === locked) {
          throw new HostFsError(
            OsFsErrors.codes.OS_FS_PERMISSION_DENIED,
            'readdir failed: permission denied',
          );
        }
        return [{ name: 'locked' }, { name: 'solo.md' }];
      },
      readFile: async () => agentMd('solo'),
    } as unknown as HostFs;

    const warnings: string[] = [];
    const result = await discoverAgentFiles(fakeFs, [fileRoot(root)], (message) =>
      warnings.push(message),
    );

    expect(result.agents.map((a) => a.name)).toEqual(['solo']);
    expect(warnings.some((w) => w.includes('locked'))).toBe(true);
  });

  it('skips an unreadable entry probe and keeps scanning the same root', async () => {
    const blocked = join(root, 'blocked.md');
    const available = join(root, 'available.md');
    const fakeFs = {
      realpath: async (p: string) => p,
      stat: async (p: string) => {
        if (p === blocked) {
          throw new HostFsError(
            OsFsErrors.codes.OS_FS_PERMISSION_DENIED,
            'stat failed: permission denied',
          );
        }
        return { isDirectory: false, isFile: p === available };
      },
      readdir: async () => [{ name: 'blocked.md' }, { name: 'available.md' }],
      readFile: async () => agentMd('available'),
    } as unknown as HostFs;

    const warnings: string[] = [];
    const result = await discoverAgentFiles(fakeFs, [fileRoot(root)], (message) =>
      warnings.push(message),
    );

    expect(result.agents.map((agent) => agent.name)).toEqual(['available']);
    expect(warnings.some((warning) => warning.includes('blocked.md'))).toBe(true);
  });

  it('isolates a failed root and keeps scanning sibling roots', async () => {
    const other = await mkdtemp(join(tmpdir(), 'agent-discovery-other-'));
    try {
      const fakeFs = {
        realpath: async (p: string) => p,
        stat: async () => ({ isDirectory: false, isFile: true }),
        readdir: async (p: string) => {
          if (p === root) {
            throw new HostFsError(
              OsFsErrors.codes.OS_FS_PERMISSION_DENIED,
              'readdir failed: permission denied',
            );
          }
          return [{ name: 'solo.md' }];
        },
        readFile: async () => agentMd('solo'),
      } as unknown as HostFs;

      const warnings: string[] = [];
      const result = await discoverAgentFiles(
        fakeFs,
        [fileRoot(root), fileRoot(other)],
        (message) => warnings.push(message),
      );

      expect(result.agents.map((a) => a.name)).toEqual(['solo']);
      expect(warnings.some((w) => w.includes(root))).toBe(true);
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
