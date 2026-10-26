import { z } from 'zod';

export const mailboxMigrationPhaseSchema = z.enum(['detecting', 'waiting_for_writers', 'backing_up', 'importing', 'verifying', 'switching', 'rolling_back', 'complete']);
export const mailboxMigrationProgressSchema = z.object({ items: z.number().nonnegative(), totalItems: z.number().nonnegative().optional(), bytes: z.number().nonnegative(), totalBytes: z.number().nonnegative().optional() });
export const mailboxMigrationSourceSchema = z.object({ name: z.enum(['thread-mailbox-v3', 'thread-mailbox-v1', 'agent-collaboration-mailbox-v2']), exists: z.boolean(), bytes: z.number().nonnegative().optional() });
export const mailboxMigrationFailureSchema = z.object({ code: z.string(), message: z.string(), source: z.string().optional(), key: z.string().optional() });
export const mailboxMigrationStatusSchema = z.object({
  schemaVersion: z.literal(1), homeDir: z.string(), migrationId: z.string().optional(), authority: z.enum(['legacy', 'sqlite']),
  phase: mailboxMigrationPhaseSchema, state: z.enum(['ready', 'running', 'cancelling', 'waiting', 'cancelled', 'failed', 'complete']),
  sources: z.array(mailboxMigrationSourceSchema).readonly(), progress: mailboxMigrationProgressSchema,
  currentSource: z.string().optional(), currentKey: z.string().optional(), backupPath: z.string().optional(), databasePath: z.string().optional(),
  writer: z.object({ hostId: z.string().optional(), epoch: z.number().optional(), lockPath: z.string().optional() }).optional(),
  failure: mailboxMigrationFailureSchema.optional(), warning: z.object({ code: z.string(), message: z.string() }).optional(), canCancel: z.boolean(), canRollback: z.boolean(),
  minimumReaderVersion: z.literal('0.5.0'), legacyImportRemovedVersion: z.literal('0.6.0'),
});
export const storageMigrationActionSchema = z.object({ action: z.enum(['migrate', 'cancel', 'rollback', 'start', 'retry_cleanup']) }).strict();
export const storageMigrationViewSchema = z.object({
  schemaVersion: z.literal(1), mode: z.enum(['maintenance', 'normal']), status: mailboxMigrationStatusSchema,
  actions: z.array(z.enum(['migrate', 'cancel', 'rollback', 'start', 'retry_cleanup'])),
  transition: z.object({ state: z.enum(['idle', 'starting', 'failed']), failure: mailboxMigrationFailureSchema.optional(), cleanupPending: z.boolean().optional(), cleanupFailure: mailboxMigrationFailureSchema.optional() }),
  operationFailure: mailboxMigrationFailureSchema.optional(),
});
export type MailboxMigrationPhase = z.infer<typeof mailboxMigrationPhaseSchema>;
export type MailboxMigrationProgress = z.infer<typeof mailboxMigrationProgressSchema>;
export type MailboxMigrationSource = z.infer<typeof mailboxMigrationSourceSchema>;
export type MailboxMigrationStatus = z.infer<typeof mailboxMigrationStatusSchema>;
export type StorageMigrationAction = z.infer<typeof storageMigrationActionSchema>;
export type StorageMigrationView = z.infer<typeof storageMigrationViewSchema>;
