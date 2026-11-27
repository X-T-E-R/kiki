import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { relayCanonicalOriginPath } from '@kiki/protocol';

export interface SignedRelayHostChallenge {
  readonly fp: string;
  readonly spkiDerBase64: string;
  readonly signatureBase64: string;
}

/** Signs a domain-separated `kiki-relay-host-v1` challenge using the local P-256 `PeerTlsIdentity` private key. */
export function signRelayHostChallenge(
  privateKeyPem: string,
  relayBaseUrl: string,
  nonce: string,
  ts: number,
): SignedRelayHostChallenge {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const fp = createHash('sha256').update(spkiDer).digest('hex');
  const originPath = relayCanonicalOriginPath(relayBaseUrl);
  const preimage = Buffer.from(`kiki-relay-host-v1:${originPath}:${fp}:${nonce}:${ts}`, 'utf8');
  const signature = sign('sha256', preimage, privateKey);
  return {
    fp,
    spkiDerBase64: spkiDer.toString('base64'),
    signatureBase64: signature.toString('base64'),
  };
}

/** Mints a time-bounded pairing relay ticket (`p.<expEpochSec>.<hmac>`). */
export function mintRelayPairingTicket(
  capKeyHex: string,
  fp: string,
  expEpochSec: number,
): string {
  const mac = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
    .update(`pair:${fp}:${expEpochSec}`, 'utf8')
    .digest('hex');
  return `p.${expEpochSec}.${mac}`;
}

/** Mints a durable grant-bound relay ticket (`g.<grantId>.<hmac>`). */
export function mintRelayGrantTicket(
  capKeyHex: string,
  fp: string,
  grantId: string,
): string {
  const mac = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
    .update(`grant:${fp}:${grantId}`, 'utf8')
    .digest('hex');
  return `g.${grantId}.${mac}`;
}

/** Mints a single-use pre-warmed pool authentication token (`HMAC(capKey, "pool:<fp>:<nonce>:<ticket>")`). */
export function mintRelayPoolToken(
  capKeyHex: string,
  fp: string,
  nonce: string,
  ticket = '',
): string {
  return createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
    .update(`pool:${fp}:${nonce}:${ticket}`, 'utf8')
    .digest('hex');
}

/** Verifies a pairing or durable grant ticket against `capKeyHex` in constant time. */
export function verifyRelayStreamTicket(
  capKeyHex: string,
  fp: string,
  ticket: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const parts = ticket.split('.');
  if (parts.length !== 3) return false;
  const [kind, idOrExp, macHex] = parts;
  if (macHex === undefined || !/^[a-f0-9]{64}$/i.test(macHex)) return false;
  let expectedHex: string;
  if (kind === 'p') {
    if (idOrExp === undefined || !/^\d{1,12}$/.test(idOrExp)) return false;
    const expSec = Number(idOrExp);
    if (!Number.isSafeInteger(expSec) || expSec < nowSec || expSec > nowSec + 86_400) return false;
    expectedHex = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
      .update(`pair:${fp}:${expSec}`, 'utf8')
      .digest('hex');
  } else if (kind === 'g') {
    if (idOrExp === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(idOrExp)) return false;
    expectedHex = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
      .update(`grant:${fp}:${idOrExp}`, 'utf8')
      .digest('hex');
  } else {
    return false;
  }
  return timingSafeEqual(Buffer.from(macHex.toLowerCase(), 'hex'), Buffer.from(expectedHex, 'hex'));
}

/** Builds a ticketed client WebSocket stream URL (`wss://.../v1/stream?target=<fp>&rt=<ticket>`). */
export function buildRelayStreamEndpoint(
  relayBaseUrl: string,
  fp: string,
  ticket: string,
): string {
  const base = relayBaseUrl.replace(/\/+$/, '');
  return `${base}/v1/stream?target=${encodeURIComponent(fp)}&rt=${encodeURIComponent(ticket)}`;
}

/** Builds a display-safe client stream URL omitting ticket material. */
export function buildRelayPublishedBaseStreamUrl(relayBaseUrl: string, fp: string): string {
  const base = relayBaseUrl.replace(/\/+$/, '');
  return `${base}/v1/stream?target=${encodeURIComponent(fp)}`;
}
