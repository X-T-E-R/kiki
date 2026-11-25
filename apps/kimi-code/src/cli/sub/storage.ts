import {
  createMailboxMigrationService,
  createStorageGovernanceService,
  type MailboxMigrationService,
  type MailboxMigrationStatus,
  type StorageCleanRetiredReport,
  type StorageDeduplicateReport,
  type StorageSlimCheckpointsReport,
  type StorageStatusReport,
} from '@kiki/node-sdk';
import type { Command } from 'commander';

import { resolveKikiHome } from '#/kiki/home';

interface StorageCommandOptions {
  readonly home?: string;
  readonly json?: boolean;
  readonly confirm?: boolean;
  readonly backup?: string;
  readonly apply?: boolean;
  readonly purgeQuarantine?: boolean;
  readonly rollback?: string;
  readonly minQuarantineDays?: string;
  readonly minAgeDays?: string;
  readonly rehydrate?: boolean;
}

const phases: Record<MailboxMigrationStatus['phase'], string> = {
  detecting: 'Detecting mailbox storage',
  waiting_for_writers: 'Waiting for writers to exit',
  backing_up: 'Backing up the original mailbox',
  importing: 'Importing mailbox records',
  verifying: 'Verifying the imported mailbox',
  switching: 'Switching mailbox authority',
  rolling_back: 'Restoring the original mailbox',
  complete: 'Mailbox upgrade complete',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function registerStorageCommand(program: Command): void {
  const storage = program.command('storage').description('Inspect, deduplicate, clean retired indexes, slim checkpoints, and manage mailbox storage.');
  const command = (name: string, description: string): Command => storage.command(name).description(description)
    .option('--home <dir>', 'Kiki home directory.')
    .option('--json', 'Print typed status and progress as newline-delimited JSON.');

  command('status', 'Show mailbox authority and read-only storage breakdown (sessions, blobs, checkpoints, cache, retired, workspaces).')
    .action(async (options: StorageCommandOptions) => {
      const homeDir = resolveKikiHome(options.home);
      const mailbox = createMailboxMigrationService(homeDir);
      const governance = createStorageGovernanceService(homeDir);
      try {
        const [mailboxStatus, storageReport] = await Promise.all([
          mailbox.status(),
          governance.status(),
        ]);
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ...mailboxStatus, storage: storageReport })}\n`);
        } else {
          printStatus(mailboxStatus, false);
          printStorageBreakdown(storageReport);
        }
        if (mailboxStatus.state === 'failed') process.exitCode = 1;
        else if (mailboxStatus.state === 'waiting') process.exitCode = 2;
      } finally {
        await mailbox.close();
      }
    });

  command('deduplicate', 'Plan or apply safe raw-byte CAS deduplication for historical agents/*/blobs (dry-run by default).')
    .option('--apply', 'Commit verified deduplication to global blobs/v2 CAS (default is dry-run plan only).')
    .action(async (options: StorageCommandOptions) => {
      const homeDir = resolveKikiHome(options.home);
      const report = await createStorageGovernanceService(homeDir).deduplicate({ apply: options.apply === true });
      printDeduplicateReport(report, options.json === true);
    });

  command('clean-retired', 'Plan or quarantine allowlisted retired derived indexes after successor readiness verification (dry-run by default).')
    .option('--apply', 'Move verified retired roots to same-volume quarantine with a 14-day rollback manifest.')
    .option('--purge-quarantine', 'Purge quarantined retired roots older than the retention window.')
    .option('--rollback <runId>', 'Restore a quarantined retired-index run back to its original paths.')
    .option('--min-quarantine-days <days>', 'Minimum quarantine age in days before purging (default: 14).')
    .action(async (options: StorageCommandOptions) => {
      const homeDir = resolveKikiHome(options.home);
      const minQuarantineAgeDays = options.minQuarantineDays === undefined ? undefined : Number(options.minQuarantineDays);
      const report = await createStorageGovernanceService(homeDir).cleanRetired({
        apply: options.apply === true,
        purgeQuarantine: options.purgeQuarantine === true,
        rollbackRunId: options.rollback,
        minQuarantineAgeDays: Number.isFinite(minQuarantineAgeDays) ? minQuarantineAgeDays : undefined,
      });
      printCleanRetiredReport(report, options.json === true);
    });

  command('slim-checkpoints', 'Plan or apply lossless archival slimming for cold finished non-main leaf replay-checkpoints (dry-run by default).')
    .option('--apply', 'Write verified cold-projection-v1.json + engine-v1.archive.zst and reclaim uncompressed engine-v1.')
    .option('--rehydrate', 'Restore byte-identical engine-v1 from slimmed archives.')
    .option('--min-age-days <days>', 'Minimum inactivity age in days (default: 30).')
    .action(async (options: StorageCommandOptions) => {
      const homeDir = resolveKikiHome(options.home);
      const minAgeDays = options.minAgeDays === undefined ? undefined : Number(options.minAgeDays);
      const report = await createStorageGovernanceService(homeDir).slimCheckpoints({
        apply: options.apply === true,
        rehydrate: options.rehydrate === true,
        minAgeDays: Number.isFinite(minAgeDays) ? minAgeDays : undefined,
      });
      printSlimCheckpointsReport(report, options.json === true);
    });

  command('migrate', 'Back up and upgrade the mailbox to SQLite; resume an interrupted upgrade.').action((options: StorageCommandOptions) => run(options, async (service, signal) => service.migrate({ signal, onProgress: (status) => printStatus(status, options.json === true) })));
  command('cancel', 'Stop an upgrade at the next committed batch; preserve its source and resume point.').action((options: StorageCommandOptions) => run(options, async (service) => service.cancel()));
  command('rollback', 'Restore the original mailbox only before SQLite has accepted new writes.').action((options: StorageCommandOptions) => run(options, async (service, signal) => service.rollback({ signal })));
  command('backup <destination>', 'Create and verify a consistent online SQLite mailbox backup.').action(async (destination: string, options: StorageCommandOptions) => {
    const service = createMailboxMigrationService(resolveKikiHome(options.home));
    try {
      const result = await service.backup(destination);
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Mailbox backup: ${result.destination}\n${result.items} records · ${result.bytes} bytes\n`);
    } finally { await service.close(); }
  });
  command('cleanup-recovery', 'Preview redundant frozen mailbox copies; remove only after verified SQLite backup.')
    .option('--backup <destination>', 'New independent SQLite backup outside this home (omit to resume a verified cleanup backup).')
    .option('--confirm', 'Create and verify the backup, then remove matching frozen copies.')
    .action(async (options: StorageCommandOptions) => {
      const service = createMailboxMigrationService(resolveKikiHome(options.home));
      try {
        const plan = await service.cleanupRecovery({ confirm: options.confirm === true, backupDestination: options.backup });
        if (options.json) process.stdout.write(`${JSON.stringify(plan)}\n`);
        else {
          process.stdout.write(`Matching frozen copies: ${plan.removeBytes} bytes · ${plan.completed ? 'cleanup complete' : 'dry run'}\n`);
          for (const item of plan.remove) process.stdout.write(`Remove ${item.path} · ${item.bytes} bytes\n`);
          for (const item of plan.preserve) process.stdout.write(`Keep ${item.path} · ${item.bytes} bytes (older legacy records remain recoverable)\n`);
          if (plan.backupDestination) process.stdout.write(`Independent SQLite backup: ${plan.backupDestination}\n`);
          if (!options.confirm && plan.removeBytes > 0) process.stdout.write('Stop all Kiki writers for this home, then use --backup <destination> --confirm to clean these copies.\n');
        }
      } finally { await service.close(); }
    });
}

