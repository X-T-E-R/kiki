import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'pathe';
import ssh2 from 'ssh2';

export interface SshKnownHostRecord {
  readonly file: string;
  readonly line: number;
  readonly hostPattern: string;
  readonly algorithm: string;
  readonly fingerprint?: string;
  readonly marker?: string;
  readonly status: 'recorded' | 'revoked' | 'unsupported' | 'invalid';
  readonly reason?: string;
}

export interface SshKnownHostsInspection {
  readonly hostname: string;
  readonly port: number;
  readonly label: string;
  readonly state: 'recorded' | 'unrecorded' | 'unavailable';
  readonly records: readonly SshKnownHostRecord[];
  readonly files: readonly { readonly path: string; readonly state: 'read' | 'missing' | 'unavailable'; readonly reason?: string }[];
}

export type SshKnownHostVerificationReason =
  | 'key_changed'
  | 'key_algorithm_unrecorded'
  | 'revoked'
  | 'certificate_authority_unsupported';

export type SshKnownHostVerificationStatus = 'matching' | 'unknown' | SshKnownHostVerificationReason;

export class SshKnownHostVerificationError extends Error {
  readonly code: SshKnownHostVerificationReason;
  readonly reason: SshKnownHostVerificationReason;
  readonly status: SshKnownHostVerificationReason;

  constructor(reason: SshKnownHostVerificationReason, message: string) {
    super(message);
    this.name = 'SshKnownHostVerificationError';
    this.code = reason;
    this.reason = reason;
    this.status = reason;
  }
}

export interface UnknownSshKey {
  readonly hostname: string;
  readonly port: number;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly reason?: 'key_algorithm_unrecorded';
  readonly status?: 'unknown' | 'key_algorithm_unrecorded';
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

function matchingEntries(text: string, label: string, issues?: string[]): { marker?: string; algorithm: string; key: string; line: number; hostPattern: string }[] {
  const results: ReturnType<typeof matchingEntries> = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.trim().split(/\s+/);
    const marker = fields[0]?.startsWith('@') ? fields.shift() : undefined;
    const hosts = fields.shift();
    const algorithm = fields.shift();
    const key = fields.shift();
    if (!hosts || issues === undefined && (!algorithm || !key)) continue;
    const patterns = hosts.split(',');
    if (patterns.some((pattern) => /^!?\|/.test(pattern) && !/^!?\|1\|[^|]+\|[^|]+$/.test(pattern))) {
      issues?.push(`unsupported-host-hash:line:${index + 1}`);
    }
    if (patterns.some((pattern) => pattern.startsWith('!') && matchesHost(pattern.slice(1), label))) continue;
    if (patterns.some((pattern) => !pattern.startsWith('!') && matchesHost(pattern, label))) {
      if (!algorithm || !key) {
        issues?.push(`invalid-record:line:${index + 1}`);
        continue;
      }
      results.push({ marker, algorithm, key, line: index + 1, hostPattern: hosts });
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

  async inspect(hostname: string, port: number): Promise<SshKnownHostsInspection> {
    const label = hostLabel(hostname, port);
    const records: SshKnownHostRecord[] = [];
    const files: SshKnownHostsInspection['files'][number][] = [];
    for (const file of this.files) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        files.push({ path: file, state: code === 'ENOENT' ? 'missing' : 'unavailable', reason: code ?? 'read-failed' });
        continue;
      }
      const issues: string[] = [];
      const entries = matchingEntries(text, label, issues);
      files.push({ path: file, state: issues.length > 0 ? 'unavailable' : 'read', reason: issues.length > 0 ? issues.join(';') : undefined });
      for (const entry of entries) {
        const parsed = ssh2.utils.parseKey(`${entry.algorithm} ${entry.key}`);
        const key = parsed instanceof Error || Array.isArray(parsed) ? undefined : parsed.getPublicSSH();
        const valid = key !== undefined && key.toString('base64') === entry.key;
        const status = !valid ? 'invalid' : entry.marker === '@revoked' ? 'revoked'
          : entry.marker === undefined ? 'recorded' : 'unsupported';
        records.push({ file, line: entry.line, hostPattern: entry.hostPattern, algorithm: entry.algorithm,
          fingerprint: valid ? `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` : undefined,
          marker: entry.marker, status,
          reason: !valid ? 'invalid-public-key' : status === 'unsupported' ? `unsupported-marker:${entry.marker}` : undefined });
      }
    }
    const unavailable = files.some((file) => file.state === 'unavailable') ||
      records.some((record) => record.status === 'unsupported' || record.status === 'invalid');
    return { hostname, port, label, state: unavailable ? 'unavailable' : records.length > 0 ? 'recorded' : 'unrecorded', records, files };
  }

