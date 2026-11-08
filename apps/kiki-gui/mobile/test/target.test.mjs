import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

  await new Promise((r) => serverA1.listen(0, '127.0.0.1', r));
  await new Promise((r) => serverA2.listen(0, '127.0.0.1', r));
  await new Promise((r) => serverSpoof.listen(0, '127.0.0.1', r));
  await new Promise((r) => serverRedirect.listen(0, '127.0.0.1', r));
  await new Promise((r) => serverB.listen(0, '127.0.0.1', r));

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
    await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
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
    const pairedRedirecting = await serve((_req, res) => {
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
    let toctouCount = 0;
    const pairedToctou = await serve((_req, res) => {
      toctouCount += 1;
      if (toctouCount === 1) {
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
      eventDetail: window.__receivedShellToken,
    }));
    assert.equal(sameOriginState.pathname, '/settings');
    assert.equal(sameOriginState.search, '?tab=providers');
    assert.equal(sameOriginState.hash, '#st-card-providers-add');
    assert.deepEqual(sameOriginState.historyState, { idx: 3, usr: { from: 'boot' } });
    assert.deepEqual(sameOriginState.storedConnection, { url: '', token: 'same-origin-token-123' });
    assert.equal(sameOriginState.peerToken, 'same-origin-token-123');
    assert.deepEqual(sameOriginState.eventDetail, {
      origin: pairedSameOriginRedirect,
      token: 'same-origin-token-123',
    });

    // 4. Native Android & iOS plugin source contract verification:
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
    assert.equal(androidPluginSource.includes('/#token='), false);
    assert.equal(iosPluginSource.includes('/#token='), false);
    assert.match(androidPluginSource, /stripTokenFromEntry\(origin,\s*entry\)/);
    assert.match(androidPluginSource, /onPageCommitVisible/);
    assert.match(androidPluginSource, /deliverCommittedToken/);
    assert.match(androidPluginSource, /buildCredentialDeliveryScript\(expectedOrigin,\s*token\)/);
    assert.match(iosPluginSource, /stripTokenFromEntry\(origin:\s*origin,\s*entry:\s*entry\)/);
    assert.match(iosPluginSource, /handleWebViewNavigationState/);
    assert.match(iosPluginSource, /buildCredentialDeliveryScript\(expectedOrigin:\s*expectedOrigin,\s*token:\s*token\)/);
  } finally {
    await browser.close();
    for (const server of servers) server.close();
  }
});
