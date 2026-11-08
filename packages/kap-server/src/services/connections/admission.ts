import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { PAIRING_CODE_ALPHABET, connectionGrantSchema, normalizePairingCode, type ConnectionIdentity, type ConnectionGrant, type InboundStatus } from '@kiki/protocol';
import { generateServerToken } from '../auth/persistentToken';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';

interface StoredGrant extends Omit<ConnectionGrant, 'activeLeases'> { digest: string }
interface PairingCode { digest: string; expiresAt: number; allowBridge: boolean; failures: number; consumed: boolean; label: string }
interface State { enabled: boolean; grants: StoredGrant[]; pairingCodes: PairingCode[] }
export interface AdmittedPeer { id: string; revision: number; source: ConnectionIdentity }
export interface PeerApproval { grantId: string; revision: number; peerToken: string; target: ConnectionIdentity; allowBridge: boolean }
export class AdmissionError extends Error {
  constructor(readonly status: number, readonly reason: string) { super(reason); }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function readPairingCodes(value: unknown): PairingCode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid pairing code store');
  return value.map((entry) => {
    const code = entry as Partial<PairingCode>;
    if (typeof code.digest !== 'string' || !/^[a-f0-9]{64}$/.test(code.digest) || typeof code.expiresAt !== 'number' || typeof code.allowBridge !== 'boolean' || typeof code.failures !== 'number' || typeof code.consumed !== 'boolean' || typeof code.label !== 'string') throw new Error('Invalid pairing code');
    return { digest: code.digest, expiresAt: code.expiresAt, allowBridge: code.allowBridge, failures: code.failures, consumed: code.consumed, label: code.label };
  });
}
export function sameIdentity(a: ConnectionIdentity, b: ConnectionIdentity): boolean { return a.homeId === b.homeId && a.hostId === b.hostId && a.protocol === b.protocol; }
export class ConnectionAdmission {
  private state: State = { enabled: false, grants: [], pairingCodes: [] };
  private readonly leases = new Map<string, Set<() => void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly changeListeners = new Set<(change: { kind: 'enabled' | 'revoked'; enabled: boolean; grantId?: string; source?: ConnectionIdentity }) => void | Promise<void>>();
  onDidChange(listener: (change: { kind: 'enabled' | 'revoked'; enabled: boolean; grantId?: string; source?: ConnectionIdentity }) => void | Promise<void>): { dispose(): void } {
    this.changeListeners.add(listener); return { dispose: () => { this.changeListeners.delete(listener); } };
  }
  private async emit(change: { kind: 'enabled' | 'revoked'; enabled: boolean; grantId?: string; source?: ConnectionIdentity }): Promise<void> {
    await Promise.allSettled([...this.changeListeners].map((listener) => listener(change)));
  }
  constructor(homeDir: string, readonly identity: ConnectionIdentity, readonly unavailableReason?: 'dangerous_auth_bypass') { this.path = join(homeDir, 'server', 'inbound-connections.json'); }
  private requireEnabled(): void {
    if (this.unavailableReason !== undefined) throw new AdmissionError(403, this.unavailableReason);
    if (!this.state.enabled) throw new AdmissionError(403, 'inbound_disabled');
  }
  async ready(): Promise<void> {
    try {
      const state = JSON.parse((await readPrivateFile(this.path)).toString('utf8')) as State;
      if (typeof state.enabled !== 'boolean' || !Array.isArray(state.grants)) throw new Error('Invalid admission store');
      const grants = state.grants.map((entry) => {
        const grant = connectionGrantSchema.omit({ activeLeases: true }).parse(entry);
        if (typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new Error('Invalid admission digest');
        return { ...grant, digest: entry.digest };
      });
      if (new Set(grants.map((entry) => entry.id)).size !== grants.length) throw new Error('Duplicate admission grant');
      const pairingCodes = readPairingCodes((state as { pairingCodes?: unknown }).pairingCodes);
      this.state = { enabled: state.enabled, grants, pairingCodes };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  status(): InboundStatus {
    return { enabled: this.state.enabled && this.unavailableReason === undefined, configuredEnabled: this.state.enabled, unavailableReason: this.unavailableReason, identity: this.identity, grants: this.state.grants.map(({ digest: _digest, ...entry }) => ({ ...entry, activeLeases: this.leases.get(entry.id)?.size ?? 0 })) };
  }
  setEnabled(enabled: boolean): Promise<InboundStatus> {
    return this.change(async () => {
      if (enabled && this.unavailableReason !== undefined) throw new AdmissionError(403, this.unavailableReason);
      this.state.enabled = enabled; if (!enabled) this.closeAll(); await this.emit({ kind: 'enabled', enabled: this.status().enabled }); return this.status();
    });
  }
  invite(source: ConnectionIdentity, label: string, expiresInMs = 600000): Promise<{ grant: ConnectionGrant; invitation: string }> {
    return this.change(async () => {
      this.requireEnabled();
      const invitation = generateServerToken();
      const entry: StoredGrant = { id: randomUUID(), source, target: this.identity, purpose: 'gui', revision: 1, status: 'invited', label, createdAt: Date.now(), expiresAt: Date.now() + expiresInMs, digest: digest(invitation) };
      this.state.grants.push(entry);
      return { grant: connectionGrantSchema.parse({ ...entry, activeLeases: 0 }), invitation };
    });
  }
  claim(invitation: string, source: ConnectionIdentity): Promise<{ grantId: string; revision: number; grant: string; target: ConnectionIdentity }> {
    return this.change(async () => {
      this.requireEnabled();
      const entry = this.find(invitation);
      if (entry === undefined || entry.status !== 'invited' || (entry.expiresAt ?? 0) <= Date.now()) throw new AdmissionError(401, 'invalid_invitation');
      if (!sameIdentity(source, entry.source) || !sameIdentity(this.identity, entry.target)) throw new AdmissionError(403, 'identity_changed');
      const grant = generateServerToken();
      entry.digest = digest(grant); entry.status = 'approved'; delete entry.expiresAt;
      return { grantId: entry.id, revision: entry.revision, grant, target: this.identity };
    });
  }
  revoke(id: string): Promise<InboundStatus> {
    return this.change(async () => {
      const entry = this.state.grants.find((g) => g.id === id);
      if (entry === undefined) throw new AdmissionError(404, 'grant_not_found');
      entry.status = 'revoked'; entry.revision += 1;
      this.closeGrant(id); await this.emit({ kind: 'revoked', enabled: this.state.enabled, grantId: id, source: entry.source }); return this.status();
    });
  }
  authorize(secret: string | undefined): StoredGrant {
    this.requireEnabled();
    const entry = secret === undefined ? undefined : this.find(secret);
    if (entry === undefined || entry.status !== 'approved') throw new AdmissionError(401, 'connection_not_approved');
    if (!sameIdentity(entry.target, this.identity)) throw new AdmissionError(403, 'identity_changed');
    entry.lastConnectedAt = Date.now();
    return entry;
  }
  matchBearer(secret: string): AdmittedPeer | undefined {
    const entry = this.find(secret);
    if (entry === undefined) return undefined;
    if (this.unavailableReason !== undefined) throw new AdmissionError(403, this.unavailableReason);
    if (!this.state.enabled) throw new AdmissionError(403, 'inbound_disabled');
    if (entry.status !== 'approved') throw new AdmissionError(401, 'connection_not_approved');
    if (!sameIdentity(entry.target, this.identity)) throw new AdmissionError(403, 'identity_changed');
    entry.lastConnectedAt = Date.now();
    return { id: entry.id, revision: entry.revision, source: entry.source };
  }
  createPairCode(input: { label?: string; expiresInMs?: number; allowBridge?: boolean } = {}): Promise<{ code: string; expiresAt: number; allowBridge: boolean }> {
    return this.change(async () => {
      if (this.unavailableReason !== undefined) throw new AdmissionError(403, this.unavailableReason);
      const enabled = this.state.enabled;
      this.state.enabled = true;
      if (!enabled) await this.emit({ kind: 'enabled', enabled: this.status().enabled });
      const bytes = randomBytes(8);
      let compact = '';
      for (const byte of bytes) compact += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
      const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
      const expiresAt = Date.now() + (input.expiresInMs ?? 600_000);
      for (const entry of this.state.pairingCodes) if (!entry.consumed) entry.consumed = true;
      this.state.pairingCodes.push({ digest: digest(code), expiresAt, allowBridge: input.allowBridge !== false, failures: 0, consumed: false, label: input.label ?? '' });
      if (this.state.pairingCodes.length > 32) this.state.pairingCodes = this.state.pairingCodes.slice(-32);
      return { code, expiresAt, allowBridge: input.allowBridge !== false };
    });
  }
  claimPair(raw: string, source: ConnectionIdentity, sourceLabel: string): Promise<PeerApproval> {
    return this.change(async () => {
      if (this.unavailableReason !== undefined) throw new AdmissionError(403, this.unavailableReason);
      if (!this.state.enabled) throw new AdmissionError(403, 'inbound_disabled');
      const now = Date.now();
      const code = normalizePairingCode(raw);
      const match = code === undefined ? undefined : this.pairingMatch(code);
      if (match === undefined || match.consumed || match.expiresAt <= now || match.failures >= 5) {
        this.notePairingFailure(now);
        throw new AdmissionError(401, 'invalid_pairing_code');
      }
      if (sameIdentity(source, this.identity)) {
        match.failures += 1;
        if (match.failures >= 5) match.consumed = true;
        throw new AdmissionError(409, 'identity_changed');
      }
      match.consumed = true;
      const peerToken = generateServerToken();
      const entry: StoredGrant = { id: randomUUID(), source, target: this.identity, purpose: 'gui', revision: 1, status: 'approved', label: sourceLabel, createdAt: now, digest: digest(peerToken) };
      this.state.grants.push(entry);
      return { grantId: entry.id, revision: entry.revision, peerToken, target: this.identity, allowBridge: match.allowBridge };
    });
  }
  approvePeer(source: ConnectionIdentity, label: string): Promise<PeerApproval> {
    return this.change(async () => {
      if (this.unavailableReason !== undefined) throw new AdmissionError(403, this.unavailableReason);
      const enabled = this.state.enabled;
      this.state.enabled = true;
      if (!enabled) await this.emit({ kind: 'enabled', enabled: this.status().enabled });
      if (sameIdentity(source, this.identity)) throw new AdmissionError(409, 'identity_changed');
      const peerToken = generateServerToken();
      const entry: StoredGrant = { id: randomUUID(), source, target: this.identity, purpose: 'gui', revision: 1, status: 'approved', label, createdAt: Date.now(), digest: digest(peerToken) };
      this.state.grants.push(entry);
      return { grantId: entry.id, revision: entry.revision, peerToken, target: this.identity, allowBridge: true };
    });
  }
  attach(id: string, close: () => void): () => void {
    if (!this.status().enabled || this.state.grants.find((entry) => entry.id === id)?.status !== 'approved') { close(); return () => {}; }
    const set = this.leases.get(id) ?? new Set<() => void>(); set.add(close); this.leases.set(id, set);
    return () => { set.delete(close); if (set.size === 0) this.leases.delete(id); };
  }
  activeCount(): number { return [...this.leases.values()].reduce((sum, set) => sum + set.size, 0); }
  closeAll(): void { for (const id of this.leases.keys()) this.closeGrant(id); }
  private closeGrant(id: string): void { const set = this.leases.get(id); this.leases.delete(id); for (const close of set ?? []) close(); }
  private find(secret: string): StoredGrant | undefined {
    const candidate = Buffer.from(digest(secret));
    return this.state.grants.find((entry) => { const expected = Buffer.from(entry.digest); return expected.length === candidate.length && timingSafeEqual(candidate, expected); });
  }
  private pairingMatch(code: string): PairingCode | undefined {
    const candidate = Buffer.from(digest(code));
    return this.state.pairingCodes.find((entry) => { const expected = Buffer.from(entry.digest); return expected.length === candidate.length && timingSafeEqual(candidate, expected); });
  }
  private notePairingFailure(now: number): void {
    for (const entry of this.state.pairingCodes) {
      if (entry.consumed || entry.expiresAt <= now) continue;
      entry.failures += 1;
      if (entry.failures >= 5) entry.consumed = true;
    }
  }
  private change<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { const value = await fn(); await writePrivateFile(this.path, JSON.stringify(this.state)); return value; });
    this.tail = result.catch(() => undefined); return result;
  }
}
