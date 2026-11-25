import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getServerVersion } from '../version';
import { runtimeReleaseSchema, type RuntimeRelease } from './controller';

export const releaseIdSchema = z.string().regex(/^[0-9a-f]{24}-[0-9a-f]{24}$/);
const fileDigestSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive() });

const releaseFilesV1Schema = z.object({ 'kiki-server.exe': fileDigestSchema, 'kiki-desktop.exe': fileDigestSchema });
const releaseFilesV2Schema = z.object({
  'kiki-desktop.exe': fileDigestSchema,
  'server-entry.mjs': fileDigestSchema,
  'native-addons.json': fileDigestSchema,
});

const releaseManifestV1Schema = z.object({
  schemaVersion: z.literal(1), releaseId: releaseIdSchema, gitSha: z.string(), installedAt: z.string(),
  promotedAtUtc: z.string().optional(),
  serverVersion: z.string(), buildId: z.string().optional(), buildChannel: z.string().optional(),
  rollbackVerifiedWith: z.array(releaseIdSchema).default([]),
  files: releaseFilesV1Schema,
});
const releaseManifestV2Schema = z.object({
  schemaVersion: z.literal(2), runtimeKind: z.literal('electron-single-binary'),
  releaseId: releaseIdSchema, gitSha: z.string(), installedAt: z.string(),
  promotedAtUtc: z.string().optional(),
  serverVersion: z.string(), buildId: z.string().optional(), buildChannel: z.string().optional(),
  rollbackVerifiedWith: z.array(releaseIdSchema).default([]),
  files: releaseFilesV2Schema,
});
const releaseManifestSchema = z.discriminatedUnion('schemaVersion', [releaseManifestV1Schema, releaseManifestV2Schema]);

const currentManifestV1Schema = z.object({
  schemaVersion: z.literal(1), releaseId: releaseIdSchema, gitSha: z.string(), promotedAtUtc: z.string(),
  installedAt: z.string().optional(), serverVersion: z.string().optional(), buildId: z.string().optional(),
  buildChannel: z.string().optional(), rollbackVerifiedWith: z.array(releaseIdSchema).optional(),
  files: releaseFilesV1Schema,
});
const currentManifestV2Schema = z.object({
  schemaVersion: z.literal(2), runtimeKind: z.literal('electron-single-binary'),
  releaseId: releaseIdSchema, gitSha: z.string(), promotedAtUtc: z.string(),
  installedAt: z.string().optional(), serverVersion: z.string().optional(), buildId: z.string().optional(),
  buildChannel: z.string().optional(), rollbackVerifiedWith: z.array(releaseIdSchema).optional(),
  files: releaseFilesV2Schema,
});
const currentManifestSchema = z.discriminatedUnion('schemaVersion', [currentManifestV1Schema, currentManifestV2Schema]);

export type InstalledRuntimeRelease = z.infer<typeof releaseManifestSchema>;

async function fileExists(filePath: string): Promise<boolean> {
  try { return (await stat(filePath)).isFile(); } catch { return false; }
}

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const source = await stat(filePath);
  if (!source.isFile()) throw Object.assign(new Error(`Missing release file: ${filePath}`), { code: 'ENOENT' });
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return { sha256: digest.digest('hex').toLowerCase(), bytes: source.size };
}

type ManifestFiles = InstalledRuntimeRelease['files'];

async function hashReleaseFiles(releaseDir: string, schemaVersion: 1 | 2): Promise<ManifestFiles> {
  if (schemaVersion === 1) {
    const [serverFile, desktopFile] = await Promise.all([
      hashFile(join(releaseDir, 'kiki-server.exe')),
      hashFile(join(releaseDir, 'kiki-desktop.exe')),
    ]);
    return { 'kiki-server.exe': serverFile, 'kiki-desktop.exe': desktopFile };
  }
  const [desktopFile, serverEntry, nativeAddons] = await Promise.all([
    hashFile(join(releaseDir, 'kiki-desktop.exe')),
    hashFile(join(releaseDir, 'server-entry.mjs')),
    hashFile(join(releaseDir, 'native-addons.json')),
  ]);
  return { 'kiki-desktop.exe': desktopFile, 'server-entry.mjs': serverEntry, 'native-addons.json': nativeAddons };
}

