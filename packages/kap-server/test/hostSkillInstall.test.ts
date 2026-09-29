import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostSkillInstallConflict, installHostSkill, previewHostSkill } from '../src/routes/hostSkillInstall';

const CONTENT = '---\nname: kiki-as-subagent\ndescription: Example\n---\n\nDelegate safely.\n';

describe('explicit global host skill installation', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'kiki-host-skill-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('previews without writing, then installs only with the confirmed revision', async () => {
    const preview = await previewHostSkill('agents', CONTENT, home);
    expect(preview).toMatchObject({ host: 'agents', overwrites: false, directory: join(home, '.agents', 'skills') });
    await expect(readFile(preview.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const installed = await installHostSkill('agents', CONTENT, preview.revision, home);
    expect(installed.path).toBe(preview.path);
    expect(await readFile(preview.path, 'utf8')).toBe(CONTENT);
    await expect(installHostSkill('agents', CONTENT, preview.revision, home)).rejects.toBeInstanceOf(HostSkillInstallConflict);
  });

  it('reports overwrite, preserves the old file if confirmation has become stale', async () => {
    const original = await previewHostSkill('claude', CONTENT, home);
    await installHostSkill('claude', CONTENT, original.revision, home);
    const overwriting = await previewHostSkill('claude', 'new content', home);
    expect(overwriting.overwrites).toBe(true);
    await writeFile(original.path, 'user edited');
    await expect(installHostSkill('claude', 'new content', overwriting.revision, home)).rejects.toBeInstanceOf(HostSkillInstallConflict);
    expect(await readFile(original.path, 'utf8')).toBe('user edited');
  });

  it('refuses a junction skill directory before preview or write', async () => {
    const elsewhere = join(home, 'elsewhere');
    await mkdir(elsewhere);
    await mkdir(join(home, '.codex', 'skills'), { recursive: true });
    await symlink(elsewhere, join(home, '.codex', 'skills', 'kiki-as-subagent'), 'junction');
    await expect(previewHostSkill('codex', CONTENT, home)).rejects.toBeInstanceOf(HostSkillInstallConflict);
  });
});
