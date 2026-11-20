import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  encodeWorkDirKey,
  normalizeGitRemoteUrl,
  resolveProjectIdentity,
} from '#/_base/utils/workdir-slug';
import { MemoryScopes } from '#/app/memory/memoryScopes';
import { MemoryStore } from '#/app/memory/memoryStore';
import {
  filterMemoriesForHost,
  filterMemoriesForSync,
} from '#/app/memory/projectIdentityBindings';
import { discoverFileSkills } from '#/app/skillCatalog/fileSkillDiscovery';
import { detectSkillRootTransport, planSkillSync } from '#/app/skillCatalog/skillSyncTransport';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.test',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.test',
    },
  }).trim();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('cross-machine project identity, memory portability, and git-aware skill sync', () => {
  it('resolves identical project_id across two real git worktrees and SSH/HTTPS remotes, plus explicit override and path fallback', async () => {
    expect(normalizeGitRemoteUrl('git@github.com:Example-Org/Demo-Repo.git')).toBe(
      'github.com/example-org/demo-repo',
    );
    expect(normalizeGitRemoteUrl('https://github.com/Example-Org/Demo-Repo.git')).toBe(
      'github.com/example-org/demo-repo',
    );
    expect(normalizeGitRemoteUrl('ssh://git@github.com:22/Example-Org/Demo-Repo/')).toBe(
      'github.com/example-org/demo-repo',
    );

    const sandbox = makeTempDir('kiki-proj-id-');
    const mainRepo = join(sandbox, 'main-checkout');
    const wtAlpha = join(sandbox, 'wt-alpha');
    const wtBeta = join(sandbox, 'wt-beta');
    const cloneHttps = join(sandbox, 'other-machine-clone');
    const plainDir = join(sandbox, 'plain-folder');

    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(plainDir, { recursive: true });

    runGit(mainRepo, ['init']);
    writeFileSync(join(mainRepo, 'README.md'), '# Sample\n', 'utf8');
    runGit(mainRepo, ['add', 'README.md']);
    runGit(mainRepo, ['commit', '-m', 'initial commit']);
    runGit(mainRepo, ['remote', 'add', 'origin', 'git@github.com:Example-Org/Demo-Repo.git']);

    runGit(mainRepo, ['worktree', 'add', '-b', 'feat-alpha', wtAlpha]);
    runGit(mainRepo, ['worktree', 'add', '-b', 'feat-beta', wtBeta]);

    runGit(sandbox, ['clone', mainRepo, cloneHttps]);
    runGit(cloneHttps, ['remote', 'set-url', 'origin', 'https://github.com/Example-Org/Demo-Repo.git']);

    const idMain = await resolveProjectIdentity(mainRepo);
    const idAlpha = await resolveProjectIdentity(wtAlpha);
    const idBeta = await resolveProjectIdentity(wtBeta);
    const idClone = await resolveProjectIdentity(cloneHttps);

    expect(idMain.source).toBe('git');
    expect(idMain.projectId).toMatch(/^prj_demo-repo_[0-9a-f]{12}$/);
    expect(idAlpha.projectId).toBe(idMain.projectId);
    expect(idBeta.projectId).toBe(idMain.projectId);
    expect(idClone.projectId).toBe(idMain.projectId);
    expect(idAlpha.workDirKey).not.toBe(idBeta.workDirKey);

    mkdirSync(join(wtAlpha, '.kiki'), { recursive: true });
    writeFileSync(
      join(wtAlpha, '.kiki', 'project.json'),
      JSON.stringify({ project_id: 'custom-explicit-proj' }),
      'utf8',
    );
    const idExplicit = await resolveProjectIdentity(wtAlpha);
    expect(idExplicit.source).toBe('explicit');
    expect(idExplicit.projectId).toBe('prj_custom-explicit-proj');

    const idPlain = await resolveProjectIdentity(plainDir);
    expect(idPlain.source).toBe('path_fallback');
    expect(idPlain.projectId).toBe(encodeWorkDirKey(plainDir));
  }, 30_000);

  it('shares portable project memories across two git worktrees while isolating applicability="machine-local" entries to originating host', async () => {
    const sandbox = makeTempDir('kiki-mem-port-');
    const homeDir = join(sandbox, 'home');
    const mainRepo = join(sandbox, 'repo');
    const wtA = join(sandbox, 'wt-a');
    const wtB = join(sandbox, 'wt-b');

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(mainRepo, { recursive: true });

    runGit(mainRepo, ['init']);
    writeFileSync(join(mainRepo, 'index.ts'), 'export const ok = true;\n', 'utf8');
    runGit(mainRepo, ['add', 'index.ts']);
    runGit(mainRepo, ['commit', '-m', 'init']);
    runGit(mainRepo, ['remote', 'add', 'origin', 'https://github.com/example-org/memory-repo.git']);
    runGit(mainRepo, ['worktree', 'add', '-b', 'branch-a', wtA]);
    runGit(mainRepo, ['worktree', 'add', '-b', 'branch-b', wtB]);

    const storage = new FileStorageService(homeDir, 0o700, 0o600, true);
    const emptyWorkspaces: IWorkspacePersistence = {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => undefined }),
      load: async () => ({ workspaces: [], deletedIds: [] }),
      save: async () => undefined,
    };

    const scopes = new MemoryScopes(emptyWorkspaces, storage);
    const store = new MemoryStore(storage, scopes);

    const boundA = await scopes.bindWorkspace(wtA, { hostId: 'host-alpha' });
    const boundB = await scopes.bindWorkspace(wtB, { hostId: 'host-beta' });
    expect(boundA.projectId).toBe(boundB.projectId);

    const wdA = encodeWorkDirKey(wtA);
    const wdB = encodeWorkDirKey(wtB);
    expect(wdA).not.toBe(wdB);

    await store.put({
      action: 'create',
      scope: { kind: 'workspace', workspaceId: wdA },
      type: 'project',
      title: 'Shared API Architecture',
      body: 'All endpoints use versioned envelopes.',
      reason: 'Recorded architecture decision',
      source: { writer: 'user' },
      applicability: 'portable',
      origin_host_id: 'host-alpha',
    });

    await store.put({
      action: 'create',
      scope: { kind: 'workspace', workspaceId: wdA },
      type: 'reference',
      title: 'Local CUDA Driver Quirk',
      body: 'Only applies to local workstation GPU slot 0.',
      reason: 'Host-specific hardware note',
      source: { writer: 'user' },
      applicability: 'machine-local',
      origin_host_id: 'host-alpha',
    });

    const listedFromWorktreeB = await store.list({ kind: 'workspace', workspaceId: wdB });
    expect(listedFromWorktreeB).toHaveLength(2);

    const syncable = filterMemoriesForSync(listedFromWorktreeB);
    expect(syncable.map((entry) => entry.title)).toEqual(['Shared API Architecture']);

    const visibleOnAlpha = filterMemoriesForHost(listedFromWorktreeB, 'host-alpha');
    expect(visibleOnAlpha).toHaveLength(2);

    const visibleOnBeta = filterMemoriesForHost(listedFromWorktreeB, 'host-beta');
    expect(visibleOnBeta.map((entry) => entry.title)).toEqual(['Shared API Architecture']);
  }, 30_000);

  it('detects git-backed skill roots and ignores .sync-conflict-* quarantine artifacts in skill discovery', async () => {
    const sandbox = makeTempDir('kiki-skill-sync-');
    const gitSkillsDir = join(sandbox, 'agents-skills');
    const plainSkillsDir = join(sandbox, 'plain-skills');

    mkdirSync(join(gitSkillsDir, 'real-skill'), { recursive: true });
    mkdirSync(join(gitSkillsDir, 'real-skill.sync-conflict-20261120-091500'), { recursive: true });
    mkdirSync(join(gitSkillsDir, '.sync-conflict-20261120-091500'), { recursive: true });
    mkdirSync(join(plainSkillsDir, 'local-skill'), { recursive: true });

    const validSkillDoc = (name: string) =>
      `---\nname: ${name}\ndescription: Valid skill ${name}\n---\nInstructions for ${name}.\n`;

    writeFileSync(join(gitSkillsDir, 'real-skill', 'SKILL.md'), validSkillDoc('real-skill'), 'utf8');
    writeFileSync(
      join(gitSkillsDir, 'real-skill.sync-conflict-20261120-091500', 'SKILL.md'),
      validSkillDoc('conflict-dir-skill'),
      'utf8',
    );
    writeFileSync(
      join(gitSkillsDir, '.sync-conflict-20261120-091500', 'SKILL.md'),
      validSkillDoc('hidden-conflict-dir-skill'),
      'utf8',
    );
    writeFileSync(
      join(gitSkillsDir, 'notes.sync-conflict-20261120-091500.md'),
      validSkillDoc('conflict-flat-skill'),
      'utf8',
    );
    writeFileSync(join(plainSkillsDir, 'local-skill', 'SKILL.md'), validSkillDoc('local-skill'), 'utf8');

    runGit(gitSkillsDir, ['init']);
    runGit(gitSkillsDir, ['remote', 'add', 'origin', 'https://github.com/example-org/skills.git']);
    runGit(gitSkillsDir, ['add', 'real-skill/SKILL.md']);
    runGit(gitSkillsDir, ['commit', '-m', 'add real skill']);

    const gitTransport = await detectSkillRootTransport(gitSkillsDir);
    expect(gitTransport.transport).toBe('git');
    expect(gitTransport.remoteUrl).toBe('https://github.com/example-org/skills.git');

    const plainTransport = await detectSkillRootTransport(plainSkillsDir);
    expect(plainTransport.transport).toBe('file_tree');

    const plans = await planSkillSync([
      { path: gitSkillsDir, source: 'user' },
      { path: plainSkillsDir, source: 'user' },
    ]);
    expect(plans.map((p) => p.transport)).toEqual(['git', 'file_tree']);
    expect(plans[0]?.ignorePatterns).toContain('.sync-conflict-*');

    const discovered = await discoverFileSkills([
      { path: gitSkillsDir, source: 'user' },
      { path: plainSkillsDir, source: 'user' },
    ]);
    expect(discovered.skills.map((s) => s.name)).toEqual(['local-skill', 'real-skill']);
  }, 30_000);
});
