import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { connectionGrantSchema, type ConnectionIdentity, type ConnectionGrant, type InboundStatus } from '@kiki/protocol';
import { generateServerToken } from '../auth/persistentToken';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';

interface StoredGrant extends Omit<ConnectionGrant, 'activeLeases'> { digest: string }
interface State { enabled: boolean; grants: StoredGrant[] }
export class AdmissionError extends Error {
  constructor(readonly status: number, readonly reason: string) { super(reason); }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function sameIdentity(a: ConnectionIdentity, b: ConnectionIdentity): boolean { return a.homeId === b.homeId && a.hostId === b.hostId && a.protocol === b.protocol; }
export class ConnectionAdmission {
  private state: State = { enabled: false, grants: [] };
  private readonly leases = new Map<string, Set<() => void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly changeListeners = new Set<(change: { kind: 'enabled' | 'revoked'; enabled: boolean; grantId?: string; source?: ConnectionIdentity }) => void>();
  onDidChange(listener: (change: { kind: 'enabled' | 'revoked'; enabled: boolean; grantId?: string; source?: ConnectionIdentity }) => void): { dispose(): void } {
    this.changeListeners.add(listener); return { dispose: () => { this.changeListeners.delete(listener); } };
  }
  private emit(change: { kind: 'enabled' | 'revoked'; enabled: boolean; grantId?: string; source?: ConnectionIdentity }): void {
    for (const listener of this.changeListeners) { try { listener(change); } catch {} }
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
      this.state = { enabled: state.enabled, grants };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  status(): InboundStatus {
    return { enabled: this.state.enabled && this.unavailableReason === undefined, configuredEnabled: this.state.enabled, unavailableReason: this.unavailableReason, identity: this.identity, grants: this.state.grants.map(({ digest: _digest, ...entry }) => ({ ...entry, activeLeases: this.leases.get(entry.id)?.size ?? 0 })) };
  }
  setEnabled(enabled: boolean): Promise<InboundStatus> {
    return this.change(async () => {
      if (enabled && this.unavailableReason !== undefined) throw new AdmissionError(403, this.unavailableReason);
      this.state.enabled = enabled; if (!enabled) this.closeAll(); this.emit({ kind: 'enabled', enabled: this.status().enabled }); return this.status();
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
      this.closeGrant(id); this.emit({ kind: 'revoked', enabled: this.state.enabled, grantId: id, source: entry.source }); return this.status();
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
  private change<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { const value = await fn(); await writePrivateFile(this.path, JSON.stringify(this.state)); return value; });
    this.tail = result.catch(() => undefined); return result;
  }
}
