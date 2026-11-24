import { mkdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionEventJournal, sessionJournalPath, type JournalLogger } from './sessionEventJournal';

export interface JournalWatermark {
  readonly seq: number;
  readonly epoch: string;
  readonly attentionSeq: number;
}

export interface JournalWatermarkStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs?: number;
}

export interface JournalWatermarkHook {
  onBeforeWrite(reason?: string): void;
  onDurableFlush(watermark: JournalWatermark, fileStat: JournalWatermarkStat): void;
}

export interface JournalWatermarkStats {
  readonly covered: boolean;
  readonly coveredHits: number;
  readonly liveHits: number;
  readonly legacyMisses: number;
  readonly repairMisses: number;
  readonly entries: number;
  readonly dirtyCount: number;
}

interface StoredWatermarkRow {
  readonly epoch: string;
  readonly seq: number;
  readonly attentionSeq: number;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly fileCtimeMs?: number;
}

const WATERMARK_DB_FILENAME = '.watermarks.sqlite';
const GLOBAL_JOURNAL_ID = '_global';

/** Persistent journal-owned watermark projection for zero-disk cold session list reads. */
export class JournalWatermarkIndex {
  private db: DatabaseSync | undefined;
  private covered = false;
  private closed = false;
  private preparePromise: Promise<void> | undefined;
  private readonly rows = new Map<string, StoredWatermarkRow>();
  private readonly dirty = new Set<string>();
  private readonly mutationSeq = new Map<string, number>();
  private coveredHits = 0;
  private liveHits = 0;
  private legacyMisses = 0;
  private repairMisses = 0;

  constructor(
    private readonly eventsDir: string,
    private readonly logger?: JournalLogger,
  ) {}

  get isCovered(): boolean {
    return this.covered && !this.closed;
  }

  stats(): JournalWatermarkStats {
    return {
      covered: this.isCovered,
      coveredHits: this.coveredHits,
      liveHits: this.liveHits,
      legacyMisses: this.legacyMisses,
      repairMisses: this.repairMisses,
      entries: this.rows.size,
      dirtyCount: this.dirty.size,
    };
  }

  recordLiveHit(): void {
    this.liveHits += 1;
  }

  currentMutationSeq(sessionId: string): number {
    return this.mutationSeq.get(sessionId) ?? 0;
  }

  hookFor(sessionId: string): JournalWatermarkHook {
    return {
      onBeforeWrite: (reason = 'write') => {
        this.markDirty(sessionId, reason);
      },
      onDurableFlush: (watermark, fileStat) => {
        this.commitWatermark(sessionId, watermark, fileStat);
      },
    };
  }

