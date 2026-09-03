import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalWorkspaceRoot,
  isWorkspaceTrusted,
  trustWorkspace,
  workspaceTrustKey,
} from '#/tui/daemon/workspace-trust';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('daemon workspace trust', () => {
  it('uses the engine-compatible canonical key for Windows workspace roots', () => {
    const canonical = canonicalWorkspaceRoot('C:\\Repo\\Project\\');
    expect(canonical).toBe('c:/repo/project');
    expect(workspaceTrustKey(canonical)).toMatch(/^wd_project_[0-9a-f]{12}$/u);
  });

  it('persists trust under the daemon home before startup', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tui-trust-'));
    tempDirs.push(homeDir);

    await expect(isWorkspaceTrusted(homeDir, 'C:\\Repo\\Project')).resolves.toBe(false);
    await trustWorkspace(homeDir, 'C:\\Repo\\Project');
    await expect(isWorkspaceTrusted(homeDir, 'c:/repo/project/')).resolves.toBe(true);
  });
});
