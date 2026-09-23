import { createReadStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';

const JOURNAL_VERSION = 1;

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
   * Open (or create) the journal for `filePath`. Scans an existing file to
   * recover `{epoch, lastSeq}`. A missing file or an unreadable header starts
   * a fresh journal with a new epoch.
   */
  static async open(filePath: string, logger: JournalLogger = noopLogger): Promise<SessionEventJournal> {
    let epoch: string | undefined;
    let lastSeq = 0;
    let sawAnyLine = false;

    try {
      for await (const raw of readLines(filePath)) {
        sawAnyLine = true;
        const parsed = parseJournalLine(raw);
        if (parsed === undefined) continue;
        if (parsed.kind === 'journal_header') {
          if (epoch === undefined) epoch = parsed.epoch;
          continue;
        }
        if (parsed.seq > lastSeq) lastSeq = parsed.seq;
      }
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
      // The stale file is truncated before the fresh header is written so
      // `appendFile` never glues new events onto a damaged tail.
      try {
        await writeFile(filePath, '', 'utf8');
      } catch {
        /* the first flush recreates the file if truncation fails */
      }
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
      // A failed write keeps its lines queued but does not spin the explicit
      // flush: the next append retries them.
      if (this.writeFailed) return;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushPromise !== undefined) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = undefined;
      // A failed write keeps its lines queued but does not spin an automatic
      // retry loop; the next append or explicit flush retries them.
      if (!this.writeFailed && this.pendingLines.length > 0) this.scheduleFlush();
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
        // `appendFile` alone does not fsync; a crash would silently drop the
        // durable events the seq watermark already promised.
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      // Put the lines back so the next flush retries them instead of leaving
      // the events live-only behind a promised seq. A failed write does not
      // spin an automatic retry loop; the next append or explicit flush
      // retries them.
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
