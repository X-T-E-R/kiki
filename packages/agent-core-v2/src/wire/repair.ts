import type { ILogService } from '#/_base/log/log';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { openPinnedLogicalRead } from '#/persistence/coldSegmentLog';
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

export const WIRE_JOURNAL_BACKUP_RETENTION = 5;

export function wireJournalBackupKey(key: string, generation = 0): string {
  return generation === 0 ? `${key}.bak` : `${key}.bak.${generation}`;
}

function wireJournalBackupGeneration(key: string, candidate: string): number | undefined {
  const base = wireJournalBackupKey(key);
  if (candidate === base) return 0;
  if (!candidate.startsWith(`${base}.`)) return undefined;
  const suffix = candidate.slice(base.length + 1);
  if (!/^[1-9]\d*$/.test(suffix)) return undefined;
  const generation = Number(suffix);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

async function listWireJournalBackups(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<number[]> {
  const generations: number[] = [];
  for (const candidate of await storage.list(scope, wireJournalBackupKey(key))) {
    const generation = wireJournalBackupGeneration(key, candidate);
    if (generation !== undefined) generations.push(generation);
  }
  return generations.toSorted((a, b) => a - b);
}

async function sameBytes(
  left: AsyncIterable<Uint8Array>,
  right: AsyncIterable<Uint8Array>,
): Promise<boolean> {
  const a = left[Symbol.asyncIterator]();
  const b = right[Symbol.asyncIterator]();
  let aChunk: Uint8Array = new Uint8Array(0);
  let bChunk: Uint8Array = new Uint8Array(0);
  let aDone = false;
  let bDone = false;
  try {
    for (;;) {
      if (aChunk.length === 0 && !aDone) {
        const next = await a.next();
        if (next.done) aDone = true;
        else aChunk = next.value;
        continue;
      }
      if (bChunk.length === 0 && !bDone) {
        const next = await b.next();
        if (next.done) bDone = true;
        else bChunk = next.value;
        continue;
      }
      if (aChunk.length === 0 || bChunk.length === 0) return aChunk.length === bChunk.length;
      const length = Math.min(aChunk.length, bChunk.length);
      for (let i = 0; i < length; i++) {
        if (aChunk[i] !== bChunk[i]) return false;
      }
      aChunk = aChunk.subarray(length);
      bChunk = bChunk.subarray(length);
    }
  } finally {
    await a.return?.();
    await b.return?.();
  }
}

async function pruneWireJournalBackups(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  generations: readonly number[],
): Promise<void> {
  const excess = generations.length - WIRE_JOURNAL_BACKUP_RETENTION;
  for (const generation of generations.slice(0, Math.max(0, excess))) {
    await storage.delete(scope, wireJournalBackupKey(key, generation));
  }
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
  let backupKey: string | undefined;
  let backupGenerations: number[] = [];
  try {
    const pinned = await openPinnedLogicalRead(storage, scope, key);
    try {
      if (pinned.size !== undefined) {
        const original = async function* () {
          let lines = 0;
          let hasContent = false;
          for await (const chunk of pinned.read()) {
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
        const existing = await listWireJournalBackups(storage, scope, key);
        const latest = existing.at(-1);
        const latestKey = latest === undefined ? undefined : wireJournalBackupKey(key, latest);
        if (
          latestKey !== undefined
          && (await storage.size(scope, latestKey)) === pinned.size
          && (await sameBytes(original(), storage.readStream(scope, latestKey)))
        ) {
          backupKey = latestKey;
        } else {
          const generation = latest === undefined ? 0 : latest + 1;
          backupKey = wireJournalBackupKey(key, generation);
          await storage.writeStream(scope, backupKey, original(), { atomic: true });
          backupCreated = true;
          backupGenerations = [...existing, generation];
        }
      }
    } finally {
      pinned.close();
    }
    await appendLog.rewrite(scope, key, records);
  } catch (error) {
    outcome = 'failed';
    repairError = error;
  }
  let pruneError: unknown;
  if (backupGenerations.length > WIRE_JOURNAL_BACKUP_RETENTION) {
    try {
      await pruneWireJournalBackups(storage, scope, key, backupGenerations);
    } catch (error) {
      pruneError = error;
    }
  }
  log.warn('corrupted wire journal truncated to its valid prefix', {
    scope,
    key,
    lineNumber: truncation.lineNumber,
    reason: truncation.reason,
    outcome,
    droppedCount,
    backupCreated,
    backupKey,
    error: repairError instanceof Error ? repairError.message : undefined,
    pruneError: pruneError instanceof Error ? pruneError.message : undefined,
  });
  telemetry.track2('wire_repair', {
    kind: truncation.reason,
    outcome,
    dropped_count: droppedCount,
    backup_created: backupCreated,
  });
  return outcome;
}
