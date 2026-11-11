import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getServerVersion } from '../version';
import { runtimeReleaseSchema, type RuntimeRelease } from './controller';

export const releaseIdSchema = z.string().regex(/^[0-9a-f]{24}-[0-9a-f]{24}$/);
const fileDigestSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive() });
const releaseManifestSchema = z.object({
  schemaVersion: z.literal(1), releaseId: releaseIdSchema, gitSha: z.string(), installedAt: z.string(),
  promotedAtUtc: z.string().optional(),
  serverVersion: z.string(), buildId: z.string().optional(), buildChannel: z.string().optional(),
  rollbackVerifiedWith: z.array(releaseIdSchema).default([]),
  files: z.object({ 'kiki-server.exe': fileDigestSchema, 'kiki-desktop.exe': fileDigestSchema }),
});
const currentManifestSchema = z.object({
  schemaVersion: z.literal(1), releaseId: releaseIdSchema, gitSha: z.string(), promotedAtUtc: z.string(),
  installedAt: z.string().optional(), serverVersion: z.string().optional(), buildId: z.string().optional(),
  buildChannel: z.string().optional(), rollbackVerifiedWith: z.array(releaseIdSchema).optional(),
  files: z.object({ 'kiki-server.exe': fileDigestSchema, 'kiki-desktop.exe': fileDigestSchema }),
});
export type InstalledRuntimeRelease = z.infer<typeof releaseManifestSchema>;

async function hashExecutable(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const source = await stat(filePath);
  if (!source.isFile()) throw Object.assign(new Error(`Missing executable: ${filePath}`), { code: 'ENOENT' });
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return { sha256: digest.digest('hex').toLowerCase(), bytes: source.size };
}

async function fallbackInstalledRelease(root: string, releaseId: string): Promise<InstalledRuntimeRelease> {
  const releaseDir = join(root, 'releases', releaseId);
  const dirStat = await stat(releaseDir);
  if (!dirStat.isDirectory()) throw Object.assign(new Error(`Missing release directory: ${releaseDir}`), { code: 'ENOENT' });
  let current: z.infer<typeof currentManifestSchema> | undefined;
  try {
    const parsed = currentManifestSchema.safeParse(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')));
    if (parsed.success && parsed.data.releaseId === releaseId) current = parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current !== undefined) {
    return releaseManifestSchema.parse({
      schemaVersion: 1,
      releaseId,
      gitSha: current.gitSha,
      installedAt: current.installedAt ?? current.promotedAtUtc,
      promotedAtUtc: current.promotedAtUtc,
      serverVersion: current.serverVersion ?? getServerVersion(),
      buildId: current.buildId,
      buildChannel: current.buildChannel,
      rollbackVerifiedWith: current.rollbackVerifiedWith ?? [],
      files: current.files,
    });
  }
  let gitSha = 'unknown';
  try {
    const buildInfo = await readFile(join(releaseDir, 'build-info.txt'), 'utf8');
    const matched = /^gitSha:\s*(\S+)/m.exec(buildInfo);
    if (matched?.[1] !== undefined) gitSha = matched[1];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const [serverFile, desktopFile] = await Promise.all([
    hashExecutable(join(releaseDir, 'kiki-server.exe')),
    hashExecutable(join(releaseDir, 'kiki-desktop.exe')),
  ]);
  const timestamp = dirStat.mtime.toISOString();
  return releaseManifestSchema.parse({
    schemaVersion: 1,
    releaseId,
    gitSha,
    installedAt: timestamp,
    promotedAtUtc: timestamp,
    serverVersion: getServerVersion(),
    rollbackVerifiedWith: [],
    files: { 'kiki-server.exe': serverFile, 'kiki-desktop.exe': desktopFile },
  });
}

export async function readInstalledRuntimeRelease(root: string, releaseId: string): Promise<InstalledRuntimeRelease> {
  releaseIdSchema.parse(releaseId);
  try {
    const raw = JSON.parse(await readFile(join(root, 'releases', releaseId, 'runtime-release.json'), 'utf8'));
    const manifest = releaseManifestSchema.parse(raw);
    if (manifest.releaseId !== releaseId) throw new Error('The installed release manifest has a different release identity.');
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return fallbackInstalledRelease(root, releaseId);
  }
}

export async function installedRuntimeReleases(root: string): Promise<InstalledRuntimeRelease[]> {
  let entries: string[];
  try { entries = await readdir(join(root, 'releases')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const releases: InstalledRuntimeRelease[] = [];
  for (const releaseId of entries) {
    if (!releaseIdSchema.safeParse(releaseId).success) continue;
    try { releases.push(await readInstalledRuntimeRelease(root, releaseId)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return releases.toSorted((left, right) => right.installedAt.localeCompare(left.installedAt));
}

export async function verifiedRuntimeRelease(root: string, releaseId: string): Promise<RuntimeRelease> {
  const manifest = await readInstalledRuntimeRelease(root, releaseId);
  const executable = join(root, 'releases', releaseId, 'kiki-server.exe');
  const expected = manifest.files['kiki-server.exe'];
  const source = await stat(executable);
  if (!source.isFile() || source.size !== expected.bytes) throw new Error('The installed server does not match its release manifest.');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(executable)) digest.update(chunk);
  if (digest.digest('hex').toLowerCase() !== expected.sha256) throw new Error('The installed server failed its release integrity check.');
  return runtimeReleaseSchema.parse({ releaseId, executable, args: [], serverVersion: manifest.serverVersion,
    buildId: manifest.buildId, buildChannel: manifest.buildChannel, rollbackVerifiedWith: manifest.rollbackVerifiedWith });
}

export async function readRuntimeReleasePointer(root: string, kind: 'installed' | 'current'): Promise<string | undefined> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(root, `${kind}.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  return z.object({ schemaVersion: z.literal(1), releaseId: releaseIdSchema }).parse(raw).releaseId;
}
