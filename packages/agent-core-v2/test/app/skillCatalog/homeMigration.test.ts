import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { migrateLegacyKikiConfiguration, migrateLegacyKikiProject } from '@kiki/oauth';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { userRoots } from '#/app/skillCatalog/skillRoots';
import { discoverFileSkills } from '#/app/skillCatalog/fileSkillDiscovery';
import { userAgentRoots } from '#/workspace/workspaceAgentProfileLoader/internal/agentRoots';
import { discoverAgentFiles } from '#/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { loadAgentsMd } from '#/agent/profile/context';
import { loadMcpServers } from '#/app/mcpConfig/configLoader';

it('migrates project MCP and instructions without changing standard root files or precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiki-project-surfaces-'));
  const project = join(root, 'project'); const home = join(root, 'home');
  const fs = new HostFileSystem();
  try {
    await mkdir(join(project, '.git'), { recursive: true });
    await mkdir(join(project, '.kimi-code'));
    await mkdir(home);
    const standardMcp = JSON.stringify({ mcpServers: { shared: { command: 'root-command' }, rootOnly: { command: 'root-only-command' } } });
    const scopedMcp = JSON.stringify({ mcpServers: { shared: { command: 'scoped-command' } } });
    await writeFile(join(project, '.mcp.json'), standardMcp);
    await writeFile(join(project, 'AGENTS.md'), 'Synthetic standard root instructions.');
    await writeFile(join(project, '.kimi-code', 'mcp.json'), scopedMcp);
    await writeFile(join(project, '.kimi-code', 'AGENTS.md'), 'Synthetic migrated scoped instructions.');
    expect((await loadMcpServers({ fs, cwd: project, homeDir: home }))['shared']).toMatchObject({ command: 'root-command' });
    const before = await loadAgentsMd({ fs, homeDir: home }, project, home);
    expect(before).toContain('Synthetic standard root instructions.');
    expect(before).not.toContain('Synthetic migrated scoped instructions.');
    expect(migrateLegacyKikiProject(project)).toMatchObject({ status: 'completed', copied: expect.arrayContaining(['mcp.json', 'AGENTS.md']) });
    const servers = await loadMcpServers({ fs, cwd: project, homeDir: home });
    expect(servers['shared']).toMatchObject({ command: 'scoped-command' });
    expect(servers['rootOnly']).toMatchObject({ command: 'root-only-command' });
    expect(await loadMcpServers({ fs, cwd: project, homeDir: home, includeProject: false })).toEqual({});
    const instructions = await loadAgentsMd({ fs, homeDir: home }, project, home);
    expect(instructions).toContain('Synthetic standard root instructions.');
    expect(instructions).toContain('Synthetic migrated scoped instructions.');
    expect(await readFile(join(project, '.mcp.json'), 'utf8')).toBe(standardMcp);
    expect(await readFile(join(project, '.kimi-code', 'mcp.json'), 'utf8')).toBe(scopedMcp);
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe('Synthetic standard root instructions.');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

it('uses the migrated project config in the daemon core without falling back after deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiki-core-project-'));
  const fs = new HostFileSystem();
  try {
    await mkdir(join(root, '.git'));
    await mkdir(join(root, '.kimi-code'));
    await mkdir(join(root, 'shared'));
    await writeFile(join(root, '.kimi-code', 'local.toml'), '[workspace]\nadditional_dir = ["shared"]\n');
    const service = new FileProjectLocalConfigService({ osHomeDir: root } as IBootstrapService, fs);
    await expect(service.readAdditionalDirs(root)).rejects.toThrow('kiki migrate-config --workspace');
    expect(migrateLegacyKikiProject(root).status).toBe('completed');
    const loaded = await service.readAdditionalDirs(root);
    expect(loaded.configPath.replaceAll('\\', '/')).toBe(join(root, '.kiki', 'local.toml').replaceAll('\\', '/'));
    expect(loaded.additionalDirs.map((path) => path.replaceAll('\\', '/'))).toEqual([join(root, 'shared').replaceAll('\\', '/')]);
    await rm(loaded.configPath);
    expect((await service.readAdditionalDirs(root)).additionalDirs).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

it('keeps migrated user profiles, commands, skill resources, and SYSTEM references usable by real loaders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiki-assets-migrate-'));
  const oldHome = join(root, 'old'); const newHome = join(root, 'new'); const osHome = join(root, 'os');
  const write = async (file: string, content: string) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); };
  try {
    await write(join(oldHome, 'config.toml'), '# Synthetic config backed by authored home resources.\n');
    await write(join(oldHome, 'SYSTEM.md'), 'Synthetic old main prompt.');
    await write(join(newHome, 'SYSTEM.md'), 'Synthetic new main prompt wins.');
    await write(join(newHome, '.kiki-home-migration.json'), '{"version":1}');
    await write(join(oldHome, 'agents', 'lead.md'), '---\nname: lead\ndescription: Synthetic main profile\nmain: true\n---\nRead resources/guide.md before acting.');
    await write(join(oldHome, 'agents', 'resources', 'guide.md'), 'Synthetic profile resource.');
    await write(join(oldHome, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Synthetic review skill\n---\nRead references/checklist.txt.');
    await write(join(oldHome, 'skills', 'review', 'references', 'checklist.txt'), 'Synthetic skill resource.');
    await write(join(oldHome, 'commands', 'draft.md'), '---\ndescription: Synthetic draft command\n---\nDraft $ARGUMENTS without execution.');
    const before = await discoverFileSkills(await userRoots(newHome, osHome));
    expect(before.skills).toHaveLength(0);
    const result = migrateLegacyKikiConfiguration(oldHome, newHome);
    expect(result.status).toBe('completed');
    expect(result.preserved).toContain('SYSTEM.md');
    const skills = await discoverFileSkills(await userRoots(newHome, osHome));
    const review = skills.skills.find((entry) => entry.name === 'review');
    expect(review).toBeDefined();
    expect(await readFile(join(review!.dir, 'references', 'checklist.txt'), 'utf8')).toBe('Synthetic skill resource.');
    expect(skills.skills.find((entry) => entry.name === 'draft')?.metadata.promptCommand).toBe(true);
    const fs = new HostFileSystem();
    const profiles = await discoverAgentFiles(fs, await userAgentRoots(fs, newHome, osHome));
    const lead = profiles.agents.find((entry) => entry.name === 'lead');
    expect(lead?.main).toBe(true);
    expect(await readFile(join(dirname(lead!.path), 'resources', 'guide.md'), 'utf8')).toBe('Synthetic profile resource.');
    expect(await readFile(join(newHome, 'SYSTEM.md'), 'utf8')).toBe('Synthetic new main prompt wins.');
    expect(await readFile(join(oldHome, 'SYSTEM.md'), 'utf8')).toBe('Synthetic old main prompt.');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
