import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionAttentionCursor } from '@kiki/protocol';
import { ulid } from 'ulid';

const JOURNAL_VERSION = 1;
const WATERMARK_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const BACKGROUND_FLUSH_COALESCE_MS = 25;
const DEFAULT_STALE_JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_TEMP_JOURNAL_TTL_MS = 60 * 60 * 1000;

const ATTENTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.ended',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.suspended',
  'event.approval.requested',
  'event.approval.resolved',
  'event.question.requested',
  'event.question.answered',
  'event.question.dismissed',
]);

/** Whether a journaled event type advances the session's attention cursor. */
export function isAttentionEventType(type: string): boolean {
  return ATTENTION_EVENT_TYPES.has(type);
}

/** Project a journal epoch and attention sequence into a wire attention cursor when an epoch is known. */
export function toAttentionCursor(
  cursor: { readonly epoch?: string; readonly attentionSeq?: number } | undefined,
): SessionAttentionCursor | undefined {
  if (cursor?.epoch === undefined || cursor.epoch.length === 0) return undefined;
  const seq = cursor.attentionSeq;
  if (seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { epoch: cursor.epoch, seq };
}

/**
 * Wire event envelope — matches `wsEventEnvelopeSchema` /
 * `sessionEventMessageSchema` in the local `protocol/ws-control` catalog. Defined
 * structurally so the journal does not depend on the zod schema at runtime.
 */
export interface EventEnvelope {
  readonly type: string;
  readonly seq: number;
  readonly epoch?: string;
  readonly volatile?: boolean;
  readonly offset?: number;
  readonly session_id?: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

interface JournalHeaderLine {
  kind: 'journal_header';
  version: number;
  epoch: string;
  created_at: number;
  last_seq?: number;
  attention_seq?: number;
}

interface JournalEventLine {
  kind: 'event';
  seq: number;
  attention_seq?: number;
  envelope: EventEnvelope;
}

export interface JournalEntry {
  seq: number;
  envelope: EventEnvelope;
}

/** Minimal logger surface — keeps the journal decoupled from the server logger. */
export interface JournalLogger {
  warn(obj: unknown, msg: string): void;
  error?(obj: unknown, msg: string): void;
}

const noopLogger: JournalLogger = { warn: () => {} };

/** Hook notified around durable journal file writes to keep a derived watermark index consistent. */
export interface JournalWriteWatermarkHook {
  onBeforeWrite(reason?: string): void;
  onDurableFlush(
    watermark: { readonly seq: number; readonly epoch: string; readonly attentionSeq: number },
    fileStat: { readonly size: number; readonly mtimeMs: number; readonly ctimeMs?: number },
  ): void;
}

interface RetainedJournalEntry {
  readonly raw: string;
  readonly bytes: number;
  readonly seq: number;
  readonly attentionSeq: number;
}

export class SessionEventJournal {
  private _seq: number;
  private _attentionSeq: number;
  private pendingEntries: RetainedJournalEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private headerPending: boolean;
  private writeFailed = false;
  private compactFailed = false;
  private appendSeparator = false;
  private dirtySinceSync = false;
  private retainedEntries: RetainedJournalEntry[] | undefined;
  private retainedBytes = 0;
  private diskEventCount = 0;
  private diskBytes = 0;
  private compactPending = false;
  private closeSyncFailed = false;
  private closing = false;
  private durableSeq: number;
  private durableAttentionSeq: number;
  private createdAt = Date.now();

  private constructor(
    private readonly filePath: string,
    private readonly logger: JournalLogger,
    public readonly epoch: string,
    lastSeq: number,
    attentionSeq: number,
    isFresh: boolean,
    private readonly capacity: number,
    private readonly maxRetainedBytes: number,
    private readonly watermarkHook?: JournalWriteWatermarkHook,
  ) {
    this._seq = lastSeq;
    this._attentionSeq = attentionSeq;
    this.durableSeq = lastSeq;
    this.durableAttentionSeq = attentionSeq;
    this.headerPending = isFresh;
    if (isFresh) this.retainedEntries = [];
  }

  /** Highest durable seq appended (0 if none). */
  get seq(): number {
    return this._seq;
  }

  /** Highest durable attention seq appended (0 if none). */
  get attentionSeq(): number {
    return this._attentionSeq;
  }

  /**
   * Recover the watermark without loading the replay window. Retention starts
   * on the first append, so cold watermark queries do not compact the journal.
   */
  static async open(
    filePath: string,
    logger: JournalLogger = noopLogger,
    capacity = 1000,
    maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES,
    watermarkHook?: JournalWriteWatermarkHook,
  ): Promise<SessionEventJournal> {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError('journal capacity must be a nonnegative integer');
    if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 0) throw new RangeError('journal maxRetainedBytes must be a nonnegative integer');
    let epoch: string | undefined;
    let lastSeq = 0;
    let attentionSeq = 0;
    let sawAnyLine = false;

    try {
      const watermark = await readWatermark(filePath);
      epoch = watermark.epoch;
      lastSeq = watermark.lastSeq;
      attentionSeq = watermark.attentionSeq;
      sawAnyLine = watermark.sawAnyLine;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(
          { filePath, err: String(error) },
          'event journal unreadable; starting a fresh epoch',
        );
      }
    }

    if (epoch === undefined) {
      if (sawAnyLine) {
        logger.warn({ filePath }, 'event journal missing header; rotating to a fresh epoch');
        watermarkHook?.onBeforeWrite('epoch_reset');
      }
      const truncateStaleTailBeforeFreshHeader = async (): Promise<void> => {
        try {
          await writeFile(filePath, '', 'utf8');
        } catch {
          return;
        }
      };
      await truncateStaleTailBeforeFreshHeader();
      return new SessionEventJournal(filePath, logger, `ep_${ulid()}`, 0, 0, true, capacity, maxRetainedBytes, watermarkHook);
    }
    return new SessionEventJournal(filePath, logger, epoch, lastSeq, attentionSeq, false, capacity, maxRetainedBytes, watermarkHook);
  }

  /**
   * Read the persisted watermark without creating, truncating, or flushing the
   * journal file. Used for cold watermark queries (such as `GET /api/sessions`).
   */
  static async peekWatermark(
    filePath: string,
    logger: JournalLogger = noopLogger,
  ): Promise<{ seq: number; epoch: string; attentionSeq: number }> {
    try {
      const watermark = await readWatermark(filePath);
      if (watermark.epoch !== undefined) {
        return { seq: watermark.lastSeq, epoch: watermark.epoch, attentionSeq: watermark.attentionSeq };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn({ filePath, err: String(error) }, 'event journal watermark read failed');
      }
    }
    return { seq: 0, epoch: '', attentionSeq: 0 };
  }

  /** Reserve the next durable seq. The caller must follow with `append()`. */
  nextSeq(): number {
    this._seq += 1;
    return this._seq;
  }

  /** Queue a durable event line for write-behind flush. */
  append(
    seq: number,
    envelope: EventEnvelope,
    options?: { readonly advancesAttention?: boolean },
  ): void {
    const advancesAttention = options?.advancesAttention ?? isAttentionEventType(envelope.type);
    if (advancesAttention && seq > this._attentionSeq) {
      this._attentionSeq = seq;
    }
    const attentionSeq = this._attentionSeq;
    const line: JournalEventLine = {
      kind: 'event',
      seq,
      attention_seq: attentionSeq,
      envelope,
    };
    const raw = JSON.stringify(line);
    this.pendingEntries.push({
      raw,
      bytes: Buffer.byteLength(raw, 'utf8') + 1,
      seq,
      attentionSeq,
    });
    this.writeFailed = false;
    this.scheduleBackgroundFlush();
  }

  /** Read journal entries with `seq > fromSeqExclusive`, capped at `limit`. */
  async readSince(fromSeqExclusive: number, limit: number): Promise<JournalEntry[]> {
    await this.flush();
    const out: JournalEntry[] = [];
    try {
      for await (const raw of readLines(this.filePath)) {
        const parsed = parseJournalLine(raw);
        if (parsed === undefined || parsed.kind !== 'event') continue;
        if (parsed.seq <= fromSeqExclusive) continue;
        out.push({ seq: parsed.seq, envelope: parsed.envelope });
        if (out.length >= limit) break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    return out;
  }

  async flush(): Promise<void> {
    this.clearFlushTimer();
    this.closeSyncFailed = false;
    while (this.flushPromise !== undefined || this.pendingEntries.length > 0 ||
      (this.closing && (this.headerPending || (this.dirtySinceSync && !this.closeSyncFailed) || (this.needsCompaction() && !this.compactFailed)))) {
      this.scheduleFlush();
      await this.flushPromise;
      if (this.writeFailed || ((this.compactFailed || this.closeSyncFailed) && this.pendingEntries.length === 0 && this.flushPromise === undefined)) return;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.flush();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private scheduleBackgroundFlush(): void {
    if (this.closing) {
      this.clearFlushTimer();
      this.scheduleFlush();
      return;
    }
    if (this.flushPromise !== undefined || this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.writeFailed && this.pendingEntries.length > 0) this.scheduleFlush();
    }, BACKGROUND_FLUSH_COALESCE_MS);
    this.flushTimer.unref?.();
  }

  private scheduleFlush(): void {
    this.clearFlushTimer();
    if (this.flushPromise !== undefined) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = undefined;
      if (!this.writeFailed && this.pendingEntries.length > 0) {
        if (this.closing) this.scheduleFlush();
        else this.scheduleBackgroundFlush();
      }
    });
  }

  private needsCompaction(): boolean {
    if (this.retainedEntries === undefined) return false;
    if (this.compactPending) return true;
    if (this.diskEventCount > this.capacity * (this.closing ? 1 : 2)) return true;
    return this.diskBytes > Math.max(this.maxRetainedBytes, this.retainedBytes);
  }

  private header(): JournalHeaderLine {
    return {
      kind: 'journal_header',
      version: JOURNAL_VERSION,
      epoch: this.epoch,
      created_at: this.createdAt,
      last_seq: this.durableSeq,
      attention_seq: this.durableAttentionSeq,
    };
  }

  private async loadRetention(): Promise<void> {
    if (this.retainedEntries !== undefined) return;
    const retained: RetainedJournalEntry[] = [];
    let retainedBytes = 0;
    try {
      const file = await open(this.filePath, 'r');
      try {
        const head = Buffer.alloc(WATERMARK_READ_BYTES);
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        const end = head.subarray(0, bytesRead).indexOf(10);
        const header = parseJournalLine(head.subarray(0, end < 0 ? bytesRead : end).toString('utf8'));
        if (header?.kind === 'journal_header') this.createdAt = header.created_at;
        const size = (await file.stat()).size;
        if (size > 0) {
          const lastByte = Buffer.allocUnsafe(1);
          await file.read(lastByte, 0, 1, size - 1);
          this.appendSeparator = lastByte[0] !== 10;
          this.compactPending ||= this.appendSeparator;
        }
      } finally {
        await file.close();
      }
      for await (const raw of readLinesReverse(this.filePath)) {
        const parsed = parseJournalLine(raw);
        if (parsed?.kind === 'journal_header') break;
        if (parsed?.kind !== 'event') {
          this.compactPending = true;
          continue;
        }
        const bytes = Buffer.byteLength(raw, 'utf8') + 1;
        if (this.capacity === 0 || retained.length >= this.capacity ||
          (retained.length > 0 && retainedBytes + bytes > this.maxRetainedBytes)) {
          this.compactPending = true;
          break;
        }
        retained.push({ raw, bytes, seq: parsed.seq, attentionSeq: lineAttentionSeq(parsed) });
        retainedBytes += bytes;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.retainedEntries = retained.toReversed();
    this.retainedBytes = retainedBytes;
    this.diskEventCount = this.retainedEntries.length;
    this.diskBytes = retainedBytes;
  }

  private async flushOnce(): Promise<void> {
    this.compactFailed = false;
    try {
      await this.loadRetention();
    } catch (error) {
      this.writeFailed = true;
      this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal retention read failed; append retained for retry');
      return;
    }
    const events = this.pendingEntries;
    this.pendingEntries = [];
    const lines = this.headerPending
      ? [JSON.stringify(this.header()), ...events.map((entry) => entry.raw)]
      : events.map((entry) => entry.raw);
    if (lines.length > 0) {
      let handleStat: { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number; readonly ino: number } | undefined;
      try {
        this.watermarkHook?.onBeforeWrite('append');
        await mkdir(dirname(this.filePath), { recursive: true });
        const file = await open(this.filePath, 'a');
        try {
          await file.appendFile((this.appendSeparator ? '\n' : '') + lines.join('\n') + '\n', 'utf8');
          if (this.watermarkHook !== undefined) {
            try {
              const info = await file.stat();
              handleStat = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino };
            } catch (statError) {
              this.logger.warn({ filePath: this.filePath, err: String(statError) }, 'event journal post-append handle stat failed; session kept dirty');
            }
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        const hadNewerAppend = this.pendingEntries.length > 0;
        this.pendingEntries = events.concat(this.pendingEntries);
        this.writeFailed = !hadNewerAppend;
        this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal write failed; lines requeued for the next flush');
        return;
      }
      this.headerPending = false;
      this.appendSeparator = false;
      this.dirtySinceSync = true;
      const retained = this.retainedEntries!;
      this.diskEventCount += events.length;
      for (const entry of events) {
        this.diskBytes += entry.bytes;
        this.durableSeq = Math.max(this.durableSeq, entry.seq);
        this.durableAttentionSeq = Math.max(this.durableAttentionSeq, entry.attentionSeq);
      }
      const trimmed = trimRetainedEntries(retained.concat(events), this.capacity, this.maxRetainedBytes);
      this.retainedEntries = trimmed.entries;
      this.retainedBytes = trimmed.bytes;
      if (this.watermarkHook !== undefined && handleStat !== undefined) {
        try {
          const pathInfo = await stat(this.filePath);
          const sameSource =
            pathInfo.ino === handleStat.ino &&
            pathInfo.size === handleStat.size &&
            Math.abs(pathInfo.mtimeMs - handleStat.mtimeMs) < 0.001 &&
            Math.abs(pathInfo.ctimeMs - handleStat.ctimeMs) < 0.001;
          if (sameSource) {
            this.watermarkHook.onDurableFlush(
              { epoch: this.epoch, seq: this.durableSeq, attentionSeq: this.durableAttentionSeq },
              { size: handleStat.size, mtimeMs: handleStat.mtimeMs, ctimeMs: handleStat.ctimeMs },
            );
          }
        } catch (error) {
          this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal watermark checkpoint failed after durable append; session kept dirty');
        }
      }
    }
    this.writeFailed = false;
    if (this.needsCompaction()) {
      let compacted = false;
      try {
        this.watermarkHook?.onBeforeWrite('compact');
        const content = [JSON.stringify(this.header()), ...this.retainedEntries!.map((entry) => entry.raw)].join('\n') + '\n';
        await replaceJournal(this.filePath, content);
        this.diskEventCount = this.retainedEntries!.length;
        this.diskBytes = this.retainedBytes;
        this.compactPending = false;
        this.dirtySinceSync = false;
        compacted = true;
      } catch (error) {
        this.compactPending = true;
        this.compactFailed = true;
        this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal compaction failed; durable source retained for retry');
      }
      if (compacted) {
        if (this.watermarkHook !== undefined) {
          try {
            const info = await stat(this.filePath);
            this.watermarkHook.onDurableFlush(
              { epoch: this.epoch, seq: this.durableSeq, attentionSeq: this.durableAttentionSeq },
              { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs },
            );
          } catch (error) {
            this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal watermark checkpoint failed after compaction; session kept dirty');
          }
        }
        return;
      }
    }
    if (this.closing && this.dirtySinceSync) {
      let synced = false;
      try {
        const file = await open(this.filePath, 'a');
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        this.dirtySinceSync = false;
        synced = true;
      } catch (error) {
        this.closeSyncFailed = true;
        this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal close sync failed');
      }
      if (synced && this.watermarkHook !== undefined) {
        try {
          const info = await stat(this.filePath);
          this.watermarkHook.onDurableFlush(
            { epoch: this.epoch, seq: this.durableSeq, attentionSeq: this.durableAttentionSeq },
            { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs },
          );
        } catch (error) {
          this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal watermark checkpoint failed on close sync; session kept dirty');
        }
      }
    }
  }
}

function trimRetainedEntries(
  entries: readonly RetainedJournalEntry[],
  capacity: number,
  maxRetainedBytes: number,
): { entries: RetainedJournalEntry[]; bytes: number } {
  if (capacity === 0 || entries.length === 0) return { entries: [], bytes: 0 };
  const floor = Math.max(0, entries.length - capacity);
  let bytes = 0;
  let kept = 0;
  for (let index = entries.length - 1; index >= floor; index -= 1) {
    const entry = entries[index]!;
    if (kept >= 1 && bytes + entry.bytes > maxRetainedBytes) break;
    bytes += entry.bytes;
    kept += 1;
  }
  return { entries: entries.slice(entries.length - kept), bytes };
}

/** Remove expired inactive session event journals and stale temp files from `eventsDir`. */
export async function pruneExpiredEventJournals(
  eventsDir: string,
  options?: {
    readonly maxAgeMs?: number;
    readonly activeSessionIds?: ReadonlySet<string>;
    readonly isSessionActive?: (sessionId: string) => boolean;
    readonly beforeUnlink?: (sessionId: string) => (() => void) | undefined;
    readonly onUnlinked?: (sessionId: string) => void;
    readonly now?: number;
    readonly logger?: JournalLogger;
  },
): Promise<number> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_STALE_JOURNAL_TTL_MS;
  const activeSessionIds = options?.activeSessionIds;
  const isSessionActive = options?.isSessionActive;
  const beforeUnlink = options?.beforeUnlink;
  const onUnlinked = options?.onUnlinked;
  const now = options?.now ?? Date.now();
  const logger = options?.logger ?? noopLogger;
  let entries;
  try {
    entries = await readdir(eventsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    logger.warn({ eventsDir, err: String(error) }, 'event journal cleanup scan failed');
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const isTemp = name.includes('.jsonl.tmp.');
    const isJournal = !isTemp && name.endsWith('.jsonl');
    if (!isTemp && !isJournal) continue;
    const sessionId = isJournal
      ? name.slice(0, -'.jsonl'.length)
      : name.slice(0, name.indexOf('.jsonl.tmp.'));
    if (isJournal && (sessionId === '_global' || activeSessionIds?.has(sessionId) === true || isSessionActive?.(sessionId) === true)) continue;
    const fullPath = join(eventsDir, name);
    try {
      const info = await stat(fullPath);
      const ttl = isTemp ? STALE_TEMP_JOURNAL_TTL_MS : maxAgeMs;
      if (now - info.mtimeMs < ttl) continue;
      if (isJournal && (activeSessionIds?.has(sessionId) === true || isSessionActive?.(sessionId) === true)) continue;
      let release: (() => void) | undefined;
      if (isJournal && beforeUnlink !== undefined) {
        release = beforeUnlink(sessionId);
        if (release === undefined) continue;
      }
      try {
        await rm(fullPath, { force: true });
        if (isJournal) onUnlinked?.(sessionId);
        removed += 1;
      } finally {
        release?.();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ filePath: fullPath, err: String(error) }, 'event journal cleanup failed');
      }
    }
  }
  return removed;
}

/** Default per-session journal path under `<eventsDir>/<sessionId>.jsonl`. */
export function sessionJournalPath(eventsDir: string, sessionId: string): string {
  return join(eventsDir, `${sessionId}.jsonl`);
}

function nonNegativeSafeInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function lineAttentionSeq(line: JournalEventLine): number {
  if (typeof line.attention_seq === 'number' && Number.isSafeInteger(line.attention_seq) && line.attention_seq >= 0) {
    return line.attention_seq;
  }
  return isAttentionEventType(line.envelope.type) ? line.seq : 0;
}

async function readWatermark(filePath: string): Promise<{
  epoch: string | undefined;
  lastSeq: number;
  attentionSeq: number;
  sawAnyLine: boolean;
}> {
  const file = await open(filePath, 'r');
  let fast: { epoch: string; lastSeq: number; attentionSeq: number; sawAnyLine: boolean } | undefined;
  try {
    const { size } = await file.stat();
    if (size === 0) return { epoch: undefined, lastSeq: 0, attentionSeq: 0, sawAnyLine: false };
    const headSize = Math.min(size, WATERMARK_READ_BYTES);
    const head = Buffer.allocUnsafe(headSize);
    await file.read(head, 0, headSize, 0);
    const headerEnd = head.indexOf(10);
    const header = headerEnd >= 0
      ? parseJournalLine(head.subarray(0, headerEnd).toString('utf8'))
      : size <= headSize ? parseJournalLine(head.toString('utf8')) : undefined;
    if (header?.kind === 'journal_header') {
      const tailStart = Math.max(0, size - WATERMARK_READ_BYTES);
      const tail = Buffer.allocUnsafe(size - tailStart);
      await file.read(tail, 0, tail.length, tailStart);
      let end = tail.length;
      let lastSeq = 0;
      let attentionSeq = 0;
      let valid = true;
      while (end > 0) {
        if (tail[end - 1] === 10) end -= 1;
        if (end === 0) break;
        const separator = tail.lastIndexOf(10, end - 1);
        if (separator < 0 && tailStart > 0) break;
        const line = tail.subarray(separator + 1, end);
        const parsed = parseJournalLine(line.toString('utf8'));
        if (parsed === undefined) {
          valid = false;
          break;
        }
        if (parsed.kind === 'event') {
          if (lastSeq > 0 && parsed.seq > lastSeq) valid = false;
          lastSeq = Math.max(lastSeq, parsed.seq);
          attentionSeq = Math.max(attentionSeq, lineAttentionSeq(parsed));
        } else if (tailStart > 0 || parsed.epoch !== header.epoch) {
          valid = false;
        }
        if (!valid) break;
        end = separator + 1;
      }
      if (valid && lastSeq === 0 && tailStart > 0) {
        for await (const raw of readLinesReverse(filePath)) {
          const parsed = parseJournalLine(raw);
          if (parsed?.kind === 'event') {
            lastSeq = parsed.seq;
            attentionSeq = Math.max(attentionSeq, lineAttentionSeq(parsed));
          } else {
            valid = false;
          }
          break;
        }
      }
      if (valid && (lastSeq > 0 || tailStart === 0)) {
        const savedSeq = nonNegativeSafeInt(header.last_seq);
        const savedAttentionSeq = nonNegativeSafeInt(header.attention_seq);
        fast = {
          epoch: header.epoch,
          lastSeq: Math.max(lastSeq, savedSeq),
          attentionSeq: Math.max(attentionSeq, savedAttentionSeq),
          sawAnyLine: true,
        };
      }
    }
  } finally {
    await file.close();
  }
  if (fast !== undefined) return fast;
  let epoch: string | undefined;
  let lastSeq = 0;
  let attentionSeq = 0;
  let sawAnyLine = false;
  for await (const raw of readLines(filePath)) {
    sawAnyLine = true;
    const parsed = parseJournalLine(raw);
    if (parsed?.kind === 'journal_header' && epoch === undefined) {
      epoch = parsed.epoch;
      lastSeq = Math.max(lastSeq, nonNegativeSafeInt(parsed.last_seq));
      attentionSeq = Math.max(attentionSeq, nonNegativeSafeInt(parsed.attention_seq));
    }
    if (parsed?.kind === 'event') {
      lastSeq = Math.max(lastSeq, parsed.seq);
      attentionSeq = Math.max(attentionSeq, lineAttentionSeq(parsed));
    }
  }
  return { epoch, lastSeq, attentionSeq, sawAnyLine };
}

function parseJournalLine(raw: string): JournalHeaderLine | JournalEventLine | undefined {
  const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'journal_header') {
    const epoch = (value as { epoch?: unknown }).epoch;
    if (typeof epoch !== 'string' || epoch.length === 0) return undefined;
    return value as JournalHeaderLine;
  }
  if (kind === 'event') {
    const seq = (value as { seq?: unknown }).seq;
    const envelope = (value as { envelope?: unknown }).envelope;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) return undefined;
    if (typeof envelope !== 'object' || envelope === null) return undefined;
    return value as JournalEventLine;
  }
  return undefined;
}

