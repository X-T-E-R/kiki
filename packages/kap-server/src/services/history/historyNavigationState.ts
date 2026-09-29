import type { DatabaseSync } from 'node:sqlite';
import type { NavigationAnchor, NavigationAnchorSequence, NavigationTurnSequence } from '@kiki/transcript/navigationSequence';

/** A Map-compatible scalar store backed by the navigation sidecar's keyed state table. */
export class SqliteNavigationMap<V> extends Map<string, V> {
  constructor(private readonly db: DatabaseSync, private readonly scope: string,
    private readonly bucket: string) { super(); }

  override get(key: string): V | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE scope=? AND bucket=? AND key=?')
      .get(this.scope, this.bucket, key) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value) as V;
  }

  override has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM state WHERE scope=? AND bucket=? AND key=?')
      .get(this.scope, this.bucket, key) !== undefined;
  }

  override set(key: string, value: V): this {
    this.db.prepare(`INSERT INTO state(scope,bucket,key,value) VALUES(?,?,?,?)
      ON CONFLICT(scope,bucket,key) DO UPDATE SET value=excluded.value`)
      .run(this.scope, this.bucket, key, JSON.stringify(value));
    return this;
  }

  override delete(key: string): boolean {
    return this.db.prepare('DELETE FROM state WHERE scope=? AND bucket=? AND key=?')
      .run(this.scope, this.bucket, key).changes > 0;
  }

  override clear(): void {
    this.db.prepare('DELETE FROM state WHERE scope=? AND bucket=?').run(this.scope, this.bucket);
  }

  override get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM state WHERE scope=? AND bucket=?')
      .get(this.scope, this.bucket) as { count: number };
    return row.count;
  }

  override *entries(): MapIterator<[string, V]> {
    const rows = this.db.prepare('SELECT key,value FROM state WHERE scope=? AND bucket=? ORDER BY key')
      .iterate(this.scope, this.bucket) as IterableIterator<{ key: string; value: string }>;
    for (const row of rows) yield [row.key, JSON.parse(row.value) as V];
  }

  override *keys(): MapIterator<string> {
    for (const [key] of this.entries()) yield key;
  }

  override *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  override [Symbol.iterator](): MapIterator<[string, V]> { return this.entries(); }

  override forEach(callbackfn: (value: V, key: string, map: Map<string, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callbackfn.call(thisArg, value, key, this);
  }
}

export class SqliteNavigationSet extends Set<string> {
  private readonly valuesByKey: SqliteNavigationMap<boolean>;
  constructor(db: DatabaseSync, scope: string, bucket: string) {
    super();
    this.valuesByKey = new SqliteNavigationMap<boolean>(db, scope, bucket);
  }
  override has(key: string): boolean { return this.valuesByKey.has(key); }
  override add(key: string): this { this.valuesByKey.set(key, true); return this; }
  override delete(key: string): boolean { return this.valuesByKey.delete(key); }
  override clear(): void { this.valuesByKey.clear(); }
  override get size(): number { return this.valuesByKey.size; }
  override *values(): SetIterator<string> { yield* this.valuesByKey.keys(); }
  override keys(): SetIterator<string> { return this.values(); }
  override *entries(): SetIterator<[string, string]> {
    for (const key of this.valuesByKey.keys()) yield [key, key];
  }
  override [Symbol.iterator](): SetIterator<string> { return this.values(); }
  override forEach(callbackfn: (value: string, value2: string, set: Set<string>) => void, thisArg?: unknown): void {
    for (const key of this) callbackfn.call(thisArg, key, key, this);
  }
}

