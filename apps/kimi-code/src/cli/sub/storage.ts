import { createMailboxMigrationService, type MailboxMigrationService, type MailboxMigrationStatus } from '@kiki/node-sdk';
import type { Command } from 'commander';

import { resolveKikiHome } from '#/kiki/home';

interface StorageCommandOptions { readonly home?: string; readonly json?: boolean; }

const phases: Record<MailboxMigrationStatus['phase'], string> = {
  detecting: 'Detecting mailbox storage', waiting_for_writers: 'Waiting for writers to exit', backing_up: 'Backing up the original mailbox',
  importing: 'Importing mailbox records', verifying: 'Verifying the imported mailbox', switching: 'Switching mailbox authority', rolling_back: 'Restoring the original mailbox', complete: 'Mailbox upgrade complete',
};

export function registerStorageCommand(program: Command): void {
  const storage = program.command('storage').description('Upgrade, inspect and back up this home’s canonical mailbox.');
  const command = (name: string, description: string): Command => storage.command(name).description(description)
    .option('--home <dir>', 'Kiki home directory.').option('--json', 'Print typed status and progress as newline-delimited JSON.');
  command('status', 'Show mailbox authority, upgrade progress and recovery actions.').action((options: StorageCommandOptions) => run(options, async (service) => service.status()));
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