async function run(options: StorageCommandOptions, operation: (service: MailboxMigrationService, signal: AbortSignal) => Promise<MailboxMigrationStatus>): Promise<void> {
  const service = createMailboxMigrationService(resolveKikiHome(options.home));
  const controller = new AbortController();
  const cancel = (): void => { controller.abort(new DOMException('Mailbox upgrade cancelled', 'AbortError')); };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const result = await operation(service, controller.signal);
    printStatus(result, options.json === true);
    if (result.state === 'failed') process.exitCode = 1;
    else if (result.state === 'waiting') process.exitCode = 2;
    else if (result.state === 'cancelled') process.exitCode = 130;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    await service.close();
  }
}

export function printStatus(status: MailboxMigrationStatus, json: boolean): void {
  if (json) { process.stdout.write(`${JSON.stringify(status)}\n`); return; }
  const progress = status.progress;
  const items = progress.totalItems === undefined ? `${progress.items} items` : `${progress.items}/${progress.totalItems} items`;
  const bytes = progress.totalBytes === undefined ? `${progress.bytes} bytes` : `${progress.bytes}/${progress.totalBytes} bytes`;
  process.stdout.write(`${phases[status.phase]} · ${status.state}\nHome: ${status.homeDir}\n${items} · ${bytes}\n`);
  if (status.backupPath !== undefined) process.stdout.write(`Original backup: ${status.backupPath}\n`);
  if (status.writer !== undefined) process.stdout.write('Close the other Kiki processes using this home, then run this command again.\n');
  if (status.state === 'cancelled') process.stdout.write('The original mailbox and committed import batches are preserved. Run storage migrate to resume.\n');
  if (status.failure !== undefined) process.stderr.write(`${status.failure.message}\n`);
}

