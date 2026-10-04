import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { usageExportBatchSchema, usageExportItemSchema, type UsageExportBatch, type UsageExportItem, type UsageExportReceipt } from '@kiki/protocol';
import { digest } from './projection';

interface ReceiverRow { revision: number; hash: string; item: string }
export class UsageExportReceiver {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS buckets(stream TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(stream,bucket));');
  }
  apply(input: UsageExportBatch): UsageExportReceipt {
    const batch = usageExportBatchSchema.parse(input); const seen = new Set<string>();
    for (const item of batch.items) {
      const key = `${item.stream_id}/${item.bucket_id}`; if (seen.has(key)) throw new Error('duplicate-bucket-in-batch'); seen.add(key);
      if (digest({ operation: item.operation, bucket: item.bucket }) !== item.payload_hash) throw new Error('payload-hash-mismatch');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statuses = batch.items.map((item) => {
        const old = this.db.prepare('SELECT revision,hash,item FROM buckets WHERE stream=? AND bucket=?').get(item.stream_id, item.bucket_id) as ReceiverRow | undefined;
        const status = old === undefined || item.revision > old.revision ? 'applied' : item.revision < old.revision ? 'stale' : item.payload_hash === old.hash ? 'duplicate' : 'conflict';
        return { item, old, status };
      });
      const conflict = statuses.some((entry) => entry.status === 'conflict');
      const items: UsageExportReceipt['items'] = statuses.map(({ item, old, status }) => {
        if (!conflict && status === 'applied') this.db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?) ON CONFLICT(stream,bucket) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,item=excluded.item').run(item.stream_id, item.bucket_id, item.revision, item.payload_hash, JSON.stringify(item));
        const persisted = status === 'stale' && old !== undefined ? old : item;
        return { stream_id: item.stream_id, bucket_id: item.bucket_id, revision: persisted.revision, payload_hash: 'hash' in persisted ? persisted.hash : persisted.payload_hash, status: conflict && status === 'applied' ? 'rejected' : status as UsageExportReceipt['items'][number]['status'] };
      });
      this.db.exec('COMMIT'); return { schema_version: 'kiki.usage.receipt.v1', batch_id: batch.batch_id, items };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  read(stream: string, bucket: string): UsageExportItem | undefined { const row = this.db.prepare('SELECT item FROM buckets WHERE stream=? AND bucket=?').get(stream, bucket) as ReceiverRow | undefined; return row === undefined ? undefined : usageExportItemSchema.parse(JSON.parse(row.item)); }
  close(): void { this.db.close(); }
}
function equal(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
/** Minimal receiver example. Bind this server explicitly; production deployments must provide TLS and persist the receiver database. */
export function createUsageExportReceiverServer(receiver: UsageExportReceiver, auth: { bearer?: string; hmac?: string } = {}): Server {
  return createServer((req, res) => {
    void (async () => {
    if (req.method !== 'POST' || req.url !== '/usage') { res.writeHead(404).end(); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const value of req) { const chunk = Buffer.from(value); bytes += chunk.length; if (bytes > 1_048_576) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const transmitted = Buffer.concat(chunks);
      if (auth.bearer !== undefined && !equal(String(req.headers['authorization'] ?? ''), `Bearer ${auth.bearer}`)) { res.writeHead(401).end(); return; }
      if (auth.hmac !== undefined) {
        const timestamp = String(req.headers['x-kiki-usage-timestamp'] ?? ''); const batch = String(req.headers['x-kiki-usage-batch'] ?? '');
        const hash = createHash('sha256').update(transmitted).digest('hex');
        const signature = createHmac('sha256', auth.hmac).update(`${timestamp}\n${batch}\n${hash}`).digest('hex');
        if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !equal(String(req.headers['x-kiki-usage-signature'] ?? ''), signature)) { res.writeHead(401).end(); return; }
      }
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(transmitted, { maxOutputLength: 1_048_576 }) : transmitted;
      const input: unknown = JSON.parse(body.toString('utf8'));
      if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
        const probe = input as Record<string, unknown>;
        if (probe['schema_version'] === 'kiki.usage.test.v1' && typeof probe['nonce'] === 'string' && /^[a-f0-9]{48}$/.test(probe['nonce']) && Object.keys(probe).length === 2) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ schema_version: 'kiki.usage.test.v1', nonce: probe['nonce'], protocol: 'kiki.usage.bucket.v1' })); return;
        }
      }
      const batch = usageExportBatchSchema.parse(input);
      if (auth.hmac !== undefined && req.headers['x-kiki-usage-batch'] !== batch.batch_id) { res.writeHead(400).end(); return; }
      const receipt = receiver.apply(batch); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(receipt));
    } catch { res.writeHead(400).end(JSON.stringify({ error: 'invalid-usage-protocol' })); }
    })().catch(() => { res.destroy(); });
  });
}
