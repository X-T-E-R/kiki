import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { symlinkDir, windowsSymlinksUnavailable } from '../../_base/utils/symlink';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  extractAgentsMdPathsFromSystemPrompt,
  loadAgentsMd,
  loadAgentsMdDetailed,
  prepareSystemPromptContext,
} from '#/agent/profile/context';

function createFs(): IHostFileSystem {
  return new HostFileSystem();
}

let fs: IHostFileSystem;
let homeDir: string;
let workDir: string;
let extraDirs: string[];

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-agents-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-agents-work-'));
  extraDirs = [];
  fs = createFs();
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await Promise.all(extraDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })));
});

describe('loadAgentsMd user-level discovery', () => {
  it('injects the user-level and workspace-root files together', async () => {
    await mkdir(join(homeDir, '.kiki'), { recursive: true });
    await writeFile(join(homeDir, '.kiki', 'AGENTS.md'), 'user instructions', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'workspace instructions', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('user instructions');
    expect(result).toContain('workspace instructions');
    expect(result.indexOf('user instructions')).toBeLessThan(
      result.indexOf('workspace instructions'),
    );
  });

  it('does not discover generic real-home instructions', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'generic instructions', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).not.toContain('generic instructions');
  });

  it('matches the instruction filename case-insensitively', async () => {
    await mkdir(join(homeDir, '.kiki'), { recursive: true });
    await writeFile(join(homeDir, '.kiki', 'AgEnTs.Md'), 'mixed-case user', 'utf-8');
    await writeFile(join(workDir, 'aGeNtS.mD'), 'mixed-case workspace', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('mixed-case user');
    expect(result).toContain('mixed-case workspace');
  });

  it('lets the workspace .kiki file override the user-level file', async () => {
    await mkdir(join(homeDir, '.kiki'), { recursive: true });
    await writeFile(join(homeDir, '.kiki', 'AGENTS.md'), 'user instructions', 'utf-8');
    await mkdir(join(workDir, '.kiki'), { recursive: true });
    await writeFile(join(workDir, '.kiki', 'agents.md'), 'workspace override', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'workspace instructions', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).not.toContain('user instructions');
    expect(result).toContain('workspace override');
    expect(result).toContain('workspace instructions');
  });
});

describe('loadAgentsMd symlinked files', () => {
  it.skipIf(windowsSymlinksUnavailable)('follows symlinks when loading user-level and project-level AGENTS.md', async () => {
    const targetDir = await mkdtemp(join(tmpdir(), 'kimi-agents-target-'));
    extraDirs.push(targetDir);
    const brandTarget = join(targetDir, 'brand-AGENTS.md');
    const projectTarget = join(targetDir, 'project-AGENTS.md');
    await writeFile(brandTarget, 'brand via symlink', 'utf-8');
    await writeFile(projectTarget, 'project via symlink', 'utf-8');

    await mkdir(join(homeDir, '.kiki'), { recursive: true });
    await symlink(brandTarget, join(homeDir, '.kiki', 'AGENTS.md'));
    await symlink(projectTarget, join(workDir, 'AGENTS.md'));

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('brand via symlink');
    expect(result).toContain('project via symlink');
  });
});

describe('loadAgentsMd unreadable paths', () => {
  it('warns when an instruction file exists but is a dangling symlink', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    await symlinkDir(join(workDir, 'missing-target.md'), join(workDir, 'AGENTS.md'));

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome);

    expect(result.agentsMd).toBe('');
    expect(result.agentsMdWarning).toBeDefined();
    expect(result.agentsMdWarning).toContain('not a readable regular file');
  });
});

describe('loadAgentsMd brand home (KIKI_HOME)', () => {
  let brandHome: string;

  beforeEach(async () => {
    brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
  });

  afterEach(async () => {
    await rm(brandHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('loads the user-level file from the configured brand home', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand home instructions', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir, brandHome);

    expect(result).toContain('brand home instructions');
  });

  it('ignores the real-home .kiki/AGENTS.md when the brand home is elsewhere', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand wins', 'utf-8');
    await mkdir(join(homeDir, '.kiki'), { recursive: true });
    await writeFile(join(homeDir, '.kiki', 'AGENTS.md'), 'stale real-home brand', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir, brandHome);

    expect(result).toContain('brand wins');
    expect(result).not.toContain('stale real-home brand');
  });

  it('falls back to the real-home .kiki/AGENTS.md when no brand home is given', async () => {
    await mkdir(join(homeDir, '.kiki'), { recursive: true });
    await writeFile(join(homeDir, '.kiki', 'AGENTS.md'), 'fallback branded', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('fallback branded');
  });
});

describe('loadAgentsMd workspace boundaries', () => {
  it('does not inject nested or arbitrary instruction files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kimi-agents-project-'));
    extraDirs.push(projectRoot);
    const leaf = join(projectRoot, 'packages', 'app');
    const docs = join(projectRoot, 'docs');
    await mkdir(leaf, { recursive: true });
    await mkdir(docs, { recursive: true });
    await mkdir(join(projectRoot, '.git'));
    await writeFile(join(projectRoot, 'AGENTS.md'), 'root instructions', 'utf-8');
    await writeFile(join(projectRoot, 'packages', 'AGENTS.md'), 'packages instructions', 'utf-8');
    await writeFile(join(leaf, 'AGENTS.md'), 'leaf instructions', 'utf-8');
    await writeFile(join(docs, 'agents.md'), 'documentation instructions', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, leaf);

    expect(result).toContain('root instructions');
    expect(result).not.toContain('packages instructions');
    expect(result).not.toContain('leaf instructions');
    expect(result).not.toContain('documentation instructions');
  });

  it('does not inject instructions above the workspace root', async () => {
    const ancestor = await mkdtemp(join(tmpdir(), 'kimi-agents-ancestor-'));
    extraDirs.push(ancestor);
    const projectRoot = join(ancestor, 'project');
    const leaf = join(projectRoot, 'src');
    await mkdir(join(projectRoot, '.git'), { recursive: true });
    await mkdir(leaf, { recursive: true });
    await writeFile(join(ancestor, 'AGENTS.md'), 'ancestor instructions', 'utf-8');
    await writeFile(join(projectRoot, 'AGENTS.md'), 'workspace instructions', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, leaf);

    expect(result).toContain('workspace instructions');
    expect(result).not.toContain('ancestor instructions');
  });
});

