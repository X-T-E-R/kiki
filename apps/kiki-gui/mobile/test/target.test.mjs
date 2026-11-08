import assert from 'node:assert/strict';
import { test } from 'node:test';

// Node ESM needs the extension to resolve the browser module.
// oxlint-disable-next-line import/extensions
import {
  STORE_ORIGIN_KEY,
  classifyOrigin,
  displayOrigin,
  formatPairingCodeInput,
  formatPairingUri,
  normalizePairingCode,
  parsePairingUri,
  readConnectInput,
  readDeviceIdentity,
  readSavedServers,
  readScanPayload,
  readTarget,
  removeSavedServer,
  updateSavedServerOrigin,
  upsertSavedServer,
} from '../launcher/target.js';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

await test('a bare LAN address opens over http on its own port', () => {
  assert.deepEqual(readTarget(' 192.168.1.5:5494 '), { ok: true, origin: 'http://192.168.1.5:5494', entry: 'http://192.168.1.5:5494/' });
  assert.deepEqual(readTarget('studio.local:5494'), { ok: true, origin: 'http://studio.local:5494', entry: 'http://studio.local:5494/' });
});

await test('a named public host defaults to https', () => {
  assert.deepEqual(readTarget('kiki.example.test'), { ok: true, origin: 'https://kiki.example.test', entry: 'https://kiki.example.test/' });
});

await test('an entry link is opened once but only its origin is kept', () => {
  const link = 'http://10.0.0.2:5494/#access=' + 'a'.repeat(43);
  assert.deepEqual(readTarget(link), { ok: true, origin: 'http://10.0.0.2:5494', entry: link });
  const tokenLink = 'https://kiki.example.test/?token=YOUR_API_KEY';
  assert.equal(readTarget(tokenLink).origin, 'https://kiki.example.test');
  assert.equal(readTarget(tokenLink).entry, tokenLink);
});

await test('a plain path is not treated as an entry link', () => {
  assert.equal(readTarget('https://kiki.example.test/s/abc').entry, 'https://kiki.example.test/');
});

await test('other schemes, credentials and junk are refused', () => {
  assert.deepEqual(readTarget(''), { ok: false, reason: 'empty' });
  assert.deepEqual(readTarget('file:///etc/hosts'), { ok: false, reason: 'scheme' });
  assert.deepEqual(readTarget('javascript://x'), { ok: false, reason: 'scheme' });
  assert.deepEqual(readTarget('http://user:pw@example.test'), { ok: false, reason: 'credentials' });
  assert.deepEqual(readTarget('http://'), { ok: false, reason: 'invalid' });
});

await test('display text drops the https scheme and marks plain http', () => {
  assert.equal(displayOrigin('https://kiki.example.test'), 'kiki.example.test');
  assert.equal(displayOrigin('http://192.168.1.5:5494'), '192.168.1.5:5494 · http');
});

await test('pairing code normalization and live input formatting follow the 4+4 alphabet', () => {
  assert.equal(normalizePairingCode('23456789'), '2345-6789');
  assert.equal(normalizePairingCode(' abcd-efgh '), 'ABCD-EFGH');
  assert.equal(normalizePairingCode('0000-1111'), null);
  assert.equal(normalizePairingCode('2345'), null);
  assert.equal(formatPairingCodeInput('abcd2345extra'), 'ABCD-2345');
});

await test('kiki://pair URI round-trips endpoint and short code', () => {
  const uri = formatPairingUri({
    endpoint: 'http://192.168.1.5:5494/',
    code: '2345 6789',
  });
  assert.equal(uri, 'kiki://pair?endpoint=http%3A%2F%2F192.168.1.5%3A5494&code=2345-6789');
  assert.deepEqual(parsePairingUri(uri), {
    endpoint: 'http://192.168.1.5:5494',
    code: '2345-6789',
  });
  assert.equal(parsePairingUri('kiki://pair?endpoint=ftp://example.test&code=2345-6789'), null);
  assert.equal(parsePairingUri('kiki://pair?endpoint=http://192.168.1.5:5494&code=bad'), null);
});

