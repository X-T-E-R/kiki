import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { encode as encodeQr } from 'uqr';
import { describe, expect, it } from 'vitest';

const mobileRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(mobileRoot, '../../..');
const vectorsPath = resolve(repoRoot, 'packages/protocol/test-vectors/pairing-handshake-v1.json');
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));

type LauncherGlobal = {
  STORE_ORIGIN_KEY: string;
  normalizePairingCode: (raw: string) => string | undefined;
  normalizeTlsFingerprint: (raw: unknown) => string | undefined;
  upgradeEndpointForTlsPin: (endpoint: string, fingerprint?: unknown) => string;
  formatPairingUri: (input: { endpoint: string; code: string; fingerprint?: string }) => string;
  parsePairingUri: (raw: string) => { endpoint: string; code: string; fingerprint?: string } | undefined;
  parsePairInput: (raw: string) => { kind: string; [key: string]: unknown };
  readScanPayload: (raw: string) => Record<string, unknown>;
  sha256Hex: (value: string) => Promise<string>;
  sha256BytesHex: (bytes: Uint8Array) => Promise<string>;
  computeHandshakeProof: (key: string, message: string) => Promise<string>;
  createMutualHandshakeChallenge: (input?: {
    peerToken?: string;
    handshakeKey?: string;
    grantId?: string;
    nonce?: string;
  }) => Promise<
    | {
        nonce: string;
        grantId?: string;
        requestProof: string;
        verifyResponse: (proof: string, homeId: string, hostId: string) => Promise<boolean>;
        verifyRevokedResponse: (proof: string, homeId: string, hostId: string) => Promise<boolean>;
        verifyDisabledResponse: (proof: string, homeId: string, hostId: string) => Promise<boolean>;
        verifyInvitedResponse: (proof: string, homeId: string, hostId: string) => Promise<boolean>;
        verifyStatusResponse: (
          statusHeader: string | null | undefined,
          proof: string,
          homeId: string,
          hostId: string,
        ) => Promise<string | undefined>;
      }
    | undefined
  >;
  probeOriginHandshake: (
    origin: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    reason?: string;
    handshakeStatus?: string;
    mutualProofVerified?: boolean;
    mutualInvitedVerified?: boolean;
  }>;
  readSavedServers: (storage?: {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    removeItem: (k: string) => void;
  }) => Array<{
    id: string;
    origin: string;
    origins: string[];
    verifiedOrigins: string[];
    pinnedFingerprints?: Record<string, string>;
  }>;
  getServerFingerprint: (server: unknown, rawOrOrigin?: string) => string | undefined;
  decodeQrFromImageData: (data: Uint8ClampedArray, width: number, height: number) => string;
  saveWebPeerToken: (serverId: string, token: string, origin?: string) => Promise<void>;
  readWebPeerToken: (serverId: string, origin?: string) => Promise<string | undefined>;
  deleteWebPeerToken: (serverId: string, origins?: readonly string[]) => Promise<void>;
};

