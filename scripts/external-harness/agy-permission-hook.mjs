import { createServer, createConnection } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
const denied = reason => ({ decision: 'deny', reason });

export function permissionChannelIdentity() {
  const id = randomUUID();
  return { KIKI_AGY_PERMISSION_ENDPOINT: process.platform === 'win32' ? `\\\\.\\pipe\\kiki-agy-${id}` : resolve(tmpdir(), `kiki-agy-${id}.sock`),
    KIKI_AGY_PERMISSION_TOKEN: randomUUID() };
}

export async function openPermissionChannel(handle, identity = permissionChannelIdentity()) {
  const endpoint = identity.KIKI_AGY_PERMISSION_ENDPOINT;
  const token = identity.KIKI_AGY_PERMISSION_TOKEN;
  const sockets = new Set();
  let closed = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let frame = '';
    let received = false;
    socket.on('data', chunk => {
      if (received) { socket.destroy(); return; }
      frame += chunk.toString('utf8');
      if (Buffer.byteLength(frame) > MAX_BYTES) { socket.destroy(); return; }
      const end = frame.indexOf('\n');
      if (end < 0) return;
      received = true;
      void (async () => {
        let response;
        try {
          const request = JSON.parse(frame.slice(0, end));
          const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
          const expected = Buffer.from(token);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw Error('Invalid AGY permission channel identity');
          if (closed) throw Error('AGY permission channel closed');
          response = await handle(request.input);
        } catch (error) {
          response = denied(error instanceof Error ? error.message : 'AGY permission request failed');
        }
        if (!socket.destroyed) socket.end(JSON.stringify(response) + '\n');
      })();
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(endpoint, done); });
  return {
    env: { KIKI_AGY_PERMISSION_ENDPOINT: endpoint, KIKI_AGY_PERMISSION_TOKEN: token },
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
  const frame = JSON.stringify({ token, input }) + '\n';
  if (Buffer.byteLength(frame) > MAX_BYTES) return denied('AGY permission request exceeds frame limit');
  return new Promise(done => {
    const socket = createConnection(endpoint);
    let response = '';
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); done(result); };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(denied('Kiki AGY permission decision timed out')), timeoutMs);
    socket.once('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
      if (Buffer.byteLength(response) > MAX_BYTES) { finish(denied('AGY permission response exceeds frame limit')); return; }
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
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const owned = process.env.KIKI_AGY_PERMISSION_ENDPOINT || process.env.KIKI_AGY_PERMISSION_TOKEN;
  let input = '';
  try {
    for await (const chunk of process.stdin) {
      if (!owned) continue;
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > MAX_BYTES) throw Error('AGY permission request exceeds frame limit');
    }
    const output = owned ? await requestHookPermission(JSON.parse(input)) : {};
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify(denied(error instanceof Error ? error.message : 'Invalid AGY hook input')) + '\n'); }
}
