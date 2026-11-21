import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionAttentionCursor } from '@kiki/protocol';
import { ulid } from 'ulid';

const JOURNAL_VERSION = 1;
const WATERMARK_READ_BYTES = 64 * 1024;

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

export class SessionEventJournal {
  private _seq: number;
  private _attentionSeq: number;
  private pendingLines: string[] = [];
  private flushPromise: Promise<void> | undefined;
  private headerPending: boolean;
  private writeFailed = false;
  private compactFailed = false;
  private appendSeparator = false;
  private retainedLines: string[] | undefined;
  private diskEventCount = 0;
  private compactPending = false;
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
  ) {
    this._seq = lastSeq;
    this._attentionSeq = attentionSeq;
    this.durableSeq = lastSeq;
    this.durableAttentionSeq = attentionSeq;
    this.headerPending = isFresh;
    if (isFresh) this.retainedLines = [];
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
  ): Promise<SessionEventJournal> {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError('journal capacity must be a nonnegative integer');
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
      }
      const truncateStaleTailBeforeFreshHeader = async (): Promise<void> => {
        try {
          await writeFile(filePath, '', 'utf8');
        } catch {
          return;
        }
      };
      await truncateStaleTailBeforeFreshHeader();
      return new SessionEventJournal(filePath, logger, `ep_${ulid()}`, 0, 0, true, capacity);
    }
    return new SessionEventJournal(filePath, logger, epoch, lastSeq, attentionSeq, false, capacity);
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
    const line: JournalEventLine = {
      kind: 'event',
      seq,
      attention_seq: this._attentionSeq,
      envelope,
    };
    this.pendingLines.push(JSON.stringify(line));
    this.scheduleFlush();
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
    while (this.flushPromise !== undefined || this.pendingLines.length > 0 ||
      (this.closing && this.retainedLines !== undefined && (this.compactPending || this.diskEventCount > this.capacity))) {
      this.scheduleFlush();
      await this.flushPromise;
      if (this.writeFailed || (this.compactFailed && this.pendingLines.length === 0 && this.flushPromise === undefined)) return;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushPromise !== undefined) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = undefined;
      if (!this.writeFailed && this.pendingLines.length > 0) this.scheduleFlush();
    });
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
    if (this.retainedLines !== undefined) return;
    const retained: string[] = [];
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
        if (retained.length === this.capacity) {
          this.compactPending = true;
          break;
        }
        retained.push(raw);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.retainedLines = retained.toReversed();
    this.diskEventCount = this.retainedLines.length;
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
    const events = this.pendingLines;
    this.pendingLines = [];
    const lines = this.headerPending ? [JSON.stringify(this.header()), ...events] : events;
    if (lines.length > 0) {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const file = await open(this.filePath, 'a');
        try {
          await file.appendFile((this.appendSeparator ? '\n' : '') + lines.join('\n') + '\n', 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
      } catch (error) {
        this.pendingLines = events.concat(this.pendingLines);
        this.writeFailed = true;
        this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal write failed; lines requeued for the next flush');
        return;
      }
      this.headerPending = false;
      this.appendSeparator = false;
      const retained = this.retainedLines!;
      this.diskEventCount += events.length;
      for (const raw of events) {
        const parsed = parseJournalLine(raw);
        if (parsed?.kind === 'event') {
          this.durableSeq = Math.max(this.durableSeq, parsed.seq);
          this.durableAttentionSeq = Math.max(this.durableAttentionSeq, lineAttentionSeq(parsed));
        }
      }
      this.retainedLines = this.capacity === 0 ? [] : retained.concat(events).slice(-this.capacity);
    }
    this.writeFailed = false;
    if (!this.compactPending && this.diskEventCount <= this.capacity * (this.closing ? 1 : 2)) return;
    try {
      await replaceJournal(this.filePath, [JSON.stringify(this.header()), ...this.retainedLines!].join('\n') + '\n');
      this.diskEventCount = this.retainedLines!.length;
      this.compactPending = false;
    } catch (error) {
      this.compactPending = true;
      this.compactFailed = true;
      this.logger.warn({ filePath: this.filePath, err: String(error) }, 'event journal compaction failed; durable source retained for retry');
    }
  }
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
