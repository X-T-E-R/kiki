import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
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
  decodeQrFromImageData: (data: Uint8ClampedArray, width: number, height: number) => string;
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

  it('verifies Android MainActivity WebChromeClient camera grant and iOS SceneDelegate.swift P0/P1 contracts', () => {
    const mainActivity = readFileSync(
      join(mobileRoot, 'android/app/src/main/java/ai/easyagent/kiki/MainActivity.java'),
      'utf8',
    );
    expect(mainActivity).toContain('onPermissionRequest');
    expect(mainActivity).toContain('handleWebPermissionRequest');

    const javaPlugin = readFileSync(
      join(mobileRoot, 'android/app/src/main/java/ai/easyagent/kiki/KikiShellPlugin.java'),
      'utf8',
    );
    expect(javaPlugin).toContain('PermissionRequest.RESOURCE_VIDEO_CAPTURE');
    expect(javaPlugin).toContain('kiki-handshake-invited-v1:');
    expect(javaPlugin).toContain('upgradeOriginForTlsPin');
    expect(javaPlugin).toContain('upgradeEntryForTlsPin');

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
  });
});
