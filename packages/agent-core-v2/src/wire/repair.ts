import type { ILogService } from '#/_base/log/log';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type {
  AppendLogTruncation,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

export interface WireJournalRepairServices {
  readonly appendLog: IAppendLogStore;
  readonly storage: IFileSystemStorageService;
  readonly log: ILogService;
  readonly telemetry: ITelemetryService;
}

export function wireJournalBackupKey(key: string): string {
  return `${key}.bak`;
}

export async function repairWireJournal(
  services: WireJournalRepairServices,
  scope: string,
  key: string,
  records: readonly unknown[],
  truncation: AppendLogTruncation,
): Promise<'repaired' | 'failed'> {
  const { appendLog, storage, log, telemetry } = services;
  let backupCreated = false;
  let outcome: 'repaired' | 'failed' = 'repaired';
  let droppedCount = 0;
  let repairError: unknown;
  try {
    if ((await storage.size(scope, key)) !== undefined) {
      const backupKey = wireJournalBackupKey(key);
      let lines = 0;
      let hasContent = false;
      const original = async function* () {
        for await (const chunk of storage.readStream(scope, key)) {
          for (const byte of chunk) {
            if (byte === 0x0a) {
              lines++;
              hasContent = false;
            } else {
              hasContent = true;
            }
          }
          yield chunk;
        }
        droppedCount = Math.max(0, lines + Number(hasContent) - records.length);
      };
      if ((await storage.size(scope, backupKey)) === undefined) {
        await storage.writeStream(scope, backupKey, original(), { atomic: true });
        backupCreated = true;
      } else {
        for await (const _chunk of original()) {}
      }
    }
    await appendLog.rewrite(scope, key, records);
  } catch (error) {
    outcome = 'failed';
    repairError = error;
  }
  log.warn('corrupted wire journal truncated to its valid prefix', {
    scope,
    key,
    lineNumber: truncation.lineNumber,
    reason: truncation.reason,
    outcome,
    droppedCount,
    backupCreated,
    error: repairError instanceof Error ? repairError.message : undefined,
  });
  telemetry.track2('wire_repair', {
    kind: truncation.reason,
    outcome,
    dropped_count: droppedCount,
    backup_created: backupCreated,
  });
  return outcome;
}