/** Suffixes stay on disk as tombstones until their visibility effect is applied. */
export class SqliteNavigationTurnSequence implements NavigationTurnSequence {
  constructor(private readonly db: DatabaseSync, private readonly scope: string) {}
  get length(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM turn_sequence WHERE scope=? AND active=1')
      .get(this.scope) as { n: number }).n;
  }
  push(id: string, startOrdinal: number): void {
    this.db.prepare(`INSERT INTO turn_sequence(scope,seq,id,start_ordinal,active)
      VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM turn_sequence WHERE scope=?),?,?,1)`)
      .run(this.scope, this.scope, id, startOrdinal);
  }
  at(_index: -1): string | undefined {
    return (this.db.prepare('SELECT id FROM turn_sequence WHERE scope=? AND active=1 ORDER BY seq DESC LIMIT 1')
      .get(this.scope) as { id: string } | undefined)?.id;
  }
  indexOf(id: string): number {
    const row = this.db.prepare('SELECT seq FROM turn_sequence WHERE scope=? AND active=1 AND id=? ORDER BY seq DESC LIMIT 1')
      .get(this.scope, id) as { seq: number } | undefined;
    return row === undefined ? -1 : (this.db.prepare('SELECT COUNT(*) AS n FROM turn_sequence WHERE scope=? AND active=1 AND seq<?')
      .get(this.scope, row.seq) as { n: number }).n;
  }
  findFromOrdinal(ordinal: number): number {
    const row = this.db.prepare(`SELECT seq FROM turn_sequence WHERE scope=? AND active=1 AND start_ordinal>=?
      ORDER BY seq LIMIT 1`).get(this.scope, ordinal) as { seq: number } | undefined;
    return row === undefined ? -1 : (this.db.prepare('SELECT COUNT(*) AS n FROM turn_sequence WHERE scope=? AND active=1 AND seq<?')
      .get(this.scope, row.seq) as { n: number }).n;
  }
  removeFrom(index: number): { sequenceRange?: readonly [number, number] } {
    const first = this.db.prepare(`SELECT seq FROM turn_sequence WHERE scope=? AND active=1 ORDER BY seq LIMIT 1 OFFSET ?`)
      .get(this.scope, index) as { seq: number } | undefined;
    if (first === undefined) return {};
    const last = this.db.prepare('SELECT MAX(seq) AS seq FROM turn_sequence WHERE scope=? AND active=1')
      .get(this.scope) as { seq: number };
    this.db.prepare('UPDATE turn_sequence SET active=0 WHERE scope=? AND active=1 AND seq>=? AND seq<=?')
      .run(this.scope, first.seq, last.seq);
    return { sequenceRange: [first.seq, last.seq] };
  }
}

export class SqliteNavigationAnchorSequence implements NavigationAnchorSequence {
  constructor(private readonly db: DatabaseSync, private readonly scope: string) {}
  push(anchor: NavigationAnchor): void {
    this.db.prepare(`INSERT INTO anchor_sequence(scope,seq,ordinal,turn_id,message_id,active)
      VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM anchor_sequence WHERE scope=?),?,?,?,1)`)
      .run(this.scope, this.scope, anchor.ordinal, anchor.turnId ?? null, anchor.messageId ?? null);
  }
  nthFromLast(count: number): NavigationAnchor | undefined {
    const row = this.db.prepare(`SELECT ordinal,turn_id,message_id FROM anchor_sequence
      WHERE scope=? AND active=1 ORDER BY ordinal DESC,seq ASC LIMIT 1 OFFSET ?`)
      .get(this.scope, count - 1) as { ordinal: number; turn_id: string | null; message_id: string | null } | undefined;
    return row === undefined ? undefined : { ordinal: row.ordinal,
      turnId: row.turn_id ?? undefined, messageId: row.message_id ?? undefined };
  }
  hasTurn(turnId: string): boolean {
    return this.db.prepare('SELECT 1 FROM anchor_sequence WHERE scope=? AND active=1 AND turn_id=? LIMIT 1')
      .get(this.scope, turnId) !== undefined;
  }
  discardFromOrdinal(ordinal: number): void {
    this.db.prepare('UPDATE anchor_sequence SET active=0 WHERE scope=? AND active=1 AND ordinal>=?')
      .run(this.scope, ordinal);
  }
  discardRemovedTurns(range: readonly [number, number] | undefined, ids: readonly string[] | undefined): void {
    if (range !== undefined) {
      this.db.prepare(`UPDATE anchor_sequence SET active=0 WHERE scope=? AND active=1 AND turn_id IN
        (SELECT id FROM turn_sequence WHERE scope=? AND seq>=? AND seq<=?)`)
        .run(this.scope, this.scope, range[0], range[1]);
    } else if (ids !== undefined) {
      for (const id of ids) this.db.prepare('UPDATE anchor_sequence SET active=0 WHERE scope=? AND turn_id=?')
        .run(this.scope, id);
    }
  }
}
