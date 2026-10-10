import { createServer, createConnection } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const denied = reason => ({ decision: 'deny', reason });

export function permissionChannelIdentity() {
  const id = randomUUID();
  return { KIKI_AGY_PERMISSION_ENDPOINT: process.platform === 'win32' ? `\\\\.\\pipe\\kiki-agy-${id}` : resolve(tmpdir(), `kiki-agy-${id}.sock`),
    KIKI_AGY_PERMISSION_TOKEN: randomUUID() };
}

/**
 * Authenticate the bounded nonce header before collecting tool JSON. Authenticated
 * input follows the existing ACP in-memory JSON framing contract without imposing
 * a smaller tool-input ceiling. The channel is owned and closed with the session.
 */
export async function openPermissionChannel(handle, identity = permissionChannelIdentity()) {
  const endpoint = identity.KIKI_AGY_PERMISSION_ENDPOINT;
  const expected = Buffer.from(identity.KIKI_AGY_PERMISSION_TOKEN);
  const sockets = new Set();
  let closed = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let header = Buffer.alloc(0);
    let authenticated = false;
    const decoder = new StringDecoder('utf8');
    let frame = '';
    let received = false;
    const reject = reason => {
      received = true;
      socket.pause();
      socket.end(JSON.stringify(denied(reason)) + '\n');
    };
    socket.on('data', chunk => {
      if (received) return;
      if (!authenticated) {
        const end = chunk.indexOf(0x0a);
        const part = end < 0 ? chunk : chunk.subarray(0, end);
        if (header.length + part.length > expected.length) { reject('Invalid AGY permission channel identity'); return; }
        header = Buffer.concat([header, part]);
        if (end < 0) return;
        if (header.length !== expected.length || !timingSafeEqual(header, expected)) { reject('Invalid AGY permission channel identity'); return; }
        authenticated = true;
        chunk = chunk.subarray(end + 1);
      }
      if (closed) { reject('AGY permission channel closed'); return; }
      frame += decoder.write(chunk);
      const end = frame.indexOf('\n');
      if (end < 0) return;
      received = true;
      socket.pause();
      void (async () => {
        let response;
        try {
          response = await handle(JSON.parse(frame.slice(0, end)));
        } catch (error) {
          response = denied(error instanceof Error ? error.message : 'AGY permission request failed');
        }
        if (!socket.destroyed && !closed) socket.end(JSON.stringify(response) + '\n');
      })();
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(endpoint, done); });
  return {
    env: { KIKI_AGY_PERMISSION_ENDPOINT: endpoint, KIKI_AGY_PERMISSION_TOKEN: identity.KIKI_AGY_PERMISSION_TOKEN },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) { socket.end(JSON.stringify(denied('AGY permission channel closed')) + '\n'); socket.destroy(); }
      await new Promise(done => server.close(done));
    },
  };
}

export async function requestHookPermission(input, env = process.env, timeoutMs) {
  const endpoint = env.KIKI_AGY_PERMISSION_ENDPOINT;
  const token = env.KIKI_AGY_PERMISSION_TOKEN;
  if (!endpoint && !token) return {};
  if (!endpoint || !token) return denied('Incomplete Kiki AGY permission channel');
  const frame = JSON.stringify(input) + '\n';
  return new Promise(done => {
    const socket = createConnection(endpoint);
    socket.setEncoding('utf8');
    let response = '';
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); done(result); };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(denied('Kiki AGY permission decision timed out')), timeoutMs);
    socket.once('connect', () => {
      socket.write(token + '\n');
      socket.write(frame);
    });
    socket.on('data', chunk => {
      response += chunk;
      const end = response.indexOf('\n');
      if (end < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, end));
        const vendorDefault = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
        if (!vendorDefault && !['allow', 'deny'].includes(parsed.decision)) throw Error('Invalid permission decision');
        finish(parsed);
      } catch { finish(denied('Invalid Kiki AGY permission response')); }
    });
    socket.once('error', () => finish(denied('Kiki AGY permission channel unavailable')));
    socket.once('end', () => finish(denied('Kiki AGY permission channel ended without a decision')));
    socket.once('close', () => finish(denied('Kiki AGY permission channel closed without a decision')));
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const owned = process.env.KIKI_AGY_PERMISSION_ENDPOINT || process.env.KIKI_AGY_PERMISSION_TOKEN;
  let input = '';
  process.stdin.setEncoding('utf8');
  try {
    for await (const chunk of process.stdin) {
      if (owned) input += chunk;
    }
    const output = owned ? await requestHookPermission(JSON.parse(input)) : {};
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify(denied(error instanceof Error ? error.message : 'Invalid AGY hook input')) + '\n'); }
}
