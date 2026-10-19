// src/server.ts
//
// A minimal RESP (REdis Serialization Protocol) TCP front-end for MiniDb, so
// existing Redis clients (redis-cli, ioredis, ...) can talk to it.

import net from 'node:net';
import type { Socket } from 'node:net';
import { MiniDb } from './index.js';

const CRLF = '\r\n';
const NIL = `$-1${CRLF}`;

const reply = {
  ok: () => `+OK${CRLF}`,
  pong: () => `+PONG${CRLF}`,
  int: (n: number) => `:${n}${CRLF}`,
  err: (m: string) => `-ERR ${m}${CRLF}`,
  // Bulk replies carry raw bytes. Build a Buffer so non-ASCII / binary values
  // are written verbatim instead of being re-encoded as UTF-8 (which corrupted
  // them and desynced the protocol when `socket.write(string)` defaulted to
  // utf8).
  bulk: (v: unknown): Buffer => {
    if (v === undefined || v === null) return Buffer.from(NIL);
    const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v as string));
    return Buffer.concat([Buffer.from(`$${b.length}${CRLF}`), b, Buffer.from(CRLF)]);
  },
  array: (items: unknown[]): Buffer => {
    const parts: Buffer[] = [Buffer.from(`*${items.length}${CRLF}`)];
    for (const it of items) parts.push(reply.bulk(it));
    return Buffer.concat(parts);
  },
};

type ParsedItem = Buffer[] | { error: string };