function printStorageBreakdown(report: StorageStatusReport): void {
  process.stdout.write(
    `\nStorage breakdown (${report.homeDir}):\n` +
      `  sessions: ${formatBytes(report.sessions.total.physicalBytes)} physical (${formatBytes(report.sessions.total.logicalBytes)} logical, ${report.sessions.total.files} files)\n` +
      `  blobs/v2: ${formatBytes(report.blobs.physicalBytes)} (${report.blobs.files} objects)\n` +
      `  replay-checkpoints: ${report.replayCheckpoints.primaryCount} primary (${formatBytes(report.replayCheckpoints.primaryBytes)}), ${report.replayCheckpoints.slimmedCount} slimmed (${formatBytes(report.replayCheckpoints.slimmedBytes)})\n` +
      `  cache: ${formatBytes(report.cache.total.physicalBytes)} (plugin-media inputs ${formatBytes(report.cache.pluginMediaInputs.physicalBytes)}, staging ${formatBytes(report.cache.pluginMediaStaging.physicalBytes)}, previews ${formatBytes(report.cache.mediaPreviews.physicalBytes)})\n` +
      `  quarantine: ${formatBytes(report.quarantine.physicalBytes)} (${report.quarantine.files} files)\n` +
      `  workspaces (read-only, permanently excluded from cleanup): ${formatBytes(report.workspaces.totalBytes)} (${report.workspaces.totalFiles} files)\n`,
  );
  for (const item of report.retired) {
    if (!item.exists) continue;
    process.stdout.write(
      `  retired ${item.relativePath}: ${formatBytes(item.bytes)} (${item.files} files) · successor ${item.successorReady ? 'ready' : `not ready (${item.successorReason ?? 'unknown'})`}\n`,
    );
  }
}

function printDeduplicateReport(report: StorageDeduplicateReport, json: boolean): void {
  if (json) { process.stdout.write(`${JSON.stringify(report)}\n`); return; }
  process.stdout.write(
    `Blob deduplication (${report.applied ? 'applied' : 'dry run'}) · ${report.homeDir}\n` +
      `  scanned: ${report.scannedFiles} · candidates: ${report.candidateFiles} (${report.uniqueDigests} unique) · already deduped: ${report.alreadyDeduplicatedFiles} · excluded: ${report.excludedFiles} · skipped: ${report.skippedFiles}\n` +
      `  reclaimable: ${formatBytes(report.reclaimableBytes)} · reclaimed: ${formatBytes(report.reclaimedBytes)}\n`,
  );
  if (!report.applied && report.candidateFiles > 0) {
    process.stdout.write('Re-run with --apply to commit verified deduplication into blobs/v2.\n');
  }
}

function printCleanRetiredReport(report: StorageCleanRetiredReport, json: boolean): void {
  if (json) { process.stdout.write(`${JSON.stringify(report)}\n`); return; }
  process.stdout.write(
    `Retired index cleanup (${report.applied ? 'applied' : 'dry run'}) · ${report.homeDir}\n` +
      `  quarantined: ${formatBytes(report.quarantinedBytes)} · freed: ${formatBytes(report.freedBytes)} · restored: ${formatBytes(report.restoredBytes)}\n`,
  );
  for (const item of report.items) {
    if (item.status === 'absent') continue;
    process.stdout.write(`  ${item.relativePath}: ${item.status} (${formatBytes(item.bytes)}${item.reason ? `, ${item.reason}` : ''})\n`);
  }
  if (report.rollbackManifestPath !== undefined) {
    process.stdout.write(`  rollback manifest: ${report.rollbackManifestPath} (runId=${report.runId})\n`);
  }
}

function printSlimCheckpointsReport(report: StorageSlimCheckpointsReport, json: boolean): void {
  if (json) { process.stdout.write(`${JSON.stringify(report)}\n`); return; }
  process.stdout.write(
    `Cold leaf replay-checkpoints (${report.rehydrated ? 'rehydrate' : report.applied ? 'applied' : 'dry run'}, minAge=${report.minAgeDays}d) · ${report.homeDir}\n` +
      `  scanned: ${report.scannedCount} · eligible: ${report.eligibleCount} · slimmed: ${report.slimmedCount} · rehydrated: ${report.rehydratedCount} · skipped: ${report.skippedCount}\n` +
      `  reclaimed: ${formatBytes(report.reclaimedBytes)} · restored: ${formatBytes(report.restoredBytes)}\n`,
  );
}
