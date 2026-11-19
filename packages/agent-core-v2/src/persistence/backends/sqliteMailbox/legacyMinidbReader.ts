import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

const MAGIC_0 = 0x4d;
const MAGIC_1 = 0x44;
const TYPE_SET = 1;
const TYPE_DEL = 2;
const TYPE_BATCH = 3;
const HEADER_SIZE = 22;
const CRC_SIZE = 4;
const SUB_HEADER_SIZE = 19;
const PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1_000);

export interface LegacyMinidbRow {
  readonly key: string;
  readonly value: Record<string, unknown>;
  readonly expireAt: number;
  readonly byteLength: number;
}

export interface LegacyMinidbReader {
  get(key: string): LegacyMinidbRow | undefined;
  scan(gt: string, count: number): readonly LegacyMinidbRow[];
  close(): Promise<void>;
}

export function shardDirName(shardId: number, shardCount: number): string {
  const width = Math.max(2, String(Math.max(shardCount - 1, 0)).length);
  return `shard-${String(shardId).padStart(width, '0')}`;
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class LegacyMinidbLock {
  private token: string | undefined;

  constructor(readonly path: string) {}

  get heldToken(): string | undefined {
    return this.token;
  }

  async acquire(): Promise<boolean> {
    if (this.token !== undefined) return true;
    const token = `${process.pid}:${randomUUID()}`;
    const payload = JSON.stringify({ pid: process.pid, processStartedAt: PROCESS_STARTED_AT, ts: Date.now(), token });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.path, 'wx', 0o600);
        try {
          await handle.writeFile(payload, 'utf8');
        } finally {
          await handle.close();
        }
        this.token = token;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let existing: { pid?: unknown } | undefined;
        try {
          existing = JSON.parse(await readFile(this.path, 'utf8')) as { pid?: unknown };
        } catch {
          existing = undefined;
        }
        if (existing !== undefined && pidAlive(existing.pid)) return false;
        if (attempt === 1) return false;
        await unlink(this.path).catch(() => {});
      }
    }
    return false;
  }

  async release(): Promise<void> {
    const token = this.token;
    this.token = undefined;
    if (token === undefined) return;
    try {
      const current = JSON.parse(await readFile(this.path, 'utf8')) as { token?: unknown };
      if (current.token === token) await unlink(this.path);
    } catch {}
  }

  releaseSync(): void {
    const token = this.token;
    this.token = undefined;
    if (token === undefined) return;
    try {
      const current = JSON.parse(readFileSync(this.path, 'utf8')) as { token?: unknown };
      if (current.token === token) unlinkSync(this.path);
    } catch {}
  }
}

interface RawEntry {
  readonly rawValue: Buffer;
  readonly expireAt: number;
}

function replayBuffer(buf: Buffer, entries: Map<string, RawEntry>, label: string): void {
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < HEADER_SIZE + CRC_SIZE) throw new Error(`Corrupted canonical source frame header in ${label}`);
    if (buf[pos] !== MAGIC_0 || buf[pos + 1] !== MAGIC_1) throw new Error(`Corrupted canonical source magic in ${label}`);
    const type = buf.readUInt8(pos + 2);
    const keyLen = buf.readUInt16LE(pos + 4);
    const valLen = buf.readUInt32LE(pos + 6);
    const metaLen = buf.readUInt32LE(pos + 10);
    const frameLen = HEADER_SIZE + keyLen + valLen + metaLen + CRC_SIZE;
    if (pos + frameLen > buf.length) throw new Error(`Corrupted canonical source truncated frame in ${label}`);
    const storedCrc = buf.readUInt32LE(pos + frameLen - CRC_SIZE);
    const computedCrc = crc32(buf.subarray(pos + 2, pos + frameLen - CRC_SIZE));
    if (storedCrc !== computedCrc) throw new Error(`Corrupted canonical source CRC mismatch in ${label}`);
    const expireAt = Number(buf.readBigInt64LE(pos + 14));
    const keyStart = pos + HEADER_SIZE;
    const valStart = keyStart + keyLen;
    if (type === TYPE_SET) {
      entries.set(buf.subarray(keyStart, valStart).toString('utf8'), { rawValue: Buffer.from(buf.subarray(valStart, valStart + valLen)), expireAt });
    } else if (type === TYPE_DEL) {
      entries.delete(buf.subarray(keyStart, valStart).toString('utf8'));
    } else if (type === TYPE_BATCH) {
      applyBatch(buf.subarray(valStart, valStart + valLen), entries, label);
    } else {
      throw new Error(`Corrupted canonical source frame type ${type} in ${label}`);
    }
    pos += frameLen;
  }
}

