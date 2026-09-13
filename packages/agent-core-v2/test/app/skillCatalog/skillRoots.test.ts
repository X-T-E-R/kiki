import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configuredRoots, projectRoots, userRoots } from '#/app/skillCatalog/skillRoots';

describe('skillRoots', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-roots-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function markGitRoot(dir: string = root): Promise<void> {
    await mkdir(join(dir, '.git'), { recursive: true });
  }

  describe('projectRoots', () => {
    it('resolves the brand .kiki/skills directory at the .git root', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kiki/skills/commit'), { recursive: true });

      const roots = await projectRoots(root);

      expect(roots.some((r) => r.path.endsWith('.kiki/skills') && r.source === 'project')).toBe(
        true,
      );
    });

    it('falls back to the generic .agents/skills directory', async () => {
      await markGitRoot();
      await mkdir(join(root, '.agents/skills/review'), { recursive: true });

      const roots = await projectRoots(root);

      expect(roots.some((r) => r.path.endsWith('.agents/skills') && r.source === 'project')).toBe(
        true,
      );
      expect(roots.some((r) => r.path.endsWith('.kiki/skills'))).toBe(false);
    });

    it('walks up from a child directory to the .git root', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kiki/skills/commit'), { recursive: true });
      const child = join(root, 'src/pkg');
      await mkdir(child, { recursive: true });

      const roots = await projectRoots(child);

      expect(roots.some((r) => r.path.endsWith('.kiki/skills'))).toBe(true);
    });

    it('orders the brand directory before the generic directory', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kiki/skills'), { recursive: true });
      await mkdir(join(root, '.agents/skills'), { recursive: true });

      const roots = await projectRoots(root);
      const brandIdx = roots.findIndex((r) => r.path.endsWith('.kiki/skills'));
      const genericIdx = roots.findIndex((r) => r.path.endsWith('.agents/skills'));

      expect(brandIdx).toBeGreaterThanOrEqual(0);
      expect(genericIdx).toBeGreaterThan(brandIdx);
    });
  });

  describe('userRoots', () => {
    it('resolves the brand skills directory under homeDir', async () => {
      await mkdir(join(root, 'skills/notes'), { recursive: true });

      const roots = await userRoots(root, root);

      expect(roots.some((r) => r.path.endsWith('/skills') && r.source === 'user')).toBe(true);
    });

    it('falls back to the generic .agents/skills under osHomeDir', async () => {
      const homeDir = join(root, 'brand-home');
      const osHomeDir = join(root, 'os-home');
      await mkdir(homeDir, { recursive: true });
      await mkdir(join(osHomeDir, '.agents/skills/notes'), { recursive: true });

      const roots = await userRoots(homeDir, osHomeDir);

      expect(roots.some((r) => r.path.endsWith('.agents/skills') && r.source === 'user')).toBe(
        true,
      );
    });
  });

  it('adds user and project command roots independently of skill merge settings', async () => {
    await markGitRoot();
    for (const dir of ['commands', 'skills', '.kiki/commands', '.kimi-code/commands', '.kiki/skills']) {
      await mkdir(join(root, dir), { recursive: true });
    }
    expect((await userRoots(root, root, { mergeAllAvailableSkills: false }))
      .find((entry) => entry.path.endsWith('/commands'))).toMatchObject({ source: 'user', scanMode: 'commands' });
    const project = await projectRoots(root);
    expect(project.filter((entry) => entry.scanMode === 'commands').map((entry) => entry.path))
      .toEqual([join(root, '.kiki/commands')]);
    expect((await projectRoots(root, { mergeAllAvailableSkills: false }))
      .filter((entry) => entry.scanMode === 'commands')).toHaveLength(1);
  });

  describe('configuredRoots', () => {
    it('resolves ~, ~/, absolute, and project-relative paths', async () => {
      await markGitRoot();
      const homeDir = join(root, 'home');
      const absDir = join(root, 'abs');
      await mkdir(homeDir, { recursive: true });
      await mkdir(join(homeDir, 'notes'), { recursive: true });
      await mkdir(absDir, { recursive: true });
      await mkdir(join(root, 'relative'), { recursive: true });

      const roots = await configuredRoots(['~', '~/notes', absDir, 'relative'], root, homeDir, 'extra');
      const paths = roots.map((root) => root.path);

      expect(roots.every((root) => root.source === 'extra')).toBe(true);
      expect(paths).toContain((await realpath(homeDir)).replaceAll('\\', '/'));
      expect(paths).toContain((await realpath(join(homeDir, 'notes'))).replaceAll('\\', '/'));
      expect(paths).toContain((await realpath(absDir)).replaceAll('\\', '/'));
      expect(paths).toContain((await realpath(join(root, 'relative'))).replaceAll('\\', '/'));
    });
  });
});