export class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxBuf: number;
  /** Body bytes of a rejected bulk still to drop, including its trailing CRLF. */
  private skipBytes = 0;
  /** Further bulk strings belonging to the rejected multibulk. */
  private skipBulks = 0;

  // maxBuf is bytes of unparsed request data held for one connection, not a
  // stored-value limit (frame values use a uint32; DB keys are 128 bytes).
  // 64 MiB is the ceiling that keeps one client from pinning an unbounded buffer.
  constructor({ maxBuf = 64 * 1024 * 1024 }: { maxBuf?: number } = {}) {
    this.maxBuf = maxBuf;
  }

  private tooLarge(): string {
    return `RESP request too large (>${this.maxBuf} bytes)`;
  }

  *feed(chunk: Buffer): Generator<ParsedItem> {
    let rest = chunk;
    // A rejected bulk's body must be discarded by count. Concatenating it
    // would copy up to the cap before any reply existed.
    if (this.skipBytes > 0) {
      if (rest.length <= this.skipBytes) {
        this.skipBytes -= rest.length;
        return;
      }
      rest = rest.subarray(this.skipBytes);
      this.skipBytes = 0;
    }
    if (rest.length) this.buf = this.buf.length ? Buffer.concat([this.buf, rest]) : rest;

    while (this.buf.length) {
      if (this.skipBulks > 0) {
        const skipped = this.consumeSkippedBulk();
        if (skipped === 'need') {
          this.dropIfOverCap();
          return;
        }
        this.skipBulks--;
        if (this.skipBytes > 0) return;
        continue;
      }

      const parsed = this.tryParse();
      if (parsed === 'need') {
        this.dropIfOverCap();
        return;
      }
      if (parsed === 'too-large') {
        yield { error: this.tooLarge() };
        if (this.skipBytes > 0) return;
        continue;
      }
      yield parsed;
    }
  }

  /** Length-less input (an inline line with no CRLF) still cannot grow without a bound. */
  private dropIfOverCap(): void {
    if (this.buf.length <= this.maxBuf) return;
    this.buf = Buffer.alloc(0);
    this.skipBytes = 0;
    this.skipBulks = 0;
    throw new Error(this.tooLarge());
  }

  /** Drop a rejected bulk body by count. Later bulks of the same multibulk stay in `skipBulks`. */
  private armOversized(bodyAt: number, len: number): void {
    const need = len + 2;
    const have = this.buf.length - bodyAt;
    if (have >= need) this.buf = Buffer.from(this.buf.subarray(bodyAt + need));
    else {
      this.skipBytes = need - Math.max(0, have);
      this.buf = Buffer.alloc(0);
    }
  }

  private bulkTooBig(bodyAt: number, len: number): boolean {
    return Number.isSafeInteger(len) && len >= 0 && len + 2 > this.maxBuf - bodyAt;
  }

  /** Drop one `$len\r\n<body>\r\n`. A body over the cap is counted, not buffered. */
  private consumeSkippedBulk(): 'need' | 'done' {
    if (this.buf[0] !== 0x24 /* '$' */) {
      this.buf = Buffer.alloc(0);
      this.skipBytes = 0;
      this.skipBulks = 0;
      throw new Error(this.tooLarge());
    }
    const end = this.buf.indexOf(CRLF, 1);
    if (end === -1) return 'need';
    const len = Number(this.buf.subarray(1, end).toString());
    const bodyAt = end + 2;
    if (!(Number.isSafeInteger(len) && len >= 0)) {
      this.buf = Buffer.alloc(0);
      this.skipBytes = 0;
      this.skipBulks = 0;
      throw new Error(this.tooLarge());
    }
    if (this.bulkTooBig(bodyAt, len)) {
      if (!Number.isSafeInteger(len + 2)) {
        this.buf = Buffer.alloc(0);
        this.skipBytes = 0;
        this.skipBulks = 0;
        throw new Error(this.tooLarge());
      }
      this.armOversized(bodyAt, len);
      return 'done';
    }
    if (this.buf.length - bodyAt < len + 2) return 'need';
    this.buf = this.buf.subarray(bodyAt + len + 2);
    return 'done';
  }

  private tryParse(): Buffer[] | 'need' | 'too-large' {
    if (this.buf[0] !== 0x2a /* '*' */) {
      const idx = this.buf.indexOf(CRLF);
      if (idx === -1) return 'need';
      const line = this.buf.subarray(0, idx).toString();
      this.buf = this.buf.subarray(idx + 2);
      return line.split(' ').filter(Boolean).map((s) => Buffer.from(s));
    }

    let pos = 1;
    let end = this.buf.indexOf(CRLF, pos);
    if (end === -1) return 'need';
    const argc = Number(this.buf.subarray(pos, end).toString());
    pos = end + 2;

    const args: Buffer[] = [];
    for (let i = 0; i < argc; i++) {
      if (pos >= this.buf.length || this.buf[pos] !== 0x24 /* '$' */) return 'need';
      pos++;
      end = this.buf.indexOf(CRLF, pos);
      if (end === -1) return 'need';
      const len = Number(this.buf.subarray(pos, end).toString());
      pos = end + 2;
      if (this.bulkTooBig(pos, len)) {
        // An inexact length cannot be skipped without drifting into the next command.
        if (!Number.isSafeInteger(len + 2)) {
          this.buf = Buffer.alloc(0);
          this.skipBytes = 0;
          this.skipBulks = 0;
          throw new Error(this.tooLarge());
        }
        this.armOversized(pos, len);
        this.skipBulks = argc - i - 1;
        return 'too-large';
      }
      if (this.buf.length - pos < len + 2) return 'need';
      args.push(this.buf.subarray(pos, pos + len));
      pos += len + 2;
    }
    this.buf = this.buf.subarray(pos);
    return args;
  }
}

async function handle(db: MiniDb<string>, args: Buffer[]): Promise<string | Buffer | null> {
  const cmd = args[0]!.toString().toUpperCase();
  const S = (i: number): string | undefined => (args[i] === undefined ? undefined : args[i]!.toString());

  switch (cmd) {
    case 'PING':
      return args[1] ? reply.bulk(S(1)) : reply.pong();
    case 'ECHO':
      return reply.bulk(S(1));
    case 'GET': {
      const v = db.get(S(1)!);
      return reply.bulk(v === undefined ? null : v);
    }
    case 'SET': {
      const key = S(1)!;
      const val = S(2)!;
      let ttl: number | undefined;
      for (let i = 3; i < args.length; i++) {
        const opt = S(i)!.toUpperCase();
        if (opt === 'EX') ttl = Number(S(++i)) * 1000;
        else if (opt === 'PX') ttl = Number(S(++i));
      }
      await db.set(key, val, ttl ? { ttl } : {});
      return reply.ok();
    }
    case 'DEL': {
      let n = 0;
      for (let i = 1; i < args.length; i++) if (await db.del(S(i)!)) n++;
      return reply.int(n);
    }
    case 'EXISTS':
      return reply.int(db.has(S(1)!) ? 1 : 0);
    case 'MGET': {
      const out: unknown[] = [];
      for (let i = 1; i < args.length; i++) {
        const v = db.get(S(i)!);
        out.push(v === undefined ? null : v);
      }
      return reply.array(out);
    }
    case 'MSET': {
      const entries: (readonly [string, string])[] = [];
      for (let i = 1; i + 1 < args.length; i += 2) entries.push([S(i)!, S(i + 1)!]);
      await db.mset(entries); // atomic batch (single WAL frame), like Redis MSET
      return reply.ok();
    }
    case 'TTL':
      return reply.int(Math.trunc(db.ttl(S(1)!) / 1000));
    case 'DBSIZE':
      return reply.int(db.size);
    case 'COMPACT':
      await db.compact();
      return reply.ok();
    case 'INFO':
      return reply.bulk(`minidb_version:0.0.1${CRLF}keys:${db.size}${CRLF}compactions:${db.stats.compactions}${CRLF}`);
    case 'QUIT':
      return null;
    default:
      return reply.err(`unknown command '${cmd}'`);
  }
}

