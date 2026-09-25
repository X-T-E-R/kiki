import { createReadStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';

const JOURNAL_VERSION = 1;
const WATERMARK_READ_BYTES = 64 * 1024;

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
}

interface JournalEventLine {
  kind: 'event';
  seq: number;
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
  private pendingLines: string[] = [];
  private flushPromise: Promise<void> | undefined;
  private headerPending: boolean;
  private writeFailed = false;

  private constructor(
    private readonly filePath: string,
    private readonly logger: JournalLogger,
    public readonly epoch: string,
    lastSeq: number,
    isFresh: boolean,
  ) {
    this._seq = lastSeq;
    this.headerPending = isFresh;
  }

  /** Highest durable seq appended (0 if none). */
  get seq(): number {
    return this._seq;
  }

  /**
   * Open (or create) the journal for `filePath`. Recovers the header and the
   * latest durable seq from bounded reads, scanning in full if either edge is
   * damaged. A missing file or unreadable header starts a fresh epoch.
   */
  static async open(filePath: string, logger: JournalLogger = noopLogger): Promise<SessionEventJournal> {
    let epoch: string | undefined;
    let lastSeq = 0;
    let sawAnyLine = false;

    try {
      const watermark = await readWatermark(filePath);
      epoch = watermark.epoch;
      lastSeq = watermark.lastSeq;
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
      return new SessionEventJournal(filePath, logger, `ep_${ulid()}`, 0, true);
    }
    return new SessionEventJournal(filePath, logger, epoch, lastSeq, false);
  }

  /** Reserve the next durable seq. The caller must follow with `append()`. */
  nextSeq(): number {
    this._seq += 1;
    return this._seq;
  }

  /** Queue a durable event line for write-behind flush. */
  append(seq: number, envelope: EventEnvelope): void {
    const line: JournalEventLine = { kind: 'event', seq, envelope };
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
    while (this.flushPromise !== undefined || this.pendingLines.length > 0) {
      if (this.flushPromise === undefined) {
        this.flushPromise = this.flushOnce().finally(() => {
          this.flushPromise = undefined;
        });
      }
      await this.flushPromise;
      const retainedLinesRetryOnNextAppend = this.writeFailed;
      if (retainedLinesRetryOnNextAppend) return;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushPromise !== undefined) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = undefined;
      const noAutomaticRetryAfterWriteFailure = !this.writeFailed;
      if (noAutomaticRetryAfterWriteFailure && this.pendingLines.length > 0) this.scheduleFlush();
    });
  }

  private async flushOnce(): Promise<void> {
    const lines: string[] = [];
    if (this.headerPending) {
      const header: JournalHeaderLine = {
        kind: 'journal_header',
        version: JOURNAL_VERSION,
        epoch: this.epoch,
        created_at: Date.now(),
      };
      lines.push(JSON.stringify(header));
      this.headerPending = false;
    }
    lines.push(...this.pendingLines);
    this.pendingLines = [];
    if (lines.length === 0) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const file = await open(this.filePath, 'a');
      try {
          await file.appendFile(lines.join('\n') + '\n', 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      this.pendingLines = lines.concat(this.pendingLines);
      this.headerPending ||= lines.length === this.pendingLines.length;
      this.writeFailed = true;
      this.logger.warn(
        { filePath: this.filePath, err: String(error) },
        'event journal write failed; lines requeued for the next flush',
      );
      return;
    }
    this.writeFailed = false;
  }
}

/** Default per-session journal path under `<eventsDir>/<sessionId>.jsonl`. */
export function sessionJournalPath(eventsDir: string, sessionId: string): string {
  return join(eventsDir, `${sessionId}.jsonl`);
}

async function readWatermark(filePath: string): Promise<{
  epoch: string | undefined;
  lastSeq: number;
  sawAnyLine: boolean;
}> {
  const file = await open(filePath, 'r');
  let fast: { epoch: string; lastSeq: number; sawAnyLine: boolean } | undefined;
  try {
    const { size } = await file.stat();
    if (size === 0) return { epoch: undefined, lastSeq: 0, sawAnyLine: false };
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
        } else if (tailStart > 0 || parsed.epoch !== header.epoch) {
          valid = false;
        }
        if (!valid) break;
        end = separator + 1;
      }
      if (valid && (lastSeq > 0 || tailStart === 0)) {
        fast = { epoch: header.epoch, lastSeq, sawAnyLine: true };
      }
    }
  } finally {
    await file.close();
  }
  if (fast !== undefined) return fast;
  let epoch: string | undefined;
  let lastSeq = 0;
  let sawAnyLine = false;
  for await (const raw of readLines(filePath)) {
    sawAnyLine = true;
    const parsed = parseJournalLine(raw);
    if (parsed?.kind === 'journal_header' && epoch === undefined) epoch = parsed.epoch;
    if (parsed?.kind === 'event') lastSeq = Math.max(lastSeq, parsed.seq);
  }
  return { epoch, lastSeq, sawAnyLine };
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
