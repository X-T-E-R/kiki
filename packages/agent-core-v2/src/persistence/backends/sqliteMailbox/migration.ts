import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rename, unlink, lstat, readdir, realpath, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

import { LockFile, MiniDb } from '@kiki/minidb';
import { shardDirName } from '@kiki/minidb/cluster';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHomeRuntimeService } from '#/app/runtimeHost/runtimeHost';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import type { MailboxMigrationOptions, MailboxMigrationService, MailboxMigrationSource, MailboxMigrationStatus, MailboxRecoveryCleanupPlan } from '#/app/threadCommunication/mailboxMigration';
import { convertLegacyMailboxRows, LegacyMailboxImportError, mailboxPeerIndexWrites } from '#/app/threadCommunication/legacyMailboxImport';
import type { AcceptedThreadMessage } from '#/app/threadCommunication/threadMailboxStore';
import { acquireFileLock, isFileLockActive } from '../node-fs/fileLock';
import {
  MAILBOX_SOURCE_NAMES, assertMailboxStartupReadySync, authorityPath, checkLocalHome, inspectSources, installMailboxFence, inventory, inventorySource, isFence, mailboxDirectory, migrationPath,
  pathKind, readJson, readMailboxAuthority, recoveryPath, saveJson, syncDirectory, validateMigrationManifest,
  type MailboxAuthority, type MigrationManifest,
} from './authority';
import { CanonicalMailboxDatabase } from './database';
import type { LegacyDeliveryCursor, MailboxOwner, MailboxRow, MailboxWrite } from './protocol';

type Document = Record<string, unknown>;
interface FrozenLock { readonly lock: LockFile; readonly token: string; originalPath: string; }
interface MaintenanceRuntime { readonly runtime: IHomeRuntimeService; readonly close: () => Promise<void>; }

export function createMailboxMigrationService(homeDir: string): MailboxMigrationService {
  return new FileMailboxMigrationService(checkLocalHome(homeDir));
}

class FileMailboxMigrationService implements MailboxMigrationService {
  private flight?: Promise<MailboxMigrationStatus>;
  private controller?: AbortController;
  private current?: MailboxMigrationStatus;
  private switching = false;

  constructor(private readonly homeDir: string) {}

