import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CognitionFileError,
  applyOverlay,
  applyOverlayAppend,
  readCognitionSlot,
  readCognitionFiles,
  readCognitionContent,
  resolveCognitionPath,
} from '#/agent/cognition/cognitionFiles';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { createTestTempDir } from '../../helpers/temp';

describe('cognition file paths', () => {
  const pathClass = process.platform === 'win32' ? 'win32' : 'posix';
  let homeDir: string;
  const extraDirs: string[] = [];
  const fs = new HostFileSystem();

  beforeEach(async () => {
    homeDir = await createTestTempDir();
  });

  afterEach(async () => {
    await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function linkDirectory(target: string, destination: string): Promise<void> {
    try {
      await symlink(target, destination, 'dir');
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await symlink(target, destination, 'junction');
    }
  }

  it('resolves a relative path under the Kiki home', () => {
    const resolved = resolveCognitionPath(homeDir, 'cognition/overlay.md', pathClass);
    expect(resolved).toBe(join(homeDir, 'cognition/overlay.md'));
  });

  it('rejects absolute paths and home escapes', () => {
    expect(() => resolveCognitionPath(homeDir, '/tmp/outside.md', pathClass, 'overlay')).toThrow(
      CognitionFileError,
    );
    expect(() => resolveCognitionPath(homeDir, '../escape.md', pathClass, 'steering')).toThrow(
      CognitionFileError,
    );
  });

  it('loads declared files and joins them in order', async () => {
    await mkdir(join(homeDir, 'cognition'));
    await writeFile(join(homeDir, 'cognition/a.md'), 'alpha\n');
    await writeFile(join(homeDir, 'cognition/b.md'), 'beta\n');
    await expect(
      readCognitionSlot(fs, homeDir, 'overlay', ['cognition/a.md', 'cognition/b.md'], pathClass),
    ).resolves.toBe('alpha\n\nbeta');
  });

  it('fails closed when a declared file is missing', async () => {
    await expect(
      readCognitionSlot(fs, homeDir, 'steering', ['cognition/missing.md'], pathClass),
    ).rejects.toMatchObject({ reason: 'missing', slot: 'steering' });
  });

  it('reads complete author files without trimming and bounds the editor read', async () => {
    const text = '  author\n完整正文\n';
    await writeFile(join(homeDir, 'author.md'), text);
    expect(await readCognitionFiles(fs, homeDir, 'overlay', ['author.md'], pathClass, 1024)).toEqual([{ path: 'author.md', text }]);
    await expect(readCognitionFiles(fs, homeDir, 'overlay', ['author.md'], pathClass, 4)).rejects.toThrow('editor limit');
    await expect(readCognitionContent(fs, homeDir, 'overlay', { text }, pathClass)).resolves.toBe(text);
    await expect(readCognitionContent(fs, homeDir, 'overlay', { text: '' }, pathClass)).resolves.toBeUndefined();
  });

  it('reads cognition files when Kiki home is reached through a directory link', async () => {
    const text = 'linked cognition';
    await writeFile(join(homeDir, 'author.md'), text);
    const aliasParent = await createTestTempDir();
    extraDirs.push(aliasParent);
    const linkedHomeDir = join(aliasParent, 'home');
    await linkDirectory(homeDir, linkedHomeDir);

    await expect(readCognitionFiles(fs, linkedHomeDir, 'overlay', ['author.md'], pathClass)).resolves.toEqual([
      { path: 'author.md', text },
    ]);
  });

  it('rejects cognition file links that resolve outside Kiki home', async () => {
    const outsideDir = await createTestTempDir();
    extraDirs.push(outsideDir);
    await writeFile(join(outsideDir, 'outside.md'), 'outside');
    let ref = 'escape.md';
    try {
      await symlink(join(outsideDir, 'outside.md'), join(homeDir, ref), 'file');
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await linkDirectory(outsideDir, join(homeDir, 'escape'));
      ref = 'escape/outside.md';
    }

    await expect(readCognitionFiles(fs, homeDir, 'overlay', [ref], pathClass)).rejects.toMatchObject({ reason: 'escape' });
  });

  it('appends overlay after the profile prompt', () => {
    expect(applyOverlayAppend('base', 'overlay')).toBe('base\n\noverlay');
    expect(applyOverlayAppend('base', undefined)).toBe('base');
  });

  it('prepends overlay before the profile prompt', () => {
    expect(applyOverlay('base', 'overlay', 'prepend')).toBe('overlay\n\nbase');
    expect(applyOverlay('base', undefined, 'prepend')).toBe('base');
  });

  it('wraps the profile between overlay and a closer', () => {
    const wrapped = applyOverlay('base', 'overlay', 'wrap');
    expect(wrapped.startsWith('overlay\n\nbase\n\n')).toBe(true);
    expect(wrapped).toContain('End of assignment');
  });

  it('substitutes ${profile_prompt} in wrap overlays and does not eat ${base_prompt}', () => {
    expect(applyOverlay('BASE', 'before ${profile_prompt} after', 'wrap')).toBe(
      'before BASE after',
    );
    expect(applyOverlay('BASE', 'keep ${base_prompt}', 'wrap')).toBe(
      'keep ${base_prompt}\n\nBASE\n\nEnd of assignment. Resume the thinking protocol above; it still governs reasoning.',
    );
  });

  it('replaces a leading You-are paragraph in persona mode', () => {
    const base = 'You are the frontend subagent.\n\n## Authority\nOwn the slice.';
    expect(applyOverlay(base, 'You are a helpful software engineer assistant.', 'persona')).toBe(
      'You are a helpful software engineer assistant.\n\n## Authority\nOwn the slice.',
    );
  });

  it('replaces the whole profile in replace mode', () => {
    expect(applyOverlay('You are the frontend subagent.\n\n## Authority', 'A1', 'replace')).toBe(
      'A1',
    );
  });
});
