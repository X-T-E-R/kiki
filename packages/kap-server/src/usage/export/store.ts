import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { usageExportDestinationSchema, usageExportItemSchema, usageExportReceiptSchema, type UsageExportBatch, type UsageExportDestination, type UsageExportItem, type UsageExportQueue, type UsageExportReceipt } from '@kiki/protocol';
import { contributionSchema, contributionPublicModel, digest, opaqueId, publicBucket, addTokens, addQuality, type Contribution, type SourceContribution } from './projection';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

interface Row { [key: string]: string | number | null }
interface SourceRow { id: Uint8Array; workspace: string; kind: string; data: string }
interface PrivateDestination { destination: UsageExportDestination; identityKey: string }
interface ProjectionPlan { buckets: Map<string, ReturnType<typeof publicBucket>>; origins: Map<string, Set<string>>; destinationStamp: string; sourceGeneration: string | null }
interface ProjectionAccumulator { contribution: Contribution; pricingVersions: Set<string> }
/** Source staging is connection-local and file-backed; restart rebuilds it. Publication commits durable sources, metadata and outbox revisions in one FULL-synchronous transaction before bounded staging cleanup. */
export class UsageExportStore {
  private readonly db: DatabaseSync;
  private readonly election: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private fence = '';
  private closed = false;
  private readonly projectedOrigins = new Map<string, Set<string>>();
  private projectionLane: Promise<void> = Promise.resolve();
  private elected: boolean;
  get writer(): boolean { return this.elected; }
  private stmt(sql: string): StatementSync {
    let statement = this.stmts.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.stmts.set(sql, statement);
    }
    return statement;
  }
  constructor(path: string, private readonly legacyDisabled?: boolean) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.election = new DatabaseSync(`${path}.writer.sqlite`);
    this.election.exec('PRAGMA busy_timeout=0');
    let writer = false;
    try { this.election.exec('BEGIN IMMEDIATE'); writer = true; } catch {}
    this.elected = writer;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000;');
    if (writer) {
      const hasTables = (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' LIMIT 1").get()) !== undefined;
      if (!hasTables) this.db.exec('PRAGMA auto_vacuum=INCREMENTAL;');
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (writer) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, invalid INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS destinations(id TEXT PRIMARY KEY, data TEXT NOT NULL, identity_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS versions(dest TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(dest,bucket));
        CREATE TABLE IF NOT EXISTS outbox(dest TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL, item TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL, batch TEXT, created INTEGER NOT NULL, PRIMARY KEY(dest,bucket,revision));
        CREATE TABLE IF NOT EXISTS acknowledgements(dest TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, confirmed INTEGER NOT NULL, PRIMARY KEY(dest,bucket));
        CREATE TABLE IF NOT EXISTS batches(dest TEXT PRIMARY KEY, batch TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bucket_origins(kind TEXT NOT NULL, dest TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL, origin TEXT NOT NULL, PRIMARY KEY(kind,dest,bucket,revision,origin));
        CREATE INDEX IF NOT EXISTS queue_by_destination ON outbox(dest,state,created);
        CREATE INDEX IF NOT EXISTS bucket_origins_lookup ON bucket_origins(origin,kind,dest);
      `);
      for (const table of ['versions', 'outbox', 'acknowledgements']) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
        if (!columns.some((column) => column['name'] === 'origins')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN origins TEXT NOT NULL DEFAULT '[]'`);
        if (table === 'acknowledgements' && !columns.some((column) => column['name'] === 'item')) this.db.exec('ALTER TABLE acknowledgements ADD COLUMN item TEXT');
        if (table === 'acknowledgements' && !columns.some((column) => column['name'] === 'mapping_version')) this.db.exec('ALTER TABLE acknowledgements ADD COLUMN mapping_version TEXT');
      }
      this.fence = randomUUID();
      this.stmt("INSERT INTO meta VALUES('fence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.fence);
      this.stmt("INSERT OR IGNORE INTO meta VALUES('capacity','52428800')").run();
      this.backfillBucketOrigins();
      this.prepareStage();
      this.retireExperimentalGate();
    }
  }
  private backfillBucketOrigins(): void {
    if (this.meta('bucket-origins-v1') === 'true') return;
    this.transaction(() => {
      this.db.exec(`
        INSERT OR IGNORE INTO bucket_origins(kind,dest,bucket,revision,origin)
          SELECT 'version',v.dest,v.bucket,v.revision,j.value FROM versions v, json_each(v.origins) j WHERE typeof(j.value)='text';
        INSERT OR IGNORE INTO bucket_origins(kind,dest,bucket,revision,origin)
          SELECT 'outbox',o.dest,o.bucket,o.revision,j.value FROM outbox o, json_each(o.origins) j WHERE typeof(j.value)='text';
        INSERT OR IGNORE INTO bucket_origins(kind,dest,bucket,revision,origin)
          SELECT 'ack',a.dest,a.bucket,a.revision,j.value FROM acknowledgements a, json_each(a.origins) j WHERE typeof(j.value)='text';
      `);
      this.setMeta('bucket-origins-v1', 'true');
    });
  }
  private syncOrigins(kind: 'version' | 'outbox' | 'ack', dest: string, bucket: string, revision: number, origins: readonly string[]): void {
    if (kind === 'outbox') {
      this.stmt('DELETE FROM bucket_origins WHERE kind=? AND dest=? AND bucket=? AND revision=?').run(kind, dest, bucket, revision);
    } else {
      this.stmt('DELETE FROM bucket_origins WHERE kind=? AND dest=? AND bucket=?').run(kind, dest, bucket);
    }
    const insert = this.stmt('INSERT OR IGNORE INTO bucket_origins(kind,dest,bucket,revision,origin) VALUES(?,?,?,?,?)');
    for (const origin of origins) insert.run(kind, dest, bucket, revision, origin);
  }
  tryPromote(): boolean {
    if (this.closed) return false; if (this.writer) return true;
    try { this.election.exec('BEGIN IMMEDIATE'); } catch { return false; }
    this.fence = randomUUID(); this.elected = true;
    this.stmt("INSERT INTO meta VALUES('fence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.fence);
    this.backfillBucketOrigins();
    this.prepareStage(); this.retireExperimentalGate(); return true;
  }
  private prepareStage(): void {
    this.stmts.clear();
    this.db.exec('DROP TABLE IF EXISTS main.staging; PRAGMA temp_store=FILE; CREATE TEMP TABLE staging(run TEXT NOT NULL, id TEXT NOT NULL, workspace TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, invalid INTEGER NOT NULL, PRIMARY KEY(run,id)); CREATE INDEX IF NOT EXISTS staging_id ON staging(id);');
  }
  private retireExperimentalGate(): void {
    if (this.legacyDisabled === undefined || this.meta('experimental-gate-retired') !== null) return;
    this.transaction(() => {
      if (this.legacyDisabled) for (const destination of this.list()) {
        if (destination.enabled) this.update(destination.id, { enabled: false, state: 'disabled', next_at: null });
        this.setMeta(`handoff-arm:${destination.id}`, '');
      }
      this.setMeta('experimental-gate-retired', 'true');
    });
  }
  private assertWriter(): void {
    if (this.closed || !this.writer || (this.stmt("SELECT value FROM meta WHERE key='fence'").get() as Row | undefined)?.['value'] !== this.fence) throw new Error('export-writer-unavailable');
  }
  private transaction<T>(work: () => T): T {
    this.assertWriter(); this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.assertWriter(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  meta(key: string): string | null { return (this.stmt('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined)?.['value'] as string | undefined ?? null; }
  setMeta(key: string, value: string): void { this.assertWriter(); this.stmt('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  pendingCredentialCleanup(): string[] {
    return (this.stmt("SELECT key FROM meta WHERE key GLOB 'credential-cleanup:*' AND value IN ('keyring','private-file')").all() as Row[]).map((row) => String(row['key']).slice('credential-cleanup:'.length));
  }
  installationKey(): string { let key = this.meta('installation-key'); if (key === null) { key = randomBytes(32).toString('hex'); this.setMeta('installation-key', key); } return key; }
  list(): UsageExportDestination[] { return (this.stmt('SELECT data FROM destinations ORDER BY id').all() as Row[]).map((row) => usageExportDestinationSchema.parse(JSON.parse(String(row['data'])))); }
  get(id: string): UsageExportDestination { const row = this.stmt('SELECT data FROM destinations WHERE id=?').get(id) as Row | undefined; if (row === undefined) throw new Error('destination-not-found'); return usageExportDestinationSchema.parse(JSON.parse(String(row['data']))); }
  private privateDestination(id: string): PrivateDestination { const row = this.stmt('SELECT data,identity_key FROM destinations WHERE id=?').get(id) as Row | undefined; if (row === undefined) throw new Error('destination-not-found'); return { destination: usageExportDestinationSchema.parse(JSON.parse(String(row['data']))), identityKey: String(row['identity_key']) }; }
  save(destination: UsageExportDestination): void {
    this.assertWriter(); const clean = usageExportDestinationSchema.parse(destination);
    this.stmt('INSERT INTO destinations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(clean.id, JSON.stringify(clean), randomBytes(32).toString('hex'));
  }
  saveWithMetadata(destination: UsageExportDestination, metadata: Readonly<Record<string, string>>): void {
    this.transaction(() => {
      this.save(destination);
      for (const [key, value] of Object.entries(metadata)) this.setMeta(key, value);
    });
  }
  update(id: string, change: Partial<UsageExportDestination>): UsageExportDestination { const next = { ...this.get(id), ...change }; this.save(next); return next; }
  updateWithMetadata(id: string, change: Partial<UsageExportDestination>, metadata: Readonly<Record<string, string>>, refresh = false): UsageExportDestination {
    return this.transaction(() => {
      const next = this.update(id, change);
      for (const [key, value] of Object.entries(metadata)) this.setMeta(key, value);
      if (refresh) { this.publishDestination(id); if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full'); }
      return next;
    });
  }
  private withProjection<T>(work: () => Promise<T>): Promise<T> {
    const flight = this.projectionLane.then(work);
    this.projectionLane = flight.then(() => {}, () => {});
    return flight;
  }
  async updateWithMetadataAsync(id: string, change: Partial<UsageExportDestination>, metadata: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<UsageExportDestination> {
    const destinationStamp = this.projectionStamp(this.get(id));
    return this.withProjection(async () => {
      signal?.throwIfAborted();
      if (destinationStamp !== this.projectionStamp(this.get(id))) throw new Error('export-projection-changed');
      const plan = await this.projectionPlan(id, undefined, { ...this.get(id), ...change });
      return this.transaction(() => {
        signal?.throwIfAborted();
        this.assertProjection(id, plan); const next = this.update(id, change);
        for (const [key, value] of Object.entries(metadata)) this.setMeta(key, value);
        this.publishDestination(id, plan); if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full'); return next;
      });
    });
  }
  stage(run: string, source: SourceContribution): void {
    this.assertWriter();
    this.stmt('INSERT INTO staging VALUES(?,?,?,?,?,?) ON CONFLICT(run,id) DO UPDATE SET workspace=excluded.workspace,kind=excluded.kind,data=excluded.data,invalid=excluded.invalid').run(run, source.key, source.workspaceId, source.kind, JSON.stringify(source.buckets.map((bucket) => contributionSchema.parse(bucket))), source.invalidRecords);
  }
  discardStage(run: string): void { this.assertWriter(); this.stmt('DELETE FROM staging WHERE run=?').run(run); }
  retireSession(workspaceId: string, sessionId: string): void {
    const key = `${workspaceId}\0${sessionId}`;
    const operationPrefix = `operation\0${key}\0`;
    const operationUpper = `operation\0${key}\u0001`;
    this.transaction(() => {
      this.stmt('DELETE FROM sources WHERE id=? OR (id>=? AND id<?)').run(key, operationPrefix, operationUpper);
      this.stmt('DELETE FROM staging WHERE id=? OR (id>=? AND id<?)').run(key, operationPrefix, operationUpper);
      const affectedOutbox = this.stmt(`SELECT DISTINCT o.dest,o.bucket,o.revision,o.batch FROM bucket_origins bo
        JOIN outbox o ON o.dest=bo.dest AND o.bucket=bo.bucket AND o.revision=bo.revision
        WHERE bo.kind='outbox' AND (bo.origin=? OR (bo.origin>=? AND bo.origin<?)) AND json_extract(o.item,'$.operation')='replace'`)
        .all(key, operationPrefix, operationUpper) as Row[];
      const affectedAckOrigins = new Set<string>(
        (this.stmt(`SELECT DISTINCT dest,bucket,revision FROM bucket_origins WHERE kind='ack' AND (origin=? OR (origin>=? AND origin<?))`)
          .all(key, operationPrefix, operationUpper) as Row[])
          .map((row) => `${String(row['dest'])}\0${String(row['bucket'])}\0${String(row['revision'])}`),
      );
      const batchesToRelease = new Map<string, string>();
      for (const row of affectedOutbox) {
        if (row['batch'] !== null && row['batch'] !== undefined) {
          batchesToRelease.set(String(row['dest']), String(row['batch']));
        }
      }
      if (affectedAckOrigins.size > 0) {
        for (const batchRow of this.stmt('SELECT dest,batch,data FROM batches').all() as Row[]) {
          const dest = String(batchRow['dest']);
          if (batchesToRelease.has(dest)) continue;
          const payload = JSON.parse(String(batchRow['data'])) as UsageExportBatch;
          if (payload.items.some((item) => item.operation === 'replace' && affectedAckOrigins.has(`${dest}\0${item.bucket_id}\0${item.revision}`))) {
            batchesToRelease.set(dest, String(batchRow['batch']));
          }
        }
      }
      for (const [dest, batch] of batchesToRelease) {
        this.stmt("UPDATE outbox SET state='pending',batch=NULL WHERE dest=? AND batch=? AND state='inflight'").run(dest, batch);
        this.stmt('DELETE FROM batches WHERE dest=? AND batch=?').run(dest, batch);
      }
      const deleteOutboxRow = this.stmt('DELETE FROM outbox WHERE dest=? AND bucket=? AND revision=?');
      const deleteOutboxOrigins = this.stmt("DELETE FROM bucket_origins WHERE kind='outbox' AND dest=? AND bucket=? AND revision=?");
      for (const row of affectedOutbox) {
        const dest = String(row['dest']);
        const bucket = String(row['bucket']);
        const revision = Number(row['revision']);
        deleteOutboxRow.run(dest, bucket, revision);
        deleteOutboxOrigins.run(dest, bucket, revision);
      }
      const affected = this.stmt(`SELECT DISTINCT dest,bucket FROM bucket_origins WHERE kind='version' AND (origin=? OR (origin>=? AND origin<?))`)
        .all(key, operationPrefix, operationUpper) as Row[];
      this.projectedOrigins.clear();
      const streamIds = new Map<string, string>();
      for (const row of affected) {
        const dest = String(row['dest']);
        let streamId = streamIds.get(dest);
        if (streamId === undefined) {
          streamId = this.get(dest).stream_id;
          streamIds.set(dest, streamId);
        }
        this.version(dest, String(row['bucket']), 'delete', null, streamId);
      }
      this.setMeta('source-generation', randomUUID());
    });
  }
  async publishStageAsync(run: string, complete = true, incompleteReason: string | null = null, operationsComplete = false): Promise<void> {
    return this.withProjection(async () => {
      if (!operationsComplete) this.db.prepare("DELETE FROM staging WHERE run=? AND kind='operation'").run(run);
      const plans = new Map<string, ProjectionPlan>();
      for (const destination of this.list()) if (destination.enabled) plans.set(destination.id, await this.projectionPlan(destination.id, run, undefined, operationsComplete));
      this.publishStage(run, complete, incompleteReason, plans, false, operationsComplete);
      const remove = this.db.prepare('DELETE FROM staging WHERE rowid IN (SELECT rowid FROM staging WHERE run=? LIMIT 16)');
      for (;;) {
        this.assertWriter();
        if (remove.run(run).changes === 0) break;
        await yieldToEventLoop();
      }
    });
  }
  publishStage(run: string, complete = true, incompleteReason: string | null = null, plans?: Map<string, ProjectionPlan>, cleanup = true, operationsComplete = false): void {
    this.transaction(() => {
      if (plans !== undefined) {
        const enabled = this.list().filter((destination) => destination.enabled);
        if (enabled.length !== plans.size || enabled.some((destination) => !plans.has(destination.id))) throw new Error('export-projection-changed');
        for (const [id, plan] of plans) this.assertProjection(id, plan);
      }
      if (operationsComplete) this.db.prepare("DELETE FROM sources WHERE kind='operation' AND id NOT IN (SELECT id FROM staging WHERE run=?)").run(run);
      const missing = (this.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE kind!='operation' AND id NOT IN (SELECT id FROM staging WHERE run=?)").get(run) as Row)['n'];
      this.db.prepare('INSERT INTO sources SELECT id,workspace,kind,data,invalid FROM staging WHERE run=? ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,kind=excluded.kind,data=excluded.data,invalid=excluded.invalid WHERE sources.workspace IS NOT excluded.workspace OR sources.kind IS NOT excluded.kind OR sources.data IS NOT excluded.data OR sources.invalid IS NOT excluded.invalid').run(run);
      if (complete) this.setMeta('scan-complete', 'true');
      this.setMeta('scan-error', incompleteReason ?? (Number(missing) > 0 ? 'source-missing-retained-gap' : ''));
      for (const destination of this.list()) if (destination.enabled) this.publishDestination(destination.id, plans?.get(destination.id));
      if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full');
      this.setMeta('source-generation', randomUUID());
      if (cleanup) this.db.prepare('DELETE FROM staging WHERE run=?').run(run);
    });
  }
  refreshDestination(id: string): void { this.transaction(() => { this.publishDestination(id); if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full'); }); }
  async refreshDestinationAsync(id: string): Promise<void> {
    return this.withProjection(async () => {
      const plan = await this.projectionPlan(id);
      this.transaction(() => { this.assertProjection(id, plan); this.publishDestination(id, plan); if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full'); });
    });
  }
  private projectionStamp(destination: UsageExportDestination): string { return digest({ scope: destination.scope, stream: destination.stream_id, target: destination.target, account: destination.account_fingerprint, enabled: destination.enabled, consent: destination.consent_fingerprint }); }
  private accumulateProjection(row: SourceRow, destination: UsageExportDestination, identityKey: string, groups: Map<string, ProjectionAccumulator>, origins: Map<string, Set<string>>): void {
    if (destination.scope.excluded_workspace_ids.includes(String(row['workspace'])) || (row['kind'] === 'ephemeral' && !destination.scope.include_ephemeral)) return;
    const buckets: unknown = JSON.parse(String(row['data'])); if (!Array.isArray(buckets)) throw new Error('invalid-stored-contribution');
    for (const value of buckets) {
      const bucket = contributionSchema.parse(value);
      if (bucket.start < destination.scope.start_at || (destination.scope.end_at !== null && bucket.start >= destination.scope.end_at)) continue;
      const model = contributionPublicModel(bucket, identityKey).model;
      const key = opaqueId(identityKey, JSON.stringify(['kiki-public-model-v1', bucket.start, model]));
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { contribution: { ...bucket, tokens: { ...bucket.tokens }, quality: { ...bucket.quality } }, pricingVersions: new Set([bucket.pricing_version]) });
      else {
        addTokens(group.contribution.tokens, bucket.tokens); addQuality(group.contribution.quality, bucket.quality); group.pricingVersions.add(bucket.pricing_version);
        group.contribution.cost = group.contribution.cost === null || bucket.cost === null ? null : group.contribution.cost + bucket.cost;
      }
      const related = origins.get(key) ?? new Set<string>(); related.add(Buffer.from(row.id).toString('utf8')); origins.set(key, related);
    }
  }
  private finishProjection(groups: Map<string, ProjectionAccumulator>, identityKey: string): ProjectionPlan['buckets'] {
    return new Map([...groups].map(([key, group]) => { const bucket = publicBucket([group.contribution], identityKey); bucket.cost.pricing_version = digest([...group.pricingVersions].sort()); return [key, bucket]; }));
  }
  private projected(id: string): Map<string, ReturnType<typeof publicBucket>> {
    const { destination, identityKey } = this.privateDestination(id); const groups = new Map<string, ProjectionAccumulator>(); this.projectedOrigins.clear();
    for (const row of this.db.prepare('SELECT CAST(id AS BLOB) AS id,workspace,kind,data FROM sources').iterate() as Iterable<SourceRow>) this.accumulateProjection(row, destination, identityKey, groups, this.projectedOrigins);
    return this.finishProjection(groups, identityKey);
  }
  private async projectionPlan(id: string, run?: string, override?: UsageExportDestination, operationsComplete = false): Promise<ProjectionPlan> {
    const saved = this.privateDestination(id); const destination = override ?? saved.destination; const identityKey = saved.identityKey; const sourceGeneration = this.meta('source-generation');
    const groups = new Map<string, ProjectionAccumulator>(); const origins = new Map<string, Set<string>>(); let cursor = '';
    for (;;) {
      const rows = (run === undefined
        ? this.db.prepare('SELECT CAST(id AS BLOB) AS id,workspace,kind,data FROM sources WHERE id>? ORDER BY id LIMIT 16').all(cursor)
        : this.db.prepare(`SELECT CAST(id AS BLOB) AS id,workspace,kind,data FROM staging WHERE run=? AND id>?
            UNION ALL SELECT CAST(id AS BLOB) AS id,workspace,kind,data FROM sources
              WHERE id>? AND (?=0 OR kind!='operation') AND id NOT IN (SELECT id FROM staging WHERE run=?)
            ORDER BY id LIMIT 16`).all(run, cursor, cursor, Number(operationsComplete), run)) as unknown as SourceRow[];
      if (rows.length === 0) break;
      for (const row of rows) this.accumulateProjection(row, destination, identityKey, groups, origins);
      cursor = Buffer.from(rows.at(-1)!.id).toString('utf8'); await yieldToEventLoop();
    }
    if (sourceGeneration !== this.meta('source-generation') || this.projectionStamp(saved.destination) !== this.projectionStamp(this.get(id))) throw new Error('export-projection-changed');
    return { buckets: this.finishProjection(groups, identityKey), origins, sourceGeneration, destinationStamp: this.projectionStamp(saved.destination) };
  }
  private assertProjection(id: string, plan: ProjectionPlan): void { if (plan.sourceGeneration !== this.meta('source-generation') || plan.destinationStamp !== this.projectionStamp(this.get(id))) throw new Error('export-projection-changed'); }
  async previewAsync(id: string, limit = 20): Promise<{ items: UsageExportItem[]; total: number }> {
    return this.withProjection(async () => {
      const plan = await this.projectionPlan(id); this.assertProjection(id, plan); return this.previewProjected(id, plan.buckets, limit);
    });
  }
  preview(id: string, limit = 20): { items: UsageExportItem[]; total: number } { return this.previewProjected(id, this.projected(id), limit); }
  private previewProjected(id: string, projected: ProjectionPlan['buckets'], limit: number): { items: UsageExportItem[]; total: number } {
    const destination = this.get(id); const items: UsageExportItem[] = [];
    for (const [key, bucket] of projected) {
      if (items.length >= limit) break;
      const row = this.db.prepare('SELECT revision,hash,item FROM versions WHERE dest=? AND bucket=?').get(id, key) as Row | undefined;
      const previous = row === undefined ? undefined : usageExportItemSchema.parse(JSON.parse(String(row['item'])));
      const payloadHash = digest({ operation: 'replace', bucket });
      items.push(usageExportItemSchema.parse({ schema_version: 'kiki.usage.bucket.v1', stream_id: destination.stream_id, bucket_id: key, revision: previous !== undefined && previous.payload_hash === payloadHash ? previous.revision : Number(row?.['revision'] ?? 0) + 1, payload_hash: payloadHash, operation: 'replace', bucket }));
    }
    return { items, total: projected.size };
  }
  private publishDestination(id: string, plan?: ProjectionPlan): void {
    if (this.meta(`withdrawn:${id}`) === 'true') return;
    const destination = this.get(id); const projected = plan?.buckets ?? this.projected(id);
    if (plan !== undefined) { this.projectedOrigins.clear(); for (const [key, origins] of plan.origins) this.projectedOrigins.set(key, origins); }
    const old = this.stmt('SELECT bucket,item FROM versions WHERE dest=?').all(id) as Row[];
    for (const row of old) if (!projected.has(String(row['bucket']))) this.version(id, String(row['bucket']), 'delete', null, destination.stream_id);
    for (const [key, bucket] of projected) this.version(id, key, 'replace', bucket, destination.stream_id);
    if (destination.state === 'queue-full') this.update(id, { state: 'ready', error_category: null });
  }
  private version(id: string, bucketId: string, operation: UsageExportItem['operation'], bucket: UsageExportItem['bucket'], streamId?: string): void {
    const previous = this.stmt('SELECT revision,hash,origins FROM versions WHERE dest=? AND bucket=?').get(id, bucketId) as Row | undefined;
    const originList: string[] = this.projectedOrigins.has(bucketId)
      ? [...this.projectedOrigins.get(bucketId) ?? []].sort()
      : JSON.parse(String(previous?.['origins'] ?? '[]')) as string[];
    const origins = JSON.stringify(originList);
    const payloadHash = digest({ operation, bucket });
    if (previous?.['hash'] === payloadHash) {
      if (String(previous['origins'] ?? '[]') !== origins) {
        this.stmt('UPDATE versions SET origins=? WHERE dest=? AND bucket=?').run(origins, id, bucketId);
        this.syncOrigins('version', id, bucketId, Number(previous['revision']), originList);
      }
      return;
    }
    const item = usageExportItemSchema.parse({ schema_version: 'kiki.usage.bucket.v1', stream_id: streamId ?? this.get(id).stream_id, bucket_id: bucketId, revision: Number(previous?.['revision'] ?? 0) + 1, payload_hash: payloadHash, operation, bucket });
    const json = JSON.stringify(item);
    this.stmt('INSERT INTO versions(dest,bucket,revision,hash,item,origins) VALUES(?,?,?,?,?,?) ON CONFLICT(dest,bucket) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,item=excluded.item,origins=excluded.origins').run(id, bucketId, item.revision, payloadHash, json, origins);
    this.syncOrigins('version', id, bucketId, item.revision, originList);
    this.stmt("DELETE FROM bucket_origins WHERE kind='outbox' AND dest=? AND bucket=? AND revision IN (SELECT revision FROM outbox WHERE dest=? AND bucket=? AND state='pending')").run(id, bucketId, id, bucketId);
    this.stmt("DELETE FROM outbox WHERE dest=? AND bucket=? AND state='pending'").run(id, bucketId);
    this.stmt("INSERT INTO outbox(dest,bucket,revision,item,bytes,state,batch,created,origins) VALUES(?,?,?,?,?,'pending',NULL,?,?)").run(id, bucketId, item.revision, json, Buffer.byteLength(json), Date.now(), origins);
    this.syncOrigins('outbox', id, bucketId, item.revision, originList);
  }
  take(id: string, maxItems: number, maxBytes: number): UsageExportBatch | undefined {
    return this.transaction(() => {
      if (!this.get(id).enabled) return undefined;
      const existing = this.db.prepare('SELECT data FROM batches WHERE dest=?').get(id) as Row | undefined;
      if (existing !== undefined) return JSON.parse(String(existing['data'])) as UsageExportBatch;
      const rows = this.db.prepare("SELECT bucket,revision,item,bytes FROM outbox WHERE dest=? AND state='pending' ORDER BY created,bucket LIMIT ?").all(id, Math.min(200, maxItems)) as Row[];
      const selected: Row[] = []; let bytes = 256;
      for (const row of rows) { if (bytes + Number(row['bytes']) > maxBytes && selected.length > 0) break; selected.push(row); bytes += Number(row['bytes']); }
      if (selected.length === 0) return undefined;
      const batch = randomBytes(24).toString('hex');
      for (const row of selected) this.db.prepare("UPDATE outbox SET state='inflight',batch=? WHERE dest=? AND bucket=? AND revision=?").run(batch, id, String(row['bucket']), Number(row['revision']));
      const payload: UsageExportBatch = { schema_version: 'kiki.usage.batch.v1', batch_id: batch, items: selected.map((row) => usageExportItemSchema.parse(JSON.parse(String(row['item'])))) };
      this.db.prepare('INSERT INTO batches VALUES(?,?,?)').run(id, batch, JSON.stringify(payload));
      return payload;
    });
  }
  acknowledge(id: string, receipt: UsageExportReceipt, now: number, mappingVersion: string | null = null): { acknowledged: number; rejected: number; remaining: number } {
    return this.transaction(() => {
      const clean = usageExportReceiptSchema.parse(receipt); let acknowledged = 0; let rejected = 0;
      const seen = new Set<string>();
      for (const ack of clean.items) {
        if (seen.has(ack.bucket_id)) throw new Error('duplicate-receipt-entry'); seen.add(ack.bucket_id);
        const batchRow = this.db.prepare('SELECT data FROM batches WHERE dest=? AND batch=?').get(id, clean.batch_id) as Row | undefined;
        const batch = batchRow === undefined ? undefined : JSON.parse(String(batchRow['data'])) as UsageExportBatch;
        const item = batch?.items.find((entry) => entry.bucket_id === ack.bucket_id);
        if (item === undefined) throw new Error('unexpected-receipt-entry');
        if (ack.stream_id !== item.stream_id) throw new Error('receipt-stream-mismatch');
        if ((ack.status === 'applied' || ack.status === 'duplicate') && ack.revision === item.revision && ack.payload_hash === item.payload_hash) {
          const sourceRow = this.stmt('SELECT origins FROM outbox WHERE dest=? AND bucket=? AND revision=?').get(id, item.bucket_id, item.revision) as Row | undefined;
          const origins = String(sourceRow?.['origins'] ?? (this.stmt('SELECT origins FROM acknowledgements WHERE dest=? AND bucket=?').get(id, item.bucket_id) as Row | undefined)?.['origins'] ?? '[]');
          const ackChanges = this.stmt('INSERT INTO acknowledgements(dest,bucket,revision,hash,confirmed,item,origins,mapping_version) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dest,bucket) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,confirmed=excluded.confirmed,item=excluded.item,origins=excluded.origins,mapping_version=excluded.mapping_version WHERE excluded.revision>=acknowledgements.revision').run(id, ack.bucket_id, ack.revision, ack.payload_hash, now, JSON.stringify(item), origins, mappingVersion).changes;
          if (Number(ackChanges) > 0) this.syncOrigins('ack', id, ack.bucket_id, ack.revision, JSON.parse(origins) as string[]);
          this.stmt("DELETE FROM bucket_origins WHERE kind='outbox' AND dest=? AND bucket=? AND revision<=?").run(id, ack.bucket_id, item.revision);
          this.stmt('DELETE FROM outbox WHERE dest=? AND bucket=? AND revision<=?').run(id, ack.bucket_id, item.revision); acknowledged++;
        } else if (['conflict', 'rejected', 'remote_diverged', 'stale'].includes(ack.status)) {
          this.stmt("UPDATE outbox SET state='quarantined' WHERE dest=? AND bucket=? AND revision=?").run(id, ack.bucket_id, item.revision); rejected++;
          this.update(id, { state: ack.status === 'remote_diverged' ? 'remote-diverged' : 'quarantined', error_category: `receipt-${ack.status}` });
        } else throw new Error('receipt-version-mismatch');
      }
      const remaining = Number((this.stmt("SELECT COUNT(*) AS n FROM outbox WHERE dest=? AND batch=? AND state='inflight'").get(id, clean.batch_id) as Row)['n']);
      if (remaining === 0) this.stmt('DELETE FROM batches WHERE dest=? AND batch=?').run(id, clean.batch_id);
      return { acknowledged, rejected, remaining };
    });
  }
  releaseBatch(id: string, batch: string, quarantine = false): void {
    this.transaction(() => {
      this.stmt("UPDATE outbox SET state=?,batch=NULL WHERE dest=? AND batch=? AND state='inflight'").run(quarantine ? 'quarantined' : 'pending', id, batch);
      this.stmt('DELETE FROM batches WHERE dest=? AND batch=?').run(id, batch);
      if (!quarantine) {
        this.stmt("DELETE FROM bucket_origins WHERE kind='outbox' AND dest=? AND (bucket,revision) IN (SELECT bucket,revision FROM outbox WHERE dest=? AND state='pending' AND revision < (SELECT MAX(newer.revision) FROM outbox newer WHERE newer.dest=outbox.dest AND newer.bucket=outbox.bucket AND newer.state='pending'))").run(id, id);
        this.stmt("DELETE FROM outbox WHERE dest=? AND state='pending' AND revision < (SELECT MAX(newer.revision) FROM outbox newer WHERE newer.dest=outbox.dest AND newer.bucket=outbox.bucket AND newer.state='pending')").run(id);
      }
    });
  }
  withdraw(id: string): void {
    this.transaction(() => {
      this.setMeta(`withdrawn:${id}`, 'true');
      const streamId = this.get(id).stream_id;
      for (const row of this.stmt('SELECT bucket FROM versions WHERE dest=?').all(id) as Row[]) this.version(id, String(row['bucket']), 'delete', null, streamId);
      if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full');
    });
  }
  retryQuarantined(id: string): void {
    this.transaction(() => {
      this.stmt("UPDATE outbox SET state='pending',batch=NULL WHERE dest=? AND state='quarantined'").run(id);
      this.stmt("DELETE FROM bucket_origins WHERE kind='outbox' AND dest=? AND (bucket,revision) IN (SELECT bucket,revision FROM outbox WHERE dest=? AND state='pending' AND revision < (SELECT MAX(newer.revision) FROM outbox newer WHERE newer.dest=outbox.dest AND newer.bucket=outbox.bucket AND newer.state='pending'))").run(id, id);
      this.stmt("DELETE FROM outbox WHERE dest=? AND state='pending' AND revision < (SELECT MAX(newer.revision) FROM outbox newer WHERE newer.dest=outbox.dest AND newer.bucket=outbox.bucket AND newer.state='pending')").run(id);
    });
  }
  clearQueue(id: string): void {
    this.transaction(() => {
      this.stmt("DELETE FROM bucket_origins WHERE kind='outbox' AND dest=?").run(id);
      this.stmt('DELETE FROM outbox WHERE dest=?').run(id);
      this.stmt('DELETE FROM batches WHERE dest=?').run(id);
      this.update(id, { enabled: false, state: 'disabled', error_category: 'queue-explicitly-cleared' });
    });
  }
  remove(id: string): void {
    this.transaction(() => {
      this.stmt('DELETE FROM outbox WHERE dest=?').run(id);
      this.stmt('DELETE FROM batches WHERE dest=?').run(id);
      this.stmt('DELETE FROM versions WHERE dest=?').run(id);
      this.stmt('DELETE FROM acknowledgements WHERE dest=?').run(id);
      this.stmt('DELETE FROM bucket_origins WHERE dest=?').run(id);
      const suffix = `:${id}`;
      this.stmt('DELETE FROM meta WHERE length(key)>=? AND substr(key,-?)=?').run(suffix.length, suffix.length, suffix);
      this.stmt('DELETE FROM destinations WHERE id=?').run(id);
    });
    try { this.db.exec('PRAGMA incremental_vacuum(64)'); } catch {}
  }
  exportQueue(id: string): UsageExportItem[] { return (this.stmt('SELECT item FROM outbox WHERE dest=? ORDER BY created,bucket,revision').all(id) as Row[]).map((row) => usageExportItemSchema.parse(JSON.parse(String(row['item'])))); }
  ack(id: string, bucket: string): { revision: number; hash: string } | undefined { const row = this.stmt('SELECT revision,hash FROM acknowledgements WHERE dest=? AND bucket=?').get(id, bucket) as Row | undefined; return row === undefined ? undefined : { revision: Number(row['revision']), hash: String(row['hash']) }; }
  acknowledgedRelated(id: string, batch: UsageExportBatch): { acknowledged: UsageExportItem; current: UsageExportItem | null; sameBucket: boolean; mappingVersion: string | null }[] {
    const result: { acknowledged: UsageExportItem; current: UsageExportItem | null; sameBucket: boolean; mappingVersion: string | null }[] = [];
    const ackRows = this.stmt('SELECT bucket,item,origins,mapping_version FROM acknowledgements WHERE dest=? AND item IS NOT NULL').all(id) as Row[];
    const versionStmt = this.stmt('SELECT item FROM versions WHERE dest=? AND bucket=?');
    const outboxOriginStmt = this.stmt('SELECT origins FROM outbox WHERE dest=? AND bucket=? AND revision=?');
    const batchOrigins = new Map<string, Set<string>>();
    for (const item of batch.items) {
      if (item.operation !== 'replace') continue;
      const originRow = outboxOriginStmt.get(id, item.bucket_id, item.revision) as Row | undefined;
      batchOrigins.set(`${item.bucket_id}\0${item.revision}`, new Set(JSON.parse(String(originRow?.['origins'] ?? '[]')) as string[]));
    }
    for (const row of ackRows) {
      const acknowledged = usageExportItemSchema.parse(JSON.parse(String(row['item'])));
      const currentRow = versionStmt.get(id, String(row['bucket'])) as Row | undefined;
      const current = currentRow === undefined ? null : usageExportItemSchema.parse(JSON.parse(String(currentRow['item'])));
      const mappingVersion = row['mapping_version'] === null || row['mapping_version'] === undefined ? null : String(row['mapping_version']);
      const oldOrigins = JSON.parse(String(row['origins'])) as string[];
      for (const item of batch.items) {
        const sameBucket = item.bucket_id === acknowledged.bucket_id && item.stream_id === acknowledged.stream_id;
        if (sameBucket) { result.push({ acknowledged, current, sameBucket, mappingVersion }); break; }
        if (acknowledged.operation !== 'replace' || item.operation !== 'replace' || acknowledged.bucket?.start_at !== item.bucket?.start_at || current?.payload_hash === acknowledged.payload_hash) continue;
        const newOrigins = batchOrigins.get(`${item.bucket_id}\0${item.revision}`);
        if (newOrigins !== undefined && oldOrigins.some((source) => newOrigins.has(source))) { result.push({ acknowledged, current, sameBucket: false, mappingVersion }); break; }
      }
    }
    return result;
  }
  capacity(): number { return Number(this.meta('capacity') ?? 52_428_800); }
  setCapacity(bytes: number): void { if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 1024 ** 3) throw new Error('invalid-queue-capacity'); this.setMeta('capacity', String(bytes)); }
  private totalBytes(): number { return Number((this.stmt('SELECT COALESCE(SUM(bytes),0) AS n FROM outbox').get() as Row)['n']); }
  invalidRecords(): number { return Number((this.stmt('SELECT COALESCE(SUM(invalid),0) AS n FROM sources').get() as Row)['n']); }
  queue(id: string): UsageExportQueue {
    const rows = this.stmt('SELECT state,COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes,MIN(created) AS oldest FROM outbox WHERE dest=? GROUP BY state').all(id) as Row[];
    const n = (state: string) => Number(rows.find((row) => row['state'] === state)?.['n'] ?? 0);
    const bytes = rows.reduce((sum, row) => sum + Number(row['bytes']), 0); const oldest = rows.reduce<number | null>((min, row) => min === null ? Number(row['oldest']) : Math.min(min, Number(row['oldest'])), null);
    return { pending: n('pending'), inflight: n('inflight'), quarantined: n('quarantined'), bytes, limit_bytes: this.capacity(), warning: this.totalBytes() >= this.capacity() * 0.8, oldest_at: oldest };
  }
  close(): void { if (this.closed) return; this.closed = true; this.stmts.clear(); this.db.close(); if (this.writer) this.election.exec('ROLLBACK'); this.election.close(); }
}
