import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { usageExportDestinationSchema, usageExportItemSchema, usageExportReceiptSchema, type UsageExportBatch, type UsageExportDestination, type UsageExportItem, type UsageExportQueue, type UsageExportReceipt } from '@kiki/protocol';
import { contributionSchema, digest, normalizePublicModel, opaqueId, publicBucket, addTokens, addQuality, type Contribution, type SourceContribution } from './projection';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

interface Row { [key: string]: string | number | null }
interface SourceRow { id: Uint8Array; workspace: string; kind: string; data: string }
interface PrivateDestination { destination: UsageExportDestination; identityKey: string }
interface ProjectionPlan { buckets: Map<string, ReturnType<typeof publicBucket>>; origins: Map<string, Set<string>>; destinationStamp: string; sourceGeneration: string | null }
interface ProjectionAccumulator { contribution: Contribution; pricingVersions: Set<string> }
export class UsageExportStore {
  private readonly db: DatabaseSync;
  private readonly election: DatabaseSync;
  private fence = '';
  private closed = false;
  private readonly projectedOrigins = new Map<string, Set<string>>();
  private elected: boolean;
  get writer(): boolean { return this.elected; }
  constructor(path: string, private readonly legacyDisabled?: boolean) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.election = new DatabaseSync(`${path}.writer.sqlite`);
    this.election.exec('PRAGMA busy_timeout=0');
    let writer = false;
    try { this.election.exec('BEGIN IMMEDIATE'); writer = true; } catch {}
    this.elected = writer;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (writer) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, invalid INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS staging(run TEXT NOT NULL, id TEXT NOT NULL, workspace TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, invalid INTEGER NOT NULL, PRIMARY KEY(run,id));
        CREATE TABLE IF NOT EXISTS destinations(id TEXT PRIMARY KEY, data TEXT NOT NULL, identity_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS versions(dest TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(dest,bucket));
        CREATE TABLE IF NOT EXISTS outbox(dest TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL, item TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL, batch TEXT, created INTEGER NOT NULL, PRIMARY KEY(dest,bucket,revision));
        CREATE TABLE IF NOT EXISTS acknowledgements(dest TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, confirmed INTEGER NOT NULL, PRIMARY KEY(dest,bucket));
        CREATE TABLE IF NOT EXISTS batches(dest TEXT PRIMARY KEY, batch TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS queue_by_destination ON outbox(dest,state,created);
      `);
      for (const table of ['versions', 'outbox', 'acknowledgements']) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
        if (!columns.some((column) => column['name'] === 'origins')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN origins TEXT NOT NULL DEFAULT '[]'`);
        if (table === 'acknowledgements' && !columns.some((column) => column['name'] === 'item')) this.db.exec('ALTER TABLE acknowledgements ADD COLUMN item TEXT');
      }
      this.fence = randomUUID();
      this.db.prepare("INSERT INTO meta VALUES('fence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.fence);
      this.db.prepare("INSERT OR IGNORE INTO meta VALUES('capacity','52428800')").run();
      this.db.exec('DELETE FROM staging;');
      this.retireExperimentalGate();
    }
  }
  tryPromote(): boolean {
    if (this.closed) return false; if (this.writer) return true;
    try { this.election.exec('BEGIN IMMEDIATE'); } catch { return false; }
    this.fence = randomUUID(); this.elected = true;
    this.db.prepare("INSERT INTO meta VALUES('fence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.fence);
    this.db.exec('DELETE FROM staging;'); this.retireExperimentalGate(); return true;
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
    if (this.closed || !this.writer || (this.db.prepare("SELECT value FROM meta WHERE key='fence'").get() as Row | undefined)?.['value'] !== this.fence) throw new Error('export-writer-unavailable');
  }
  private transaction<T>(work: () => T): T {
    this.assertWriter(); this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.assertWriter(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  meta(key: string): string | null { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined)?.['value'] as string | undefined ?? null; }
  setMeta(key: string, value: string): void { this.assertWriter(); this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  installationKey(): string { let key = this.meta('installation-key'); if (key === null) { key = randomBytes(32).toString('hex'); this.setMeta('installation-key', key); } return key; }
  list(): UsageExportDestination[] { return (this.db.prepare('SELECT data FROM destinations ORDER BY id').all() as Row[]).map((row) => usageExportDestinationSchema.parse(JSON.parse(String(row['data'])))); }
  get(id: string): UsageExportDestination { const row = this.db.prepare('SELECT data FROM destinations WHERE id=?').get(id) as Row | undefined; if (row === undefined) throw new Error('destination-not-found'); return usageExportDestinationSchema.parse(JSON.parse(String(row['data']))); }
  private privateDestination(id: string): PrivateDestination { const row = this.db.prepare('SELECT data,identity_key FROM destinations WHERE id=?').get(id) as Row | undefined; if (row === undefined) throw new Error('destination-not-found'); return { destination: usageExportDestinationSchema.parse(JSON.parse(String(row['data']))), identityKey: String(row['identity_key']) }; }
  save(destination: UsageExportDestination): void {
    this.assertWriter(); const clean = usageExportDestinationSchema.parse(destination);
    this.db.prepare('INSERT INTO destinations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(clean.id, JSON.stringify(clean), randomBytes(32).toString('hex'));
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
  async updateWithMetadataAsync(id: string, change: Partial<UsageExportDestination>, metadata: Readonly<Record<string, string>>): Promise<UsageExportDestination> {
    const plan = await this.projectionPlan(id, undefined, { ...this.get(id), ...change });
    return this.transaction(() => {
      this.assertProjection(id, plan); const next = this.update(id, change);
      for (const [key, value] of Object.entries(metadata)) this.setMeta(key, value);
      this.publishDestination(id, plan); if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full'); return next;
    });
  }
  stage(run: string, source: SourceContribution): void {
    this.assertWriter();
    this.db.prepare('INSERT INTO staging VALUES(?,?,?,?,?,?) ON CONFLICT(run,id) DO UPDATE SET workspace=excluded.workspace,kind=excluded.kind,data=excluded.data,invalid=excluded.invalid').run(run, source.key, source.workspaceId, source.kind, JSON.stringify(source.buckets.map((bucket) => contributionSchema.parse(bucket))), source.invalidRecords);
  }
  discardStage(run: string): void { this.assertWriter(); this.db.prepare('DELETE FROM staging WHERE run=?').run(run); }
  async publishStageAsync(run: string, complete = true, incompleteReason: string | null = null): Promise<void> {
    const plans = new Map<string, ProjectionPlan>();
    for (const destination of this.list()) if (destination.enabled) plans.set(destination.id, await this.projectionPlan(destination.id, run));
    this.publishStage(run, complete, incompleteReason, plans);
  }
  publishStage(run: string, complete = true, incompleteReason: string | null = null, plans?: Map<string, ProjectionPlan>): void {
    this.transaction(() => {
      if (plans !== undefined) {
        const enabled = this.list().filter((destination) => destination.enabled);
        if (enabled.length !== plans.size || enabled.some((destination) => !plans.has(destination.id))) throw new Error('export-projection-changed');
        for (const [id, plan] of plans) this.assertProjection(id, plan);
      }
      const missing = (this.db.prepare('SELECT COUNT(*) AS n FROM sources WHERE id NOT IN (SELECT id FROM staging WHERE run=?)').get(run) as Row)['n'];
      this.db.prepare('INSERT INTO sources SELECT id,workspace,kind,data,invalid FROM staging WHERE run=? ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,kind=excluded.kind,data=excluded.data,invalid=excluded.invalid').run(run);
      if (complete) this.setMeta('scan-complete', 'true');
      this.setMeta('scan-error', incompleteReason ?? (Number(missing) > 0 ? 'source-missing-retained-gap' : ''));
      for (const destination of this.list()) if (destination.enabled) this.publishDestination(destination.id, plans?.get(destination.id));
      if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full');
      this.setMeta('source-generation', randomUUID());
      this.db.prepare('DELETE FROM staging WHERE run=?').run(run);
    });
  }
  refreshDestination(id: string): void { this.transaction(() => { this.publishDestination(id); if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full'); }); }
  async refreshDestinationAsync(id: string): Promise<void> { const plan = await this.projectionPlan(id); this.transaction(() => { this.assertProjection(id, plan); this.publishDestination(id, plan); if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full'); }); }
  private projectionStamp(destination: UsageExportDestination): string { return digest({ scope: destination.scope, stream: destination.stream_id, target: destination.target, account: destination.account_fingerprint, enabled: destination.enabled, consent: destination.consent_fingerprint }); }
  private accumulateProjection(row: SourceRow, destination: UsageExportDestination, identityKey: string, groups: Map<string, ProjectionAccumulator>, origins: Map<string, Set<string>>): void {
    if (destination.scope.excluded_workspace_ids.includes(String(row['workspace'])) || (row['kind'] === 'ephemeral' && !destination.scope.include_ephemeral)) return;
    const buckets: unknown = JSON.parse(String(row['data'])); if (!Array.isArray(buckets)) throw new Error('invalid-stored-contribution');
    for (const value of buckets) {
      const bucket = contributionSchema.parse(value);
      if (bucket.start < destination.scope.start_at || (destination.scope.end_at !== null && bucket.start >= destination.scope.end_at)) continue;
      const rawModel = bucket.upstream_model_id ?? bucket.model_alias;
      const model = normalizePublicModel(rawModel) ?? `custom-${opaqueId(identityKey, `model\0${rawModel}`).slice(0, 32)}`;
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
  private async projectionPlan(id: string, run?: string, override?: UsageExportDestination): Promise<ProjectionPlan> {
    const saved = this.privateDestination(id); const destination = override ?? saved.destination; const identityKey = saved.identityKey; const sourceGeneration = this.meta('source-generation');
    const groups = new Map<string, ProjectionAccumulator>(); const origins = new Map<string, Set<string>>(); let cursor = '';
    for (;;) {
      const rows = (run === undefined ? this.db.prepare('SELECT CAST(id AS BLOB) AS id,workspace,kind,data FROM sources WHERE id>? ORDER BY id LIMIT 16').all(cursor) : this.db.prepare('SELECT CAST(id AS BLOB) AS id,workspace,kind,data FROM staging WHERE run=? AND id>? UNION ALL SELECT CAST(id AS BLOB) AS id,workspace,kind,data FROM sources WHERE id>? AND id NOT IN (SELECT id FROM staging WHERE run=?) ORDER BY id LIMIT 16').all(run, cursor, cursor, run)) as unknown as SourceRow[];
      if (rows.length === 0) break;
      for (const row of rows) this.accumulateProjection(row, destination, identityKey, groups, origins);
      cursor = Buffer.from(rows.at(-1)!.id).toString('utf8'); await yieldToEventLoop();
    }
    if (sourceGeneration !== this.meta('source-generation') || this.projectionStamp(saved.destination) !== this.projectionStamp(this.get(id))) throw new Error('export-projection-changed');
    return { buckets: this.finishProjection(groups, identityKey), origins, sourceGeneration, destinationStamp: this.projectionStamp(saved.destination) };
  }
  private assertProjection(id: string, plan: ProjectionPlan): void { if (plan.sourceGeneration !== this.meta('source-generation') || plan.destinationStamp !== this.projectionStamp(this.get(id))) throw new Error('export-projection-changed'); }
  async previewAsync(id: string, limit = 20): Promise<{ items: UsageExportItem[]; total: number }> { const plan = await this.projectionPlan(id); this.assertProjection(id, plan); return this.previewProjected(id, plan.buckets, limit); }
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
    const old = this.db.prepare('SELECT bucket,item FROM versions WHERE dest=?').all(id) as Row[];
    for (const row of old) if (!projected.has(String(row['bucket']))) this.version(id, String(row['bucket']), 'delete', null);
    for (const [key, bucket] of projected) this.version(id, key, 'replace', bucket);
    if (destination.state === 'queue-full') this.update(id, { state: 'ready', error_category: null });
  }
  private version(id: string, bucketId: string, operation: UsageExportItem['operation'], bucket: UsageExportItem['bucket']): void {
    const previous = this.db.prepare('SELECT revision,hash,origins FROM versions WHERE dest=? AND bucket=?').get(id, bucketId) as Row | undefined;
    const origins = this.projectedOrigins.has(bucketId) ? JSON.stringify([...this.projectedOrigins.get(bucketId) ?? []].sort()) : String(previous?.['origins'] ?? '[]');
    const payloadHash = digest({ operation, bucket }); if (previous?.['hash'] === payloadHash) { this.db.prepare('UPDATE versions SET origins=? WHERE dest=? AND bucket=?').run(origins, id, bucketId); return; }
    const item = usageExportItemSchema.parse({ schema_version: 'kiki.usage.bucket.v1', stream_id: this.get(id).stream_id, bucket_id: bucketId, revision: Number(previous?.['revision'] ?? 0) + 1, payload_hash: payloadHash, operation, bucket });
    const json = JSON.stringify(item);
    this.db.prepare('INSERT INTO versions(dest,bucket,revision,hash,item,origins) VALUES(?,?,?,?,?,?) ON CONFLICT(dest,bucket) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,item=excluded.item,origins=excluded.origins').run(id, bucketId, item.revision, payloadHash, json, origins);
    this.db.prepare("DELETE FROM outbox WHERE dest=? AND bucket=? AND state='pending'").run(id, bucketId);
    this.db.prepare("INSERT INTO outbox(dest,bucket,revision,item,bytes,state,batch,created,origins) VALUES(?,?,?,?,?,'pending',NULL,?,?)").run(id, bucketId, item.revision, json, Buffer.byteLength(json), Date.now(), origins);
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
  acknowledge(id: string, receipt: UsageExportReceipt, now: number): { acknowledged: number; rejected: number; remaining: number } {
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
          const sourceRow = this.db.prepare('SELECT origins FROM outbox WHERE dest=? AND bucket=? AND revision=?').get(id, item.bucket_id, item.revision) as Row | undefined;
          const origins = String(sourceRow?.['origins'] ?? (this.db.prepare('SELECT origins FROM acknowledgements WHERE dest=? AND bucket=?').get(id, item.bucket_id) as Row | undefined)?.['origins'] ?? '[]');
          this.db.prepare('INSERT INTO acknowledgements(dest,bucket,revision,hash,confirmed,item,origins) VALUES(?,?,?,?,?,?,?) ON CONFLICT(dest,bucket) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,confirmed=excluded.confirmed,item=excluded.item,origins=excluded.origins WHERE excluded.revision>=acknowledgements.revision').run(id, ack.bucket_id, ack.revision, ack.payload_hash, now, JSON.stringify(item), origins);
          this.db.prepare('DELETE FROM outbox WHERE dest=? AND bucket=? AND revision=?').run(id, ack.bucket_id, item.revision); acknowledged++;
        } else if (['conflict', 'rejected', 'remote_diverged', 'stale'].includes(ack.status)) {
          this.db.prepare("UPDATE outbox SET state='quarantined' WHERE dest=? AND bucket=? AND revision=?").run(id, ack.bucket_id, item.revision); rejected++;
          this.update(id, { state: ack.status === 'remote_diverged' ? 'remote-diverged' : 'quarantined', error_category: `receipt-${ack.status}` });
        } else throw new Error('receipt-version-mismatch');
      }
      const remaining = Number((this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE dest=? AND batch=? AND state='inflight'").get(id, clean.batch_id) as Row)['n']);
      if (remaining === 0) this.db.prepare('DELETE FROM batches WHERE dest=? AND batch=?').run(id, clean.batch_id);
      return { acknowledged, rejected, remaining };
    });
  }
  releaseBatch(id: string, batch: string, quarantine = false): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET state=?,batch=NULL WHERE dest=? AND batch=? AND state='inflight'").run(quarantine ? 'quarantined' : 'pending', id, batch);
      this.db.prepare('DELETE FROM batches WHERE dest=? AND batch=?').run(id, batch);
      if (!quarantine) this.db.prepare("DELETE FROM outbox WHERE dest=? AND state='pending' AND revision < (SELECT MAX(newer.revision) FROM outbox newer WHERE newer.dest=outbox.dest AND newer.bucket=outbox.bucket AND newer.state='pending')").run(id);
    });
  }
  withdraw(id: string): void { this.transaction(() => { this.setMeta(`withdrawn:${id}`, 'true'); for (const row of this.db.prepare('SELECT bucket FROM versions WHERE dest=?').all(id) as Row[]) this.version(id, String(row['bucket']), 'delete', null); if (this.totalBytes() > this.capacity()) throw new Error('export-queue-full'); }); }
  retryQuarantined(id: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET state='pending',batch=NULL WHERE dest=? AND state='quarantined'").run(id);
      this.db.prepare("DELETE FROM outbox WHERE dest=? AND state='pending' AND revision < (SELECT MAX(newer.revision) FROM outbox newer WHERE newer.dest=outbox.dest AND newer.bucket=outbox.bucket AND newer.state='pending')").run(id);
    });
  }
  clearQueue(id: string): void { this.transaction(() => { this.db.prepare('DELETE FROM outbox WHERE dest=?').run(id); this.db.prepare('DELETE FROM batches WHERE dest=?').run(id); this.update(id, { enabled: false, state: 'disabled', error_category: 'queue-explicitly-cleared' }); }); }
  remove(id: string): void { this.transaction(() => { this.db.prepare('DELETE FROM outbox WHERE dest=?').run(id); this.db.prepare('DELETE FROM batches WHERE dest=?').run(id); this.db.prepare('DELETE FROM destinations WHERE id=?').run(id); }); }
  exportQueue(id: string): UsageExportItem[] { return (this.db.prepare('SELECT item FROM outbox WHERE dest=? ORDER BY created,bucket,revision').all(id) as Row[]).map((row) => usageExportItemSchema.parse(JSON.parse(String(row['item'])))); }
  ack(id: string, bucket: string): { revision: number; hash: string } | undefined { const row = this.db.prepare('SELECT revision,hash FROM acknowledgements WHERE dest=? AND bucket=?').get(id, bucket) as Row | undefined; return row === undefined ? undefined : { revision: Number(row['revision']), hash: String(row['hash']) }; }
  acknowledgedRelated(id: string, batch: UsageExportBatch): { acknowledged: UsageExportItem; current: UsageExportItem | null; sameBucket: boolean }[] {
    const result: { acknowledged: UsageExportItem; current: UsageExportItem | null; sameBucket: boolean }[] = [];
    const ackRows = this.db.prepare('SELECT bucket,item,origins FROM acknowledgements WHERE dest=? AND item IS NOT NULL').all(id) as Row[];
    for (const row of ackRows) {
      const acknowledged = usageExportItemSchema.parse(JSON.parse(String(row['item'])));
      const currentRow = this.db.prepare('SELECT item FROM versions WHERE dest=? AND bucket=?').get(id, String(row['bucket'])) as Row | undefined;
      const current = currentRow === undefined ? null : usageExportItemSchema.parse(JSON.parse(String(currentRow['item'])));
      const oldOrigins = JSON.parse(String(row['origins'])) as string[];
      for (const item of batch.items) {
        const sameBucket = item.bucket_id === acknowledged.bucket_id && item.stream_id === acknowledged.stream_id;
        if (sameBucket) { result.push({ acknowledged, current, sameBucket }); break; }
        if (acknowledged.operation !== 'replace' || item.operation !== 'replace' || acknowledged.bucket?.start_at !== item.bucket?.start_at || current?.payload_hash === acknowledged.payload_hash) continue;
        const originRow = this.db.prepare('SELECT origins FROM outbox WHERE dest=? AND bucket=? AND revision=?').get(id, item.bucket_id, item.revision) as Row | undefined;
        const newOrigins = JSON.parse(String(originRow?.['origins'] ?? '[]')) as string[];
        if (oldOrigins.some((source) => newOrigins.includes(source))) { result.push({ acknowledged, current, sameBucket: false }); break; }
      }
    }
    return result;
  }
  capacity(): number { return Number(this.meta('capacity') ?? 52_428_800); }
  setCapacity(bytes: number): void { if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 1024 ** 3) throw new Error('invalid-queue-capacity'); this.setMeta('capacity', String(bytes)); }
  private totalBytes(): number { return Number((this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM outbox').get() as Row)['n']); }
  invalidRecords(): number { return Number((this.db.prepare('SELECT COALESCE(SUM(invalid),0) AS n FROM sources').get() as Row)['n']); }
  queue(id: string): UsageExportQueue {
    const rows = this.db.prepare('SELECT state,COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes,MIN(created) AS oldest FROM outbox WHERE dest=? GROUP BY state').all(id) as Row[];
    const n = (state: string) => Number(rows.find((row) => row['state'] === state)?.['n'] ?? 0);
    const bytes = rows.reduce((sum, row) => sum + Number(row['bytes']), 0); const oldest = rows.reduce<number | null>((min, row) => min === null ? Number(row['oldest']) : Math.min(min, Number(row['oldest'])), null);
    return { pending: n('pending'), inflight: n('inflight'), quarantined: n('quarantined'), bytes, limit_bytes: this.capacity(), warning: this.totalBytes() >= this.capacity() * 0.8, oldest_at: oldest };
  }
  close(): void { if (this.closed) return; this.closed = true; this.db.close(); if (this.writer) this.election.exec('ROLLBACK'); this.election.close(); }
}
