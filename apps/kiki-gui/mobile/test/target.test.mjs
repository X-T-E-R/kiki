import assert from 'node:assert/strict';
import { test } from 'node:test';

// Node ESM needs the extension to resolve the browser module.
// oxlint-disable-next-line import/extensions
import { displayOrigin, readTarget } from '../launcher/target.js';

test('a bare LAN address opens over http on its own port', () => {
  assert.deepEqual(readTarget(' 192.168.1.5:5494 '), { ok: true, origin: 'http://192.168.1.5:5494', entry: 'http://192.168.1.5:5494/' });
  assert.deepEqual(readTarget('studio.local:5494'), { ok: true, origin: 'http://studio.local:5494', entry: 'http://studio.local:5494/' });
});

test('a named public host defaults to https', () => {
  assert.deepEqual(readTarget('kiki.example.test'), { ok: true, origin: 'https://kiki.example.test', entry: 'https://kiki.example.test/' });
});

test('an entry link is opened once but only its origin is kept', () => {
  const link = 'http://10.0.0.2:5494/#access=' + 'a'.repeat(43);
  assert.deepEqual(readTarget(link), { ok: true, origin: 'http://10.0.0.2:5494', entry: link });
  const tokenLink = 'https://kiki.example.test/?token=YOUR_API_KEY';
  assert.equal(readTarget(tokenLink).origin, 'https://kiki.example.test');
  assert.equal(readTarget(tokenLink).entry, tokenLink);
});

test('a plain path is not treated as an entry link', () => {
  assert.equal(readTarget('https://kiki.example.test/s/abc').entry, 'https://kiki.example.test/');
});

test('other schemes, credentials and junk are refused', () => {
  assert.deepEqual(readTarget(''), { ok: false, reason: 'empty' });
  assert.deepEqual(readTarget('file:///etc/hosts'), { ok: false, reason: 'scheme' });
  assert.deepEqual(readTarget('javascript://x'), { ok: false, reason: 'scheme' });
  assert.deepEqual(readTarget('http://user:pw@example.test'), { ok: false, reason: 'credentials' });
  assert.deepEqual(readTarget('http://'), { ok: false, reason: 'invalid' });
});

test('display text drops the https scheme and marks plain http', () => {
  assert.equal(displayOrigin('https://kiki.example.test'), 'kiki.example.test');
  assert.equal(displayOrigin('http://192.168.1.5:5494'), '192.168.1.5:5494 · http');
});
