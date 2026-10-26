import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { mailboxMigrationStatusSchema } from '@kiki/protocol';

import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import type { MailboxMigrationSource, MailboxMigrationStatus } from '#/app/threadCommunication/mailboxMigration';
import { acquireFileLock } from '../node-fs/fileLock';
import { CanonicalMailboxDatabase } from './database';
import type { MailboxOwner } from './protocol';

export const MAILBOX_SOURCE_NAMES = ['thread-mailbox-v3', 'thread-mailbox-v1', 'agent-collaboration-mailbox-v2'] as const;
export const MAILBOX_SQLITE_DIRECTORY = 'thread-mailbox-sqlite-v1';

export interface MailboxAuthority {
  readonly version: 1;
  readonly backend: 'sqlite';
  readonly migrationId: string;
  readonly database: string;
  readonly publishedAt: number;
}

export interface SourceFile {
  readonly source: typeof MAILBOX_SOURCE_NAMES[number];
  readonly relative: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface MigrationManifest {
  readonly version: 1;
  readonly status: MailboxMigrationStatus;
  readonly files: readonly SourceFile[];
  readonly copiedFiles: number;
  readonly importedSources: readonly string[];
  readonly fencedSources: readonly string[];
  readonly cutoverStarted?: boolean;
  readonly rollbackAuthority?: MailboxAuthority;
  readonly rolledBack?: boolean;
}

export function mailboxDirectory(homeDir: string): string { return join(resolve(homeDir), 'store', MAILBOX_SQLITE_DIRECTORY); }
export function authorityPath(homeDir: string): string { return join(mailboxDirectory(homeDir), 'authority.json'); }
export function migrationPath(homeDir: string): string { return join(mailboxDirectory(homeDir), 'migration.json'); }
export function recoveryPath(homeDir: string, migrationId: string): string { return join(mailboxDirectory(homeDir), 'recovery', migrationId); }
export function fenceText(migrationId: string): string { return `Kiki mailbox SQLite authority ${migrationId}\nUse Kiki 0.5.x or later. Do not remove this file or reopen the recovery copy for writing.\n`; }

export function validateMigrationManifest(homeDir: string, manifest: MigrationManifest): void {
  const status = mailboxMigrationStatusSchema.safeParse(manifest.status);
  const id = status.success ? status.data.migrationId : undefined;
  const fail = (): never => { throw new Error('Unsupported or damaged mailbox migration checkpoint; keep the sources and use a compatible 0.5.x repair tool'); };
  if (!status.success || manifest.version !== 1 || status.data.homeDir !== homeDir || id === undefined || !/^[a-zA-Z0-9-]+$/.test(id)) fail();
  if (manifest.status.databasePath !== join(mailboxDirectory(homeDir), `mailbox-${id}.sqlite`) || manifest.status.backupPath !== undefined && manifest.status.backupPath !== join(recoveryPath(homeDir, id!), 'sources')) fail();
  if (manifest.status.sources.length !== MAILBOX_SOURCE_NAMES.length || MAILBOX_SOURCE_NAMES.some((name) => manifest.status.sources.filter((source) => source.name === name).length !== 1)) fail();
  if (!Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.copiedFiles) || manifest.copiedFiles < 0 || manifest.copiedFiles > manifest.files.length || !Array.isArray(manifest.fencedSources) || manifest.fencedSources.some((source) => !MAILBOX_SOURCE_NAMES.includes(source as typeof MAILBOX_SOURCE_NAMES[number]))) fail();
  for (const file of manifest.files) {
    if (!MAILBOX_SOURCE_NAMES.includes(file.source) || typeof file.relative !== 'string' || isAbsolute(file.relative) || file.relative.split(/[\\/]/).includes('..') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isFinite(file.mtimeMs)) fail();
  }
  if (manifest.rollbackAuthority !== undefined && (manifest.rollbackAuthority.migrationId !== id || manifest.rollbackAuthority.database !== `mailbox-${id}.sqlite` || manifest.rollbackAuthority.backend !== 'sqlite' || manifest.rollbackAuthority.version !== 1)) fail();
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function saveJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function pathKind(path: string): Promise<'missing' | 'file' | 'directory'> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error(`Mailbox migration refuses a symbolic link or special file: ${path}`);
    return stat.isDirectory() ? 'directory' : 'file';
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
}

