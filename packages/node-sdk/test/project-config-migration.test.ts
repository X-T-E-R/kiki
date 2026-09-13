import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { expect, it } from 'vitest';
import { LocalKaos } from '@kiki/kaos';
import { migrateLegacyKikiProject } from '@kiki/oauth';
import { loadWorkspaceLocalConfig } from '../src/config/workspace-local';

it('requires explicit project migration and then preserves canonical empty overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiki-project-config-'));
  const project = join(root, 'project'); const shared = join(root, 'shared');
  try {
    await mkdir(join(project, '.git'), { recursive: true }); await mkdir(shared);
    await mkdir(join(project, '.kimi-code'));
    const oldPath = join(project, '.kimi-code', 'local.toml');
    await writeFile(oldPath, '[workspace]\nadditional_dir = ["../shared"]\n');
    const kaos = (await LocalKaos.create()).withCwd(project);
    await expect(loadWorkspaceLocalConfig(kaos, project)).rejects.toThrow('kiki migrate-config --workspace');
    expect(migrateLegacyKikiProject(project).status).toBe('completed');
    const loaded = await loadWorkspaceLocalConfig(kaos, project);
    expect(loaded.configPath).toBe(join(project, '.kiki', 'local.toml'));
    expect(loaded.additionalDirs).toEqual([shared]);
    await writeFile(loaded.configPath, '[workspace]\nadditional_dir = []\n');
    expect((await loadWorkspaceLocalConfig(kaos, project)).additionalDirs).toEqual([]);
    expect(await readFile(oldPath, 'utf8')).toContain('../shared');
    await rm(loaded.configPath);
    expect((await loadWorkspaceLocalConfig(kaos, project)).additionalDirs).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
