import { isIP } from 'node:net';

/** Removes surrounding brackets from an IPv6 host literal. */
export function stripHostBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Returns whether a host string is an explicit loopback host (`localhost`, `127.0.0.1`, or `::1`). */
export function isExplicitLoopbackHost(hostname: string): boolean {
  const bare = stripHostBrackets(hostname).toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

function ipv4FromHextets(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function expandIpv6Hextets(bare: string): readonly number[] | undefined {
  let normalized = bare;
  try {
    normalized = new URL(`https://[${bare}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return undefined;
  }
  if (!normalized.includes('::')) {
    const parts = normalized.split(':');
    if (parts.length !== 8) return undefined;
    const nums = parts.map((part) => Number.parseInt(part, 16));
    return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? undefined : nums;
  }
  const halves = normalized.split('::');
  if (halves.length !== 2) return undefined;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves[1] === '' ? [] : halves[1]!.split(':');
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return undefined;
  const full = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (full.length !== 8) return undefined;
  const nums = full.map((part) => Number.parseInt(part || '0', 16));
  return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? undefined : nums;
}

/** Checks whether an IPv4 address falls into a private, loopback, link-local, CGNAT, benchmark, or reserved range. */
export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

/** Checks whether an IPv4 or IPv6 address (including IPv4-mapped, NAT64, 6to4, and Teredo embeddings) is blocked for SSRF protection. */
export function isBlockedIp(rawIp: string): boolean {
  const bare = stripHostBrackets(rawIp).split('%')[0]!.toLowerCase();
  const kind = isIP(bare);
  if (kind === 4) return isBlockedIpv4(bare);
  if (kind !== 6) return true;
  const hextets = expandIpv6Hextets(bare);
  if (hextets === undefined) return true;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [number, number, number, number, number, number, number, number];
  const allZeroPrefix6 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;
  if (allZeroPrefix6 && h6 === 0 && (h7 === 0 || h7 === 1)) return true;
  if ((h0 & 0xfe00) === 0xfc00) return true;
  if ((h0 & 0xffc0) === 0xfe80) return true;
  if ((h0 & 0xffc0) === 0xfec0) return true;
  if ((h0 & 0xff00) === 0xff00) return true;
  if (h0 === 0x2001 && h1 === 0x0db8) return true;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return isBlockedIpv4(ipv4FromHextets(h6, h7));
  }
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
    return isBlockedIpv4(ipv4FromHextets(h6, h7));
  }
  if (allZeroPrefix6) {
    return isBlockedIpv4(ipv4FromHextets(h6, h7));
  }
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isBlockedIpv4(ipv4FromHextets(h6, h7));
  }
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0x0001) {
    return true;
  }
  if (h0 === 0x2002) {
    return isBlockedIpv4(ipv4FromHextets(h1, h2));
  }
  if (h0 === 0x2001 && h1 === 0x0000) {
    const serverIpv4 = ipv4FromHextets(h2, h3);
    const clientIpv4 = ipv4FromHextets((~h6) & 0xffff, (~h7) & 0xffff);
    return isBlockedIpv4(serverIpv4) || isBlockedIpv4(clientIpv4);
  }
  return false;
}

/** Checks whether an IPv4 or IPv4-mapped IPv6 address falls in the RFC 2544 / Fake-IP benchmark range (`198.18.0.0/15`). */
export function isFakeIpAddress(rawIp: string): boolean {
  const bare = stripHostBrackets(rawIp).split('%')[0]!.toLowerCase();
  const kind = isIP(bare);
  if (kind === 4) {
    const parts = bare.split('.').map((part) => Number(part));
    return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
  }
  if (kind !== 6) return false;
  const hextets = expandIpv6Hextets(bare);
  if (hextets === undefined) return false;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [number, number, number, number, number, number, number, number];
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    const hi = (h6 >> 8) & 0xff;
    const lo = h6 & 0xff;
    void h7;
    return hi === 198 && (lo === 18 || lo === 19);
  }
  return false;
}
