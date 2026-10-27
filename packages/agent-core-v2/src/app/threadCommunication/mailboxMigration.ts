import type { MailboxMigrationStatus } from '@kiki/protocol';

export type { MailboxMigrationPhase, MailboxMigrationProgress, MailboxMigrationSource, MailboxMigrationStatus } from '@kiki/protocol';

export interface MailboxMigrationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (status: MailboxMigrationStatus) => void;
}

export interface MailboxRecoveryCleanupPlan {
  readonly migrationId: string;
  readonly remove: readonly { readonly path: string; readonly bytes: number }[];
  readonly preserve: readonly { readonly path: string; readonly bytes: number }[];
  readonly removeBytes: number;
  readonly preserveBytes: number;
  readonly backupDestination?: string;
  readonly completed: boolean;
}

export interface MailboxMigrationService {
  status(): Promise<MailboxMigrationStatus>;
  migrate(options?: MailboxMigrationOptions): Promise<MailboxMigrationStatus>;
  cancel(): Promise<MailboxMigrationStatus>;
  rollback(options?: MailboxMigrationOptions): Promise<MailboxMigrationStatus>;
  backup(destination: string, options?: MailboxMigrationOptions): Promise<{ readonly destination: string; readonly items: number; readonly bytes: number }>;
  cleanupRecovery(options?: { readonly confirm?: boolean; readonly backupDestination?: string }): Promise<MailboxRecoveryCleanupPlan>;
  close(): Promise<void>;
}
