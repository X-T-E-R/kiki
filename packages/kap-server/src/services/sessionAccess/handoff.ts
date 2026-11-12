import { createHash, randomBytes } from 'node:crypto';
import { IConfigService, ISessionManager, type IDisposable, type Scope } from '@kiki/agent-core-v2';
import { SESSION_ACCESS_SECTION } from './configSection';
import { digest, type SessionAccessClient, type SessionAccessStore } from './store';

interface Ticket {
  readonly session_id: string;
  readonly challenge: string;
  readonly holder_id: string;
  readonly expires_at: number;
}
interface Holder {
  readonly streams: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}

export class SessionAccessHandoff {
  private readonly tickets = new Map<string, Ticket>();
  private readonly holders = new Map<string, Holder>();
  private readonly listeners: IDisposable[] = [];

  constructor(core: Scope, private readonly tokens: SessionAccessStore, private readonly graceMs = 20_000) {
    this.listeners.push(core.accessor.get(IConfigService).onDidSectionChange(({ domain }) => {
      if (domain !== SESSION_ACCESS_SECTION) return;
      const config = tokens.config();
      if (!config.enabled || !config.terminalHandoff) {
        this.tickets.clear();
        tokens.revokeWhere((token) => token.channel === 'terminal');
      }
      if (!config.enabled) this.closePresence();
    }));
    const deleted = core.accessor.get(ISessionManager).onDidDeleteSession;
    if (deleted !== undefined) this.listeners.push(deleted(({ sessionId }) => {
      for (const [key, ticket] of this.tickets) if (ticket.session_id === sessionId) this.tickets.delete(key);
    }));
  }

  present(holderId: string): boolean { return (this.holders.get(holderId)?.streams.size ?? 0) > 0; }

  attach(holderId: string, close: () => void): () => void {
    let holder = this.holders.get(holderId);
    if (holder === undefined) { holder = { streams: new Set() }; this.holders.set(holderId, holder); }
    clearTimeout(holder.timer); holder.timer = undefined;
    holder.streams.add(close);
    return () => {
      holder.streams.delete(close);
      if (this.holders.get(holderId) !== holder || holder.streams.size > 0 || holder.timer !== undefined) return;
      holder.timer = setTimeout(() => { this.release(holderId); this.holders.delete(holderId); }, this.graceMs);
      holder.timer.unref();
    };
  }

  issue(session_id: string, challenge: string, holder_id: string): { ticket: string; expires_at: number } {
    const now = this.tokens.now();
    for (const [key, ticket] of this.tickets) if (ticket.expires_at <= now) this.tickets.delete(key);
    const existing = [...this.tickets].filter(([, ticket]) => ticket.holder_id === holder_id);
    for (const [key] of existing.slice(0, Math.max(0, existing.length - 7))) this.tickets.delete(key);
    const ticket = randomBytes(32).toString('base64url');
    const expires_at = now + 60_000;
    this.tickets.set(digest(ticket), { session_id, challenge, holder_id, expires_at });
    return { ticket, expires_at };
  }

  consume(ticket: string): Ticket | undefined {
    const key = digest(ticket);
    const found = this.tickets.get(key);
    this.tickets.delete(key);
    return found;
  }

  exchange(ticket: Ticket | undefined, verifier: string, client: SessionAccessClient) {
    if (ticket === undefined || ticket.expires_at <= this.tokens.now() || !this.present(ticket.holder_id)) return undefined;
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    if (challenge !== ticket.challenge) return undefined;
    return this.tokens.issue({ session_id: ticket.session_id, scopes: ['read', 'prompt', 'abort'], client, channel: 'terminal', holder_id: ticket.holder_id, ttl_seconds: 3600 });
  }

  release(holderId: string, sessionId?: string): number {
    let revoked = this.tokens.revokeWhere((token) => token.holder_id === holderId && (sessionId === undefined || token.session_id === sessionId));
    for (const [key, ticket] of this.tickets) {
      if (ticket.holder_id !== holderId || sessionId !== undefined && ticket.session_id !== sessionId) continue;
      this.tickets.delete(key); revoked += 1;
    }
    return revoked;
  }

  close(): void {
    for (const listener of this.listeners) void listener.dispose();
    this.closePresence();
    this.tickets.clear();
  }

  private closePresence(): void {
    for (const holder of this.holders.values()) {
      clearTimeout(holder.timer);
      for (const close of holder.streams) close();
    }
    this.holders.clear();
  }
}
