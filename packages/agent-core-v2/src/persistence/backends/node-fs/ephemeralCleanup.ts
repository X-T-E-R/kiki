import { readdir, rm } from 'node:fs/promises';
import { join } from 'pathe';

import { isSessionLockActive } from './fileLock';

export async function cleanupOrphanedEphemeralSessions(homeDir: string): Promise<number> {
  const root = join(homeDir, 'ephemeral');
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) continue;
    const workspaceDir = join(root, workspace.name);
    for (const session of await readdir(workspaceDir, { withFileTypes: true })) {
      if (!session.isDirectory() || session.isSymbolicLink()) continue;
      const scope = `ephemeral/${workspace.name}/${session.name}`;
      if (await isSessionLockActive(homeDir, scope)) continue;
      await rm(join(workspaceDir, session.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
