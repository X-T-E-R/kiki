import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';

export interface PeerTlsIdentity { key: string; cert: string; tlsFingerprint: string }
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
const time = (date: Date) => der(0x18, Buffer.from(date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')));
function generate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(oid('2a8648ce3d040302'));
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Kiki Peer')))));
  const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 1;
  const now = Date.now();
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name,
    sequence(time(new Date(now - 86400000)), time(new Date(now + 20 * 366 * 86400000))), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n` };
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
  const certificate = new X509Certificate(stored.cert);
  const privateKey = createPrivateKey(stored.key);
  if (!certificate.verify(certificate.publicKey) || spkiFingerprint(createPublicKey(privateKey)) !== spkiFingerprint(certificate.publicKey)) throw new Error('Invalid peer TLS identity');
  return { ...stored, tlsFingerprint: spkiFingerprint(certificate.publicKey) };
}