async function* readLines(filePath: string): AsyncIterable<string> {
  let buffered = '';
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  for await (const chunk of stream) {
    buffered += chunk;
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      yield buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf('\n');
    }
  }
  if (buffered.length > 0) yield buffered;
}

async function* readLinesReverse(filePath: string): AsyncIterable<string> {
  const file = await open(filePath, 'r');
  try {
    let position = (await file.stat()).size;
    let buffered = Buffer.alloc(0);
    let blockSize = WATERMARK_READ_BYTES;
    while (position > 0) {
      const length = Math.min(position, blockSize);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const result = await file.read(chunk, read, length - read, position + read);
        if (result.bytesRead === 0) throw new Error('event journal changed during retention read');
        read += result.bytesRead;
      }
      buffered = Buffer.concat([chunk, buffered]);
      while (buffered.length > 0) {
        const end = buffered.length - (buffered.at(-1) === 10 ? 1 : 0);
        const separator = end === 0 ? -1 : buffered.lastIndexOf(10, end - 1);
        if (separator < 0 && position > 0) break;
        yield buffered.subarray(separator + 1, end).toString('utf8');
        buffered = buffered.subarray(0, separator + 1);
      }
      blockSize = buffered.length > 0 ? Math.min(blockSize * 2, 4 * 1024 * 1024) : WATERMARK_READ_BYTES;
    }
  } finally {
    await file.close();
  }
}

async function replaceJournal(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.tmp.${ulid()}`;
  try {
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
