// Covers the RESP commands and parser paths not exercised by server.test.ts.
import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RespParser, startServer } from '../src/server.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-srv2-'));
}

function encode(...args: string[]) {
  let s = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(a);
    s += `$${b.length}\r\n${a}\r\n`;
  }
  return s;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

function send(sock: net.Socket, cmd: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(cmd);
  });
}

// Send a command and resolve when the server closes the connection (QUIT).
function sendUntilClose(sock: net.Socket, cmd: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    sock.once('close', () => resolve());
    sock.write(cmd);
  });
}

test('RESP: ECHO and PING with argument', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('ECHO', 'hello')), '$5\r\nhello\r\n');
    assert.equal(await send(sock, encode('PING', 'hi')), '$2\r\nhi\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('RESP: EXISTS / MSET / MGET / TTL', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('MSET', 'a', '1', 'b', '2')), '+OK\r\n');
    assert.equal(await send(sock, encode('EXISTS', 'a')), ':1\r\n');
    assert.equal(await send(sock, encode('EXISTS', 'z')), ':0\r\n');
    assert.equal(await send(sock, encode('MGET', 'a', 'b')), '*2\r\n$1\r\n1\r\n$1\r\n2\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('RESP: SET with EX / PX sets a TTL', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('SET', 'ex', 'v', 'EX', '10')), '+OK\r\n');
    const ex = Number((await send(sock, encode('TTL', 'ex'))).slice(1));
    assert.ok(ex > 0 && ex <= 10, `EX ttl=${ex}`);

    assert.equal(await send(sock, encode('SET', 'px', 'v', 'PX', '5000')), '+OK\r\n');
    const px = Number((await send(sock, encode('TTL', 'px'))).slice(1));
    assert.ok(px > 0 && px <= 5, `PX ttl=${px}`);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('RESP: INFO and COMPACT', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await send(sock, encode('SET', 'k', 'v'));
    const info = await send(sock, encode('INFO'));
    assert.ok(info.includes('minidb_version:0.0.1'), info);
    assert.ok(info.includes('keys:1'), info);
    assert.equal(await send(sock, encode('COMPACT')), '+OK\r\n');
    const info2 = await send(sock, encode('INFO'));
    assert.ok(info2.includes('compactions:1'), info2);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('RESP: QUIT closes the connection', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await expect(sendUntilClose(sock, encode('QUIT'))).resolves.toBeUndefined();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('RESP: inline (non-array) command path', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // Redis inline protocol: a bare line of space-separated tokens.
    assert.equal(await send(sock, 'PING\r\n'), '+PONG\r\n');
    assert.equal(await send(sock, 'SET foo bar\r\n'), '+OK\r\n');
    assert.equal(await send(sock, 'GET foo\r\n'), '$3\r\nbar\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

// Accumulate reply bytes until `done` accepts them (replies may span chunks).
function collectUntil(sock: net.Socket, done: (s: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (done(buf)) {
        clearTimeout(timer);
        sock.off('data', onData);
        resolve(buf);
      }
    };
    const timer = setTimeout(() => {
      sock.off('data', onData);
      reject(new Error(`timed out waiting for reply; got ${buf.length} bytes`));
    }, 20_000);
    sock.on('data', onData);
  });
}

test('RESP: a client aborting mid-large-reply does not kill the server', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    sock.on('error', () => {}); // the test client itself may see the RST
    const big = 'x'.repeat(4 * 1024 * 1024);
    assert.equal(await send(sock, encode('SET', 'big', big)), '+OK\r\n');
    // Ask for the large value, then reset the connection without reading the
    // reply: the server hits EPIPE/ECONNRESET while writing it out.
    sock.write(encode('GET', 'big'));
    await new Promise((r) => setTimeout(r, 20));
    sock.destroy();
    // Give the server a moment to hit the write failure, then prove a fresh
    // connection is still being served.
    await new Promise((r) => setTimeout(r, 100));
    const sock2 = await connect(srv.port);
    assert.equal(await send(sock2, encode('PING')), '+PONG\r\n');
    sock2.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('RESP: an oversized request gets -ERR and the connection recovers', { timeout: 30_000 }, async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // 65 MiB of bulk payload crosses the parser's 64 MiB cap. The cap is the
    // unparsed-request buffer, in bytes; this payload is intentionally over it.
    const cap = 64 * 1024 * 1024;
    const big = Buffer.alloc(65 * 1024 * 1024, 'x'.charCodeAt(0));
    const head = Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${big.length}\r\n`);
    sock.write(Buffer.concat([head, big, Buffer.from('\r\n')]));
    // Pipelined right behind it: once the parser recovers from the -ERR this
    // fresh small command must still be answered, with no leftover payload
    // parsed as another command.
    sock.write(encode('PING'));
    const data = await collectUntil(sock, (s) => s.includes('+PONG'));
    assert.equal(data, `-ERR RESP request too large (>${cap} bytes)\r\n+PONG\r\n`);
    // The rejected SET must not land, and the same socket still serves a write.
    assert.equal(await send(sock, encode('GET', 'k')), '$-1\r\n');
    assert.equal(await send(sock, encode('SET', 'ok', 'v')), '+OK\r\n');
    assert.equal(await send(sock, encode('GET', 'ok')), '$1\r\nv\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

function feedAll(parser: RespParser, bytes: Buffer, chunkSize = 1): Array<Buffer[] | { error: string }> {
  const out: Array<Buffer[] | { error: string }> = [];
  for (let i = 0; i < bytes.length; i += chunkSize) out.push(...parser.feed(bytes.subarray(i, i + chunkSize)));
  return out;
}

function describeItems(items: Array<Buffer[] | { error: string }>): Array<{ error: string } | string[]> {
  return items.map((item) => (Array.isArray(item) ? item.map((b) => b.toString()) : item));
}

test('RESP parser: a declared bulk over the cap errors before the body and keeps the next command', () => {
  const cap = 32;
  const parser = new RespParser({ maxBuf: cap });
  const body = Buffer.alloc(40, 0x78);
  const head = Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${body.length}\r\n`);
  // The length is known here. No body byte has been fed, so this must already be -ERR-shaped.
  assert.deepEqual(describeItems([...parser.feed(head)]), [{ error: `RESP request too large (>${cap} bytes)` }]);
  assert.deepEqual([...parser.feed(body)], []);
  assert.deepEqual([...parser.feed(Buffer.from('\r\n'))], []);
  assert.deepEqual(describeItems([...parser.feed(Buffer.from('*1\r\n$4\r\nPING\r\n'))]), [['PING']]);
});

test('RESP parser: bytes after an oversized bulk are not a new command, including a later arg', () => {
  const parser = new RespParser({ maxBuf: 32 });
  const body = Buffer.alloc(40, 0x78);
  // The oversized value is not the last bulk. `$1\r\nv` belongs to the rejected SET.
  const bytes = Buffer.concat([
    Buffer.from(`*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$${body.length}\r\n`),
    body,
    Buffer.from('\r\n$1\r\nv\r\n'),
    Buffer.from('*1\r\n$4\r\nPING\r\n'),
  ]);
  assert.deepEqual(describeItems(feedAll(parser, bytes)), [
    { error: 'RESP request too large (>32 bytes)' },
    ['PING'],
  ]);
});

test('RESP parser: an inline line with no CRLF still errors at the cap and the next command parses', () => {
  // 16 bytes holds `*1\r\n$4\r\nPING\r\n` (14) and still rejects a CRLF-less line.
  const parser = new RespParser({ maxBuf: 16 });
  assert.throws(() => [...parser.feed(Buffer.from('x'.repeat(17)))], /RESP request too large \(>16 bytes\)/);
  assert.deepEqual(describeItems([...parser.feed(Buffer.from('*1\r\n$4\r\nPING\r\n'))]), [['PING']]);
});

test('RESP parser: a complete inline line over the cap is rejected and a later PING recovers', () => {
  const parser = new RespParser({ maxBuf: 16 });
  const line = Buffer.from(`PING ${'x'.repeat(20)}\r\n`);
  assert.ok(line.length > 16);
  assert.throws(() => [...parser.feed(line)], /RESP request too large \(>16 bytes\)/);
  assert.deepEqual(describeItems([...parser.feed(Buffer.from('PING\r\n'))]), [['PING']]);
});

test('RESP parser: an inline line completed by a later CRLF chunk over the cap is rejected and PING recovers', () => {
  const parser = new RespParser({ maxBuf: 16 });
  const head = Buffer.from(`PING ${'x'.repeat(10)}`);
  assert.equal(head.length, 15);
  assert.deepEqual([...parser.feed(head)], []);
  assert.throws(() => [...parser.feed(Buffer.from(`${'x'.repeat(10)}\r\n`))], /RESP request too large \(>16 bytes\)/);
  assert.deepEqual(describeItems([...parser.feed(Buffer.from('PING\r\n'))]), [['PING']]);
});

test('RESP parser: an inline line exactly at the cap is kept, and small lines sharing a chunk are kept', () => {
  const exact = new RespParser({ maxBuf: 16 });
  const line = Buffer.from(`PING ${'x'.repeat(9)}\r\n`);
  assert.equal(line.length, 16);
  assert.deepEqual(describeItems([...exact.feed(line)]), [['PING', 'x'.repeat(9)]]);

  // 18 bytes in one chunk, three requests of 6. The cap is per unparsed request.
  const pipelined = new RespParser({ maxBuf: 16 });
  const chunk = Buffer.from('PING\r\nPING\r\nPING\r\n');
  assert.equal(chunk.length, 18);
  assert.deepEqual(describeItems([...pipelined.feed(chunk)]), [['PING'], ['PING'], ['PING']]);
});

test('RESP parser: a complete array frame over the cap is not returned as arguments', () => {
  const parser = new RespParser({ maxBuf: 16 });
  const frame = Buffer.from('*2\r\n$1\r\nA\r\n$1\r\nB\r\n');
  assert.equal(frame.length, 18);
  let items: Array<Buffer[] | { error: string }> = [];
  try {
    items = [...parser.feed(frame)];
  } catch (error) {
    assert.match((error as Error).message, /RESP request too large \(>16 bytes\)/);
  }
  assert.ok(items.every((item) => !Array.isArray(item)));
  assert.deepEqual(describeItems([...parser.feed(Buffer.from('PING\r\n'))]), [['PING']]);
});

test('RESP: one bad command does not starve its pipelined siblings', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // The 129-byte key exceeds MAX_KEY_LEN so SET throws inside the handler;
    // the two PINGs in the very same chunk must still be answered, in order.
    const key = 'k'.repeat(129);
    sock.write(encode('SET', key, 'v') + encode('PING') + encode('PING'));
    const data = await collectUntil(sock, (s) => s.endsWith('+PONG\r\n+PONG\r\n'));
    assert.match(data, /^-ERR [^\r]*\r\n\+PONG\r\n\+PONG\r\n$/);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