function loadCompiledLauncherBundle(): LauncherGlobal {
  const bundlePath = join(mobileRoot, 'launcher/launcher.js');
  const code = readFileSync(bundlePath, 'utf8');
  const sandbox: Record<string, unknown> = {
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint8ClampedArray,
    crypto: globalThis.crypto,
    fetch: globalThis.fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox['globalThis'] = sandbox;
  sandbox['window'] = sandbox;
  sandbox['self'] = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: bundlePath });
  const api = sandbox['__kikiLauncher'] as LauncherGlobal | undefined;
  if (!api) {
    throw new Error('Compiled launcher/launcher.js did not expose globalThis.__kikiLauncher');
  }
  return api;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function renderQrToRgba(text: string, scale = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const qr = encodeQr(text, { ecc: 'M', border: 4 });
  const modules = qr.size;
  const width = modules * scale;
  const height = modules * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = qr.data[Math.floor(y / scale)]!;
    for (let x = 0; x < width; x += 1) {
      const dark = row[Math.floor(x / scale)] === true;
      const value = dark ? 0 : 255;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

function findJdkTool(name: 'javac' | 'java'): string {
  const javaHome = process.env['JAVA_HOME'] ?? '';
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const fromJavaHome = javaHome ? join(javaHome, 'bin', `${name}${exeSuffix}`) : '';
  if (fromJavaHome && existsSync(fromJavaHome)) return fromJavaHome;
  const fromStudio = `C:/Program Files/Android/Android Studio/jbr/bin/${name}.exe`;
  if (existsSync(fromStudio)) return fromStudio;
  return name;
}

describe('mobile launcher bundle freshness and hygiene', () => {
  it('deletes the legacy hand-rolled launcher/target.js and loads classic IIFE launcher.js in index.html', () => {
    expect(existsSync(join(mobileRoot, 'launcher/target.js'))).toBe(false);
    expect(existsSync(join(mobileRoot, 'launcher/launcher.js'))).toBe(true);
    const html = readFileSync(join(mobileRoot, 'launcher/index.html'), 'utf8');
    expect(html).toContain('<script src="./launcher.js" defer></script>');
    expect(html).not.toContain('target.js');
    expect(html).not.toContain('type="module"');
    expect(html).toContain('id="pick-qr-photo"');
    expect(html).toContain('id="qr-photo-input"');
  });

  it('matches a fresh tsdown build byte-for-byte with zero drift from @kiki/protocol', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'kiki-launcher-freshness-'));
    try {
      const tsdownBin = join(repoRoot, 'node_modules/tsdown/dist/run.mjs');
      execFileSync(
        process.execPath,
        [tsdownBin, '--config', join(mobileRoot, 'tsdown.config.ts'), '--out-dir', outDir],
        { cwd: mobileRoot, stdio: 'pipe' },
      );
      const checkedIn = readFileSync(join(mobileRoot, 'launcher/launcher.js'), 'utf8');
      const rebuilt = readFileSync(join(outDir, 'launcher.js'), 'utf8');
      expect(checkedIn).toBe(rebuilt);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('compiled mobile launcher RFC vectors and jsQR fallback', () => {
  const bundle = loadCompiledLauncherBundle();

  it('verifies every RFC pairing code, SPKI pin, kiki://pair URI, and http->https TLS pin upgrade vector', async () => {
    for (const item of vectors.pairingCodes.valid) {
      expect(bundle.normalizePairingCode(item.input)).toBe(item.normalized);
    }
    for (const invalid of vectors.pairingCodes.invalid) {
      expect(bundle.normalizePairingCode(invalid)).toBeNull();
    }

    const spkiPin = await bundle.sha256BytesHex(hexToBytes(vectors.spkiPin.spkiDerHex));
    expect(spkiPin).toBe(vectors.spkiPin.spkiSha256Hex);
    for (const valid of vectors.spkiPin.validInputs) {
      expect(bundle.normalizeTlsFingerprint(valid)).toBe(vectors.spkiPin.spkiSha256Hex);
    }
    for (const invalid of vectors.spkiPin.invalidInputs) {
      expect(bundle.normalizeTlsFingerprint(invalid)).toBeUndefined();
    }

    const ts = vectors.pairingUri.tailscaleWithPinUpgrade;
    const scanned = bundle.readScanPayload(ts.uri);
    expect(scanned).toEqual({
      ok: true,
      kind: 'pair',
      origin: ts.expectedUpgradedOrigin,
      endpoint: ts.expectedUpgradedOrigin,
      entry: ts.expectedUpgradedEntry,
      code: ts.code,
      fingerprint: ts.fingerprint,
    });

    const p80 = vectors.pairingUri.implicitPort80WithPinUpgrade;
    expect(bundle.upgradeEndpointForTlsPin(p80.endpoint, p80.fingerprint)).toBe(p80.expectedUpgradedOrigin);

    const p443 = vectors.pairingUri.explicitPort443WithPinUpgrade;
    expect(bundle.upgradeEndpointForTlsPin(p443.endpoint, p443.fingerprint)).toBe(p443.expectedUpgradedOrigin);

    const lan = vectors.pairingUri.lanWithoutPin;
    expect(bundle.readScanPayload(lan.uri)).toEqual({
      ok: true,
      kind: 'pair',
      origin: lan.expectedOrigin,
      endpoint: lan.expectedOrigin,
      entry: `${lan.expectedOrigin}/`,
      code: lan.code,
    });
  });

  it('verifies owner and invited-space (kiki-handshake-invited-v1) RFC mutual HMAC vectors', async () => {
    const owner = vectors.ownerHandshake;
    const ownerChallenge = await bundle.createMutualHandshakeChallenge({
      peerToken: owner.peerToken,
      grantId: owner.grantId,
      nonce: owner.nonce,
    });
    expect(ownerChallenge).toBeDefined();
    if (!ownerChallenge) return;
    expect(ownerChallenge.requestProof).toBe(owner.reqProof);
    expect(await ownerChallenge.verifyResponse(owner.resProof, owner.target.homeId, owner.target.hostId)).toBe(true);
    expect(await ownerChallenge.verifyRevokedResponse(owner.revokedProof, owner.target.homeId, owner.target.hostId)).toBe(true);
    expect(await ownerChallenge.verifyDisabledResponse(owner.disabledProof, owner.target.homeId, owner.target.hostId)).toBe(true);
    expect(await ownerChallenge.verifyInvitedResponse(owner.resProof, owner.target.homeId, owner.target.hostId)).toBe(false);

    const invited = vectors.invitedHandshake;
    const invitedChallenge = await bundle.createMutualHandshakeChallenge({
      peerToken: invited.invitation,
      grantId: invited.grantId,
      nonce: invited.nonce,
    });
    expect(invitedChallenge).toBeDefined();
    if (!invitedChallenge) return;
    expect(invitedChallenge.requestProof).toBe(invited.reqProof);
    expect(await invitedChallenge.verifyInvitedResponse(invited.invitedProof, invited.target.homeId, invited.target.hostId)).toBe(true);
    expect(await invitedChallenge.verifyStatusResponse('invited', invited.invitedProof, invited.target.homeId, invited.target.hostId)).toBe('invited');
    expect(await invitedChallenge.verifyResponse(invited.invitedProof, invited.target.homeId, invited.target.hostId)).toBe(false);
  });

  it('decodes real kiki://pair QR bitmaps through bundled jsQR fallback when BarcodeDetector is absent', () => {
    const ts = vectors.pairingUri.tailscaleWithPinUpgrade;
    const { data, width, height } = renderQrToRgba(ts.uri, 4);
    const decoded = bundle.decodeQrFromImageData(data, width, height);
    expect(decoded).toBe(ts.uri);
    const parsed = bundle.readScanPayload(decoded);
    expect(parsed).toEqual({
      ok: true,
      kind: 'pair',
      origin: ts.expectedUpgradedOrigin,
      endpoint: ts.expectedUpgradedOrigin,
      entry: ts.expectedUpgradedEntry,
      code: ts.code,
      fingerprint: ts.fingerprint,
    });
  });

  it('probes kiki-handshake-invited-v1 over both 200 direct and 401 public listeners and rejects cross-status mismatch', async () => {
    const invited = vectors.invitedHandshake;
    let statusCode = 200;
    let responseDomain: 'invited' | 'approved' = 'invited';
    const server = createServer((req, res) => {
      if (req.url === '/api/remote-connections/handshake') {
        const nonce = String(req.headers['x-kiki-handshake-nonce'] ?? '');
        const reqProof = String(req.headers['x-kiki-handshake-proof'] ?? '');
        const key = createHash('sha256').update(invited.invitation).digest('hex');
        const expectedReq = createHmac('sha256', key).update(`kiki-handshake-req-v1:${nonce}`).digest('hex');
        if (reqProof !== expectedReq) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 40100 }));
          return;
        }
        const prefix = responseDomain === 'invited' ? 'kiki-handshake-invited-v1:' : 'kiki-handshake-res-v1:';
        const resProof = createHmac('sha256', key)
          .update(`${prefix}${nonce}:${invited.target.homeId}:${invited.target.hostId}`)
          .digest('hex');
        res.writeHead(statusCode, {
          'content-type': 'application/json',
          'x-kiki-handshake-status': responseDomain,
          'x-kiki-handshake-proof': resProof,
        });
        if (statusCode === 200) {
          res.end(JSON.stringify({ data: { target: invited.target, inboundEnabled: true } }));
        } else {
          res.end(JSON.stringify({ code: 40100 }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const origin = `http://127.0.0.1:${port}`;

      // 200 direct listener with invited proof + expectedStatus='invited' -> ok
      const directInvited = await bundle.probeOriginHandshake(origin, {
        peerToken: invited.invitation,
        grantId: invited.grantId,
        targetHomeId: invited.target.homeId,
        targetHostId: invited.target.hostId,
        expectedStatus: 'invited',
      });
      expect(directInvited.ok).toBe(true);
      expect(directInvited.handshakeStatus).toBe('invited');
      expect(directInvited.mutualInvitedVerified).toBe(true);

      // 200 direct listener with invited proof + default expectedStatus='approved' -> pairing_required
      const mismatchOwner = await bundle.probeOriginHandshake(origin, {
        peerToken: invited.invitation,
        grantId: invited.grantId,
        targetHomeId: invited.target.homeId,
        targetHostId: invited.target.hostId,
      });
      expect(mismatchOwner.ok).toBe(false);
      expect(mismatchOwner.reason).toBe('pairing_required');
      expect(mismatchOwner.mutualInvitedVerified).toBe(true);

      // 401 public web listener with invited proof + expectedStatus='invited' -> ok
      statusCode = 401;
      const publicInvited = await bundle.probeOriginHandshake(origin, {
        peerToken: invited.invitation,
        grantId: invited.grantId,
        targetHomeId: invited.target.homeId,
        targetHostId: invited.target.hostId,
        expectedStatus: 'invited',
      });
      expect(publicInvited.ok).toBe(true);
      expect(publicInvited.handshakeStatus).toBe('invited');
      expect(publicInvited.mutualInvitedVerified).toBe(true);

      // 401 public web listener with invited proof + default expectedStatus='approved' -> pairing_required
      const publicMismatch = await bundle.probeOriginHandshake(origin, {
        peerToken: invited.invitation,
        grantId: invited.grantId,
        targetHomeId: invited.target.homeId,
        targetHostId: invited.target.hostId,
      });
      expect(publicMismatch.ok).toBe(false);
      expect(publicMismatch.reason).toBe('pairing_required');
      expect(publicMismatch.mutualInvitedVerified).toBe(true);

      // Expected invited must reject an approved owner proof
      statusCode = 200;
      responseDomain = 'approved';
      const wrongDomain = await bundle.probeOriginHandshake(origin, {
        peerToken: invited.invitation,
        grantId: invited.grantId,
        targetHomeId: invited.target.homeId,
        targetHostId: invited.target.hostId,
        expectedStatus: 'invited',
      });
      expect(wrongDomain.ok).toBe(false);
      expect(wrongDomain.reason).toBe('pairing_required');
    } finally {
      server.close();
    }
  });

  it('migrates legacy pre-W2-B pinned http:// pairings across SavedServer records and Web Vault while keeping unpinned http:// untouched (F3)', async () => {
    const fp = vectors.spkiPin.spkiSha256Hex;
    const store = new Map<string, string>([
      [
        'kiki.shell.servers',
        JSON.stringify([
          {
            id: 'home-legacy-1',
            label: 'Studio',
            origin: 'http://100.64.0.10:58627',
            origins: ['http://100.64.0.10:58627', 'http://192.168.10.40:58627'],
            verifiedOrigins: ['http://100.64.0.10:58627', 'http://192.168.10.40:58627'],
            paired: true,
            targetHomeId: 'home-legacy-1',
            targetHostId: 'studio-host',
            pinnedFingerprints: {
              'http://100.64.0.10:58627': fp,
            },
            updatedAt: 1,
          },
        ]),
      ],
      ['kiki.shell.origin', 'http://100.64.0.10:58627'],
    ]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };

    const servers = bundle.readSavedServers(storage);
    expect(servers).toHaveLength(1);
    const migrated = servers[0]!;
    expect(migrated.origin).toBe('https://100.64.0.10:58627');
    expect(migrated.origins).toEqual(['https://100.64.0.10:58627', 'http://192.168.10.40:58627']);
    expect(migrated.verifiedOrigins).toEqual(['https://100.64.0.10:58627', 'http://192.168.10.40:58627']);
    expect(migrated.pinnedFingerprints).toEqual({ 'https://100.64.0.10:58627': fp });
    expect(bundle.getServerFingerprint(migrated, 'https://100.64.0.10:58627')).toBe(fp);
    expect(bundle.getServerFingerprint(migrated, 'http://100.64.0.10:58627')).toBe(fp);
    expect(bundle.getServerFingerprint(migrated, 'http://192.168.10.40:58627')).toBeUndefined();

    // Web Vault legacy http:// scoped token lookup & cleanup
    await bundle.saveWebPeerToken('home-legacy-1', 'legacy-scoped-token', 'http://100.64.0.10:58627');
    expect(await bundle.readWebPeerToken('home-legacy-1', 'https://100.64.0.10:58627')).toBe(
      'legacy-scoped-token',
    );
    await bundle.deleteWebPeerToken('home-legacy-1', ['https://100.64.0.10:58627']);
    expect(await bundle.readWebPeerToken('home-legacy-1', 'https://100.64.0.10:58627')).toBeUndefined();
    expect(await bundle.readWebPeerToken('home-legacy-1', 'http://100.64.0.10:58627')).toBeUndefined();
  });

  it('passes upgraded https:// origin and matching entry to native KikiShell.open when openServer receives raw http:// + fp (F2)', async () => {
    const fp = vectors.spkiPin.spkiSha256Hex;
    const launcherDir = join(mobileRoot, 'launcher');
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(launcherDir, 'index.html'), 'utf8'));
        return;
      }
      if (path === '/launcher.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        res.end(readFileSync(join(launcherDir, 'launcher.js'), 'utf8'));
        return;
      }
      if (path === '/launcher.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
        res.end(readFileSync(join(launcherDir, 'launcher.css'), 'utf8'));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const browser = await chromium.launch({ headless: true });
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const page = await browser.newPage();
      await page.addInitScript(
        ({ testFp }: { testFp: string }) => {
          localStorage.setItem(
            'kiki.shell.servers',
            JSON.stringify([
              {
                id: 'home-f2',
                label: 'Studio F2',
                origin: 'https://100.64.0.10:58627',
                origins: ['https://100.64.0.10:58627'],
                verifiedOrigins: ['https://100.64.0.10:58627'],
                paired: true,
                targetHomeId: 'home-f2',
                targetHostId: 'host-f2',
                grantId: 'grant-f2',
                pinnedFingerprints: { 'https://100.64.0.10:58627': testFp },
                updatedAt: 1,
              },
            ]),
          );
          const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
          (window as unknown as Record<string, unknown>)['__capturedShellCalls'] = calls;
          (window as unknown as Record<string, unknown>)['Capacitor'] = {
            isNativePlatform: () => true,
            nativePromise: async (_plugin: string, method: string, payload?: Record<string, unknown>) => {
              calls.push({ method, payload: payload ?? {} });
              if (method === 'consumePendingPair') return {};
              if (method === 'probe') {
                return {
                  ok: true,
                  status: 200,
                  inboundEnabled: true,
                  targetHomeId: 'home-f2',
                  targetHostId: 'host-f2',
                  mutualProofVerified: true,
                };
              }
              if (method === 'open') {
                const openOrigin = String(payload?.['origin'] ?? '');
                const openEntry = String(payload?.['entry'] ?? '');
                if (!openEntry.startsWith(`${openOrigin}/`)) {
                  throw new Error('invalid_origin');
                }
                return { ok: true, origin: openOrigin };
              }
              return { ok: true };
            },
          };
        },
        { testFp: fp },
      );

      await page.goto(`http://127.0.0.1:${port}/index.html#change`, { waitUntil: 'networkidle' });
      const openPayload = await page.evaluate(
        async ({ testFp }: { testFp: string }) => {
          const w = window as unknown as {
            __kikiLauncher: {
              openServer: (
                origin: string,
                entry: string,
                options?: Record<string, unknown>,
              ) => Promise<void>;
            };
            __capturedShellCalls: Array<{ method: string; payload: Record<string, unknown> }>;
          };
          w.__capturedShellCalls.length = 0;
          await w.__kikiLauncher.openServer('http://100.64.0.10:58627', 'http://100.64.0.10:58627/', {
            serverId: 'home-f2',
            paired: true,
            targetHomeId: 'home-f2',
            targetHostId: 'host-f2',
            grantId: 'grant-f2',
            fingerprint: testFp,
          });
          return w.__capturedShellCalls.find((c) => c.method === 'open')?.payload ?? null;
        },
        { testFp: fp },
      );

      expect(openPayload).not.toBeNull();
      expect(openPayload?.['origin']).toBe('https://100.64.0.10:58627');
      expect(openPayload?.['entry']).toBe('https://100.64.0.10:58627/');
      expect(openPayload?.['fingerprint']).toBe(fp);
    } finally {
      await browser.close();
      server.close();
    }
  });

  it('surfaces probe failure on the active Computers tab card, never wedges #open in Opening, supports cancel, and reprobes on online/visibilitychange (P1-10)', async () => {
    const launcherDir = join(mobileRoot, 'launcher');
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(launcherDir, 'index.html'), 'utf8'));
        return;
      }
      if (path === '/launcher.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        res.end(readFileSync(join(launcherDir, 'launcher.js'), 'utf8'));
        return;
      }
      if (path === '/launcher.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
        res.end(readFileSync(join(launcherDir, 'launcher.css'), 'utf8'));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const browser = await chromium.launch({ headless: true });
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const page = await browser.newPage();
      await page.addInitScript(() => {
        localStorage.setItem(
          'kiki.shell.servers',
          JSON.stringify([
            {
              id: 'home-p1-10',
              label: 'Studio P1-10',
              origin: 'http://192.168.31.221:59918',
              origins: ['http://192.168.31.221:59918'],
              verifiedOrigins: ['http://192.168.31.221:59918'],
              paired: true,
              targetHomeId: 'home-p1-10',
              targetHostId: 'host-p1-10',
              grantId: 'grant-p1-10',
              updatedAt: 2,
            },
            {
              id: 'home-local-daemon',
              label: 'Phone Local',
              origin: 'http://127.0.0.1:19410',
              origins: ['http://127.0.0.1:19410'],
              verifiedOrigins: ['http://127.0.0.1:19410'],
              paired: true,
              targetHomeId: 'home-local-daemon',
              targetHostId: 'host-local',
              grantId: 'grant-local',
              updatedAt: 1,
            },
          ]),
        );
        const w = window as unknown as Record<string, unknown>;
        w['__probeMode'] = 'fail';
        w['__probeCount'] = 0;
        w['__openedOrigins'] = [];
        w['__holdProbeResolve'] = null;
        w['Capacitor'] = {
          isNativePlatform: () => true,
          nativePromise: async (_plugin: string, method: string, payload?: Record<string, unknown>) => {
            if (method === 'consumePendingPair') return {};
            if (method === 'probe') {
              w['__probeCount'] = Number(w['__probeCount']) + 1;
              if (w['__probeMode'] === 'hold') {
                return new Promise((resolve) => {
                  w['__holdProbeResolve'] = resolve;
                });
              }
              if (w['__probeMode'] === 'throw') {
                throw new Error('simulated bridge failure');
              }
              if (w['__probeMode'] === 'ok') {
                return {
                  ok: true,
                  status: 200,
                  inboundEnabled: true,
                  targetHomeId: String(payload?.['serverId'] ?? ''),
                  targetHostId: 'host-p1-10',
                  mutualProofVerified: true,
                };
              }
              return { ok: false };
            }
            if (method === 'open') {
              (w['__openedOrigins'] as string[]).push(String(payload?.['origin'] ?? ''));
              return { ok: true, origin: payload?.['origin'] };
            }
            return { ok: true };
          },
        };
      });

      await page.goto(`http://127.0.0.1:${port}/index.html#change`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#view-computers:not([hidden])');

      // 1. Clicking unreachable computer on Computers tab shows error right on the card and stays on Computers tab
      await page.click('#recent-open');
      await page.waitForSelector('.saved-card[data-server-id="home-p1-10"] .saved-card-status');
      const cardState = await page.evaluate(() => ({
        computersHidden: (document.querySelector('#view-computers') as HTMLElement).hidden,
        statusText: document.querySelector('.saved-card[data-server-id="home-p1-10"] .saved-card-status-text')?.textContent ?? '',
        openDisabled: (document.querySelector('#open') as HTMLButtonElement).disabled,
        openText: document.querySelector('#open')?.textContent ?? '',
      }));
      expect(cardState.computersHidden).toBe(false);
      expect(cardState.statusText).toContain('192.168.31.221:59918');
      expect(cardState.openDisabled).toBe(false);
      expect(cardState.openText).not.toContain('Opening');

      // 2. Local loopback failure (127.0.0.1:19410) shows local-daemon message instead of LAN/Wi-Fi message
      await page.click('.saved-card[data-server-id="home-local-daemon"] .recent-row');
      await page.waitForSelector('.saved-card[data-server-id="home-local-daemon"] .saved-card-status');
      const localCardText = await page.textContent('.saved-card[data-server-id="home-local-daemon"] .saved-card-status-text');
      expect(localCardText ?? '').toMatch(/Local Kiki service|本机 Kiki 服务/);
      expect(localCardText ?? '').not.toMatch(/Wi-Fi|局域网/);

      // 3. Online event on Computers tab triggers host reprobe and opens automatically when host recovers
      await page.click('#recent-open');
      await page.waitForSelector('.saved-card[data-server-id="home-p1-10"] .saved-card-status');
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w['__probeMode'] = 'ok';
        window.dispatchEvent(new Event('online'));
      });
      await page.waitForFunction(() => ((window as unknown as { __openedOrigins: string[] }).__openedOrigins.length > 0));
      const opened = await page.evaluate(() => (window as unknown as { __openedOrigins: string[] }).__openedOrigins);
      expect(opened).toContain('http://192.168.31.221:59918');

      // 4. Cancel affordance resets #open cleanly while a probe is in flight on Connect tab
      await page.click('button.tab[data-tab="connect"]');
      await page.waitForSelector('#view-connect:not([hidden])');
      await page.click('#manual-toggle');
      await page.fill('#server', '192.168.31.221:59918');
      await page.evaluate(() => {
        (window as unknown as Record<string, unknown>)['__probeMode'] = 'hold';
      });
      await page.click('#open');
      await page.waitForSelector('#cancel-open:not([hidden])');
      expect(await page.evaluate(() => (document.querySelector('#open') as HTMLButtonElement).disabled)).toBe(true);
      await page.click('#cancel-open');
      const afterCancel = await page.evaluate(() => ({
        openDisabled: (document.querySelector('#open') as HTMLButtonElement).disabled,
        cancelHidden: (document.querySelector('#cancel-open') as HTMLElement).hidden,
        openText: document.querySelector('#open')?.textContent ?? '',
      }));
      expect(afterCancel.openDisabled).toBe(false);
      expect(afterCancel.cancelHidden).toBe(true);
      expect(afterCancel.openText).not.toContain('Opening');
    } finally {
      await browser.close();
      server.close();
    }
  });
});

