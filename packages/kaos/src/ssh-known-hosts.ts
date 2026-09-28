import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'pathe';

export interface UnknownSshKey {
  readonly hostname: string;
  readonly port: number;
  readonly algorithm: string;
  readonly fingerprint: string;
}

export type TrustUnknownKey = (key: UnknownSshKey) => Promise<boolean>;

function hostLabel(hostname: string, port: number): string {
  return port === 22 ? hostname : `[${hostname}]:${port}`;
}

function matchesHost(pattern: string, label: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, version, salt, digest] = pattern.split('|');
    if (version !== '1' || !salt || !digest) return false;
    const expected = Buffer.from(digest, 'base64');
    const observed = createHmac('sha1', Buffer.from(salt, 'base64')).update(label).digest();
    return expected.length === observed.length && timingSafeEqual(expected, observed);
  }
  const regex = new RegExp(`^${pattern.replaceAll(/[|\\{}()[\]^$+?.*]/g, (char) => {
    if (char === '*') return '.*';
    if (char === '?') return '.';
    return `\\${char}`;
  })}$`, 'i');
  return regex.test(label);
}

function matchingEntries(text: string, label: string): { marker?: string; algorithm: string; key: string }[] {
  const results: { marker?: string; algorithm: string; key: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.trim().split(/\s+/);
    const marker = fields[0]?.startsWith('@') ? fields.shift() : undefined;
    const hosts = fields.shift();
    const algorithm = fields.shift();
    const key = fields.shift();
    if (!hosts || !algorithm || !key) continue;
    const patterns = hosts.split(',');
    if (patterns.some((pattern) => pattern.startsWith('!') && matchesHost(pattern.slice(1), label))) continue;
    if (patterns.some((pattern) => !pattern.startsWith('!') && matchesHost(pattern, label))) {
      results.push({ marker, algorithm, key });
    }
  }
  return results;
}

export class SshKnownHosts {
  private static readonly pendingByFile = new Map<string, Promise<void>>();

  constructor(private readonly files: readonly string[] = [join(homedir(), '.ssh', 'known_hosts')]) {
    if (files.length === 0) throw new Error('At least one known_hosts path is required');
  }

  private async entries(label: string): Promise<ReturnType<typeof matchingEntries>> {
    const all = await Promise.all(this.files.map(async (file) => {
      try {
        return matchingEntries(await readFile(file, 'utf8'), label);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }));
    return all.flat();
  }

  async verify(hostname: string, port: number, rawKey: Buffer, trustUnknown: TrustUnknownKey): Promise<boolean> {
    const size = rawKey.length >= 4 ? rawKey.readUInt32BE(0) : 0;
    if (size < 1 || size > 128 || size + 4 > rawKey.length) throw new Error('Invalid SSH server key');
    const algorithm = rawKey.subarray(4, 4 + size).toString('ascii');
    if (!/^[a-zA-Z0-9@._+-]+$/.test(algorithm)) throw new Error('Invalid SSH key algorithm');
    const label = hostLabel(hostname, port);
    const fingerprint = `SHA256:${createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`;
    const check = async (): Promise<'matching' | 'changed' | 'unknown'> => {
      const entries = await this.entries(label);
      if (entries.some((entry) => entry.marker === '@revoked')) return 'changed';
      if (entries.some((entry) => entry.marker === '@cert-authority')) return 'changed';
      if (entries.some((entry) => entry.algorithm === algorithm && entry.key === rawKey.toString('base64'))) return 'matching';
      return entries.length > 0 ? 'changed' : 'unknown';
    };
    const existing = await check();
    if (existing === 'matching') return true;
    if (existing === 'changed') throw new Error(`SSH host key changed for ${label}; verify it out of band before editing known_hosts`);
    if (!await trustUnknown({ hostname, port, algorithm, fingerprint })) return false;
    const target = this.files[0]!;
    const previous = SshKnownHosts.pendingByFile.get(target) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    SshKnownHosts.pendingByFile.set(target, pending);
    await previous;
    try {
      const current = await check();
      if (current === 'matching') return true;
      if (current === 'changed') throw new Error(`SSH host key changed for ${label}`);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await appendFile(target, `${label} ${algorithm} ${rawKey.toString('base64')}\n`, { mode: 0o600 });
      return true;
    } finally {
      release();
      if (SshKnownHosts.pendingByFile.get(target) === pending) SshKnownHosts.pendingByFile.delete(target);
    }
  }
}
