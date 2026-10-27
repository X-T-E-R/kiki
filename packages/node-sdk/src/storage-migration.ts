export { assertMailboxStartupReady } from '@kiki/agent-core-v2/persistence/backends/sqliteMailbox/authority';
export { createMailboxMigrationService } from '@kiki/agent-core-v2/persistence/backends/sqliteMailbox/migration';
export type {
  MailboxMigrationOptions,
  MailboxMigrationPhase,
  MailboxMigrationProgress,
  MailboxMigrationService,
  MailboxMigrationSource,
  MailboxMigrationStatus,
  MailboxRecoveryCleanupPlan,
} from '@kiki/agent-core-v2/app/threadCommunication/mailboxMigration';
