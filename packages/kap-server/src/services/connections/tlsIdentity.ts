import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';

export interface PeerTlsIdentity { key: string; cert: string; tlsFingerprint: string }
const CERT_VALIDITY_DAYS = 800;
const CERT_RENEW_WINDOW_MS = 30 * 86400000;
export function spkiFingerprint(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length < 128 ? Buffer.from([body.length]) : (() => {
    const bytes: number[] = []; let n = body.length;
    while (n > 0) { bytes.unshift(n & 255); n >>>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
function asn1Time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const year = date.getUTCFullYear();
  if (year >= 1950 && year <= 2049) return der(0x17, Buffer.from(iso.slice(2), 'ascii'));
  return der(0x18, Buffer.from(iso, 'ascii'));
}
function readDerElement(buf: Buffer, offset: number): { tag: number; contentStart: number; contentEnd: number; next: number } | null {
  if (offset + 2 > buf.length) return null;
  const tag = buf[offset]!;
  const lenByte = buf[offset + 1]!;
  let len = 0;
  let contentStart = offset + 2;
  if ((lenByte & 0x80) === 0) {
    len = lenByte;
  } else {
    const count = lenByte & 0x7f;
    if (count === 0 || count > 4 || contentStart + count > buf.length) return null;
    for (let i = 0; i < count; i += 1) len = len * 256 + buf[contentStart + i]!;
    contentStart += count;
  }
  const contentEnd = contentStart + len;
  if (contentEnd > buf.length) return null;
  return { tag, contentStart, contentEnd, next: contentEnd };
}
function hasValidRfc5280Validity(raw: Buffer): boolean {
  const cert = readDerElement(raw, 0);
  if (cert === null || cert.tag !== 0x30) return false;
  const tbs = readDerElement(raw, cert.contentStart);
  if (tbs === null || tbs.tag !== 0x30) return false;
  let cursor = tbs.contentStart;
  const first = readDerElement(raw, cursor);
  if (first === null) return false;
  if (first.tag === 0xa0) cursor = first.next;
  for (let i = 0; i < 3; i += 1) {
    const field = readDerElement(raw, cursor);
    if (field === null || field.next > tbs.contentEnd) return false;
    cursor = field.next;
  }
  const validity = readDerElement(raw, cursor);
  if (validity === null || validity.tag !== 0x30 || validity.next > tbs.contentEnd) return false;
  const notBefore = readDerElement(raw, validity.contentStart);
  if (notBefore === null) return false;
  const notAfter = readDerElement(raw, notBefore.next);
  if (notAfter === null || notAfter.next !== validity.contentEnd) return false;
  for (const el of [notBefore, notAfter]) {
    const text = raw.subarray(el.contentStart, el.contentEnd).toString('ascii');
    if (el.tag === 0x17) {
      if (!/^\d{12}Z$/.test(text)) return false;
    } else if (el.tag === 0x18) {
      if (!/^\d{14}Z$/.test(text)) return false;
      const year = Number(text.slice(0, 4));
      if (year >= 1950 && year <= 2049) return false;
    } else {
      return false;
    }
  }
  return true;
}
function needsCertificateRepair(certificate: X509Certificate, now = Date.now()): boolean {
  if (!hasValidRfc5280Validity(certificate.raw)) return true;
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) return true;
  if (validTo - now < CERT_RENEW_WINDOW_MS) return true;
  return false;
}
function signCertificate(privateKey: KeyObject, publicKey: KeyObject, now = Date.now()): string {
  const algorithm = sequence(oid('2a8648ce3d040302'));
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Kiki Peer')))));
  const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 1;
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name,
    sequence(asn1Time(new Date(now - 86400000)), asn1Time(new Date(now + CERT_VALIDITY_DAYS * 86400000))), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}
function generate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert: signCertificate(privateKey, publicKey) };
}
export async function loadPeerTlsIdentity(homeDir: string): Promise<PeerTlsIdentity> {
  const path = join(homeDir, 'server', 'peer-tls.json');
  let stored: { key: string; cert: string };
  try { stored = JSON.parse((await readPrivateFile(path)).toString('utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    stored = generate();
    await writePrivateFile(path, JSON.stringify(stored));
  }
  let certificate = new X509Certificate(stored.cert);
  const privateKey = createPrivateKey(stored.key);
  const publicKey = createPublicKey(privateKey);
  const expectedFingerprint = spkiFingerprint(publicKey);
  if (!certificate.verify(certificate.publicKey) || expectedFingerprint !== spkiFingerprint(certificate.publicKey)) throw new Error('Invalid peer TLS identity');
  if (needsCertificateRepair(certificate)) {
    stored = { key: stored.key, cert: signCertificate(privateKey, publicKey) };
    await writePrivateFile(path, JSON.stringify(stored));
    certificate = new X509Certificate(stored.cert);
    if (!certificate.verify(certificate.publicKey) || expectedFingerprint !== spkiFingerprint(certificate.publicKey)) throw new Error('Invalid peer TLS identity');
  }
  return { ...stored, tlsFingerprint: expectedFingerprint };
}