describe('Android Java and iOS Swift native pairing parity against RFC vectors', () => {
  it('executes extracted KikiShellPlugin.java crypto, invited-v1 domain, and http->https upgrade methods with JDK', () => {
    const javaPluginPath = join(
      mobileRoot,
      'android/app/src/main/java/ai/easyagent/kiki/KikiShellPlugin.java',
    );
    const source = readFileSync(javaPluginPath, 'utf8');
    function sliceBetween(start: string, end: string): string {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);
      return source.slice(from, to);
    }

    const cryptoHelpers = sliceBetween('    static String sha256Hex', '    private String resolveHandshakeKey');
    const pinAndUpgrade = sliceBetween('    static String normalizeFingerprint', '    static String certificateSpkiSha256Hex');
    const originHelpers = sliceBetween('    private static boolean isWebOrigin(Uri uri)', '\n}');
    const handshakeResultClass = sliceBetween('    private static final class HandshakeResult', '    @Override\n    public void load()');

    const tempDir = mkdtempSync(join(tmpdir(), 'kiki-java-rfc-vectors-'));
    try {
      const harness = `import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class JavaRfcVectorCheck {
    private static final SecureRandom NONCE_RANDOM = new SecureRandom();
    static final class Uri {
        private final URI inner;
        Uri(URI u) { this.inner = u; }
        static Uri parse(String s) { return new Uri(URI.create(s)); }
        String getScheme() { return inner.getScheme(); }
        String getHost() { return inner.getHost(); }
        int getPort() { return inner.getPort(); }
        String getUserInfo() { return inner.getUserInfo(); }
        @Override public String toString() { return inner.toString(); }
    }
${handshakeResultClass}
${cryptoHelpers}
${pinAndUpgrade}
${originHelpers}

    private static void eq(Object actual, Object expected, String label) {
        if ((actual == null && expected != null) || (actual != null && !actual.equals(expected))) {
            throw new AssertionError(label + ": expected=" + expected + " actual=" + actual);
        }
    }

    public static void main(String[] args) {
        String fp = ${JSON.stringify(vectors.spkiPin.spkiSha256Hex)};
        eq(normalizeFingerprint(${JSON.stringify(vectors.spkiPin.validInputs[1])}), fp, "normalizeFingerprint uppercase");
        eq(normalizeFingerprint(${JSON.stringify(vectors.spkiPin.invalidInputs[0])}), null, "normalizeFingerprint invalid");

        // P0 http:// + fp -> https:// upgrade parity
        eq(
            upgradeOriginForTlsPin(${JSON.stringify(vectors.pairingUri.tailscaleWithPinUpgrade.endpoint)}, fp),
            ${JSON.stringify(vectors.pairingUri.tailscaleWithPinUpgrade.expectedUpgradedOrigin)},
            "upgrade tailscale http+fp"
        );
        eq(
            upgradeOriginForTlsPin(${JSON.stringify(vectors.pairingUri.implicitPort80WithPinUpgrade.endpoint)}, fp),
            ${JSON.stringify(vectors.pairingUri.implicitPort80WithPinUpgrade.expectedUpgradedOrigin)},
            "upgrade implicit port 80 http+fp"
        );
        eq(
            upgradeOriginForTlsPin(${JSON.stringify(vectors.pairingUri.explicitPort443WithPinUpgrade.endpoint)}, fp),
            ${JSON.stringify(vectors.pairingUri.explicitPort443WithPinUpgrade.expectedUpgradedOrigin)},
            "upgrade explicit port 443 omits :443"
        );
        eq(legacyHttpOriginForHttps("https://100.64.0.10:58627"), "http://100.64.0.10:58627", "legacy http non-default port");
        eq(legacyHttpOriginForHttps("https://100.64.0.10:80"), "http://100.64.0.10", "legacy http port 80");
        eq(legacyHttpOriginForHttps("https://100.64.0.10"), "http://100.64.0.10:443", "legacy http port 443");
        eq(legacyHttpOriginForHttps("http://100.64.0.10:58627"), null, "legacy http rejects plain http");
        eq(
            upgradeOriginForTlsPin(${JSON.stringify(vectors.pairingUri.lanWithoutPin.endpoint)}, null),
            ${JSON.stringify(vectors.pairingUri.lanWithoutPin.expectedUpgradedOrigin)},
            "preserve http without fp"
        );
        eq(
            upgradeEntryForTlsPin("http://100.64.0.10:58627", "http://100.64.0.10:58627/sessions", fp),
            "https://100.64.0.10:58627/sessions",
            "upgrade entry path with fp"
        );

        // Owner handshake vectors
        String ownerKey = sha256Hex(${JSON.stringify(vectors.ownerHandshake.peerToken)});
        eq(ownerKey, ${JSON.stringify(vectors.ownerHandshake.grantDigest)}, "owner digest");
        eq(hmacSha256Hex(ownerKey, ${JSON.stringify(vectors.ownerHandshake.reqPreimage)}), ${JSON.stringify(vectors.ownerHandshake.reqProof)}, "owner reqProof");
        String ownerSuffix = ${JSON.stringify(`${vectors.ownerHandshake.nonce}:${vectors.ownerHandshake.target.homeId}:${vectors.ownerHandshake.target.hostId}`)};
        eq(verifyHandshakeDomain("approved", ${JSON.stringify(vectors.ownerHandshake.resProof)}, ownerKey, ownerSuffix), "approved", "owner approved");
        eq(verifyHandshakeDomain("revoked", ${JSON.stringify(vectors.ownerHandshake.revokedProof)}, ownerKey, ownerSuffix), "revoked", "owner revoked");
        eq(verifyHandshakeDomain("inbound_disabled", ${JSON.stringify(vectors.ownerHandshake.disabledProof)}, ownerKey, ownerSuffix), "inbound_disabled", "owner disabled");
        eq(verifyHandshakeDomain("invited", ${JSON.stringify(vectors.ownerHandshake.resProof)}, ownerKey, ownerSuffix), null, "owner resProof must not verify as invited");

        // Invited-space kiki-handshake-invited-v1 vectors
        String invitedKey = sha256Hex(${JSON.stringify(vectors.invitedHandshake.invitation)});
        eq(invitedKey, ${JSON.stringify(vectors.invitedHandshake.invitationDigest)}, "invited digest");
        eq(hmacSha256Hex(invitedKey, ${JSON.stringify(vectors.invitedHandshake.reqPreimage)}), ${JSON.stringify(vectors.invitedHandshake.reqProof)}, "invited reqProof");
        String invitedSuffix = ${JSON.stringify(`${vectors.invitedHandshake.nonce}:${vectors.invitedHandshake.target.homeId}:${vectors.invitedHandshake.target.hostId}`)};
        eq(verifyHandshakeDomain("invited", ${JSON.stringify(vectors.invitedHandshake.invitedProof)}, invitedKey, invitedSuffix), "invited", "invited domain");
        eq(verifyHandshakeDomain(null, ${JSON.stringify(vectors.invitedHandshake.invitedProof)}, invitedKey, invitedSuffix), "invited", "invited domain without header");
        eq(verifyHandshakeDomain("approved", ${JSON.stringify(vectors.invitedHandshake.invitedProof)}, invitedKey, invitedSuffix), null, "invited proof must not verify as approved");

        // classifyPairedHandshakeFailure for invited status
        HandshakeResult invitedHs = new HandshakeResult(true, false, 200, "home", "host", "Lab", false, false, false, true, true);
        eq(classifyPairedHandshakeFailure(invitedHs, "home", true), "pairing_required", "owner open rejects invited handshake");
    }
}
`;
      const javaFile = join(tempDir, 'JavaRfcVectorCheck.java');
      writeFileSync(javaFile, harness);
      const compiled = spawnSync(findJdkTool('javac'), ['-d', tempDir, javaFile], { encoding: 'utf8' });
      expect(compiled.status, `javac stderr: ${compiled.stderr}`).toBe(0);
      const ran = spawnSync(findJdkTool('java'), ['-cp', tempDir, 'JavaRfcVectorCheck'], { encoding: 'utf8' });
      expect(ran.status, `java stderr: ${ran.stderr || ran.stdout}`).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('verifies Android MainActivity never falls back to super.onPermissionRequest and executes KikiShellPlugin handleWebPermissionRequest + legacy migration via JDK (F1, F3, F5)', () => {
    const mainActivity = readFileSync(
      join(mobileRoot, 'android/app/src/main/java/ai/easyagent/kiki/MainActivity.java'),
      'utf8',
    );
    expect(mainActivity).toContain('onPermissionRequest');
    expect(mainActivity).toContain('handleWebPermissionRequest');
    expect(mainActivity).not.toContain('super.onPermissionRequest');
    expect(mainActivity).toContain('onShowFileChooser');
    expect(mainActivity).toContain('ACTION_IMAGE_CAPTURE');
    expect(mainActivity).toContain('--kiki-ime-height');
    expect(mainActivity).toContain('WindowInsetsAnimationCompat');

    const javaPlugin = readFileSync(
      join(mobileRoot, 'android/app/src/main/java/ai/easyagent/kiki/KikiShellPlugin.java'),
      'utf8',
    );
    expect(javaPlugin).toContain('kiki:host-back');
    expect(javaPlugin).toContain('PermissionRequest.RESOURCE_VIDEO_CAPTURE');
    expect(javaPlugin).toContain('kiki-handshake-invited-v1:');
    expect(javaPlugin).toContain('upgradeOriginForTlsPin');
    expect(javaPlugin).toContain('upgradeEntryForTlsPin');
    expect(javaPlugin).toContain('legacyHttpOriginForHttps');

    function sliceBetween(start: string, end: string): string {
      const from = javaPlugin.indexOf(start);
      const to = javaPlugin.indexOf(end, from);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);
      return javaPlugin.slice(from, to);
    }
    const permMethod = sliceBetween('    boolean handleWebPermissionRequest', '    @PluginMethod\n    public void scanQr');
    const verifiedAndForget = sliceBetween('    private static String scopedTokenId', '    static String normalizeFingerprint');
    const pinMethods = sliceBetween('    static String normalizeFingerprint', '    static String certificateSpkiSha256Hex');
    const pinStore = sliceBetween('    private void savePinnedFingerprint', '    private void configurePinnedTls');
    const originHelpers = sliceBetween('    private static boolean isWebOrigin(Uri uri)', '\n}');

    const tempDir = mkdtempSync(join(tmpdir(), 'kiki-java-f1-f3-'));
    try {
      const harness = `import java.net.URI;
import java.util.*;

public class JavaF1F3Check {
    private static final String TRUSTED_ORIGIN = "trustedOrigin";
    private static final String TOKEN_PREFIX = "token.";
    private static final String LEGACY_TOKEN_PREFIX = "legacy.";
    private static final String HOST_ID_PREFIX = "host.";
    private static final String GRANT_ID_PREFIX = "grant.";
    private static final String VERIFIED_ORIGINS_PREFIX = "verified.";
    private static final String TLS_FP_PREFIX = "tlsFp.";
    private static final String ORIGIN_TLS_FP_PREFIX = "originTlsFp.";

    static final class Uri {
        private final URI inner;
        Uri(URI u) { this.inner = u; }
        static Uri parse(String s) { return new Uri(URI.create(s)); }
        String getScheme() { return inner.getScheme(); }
        String getHost() { return inner.getHost(); }
        int getPort() { return inner.getPort(); }
        String getUserInfo() { return inner.getUserInfo(); }
        @Override public String toString() { return inner.toString(); }
    }
    static final class Manifest {
        static final class permission {
            static final String CAMERA = "android.permission.CAMERA";
        }
    }
    static final class PackageManager {
        static final int PERMISSION_GRANTED = 0;
        static final int PERMISSION_DENIED = -1;
    }
    static final class ContextCompat {
        static int camPermission = PackageManager.PERMISSION_GRANTED;
        static int checkSelfPermission(Object ctx, String perm) { return camPermission; }
    }
    static final class PermissionRequest {
        static final String RESOURCE_VIDEO_CAPTURE = "android.webkit.resource.VIDEO_CAPTURE";
        static final String RESOURCE_AUDIO_CAPTURE = "android.webkit.resource.AUDIO_CAPTURE";
        final Uri origin;
        final String[] resources;
        boolean denied = false;
        String[] granted = null;
        PermissionRequest(Uri origin, String[] resources) { this.origin = origin; this.resources = resources; }
        Uri getOrigin() { return origin; }
        String[] getResources() { return resources; }
        void deny() { denied = true; }
        void grant(String[] res) { granted = res; }
    }
    static final class Bridge {
        String getLocalUrl() { return "https://localhost"; }
    }
    static final class SharedPreferences {
        final Map<String, Object> map = new HashMap<>();
        boolean contains(String k) { return map.containsKey(k); }
        String getString(String k, String def) {
            Object v = map.get(k);
            return v instanceof String ? (String) v : def;
        }
        @SuppressWarnings("unchecked")
        Set<String> getStringSet(String k, Set<String> def) {
            Object v = map.get(k);
            return v instanceof Set ? (Set<String>) v : def;
        }
        Editor edit() { return new Editor(map); }
        static final class Editor {
            final Map<String, Object> map;
            Editor(Map<String, Object> m) { this.map = m; }
            Editor putString(String k, String v) { map.put(k, v); return this; }
            Editor putStringSet(String k, Set<String> v) { map.put(k, new HashSet<>(v)); return this; }
            Editor remove(String k) { map.remove(k); return this; }
            void apply() {}
        }
    }

    private final Bridge bridge = new Bridge();
    private final SharedPreferences sp = new SharedPreferences();
    private Bridge getBridge() { return bridge; }
    private Object getContext() { return this; }
    private SharedPreferences prefs() { return sp; }
    private void clearPendingAuth() {}
    private void clearActiveAuth() {}

${permMethod}
${verifiedAndForget}
${pinMethods}
${pinStore}
${originHelpers}

    private static void check(boolean cond, String msg) {
        if (!cond) throw new AssertionError(msg);
    }

    public static void main(String[] args) {
        JavaF1F3Check p = new JavaF1F3Check();
        // F1: remote origin MUST be denied, never fall through
        PermissionRequest remoteReq = new PermissionRequest(Uri.parse("https://evil.example.test"), new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        check(p.handleWebPermissionRequest(remoteReq), "remote request handled");
        check(remoteReq.denied && remoteReq.granted == null, "remote origin must be denied");

        // F1: mixed VIDEO + AUDIO on local origin MUST be denied
        PermissionRequest mixedReq = new PermissionRequest(Uri.parse("https://localhost"), new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE, PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        check(p.handleWebPermissionRequest(mixedReq), "mixed request handled");
        check(mixedReq.denied && mixedReq.granted == null, "audio resource must be denied");

        // F1: local origin with OS CAMERA denied MUST be denied
        ContextCompat.camPermission = PackageManager.PERMISSION_DENIED;
        PermissionRequest noPermReq = new PermissionRequest(Uri.parse("https://localhost"), new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        check(p.handleWebPermissionRequest(noPermReq), "denied-os request handled");
        check(noPermReq.denied && noPermReq.granted == null, "camera denied when OS permission missing");

        // F1: local origin + OS CAMERA granted + VIDEO only -> granted
        ContextCompat.camPermission = PackageManager.PERMISSION_GRANTED;
        PermissionRequest okReq = new PermissionRequest(Uri.parse("https://localhost"), new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        check(p.handleWebPermissionRequest(okReq), "local video request handled");
        check(!okReq.denied && okReq.granted != null && okReq.granted.length == 1 && PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(okReq.granted[0]), "local video must be granted");

        // F3: legacy pinned http:// migrates to https://, while unpinned http:// does NOT migrate
        String fp = ${JSON.stringify(vectors.spkiPin.spkiSha256Hex)};
        p.sp.edit()
            .putString(TLS_FP_PREFIX + "home-1@http://100.64.0.10:58627", fp)
            .putString(ORIGIN_TLS_FP_PREFIX + "http://100.64.0.10:58627", fp)
            .putString(TOKEN_PREFIX + "home-1@http://100.64.0.10:58627", "enc-token")
            .putStringSet(VERIFIED_ORIGINS_PREFIX + "home-1", new HashSet<>(Arrays.asList("http://100.64.0.10:58627", "http://192.168.10.40:58627")))
            .apply();

        check(fp.equals(p.resolvePinnedFingerprint("home-1", "https://100.64.0.10:58627")), "legacy pin resolved and migrated");
        check(p.isOriginVerified("home-1", "https://100.64.0.10:58627"), "legacy pinned http verifiedOrigin migrated to https");
        check(p.hasStoredToken("home-1", "https://100.64.0.10:58627"), "legacy pinned http token matched for https");
        check(!p.isOriginVerified("home-1", "https://192.168.10.40:58627"), "unpinned http origin must NOT migrate to https");
        check(p.isOriginVerified("home-1", "http://192.168.10.40:58627"), "unpinned http origin remains verified as http");

        p.forgetServerData("home-1", "https://100.64.0.10:58627");
        check(!p.sp.contains(TOKEN_PREFIX + "home-1@http://100.64.0.10:58627"), "forgetServerData cleans legacy http token");
        check(!p.sp.contains(ORIGIN_TLS_FP_PREFIX + "http://100.64.0.10:58627"), "forgetServerData cleans legacy http pin");
    }
}
`;
      const javaFile = join(tempDir, 'JavaF1F3Check.java');
      writeFileSync(javaFile, harness);
      const compiled = spawnSync(findJdkTool('javac'), ['-d', tempDir, javaFile], { encoding: 'utf8' });
      expect(compiled.status, `javac stderr: ${compiled.stderr}`).toBe(0);
      const ran = spawnSync(findJdkTool('java'), ['-cp', tempDir, 'JavaF1F3Check'], { encoding: 'utf8' });
      expect(ran.status, `java stderr: ${ran.stderr || ran.stdout}`).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const swiftScene = readFileSync(
      join(mobileRoot, 'ios/App/App/SceneDelegate.swift'),
      'utf8',
    );
    expect(swiftScene).toContain('kiki-handshake-invited-v1:');
    expect(swiftScene).toContain('mutualInvitedVerified');
    expect(swiftScene).toContain('upgradeOriginForTlsPin');
    expect(swiftScene).toContain('upgradeEntryForTlsPin');
    expect(swiftScene).toContain('verifyHandshakeDomain');
    expect(swiftScene).toContain('expectedStatus');

    const swiftPinning = readFileSync(
      join(mobileRoot, 'ios/App/App/KikiTlsPinning.swift'),
      'utf8',
    );
    expect(swiftPinning).toContain('legacyHttpOriginForHttps');
  });
});