  getCovered(sessionId: string): JournalWatermark | undefined {
    if (this.closed) return undefined;
    if (!this.covered) {
      this.legacyMisses += 1;
      return undefined;
    }
    if (this.dirty.has(sessionId)) {
      this.repairMisses += 1;
      return undefined;
    }
    const row = this.rows.get(sessionId);
    const fullPath = sessionJournalPath(this.eventsDir, sessionId);
    let fileInfo: { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number } | undefined;
    try {
      const st = statSync(fullPath);
      fileInfo = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.repairMisses += 1;
        return undefined;
      }
      fileInfo = undefined;
    }
    if (fileInfo === undefined) {
      if (row !== undefined) this.recordRemoved(sessionId);
      this.coveredHits += 1;
      return { epoch: '', seq: 0, attentionSeq: 0 };
    }
    if (
      row === undefined ||
      row.fileSize !== fileInfo.size ||
      Math.abs(row.fileMtimeMs - fileInfo.mtimeMs) >= 0.001 ||
      (row.fileCtimeMs !== undefined && Math.abs(row.fileCtimeMs - fileInfo.ctimeMs) >= 0.001)
    ) {
      this.markDirty(sessionId, 'external_change');
      this.repairMisses += 1;
      return undefined;
    }
    this.coveredHits += 1;
    return {
      epoch: row.epoch,
      seq: row.seq,
      attentionSeq: row.attentionSeq,
    };
  }

  markDirty(sessionId: string, reason: string): void {
    if (this.closed || sessionId === GLOBAL_JOURNAL_ID) return;
    this.bumpMutation(sessionId);
    this.dirty.add(sessionId);
    try {
      const db = this.ensureDb();
      db.prepare('INSERT OR REPLACE INTO dirty (session_id, reason, updated_at) VALUES (?, ?, ?)').run(
        sessionId,
        reason,
        Date.now(),
      );
    } catch (error) {
      this.covered = false;
      this.logger?.warn({ sessionId, reason, err: String(error) }, 'journal watermark dirty mark failed');
    }
  }

  commitWatermark(
    sessionId: string,
    watermark: JournalWatermark,
    fileStat: JournalWatermarkStat,
  ): void {
    if (this.closed || sessionId === GLOBAL_JOURNAL_ID) return;
    this.bumpMutation(sessionId);
    try {
      const db = this.ensureDb();
      db.exec('BEGIN IMMEDIATE');
      try {
        if (watermark.epoch.length > 0) {
          db.prepare(
            'INSERT OR REPLACE INTO watermarks (session_id, epoch, seq, attention_seq, file_size, file_mtime_ms, file_ctime_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(
            sessionId,
            watermark.epoch,
            watermark.seq,
            watermark.attentionSeq,
            fileStat.size,
            fileStat.mtimeMs,
            fileStat.ctimeMs ?? null,
          );
          this.rows.set(sessionId, {
            epoch: watermark.epoch,
            seq: watermark.seq,
            attentionSeq: watermark.attentionSeq,
            fileSize: fileStat.size,
            fileMtimeMs: fileStat.mtimeMs,
            fileCtimeMs: fileStat.ctimeMs,
          });
        } else {
          db.prepare('DELETE FROM watermarks WHERE session_id = ?').run(sessionId);
          this.rows.delete(sessionId);
        }
        db.prepare('DELETE FROM dirty WHERE session_id = ?').run(sessionId);
        this.dirty.delete(sessionId);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw error;
      }
    } catch (error) {
      this.covered = false;
      this.dirty.add(sessionId);
      this.logger?.warn({ sessionId, err: String(error) }, 'journal watermark commit failed');
    }
  }

  recordRemoved(sessionId: string): void {
    if (this.closed || sessionId === GLOBAL_JOURNAL_ID) return;
    this.bumpMutation(sessionId);
    this.rows.delete(sessionId);
    this.dirty.delete(sessionId);
    try {
      const db = this.ensureDb();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM watermarks WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM dirty WHERE session_id = ?').run(sessionId);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw error;
      }
    } catch (error) {
      this.covered = false;
      this.logger?.warn({ sessionId, err: String(error) }, 'journal watermark removal failed');
    }
  }

  invalidate(sessionId: string, reason: string): void {
    if (this.closed || sessionId === GLOBAL_JOURNAL_ID) return;
    this.bumpMutation(sessionId);
    this.rows.delete(sessionId);
    this.dirty.add(sessionId);
    try {
      const db = this.ensureDb();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM watermarks WHERE session_id = ?').run(sessionId);
        db.prepare('INSERT OR REPLACE INTO dirty (session_id, reason, updated_at) VALUES (?, ?, ?)').run(
          sessionId,
          reason,
          Date.now(),
        );
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw error;
      }
    } catch (error) {
      this.covered = false;
      this.logger?.warn({ sessionId, reason, err: String(error) }, 'journal watermark invalidation failed');
    }
  }

  backfillAuthoritative(
    sessionId: string,
    watermark: JournalWatermark,
    fileStat: JournalWatermarkStat | undefined,
    observedMutationSeq: number,
  ): void {
    if (this.closed || sessionId === GLOBAL_JOURNAL_ID) return;
    if (this.currentMutationSeq(sessionId) !== observedMutationSeq) return;
    if (fileStat === undefined) {
      this.recordRemoved(sessionId);
      return;
    }
    this.commitWatermark(sessionId, watermark, fileStat);
  }

  prepare(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.preparePromise !== undefined) return this.preparePromise;
    this.preparePromise = this.runPrepare().finally(() => {
      this.preparePromise = undefined;
    });
    return this.preparePromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.covered = false;
    if (this.preparePromise !== undefined) {
      await this.preparePromise.catch(() => {});
    }
    if (this.db !== undefined) {
      try {
        this.db.close();
      } catch {}
      this.db = undefined;
    }
  }

  private bumpMutation(sessionId: string): void {
    this.mutationSeq.set(sessionId, (this.mutationSeq.get(sessionId) ?? 0) + 1);
  }

  private ensureDb(): DatabaseSync {
    if (this.db !== undefined) return this.db;
    mkdirSync(this.eventsDir, { recursive: true });
    const db = new DatabaseSync(join(this.eventsDir, WATERMARK_DB_FILENAME));
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watermarks (
        session_id TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        seq INTEGER NOT NULL,
        attention_seq INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        file_mtime_ms REAL NOT NULL,
        file_ctime_ms REAL
      );
      CREATE TABLE IF NOT EXISTS dirty (
        session_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const cols = db.prepare('PRAGMA table_info(watermarks)').all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === 'file_ctime_ms')) {
      db.exec('ALTER TABLE watermarks ADD COLUMN file_ctime_ms REAL;');
    }
    this.db = db;
    this.hydrateFromDb(db);
    return db;
  }

  private hydrateFromDb(db: DatabaseSync): void {
    const savedRows = db.prepare(
      'SELECT session_id, epoch, seq, attention_seq, file_size, file_mtime_ms, file_ctime_ms FROM watermarks',
    ).all() as Array<{
      session_id: string;
      epoch: string;
      seq: number;
      attention_seq: number;
      file_size: number;
      file_mtime_ms: number;
      file_ctime_ms: number | null;
    }>;
    for (const row of savedRows) {
      if (!this.rows.has(row.session_id) && !this.mutationSeq.has(row.session_id)) {
        this.rows.set(row.session_id, {
          epoch: row.epoch,
          seq: row.seq,
          attentionSeq: row.attention_seq,
          fileSize: row.file_size,
          fileMtimeMs: row.file_mtime_ms,
          fileCtimeMs: row.file_ctime_ms ?? undefined,
        });
      }
    }
    const dirtyRows = db.prepare('SELECT session_id FROM dirty').all() as Array<{ session_id: string }>;
    for (const row of dirtyRows) {
      if (!this.mutationSeq.has(row.session_id)) {
        this.dirty.add(row.session_id);
      }
    }
  }

  private async runPrepare(): Promise<void> {
    if (this.closed) return;
    try {
      this.ensureDb();
    } catch (error) {
      this.logger?.warn({ eventsDir: this.eventsDir, err: String(error) }, 'journal watermark index open failed');
      return;
    }

    const snapshotMutations = new Map<string, number>();
    for (const id of this.rows.keys()) snapshotMutations.set(id, this.currentMutationSeq(id));
    for (const id of this.dirty) snapshotMutations.set(id, this.currentMutationSeq(id));

    let entries;
    try {
      entries = await readdir(this.eventsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!this.closed) this.covered = true;
        return;
      }
      this.logger?.warn({ eventsDir: this.eventsDir, err: String(error) }, 'journal watermark scan failed');
      return;
    }

    const seen = new Set<string>();
    for (const entry of entries) {
      if (this.closed) return;
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl') || entry.name.includes('.jsonl.tmp.')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      if (sessionId.length === 0 || sessionId === GLOBAL_JOURNAL_ID) continue;
      seen.add(sessionId);

      const seqBefore = this.currentMutationSeq(sessionId);
      const fullPath = sessionJournalPath(this.eventsDir, sessionId);
      let fileInfo;
      try {
        fileInfo = await stat(fullPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          seen.delete(sessionId);
        }
        continue;
      }
      const existing = this.rows.get(sessionId);
      const isCleanMatch =
        existing !== undefined &&
        !this.dirty.has(sessionId) &&
        existing.fileSize === fileInfo.size &&
        Math.abs(existing.fileMtimeMs - fileInfo.mtimeMs) < 0.001 &&
        (existing.fileCtimeMs === undefined || Math.abs(existing.fileCtimeMs - fileInfo.ctimeMs) < 0.001);
      if (isCleanMatch) continue;

      const watermark = await SessionEventJournal.peekWatermark(fullPath, this.logger);
      if (this.closed) return;
      if (this.currentMutationSeq(sessionId) !== seqBefore) continue;
      this.commitWatermark(sessionId, watermark, {
        size: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs,
        ctimeMs: fileInfo.ctimeMs,
      });
    }

    for (const [sessionId, seqBefore] of snapshotMutations) {
      if (this.closed) return;
      if (seen.has(sessionId)) continue;
      if (this.currentMutationSeq(sessionId) !== seqBefore) continue;
      this.recordRemoved(sessionId);
    }

    if (!this.closed) {
      this.covered = true;
      try {
        this.ensureDb()
          .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('covered', '1')")
          .run();
      } catch {}
    }
  }
}
