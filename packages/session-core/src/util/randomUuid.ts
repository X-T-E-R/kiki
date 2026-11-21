const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));

/**
 * Generates an RFC-4122 v4 UUID even in non-secure HTTP contexts (such as LAN
 * `http://192.168.x.x` mobile browsers or WebViews) where `crypto.randomUUID`
 * is undefined. Prefers `crypto.randomUUID`, then `crypto.getRandomValues`,
 * and falls back to `Math.random` only when Web Crypto is absent.
 */
export function randomUuid(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return (
    `${HEX[bytes[0]!]!}${HEX[bytes[1]!]!}${HEX[bytes[2]!]!}${HEX[bytes[3]!]!}-` +
    `${HEX[bytes[4]!]!}${HEX[bytes[5]!]!}-` +
    `${HEX[bytes[6]!]!}${HEX[bytes[7]!]!}-` +
    `${HEX[bytes[8]!]!}${HEX[bytes[9]!]!}-` +
    `${HEX[bytes[10]!]!}${HEX[bytes[11]!]!}${HEX[bytes[12]!]!}${HEX[bytes[13]!]!}${HEX[bytes[14]!]!}${HEX[bytes[15]!]!}`
  );
}