function manifestForCurrent(current: z.infer<typeof currentManifestSchema>, releaseId: string): InstalledRuntimeRelease {
  const shared = {
    releaseId,
    gitSha: current.gitSha,
    installedAt: current.installedAt ?? current.promotedAtUtc,
    promotedAtUtc: current.promotedAtUtc,
    serverVersion: current.serverVersion ?? getServerVersion(),
    buildId: current.buildId,
    buildChannel: current.buildChannel,
    rollbackVerifiedWith: current.rollbackVerifiedWith ?? [],
    files: current.files,
  };
  if (current.schemaVersion === 2) {
    return releaseManifestV2Schema.parse({ ...shared, schemaVersion: 2, runtimeKind: 'electron-single-binary' });
  }
  return releaseManifestV1Schema.parse({ ...shared, schemaVersion: 1 });
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
  if (current !== undefined) return manifestForCurrent(current, releaseId);
  let gitSha = 'unknown';
  try {
    const buildInfo = await readFile(join(releaseDir, 'build-info.txt'), 'utf8');
    const matched = /^gitSha:\s*(\S+)/m.exec(buildInfo);
    if (matched?.[1] !== undefined) gitSha = matched[1];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const timestamp = dirStat.mtime.toISOString();
  const shared = { releaseId, gitSha, installedAt: timestamp, promotedAtUtc: timestamp, serverVersion: getServerVersion(), rollbackVerifiedWith: [] as string[] };
  const v2Layout = !(await fileExists(join(releaseDir, 'kiki-server.exe'))) &&
    await fileExists(join(releaseDir, 'server-entry.mjs')) &&
    await fileExists(join(releaseDir, 'native-addons.json'));
  if (v2Layout) {
    return releaseManifestV2Schema.parse({
      ...shared, schemaVersion: 2, runtimeKind: 'electron-single-binary', files: await hashReleaseFiles(releaseDir, 2),
    });
  }
  return releaseManifestV1Schema.parse({
    ...shared, schemaVersion: 1, files: await hashReleaseFiles(releaseDir, 1),
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

async function verifyFileDigest(filePath: string, expected: { sha256: string; bytes: number }, label: string): Promise<void> {
  let actual: { sha256: string; bytes: number };
  try {
    actual = await hashFile(filePath);
  } catch {
    throw new Error(`The installed ${label} does not match its release manifest.`);
  }
  if (actual.bytes !== expected.bytes) throw new Error(`The installed ${label} does not match its release manifest.`);
  if (actual.sha256 !== expected.sha256) throw new Error(`The installed ${label} failed its release integrity check.`);
}

export async function verifiedRuntimeRelease(root: string, releaseId: string): Promise<RuntimeRelease> {
  const manifest = await readInstalledRuntimeRelease(root, releaseId);
  const releaseDir = join(root, 'releases', releaseId);
  if (manifest.schemaVersion === 2) {
    const desktop = join(releaseDir, 'kiki-desktop.exe');
    await verifyFileDigest(desktop, manifest.files['kiki-desktop.exe'], 'desktop binary');
    await verifyFileDigest(join(releaseDir, 'server-entry.mjs'), manifest.files['server-entry.mjs'], 'server entry');
    await verifyFileDigest(join(releaseDir, 'native-addons.json'), manifest.files['native-addons.json'], 'native addon manifest');
    return runtimeReleaseSchema.parse({
      releaseId, executable: desktop, args: [join(releaseDir, 'server-entry.mjs')], serverVersion: manifest.serverVersion,
      buildId: manifest.buildId, buildChannel: manifest.buildChannel, rollbackVerifiedWith: manifest.rollbackVerifiedWith,
    });
  }
  const executable = join(releaseDir, 'kiki-server.exe');
  await verifyFileDigest(executable, manifest.files['kiki-server.exe'], 'server');
  return runtimeReleaseSchema.parse({ releaseId, executable, args: [], serverVersion: manifest.serverVersion,
    buildId: manifest.buildId, buildChannel: manifest.buildChannel, rollbackVerifiedWith: manifest.rollbackVerifiedWith });
}

export async function readRuntimeReleasePointer(root: string, kind: 'installed' | 'current'): Promise<string | undefined> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(root, `${kind}.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  return z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), releaseId: releaseIdSchema }).parse(raw).releaseId;
}