export interface ServerOptions {
  dir: string;
  port?: number;
  host?: string;
  fsyncPolicy?: 'always' | 'everysec' | 'no';
}

export interface ServerHandle {
  server: net.Server;
  db: MiniDb<string>;
  close: () => Promise<void>;
  port: number;
  host: string;
}

export async function startServer({ dir, port = 6379, host = '127.0.0.1', fsyncPolicy = 'everysec' }: ServerOptions): Promise<ServerHandle> {
  const db = (await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy })) as MiniDb<string>;
  const server = net.createServer((socket: Socket) => {
    const parser = new RespParser();
    // Serialize per-connection processing: a new chunk's commands are queued
    // behind the previous chunk's in-flight work, so replies always leave in
    // request order. Without this, a slow command in one packet (e.g. SET with
    // fsync 'always') let replies from the next packet overtake it, breaking
    // pipelined clients.
    let queue: Promise<void> = Promise.resolve();
    // A client that resets the connection while a large reply is being written
    // makes the next write fail with EPIPE/ECONNRESET. Without an 'error'
    // listener that event becomes an uncaught exception and takes the whole
    // process down, so swallow it: the connection is dead either way, and the
    // queued work below skips further writes to it.
    socket.on('error', () => {});
    // Never write to a destroyed socket: write-after-destroy would just
    // surface as another 'error' event on the dead connection.
    const send = (res: string | Buffer): void => {
      if (!socket.destroyed) socket.write(res);
    };
    socket.on('data', (chunk: Buffer) => {
      queue = queue.then(async () => {
        try {
          for (const item of parser.feed(chunk)) {
            if (socket.destroyed) return;
            if (!Array.isArray(item)) {
              // Declared bulk over the cap. feed() has already counted out that
              // bulk and the rest of its multibulk, so a pipelined command on
              // this same socket is still framed.
              send(reply.err(item.error));
              continue;
            }
            let res: string | Buffer | null;
            try {
              res = await handle(db, item);
            } catch (e) {
              // One failing command must not starve the replies of the
              // commands already parsed from the same chunk.
              res = reply.err((e as Error).message);
            }
            if (res === null) {
              socket.end();
              return;
            }
            send(res);
          }
        } catch (e) {
          // Unframed overflow (an inline line with no CRLF). feed() has dropped
          // its buffer; later chunks are parsed as new commands.
          send(reply.err((e as Error).message));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as net.AddressInfo).port;

  const close = async (): Promise<void> => {
    server.close();
    await db.close();
  };
  process.on('SIGINT', () => {
    void close().then(() => process.exit(0));
  });
  return { server, db, close, port: actualPort, host };
}

// Run directly: node --import tsx src/server.ts --dir ./data --port 6379
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name: string, def: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? def : argv[i + 1]!;
  };
  const dir = arg('dir', './data');
  const port = Number(arg('port', '6379'));
  const fsyncPolicy = arg('fsync', 'everysec') as 'always' | 'everysec' | 'no';
  const { host, port: p } = await startServer({ dir, port, fsyncPolicy });
  console.log(`minidb RESP server listening on ${host}:${p} (dir=${dir}, fsync=${fsyncPolicy})`);
}
