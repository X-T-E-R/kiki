import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { symlinkDir, windowsSymlinksUnavailable } from '../../_base/utils/symlink';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  agentsMdWatchRoots,
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
  it('loads applicable ancestors without scanning unrelated subtrees', async () => {
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
    expect(result).toContain('packages instructions');
    expect(result).toContain('leaf instructions');
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

describe('loadAgentsMd space inheritance', () => {
  it('falls back to the base home file when this home has none', async () => {
    const baseBrandHome = join(homeDir, 'main-home');
    const brandHome = join(homeDir, 'space-home');
    await mkdir(baseBrandHome, { recursive: true });
    await mkdir(brandHome, { recursive: true });
    await writeFile(join(baseBrandHome, 'AGENTS.md'), 'base instructions', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir, brandHome, {
      inheritance: { baseHomeDir: baseBrandHome, instructions: true },
    });

    expect(result.content).toContain('base instructions');
    expect(result.paths).toEqual([normalize(join(baseBrandHome, 'AGENTS.md'))]);
  });

  it('replaces the base home file when this home has one', async () => {
    const baseBrandHome = join(homeDir, 'main-home');
    const brandHome = join(homeDir, 'space-home');
    await mkdir(baseBrandHome, { recursive: true });
    await mkdir(brandHome, { recursive: true });
    await writeFile(join(baseBrandHome, 'AGENTS.md'), 'base instructions', 'utf-8');
    await writeFile(join(brandHome, 'AGENTS.md'), 'space instructions', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir, brandHome, {
      inheritance: { baseHomeDir: baseBrandHome, instructions: true },
    });

    expect(result.content).toContain('space instructions');
    expect(result.content).not.toContain('base instructions');
  });

  it('stacks base, home, then workspace files in instructions="stack"', async () => {
    const baseBrandHome = join(homeDir, 'main-home');
    const brandHome = join(homeDir, 'space-home');
    await mkdir(baseBrandHome, { recursive: true });
    await mkdir(brandHome, { recursive: true });
    await writeFile(join(baseBrandHome, 'AGENTS.md'), 'base instructions', 'utf-8');
    await writeFile(join(brandHome, 'AGENTS.md'), 'space instructions', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'workspace instructions', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir, brandHome, {
      inheritance: { baseHomeDir: baseBrandHome, instructions: 'stack' },
    });

    expect(result.content.indexOf('base instructions')).toBeLessThan(
      result.content.indexOf('space instructions'),
    );
    expect(result.content.indexOf('space instructions')).toBeLessThan(
      result.content.indexOf('workspace instructions'),
    );
  });

  it('keeps the workspace .kiki override suppressing both user layers', async () => {
    const baseBrandHome = join(homeDir, 'main-home');
    const brandHome = join(homeDir, 'space-home');
    await mkdir(baseBrandHome, { recursive: true });
    await mkdir(brandHome, { recursive: true });
    await mkdir(join(workDir, '.kiki'), { recursive: true });
    await writeFile(join(baseBrandHome, 'AGENTS.md'), 'base instructions', 'utf-8');
    await writeFile(join(brandHome, 'AGENTS.md'), 'space instructions', 'utf-8');
    await writeFile(join(workDir, '.kiki', 'AGENTS.md'), 'workspace override', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir, brandHome, {
      inheritance: { baseHomeDir: baseBrandHome, instructions: 'stack' },
    });

    expect(result.content).toContain('workspace override');
    expect(result.content).not.toContain('base instructions');
    expect(result.content).not.toContain('space instructions');
  });

  it('ignores the base home file when instructions is false', async () => {
    const baseBrandHome = join(homeDir, 'main-home');
    const brandHome = join(homeDir, 'space-home');
    await mkdir(baseBrandHome, { recursive: true });
    await mkdir(brandHome, { recursive: true });
    await writeFile(join(baseBrandHome, 'AGENTS.md'), 'base instructions', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir, brandHome, {
      inheritance: { baseHomeDir: baseBrandHome, instructions: false },
    });

    expect(result.content).not.toContain('base instructions');
    expect(result.paths).toEqual([]);
  });

  it('watches the base home file when instructions inheritance is on', async () => {
    const baseBrandHome = join(homeDir, 'main-home');
    const brandHome = join(homeDir, 'space-home');

    const roots = await agentsMdWatchRoots({ fs, homeDir }, workDir, brandHome, {
      inheritance: { baseHomeDir: baseBrandHome, instructions: true },
    });
    const paths = roots.flatMap((entry) => entry.candidates);

    expect(paths).toContain(join(baseBrandHome, 'AGENTS.md'));

    const disabled = await agentsMdWatchRoots({ fs, homeDir }, workDir, brandHome, {
      inheritance: { baseHomeDir: baseBrandHome, instructions: false },
    });
    expect(disabled.flatMap((entry) => entry.candidates)).not.toContain(
      join(baseBrandHome, 'AGENTS.md'),
    );
  });
});


describe('stable dynamic prefix layout', () => {
  it('keeps the rendered system hash stable while runtime, memory and catalogs change', async () => {
    const { stablePromptContext, promptSectionHash, dynamicPromptContent } = await import('#/agent/profile/dynamicPrompt');
    const { renderSystemPromptResult } = await import('@kiki/agent-profiles/profileShared');
    const first = { cwd: '/workspace/a', cwdListing: 'first directory', additionalDirsInfo: 'extra-a', agentsMd: 'rule A',
      memory: 'memory A', skills: 'skill A', pluginSections: 'plugin A', now: '2026-01-01T01:00:00.000Z', timeZone: 'UTC', osKind: 'Linux' };
    const second = { ...first, cwd: '/workspace/b', cwdListing: 'second directory', additionalDirsInfo: 'extra-b', agentsMd: 'rule B',
      memory: 'memory B', skills: 'skill B', pluginSections: 'plugin B', now: '2026-01-02T01:00:00.000Z' };
    const render = (context: typeof first) => renderSystemPromptResult('', stablePromptContext(context), { skillActive: true }).text;
    expect(promptSectionHash(render(first))).toBe(promptSectionHash(render(second)));
    expect(render(first)).not.toContain('first directory');
    expect(dynamicPromptContent(first)).not.toBe(dynamicPromptContent(second));
    expect(dynamicPromptContent(first)).not.toContain('01:00:00.000Z');
  });
  it('freezes legacy environment without freezing a changed policy', async () => {
    const { legacyEnvironmentContext } = await import('#/agent/profile/dynamicPrompt');
    const first = { cwd: '/workspace/a', cwdListing: 'first directory', now: '2026-01-01T01:00:00.000Z', agentsMd: 'rule A' };
    const second = { cwd: '/workspace/b', cwdListing: 'second directory', now: '2026-01-02T01:00:00.000Z', agentsMd: 'rule B' };
    expect(legacyEnvironmentContext(second, '', first)).toEqual({ ...second, cwd: first.cwd, cwdListing: first.cwdListing, now: first.now, timeZone: undefined, additionalDirsInfo: undefined });
  });
});

describe('sampled directory and stable template boundaries', () => {
  it('samples one directory level up to 20 entries while retaining complete instruction text', async () => {
    await mkdir(join(workDir, 'source'), { recursive: true });
    await writeFile(join(workDir, 'source', 'not-expanded.ts'), 'nested');
    const rule = 'Complete instruction, including its applicability and exception.\n'.repeat(100);
    await writeFile(join(workDir, 'AGENTS.md'), rule);
    await Promise.all(Array.from({ length: 25 }, (_, i) => writeFile(join(workDir, `entry-${String(i).padStart(2, '0')}.txt`), 'entry')));
    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);
    expect(result.cwdListing).toContain('source/');
    expect(result.cwdListing).not.toContain('not-expanded.ts');
    expect(result.cwdListing).toContain('more entries; use Glob to explore');
    expect(result.cwdListing!.split('\n').filter((line) => /[├└]──/.test(line)).length).toBeLessThanOrEqual(21);
    expect(result.agentsMd).toContain(rule.trim());
    expect(result.agentsMdFiles).toMatchObject([{ path: normalize(await fs.realpath(join(workDir, 'AGENTS.md'))), scope: workDir, runtimeId: 'local' }]);
  });
  it('reuses directory samples without filesystem reads while instructions change', async () => {
    const { vi } = await import('vitest');
    const reads = vi.spyOn(fs, 'readdir');
    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, undefined, {
      cwdListing: 'sampled tree', additionalDirsInfo: '',
      preloadedAgentsMd: { content: 'updated instructions', paths: [], warning: undefined },
    });
    expect(reads).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cwdListing: 'sampled tree', agentsMd: 'updated instructions', additionalDirsInfo: '' });
    reads.mockRestore();
  });
  it('renders the full SYSTEM with runtime references and no empty fences', async () => {
    const { stablePromptContext, legacyEnvironmentContext } = await import('#/agent/profile/dynamicPrompt');
    const { renderSystemPromptResult } = await import('@kiki/agent-profiles/profileShared');
    const context = { osKind: 'Windows', shellName: 'bash', shellPath: '/bin/bash', now: '2026-01-01T00:00:00.000Z', cwd: '/example', cwdListing: 'private-tree', agentsMd: 'private-instructions', skills: 'private-skills', memory: 'private-memory', pluginSections: 'private-plugins', skillActive: true };
    const text = renderSystemPromptResult('', stablePromptContext(context), { skillActive: true }).text;
    expect(text).toContain('Session time reference: `See the versioned runtime snapshot in messages.`');
    expect(text).toContain('Working-directory reference: `See runtime snapshot`');
    expect(text).toContain('Directory tree is sampled at session start');
    expect(text).not.toMatch(/(`{3,})\n\s*\n\1/);
    expect(text).not.toContain('${');
    expect(text).not.toContain('private-');
    expect(legacyEnvironmentContext(context, 'memory time 1999-01-01T00:00:00.000Z\n## Date and Time\nSession time reference: `2025-01-01T00:00:00.000Z`\n## Working Directory\nother')).toMatchObject({ now: '2025-01-01T00:00:00.000Z' });
    expect(legacyEnvironmentContext(context, '## Date and Time\nNo timestamp\n# Project Information\nmemory time 1999-01-01T00:00:00.000Z').now).toBe(context.now);
  });
});
