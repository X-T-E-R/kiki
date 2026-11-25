import assert from 'node:assert/strict';

import { WebSocket } from 'ws';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

function openSocket(url, protocols) {
  return new Promise((resolve) => {
    const ws = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    ws.once('open', () => {
      const protocol = ws.protocol;
      ws.close();
      finish({ status: 101, protocol });
    });
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      finish({ status: res.statusCode ?? 0, protocol: '' });
    });
    ws.once('error', (error) => {
      finish({ status: 0, error: error.message });
    });
  });
}

async function main() {
  const fixture = await startFixtureServer({ port: 0, scenario: 'gui-slice' });
  try {
    const port = fixture.http.address().port;
    const validSubprotocol = `kimi-code.bearer.${FIXTURE_TOKEN}`;
    for (const path of ['/api/ws', '/api/klient/events']) {
      const url = `ws://127.0.0.1:${port}${path}`;

      const accepted = await openSocket(url, [validSubprotocol]);
      assert.equal(accepted.status, 101, `${path}: valid bearer subprotocol must upgrade`);
      assert.equal(accepted.protocol, validSubprotocol, `${path}: negotiated subprotocol must echo bearer token`);

      const wrong = await openSocket(url, ['kimi-code.bearer.wrong-token']);
      assert.equal(wrong.status, 401, `${path}: wrong bearer subprotocol must be rejected with 401`);

      const missing = await openSocket(url);
      assert.equal(missing.status, 401, `${path}: missing bearer subprotocol must be rejected with 401`);
    }
    console.log('test-upgrade: OK (101 valid / 401 wrong / 401 missing on /api/ws and /api/klient/events)');
  } finally {
    await fixture.stop();
  }
}

await main();
