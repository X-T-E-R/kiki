import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { generateServerToken } from './persistentToken';
import { readPrivateFile, writePrivateFile } from './privateFiles';

export const LOCAL_OWNER_FILE = 'server.local-owner';
export async function readLocalOwnerToken(homeDir: string): Promise<string | undefined> {
  try { return (await readPrivateFile(join(homeDir, LOCAL_OWNER_FILE))).toString('utf8').trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function loadOrCreateLocalOwnerToken(homeDir: string): Promise<string> {
  const existing = await readLocalOwnerToken(homeDir);
  if (existing !== undefined) return existing;
  const token = generateServerToken();
  await writePrivateFile(join(homeDir, LOCAL_OWNER_FILE), token);
  return token;
}
export function matchesLocalOwner(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
