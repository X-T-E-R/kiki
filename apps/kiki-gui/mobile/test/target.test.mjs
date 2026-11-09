import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { chromium } from '../../node_modules/playwright/index.mjs';

// Node ESM needs the extension to resolve the browser module.
// oxlint-disable-next-line import/extensions
import {
  STORE_ORIGIN_KEY,
  buildCommittedCredentialScript,
  claimPairingOrigin,
  classifyOrigin,
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
    assert.match(androidPluginSource, /fetchHandshake\(normalizedOrigin\)/);
    assert.match(androidPluginSource, /fetchHandshake\(targetOrigin\)/);
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
    assert.match(iosPluginSource, /Self\.fetchHandshake\(origin:\s*origin\)/);
    assert.match(iosPluginSource, /Self\.fetchHandshake\(origin:\s*targetOrigin\)/);
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
  const fields = section('    private volatile String pendingPairUri;', '    @Override\n    public void load()');
  const clear = section('    private void clearPendingAuth() {', '    private void deliverCommittedToken');
  const deliver = section('    private void deliverCommittedToken', '    static String stripTokenFromEntry');
  const builder = section('    static String buildDocumentNavNonceScript', '    private HandshakeResult fetchHandshake');
  const override = section('    @Override\n    public Boolean shouldOverrideLoad(Uri url)', '    @Override\n    protected void handleOnNewIntent').replace('    @Override\n', '');
  const origin = section('    private static boolean isWebOrigin(Uri uri)', '\n}');

  const tempDir = mkdtempSync(join(tmpdir(), 'kiki-native-delivery-'));
  try {
    const javaSource = `import java.net.URI;
import java.util.concurrent.*;
import java.util.*;
public class NativeDeliveryCheck {
${fields}
${clear}
${deliver}
${builder}
${override}
${origin}
    private static final String TRUSTED_ORIGIN = "trustedOrigin";
    private static final String ORIGIN = "http://192.168.1.50:5494";
    private final WebView view = new WebView();
    private final Bridge bridge = new Bridge(view);
    private final BlockingQueue<Reply> replies = new LinkedBlockingQueue<>();
    private Bridge getBridge() { return bridge; }
    private Prefs prefs() { return new Prefs(); }
    private boolean isOriginVerified(String id, String origin) { return id.equals("home-a") && origin.equals(ORIGIN); }
    private boolean matchesStoredHostId(String id, String host) { return id.equals("home-a") && host.equals("host-a"); }
    private String readPeerToken(String id, String origin) { return "fixture-peer-a"; }
    private HandshakeResult fetchHandshake(String origin) {
        try {
            Reply r = replies.take();
            r.started.countDown();
            if (!r.release.await(5, TimeUnit.SECONDS)) throw new AssertionError("handshake release timeout");
            return new HandshakeResult(true, false, r.home, r.host, "fixture");
        } catch (InterruptedException e) { throw new RuntimeException(e); }
    }
    private static class Reply {
        final CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        final String home, host;
        Reply(String home, String host) { this.home = home; this.host = host; }
    }
    private static class WebView {
        volatile String url = ORIGIN + "/";
        volatile String documentId = "A-document";
        final BlockingQueue<Runnable> posted = new LinkedBlockingQueue<>();
        final List<String> deliveries = new ArrayList<>();
        final List<String> deliveredScripts = new ArrayList<>();
        String getUrl() { return url; }
        void post(Runnable r) { posted.add(r); }
        void loadUrl(String next) { url = next; }
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
        Bridge(WebView v) { this.v = v; }
        String getLocalUrl() { return "https://localhost"; }
        WebView getWebView() { return v; }
    }
    private static class Prefs { String getString(String k, String def) { return ORIGIN; } }
    private static class Uri {
        final URI value;
        Uri(URI value) { this.value = value; }
        static Uri parse(String s) { return new Uri(URI.create(s)); }
        String getScheme() { return value.getScheme(); }
        String getHost() { return value.getHost(); }
        String getUserInfo() { return value.getUserInfo(); }
        int getPort() { return value.getPort(); }
        public String toString() { return value.toString(); }
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
    }
}
`;
    const javaFile = join(tempDir, 'NativeDeliveryCheck.java');
    writeFileSync(javaFile, javaSource);
    const javacBin = existsSync('C:/Program Files/Android/Android Studio/jbr/bin/javac.exe')
      ? 'C:/Program Files/Android/Android Studio/jbr/bin/javac.exe'
      : 'javac';
    const javaBin = existsSync('C:/Program Files/Android/Android Studio/jbr/bin/java.exe')
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
