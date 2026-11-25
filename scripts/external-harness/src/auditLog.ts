import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AuditRecord } from './types';

export const AUDIT_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const AUDIT_TAIL_FRAME_RECORDS = 200;
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const HIGH_FREQ_FRAME_TYPES = new Set(['native_frame_received', 'native_frame_delivered']);

interface IndexedRecord {
  readonly order: number;
  readonly record: AuditRecord;
}

export interface ReadAuditOptions {
  readonly maxBytes?: number;
  readonly tailFrameLimit?: number;
  readonly repairTruncatedTail?: boolean;
  readonly warn?: (message: string) => void;
}

export async function readAuditFile(
  auditPath: string,
  options: ReadAuditOptions = {},
): Promise<AuditRecord[]> {
  const maxBytes = options.maxBytes ?? AUDIT_DEFAULT_MAX_BYTES;
  const tailFrameLimit = options.tailFrameLimit ?? AUDIT_TAIL_FRAME_RECORDS;
  const warn =
    options.warn ??
    ((message: string) => {
      process.stderr.write(`[agy-cli-acp] ${message}\n`);
    });

  const info = await stat(auditPath);
  const compactMode = info.size > maxBytes;

  const keptState: IndexedRecord[] = [];
  const keptFrames: IndexedRecord[] = [];
  const latestToolState = new Map<string, IndexedRecord>();
  let latestNativeUsage: IndexedRecord | undefined;
  let order = 0;

  let pendingMalformed:
    | { readonly error: unknown; readonly validByteOffset: number }
    | undefined;
  let validByteOffset = 0;
  let currentByteOffset = 0;
  let carry = '';
  let hadTruncatedTail = false;
  let truncateToOffset = info.size;

  const pushRecord = (record: AuditRecord): void => {
    const entry: IndexedRecord = { order: order++, record };
    if (compactMode) {
      if (HIGH_FREQ_FRAME_TYPES.has(record.type)) {
        keptFrames.push(entry);
        if (keptFrames.length > tailFrameLimit) {
          keptFrames.shift();
        }
        return;
      }
      if (record.type === 'tool_state' && typeof record['toolCallId'] === 'string') {
        latestToolState.set(record['toolCallId'], entry);
        return;
      }
      if (record.type === 'native_usage') {
        latestNativeUsage = entry;
        return;
      }
    }
    keptState.push(entry);
  };

  const processLine = (rawLine: string, lineBytes: number, terminatedByNewline: boolean): void => {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      if (pendingMalformed === undefined && terminatedByNewline) {
        validByteOffset = currentByteOffset + lineBytes;
      }
      currentByteOffset += lineBytes;
      return;
    }

    if (pendingMalformed !== undefined) {
      throw pendingMalformed.error;
    }

    let parsed: AuditRecord;
    try {
      parsed = JSON.parse(trimmed) as AuditRecord;
    } catch (error) {
      pendingMalformed = { error, validByteOffset };
      currentByteOffset += lineBytes;
      return;
    }

    pushRecord(parsed);
    currentByteOffset += lineBytes;
    validByteOffset = currentByteOffset;
  };

  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(auditPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    stream.on('data', (chunk: string | Buffer) => {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const combined = carry + text;
        const lines = combined.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line, Buffer.byteLength(line, 'utf8') + 1, true);
        }
      } catch (error) {
        stream.destroy();
        rejectStream(error);
      }
    });
    stream.on('error', (error) => {
      rejectStream(error);
    });
    stream.on('end', () => {
      try {
        const trimmedCarry = carry.trim();
        if (trimmedCarry.length > 0) {
          if (pendingMalformed !== undefined) {
            throw pendingMalformed.error;
          }
          try {
            const parsed = JSON.parse(trimmedCarry) as AuditRecord;
            pushRecord(parsed);
            hadTruncatedTail = true;
            truncateToOffset = info.size;
          } catch {
            hadTruncatedTail = true;
            truncateToOffset = validByteOffset;
            warn(`Ignoring incomplete trailing audit record in ${auditPath}`);
          }
        } else if (pendingMalformed !== undefined) {
          hadTruncatedTail = true;
          truncateToOffset = pendingMalformed.validByteOffset;
          warn(`Ignoring malformed trailing audit record in ${auditPath}`);
        }
        resolveStream();
      } catch (error) {
        rejectStream(error);
      }
    });
  });

  if (hadTruncatedTail && options.repairTruncatedTail === true) {
    if (truncateToOffset < info.size) {
      await truncate(auditPath, truncateToOffset).catch(() => {});
    } else if (carry.length > 0) {
      await writeFile(auditPath, '\n', { flag: 'a' }).catch(() => {});
    }
  }

  if (!compactMode) {
    return keptState.map((item) => item.record);
  }
  const merged = [
    ...keptState,
    ...latestToolState.values(),
    ...(latestNativeUsage === undefined ? [] : [latestNativeUsage]),
    ...keptFrames,
  ].sort((a, b) => a.order - b.order);
  return merged.map((item) => item.record);
}

export interface CompactAuditStats {
  readonly totalBytes: number;
  readonly stateBytes: number;
}

export async function compactAuditFileWithStats(
  auditPath: string,
  options: { readonly maxBytes?: number; readonly tailFrameLimit?: number } = {},
): Promise<CompactAuditStats> {
  const records = await readAuditFile(auditPath, {
    maxBytes: 0,
    tailFrameLimit: options.tailFrameLimit ?? AUDIT_TAIL_FRAME_RECORDS,
    repairTruncatedTail: false,
  });
  let stateBytes = 0;
  const lines = records.map((record) => {
    const serialized = `${JSON.stringify(record)}\n`;
    if (!HIGH_FREQ_FRAME_TYPES.has(record.type)) {
      stateBytes += Buffer.byteLength(serialized, 'utf8');
    }
    return serialized;
  });
  const payload = lines.join('');
  const tempPath = `${auditPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, payload, 'utf8');
  try {
    await rename(tempPath, auditPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  return {
    totalBytes: Buffer.byteLength(payload, 'utf8'),
    stateBytes,
  };
}

export async function compactAuditFile(
  auditPath: string,
  options: { readonly maxBytes?: number; readonly tailFrameLimit?: number } = {},
): Promise<number> {
  const stats = await compactAuditFileWithStats(auditPath, options);
  return stats.totalBytes;
}

export async function pruneExpiredAuditFiles(
  auditDir: string,
  maxAgeMs: number = AUDIT_RETENTION_MS,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(auditDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue;
    const filePath = resolve(auditDir, entry.name);
    const info = await stat(filePath).catch(() => undefined);
    if (info && info.mtimeMs < cutoff) {
      await unlink(filePath).catch(() => {});
    }
  }
}
