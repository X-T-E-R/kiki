import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import { LegacyMinidbLock, legacyMinidbOpener, shardDirName } from '#/persistence/backends/sqliteMailbox/legacyMinidbReader';

export interface LegacyWriteOp {
  readonly op: 'set' | 'del';
  readonly key: string;
  readonly value?: Record<string, unknown>;
  readonly ttl?: number;
}

function encodeFrame(type: number, key: Buffer, value: Buffer, expireAt: number): Buffer {
  const frame = Buffer.allocUnsafe(22 + key.length + value.length + 4);
  frame[0] = 0x4d;
  frame[1] = 0x44;
  frame.writeUInt8(type, 2);
  frame.writeUInt8(0, 3);
  frame.writeUInt16LE(key.length, 4);
  frame.writeUInt32LE(value.length, 6);
  frame.writeUInt32LE(0, 10);
  frame.writeBigInt64LE(BigInt(expireAt), 14);
  key.copy(frame, 22);
  value.copy(frame, 22 + key.length);
  const checksum = crc32(frame.subarray(2, 22 + key.length + value.length)) >>> 0;
  frame.writeUInt32LE(checksum, 22 + key.length + value.length);
  return frame;
}

function shardFor(key: string, shardCount: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) >>> 0;
  return hash % shardCount;
}

export class LegacyMinidbFixture {
  private readonly lock: LegacyMinidbLock;
  private readonly expires = new Map<string, number>();

  private constructor(readonly dir: string, lock: LegacyMinidbLock) {
    this.lock = lock;
  }

  static async open(dir: string): Promise<LegacyMinidbFixture> {
    await mkdir(dir, { recursive: true });
    const lock = new LegacyMinidbLock(join(dir, 'db.lock'));
    if (!await lock.acquire()) throw new Error(`Legacy fixture lock held: ${lock.path}`);
    return new LegacyMinidbFixture(dir, lock);
  }

  async batch(ops: readonly LegacyWriteOp[]): Promise<void> {
    const chunks: Buffer[] = [];
    for (const op of ops) {
      const expireAt = op.ttl !== undefined && op.ttl > 0 ? Date.now() + op.ttl : 0;
      if (op.op === 'set') {
        this.expires.set(op.key, expireAt);
        chunks.push(encodeFrame(1, Buffer.from(op.key, 'utf8'), Buffer.from(JSON.stringify(op.value ?? {}), 'utf8'), expireAt));
      } else {
        this.expires.delete(op.key);
        chunks.push(encodeFrame(2, Buffer.from(op.key, 'utf8'), Buffer.alloc(0), 0));
      }
    }
    if (chunks.length > 0) await appendFile(join(this.dir, 'db.wal'), Buffer.concat(chunks));
  }

  expireAtOf(key: string): number {
    return this.expires.get(key) ?? 0;
  }

  async close(): Promise<void> {
    await this.lock.release();
  }
}

export class LegacyClusterFixture {
  private readonly shards: readonly LegacyMinidbFixture[];

  private constructor(readonly dir: string, shards: readonly LegacyMinidbFixture[]) {
    this.shards = shards;
  }

  static async open(dir: string, shardCount = 2): Promise<LegacyClusterFixture> {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'cluster.meta.json'),
      JSON.stringify({ version: 1, shardCount, createdAt: new Date().toISOString(), valueCodec: 'json', fsyncPolicy: 'always' }, null, 2),
      'utf8',
    );
    const shards: LegacyMinidbFixture[] = [];
    for (let i = 0; i < shardCount; i += 1) {
      shards.push(await LegacyMinidbFixture.open(join(dir, shardDirName(i, shardCount))));
    }
    return new LegacyClusterFixture(dir, shards);
  }

  async partitionBatch(partition: string, ops: readonly LegacyWriteOp[]): Promise<void> {
    const target = this.shards[shardFor(partition, this.shards.length)]!;
    await target.batch(ops);
  }

  async close(): Promise<void> {
    for (const shard of this.shards) await shard.close();
  }
}

export { LegacyMinidbLock, legacyMinidbOpener, shardDirName };
