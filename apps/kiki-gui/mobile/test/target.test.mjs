import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { chromium } from 'playwright';

// Node ESM needs the extension to resolve the browser module.
// oxlint-disable-next-line import/extensions
import {
  STORE_ORIGIN_KEY,
  buildCommittedCredentialScript,
  claimPairingOrigin,
  classifyOrigin,
  computeHandshakeProof,
  createMutualHandshakeChallenge,
  deliverCommittedServerCredential,
  displayOrigin,
  formatPairingCodeInput,
  formatPairingUri,
  isServerOriginVerified,
  normalizePairingCode,
  openVerifiedServerNavigation,
  parsePairingUri,
  probeOriginHandshake,
  readConnectInput,
  readDeviceIdentity,
  readSavedServers,
  readScanPayload,
  readTarget,
  removeSavedServer,
  resolveVerifiedServerOpen,
  stripTokenFromEntry,
  updateSavedServerOrigin,
  upsertSavedServer,
  verifySavedServerOrigin,
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

  const fingerprint = '0123456789abcdef'.repeat(4);
  const fingerprintUri = formatPairingUri({
    endpoint: 'http://192.168.1.5:5494',
    code: '2345-6789',
    fingerprint,
  });
  assert.equal(new URL(fingerprintUri).searchParams.get('fp'), fingerprint);
  assert.deepEqual(parsePairingUri(fingerprintUri), {
    endpoint: 'http://192.168.1.5:5494',
    code: '2345-6789',
  });
  assert.deepEqual(readScanPayload(fingerprintUri), {
    ok: true,
    kind: 'pair',
    origin: 'http://192.168.1.5:5494',
    endpoint: 'http://192.168.1.5:5494',
    code: '2345-6789',
    entry: 'http://192.168.1.5:5494/',
  });
  assert.equal(parsePairingUri(`${uri}&fp=${'A'.repeat(64)}`), null);
  assert.throws(() => formatPairingUri({ endpoint: 'http://192.168.1.5:5494', code: '2345-6789', fingerprint: 'A'.repeat(64) }));
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

await test('saved computers require pairing to trust a new network address and preserve already-paired addresses', () => {
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
    verified: true,
  });
  assert.equal(paired.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(paired.paired, true);
  assert.equal(paired.label, 'Studio Mac');
  assert.equal(isServerOriginVerified(paired, 'http://192.168.1.5:5494'), true);

  // Attempting to switch a paired computer to an unverified origin without pairing refuses to overwrite
  const unverifiedMove = updateSavedServerOrigin(storage, paired.id, '100.90.1.8:5494');
  assert.equal(unverifiedMove.ok, false);
  assert.equal(unverifiedMove.reason, 'pairing_required');
  assert.equal(unverifiedMove.origin, 'http://100.90.1.8:5494');
  assert.equal(unverifiedMove.server.origin, 'http://192.168.1.5:5494');
  assert.deepEqual(unverifiedMove.server.origins, ['http://192.168.1.5:5494']);
  assert.equal(storage.getItem(STORE_ORIGIN_KEY), 'http://192.168.1.5:5494');

  // Even if public handshake echoes matching targetHomeId/targetHostId, verifySavedServerOrigin requires pairing
  const spoofAttempt = verifySavedServerOrigin(storage, paired.id, 'http://100.90.1.8:5494', {
    ok: true,
    targetHomeId: '22222222-2222-4222-8222-222222222222',
    targetHostId: 'studio-mac',
  });
  assert.equal(spoofAttempt.ok, false);
  assert.equal(spoofAttempt.reason, 'pairing_required');
  assert.equal(isServerOriginVerified(spoofAttempt.server, 'http://100.90.1.8:5494'), false);
  assert.equal(spoofAttempt.server.origin, 'http://192.168.1.5:5494');

  // After pairing the new address (verified: true), both addresses are verified and can switch freely
  const pairedSecondOrigin = upsertSavedServer(storage, {
    id: paired.id,
    origin: 'http://100.90.1.8:5494',
    label: 'Studio Mac',
    paired: true,
    targetHomeId: '22222222-2222-4222-8222-222222222222',
    targetHostId: 'studio-mac',
    grantId: 'grant-2',
    verified: true,
  });
  assert.equal(isServerOriginVerified(pairedSecondOrigin, 'http://100.90.1.8:5494'), true);
  assert.equal(isServerOriginVerified(pairedSecondOrigin, 'http://192.168.1.5:5494'), true);

  const switchBackToLan = updateSavedServerOrigin(storage, paired.id, 'http://192.168.1.5:5494');
  assert.equal(switchBackToLan.ok, true);
  assert.equal(switchBackToLan.server.origin, 'http://192.168.1.5:5494');

  const mismatch = verifySavedServerOrigin(storage, paired.id, 'http://192.168.1.99:5494', {
    ok: true,
    targetHomeId: '99999999-9999-4999-8999-999999999999',
    targetHostId: 'other-mac',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'identity_mismatch');
  assert.equal(mismatch.server.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(mismatch.server.paired, true);
  assert.equal(mismatch.server.origin, 'http://192.168.1.5:5494');
  assert.equal(mismatch.server.origins.includes('http://192.168.1.99:5494'), false);
  assert.equal(storage.getItem(STORE_ORIGIN_KEY), 'http://192.168.1.5:5494');

  const identity1 = readDeviceIdentity(storage, 'android');
  const identity2 = readDeviceIdentity(storage, 'android');
  assert.deepEqual(identity1, identity2);

  const afterRemove = removeSavedServer(storage, paired.id);
  assert.equal(afterRemove.length, 0);
  assert.equal(storage.getItem(STORE_ORIGIN_KEY), null);
});

await test('unverified origin echoing targetHomeId/targetHostId or 302-redirecting never receives old token; new code pairs new origin while old origin still opens', async () => {
  const identityA = {
    homeId: '11111111-1111-4111-8111-111111111111',
    hostId: 'workstation-a',
    protocol: 1,
  };
  const identityB = {
    homeId: '22222222-2222-4222-8222-222222222222',
    hostId: 'workstation-b',
    protocol: 1,
  };
  const requestsToSpoof = [];
  const requestsToRedirect = [];
  const requestsToB = [];

  function makeKapListener(identity, label, serverId, logList = null, claimGrants = {}) {
    return createServer((req, res) => {
      if (logList) {
        logList.push({
          method: req.method,
          url: req.url ?? '/',
          authorization: req.headers.authorization ?? '',
        });
      }
      if (req.method === 'GET' && req.url === '/api/remote-connections/handshake') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity,
              target: identity,
              targetLabel: label,
              serverId,
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/remote-connections/pair/claim') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const body = JSON.parse(raw || '{}');
          const match = claimGrants[body.code];
          if (!match) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ code: 40101, message: 'invalid_pairing_code' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              code: 0,
              data: {
                target: identity,
                targetLabel: label,
                grantId: match.grantId,
                peerToken: match.peerToken,
              },
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  }

  const serverA1 = makeKapListener(identityA, 'Studio A', 'srv-a-1', null, {
    'AAAA-2222': { grantId: 'grant-a-1', peerToken: 'peer_token_secret_a1' },
  });
  const serverA2 = makeKapListener(identityA, 'Studio A', 'srv-a-2', null, {
    'AAAA-3333': { grantId: 'grant-a-2', peerToken: 'peer_token_secret_a2' },
  });
  const serverSpoof = makeKapListener(identityA, 'Studio A', 'srv-a-spoof', requestsToSpoof);
  const serverB = makeKapListener(identityB, 'Office B', 'srv-b-1', requestsToB);

  let originA1 = '';
  const serverRedirect = createServer((req, res) => {
    requestsToRedirect.push({
      method: req.method,
      url: req.url ?? '/',
      authorization: req.headers.authorization ?? '',
    });
    res.writeHead(302, { Location: `${originA1}${req.url ?? '/'}` });
    res.end();
  });

  await new Promise((r) => { serverA1.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { serverA2.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { serverSpoof.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { serverRedirect.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { serverB.listen(0, '127.0.0.1', r); });

  try {
    originA1 = `http://127.0.0.1:${serverA1.address().port}`;
    const originA2 = `http://127.0.0.1:${serverA2.address().port}`;
    const originSpoof = `http://127.0.0.1:${serverSpoof.address().port}`;
    const originRedirect = `http://127.0.0.1:${serverRedirect.address().port}`;
    const originB = `http://127.0.0.1:${serverB.address().port}`;

    const storage = createMemoryStorage();
    const tokenStore = new Map();
    const saveToken = (serverId, token, origin) => {
      if (origin) tokenStore.set(`${serverId}@${origin}`, token);
      tokenStore.set(serverId, token);
    };
    const getToken = (serverId, origin) =>
      (origin && tokenStore.get(`${serverId}@${origin}`)) || tokenStore.get(serverId) || null;

    // 1. Pair with Computer A at originA1 using short code AAAA-2222
    const claimA1 = await claimPairingOrigin(storage, {
      origin: originA1,
      code: 'AAAA-2222',
      platform: 'android',
      saveToken,
    });
    assert.equal(claimA1.ok, true);
    const pairedA = claimA1.server;
    assert.equal(isServerOriginVerified(pairedA, originA1), true);

    // 2. Counterexample 1: Spoof server echoes identical targetHomeId/targetHostId on handshake
    const openSpoof = await resolveVerifiedServerOpen(storage, {
      serverId: pairedA.id,
      origin: originSpoof,
      entry: `${originSpoof}/`,
      label: pairedA.label,
      paired: true,
      targetHomeId: pairedA.targetHomeId,
      targetHostId: pairedA.targetHostId,
      grantId: pairedA.grantId,
      getToken,
    });
    assert.equal(openSpoof.ok, false);
    assert.equal(openSpoof.reason, 'pairing_required');
    assert.equal(isServerOriginVerified(openSpoof.server, originSpoof), false);
    assert.equal(openSpoof.server.origin, originA1);
    for (const reqInfo of requestsToSpoof) {
      assert.equal(reqInfo.authorization, '');
      assert.equal(reqInfo.url.includes('token='), false);
    }

    // 3. Counterexample 2: Redirect server 302s handshake and pair/claim to real originA1
    const redirectedHandshake = await probeOriginHandshake(originRedirect);
    assert.equal(redirectedHandshake.ok, false);

    const redirectedClaim = await claimPairingOrigin(storage, {
      origin: originRedirect,
      code: 'AAAA-2222',
      platform: 'android',
      saveToken,
    });
    assert.equal(redirectedClaim.ok, false);
    assert.equal(redirectedClaim.reason, 'rejected');

    const openRedirect = await resolveVerifiedServerOpen(storage, {
      serverId: pairedA.id,
      origin: originRedirect,
      entry: `${originRedirect}/`,
      label: pairedA.label,
      paired: true,
      targetHomeId: pairedA.targetHomeId,
      targetHostId: pairedA.targetHostId,
      grantId: pairedA.grantId,
      getToken,
    });
    assert.equal(openRedirect.ok, false);
    assert.equal(openRedirect.reason, 'unreachable');
    assert.equal(isServerOriginVerified(openRedirect.server, originRedirect), false);
    for (const reqInfo of requestsToRedirect) {
      assert.equal(reqInfo.authorization, '');
      assert.equal(reqInfo.url.includes('token='), false);
    }

    // 4. Counterexample 3: Different KAP home B returns identity_mismatch
    const openB = await resolveVerifiedServerOpen(storage, {
      serverId: pairedA.id,
      origin: originB,
      entry: `${originB}/`,
      label: pairedA.label,
      paired: true,
      targetHomeId: pairedA.targetHomeId,
      targetHostId: pairedA.targetHostId,
      grantId: pairedA.grantId,
      getToken,
    });
    assert.equal(openB.ok, false);
    assert.equal(openB.reason, 'identity_mismatch');
    assert.equal(requestsToB.length, 1);
    assert.equal(requestsToB[0].authorization, '');
    assert.equal(requestsToB[0].url.includes('token='), false);

    // Saved Computer A and its verified address originA1 & grant-a-1 are preserved untouched
    const savedBeforeRePair = readSavedServers(storage);
    assert.equal(savedBeforeRePair.length, 1);
    assert.equal(savedBeforeRePair[0].origin, originA1);
    assert.equal(savedBeforeRePair[0].grantId, 'grant-a-1');
    assert.deepEqual(savedBeforeRePair[0].origins, [originA1]);

    // 5. Positive: Changing address to originA2 with a new short code (AAAA-3333) issues its own grant & token
    const openA2WithCode = await resolveVerifiedServerOpen(storage, {
      serverId: pairedA.id,
      origin: originA2,
      entry: `${originA2}/`,
      label: pairedA.label,
      paired: true,
      targetHomeId: pairedA.targetHomeId,
      targetHostId: pairedA.targetHostId,
      grantId: pairedA.grantId,
      code: 'AAAA-3333',
      platform: 'android',
      saveToken,
      getToken,
    });
    assert.equal(openA2WithCode.ok, true);
    assert.equal(openA2WithCode.tokenAttached, false);
    assert.equal(openA2WithCode.finalEntry, `${originA2}/`);
    assert.equal(openA2WithCode.commitOrigin, originA2);
    assert.equal(openA2WithCode.sessionToken, 'peer_token_secret_a2');
    assert.equal(isServerOriginVerified(openA2WithCode.server, originA2), true);
    assert.equal(isServerOriginVerified(openA2WithCode.server, originA1), true);

    // 6. Positive: Selecting the original saved address originA1 still opens smoothly with originA1's token
    const switchToA1 = updateSavedServerOrigin(storage, pairedA.id, originA1);
    assert.equal(switchToA1.ok, true);
    const reopenA1 = await resolveVerifiedServerOpen(storage, {
      serverId: pairedA.id,
      origin: originA1,
      entry: `${originA1}/`,
      label: pairedA.label,
      paired: true,
      targetHomeId: pairedA.targetHomeId,
      targetHostId: pairedA.targetHostId,
      grantId: pairedA.grantId,
      getToken,
    });
    assert.equal(reopenA1.ok, true);
    assert.equal(reopenA1.tokenAttached, false);
    assert.equal(reopenA1.finalEntry, `${originA1}/`);
    assert.equal(reopenA1.commitOrigin, originA1);
    assert.equal(reopenA1.sessionToken, 'peer_token_secret_a1');
  } finally {
    serverA1.close();
    serverA2.close();
    serverSpoof.close();
    serverRedirect.close();
    serverB.close();
  }
});

await test('paired-origin cross-origin 302 redirect (including TOCTOU redirect) leaks zero credential to target B while same-origin open and same-origin redirect preserve hash and history state', async () => {
  const servers = [];
  async function serve(handler) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise((resolveServer) => { server.listen(0, '127.0.0.1', resolveServer); });
    return `http://127.0.0.1:${server.address().port}`;
  }

  assert.equal(
    stripTokenFromEntry(
      'http://127.0.0.1:5494',
      'http://127.0.0.1:5494/settings?token=leak&tab=providers#token=leak2&st-card-providers-add=1',
    ),
    'http://127.0.0.1:5494/settings?tab=providers#st-card-providers-add=1',
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const receiverRequests = [];
    const receiver = await serve((req, res) => {
      receiverRequests.push({
        url: req.url ?? '/',
        authorization: req.headers.authorization ?? '',
        referer: req.headers.referer ?? '',
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>redirect target</body></html>');
    });

    // 1. Direct 302 from already-paired origin to receiver (exact reproduction from check-paired-navigation-redirect.mjs)
    let directRedirectArmed = false;
    const pairedRedirecting = await serve((req, res) => {
      if (req.url === '/api/remote-connections/handshake' && !directRedirectArmed) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: { homeId: 'fixture-home', hostId: 'fixture-host', protocol: 1 },
              serverId: 'srv-fixture',
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      res.writeHead(302, { Location: receiver }).end();
    });

    const storage = createMemoryStorage();
    upsertSavedServer(storage, {
      origin: pairedRedirecting,
      targetHomeId: 'fixture-home',
      paired: true,
      verified: true,
    });
    const resolved = await resolveVerifiedServerOpen(storage, {
      origin: pairedRedirecting,
      targetHomeId: 'fixture-home',
      paired: true,
      getToken: async () => 'fixture-token',
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.tokenAttached, false);
    assert.equal(resolved.finalEntry, `${pairedRedirecting}/`);
    assert.equal(resolved.finalEntry.includes('token='), false);

    directRedirectArmed = true;
    const page = await browser.newPage();
    await page.goto(resolved.finalEntry);
    assert.equal(new URL(page.url()).origin, receiver);
    assert.equal(await page.evaluate(() => location.hash), '');

    const deliveryOnRedirect = await deliverCommittedServerCredential(page, resolved);
    assert.equal(deliveryOnRedirect.ok, false);
    assert.equal(deliveryOnRedirect.reason, 'cross_origin_redirect');
    assert.equal(deliveryOnRedirect.tokenDelivered, false);
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('kiki.connection')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('kiki.peer.token')), null);

    // Even if native evaluateJavascript runs buildCommittedCredentialScript on the redirected page,
    // the in-page origin guard rejects delivery.
    const scriptEvalOnReceiver = await page.evaluate((script) => {
      // eslint-disable-next-line no-eval
      return (0, eval)(script);
    }, buildCommittedCredentialScript(pairedRedirecting, 'fixture-token'));
    assert.equal(scriptEvalOnReceiver, false);
    assert.equal(await page.evaluate(() => localStorage.getItem('kiki.connection')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('kiki.peer.token')), null);

    // 2. TOCTOU paired origin: returns 200 OK on first visit (e.g. preflight/iframe commit) and 302s to receiver on second visit
    let toctouNavCount = 0;
    const pairedToctou = await serve((req, res) => {
      if (req.url === '/api/remote-connections/handshake') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: { homeId: 'fixture-home-toctou', hostId: 'toctou-host', protocol: 1 },
              serverId: 'srv-toctou',
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      toctouNavCount += 1;
      if (toctouNavCount === 1) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body>first visit ok</body></html>');
        return;
      }
      res.writeHead(302, { Location: receiver }).end();
    });
    upsertSavedServer(storage, {
      origin: pairedToctou,
      targetHomeId: 'fixture-home-toctou',
      paired: true,
      verified: true,
    });
    const firstOpen = await openVerifiedServerNavigation(page, storage, {
      origin: pairedToctou,
      targetHomeId: 'fixture-home-toctou',
      paired: true,
      getToken: async () => 'toctou-secret-token',
    });
    assert.equal(firstOpen.ok, true);
    assert.equal(firstOpen.tokenDelivered, true);

    const secondOpen = await openVerifiedServerNavigation(page, storage, {
      origin: pairedToctou,
      targetHomeId: 'fixture-home-toctou',
      paired: true,
      getToken: async () => 'toctou-secret-token',
    });
    assert.equal(secondOpen.ok, false);
    assert.equal(secondOpen.reason, 'cross_origin_redirect');
    assert.equal(secondOpen.tokenDelivered, false);
    assert.equal(new URL(page.url()).origin, receiver);
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('kiki.connection')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('kiki.peer.token')), null);

    for (const reqInfo of receiverRequests) {
      assert.equal(reqInfo.url.includes('token='), false);
      assert.equal(reqInfo.authorization, '');
      assert.equal(reqInfo.referer.includes('token='), false);
    }

    // 3. Positive: Paired origin with same-origin 302 redirect (`/settings?tab=providers#st-card-providers-add`)
    // commits at paired origin, receives credential, and preserves path, query, hash, and history.state.idx
    const pairedSameOriginRedirect = await serve((req, res) => {
      if (req.url === '/api/remote-connections/handshake') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: { homeId: 'fixture-home-same-origin', hostId: 'same-origin-host', protocol: 1 },
              serverId: 'srv-same-origin',
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      if (req.url === '/') {
        res.writeHead(302, { Location: '/settings?tab=providers#st-card-providers-add' }).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body><script>
        window.history.replaceState({ idx: 3, usr: { from: 'boot' } }, '');
        window.addEventListener('kiki:shell-token', (e) => {
          window.__receivedShellToken = e.detail;
        });
      </script>same-origin destination</body></html>`);
    });
    upsertSavedServer(storage, {
      origin: pairedSameOriginRedirect,
      targetHomeId: 'fixture-home-same-origin',
      paired: true,
      verified: true,
    });
    const sameOriginOpen = await openVerifiedServerNavigation(page, storage, {
      origin: pairedSameOriginRedirect,
      targetHomeId: 'fixture-home-same-origin',
      paired: true,
      getToken: async () => 'same-origin-token-123',
    });
    assert.equal(sameOriginOpen.ok, true);
    assert.equal(sameOriginOpen.tokenDelivered, true);
    assert.equal(sameOriginOpen.committedOrigin, pairedSameOriginRedirect);
    const sameOriginState = await page.evaluate(() => ({
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      historyState: window.history.state,
      storedConnection: JSON.parse(window.localStorage.getItem('kiki.connection') || 'null'),
      peerToken: window.sessionStorage.getItem('kiki.peer.token'),
      stagedSlot: window.document.__kikiShellStagedCredential,
      secondStagedRead: window.document.__kikiShellStagedCredential ?? null,
      eventDetail: window.__receivedShellToken,
    }));
    assert.equal(sameOriginState.pathname, '/settings');
    assert.equal(sameOriginState.search, '?tab=providers');
    assert.equal(sameOriginState.hash, '#st-card-providers-add');
    assert.deepEqual(sameOriginState.historyState, { idx: 3, usr: { from: 'boot' } });
    assert.equal(sameOriginState.storedConnection, null);
    assert.equal(sameOriginState.peerToken, null);
    assert.deepEqual(sameOriginState.stagedSlot, {
      origin: pairedSameOriginRedirect,
      token: 'same-origin-token-123',
    });
    assert.equal(sameOriginState.secondStagedRead, null, 'document-staged credential slot must be one-shot');
    assert.deepEqual(sameOriginState.eventDetail, {
      origin: pairedSameOriginRedirect,
      token: 'same-origin-token-123',
    });

    // 4. Real GUI `appShell.ts` + `connectionConfig.ts` consumption under production non-loopback CSP
    // (`frame-ancestors 'self'; default-src 'self'`, without `Access-Control-Allow-Origin: *`),
    // plus the four targeted counterexamples:
    //   (a) Preflight 200 OK -> main navigation 302 cross-origin redirect
    //   (b) Page JS cross-origin redirect (`window.location.replace`)
    //   (c) Plain Window / missing native bridge refusal (`native_bridge_required`)
    //   (d) Existing non-shell owner credential refusal (`existing_owner_credential`)
    const guiSrcDir = resolve(import.meta.dirname, '../../src');
    const realConnectionConfigJs = stripTypeScriptTypes(
      readFileSync(join(guiSrcDir, 'state/connectionConfig.ts'), 'utf8'),
    );
    const realAppShellJs = stripTypeScriptTypes(
      readFileSync(join(guiSrcDir, 'lib/appShell.ts'), 'utf8'),
    )
      .replace("from '../state/connectionConfig'", "from '/src/state/connectionConfig.ts'")
      .replace("from './webAccess'", "from '/src/lib/webAccess.ts'");

    const productionCsp =
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'self'; frame-src 'self' http://*.kiki-document.localhost:*";
    let cspTargetMode = 'normal';
    const cspPairedServer = await serve((req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', productionCsp);
      if (req.url === '/api/remote-connections/handshake') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: { homeId: 'fixture-home-csp', hostId: 'csp-host', protocol: 1 },
              serverId: 'srv-csp',
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      if (req.url === '/src/state/connectionConfig.ts') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(realConnectionConfigJs);
        return;
      }
      if (req.url === '/src/lib/webAccess.ts') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end('export function webAccessBootstrap() { return { kind: "none" }; }\n');
        return;
      }
      if (req.url === '/src/lib/appShell.ts') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(realAppShellJs);
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(`
          import { installAppShellCredentialListener, readAdoptedShellCredential } from '/src/lib/appShell.ts';
          import { readStoredConfig } from '/src/state/connectionConfig.ts';
          window.__shellEvents = [];
          installAppShellCredentialListener(window, (detail) => {
            window.__shellEvents.push(detail);
          });
          window.__readStoredConfig = () => readStoredConfig(window.localStorage);
          window.__readAdoptedShellCredential = () => readAdoptedShellCredential(window);
          document.body.dataset.ready = 'true';
        `);
        return;
      }
      if (cspTargetMode === 'preflight-200-nav-302') {
        const isMainNav =
          req.headers['sec-fetch-mode'] === 'navigate' ||
          String(req.headers.accept ?? '').includes('text/html');
        if (!isMainNav) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('preflight ok');
          return;
        }
        res.writeHead(302, { Location: `${receiver}/` }).end();
        return;
      }
      if (req.url === '/redirect.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(`window.location.replace(${JSON.stringify(`${receiver}/`)});`);
        return;
      }
      if (cspTargetMode === 'js-cross-origin-redirect') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><meta charset="utf-8"><script src="/redirect.js"></script></head><body>redirecting</body></html>',
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/app.js"></script>csp-gui</body></html>');
    });

    upsertSavedServer(storage, {
      origin: cspPairedServer,
      targetHomeId: 'fixture-home-csp',
      paired: true,
      verified: true,
    });

    // 4a. Counterexample: Plain browser Window (no native evaluation bridge) refuses token delivery and wipes window.name
    const mockLauncherWin = {
      name: 'stale-window-name',
    };
    const cspResolved = {
      ok: true,
      origin: cspPairedServer,
      commitOrigin: cspPairedServer,
      finalEntry: `${cspPairedServer}/`,
      sessionToken: 'csp-paired-secret-token',
      tokenAttached: false,
    };
    const plainWinDelivery = await deliverCommittedServerCredential(mockLauncherWin, cspResolved);
    assert.equal(plainWinDelivery.ok, false);
    assert.equal(plainWinDelivery.reason, 'native_bridge_required');
    assert.equal(plainWinDelivery.tokenDelivered, false);
    assert.equal(mockLauncherWin.name, '');

    // 4b. Counterexample: Preflight returns 200 OK, but main document navigation 302s cross-origin to `receiver`
    cspTargetMode = 'preflight-200-nav-302';
    const preflightRes = await fetch(`${cspPairedServer}/`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    assert.equal(preflightRes.status, 200);
    const nav302Result = await openVerifiedServerNavigation(page, storage, {
      origin: cspPairedServer,
      targetHomeId: 'fixture-home-csp',
      paired: true,
      getToken: async () => 'csp-paired-secret-token',
    });
    assert.equal(nav302Result.ok, false);
    assert.equal(nav302Result.reason, 'cross_origin_redirect');
    assert.equal(nav302Result.tokenDelivered, false);
    assert.equal(new URL(page.url()).origin, receiver);
    assert.equal(await page.evaluate(() => window.name), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('kiki.connection')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('kiki.peer.token')), null);

    // 4c. Counterexample: Target returns 200 OK HTML that immediately executes a JS cross-origin redirect (`window.location.replace(receiver)`)
    cspTargetMode = 'js-cross-origin-redirect';
    const jsRedirectResult = await openVerifiedServerNavigation(page, storage, {
      origin: cspPairedServer,
      targetHomeId: 'fixture-home-csp',
      paired: true,
      getToken: async () => 'csp-paired-secret-token',
    });
    assert.equal(jsRedirectResult.ok, false);
    assert.equal(jsRedirectResult.reason, 'cross_origin_redirect');
    assert.equal(jsRedirectResult.tokenDelivered, false);
    assert.equal(new URL(page.url()).origin, receiver);
    assert.equal(await page.evaluate(() => window.name), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('kiki.connection')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('kiki.peer.token')), null);

    // 4d. Positive: Same-origin commit under production CSP with real `appShell.ts` + `connectionConfig.ts`
    cspTargetMode = 'normal';
    const shellCtx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Linux; Android 16; wv) KikiApp/android',
    });
    try {
      const shellPage = await shellCtx.newPage();
      const positiveCspOpen = await openVerifiedServerNavigation(shellPage, storage, {
        origin: cspPairedServer,
        targetHomeId: 'fixture-home-csp',
        paired: true,
        getToken: async () => 'csp-paired-secret-token',
      });
      assert.equal(positiveCspOpen.ok, true);
      assert.equal(positiveCspOpen.tokenDelivered, true);
      await shellPage.waitForSelector('body[data-ready="true"]');
      const cspState = await shellPage.evaluate(() => ({
        windowName: window.name,
        storedConnection: window.__readStoredConfig(),
        shellManaged: localStorage.getItem('kiki.shell.managed'),
        peerToken: sessionStorage.getItem('kiki.peer.token'),
        adoptedToken: window.__readAdoptedShellCredential(),
        shellEvents: window.__shellEvents,
      }));
      assert.equal(cspState.windowName, '');
      assert.equal(cspState.storedConnection, null);
      assert.equal(cspState.shellManaged, null);
      assert.equal(cspState.peerToken, null);
      assert.equal(cspState.adoptedToken, 'csp-paired-secret-token');
      assert.deepEqual(cspState.shellEvents, [
        { origin: cspPairedServer, token: 'csp-paired-secret-token' },
      ]);

      // 4e. Counterexample: Existing non-shell owner credential on target origin is never overwritten
      await shellPage.evaluate(() => {
        localStorage.removeItem('kiki.shell.managed');
        localStorage.setItem(
          'kiki.connection',
          JSON.stringify({ url: '', token: 'existing-owner-token' }),
        );
        sessionStorage.removeItem('kiki.peer.token');
      });
      const ownerProtectedDelivery = await deliverCommittedServerCredential(shellPage, {
        ...cspResolved,
        sessionToken: 'override-attempt-token',
      });
      assert.equal(ownerProtectedDelivery.ok, false);
      assert.equal(ownerProtectedDelivery.reason, 'existing_owner_credential');
      assert.equal(ownerProtectedDelivery.tokenDelivered, false);
      const scriptEvalWithOwner = await shellPage.evaluate((script) => {
        // eslint-disable-next-line no-eval
        return (0, eval)(script);
      }, buildCommittedCredentialScript(cspPairedServer, 'override-attempt-token'));
      assert.equal(scriptEvalWithOwner, false);
      await shellPage.evaluate((origin) => {
        window.postMessage(
          { type: 'kiki:shell-credential', origin, token: 'attacker-forged-token' },
          '*',
        );
      }, cspPairedServer);
      const afterOwnerCheck = await shellPage.evaluate(() => ({
        storedConnection: window.__readStoredConfig(),
        shellManaged: localStorage.getItem('kiki.shell.managed'),
        peerToken: sessionStorage.getItem('kiki.peer.token'),
      }));
      assert.deepEqual(afterOwnerCheck.storedConnection, {
        url: '',
        token: 'existing-owner-token',
      });
      assert.equal(afterOwnerCheck.shellManaged, null);
      assert.equal(afterOwnerCheck.peerToken, null);
    } finally {
      await shellCtx.close();
    }

    // 5. Native Android & iOS plugin source contract verification:
    // Neither KikiShellPlugin.java nor SceneDelegate.swift attaches `#token=` before loadUrl/load(URLRequest);
    // both strip token fragments before loading, cancel cross-origin redirects in shouldOverrideLoad,
    // and deliver credentials only after verifying committed origin.
    const mobileRoot = resolve(import.meta.dirname, '..');
    const androidPluginSource = readFileSync(
      join(mobileRoot, 'android/app/src/main/java/ai/easyagent/kiki/KikiShellPlugin.java'),
      'utf8',
    );
    const iosPluginSource = readFileSync(
      join(mobileRoot, 'ios/App/App/SceneDelegate.swift'),
      'utf8',
    );
    const iosInfoPlist = readFileSync(
      join(mobileRoot, 'ios/App/App/Info.plist'),
      'utf8',
    );
    assert.equal(androidPluginSource.includes('/#token='), false);
    assert.equal(iosPluginSource.includes('/#token='), false);
    assert.match(androidPluginSource, /stripTokenFromEntry\(origin,\s*entry\)/);
    assert.match(androidPluginSource, /onPageCommitVisible/);
    assert.match(androidPluginSource, /deliverCommittedToken/);
    assert.match(androidPluginSource, /buildDocumentNavNonceScript\(targetOrigin,\s*expectedNavNonce\)/);
    assert.match(androidPluginSource, /buildCredentialDeliveryScript\(targetOrigin,\s*token,\s*expectedNavNonce\)/);
    assert.match(androidPluginSource, /fetchHandshake\(normalizedOrigin,\s*serverId,\s*grantId\)/);
    assert.match(androidPluginSource, /fetchHandshake\(origin,\s*serverId,\s*grantId\)/);
    assert.match(androidPluginSource, /fetchHandshake\(targetOrigin,\s*targetServerId\)/);
    assert.match(androidPluginSource, /x-kiki-handshake-nonce/);
    assert.match(androidPluginSource, /x-kiki-handshake-proof/);
    assert.match(androidPluginSource, /x-kiki-handshake-grant/);
    assert.match(androidPluginSource, /kiki-handshake-req-v1:/);
    assert.match(androidPluginSource, /kiki-handshake-res-v1:/);
    assert.match(androidPluginSource, /!hs\.mutualProofVerified/);
    assert.match(androidPluginSource, /clearPendingAuthIfCurrent\(callEpoch\)/);
    assert.equal(
      /removeVerifiedOrigin\s*\(/.test(
        androidPluginSource.slice(0, androidPluginSource.indexOf('private void removeVerifiedOrigin')),
      ),
      false,
      'Android plugin must not remove verifiedOrigins on temporary DHCP mismatch',
    );
    assert.match(iosPluginSource, /stripTokenFromEntry\(origin:\s*origin,\s*entry:\s*entry\)/);
    assert.match(iosPluginSource, /handleWebViewNavigationState/);
    assert.match(
      iosPluginSource,
      /buildDocumentNavNonceScript\(expectedOrigin:\s*targetOrigin,\s*navNonce:\s*expectedNavNonce\)/,
    );
    assert.match(
      iosPluginSource,
      /buildCredentialDeliveryScript\(\s*expectedOrigin:\s*targetOrigin,\s*token:\s*token,\s*expectedNavNonce:\s*expectedNavNonce\s*\)/,
    );
    assert.match(iosPluginSource, /Self\.fetchHandshake\(origin:\s*normalized,\s*serverId:\s*serverId,\s*explicitGrantId:\s*grantId\)/);
    assert.match(iosPluginSource, /Self\.fetchHandshake\(origin:\s*origin,\s*serverId:\s*serverId,\s*explicitGrantId:\s*grantId\)/);
    assert.match(iosPluginSource, /Self\.fetchHandshake\(origin:\s*targetOrigin,\s*serverId:\s*targetServerId\)/);
    assert.match(iosPluginSource, /x-kiki-handshake-nonce/);
    assert.match(iosPluginSource, /x-kiki-handshake-proof/);
    assert.match(iosPluginSource, /x-kiki-handshake-grant/);
    assert.match(iosPluginSource, /kiki-handshake-req-v1:/);
    assert.match(iosPluginSource, /kiki-handshake-res-v1:/);
    assert.match(iosPluginSource, /mutualVerified/);
    assert.match(iosPluginSource, /clearPendingAuthIfCurrent\(epoch:\s*callEpoch\)/);
    assert.equal(
      /Self\.removeVerifiedOrigin\s*\(/.test(iosPluginSource),
      false,
      'iOS plugin must not remove verifiedOrigins on temporary DHCP mismatch',
    );
    assert.match(iosInfoPlist, /<key>CFBundleURLTypes<\/key>/);
    assert.match(iosInfoPlist, /<string>kiki<\/string>/);
    assert.match(iosPluginSource, /navigateToPendingPair\(\)/);
    assert.match(iosPluginSource, /\/index\.html#pair/);

    // 6. R1 regression: already-verified same origin reassigned to Home B (LAN DHCP / port reuse)
    // leaks zero old peer token to Home B across both pre-open and post-navigation commit checks,
    // preserves saved Computer A and its credential, and resumes seamlessly when Home A returns.
    let activeTenant = 'A';
    const homeBRequests = [];
    const sharedLanOrigin = await serve((req, res) => {
      if (activeTenant === 'B') {
        homeBRequests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          authorization: req.headers.authorization ?? '',
          cookie: req.headers.cookie ?? '',
          referer: req.headers.referer ?? '',
        });
      }
      if (req.url === '/api/remote-connections/handshake') {
        if (activeTenant === 'meta-401-only') {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 40100, msg: 'Unauthorized' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            code: 0,
            data:
              activeTenant === 'A'
                ? {
                    identity: { homeId: 'home-a-id', hostId: 'host-a', protocol: 1 },
                    targetLabel: 'Workstation A',
                    serverId: 'srv-a',
                    inboundEnabled: true,
                  }
                : {
                    identity: { homeId: 'home-b-id', hostId: 'host-b', protocol: 1 },
                    targetLabel: 'Stranger Home B',
                    serverId: 'srv-b',
                    inboundEnabled: true,
                  },
          }),
        );
        return;
      }
      if (req.url === '/api/meta' && activeTenant === 'meta-401-only') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 40100, msg: 'Unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><body>tenant-${activeTenant}</body></html>`,
      );
    });

    const dhcpStorage = createMemoryStorage();
    const tokenReads = [];
    const readSavedTokenForA = async (serverId, origin) => {
      tokenReads.push({ serverId, origin, tenantAtRead: activeTenant });
      return 'secret-peer-token-home-a';
    };
    upsertSavedServer(dhcpStorage, {
      id: 'home-a-id',
      origin: sharedLanOrigin,
      label: 'Workstation A',
      paired: true,
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
      grantId: 'grant-a',
      verified: true,
    });

    const dhcpPage = await browser.newPage();
    const openWhenA = await openVerifiedServerNavigation(dhcpPage, dhcpStorage, {
      serverId: 'home-a-id',
      origin: sharedLanOrigin,
      label: 'Workstation A',
      paired: true,
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
      grantId: 'grant-a',
      getToken: readSavedTokenForA,
    });
    assert.equal(openWhenA.ok, true);
    assert.equal(openWhenA.tokenDelivered, true);
    assert.equal(
      await dhcpPage.evaluate(() => localStorage.getItem('kiki.connection')),
      null,
      'Shell peer token must stay in document memory only and never persist to localStorage',
    );
    assert.equal(
      await dhcpPage.evaluate(() => sessionStorage.getItem('kiki.peer.token')),
      null,
      'Shell peer token must never be written to sessionStorage',
    );
    assert.deepEqual(
      await dhcpPage.evaluate(() => window.document.__kikiShellStagedCredential),
      { origin: sharedLanOrigin, token: 'secret-peer-token-home-a' },
    );

    // Counterexample (cross-origin launcher round-trip + same-origin replacement document):
    // Without calling localStorage.clear() or sessionStorage.clear(), navigate the same WebView
    // to another port (launcher), then switch sharedLanOrigin to Home B whose first inline script
    // tries to read localStorage, sessionStorage, window.name, and document.__kikiShellStagedCredential
    // BEFORE any new handshake or credential injection.
    const crossOriginLauncher = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>cross-origin-launcher</body></html>');
    });
    await dhcpPage.goto(crossOriginLauncher);
    activeTenant = 'B';
    await dhcpPage.goto(sharedLanOrigin);
    const replacementFirstScriptCheck = await dhcpPage.evaluate(() => ({
      localConn: window.localStorage.getItem('kiki.connection'),
      sessionPeer: window.sessionStorage.getItem('kiki.peer.token'),
      winName: window.name,
      docStaged: window.document.__kikiShellStagedCredential ?? null,
    }));
    const freshReplacementDocumentReadsOldPeerBeforeHandshake = Boolean(
      replacementFirstScriptCheck.localConn ||
        replacementFirstScriptCheck.sessionPeer ||
        replacementFirstScriptCheck.winName ||
        replacementFirstScriptCheck.docStaged,
    );
    assert.equal(
      freshReplacementDocumentReadsOldPeerBeforeHandshake,
      false,
      'Replacement document after cross-origin launcher round-trip must read zero old peer credential before handshake',
    );

    homeBRequests.length = 0;
    const tokenReadsBeforeB = tokenReads.length;
    const openWhenB = await openVerifiedServerNavigation(dhcpPage, dhcpStorage, {
      serverId: 'home-a-id',
      origin: sharedLanOrigin,
      label: 'Workstation A',
      paired: true,
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
      grantId: 'grant-a',
      getToken: readSavedTokenForA,
    });
    assert.equal(openWhenB.ok, false);
    assert.equal(openWhenB.reason, 'identity_mismatch');
    assert.equal(openWhenB.tokenDelivered, false);
    assert.equal(tokenReads.length, tokenReadsBeforeB, 'saved peer token must not even be read when handshake reports Home B');

    // Even if Home A answered during pre-open and switched to Home B right as the WebView committed:
    const midFlightCommitToB = await deliverCommittedServerCredential(dhcpPage, openWhenA);
    assert.equal(midFlightCommitToB.ok, false);
    assert.equal(midFlightCommitToB.reason, 'identity_mismatch');
    assert.equal(midFlightCommitToB.targetHomeId, 'home-b-id');
    assert.equal(midFlightCommitToB.tokenDelivered, false);
    assert.equal(await dhcpPage.evaluate(() => localStorage.getItem('kiki.connection')), null);
    assert.equal(await dhcpPage.evaluate(() => sessionStorage.getItem('kiki.peer.token')), null);
    assert.equal(await dhcpPage.evaluate(() => window.document.__kikiShellStagedCredential ?? null), null);

    // Home B received zero old token on any network request
    assert.equal(homeBRequests.length > 0, true);
    for (const req of homeBRequests) {
      assert.equal(req.authorization, '');
      assert.equal(req.url.includes('token='), false);
      assert.equal(req.url.includes('secret-peer-token-home-a'), false);
      assert.equal(req.referer.includes('token='), false);
    }

    // Saved Computer A record and its pairing metadata (including multiple verifiedOrigins) are preserved
    const savedDuringB = readSavedServers(dhcpStorage);
    assert.equal(savedDuringB.length, 1);
    assert.equal(savedDuringB[0].id, 'home-a-id');
    assert.equal(savedDuringB[0].targetHomeId, 'home-a-id');
    assert.equal(savedDuringB[0].label, 'Workstation A');
    assert.equal(isServerOriginVerified(savedDuringB[0], sharedLanOrigin), true);

    upsertSavedServer(dhcpStorage, {
      id: 'home-a-id',
      origin: 'http://100.90.1.8:5494',
      label: 'Workstation A',
      paired: true,
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
      grantId: 'grant-a',
      verified: true,
    });
    const multiOriginMismatch = verifySavedServerOrigin(dhcpStorage, 'home-a-id', sharedLanOrigin, {
      ok: true,
      targetHomeId: 'home-b-id',
      targetHostId: 'host-b',
    });
    assert.equal(multiOriginMismatch.ok, false);
    assert.equal(multiOriginMismatch.reason, 'identity_mismatch');
    assert.equal(
      isServerOriginVerified(multiOriginMismatch.server, sharedLanOrigin),
      true,
      'Temporary DHCP mismatch must not strip sharedLanOrigin from verifiedOrigins',
    );
    assert.equal(isServerOriginVerified(multiOriginMismatch.server, 'http://100.90.1.8:5494'), true);

    // A server that only returns 401 on handshake and /api/meta (unauthenticated reachability without identity)
    // is never treated as an identity match for a paired computer:
    activeTenant = 'meta-401-only';
    const openWhen401Only = await resolveVerifiedServerOpen(dhcpStorage, {
      serverId: 'home-a-id',
      origin: sharedLanOrigin,
      label: 'Workstation A',
      paired: true,
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
      grantId: 'grant-a',
      getToken: readSavedTokenForA,
    });
    assert.equal(openWhen401Only.ok, false);
    assert.equal(openWhen401Only.reason, 'unreachable');
    assert.equal(tokenReads.length, tokenReadsBeforeB);

    // When Home A returns to the same LAN origin, it resumes seamlessly without re-pairing:
    activeTenant = 'A';
    const reopenWhenAReturns = await openVerifiedServerNavigation(dhcpPage, dhcpStorage, {
      serverId: 'home-a-id',
      origin: sharedLanOrigin,
      label: 'Workstation A',
      paired: true,
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
      grantId: 'grant-a',
      getToken: readSavedTokenForA,
    });
    assert.equal(reopenWhenAReturns.ok, true);
    assert.equal(reopenWhenAReturns.tokenDelivered, true);
    assert.equal(
      await dhcpPage.evaluate(() => localStorage.getItem('kiki.connection')),
      null,
    );
    assert.equal(
      await dhcpPage.evaluate(() => sessionStorage.getItem('kiki.peer.token')),
      null,
    );
    assert.deepEqual(
      await dhcpPage.evaluate(() => window.document.__kikiShellStagedCredential),
      { origin: sharedLanOrigin, token: 'secret-peer-token-home-a' },
    );

    // 7. Native-equivalent state machine test (Android KikiShellPlugin / iOS SceneDelegate):
    // - Temporary DHCP mismatch rejects open() and navigation commit without removing verifiedOrigins
    //   or deleting native token, and resumes when the original computer returns.
    // - Same-origin reload (after finalize cleared pendingAuth) re-verifies handshake via activeAuth
    //   and re-delivers the document-scoped credential without permanent web storage.
    // - Navigating to the launcher clears both pendingAuth and activeAuth.
    // - A stale async handshake callback from an earlier open() never clears pendingAuth of a newer open().
    // - Only explicit forgetServer() deletes the native verifiedOrigins and stored token.
    const createNativeShellStateMachine = (fetchHandshakeImpl) => {
      const serverTokens = new Map();
      const verifiedOriginsByServer = new Map();
      let pendingAuthOrigin = null;
      let pendingAuthServerId = null;
      let pendingAuthHomeId = null;
      let pendingAuthHostId = null;
      let pendingAuthToken = null;
      let activeAuthOrigin = null;
      let activeAuthServerId = null;
      let activeAuthHomeId = null;
      let activeAuthHostId = null;
      let pendingAuthEpoch = 0;
      const deliveredScripts = [];
      const loadedUrls = [];

      const clearPendingAuth = () => {
        pendingAuthEpoch += 1;
        pendingAuthOrigin = null;
        pendingAuthServerId = null;
        pendingAuthHomeId = null;
        pendingAuthHostId = null;
        pendingAuthToken = null;
      };
      const clearActiveAuth = () => {
        activeAuthOrigin = null;
        activeAuthServerId = null;
        activeAuthHomeId = null;
        activeAuthHostId = null;
      };
      const clearPendingAuthIfCurrent = (epoch) => {
        if (pendingAuthEpoch !== epoch) return;
        pendingAuthOrigin = null;
        pendingAuthServerId = null;
        pendingAuthHomeId = null;
        pendingAuthHostId = null;
        pendingAuthToken = null;
      };
      return {
        saveServerToken(serverId, token, origin) {
          serverTokens.set(serverId, token);
          const list = verifiedOriginsByServer.get(serverId) ?? [];
          if (origin && !list.includes(origin)) list.push(origin);
          verifiedOriginsByServer.set(serverId, list);
        },
        isOriginVerified(serverId, origin) {
          return (verifiedOriginsByServer.get(serverId) ?? []).includes(origin);
        },
        getServerToken(serverId) {
          return serverTokens.get(serverId) ?? null;
        },
        forgetServer(serverId) {
          clearPendingAuth();
          clearActiveAuth();
          serverTokens.delete(serverId);
          verifiedOriginsByServer.delete(serverId);
        },
        async open({ url, serverId, targetHomeId, targetHostId }) {
          const origin = new URL(url).origin;
          const storedToken = serverId && this.isOriginVerified(serverId, origin) ? this.getServerToken(serverId) : null;
          if (!storedToken) {
            clearPendingAuth();
            clearActiveAuth();
            loadedUrls.push(url);
            return { ok: true, mode: 'unauthenticated' };
          }
          pendingAuthEpoch += 1;
          const callEpoch = pendingAuthEpoch;
          const handshake = await fetchHandshakeImpl(origin);
          if (pendingAuthEpoch !== callEpoch) {
            return { ok: false, stale: true };
          }
          const handshakeOk =
            handshake &&
            handshake.ok &&
            (!targetHomeId || handshake.homeId === targetHomeId) &&
            (!targetHostId || handshake.hostId === targetHostId);
          if (!handshakeOk) {
            clearPendingAuthIfCurrent(callEpoch);
            return {
              ok: false,
              reason: handshake && handshake.ok ? 'identity_mismatch' : 'unreachable',
            };
          }
          pendingAuthOrigin = origin;
          pendingAuthServerId = serverId;
          pendingAuthHomeId = targetHomeId;
          pendingAuthHostId = targetHostId;
          pendingAuthToken = storedToken;
          activeAuthOrigin = origin;
          activeAuthServerId = serverId;
          activeAuthHomeId = targetHomeId;
          activeAuthHostId = targetHostId;
          loadedUrls.push(url);
          return { ok: true, mode: 'authenticated', epoch: callEpoch };
        },
        async onPageCommitVisible(currentUrl, finalize = false) {
          if (currentUrl.startsWith('https://localhost/')) {
            clearPendingAuth();
            clearActiveAuth();
            return { delivered: false, reason: 'launcher' };
          }
          const currentOrigin = new URL(currentUrl).origin;
          const expectedEpoch = pendingAuthEpoch;
          let expectedOrigin = pendingAuthOrigin;
          let expectedServerId = pendingAuthServerId;
          let expectedHomeId = pendingAuthHomeId;
          let expectedHostId = pendingAuthHostId;
          if (!expectedOrigin || !expectedServerId) {
            if (activeAuthOrigin && activeAuthServerId && activeAuthOrigin === currentOrigin) {
              expectedOrigin = activeAuthOrigin;
              expectedServerId = activeAuthServerId;
              expectedHomeId = activeAuthHomeId;
              expectedHostId = activeAuthHostId;
            } else {
              return { delivered: false };
            }
          }
          if (currentOrigin !== expectedOrigin) {
            clearPendingAuthIfCurrent(expectedEpoch);
            clearActiveAuth();
            return { delivered: false, reason: 'cross_origin' };
          }
          const handshake = await fetchHandshakeImpl(expectedOrigin);
          if (pendingAuthEpoch !== expectedEpoch) {
            return { delivered: false, stale: true };
          }
          const handshakeOk =
            handshake &&
            handshake.ok &&
            (!expectedHomeId || handshake.homeId === expectedHomeId) &&
            (!expectedHostId || handshake.hostId === expectedHostId);
          if (!handshakeOk) {
            clearPendingAuthIfCurrent(expectedEpoch);
            clearActiveAuth();
            return { delivered: false, reason: 'identity_mismatch' };
          }
          const token = this.getServerToken(expectedServerId);
          if (finalize) {
            clearPendingAuthIfCurrent(expectedEpoch);
          }
          if (!token) return { delivered: false };
          deliveredScripts.push(buildCommittedCredentialScript(expectedOrigin, token));
          return { delivered: true };
        },
        getPendingAuthSnapshot() {
          return {
            origin: pendingAuthOrigin,
            serverId: pendingAuthServerId,
            token: pendingAuthToken,
            activeOrigin: activeAuthOrigin,
            activeServerId: activeAuthServerId,
            epoch: pendingAuthEpoch,
          };
        },
        deliveredScripts,
        loadedUrls,
      };
    };

    let deferredSlowResolver = null;
    const nativeState = createNativeShellStateMachine((origin) => {
      if (origin === 'http://192.168.1.50:5494') {
        return new Promise((resolve) => {
          deferredSlowResolver = resolve;
        });
      }
      if (origin === 'http://192.168.1.51:5494') {
        return Promise.resolve({
          ok: true,
          homeId: activeTenant === 'A' ? 'home-a-id' : 'home-b-id',
          hostId: activeTenant === 'A' ? 'host-a' : 'host-b',
        });
      }
      return Promise.resolve({ ok: false });
    });

    nativeState.saveServerToken('home-a-id', 'native-token-a', 'http://192.168.1.50:5494');
    nativeState.saveServerToken('home-a-id', 'native-token-a', 'http://192.168.1.51:5494');

    // Start slow navigation 1 to .50, then immediately start fast navigation 2 to .51 while A is active:
    activeTenant = 'A';
    const slowOpenPromise = nativeState.open({
      url: 'http://192.168.1.50:5494/',
      serverId: 'home-a-id',
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
    });
    const fastOpenResult = await nativeState.open({
      url: 'http://192.168.1.51:5494/',
      serverId: 'home-a-id',
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
    });
    assert.equal(fastOpenResult.ok, true);
    assert.equal(nativeState.getPendingAuthSnapshot().origin, 'http://192.168.1.51:5494');

    // Now the slow handshake from navigation 1 resolves with a mismatch (or failure):
    deferredSlowResolver({ ok: true, homeId: 'home-b-id', hostId: 'host-b' });
    const slowOpenResult = await slowOpenPromise;
    assert.equal(slowOpenResult.ok, false);
    assert.equal(slowOpenResult.stale, true);
    // Navigation 2's pendingAuth MUST remain intact and deliver on commit & finalize:
    assert.equal(nativeState.getPendingAuthSnapshot().origin, 'http://192.168.1.51:5494');
    assert.equal(nativeState.getPendingAuthSnapshot().token, 'native-token-a');
    const commitFast = await nativeState.onPageCommitVisible('http://192.168.1.51:5494/', true);
    assert.equal(commitFast.delivered, true);
    assert.equal(nativeState.getPendingAuthSnapshot().origin, null, 'finalize clears pendingAuthOrigin');
    assert.equal(nativeState.getPendingAuthSnapshot().activeOrigin, 'http://192.168.1.51:5494', 'activeAuthOrigin remains bound for same-origin reload');

    // Normal same-origin reload re-verifies handshake via activeAuth and re-delivers credential to the new document:
    const reloadOn51 = await nativeState.onPageCommitVisible('http://192.168.1.51:5494/settings', true);
    assert.equal(reloadOn51.delivered, true);

    // If the server is replaced by Home B during a reload, activeAuth rejects and clears activeAuth:
    activeTenant = 'B';
    const reloadMismatchOn51 = await nativeState.onPageCommitVisible('http://192.168.1.51:5494/settings', true);
    assert.equal(reloadMismatchOn51.delivered, false);
    assert.equal(reloadMismatchOn51.reason, 'identity_mismatch');
    assert.equal(nativeState.getPendingAuthSnapshot().activeOrigin, null);

    // Temporary DHCP switch on .51 to Home B rejects open() but keeps .51 verified and token intact:
    const mismatchOn51 = await nativeState.open({
      url: 'http://192.168.1.51:5494/',
      serverId: 'home-a-id',
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
    });
    assert.equal(mismatchOn51.ok, false);
    assert.equal(mismatchOn51.reason, 'identity_mismatch');
    assert.equal(nativeState.isOriginVerified('home-a-id', 'http://192.168.1.51:5494'), true);
    assert.equal(nativeState.getServerToken('home-a-id'), 'native-token-a');

    // When Home A returns to .51, open() succeeds immediately without re-pairing:
    activeTenant = 'A';
    const resumeOn51 = await nativeState.open({
      url: 'http://192.168.1.51:5494/',
      serverId: 'home-a-id',
      targetHomeId: 'home-a-id',
      targetHostId: 'host-a',
    });
    assert.equal(resumeOn51.ok, true);
    assert.equal(resumeOn51.mode, 'authenticated');

    // Navigating back to launcher clears both pendingAuth and activeAuth:
    const navLauncher = await nativeState.onPageCommitVisible('https://localhost/index.html#change', true);
    assert.equal(navLauncher.delivered, false);
    assert.equal(nativeState.getPendingAuthSnapshot().origin, null);
    assert.equal(nativeState.getPendingAuthSnapshot().activeOrigin, null);

    // Only explicit forgetServer removes verifiedOrigins and token:
    nativeState.forgetServer('home-a-id');
    assert.equal(nativeState.isOriginVerified('home-a-id', 'http://192.168.1.51:5494'), false);
    assert.equal(nativeState.getServerToken('home-a-id'), null);
  } finally {
    await browser.close();
    for (const server of servers) server.close();
  }
});

test('Android KikiShellPlugin actual Java methods bind async handshake to exact document generation and reject stale A delivery into same-origin replacement document B', () => {
  const source = readFileSync(
    new URL('../android/app/src/main/java/ai/easyagent/kiki/KikiShellPlugin.java', import.meta.url),
    'utf8',
  );
  function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return source.slice(from, to);
  }
  const fields = section('    private static final SecureRandom NONCE_RANDOM', '    @Override\n    public void load()');
  const load = section('    public void load() {', '    @PluginMethod\n    public void scanQr');
  const probeMethod = section('    @PluginMethod\n    public void probe(PluginCall call)', '    @PluginMethod\n    public void claimPair').replaceAll('    @PluginMethod\n', '');
  const openMethods = section('    @PluginMethod\n    public void open(PluginCall call)', '    @PluginMethod\n    public void forgetServer').replaceAll('    @PluginMethod\n', '');
  const clear = section('    private void clearPendingAuth() {', '    private void deliverCommittedToken');
  const deliver = section('    private void deliverCommittedToken', '    static String stripTokenFromEntry');
  const stripAndBuilder = section('    static String stripTokenFromEntry', '    private HandshakeResult fetchHandshake');
  const cryptoHelpers = section('    static String sha256Hex', '    private String resolveHandshakeKey');
  const override = section('    @Override\n    public Boolean shouldOverrideLoad(Uri url)', '    @Override\n    protected void handleOnNewIntent').replace('    @Override\n', '');
  const origin = section('    private static boolean isWebOrigin(Uri uri)', '\n}');
  assert.ok(load.includes('new WebViewListener()'));

  const tempDir = mkdtempSync(join(tmpdir(), 'kiki-native-delivery-'));
  try {
    const javaSource = `import java.net.URI;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.*;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
public class NativeDeliveryCheck {
${fields}
${load}
${probeMethod}
${openMethods}
${clear}
${deliver}
${stripAndBuilder}
${cryptoHelpers}
${override}
${origin}
    private static final String TRUSTED_ORIGIN = "trustedOrigin";
    private static final String ORIGIN = "http://192.168.1.50:5494";
    private final WebView view = new WebView();
    private final Bridge bridge = new Bridge(view);
    private final Activity activity = new Activity();
    private final BlockingQueue<Reply> replies = new LinkedBlockingQueue<>();
    private Bridge getBridge() { return bridge; }
    private Activity getActivity() { return activity; }
    private void capturePairIntent(Object ignored) {}
    private Prefs prefs() { return new Prefs(); }
    private boolean isOriginVerified(String id, String origin) { return id.equals("home-a") && origin.equals(ORIGIN); }
    private boolean hasStoredToken(String id, String origin) { return isOriginVerified(id, origin); }
    private void recordVerifiedOrigin(String id, String origin, String hostId, String grantId) {}
    private boolean matchesStoredHostId(String id, String host) {
        return id.equals("home-a") && (host == null || host.isEmpty() || host.equals("host-a"));
    }
    private String readPeerToken(String id, String origin) { return "fixture-peer-a"; }
    private HandshakeResult fetchHandshake(String origin, String serverId, String grantId) {
        return fetchHandshake(origin);
    }
    private HandshakeResult fetchHandshake(String origin, String serverId) {
        return fetchHandshake(origin);
    }
    private HandshakeResult fetchHandshake(String origin) {
        try {
            Reply r = replies.take();
            r.started.countDown();
            if (!r.release.await(5, TimeUnit.SECONDS)) throw new AssertionError("handshake release timeout");
            return new HandshakeResult(
                r.ok,
                r.redirected,
                r.statusCode,
                r.home,
                r.host,
                "fixture",
                r.mutualVerified,
                r.mutualRevoked,
                r.mutualDisabled,
                r.inboundEnabled
            );
        } catch (InterruptedException e) { throw new RuntimeException(e); }
    }
    private static class Reply {
        final CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        final boolean ok, redirected, mutualVerified, mutualRevoked, mutualDisabled, inboundEnabled;
        final int statusCode;
        final String home, host;
        Reply(String home, String host) {
            this(true, false, 200, home, host, true, false, false, true);
        }
        Reply(String home, String host, boolean mutualVerified) {
            this(true, false, 200, home, host, mutualVerified, false, false, true);
        }
        Reply(boolean ok, boolean redirected, int statusCode, String home, String host, boolean mutualVerified) {
            this(ok, redirected, statusCode, home, host, mutualVerified, false, false, true);
        }
        Reply(
            boolean ok,
            boolean redirected,
            int statusCode,
            String home,
            String host,
            boolean mutualVerified,
            boolean mutualRevoked,
            boolean mutualDisabled,
            boolean inboundEnabled
        ) {
            this.ok = ok;
            this.redirected = redirected;
            this.statusCode = statusCode;
            this.home = home;
            this.host = host;
            this.mutualVerified = mutualVerified;
            this.mutualRevoked = mutualRevoked;
            this.mutualDisabled = mutualDisabled;
            this.inboundEnabled = inboundEnabled;
        }
    }
    private static class WebView {
        volatile String url = ORIGIN + "/";
        volatile String documentId = "A-document";
        final BlockingQueue<Runnable> posted = new LinkedBlockingQueue<>();
        final List<String> deliveries = new ArrayList<>();
        final List<String> deliveredScripts = new ArrayList<>();
        volatile boolean backStarted;
        String getUrl() { return url; }
        void post(Runnable r) { posted.add(r); }
        void loadUrl(String next) { url = next; }
        boolean canGoBack() { return true; }
        WebBackForwardList copyBackForwardList() { return new WebBackForwardList(); }
        void goBack() { backStarted = true; }
        void evaluateJavascript(String script, Object ignored) {
            if (script.contains("__kikiShellStagedCredential")) {
                if (!script.contains("fixture-peer-a")) throw new AssertionError("wrong credential script");
                deliveries.add(documentId);
                deliveredScripts.add(script);
            }
        }
    }
    private static class Bridge {
        final WebView v;
        WebViewListener listener;
        Bridge(WebView v) { this.v = v; }
        String getLocalUrl() { return "https://localhost"; }
        WebView getWebView() { return v; }
        void removeWebViewListener(WebViewListener ignored) {
            if (this.listener == ignored) this.listener = null;
        }
        void addWebViewListener(WebViewListener listener) { this.listener = listener; }
    }
    private static abstract class WebViewListener {
        public void onPageStarted(WebView view) {}
        public void onPageCommitVisible(WebView view, String url) {}
        public void onPageLoaded(WebView view) {}
    }
    private static class Activity {
        final Dispatcher dispatcher = new Dispatcher();
        Object getIntent() { return null; }
        Dispatcher getOnBackPressedDispatcher() { return dispatcher; }
        void moveTaskToBack(boolean ignored) {}
    }
    private static class Dispatcher {
        OnBackPressedCallback back;
        void addCallback(Activity activity, OnBackPressedCallback callback) { back = callback; }
    }
    private static abstract class OnBackPressedCallback {
        OnBackPressedCallback(boolean ignored) {}
        public abstract void handleOnBackPressed();
    }
    private static class WebBackForwardList {
        int getCurrentIndex() { return 1; }
        WebHistoryItem getItemAtIndex(int index) { return new WebHistoryItem(ORIGIN + "/previous"); }
        WebHistoryItem getCurrentItem() { return new WebHistoryItem(ORIGIN + "/"); }
    }
    private static class WebHistoryItem {
        final String url;
        WebHistoryItem(String url) { this.url = url; }
        String getUrl() { return url; }
    }
    private static class Prefs {
        String getString(String k, String def) { return ORIGIN; }
        Editor edit() { return new Editor(); }
        static class Editor {
            Editor putString(String k, String v) { return this; }
            void apply() {}
        }
    }
    private static class JSObject {
        final Map<String, Object> data = new HashMap<>();
        JSObject put(String k, Object v) { data.put(k, v); return this; }
    }
    private static class PluginCall {
        final Map<String, String> params;
        final CompletableFuture<JSObject> resolved = new CompletableFuture<>();
        final CompletableFuture<String> rejected = new CompletableFuture<>();
        PluginCall(Map<String, String> params) { this.params = params; }
        String getString(String k) { return params.get(k); }
        void resolve(JSObject obj) { resolved.complete(obj); }
        void reject(String msg) { rejected.complete(msg); }
    }
    private static class Uri {
        final URI value;
        Uri(URI value) { this.value = value; }
        static Uri parse(String s) { return new Uri(URI.create(s)); }
        String getScheme() { return value.getScheme(); }
        String getHost() { return value.getHost(); }
        String getUserInfo() { return value.getUserInfo(); }
        int getPort() { return value.getPort(); }
        String getEncodedFragment() { return value.getRawFragment(); }
        String getQueryParameter(String name) { return null; }
        Set<String> getQueryParameterNames() { return Collections.emptySet(); }
        List<String> getQueryParameters(String name) { return Collections.emptyList(); }
        Builder buildUpon() { return new Builder(value); }
        public String toString() { return value.toString(); }
        static class Builder {
            final URI base;
            Builder(URI base) { this.base = base; }
            Builder encodedFragment(String f) { return this; }
            Builder clearQuery() { return this; }
            Builder appendQueryParameter(String k, String v) { return this; }
            Uri build() { return new Uri(base); }
        }
    }
    private static class JSONObject {
        static String quote(String s) { return "\\"" + s.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"") + "\\""; }
    }
    public static void main(String[] args) throws Exception {
        // Case 1: Delayed A handshake resolves AFTER same-origin replacement document B committed
        NativeDeliveryCheck p = new NativeDeliveryCheck();
        p.pendingAuthEpoch = 7;
        p.activeAuthOrigin = ORIGIN;
        p.activeAuthServerId = "home-a";
        Reply a = new Reply("home-a", "host-a");
        Reply b = new Reply("home-b", "host-b");
        p.replies.add(a);
        p.deliverCommittedToken(p.view, p.view.url, false);
        if (!a.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("A callback not started");
        p.shouldOverrideLoad(Uri.parse(ORIGIN + "/"));
        p.view.url = ORIGIN + "/";
        p.view.documentId = "B-document";
        p.replies.add(b);
        p.deliverCommittedToken(p.view, p.view.url, false);
        if (!b.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("B callback not started");
        a.release.countDown();
        Runnable staleDelivery = p.view.posted.poll(200, TimeUnit.MILLISECONDS);
        if (staleDelivery != null) staleDelivery.run();
        b.release.countDown();
        Runnable fallback = p.view.posted.poll(1, TimeUnit.SECONDS);
        if (fallback != null) fallback.run();
        if (p.view.deliveries.contains("B-document")) {
            throw new AssertionError("stale A handshake delivered A token into B document: " + p.view.deliveries);
        }

        // Case 2: Normal same-origin reload to valid Home A delivers credential into the reloaded document
        NativeDeliveryCheck p2 = new NativeDeliveryCheck();
        p2.pendingAuthEpoch = 8;
        p2.activeAuthOrigin = ORIGIN;
        p2.activeAuthServerId = "home-a";
        p2.view.documentId = "Reloaded-A-document";
        Reply a2 = new Reply("home-a", "host-a");
        p2.replies.add(a2);
        p2.deliverCommittedToken(p2.view, p2.view.url, false);
        if (!a2.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Reload A callback not started");
        a2.release.countDown();
        Runnable validDelivery = p2.view.posted.poll(5, TimeUnit.SECONDS);
        if (validDelivery == null) throw new AssertionError("Valid reload did not schedule delivery");
        validDelivery.run();
        if (!p2.view.deliveries.equals(Arrays.asList("Reloaded-A-document"))) {
            throw new AssertionError("Expected delivery to Reloaded-A-document, got: " + p2.view.deliveries);
        }

        // Case 3: Stale onPageLoaded failure from document A resolves after a same-URL reload commits;
        // it must neither kick the reloaded document to launcher nor clear activeAuthServerId, and the
        // reloaded document's own handshake must still succeed.
        NativeDeliveryCheck p3 = new NativeDeliveryCheck();
        p3.pendingAuthEpoch = 9;
        p3.activeAuthOrigin = ORIGIN;
        p3.activeAuthServerId = "home-a";
        Reply staleFailure = new Reply("home-temporary-mismatch", "host-other");
        p3.replies.add(staleFailure);
        p3.deliverCommittedToken(p3.view, p3.view.url, true);
        if (!staleFailure.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Stale A callback not started");
        p3.shouldOverrideLoad(Uri.parse(p3.view.url));
        staleFailure.release.countDown();
        Runnable oldFallback = p3.view.posted.poll(200, TimeUnit.MILLISECONDS);
        Reply reloadedValid = new Reply("home-a", "host-a");
        p3.replies.add(reloadedValid);
        p3.view.documentId = "Reloaded-After-Stale-Failure";
        p3.deliverCommittedToken(p3.view, p3.view.url, false);
        if (!reloadedValid.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Reloaded callback not started");
        if (oldFallback != null) oldFallback.run();
        if (!p3.view.url.equals(ORIGIN + "/")) {
            throw new AssertionError("old document failure kicked the committed reload back to launcher: " + p3.view.url);
        }
        if (!"home-a".equals(p3.activeAuthServerId)) {
            throw new AssertionError("old document failure cleared the reload's active pairing");
        }
        reloadedValid.release.countDown();
        Runnable reloadDelivery = p3.view.posted.poll(5, TimeUnit.SECONDS);
        if (reloadDelivery == null) throw new AssertionError("Reload after stale failure did not schedule delivery");
        reloadDelivery.run();
        if (!p3.view.deliveries.equals(Arrays.asList("Reloaded-After-Stale-Failure"))) {
            throw new AssertionError("Expected delivery to Reloaded-After-Stale-Failure, got: " + p3.view.deliveries);
        }

        // Case 4:Current document handshake mismatch (without any newer navigation) still clears activeAuth and redirects to launcher with #identity_mismatch
        NativeDeliveryCheck p4 = new NativeDeliveryCheck();
        p4.pendingAuthEpoch = 10;
        p4.activeAuthOrigin = ORIGIN;
        p4.activeAuthServerId = "home-a";
        Reply currentMismatch = new Reply("home-b", "host-b");
        p4.replies.add(currentMismatch);
        p4.deliverCommittedToken(p4.view, p4.view.url, false);
        if (!currentMismatch.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Current mismatch callback not started");
        currentMismatch.release.countDown();
        Runnable activeFallback = p4.view.posted.poll(5, TimeUnit.SECONDS);
        if (activeFallback == null) throw new AssertionError("Current mismatch did not schedule fallback");
        activeFallback.run();
        if (!"https://localhost/index.html#identity_mismatch".equals(p4.view.url)) {
            throw new AssertionError("Expected current mismatch to navigate to launcher #identity_mismatch, got: " + p4.view.url);
        }
        if (p4.activeAuthServerId != null) {
            throw new AssertionError("Expected current mismatch to clear activeAuthServerId");
        }

        // Case 5: Real system back (handleOnBackPressed -> goBack()) and onPageStarted before B commits;
        // stale A onPageLoaded failure must not cancel the in-progress same-origin history navigation
        NativeDeliveryCheck p5 = new NativeDeliveryCheck();
        p5.pendingAuthEpoch = 11;
        p5.activeAuthOrigin = ORIGIN;
        p5.activeAuthServerId = "home-a";
        p5.load();
        Reply staleBackMismatch = new Reply("home-temporary-mismatch", "host-other");
        p5.replies.add(staleBackMismatch);
        p5.bridge.listener.onPageLoaded(p5.view);
        if (!staleBackMismatch.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("A onPageLoaded callback not started");
        p5.activity.dispatcher.back.handleOnBackPressed();
        if (!p5.view.backStarted) throw new AssertionError("Production Android back callback did not call goBack()");
        p5.bridge.listener.onPageStarted(p5.view);
        staleBackMismatch.release.countDown();
        Runnable staleBackFallback = p5.view.posted.poll(200, TimeUnit.MILLISECONDS);
        if (staleBackFallback != null) staleBackFallback.run();
        if (!p5.view.url.equals(ORIGIN + "/") || !"home-a".equals(p5.activeAuthServerId)) {
            throw new AssertionError("old document failure cancelled the in-progress same-origin history navigation");
        }
        Reply backTargetValid = new Reply("home-a", "host-a");
        p5.replies.add(backTargetValid);
        p5.view.url = ORIGIN + "/previous";
        p5.view.documentId = "Previous-A-document";
        p5.bridge.listener.onPageCommitVisible(p5.view, p5.view.url);
        if (!backTargetValid.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Back target commit callback not started");
        backTargetValid.release.countDown();
        Runnable backDelivery = p5.view.posted.poll(5, TimeUnit.SECONDS);
        if (backDelivery == null) throw new AssertionError("Back target did not schedule delivery");
        backDelivery.run();
        if (!p5.view.deliveries.equals(Arrays.asList("Previous-A-document"))) {
            throw new AssertionError("Expected delivery to Previous-A-document, got: " + p5.view.deliveries);
        }

        // Case 6: Unverified mutual proof on Home A identity (home-a / host-a) without mutual proof;
        // deliverCommittedToken must reject it, clear activeAuthServerId, navigate to #unverified_handshake_proof (never claiming pairing_revoked), and deliver zero token
        NativeDeliveryCheck p6 = new NativeDeliveryCheck();
        p6.pendingAuthEpoch = 12;
        p6.activeAuthOrigin = ORIGIN;
        p6.activeAuthServerId = "home-a";
        p6.view.documentId = "Spoof-A-Without-Mutual-Proof";
        Reply spoofedIdentityNoProof = new Reply("home-a", "host-a", false);
        p6.replies.add(spoofedIdentityNoProof);
        p6.deliverCommittedToken(p6.view, p6.view.url, false);
        if (!spoofedIdentityNoProof.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Spoof callback not started");
        spoofedIdentityNoProof.release.countDown();
        Runnable spoofFallback = p6.view.posted.poll(5, TimeUnit.SECONDS);
        if (spoofFallback == null) throw new AssertionError("Unverified mutual proof did not schedule fallback");
        spoofFallback.run();
        if (!p6.view.deliveries.isEmpty()) {
            throw new AssertionError("Unverified mutual proof delivered token: " + p6.view.deliveries);
        }
        if (!"https://localhost/index.html#unverified_handshake_proof".equals(p6.view.url) || p6.activeAuthServerId != null) {
            throw new AssertionError("Unverified mutual proof did not clear activeAuth and navigate to #unverified_handshake_proof: " + p6.view.url);
        }

        // Case 6b: Authenticated revocation vs unverified 401/403 vs inbound disabled (401 HMAC & 200 JSON) vs real network outage (status 0 / 503)
        if (!"pairing_revoked".equals(classifyPairedHandshakeFailure(new HandshakeResult(true, false, 200, "home-a", "host-a", "", false, true, false, true), "home-a", true))) {
            throw new AssertionError("Expected 200 handshake with mutualRevokedVerified=true to classify as pairing_revoked");
        }
        if (!"pairing_revoked".equals(classifyPairedHandshakeFailure(new HandshakeResult(false, false, 401, "", "", "", false, true, false, true), "home-a", true))) {
            throw new AssertionError("Expected 401 handshake with mutualRevokedVerified=true to classify as pairing_revoked");
        }
        if (!"unverified_handshake_proof".equals(classifyPairedHandshakeFailure(new HandshakeResult(false, false, 401, "", "", "", false, false, false, true), "home-a", true))) {
            throw new AssertionError("Expected unverified 401 handshake (e.g. replacement server) to classify as unverified_handshake_proof");
        }
        if (!"unverified_handshake_proof".equals(classifyPairedHandshakeFailure(new HandshakeResult(false, false, 403, "", "", "", false, false, false, true), "home-a", true))) {
            throw new AssertionError("Expected unverified 403 handshake to classify as unverified_handshake_proof");
        }
        if (!"unreachable".equals(classifyPairedHandshakeFailure(new HandshakeResult(false, false, 401, "", "", "", false, false, true, false), "home-a", true))) {
            throw new AssertionError("Expected 401 handshake with mutualDisabledVerified=true to classify as unreachable");
        }
        if (!"unreachable".equals(classifyPairedHandshakeFailure(new HandshakeResult(true, false, 200, "home-a", "host-a", "", false, false, true, false), "home-a", true))) {
            throw new AssertionError("Expected 200 handshake with mutualDisabledVerified=true to classify as unreachable");
        }
        if (!"unreachable".equals(classifyPairedHandshakeFailure(new HandshakeResult(true, false, 200, "home-a", "host-a", "", false, false, false, false), "home-a", true))) {
            throw new AssertionError("Expected legacy 200 handshake with inboundEnabled=false (no HMAC proof) to classify as unreachable");
        }
        if (!"unreachable".equals(classifyPairedHandshakeFailure(new HandshakeResult(false, false, 503, "", "", "", false), "home-a", true))) {
            throw new AssertionError("Expected 503 handshake to classify as unreachable");
        }
        if (!"unreachable".equals(classifyPairedHandshakeFailure(new HandshakeResult(false, false, 0, "", "", "", false), "home-a", true))) {
            throw new AssertionError("Expected network failure (status 0) to classify as unreachable");
        }

        // Verify actual extracted probe(), open(), and deliverCommittedToken() across:
        // (1) public Web 401 with mutualDisabledVerified=true -> unreachable (preserves pairing, mutualDisabledVerified=true)
        // (2) legacy LAN 200 with inboundEnabled=false (no HMAC) -> unreachable (mutualDisabledVerified=false, inboundEnabled=false)
        // (3) unverified bare 401 -> unverified_handshake_proof (authRejected=false)
        // (4) authenticated 401 with mutualRevokedVerified=true -> pairing_revoked (authRejected=true)
        Map<String, String> pairedProbeParams = new HashMap<>();
        pairedProbeParams.put("origin", ORIGIN);
        pairedProbeParams.put("serverId", "home-a");
        pairedProbeParams.put("grantId", "grant-a");

        // (1) probe + open + deliverCommittedToken on 401 with mutualDisabledVerified=true
        Reply probeWebDisabledReply = new Reply(false, false, 401, "", "", false, false, true, false);
        p6.replies.add(probeWebDisabledReply);
        PluginCall probeWebDisabledCall = new PluginCall(pairedProbeParams);
        p6.probe(probeWebDisabledCall);
        if (!probeWebDisabledReply.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("probeWebDisabled not started");
        probeWebDisabledReply.release.countDown();
        JSObject probeWebDisabledRes = probeWebDisabledCall.resolved.get(5, TimeUnit.SECONDS);
        if (!Boolean.FALSE.equals(probeWebDisabledRes.data.get("ok")) ||
            !"unreachable".equals(probeWebDisabledRes.data.get("reason")) ||
            !Boolean.TRUE.equals(probeWebDisabledRes.data.get("mutualDisabledVerified")) ||
            !Boolean.FALSE.equals(probeWebDisabledRes.data.get("inboundEnabled")) ||
            Boolean.TRUE.equals(probeWebDisabledRes.data.get("authRejected"))) {
            throw new AssertionError("Expected 401 mutualDisabled probe to resolve unreachable with mutualDisabledVerified=true, got: " + probeWebDisabledRes.data);
        }

        Map<String, String> openParams = new HashMap<>(pairedProbeParams);
        openParams.put("entry", ORIGIN + "/");
        Reply openWebDisabledReply = new Reply(false, false, 401, "", "", false, false, true, false);
        p6.replies.add(openWebDisabledReply);
        PluginCall openWebDisabledCall = new PluginCall(openParams);
        p6.open(openWebDisabledCall);
        if (!openWebDisabledReply.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("openWebDisabled not started");
        openWebDisabledReply.release.countDown();
        JSObject openWebDisabledRes = openWebDisabledCall.resolved.get(5, TimeUnit.SECONDS);
        if (!Boolean.FALSE.equals(openWebDisabledRes.data.get("ok")) || !"unreachable".equals(openWebDisabledRes.data.get("reason"))) {
            throw new AssertionError("Expected 401 mutualDisabled open to resolve unreachable, got: " + openWebDisabledRes.data);
        }

        NativeDeliveryCheck p6WebDisabledDoc = new NativeDeliveryCheck();
        p6WebDisabledDoc.pendingAuthEpoch = 15;
        p6WebDisabledDoc.activeAuthOrigin = ORIGIN;
        p6WebDisabledDoc.activeAuthServerId = "home-a";
        Reply docWebDisabledReply = new Reply(false, false, 401, "", "", false, false, true, false);
        p6WebDisabledDoc.replies.add(docWebDisabledReply);
        p6WebDisabledDoc.deliverCommittedToken(p6WebDisabledDoc.view, p6WebDisabledDoc.view.url, false);
        if (!docWebDisabledReply.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("docWebDisabled not started");
        docWebDisabledReply.release.countDown();
        Runnable docWebDisabledFallback = p6WebDisabledDoc.view.posted.poll(5, TimeUnit.SECONDS);
        if (docWebDisabledFallback == null) throw new AssertionError("docWebDisabled did not schedule fallback");
        docWebDisabledFallback.run();
        if (!"https://localhost/index.html#unreachable".equals(p6WebDisabledDoc.view.url)) {
            throw new AssertionError("Expected 401 mutualDisabled document delivery to navigate to #unreachable, got: " + p6WebDisabledDoc.view.url);
        }

        // (2) probe on legacy LAN 200 with inboundEnabled=false and no HMAC proof: must be unreachable, mutualDisabledVerified=false
        Reply probeLanLegacyDisabledReply = new Reply(true, false, 200, "home-a", "host-a", false, false, false, false);
        p6.replies.add(probeLanLegacyDisabledReply);
        PluginCall probeLanLegacyDisabledCall = new PluginCall(pairedProbeParams);
        p6.probe(probeLanLegacyDisabledCall);
        if (!probeLanLegacyDisabledReply.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("probeLanLegacyDisabled not started");
        probeLanLegacyDisabledReply.release.countDown();
        JSObject probeLanLegacyDisabledRes = probeLanLegacyDisabledCall.resolved.get(5, TimeUnit.SECONDS);
        if (!Boolean.FALSE.equals(probeLanLegacyDisabledRes.data.get("ok")) ||
            !"unreachable".equals(probeLanLegacyDisabledRes.data.get("reason")) ||
            !Boolean.FALSE.equals(probeLanLegacyDisabledRes.data.get("mutualDisabledVerified")) ||
            !Boolean.FALSE.equals(probeLanLegacyDisabledRes.data.get("inboundEnabled"))) {
            throw new AssertionError("Expected legacy LAN 200 inboundEnabled=false without HMAC to keep mutualDisabledVerified=false and reason=unreachable, got: " + probeLanLegacyDisabledRes.data);
        }

        // (3) probe on unverified bare 401 -> unverified_handshake_proof (authRejected=false)
        Reply probeBare401Reply = new Reply(false, false, 401, "", "", false, false, false, true);
        p6.replies.add(probeBare401Reply);
        PluginCall probeBare401Call = new PluginCall(pairedProbeParams);
        p6.probe(probeBare401Call);
        if (!probeBare401Reply.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("probeBare401 not started");
        probeBare401Reply.release.countDown();
        JSObject probeBare401Res = probeBare401Call.resolved.get(5, TimeUnit.SECONDS);
        if (!Boolean.FALSE.equals(probeBare401Res.data.get("ok")) ||
            !"unverified_handshake_proof".equals(probeBare401Res.data.get("reason")) ||
            Boolean.TRUE.equals(probeBare401Res.data.get("authRejected")) ||
            Boolean.TRUE.equals(probeBare401Res.data.get("mutualRevokedVerified"))) {
            throw new AssertionError("Expected bare 401 probe to resolve unverified_handshake_proof, got: " + probeBare401Res.data);
        }

        // (4) probe on authenticated 401 with mutualRevokedVerified=true -> pairing_revoked (authRejected=true)
        Reply probeRevoked401Reply = new Reply(false, false, 401, "", "", false, true, false, true);
        p6.replies.add(probeRevoked401Reply);
        PluginCall probeRevoked401Call = new PluginCall(pairedProbeParams);
        p6.probe(probeRevoked401Call);
        if (!probeRevoked401Reply.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("probeRevoked401 not started");
        probeRevoked401Reply.release.countDown();
        JSObject probeRevoked401Res = probeRevoked401Call.resolved.get(5, TimeUnit.SECONDS);
        if (!Boolean.FALSE.equals(probeRevoked401Res.data.get("ok")) ||
            !"pairing_revoked".equals(probeRevoked401Res.data.get("reason")) ||
            !Boolean.TRUE.equals(probeRevoked401Res.data.get("authRejected")) ||
            !Boolean.TRUE.equals(probeRevoked401Res.data.get("mutualRevokedVerified"))) {
            throw new AssertionError("Expected authenticated 401 probe to resolve pairing_revoked, got: " + probeRevoked401Res.data);
        }
        NativeDeliveryCheck p6Outage = new NativeDeliveryCheck();
        p6Outage.pendingAuthEpoch = 14;
        p6Outage.activeAuthOrigin = ORIGIN;
        p6Outage.activeAuthServerId = "home-a";
        Reply outageReply = new Reply(false, false, 0, "", "", false);
        p6Outage.replies.add(outageReply);
        p6Outage.deliverCommittedToken(p6Outage.view, p6Outage.view.url, false);
        if (!outageReply.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Outage callback not started");
        outageReply.release.countDown();
        Runnable outageFallback = p6Outage.view.posted.poll(5, TimeUnit.SECONDS);
        if (outageFallback == null) throw new AssertionError("Outage did not schedule fallback");
        outageFallback.run();
        if (!"https://localhost/index.html#unreachable".equals(p6Outage.view.url) || p6Outage.activeAuthServerId != null) {
            throw new AssertionError("Expected network outage to navigate to #unreachable, got: " + p6Outage.view.url);
        }

        // Case 7: Actual Java crypto helpers (sha256Hex, hmacSha256Hex, generateHandshakeNonce, constantTimeEquals)
        String keyHex = sha256Hex("fixture-peer-a");
        if (keyHex == null || keyHex.length() != 64) throw new AssertionError("Invalid sha256Hex");
        String nonce1 = generateHandshakeNonce();
        String nonce2 = generateHandshakeNonce();
        if (nonce1.length() != 32 || nonce1.equals(nonce2)) throw new AssertionError("Invalid nonce generation");
        String reqProof1 = hmacSha256Hex(keyHex, "kiki-handshake-req-v1:" + nonce1);
        String resProof1 = hmacSha256Hex(keyHex, "kiki-handshake-res-v1:" + nonce1 + ":home-a:host-a");
        String resProof2 = hmacSha256Hex(keyHex, "kiki-handshake-res-v1:" + nonce2 + ":home-a:host-a");
        if (reqProof1 == null || resProof1 == null || reqProof1.equals(resProof1)) {
            throw new AssertionError("Domain separation failed between req and res HMAC");
        }
        if (!constantTimeEquals(resProof1, resProof1.toUpperCase())) {
            throw new AssertionError("Expected constantTimeEquals to match valid response proof");
        }
        if (constantTimeEquals(resProof1, resProof2)) {
            throw new AssertionError("Replayed response proof from nonce1 matched nonce2");
        }

        // Case 8: Capacitor Bridge.Builder.create() overwrites bridge.webViewListeners after plugin.load();
        // ensureWebViewListenersRegistered() restores the listener so onPageCommitVisible / onPageLoaded
        // deliver the peer credential, and buildCredentialDeliveryScript guards duplicate same-nonce delivery.
        NativeDeliveryCheck p8 = new NativeDeliveryCheck();
        p8.pendingAuthEpoch = 13;
        p8.activeAuthOrigin = ORIGIN;
        p8.activeAuthServerId = "home-a";
        p8.load();
        if (p8.bridge.listener == null) throw new AssertionError("Expected load() to register WebViewListener");
        p8.bridge.listener = null; // Simulate Bridge.Builder.create() calling bridge.setWebViewListeners(emptyList)
        p8.ensureWebViewListenersRegistered();
        if (p8.bridge.listener == null) throw new AssertionError("Expected ensureWebViewListenersRegistered() to restore clobbered WebViewListener");
        p8.view.documentId = "Restored-Listener-Document";
        Reply restoredCommit = new Reply("home-a", "host-a");
        p8.replies.add(restoredCommit);
        p8.bridge.listener.onPageCommitVisible(p8.view, p8.view.url);
        if (!restoredCommit.started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Restored listener onPageCommitVisible did not start handshake");
        restoredCommit.release.countDown();
        Runnable restoredDelivery = p8.view.posted.poll(5, TimeUnit.SECONDS);
        if (restoredDelivery == null) throw new AssertionError("Restored listener did not schedule credential delivery");
        restoredDelivery.run();
        if (!p8.view.deliveries.equals(Arrays.asList("Restored-Listener-Document"))) {
            throw new AssertionError("Expected restored listener to deliver credential, got: " + p8.view.deliveries);
        }
        String deliveredScript = p8.view.deliveredScripts.get(0);
        if (!deliveredScript.contains("__kikiShellDeliveredNonce===n") || !deliveredScript.contains("__kikiShellDeliveredNonce=n")) {
            throw new AssertionError("Expected buildCredentialDeliveryScript to guard duplicate same-nonce delivery: " + deliveredScript);
        }

        // Case 9: Native open() enters async fetchHandshake -> user switches computer (cancelOpen with opId) ->
        // old handshake succeeds but MUST NOT loadUrl or overwrite activeAuth, and subsequent new open() succeeds normally.
        NativeDeliveryCheck p9 = new NativeDeliveryCheck();
        p9.view.url = "https://localhost/index.html";
        p9.activeAuthOrigin = "http://192.168.1.99:5494";
        p9.activeAuthServerId = "home-existing";
        Reply inFlightOpenHandshake = new Reply("home-a", "host-a");
        p9.replies.add(inFlightOpenHandshake);
        Map<String, String> open1Params = new HashMap<>();
        open1Params.put("opId", "op-auto-1");
        open1Params.put("origin", ORIGIN);
        open1Params.put("entry", ORIGIN + "/");
        open1Params.put("serverId", "home-a");
        open1Params.put("grantId", "grant-a");
        PluginCall open1Call = new PluginCall(open1Params);
        p9.open(open1Call);
        if (!inFlightOpenHandshake.started.await(5, TimeUnit.SECONDS)) {
            throw new AssertionError("Native open(op-auto-1) did not start fetchHandshake");
        }
        // User clicks Switch computer while native open handshake is in flight -> cancelOpen("op-auto-1")
        Map<String, String> cancelParams = new HashMap<>();
        cancelParams.put("opId", "op-auto-1");
        PluginCall cancelCall = new PluginCall(cancelParams);
        p9.cancelOpen(cancelCall);
        JSObject cancelRes = cancelCall.resolved.get(5, TimeUnit.SECONDS);
        if (!Boolean.TRUE.equals(cancelRes.data.get("cancelled"))) {
            throw new AssertionError("Expected cancelOpen(op-auto-1) to cancel uncommitted open");
        }
        // Release the old handshake with a valid 200 mutual-verified response
        inFlightOpenHandshake.release.countDown();
        JSObject open1Res = open1Call.resolved.get(5, TimeUnit.SECONDS);
        if (!Boolean.FALSE.equals(open1Res.data.get("ok")) || !"aborted".equals(open1Res.data.get("reason"))) {
            throw new AssertionError("Expected cancelled open1 to resolve with reason=aborted, got: " + open1Res.data);
        }
        Runnable unexpectedPost = p9.view.posted.poll(200, TimeUnit.MILLISECONDS);
        if (unexpectedPost != null) unexpectedPost.run();
        if (!"https://localhost/index.html".equals(p9.view.url)) {
            throw new AssertionError("Cancelled native open still called loadUrl: " + p9.view.url);
        }
        if (!"home-existing".equals(p9.activeAuthServerId)) {
            throw new AssertionError("Cancelled native open clobbered existing activeAuthServerId: " + p9.activeAuthServerId);
        }

        // Subsequent new open("op-new-2") succeeds normally and loads the target entry
        Reply nextOpenHandshake = new Reply("home-a", "host-a");
        p9.replies.add(nextOpenHandshake);
        Map<String, String> open2Params = new HashMap<>();
        open2Params.put("opId", "op-new-2");
        open2Params.put("origin", ORIGIN);
        open2Params.put("entry", ORIGIN + "/");
        open2Params.put("serverId", "home-a");
        open2Params.put("grantId", "grant-a");
        PluginCall open2Call = new PluginCall(open2Params);
        p9.open(open2Call);
        if (!nextOpenHandshake.started.await(5, TimeUnit.SECONDS)) {
            throw new AssertionError("Subsequent open(op-new-2) did not start fetchHandshake");
        }
        // Cancelling with a stale opId ("op-auto-1") must NOT affect the new open ("op-new-2")
        PluginCall staleCancelCall = new PluginCall(cancelParams);
        p9.cancelOpen(staleCancelCall);
        if (Boolean.TRUE.equals(staleCancelCall.resolved.get(5, TimeUnit.SECONDS).data.get("cancelled"))) {
            throw new AssertionError("Stale opId cancelled the newer open");
        }
        nextOpenHandshake.release.countDown();
        Runnable loadPost = p9.view.posted.poll(5, TimeUnit.SECONDS);
        if (loadPost == null) throw new AssertionError("Subsequent open did not post loadUrl");
        loadPost.run();
        JSObject open2Res = open2Call.resolved.get(5, TimeUnit.SECONDS);
        if (!Boolean.TRUE.equals(open2Res.data.get("ok")) || !(ORIGIN + "/").equals(p9.view.url)) {
            throw new AssertionError("Subsequent open did not load expected URL: " + p9.view.url);
        }
        // Once committed, cancelOpen("op-new-2") returns false and preserves the established connection
        Map<String, String> postCommitCancelParams = new HashMap<>();
        postCommitCancelParams.put("opId", "op-new-2");
        PluginCall postCommitCancelCall = new PluginCall(postCommitCancelParams);
        p9.cancelOpen(postCommitCancelCall);
        if (Boolean.TRUE.equals(postCommitCancelCall.resolved.get(5, TimeUnit.SECONDS).data.get("cancelled")) || !"home-a".equals(p9.activeAuthServerId)) {
            throw new AssertionError("cancelOpen after commit must not revoke established connection");
        }
    }
}
`;
    const javaFile = join(tempDir, 'NativeDeliveryCheck.java');
    writeFileSync(javaFile, javaSource);
    const javaHome = process.env.JAVA_HOME ?? '';
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    const javaHomeJavac = javaHome ? join(javaHome, 'bin', `javac${exeSuffix}`) : '';
    const javaHomeJava = javaHome ? join(javaHome, 'bin', `java${exeSuffix}`) : '';
    const javacBin = javaHomeJavac && existsSync(javaHomeJavac)
      ? javaHomeJavac
      : existsSync('C:/Program Files/Android/Android Studio/jbr/bin/javac.exe')
        ? 'C:/Program Files/Android/Android Studio/jbr/bin/javac.exe'
        : 'javac';
    const javaBin = javaHomeJava && existsSync(javaHomeJava)
      ? javaHomeJava
      : existsSync('C:/Program Files/Android/Android Studio/jbr/bin/java.exe')
        ? 'C:/Program Files/Android/Android Studio/jbr/bin/java.exe'
        : 'java';
    const compiled = spawnSync(javacBin, ['-d', tempDir, javaFile], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, `javac failed: ${compiled.stderr}`);
    const ran = spawnSync(javaBin, ['-cp', tempDir, 'NativeDeliveryCheck'], { encoding: 'utf8' });
    assert.equal(ran.status, 0, `java failed: ${ran.stderr || ran.stdout}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

await test('public Web listener (anonymous handshake 401) pairs via short code and opens/reopens with mutual nonce-bound HMAC proof while leaking zero bearer token or digest to a same-origin replacement server (including identity spoof + replay)', async () => {
  const { createHash, createHmac } = await import('node:crypto');
  const identityA = {
    homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    hostId: 'public-web-host-a',
    protocol: 1,
  };
  const identityB = {
    homeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    hostId: 'public-web-host-b',
    protocol: 1,
  };
  const peerTokenA = 'peer-secret-token-for-public-web-listener-a';
  const expectedDigestA = createHash('sha256').update(peerTokenA).digest('hex');

  let activeServer = 'A';
  let grantRevoked = false;
  let capturedValidResponseProof = '';
  const requestsToB = [];
  const webListener = createServer((req, res) => {
    const authHeader = req.headers.authorization ?? '';
    const nonceHeader = String(req.headers['x-kiki-handshake-nonce'] ?? '').trim().toLowerCase();
    const proofHeader = String(req.headers['x-kiki-handshake-proof'] ?? '').trim().toLowerCase();
    const grantHeader = String(req.headers['x-kiki-handshake-grant'] ?? '').trim();
    if (activeServer.startsWith('B')) {
      requestsToB.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        authorization: authHeader,
        nonce: nonceHeader,
        proof: proofHeader,
        grant: grantHeader,
      });
    }
    if (req.method === 'POST' && req.url === '/api/remote-connections/pair/claim') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (activeServer === 'A' && (body.code === '2345-6789' || body.code === '6789-2345')) {
          grantRevoked = false;
          const isRepair = body.code === '6789-2345';
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              code: 0,
              data: {
                target: identityA,
                targetLabel: 'Studio Public Web',
                grantId: isRepair ? 'grant-web-a-v2' : 'grant-web-a',
                revision: isRepair ? 2 : 1,
                peerToken: peerTokenA,
              },
            }),
          );
          return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 40101, msg: 'invalid_pairing_code' }));
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/remote-connections/handshake') {
      if (activeServer === 'A') {
        if (/^[a-f0-9]{32,128}$/.test(nonceHeader) && /^[a-f0-9]{64}$/.test(proofHeader)) {
          const expectedReqProof = createHmac('sha256', expectedDigestA)
            .update(`kiki-handshake-req-v1:${nonceHeader}`)
            .digest('hex');
          if (
            proofHeader === expectedReqProof &&
            (!grantHeader || grantHeader === 'grant-web-a' || grantHeader === 'grant-web-a-v2')
          ) {
            if (grantRevoked) {
              const revokedProof = createHmac('sha256', expectedDigestA)
                .update(`kiki-handshake-revoked-v1:${nonceHeader}:${identityA.homeId}:${identityA.hostId}`)
                .digest('hex');
              res.writeHead(401, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'x-kiki-handshake-proof': revokedProof,
                'x-kiki-handshake-status': 'revoked',
              });
              res.end(JSON.stringify({ code: 40101, msg: 'web_session_required' }));
              return;
            }
            const resProof = createHmac('sha256', expectedDigestA)
              .update(`kiki-handshake-res-v1:${nonceHeader}:${identityA.homeId}:${identityA.hostId}`)
              .digest('hex');
            capturedValidResponseProof = resProof;
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'x-kiki-handshake-proof': resProof,
              'x-kiki-handshake-status': 'approved',
            });
            res.end(
              JSON.stringify({
                code: 0,
                data: {
                  identity: identityA,
                  serverId: 'srv-web-a',
                  inboundEnabled: true,
                },
              }),
            );
            return;
          }
        }
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 40101, msg: 'web_session_required' }));
        return;
      }
      if (activeServer === 'A-direct-revoked') {
        const expectedReqProof = createHmac('sha256', expectedDigestA)
          .update(`kiki-handshake-req-v1:${nonceHeader}`)
          .digest('hex');
        const revokedProof =
          proofHeader === expectedReqProof
            ? createHmac('sha256', expectedDigestA)
                .update(`kiki-handshake-revoked-v1:${nonceHeader}:${identityA.homeId}:${identityA.hostId}`)
                .digest('hex')
            : '';
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(revokedProof
            ? {
                'x-kiki-handshake-proof': revokedProof,
                'x-kiki-handshake-status': 'revoked',
              }
            : {}),
        });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: identityA,
              serverId: 'srv-web-a',
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      if (activeServer === 'A-web-disabled') {
        const expectedReqProof = createHmac('sha256', expectedDigestA)
          .update(`kiki-handshake-req-v1:${nonceHeader}`)
          .digest('hex');
        const disabledProof =
          proofHeader === expectedReqProof
            ? createHmac('sha256', expectedDigestA)
                .update(`kiki-handshake-disabled-v1:${nonceHeader}:${identityA.homeId}:${identityA.hostId}`)
                .digest('hex')
            : '';
        res.writeHead(401, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(disabledProof
            ? {
                'x-kiki-handshake-proof': disabledProof,
                'x-kiki-handshake-status': 'inbound_disabled',
              }
            : {}),
        });
        res.end(JSON.stringify({ code: 40101, msg: 'web_session_required' }));
        return;
      }
      if (activeServer === 'A-direct-disabled') {
        const expectedReqProof = createHmac('sha256', expectedDigestA)
          .update(`kiki-handshake-req-v1:${nonceHeader}`)
          .digest('hex');
        const disabledProof =
          proofHeader === expectedReqProof
            ? createHmac('sha256', expectedDigestA)
                .update(`kiki-handshake-disabled-v1:${nonceHeader}:${identityA.homeId}:${identityA.hostId}`)
                .digest('hex')
            : '';
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(disabledProof
            ? {
                'x-kiki-handshake-proof': disabledProof,
                'x-kiki-handshake-status': 'inbound_disabled',
              }
            : {}),
        });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: identityA,
              serverId: 'srv-web-a',
              inboundEnabled: false,
            },
          }),
        );
        return;
      }
      if (activeServer === 'A-legacy-disabled-no-proof') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: identityA,
              serverId: 'srv-web-a',
              inboundEnabled: false,
            },
          }),
        );
        return;
      }
      if (activeServer === 'A-unverified-200') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: identityA,
              serverId: 'srv-web-a',
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      if (activeServer === 'A-outage') {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 50300, msg: 'service_unavailable' }));
        return;
      }
      if (activeServer === 'B-echo-digest') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: identityB,
              serverId: 'srv-web-b',
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      if (activeServer === 'B-spoof-identity-and-replay') {
        // Replacement server B knows A's non-secret identityA and replays a previously captured
        // valid x-kiki-handshake-proof header from an earlier session with A:
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'x-kiki-handshake-proof': capturedValidResponseProof,
        });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              identity: identityA,
              serverId: 'srv-web-a',
              inboundEnabled: true,
            },
          }),
        );
        return;
      }
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 40101, msg: 'web_session_required' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/meta') {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 40101, msg: 'web_session_required' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>public web gui</body></html>');
  });

  await new Promise((r) => {
    webListener.listen(0, '127.0.0.1', r);
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const publicOrigin = `http://127.0.0.1:${webListener.address().port}`;
    const storage = createMemoryStorage();
    const nativeTokenVault = new Map();
    const tokenReadEvents = [];
    const saveToken = (serverId, token, origin) => {
      nativeTokenVault.set(`${serverId}@${origin}`, token);
      nativeTokenVault.set(serverId, token);
    };
    const getToken = async (serverId, origin) => {
      tokenReadEvents.push({ serverId, origin, activeServer });
      return nativeTokenVault.get(`${serverId}@${origin}`) ?? nativeTokenVault.get(serverId) ?? null;
    };

    // 1. Anonymous handshake on the public Web listener returns 401 (no identity exposed to unauthenticated scanners)
    const anonProbe = await probeOriginHandshake(publicOrigin);
    assert.equal(anonProbe.ok, true);
    assert.equal(anonProbe.targetHomeId, undefined);

    // 2. Pairing with short code 2345-6789 and immediately opening succeeds using mutual HMAC handshake proof
    const page = await browser.newPage();
    const pairAndOpen = await openVerifiedServerNavigation(
      page,
      storage,
      {
        origin: publicOrigin,
        code: '2345-6789',
        platform: 'android',
        requireMutualProof: true,
        saveToken,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(pairAndOpen.ok, true);
    assert.equal(pairAndOpen.tokenDelivered, true);
    assert.equal(capturedValidResponseProof.length, 64);
    assert.deepEqual(
      await page.evaluate(() => window.document.__kikiShellStagedCredential),
      { origin: publicOrigin, token: peerTokenA },
    );

    // 3. Re-opening the saved computer succeeds using mutual HMAC challenge without sending expectedDigestA or peerTokenA on the wire
    const keyForA = await computeHandshakeProof(peerTokenA);
    assert.equal(keyForA, expectedDigestA);
    const ch1 = await createMutualHandshakeChallenge({ handshakeKey: keyForA, grantId: 'grant-web-a' });
    const ch2 = await createMutualHandshakeChallenge({ handshakeKey: keyForA, grantId: 'grant-web-a' });
    assert.notEqual(ch1.nonce, ch2.nonce);
    assert.notEqual(ch1.requestProof, ch2.requestProof);
    assert.notEqual(ch1.requestProof, expectedDigestA);

    const reopenSaved = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(reopenSaved.ok, true);
    assert.equal(reopenSaved.tokenDelivered, true);

    // 4. If the same public origin is replaced by another server B (unverified 401 on unknown proof), open refuses as unverified_handshake_proof (never falsely claiming pairing_revoked) and leaks neither bearer token nor grant.digest
    activeServer = 'B';
    requestsToB.length = 0;
    const readsBeforeB = tokenReadEvents.length;
    const blockedOnB = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(blockedOnB.ok, false);
    assert.equal(blockedOnB.reason, 'unverified_handshake_proof');
    assert.equal(blockedOnB.tokenDelivered, false);
    assert.equal(tokenReadEvents.length, readsBeforeB, 'peerToken must not be read when pre-open handshake fails');
    for (const req of requestsToB) {
      assert.equal(req.authorization, '');
      assert.equal(req.url.includes(peerTokenA), false);
      assert.notEqual(req.proof, peerTokenA);
      assert.notEqual(req.proof, expectedDigestA, 'static grant.digest must never be sent over the network');
    }

    // 5. Counterexample: Replacement server B echoes A's exact non-secret identity (homeId/hostId) AND replays
    // a previously captured valid response proof from A. Both pre-open and post-commit mutual verification
    // must reject it (fresh nonce mismatch) and deliver zero token!
    activeServer = 'B-spoof-identity-and-replay';
    requestsToB.length = 0;
    const spoofedReplayPreOpen = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(spoofedReplayPreOpen.ok, false);
    assert.equal(spoofedReplayPreOpen.reason, 'unverified_handshake_proof');
    assert.equal(spoofedReplayPreOpen.tokenDelivered, false);
    assert.equal(tokenReadEvents.length, readsBeforeB, 'peerToken must not be read when B replays stale proof with A identity');

    // Even if A answered pre-open and B took over right as the WebView committed a fresh document (mid-navigation swap to B):
    await page.goto(reopenSaved.finalEntry);
    const midFlightSpoofCommit = await deliverCommittedServerCredential(page, reopenSaved, {
      requireMutualProof: true,
    });
    assert.equal(midFlightSpoofCommit.ok, false);
    assert.equal(midFlightSpoofCommit.reason, 'unverified_handshake_proof');
    assert.equal(midFlightSpoofCommit.tokenDelivered, false);
    assert.equal(await page.evaluate(() => window.document.__kikiShellStagedCredential ?? null), null);
    for (const req of requestsToB) {
      assert.equal(req.authorization, '');
      assert.notEqual(req.proof, expectedDigestA);
      assert.notEqual(req.proof, peerTokenA);
    }

    // 6. Revoking the grant on A (401 on public web listener, or 200 without mutual proof on direct port)
    // immediately surfaces pairing_revoked without leaking token, while real 503 outage remains unreachable:
    activeServer = 'A';
    grantRevoked = true;
    const afterRevoke = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(afterRevoke.ok, false);
    assert.equal(afterRevoke.reason, 'pairing_revoked');
    assert.equal(afterRevoke.tokenDelivered, false);

    activeServer = 'A-direct-revoked';
    const afterDirectRevoke = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(afterDirectRevoke.ok, false);
    assert.equal(afterDirectRevoke.reason, 'pairing_revoked');
    assert.equal(afterDirectRevoke.tokenDelivered, false);

    activeServer = 'A-web-disabled';
    const webDisabledProbe = await probeOriginHandshake(publicOrigin, {
      handshakeKey: keyForA,
      grantId: 'grant-web-a',
      targetHomeId: identityA.homeId,
      targetHostId: identityA.hostId,
      requireMutualProof: true,
    });
    assert.equal(webDisabledProbe.ok, false);
    assert.equal(webDisabledProbe.reason, 'unreachable');
    assert.equal(webDisabledProbe.mutualDisabledVerified, true);
    assert.equal(webDisabledProbe.inboundEnabled, false);
    const afterWebDisabled = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(afterWebDisabled.ok, false);
    assert.equal(afterWebDisabled.reason, 'unreachable');
    assert.equal(afterWebDisabled.tokenDelivered, false);

    activeServer = 'A-direct-disabled';
    const directDisabledProbe = await probeOriginHandshake(publicOrigin, {
      handshakeKey: keyForA,
      grantId: 'grant-web-a',
      targetHomeId: identityA.homeId,
      targetHostId: identityA.hostId,
      requireMutualProof: true,
    });
    assert.equal(directDisabledProbe.ok, false);
    assert.equal(directDisabledProbe.reason, 'unreachable');
    assert.equal(directDisabledProbe.mutualDisabledVerified, true);
    assert.equal(directDisabledProbe.inboundEnabled, false);
    const afterDirectDisabled = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(afterDirectDisabled.ok, false);
    assert.equal(afterDirectDisabled.reason, 'unreachable');
    assert.equal(afterDirectDisabled.tokenDelivered, false);

    activeServer = 'A-legacy-disabled-no-proof';
    const legacyDisabledProbe = await probeOriginHandshake(publicOrigin, {
      handshakeKey: keyForA,
      grantId: 'grant-web-a',
      targetHomeId: identityA.homeId,
      targetHostId: identityA.hostId,
      requireMutualProof: true,
    });
    assert.equal(legacyDisabledProbe.ok, false);
    assert.equal(legacyDisabledProbe.reason, 'unreachable');
    assert.equal(legacyDisabledProbe.mutualDisabledVerified, false);
    assert.equal(legacyDisabledProbe.inboundEnabled, false);
    const afterLegacyDisabled = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(afterLegacyDisabled.ok, false);
    assert.equal(afterLegacyDisabled.reason, 'unreachable');
    assert.equal(afterLegacyDisabled.tokenDelivered, false);

    activeServer = 'A-unverified-200';
    const afterUnverified200 = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(afterUnverified200.ok, false);
    assert.equal(afterUnverified200.reason, 'unverified_handshake_proof');
    assert.equal(afterUnverified200.tokenDelivered, false);

    activeServer = 'A-outage';
    const duringOutage = await openVerifiedServerNavigation(
      page,
      storage,
      {
        serverId: identityA.homeId,
        origin: publicOrigin,
        paired: true,
        targetHomeId: identityA.homeId,
        targetHostId: identityA.hostId,
        grantId: 'grant-web-a',
        handshakeKey: keyForA,
        requireMutualProof: true,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(duringOutage.ok, false);
    assert.equal(duringOutage.reason, 'unreachable');
    assert.equal(duringOutage.tokenDelivered, false);

    // 7. Re-pairing with a fresh short code 6789-2345 restores mutual proof and re-opens cleanly:
    activeServer = 'A';
    const repairedAndOpened = await openVerifiedServerNavigation(
      page,
      storage,
      {
        origin: publicOrigin,
        code: '6789-2345',
        platform: 'android',
        requireMutualProof: true,
        saveToken,
        getToken,
      },
      { requireMutualProof: true },
    );
    assert.equal(repairedAndOpened.ok, true);
    assert.equal(repairedAndOpened.tokenDelivered, true);
    assert.equal(repairedAndOpened.server.grantId, 'grant-web-a-v2');
  } finally {
    await browser.close();
    webListener.close();
  }
});

await test('launcher Connect screen defaults to a centered scan-first hierarchy with quiet manual disclosure and auto-expands on fallback, error, and incoming pair flows', async () => {
  const launcherRoot = resolve(import.meta.dirname, '../launcher');
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.woff2': 'font/woff2',
  };
  const launcherServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const relPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = resolve(launcherRoot, `.${relPath}`);
    if (!safePath.startsWith(launcherRoot) || !existsSync(safePath)) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = safePath.slice(safePath.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(safePath));
  });
  await new Promise((r) => {
    launcherServer.listen(0, '127.0.0.1', r);
  });
  const launcherBaseUrl = `http://127.0.0.1:${launcherServer.address().port}`;
  const proofDir = process.env.KIKI_MOBILE_PROOF_DIR ?? '';
  if (proofDir) {
    mkdirSync(proofDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  try {
    // 1. Default collapsed state + manual disclosure in light/zh at 390x844 phone width
    const zhCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      colorScheme: 'light',
      deviceScaleFactor: 2,
    });
    try {
      const page = await zhCtx.newPage();
      await page.goto(`${launcherBaseUrl}/index.html`, { waitUntil: 'networkidle' });

      const collapsedState = await page.evaluate(() => {
        const topbar = document.querySelector('.topbar').getBoundingClientRect();
        const tabbar = document.querySelector('.tabbar').getBoundingClientRect();
        const stage = document.querySelector('#connect-stage').getBoundingClientRect();
        const scanBtn = document.querySelector('#scan-qr').getBoundingClientRect();
        const toggleBtn = document.querySelector('#manual-toggle');
        const toggleRect = toggleBtn.getBoundingClientRect();
        const form = document.querySelector('#connect');
        const server = document.querySelector('#server');
        const pairCode = document.querySelector('#pair-code');
        const hint = document.querySelector('#hint');
        const openBtn = document.querySelector('#open');
        const availableCenterY = (topbar.bottom + tabbar.top) / 2;
        const stageCenterY = (stage.top + stage.bottom) / 2;
        const scanCenterX = (scanBtn.left + scanBtn.right) / 2;
        return {
          scanText: document.querySelector('#scan-qr [data-i18n="scanQr"]').textContent,
          toggleText: toggleBtn.textContent,
          ariaExpanded: toggleBtn.getAttribute('aria-expanded'),
          ariaControls: toggleBtn.getAttribute('aria-controls'),
          formHidden: form.hidden,
          serverVisible: server.offsetParent !== null,
          pairCodeVisible: pairCode.offsetParent !== null,
          hintVisible: hint.offsetParent !== null,
          openVisible: openBtn.offsetParent !== null,
          centerOffsetY: Math.abs(stageCenterY - availableCenterY),
          centerOffsetX: Math.abs(scanCenterX - window.innerWidth / 2),
          toggleBelowScan: toggleRect.top >= scanBtn.bottom,
        };
      });

      assert.equal(collapsedState.scanText, '扫码连接');
      assert.equal(collapsedState.toggleText, '手动输入');
      assert.equal(collapsedState.ariaExpanded, 'false');
      assert.equal(collapsedState.ariaControls, 'connect');
      assert.equal(collapsedState.formHidden, true);
      assert.equal(collapsedState.serverVisible, false);
      assert.equal(collapsedState.pairCodeVisible, false);
      assert.equal(collapsedState.hintVisible, false);
      assert.equal(collapsedState.openVisible, false);
      assert.equal(collapsedState.toggleBelowScan, true);
      assert.ok(
        collapsedState.centerOffsetY < 48,
        `Expected scan stage vertically centered in content area, offset was ${collapsedState.centerOffsetY}px`,
      );
      assert.ok(
        collapsedState.centerOffsetX < 2,
        `Expected scan button horizontally centered, offset was ${collapsedState.centerOffsetX}px`,
      );

      if (proofDir) {
        await page.screenshot({ path: join(proofDir, 'connect-collapsed-zh-light-390x844.png') });
      }

      // Keyboard disclosure expand + collapse
      await page.focus('#manual-toggle');
      await page.keyboard.press('Enter');

      const expandedState = await page.evaluate(() => {
        const toggleBtn = document.querySelector('#manual-toggle');
        const form = document.querySelector('#connect');
        return {
          ariaExpanded: toggleBtn.getAttribute('aria-expanded'),
          toggleText: toggleBtn.textContent,
          formHidden: form.hidden,
          serverVisible: document.querySelector('#server').offsetParent !== null,
          pairCodeVisible: document.querySelector('#pair-code').offsetParent !== null,
          hintVisible: document.querySelector('#hint').offsetParent !== null,
          openVisible: document.querySelector('#open').offsetParent !== null,
          activeId: document.activeElement?.id ?? '',
        };
      });

      assert.equal(expandedState.ariaExpanded, 'true');
      assert.equal(expandedState.toggleText, '收起手动输入');
      assert.equal(expandedState.formHidden, false);
      assert.equal(expandedState.serverVisible, true);
      assert.equal(expandedState.pairCodeVisible, true);
      assert.equal(expandedState.hintVisible, true);
      assert.equal(expandedState.openVisible, true);
      assert.equal(expandedState.activeId, 'server');

      if (proofDir) {
        await page.screenshot({ path: join(proofDir, 'connect-expanded-zh-light-390x844.png') });
      }

      // Simple way to collapse again
      await page.click('#manual-toggle');
      const recollapsed = await page.evaluate(() => ({
        ariaExpanded: document.querySelector('#manual-toggle').getAttribute('aria-expanded'),
        toggleText: document.querySelector('#manual-toggle').textContent,
        formHidden: document.querySelector('#connect').hidden,
      }));
      assert.equal(recollapsed.ariaExpanded, 'false');
      assert.equal(recollapsed.toggleText, '手动输入');
      assert.equal(recollapsed.formHidden, true);

      // Programmatic scan cancel / denied / invalid QR fallbacks auto-expand and focus manual input
      await page.evaluate(() => {
        window.__kikiTestScanQr = async () => ({ status: 'cancelled' });
      });
      await page.click('#scan-qr');
      assert.equal(await page.evaluate(() => document.querySelector('#connect').hidden), false);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'server');

      await page.click('#manual-toggle');
      assert.equal(await page.evaluate(() => document.querySelector('#connect').hidden), true);

      await page.evaluate(() => {
        window.__kikiTestScanQr = async () => ({ status: 'denied' });
      });
      await page.click('#scan-qr');
      assert.equal(await page.evaluate(() => document.querySelector('#connect').hidden), false);
      assert.equal(await page.evaluate(() => document.querySelector('#scan-feedback').hidden), false);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'server');

      await page.click('#manual-toggle');
      assert.equal(await page.evaluate(() => document.querySelector('#connect').hidden), true);

      await page.evaluate(() => {
        window.__kikiTestScanQr = async () => ({ status: 'scanned', value: 'NOT-A-VALID-QR' });
      });
      await page.click('#scan-qr');
      assert.equal(await page.evaluate(() => document.querySelector('#connect').hidden), false);
      assert.equal(await page.evaluate(() => document.querySelector('#scan-feedback').hidden), false);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'server');
    } finally {
      await zhCtx.close();
    }

    // 2. Narrow/dark check (360x780, en-US, dark) + incoming pair / unreachable error flows
    const darkCtx = await browser.newContext({
      viewport: { width: 360, height: 780 },
      locale: 'en-US',
      colorScheme: 'dark',
      deviceScaleFactor: 2,
    });
    try {
      const page = await darkCtx.newPage();
      await page.goto(`${launcherBaseUrl}/index.html`, { waitUntil: 'networkidle' });

      const narrowCollapsed = await page.evaluate(() => ({
        scanText: document.querySelector('#scan-qr [data-i18n="scanQr"]').textContent,
        toggleText: document.querySelector('#manual-toggle').textContent,
        ariaExpanded: document.querySelector('#manual-toggle').getAttribute('aria-expanded'),
        formHidden: document.querySelector('#connect').hidden,
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      }));
      assert.equal(narrowCollapsed.scanText, 'Scan QR code');
      assert.equal(narrowCollapsed.toggleText, 'Enter manually');
      assert.equal(narrowCollapsed.ariaExpanded, 'false');
      assert.equal(narrowCollapsed.formHidden, true);
      assert.equal(narrowCollapsed.noHorizontalOverflow, true);

      if (proofDir) {
        await page.screenshot({ path: join(proofDir, 'connect-collapsed-en-dark-360x780.png') });
      }

      // Incoming native pending pair URI that fails claim auto-expands manual form with populated address & code
      await page.evaluate(() => {
        window.Capacitor = {
          isNativePlatform: () => true,
          nativePromise: async (_plugin, method, payload) => {
            if (method === 'consumePendingPair' && !window.__consumedOnce) {
              window.__consumedOnce = true;
              return { uri: 'kiki://pair?endpoint=http%3A%2F%2F192.168.1.40%3A5494&code=2345-6789' };
            }
            if (method === 'claimPair') {
              window.__lastClaimPayload = payload;
              return { ok: false, reason: 'rejected' };
            }
            return { ok: false };
          },
        };
        window.location.hash = '#pair';
      });
      await page.waitForFunction(() => document.querySelector('#problem').hidden === false);

      const afterPendingPair = await page.evaluate(() => ({
        formHidden: document.querySelector('#connect').hidden,
        ariaExpanded: document.querySelector('#manual-toggle').getAttribute('aria-expanded'),
        serverValue: document.querySelector('#server').value,
        codeValue: document.querySelector('#pair-code').value,
        problemHidden: document.querySelector('#problem').hidden,
        problemText: document.querySelector('#problem').textContent,
        claimPayload: window.__lastClaimPayload,
      }));
      assert.equal(afterPendingPair.formHidden, false);
      assert.equal(afterPendingPair.ariaExpanded, 'true');
      assert.equal(afterPendingPair.serverValue, '192.168.1.40:5494');
      assert.equal(afterPendingPair.codeValue, '2345-6789');
      assert.equal(afterPendingPair.problemHidden, false);
      assert.match(afterPendingPair.problemText, /expired|already used/i);
      assert.equal(afterPendingPair.claimPayload?.endpoint, 'http://192.168.1.40:5494');
      assert.equal(afterPendingPair.claimPayload?.code, '2345-6789');

      if (proofDir) {
        await page.screenshot({ path: join(proofDir, 'connect-expanded-en-dark-360x780.png') });
      }

      // Saved computer unreachable / #unreachable fallback auto-expands manual form on Connect tab
      await page.evaluate(() => {
        localStorage.setItem('kiki.shell.origin', 'http://192.168.1.55:5494');
      });
      await page.click('#manual-toggle');
      assert.equal(await page.evaluate(() => document.querySelector('#connect').hidden), true);
      await page.evaluate(() => {
        window.location.hash = '#unreachable';
      });
      await page.waitForFunction(() => document.querySelector('#connect').hidden === false);
      const afterUnreachable = await page.evaluate(() => ({
        connectHidden: document.querySelector('#view-connect').hidden,
        formHidden: document.querySelector('#connect').hidden,
        ariaExpanded: document.querySelector('#manual-toggle').getAttribute('aria-expanded'),
        problemText: document.querySelector('#problem').textContent,
      }));
      assert.equal(afterUnreachable.connectHidden, false);
      assert.equal(afterUnreachable.formHidden, false);
      assert.equal(afterUnreachable.ariaExpanded, 'true');
      assert.match(afterUnreachable.problemText, /192\.168\.1\.55:5494/);
      assert.equal(await page.evaluate(() => document.querySelector('#hint').hidden), true);

      // Revoked pairing (cold reopen or #pairing_revoked fallback) surfaces dedicated re-pairing recovery
      // rather than LAN unreachable copy, keeps Scan QR + short-code entry operable, and re-pairs cleanly:
      const recoveryPage = await darkCtx.newPage();
      await recoveryPage.addInitScript(() => {
        const saved = [
          {
            id: 'home-studio-1',
            origin: 'http://192.168.1.58:5494',
            origins: ['http://192.168.1.58:5494'],
            verifiedOrigins: ['http://192.168.1.58:5494'],
            label: 'Studio Workstation',
            paired: true,
            targetHomeId: 'home-studio-1',
            targetHostId: 'host-studio-1',
            grantId: 'grant-old',
            updatedAt: Date.now(),
          },
        ];
        localStorage.setItem('kiki.shell.servers', JSON.stringify(saved));
        localStorage.setItem('kiki.shell.origin', 'http://192.168.1.58:5494');
        window.__openedEntries = [];
        window.__revokedState = true;
        window.Capacitor = {
          isNativePlatform: () => true,
          nativePromise: async (_plugin, method, payload) => {
            if (method === 'consumePendingPair') return {};
            if (method === 'probe') {
              if (window.__unverifiedProofState) {
                return {
                  ok: true,
                  status: 200,
                  targetHomeId: 'home-studio-1',
                  targetHostId: 'host-studio-1',
                  targetLabel: 'Studio Workstation',
                  mutualProofVerified: false,
                };
              }
              if (window.__revokedState) {
                return {
                  ok: false,
                  status: 401,
                  reason: 'pairing_revoked',
                  authRejected: true,
                  targetHomeId: 'home-studio-1',
                  targetHostId: 'host-studio-1',
                  targetLabel: 'Studio Workstation',
                  mutualProofVerified: false,
                };
              }
              return {
                ok: true,
                status: 200,
                targetHomeId: 'home-studio-1',
                targetHostId: 'host-studio-1',
                targetLabel: 'Studio Workstation',
                mutualProofVerified: true,
              };
            }
            if (method === 'claimPair') {
              window.__revokedState = false;
              return {
                ok: true,
                serverId: 'home-studio-1',
                targetHomeId: 'home-studio-1',
                targetHostId: 'host-studio-1',
                targetLabel: 'Studio Workstation',
                grantId: 'grant-repaired',
                revision: 2,
              };
            }
            if (method === 'open') {
              if (window.__revokedState) {
                return { ok: false, reason: 'pairing_revoked' };
              }
              window.__openedEntries.push(payload);
              return { ok: true, origin: payload.origin };
            }
            return { ok: false };
          },
        };
      });
      await recoveryPage.goto(`${launcherBaseUrl}/index.html`, { waitUntil: 'networkidle' });
      await recoveryPage.waitForFunction(() => document.querySelector('#problem').hidden === false);
      const revokedUi = await recoveryPage.evaluate(() => ({
        problemText: document.querySelector('#problem').textContent,
        hintHidden: document.querySelector('#hint').hidden,
        serverValue: document.querySelector('#server').value,
        activeId: document.activeElement?.id ?? '',
        scanVisible: document.querySelector('#scan-qr').offsetParent !== null,
      }));
      assert.match(revokedUi.problemText, /Studio Workstation/);
      assert.match(revokedUi.problemText, /revoked|expired/i);
      assert.doesNotMatch(revokedUi.problemText, /Could not reach/i);
      assert.equal(revokedUi.hintHidden, true);
      assert.equal(revokedUi.serverValue, '192.168.1.58:5494');
      assert.equal(revokedUi.activeId, 'pair-code');
      assert.equal(revokedUi.scanVisible, true);

      // Re-pairing via short code succeeds and opens the server with updated grantId:
      await recoveryPage.fill('#pair-code', '67892345');
      assert.equal(await recoveryPage.evaluate(() => document.querySelector('#open').textContent), 'Pair & open');
      await recoveryPage.click('#open');
      await recoveryPage.waitForFunction(() => window.__openedEntries.length === 1);
      const openedAfterRepair = await recoveryPage.evaluate(() => window.__openedEntries[0]);
      assert.equal(openedAfterRepair.origin, 'http://192.168.1.58:5494');
      assert.equal(openedAfterRepair.grantId, 'grant-repaired');

      // Re-pairing via QR scan after #pairing_revoked WebView fallback also succeeds:
      await recoveryPage.evaluate(() => {
        window.__revokedState = true;
        window.__kikiTestScanQr = async () => ({
          status: 'scanned',
          value: 'kiki://pair?endpoint=http%3A%2F%2F192.168.1.58%3A5494&code=4567-8923',
        });
        window.location.hash = '#pairing_revoked';
      });
      await recoveryPage.waitForFunction(() => document.querySelector('#problem').hidden === false);
      assert.match(await recoveryPage.textContent('#problem'), /revoked|expired/i);
      await recoveryPage.click('#scan-qr');
      await recoveryPage.waitForFunction(() => window.__openedEntries.length === 2);
      // HTTP 200 without mutual proof surfaces unverifiedHandshakeProof (retryable, keeps pairing) rather than claiming pairing_revoked:
      await recoveryPage.evaluate(() => {
        window.__unverifiedProofState = true;
        window.location.hash = '#unverified_handshake_proof';
      });
      await recoveryPage.waitForFunction(() => document.querySelector('#problem').hidden === false);
      const unverifiedUi = await recoveryPage.evaluate(() => ({
        problemText: document.querySelector('#problem').textContent,
        openText: document.querySelector('#open').textContent,
        switchHidden: document.querySelector('#switch-computer').hidden,
        pairedSaved: JSON.parse(localStorage.getItem('kiki.shell.servers') || '[]')[0]?.paired,
      }));
      assert.match(unverifiedUi.problemText, /Could not verify Studio Workstation/i);
      assert.doesNotMatch(unverifiedUi.problemText, /revoked|expired/i);
      assert.equal(unverifiedUi.openText, 'Reconnect');
      assert.equal(unverifiedUi.switchHidden, false);
      assert.equal(unverifiedUi.pairedSaved, true);
      await recoveryPage.close();

      // Cold-start paired unreachable surfaces Reconnect + Switch computer actions and auto-recovers via single-flight backoff
      // even when navigator.onLine stays true and neither button click nor `online` event occurs; also binds exact origin/server/grant:
      const unreachablePairedPage = await darkCtx.newPage();
      await unreachablePairedPage.addInitScript(() => {
        const saved = [
          {
            id: 'home-studio-other',
            origin: 'http://192.168.1.99:5494',
            origins: ['http://192.168.1.99:5494'],
            verifiedOrigins: ['http://192.168.1.99:5494'],
            label: 'Other Computer First In List',
            paired: true,
            targetHomeId: 'home-studio-other',
            targetHostId: 'host-studio-other',
            grantId: 'grant-other-computer',
            updatedAt: Date.now() + 1000,
          },
          {
            id: 'home-studio-2',
            origin: 'http://192.168.1.58:5494',
            origins: ['http://192.168.1.58:5494', 'http://192.168.1.59:5494'],
            verifiedOrigins: ['http://192.168.1.58:5494', 'http://192.168.1.59:5494'],
            label: 'Mobile Lab Host',
            paired: true,
            targetHomeId: 'home-studio-2',
            targetHostId: 'host-studio-2',
            grantId: 'grant-active-2',
            updatedAt: Date.now(),
          },
        ];
        localStorage.setItem('kiki.shell.servers', JSON.stringify(saved));
        localStorage.setItem('kiki.shell.origin', 'http://192.168.1.59:5494');
        window.__openedPairedEntries = [];
        window.__cancelledOpenOps = [];
        window.__probeCalls = [];
        window.__networkDown = true;
        window.__holdProbe = false;
        window.__holdNativeOpen = false;
        window.__pendingProbeResolvers = [];
        window.__pendingOpenResolvers = [];
        window.Capacitor = {
          isNativePlatform: () => true,
          nativePromise: async (_plugin, method, payload) => {
            if (method === 'consumePendingPair') return {};
            if (method === 'probe') {
              window.__probeCalls.push(payload);
              if (window.__holdProbe) {
                return await new Promise((resolve) => {
                  window.__pendingProbeResolvers.push(resolve);
                });
              }
              if (window.__networkDown) {
                return { ok: false };
              }
              return {
                ok: true,
                status: 200,
                targetHomeId: 'home-studio-2',
                targetHostId: 'host-studio-2',
                targetLabel: 'Mobile Lab Host',
                mutualProofVerified: true,
              };
            }
            if (method === 'cancelOpen') {
              window.__cancelledOpenOps.push(payload?.opId);
              return { ok: true, cancelled: true };
            }
            if (method === 'open') {
              if (window.__holdNativeOpen) {
                return await new Promise((resolve) => {
                  window.__pendingOpenResolvers.push({ payload, resolve });
                });
              }
              if (window.__networkDown) {
                return { ok: false, reason: 'unreachable' };
              }
              window.__openedPairedEntries.push(payload);
              return { ok: true, origin: payload.origin };
            }
            return { ok: false };
          },
        };
      });
      await unreachablePairedPage.goto(`${launcherBaseUrl}/index.html`, { waitUntil: 'networkidle' });
      await unreachablePairedPage.waitForFunction(() => document.querySelector('#problem').hidden === false);
      const unreachablePairedUi = await unreachablePairedPage.evaluate(() => ({
        onLine: navigator.onLine,
        openText: document.querySelector('#open').textContent,
        switchHidden: document.querySelector('#switch-computer').hidden,
        switchText: document.querySelector('#switch-computer').textContent,
        codeValue: document.querySelector('#pair-code').value,
      }));
      assert.equal(unreachablePairedUi.onLine, true, 'navigator.onLine stays true throughout server outage');
      assert.equal(unreachablePairedUi.openText, 'Reconnect');
      assert.equal(unreachablePairedUi.switchHidden, false);
      assert.equal(unreachablePairedUi.switchText, 'Switch computer');
      assert.equal(unreachablePairedUi.codeValue, '');

      // Counterexample: navigator.onLine remains true, service recovers, NO button is clicked and NO `online` event is dispatched ->
      // single-flight backoff timer automatically reconnects to the exact verified origin (.59, not .58 and never servers[0] .99) with original grantId:
      await unreachablePairedPage.evaluate(() => {
        window.__networkDown = false;
      });
      await unreachablePairedPage.waitForFunction(() => window.__openedPairedEntries.length === 1, null, { timeout: 5000 });
      const autoReconnected = await unreachablePairedPage.evaluate(() => window.__openedPairedEntries[0]);
      assert.equal(autoReconnected.origin, 'http://192.168.1.59:5494');
      assert.equal(autoReconnected.serverId, 'home-studio-2');
      assert.equal(autoReconnected.grantId, 'grant-active-2');

      // Boundary 1: Unmatched origin in kiki.shell.origin + #unreachable MUST NOT fall back to servers[0] or auto-connect another computer:
      await unreachablePairedPage.evaluate(() => {
        window.__openedPairedEntries.length = 0;
        window.__probeCalls.length = 0;
        localStorage.setItem('kiki.shell.origin', 'http://192.168.1.250:5494');
        window.location.hash = '#unreachable';
      });
      await unreachablePairedPage.waitForTimeout(1300);
      assert.equal(
        await unreachablePairedPage.evaluate(() => window.__openedPairedEntries.length),
        0,
        'unmatched origin must never fall back to servers[0] for background auto-recovery',
      );

      // Boundary 2: In-flight probe race — hold old auto-reconnect handshake in flight -> user clicks Switch computer ->
      // release old successful handshake result -> native open for the old target MUST be 0:
      await unreachablePairedPage.evaluate(() => {
        window.__openedPairedEntries.length = 0;
        window.__probeCalls.length = 0;
        window.__pendingProbeResolvers.length = 0;
        window.__networkDown = false;
        window.__holdProbe = true;
        localStorage.setItem('kiki.shell.origin', 'http://192.168.1.59:5494');
        window.location.hash = '';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await unreachablePairedPage.evaluate(() => {
        window.location.hash = '#unreachable';
      });
      await unreachablePairedPage.waitForFunction(
        () => document.querySelector('#problem').hidden === false && !document.querySelector('#switch-computer').hidden,
      );
      await unreachablePairedPage.evaluate(() => {
        window.dispatchEvent(new Event('online'));
      });
      await unreachablePairedPage.waitForFunction(() => window.__pendingProbeResolvers.length === 1);
      await unreachablePairedPage.click('#switch-computer');
      await unreachablePairedPage.evaluate(() => {
        const resolveOldProbe = window.__pendingProbeResolvers.shift();
        resolveOldProbe?.({
          ok: true,
          status: 200,
          targetHomeId: 'home-studio-2',
          targetHostId: 'host-studio-2',
          targetLabel: 'Mobile Lab Host',
          mutualProofVerified: true,
        });
      });
      await unreachablePairedPage.waitForTimeout(300);
      assert.equal(
        await unreachablePairedPage.evaluate(() => window.__openedPairedEntries.length),
        0,
        'late probe completion after switching to Computers tab must not call KikiShell.open for the old target',
      );

      // Boundary 3: In-flight probe race on address edit — hold old auto-reconnect handshake in flight -> user edits address input ->
      // release old successful handshake result -> native open for the old target MUST be 0 and edited input stays intact:
      await unreachablePairedPage.evaluate(() => {
        window.__openedPairedEntries.length = 0;
        window.__probeCalls.length = 0;
        window.__pendingProbeResolvers.length = 0;
        window.__holdProbe = true;
        localStorage.setItem('kiki.shell.origin', 'http://192.168.1.59:5494');
        window.location.hash = '';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await unreachablePairedPage.evaluate(() => {
        window.location.hash = '#unreachable';
      });
      await unreachablePairedPage.waitForFunction(() => document.querySelector('#problem').hidden === false);
      await unreachablePairedPage.evaluate(() => {
        window.dispatchEvent(new Event('online'));
      });
      await unreachablePairedPage.waitForFunction(() => window.__pendingProbeResolvers.length === 1);
      await unreachablePairedPage.fill('#server', '192.168.1.77:5494');
      await unreachablePairedPage.evaluate(() => {
        window.__holdProbe = false;
        const resolveOldProbe = window.__pendingProbeResolvers.shift();
        resolveOldProbe?.({
          ok: true,
          status: 200,
          targetHomeId: 'home-studio-2',
          targetHostId: 'host-studio-2',
          targetLabel: 'Mobile Lab Host',
          mutualProofVerified: true,
        });
      });
      await unreachablePairedPage.waitForTimeout(300);
      const afterEditRace = await unreachablePairedPage.evaluate(() => ({
        openedCount: window.__openedPairedEntries.length,
        serverValue: document.querySelector('#server').value,
        buttonDisabled: document.querySelector('#open').disabled,
      }));
      assert.equal(
        afterEditRace.openedCount,
        0,
        'late probe completion after editing server address must not call KikiShell.open for the old target',
      );
      assert.equal(afterEditRace.serverValue, '192.168.1.77:5494');
      assert.equal(afterEditRace.buttonDisabled, false);

      // Boundary 4: Native open in-flight handshake race — probe succeeds and KikiShell.open is called with opId,
      // then user clicks Switch computer while native open is awaiting handshake -> launcher calls KikiShell.cancelOpen({ opId }) ->
      // subsequent manual open on Computers tab succeeds cleanly:
      await unreachablePairedPage.evaluate(() => {
        window.__openedPairedEntries.length = 0;
        window.__cancelledOpenOps.length = 0;
        window.__pendingOpenResolvers.length = 0;
        window.__holdProbe = false;
        window.__holdNativeOpen = true;
        window.__networkDown = false;
        localStorage.setItem('kiki.shell.origin', 'http://192.168.1.59:5494');
        window.location.hash = '';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await unreachablePairedPage.evaluate(() => {
        window.location.hash = '#unreachable';
      });
      await unreachablePairedPage.waitForFunction(() => document.querySelector('#problem').hidden === false);
      await unreachablePairedPage.evaluate(() => {
        window.dispatchEvent(new Event('online'));
      });
      await unreachablePairedPage.waitForFunction(() => window.__pendingOpenResolvers.length === 1);
      const inFlightOpId = await unreachablePairedPage.evaluate(() => window.__pendingOpenResolvers[0]?.payload?.opId);
      assert.ok(typeof inFlightOpId === 'string' && inFlightOpId.startsWith('open-'), 'KikiShell.open must receive a non-empty opId');
      await unreachablePairedPage.click('#switch-computer');
      const cancelledOps = await unreachablePairedPage.evaluate(() => window.__cancelledOpenOps);
      assert.deepEqual(cancelledOps, [inFlightOpId], 'stopAutoReconnect must call KikiShell.cancelOpen with the exact in-flight opId');
      await unreachablePairedPage.evaluate(() => {
        window.__holdNativeOpen = false;
        const pending = window.__pendingOpenResolvers.shift();
        pending?.resolve({ ok: false, reason: 'aborted' });
      });
      await unreachablePairedPage.waitForTimeout(200);
      assert.equal(await unreachablePairedPage.evaluate(() => document.querySelector('#view-computers').hidden), false);
      await unreachablePairedPage.close();
    } finally {
      await darkCtx.close();
    }
  } finally {
    await browser.close();
    launcherServer.close();
  }
});