function applyBatch(body: Buffer, entries: Map<string, RawEntry>, label: string): void {
  if (body.length < 2) throw new Error(`Corrupted canonical source batch body in ${label}`);
  let pos = 2;
  const count = body.readUInt16LE(0);
  const staged: Array<{ readonly type: number; readonly key: string; readonly rawValue: Buffer; readonly expireAt: number }> = [];
  for (let i = 0; i < count; i += 1) {
    if (pos + SUB_HEADER_SIZE > body.length) throw new Error(`Corrupted canonical source batch op in ${label}`);
    const type = body.readUInt8(pos);
    if (type !== TYPE_SET && type !== TYPE_DEL) throw new Error(`Corrupted canonical source batch op type in ${label}`);
    const keyLen = body.readUInt16LE(pos + 1);
    const valLen = body.readUInt32LE(pos + 3);
    const metaLen = body.readUInt32LE(pos + 7);
    const expireAt = Number(body.readBigInt64LE(pos + 11));
    pos += SUB_HEADER_SIZE;
    if (pos + keyLen + valLen + metaLen > body.length) throw new Error(`Corrupted canonical source batch payload in ${label}`);
    const key = body.subarray(pos, pos + keyLen).toString('utf8');
    const rawValue = Buffer.from(body.subarray(pos + keyLen, pos + keyLen + valLen));
    pos += keyLen + valLen + metaLen;
    staged.push({ type, key, rawValue, expireAt });
  }
  if (pos !== body.length) throw new Error(`Corrupted canonical source batch trailing bytes in ${label}`);
  for (const op of staged) {
    if (op.type === TYPE_SET) entries.set(op.key, { rawValue: op.rawValue, expireAt: op.expireAt });
    else entries.delete(op.key);
  }
}

async function readOptionalFile(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export const legacyMinidbOpener = {
  async open(dir: string): Promise<LegacyMinidbReader> {
    const entries = new Map<string, RawEntry>();
    for (const fileName of ['db.snapshot', 'db.wal'] as const) {
      const data = await readOptionalFile(join(dir, fileName));
      if (data !== undefined && data.length > 0) replayBuffer(data, entries, join(dir, fileName));
    }
    const keys = [...entries.keys()].toSorted((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    const decodeEntry = (key: string, entry: RawEntry): LegacyMinidbRow => ({
      key,
      value: JSON.parse(entry.rawValue.toString('utf8')) as Record<string, unknown>,
      expireAt: entry.expireAt,
      byteLength: Buffer.byteLength(key, 'utf8') + entry.rawValue.byteLength,
    });
    return {
      get(key: string): LegacyMinidbRow | undefined {
        const entry = entries.get(key);
        if (entry === undefined) return undefined;
        if (entry.expireAt > 0 && entry.expireAt <= Date.now()) return undefined;
        return decodeEntry(key, entry);
      },
      scan(gt: string, count: number): readonly LegacyMinidbRow[] {
        const now = Date.now();
        const gtBuf = Buffer.from(gt, 'utf8');
        const out: LegacyMinidbRow[] = [];
        for (const key of keys) {
          if (gt.length > 0 && Buffer.compare(Buffer.from(key, 'utf8'), gtBuf) <= 0) continue;
          const entry = entries.get(key)!;
          if (entry.expireAt > 0 && entry.expireAt <= now) continue;
          out.push(decodeEntry(key, entry));
          if (out.length >= count) break;
        }
        return out;
      },
      async close(): Promise<void> {},
    };
  },
};