export async function isFence(path: string, migrationId: string): Promise<boolean> {
  if (await pathKind(path) !== 'file') return false;
  return await readFile(path, 'utf8') === fenceText(migrationId);
}

export async function installMailboxFence(path: string, migrationId: string): Promise<void> {
  if (await isFence(path, migrationId)) return;
  const temporary = `${path}.fence-${migrationId}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(fenceText(migrationId)); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, path); }
  catch (error) { if (!await isFence(path, migrationId)) throw error; }
  await syncDirectory(dirname(path));
  await unlink(temporary);
}

export async function inspectSources(homeDir: string): Promise<readonly MailboxMigrationSource[]> {
  const sources: MailboxMigrationSource[] = [];
  for (const name of MAILBOX_SOURCE_NAMES) sources.push({ name, exists: await pathKind(join(homeDir, 'store', name)) === 'directory' });
  return sources;
}

export async function inventory(homeDir: string, sources: readonly MailboxMigrationSource[]): Promise<readonly SourceFile[]> {
  const result: SourceFile[] = [];
  for (const source of sources) {
    if (source.exists) result.push(...await inventorySource(join(homeDir, 'store', source.name), source.name));
  }
  return result;
}

export async function inventorySource(root: string, source: typeof MAILBOX_SOURCE_NAMES[number]): Promise<readonly SourceFile[]> {
  const result: SourceFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === 'db.lock' || name.startsWith('db.lock.')) continue;
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error(`Mailbox migration refuses a symbolic link or special file: ${path}`);
      if (stat.isDirectory()) await visit(path);
      else result.push({ source, relative: relative(root, path), bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  await visit(root);
  return result;
}

export async function readMailboxAuthority(homeDir: string): Promise<MailboxAuthority | undefined> {
  const authority = await readJson<MailboxAuthority>(authorityPath(homeDir));
  if (authority === undefined) return undefined;
  if (authority.version !== 1 || authority.backend !== 'sqlite' || !/^[a-zA-Z0-9-]+$/.test(authority.migrationId) || authority.database !== `mailbox-${authority.migrationId}.sqlite`) throw new Error('Unsupported canonical mailbox authority; use a compatible Kiki 0.5.x repair version');
  for (const name of MAILBOX_SOURCE_NAMES) {
    if (!await isFence(join(homeDir, 'store', name), authority.migrationId)) throw new Error(`Canonical mailbox legacy fence is missing or changed: ${name}. Stop old Kiki versions and restore the fence before writing.`);
  }
  if (await pathKind(join(mailboxDirectory(homeDir), authority.database)) !== 'file') throw new Error('Canonical mailbox database is missing; restore its consistent SQLite backup before starting Kiki');
  return authority;
}

export function checkLocalHome(homeDir: string): string {
  if (!isAbsolute(homeDir) || homeDir.startsWith('\\\\') || homeDir.startsWith('//')) throw new Error('Mailbox SQLite requires an absolute home on a local filesystem; network shares are not supported');
  return resolve(homeDir);
}

export async function openRuntimeMailbox<V>(homeDir: string, owner: MailboxOwner): Promise<CanonicalMailboxDatabase<V>> {
  checkLocalHome(homeDir);
  let authority = await readMailboxAuthority(homeDir);
  if (authority === undefined) {
    const sources = await inspectSources(homeDir);
    await assertMailboxStartupReady(homeDir);
    await mkdir(mailboxDirectory(homeDir), { recursive: true, mode: 0o700 });
    const lock = await acquireFileLock(join(mailboxDirectory(homeDir), 'migration.lock'), { waitForMs: 0, owner: { kind: 'mailbox-migration' } });
    try {
      authority = await readMailboxAuthority(homeDir);
      if (authority === undefined) {
        await assertMailboxStartupReady(homeDir);
        const id = randomUUID();
        const database = `mailbox-${id}.sqlite`;
        const db = new CanonicalMailboxDatabase<Record<string, unknown>>(join(mailboxDirectory(homeDir), database), true);
        const status: MailboxMigrationStatus = { schemaVersion: 1, homeDir, migrationId: id, authority: 'legacy', phase: 'switching', state: 'running', sources,
          progress: { items: 0, totalItems: 0, bytes: 0, totalBytes: 0 }, databasePath: db.database, canCancel: false, canRollback: false, minimumReaderVersion: '0.5.0', legacyImportRemovedVersion: '0.6.0' };
        try {
          await db.verify();
          await db.metadata('migrationReady', id);
          await db.metadata('peerHistoryComplete', true);
          await saveJson(migrationPath(homeDir), { version: 1, status, cutoverStarted: true, files: [], copiedFiles: 0, importedSources: [], fencedSources: [] } satisfies MigrationManifest);
          for (const name of MAILBOX_SOURCE_NAMES) await installMailboxFence(join(homeDir, 'store', name), id);
          await syncDirectory(join(homeDir, 'store'));
          await db.metadata('authority', 'sqlite');
          authority = { version: 1, backend: 'sqlite', migrationId: id, database, publishedAt: Date.now() };
          await saveJson(authorityPath(homeDir), authority);
          await saveJson(migrationPath(homeDir), { version: 1, status: { ...status, authority: 'sqlite', phase: 'complete', state: 'complete', canRollback: true }, files: [], copiedFiles: 0, importedSources: [], fencedSources: [...MAILBOX_SOURCE_NAMES] } satisfies MigrationManifest);
        } finally { await db.close(); }
      }
    } finally { await lock.release(); }
  }
  const db = new CanonicalMailboxDatabase<V>(join(mailboxDirectory(homeDir), authority.database));
  try { await db.claimOwner(owner); return db; } catch (error) { await db.close(); throw error; }
}

export async function assertMailboxStartupReady(homeDir: string): Promise<void> {
  assertMailboxStartupReadySync(homeDir);
}

export function assertMailboxStartupReadySync(homeDir: string): void {
  checkLocalHome(homeDir);
  let manifest: MigrationManifest | undefined;
  try { manifest = JSON.parse(readFileSync(migrationPath(homeDir), 'utf8')) as MigrationManifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (manifest !== undefined) {
    validateMigrationManifest(homeDir, manifest);
    if (manifest.rollbackAuthority !== undefined && manifest.rolledBack !== true || manifest.status.phase === 'rolling_back') {
      throw new HomeRuntimeError('mailbox.migration_required', `Mailbox rollback is incomplete. Review kiki storage status --home "${homeDir}", then finish kiki storage rollback --home "${homeDir}" before starting Kiki.`);
    }
  }
  let authority: MailboxAuthority | undefined;
  try { authority = JSON.parse(readFileSync(authorityPath(homeDir), 'utf8')) as MailboxAuthority; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (authority !== undefined) {
    if (authority.version !== 1 || authority.backend !== 'sqlite' || !/^[a-zA-Z0-9-]+$/.test(authority.migrationId) || authority.database !== `mailbox-${authority.migrationId}.sqlite`) throw migrationRequired(homeDir);
    for (const name of MAILBOX_SOURCE_NAMES) {
      const path = join(homeDir, 'store', name);
      try { if (!lstatSync(path).isFile() || readFileSync(path, 'utf8') !== fenceText(authority.migrationId)) throw migrationRequired(homeDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw migrationRequired(homeDir); throw error; }
    }
    const database = join(mailboxDirectory(homeDir), authority.database);
    try { if (!lstatSync(database).isFile()) throw migrationRequired(homeDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw migrationRequired(homeDir); throw error; }
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100');
      if (db.prepare("SELECT json FROM metadata WHERE key='authority'").get()?.['json'] !== '"sqlite"') {
        throw new HomeRuntimeError('mailbox.migration_required', `Mailbox database authority is not active. Review kiki storage status --home "${homeDir}" and finish its recovery action before starting Kiki.`);
      }
    } finally { db.close(); }
    return;
  }
  for (const path of [migrationPath(homeDir), ...MAILBOX_SOURCE_NAMES.map((name) => join(homeDir, 'store', name))]) {
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw migrationRequired(homeDir);
  }
}

export function migrationRequired(homeDir: string): HomeRuntimeError {
  return new HomeRuntimeError('mailbox.migration_required', `This home has legacy canonical mailbox data. Close all Kiki writers, then run: kiki storage migrate --home "${homeDir}". Kiki 0.6.0 requires migration with the latest 0.5.x tool; no empty mailbox was created.`);
}
