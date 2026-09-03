import { symlink } from 'node:fs/promises';

export const windowsSymlinksUnavailable = process.platform === 'win32';

export async function symlinkDir(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