await test('scan payload accepts kiki://pair and explicit http(s) links while rejecting stray text', () => {
  const scannedPair = readScanPayload('kiki://pair?endpoint=http%3A%2F%2F10.0.0.8%3A5494&code=2345-6789');
  assert.deepEqual(scannedPair, {
    ok: true,
    kind: 'pair',
    origin: 'http://10.0.0.8:5494',
    endpoint: 'http://10.0.0.8:5494',
    code: '2345-6789',
    entry: 'http://10.0.0.8:5494/',
  });
  const scannedAccess = readScanPayload('https://kiki.example.test/#access=abc');
  assert.deepEqual(scannedAccess, {
    ok: true,
    kind: 'target',
    origin: 'https://kiki.example.test',
    entry: 'https://kiki.example.test/#access=abc',
  });
  assert.deepEqual(readScanPayload('PLAIN-PRODUCT-BARCODE-12345'), {
    ok: false,
    reason: 'invalid_qr',
  });
});

await test('manual connect input combines address and optional pairing code or pasted kiki://pair URI', () => {
  assert.deepEqual(readConnectInput('192.168.1.5:5494', '2345-6789'), {
    ok: true,
    kind: 'pair',
    origin: 'http://192.168.1.5:5494',
    endpoint: 'http://192.168.1.5:5494',
    code: '2345-6789',
    entry: 'http://192.168.1.5:5494/',
  });
  assert.deepEqual(readConnectInput('192.168.1.5:5494', 'bad-code'), {
    ok: false,
    reason: 'invalid_code',
  });
  assert.deepEqual(readConnectInput('kiki://pair?endpoint=https%3A%2F%2Fkiki.example.test&code=2345-6789', ''), {
    ok: true,
    kind: 'pair',
    origin: 'https://kiki.example.test',
    endpoint: 'https://kiki.example.test',
    code: '2345-6789',
    entry: 'https://kiki.example.test/',
  });
});

await test('classifyOrigin distinguishes LAN, Tailscale/VPN, and external HTTPS', () => {
  assert.deepEqual(classifyOrigin('http://192.168.1.5:5494'), {
    layer: 'lan',
    protocol: 'http',
    host: '192.168.1.5:5494',
  });
  assert.deepEqual(classifyOrigin('http://100.101.102.103:5494'), {
    layer: 'vpn',
    protocol: 'http',
    host: '100.101.102.103:5494',
  });
  assert.deepEqual(classifyOrigin('https://workstation.tailnet.ts.net'), {
    layer: 'vpn',
    protocol: 'https',
    host: 'workstation.tailnet.ts.net',
  });
  assert.deepEqual(classifyOrigin('https://kiki.example.test'), {
    layer: 'https',
    protocol: 'https',
    host: 'kiki.example.test',
  });
});

await test('saved computers preserve paired device trust across network address changes', () => {
  const storage = createMemoryStorage({
    [STORE_ORIGIN_KEY]: 'http://192.168.1.5:5494',
  });
  const initial = readSavedServers(storage);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].origin, 'http://192.168.1.5:5494');

  const paired = upsertSavedServer(storage, {
    origin: 'http://192.168.1.5:5494',
    label: 'Studio Mac',
    paired: true,
    targetHomeId: '22222222-2222-4222-8222-222222222222',
    targetHostId: 'studio-mac',
    grantId: 'grant-1',
  });
  assert.equal(paired.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(paired.paired, true);
  assert.equal(paired.label, 'Studio Mac');

  const moved = updateSavedServerOrigin(storage, paired.id, '100.90.1.8:5494');
  assert.equal(moved.ok, true);
  assert.equal(moved.server.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(moved.server.paired, true);
  assert.equal(moved.server.grantId, 'grant-1');
  assert.equal(moved.server.origin, 'http://100.90.1.8:5494');
  assert.deepEqual(moved.server.origins, ['http://100.90.1.8:5494', 'http://192.168.1.5:5494']);
  assert.equal(storage.getItem(STORE_ORIGIN_KEY), 'http://100.90.1.8:5494');

  const identity1 = readDeviceIdentity(storage, 'android');
  const identity2 = readDeviceIdentity(storage, 'android');
  assert.deepEqual(identity1, identity2);

  const afterRemove = removeSavedServer(storage, paired.id);
  assert.equal(afterRemove.length, 0);
  assert.equal(storage.getItem(STORE_ORIGIN_KEY), null);
});
