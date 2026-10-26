import type { MailboxMigrationStatus } from '@kiki/protocol';

export type { MailboxMigrationPhase, MailboxMigrationProgress, MailboxMigrationSource, MailboxMigrationStatus } from '@kiki/protocol';

export interface MailboxMigrationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (status: MailboxMigrationStatus) => void;
}

export interface MailboxMigrationService {
  status(): Promise<MailboxMigrationStatus>;
  migrate(options?: MailboxMigrationOptions): Promise<MailboxMigrationStatus>;
  cancel(): Promise<MailboxMigrationStatus>;
  rollback(options?: MailboxMigrationOptions): Promise<MailboxMigrationStatus>;
  backup(destination: string, options?: MailboxMigrationOptions): Promise<{ readonly destination: string; readonly items: number; readonly bytes: number }>;
  close(): Promise<void>;
}
