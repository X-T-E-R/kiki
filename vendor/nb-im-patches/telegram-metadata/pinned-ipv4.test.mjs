import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { createServer, request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setDefaultAutoSelectFamily } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const packageRoot = process.argv[2];
assert.ok(packageRoot, 'pass an extracted @nb-im/core package directory');

await test('packaged Telegram poll, send, download and notification use Node 24 pinned IPv4', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push([req.method, req.url]);
    req.resume();
    res.setHeader('connection', 'close');
    if (req.method === 'GET') res.end('fixture-file');
    else res.end('{"ok":true,"result":{"message_id":42}}');
  });
  await new Promise((done, reject) => server.listen(0, '127.0.0.1', done).once('error', reject));
  t.after(() => new Promise((done) => server.close(done)));
  setDefaultAutoSelectFamily(true);
  const port = server.address().port;
  const publicIp = '149.154.167.220';
  t.mock.method(dns, 'resolve4', async (host) => {
    assert.equal(host, 'api.telegram.org');
    return [publicIp];
  });
  t.mock.method(https, 'request', (options, onResponse) => {
    assert.equal(options.hostname, 'api.telegram.org');
    assert.equal(options.port, 443);
    assert.equal(options.agent, false);
    return request({
      ...options, hostname: 'pinned.example.test', port,
      lookup: (_host, lookupOptions, done) => options.lookup(options.hostname, lookupOptions, (error, address, family) => {
        if (error) return done(error);
        if (lookupOptions.all && Array.isArray(address)) {
          assert.deepEqual(address, [{ address: publicIp, family: 4 }]);
          return done(null, [{ address: '127.0.0.1', family: 4 }]);
        }
        assert.equal(address, publicIp);
        assert.equal(family, 4);
        return done(null, '127.0.0.1', 4);
      }),
    }, onResponse);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { createTelegramBotTransport } = await import(pathToFileURL(join(packageRoot, 'dist/session/telegram-http.js')).href);
  const { telegramHttps } = await import(pathToFileURL(join(packageRoot, 'dist/providers.js')).href);
  const token = 'fixture-token';
  const transport = createTelegramBotTransport(token);
  const signal = AbortSignal.timeout(3000);
  assert.equal((await transport.call({ method: 'getUpdates' }, signal)).http_status, 200);
  assert.equal((await transport.call({ method: 'sendMessage', json: { text: 'fixture' } }, signal)).http_status, 200);
  const download = await transport.download('photos/a.jpg', signal);
  assert.equal(download.ok, true);
  assert.equal(Buffer.from(download.bytes).toString(), 'fixture-file');
  assert.equal((await telegramHttps.post(token, '{}', () => 'ready')).status, 200);
  assert.deepEqual(seen, [
    ['POST', '/botfixture-token/getUpdates'],
    ['POST', '/botfixture-token/sendMessage'],
    ['GET', '/file/botfixture-token/photos/a.jpg'],
    ['POST', '/botfixture-token/sendMessage'],
  ]);
});