  async status(): Promise<MailboxMigrationStatus> {
    try { return await this.readStatus(); }
    catch (error) {
      const status = initialStatus(this.homeDir, []);
      return { ...status, state: 'failed', failure: { code: 'mailbox.status_failed', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  private async readStatus(): Promise<MailboxMigrationStatus> {
    if (this.current !== undefined && this.flight !== undefined) return this.current;
    const authority = await readMailboxAuthority(this.homeDir);
    let manifest: MigrationManifest | undefined;
    try {
      manifest = await readJson<MigrationManifest>(migrationPath(this.homeDir));
      if (manifest !== undefined) validateMigrationManifest(this.homeDir, manifest);
    } catch (error) {
      if (authority === undefined) throw error;
      assertMailboxStartupReadySync(this.homeDir);
      return { ...initialStatus(this.homeDir, await inspectSources(this.homeDir)), authority: 'sqlite', phase: 'complete', state: 'complete',
        migrationId: authority.migrationId, databasePath: join(mailboxDirectory(this.homeDir), authority.database), canRollback: false,
        warning: { code: 'mailbox.checkpoint_warning', message: `Historical mailbox upgrade progress needs repair before rollback: ${error instanceof Error ? error.message : String(error)}` } };
    }
    if (manifest !== undefined) {
      if (manifest.rollbackAuthority !== undefined && manifest.rolledBack !== true) {
        const active = await isFileLockActive(join(mailboxDirectory(this.homeDir), 'migration.lock'));
        const state = active || !['running', 'cancelling'].includes(manifest.status.state) ? manifest.status.state : 'ready';
        return { ...manifest.status, phase: 'rolling_back', state, canCancel: false, canRollback: true };
      }
      if (authority !== undefined) {
        assertMailboxStartupReadySync(this.homeDir);
        const db = new CanonicalMailboxDatabase<Document>(join(mailboxDirectory(this.homeDir), authority.database), false, true);
        try { return { ...manifest.status, authority: 'sqlite', phase: 'complete', state: 'complete', canCancel: false, canRollback: await db.metadata<boolean>('hasNewWrites') !== true }; }
        finally { await db.close(); }
      }
      const active = await isFileLockActive(join(mailboxDirectory(this.homeDir), 'migration.lock'));
      const cancellation = await readJson<{ migrationId?: string }>(join(mailboxDirectory(this.homeDir), 'cancel.json'));
      const state = active && cancellation?.migrationId === manifest.status.migrationId ? 'cancelling'
        : active ? manifest.status.state : manifest.status.state === 'running' || manifest.status.state === 'cancelling' ? 'ready' : manifest.status.state;
      return { ...manifest.status, state, canCancel: active && state === 'running' && manifest.cutoverStarted !== true };
    }
    if (authority !== undefined) {
      assertMailboxStartupReadySync(this.homeDir);
      return { ...initialStatus(this.homeDir, await inspectSources(this.homeDir)), authority: 'sqlite', phase: 'complete', state: 'complete',
        migrationId: authority.migrationId, databasePath: join(mailboxDirectory(this.homeDir), authority.database), canRollback: false,
        warning: { code: 'mailbox.checkpoint_warning', message: 'Historical mailbox upgrade progress is missing; repair it before rollback.' } };
    }
    return initialStatus(this.homeDir, await inspectSources(this.homeDir));
  }

  migrate(options: MailboxMigrationOptions = {}): Promise<MailboxMigrationStatus> {
    if (this.flight !== undefined) return this.flight;
    this.current = undefined;
    this.controller = new AbortController();
    const signal = options.signal === undefined ? this.controller.signal : AbortSignal.any([options.signal, this.controller.signal]);
    this.flight = this.runMigration({ ...options, signal }).finally(() => { this.flight = undefined; this.controller = undefined; this.switching = false; });
    return this.flight;
  }

  async cancel(): Promise<MailboxMigrationStatus> {
    const status = await this.status();
    if (!status.canCancel || this.switching) return status;
    await saveJson(join(mailboxDirectory(this.homeDir), 'cancel.json'), { migrationId: status.migrationId });
    this.controller?.abort(new DOMException('Mailbox migration cancelled', 'AbortError'));
    return this.flight === undefined ? { ...status, state: 'cancelling', canCancel: false } : this.flight;
  }

  async backup(destination: string, options: MailboxMigrationOptions = {}): Promise<{ readonly destination: string; readonly items: number; readonly bytes: number }> {
    options.signal?.throwIfAborted();
    const authority = await readMailboxAuthority(this.homeDir);
    if (authority === undefined) throw new Error('Complete the mailbox migration before creating a SQLite online backup');
    const target = resolve(destination);
    if (await pathKind(target) !== 'missing') throw new Error('Mailbox backup destination already exists');
    const temporary = `${target}.mailbox-backup-${randomUUID()}`;
    const db = new CanonicalMailboxDatabase<Document>(join(mailboxDirectory(this.homeDir), authority.database), false, true);
    try {
      const result = await db.backup(temporary, options.signal);
      const file = await open(temporary, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      options.signal?.throwIfAborted();
      await link(temporary, target);
      await syncDirectory(dirname(target));
      return { destination: target, items: result.items, bytes: result.bytes };
    } finally { await closeAll([() => db.close(), async () => { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }]); }
  }

  async cleanupRecovery(options: { readonly confirm?: boolean; readonly backupDestination?: string } = {}): Promise<MailboxRecoveryCleanupPlan> {
    if (this.flight !== undefined) throw new Error('Wait for the mailbox migration to finish before cleaning its recovery copies');
    const authority = await readMailboxAuthority(this.homeDir);
    if (authority === undefined) throw new Error('A verified SQLite mailbox is required before recovery cleanup');
    const manifest = await readJson<MigrationManifest>(migrationPath(this.homeDir));
    if (manifest === undefined) throw new Error('The mailbox migration record is missing; keep the recovery copies');
    validateMigrationManifest(this.homeDir, manifest);
    if (manifest.status.migrationId !== authority.migrationId || manifest.cutoverStarted !== true || manifest.rolledBack === true || manifest.rollbackAuthority !== undefined || manifest.status.phase !== 'complete') {
      throw new Error('Mailbox recovery cleanup requires a completed SQLite authority without an unfinished rollback');
    }
    const recovery = recoveryPath(this.homeDir, authority.migrationId);
    const markerPath = join(recovery, 'cleanup.json');
    const marker = await readJson<RecoveryCleanupMarker>(markerPath);
    if (marker !== undefined && (marker.version !== 1 || marker.migrationId !== authority.migrationId || typeof marker.backupDestination !== 'string' ||
      typeof marker.mailboxOwner?.hostId !== 'string' || !Number.isSafeInteger(marker.mailboxOwner.epoch))) {
      throw new Error('Unrecognized mailbox recovery cleanup record; keep the original copies');
    }
    const destination = options.backupDestination === undefined ? marker?.backupDestination : resolve(options.backupDestination);
    if (destination !== undefined) await assertIndependentBackupPath(this.homeDir, destination);
    const database = new CanonicalMailboxDatabase<Document>(join(mailboxDirectory(this.homeDir), authority.database), false, true);
    try {
      if (await database.metadata<boolean>('hasNewWrites') !== true) throw new Error('Mailbox rollback is still available; retain both recovery copies');
    } finally { await database.close(); }
    const plan = await recoveryCleanupPlan(manifest, recovery, destination, marker !== undefined);
    if (options.confirm !== true || plan.remove.length === 0 && (marker === undefined || marker.completed === true)) {
      return { ...plan, completed: marker?.completed === true && plan.remove.length === 0 };
    }
    if (destination === undefined) throw new Error('Confirm cleanup with --backup <absolute-path> for a new independent SQLite backup');
    const lease = await acquireFileLock(join(mailboxDirectory(this.homeDir), 'migration.lock'), { waitForMs: 0, owner: { kind: 'mailbox-recovery-cleanup' } });
    const maintenance = createMaintenanceRuntime(this.homeDir);
    const locks: FrozenLock[] = [];
    try {
      await maintenance.runtime.ready();
      if (maintenance.runtime.status().role !== 'owner') throw new Error('Another Kiki writer still owns this home; stop it naturally before cleanup');
      const busy = await acquireSourceLocks(this.homeDir, manifest, locks);
      if (busy !== undefined) throw new Error(`A legacy writer still holds the frozen source lock: ${busy}`);
      const current = await readMailboxAuthority(this.homeDir);
      if (current?.migrationId !== authority.migrationId) throw new Error('Mailbox authority changed during cleanup; preserve the recovery copies');
      const verified = await recoveryCleanupPlan(manifest, recovery, destination, marker !== undefined);
      if (verified.remove.length !== plan.remove.length || verified.removeBytes !== plan.removeBytes) throw new Error('Recovery files changed during cleanup; review the new dry-run plan');
      const live = new CanonicalMailboxDatabase<Document>(join(mailboxDirectory(this.homeDir), authority.database), false, true);
      let mailboxOwner: MailboxOwner | undefined;
      try { mailboxOwner = await live.metadata<MailboxOwner>('owner'); } finally { await live.close(); }
      if (mailboxOwner === undefined) throw new Error('SQLite mailbox writer ownership is missing; preserve recovery copies');
      const refreshBackup = marker === undefined || !isDeepStrictEqual(marker.mailboxOwner, mailboxOwner);
      if (marker !== undefined && refreshBackup && (options.backupDestination === undefined || destination === marker.backupDestination)) {
        throw new Error('SQLite writer changed since the previous cleanup backup; specify a new --backup destination before resuming');
      }
      if (marker !== undefined && !refreshBackup && marker.backupDestination !== destination) throw new Error('Resume recovery cleanup using its original verified backup destination');
      await assertIndependentBackupPath(this.homeDir, destination);
      if (refreshBackup) {
        if (await pathKind(destination) !== 'missing') throw new Error('Independent SQLite backup destination already exists');
        await this.backup(destination);
      }
      await assertIndependentBackupPath(this.homeDir, destination, true);
      const backupIdentity = await lstat(destination);
      const backup = new CanonicalMailboxDatabase<Document>(destination, false, true);
      try {
        await backup.verify();
        if (await backup.metadata<string>('authority') !== 'sqlite' || await backup.metadata<string>('migrationReady') !== authority.migrationId) {
          throw new Error('Independent SQLite backup cannot restore this mailbox authority');
        }
      } finally { await backup.close(); }
      await assertVerifiedBackupUnchanged(this.homeDir, destination, backupIdentity);
      const record = { version: 1, migrationId: authority.migrationId, backupDestination: destination, mailboxOwner } satisfies RecoveryCleanupMarker;
      if (refreshBackup) await saveJson(markerPath, record);
      const writable = new CanonicalMailboxDatabase<Document>(join(mailboxDirectory(this.homeDir), authority.database));
      try { await writable.discardArchive(authority.migrationId); } finally { await writable.close(); }
      await assertVerifiedBackupUnchanged(this.homeDir, destination, backupIdentity);
      const finalPlan = await recoveryCleanupPlan(manifest, recovery, destination, marker !== undefined);
      if (finalPlan.remove.length !== verified.remove.length || finalPlan.removeBytes !== verified.removeBytes) {
        throw new Error('Recovery files changed after backup; retain the remaining copies and review the new dry-run plan');
      }
      for (const item of finalPlan.remove) {
        const source = MAILBOX_SOURCE_NAMES.find((name) => item.path === join(recovery, 'sources', name));
        if (source === undefined) throw new Error('Unexpected recovery cleanup path; no files removed');
        await assertVerifiedBackupUnchanged(this.homeDir, destination, backupIdentity);
        await removeRecoveryFiles(item.path, join(recovery, 'originals', source), manifest.files.filter((entry) => entry.source === source).map((entry) => entry.relative),
          () => assertVerifiedBackupUnchanged(this.homeDir, destination, backupIdentity));
      }
      await saveJson(markerPath, { ...record, completed: true } satisfies RecoveryCleanupMarker);
      return { ...verified, completed: true };
    } finally { await closeAll([...locks.reverse().map((held) => () => releaseSourceLock(held)), () => maintenance.close(), () => lease.release()]); }
  }

  rollback(options: MailboxMigrationOptions = {}): Promise<MailboxMigrationStatus> {
    if (this.flight !== undefined) return Promise.reject(new Error('Wait for the current migration to stop before rolling back'));
    this.current = undefined;
    this.switching = true;
    this.flight = this.runRollback(options).finally(() => { this.flight = undefined; this.switching = false; });
    return this.flight;
  }

  private async runRollback(options: MailboxMigrationOptions): Promise<MailboxMigrationStatus> {
    options.signal?.throwIfAborted();
    const lease = await acquireFileLock(join(mailboxDirectory(this.homeDir), 'migration.lock'), { owner: { kind: 'mailbox-migration' } });
    const maintenance = createMaintenanceRuntime(this.homeDir);
    const locks: FrozenLock[] = [];
    let db: CanonicalMailboxDatabase<Document> | undefined;
    let manifest: MigrationManifest | undefined;
    try {
      manifest = await readJson<MigrationManifest>(migrationPath(this.homeDir));
      if (manifest === undefined || manifest.rolledBack === true) return await this.status();
      validateMigrationManifest(this.homeDir, manifest);
      const published = await readMailboxAuthority(this.homeDir);
      const authority = manifest.rollbackAuthority ?? published ?? (manifest.cutoverStarted === true
        ? { version: 1, backend: 'sqlite', migrationId: manifest.status.migrationId!, database: `mailbox-${manifest.status.migrationId!}.sqlite`, publishedAt: 0 } satisfies MailboxAuthority : undefined);
      if (authority === undefined) return await this.status();
      db = new CanonicalMailboxDatabase<Document>(join(mailboxDirectory(this.homeDir), authority.database), false, true);
      if (await db.metadata<boolean>('hasNewWrites') === true) throw rollbackAfterWrites();
      await db.close(); db = undefined;
      await maintenance.runtime.ready();
      const runtime = maintenance.runtime.status();
      manifest = { ...manifest, rollbackAuthority: authority, status: { ...manifest.status, phase: 'rolling_back', state: runtime.role === 'owner' ? 'running' : 'waiting', writer: runtime.role === 'owner' ? undefined : { hostId: runtime.hostId, epoch: runtime.epoch }, failure: undefined, canCancel: false, canRollback: true } };
      await saveJson(migrationPath(this.homeDir), manifest);
      if (runtime.role !== 'owner') return manifest.status;
      const busy = await acquireSourceLocks(this.homeDir, manifest, locks);
      if (busy !== undefined) {
        manifest = { ...manifest, status: { ...manifest.status, state: 'waiting', writer: { lockPath: busy } } };
        await saveJson(migrationPath(this.homeDir), manifest);
        return manifest.status;
      }
      await verifyFrozenSources(this.homeDir, manifest, locks, false);
      db = new CanonicalMailboxDatabase<Document>(join(mailboxDirectory(this.homeDir), authority.database));
      if (await db.metadata<boolean>('hasNewWrites') === true) throw rollbackAfterWrites();
      await db.metadata('authority', 'rolled_back');
      await mkdir(recoveryPath(this.homeDir, authority.migrationId), { recursive: true, mode: 0o700 });
      if (published !== undefined) {
        await rename(authorityPath(this.homeDir), join(recoveryPath(this.homeDir, authority.migrationId), 'authority.rolled-back.json'));
        await syncDirectory(mailboxDirectory(this.homeDir));
      }
      for (const name of MAILBOX_SOURCE_NAMES) {
        const path = join(this.homeDir, 'store', name);
        const original = join(recoveryPath(this.homeDir, authority.migrationId), 'originals', name);
        if (await isFence(path, authority.migrationId)) await unlink(path);
        const kind = await pathKind(path);
        const hasOriginal = await pathKind(original) === 'directory';
        if (hasOriginal && kind === 'missing') {
          await rename(original, path);
          relocateLocks(locks, original, path);
        } else if (hasOriginal || kind === 'file' || manifest.status.sources.some((source) => source.name === name && source.exists) && kind !== 'directory') throw new Error(`Legacy mailbox copies conflict during rollback: ${name}; both copies were preserved`);
        await syncDirectory(join(this.homeDir, 'store'));
      }
      const status: MailboxMigrationStatus = { ...manifest.status, authority: 'legacy', phase: 'detecting', state: 'cancelled', writer: undefined, canCancel: false, canRollback: false, sources: await inspectSources(this.homeDir) };
      await saveJson(migrationPath(this.homeDir), { ...manifest, status, rolledBack: true });
      return status;
    } catch (error) {
      if (manifest?.rollbackAuthority !== undefined) await saveJson(migrationPath(this.homeDir), { ...manifest, status: { ...manifest.status, state: 'failed', failure: { code: 'mailbox.rollback_failed', message: error instanceof Error ? error.message : String(error) } } });
      throw error;
    } finally { await closeAll([() => db?.close(), ...locks.reverse().map((held) => () => releaseSourceLock(held)), () => maintenance.close(), () => lease.release()]); }
  }

  async close(): Promise<void> {
    if (!this.switching) this.controller?.abort(new DOMException('Mailbox migration service closed', 'AbortError'));
    await this.flight;
  }

  private async runMigration(options: MailboxMigrationOptions): Promise<MailboxMigrationStatus> {
    await mkdir(mailboxDirectory(this.homeDir), { recursive: true, mode: 0o700 });
    const lease = await acquireFileLock(join(mailboxDirectory(this.homeDir), 'migration.lock'), { owner: { kind: 'mailbox-migration' } });
    const maintenance = createMaintenanceRuntime(this.homeDir);
    const locks: FrozenLock[] = [];
    let db: CanonicalMailboxDatabase<Document> | undefined;
    let manifest: MigrationManifest | undefined;
    const update = async (status: MailboxMigrationStatus, patch: Partial<MigrationManifest> = {}): Promise<void> => {
      this.current = status;
      manifest = { ...manifest!, ...patch, status };
      await saveJson(migrationPath(this.homeDir), manifest);
      options.onProgress?.(status);
    };
    const markSource = async (name: string, stage: NonNullable<MailboxMigrationSource['stage']>, status: MailboxMigrationStatus = manifest!.status): Promise<void> => {
      await update({ ...status, sources: status.sources.map((source) => source.name === name ? { ...source, stage } : source) });
    };
    try {
      const complete = await readMailboxAuthority(this.homeDir);
      if (complete !== undefined) return await this.status();
      const prior = await readJson<MigrationManifest>(migrationPath(this.homeDir));
      if (prior !== undefined) validateMigrationManifest(this.homeDir, prior);
      if (prior?.rollbackAuthority !== undefined && prior.rolledBack !== true) throw new Error('An interrupted rollback must be completed with kiki storage rollback before migrating again');
      manifest = prior === undefined || prior.rolledBack === true ? newManifest(this.homeDir, await inspectSources(this.homeDir)) : prior;
      this.switching = manifest.cutoverStarted === true;
      await mkdir(recoveryPath(this.homeDir, manifest.status.migrationId!), { recursive: true, mode: 0o700 });
      await update({ ...manifest.status, phase: this.switching ? 'switching' : 'waiting_for_writers', state: 'running', canCancel: !this.switching, failure: undefined });
      await unlink(join(mailboxDirectory(this.homeDir), 'cancel.json')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await maintenance.runtime.ready();
      const runtime = maintenance.runtime.status();
      if (runtime.role !== 'owner') {
        await update({ ...manifest.status, phase: 'waiting_for_writers', state: 'waiting', writer: { hostId: runtime.hostId, epoch: runtime.epoch }, canCancel: false });
        return manifest.status;
      }
      if (!this.switching) {
        const sources = await inspectSources(this.homeDir);
        if (manifest.status.sources.some((source, index) => source.exists && !sources[index]!.exists)) throw new Error('A canonical source disappeared before it could be frozen; the prior backup and checkpoint were preserved');
        await update({ ...manifest.status, sources: sources.map((source) => ({ ...source,
          stage: source.exists ? manifest!.status.sources.find((prior) => prior.name === source.name)?.stage ?? 'discovered' : undefined })) });
      }
      const busy = await acquireSourceLocks(this.homeDir, manifest, locks, () => this.checkCancelled(options.signal, manifest!.status.migrationId!));
      if (busy !== undefined) {
        await update({ ...manifest.status, phase: 'waiting_for_writers', state: 'waiting', writer: { lockPath: busy }, canCancel: false });
        return manifest.status;
      }
      await verifyFrozenSources(this.homeDir, manifest, locks, manifest.cutoverStarted === true);
      if (manifest.cutoverStarted !== true) {
        const sources = await inspectSources(this.homeDir);
        if (JSON.stringify(sources) !== JSON.stringify(manifest.status.sources.map(({ stage: _stage, ...source }) => source))) throw new Error('A canonical source appeared while acquiring writer locks; retry after every legacy writer has stopped');
        const files = await inventory(this.homeDir, sources);
        if (manifest.files.length > 0 && JSON.stringify(files) !== JSON.stringify(manifest.files)) {
          await saveJson(join(recoveryPath(this.homeDir, manifest.status.migrationId!), 'superseded-migration.json'), manifest);
          manifest = newManifest(this.homeDir, sources);
          await mkdir(recoveryPath(this.homeDir, manifest.status.migrationId!), { recursive: true, mode: 0o700 });
        }
        manifest = { ...manifest, files, status: { ...manifest.status, sources: sources.map((source) => ({ ...source,
          stage: source.exists ? manifest!.status.sources.find((prior) => prior.name === source.name)?.stage ?? 'discovered' : undefined })) } };
        await update({ ...manifest.status, phase: 'backing_up', state: 'running', writer: undefined, canCancel: true,
          progress: { items: manifest.copiedFiles, totalItems: files.length, bytes: files.slice(0, manifest.copiedFiles).reduce((sum, file) => sum + file.bytes, 0), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) } });
        for (const source of sources) {
          if (!source.exists) continue;
          const root = join(this.homeDir, 'store', source.name);
          const directories = source.name === 'thread-mailbox-v3' ? await shardDirectories(root) : [root];
          for (const directory of directories) await mkdir(join(manifest.status.backupPath!, source.name, relative(root, directory)), { recursive: true, mode: 0o700 });
        }
        for (let index = manifest.copiedFiles; index < files.length; index++) {
          const file = files[index]!;
          await this.checkCancelled(options.signal, manifest.status.migrationId!);
          await copyFileBounded(join(this.homeDir, 'store', file.source, file.relative), join(manifest.status.backupPath!, file.source, file.relative), async (bytes) => {
            await this.checkCancelled(options.signal, manifest!.status.migrationId!);
            await update({ ...manifest!.status, currentSource: file.source, currentKey: file.relative,
              progress: { ...manifest!.status.progress, bytes: files.slice(0, index).reduce((sum, entry) => sum + entry.bytes, 0) + bytes } });
          });
          await update({ ...manifest.status, progress: { ...manifest.status.progress, items: index + 1 } }, { copiedFiles: index + 1 });
        }
        await update({ ...manifest.status, sources: manifest.status.sources.map((source) => source.exists ? { ...source, stage: 'backed_up' } : source) });
      }
      const database = manifest.status.databasePath!;
      db = new CanonicalMailboxDatabase<Document>(database, manifest.cutoverStarted !== true);
      if (manifest.cutoverStarted !== true) {
        const sources = await Promise.all(manifest.status.sources.filter((source) => source.exists).map(async (source) => {
          const root = join(manifest!.status.backupPath!, source.name);
          const directories = source.name === 'thread-mailbox-v3' ? await shardDirectories(root) : [root];
          return { source, root, directories };
        }));
        let importedItems = 0;
        let importedBytes = 0;
        for (const { source, root, directories } of sources) for (const directory of directories) {
          const point = await db.checkpoint(`${source.name}/${relative(root, directory)}`);
          importedItems += point?.items ?? 0;
          importedBytes += point?.bytes ?? 0;
        }
        await update({ ...manifest.status, phase: 'importing', progress: { items: importedItems, bytes: importedBytes }, currentKey: undefined });
        for (const { source, root, directories } of sources) {
          await markSource(source.name, 'importing');
          for (const directory of directories) {
            const sourceId = `${source.name}/${relative(root, directory)}`;
            const point = await db.checkpoint(sourceId);
            let after = point?.after ?? '';
            let items = point?.items ?? 0;
            let bytes = point?.bytes ?? 0;
            await update({ ...manifest.status, currentSource: sourceId, currentKey: after === '' ? undefined : after });
            const legacy = await MiniDb.open<Document>({ dir: directory, readOnly: true, valueCodec: 'json', valueMode: 'disk', recovery: 'strict', indexGenerations: false, activeExpireIntervalMs: 0 });
            try {
              const recovery = legacy.recoveryInfo;
              if (recovery === null || recovery.corruptRanges.length > 0 || recovery.snapshotCorruptRanges.length > 0 || recovery.corruptBatches > 0 || recovery.lostBytes > 0) throw new Error(`Corrupted canonical source at ${sourceId}; the original and backup were preserved`);
              const reader = {
                get: (key: string) => db!.partitionGet('', key), find: (partition: string, field: 'messageId' | 'legacyIdentity', value: string) => db!.findIdentity(partition, field, value),
                sourceGet: (key: string): MailboxRow | undefined => {
                  const record = legacy.store.getRecord(key);
                  const value = legacy.get(key);
                  return record === undefined || value === undefined ? undefined : { key, value, expireAt: record.expireAt };
                },
              };
              for (;;) {
                await this.checkCancelled(options.signal, manifest.status.migrationId!);
                const rows: MailboxRow[] = [];
                let pageBytes = 0;
                for (const entry of legacy.store.scan({ gt: after, count: 256 })) {
                  rows.push({ key: entry.key.toString('utf8'), value: legacy.codec.decode(entry.value), expireAt: entry.expireAt });
                  pageBytes += entry.key.byteLength + entry.value.byteLength;
                  if (pageBytes >= 1024 * 1024) break;
                }
                if (rows.length === 0) break;
                const writes: readonly MailboxWrite<Document>[] = source.name === 'thread-mailbox-v3'
                  ? rows.map((row) => ({ op: 'set', ...row }))
                  : await convertLegacyMailboxRows(rows.filter((row) => row.value['kind'] !== 'delivery' && row.value['kind'] !== 'idempotency'), reader);
                const nextItems = items + rows.length;
                const nextBytes = bytes + rows.reduce((sum, row) => sum + Buffer.byteLength(row.key) + Buffer.byteLength(JSON.stringify(row.value)), 0);
                const nextAfter = rows.at(-1)!.key;
                await db.importBatch(writes, { source: sourceId, after: nextAfter, items: nextItems, bytes: nextBytes }, options.signal,
                  source.name === 'thread-mailbox-v3' ? rows : rows.filter((row) => row.value['kind'] === 'delivery'));
                importedItems += rows.length;
                importedBytes += nextBytes - bytes;
                items = nextItems;
                bytes = nextBytes;
                after = nextAfter;
                await update({ ...manifest.status, currentSource: sourceId, currentKey: after, progress: { items: importedItems, bytes: importedBytes } });
              }
              if (source.name !== 'thread-mailbox-v3') {
                const messageMarker = `@legacy-delivery/${sourceId}`;
                const messagePoint = await db.checkpoint(messageMarker);
                let cursor = messagePoint === undefined ? undefined : JSON.parse(messagePoint.after) as LegacyDeliveryCursor;
                let accepted = messagePoint?.items ?? 0;
                for (;;) {
                  await this.checkCancelled(options.signal, manifest.status.migrationId!);
                  const page = await db.legacyDeliveries(sourceId, cursor, options.signal);
                  if (page.rows.length === 0) break;
                  const rows = page.rows.map(({ key }) => reader.sourceGet(key) ?? { key, value: { kind: 'missing' }, expireAt: 0 });
                  const writes = await convertLegacyMailboxRows(rows, reader);
                  cursor = page.rows.at(-1)!;
                  accepted += page.rows.length;
                  await db.importBatch(writes, { source: messageMarker, after: JSON.stringify(cursor), items: accepted, bytes: 0 }, options.signal);
                  await update({ ...manifest.status, currentKey: cursor.key });
                }
                const idemMarker = `@legacy-idempotency/${sourceId}`;
                const idemPoint = await db.checkpoint(idemMarker);
                let idemAfter = idemPoint?.after ?? 'idem/';
                let idemItems = idemPoint?.items ?? 0;
                for (;;) {
                  await this.checkCancelled(options.signal, manifest.status.migrationId!);
                  const rows: MailboxRow[] = [];
                  for (const entry of legacy.store.scan({ gt: idemAfter, count: 256 })) rows.push({ key: entry.key.toString('utf8'), value: legacy.codec.decode(entry.value), expireAt: entry.expireAt });
                  if (rows.length === 0) break;
                  const writes = await convertLegacyMailboxRows(rows.filter((row) => row.value['kind'] === 'idempotency'), reader);
                  idemAfter = rows.at(-1)!.key;
                  idemItems += rows.length;
                  await db.importBatch(writes, { source: idemMarker, after: idemAfter, items: idemItems, bytes: 0 }, options.signal);
                }
              }
            } finally { await legacy.close(); }
          }
          await markSource(source.name, 'imported');
          await update(manifest.status, { importedSources: [...new Set([...manifest.importedSources, source.name])] });
        }
        await update({ ...manifest.status, phase: 'verifying', currentSource: undefined, currentKey: undefined,
          progress: { items: importedItems, totalItems: importedItems, bytes: importedBytes, totalBytes: importedBytes } });
        await preparePeerHistory(db, options.signal);
        await db.verify(options.signal);
        await verifyFrozenSources(this.homeDir, manifest, locks, true);
        await update({ ...manifest.status, sources: manifest.status.sources.map((source) => source.exists ? { ...source, stage: 'verified' } : source) });
        await db.metadata('migrationReady', manifest.status.migrationId!);
        await this.checkCancelled(options.signal, manifest.status.migrationId!);
        this.switching = true;
        await update({ ...manifest.status, phase: 'switching', canCancel: false, canRollback: true }, { cutoverStarted: true });
      }
      this.switching = true;
      const id = manifest.status.migrationId!;
      if (await db.metadata('migrationReady') !== id) throw new Error('Interrupted mailbox cutover has no verified SQLite import; keep the original sources and use a compatible 0.5.x repair tool');
      await db.discardArchive();
      await mkdir(join(recoveryPath(this.homeDir, id), 'originals'), { recursive: true, mode: 0o700 });
      for (const name of MAILBOX_SOURCE_NAMES) {
        const path = join(this.homeDir, 'store', name);
        const original = join(recoveryPath(this.homeDir, id), 'originals', name);
        if (await isFence(path, id)) continue;
        const kind = await pathKind(path);
        if (kind === 'directory') {
          if (!manifest.status.sources.some((source) => source.name === name && source.exists)) throw new Error(`A new legacy writer created ${name} after the import; its data was preserved and cutover stopped`);
          if (await pathKind(original) !== 'missing') throw new Error(`A new legacy writer recreated ${name} during an interrupted cutover. Both copies were preserved; stop the writer and reconcile before retrying.`);
          await rename(path, original);
          relocateLocks(locks, path, original);
        } else if (kind === 'file') throw new Error(`Unrecognized legacy mailbox fence at ${name}`);
        await installMailboxFence(path, id);
        await update({ ...manifest.status }, { fencedSources: [...new Set([...manifest.fencedSources, name])] });
      }
      await db.metadata('authority', 'sqlite');
      const authority: MailboxAuthority = { version: 1, backend: 'sqlite', migrationId: id, database: `mailbox-${id}.sqlite`, publishedAt: Date.now() };
      await saveJson(authorityPath(this.homeDir), authority);
      await update({ ...manifest.status, authority: 'sqlite', phase: 'complete', state: 'complete', canCancel: false, canRollback: true });
      return manifest.status;
    } catch (error) {
      if (manifest === undefined) throw error;
      const cancelled = !this.switching && (options.signal?.aborted || (error as Error).name === 'AbortError');
      const code = (error as { code?: unknown }).code;
      const status: MailboxMigrationStatus = { ...manifest.status, state: cancelled ? 'cancelled' : 'failed', canCancel: false,
        failure: cancelled ? undefined : { code: typeof code === 'string' ? code : 'mailbox.migration_failed', message: error instanceof Error ? error.message : String(error), source: manifest.status.currentSource, key: error instanceof LegacyMailboxImportError ? error.key : manifest.status.currentKey } };
      await update(status);
      return status;
    } finally {
      await closeAll([() => db?.close(), ...locks.reverse().map((held) => () => releaseSourceLock(held)), () => maintenance.close(), () => lease.release()]);
    }
  }

  private async checkCancelled(signal: AbortSignal | undefined, migrationId: string): Promise<void> {
    if (this.switching) return;
    signal?.throwIfAborted();
    const request = await readJson<{ migrationId?: string }>(join(mailboxDirectory(this.homeDir), 'cancel.json'));
    if (request?.migrationId === migrationId) throw new DOMException('Mailbox migration cancelled', 'AbortError');
  }
}

interface RecoveryCleanupMarker {
  readonly version: 1;
  readonly migrationId: string;
  readonly backupDestination: string;
  readonly mailboxOwner: MailboxOwner;
  readonly completed?: boolean;
}

async function recoveryFiles(root: string, allowLocks = false): Promise<readonly { readonly relative: string; readonly bytes: number; readonly mtimeMs: number }[]> {
  const result: { relative: string; bytes: number; mtimeMs: number }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const file = join(directory, name);
      const info = await lstat(file);
      if (info.isDirectory()) await visit(file);
      else if (info.isFile() && (name === 'db.lock' || name.startsWith('db.lock.')) && allowLocks) continue;
      else if (info.isFile()) result.push({ relative: relative(root, file), bytes: info.size, mtimeMs: info.mtimeMs });
      else throw new Error(`Recovery copy contains a link or unknown file: ${file}`);
    }
  };
  await visit(root);
  return result.toSorted((left, right) => left.relative.localeCompare(right.relative));
}

async function sameFileBytes(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([open(left, 'r'), open(right, 'r')]);
  try {
    const l = Buffer.allocUnsafe(1024 * 1024);
    const r = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const [first, second] = await Promise.all([a.read(l, 0, l.length), b.read(r, 0, r.length)]);
      if (first.bytesRead !== second.bytesRead || !l.subarray(0, first.bytesRead).equals(r.subarray(0, second.bytesRead))) return false;
      if (first.bytesRead === 0) return true;
    }
  } finally { await Promise.all([a.close(), b.close()]); }
}

async function assertIndependentBackupPath(homeDir: string, destination: string, mustExist = false): Promise<void> {
  const inside = (root: string, path: string): boolean => {
    const position = relative(root, path);
    return position === '' || !position.startsWith('..') && !isAbsolute(position);
  };
  const home = await realpath(homeDir);
  let existing = dirname(destination);
  let projected: string;
  for (;;) {
    try { projected = resolve(await realpath(existing), relative(existing, destination)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (inside(homeDir, destination) || inside(home, projected)) throw new Error('Place the independent SQLite backup outside this Kiki home (including linked directories)');
  if (mustExist) {
    if (await pathKind(destination) !== 'file' || inside(home, await realpath(destination))) {
      throw new Error('Independent SQLite backup moved or links into this Kiki home; retain the recovery copies');
    }
  }
}

async function assertVerifiedBackupUnchanged(homeDir: string, destination: string, verified: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  await assertIndependentBackupPath(homeDir, destination, true);
  const current = await lstat(destination);
  if (!current.isFile() || current.dev !== verified.dev || current.ino !== verified.ino || current.size !== verified.size ||
    current.mtimeMs !== verified.mtimeMs || current.ctimeMs !== verified.ctimeMs) {
    throw new Error('Independent SQLite backup changed after verification; retain the recovery copies');
  }
}

async function recoveryCleanupPlan(manifest: MigrationManifest, recovery: string, backupDestination?: string, resuming = false): Promise<MailboxRecoveryCleanupPlan> {
  const remove: { path: string; bytes: number }[] = [];
  const preserve: { path: string; bytes: number }[] = [];
  for (const source of manifest.status.sources) {
    if (!source.exists) continue;
    const original = join(recovery, 'originals', source.name);
    const copy = join(recovery, 'sources', source.name);
    if (await pathKind(original) !== 'directory') throw new Error(`Frozen original source is missing: ${original}`);
    const expected = manifest.files.filter((entry) => entry.source === source.name).toSorted((a, b) => a.relative.localeCompare(b.relative));
    const originals = await recoveryFiles(original, true);
    if (JSON.stringify(originals.map(({ relative: path, bytes, mtimeMs }) => ({ path, bytes, mtimeMs }))) !==
      JSON.stringify(expected.map(({ relative: path, bytes, mtimeMs }) => ({ path, bytes, mtimeMs })))) {
      throw new Error(`Frozen original source changed; preserve recovery: ${original}`);
    }
    preserve.push({ path: original, bytes: originals.reduce((sum, item) => sum + item.bytes, 0) });
    const kind = await pathKind(copy);
    if (kind === 'missing' && resuming) continue;
    if (kind !== 'directory') throw new Error(`Frozen backup copy is missing or changed: ${copy}`);
    const remaining = await recoveryFiles(copy);
    if (!resuming && remaining.length !== expected.length) throw new Error(`Frozen backup inventory differs from the original: ${copy}`);
    for (const file of remaining) {
      const originalFile = expected.find((entry) => entry.relative === file.relative);
      if (originalFile === undefined || originalFile.bytes !== file.bytes || !await sameFileBytes(join(original, file.relative), join(copy, file.relative))) {
        throw new Error(`Frozen backup differs from original; preserve both: ${join(copy, file.relative)}`);
      }
    }
    remove.push({ path: copy, bytes: remaining.reduce((sum, item) => sum + item.bytes, 0) });
  }
  return { migrationId: manifest.status.migrationId!, remove, preserve,
    removeBytes: remove.reduce((sum, item) => sum + item.bytes, 0), preserveBytes: preserve.reduce((sum, item) => sum + item.bytes, 0), backupDestination, completed: false };
}

async function removeRecoveryFiles(root: string, original: string, files: readonly string[], checkBackup: () => Promise<void>): Promise<void> {
  for (const file of files) {
    const path = join(root, file);
    if (await pathKind(path) === 'missing') continue;
    const before = await lstat(path);
    const preserved = await lstat(join(original, file));
    if (!before.isFile() || !preserved.isFile() || before.size !== preserved.size || !await sameFileBytes(path, join(original, file))) {
      throw new Error(`Frozen backup changed before deletion; preserve remaining recovery copies: ${path}`);
    }
    const after = await lstat(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Frozen backup changed before deletion; preserve remaining recovery copies: ${path}`);
    }
    await checkBackup();
    await unlink(path);
  }
  const prune = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) if (await pathKind(join(directory, entry)) === 'directory') await prune(join(directory, entry));
    await rmdir(directory);
  };
  await prune(root);
}

async function closeAll(actions: readonly (() => Promise<unknown> | undefined)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
  if (errors.length > 0) throw new AggregateError(errors, 'Mailbox resources did not all close cleanly');
}

function initialStatus(homeDir: string, sources: readonly MailboxMigrationSource[]): MailboxMigrationStatus {
  return { schemaVersion: 1, homeDir, authority: 'legacy', phase: 'detecting', state: 'ready', sources, progress: { items: 0, bytes: 0 },
    canCancel: false, canRollback: false, minimumReaderVersion: '0.5.0', legacyImportRemovedVersion: '0.6.0' };
}

function newManifest(homeDir: string, sources: readonly MailboxMigrationSource[]): MigrationManifest {
  const migrationId = randomUUID();
  return { version: 1, status: { ...initialStatus(homeDir, sources), migrationId,
    backupPath: join(recoveryPath(homeDir, migrationId), 'sources'), databasePath: join(mailboxDirectory(homeDir), `mailbox-${migrationId}.sqlite`) },
    files: [], copiedFiles: 0, importedSources: [], fencedSources: [] };
}

function rollbackAfterWrites(): Error { return new Error('SQLite has accepted new canonical writes. Keep SQLite authority and use a compatible 0.5.x repair version or restore a consistent SQLite backup.'); }

async function acquireSourceLocks(homeDir: string, manifest: MigrationManifest, locks: FrozenLock[], checkCancelled?: () => Promise<void>): Promise<string | undefined> {
  for (const source of manifest.status.sources) {
    if (!source.exists) continue;
    let root = join(homeDir, 'store', source.name);
    const original = join(recoveryPath(homeDir, manifest.status.migrationId!), 'originals', source.name);
    if (await pathKind(original) === 'directory') root = original;
    const directories = source.name === 'thread-mailbox-v3' ? await shardDirectories(root) : [root];
    for (const directory of directories) {
      await checkCancelled?.();
      const lock = new LockFile(join(directory, 'db.lock'));
      if (!await lock.acquire()) return lock.path;
      locks.push({ lock, token: lock.heldToken!, originalPath: lock.path });
    }
  }
  return undefined;
}

function relocateLocks(locks: readonly FrozenLock[], source: string, destination: string): void {
  for (const held of locks) if (held.originalPath.startsWith(`${source}\\`) || held.originalPath.startsWith(`${source}/`)) held.originalPath = join(destination, relative(source, held.originalPath));
}

async function releaseSourceLock(held: FrozenLock): Promise<void> {
  if (held.originalPath === held.lock.path) { await held.lock.release(); return; }
  held.lock.releaseSync();
  if ((await readJson<{ token?: string }>(held.originalPath))?.token === held.token) await unlink(held.originalPath);
}

async function verifyFrozenSources(homeDir: string, manifest: MigrationManifest, locks: readonly FrozenLock[], compareFiles: boolean): Promise<void> {
  let expectedLocks = 0;
  for (const source of manifest.status.sources) {
    const path = join(homeDir, 'store', source.name);
    const original = join(recoveryPath(homeDir, manifest.status.migrationId!), 'originals', source.name);
    const hasOriginal = await pathKind(original) === 'directory';
    const root = hasOriginal ? original : path;
    if (!source.exists) {
      if (await pathKind(path) === 'directory' || hasOriginal) throw new Error(`A legacy source appeared while frozen: ${source.name}`);
      continue;
    }
    const directories = source.name === 'thread-mailbox-v3' ? await shardDirectories(root) : [root];
    for (const directory of directories) {
      const held = locks.find((entry) => entry.originalPath === join(directory, 'db.lock'));
      if (held === undefined || (await readJson<{ token?: string }>(held.originalPath))?.token !== held.token) throw new Error(`Canonical source writer lock changed: ${directory}`);
      expectedLocks++;
    }
    if (compareFiles && JSON.stringify(await inventorySource(root, source.name)) !== JSON.stringify(manifest.files.filter((file) => file.source === source.name))) throw new Error(`Canonical source changed while frozen: ${source.name}; the source, backup and SQLite import were preserved`);
  }
  if (expectedLocks !== locks.length) throw new Error('Canonical mailbox topology changed while acquiring writer locks');
}

async function shardDirectories(root: string): Promise<readonly string[]> {
  const meta = await readJson<{ version: number; shardCount: number; valueCodec: string }>(join(root, 'cluster.meta.json'));
  if (meta === undefined || meta.version !== 1 || !Number.isInteger(meta.shardCount) || meta.shardCount < 1 || meta.shardCount > 1024 || meta.valueCodec !== 'json') throw new Error(`Invalid canonical mailbox topology at ${root}`);
  const result = Array.from({ length: meta.shardCount }, (_, shard) => join(root, shardDirName(shard, meta.shardCount)));
  for (const directory of result) if (await pathKind(directory) !== 'directory') throw new Error(`Missing canonical mailbox shard at ${directory}`);
  return result;
}

async function preparePeerHistory(db: CanonicalMailboxDatabase<Document>, signal?: AbortSignal): Promise<void> {
  const point = await db.checkpoint('@peer-history');
  let after = point?.after;
  let items = point?.items ?? 0;
  for (;;) {
    const rows = await db.page('t/', after, 128, 'message', signal);
    if (rows.length === 0) break;
    const writes = rows.flatMap((row) => mailboxPeerIndexWrites(row.key.slice(0, row.key.indexOf('/message/')), row.value['message'] as AcceptedThreadMessage)
      .map((op) => op.op === 'set' ? { ...op, expireAt: row.expireAt, onlyIfMissing: true } : op));
    after = rows.at(-1)!.key;
    items += rows.length;
    await db.importBatch(writes, { source: '@peer-history', after, items, bytes: 0 }, signal);
  }
  let afterMeta: string | undefined;
  for (;;) {
    const rows = await db.page('t/', afterMeta, 128, 'target_meta', signal);
    if (rows.length === 0) break;
    const writes: MailboxWrite<Document>[] = rows.filter((row) => row.value['activityEpoch'] === '').map((row) => ({ op: 'set', key: row.key, value: { ...row.value, activityEpoch: randomUUID() }, expireAt: row.expireAt }));
    afterMeta = rows.at(-1)!.key;
    await db.importBatch(writes, { source: '@target-meta', after: afterMeta, items: 0, bytes: 0 }, signal);
  }
  await db.metadata('peerHistoryComplete', true);
}

async function copyFileBounded(source: string, destination: string, progress: (bytes: number) => Promise<void>): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.copying`;
  const input = await open(source, 'r');
  const output = await open(temporary, 'w', 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const read = await input.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead === 0) break;
      let written = 0;
      while (written < read.bytesRead) written += (await output.write(buffer, written, read.bytesRead - written)).bytesWritten;
      offset += read.bytesRead;
      await progress(offset);
    }
    if ((await lstat(source)).size !== offset) throw new Error(`Mailbox source changed during backup: ${source}`);
    await output.sync();
  } finally { await input.close(); await output.close(); }
  await rename(temporary, destination);
  await syncDirectory(dirname(destination));
}

function createMaintenanceRuntime(homeDir: string): MaintenanceRuntime {
  const bootstrap: IBootstrapService = {
    _serviceBrand: undefined, platform: process.platform, arch: process.arch, cwd: homeDir, osHomeDir: homedir(), homeDir,
    configPath: join(homeDir, 'config.toml'), configReadOnly: true, userAgentProfileHomeDir: homeDir, modelAccountHomeDir: homeDir, credentialsHomeDir: homeDir,
    clientIdentity: { productName: 'kiki-storage-migration', version: '0.5.0', platform: process.platform }, args: { requestHeaders: {} },
    sessionsDir: join(homeDir, 'sessions'), blobsDir: join(homeDir, 'blobs'), storeDir: join(homeDir, 'store'), cacheDir: join(homeDir, 'cache'), logsDir: join(homeDir, 'logs'),
    getEnv: () => undefined, scope: (name) => name, configKey: 'config.toml',
  };
  const container = new InstantiationService(new ServiceCollection([IBootstrapService, bootstrap], [IHomeRuntimeService, new SyncDescriptor(HomeRuntimeHostService)]), true);
  const runtime = container.invokeFunction((accessor) => accessor.get(IHomeRuntimeService));
  const registration = runtime.registerMethod('threadMailbox.migrationFence', async () => null);
  return { runtime, close: async () => { await registration.dispose(); await runtime.close(); await container.dispose(); } };
}