  async verify(hostname: string, port: number, rawKey: Buffer, trustUnknown: TrustUnknownKey): Promise<boolean> {
    const size = rawKey.length >= 4 ? rawKey.readUInt32BE(0) : 0;
    if (size < 1 || size > 128 || size + 4 > rawKey.length) throw new Error('Invalid SSH server key');
    const algorithm = rawKey.subarray(4, 4 + size).toString('ascii');
    if (!/^[a-zA-Z0-9@._+-]+$/.test(algorithm)) throw new Error('Invalid SSH key algorithm');
    const label = hostLabel(hostname, port);
    const fingerprint = `SHA256:${createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`;
    const encodedKey = rawKey.toString('base64');
    const check = async (): Promise<SshKnownHostVerificationStatus> => {
      const entries = await this.entries(label);
      const exact = entries.filter((entry) => entry.algorithm === algorithm && entry.key === encodedKey);
      if (exact.some((entry) => entry.marker === '@revoked')) return 'revoked';
      if (exact.some((entry) => entry.marker === '@cert-authority')) return 'certificate_authority_unsupported';
      if (exact.some((entry) => entry.marker === undefined)) return 'matching';
      if (entries.some((entry) => entry.marker === '@cert-authority')) return 'certificate_authority_unsupported';
      const trusted = entries.filter((entry) => entry.marker === undefined);
      if (trusted.some((entry) => entry.algorithm === algorithm)) return 'key_changed';
      return trusted.length > 0 ? 'key_algorithm_unrecorded' : 'unknown';
    };
    const existing = await check();
    if (existing === 'matching') return true;
    if (existing === 'revoked') throw new SshKnownHostVerificationError('revoked', `SSH host key is revoked for ${label}`);
    if (existing === 'certificate_authority_unsupported') {
      throw new SshKnownHostVerificationError(
        'certificate_authority_unsupported',
        `SSH certificate-authority known_hosts records are unsupported for ${label}`,
      );
    }
    if (existing === 'key_changed') {
      throw new SshKnownHostVerificationError(
        'key_changed',
        `SSH host key changed for ${label}; verify it out of band before editing known_hosts`,
      );
    }
    const reason = existing === 'key_algorithm_unrecorded' ? 'key_algorithm_unrecorded' : undefined;
    if (!await trustUnknown({ hostname, port, algorithm, fingerprint, reason, status: reason ?? 'unknown' })) return false;
    const target = this.files[0]!;
    const previous = SshKnownHosts.pendingByFile.get(target) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    SshKnownHosts.pendingByFile.set(target, pending);
    await previous;
    try {
      const current = await check();
      if (current === 'matching') return true;
      if (current === 'revoked') throw new SshKnownHostVerificationError('revoked', `SSH host key is revoked for ${label}`);
      if (current === 'certificate_authority_unsupported') {
        throw new SshKnownHostVerificationError(
          'certificate_authority_unsupported',
          `SSH certificate-authority known_hosts records are unsupported for ${label}`,
        );
      }
      if (current === 'key_changed') {
        throw new SshKnownHostVerificationError('key_changed', `SSH host key changed for ${label}`);
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await appendFile(target, `${label} ${algorithm} ${rawKey.toString('base64')}\n`, { mode: 0o600 });
      return true;
    } finally {
      release();
      if (SshKnownHosts.pendingByFile.get(target) === pending) SshKnownHosts.pendingByFile.delete(target);
    }
  }
}