describe('loadAgentsMd oversized content', () => {
  it('keeps the full content when AGENTS.md exceeds the recommended size', async () => {
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain(largeContent);
    expect(result).not.toContain('truncated or omitted');
  });
});

describe('prepareSystemPromptContext AGENTS.md size warning', () => {
  it('returns agentsMdWarning and keeps full content when oversized', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome);

    expect(result.agentsMd).toContain(largeContent);
    expect(result.agentsMdWarning).toBeDefined();
    expect(result.agentsMdWarning).toContain('exceeds the recommended');
  });

  it('does not return agentsMdWarning when within the recommended size', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome);

    expect(result.agentsMdWarning).toBeUndefined();
  });
});

describe('prepareSystemPromptContext additional directories', () => {
  it('includes additional directory listings without loading their AGENTS.md', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-empty-brand-'));
    extraDirs.push(brandHome);
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-'));
    extraDirs.push(extraDir);

    await writeFile(join(workDir, 'AGENTS.md'), 'repo project instructions', 'utf-8');
    await writeFile(join(extraDir, 'AGENTS.md'), 'extra project instructions', 'utf-8');
    await writeFile(join(extraDir, 'extra-file.txt'), 'extra listing entry', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome, {
      additionalDirs: [extraDir],
    });

    const agentsMd = result.agentsMd ?? '';

    expect(result.cwdListing).toBeTypeOf('string');
    expect(result.additionalDirsInfo).toContain(`### ${extraDir}`);
    expect(result.additionalDirsInfo).toContain('extra-file.txt');
    expect(agentsMd).toContain('repo project instructions');
    expect(agentsMd).not.toContain('extra project instructions');
    expect(agentsMd.split('<!-- From:').length - 1).toBe(1);
  });

  it('loads user-level AGENTS.md once and skips additional directory AGENTS.md', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-empty-brand-'));
    extraDirs.push(brandHome);
    const extraDirA = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-a-'));
    const extraDirB = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-b-'));
    extraDirs.push(extraDirA, extraDirB);

    await writeFile(join(brandHome, 'AGENTS.md'), 'shared user instructions', 'utf-8');
    await writeFile(join(extraDirA, 'AGENTS.md'), 'extra A instructions', 'utf-8');
    await writeFile(join(extraDirB, 'AGENTS.md'), 'extra B instructions', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome, {
      additionalDirs: [extraDirA, extraDirB],
    });

    const agentsMd = result.agentsMd ?? '';

    expect(result.additionalDirsInfo).toContain(`### ${extraDirA}`);
    expect(result.additionalDirsInfo).toContain(`### ${extraDirB}`);
    expect(agentsMd.split('shared user instructions').length - 1).toBe(1);
    expect(agentsMd).not.toContain('extra A instructions');
    expect(agentsMd).not.toContain('extra B instructions');
  });
});

describe('loadAgentsMdDetailed discovered paths', () => {
  it('recovers AGENTS.md source annotations without treating plugin annotations as files', () => {
    expect(
      extractAgentsMdPathsFromSystemPrompt(
        '<!-- From: /repo/AGENTS.md -->\nroot\n\n<!-- From: plugin example -->\nplugin',
      ),
    ).toEqual(['/repo/AGENTS.md']);
  });

  it('returns the normalized paths of every injected file in collection order', async () => {
    await mkdir(join(homeDir, '.kiki'), { recursive: true });
    await writeFile(join(homeDir, '.kiki', 'AGENTS.md'), 'user branded', 'utf-8');
    await mkdir(join(workDir, '.kiki'), { recursive: true });
    await writeFile(join(workDir, '.kiki', 'AGENTS.md'), 'dot kiki', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir);

    expect(result.paths).toEqual([
      normalize(join(workDir, '.kiki', 'AGENTS.md')),
      normalize(join(workDir, 'AGENTS.md')),
    ]);
  });

  it('prefers AGENTS.md over agents.md within one directory', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'upper', 'utf-8');
    await writeFile(join(workDir, 'agents.md'), 'lower', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir);

    expect(result.paths).toEqual([normalize(join(workDir, 'AGENTS.md'))]);
  });

  it('exposes the same paths through prepareSystemPromptContext', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);

    expect(result.agentsMdPaths).toEqual([normalize(join(workDir, 'AGENTS.md'))]);
  });
});
